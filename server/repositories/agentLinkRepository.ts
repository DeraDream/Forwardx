import { getDatabaseKind, executeRaw, queryRaw, withDatabaseTransaction } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";
import {
  normalizeAgentLinkProbeSample,
  type AgentLinkProbeSample,
} from "../../shared/agentLink";

const AGENT_LINK_HISTORY_RETENTION_DAYS = 30;
const MAX_EDGE_QUERY_COUNT = 500;

const sampleColumns = [
  "edgeKey",
  "sourceHostId",
  "targetHostId",
  "targetAddress",
  "targetPort",
  "transport",
  "probeVersion",
  "probeRoundId",
  "latencyMs",
  "minLatencyMs",
  "maxLatencyMs",
  "jitterMs",
  "isTimeout",
  "probeCount",
  "probeSuccesses",
  "errorCode",
  "errorMessage",
  "recordedAt",
] as const;

function sampleValues(sample: AgentLinkProbeSample) {
  return sampleColumns.map((column) => (sample as any)[column] ?? null);
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function rowBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

function rowDate(value: unknown) {
  if (value instanceof Date) return value;
  const numeric = Number(value || 0);
  return new Date(numeric * 1000);
}

function mapAgentLinkRow(row: any): AgentLinkProbeSample & { id?: number; updatedAt?: Date } {
  return {
    id: Number(row.id || 0) || undefined,
    edgeKey: String(row.edgeKey || ""),
    sourceHostId: Number(row.sourceHostId || 0),
    targetHostId: Number(row.targetHostId || 0),
    targetAddress: String(row.targetAddress || ""),
    targetPort: Number(row.targetPort || 0),
    transport: row.transport === "udp" ? "udp" : "tcp",
    probeVersion: Number(row.probeVersion || 1),
    probeRoundId: String(row.probeRoundId || ""),
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    minLatencyMs: row.minLatencyMs === null || row.minLatencyMs === undefined ? null : Number(row.minLatencyMs),
    maxLatencyMs: row.maxLatencyMs === null || row.maxLatencyMs === undefined ? null : Number(row.maxLatencyMs),
    jitterMs: row.jitterMs === null || row.jitterMs === undefined ? null : Number(row.jitterMs),
    isTimeout: rowBool(row.isTimeout),
    probeCount: Number(row.probeCount || 1),
    probeSuccesses: Number(row.probeSuccesses || 0),
    errorCode: row.errorCode ? String(row.errorCode) : null,
    errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    recordedAt: rowDate(row.recordedAt),
    ...(row.updatedAt !== undefined ? { updatedAt: rowDate(row.updatedAt) } : {}),
  };
}

async function insertHistory(sample: AgentLinkProbeSample) {
  const q = quoteIdentifier;
  const columns = sampleColumns.map(q).join(", ");
  const conflict = getDatabaseKind() === "mysql"
    ? `ON DUPLICATE KEY UPDATE ${q("edgeKey")} = ${q("edgeKey")}`
    : `ON CONFLICT (${q("edgeKey")}, ${q("probeRoundId")}) DO NOTHING`;
  await executeRaw(
    `INSERT INTO ${q("agent_link_latency_stats")} (${columns}) VALUES (${placeholders(sampleColumns.length)}) ${conflict}`,
    sampleValues(sample),
  );
}

async function upsertLatest(sample: AgentLinkProbeSample) {
  const q = quoteIdentifier;
  const columns = [...sampleColumns, "updatedAt"] as const;
  const values = [...sampleValues(sample), sample.recordedAt];
  const mutableColumns = sampleColumns.filter((column) => column !== "edgeKey");
  if (getDatabaseKind() === "mysql") {
    const assignments = mutableColumns.map((column) => (
      `${q(column)} = IF(VALUES(${q("recordedAt")}) >= ${q("recordedAt")}, VALUES(${q(column)}), ${q(column)})`
    ));
    assignments.push(`${q("updatedAt")} = IF(VALUES(${q("recordedAt")}) >= ${q("recordedAt")}, VALUES(${q("updatedAt")}), ${q("updatedAt")})`);
    await executeRaw(
      `INSERT INTO ${q("agent_link_latest")} (${columns.map(q).join(", ")}) VALUES (${placeholders(columns.length)})
       ON DUPLICATE KEY UPDATE ${assignments.join(", ")}`,
      values,
    );
    return;
  }
  const assignments = mutableColumns.map((column) => `${q(column)} = excluded.${q(column)}`);
  assignments.push(`${q("updatedAt")} = excluded.${q("updatedAt")}`);
  await executeRaw(
    `INSERT INTO ${q("agent_link_latest")} (${columns.map(q).join(", ")}) VALUES (${placeholders(columns.length)})
     ON CONFLICT (${q("edgeKey")}) DO UPDATE SET ${assignments.join(", ")}
     WHERE excluded.${q("recordedAt")} >= ${q("agent_link_latest")}.${q("recordedAt")}`,
    values,
  );
}

export async function recordAgentLinkProbeSample(input: AgentLinkProbeSample) {
  const sample = normalizeAgentLinkProbeSample(input);
  if (!sample) throw new Error("Invalid Agent Link probe sample");
  await withDatabaseTransaction(async () => {
    await insertHistory(sample);
    await upsertLatest(sample);
  });
  return sample;
}

export async function getAgentLinkLatest(edgeKeys?: string[]) {
  const q = quoteIdentifier;
  const keys = Array.from(new Set((edgeKeys || []).map((key) => String(key || "").trim()).filter(Boolean))).slice(0, MAX_EDGE_QUERY_COUNT);
  const where = keys.length > 0 ? `WHERE ${q("edgeKey")} IN (${placeholders(keys.length)})` : "";
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q("agent_link_latest")} ${where} ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC`,
    keys,
  );
  return rows.map(mapAgentLinkRow);
}

export async function getAgentLinkHistory(edgeKey: string, options: { since?: Date; limit?: number } = {}) {
  const q = quoteIdentifier;
  const normalizedKey = String(edgeKey || "").trim();
  if (!normalizedKey) return [];
  const limit = Math.max(1, Math.min(10_000, Math.floor(Number(options.limit) || 500)));
  const params: unknown[] = [normalizedKey];
  const since = options.since instanceof Date ? options.since : null;
  const sinceSql = since ? `AND ${q("recordedAt")} >= ?` : "";
  if (since) params.push(since);
  params.push(limit);
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q("agent_link_latency_stats")}
      WHERE ${q("edgeKey")} = ? ${sinceSql}
      ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC
      LIMIT ?`,
    params,
  );
  return rows.map(mapAgentLinkRow);
}

export async function getAgentLinkRoundSamples(probeRoundId: string, edgeKeys?: string[]) {
  const q = quoteIdentifier;
  const roundId = String(probeRoundId || "").trim();
  if (!roundId) return [];
  const keys = Array.from(new Set((edgeKeys || []).map((key) => String(key || "").trim()).filter(Boolean))).slice(0, MAX_EDGE_QUERY_COUNT);
  const keySql = keys.length > 0 ? `AND ${q("edgeKey")} IN (${placeholders(keys.length)})` : "";
  const rows = await queryRaw<any>(
    `SELECT * FROM ${q("agent_link_latency_stats")}
      WHERE ${q("probeRoundId")} = ? ${keySql}
      ORDER BY ${q("edgeKey")} ASC`,
    [roundId, ...keys],
  );
  return rows.map(mapAgentLinkRow);
}

export async function cleanOldAgentLinkStats(retainHours = AGENT_LINK_HISTORY_RETENTION_DAYS * 24) {
  const q = quoteIdentifier;
  const hours = Math.max(1, Math.floor(Number(retainHours) || AGENT_LINK_HISTORY_RETENTION_DAYS * 24));
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [history, latest] = await Promise.all([
    executeRaw(`DELETE FROM ${q("agent_link_latency_stats")} WHERE ${q("recordedAt")} < ?`, [cutoff]),
    executeRaw(`DELETE FROM ${q("agent_link_latest")} WHERE ${q("recordedAt")} < ?`, [cutoff]),
  ]);
  return { history, latest };
}

export async function pruneAgentLinkHistory(retentionDays = AGENT_LINK_HISTORY_RETENTION_DAYS) {
  return cleanOldAgentLinkStats(Math.max(1, Math.floor(Number(retentionDays) || AGENT_LINK_HISTORY_RETENTION_DAYS)) * 24);
}
