import crypto from "node:crypto";
import * as db from "./db";
import { pushAgentRefresh } from "./agentEvents";
import { createAgentProbeTicket } from "./agentProbeProtocol";
import { recordAgentLinkProbeSample } from "./repositories/agentLinkRepository";
import { claimAgentLinkProbeTask, claimAgentLinkProbeTaskFinalization, finishAgentLinkProbeTask, getAgentLinkProbeTask, getExpiredAgentLinkProbeTasks, getQueuedAgentLinkProbeTasks, insertAgentLinkProbeTask, releaseAgentLinkProbeTaskFinalization } from "./repositories/agentLinkTaskRepository";
import {
  AGENT_LINK_TRANSPORTS,
  buildAgentLinkEdgeKey,
  normalizeAgentLinkIdentity,
  type AgentLinkIdentity,
  type AgentLinkProbeSample,
  type AgentLinkTransport,
} from "../shared/agentLink";
import { AGENT_PROBE_PROTOCOL_VERSION, agentProbePortForHost } from "../shared/agentProbe";

export type AgentLinkProbeAttempt = {
  request: string;
  expectedResponse: string;
};

export type AgentLinkProbeTask = AgentLinkIdentity & {
  taskId: string;
  edgeKey: string;
  probeRoundId: string;
  probeVersion: number;
  timeoutMs: number;
  attempts: AgentLinkProbeAttempt[];
  createdAt: number;
  expiresAt: number;
};

export type AgentLinkProbeTaskResult = {
  taskId: string;
  probeRoundId?: string;
  latencyMs?: number | null;
  minLatencyMs?: number | null;
  maxLatencyMs?: number | null;
  jitterMs?: number | null;
  probeCount?: number;
  probeSuccesses?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  recordedAt?: string | number | Date;
};

type TaskState = {
  sourceHostId: number;
  task: AgentLinkProbeTask;
  status: "queued" | "running" | "finalizing" | "completed" | "timeout";
  result?: AgentLinkProbeSample;
  timer: NodeJS.Timeout;
  updatedAt: number;
};

const queues = new Map<number, AgentLinkProbeTask[]>();
const states = new Map<string, TaskState>();
const activeByRoundEdge = new Map<string, string>();
const activeByEdge = new Map<string, string>();
const TASK_RETENTION_MS = 10 * 60_000;
const TARGET_STATUS_FRESH_MS = 10 * 60_000;
const MAX_TASKS_PER_HOST = 256;

function roundEdgeKey(probeRoundId: string, edgeKey: string) {
  return `${probeRoundId}\u0000${edgeKey}`;
}

function attemptCount(transport: AgentLinkTransport, requested?: number) {
  const fallback = transport === "udp" ? 5 : 3;
  return Math.max(1, Math.min(10, Math.floor(Number(requested) || fallback)));
}

function cleanRoundId(value: unknown) {
  return String(value || "").trim().slice(0, 128);
}

function statusFresh(host: any, now = Date.now()) {
  const checkedAt = host?.agentProbeCheckedAt instanceof Date
    ? host.agentProbeCheckedAt.getTime()
    : Number(host?.agentProbeCheckedAt || 0) * 1000;
  return checkedAt > 0 && now - checkedAt <= TARGET_STATUS_FRESH_MS;
}

function purgeTask(taskId: string) {
  const state = states.get(taskId);
  if (!state) return;
  states.delete(taskId);
  const key = roundEdgeKey(state.task.probeRoundId, state.task.edgeKey);
  if (activeByRoundEdge.get(key) === taskId) activeByRoundEdge.delete(key);
  if (activeByEdge.get(state.task.edgeKey) === taskId) activeByEdge.delete(state.task.edgeKey);
}

function schedulePurge(taskId: string) {
  const timer = setTimeout(() => purgeTask(taskId), TASK_RETENTION_MS);
  timer.unref?.();
}

function removeQueuedTask(sourceHostId: number, taskId: string) {
  const queue = queues.get(sourceHostId);
  if (!queue?.length) return;
  const remaining = queue.filter((task) => task.taskId !== taskId);
  if (remaining.length > 0) queues.set(sourceHostId, remaining);
  else queues.delete(sourceHostId);
}

async function finalizeTask(state: TaskState, sample: AgentLinkProbeSample, terminalStatus: "completed" | "timeout") {
  // The timeout timer and the Agent report handler run independently. Claim
  // the state synchronously before the first await so only one result can
  // write the same physical edge/round and update latest.
  if (state.status === "completed" || state.status === "timeout" || state.status === "finalizing") return false;
  const previousStatus = state.status;
  state.status = "finalizing";
  state.updatedAt = Date.now();
  clearTimeout(state.timer);
  try {
    if (!await claimAgentLinkProbeTaskFinalization(state.task.taskId, state.sourceHostId)) {
      state.status = previousStatus;
      state.updatedAt = Date.now();
      return false;
    }
    await recordAgentLinkProbeSample(sample);
    if (!await finishAgentLinkProbeTask(state.task.taskId, state.sourceHostId, terminalStatus)) {
      throw new Error("durable Agent Link task finalization was not accepted");
    }
  } catch (error) {
    // Let the caller retry: timeoutTask schedules another sweep and an Agent
    // receives a non-success response, causing its bounded report retries.
    await releaseAgentLinkProbeTaskFinalization(state.task.taskId, state.sourceHostId, previousStatus);
    state.status = previousStatus;
    state.updatedAt = Date.now();
    throw error;
  }
  state.result = sample;
  state.status = terminalStatus;
  state.updatedAt = Date.now();
  removeQueuedTask(state.sourceHostId, state.task.taskId);
  // Keep the round/edge claim until task retention expires. A completed or
  // timed-out task must not be re-enqueued for the same aggregation round;
  // otherwise a second late measurement could replace latest while history
  // correctly rejects its duplicate row.
  if (activeByEdge.get(state.task.edgeKey) === state.task.taskId) activeByEdge.delete(state.task.edgeKey);
  schedulePurge(state.task.taskId);
  return true;
}

async function timeoutTask(taskId: string, failure: { errorCode: string; errorMessage: string } = {
  errorCode: "agent-report-timeout",
  errorMessage: "Source Agent did not report the probe task before expiry",
}) {
  const state = states.get(taskId);
  if (!state || state.status === "completed" || state.status === "timeout" || state.status === "finalizing") return;
  const task = state.task;
  const sample: AgentLinkProbeSample = {
    sourceHostId: task.sourceHostId,
    targetHostId: task.targetHostId,
    targetAddress: task.targetAddress,
    targetPort: task.targetPort,
    transport: task.transport,
    edgeKey: task.edgeKey,
    probeVersion: task.probeVersion,
    probeRoundId: task.probeRoundId,
    latencyMs: null,
    isTimeout: true,
    probeCount: task.attempts.length,
    probeSuccesses: 0,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    recordedAt: new Date(),
  };
  try {
    await finalizeTask(state, sample, "timeout");
  } catch (error) {
    console.error(`[AgentLink] timeout persistence failed task=${taskId}:`, error);
    state.timer = setTimeout(() => void timeoutTask(taskId), 5_000);
    state.timer.unref?.();
  }
}

export async function enqueueAgentLinkProbeTask(input: AgentLinkIdentity & {
  probeRoundId?: string;
  attemptCount?: number;
  timeoutMs?: number;
}) {
  const identity = normalizeAgentLinkIdentity(input);
  if (!identity) throw new Error("Invalid Agent Link identity");
  const probeRoundId = cleanRoundId(input.probeRoundId) || crypto.randomUUID();
  const edgeKey = buildAgentLinkEdgeKey(identity);
  const dedupeKey = roundEdgeKey(probeRoundId, edgeKey);
  const existingTaskId = activeByRoundEdge.get(dedupeKey);
  const existing = existingTaskId ? states.get(existingTaskId) : undefined;
  // History is idempotent by (edgeKey, probeRoundId), so retain one task
  // identity for every state during the retention window, not only in-flight
  // states. Callers must create a new round for a retry after a timeout.
  if (existing) return existing.task;
  const activeTaskId = activeByEdge.get(edgeKey);
  const activeTask = activeTaskId ? states.get(activeTaskId) : undefined;
  if (activeTask && (activeTask.status === "queued" || activeTask.status === "running")) {
    throw new Error("Agent Link edge already has an active probe task");
  }

  const [sourceHost, targetHost] = await Promise.all([
    db.getHostById(identity.sourceHostId),
    db.getHostById(identity.targetHostId),
  ]);
  if (!sourceHost || !targetHost) throw new Error("Agent Link source or target host does not exist");
  if (Number((sourceHost as any).agentProbeVersion || 0) < AGENT_PROBE_PROTOCOL_VERSION || !statusFresh(sourceHost)) {
    throw new Error("Source Agent does not support Agent Link probes or its capability is stale");
  }
  if (Number((targetHost as any).agentProbeVersion || 0) !== AGENT_PROBE_PROTOCOL_VERSION || !statusFresh(targetHost)) {
    throw new Error("Target Agent probe capability is unavailable or stale");
  }
  const expectedPort = agentProbePortForHost(targetHost);
  if (identity.targetPort !== expectedPort) throw new Error(`Target Agent probe port is ${expectedPort}, not ${identity.targetPort}`);
  const ready = identity.transport === "tcp" ? !!(targetHost as any).agentProbeTcpReady : !!(targetHost as any).agentProbeUdpReady;
  if (!ready) throw new Error(`Target Agent ${identity.transport.toUpperCase()} probe listener is not ready`);
  const targetToken = String((targetHost as any).agentToken || "").trim();
  if (!targetToken) throw new Error("Target Agent token is unavailable");

  const now = Date.now();
  const timeoutMs = Math.max(250, Math.min(10_000, Math.floor(Number(input.timeoutMs) || 1_500)));
  const count = attemptCount(identity.transport, input.attemptCount);
  const expiresAt = now + Math.max(30_000, count * (timeoutMs + 250) + 30_000);
  const attempts = Array.from({ length: count }, () => {
    const ticket = createAgentProbeTicket({
      token: targetToken,
      transport: identity.transport,
      nowSeconds: Math.floor(now / 1000),
      ttlSeconds: Math.ceil((expiresAt - now) / 1000) + 30,
    });
    return {
      request: ticket.request.toString("base64"),
      expectedResponse: ticket.expectedResponse.toString("base64"),
    };
  });
  const task: AgentLinkProbeTask = {
    ...identity,
    taskId: crypto.randomUUID(),
    edgeKey,
    probeRoundId,
    probeVersion: AGENT_PROBE_PROTOCOL_VERSION,
    timeoutMs,
    attempts,
    createdAt: now,
    expiresAt,
  };
  // Persist before exposing the task to a heartbeat. A Panel restart after
  // this point retains the signed ticket and authoritative edge identity.
  await insertAgentLinkProbeTask({ ...task, status: "queued" });
  const queue = queues.get(identity.sourceHostId) || [];
  queue.push(task);
  const overflow = queue.splice(0, Math.max(0, queue.length - MAX_TASKS_PER_HOST));
  queues.set(identity.sourceHostId, queue);
  for (const dropped of overflow) void timeoutTask(dropped.taskId);
  const timer = setTimeout(() => void timeoutTask(task.taskId), expiresAt - now + 5_000);
  timer.unref?.();
  states.set(task.taskId, {
    sourceHostId: identity.sourceHostId,
    task,
    status: "queued",
    timer,
    updatedAt: now,
  });
  activeByRoundEdge.set(dedupeKey, task.taskId);
  activeByEdge.set(edgeKey, task.taskId);
  pushAgentRefresh(identity.sourceHostId, "agent-link-probe", { urgent: true });
  return task;
}

// Timers are the fast path. This sweep is the recovery path for a delayed
// event loop and lets the scheduler reliably persist zero-success outcomes
// even when no new demand is currently being planned.
export async function sweepExpiredAgentLinkProbeTasks(now = Date.now()) {
  const expiredTaskIds = new Set(Array.from(states.values())
    .filter((state) => (state.status === "queued" || state.status === "running") && state.task.expiresAt <= now)
    .map((state) => state.task.taskId));
  // Include durable work that is not in this process after a restart.
  for (const durable of await getExpiredAgentLinkProbeTasks(new Date(now))) {
    if (!states.has(durable.taskId)) {
      const task: AgentLinkProbeTask = { ...durable };
      const timer = setTimeout(() => void timeoutTask(task.taskId), 5_000);
      timer.unref?.();
      states.set(task.taskId, { sourceHostId: task.sourceHostId, task, status: durable.status === "queued" ? "queued" : "running", timer, updatedAt: now });
      activeByRoundEdge.set(roundEdgeKey(task.probeRoundId, task.edgeKey), task.taskId);
      activeByEdge.set(task.edgeKey, task.taskId);
    }
    expiredTaskIds.add(durable.taskId);
  }
  await Promise.all(Array.from(expiredTaskIds, (taskId) => timeoutTask(taskId)));
  return expiredTaskIds.size;
}

export function hasQueuedAgentLinkProbeTasks(hostId: number) {
  return (queues.get(Number(hostId))?.length || 0) > 0;
}

async function taskDispatchFailure(task: AgentLinkProbeTask) {
  const [sourceHost, targetHost] = await Promise.all([
    db.getHostById(task.sourceHostId),
    db.getHostById(task.targetHostId),
  ]);
  if (!sourceHost || !targetHost) return "source or target host no longer exists";
  if (Number((sourceHost as any).agentProbeVersion || 0) < AGENT_PROBE_PROTOCOL_VERSION || !statusFresh(sourceHost)) {
    return "source Agent probe capability is unavailable or stale";
  }
  if (Number((targetHost as any).agentProbeVersion || 0) !== AGENT_PROBE_PROTOCOL_VERSION || !statusFresh(targetHost)) {
    return "target Agent probe capability is unavailable or stale";
  }
  if (agentProbePortForHost(targetHost) !== task.targetPort) return "target Agent probe port changed before dispatch";
  const ready = task.transport === "tcp" ? !!(targetHost as any).agentProbeTcpReady : !!(targetHost as any).agentProbeUdpReady;
  return ready ? null : `target Agent ${task.transport.toUpperCase()} probe listener is not ready`;
}

export async function takeAgentLinkProbeTasks(hostId: number, limit = 16) {
  const normalizedHostId = Number(hostId);
  const queue = queues.get(normalizedHostId) || [];
  const maxTasks = Math.max(1, Math.min(64, Math.floor(limit)));
  const queuedTasks = queue.splice(0, maxTasks);
  if (queue.length > 0) queues.set(normalizedHostId, queue);
  else queues.delete(normalizedHostId);
  // After a Panel restart the in-memory queue is empty while durable queued
  // work remains. Hydrate only tasks not already represented locally.
  if (queuedTasks.length < maxTasks) {
    const durableTasks = await getQueuedAgentLinkProbeTasks(normalizedHostId, maxTasks);
    for (const durable of durableTasks) {
      if (queuedTasks.length >= maxTasks || states.has(durable.taskId)) continue;
      const task: AgentLinkProbeTask = { ...durable };
      const timer = setTimeout(() => void timeoutTask(task.taskId), Math.max(0, task.expiresAt - Date.now()) + 5_000);
      timer.unref?.();
      states.set(task.taskId, { sourceHostId: normalizedHostId, task, status: "queued", timer, updatedAt: Date.now() });
      activeByRoundEdge.set(roundEdgeKey(task.probeRoundId, task.edgeKey), task.taskId);
      activeByEdge.set(task.edgeKey, task.taskId);
      queuedTasks.push(task);
    }
  }
  const now = Date.now();
  const dispatched: AgentLinkProbeTask[] = [];
  for (const task of queuedTasks) {
    const state = states.get(task.taskId);
    if (!state || state.sourceHostId !== normalizedHostId || state.status !== "queued") continue;
    if (task.expiresAt <= now) {
      await timeoutTask(task.taskId);
      continue;
    }
    const failure = await taskDispatchFailure(task);
    if (failure) {
      await timeoutTask(task.taskId, { errorCode: "capability-unavailable", errorMessage: failure });
      continue;
    }
    if (!await claimAgentLinkProbeTask(task.taskId, normalizedHostId)) continue;
    state.status = "running";
    state.updatedAt = Date.now();
    dispatched.push(task);
  }
  return dispatched;
}

export async function completeAgentLinkProbeTask(hostId: number, result: AgentLinkProbeTaskResult) {
  const taskId = String(result?.taskId || "").trim();
  let state = states.get(taskId);
  // A result may arrive after the Panel restarted. Rehydrate only the durable
  // running task owned by this source Agent; never trust result-provided edge
  // fields.
  if (!state) {
    const persisted = await getAgentLinkProbeTask(taskId);
    if (!persisted || persisted.sourceHostId !== Number(hostId) || persisted.status !== "running") return false;
    const task: AgentLinkProbeTask = { ...persisted };
    const timer = setTimeout(() => void timeoutTask(task.taskId), Math.max(0, task.expiresAt - Date.now()) + 5_000);
    timer.unref?.();
    state = { sourceHostId: task.sourceHostId, task, status: "running", timer, updatedAt: Date.now() };
    states.set(task.taskId, state);
    activeByRoundEdge.set(roundEdgeKey(task.probeRoundId, task.edgeKey), task.taskId);
    activeByEdge.set(task.edgeKey, task.taskId);
  }
  if (state.sourceHostId !== Number(hostId)) return false;
  if (state.status === "completed" || state.status === "timeout") return true;
  // A task ID is accepted only after this Panel instance has dispatched it
  // to its assigned source Agent. This preserves queued → running → terminal
  // ordering and prevents a queued task from being completed out of band.
  if (state.status !== "running") return false;
  const task = state.task;
  if (result.probeRoundId && cleanRoundId(result.probeRoundId) !== task.probeRoundId) return false;
  const probeCount = task.attempts.length;
  const probeSuccesses = Math.max(0, Math.min(probeCount, Math.floor(Number(result.probeSuccesses) || 0)));
  const finiteLatency = (value: unknown) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Math.round(Number(value));
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= task.timeoutMs * 4 ? parsed : null;
  };
  const latencyMs = probeSuccesses > 0 ? finiteLatency(result.latencyMs) : null;
  const minLatencyMs = probeSuccesses > 0 ? finiteLatency(result.minLatencyMs) : null;
  const maxLatencyMs = probeSuccesses > 0 ? finiteLatency(result.maxLatencyMs) : null;
  const jitterMs = probeSuccesses > 0 ? finiteLatency(result.jitterMs) : null;
  if (probeSuccesses > 0 && latencyMs === null) return false;
  // Optional summary fields may be omitted by a compatible Agent, but when
  // supplied they must describe the reported median rather than corrupting
  // a persisted edge history with impossible bounds.
  if (probeSuccesses > 0 && (
    (minLatencyMs !== null && maxLatencyMs !== null && minLatencyMs > maxLatencyMs)
    || (minLatencyMs !== null && latencyMs! < minLatencyMs)
    || (maxLatencyMs !== null && latencyMs! > maxLatencyMs)
  )) return false;
  const reportedAt = result.recordedAt instanceof Date
    ? result.recordedAt
    : new Date(result.recordedAt || Date.now());
  const recordedAt = Number.isFinite(reportedAt.getTime()) && Math.abs(Date.now() - reportedAt.getTime()) <= 10 * 60_000
    ? reportedAt
    : new Date();
  const sample: AgentLinkProbeSample = {
    sourceHostId: task.sourceHostId,
    targetHostId: task.targetHostId,
    targetAddress: task.targetAddress,
    targetPort: task.targetPort,
    transport: task.transport,
    edgeKey: task.edgeKey,
    probeVersion: task.probeVersion,
    probeRoundId: task.probeRoundId,
    latencyMs,
    minLatencyMs,
    maxLatencyMs,
    jitterMs,
    isTimeout: probeSuccesses <= 0,
    probeCount,
    probeSuccesses,
    errorCode: String(result.errorCode || "").trim().slice(0, 64) || null,
    errorMessage: String(result.errorMessage || "").trim().slice(0, 512) || null,
    recordedAt,
  };
  return finalizeTask(state, sample, probeSuccesses > 0 ? "completed" : "timeout");
}

/** Test support for simulating a Panel process restart; durable rows remain. */
export function resetAgentLinkProbeTaskMemoryForTest() {
  for (const state of states.values()) clearTimeout(state.timer);
  queues.clear();
  states.clear();
  activeByRoundEdge.clear();
  activeByEdge.clear();
}

export function getAgentLinkProbeTaskState(taskId: string) {
  const state = states.get(String(taskId || "").trim());
  if (!state) return null;
  return {
    sourceHostId: state.sourceHostId,
    task: state.task,
    status: state.status,
    result: state.result,
    updatedAt: state.updatedAt,
  };
}

export function agentLinkProbeTransportSupported(value: unknown): value is AgentLinkTransport {
  return (AGENT_LINK_TRANSPORTS as readonly unknown[]).includes(value);
}
