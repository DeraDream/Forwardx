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
]);

type NetworkProfileProxyCacheEntry = {
  expiresAt: number;
  payload: Record<string, unknown>;
};

const networkProfileProxyCache = new Map<string, NetworkProfileProxyCacheEntry>();

async function networkProfileProxyRequest(ip: string, provider: string) {
  const escapedIp = encodeURIComponent(ip);
  if (provider === "ipapi") {
    const apiKey = String((await db.getSetting("networkProfileIpapiApiKey")) || "").trim();
    if (!apiKey) throw new Error("ipapi.is API key is not configured");
    return {
      url: `https://api.ipapi.is/?q=${escapedIp}&key=${encodeURIComponent(apiKey)}`,
      headers: { Accept: "application/json" },
    };
  }
  if (provider === "proxycheck") {
    return { url: `https://proxycheck.io/v2/${escapedIp}?vpn=1&asn=1&risk=1&days=7`, headers: {} as Record<string, string> };
  }
  if (provider === "abuseipdb") {
    const apiKey = String((await db.getSetting("networkProfileAbuseIpdbApiKey")) || "").trim();
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
