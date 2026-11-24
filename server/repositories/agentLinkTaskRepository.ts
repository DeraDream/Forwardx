import { executeRaw, getDatabaseKind, queryRaw } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";
import { rawAffectedRows } from "../dbRuntime";

export type DurableAgentLinkTask = {
  taskId: string;
  edgeKey: string;
  probeRoundId: string;
  sourceHostId: number;
  targetHostId: number;
  targetAddress: string;
  targetPort: number;
  transport: "tcp" | "udp";
  probeVersion: number;
  timeoutMs: number;
  attempts: Array<{ request: string; expectedResponse: string }>;
  createdAt: number;
  expiresAt: number;
  status: "queued" | "running" | "finalizing" | "completed" | "timeout";
};

function rowDateMs(value: unknown) {
  if (value instanceof Date) return value.getTime();
  return Number(value || 0) * 1000;
}

function mapRow(row: any): DurableAgentLinkTask | null {
  try {
    const attempts = JSON.parse(String(row.attemptsJson || "[]"));
    if (!Array.isArray(attempts)) return null;
    const status = String(row.status || "");
    if (!["queued", "running", "finalizing", "completed", "timeout"].includes(status)) return null;
    return {
      taskId: String(row.taskId || ""), edgeKey: String(row.edgeKey || ""), probeRoundId: String(row.probeRoundId || ""),
      sourceHostId: Number(row.sourceHostId || 0), targetHostId: Number(row.targetHostId || 0), targetAddress: String(row.targetAddress || ""),
      targetPort: Number(row.targetPort || 0), transport: row.transport === "udp" ? "udp" : "tcp", probeVersion: Number(row.probeVersion || 1),
      timeoutMs: Number(row.timeoutMs || 0), attempts, createdAt: rowDateMs(row.createdAt), expiresAt: rowDateMs(row.expiresAt), status: status as DurableAgentLinkTask["status"],
    };
  } catch { return null; }
}

export async function insertAgentLinkProbeTask(task: DurableAgentLinkTask) {
  const q = quoteIdentifier;
  const columns = ["taskId", "edgeKey", "probeRoundId", "sourceHostId", "targetHostId", "targetAddress", "targetPort", "transport", "probeVersion", "timeoutMs", "attemptsJson", "status", "createdAt", "expiresAt", "updatedAt"];
  const values = [task.taskId, task.edgeKey, task.probeRoundId, task.sourceHostId, task.targetHostId, task.targetAddress, task.targetPort, task.transport, task.probeVersion, task.timeoutMs, JSON.stringify(task.attempts), task.status, new Date(task.createdAt), new Date(task.expiresAt), new Date(task.createdAt)];
  const conflict = getDatabaseKind() === "mysql" ? `ON DUPLICATE KEY UPDATE ${q("taskId")}=${q("taskId")}` : `ON CONFLICT (${q("edgeKey")}, ${q("probeRoundId")}) DO NOTHING`;
  await executeRaw(`INSERT INTO ${q("agent_link_probe_tasks")} (${columns.map(q).join(",")}) VALUES (${columns.map(() => "?").join(",")}) ${conflict}`, values);
}

export async function getAgentLinkProbeTask(taskId: string) {
  const q = quoteIdentifier;
  const rows = await queryRaw<any>(`SELECT * FROM ${q("agent_link_probe_tasks")} WHERE ${q("taskId") }=? LIMIT 1`, [taskId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getQueuedAgentLinkProbeTasks(sourceHostId: number, limit = 16) {
  const q = quoteIdentifier;
  const rows = await queryRaw<any>(`SELECT * FROM ${q("agent_link_probe_tasks")} WHERE ${q("sourceHostId") }=? AND ${q("status")}='queued' ORDER BY ${q("createdAt")} ASC LIMIT ?`, [sourceHostId, Math.max(1, Math.min(64, limit))]);
  return rows.map(mapRow).filter((row): row is DurableAgentLinkTask => !!row);
}

export async function getExpiredAgentLinkProbeTasks(now = new Date(), limit = 1_000) {
  const q = quoteIdentifier;
  // A crash can leave a task in finalizing after its history transaction. It
  // is safe to make it retryable here: history writes are idempotent by edge
  // and round, and the next finalizer owns the terminal transition.
  await executeRaw(`UPDATE ${q("agent_link_probe_tasks")} SET ${q("status")}='running', ${q("updatedAt") }=? WHERE ${q("status")}='finalizing' AND ${q("expiresAt")} <= ?`, [now, now]);
  const rows = await queryRaw<any>(`SELECT * FROM ${q("agent_link_probe_tasks")} WHERE ${q("expiresAt")} <= ? AND ${q("status")} IN ('queued','running') ORDER BY ${q("expiresAt")} ASC LIMIT ?`, [now, Math.max(1, Math.min(10_000, limit))]);
  return rows.map(mapRow).filter((row): row is DurableAgentLinkTask => !!row);
}

export async function cleanTerminalAgentLinkProbeTasks(cutoff = new Date(Date.now() - 10 * 60_000)) {
  const q = quoteIdentifier;
  return executeRaw(`DELETE FROM ${q("agent_link_probe_tasks")} WHERE ${q("status")} IN ('completed','timeout') AND COALESCE(${q("completedAt")}, ${q("updatedAt")}) < ?`, [cutoff]);
}

export async function claimAgentLinkProbeTaskFinalization(taskId: string, sourceHostId: number, now = new Date()) {
  const q = quoteIdentifier;
  const result = await executeRaw(`UPDATE ${q("agent_link_probe_tasks")} SET ${q("status") }='finalizing', ${q("updatedAt") }=? WHERE ${q("taskId") }=? AND ${q("sourceHostId") }=? AND ${q("status")} IN ('queued','running')`, [now, taskId, sourceHostId]);
  return rawAffectedRows(result) > 0;
}

export async function releaseAgentLinkProbeTaskFinalization(taskId: string, sourceHostId: number, status: "queued" | "running", now = new Date()) {
  const q = quoteIdentifier;
  await executeRaw(`UPDATE ${q("agent_link_probe_tasks")} SET ${q("status") }=?, ${q("updatedAt") }=? WHERE ${q("taskId") }=? AND ${q("sourceHostId") }=? AND ${q("status")}='finalizing'`, [status, now, taskId, sourceHostId]);
}

export async function finishAgentLinkProbeTask(taskId: string, sourceHostId: number, status: "completed" | "timeout", now = new Date()) {
  const q = quoteIdentifier;
  const result = await executeRaw(`UPDATE ${q("agent_link_probe_tasks")} SET ${q("status") }=?, ${q("completedAt") }=?, ${q("updatedAt") }=? WHERE ${q("taskId") }=? AND ${q("sourceHostId") }=? AND ${q("status")}='finalizing'`, [status, now, now, taskId, sourceHostId]);
  return rawAffectedRows(result) > 0;
}

export async function claimAgentLinkProbeTask(taskId: string, sourceHostId: number, now = new Date()) {
  const q = quoteIdentifier;
  const result = await executeRaw(`UPDATE ${q("agent_link_probe_tasks")} SET ${q("status")}='running', ${q("dispatchedAt") }=?, ${q("updatedAt") }=? WHERE ${q("taskId") }=? AND ${q("sourceHostId") }=? AND ${q("status")}='queued'`, [now, now, taskId, sourceHostId]);
  return rawAffectedRows(result) > 0;
}
