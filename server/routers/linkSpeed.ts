import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import * as db from "../db";
import {
  cancelLinkSpeedJob,
  createLinkSpeedJob,
  getLinkSpeedJob,
  latestLinkSpeedJob,
} from "../linkSpeedTasks";
import { withKeyedTaskLock } from "../keyedTaskLock";
import { isAgentVersionAtLeast } from "../agentRouteUtils";
import { AGENT_VERSION } from "../../shared/versions";

function enabled(value: unknown) {
  return ![false, 0, "0", "false"].includes(value as any);
}

function normalizeGroupMode(group: any) {
  const mode = String(group?.groupMode || "");
  return mode === "chain" || mode === "port" || mode === "entry" || mode === "exit" ? mode : "failover";
}

async function resolveTerminalLanding(rule: any) {
  const seen = new Set<number>();
  let current = rule;
  let landingServiceId = Number(current?.targetLandingServiceId || 0);
  for (let depth = 0; depth < 16; depth++) {
    const id = Number(current?.id || 0);
    if (id > 0) seen.add(id);
    const targetRuleId = Number(current?.targetRuleId || 0);
    if (targetRuleId <= 0) break;
    if (seen.has(targetRuleId)) throw new Error("转发规则引用形成循环，无法解析最终落地 SS");
    const target = await db.getForwardRuleById(targetRuleId) as any;
    if (!target || target.pendingDelete) throw new Error("被引用的转发链规则不存在或正在删除");
    current = target;
    landingServiceId = Number(current.targetLandingServiceId || landingServiceId || 0);
  }
  if (landingServiceId <= 0) throw new Error("当前链路没有关联最终落地 SS，无法进行全链路测速");
  const landing = await db.getLandingServiceById(landingServiceId, true) as any;
  if (!landing) throw new Error("最终落地 SS 不存在");
  if (!enabled(landing.isEnabled) || String(landing.status || "") === "disabled") throw new Error("最终落地 SS 已停用");
  if (!String(landing.method || "").trim() || !String(landing.password || "").trim()) throw new Error("最终落地 SS 缺少加密方式或密码");
  return { terminalRule: current, landing };
}

const routeNodeSchema = z.object({
  hostId: z.number().int().positive(),
  name: z.string().trim().min(1).max(160),
  transport: z.string().trim().min(1).max(80),
});

export const linkSpeedRouter = router({
  start: adminProcedure
    .input(z.object({
      ruleId: z.number().int().positive(),
      entryHostId: z.number().int().positive(),
      pathId: z.string().trim().min(1).max(240),
      name: z.string().trim().min(1).max(160),
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
      duration: z.number().int().min(3).max(30).default(10),
      rateMbps: z.number().min(1).max(1000).default(100),
      route: z.array(routeNodeSchema).min(2).max(32),
    }))
    .mutation(async ({ input, ctx }) => withKeyedTaskLock("full-link-speed-start", async () => {
      const rule = await db.getForwardRuleById(input.ruleId) as any;
      if (!rule || rule.pendingDelete) throw new Error("转发规则不存在或正在删除");
      if (!enabled(rule.isEnabled)) throw new Error("请先启用当前转发规则");
      const group = Number(rule.forwardGroupId || 0) > 0
        ? await db.getForwardGroupById(Number(rule.forwardGroupId)) as any
        : null;
      const mode = group ? normalizeGroupMode(group) : "port";
      if (group && mode !== "port" && mode !== "chain") throw new Error("当前仅支持端口转发和转发链测速");
      const configuredProtocol = String(rule.protocol || group?.protocol || "both").toLowerCase();
      if (configuredProtocol !== "both" && configuredProtocol !== input.protocol) {
        throw new Error(`当前规则未启用 ${input.protocol.toUpperCase()}`);
      }
      const entryHost = await db.getHostById(input.entryHostId) as any;
      if (!entryHost?.agentToken || !entryHost.isOnline) throw new Error("入口 Agent 离线或未绑定 Token");
      if (!isAgentVersionAtLeast(String(entryHost.agentVersion || ""), AGENT_VERSION)) throw new Error(`请先将入口 Agent 升级到 ${AGENT_VERSION}`);
      if (!input.route.some((node) => Number(node.hostId) === input.entryHostId)) throw new Error("测速路径与入口主机不匹配，请刷新网络拓扑后重试");
      const sourcePort = Number(rule.sourcePort || 0);
      if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) throw new Error("当前规则缺少有效入口端口");
      const { landing } = await resolveTerminalLanding(rule);
      const benchmarkPort = Number.parseInt(process.env.FORWARDX_LINK_SPEED_PORT || "5202", 10);
      if (!Number.isInteger(benchmarkPort) || benchmarkPort < 1 || benchmarkPort > 65535) throw new Error("面板全链路测速端口配置无效");
      const route = await Promise.all(input.route.map(async (node) => {
        const host = await db.getHostById(node.hostId) as any;
        return {
          hostId: node.hostId,
          name: node.name,
          transport: node.transport,
          agentVersion: String(host?.agentVersion || "").trim() || undefined,
          osInfo: String(host?.osInfo || "").trim().slice(0, 160) || undefined,
        };
      }));
      return createLinkSpeedJob({
        userId: ctx.user.id,
        ruleId: input.ruleId,
        entryHostId: input.entryHostId,
        pathId: input.pathId,
        name: input.name,
        protocol: input.protocol,
        duration: input.duration,
        rateMbps: input.protocol === "udp" ? input.rateMbps : 0,
        route,
        entryAddress: "127.0.0.1",
        entryPort: sourcePort,
        entryMode: String(rule.forwardType || "").toLowerCase() === "iptables" ? "iptables" : "listener",
        ssMethod: String(landing.method),
        ssPassword: String(landing.password),
        benchmarkHost: String(process.env.FORWARDX_LINK_SPEED_HOST || "").trim(),
        benchmarkPort,
      });
    })),
  status: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ input, ctx }) => getLinkSpeedJob(input.id, ctx.user).status),
  latest: adminProcedure
    .input(z.object({ pathId: z.string().trim().min(1).max(240) }))
    .query(({ input, ctx }) => latestLinkSpeedJob(input.pathId, ctx.user.id)),
  cancel: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input, ctx }) => cancelLinkSpeedJob(input.id, ctx.user)),
});
