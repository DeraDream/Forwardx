import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";

type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";
type DiagnosticCheck = {
  key: string;
  label: string;
  status: DiagnosticStatus;
  message: string;
  detail?: string | null;
};

type DiagnosticNode = {
  hostId: number | null;
  name: string;
  address: string;
  role: "entry" | "relay" | "landing" | "target";
  online: boolean | null;
  agentVersion?: string | null;
};

function check(
  key: string,
  label: string,
  status: DiagnosticStatus,
  message: string,
  detail?: string | null,
): DiagnosticCheck {
  return { key, label, status, message, detail: detail || null };
}

function hostAddress(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ip || host?.publicIp || "").trim();
}

function enabled(value: any) {
  return value !== false && Number(value ?? 1) !== 0;
}

async function hostNode(hostId: number, role: DiagnosticNode["role"]): Promise<DiagnosticNode | null> {
  if (!Number.isFinite(hostId) || hostId <= 0) return null;
  const host = await db.getHostById(hostId) as any;
  if (!host) return null;
  return {
    hostId,
    name: String(host.name || `主机 #${hostId}`),
    address: hostAddress(host),
    role,
    online: !!host.isOnline,
    agentVersion: host.agentVersion ? String(host.agentVersion) : null,
  };
}

async function tunnelHostIds(tunnel: any) {
  const ids: number[] = [];
  const hops = await db.getTunnelHops(Number(tunnel?.id || 0)).catch(() => []) as any[];
  if (hops.length > 0) {
    for (const hop of hops) {
      const id = Number(hop?.hostId || 0);
      if (id > 0 && !ids.includes(id)) ids.push(id);
    }
  } else {
    for (const value of [tunnel?.entryHostId, tunnel?.exitHostId]) {
      const id = Number(value || 0);
      if (id > 0 && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

async function groupHostIds(group: any) {
  const ids: number[] = [];
  const entryGroupId = Number(group?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const entryGroup = await db.getForwardGroupById(entryGroupId) as any;
    for (const member of entryGroup?.members || []) {
      if (!enabled(member?.isEnabled)) continue;
      const hostId = Number(member?.hostId || 0);
      if (hostId > 0 && !ids.includes(hostId)) ids.push(hostId);
    }
  }
  for (const member of group?.members || []) {
    if (!enabled(member?.isEnabled)) continue;
    if (String(member?.memberType || "host") === "tunnel" && Number(member?.tunnelId || 0) > 0) {
      const tunnel = await db.getTunnelById(Number(member.tunnelId)) as any;
      for (const hostId of await tunnelHostIds(tunnel)) {
        if (!ids.includes(hostId)) ids.push(hostId);
      }
      continue;
    }
    const hostId = Number(member?.hostId || 0);
    if (hostId > 0 && !ids.includes(hostId)) ids.push(hostId);
  }
  return ids;
}

async function ruleHostIds(rule: any, visited = new Set<number>()): Promise<number[]> {
  const ruleId = Number(rule?.id || 0);
  if (ruleId > 0 && visited.has(ruleId)) return [];
  const nextVisited = new Set(visited);
  if (ruleId > 0) nextVisited.add(ruleId);

  let ids: number[] = [];
  if (Number(rule?.forwardGroupId || 0) > 0) {
    const group = await db.getForwardGroupById(Number(rule.forwardGroupId)) as any;
    if (group) ids = await groupHostIds(group);
  } else if (Number(rule?.tunnelId || 0) > 0) {
    const tunnel = await db.getTunnelById(Number(rule.tunnelId)) as any;
    if (tunnel) ids = await tunnelHostIds(tunnel);
  } else if (Number(rule?.hostId || 0) > 0) {
    ids = [Number(rule.hostId)];
  }

  const targetRuleId = Number(rule?.targetRuleId || 0);
  if (targetRuleId > 0) {
    const targetRule = await db.getForwardRuleById(targetRuleId) as any;
    if (targetRule) {
      for (const hostId of await ruleHostIds(targetRule, nextVisited)) {
        if (!ids.includes(hostId)) ids.push(hostId);
      }
    }
  }
  return ids;
}

async function buildNodes(hostIds: number[], landingHostId = 0) {
  const nodes: DiagnosticNode[] = [];
  for (let index = 0; index < hostIds.length; index += 1) {
    const role: DiagnosticNode["role"] = index === 0 ? "entry" : "relay";
    const node = await hostNode(hostIds[index], role);
    if (node) nodes.push(node);
  }
  if (landingHostId > 0) {
    const existing = nodes.find((node) => Number(node.hostId) === landingHostId);
    if (existing) {
      existing.role = "landing";
    } else {
      const landing = await hostNode(landingHostId, "landing");
      if (landing) nodes.push(landing);
    }
  }
  return nodes;
}

function agentChecks(nodes: DiagnosticNode[]) {
  if (nodes.length === 0) {
    return [check("agents-none", "Agent 状态", "warn", "没有可检查的托管主机")];
  }
  return nodes
    .filter((node) => node.hostId)
    .map((node) =>
      check(
        `agent-${node.hostId}`,
        `Agent · ${node.name}`,
        node.online ? "pass" : "fail",
        node.online ? "在线" : "离线",
        node.agentVersion ? `Agent ${node.agentVersion}` : null,
      ),
    );
}

async function ensureAccess(scope: string, id: number, user: any) {
  const admin = String(user?.role) === "admin";
  if (scope === "rule") {
    const resource = await db.getForwardRuleById(id) as any;
    if (!resource) throw new Error("规则不存在");
    if (!admin && Number(resource.userId) !== Number(user.id)) throw new Error("无权查看此规则");
    return resource;
  }
  if (scope === "tunnel") {
    const resource = await db.getTunnelById(id) as any;
    if (!resource) throw new Error("隧道不存在");
    if (!admin && Number(resource.userId) !== Number(user.id)) throw new Error("无权查看此隧道");
    return resource;
  }
  if (scope === "chain") {
    const resource = await db.getForwardGroupById(id) as any;
    if (!resource || String(resource.groupMode || "") !== "chain") throw new Error("转发链不存在");
    if (!admin && Number(resource.userId) !== Number(user.id)) {
      const allowed = await db.checkUserForwardGroupPermission(Number(user.id), id);
      if (!allowed) throw new Error("无权查看此转发链");
    }
    return resource;
  }
  const resource = await db.getFullChainById(id) as any;
  if (!resource) throw new Error("全链路不存在");
  if (!admin && Number(resource.userId) !== Number(user.id)) throw new Error("无权查看此全链路");
  return resource;
}

export const diagnosticsRouter = router({
  plan: protectedProcedure
    .input(z.object({
      scope: z.enum(["rule", "tunnel", "chain", "full-chain"]),
      id: z.number().int().positive(),
    }))
    .query(async ({ input, ctx }) => {
      const resource = await ensureAccess(input.scope, input.id, ctx.user);
      const checks: DiagnosticCheck[] = [];
      let nodes: DiagnosticNode[] = [];
      let title = String(resource?.name || `资源 #${input.id}`);
      let target = "";
      let liveTestSupported = true;

      if (input.scope === "rule") {
        const rule = resource as any;
        const hostIds = await ruleHostIds(rule);
        let landing: any = null;
        if (Number(rule.targetLandingServiceId || 0) > 0) {
          landing = await db.getLandingServiceById(Number(rule.targetLandingServiceId), true) as any;
        }
        nodes = await buildNodes(hostIds, Number(landing?.hostId || 0));
        target = landing
          ? `${String(landing.endpoint || "")}:${Number(landing.port || 0)}`
          : `${String(rule.targetIp || "")}:${Number(rule.targetPort || 0)}`;

        checks.push(check("config-resource", "配置完整性", "pass", "规则存在"));
        checks.push(check(
          "config-enabled",
          "规则启用状态",
          rule.isEnabled === false ? "warn" : "pass",
          rule.isEnabled === false ? "规则当前已停用" : "规则已启用",
        ));
        checks.push(check(
          "config-entry",
          "入口配置",
          hostIds.length > 0 ? "pass" : "fail",
          hostIds.length > 0 ? `已解析 ${hostIds.length} 个物理节点` : "无法解析入口主机",
        ));
        checks.push(check(
          "runtime",
          "入口运行状态",
          rule.isRunning ? "pass" : "warn",
          rule.isRunning ? "当前标记为运行中" : "当前未标记为运行中",
          "该项来自面板运行状态；实时连通性以本次诊断探测结果为准",
        ));
        checks.push(check(
          "target",
          "目标配置",
          String(rule.targetIp || landing?.endpoint || "").trim() && Number(rule.targetPort || landing?.port || 0) > 0 ? "pass" : "fail",
          target || "目标地址不完整",
        ));
        if (Number(rule.targetLandingServiceId || 0) > 0) {
          checks.push(check(
            "landing",
            "落地 SS",
            !landing ? "fail" : landing.isEnabled === false || String(landing.status || "") === "disabled" ? "warn" : "pass",
            !landing ? "引用的落地 SS 不存在" : String(landing.statusMessage || landing.status || "已配置"),
            landing ? `${landing.name || "落地 SS"} · ${landing.endpoint || ""}:${landing.port || ""}` : null,
          ));
        } else {
          checks.push(check("landing", "落地 SS", "skip", "当前规则使用直连目标"));
        }
      }

      if (input.scope === "tunnel") {
        const tunnel = resource as any;
        const hostIds = await tunnelHostIds(tunnel);
        nodes = await buildNodes(hostIds);
        if (nodes.length > 0) nodes[nodes.length - 1].role = "landing";
        checks.push(check("config-resource", "配置完整性", "pass", "隧道存在"));
        checks.push(check(
          "config-hops",
          "链路节点",
          hostIds.length >= 2 ? "pass" : "fail",
          hostIds.length >= 2 ? `共 ${hostIds.length} 个物理节点` : "隧道节点不足",
        ));
        checks.push(check(
          "runtime",
          "隧道运行状态",
          tunnel.isRunning ? "pass" : "warn",
          tunnel.isRunning ? "当前标记为运行中" : "当前未标记为运行中",
        ));
        checks.push(check(
          "listen",
          "出口监听配置",
          Number(tunnel.listenPort || 0) > 0 ? "pass" : "warn",
          Number(tunnel.listenPort || 0) > 0 ? `端口 ${tunnel.listenPort}` : "未发现有效监听端口",
          "这里只检查配置值；实时可达性由逐跳探测确认",
        ));
      }

      if (input.scope === "chain") {
        const group = resource as any;
        const hostIds = await groupHostIds(group);
        nodes = await buildNodes(hostIds);
        checks.push(check("config-resource", "配置完整性", "pass", "转发链存在"));
        checks.push(check(
          "config-enabled",
          "链路启用状态",
          group.isEnabled === false ? "warn" : "pass",
          group.isEnabled === false ? "转发链当前已停用" : "转发链已启用",
        ));
        checks.push(check(
          "config-hops",
          "链路节点",
          hostIds.length >= 2 ? "pass" : "fail",
          hostIds.length >= 2 ? `已解析 ${hostIds.length} 个物理节点` : "转发链节点不足",
        ));
        checks.push(check(
          "runtime",
          "运行配置",
          "pass",
          String(group.forwardType || "未指定"),
          Number(group.entryGroupId || 0) > 0 ? "已配置独立入口组" : "首个链路节点作为入口",
        ));
      }

      if (input.scope === "full-chain") {
        const chain = resource as any;
        const rawNodes = await db.getFullChainNodes(input.id) as any[];
        const hostIds: number[] = [];
        for (const node of rawNodes) {
          if (String(node?.nodeType || "host") === "forward-chain" && Number(node?.forwardGroupId || 0) > 0) {
            const group = await db.getForwardGroupById(Number(node.forwardGroupId)) as any;
            for (const hostId of await groupHostIds(group)) {
              if (!hostIds.includes(hostId)) hostIds.push(hostId);
            }
          } else {
            const hostId = Number(node?.hostId || 0);
            if (hostId > 0 && !hostIds.includes(hostId)) hostIds.push(hostId);
          }
        }
        nodes = await buildNodes(hostIds, Number(hostIds.at(-1) || 0));
        const landing = Number(chain.landingServiceId || 0) > 0
          ? await db.getLandingServiceById(Number(chain.landingServiceId), true) as any
          : null;
        checks.push(check("config-resource", "配置完整性", "pass", "全链路存在"));
        checks.push(check(
          "config-hops",
          "链路节点",
          hostIds.length >= 2 ? "pass" : "fail",
          hostIds.length >= 2 ? `已解析 ${hostIds.length} 个物理节点` : "全链路节点不足",
        ));
        checks.push(check(
          "runtime",
          "全链路运行状态",
          String(chain.status || "") === "running" ? "pass" : "warn",
          String(chain.statusMessage || chain.status || "未知状态"),
        ));
        checks.push(check(
          "landing",
          "落地 SS",
          landing ? (landing.isEnabled === false ? "warn" : "pass") : "warn",
          landing ? String(landing.statusMessage || landing.status || "已配置") : "当前未找到运行中的落地 SS",
          landing ? `${landing.name || "落地 SS"} · ${landing.endpoint || ""}:${landing.port || ""}` : null,
        ));
      }

      checks.push(...agentChecks(nodes));

      const failed = checks.filter((item) => item.status === "fail").length;
      const warnings = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;

      return {
        scope: input.scope,
        id: input.id,
        title,
        target,
        liveTestSupported,
        checks,
        nodes,
        summary: {
          passed,
          warnings,
          failed,
          status: failed > 0 ? "fail" as const : warnings > 0 ? "warn" as const : "pass" as const,
        },
      };
    }),
});
