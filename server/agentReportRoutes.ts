import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import * as db from "./db";
import { notifyTopologyBlockTransitions } from "./topologyBlockNotifier";
import { isHostMetricsWatching, isHostTopologyTrafficWatching, pushAgentRefresh } from "./agentEvents";
import {
  isAgentForwardGroupLatencyResult,
  isAgentHostProbeServiceResult,
  isAgentTopologySegmentLatencyResult,
  isAgentHostTrafficStat,
  isAgentLandingTrafficStat,
  isAgentTcpingResult,
  isAgentTrafficStat,
  isAgentTunnelTcpingResult,
  normalizeAgentProbeCounts,
  type AgentForwardGroupLatencyResult,
  type AgentHostProbeServiceResult,
  type AgentTopologySegmentLatencyResult,
  type AgentHostTrafficStat,
  type AgentTcpingResult,
  type AgentTrafficStat,
  type AgentTunnelTcpingResult,
} from "../shared/agentDtos";
import { recordForwardGroupAutoHopLatency } from "./forwardGroupAutoLatencyState";
import { getTunnelAutoHopAggregate, getTunnelAutoHopDetails, recordTunnelAutoHopLatency } from "./tunnelAutoLatencyState";
import { getTunnelMultiEntryHopDetails, getTunnelMultiEntryLatency, recordTunnelMultiEntryLatency } from "./tunnelMultiEntryLatencyState";
import { completeLookingGlassAgentTask, updateLookingGlassAgentTaskProgress, type LookingGlassMethod } from "./lookingGlassAgentTasks";
import { completeIperf3AgentTask } from "./iperf3AgentTasks";
import { completePluginAgentTask } from "./pluginAgentTasks";
import { getAgentHostIdentityFromRequest } from "./agentAuth";
import { applyTrafficMultiplier, normalizeTrafficMultiplier } from "../shared/trafficMultiplier";
import { mapWithConcurrency } from "./asyncPool";
import { forwardGroupProbeTopologyKey, tunnelProbeTopologyKey } from "./probeTopology";
import { recordLandingGroupProbe } from "./landingGroupProbes";
import { trafficBillingUserLockKey, withKeyedTaskLock } from "./keyedTaskLock";
import { isTunnelRelayFailover, tunnelRelayCandidates } from "../shared/tunnelRelay";
import { exitGroupUsesMultipleExits } from "../shared/exitStrategy";
import { isRuleLatencyReportMethodCompatible } from "../shared/latencyProbe";
import { completeSupportBundleHost } from "./supportBundle";
import {
  combineTunnelRuleLatencySample,
  directRuleLatencyTopologyKey,
  validateTunnelRuleLatencyReport,
} from "./ruleLatency";
import { clearRuleLatencyQueryCaches } from "./ruleLatencyQueryCache";
import { agentTcpingReportGate } from "./agentTcpingReportGate";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";
import { branchedTunnelExitEndpoints, relayBranchedTunnelExitEndpoints } from "./tunnelBranchPlan";
import { completeAgentLinkProbeTask } from "./agentLinkTasks";
import { completeExternalForwardPortCheck } from "./externalForwardPorts";

const VERBOSE_AGENT_REPORTS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_REPORTS || ""));

async function refreshUserRuleAgents(userId: number, reason: string) {
  const rules = await db.getForwardRulesForUserSync(userId);
  const hostIds = new Set<number>();
  const tunnelIds = new Set<number>();
  for (const rule of rules as any[]) {
    if (rule.hostId) hostIds.add(Number(rule.hostId));
    if (rule.tunnelId) tunnelIds.add(Number(rule.tunnelId));
  }
  for (const tunnelId of tunnelIds) {
    const tunnel = await db.getTunnelById(tunnelId);
    if (!tunnel) continue;
    await db.updateTunnel(tunnelId, { isRunning: false } as any);
    hostIds.add(Number(tunnel.entryHostId));
    hostIds.add(Number(tunnel.exitHostId));
  }
  for (const hostId of hostIds) {
    if (hostId > 0) pushAgentRefresh(hostId, reason);
  }
}

function cleanTunnelSeriesKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return key.slice(0, 64);
}

function cleanTunnelSeriesLabel(value: unknown, fallback: string) {
  const label = String(value || "").trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
  return (label || fallback).slice(0, 96);
}
function isForwardXTunnel(tunnel: any) {
  return String(tunnel?.mode || "").toLowerCase() === "forwardx";
}

function tunnelUsesExtraExitHosts(tunnel: any) {
  return !!tunnel?.loadBalanceEnabled
    && String(tunnel?.loadBalanceStrategy || "").trim().toLowerCase() !== "none";
}

async function withTrafficAccountingUserLocks<T>(userIds: number[], task: () => Promise<T>): Promise<T> {
  const keys = Array.from(new Set(userIds
    .map((id) => Math.floor(Number(id) || 0))
    .filter((id) => id > 0)))
    .sort((left, right) => left - right)
    .map(trafficBillingUserLockKey);
  const run = (index: number): Promise<T> => index >= keys.length
    ? task()
    : withKeyedTaskLock(keys[index], () => run(index + 1));
  return run(0);
}

export function trafficAccountingHostIds(
  rule: any,
  tunnel: any | null,
  entryHostIds: Set<number> | undefined,
  extraExitHostIds: Set<number> | undefined,
) {
  if (!tunnel) return new Set([Number(rule.hostId || 0)]);
  if (isForwardXTunnel(tunnel)) {
    return entryHostIds && entryHostIds.size > 0
      ? new Set(entryHostIds)
      : new Set([Number(tunnel.entryHostId || 0)]);
  }
  const ids = new Set<number>([Number(tunnel.exitHostId || 0)]);
  if (tunnelUsesExtraExitHosts(tunnel)) {
    for (const hostId of extraExitHostIds || []) ids.add(Number(hostId));
  }
  return ids;
}

export function shouldAccountForwardRuleTraffic(rule: any, group: any | null) {
  const groupId = Number(rule?.forwardGroupId || 0);
  const templateId = Number(rule?.forwardGroupRuleId || 0);
  const memberId = Number(rule?.forwardGroupMemberId || 0);
  if (!groupId || !templateId || !memberId) return true;
  if (String(group?.groupMode || "failover") !== "chain") return true;
  const members = [...(group.members || [])]
    .filter((member: any) => !!member.isEnabled)
    .sort((a: any, b: any) => Number(a.priority) - Number(b.priority));
  const firstMember = members[0] as any;
  if (Number(firstMember?.id || 0) !== memberId) return false;
  const firstHostId = Number(firstMember?.hostId || 0);
  if (!firstHostId) return true;
  return Number(rule?.hostId || 0) === firstHostId;
}

function quotaTrafficMultiplierForRule(rule: any, tunnel: any | null, group: any | null) {
  const groupId = Number(rule?.forwardGroupId || 0);
  if (groupId > 0) {
    if (group && ["port", "chain", "failover"].includes(String(group?.groupMode || "failover"))) {
      return normalizeTrafficMultiplier(group?.trafficMultiplier);
    }
  }
  if (tunnel) return normalizeTrafficMultiplier((tunnel as any).trafficMultiplier);
  return 100;
}

const trafficReportLogIntervalMs = 10_000;
const tcpingReportLogIntervalMs = 30_000;
// Keep one operational traffic summary per host every few minutes. Per-rule
// samples remain opt-in via FORWARDX_VERBOSE_AGENT_REPORTS.
const trafficReportSummaryLogIntervalMs = 5 * 60_000;
const REPORT_LOG_CACHE_MAX = 20_000;
const REPORT_LOG_CACHE_RETENTION_MS = 60 * 60 * 1000;

type TrafficReportLogBucket = {
  lastLoggedAt: number;
  updatedAt: number;
  samples: number;
  bytesIn: number;
  bytesOut: number;
  connectionsMax: number;
};

const trafficReportLogBuckets = new Map<string, TrafficReportLogBucket>();
const reportLogTimes = new Map<string, number>();

function pruneReportLogCaches(now = Date.now()) {
  pruneMapEntries(
    trafficReportLogBuckets,
    (bucket) => !Number.isFinite(bucket.updatedAt) || now - bucket.updatedAt >= REPORT_LOG_CACHE_RETENTION_MS,
  );
  pruneMapEntries(
    reportLogTimes,
    (loggedAt) => !Number.isFinite(loggedAt) || now - loggedAt >= REPORT_LOG_CACHE_RETENTION_MS,
  );
}

const reportLogCacheCleanupTimer = setInterval(() => pruneReportLogCaches(), 10 * 60 * 1000);
reportLogCacheCleanupTimer.unref?.();

function logTrafficReportSample(key: string, label: string, bytesIn: number, bytesOut: number, connections: number) {
  if (!VERBOSE_AGENT_REPORTS) return;
  const now = Date.now();
  const bucket = trafficReportLogBuckets.get(key) || {
    lastLoggedAt: 0,
    updatedAt: now,
    samples: 0,
    bytesIn: 0,
    bytesOut: 0,
    connectionsMax: 0,
  };
  bucket.samples += 1;
  bucket.bytesIn += Math.max(0, Number(bytesIn) || 0);
  bucket.bytesOut += Math.max(0, Number(bytesOut) || 0);
  bucket.connectionsMax = Math.max(bucket.connectionsMax, Number(connections) || 0);
  bucket.updatedAt = now;
  if (bucket.lastLoggedAt === 0 || now - bucket.lastLoggedAt >= trafficReportLogIntervalMs) {
    console.log(`${label} samples=${bucket.samples} in=${bucket.bytesIn} out=${bucket.bytesOut} connectionsMax=${bucket.connectionsMax}`);
    setBoundedMapValue(trafficReportLogBuckets, key, {
      lastLoggedAt: now,
      updatedAt: now,
      samples: 0,
      bytesIn: 0,
      bytesOut: 0,
      connectionsMax: 0,
    }, REPORT_LOG_CACHE_MAX);
    return;
  }
  setBoundedMapValue(trafficReportLogBuckets, key, bucket, REPORT_LOG_CACHE_MAX);
}

function shouldLogReport(key: string, intervalMs: number) {
  const now = Date.now();
  const last = reportLogTimes.get(key) || 0;
  if (now - last < intervalMs) return false;
  setBoundedMapValue(reportLogTimes, key, now, REPORT_LOG_CACHE_MAX);
  return true;
}

function logTrafficReportSummary(input: {
  hostId: number;
  hostName?: string;
  reported: number;
  accepted: number;
  routedAway: number;
  ignored: number;
  bytesIn: number;
  bytesOut: number;
  hostBytesIn?: number;
  hostBytesOut?: number;
  duplicate?: boolean;
  durationMs: number;
}) {
  if (input.hostId <= 0 || !shouldLogReport(`traffic-summary:${input.hostId}`, trafficReportSummaryLogIntervalMs)) return;
  const name = String(input.hostName || "-").replace(/[\r\n\t]+/g, " ").slice(0, 96);
  const hostBytes = input.hostBytesIn !== undefined || input.hostBytesOut !== undefined
    ? ` hostBytes=${Math.max(0, Number(input.hostBytesIn) || 0)}/${Math.max(0, Number(input.hostBytesOut) || 0)}`
    : "";
  console.info(
    `[Agent Traffic] summary host=${input.hostId} name=${name} reported=${input.reported} accepted=${input.accepted}`
      + ` routedAway=${input.routedAway} ignored=${input.ignored}`
      + ` bytes=${Math.max(0, Number(input.bytesIn) || 0)}/${Math.max(0, Number(input.bytesOut) || 0)}`
      + `${hostBytes} duplicate=${input.duplicate === true} duration=${Math.max(0, Number(input.durationMs) || 0)}ms`,
  );
}

function logTcpingReportSummary(
  hostId: number,
  results: AgentTcpingResult[],
  tunnelResults: AgentTunnelTcpingResult[],
  forwardGroupResults: AgentForwardGroupLatencyResult[],
  serviceResults: AgentHostProbeServiceResult[],
) {
  if (!VERBOSE_AGENT_REPORTS) return;
  if (!shouldLogReport(`tcping:${hostId}`, tcpingReportLogIntervalMs)) return;
  const all = [...results, ...tunnelResults, ...forwardGroupResults, ...serviceResults] as Array<{ latencyMs?: unknown; isTimeout?: unknown }>;
  const timeouts = all.filter((item) => !!item.isTimeout).length;
  const latencies = all
    .map((item) => Number(item.latencyMs))
    .filter((value) => Number.isFinite(value) && value > 0);
  const avgLatency = latencies.length
    ? `${Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)}ms`
    : "-";
  console.info(`[Agent TCPing] host=${hostId} rules=${results.length} tunnels=${tunnelResults.length} groups=${forwardGroupResults.length} services=${serviceResults.length} timeouts=${timeouts}/${all.length} avg=${avgLatency}`);
}

function compactTrafficStats(value: unknown): AgentTrafficStat[] {
  if (!Array.isArray(value)) return [];
  const stats: AgentTrafficStat[] = [];
  for (const row of value) {
    if (!Array.isArray(row)) continue;
    const ruleId = Number(row[0]);
    if (!Number.isFinite(ruleId)) continue;
    stats.push({
      ruleId,
      bytesIn: Number(row[1]) || 0,
      bytesOut: Number(row[2]) || 0,
      connections: Number(row[3]) || 0,
    });
  }
  return stats;
}

function tunnelReportEnabled(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || (typeof value === "string" && ["1", "true"].includes(value.trim().toLowerCase()));
}

async function tunnelEntryHostIds(tunnel: any) {
  const ids = new Set<number>();
  const primary = Number(tunnel?.entryHostId || 0);
  if (primary > 0) ids.add(primary);
  const entryGroupId = Number(tunnel?.entryGroupId || 0);
  if (entryGroupId > 0) {
    const group = await db.getForwardGroupById(entryGroupId) as any;
    if (tunnelReportEnabled(group?.isEnabled) && String(group.groupMode || "") === "entry") {
      for (const member of group.members || []) {
        const hostId = tunnelReportEnabled(member?.isEnabled, true) && member?.memberType === "host" ? Number(member.hostId || 0) : 0;
        if (hostId > 0) ids.add(hostId);
      }
    }
  }
  return ids;
}

export function tunnelProbeTargetHostId(
  tunnel: any,
  hops: any[],
  exitNodes: any[],
  report: AgentTunnelTcpingResult,
  seriesKey = "",
) {
  const hopIndex = Number(report.hopIndex);
  const hopCount = Number(report.hopCount);
  if (Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0) {
    const relayBranchEntry = seriesKey.match(/^relay-branch-entry-(\d+)$/);
    const relayBranchExit = seriesKey.match(/^relay-branch-exit-(\d+)-(\d+)$/);
    if (relayBranchEntry) return Number(relayBranchEntry[1]) || null;
    if (relayBranchExit) return Number(relayBranchExit[2]) || null;
    const branchMatch = seriesKey.match(/^branch-exit-(\d+)$/);
    if (branchMatch) {
      const endpoint = branchedTunnelExitEndpoints(tunnel, hops, exitNodes).find((item) => Number(item.hostId) === Number(branchMatch[1]));
      return endpoint ? Number(endpoint.hostId) : null;
    }
    if (isTunnelRelayFailover(tunnel, hops) && /^relay-\d+$/.test(seriesKey)) {
      const relayIndex = Number(seriesKey.slice("relay-".length)) - 1;
      const relay = tunnelRelayCandidates(hops)[relayIndex] as any;
      if (relay && hopIndex === 0) return Number(relay.hostId || 0) || null;
      if (relay && hopIndex === 1) return Number(hops[hops.length - 1]?.hostId || 0) || null;
    }
    return Number(hops[hopIndex + 1]?.hostId || 0) || null;
  }
  if (seriesKey === "primary") return Number(tunnel?.exitHostId || 0) || null;
  const exitMatch = seriesKey.match(/^exit-(\d+)$/);
  if (exitMatch && tunnel?.loadBalanceEnabled && exitGroupUsesMultipleExits(tunnel?.loadBalanceStrategy)) {
    const exitIndex = Number(exitMatch[1]) - 2;
    const activeExits = [...(exitNodes || [])]
      .filter((node) => node?.isEnabled !== false && Number(node?.hostId || 0) > 0 && Number(node?.listenPort || 0) > 0)
      .sort((left, right) => Number(left?.seq || 0) - Number(right?.seq || 0));
    if (exitIndex >= 0) return Number(activeExits[exitIndex]?.hostId || 0) || null;
  }
  return Number(tunnel?.exitHostId || 0) || null;
}

type TunnelRelayAggregate = {
  key: string;
  label: string;
  aggregate: { success: boolean; latencyMs: number | null; probeCount?: number; probeSuccesses?: number } | null;
};

export function readyTunnelRelayAggregates(aggregates: TunnelRelayAggregate[]) {
  const completed = aggregates.filter((item): item is TunnelRelayAggregate & {
    aggregate: { success: boolean; latencyMs: number | null; probeCount?: number; probeSuccesses?: number };
  } => item.aggregate !== null);
  return completed.some((item) => item.aggregate.success) || completed.length === aggregates.length
    ? completed
    : [];
}

export async function validateTunnelProbeSource(
  hostId: number,
  tunnel: any,
  report: AgentTunnelTcpingResult,
  context?: { hops: any[]; exitNodes: any[]; entryHostIds?: Set<number>; topologyKey?: string },
) {
  if (!tunnel?.isEnabled) return false;
  const hops = context?.hops || await db.getTunnelHops(Number(tunnel.id)) as any[];
  const exitNodes = context?.exitNodes || await db.getTunnelExitNodes(Number(tunnel.id)) as any[];
  const topologyKey = String((report as any).topologyKey || "");
  const expectedTopologyKey = context?.topologyKey || tunnelProbeTopologyKey(tunnel, hops, exitNodes);
  if (topologyKey && topologyKey !== expectedTopologyKey) return false;
  const hopIndex = Number(report.hopIndex);
  const hopCount = Number(report.hopCount);
  const relayBranchEndpoints = relayBranchedTunnelExitEndpoints(tunnel, hops, exitNodes);
  if (relayBranchEndpoints.length > 0) {
    if (!topologyKey || topologyKey !== expectedTopologyKey || hopCount !== 2) return false;
    const key = String(report.seriesKey || "");
    const entryMatch = key.match(/^relay-branch-entry-(\d+)$/);
    const exitMatch = key.match(/^relay-branch-exit-(\d+)-(\d+)$/);
    const relays = tunnelRelayCandidates(hops) as any[];
    if (entryMatch && hopIndex === 0) {
      const relay = relays.find((item) => Number(item.hostId) === Number(entryMatch[1]));
      const entryIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
      return !!relay && entryIds.has(Number(hostId)) && Number(report.targetPort) === Number(relay.listenPort);
    }
    if (exitMatch && hopIndex === 1) {
      const relay = relays.find((item) => Number(item.hostId) === Number(exitMatch[1]));
      const endpoint = relayBranchEndpoints.find((item) => Number(item.hostId) === Number(exitMatch[2]));
      return !!relay && !!endpoint && Number(relay.hostId) === Number(hostId) && Number(report.targetPort) === Number(endpoint.listenPort);
    }
    return false;
  }
  const branchEndpoints = branchedTunnelExitEndpoints(tunnel, hops, exitNodes);
  if (branchEndpoints.length > 0) {
    if (!topologyKey || topologyKey !== expectedTopologyKey || !Number.isInteger(hopIndex) || hopCount !== hops.length - 1 || hopIndex < 0 || hopIndex >= hopCount) return false;
    if (hopIndex === 0) {
      const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
      if (!entryHostIds.has(Number(hostId))) return false;
    } else if (Number(hops[hopIndex]?.hostId || 0) !== Number(hostId)) return false;
    const key = String(report.seriesKey || "");
    if (hopIndex < hopCount - 1) return key === "branch-common" && Number(report.targetPort) === Number(hops[hopIndex + 1]?.listenPort);
    const match = key.match(/^branch-exit-(\d+)$/);
    const endpoint = match ? branchEndpoints.find((item) => Number(item.hostId) === Number(match[1])) : null;
    return !!endpoint && Number(report.targetPort) === Number(endpoint.listenPort);
  }
  if (Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0) {
    if (isTunnelRelayFailover(tunnel, hops)) {
      const relayMatch = String(report.seriesKey || "").match(/^relay-(\d+)$/);
      const relayIndex = Number(relayMatch?.[1] || 0);
      const relays = tunnelRelayCandidates(hops) as any[];
      if (!relayMatch || relayIndex <= 0 || relayIndex > relays.length || hopCount !== 2 || hopIndex < 0 || hopIndex > 1) return false;
      const relay = relays[relayIndex - 1] as any;
      if (hopIndex === 0) {
        const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
        return entryHostIds.has(Number(hostId))
          && (!report.targetPort || Number(relay?.listenPort || 0) === Number(report.targetPort));
      }
      const finalExit = hops[hops.length - 1] as any;
      return Number(relay?.hostId || 0) === Number(hostId)
        && (!report.targetPort || Number(finalExit?.listenPort || 0) === Number(report.targetPort));
    }
    if (!Array.isArray(hops) || hops.length - 1 !== hopCount || hopIndex < 0 || hopIndex >= hopCount) return false;
    if (hopIndex === 0) {
      const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
      if (!entryHostIds.has(Number(hostId))) return false;
    } else if (Number(hops[hopIndex]?.hostId || 0) !== Number(hostId)) {
      return false;
    }
    const expectedPort = Number(hops[hopIndex + 1]?.listenPort || 0);
    return !report.targetPort || expectedPort === Number(report.targetPort);
  }
  const entryHostIds = context?.entryHostIds || await tunnelEntryHostIds(tunnel);
  if (!entryHostIds.has(Number(hostId))) return false;
  const expectedPorts = new Set<number>([Number(tunnel.listenPort || 0)]);
  for (const node of exitNodes) {
    if (node?.isEnabled !== false && Number(node?.listenPort || 0) > 0) expectedPorts.add(Number(node.listenPort));
  }
  return !report.targetPort || expectedPorts.has(Number(report.targetPort));
}

function sameProbeTarget(left: unknown, right: unknown) {
  return String(left || "").trim().replace(/^\[|\]$/g, "").toLowerCase()
    === String(right || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

export function summarizeTunnelBranches(branches: Array<{ latencyMs: number | null; isTimeout: boolean; probeCount?: number; probeSuccesses?: number }>) {
  const successful = branches.filter((branch) => !branch.isTimeout && Number(branch.latencyMs || 0) > 0);
  const normalizeBranchCounts = (branch: typeof branches[number]) => {
    const rawCount = Number(branch.probeCount);
    const probeCount = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 1024 ? rawCount : 1;
    const rawSuccesses = Number(branch.probeSuccesses);
    const hasSuccesses = branch.probeSuccesses !== undefined
      && branch.probeSuccesses !== null
      && Number.isInteger(rawSuccesses);
    const probeSuccesses = Math.max(0, Math.min(
      probeCount,
      hasSuccesses ? rawSuccesses : (branch.isTimeout ? 0 : probeCount),
    ));
    return { probeCount, probeSuccesses };
  };
  const successfulCounts = successful
    .map(normalizeBranchCounts)
    .sort((left, right) => right.probeSuccesses / right.probeCount - left.probeSuccesses / left.probeCount);
  const allCounts = branches.map(normalizeBranchCounts);
  const result: {
    unavailable: boolean;
    partial: boolean;
    latencyMs: number | null;
    probeCount?: number;
    probeSuccesses?: number;
  } = {
    unavailable: successful.length === 0,
    partial: successful.length > 0 && successful.length < branches.length,
    latencyMs: successful.length > 0 ? Math.max(...successful.map((branch) => Number(branch.latencyMs))) : null,
  };
  let probeCount = 1;
  let probeSuccesses = result.unavailable ? 0 : 1;
  if (successfulCounts.length > 0) {
    ({ probeCount, probeSuccesses } = successfulCounts[0]);
  } else if (allCounts.length > 0) {
    probeCount = Math.max(...allCounts.map((counts) => counts.probeCount), 1);
    const ratio = Math.min(...allCounts.map((counts) => counts.probeSuccesses / counts.probeCount));
    probeSuccesses = Math.max(0, Math.min(probeCount, Math.floor(ratio * probeCount + 1e-9)));
  }
  if (probeCount !== 1 || probeSuccesses !== (result.unavailable ? 0 : 1)) {
    result.probeCount = probeCount;
    result.probeSuccesses = probeSuccesses;
  }
  return result;
}

/**
 * Compose the exit-to-target probe with the current tunnel sample. Both
 * probes describe the same end-to-end request from different hops, so retain
 * the lowest success ratio instead of silently reporting a clean target
 * probe when the tunnel itself had partial loss.
 */
export function combineTunnelRuleProbeCounts(input: {
  target: { isTimeout?: unknown; probeCount?: unknown; probeSuccesses?: unknown };
  tunnel?: { isTimeout?: unknown; probeCount?: unknown; probeSuccesses?: unknown } | null;
  combinedIsTimeout: boolean;
}) {
  const target = normalizeAgentProbeCounts(input.target, { legacyZeroAsSuccess: false });
  if (!input.tunnel) {
    return {
      probeCount: target.probeCount,
      probeSuccesses: input.combinedIsTimeout ? 0 : target.probeSuccesses,
    };
  }
  // Tunnel rows can predate counter telemetry. Successful legacy rows have
  // the new column's zero default, which normalizeAgentProbeCounts recognizes
  // as one successful probe at this database-read boundary.
  const tunnel = normalizeAgentProbeCounts(input.tunnel);
  const probeCount = Math.max(target.probeCount, tunnel.probeCount, 1);
  if (input.combinedIsTimeout) return { probeCount, probeSuccesses: 0 };
  const successRatio = Math.min(
    target.probeSuccesses / target.probeCount,
    tunnel.probeSuccesses / tunnel.probeCount,
  );
  return {
    probeCount,
    probeSuccesses: Math.max(0, Math.min(probeCount, Math.floor(successRatio * probeCount + 1e-9))),
  };
}

function compactHostTraffic(value: unknown): AgentHostTrafficStat | null {
  if (!Array.isArray(value)) return null;
  const bytesIn = Number(value[0]) || 0;
  const bytesOut = Number(value[1]) || 0;
  if (!Number.isFinite(bytesIn) && !Number.isFinite(bytesOut)) return null;
  return { bytesIn, bytesOut };
}

export function registerAgentReportRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/external-port-check-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) { res.status(401).json({ error: "Invalid token" }); return; }
    res.json({ success: completeExternalForwardPortCheck(Number(host.id), req.body) });
  } catch (error) {
    console.error("[ExternalForwardPorts] Agent report failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
agentRouter.post("/api/agent/support-bundle-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const taskId = String(req.body?.taskId || "").trim();
    if (!taskId) {
      res.status(400).json({ error: "taskId is required" });
      return;
    }
    const accepted = completeSupportBundleHost(taskId, Number(host.id), {
      diagnostics: req.body?.diagnostics,
      error: req.body?.error,
    });
    res.json({ success: accepted });
  } catch (error) {
    console.error("[SupportBundle] Agent report failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/agent-link-probe-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const accepted = await completeAgentLinkProbeTask(Number(host.id), result);
    res.json({ success: accepted });
  } catch (error) {
    console.error("[AgentLink] Agent report failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/looking-glass-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = completeLookingGlassAgentTask(host.id, {
      taskId: String(result.taskId),
      method: result.method as LookingGlassMethod,
      target: String(result.target || ""),
      port: result.port === undefined || result.port === null ? undefined : Number(result.port),
      resolvedAddress: String(result.resolvedAddress || ""),
      resolvedAddresses: Array.isArray(result.resolvedAddresses) ? result.resolvedAddresses.map(String) : [],
      output: String(result.output || ""),
      exitCode: result.exitCode === undefined || result.exitCode === null ? null : Number(result.exitCode),
      timedOut: !!result.timedOut,
      durationMs: Number(result.durationMs || 0),
      startedAt: String(result.startedAt || new Date().toISOString()),
      finishedAt: String(result.finishedAt || new Date().toISOString()),
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent LookingGlass] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/looking-glass-progress", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = updateLookingGlassAgentTaskProgress(host.id, {
      taskId: String(result.taskId),
      output: String(result.output || ""),
      durationMs: Number(result.durationMs || 0),
      startedAt: String(result.startedAt || new Date().toISOString()),
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent LookingGlassProgress] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/iperf3-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const result = req.body?.result;
    if (!result?.taskId) {
      res.status(400).json({ error: "result.taskId is required" });
      return;
    }
    const ok = completeIperf3AgentTask(host.id, {
      taskId: String(result.taskId),
      op: result.op === "stop" ? "stop" : "start",
      port: Number(result.port || 5201),
      status: result.status === "stopped" ? "stopped" : result.status === "error" ? "error" : "running",
      output: String(result.output || ""),
      pid: result.pid === undefined || result.pid === null ? null : Number(result.pid),
      startedAt: result.startedAt ? String(result.startedAt) : undefined,
      updatedAt: result.updatedAt ? String(result.updatedAt) : undefined,
      error: result.error ? String(result.error) : undefined,
    });
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent Iperf3] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/plugin-action-result", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    const result = req.body?.result;
    if (!result?.taskId || !result?.groupId || !result?.pluginId || !result?.actionId) {
      res.status(400).json({ error: "plugin action result identifiers are required" });
      return;
    }
    let data = result.data;
    if (data !== undefined) {
      try {
        if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256 * 1024) {
          res.status(400).json({ error: "plugin action result data is too large" });
          return;
        }
      } catch {
        res.status(400).json({ error: "plugin action result data is invalid" });
        return;
      }
    }
    const ok = completePluginAgentTask(host.id, {
      taskId: String(result.taskId),
      groupId: String(result.groupId),
      pluginId: String(result.pluginId),
      actionId: String(result.actionId),
      success: !!result.success,
      output: String(result.output || "").slice(0, 256 * 1024),
      stderr: String(result.stderr || "").slice(0, 256 * 1024),
      data,
      exitCode: result.exitCode === undefined || result.exitCode === null ? null : Number(result.exitCode),
      timedOut: !!result.timedOut,
      durationMs: Math.max(0, Number(result.durationMs || 0)),
      startedAt: result.startedAt ? String(result.startedAt) : undefined,
      finishedAt: result.finishedAt ? String(result.finishedAt) : undefined,
      error: result.error ? String(result.error).slice(0, 4000) : undefined,
      errorDetail: result.errorDetail ? String(result.errorDetail).slice(0, 4000) : undefined,
      advice: result.advice ? String(result.advice).slice(0, 4000) : undefined,
      processError: result.processError ? String(result.processError).slice(0, 4000) : undefined,
    });
    if (ok) await db.syncPluginAgentActionState(String(result.pluginId), String(result.groupId));
    res.json({ success: ok });
  } catch (error) {
    console.error("[Agent Plugin Action] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

agentRouter.post("/api/agent/traffic", async (req: Request, res: Response) => {
  const requestStartedAt = Date.now();
  let logHostId = 0;
  let logHostName = "";
  let reportedStatCount = 0;
  let acceptedStatCount = 0;
  let routedAwayStatCount = 0;
  let ignoredStatCount = 0;
  let acceptedBytesIn = 0;
  let acceptedBytesOut = 0;
  let strictTrafficAccounting = false;
  let trafficReportId = "";
  let trafficReportProducerId = "";
  let duplicateTrafficReport = false;
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    logHostId = Number((host as any).id || 0);
    logHostName = cleanTunnelSeriesLabel((host as any).name, "-");
    trafficReportId = typeof req.body?.reportId === "string"
      ? req.body.reportId.trim().slice(0, 128)
      : "";
    trafficReportProducerId = typeof req.body?.reportProducerId === "string"
      ? req.body.reportProducerId.trim().slice(0, 128)
      : "";

    const objectStats = Array.isArray(req.body?.stats)
      ? req.body.stats.filter(isAgentTrafficStat)
      : [];
    const compactStats = compactTrafficStats(req.body?.s);
    const stats: AgentTrafficStat[] = objectStats.length > 0 ? objectStats : compactStats;
    const landingStats = Array.isArray(req.body?.landingStats) ? req.body.landingStats.filter(isAgentLandingTrafficStat) : [];
    reportedStatCount = stats.length;
    const hostTraffic: AgentHostTrafficStat | null = isAgentHostTrafficStat(req.body?.hostTraffic)
      ? req.body.hostTraffic
      : compactHostTraffic(req.body?.h);
    if (landingStats.length > 0) {
      const services = await Promise.all(landingStats.map((stat: any) => db.getLandingServiceById(stat.landingServiceId)));
      const accepted = landingStats.flatMap((stat: any, index: number) => {
        const service: any = services[index];
        return service && Number(service.hostId) === Number(host.id) ? [{ serviceId: service.id, hostId: Number(host.id), userId: Number(service.userId), bytesIn: Math.max(0, Number(stat.bytesIn) || 0), bytesOut: Math.max(0, Number(stat.bytesOut) || 0), connections: Math.max(0, Number(stat.connections) || 0), isFullChainManaged: !!service.isFullChainManaged }] : [];
      });
      await db.recordLandingServiceTraffic(accepted.filter((item: any) => !item.isFullChainManaged));
      await db.recordFullChainTraffic(accepted.filter((item: any) => item.isFullChainManaged));
    }
    if (!Array.isArray(req.body?.stats) && !Array.isArray(req.body?.s) && !hostTraffic) {
      res.status(400).json({ error: "stats array or hostTraffic is required" });
      return;
    }
    // An idle Agent may only report the host-wide network counters. Avoid
    // opening the full traffic transaction and querying billing/rule/tunnel
    // context when there are no rule deltas to account.
    if (stats.length === 0) {
      await db.withDatabaseTransaction(async () => {
        if (trafficReportId && !await db.claimAgentTrafficReport(host.id, trafficReportId, trafficReportProducerId)) {
          duplicateTrafficReport = true;
          return;
        }
        if (hostTraffic) {
          await db.recordHostTrafficSample(host.id, {
            bytesIn: Number(hostTraffic.bytesIn) || 0,
            bytesOut: Number(hostTraffic.bytesOut) || 0,
          });
        }
      });
      if (duplicateTrafficReport) {
        logTrafficReportSummary({
          hostId: logHostId,
          hostName: logHostName,
          reported: 0,
          accepted: 0,
          routedAway: 0,
          ignored: 0,
          bytesIn: 0,
          bytesOut: 0,
          hostBytesIn: hostTraffic ? Number(hostTraffic.bytesIn) || 0 : undefined,
          hostBytesOut: hostTraffic ? Number(hostTraffic.bytesOut) || 0 : undefined,
          duplicate: true,
          durationMs: Date.now() - requestStartedAt,
        });
        res.json({ success: true, duplicate: true });
        return;
      }
      const durationMs = Date.now() - requestStartedAt;
      logTrafficReportSummary({
        hostId: logHostId,
        hostName: logHostName,
        reported: 0,
        accepted: 0,
        routedAway: 0,
        ignored: 0,
        bytesIn: 0,
        bytesOut: 0,
        hostBytesIn: hostTraffic ? Number(hostTraffic.bytesIn) || 0 : undefined,
        hostBytesOut: hostTraffic ? Number(hostTraffic.bytesOut) || 0 : undefined,
        durationMs,
      });
      if (durationMs >= 2_000 && shouldLogReport(`traffic-slow:${logHostId}`, 60_000)) {
        console.warn(`[Agent Traffic] slow host=${logHostId} name=${logHostName || "-"} stats=0 duration=${durationMs}ms`);
      }
      // No rule delta means the panel cannot infer whether this host is on a
      // strict quota/billing path. Preserve the Agent's last confirmed policy.
      res.json({ success: true });
      return;
    }

    const preliminaryTrafficContexts = await db.getForwardRuleTrafficContextsByIds(
      stats.map((stat) => Number(stat.ruleId)),
    );
    const accountingUserIds = (preliminaryTrafficContexts as any[])
      .map((context) => Number(context?.rule?.userId || 0))
      .filter((userId) => userId > 0);
    await withTrafficAccountingUserLocks(accountingUserIds, () => db.withDatabaseTransaction(async () => {
      // Lock database rows in the same deterministic order as the in-process
      // keyed locks. This protects quota/billing counters when reports arrive
      // concurrently on different panel instances.
      await db.lockTrafficBillingUserRows(accountingUserIds);
      if (trafficReportId && !await db.claimAgentTrafficReport(host.id, trafficReportId, trafficReportProducerId)) {
        duplicateTrafficReport = true;
        return;
      }
      if (hostTraffic) {
        await db.recordHostTrafficSample(host.id, {
          bytesIn: Number(hostTraffic.bytesIn) || 0,
          bytesOut: Number(hostTraffic.bytesOut) || 0,
        });
      }

    const quotaTrafficByUser = new Map<number, number>();
    const trafficBatch: db.TrafficStatBatchItem[] = [];
    const runningRuleIds = new Set<number>();
    const billingEntries: Array<{
      rule: any;
      ruleBytes: number;
      billingResource: NonNullable<Awaited<ReturnType<typeof db.findTrafficBillingResourceForRule>>>;
    }> = [];
    const trafficBillingEnabled = await db.getTrafficBillingEnabledForWrite();
    const trafficContexts = await db.getForwardRuleTrafficContextsByIds(stats.map((stat) => Number(stat.ruleId)));
    const contextsByRuleId = new Map((trafficContexts as any[]).map((context) => [Number(context.rule.id), context]));
    const tunnelContextsById = new Map<number, any>();
    for (const context of trafficContexts as any[]) {
      const tunnelId = Number(context?.tunnel?.id || 0);
      if (tunnelId > 0 && !tunnelContextsById.has(tunnelId)) {
        tunnelContextsById.set(tunnelId, context.tunnel);
      }
    }
    const tunnelContexts = Array.from(tunnelContextsById.values());
    const tunnelIds = Array.from(tunnelContextsById.keys());
    const [entryHostIdPairs, tunnelExitNodes] = await Promise.all([
      Promise.all(tunnelContexts.map(async (tunnel) => [Number(tunnel.id), await tunnelEntryHostIds(tunnel)] as const)),
      tunnelIds.length > 0
        ? db.getTunnelExitNodesByTunnelIds(tunnelIds)
        : Promise.resolve([]),
    ]);
    const entryHostsByTunnelId = new Map<number, Set<number>>(entryHostIdPairs);
    const extraExitHostsByTunnelId = new Map<number, Set<number>>();
    for (const node of tunnelExitNodes as any[]) {
      const tunnelId = Number(node?.tunnelId || 0);
      const hostId = Number(node?.hostId || 0);
      if (tunnelId <= 0 || hostId <= 0 || node?.isEnabled === false) continue;
      const hosts = extraExitHostsByTunnelId.get(tunnelId) || new Set<number>();
      hosts.add(hostId);
      extraExitHostsByTunnelId.set(tunnelId, hosts);
    }
    const rulesWithBytes = new Set(stats
      .filter((stat) => (Number(stat.bytesIn) || 0) + (Number(stat.bytesOut) || 0) > 0)
      .map((stat) => Number(stat.ruleId)));
    const billingResourcesByRuleId = trafficBillingEnabled
      ? await db.findTrafficBillingResourcesForRules((trafficContexts as any[])
        .map((context) => context.rule)
        .filter((rule) => rulesWithBytes.has(Number(rule.id))))
      : new Map();
    for (const stat of stats) {
      const bytesIn = Number(stat.bytesIn) || 0;
      const bytesOut = Number(stat.bytesOut) || 0;
      const context = contextsByRuleId.get(Number(stat.ruleId)) as any;
      if (!context) {
        ignoredStatCount += 1;
        continue;
      }
      const { rule, tunnel, group } = context;
      if ((rule as any).pendingDelete || !(rule as any).isEnabled) {
        ignoredStatCount += 1;
        continue;
      }
      if (!shouldAccountForwardRuleTraffic(rule, group)) {
        ignoredStatCount += 1;
        continue;
      }
      const tunnelId = Number((rule as any).tunnelId || 0);
      const accountingHostIds = trafficAccountingHostIds(
        rule,
        tunnel,
        entryHostsByTunnelId.get(Number(tunnel?.id || tunnelId)),
        extraExitHostsByTunnelId.get(Number(tunnel?.id || tunnelId)),
      );
      if (!accountingHostIds.has(Number(host.id))) {
        routedAwayStatCount += 1;
        const ruleBytes = bytesIn + bytesOut;
        if (ruleBytes > 0 && tunnel && !isForwardXTunnel(tunnel)) {
          logTrafficReportSample(
            `tunnel:${host.id}:${tunnelId}:${rule.id}`,
            `[TunnelTraffic] host=${host.id} tunnel=${tunnelId} rule=${rule.id}`,
            bytesIn,
            bytesOut,
            stat.connections || 0,
          );
        }
        continue;
      }
      trafficBatch.push({
        stat: {
          ruleId: stat.ruleId,
          hostId: host.id,
          bytesIn,
          bytesOut,
          connections: stat.connections || 0,
        },
        userId: Number(rule.userId),
      });
      acceptedStatCount += 1;
      acceptedBytesIn += bytesIn;
      acceptedBytesOut += bytesOut;
      const ruleBytes = bytesIn + bytesOut;
      if (ruleBytes > 0) {
        if (!(rule as any).isRunning) runningRuleIds.add(Number(rule.id));
        logTrafficReportSample(
          `rule:${host.id}:${rule.id}`,
          `[Traffic] host=${host.id} rule=${rule.id}`,
          bytesIn,
          bytesOut,
          stat.connections || 0,
        );
        const billingResource = billingResourcesByRuleId.get(Number(rule.id));
        if (billingResource?.config) {
          billingEntries.push({ rule, ruleBytes, billingResource });
        } else {
          const quotaBytes = applyTrafficMultiplier(ruleBytes, quotaTrafficMultiplierForRule(rule, tunnel, group));
          quotaTrafficByUser.set(rule.userId, (quotaTrafficByUser.get(rule.userId) || 0) + quotaBytes);
        }
      }
    }

    await db.insertTrafficStatsBatch(trafficBatch);
    await db.markForwardRulesRunning(Array.from(runningRuleIds));

    for (const { rule, ruleBytes, billingResource } of billingEntries) {
      strictTrafficAccounting = true;
      const user = await db.getUserById(Number(rule.userId));
      if (user && Number((user as any).balanceCents || 0) <= 0) {
        console.warn(`[TrafficBilling] user=${rule.userId} balance unavailable, disabling rules`);
        await db.setUserForwardAccess(rule.userId, false, "traffic_billing_balance");
        await refreshUserRuleAgents(rule.userId, "traffic-billing-balance-unavailable");
        continue;
      }
      const billed = await db.billTrafficUsage({
        userId: Number(rule.userId),
        ruleId: Number(rule.id),
        bytes: ruleBytes,
        resourceType: billingResource.resourceType,
        resourceId: billingResource.resourceId,
      });
      if (billed && billed.balanceAfterCents < 0) {
        console.warn(`[TrafficBilling] user=${rule.userId} balance negative, disabling rules`);
        await db.setUserForwardAccess(rule.userId, false, "traffic_billing_balance");
        await refreshUserRuleAgents(rule.userId, "traffic-billing-balance-negative");
      }
    }

    // 累加用户已用流量
    await mapWithConcurrency(Array.from(quotaTrafficByUser.entries()), 8, async ([userId, totalBytes]) => {
      if (totalBytes <= 0) return;
      const user = await db.addUserTraffic(userId, totalBytes);

      // 检查用户流量配额
      if (user) {
        if (Number(user.trafficLimit || 0) > 0) strictTrafficAccounting = true;
        // 流量超额：自动禁用该用户所有规则
        if (user.trafficLimit > 0 && user.trafficUsed >= user.trafficLimit) {
          console.log(`[Traffic] User ${user.id} traffic exceeded limit, disabling rules`);
          await db.setUserForwardAccess(user.id, false, "traffic_limit");
          await refreshUserRuleAgents(user.id, "traffic-limit-exceeded");
        }
        // 账户到期：自动禁用该用户所有规则
        if (user.expiresAt && new Date(user.expiresAt) <= new Date()) {
          console.log(`[Traffic] User ${user.id} account expired, disabling rules`);
          await db.setUserForwardAccess(user.id, false, "expired");
          await refreshUserRuleAgents(user.id, "user-expired");
        }
      }
    });
    }));

    if (duplicateTrafficReport) {
      logTrafficReportSummary({
        hostId: logHostId,
        hostName: logHostName,
        reported: reportedStatCount,
        accepted: 0,
        routedAway: 0,
        ignored: 0,
        bytesIn: 0,
        bytesOut: 0,
        duplicate: true,
        durationMs: Date.now() - requestStartedAt,
      });
      res.json({ success: true, duplicate: true });
      return;
    }

    const durationMs = Date.now() - requestStartedAt;
    logTrafficReportSummary({
      hostId: logHostId,
      hostName: logHostName,
      reported: reportedStatCount,
      accepted: acceptedStatCount,
      routedAway: routedAwayStatCount,
      ignored: ignoredStatCount,
      bytesIn: acceptedBytesIn,
      bytesOut: acceptedBytesOut,
      hostBytesIn: hostTraffic ? Number(hostTraffic.bytesIn) || 0 : undefined,
      hostBytesOut: hostTraffic ? Number(hostTraffic.bytesOut) || 0 : undefined,
      durationMs,
    });
    if (durationMs >= 2_000 && shouldLogReport(`traffic-slow:${logHostId}`, 60_000)) {
      console.warn(`[Agent Traffic] slow host=${logHostId} name=${logHostName || "-"} stats=${reportedStatCount} duration=${durationMs}ms`);
    }

    res.json({
      success: true,
      // Topology has an explicit high-frequency mode; after its watcher expires
      // keep this host at one second instead of reverting to the normal batch window.
      trafficReportInterval: 1,
      trafficReportIntervalMs: isHostTopologyTrafficWatching(Number(host.id)) ? 500 : 1_000,
    });
  } catch (error) {
    console.error(`[Agent Traffic] Error host=${logHostId || "-"} name=${logHostName || "-"}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent TCPing 上报接口
agentRouter.post("/api/agent/tcping", async (req: Request, res: Response) => {
  try {
    const host = await getAgentHostIdentityFromRequest(req);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const parsedResults: AgentTcpingResult[] = Array.isArray(req.body?.results)
      ? req.body.results.filter(isAgentTcpingResult)
      : [];
    const rawTunnelResults = Array.isArray(req.body?.tunnels)
      ? req.body.tunnels
      : (Array.isArray(req.body?.tunnelResults) ? req.body.tunnelResults : []);
    const parsedTunnelResults: AgentTunnelTcpingResult[] = rawTunnelResults.filter(isAgentTunnelTcpingResult);
    const rawForwardGroupResults = Array.isArray(req.body?.forwardGroups)
      ? req.body.forwardGroups
      : (Array.isArray(req.body?.forwardGroupResults) ? req.body.forwardGroupResults : []);
    const parsedForwardGroupResults: AgentForwardGroupLatencyResult[] = rawForwardGroupResults.filter(isAgentForwardGroupLatencyResult);
    const rawServiceResults = Array.isArray(req.body?.services)
      ? req.body.services
      : (Array.isArray(req.body?.serviceResults) ? req.body.serviceResults : []);
    const parsedServiceResults: AgentHostProbeServiceResult[] = rawServiceResults.filter(isAgentHostProbeServiceResult);
    const parsedSegmentResults: AgentTopologySegmentLatencyResult[] = Array.isArray(req.body?.segments)
      ? req.body.segments.filter(isAgentTopologySegmentLatencyResult)
      : [];
    // Normalize the optional counters once at the ingress boundary.  This
    // keeps old Agents (which omit them) compatible while preserving partial
    // packet loss reported by newer Agents through every persistence path.
    for (const report of [
      ...parsedResults,
      ...parsedTunnelResults,
      ...parsedForwardGroupResults,
      ...parsedServiceResults,
      ...parsedSegmentResults,
    ]) {
      const probeCounts = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
      Object.assign(report, probeCounts);
      // Keep the legacy boolean and packet counters coherent at the trust
      // boundary. Packet counters are authoritative: a partially successful
      // probe is reachable, while a report with zero successful packets is a
      // timeout even if an Agent used an inconsistent legacy boolean.
      report.isTimeout = probeCounts.probeSuccesses <= 0;
    }
    for (const report of parsedForwardGroupResults) if (report.probeType === "landing") {
      // The Agent already reports a TCP dial result; keep healthy steady-state
      // reports on the 60-second health gate instead of the 5-minute chart gate.
      report.healthStatus = report.isTimeout ? "unhealthy" : "healthy";
    }
    if (parsedResults.length === 0 && parsedTunnelResults.length === 0 && parsedForwardGroupResults.length === 0 && parsedServiceResults.length === 0 && parsedSegmentResults.length === 0) {
      res.status(400).json({ error: "results, tunnels, forwardGroups, services or segments array is required" });
      return;
    }
    const force = req.body?.force === true;
    // The authenticated Agent may report only a visible rule it owns. Runtime
    // chain reconciliation can replace target IP/port just before dispatch,
    // so matching against the stored target here would silently discard a
    // valid physical-hop result.
    const acceptedSegments: any[] = [];
    const sourceHostId = Number(host.id);
    if (parsedSegmentResults.length > 0) {
      const sourceRuntimeRules = await db.getForwardRulesForAgent(sourceHostId);
      const targetHostIdByAddress = new Map<string, number>();
      const targetHostNameByAddress = new Map<string, string>();
      for (const candidate of await db.getHosts()) {
        for (const address of [(candidate as any).entryIp, (candidate as any).ipv4, (candidate as any).ip, (candidate as any).publicIp, (candidate as any).exitIp]) {
          const normalized = String(address || "").trim().toLowerCase();
          if (normalized && !targetHostIdByAddress.has(normalized)) {
            targetHostIdByAddress.set(normalized, Number((candidate as any).id));
            targetHostNameByAddress.set(normalized, String((candidate as any).name || address));
          }
        }
      }
      for (const report of parsedSegmentResults) {
        const targetAddress = String(report.targetIp || "").trim();
        const method = report.method === "ping" ? "ping" : "tcp";
        const targetPort = Number(report.targetPort || 0);
        // The key is deterministic and binds this report to both the reporting
        // host and its configured destination; do not persist Agent-supplied
        // arbitrary segment identifiers.
        const expectedKey = `topology-v1:${sourceHostId}:${targetAddress.toLowerCase()}:${targetPort}:${method}`;
        if (String(report.segmentKey).trim() !== expectedKey) continue;
        const normalizedTargetAddress = targetAddress.toLowerCase();
        const runtimeRules = (sourceRuntimeRules as any[]).filter((rule: any) => {
          if (rule.isEnabled === false || rule.pendingDelete) return false;
          const ownsReport = Number(rule.id) === Number(report.ruleId) || Number(rule.forwardGroupRuleId || 0) === Number(report.ruleId);
          const sharesPingTarget = method === "ping" && String(rule.targetIp || "").trim().toLowerCase() === normalizedTargetAddress;
          return ownsReport || sharesPingTarget;
        });
        if (runtimeRules.length === 0) continue;
        const targetHostId = targetHostIdByAddress.get(targetAddress.toLowerCase()) || null;
        for (const runtimeRule of runtimeRules) acceptedSegments.push({
          ruleId: Number(runtimeRule.forwardGroupRuleId || runtimeRule.id), sourceHostId, targetHostId,
          userId: Number(runtimeRule.userId), sourceName: String((host as any).name || `Host #${sourceHostId}`),
          targetName: targetHostNameByAddress.get(targetAddress.toLowerCase()) || targetAddress,
          targetAddress, targetPort, segmentKey: expectedKey, method,
          latencyMs: report.latencyMs == null ? null : Number(report.latencyMs), isTimeout: !!report.isTimeout,
          probeCount: Number(report.probeCount) || 1, probeSuccesses: Number(report.probeSuccesses) || 0,
        });
      }
    }
    if (acceptedSegments.length > 0) {
      const uniqueSegments = new Map<string, any>();
      for (const sample of acceptedSegments) uniqueSegments.set(`${sample.ruleId}:${sample.segmentKey}`, sample);
      const samples = Array.from(uniqueSegments.values());
      const transitions = await db.updateTopologySegmentIncidents(samples);
      await db.recordTopologySegmentLatency(samples);
      if (transitions.length > 0) void notifyTopologyBlockTransitions(transitions).catch((error) => {
        console.warn(`[Telegram] Topology block notification failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const topologyGatePlan = agentTcpingReportGate.plan({
      hostId: Number(host.id),
      force,
      gateRules: false,
      results: parsedResults,
      tunnels: parsedTunnelResults,
      forwardGroups: parsedForwardGroupResults,
      services: parsedServiceResults,
    });
    const {
      results,
      tunnels: tunnelResults,
      forwardGroups: forwardGroupResults,
      services: serviceResults,
    } = topologyGatePlan;
    if (results.length === 0 && tunnelResults.length === 0 && forwardGroupResults.length === 0 && serviceResults.length === 0) {
      res.json({ success: true });
      return;
    }
    logTcpingReportSummary(host.id, results, tunnelResults, forwardGroupResults, serviceResults);

    const tunnelResultsById = new Map<number, AgentTunnelTcpingResult[]>();
    for (const report of tunnelResults) {
      const tunnelId = Number(report.tunnelId || 0);
      if (tunnelId <= 0) continue;
      const rows = tunnelResultsById.get(tunnelId) || [];
      rows.push(report);
      tunnelResultsById.set(tunnelId, rows);
    }
    await mapWithConcurrency(Array.from(tunnelResultsById.entries()), 12, async ([tunnelId, reports]) => withKeyedTaskLock(`tunnel-latency:${tunnelId}`, async () => {
      const [tunnel, hops, exitNodes] = await Promise.all([
        db.getTunnelById(tunnelId),
        db.getTunnelHops(tunnelId),
        db.getTunnelExitNodes(tunnelId),
      ]) as [any, any[], any[]];
      if (!tunnel) return;
      const entryHostIds = await tunnelEntryHostIds(tunnel);
      const topologyKey = tunnelProbeTopologyKey(tunnel, hops, exitNodes);
      const orderedEntryHostIds = Array.from(entryHostIds).sort((left, right) => left - right);
      const multiEntry = orderedEntryHostIds.length > 1;
      const multiEntryGeneration = `${topologyKey}:entries:${orderedEntryHostIds.join(",")}`;
      const relayFailover = isTunnelRelayFailover(tunnel, hops);
      const relayCandidateCount = relayFailover ? tunnelRelayCandidates(hops).length : 0;
      const branchedEndpoints = branchedTunnelExitEndpoints(tunnel, hops, exitNodes);
      const relayBranchedEndpoints = relayBranchedTunnelExitEndpoints(tunnel, hops, exitNodes);
      const branchByKey = new Map<string, { key: string; label: string; latencyMs: number | null; isTimeout: boolean; probeCount?: number; probeSuccesses?: number }>();
      const relayPathSeries: Array<{ key: string; label: string; latencyMs: number | null; isTimeout: boolean; probeCount?: number; probeSuccesses?: number }> = [];
      let branchUpdated = false;
      let relayPathsPartial = false;
      for (const report of reports) {
        if (!await validateTunnelProbeSource(Number(host.id), tunnel, report, { hops, exitNodes, entryHostIds, topologyKey })) continue;
        const latencyValue = typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null;
        const isTimeout = !!report.isTimeout || latencyValue === null;
        const seriesKey = cleanTunnelSeriesKey(report.seriesKey);
        const hopIndex = Number(report.hopIndex);
        const hopCount = Number(report.hopCount);
        const hasHop = Number.isInteger(hopIndex) && Number.isInteger(hopCount) && hopCount > 0;
        if (relayBranchedEndpoints.length > 0) {
          branchUpdated = true;
          const entryMatch = seriesKey.match(/^relay-branch-entry-(\d+)$/);
          const exitMatch = seriesKey.match(/^relay-branch-exit-(\d+)-(\d+)$/);
          const relayId = Number(entryMatch?.[1] || exitMatch?.[1] || 0);
          const targets = entryMatch ? relayBranchedEndpoints : relayBranchedEndpoints.filter((endpoint) => Number(endpoint.hostId) === Number(exitMatch?.[2] || 0));
          for (const endpoint of targets) {
            const pathKey = `relay-branch-${relayId}-${Number(endpoint.hostId)}`;
            const toHostId = entryMatch ? relayId : Number(endpoint.hostId);
            if (multiEntry) {
              recordTunnelMultiEntryLatency({ tunnelId, sourceHostId: Number(host.id), sourceLabel: String((host as any).name || `入口 ${host.id}`), expectedEntryHostIds: orderedEntryHostIds,
                hopIndex, hopCount, latencyMs: latencyValue, isTimeout, probeCount: report.probeCount, probeSuccesses: report.probeSuccesses, generation: multiEntryGeneration, pathKey, toHostId });
            } else {
              recordTunnelAutoHopLatency({ tunnelId, hopIndex, hopCount, latencyMs: latencyValue, isTimeout, probeCount: report.probeCount, probeSuccesses: report.probeSuccesses,
                generation: multiEntryGeneration, pathKey, fromHostId: Number(host.id), toHostId });
            }
          }
          continue;
        }
        if (branchedEndpoints.length > 0) {
          branchUpdated = true;
          const targets = seriesKey === "branch-common" ? branchedEndpoints : branchedEndpoints.filter((endpoint) => seriesKey === `branch-exit-${Number(endpoint.hostId)}`);
          for (const endpoint of targets) {
            const pathKey = `branch-exit-${Number(endpoint.hostId)}`;
            const toHostId = seriesKey === "branch-common" ? Number(hops[hopIndex + 1]?.hostId || 0) : Number(endpoint.hostId);
            if (multiEntry) {
              recordTunnelMultiEntryLatency({ tunnelId, sourceHostId: Number(host.id), sourceLabel: String((host as any).name || `入口 ${host.id}`),
                expectedEntryHostIds: orderedEntryHostIds, hopIndex, hopCount, latencyMs: latencyValue, isTimeout,
                probeCount: report.probeCount, probeSuccesses: report.probeSuccesses, generation: multiEntryGeneration, pathKey, toHostId });
            } else {
              recordTunnelAutoHopLatency({ tunnelId, hopIndex, hopCount, latencyMs: latencyValue, isTimeout,
                probeCount: report.probeCount, probeSuccesses: report.probeSuccesses, generation: multiEntryGeneration, pathKey,
                fromHostId: Number(host.id), toHostId });
            }
          }
          continue;
        }
        if (multiEntry) {
          const aggregate = recordTunnelMultiEntryLatency({
            tunnelId,
            sourceHostId: Number(host.id),
            sourceLabel: String((host as any).name || `入口 ${host.id}`),
            expectedEntryHostIds: orderedEntryHostIds,
            hopIndex: hasHop ? hopIndex : 0,
            hopCount: hasHop ? hopCount : 1,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: multiEntryGeneration,
            pathKey: seriesKey || "default",
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          if (!aggregate) continue;
          const recordedAt = new Date();
          await mapWithConcurrency(aggregate.details, 4, async (detail) => {
            const detailSeriesKey = cleanTunnelSeriesKey(`entry-${detail.hostId}${seriesKey ? `-${seriesKey}` : ""}`);
            const branchLabel = seriesKey ? cleanTunnelSeriesLabel(report.seriesLabel, seriesKey) : "";
            await db.insertTunnelLatencyStat({
              tunnelId,
              latencyMs: detail.isTimeout ? null : detail.latencyMs,
              isTimeout: detail.isTimeout,
              probeCount: detail.probeCount ?? 1,
              probeSuccesses: detail.probeSuccesses ?? (detail.isTimeout ? 0 : 1),
              seriesKey: detailSeriesKey,
              seriesLabel: cleanTunnelSeriesLabel(
                branchLabel ? `${detail.label} / ${branchLabel}` : detail.label,
                `入口 ${detail.hostId}`,
              ),
              recordedAt,
            }, { preserveMessage: true, updateTunnel: false });
          });
          if (seriesKey) {
            const label = cleanTunnelSeriesLabel(report.seriesLabel, seriesKey === "primary" ? "主出口" : seriesKey);
            branchByKey.set(seriesKey, {
              key: seriesKey,
              label,
              latencyMs: aggregate.success ? aggregate.latencyMs : null,
              isTimeout: !aggregate.success,
              probeCount: aggregate.probeCount ?? 1,
              probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
            });
            continue;
          }
          await db.insertTunnelLatencyStat({
            tunnelId,
            latencyMs: aggregate.success ? aggregate.latencyMs : null,
            isTimeout: !aggregate.success,
            probeCount: aggregate.probeCount ?? 1,
            probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
            seriesKey: "total",
            seriesLabel: aggregate.partial ? "可用入口最大延迟" : "多入口最大延迟",
            recordedAt,
          }, { preserveMessage: true });
          if (aggregate.success && !tunnel.isRunning) {
            await db.updateTunnelRunningStatus(tunnelId, true);
            tunnel.isRunning = true;
          }
          continue;
        }
        if (relayFailover && seriesKey && /^relay-\d+$/.test(seriesKey)) {
          recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex: Number(report.hopIndex),
            hopCount: 2,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: topologyKey,
            pathKey: seriesKey,
            allowEarlyFailure: true,
            fromHostId: Number(host.id),
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          continue;
        }
        if (seriesKey) {
          recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex: hasHop ? hopIndex : 0,
            hopCount: hasHop ? hopCount : 1,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: topologyKey,
            pathKey: seriesKey,
            fromHostId: Number(host.id),
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          const label = cleanTunnelSeriesLabel(report.seriesLabel, seriesKey === "primary" ? "主出口" : seriesKey);
          branchByKey.set(seriesKey, {
            key: seriesKey,
            label,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: Number(report.probeCount) || 1,
            probeSuccesses: Number(report.probeSuccesses) || 0,
          });
          continue;
        }
        if (hasHop) {
          const aggregate = recordTunnelAutoHopLatency({
            tunnelId,
            hopIndex,
            hopCount,
            latencyMs: latencyValue,
            isTimeout,
            probeCount: report.probeCount,
            probeSuccesses: report.probeSuccesses,
            generation: topologyKey,
            fromHostId: Number(host.id),
            toHostId: tunnelProbeTargetHostId(tunnel, hops, exitNodes, report, seriesKey),
          });
          if (!aggregate) continue;
          await db.insertTunnelLatencyStat({
            tunnelId,
            latencyMs: aggregate.success ? aggregate.latencyMs : null,
            isTimeout: !aggregate.success,
            probeCount: aggregate.probeCount ?? 1,
            probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
            seriesKey: "total",
            seriesLabel: "总延迟",
          }, { preserveMessage: true });
          if (aggregate.success && !tunnel.isRunning) {
            await db.updateTunnelRunningStatus(tunnelId, true);
            tunnel.isRunning = true;
          }
          continue;
        }
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: latencyValue,
          isTimeout,
          probeCount: Number(report.probeCount) || 1,
          probeSuccesses: Number(report.probeSuccesses) || 0,
          seriesKey: "total",
          seriesLabel: "总延迟",
        }, { preserveMessage: true });
        if (!isTimeout && !tunnel.isRunning) {
          await db.updateTunnelRunningStatus(tunnelId, true);
          tunnel.isRunning = true;
        }
      }

      if ((branchedEndpoints.length > 0 || relayBranchedEndpoints.length > 0) && !branchUpdated) return;
      if (branchedEndpoints.length > 0) {
        const hopCount = hops.length - 1;
        const aggregates = branchedEndpoints.map((endpoint, index) => {
          const pathKey = `branch-exit-${Number(endpoint.hostId)}`;
          const details = multiEntry
            ? getTunnelMultiEntryHopDetails({ tunnelId, expectedEntryHostIds: orderedEntryHostIds, hopCount, generation: multiEntryGeneration, pathKey, referenceAt: Date.now(), maxAgeMs: 120_000, maxSkewMs: 120_000 })
            : getTunnelAutoHopDetails({ tunnelId, hopCount, generation: multiEntryGeneration, pathKey, referenceAt: Date.now(), maxAgeMs: 120_000, maxSkewMs: 120_000 });
          const aggregate = !details || details.filter((detail) => detail.hopIndex === 0).length !== orderedEntryHostIds.length || details.filter((detail) => detail.hopIndex > 0).length !== hopCount - 1
            ? null
            : multiEntry
              ? getTunnelMultiEntryLatency({ tunnelId, expectedEntryHostIds: orderedEntryHostIds, hopCount, generation: multiEntryGeneration, pathKey })
              : getTunnelAutoHopAggregate(tunnelId, hopCount, multiEntryGeneration, pathKey);
          return { key: index === 0 ? "primary" : `exit-${index + 1}`, label: index === 0 ? "主出口" : `出口 ${index + 1}`, aggregate };
        });
        // Publish completed branches separately, but never a total that omits
        // an exit still waiting for a fresh report.
        if (aggregates.some((item) => !item.aggregate)) {
          const recordedAt = new Date();
          for (const item of aggregates) {
            const aggregate = item.aggregate;
            if (!aggregate) continue;
            await db.insertTunnelLatencyStat({ tunnelId, latencyMs: aggregate.success ? aggregate.latencyMs : null, isTimeout: !aggregate.success,
              seriesKey: item.key, seriesLabel: `${item.label}（其他出口待上报）`, recordedAt }, { preserveMessage: true, updateTunnel: false });
          }
          return;
        }
        for (const item of aggregates) {
          const aggregate = item.aggregate!;
          branchByKey.set(item.key, { key: item.key, label: "partial" in aggregate && aggregate.partial ? `${item.label}（部分入口不可用）` : item.label, latencyMs: aggregate.success ? aggregate.latencyMs : null,
            isTimeout: !aggregate.success, probeCount: ("probeCount" in aggregate ? Number(aggregate.probeCount) : 1) || 1,
            probeSuccesses: "probeSuccesses" in aggregate ? Number(aggregate.probeSuccesses) : (aggregate.success ? 1 : 0) });
        }
      }
      if (relayBranchedEndpoints.length > 0) {
        const relays = tunnelRelayCandidates(hops) as any[];
        const byExit = relayBranchedEndpoints.map((endpoint, index) => {
          const paths = relays.map((relay) => {
            const pathKey = `relay-branch-${Number(relay.hostId)}-${Number(endpoint.hostId)}`;
            const details = multiEntry
              ? getTunnelMultiEntryHopDetails({ tunnelId, expectedEntryHostIds: orderedEntryHostIds, hopCount: 2, generation: multiEntryGeneration, pathKey, referenceAt: Date.now(), maxAgeMs: 120_000, maxSkewMs: 120_000 })
              : getTunnelAutoHopDetails({ tunnelId, hopCount: 2, generation: multiEntryGeneration, pathKey, referenceAt: Date.now(), maxAgeMs: 120_000, maxSkewMs: 120_000 });
            if (!details || details.filter((detail) => detail.hopIndex === 0).length !== orderedEntryHostIds.length || details.filter((detail) => detail.hopIndex === 1).length !== 1) return { pathKey, aggregate: null };
            const aggregate = multiEntry ? getTunnelMultiEntryLatency({ tunnelId, expectedEntryHostIds: orderedEntryHostIds, hopCount: 2, generation: multiEntryGeneration, pathKey })
              : getTunnelAutoHopAggregate(tunnelId, 2, multiEntryGeneration, pathKey);
            return { pathKey, aggregate };
          });
          return { key: index === 0 ? "primary" : `exit-${index + 1}`, label: index === 0 ? "主出口" : `出口 ${index + 1}`, paths };
        });
        if (byExit.some((item) => item.paths.some((path) => !path.aggregate))) {
          const recordedAt = new Date();
          for (const item of byExit) {
            for (const path of item.paths) {
              const aggregate = path.aggregate;
              if (!aggregate) continue;
              await db.insertTunnelLatencyStat({ tunnelId, latencyMs: aggregate.success ? aggregate.latencyMs : null, isTimeout: !aggregate.success,
                seriesKey: path.pathKey, seriesLabel: `${item.label} / ${path.pathKey}（其他路径待上报）`, recordedAt }, { preserveMessage: true, updateTunnel: false });
            }
            if (item.paths.some((path) => !path.aggregate)) continue;
            const selected = item.paths.flatMap((path) => path.aggregate?.success ? [path.aggregate] : []).sort((a, b) => Number(b.latencyMs || 0) - Number(a.latencyMs || 0))[0];
            await db.insertTunnelLatencyStat({ tunnelId, latencyMs: selected?.latencyMs ?? null, isTimeout: !selected,
              seriesKey: item.key, seriesLabel: `${item.label}（其他出口待上报）`, recordedAt }, { preserveMessage: true, updateTunnel: false });
          }
          return;
        }
        for (const item of byExit) {
          for (const path of item.paths) {
            const aggregate = path.aggregate!;
            relayPathSeries.push({ key: path.pathKey, label: `${item.label} / ${path.pathKey}`, latencyMs: aggregate.success ? aggregate.latencyMs : null,
              isTimeout: !aggregate.success, probeCount: ("probeCount" in aggregate ? Number(aggregate.probeCount) : 1) || 1,
              probeSuccesses: "probeSuccesses" in aggregate ? Number(aggregate.probeSuccesses) : (aggregate.success ? 1 : 0) });
          }
          const successful = item.paths.flatMap((path) => path.aggregate?.success ? [path.aggregate] : []);
          const selected = successful.sort((a, b) => Number(b.latencyMs || 0) - Number(a.latencyMs || 0))[0];
          if (successful.length < item.paths.length) relayPathsPartial = true;
          branchByKey.set(item.key, { key: item.key, label: successful.length < item.paths.length ? `${item.label}（部分中转不可用）` : item.label,
            latencyMs: selected?.latencyMs ?? null, isTimeout: !selected, probeCount: selected && "probeCount" in selected ? Number(selected.probeCount) || 1 : 1,
            probeSuccesses: selected && "probeSuccesses" in selected ? Number(selected.probeSuccesses) : selected ? 1 : 0 });
        }
      }
      if (relayFailover && relayBranchedEndpoints.length === 0) {
        const aggregates = Array.from({ length: relayCandidateCount }, (_, index) => {
          const key = `relay-${index + 1}`;
          return {
            key,
            label: `中转 ${index + 1}`,
            aggregate: multiEntry
              ? getTunnelMultiEntryLatency({
                tunnelId,
                expectedEntryHostIds: orderedEntryHostIds,
                hopCount: 2,
                generation: multiEntryGeneration,
                pathKey: key,
              })
              : getTunnelAutoHopAggregate(tunnelId, 2, topologyKey, key, true),
          };
        });
        const readyAggregates = readyTunnelRelayAggregates(aggregates);
        if (readyAggregates.length > 0) {
          for (const item of readyAggregates) {
            branchByKey.set(item.key, {
              key: item.key,
              label: item.label,
              latencyMs: item.aggregate.success ? item.aggregate.latencyMs : null,
              isTimeout: !item.aggregate.success,
              probeCount: item.aggregate.probeCount ?? 1,
              probeSuccesses: item.aggregate.probeSuccesses ?? (item.aggregate.success ? 1 : 0),
            });
          }
        }
      }

      const branches = Array.from(branchByKey.values());
      if (branches.length === 0) return;
      const recordedAt = new Date();
      await mapWithConcurrency([...branches, ...relayPathSeries], 4, async (branch) => {
        await db.insertTunnelLatencyStat({
          tunnelId,
          latencyMs: branch.isTimeout ? null : branch.latencyMs,
          isTimeout: branch.isTimeout,
          probeCount: branch.probeCount || 1,
          probeSuccesses: branch.probeSuccesses ?? (branch.isTimeout ? 0 : 1),
          seriesKey: branch.key,
          seriesLabel: branch.label,
          recordedAt,
        }, { preserveMessage: true, updateTunnel: false });
      });
      const summary = summarizeTunnelBranches(branches);
      await db.insertTunnelLatencyStat({
        tunnelId,
        latencyMs: summary.latencyMs,
        isTimeout: summary.unavailable,
        probeCount: summary.probeCount ?? 1,
        probeSuccesses: summary.probeSuccesses ?? (summary.unavailable ? 0 : 1),
        seriesKey: "total",
        seriesLabel: summary.partial ? "可用出口最大延迟" : relayPathsPartial ? "可用中转最大路径延迟" : "最大延迟",
        recordedAt,
      }, { preserveMessage: true });
      if (!summary.unavailable && !tunnel.isRunning) await db.updateTunnelRunningStatus(tunnelId, true);
    }));
    const needsForwardGroupHealthTopology = forwardGroupResults.some((report) => {
      const type = String(report.probeType || "");
      return type === "china" || type === "entry";
    });
    const healthTopology = needsForwardGroupHealthTopology
      ? await db.getForwardGroupProbeTopologyForHost(Number(host.id)) as any
      : { chinaHealthProbes: [], entryHealthProbes: [] };
    const chinaExpected = healthTopology.chinaHealthProbes || [];
    const chinaExpectedByKey = new Map(chinaExpected.map((probe: any) => [
      `${Number(probe.groupId)}:${Number(probe.memberId)}`,
      probe,
    ]));
    const entryExpectedByKey = new Map((healthTopology.entryHealthProbes || []).map((probe: any) => [
      `${Number(probe.groupId)}:${Number(probe.memberId)}`,
      probe,
    ]));
    await mapWithConcurrency(forwardGroupResults.filter(report => report.probeType === "landing"), 12, async report => {
      await recordLandingGroupProbe(Number(host.id), report);
    });
    const forwardGroupResultsById = new Map<number, AgentForwardGroupLatencyResult[]>();
    for (const report of forwardGroupResults) {
      if (report.probeType === "landing") continue;
      const groupId = Number(report.groupId || 0);
      if (groupId <= 0) continue;
      const rows = forwardGroupResultsById.get(groupId) || [];
      rows.push(report);
      forwardGroupResultsById.set(groupId, rows);
    }
    await mapWithConcurrency(Array.from(forwardGroupResultsById.entries()), 12, async ([groupId, reports]) => {
      const group = await db.getForwardGroupById(groupId) as any;
      if (!group?.isEnabled) return;
      const chainProbes = String(group.groupMode || "failover") === "chain"
        ? await db.getForwardGroupChainProbes(groupId)
        : [];
      const topologyKey = forwardGroupProbeTopologyKey(groupId, chainProbes);
      for (const report of reports) {
        if (String(report.probeType || "") === "china") {
          const expected = chinaExpectedByKey.get(`${groupId}:${Number(report.memberId || 0)}`) as any;
          if (!expected) continue;
          if (report.targetIp && !sameProbeTarget(report.targetIp, expected.targetIp)) continue;
          if (report.targetPort && Number(report.targetPort) !== Number(expected.targetPort)) continue;
          await db.updateForwardGroupMemberChinaHealth({
            groupId,
            memberId: Number(report.memberId || 0),
            hostId: Number(host.id),
            latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
            isTimeout: !!report.isTimeout,
            healthStatus: report.healthStatus,
          });
          continue;
        }
        if (String(report.probeType || "") === "entry") {
          const expected = entryExpectedByKey.get(`${groupId}:${Number(report.memberId || 0)}`) as any;
          if (!expected || report.healthStatus === undefined) continue;
          await db.updateForwardGroupMemberAgentHealth({
            groupId,
            memberId: Number(report.memberId || 0),
            hostId: Number(host.id),
            healthStatus: report.healthStatus,
          });
          continue;
        }
        if (String(group.groupMode || "failover") !== "chain") continue;
        if (report.topologyKey && report.topologyKey !== topologyKey) continue;
        const hopIndex = Number(report.hopIndex);
        const hopCount = Number(report.hopCount);
        if (!Number.isInteger(hopIndex) || !Number.isInteger(hopCount) || hopCount <= 0) continue;
        const expected = (chainProbes as any[]).find((probe: any) => (
          Number(probe.fromHostId) === Number(host.id)
          && Number(probe.hopIndex) === hopIndex
          && Number(probe.hopCount) === hopCount
          && (!report.targetIp || sameProbeTarget(report.targetIp, probe.targetIp))
          && (!report.targetPort || Number(report.targetPort) === Number(probe.targetPort))
        ));
        if (!expected) continue;
        const aggregate = recordForwardGroupAutoHopLatency({
          groupId,
          hopIndex,
          hopCount,
          latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
          isTimeout: !!report.isTimeout,
          probeCount: report.probeCount,
          probeSuccesses: report.probeSuccesses,
          generation: topologyKey,
        });
        if (!aggregate) continue;
        await db.insertForwardGroupLatencyStat({
          groupId,
          latencyMs: aggregate.success ? aggregate.latencyMs : null,
          isTimeout: !aggregate.success,
          probeCount: aggregate.probeCount ?? 1,
          probeSuccesses: aggregate.probeSuccesses ?? (aggregate.success ? 1 : 0),
        });
      }
    });

    const serviceProbeRoundId = `legacy-service:${crypto.randomUUID()}`;
    const landingServiceReports = serviceResults.filter((report: any) => Number(report.landingServiceId || 0) > 0);
    if (landingServiceReports.length > 0) {
      const marker = await db.getLandingHostByHostId(Number(host.id)) as any;
      if (marker?.isEnabled !== false) {
        const acceptedLandingStats: Array<{ serviceId: number; hostId: number; latencyMs: number | null; isTimeout: boolean }> = [];
        const acceptedLandingHealth: any[] = [];
        await Promise.all(landingServiceReports.map(async (report: any) => {
          const service = await db.getLandingServiceById(Number(report.landingServiceId), false) as any;
          if (!service || Number(service.hostId) !== Number(host.id) || service.isEnabled === false) return;
          if (report.targetIp && !sameProbeTarget(report.targetIp, service.latencyTargetHost)) return;
          if (report.targetPort && Number(report.targetPort) !== Number(service.latencyTargetPort || 443)) return;
          const healthLatencyMs = typeof report.latencyMs === "number" && report.latencyMs >= 0 ? Math.round(report.latencyMs) : null;
          const legacyLatencyMs = typeof report.latencyMs === "number" && report.latencyMs > 0 ? Math.round(report.latencyMs) : null;
          const { probeCount, probeSuccesses } = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
          const isTimeout = !!report.isTimeout || probeSuccesses <= 0 || healthLatencyMs === null;
          const legacyIsTimeout = !!report.isTimeout || legacyLatencyMs === null;
          acceptedLandingStats.push({ serviceId: Number(service.id), hostId: Number(host.id), latencyMs: legacyLatencyMs, isTimeout: legacyIsTimeout });
          if (String(report.method || "tcping").toLowerCase() !== "ping") {
            acceptedLandingHealth.push({
              serviceType: "landing-latency-target",
              serviceId: Number(service.id),
              hostId: Number(host.id),
              targetAddress: String(service.latencyTargetHost || report.targetIp || ""),
              targetPort: Number(service.latencyTargetPort || report.targetPort || 443),
              transport: "tcp",
              probeMethod: "tcp-connect",
              probeRoundId: serviceProbeRoundId,
              status: isTimeout ? ("unhealthy" as const) : probeSuccesses < probeCount ? ("degraded" as const) : ("healthy" as const),
              latencyMs: isTimeout ? null : healthLatencyMs,
              probeCount,
              probeSuccesses,
              errorCode: isTimeout ? "timeout" : null,
            });
          }
          await db.updateLandingService(Number(service.id), {
            latestLatencyMs: legacyLatencyMs,
            latestLatencyIsTimeout: legacyIsTimeout,
            latestLatencyAt: new Date(),
          });
        }));
        if (acceptedLandingStats.length > 0) await db.recordLandingServiceLatency(acceptedLandingStats);
        if (acceptedLandingHealth.length > 0) {
          await db.recordServiceHealthStats(acceptedLandingHealth).catch((error: unknown) => {
            console.warn("[ServiceHealth] landing mirror write failed:", error instanceof Error ? error.message : String(error));
          });
        }
      }
    }
    const ordinaryServiceResults = serviceResults.filter((report: any) => Number(report.landingServiceId || 0) <= 0);
    const expectedServices = ordinaryServiceResults.length > 0 ? await db.getHostProbeTasksForHost(Number(host.id)) as any[] : [];
    const expectedServiceById = new Map(expectedServices.map((service: any) => [Number(service.serviceId), service]));
    const serviceStats = ordinaryServiceResults.flatMap((report) => {
      const serviceId = Number(report.serviceId || 0);
      const expected = expectedServiceById.get(serviceId) as any;
      if (!expected) return [];
      if (report.targetIp && !sameProbeTarget(report.targetIp, expected.targetIp)) return [];
      if (report.targetPort && Number(report.targetPort) !== Number(expected.targetPort || 0)) return [];
      const counts = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
      return [{
        serviceId,
        hostId: host.id,
        latencyMs: typeof report.latencyMs === "number" && report.latencyMs > 0 ? report.latencyMs : null,
        isTimeout: !!report.isTimeout,
        probeCount: counts.probeCount,
        probeSuccesses: counts.probeSuccesses,
      }];
    });
    if (serviceStats.length > 0) {
      await db.insertHostProbeServiceStats(serviceStats);
    }
    const ordinaryServiceHealth = ordinaryServiceResults.flatMap((report) => {
      const serviceId = Number(report.serviceId || 0);
      const expected = expectedServiceById.get(serviceId) as any;
      if (!expected) return [];
      if (report.targetIp && !sameProbeTarget(report.targetIp, expected.targetIp)) return [];
      if (report.targetPort && Number(report.targetPort) !== Number(expected.targetPort || 0)) return [];
      if (String(report.method || expected.method || "tcping").toLowerCase() === "ping") return [];
      const { probeCount, probeSuccesses } = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
      const latencyMs = typeof report.latencyMs === "number" && report.latencyMs >= 0 ? Math.round(report.latencyMs) : null;
      const isTimeout = !!report.isTimeout || probeSuccesses <= 0 || latencyMs === null;
      return [{
        serviceType: "host-probe-service",
        serviceId,
        hostId: Number(host.id),
        targetAddress: String(expected.targetIp || report.targetIp || ""),
        targetPort: Number(expected.targetPort || report.targetPort || 0),
        transport: "tcp" as const,
        probeMethod: "tcp-connect",
        probeRoundId: serviceProbeRoundId,
        status: isTimeout ? ("unhealthy" as const) : probeSuccesses < probeCount ? ("degraded" as const) : ("healthy" as const),
        latencyMs: isTimeout ? null : latencyMs,
        probeCount,
        probeSuccesses,
        errorCode: isTimeout ? "timeout" : null,
      }];
    });
    if (ordinaryServiceHealth.length > 0) {
      await db.recordServiceHealthStats(ordinaryServiceHealth).catch((error: unknown) => {
        console.warn("[ServiceHealth] host probe mirror write failed:", error instanceof Error ? error.message : String(error));
      });
    }

    const reportedRuleRows = await db.getForwardRulesByIds(results.map((report) => Number(report.ruleId || 0))) as any[];
    const reportedRuleById = new Map(reportedRuleRows.map((rule: any) => [Number(rule.id), rule]));
    const tunnelLatencyById = new Map<number, Promise<any>>();
    const tunnelContextById = new Map<number, Promise<{ tunnel: any } | null>>();
    const getTunnelContext = (tunnelId: number) => {
      let work = tunnelContextById.get(tunnelId);
      if (!work) {
        work = (async () => {
          const tunnel = await db.getTunnelById(tunnelId) as any;
          if (!tunnel) return null;
          return { tunnel };
        })();
        tunnelContextById.set(tunnelId, work);
      }
      return work;
    };
    const getLatestTunnelLatency = (tunnelId: number) => {
      let work = tunnelLatencyById.get(tunnelId);
      if (!work) {
        work = db.getLatestTunnelLatency(tunnelId);
        tunnelLatencyById.set(tunnelId, work);
      }
      return work;
    };
    const ruleStats = await mapWithConcurrency(results, 16, async (report) => {
      const ruleId = Number(report.ruleId);
      if (ruleId <= 0) return null;
      const rule = reportedRuleById.get(ruleId) as any;
      if (!rule || rule.pendingDelete || !rule.isEnabled) return null;
      const tunnelId = Number(rule.tunnelId || 0);
      const baseLatency = typeof report.latencyMs === "number" && Number.isFinite(report.latencyMs) && report.latencyMs >= 0
        ? Number(report.latencyMs)
        : null;
      const targetProbeCounts = normalizeAgentProbeCounts(report, { legacyZeroAsSuccess: false });
      const targetIsTimeout = !!report.isTimeout || baseLatency === null || targetProbeCounts.probeSuccesses <= 0;
      if (tunnelId <= 0) {
        if (Number(rule.hostId || 0) !== Number(host.id)) return null;
        if (report.sourcePort && Number(report.sourcePort) !== Number(rule.sourcePort || 0)) return null;
        if (report.targetPort && Number(report.targetPort) !== Number(rule.targetPort || 0)) return null;
        if (!sameProbeTarget(report.targetIp, rule.targetIp)) return null;
        if (!isRuleLatencyReportMethodCompatible(rule.protocol, report.method)) return null;
        if (report.topologyKey && report.topologyKey !== directRuleLatencyTopologyKey(rule, host.id)) return null;
        const isTimeout = targetIsTimeout;
        const latencyMs = isTimeout ? null : baseLatency;
        return {
          stat: {
            ruleId,
            hostId: host.id,
            latencyMs,
            isTimeout,
            probeCount: targetProbeCounts.probeCount,
            probeSuccesses: isTimeout ? 0 : targetProbeCounts.probeSuccesses,
            healthStatus: report.healthStatus || null,
            healthPending: !!report.healthPending,
          },
          gateReport: { ...report, latencyMs, isTimeout },
        };
      }

      const tunnelContext = await getTunnelContext(tunnelId);
      if (!tunnelContext || !validateTunnelRuleLatencyReport({
        hostId: host.id,
        rule,
        tunnel: tunnelContext.tunnel,
        report,
      })) return null;
      const latestTunnelLatency = targetIsTimeout ? null : await getLatestTunnelLatency(tunnelId);
      const combined = combineTunnelRuleLatencySample({
        targetLatencyMs: baseLatency,
        targetIsTimeout,
        tunnelLatencyMs: latestTunnelLatency?.latencyMs,
        tunnelIsTimeout: !!latestTunnelLatency?.isTimeout,
        tunnelRecordedAt: latestTunnelLatency?.recordedAt,
      });
      if (!combined) return null;
      const tunnelIntroducedTimeout = combined.isTimeout && !targetIsTimeout;
      // Compose target and tunnel counters. If the tunnel path timed out,
      // no end-to-end packet can be considered successful; otherwise retain
      // the lower success ratio from either segment.
      const composedProbeCounts = combineTunnelRuleProbeCounts({
        target: report,
        tunnel: latestTunnelLatency,
        combinedIsTimeout: combined.isTimeout,
      });
      return {
        stat: {
          ruleId,
          hostId: host.id,
          latencyMs: combined.latencyMs,
          isTimeout: combined.isTimeout,
          probeCount: composedProbeCounts.probeCount,
          probeSuccesses: composedProbeCounts.probeSuccesses,
          healthStatus: tunnelIntroducedTimeout ? null : report.healthStatus || null,
          healthPending: tunnelIntroducedTimeout ? false : !!report.healthPending,
        },
        gateReport: {
          ...report,
          tunnelId,
          latencyMs: combined.latencyMs,
          isTimeout: combined.isTimeout,
        },
      };
    });
    const validRuleStats = ruleStats.filter((entry): entry is NonNullable<typeof entry> => !!entry);
    const ruleGatePlan = agentTcpingReportGate.plan({
      hostId: Number(host.id),
      force,
      results: validRuleStats.map((entry) => entry.gateReport),
      tunnels: [],
      forwardGroups: [],
      services: [],
    });
    const acceptedRuleIds = new Set(ruleGatePlan.results.map((report) => Number(report.ruleId)));
    const acceptedRuleStats = validRuleStats.filter((entry) => acceptedRuleIds.has(Number(entry.stat.ruleId)));
    const stats = acceptedRuleStats.map((entry) => entry.stat);

    if (stats.length > 0) {
      await db.insertTcpingStats(stats);
      clearRuleLatencyQueryCaches();
      db.scheduleForwardGroupFailover(Array.from(new Set(stats
        .filter((stat) => ruleGatePlan.transitionRuleIds.has(Number(stat.ruleId)))
        .map((stat) => Number(reportedRuleById.get(stat.ruleId)?.forwardGroupId || 0))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0))));

      const endpointProbeRoundId = `legacy-rule-endpoint:${crypto.randomUUID()}`;
      let endpointHostByAddress: Map<string, number> | null = null;
      const endpointTargetHostId = async (rule: any, targetAddress: string) => {
        const targetRuleId = Number(rule?.targetRuleId || 0);
        if (targetRuleId > 0) return Number((await db.getForwardRuleById(targetRuleId) as any)?.hostId || 0) || null;
        const landingServiceId = Number(rule?.targetLandingServiceId || 0);
        if (landingServiceId > 0) return Number((await db.getLandingServiceById(landingServiceId, false) as any)?.hostId || 0) || null;
        if (!endpointHostByAddress) {
          endpointHostByAddress = new Map<string, number>();
          for (const candidate of await db.getHosts() as any[]) {
            for (const address of [candidate.ip, candidate.ipv4, candidate.ipv6, candidate.entryIp, candidate.tunnelEntryIp, candidate.ddnsDomain]) {
              const key = String(address || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
              if (key && !endpointHostByAddress.has(key)) endpointHostByAddress.set(key, Number(candidate.id));
            }
          }
        }
        return endpointHostByAddress.get(String(targetAddress || "").trim().replace(/^\[|\]$/g, "").toLowerCase()) || null;
      };
      const endpointSamples = (await mapWithConcurrency(acceptedRuleStats, 12, async (entry) => {
        const report = entry.gateReport as AgentTcpingResult;
        if (String(report.method || "tcping").trim().toLowerCase() === "ping") return null;
        const rule = reportedRuleById.get(Number(entry.stat.ruleId)) as any;
        if (!rule) return null;
        const targetAddress = String(report.targetIp || rule.targetIp || "").trim();
        const targetPort = Number(report.targetPort || rule.targetPort || 0);
        if (!targetAddress || targetPort < 1 || targetPort > 65535) return null;
        return {
          ruleId: Number(entry.stat.ruleId),
          sourceHostId: Number(host.id),
          targetHostId: await endpointTargetHostId(rule, targetAddress),
          targetAddress,
          targetPort,
          transport: "tcp" as const,
          probeMethod: "tcp-connect",
          probeRoundId: endpointProbeRoundId,
          latencyMs: entry.stat.isTimeout ? null : entry.stat.latencyMs,
          isTimeout: !!entry.stat.isTimeout,
          probeCount: Number(entry.stat.probeCount) || 1,
          probeSuccesses: Number(entry.stat.probeSuccesses) || 0,
          errorCode: entry.stat.isTimeout ? "timeout" : null,
        };
      })).filter((sample): sample is NonNullable<typeof sample> => !!sample);
      if (endpointSamples.length > 0) {
        await db.recordRuleEndpointLatencyStats(endpointSamples).catch((error: unknown) => {
          console.warn("[RuleEndpoint] mirror write failed:", error instanceof Error ? error.message : String(error));
        });
      }
    }

    topologyGatePlan.commit();
    ruleGatePlan.commit();
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent TCPing] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

}
