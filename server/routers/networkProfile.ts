import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { isAgentVersionAtLeast } from "../agentRouteUtils";
import { pushAgentNetworkProfile } from "../agentEvents";
import {
  hostNetworkProfileView,
  reportHostNetworkProfile,
  startHostNetworkProfileTask,
  type NetworkProfileFamily,
} from "../hostNetworkProfileState";

export const NETWORK_PROFILE_AGENT_VERSION = "2.2.222";

const BGP_GRAPH_CACHE_MS = 6 * 60 * 60_000;
const BGP_GRAPH_CACHE_LIMIT = 128;
const BGP_GRAPH_MAX_BYTES = 4 * 1024 * 1024;

type BGPGraphCacheEntry = {
  expiresAt: number;
  dataUrl: string;
};

const bgpGraphCache = new Map<string, BGPGraphCacheEntry>();

function pruneBGPGraphCache(now = Date.now()) {
  for (const [key, entry] of bgpGraphCache) {
    if (entry.expiresAt <= now) bgpGraphCache.delete(key);
  }
  while (bgpGraphCache.size > BGP_GRAPH_CACHE_LIMIT) {
    const oldest = bgpGraphCache.keys().next().value;
    if (!oldest) break;
    bgpGraphCache.delete(oldest);
  }
}

function bgpGraphPathFromPrefix(prefix: unknown) {
  const value = String(prefix || "").trim();
  if (!value || !value.includes("/")) return "";
  return `/pathimg/rt-${value.replaceAll("/", "_")}`;
}

function normalizeBGPGraphUrl(rawPath: unknown) {
  const value = String(rawPath || "").trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://bgp.tools");
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "bgp.tools") return null;
  if (!parsed.pathname.startsWith("/pathimg/")) return null;
  return parsed.toString();
}

async function fetchBGPGraphDataUrl(rawPath: unknown) {
  const graphUrl = normalizeBGPGraphUrl(rawPath);
  if (!graphUrl) throw new Error("BGP 拓扑图地址无效");
  const cached = bgpGraphCache.get(graphUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.dataUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(graphUrl, {
      cache: "no-store",
      headers: {
        Accept: "image/svg+xml,image/*;q=0.8,*/*;q=0.5",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/122 Safari/537.36",
        Referer: "https://bgp.tools/",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BGP.Tools HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > BGP_GRAPH_MAX_BYTES) throw new Error("BGP 拓扑图过大");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > BGP_GRAPH_MAX_BYTES) {
      throw new Error("BGP 拓扑图大小异常");
    }
    const svg = Buffer.from(bytes).toString("utf8").trim();
    if (!/<svg\b/i.test(svg.slice(0, 2048))) throw new Error("BGP.Tools 未返回 SVG");
    if (svg.includes("Not_Visible") && svg.includes("in_DFZ")) throw new Error("该 Prefix 当前未在 DFZ 中可见");
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
    bgpGraphCache.set(graphUrl, {
      expiresAt: Date.now() + BGP_GRAPH_CACHE_MS,
      dataUrl,
    });
    pruneBGPGraphCache();
    return dataUrl;
  } finally {
    clearTimeout(timer);
  }
}

async function requireHost(hostId: number, user: any) {
  const host = await db.getHostById(hostId) as any;
  if (!host) throw new Error("主机不存在");
  if (String(user?.role) !== "admin" && Number(host.userId) !== Number(user?.id)) throw new Error("无权查看此主机");
  return host;
}

async function resolveFinalLandingForRule(ruleId: number, user: any, visited = new Set<number>()): Promise<any | null> {
  const id = Number(ruleId || 0);
  if (!Number.isInteger(id) || id <= 0 || visited.has(id)) return null;
  visited.add(id);
  const rule = await db.getForwardRuleById(id) as any;
  if (!rule || rule.pendingDelete === true) return null;
  if (String(user?.role) !== "admin" && Number(rule.userId) !== Number(user?.id)) throw new Error("无权查看此规则");

  const serviceId = Number(rule.targetLandingServiceId || 0);
  if (serviceId > 0) {
    const service = await db.getLandingServiceById(serviceId, false) as any;
    if (!service || service.isFullChainManaged || service.isExternal || Number(service.hostId || 0) <= 0) return null;
    if (String(user?.role) !== "admin" && Number(service.userId) !== Number(user?.id)) throw new Error("无权查看该落地服务");
    const host = await db.getHostById(Number(service.hostId)) as any;
    if (!host) return null;
    return {
      ruleId: id,
      serviceId: Number(service.id),
      serviceName: String(service.name || `落地 SS #${service.id}`),
      hostId: Number(host.id),
      hostName: String(host.name || `主机 #${host.id}`),
    };
  }

  const targetRuleId = Number(rule.targetRuleId || 0);
  if (targetRuleId > 0) return resolveFinalLandingForRule(targetRuleId, user, visited);
  return null;
}

export const networkProfileRouter = router({
  resolveRuleLanding: protectedProcedure
    .input(z.object({ ruleId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      return resolveFinalLandingForRule(input.ruleId, ctx.user);
    }),

  status: protectedProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const host = await requireHost(input.hostId, ctx.user);
      const [ipv4, ipv6] = await Promise.all([
        hostNetworkProfileView(input.hostId, "ipv4"),
        hostNetworkProfileView(input.hostId, "ipv6"),
      ]);
      return {
        host: {
          id: Number(host.id),
          name: String(host.name || `主机 #${host.id}`),
          online: !!host.isOnline,
          agentVersion: host.agentVersion ? String(host.agentVersion) : null,
          ipv4: String(host.ipv4 || ""),
          ipv6: String(host.ipv6 || ""),
        },
        minimumAgentVersion: NETWORK_PROFILE_AGENT_VERSION,
        ipv4,
        ipv6,
      };
    }),

  bgpGraph: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      family: z.enum(["ipv4", "ipv6"]),
    }))
    .query(async ({ input, ctx }) => {
      await requireHost(input.hostId, ctx.user);
      const view = await hostNetworkProfileView(input.hostId, input.family);
      const current = view.running || view.persisted;
      const network = current?.data?.network as Record<string, any> | undefined;
      const prefix = String(network?.prefix || "").trim();
      const graphPath = String(network?.bgpGraphPath || "").trim() || bgpGraphPathFromPrefix(prefix);
      const pageUrl = String(network?.bgpGraphPageUrl || "").trim()
        || (prefix ? `https://bgp.tools/prefix/${prefix}#connectivity` : "");
      if (!graphPath) {
        return { available: false as const, prefix, pageUrl, dataUrl: null };
      }
      try {
        const dataUrl = await fetchBGPGraphDataUrl(graphPath);
        return { available: true as const, prefix, pageUrl, dataUrl };
      } catch (error) {
        return {
          available: false as const,
          prefix,
          pageUrl,
          dataUrl: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),

  start: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      family: z.enum(["ipv4", "ipv6"]),
      mode: z.enum(["quick", "full"]).default("full"),
    }))
    .mutation(async ({ input, ctx }) => {
      const host = await requireHost(input.hostId, ctx.user);
      if (!host.isOnline) throw new Error("Agent 离线，无法执行网络画像检测");
      if (!isAgentVersionAtLeast(host.agentVersion, NETWORK_PROFILE_AGENT_VERSION)) {
        throw new Error(`Agent 版本过旧，需要升级至 ${NETWORK_PROFILE_AGENT_VERSION} 或更高版本`);
      }
      const family = input.family as NetworkProfileFamily;
      const task = startHostNetworkProfileTask({ hostId: input.hostId, family, mode: input.mode });
      const pushed = pushAgentNetworkProfile(input.hostId, {
        taskId: task.taskId,
        family,
        mode: input.mode,
      });
      if (!pushed) {
        await reportHostNetworkProfile({
          hostId: input.hostId,
          taskId: task.taskId,
          family,
          stage: "dispatch",
          status: "error",
          message: "Agent 实时通道不可用",
          completed: true,
          failed: true,
        });
        throw new Error("Agent 实时通道不可用，请确认 Agent 在线后重试");
      }
      return task;
    }),
});
