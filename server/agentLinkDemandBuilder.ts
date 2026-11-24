import * as db from "./db";
import { agentProbePortForHost } from "../shared/agentProbe";
import {
  buildAgentLinkEdgeKey,
  type AgentLinkIdentity,
} from "../shared/agentLink";

type AgentLinkCandidate = {
  sourceHostId: number;
  targetHostId: number | null | undefined;
  targetAddress: string;
};

export async function buildAgentLinkDemands(candidates: AgentLinkCandidate[]) {
  const targetHosts = new Map<number, any>();
  const identities: AgentLinkIdentity[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const sourceHostId = Math.floor(Number(candidate.sourceHostId || 0));
    const targetHostId = Math.floor(Number(candidate.targetHostId || 0));
    const targetAddress = String(candidate.targetAddress || "").trim();
    if (sourceHostId <= 0 || targetHostId <= 0 || sourceHostId === targetHostId || !targetAddress) continue;
    let targetHost = targetHosts.get(targetHostId);
    if (targetHost === undefined) {
      targetHost = await db.getHostById(targetHostId) || null;
      targetHosts.set(targetHostId, targetHost);
    }
    if (!targetHost) continue;
    const targetPort = agentProbePortForHost(targetHost);
    for (const transport of ["tcp", "udp"] as const) {
      const identity: AgentLinkIdentity = { sourceHostId, targetHostId, targetAddress, targetPort, transport };
      const edgeKey = buildAgentLinkEdgeKey(identity);
      if (!edgeKey || seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      identities.push(identity);
    }
  }
  return identities;
}

export function agentLinkCandidatesFromProbeLists(input: {
  sourceHostId: number;
  forwardGroupProbes?: any[];
  tunnelProbes?: any[];
}) {
  const sourceHostId = Number(input.sourceHostId || 0);
  const candidates: AgentLinkCandidate[] = [];
  for (const probe of input.forwardGroupProbes || []) {
    candidates.push({
      sourceHostId,
      targetHostId: Number(probe?.targetHostId || 0) || null,
      targetAddress: String(probe?.targetIp || ""),
    });
  }
  for (const probe of input.tunnelProbes || []) {
    candidates.push({
      sourceHostId,
      targetHostId: Number(probe?.targetHostId || 0) || null,
      targetAddress: String(probe?.targetIp || ""),
    });
  }
  return candidates;
}
