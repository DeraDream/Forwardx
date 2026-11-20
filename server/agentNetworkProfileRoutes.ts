import net from "node:net";
import type { Router, Request, Response } from "express";
import { getAgentHostFromRequest } from "./agentAuth";
import { reportHostNetworkProfile } from "./hostNetworkProfileState";
import * as db from "./db";

function familyOf(value: unknown): "ipv4" | "ipv6" | null {
  const text = String(value || "").trim().toLowerCase();
  return text === "ipv4" || text === "ipv6" ? text : null;
}

const NETWORK_PROFILE_PROXY_TIMEOUT_MS = 9_000;
const NETWORK_PROFILE_PROXY_CACHE_MS = 10 * 60_000;
const NETWORK_PROFILE_PROXY_CACHE_LIMIT = 2_048;
const NETWORK_PROFILE_PROXY_PROVIDERS = new Set([
  "ipapi",
  "proxycheck",
  "abuseipdb",
  "scamalytics",
  "dbip",
  "ipdata",
  "ipqs",
  "ipinfo",
  "ipregistry",
  "ip2location",
]);

type NetworkProfileProxyCacheEntry = {
  expiresAt: number;
  payload: Record<string, unknown>;
};

type NetworkProfileProxyRequest = {
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers: Record<string, string>;
};

const networkProfileProxyCache = new Map<string, NetworkProfileProxyCacheEntry>();

const networkProfileKeySettings: Record<string, string> = {
  ipinfo: "networkProfileIpinfoApiKey",
  ipregistry: "networkProfileIpregistryApiKey",
  ipapi: "networkProfileIpapiApiKey",
  ip2location: "networkProfileIp2locationApiKey",
  proxycheck: "networkProfileProxycheckApiKey",
  abuseipdb: "networkProfileAbuseIpdbApiKey",
  scamalytics: "networkProfileScamalyticsApiKey",
  dbip: "networkProfileDbIpApiKey",
  ipdata: "networkProfileIpdataApiKey",
  ipqs: "networkProfileIpqsApiKey",
};

async function networkProfileProviderKey(provider: string) {
  const setting = networkProfileKeySettings[provider];
  return setting ? String((await db.getSetting(setting)) || "").trim() : "";
}

export const NETWORK_PROFILE_KEY_PROVIDERS = Object.keys(networkProfileKeySettings);

export function clearNetworkProfileProviderCache(provider?: string) {
  for (const key of networkProfileProxyCache.keys()) {
    if (!provider || key.startsWith(`${provider}:`)) networkProfileProxyCache.delete(key);
  }
}

async function networkProfileProxyRequest(ip: string, provider: string): Promise<NetworkProfileProxyRequest> {
  const escapedIp = encodeURIComponent(ip);
  if (provider === "ipapi") {
    const apiKey = String((await db.getSetting("networkProfileIpapiApiKey")) || "").trim();
    if (!apiKey) throw new Error("ipapi.is API key is not configured");
    return {
      url: "https://api.ipapi.is",
      method: "POST",
      body: JSON.stringify({ q: ip, key: apiKey }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };
  }
  if (provider === "ipinfo") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("IPinfo API key is not configured");
    return { url: `https://ipinfo.io/${escapedIp}?token=${encodeURIComponent(apiKey)}`, headers: {} };
  }
  if (provider === "ipregistry") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("ipregistry API key is not configured");
    return { url: `https://api.ipregistry.co/${escapedIp}?key=${encodeURIComponent(apiKey)}`, headers: {} };
  }
  if (provider === "ip2location") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("IP2Location API key is not configured");
    return { url: `https://api.ip2location.io/?key=${encodeURIComponent(apiKey)}&ip=${escapedIp}&format=json`, headers: {} };
  }
  if (provider === "proxycheck") {
    const apiKey = await networkProfileProviderKey(provider);
    const key = apiKey ? `&key=${encodeURIComponent(apiKey)}` : "";
    return { url: `https://proxycheck.io/v2/${escapedIp}?vpn=1&asn=1&risk=1&days=7${key}`, headers: {} };
  }
  if (provider === "scamalytics") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("Scamalytics API key is not configured");
    return { url: `https://api11.scamalytics.com/${encodeURIComponent(apiKey)}/?ip=${escapedIp}`, headers: {} };
  }
  if (provider === "dbip") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("DB-IP API key is not configured");
    return { url: `https://api.db-ip.com/v2/${encodeURIComponent(apiKey)}/${escapedIp}`, headers: {} };
  }
  if (provider === "ipdata") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("IPdata API key is not configured");
    return { url: `https://api.ipdata.co/${escapedIp}?api-key=${encodeURIComponent(apiKey)}`, headers: {} };
  }
  if (provider === "ipqs") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("IPQualityScore API key is not configured");
    return { url: `https://www.ipqualityscore.com/api/json/ip/${encodeURIComponent(apiKey)}/${escapedIp}`, headers: {} };
  }
  if (provider === "abuseipdb") {
    const apiKey = await networkProfileProviderKey(provider);
    if (!apiKey) throw new Error("AbuseIPDB API key is not configured");
    return {
      url: `https://api.abuseipdb.com/api/v2/check?ipAddress=${escapedIp}&maxAgeInDays=90&verbose=`,
      headers: {
        Key: apiKey,
        Accept: "application/json",
      },
    };
  }
  throw new Error("unsupported network profile proxy provider");
}

function pruneNetworkProfileProxyCache(now = Date.now()) {
  for (const [key, entry] of networkProfileProxyCache) {
    if (entry.expiresAt <= now) networkProfileProxyCache.delete(key);
  }
  while (networkProfileProxyCache.size > NETWORK_PROFILE_PROXY_CACHE_LIMIT) {
    const oldest = networkProfileProxyCache.keys().next().value;
    if (!oldest) break;
    networkProfileProxyCache.delete(oldest);
  }
}

export async function validateNetworkProfileProvider(provider: string) {
  if (!NETWORK_PROFILE_KEY_PROVIDERS.includes(provider)) throw new Error("unsupported network profile provider");
  if (provider !== "proxycheck" && !await networkProfileProviderKey(provider)) throw new Error("API key is not configured");
  await fetchNetworkProfileProxyPayload("1.1.1.1", provider);
  return { valid: true };
}

async function fetchNetworkProfileProxyPayload(ip: string, provider: string) {
  const cacheKey = `${provider}:${ip.toLowerCase()}`;
  const cached = networkProfileProxyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_PROFILE_PROXY_TIMEOUT_MS);
    try {
      const request = await networkProfileProxyRequest(ip, provider);
      const response = await fetch(request.url, {
        cache: "no-store",
        method: request.method || "GET",
        body: request.body,
        headers: {
          Accept: "application/json,text/plain,*/*",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
          ...request.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length === 0) {
        throw new Error("invalid or empty JSON payload");
      }
      const keys = Object.keys(payload);
      if (keys.length <= 2 && ("error" in payload || "message" in payload) && !("data" in payload)) {
        throw new Error(String(payload.error || payload.message || "provider returned an error payload"));
      }
      networkProfileProxyCache.set(cacheKey, {
        expiresAt: Date.now() + NETWORK_PROFILE_PROXY_CACHE_MS,
        payload,
      });
      pruneNetworkProfileProxyCache();
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "risk proxy request failed"));
}

export function registerAgentNetworkProfileRoutes(router: Router) {
  router.post("/api/agent/network-profile-risk-proxy", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      const ip = String(req.body?.ip || "").trim();
      const provider = String(req.body?.provider || "").trim().toLowerCase();
      if (!net.isIP(ip) || !NETWORK_PROFILE_PROXY_PROVIDERS.has(provider)) {
        res.status(400).json({ error: "Invalid network profile risk proxy request" });
        return;
      }
      // Keyed providers are called only after an admin has saved credentials
      // in System Settings. Missing credentials are a clean unavailable state,
      // not a provider/network failure.
      if (provider === "ipapi" && !String((await db.getSetting("networkProfileIpapiApiKey")) || "").trim()) {
        res.json({ success: false, error: "ipapi.is API key is not configured" });
        return;
      }
      if (provider === "abuseipdb" && !String((await db.getSetting("networkProfileAbuseIpdbApiKey")) || "").trim()) {
        res.json({ success: false, error: "AbuseIPDB API key is not configured" });
        return;
      }
      const payload = await fetchNetworkProfileProxyPayload(ip, provider);
      res.json({ success: true, payload });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/api/agent/network-profile-report", async (req: Request, res: Response) => {
    try {
      const host = await getAgentHostFromRequest(req);
      if (!host) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
      const family = familyOf(req.body?.family);
      const taskId = String(req.body?.taskId || "").trim().slice(0, 160);
      const stage = String(req.body?.stage || "").trim().slice(0, 80);
      const status = String(req.body?.status || "").trim();
      const allowed = new Set(["pending", "running", "success", "error", "skip"]);
      if (!family || !taskId || !stage || !allowed.has(status)) {
        res.status(400).json({ error: "Invalid network profile report" });
        return;
      }
      const accepted = await reportHostNetworkProfile({
        hostId: Number(host.id),
        taskId,
        family,
        stage,
        status: status as any,
        data: req.body?.data,
        message: typeof req.body?.message === "string" ? req.body.message.slice(0, 2000) : null,
        completed: req.body?.completed === true,
        failed: req.body?.failed === true,
      });
      res.json({ success: true, accepted });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
