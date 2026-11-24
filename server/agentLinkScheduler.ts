import crypto from "node:crypto";
import { mapWithConcurrency } from "./asyncPool";
import * as db from "./db";
import { enqueueAgentLinkProbeTask, hasActiveAgentLinkProbeEdge, sweepExpiredAgentLinkProbeTasks } from "./agentLinkTasks";
import {
  buildAgentLinkEdgeKey,
  normalizeAgentLinkIdentity,
  type AgentLinkIdentity,
} from "../shared/agentLink";
import { agentProbePortForHost } from "../shared/agentProbe";
import { cleanTerminalAgentLinkProbeTasks } from "./repositories/agentLinkTaskRepository";

export type AgentLinkDemandMode = "background" | "interactive";

type OwnerDemand = {
  mode: AgentLinkDemandMode;
  expiresAt: number;
};

type EdgeDemand = {
  identity: AgentLinkIdentity;
  owners: Map<string, OwnerDemand>;
};

const demands = new Map<string, EdgeDemand>();
const ownerEdges = new Map<string, Set<string>>();
const BACKGROUND_INTERVAL_MS = 30_000;
const INTERACTIVE_INTERVAL_MS = 5_000;
const DEFAULT_DEMAND_TTL_MS = 5 * 60_000;
const MAX_DEMANDS = 10_000;
let nextBackgroundAt = 0;
let nextInteractiveAt = 0;
let schedulerRunning = false;
let nextTerminalTaskCleanupAt = 0;
let latestRound: { probeRoundId: string; mode: AgentLinkDemandMode; requested: number; queued: number; errors: number; startedAt: number } | null = null;

function jitteredBackgroundInterval() {
  return Math.round(BACKGROUND_INTERVAL_MS * (0.9 + Math.random() * 0.2));
}

function cleanOwnerKey(value: unknown) {
  return String(value || "").trim().slice(0, 191);
}

function removeOwnerFromEdge(ownerKey: string, edgeKey: string) {
  const edge = demands.get(edgeKey);
  if (!edge) return;
  edge.owners.delete(ownerKey);
  if (edge.owners.size === 0) demands.delete(edgeKey);
}

function pruneDemands(now = Date.now()) {
  for (const [edgeKey, edge] of demands) {
    for (const [ownerKey, owner] of edge.owners) {
      if (owner.expiresAt > now) continue;
      edge.owners.delete(ownerKey);
      const keys = ownerEdges.get(ownerKey);
      keys?.delete(edgeKey);
      if (keys?.size === 0) ownerEdges.delete(ownerKey);
    }
    if (edge.owners.size === 0) demands.delete(edgeKey);
  }
}

export function replaceAgentLinkDemands(
  ownerKeyValue: string,
  identities: AgentLinkIdentity[],
  options: { mode?: AgentLinkDemandMode; ttlMs?: number } = {},
) {
  const ownerKey = cleanOwnerKey(ownerKeyValue);
  if (!ownerKey) throw new Error("Agent Link demand owner key is required");
  const mode: AgentLinkDemandMode = options.mode === "interactive" ? "interactive" : "background";
  const ttlMs = Math.max(15_000, Math.min(30 * 60_000, Math.floor(Number(options.ttlMs) || DEFAULT_DEMAND_TTL_MS)));
  const expiresAt = Date.now() + ttlMs;
  const nextKeys = new Set<string>();
  for (const value of identities) {
    const identity = normalizeAgentLinkIdentity(value);
    if (!identity) continue;
    const edgeKey = buildAgentLinkEdgeKey(identity);
    if (!edgeKey || (!demands.has(edgeKey) && demands.size >= MAX_DEMANDS)) continue;
    nextKeys.add(edgeKey);
    const edge = demands.get(edgeKey) || { identity, owners: new Map<string, OwnerDemand>() };
    edge.identity = identity;
    edge.owners.set(ownerKey, { mode, expiresAt });
    demands.set(edgeKey, edge);
  }
  const previousKeys = ownerEdges.get(ownerKey) || new Set<string>();
  for (const edgeKey of previousKeys) {
    if (!nextKeys.has(edgeKey)) removeOwnerFromEdge(ownerKey, edgeKey);
  }
  if (nextKeys.size > 0) ownerEdges.set(ownerKey, nextKeys);
  else ownerEdges.delete(ownerKey);
  const now = Date.now();
  if (mode === "interactive") nextInteractiveAt = Math.min(nextInteractiveAt || now, now + 250);
  else nextBackgroundAt = Math.min(nextBackgroundAt || now, now + 1_000);
  return Array.from(nextKeys);
}

export function touchAgentLinkDemands(ownerKeyValue: string, ttlMs = DEFAULT_DEMAND_TTL_MS) {
  const ownerKey = cleanOwnerKey(ownerKeyValue);
  const keys = ownerEdges.get(ownerKey);
  if (!keys) return 0;
  const expiresAt = Date.now() + Math.max(15_000, Math.min(30 * 60_000, Math.floor(Number(ttlMs) || DEFAULT_DEMAND_TTL_MS)));
  let touched = 0;
  for (const edgeKey of keys) {
    const owner = demands.get(edgeKey)?.owners.get(ownerKey);
    if (!owner) continue;
    owner.expiresAt = expiresAt;
    touched += 1;
  }
  return touched;
}

export function clearAgentLinkDemands(ownerKeyValue: string) {
  const ownerKey = cleanOwnerKey(ownerKeyValue);
  const keys = ownerEdges.get(ownerKey);
  if (!keys) return;
  for (const edgeKey of keys) removeOwnerFromEdge(ownerKey, edgeKey);
  ownerEdges.delete(ownerKey);
}

function demandMatchesMode(edge: EdgeDemand, mode: AgentLinkDemandMode, now: number) {
  let hasBackground = false;
  let hasInteractive = false;
  for (const owner of edge.owners.values()) {
    if (owner.expiresAt <= now) continue;
    if (owner.mode === "interactive") hasInteractive = true;
    else hasBackground = true;
  }
  return mode === "interactive" ? hasInteractive : hasBackground && !hasInteractive;
}

function mergeOwnerDemand(current: OwnerDemand | undefined, incoming: OwnerDemand) {
  if (!current) return incoming;
  return {
    mode: current.mode === "interactive" || incoming.mode === "interactive" ? "interactive" : "background",
    expiresAt: Math.max(current.expiresAt, incoming.expiresAt),
  } satisfies OwnerDemand;
}

async function refreshDemandTargetPorts() {
  if (demands.size === 0) return;
  const targetHostIds = new Set(Array.from(demands.values()).map((edge) => edge.identity.targetHostId));
  const hosts = await db.getHosts();
  const targetPorts = new Map<number, number>();
  for (const host of hosts as any[]) {
    const hostId = Number(host?.id || 0);
    if (targetHostIds.has(hostId)) targetPorts.set(hostId, agentProbePortForHost(host));
  }
  for (const [oldEdgeKey, edge] of Array.from(demands.entries())) {
    const targetPort = targetPorts.get(edge.identity.targetHostId);
    if (!targetPort || targetPort === edge.identity.targetPort) continue;
    const identity = normalizeAgentLinkIdentity({ ...edge.identity, targetPort });
    if (!identity) continue;
    const nextEdgeKey = buildAgentLinkEdgeKey(identity);
    if (!nextEdgeKey || nextEdgeKey === oldEdgeKey) continue;
    const nextEdge = demands.get(nextEdgeKey) || { identity, owners: new Map<string, OwnerDemand>() };
    nextEdge.identity = identity;
    for (const [ownerKey, owner] of edge.owners) {
      nextEdge.owners.set(ownerKey, mergeOwnerDemand(nextEdge.owners.get(ownerKey), owner));
      const keys = ownerEdges.get(ownerKey);
      if (keys) {
        keys.delete(oldEdgeKey);
        keys.add(nextEdgeKey);
      }
    }
    demands.set(nextEdgeKey, nextEdge);
    demands.delete(oldEdgeKey);
  }
}

async function enqueueAgentLinkRoundIdentities(identities: AgentLinkIdentity[], mode: AgentLinkDemandMode) {
  const now = Date.now();
  const probeRoundId = crypto.randomUUID();
  const unique = new Map(identities.map((identity) => [buildAgentLinkEdgeKey(identity), identity]));
  const edges = Array.from(unique.values());
  // Interactive path probes require every edge to share one round. Avoid a
  // partial batch when a background task is still using one of those edges.
  if (mode === "interactive" && edges.some((identity) => hasActiveAgentLinkProbeEdge(buildAgentLinkEdgeKey(identity)))) {
    latestRound = { probeRoundId, mode, requested: edges.length, queued: 0, errors: edges.length, startedAt: now };
    return latestRound;
  }
  let queued = 0;
  let errors = 0;
  await mapWithConcurrency(edges, 16, async (identity) => {
    try {
      await enqueueAgentLinkProbeTask({ ...identity, probeRoundId });
      queued += 1;
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (!/active probe task|capability is stale|listener is not ready/i.test(message)) {
        console.warn(`[AgentLink] queue failed edge=${buildAgentLinkEdgeKey(identity)} round=${probeRoundId}: ${message}`);
      }
    }
  });
  latestRound = { probeRoundId, mode, requested: edges.length, queued, errors, startedAt: now };
  return latestRound;
}

export async function runAgentLinkProbeIdentities(identities: AgentLinkIdentity[], mode: AgentLinkDemandMode = "interactive") {
  return enqueueAgentLinkRoundIdentities(identities.map(normalizeAgentLinkIdentity).filter((identity): identity is AgentLinkIdentity => !!identity), mode);
}

export async function runAgentLinkProbeRound(mode: AgentLinkDemandMode = "background") {
  pruneDemands();
  await refreshDemandTargetPorts();
  const now = Date.now();
  const identities = Array.from(demands.values()).filter((edge) => demandMatchesMode(edge, mode, now)).map((edge) => edge.identity);
  const probeRoundId = crypto.randomUUID();
  let queued = 0;
  let errors = 0;
  await mapWithConcurrency(identities, 16, async (identity) => {
    try {
      await enqueueAgentLinkProbeTask({ ...identity, probeRoundId });
      queued += 1;
    } catch (error) {
      errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (!/active probe task|capability is stale|listener is not ready/i.test(message)) {
        console.warn(`[AgentLink] queue failed edge=${buildAgentLinkEdgeKey(identity)} round=${probeRoundId}: ${message}`);
      }
    }
  });
  latestRound = { probeRoundId, mode, requested: identities.length, queued, errors, startedAt: now };
  return latestRound;
}

async function schedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    // Do this even with no active demand: an already dispatched task still
    // needs a durable timeout sample when its source Agent never reports.
    await sweepExpiredAgentLinkProbeTasks(now);
    if (now >= nextTerminalTaskCleanupAt) {
      nextTerminalTaskCleanupAt = now + 60_000;
      await cleanTerminalAgentLinkProbeTasks().catch((error: unknown) => {
        console.warn("[AgentLink] terminal task cleanup failed:", error instanceof Error ? error.message : String(error));
      });
    }
    pruneDemands(now);
    const runInteractive = demands.size > 0 && now >= nextInteractiveAt
      && Array.from(demands.values()).some((edge) => demandMatchesMode(edge, "interactive", now));
    const runBackground = demands.size > 0 && now >= nextBackgroundAt
      && Array.from(demands.values()).some((edge) => demandMatchesMode(edge, "background", now));
    if (runInteractive) {
      await runAgentLinkProbeRound("interactive");
      nextInteractiveAt = Date.now() + INTERACTIVE_INTERVAL_MS;
    }
    if (runBackground) {
      await runAgentLinkProbeRound("background");
      nextBackgroundAt = Date.now() + jitteredBackgroundInterval();
    }
  } finally {
    schedulerRunning = false;
  }
}

export function getAgentLinkDemandIdentities(pairs: Array<{ sourceHostId: number; targetHostId: number }>) {
  pruneDemands();
  const allowed = new Set(pairs.map((pair) => `${Number(pair.sourceHostId)}:${Number(pair.targetHostId)}`));
  const identities = new Map<string, AgentLinkIdentity>();
  for (const [edgeKey, edge] of demands) {
    if (allowed.has(`${edge.identity.sourceHostId}:${edge.identity.targetHostId}`)) identities.set(edgeKey, edge.identity);
  }
  return Array.from(identities.values());
}

export function getAgentLinkSchedulerState() {
  pruneDemands();
  return {
    edgeCount: demands.size,
    ownerCount: ownerEdges.size,
    nextBackgroundAt,
    nextInteractiveAt,
    latestRound,
  };
}

const schedulerTimer = setInterval(() => void schedulerTick(), 1_000);
schedulerTimer.unref?.();
