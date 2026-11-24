export const DEFAULT_AGENT_PROBE_PORT = 9811;
export const AGENT_PROBE_PROTOCOL_VERSION = 1;

export function normalizeAgentProbePort(value: unknown, fallback = DEFAULT_AGENT_PROBE_PORT) {
  const port = Number(value);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  return fallback;
}

export function agentProbePortForHost(host: any) {
  return normalizeAgentProbePort(host?.agentProbePort);
}

export function isAgentProbePortForHost(host: any, port: unknown) {
  const candidate = Number(port);
  return Number.isInteger(candidate) && candidate === agentProbePortForHost(host);
}
