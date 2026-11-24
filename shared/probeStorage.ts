import { normalizeAgentLinkAddress, normalizeAgentLinkTransport } from "./agentLink";

function positiveId(value: unknown) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function validPort(value: unknown) {
  const parsed = Math.floor(Number(value));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 0;
}

function cleanPart(value: unknown, maxLength = 64) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength);
}

export function buildRuleEndpointKey(input: {
  ruleId: number;
  sourceHostId: number;
  targetHostId?: number | null;
  targetAddress: string;
  targetPort: number;
  transport: unknown;
  probeMethod: unknown;
}) {
  const ruleId = positiveId(input.ruleId);
  const sourceHostId = positiveId(input.sourceHostId);
  const targetHostId = positiveId(input.targetHostId);
  const targetAddress = normalizeAgentLinkAddress(input.targetAddress);
  const targetPort = validPort(input.targetPort);
  const transport = normalizeAgentLinkTransport(input.transport);
  const probeMethod = cleanPart(input.probeMethod, 32);
  if (!ruleId || !sourceHostId || !targetAddress || !targetPort || !transport || !probeMethod) return "";
  return ["rule-endpoint-v1", ruleId, sourceHostId, targetHostId, encodeURIComponent(targetAddress), targetPort, transport, probeMethod].join(":");
}

export function buildServiceHealthKey(input: {
  serviceType: unknown;
  serviceId?: number | null;
  hostId?: number | null;
  targetAddress: string;
  targetPort: number;
  transport: unknown;
  probeMethod: unknown;
}) {
  const serviceType = cleanPart(input.serviceType, 32);
  const serviceId = positiveId(input.serviceId);
  const hostId = positiveId(input.hostId);
  const targetAddress = normalizeAgentLinkAddress(input.targetAddress);
  const targetPort = validPort(input.targetPort);
  const transport = normalizeAgentLinkTransport(input.transport);
  const probeMethod = cleanPart(input.probeMethod, 32);
  if (!serviceType || !targetAddress || !targetPort || !transport || !probeMethod) return "";
  return ["service-health-v1", serviceType, serviceId, hostId, encodeURIComponent(targetAddress), targetPort, transport, probeMethod].join(":");
}
