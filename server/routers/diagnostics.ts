import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { pushAgentSelfTest } from "../agentEvents";
import { isAgentVersionAtLeast } from "../agentRouteUtils";
import { summarizeForwardGroupRuntime } from "../forwardGroupRuntimeStatus";
import {
  getForwardGroupChildRulesForTemplate,
  getForwardGroupTemplateRules,
} from "../repositories/forwardRuleRepository";
import { adjustHopTestDetailsForLatencyMode, type HopTestLatencyMode, type HopTestResult } from "../hopTestState";
import { latestConfigRevision } from "../configAudit";
import { getAgentLocalRuntimeStateSnapshot } from "../agentHeartbeatRoute";

const DIAGNOSTIC_AGENT_VERSION = "2.2.210";

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
    .map((node) => {
      const versionReady = isAgentVersionAtLeast(node.agentVersion, DIAGNOSTIC_AGENT_VERSION);
      const status: DiagnosticStatus = !node.online || !versionReady ? "fail" : "pass";
      const message = !node.online
        ? "离线"
        : !versionReady
          ? `Agent 版本过低，需要 ${DIAGNOSTIC_AGENT_VERSION}+`
          : "在线，可执行无侵入诊断";
      return check(
        `agent-${node.hostId}`,
        `Agent · ${node.name}`,
        status,
        message,
        node.agentVersion ? `Agent ${node.agentVersion}` : "未上报 Agent 版本",
      );
    });
}

async function ruleRuntimeCheck(rule: any): Promise<DiagnosticCheck> {
  if (rule?.isForwardGroupTemplate && Number(rule?.forwardGroupId || 0) > 0) {
    const group = await db.getForwardGroupById(Number(rule.forwardGroupId)) as any;
    const childRules = await getForwardGroupChildRulesForTemplate(Number(rule.id));
    let entryMembers: any[] = [];
    if (String(group?.groupMode || "") === "chain" && Number(group?.entryGroupId || 0) > 0) {
      const entryGroup = await db.getForwardGroupById(Number(group.entryGroupId)) as any;
      entryMembers = (entryGroup?.members || []).filter((member: any) => enabled(member?.isEnabled));
    }
    const summary = summarizeForwardGroupRuntime({
      group,
      members: group?.members || [],
      entryMembers,
      templateRules: [rule],
      childRules,
    });
    const ruleSummary = summary.ruleStatuses.find((item) => Number(item.templateRuleId) === Number(rule.id));
    const expected = Number(ruleSummary?.expectedRuleCount || 0);
    const running = Number(ruleSummary?.runningRuleCount || 0);
    const configured = Number(ruleSummary?.configuredRuleCount || 0);

    if (String(ruleSummary?.status || summary.status) === "running" && expected > 0 && running >= expected) {
      return check(
        "runtime",
        "入口运行状态",
        "pass",
        `托管监听已确认运行（${running}/${expected}）`,
        "模板规则自身不承载监听，运行状态来自其生成的托管子规则",
      );
    }
    if (rule.isEnabled === false) {
      return check("runtime", "入口运行状态", "skip", "规则已停用");
    }
    return check(
      "runtime",
      "入口运行状态",
      "warn",
      expected > 0
        ? `等待托管监听确认（运行 ${running}/${expected}，已配置 ${configured}/${expected}）`
        : "尚未生成可确认的托管监听",
      "模板规则自身的 isRunning 不代表实际监听状态",
    );
  }

  return check(
    "runtime",
    "入口运行状态",
    rule?.isRunning ? "pass" : "warn",
    rule?.isRunning ? "Agent 已确认规则运行" : "等待 Agent 确认规则运行",
    "实时连通性以本次诊断探测结果为准",
  );
}

async function diagnosticLatencyMode(
  scope: "rule" | "tunnel" | "chain" | "full-chain",
  resource: any,
  segments: DiagnosticSegment[],
): Promise<HopTestLatencyMode> {
  if (scope !== "rule" || !segments.some((segment) => segment.method === "tcp")) return "sum";

  const rule = resource as any;
  const targetRuleId = Number(rule?.targetRuleId || 0);
  if (targetRuleId > 0) {
    const referenced = await db.getForwardRuleById(targetRuleId) as any;
    const savedChain = referenced?.forwardGroupId
      ? await db.getForwardGroupById(Number(referenced.forwardGroupId)) as any
      : null;
    if (referenced && String(savedChain?.groupMode || "") === "chain") {
      let sourceHostCount = 1;
      if (Number(rule.forwardGroupId || 0) > 0) {
        const sourceGroup = await db.getForwardGroupById(Number(rule.forwardGroupId)) as any;
        const sourceHostIds = String(sourceGroup?.groupMode || "") === "port"
          ? await db.getForwardGroupRuleEntryHostIds(Number(sourceGroup.id))
          : await groupHostIds(sourceGroup);
        sourceHostCount = Math.max(1, sourceHostIds.length);
      }
      const kernelForward = ["iptables", "nftables"].includes(
        String(savedChain.forwardType || "").trim().toLowerCase(),
      );
      if (kernelForward) {
        return sourceHostCount > 1 || Number(savedChain.entryGroupId || 0) > 0
          ? "multi-source-remaining-path"
          : "remaining-path";
      }
    }
  }

  if (Number(rule?.forwardGroupId || 0) > 0) {
    const group = await db.getForwardGroupById(Number(rule.forwardGroupId)) as any;
    if (
      String(group?.groupMode || "") === "chain"
      && ["iptables", "nftables"].includes(String(group?.forwardType || "").trim().toLowerCase())
    ) {
      return Number(group?.entryGroupId || 0) > 0
        ? "multi-source-remaining-path"
        : "remaining-path";
    }
  }

  return "sum";
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


type DiagnosticSegment = {
  fromHostId: number;
  targetIp: string;
  targetPort: number;
  method: "tcp" | "ping";
  routeLabel: string;
  sourcePort?: number;
  sourceProtocol?: "tcp" | "udp" | "both";
  expectedRuleId?: number;
  expectedForwardType?: string;
  isFinalTarget?: boolean;
};

function activeRuntimeRule(rule: any) {
  return !!rule
    && rule.pendingDelete !== true
    && rule.isEnabled !== false
    && !rule.isForwardGroupTemplate
    && Number(rule.id || 0) > 0
    && Number(rule.hostId || 0) > 0
    && Number(rule.sourcePort || 0) > 0;
}

function normalizeDiagnosticProtocol(value: unknown): "tcp" | "udp" | "both" {
  const protocol = String(value || "").trim().toLowerCase();
  return protocol === "udp" ? "udp" : protocol === "tcp" ? "tcp" : "both";
}

async function runtimeRulesForRule(rule: any, visited = new Set<number>()): Promise<any[]> {
  const ruleId = Number(rule?.id || 0);
  if (ruleId > 0 && visited.has(ruleId)) return [];
  const nextVisited = new Set(visited);
  if (ruleId > 0) nextVisited.add(ruleId);

  const result: any[] = [];
  if (rule?.isForwardGroupTemplate) {
    for (const child of await getForwardGroupChildRulesForTemplate(ruleId)) {
      if (activeRuntimeRule(child)) result.push(child);
    }
  } else if (activeRuntimeRule(rule)) {
    result.push(rule);
  }

  const targetRuleId = Number(rule?.targetRuleId || 0);
  if (targetRuleId > 0) {
    const referenced = await db.getForwardRuleById(targetRuleId) as any;
    if (referenced) result.push(...await runtimeRulesForRule(referenced, nextVisited));
  }

  return result;
}

function uniqueRuntimeRules(rules: any[]) {
  const seen = new Set<number>();
  return rules.filter((rule) => {
    const id = Number(rule?.id || 0);
    if (id <= 0 || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function runtimeRulesForResource(
  scope: "rule" | "tunnel" | "chain" | "full-chain",
  resource: any,
) {
  if (scope === "rule") return uniqueRuntimeRules(await runtimeRulesForRule(resource));

  if (scope === "tunnel") {
    const rules = await db.getForwardRulesByTunnel(Number(resource?.id || 0)) as any[];
    return uniqueRuntimeRules(rules.filter(activeRuntimeRule));
  }

  if (scope === "chain") {
    const templates = await getForwardGroupTemplateRules(Number(resource?.id || 0));
    const nested = await Promise.all((templates as any[]).map((rule) => runtimeRulesForRule(rule)));
    return uniqueRuntimeRules(nested.flat());
  }

  const nodes = await db.getFullChainNodes(Number(resource?.id || 0)) as any[];
  const rules: any[] = [];
  for (const node of nodes) {
    const ruleId = Number(node?.generatedRuleId || 0);
    if (ruleId <= 0) continue;
    const rule = await db.getForwardRuleById(ruleId) as any;
    if (rule) rules.push(...await runtimeRulesForRule(rule));
  }
  return uniqueRuntimeRules(rules);
}

function decorateSegmentsWithRuntimeRules(segments: DiagnosticSegment[], runtimeRules: any[]) {
  return segments.map((segment, index) => {
    const candidates = runtimeRules.filter((rule) => Number(rule?.hostId || 0) === Number(segment.fromHostId));
    const exact = candidates.find((rule) =>
      String(rule?.targetIp || "").trim().toLowerCase() === String(segment.targetIp || "").trim().toLowerCase()
      && Number(rule?.targetPort || 0) === Number(segment.targetPort || 0)
    );
    const expected = exact || (candidates.length === 1 ? candidates[0] : null);
    return {
      ...segment,
      sourcePort: Number(expected?.sourcePort || segment.sourcePort || 0) || undefined,
      sourceProtocol: expected ? normalizeDiagnosticProtocol(expected.protocol) : segment.sourceProtocol,
      expectedRuleId: Number(expected?.id || segment.expectedRuleId || 0) || undefined,
      expectedForwardType: String(expected?.forwardType || segment.expectedForwardType || "").trim() || undefined,
      isFinalTarget: segment.isFinalTarget === true || index === segments.length - 1,
    };
  });
}

async function configSyncChecks(hostIds: number[]) {
  const revision = await latestConfigRevision();
  const checks: DiagnosticCheck[] = [];
  for (const hostId of Array.from(new Set(hostIds.filter((id) => id > 0)))) {
    const host = await db.getHostById(hostId) as any;
    if (!host) continue;
    const applied = Number(host.agentLastAppliedRevision || 0);
    const received = Number(host.agentLastReceivedRevision || 0);
    const appliedHash = String(host.agentLastAppliedHash || "").trim();
    const receivedHash = String(host.agentLastReceivedHash || "").trim();
    const hashMismatch = !!appliedHash && !!receivedHash && appliedHash !== receivedHash;
    const synced = revision <= 0 || (applied >= revision && received >= revision && !hashMismatch);
    checks.push(check(
      `config-sync-${hostId}`,
      `配置同步 · ${host.name || "主机 #" + hostId}`,
      synced ? "pass" : "warn",
      synced ? "Panel 与 Agent 已同步" : hashMismatch ? "Agent 已接收配置但应用哈希不一致" : "Agent 尚未应用面板最新配置版本",
      `Panel rev ${revision || "—"} · received ${received || "—"} · applied ${applied || "—"}${hashMismatch ? " · hash mismatch" : ""}`,
    ));
  }
  return checks;
}

async function runtimeReadinessChecks(
  scope: "rule" | "tunnel" | "chain" | "full-chain",
  resource: any,
  runtimeRules: any[],
  hostIds: number[],
) {
  const checks: DiagnosticCheck[] = [];
  const now = Date.now();
  const uniqueHosts = Array.from(new Set(hostIds.filter((id) => id > 0)));

  for (const hostId of uniqueHosts) {
    const host = await db.getHostById(hostId) as any;
    const snapshot = getAgentLocalRuntimeStateSnapshot(hostId);
    const fresh = !!snapshot && now - Number(snapshot.updatedAt || 0) <= 120_000;
    const expected = runtimeRules.filter((rule) => Number(rule?.hostId || 0) === hostId);

    if (!snapshot || !fresh) {
      checks.push(check(
        `runtime-real-${hostId}`,
        `真实运行状态 · ${host?.name || "主机 #" + hostId}`,
        "warn",
        "暂缺新鲜的 Agent 本地运行快照",
        snapshot ? `快照距今 ${Math.max(0, Math.round((now - snapshot.updatedAt) / 1000))} 秒` : "等待 Agent 上报本地运行状态",
      ));
      continue;
    }

    if (scope === "tunnel") {
      const tunnelId = Number(resource?.id || 0);
      const localTunnels = (snapshot.state?.tunnels || []).filter((item: any) => Number(item?.tunnelId || 0) === tunnelId);
      if (localTunnels.length > 0) {
        const ready = localTunnels.filter((item: any) => item?.ready !== false).length;
        checks.push(check(
          `runtime-real-${hostId}`,
          `真实监听 · ${host?.name || "主机 #" + hostId}`,
          ready === localTunnels.length ? "pass" : "fail",
          ready === localTunnels.length ? `Agent 已确认 ${ready} 个隧道监听就绪` : `仅 ${ready}/${localTunnels.length} 个隧道监听就绪`,
        ));
        continue;
      }
    }

    if (expected.length === 0) {
      checks.push(check(
        `runtime-real-${hostId}`,
        `真实运行状态 · ${host?.name || "主机 #" + hostId}`,
        "skip",
        "当前路径没有需要在该主机确认的托管监听",
      ));
      continue;
    }

    const missing: number[] = [];
    const notReady: number[] = [];
    for (const rule of expected) {
      const local = (snapshot.state?.rules || []).find((item: any) =>
        Number(item?.ruleId || 0) === Number(rule.id)
        && Number(item?.port || 0) === Number(rule.sourcePort)
      );
      if (!local) missing.push(Number(rule.id));
      else if (local.ready === false) notReady.push(Number(rule.id));
    }

    const ok = missing.length === 0 && notReady.length === 0;
    checks.push(check(
      `runtime-real-${hostId}`,
      `真实监听/规则 · ${host?.name || "主机 #" + hostId}`,
      ok ? "pass" : "fail",
      ok ? `Agent 已实测确认 ${expected.length} 个运行项就绪` : "实际运行状态与面板期望不一致",
      [
        missing.length ? `缺失规则 #${missing.join(", #")}` : "",
        notReady.length ? `未就绪规则 #${notReady.join(", #")}` : "",
      ].filter(Boolean).join("；") || "iptables/nftables 检查内核规则，进程型后端检查实际监听与进程",
    ));
  }
  return checks;
}

async function portConflictChecks(runtimeRules: any[]) {
  const checks: DiagnosticCheck[] = [];
  const byHost = new Map<number, any[]>();
  for (const rule of runtimeRules) {
    const hostId = Number(rule?.hostId || 0);
    if (hostId <= 0) continue;
    byHost.set(hostId, [...(byHost.get(hostId) || []), rule]);
  }

  for (const [hostId, expectedRules] of byHost) {
    const host = await db.getHostById(hostId) as any;
    const expectedIds = new Set(expectedRules.map((rule) => Number(rule.id)));
    const expectedPorts = new Set(expectedRules.map((rule) => Number(rule.sourcePort)).filter((port) => port > 0));
    const databaseRules = (await db.getForwardRulesForAgent(hostId) as any[]).filter(activeRuntimeRule);
    const conflicts = databaseRules.filter((rule) =>
      expectedPorts.has(Number(rule.sourcePort || 0))
      && !expectedIds.has(Number(rule.id || 0))
    );
    const snapshot = getAgentLocalRuntimeStateSnapshot(hostId);
    const runtimeConflicts = (snapshot?.state?.rules || []).filter((item: any) =>
      expectedPorts.has(Number(item?.port || 0))
      && Number(item?.ruleId || 0) > 0
      && !expectedIds.has(Number(item.ruleId))
    );
    const ids = Array.from(new Set([...conflicts, ...runtimeConflicts].map((item: any) => Number(item.id || item.ruleId || 0)).filter((id) => id > 0)));
    checks.push(check(
      `port-conflict-${hostId}`,
      `端口冲突 · ${host?.name || "主机 #" + hostId}`,
      ids.length > 0 ? "fail" : "pass",
      ids.length > 0 ? `发现 ${ids.length} 个托管规则占用冲突` : "未发现托管规则端口冲突",
      ids.length > 0 ? `冲突规则 #${ids.join(", #")}` : `检查端口 ${Array.from(expectedPorts).sort((a, b) => a - b).join(", ")}`,
    ));
  }
  return checks;
}

async function templateIntegrityChecks(templates: any[]) {
  const checks: DiagnosticCheck[] = [];
  for (const template of uniqueRuntimeRules(templates.filter(Boolean))) {
    // uniqueRuntimeRules excludes templates by design; this branch is intentionally unreachable.
    void template;
  }

  const seenTemplates = new Set<number>();
  for (const template of templates) {
    const templateId = Number(template?.id || 0);
    if (templateId <= 0 || seenTemplates.has(templateId) || !template?.isForwardGroupTemplate) continue;
    seenTemplates.add(templateId);
    const group = await db.getForwardGroupById(Number(template.forwardGroupId || 0)) as any;
    if (!group) {
      checks.push(check(`integrity-${templateId}`, `托管规则完整性 · #${templateId}`, "fail", "模板引用的转发组不存在"));
      continue;
    }
    const childRules = await getForwardGroupChildRulesForTemplate(templateId) as any[];
    let entryMembers: any[] = [];
    if (String(group.groupMode || "") === "chain" && Number(group.entryGroupId || 0) > 0) {
      const entryGroup = await db.getForwardGroupById(Number(group.entryGroupId)) as any;
      entryMembers = (entryGroup?.members || []).filter((member: any) => enabled(member?.isEnabled));
    }
    const summary = summarizeForwardGroupRuntime({
      group,
      members: group.members || [],
      entryMembers,
      templateRules: [template],
      childRules,
    });
    const row = summary.ruleStatuses.find((item) => Number(item.templateRuleId) === templateId);
    const expected = Number(row?.expectedRuleCount || 0);
    const configured = Number(row?.configuredRuleCount || 0);
    const activeChildren = childRules.filter((child) => child.pendingDelete !== true);
    const keys = new Set<string>();
    let duplicates = 0;
    for (const child of activeChildren) {
      const key = `${Number(child.forwardGroupMemberId || 0)}:${Number(child.hostId || 0)}:${Number(child.sourcePort || 0)}`;
      if (keys.has(key)) duplicates += 1;
      keys.add(key);
    }
    const ok = expected > 0 && configured === expected && duplicates === 0;
    checks.push(check(
      `integrity-${templateId}`,
      `托管子规则完整性 · ${template.name || "#" + templateId}`,
      ok ? "pass" : "fail",
      ok ? `应生成 ${expected} 条，实际 ${configured} 条，关系完整` : `应生成 ${expected} 条，实际 ${configured} 条${duplicates ? "，并发现重复" : ""}`,
      duplicates ? `重复子规则 ${duplicates} 条` : "未发现重复托管子规则",
    ));
  }
  return checks;
}

async function diagnosticTemplates(
  scope: "rule" | "tunnel" | "chain" | "full-chain",
  resource: any,
) {
  const templates: any[] = [];
  const addRule = async (rule: any, visited = new Set<number>()) => {
    const id = Number(rule?.id || 0);
    if (id <= 0 || visited.has(id)) return;
    const next = new Set(visited);
    next.add(id);
    if (rule?.isForwardGroupTemplate) templates.push(rule);
    const targetRuleId = Number(rule?.targetRuleId || 0);
    if (targetRuleId > 0) {
      const referenced = await db.getForwardRuleById(targetRuleId) as any;
      if (referenced) await addRule(referenced, next);
    }
  };

  if (scope === "rule") await addRule(resource);
  if (scope === "chain") templates.push(...await getForwardGroupTemplateRules(Number(resource?.id || 0)) as any[]);
  if (scope === "full-chain") {
    const nodes = await db.getFullChainNodes(Number(resource?.id || 0)) as any[];
    for (const node of nodes) {
      const ruleId = Number(node?.generatedRuleId || 0);
      if (ruleId <= 0) continue;
      const rule = await db.getForwardRuleById(ruleId) as any;
      if (rule) await addRule(rule);
    }
  }
  return templates;
}

async function hostTarget(hostId: number) {
  const host = await db.getHostById(hostId) as any;
  return { host, address: hostAddress(host) };
}

async function tunnelSegments(tunnel: any, finalTarget?: { ip: string; port: number } | null): Promise<DiagnosticSegment[]> {
  const segments: DiagnosticSegment[] = [];
  const hops = await db.getTunnelHops(Number(tunnel?.id || 0)).catch(() => []) as any[];
  if (hops.length >= 2) {
    for (let index = 0; index < hops.length - 1; index += 1) {
      const current = hops[index];
      const next = hops[index + 1];
      const fromHostId = Number(current?.hostId || 0);
      const { host: currentHost } = await hostTarget(fromHostId);
      const { host: nextHost, address } = await hostTarget(Number(next?.hostId || 0));
      const targetIp = String(next?.connectHost || address || "").trim();
      const targetPort = Number(next?.listenPort || 0);
      if (fromHostId > 0 && targetIp && targetPort > 0) {
        segments.push({
          fromHostId,
          targetIp,
          targetPort,
          method: "tcp",
          routeLabel: `${currentHost?.name || "主机" + fromHostId} -> ${nextHost?.name || targetIp}`,
        });
      }
    }
  } else {
    const entryHostId = Number(tunnel?.entryHostId || 0);
    const exitHostId = Number(tunnel?.exitHostId || 0);
    const { host: entryHost } = await hostTarget(entryHostId);
    const { host: exitHost, address } = await hostTarget(exitHostId);
    const targetIp = String(tunnel?.connectHost || address || "").trim();
    const targetPort = Number(tunnel?.listenPort || 0);
    if (entryHostId > 0 && targetIp && targetPort > 0) {
      segments.push({
        fromHostId: entryHostId,
        targetIp,
        targetPort,
        method: "tcp",
        routeLabel: `${entryHost?.name || "主机" + entryHostId} -> ${exitHost?.name || targetIp}`,
      });
    }
  }

  if (finalTarget?.ip && finalTarget.port > 0) {
    const exitHostId = Number((hops.at(-1) as any)?.hostId || tunnel?.exitHostId || 0);
    const { host: exitHost } = await hostTarget(exitHostId);
    if (exitHostId > 0) {
      segments.push({
        fromHostId: exitHostId,
        targetIp: finalTarget.ip,
        targetPort: finalTarget.port,
        method: "tcp",
        routeLabel: `${exitHost?.name || "出口"} -> ${finalTarget.ip}:${finalTarget.port}`,
      });
    }
  }
  return segments;
}

async function diagnosticSegments(scope: "rule" | "tunnel" | "chain" | "full-chain", resource: any): Promise<DiagnosticSegment[]> {
  if (scope === "chain") {
    const probes = await db.getForwardGroupChainProbes(Number(resource.id), { includeFinalTarget: false });
    return probes.map((probe: any) => ({
      fromHostId: Number(probe.fromHostId),
      targetIp: String(probe.targetIp || ""),
      targetPort: Number(probe.targetPort || 0),
      method: (probe.method === "ping" ? "ping" : "tcp") as "ping" | "tcp",
      routeLabel: String(probe.routeLabel || probe.hopLabel || "链路"),
    })).filter((item: DiagnosticSegment) => item.fromHostId > 0 && !!item.targetIp && (item.method === "ping" || item.targetPort > 0));
  }

  if (scope === "tunnel") {
    return tunnelSegments(resource);
  }

  if (scope === "rule") {
    const rule = resource as any;
    const targetRuleId = Number(rule.targetRuleId || 0);
    if (targetRuleId > 0) {
      const referenced = await db.getForwardRuleById(targetRuleId) as any;
      const savedGroup = referenced?.forwardGroupId
        ? await db.getForwardGroupById(Number(referenced.forwardGroupId)) as any
        : null;
      if (referenced && String(savedGroup?.groupMode || "") === "chain") {
        const segments: DiagnosticSegment[] = [];
        let sourceHostIds: number[] = [];
        if (Number(rule.forwardGroupId || 0) > 0) {
          const sourceGroup = await db.getForwardGroupById(Number(rule.forwardGroupId)) as any;
          sourceHostIds = String(sourceGroup?.groupMode || "") === "port"
            ? await db.getForwardGroupRuleEntryHostIds(Number(sourceGroup.id))
            : await groupHostIds(sourceGroup);
        } else if (Number(rule.hostId || 0) > 0) {
          sourceHostIds = [Number(rule.hostId)];
        }
        const entryHostId = await db.getForwardGroupDefaultHostId(Number(savedGroup.id));
        const entryHost = await db.getHostById(entryHostId) as any;
        for (const sourceHostId of sourceHostIds) {
          const sourceHost = await db.getHostById(sourceHostId) as any;
          if (String(rule.targetIp || "") && Number(rule.targetPort || 0) > 0) {
            segments.push({
              fromHostId: sourceHostId,
              targetIp: String(rule.targetIp),
              targetPort: Number(rule.targetPort),
              method: "tcp",
              routeLabel: `${sourceHost?.name || "入口"} -> ${entryHost?.name || "引用转发链"}`,
            });
          }
        }
        const probes = await db.getForwardGroupChainProbes(Number(savedGroup.id), { includeFinalTarget: true, templateRule: referenced });
        for (const probe of probes as any[]) {
          segments.push({
            fromHostId: Number(probe.fromHostId),
            targetIp: String(probe.targetIp || ""),
            targetPort: Number(probe.targetPort || 0),
            method: (probe.method === "ping" ? "ping" : "tcp") as "ping" | "tcp",
            routeLabel: String(probe.routeLabel || probe.hopLabel || "链路"),
          });
        }
        return segments.filter((item) => item.fromHostId > 0 && item.targetIp && (item.method === "ping" || item.targetPort > 0));
      }
    }

    if (Number(rule.tunnelId || 0) > 0) {
      const tunnel = await db.getTunnelById(Number(rule.tunnelId)) as any;
      if (tunnel) {
        return tunnelSegments(tunnel, {
          ip: String(rule.targetIp || ""),
          port: Number(rule.targetPort || 0),
        });
      }
    }

    if (Number(rule.forwardGroupId || 0) > 0) {
      const group = await db.getForwardGroupById(Number(rule.forwardGroupId)) as any;
      if (String(group?.groupMode || "") === "chain") {
        const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: true, templateRule: rule });
        return probes.map((probe: any) => ({
          fromHostId: Number(probe.fromHostId),
          targetIp: String(probe.targetIp || ""),
          targetPort: Number(probe.targetPort || 0),
          method: (probe.method === "ping" ? "ping" : "tcp") as "ping" | "tcp",
          routeLabel: String(probe.routeLabel || probe.hopLabel || "链路"),
        })).filter((item: DiagnosticSegment) => item.fromHostId > 0 && !!item.targetIp && (item.method === "ping" || item.targetPort > 0));
      }

      const entryHostIds = String(group?.groupMode || "") === "port"
        ? await db.getForwardGroupRuleEntryHostIds(Number(group.id))
        : await groupHostIds(group);
      return Promise.all(entryHostIds.map(async (fromHostId) => {
        const sourceHost = await db.getHostById(fromHostId) as any;
        return {
          fromHostId,
          targetIp: String(rule.targetIp || ""),
          targetPort: Number(rule.targetPort || 0),
          method: "tcp" as const,
          routeLabel: `${sourceHost?.name || "入口"} -> ${String(rule.targetIp || "目标")}:${Number(rule.targetPort || 0)}`,
        };
      }));
    }

    const fromHostId = Number(rule.hostId || 0);
    const sourceHost = await db.getHostById(fromHostId) as any;
    return fromHostId > 0 && String(rule.targetIp || "") && Number(rule.targetPort || 0) > 0
      ? [{
          fromHostId,
          targetIp: String(rule.targetIp),
          targetPort: Number(rule.targetPort),
          method: "tcp",
          routeLabel: `${sourceHost?.name || "入口"} -> ${rule.targetIp}:${rule.targetPort}`,
        }]
      : [];
  }

  const chain = resource as any;
  const nodes = await db.getFullChainNodes(Number(chain.id)) as any[];
  const segments: DiagnosticSegment[] = [];
  let previousExitHostId = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (String(node?.nodeType || "host") === "forward-chain" && Number(node?.forwardGroupId || 0) > 0) {
      const group = await db.getForwardGroupById(Number(node.forwardGroupId)) as any;
      const templateRule = Number(node.generatedRuleId || 0) > 0
        ? await db.getForwardRuleById(Number(node.generatedRuleId)) as any
        : null;
      const entryHostId = await db.getForwardGroupDefaultHostId(Number(group.id));
      const entryHost = await db.getHostById(entryHostId) as any;
      if (previousExitHostId > 0 && entryHostId > 0) {
        const sourceHost = await db.getHostById(previousExitHostId) as any;
        const targetIp = hostAddress(entryHost);
        if (targetIp && Number(chain.port || 0) > 0) {
          segments.push({
            fromHostId: previousExitHostId,
            targetIp,
            targetPort: Number(chain.port),
            method: "tcp",
            routeLabel: `${sourceHost?.name || "上一跳"} -> ${entryHost?.name || "转发链入口"}`,
          });
        }
      }
      const probes = await db.getForwardGroupChainProbes(Number(group.id), { includeFinalTarget: !!templateRule, templateRule });
      for (const probe of probes as any[]) {
        segments.push({
          fromHostId: Number(probe.fromHostId),
          targetIp: String(probe.targetIp || ""),
          targetPort: Number(probe.targetPort || 0),
          method: (probe.method === "ping" ? "ping" : "tcp") as "ping" | "tcp",
          routeLabel: String(probe.routeLabel || probe.hopLabel || "转发链"),
        });
      }
      const memberIds = await groupHostIds(group);
      previousExitHostId = Number(memberIds.at(-1) || entryHostId || 0);
      continue;
    }

    const hostId = Number(node?.hostId || 0);
    if (hostId <= 0) continue;
    if (previousExitHostId > 0) {
      const sourceHost = await db.getHostById(previousExitHostId) as any;
      const targetHost = await db.getHostById(hostId) as any;
      const targetIp = String(node?.ingressIp || hostAddress(targetHost)).trim();
      if (targetIp && Number(chain.port || 0) > 0) {
        segments.push({
          fromHostId: previousExitHostId,
          targetIp,
          targetPort: Number(chain.port),
          method: "tcp",
          routeLabel: `${sourceHost?.name || "上一跳"} -> ${targetHost?.name || targetIp}`,
        });
      }
    }
    previousExitHostId = hostId;
  }
  return segments;
}

export const diagnosticsRouter = router({
  start: protectedProcedure
    .input(z.object({
      scope: z.enum(["rule", "tunnel", "chain", "full-chain"]),
      id: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      const resource = await ensureAccess(input.scope, input.id, ctx.user);
      const runtimeRules = await runtimeRulesForResource(input.scope, resource);
      const rawSegments = await diagnosticSegments(input.scope, resource);
      const segments = decorateSegmentsWithRuntimeRules(rawSegments, runtimeRules);
      if (segments.length === 0) throw new Error("当前资源没有可执行的实时诊断链路");
      const latencyMode = await diagnosticLatencyMode(input.scope, resource, segments);
      const sourceHostIds = Array.from(new Set(segments.map((segment) => Number(segment.fromHostId)).filter((id) => id > 0)));
      for (const hostId of sourceHostIds) {
        const host = await db.getHostById(hostId) as any;
        if (!host?.isOnline) throw new Error(`${host?.name || "主机 #" + hostId} Agent 离线，无法执行实时诊断`);
        if (!isAgentVersionAtLeast(host?.agentVersion, DIAGNOSTIC_AGENT_VERSION)) {
          throw new Error(`${host?.name || "主机 #" + hostId} 需要升级 Agent 到 ${DIAGNOSTIC_AGENT_VERSION} 或更高版本后才能执行无侵入诊断`);
        }
      }
      const diagnosticId = `diag-${input.scope}-${input.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const testIds: number[] = [];
      const hostIds = new Set<number>();
      for (const [index, segment] of segments.entries()) {
        const id = await db.createForwardTest({
          ruleId: 0,
          hostId: segment.fromHostId,
          userId: Number(ctx.user.id),
          status: "pending",
          listenOk: false,
          targetReachable: false,
          forwardOk: false,
          message: JSON.stringify({
            kind: "diagnostic-hop",
            diagnosticId,
            targetIp: segment.targetIp,
            targetPort: segment.targetPort,
            method: segment.method,
            latencyMode,
            sourcePort: Number(segment.sourcePort || 0) || 0,
            sourceProtocol: segment.sourceProtocol || "both",
            expectedRuleId: Number(segment.expectedRuleId || 0) || 0,
            expectedForwardType: segment.expectedForwardType || "",
            sampleCount: 5,
            isFinalTarget: segment.isFinalTarget === true,
            hopLabel: `${index + 1}/${segments.length}`,
            routeLabel: segment.routeLabel,
          }),
        } as any);
        testIds.push(Number(id));
        hostIds.add(segment.fromHostId);
      }
      for (const hostId of hostIds) {
        pushAgentSelfTest(hostId, diagnosticId);
      }
      return {
        diagnosticId,
        testIds,
        queued: testIds.length,
        latencyMode,
        segments: segments.map((segment, index) => ({
          index,
          routeLabel: segment.routeLabel,
          fromHostId: segment.fromHostId,
          targetIp: segment.targetIp,
          targetPort: segment.targetPort,
          method: segment.method,
          sourcePort: segment.sourcePort || 0,
          expectedRuleId: segment.expectedRuleId || 0,
          expectedForwardType: segment.expectedForwardType || "",
          isFinalTarget: segment.isFinalTarget === true,
        })),
      };
    }),

  status: protectedProcedure
    .input(z.object({
      testIds: z.array(z.number().int().positive()).min(1).max(64),
    }))
    .query(async ({ input, ctx }) => {
      const rows: Array<{ row: any; meta: any }> = [];
      for (const id of input.testIds) {
        const row = await db.getForwardTestById(id) as any;
        if (!row) continue;
        if (String(ctx.user.role) !== "admin" && Number(row.userId) !== Number(ctx.user.id)) continue;
        let meta: any = null;
        try { meta = JSON.parse(String(row.message || "")); } catch {}
        rows.push({ row, meta });
      }

      const latencyMode = (rows.find((item) => item.meta?.latencyMode)?.meta?.latencyMode || "sum") as HopTestLatencyMode;
      const rawDetails: HopTestResult[] = rows.map(({ row, meta }, index) => ({
        success: String(row.status) === "success",
        latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
        message: typeof meta?.detail === "string" ? meta.detail : null,
        hopLabel: typeof meta?.hopLabel === "string" ? meta.hopLabel : `${index + 1}/${rows.length}`,
        routeLabel: typeof meta?.routeLabel === "string" ? meta.routeLabel : "",
        method: typeof meta?.method === "string" ? meta.method : null,
      }));
      const adjustedDetails = adjustHopTestDetailsForLatencyMode(rawDetails, latencyMode);

      const sampleArrays = rows.map(({ meta }) =>
        Array.isArray(meta?.latencySamples)
          ? meta.latencySamples.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value) && value >= 0).slice(0, 8)
          : []
      );
      const successfulSampleCounts = rows
        .map(({ row }, index) => String(row.status) === "success" ? sampleArrays[index].length : 0)
        .filter((count) => count > 0);
      const commonSampleCount = successfulSampleCounts.length === rows.filter(({ row }) => String(row.status) === "success").length
        && successfulSampleCounts.length > 0
        ? Math.min(...successfulSampleCounts)
        : 0;
      const adjustedSamplesByRow: number[][] = rows.map(() => []);

      for (let sampleIndex = 0; sampleIndex < commonSampleCount; sampleIndex += 1) {
        const sampleDetails: HopTestResult[] = rows.map(({ row, meta }, index) => ({
          success: String(row.status) === "success" && Number.isFinite(sampleArrays[index]?.[sampleIndex]),
          latencyMs: Number.isFinite(sampleArrays[index]?.[sampleIndex]) ? sampleArrays[index][sampleIndex] : null,
          message: null,
          hopLabel: typeof meta?.hopLabel === "string" ? meta.hopLabel : `${index + 1}/${rows.length}`,
          routeLabel: typeof meta?.routeLabel === "string" ? meta.routeLabel : "",
          method: typeof meta?.method === "string" ? meta.method : null,
        }));
        const adjustedSampleDetails = adjustHopTestDetailsForLatencyMode(sampleDetails, latencyMode);
        adjustedSampleDetails.forEach((detail, index) => {
          const value = Number(detail.latencyMs);
          if (detail.success && Number.isFinite(value) && value >= 0) adjustedSamplesByRow[index].push(value);
        });
      }

      const median = (values: number[]) => {
        if (values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
          : Math.round(sorted[middle]);
      };
      const average = (values: number[]) =>
        values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
      const jitter = (values: number[]) => {
        if (values.length < 2) return 0;
        let total = 0;
        for (let index = 1; index < values.length; index += 1) total += Math.abs(values[index] - values[index - 1]);
        return Math.round(total / (values.length - 1));
      };

      return rows.map(({ row, meta }, index) => {
        const adjusted = adjustedDetails[index];
        const rawLatencyMs = row.latencyMs == null ? null : Number(row.latencyMs);
        const samples = adjustedSamplesByRow[index];
        const sampleLatency = median(samples);
        const latencyMs = sampleLatency ?? (adjusted?.latencyMs == null ? null : Number(adjusted.latencyMs));
        const latencyAdjusted = rawLatencyMs !== null
          && latencyMs !== null
          && Math.round(rawLatencyMs) !== Math.round(latencyMs);
        const targetText = String(meta?.targetIp || "").trim()
          ? `${String(meta.targetIp)}${Number(meta?.targetPort || 0) > 0 ? ":" + Number(meta.targetPort) : ""}`
          : "";
        const methodText = String(meta?.method || "tcp").toUpperCase();
        const displayDetail = latencyAdjusted && String(row.status) === "success"
          ? `${targetText ? "目标 " + targetText + " " : ""}${methodText}可达，逐跳延迟 ${Math.round(latencyMs || 0)}ms`
          : typeof meta?.detail === "string" ? meta.detail : "";

        const inspection = meta?.portInspection && typeof meta.portInspection === "object"
          ? meta.portInspection
          : null;
        const issues: Array<{ severity: "warn" | "fail"; message: string }> = [];
        if (inspection?.portConflict === true) {
          issues.push({ severity: "fail", message: "检测到监听端口冲突" });
        }
        if (
          Number(meta?.sourcePort || 0) > 0
          && Number(meta?.expectedRuleId || 0) > 0
          && inspection?.available === true
          && inspection?.runtimeReady !== true
        ) {
          issues.push({ severity: "fail", message: "Agent 实测运行规则未就绪" });
        }
        const attempts = Math.max(0, Number(meta?.sampleAttempts || 0));
        const successes = Math.max(0, Number(meta?.sampleSuccesses || 0));
        if (attempts > 0 && successes < attempts && successes > 0) {
          issues.push({ severity: "warn", message: `稳定性采样 ${successes}/${attempts} 成功` });
        }
        if (meta?.dnsError && meta?.dnsSkipped !== true) {
          issues.push({ severity: "fail", message: `DNS 解析失败：${String(meta.dnsError)}` });
        }

        return {
          id: Number(row.id),
          status: String(row.status || "pending"),
          latencyMs,
          rawLatencyMs,
          latencyAdjusted,
          latencyMode,
          latencySamples: samples,
          minLatencyMs: samples.length ? Math.round(Math.min(...samples)) : latencyMs,
          averageLatencyMs: samples.length ? average(samples) : latencyMs,
          maxLatencyMs: samples.length ? Math.round(Math.max(...samples)) : latencyMs,
          jitterMs: samples.length ? jitter(samples) : Number(meta?.jitterMs || 0),
          sampleAttempts: attempts,
          sampleSuccesses: successes,
          dnsMs: meta?.dnsMs == null ? null : Number(meta.dnsMs),
          dnsAddresses: Array.isArray(meta?.dnsAddresses) ? meta.dnsAddresses : [],
          dnsError: String(meta?.dnsError || ""),
          dnsSkipped: meta?.dnsSkipped === true,
          portInspection: inspection,
          isFinalTarget: meta?.isFinalTarget === true,
          issues,
          success: String(row.status) === "success",
          targetReachable: !!row.targetReachable,
          message: JSON.stringify({
            ...(meta || {}),
            latencyMs,
            rawLatencyMs,
            latencyAdjusted,
            latencySamples: samples,
            minLatencyMs: samples.length ? Math.round(Math.min(...samples)) : latencyMs,
            averageLatencyMs: samples.length ? average(samples) : latencyMs,
            maxLatencyMs: samples.length ? Math.round(Math.max(...samples)) : latencyMs,
            jitterMs: samples.length ? jitter(samples) : Number(meta?.jitterMs || 0),
            issues,
            detail: displayDetail,
          }),
          routeLabel: typeof meta?.routeLabel === "string" ? meta.routeLabel : "",
          hopLabel: typeof meta?.hopLabel === "string" ? meta.hopLabel : "",
          updatedAt: row.updatedAt,
        };
      });
    }),

  plan: protectedProcedure
    .input(z.object({
      scope: z.enum(["rule", "tunnel", "chain", "full-chain"]),
      id: z.number().int().positive(),
    }))
    .query(async ({ input, ctx }) => {
      const resource = await ensureAccess(input.scope, input.id, ctx.user);
      const runtimeRules = await runtimeRulesForResource(input.scope, resource);
      const templates = await diagnosticTemplates(input.scope, resource);
      const checks: DiagnosticCheck[] = [];
      let nodes: DiagnosticNode[] = [];
      let title = String(resource?.name || `资源 #${input.id}`);
      let target = "";
      let liveTestSupported = true;

      if (input.scope === "rule") {
        const rule = resource as any;
        const hostIds = await ruleHostIds(rule);
        const targetRuleId = Number(rule.targetRuleId || 0);
        const referencedRule = targetRuleId > 0
          ? await db.getForwardRuleById(targetRuleId) as any
          : null;
        let landing: any = null;
        if (Number(rule.targetLandingServiceId || 0) > 0) {
          landing = await db.getLandingServiceById(Number(rule.targetLandingServiceId), true) as any;
        }

        nodes = await buildNodes(hostIds, Number(landing?.hostId || 0));

        const referencedFinalIp = String(referencedRule?.targetIp || "").trim();
        const referencedFinalPort = Number(referencedRule?.targetPort || 0);
        const referencedFinalName = String(referencedRule?.name || "").trim();
        if (referencedRule && referencedFinalIp && referencedFinalPort > 0) {
          target = referencedFinalName
            ? `${referencedFinalName} · ${referencedFinalIp}:${referencedFinalPort}`
            : `${referencedFinalIp}:${referencedFinalPort}`;
        } else {
          target = landing
            ? `${String(landing.endpoint || "")}:${Number(landing.port || 0)}`
            : `${String(rule.targetIp || "")}:${Number(rule.targetPort || 0)}`;
        }

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
        checks.push(await ruleRuntimeCheck(rule));

        if (referencedRule) {
          const chainEntry = String(rule.targetIp || "").trim();
          const chainEntryPort = Number(rule.targetPort || 0);
          checks.push(check(
            "target",
            "目标配置",
            referencedFinalIp && referencedFinalPort > 0 ? "pass" : "fail",
            `引用转发链 · ${referencedFinalName || "已完成转发"}`,
            chainEntry && chainEntryPort > 0
              ? `链路入口 ${chainEntry}:${chainEntryPort}；最终出口 ${target || "未解析"}`
              : `最终出口 ${target || "未解析"}`,
          ));
          checks.push(check("landing", "落地 SS", "skip", "当前规则引用已完成转发链，落地由被引用链路负责"));
        } else {
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

      const managedHostIds = Array.from(new Set([
        ...nodes.map((node) => Number(node.hostId || 0)),
        ...runtimeRules.map((rule) => Number(rule?.hostId || 0)),
      ].filter((id) => id > 0)));
      checks.push(...await configSyncChecks(managedHostIds));
      checks.push(...await runtimeReadinessChecks(input.scope, resource, runtimeRules, managedHostIds));
      checks.push(...await portConflictChecks(runtimeRules));
      checks.push(...await templateIntegrityChecks(templates));
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
