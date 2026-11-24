import { executeRaw, getDatabaseKind, queryRaw } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";
import { normalizeAgentLinkAddress, normalizeAgentLinkTransport, type AgentLinkTransport } from "../../shared/agentLink";
import { buildRuleEndpointKey, buildServiceHealthKey } from "../../shared/probeStorage";

export type RuleEndpointLatencySample = {
  ruleId: number;
  sourceHostId: number;
  targetHostId?: number | null;
  targetAddress: string;
  targetPort: number;
  transport: AgentLinkTransport;
  probeMethod: string;
  probeRoundId: string;
  latencyMs: number | null;
  isTimeout: boolean;
  probeCount: number;
  probeSuccesses: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  recordedAt?: Date;
};

export type ServiceHealthSample = {
  serviceType: string;
  serviceId?: number | null;
  hostId?: number | null;
  targetAddress: string;
  targetPort: number;
  transport: AgentLinkTransport;
  probeMethod: string;
  probeRoundId: string;
  status: "healthy" | "unhealthy" | "degraded" | "unknown";
  latencyMs: number | null;
  probeCount: number;
  probeSuccesses: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  recordedAt?: Date;
};

function positiveId(value: unknown) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function validPort(value: unknown) {
  const parsed = Math.floor(Number(value));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 0;
}

function probeCounts(countValue: unknown, successesValue: unknown) {
  const probeCount = Math.max(1, Math.min(100, Math.floor(Number(countValue) || 1)));
  const probeSuccesses = Math.max(0, Math.min(probeCount, Math.floor(Number(successesValue) || 0)));
  return { probeCount, probeSuccesses };
}

function latency(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function cleanText(value: unknown, maxLength: number) {
  return String(value || "").trim().slice(0, maxLength) || null;
}

function insertConflict(columns: string[]) {
  const q = quoteIdentifier;
  return getDatabaseKind() === "mysql"
    ? `ON DUPLICATE KEY UPDATE ${q(columns[0])} = ${q(columns[0])}`
    : `ON CONFLICT (${columns.map(q).join(", ")}) DO NOTHING`;
}

export async function recordRuleEndpointLatencyStats(samples: RuleEndpointLatencySample[]) {
  const q = quoteIdentifier;
  let inserted = 0;
  for (const input of samples) {
    const ruleId = positiveId(input.ruleId);
    const sourceHostId = positiveId(input.sourceHostId);
    const targetHostId = positiveId(input.targetHostId) || null;
    const targetAddress = normalizeAgentLinkAddress(input.targetAddress);
    const targetPort = validPort(input.targetPort);
    const transport = normalizeAgentLinkTransport(input.transport);
    const probeMethod = String(input.probeMethod || "").trim().toLowerCase().slice(0, 32);
    const probeRoundId = String(input.probeRoundId || "").trim().slice(0, 128);
    const counts = probeCounts(input.probeCount, input.probeSuccesses);
    const isTimeout = counts.probeSuccesses <= 0;
    const latencyMs = isTimeout ? null : latency(input.latencyMs);
    const endpointKey = buildRuleEndpointKey({ ruleId, sourceHostId, targetHostId, targetAddress, targetPort, transport, probeMethod });
    if (!endpointKey || !probeRoundId || (!isTimeout && latencyMs === null)) continue;
    const columns = ["endpointKey", "ruleId", "sourceHostId", "targetHostId", "targetAddress", "targetPort", "transport", "probeMethod", "probeRoundId", "latencyMs", "isTimeout", "probeCount", "probeSuccesses", "errorCode", "errorMessage", "recordedAt"];
    await executeRaw(
      `INSERT INTO ${q("rule_endpoint_latency_stats")} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ${insertConflict(["endpointKey", "probeRoundId"])}`,
      [endpointKey, ruleId, sourceHostId, targetHostId, targetAddress, targetPort, transport, probeMethod, probeRoundId, latencyMs, isTimeout,
        counts.probeCount, counts.probeSuccesses, cleanText(input.errorCode, 64), cleanText(input.errorMessage, 512), input.recordedAt || new Date()],
    );
    inserted += 1;
  }
  return inserted;
}

export async function recordServiceHealthStats(samples: ServiceHealthSample[]) {
  const q = quoteIdentifier;
  let inserted = 0;
  for (const input of samples) {
    const serviceType = String(input.serviceType || "").trim().toLowerCase().slice(0, 32);
    const serviceId = positiveId(input.serviceId) || null;
    const hostId = positiveId(input.hostId) || null;
    const targetAddress = normalizeAgentLinkAddress(input.targetAddress);
    const targetPort = validPort(input.targetPort);
    const transport = normalizeAgentLinkTransport(input.transport);
    const probeMethod = String(input.probeMethod || "").trim().toLowerCase().slice(0, 32);
    const probeRoundId = String(input.probeRoundId || "").trim().slice(0, 128);
    const counts = probeCounts(input.probeCount, input.probeSuccesses);
    const status = ["healthy", "unhealthy", "degraded", "unknown"].includes(input.status) ? input.status : "unknown";
    const latencyMs = counts.probeSuccesses > 0 ? latency(input.latencyMs) : null;
    const serviceKey = buildServiceHealthKey({ serviceType, serviceId, hostId, targetAddress, targetPort, transport, probeMethod });
    if (!serviceKey || !probeRoundId || (counts.probeSuccesses > 0 && latencyMs === null)) continue;
    const columns = ["serviceKey", "serviceType", "serviceId", "hostId", "targetAddress", "targetPort", "transport", "probeMethod", "probeRoundId", "status", "latencyMs", "probeCount", "probeSuccesses", "errorCode", "errorMessage", "recordedAt"];
    await executeRaw(
      `INSERT INTO ${q("service_health_stats")} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ${insertConflict(["serviceKey", "probeRoundId"])}`,
      [serviceKey, serviceType, serviceId, hostId, targetAddress, targetPort, transport, probeMethod, probeRoundId, status, latencyMs,
        counts.probeCount, counts.probeSuccesses, cleanText(input.errorCode, 64), cleanText(input.errorMessage, 512), input.recordedAt || new Date()],
    );
    inserted += 1;
  }
  return inserted;
}

export async function cleanOldProbeOutcomeStats(retainHours = 30 * 24) {
  const q = quoteIdentifier;
  const hours = Math.max(1, Math.floor(Number(retainHours) || 30 * 24));
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [ruleEndpoints, serviceHealth] = await Promise.all([
    executeRaw(`DELETE FROM ${q("rule_endpoint_latency_stats")} WHERE ${q("recordedAt")} < ?`, [cutoff]),
    executeRaw(`DELETE FROM ${q("service_health_stats")} WHERE ${q("recordedAt")} < ?`, [cutoff]),
  ]);
  return { ruleEndpoints, serviceHealth };
}

export async function getRuleEndpointLatencyHistory(ruleIdValue: number, limitValue = 500) {
  const q = quoteIdentifier;
  const ruleId = positiveId(ruleIdValue);
  if (!ruleId) return [];
  const limit = Math.max(1, Math.min(10_000, Math.floor(Number(limitValue) || 500)));
  return queryRaw<any>(
    `SELECT * FROM ${q("rule_endpoint_latency_stats")} WHERE ${q("ruleId")} = ? ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC LIMIT ?`,
    [ruleId, limit],
  );
}

export async function getServiceHealthHistory(serviceTypeValue: string, serviceIdValue: number, limitValue = 500) {
  const q = quoteIdentifier;
  const serviceType = String(serviceTypeValue || "").trim().toLowerCase().slice(0, 32);
  const serviceId = positiveId(serviceIdValue);
  if (!serviceType || !serviceId) return [];
  const limit = Math.max(1, Math.min(10_000, Math.floor(Number(limitValue) || 500)));
  return queryRaw<any>(
    `SELECT * FROM ${q("service_health_stats")} WHERE ${q("serviceType")} = ? AND ${q("serviceId")} = ? ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC LIMIT ?`,
    [serviceType, serviceId, limit],
  );
}
