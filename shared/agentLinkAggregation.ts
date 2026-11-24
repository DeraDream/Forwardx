import type { AgentLinkProbeSample } from "./agentLink";

export type AgentLinkPathAggregate = {
  probeRoundId: string;
  status: "success" | "timeout";
  latencyMs: number | null;
  edgeKeys: string[];
  missingEdgeKeys: string[];
  timeoutEdgeKeys: string[];
  segments: AgentLinkProbeSample[];
};

export function aggregateAgentLinkPathRound(
  expectedEdgeKeys: string[],
  samples: AgentLinkProbeSample[],
): AgentLinkPathAggregate {
  const edgeKeys = expectedEdgeKeys.map((key) => String(key || "").trim()).filter(Boolean);
  const roundIds = Array.from(new Set(samples.map((sample) => String(sample.probeRoundId || "").trim()).filter(Boolean)));
  if (roundIds.length > 1) throw new Error("Agent Link path aggregation requires one probeRoundId");
  const probeRoundId = roundIds[0] || "";
  const byEdge = new Map<string, AgentLinkProbeSample>();
  for (const sample of samples) {
    const edgeKey = String(sample.edgeKey || "").trim();
    if (!edgeKey || String(sample.probeRoundId || "").trim() !== probeRoundId) continue;
    byEdge.set(edgeKey, sample);
  }
  const missingEdgeKeys = edgeKeys.filter((key) => !byEdge.has(key));
  const segments = edgeKeys.map((key) => byEdge.get(key)).filter((sample): sample is AgentLinkProbeSample => !!sample);
  const timeoutEdgeKeys = edgeKeys.filter((key) => {
    const sample = byEdge.get(key);
    return !!sample && (sample.isTimeout || sample.probeSuccesses <= 0 || sample.latencyMs === null);
  });
  const failed = !probeRoundId || edgeKeys.length === 0 || missingEdgeKeys.length > 0 || timeoutEdgeKeys.length > 0;
  return {
    probeRoundId,
    status: failed ? "timeout" : "success",
    latencyMs: failed ? null : Math.round(segments.reduce((sum, sample) => sum + Number(sample.latencyMs || 0), 0)),
    edgeKeys,
    missingEdgeKeys,
    timeoutEdgeKeys,
    segments,
  };
}
