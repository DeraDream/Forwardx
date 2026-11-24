import { AGENT_PROBE_PROTOCOL_VERSION, DEFAULT_AGENT_PROBE_PORT, normalizeAgentProbePort } from "../shared/agentProbe";

export type AgentProbeStatusReport = {
  version: number;
  port: number;
  tcpReady: boolean;
  udpReady: boolean;
  message: string | null;
};

function reportBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value || "").trim().toLowerCase() === "true";
}

export function normalizeAgentProbeStatus(value: unknown): AgentProbeStatusReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as any;
  const version = Math.max(0, Math.floor(Number(report.version || 0)));
  if (version !== AGENT_PROBE_PROTOCOL_VERSION) return null;
  const rawPort = Number(report.port);
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) return null;
  const messageText = String(report.message || "").trim().slice(0, 512);
  return {
    version,
    port: normalizeAgentProbePort(rawPort, DEFAULT_AGENT_PROBE_PORT),
    tcpReady: reportBool(report.tcpReady),
    udpReady: reportBool(report.udpReady),
    message: messageText || null,
  };
}

export function agentProbeStatusChanged(host: any, report: AgentProbeStatusReport | null) {
  if (!report) return false;
  return Number(host?.agentProbeVersion || 0) !== report.version
    || Number(host?.agentProbePort || DEFAULT_AGENT_PROBE_PORT) !== report.port
    || !!host?.agentProbeTcpReady !== report.tcpReady
    || !!host?.agentProbeUdpReady !== report.udpReady
    || String(host?.agentProbeMessage || "") !== String(report.message || "");
}
