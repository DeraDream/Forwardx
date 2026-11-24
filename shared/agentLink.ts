import { AGENT_PROBE_PROTOCOL_VERSION } from "./agentProbe";

export const AGENT_LINK_KEY_VERSION = 1;
export const AGENT_LINK_TRANSPORTS = ["tcp", "udp"] as const;
export type AgentLinkTransport = (typeof AGENT_LINK_TRANSPORTS)[number];

export type AgentLinkIdentity = {
  sourceHostId: number;
  targetHostId: number;
  targetAddress: string;
  targetPort: number;
  transport: AgentLinkTransport;
};

export type AgentLinkProbeSample = AgentLinkIdentity & {
  edgeKey?: string;
  probeVersion?: number;
  probeRoundId: string;
  latencyMs: number | null;
  minLatencyMs?: number | null;
  maxLatencyMs?: number | null;
  jitterMs?: number | null;
  isTimeout: boolean;
  probeCount: number;
  probeSuccesses: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  recordedAt?: Date;
};

export function normalizeAgentLinkTransport(value: unknown): AgentLinkTransport | null {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "tcp" || normalized === "udp" ? normalized : null;
}

export function normalizeAgentLinkAddress(value: unknown) {
  const raw = String(value || "").trim();
  const unwrapped = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return unwrapped.toLowerCase().slice(0, 253);
}

function positiveHostId(value: unknown) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeAgentLinkIdentity(value: AgentLinkIdentity): AgentLinkIdentity | null {
  const sourceHostId = positiveHostId(value.sourceHostId);
  const targetHostId = positiveHostId(value.targetHostId);
  const targetAddress = normalizeAgentLinkAddress(value.targetAddress);
  const targetPort = Math.floor(Number(value.targetPort));
  const transport = normalizeAgentLinkTransport(value.transport);
  if (!sourceHostId || !targetHostId || !targetAddress || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || !transport || sourceHostId === targetHostId) return null;
  return { sourceHostId, targetHostId, targetAddress, targetPort, transport };
}

export function buildAgentLinkEdgeKey(value: AgentLinkIdentity) {
  const identity = normalizeAgentLinkIdentity(value);
  if (!identity) return "";
  return [
    `agent-link-v${AGENT_LINK_KEY_VERSION}`,
    identity.sourceHostId,
    identity.targetHostId,
    encodeURIComponent(identity.targetAddress),
    identity.targetPort,
    identity.transport,
  ].join(":");
}

export function parseAgentLinkEdgeKey(value: unknown): AgentLinkIdentity | null {
  const parts = String(value || "").trim().split(":");
  if (parts.length !== 6 || parts[0] !== `agent-link-v${AGENT_LINK_KEY_VERSION}`) return null;
  let targetAddress = "";
  try {
    targetAddress = decodeURIComponent(parts[3]);
  } catch {
    return null;
  }
  const identity = normalizeAgentLinkIdentity({
    sourceHostId: Number(parts[1]),
    targetHostId: Number(parts[2]),
    targetAddress,
    targetPort: Number(parts[4]),
    transport: parts[5] as AgentLinkTransport,
  });
  return identity && buildAgentLinkEdgeKey(identity) === String(value).trim() ? identity : null;
}

export function normalizeAgentLinkProbeSample(value: AgentLinkProbeSample): AgentLinkProbeSample | null {
  const identity = normalizeAgentLinkIdentity(value);
  if (!identity) return null;
  const probeRoundId = String(value.probeRoundId || "").trim().slice(0, 128);
  if (!probeRoundId) return null;
  const probeCount = Math.max(1, Math.min(100, Math.floor(Number(value.probeCount) || 1)));
  const probeSuccesses = Math.max(0, Math.min(probeCount, Math.floor(Number(value.probeSuccesses) || 0)));
  const isTimeout = probeSuccesses <= 0;
  const normalizeLatency = (latency: unknown) => {
    if (latency === null || latency === undefined || latency === "") return null;
    const parsed = Math.round(Number(latency));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const latencyMs = isTimeout ? null : normalizeLatency(value.latencyMs);
  if (!isTimeout && latencyMs === null) return null;
  return {
    ...identity,
    edgeKey: buildAgentLinkEdgeKey(identity),
    probeVersion: Math.max(1, Math.floor(Number(value.probeVersion) || AGENT_PROBE_PROTOCOL_VERSION)),
    probeRoundId,
    latencyMs,
    minLatencyMs: isTimeout ? null : normalizeLatency(value.minLatencyMs),
    maxLatencyMs: isTimeout ? null : normalizeLatency(value.maxLatencyMs),
    jitterMs: isTimeout ? null : normalizeLatency(value.jitterMs),
    isTimeout,
    probeCount,
    probeSuccesses,
    errorCode: String(value.errorCode || "").trim().slice(0, 64) || null,
    errorMessage: String(value.errorMessage || "").trim().slice(0, 512) || null,
    recordedAt: value.recordedAt instanceof Date ? value.recordedAt : new Date(),
  };
}
