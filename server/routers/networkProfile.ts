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

export const NETWORK_PROFILE_AGENT_VERSION = "2.2.212";

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
