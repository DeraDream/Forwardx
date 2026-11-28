import { compareVersions, isIptablesOnlyAgentVersion } from "./agentRouteUtils";

// Standalone v1.0.8 and earlier ignore self-tests, even when the Panel sends
// them in the heartbeat. Only v1.0.9+ can report a single topology TCP dial.
export function canRunTopologyTcpTest(version: string | null | undefined) {
  if (!isIptablesOnlyAgentVersion(version)) return true;
  return compareVersions(String(version).split("-iptables-only.")[1], "1.0.9") >= 0;
}

export function canDispatchAgentSelfTest(version: string | null | undefined, kind: string | undefined) {
  if (!isIptablesOnlyAgentVersion(version)) return true;
  return canRunTopologyTcpTest(version) && kind === "topology-total";
}
