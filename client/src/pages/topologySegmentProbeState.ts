export type TopologySegmentProbe = {
  ruleId: number;
  testId: number;
  status: string;
  success: boolean;
  latencyMs: number | null;
  requestedAt: number;
};

export type TopologySegmentProbeResult = {
  id: number;
  status?: unknown;
  success?: unknown;
  latencyMs?: unknown;
};

export type AutomaticTopologySegment = {
  ruleId: number;
  segmentKey?: string;
  sourceHostId: number;
  targetHostId?: number | null;
  targetAddress?: string | null;
  method?: "ping" | "tcp" | string;
  latencyMs?: number | null;
  isTimeout?: boolean;
  blocked?: boolean;
  failureSince?: Date | string | number | null;
  recordedAt?: Date | string | number | null;
};

export function topologySegmentProbeKey(pathId: string, edgeId: string) {
  return `${pathId}:${edgeId}`;
}

export function activeTopologySegmentProbeIds(probes: Record<string, TopologySegmentProbe>, limit = 64) {
  return Array.from(new Set(Object.values(probes)
    .filter((probe) => probe.testId > 0 && ["pending", "running"].includes(probe.status))
    .sort((a, b) => a.requestedAt - b.requestedAt)
    .map((probe) => probe.testId))).slice(0, limit);
}

export function mergeTopologySegmentProbeResults(
  current: Record<string, TopologySegmentProbe>,
  rows: TopologySegmentProbeResult[],
) {
  const results = new Map(rows.map((row) => [Number(row.id), row]));
  let changed = false;
  const next = { ...current };
  for (const [key, probe] of Object.entries(current)) {
    const result = results.get(probe.testId);
    if (!result) continue;
    const latency = result.latencyMs == null ? null : Number(result.latencyMs);
    const updated: TopologySegmentProbe = {
      ...probe,
      status: String(result.status || "pending"),
      success: result.success === true,
      latencyMs: latency !== null && Number.isFinite(latency) ? latency : null,
    };
    if (updated.status !== probe.status || updated.success !== probe.success || updated.latencyMs !== probe.latencyMs) {
      next[key] = updated;
      changed = true;
    }
  }
  return changed ? next : current;
}

export function latestAutomaticTopologySegment(
  rows: AutomaticTopologySegment[],
  input: { ruleIds: Set<number>; sourceHostId: number; targetHostId: number; targetAddresses: string[]; method?: string },
) {
  const addresses = new Set(input.targetAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
  return rows
    .filter((row) => {
      if (!input.ruleIds.has(Number(row.ruleId)) || Number(row.sourceHostId) !== input.sourceHostId) return false;
      if (input.method && String(row.method || "").toLowerCase() !== input.method.toLowerCase()) return false;
      if (input.targetHostId > 0 && Number(row.targetHostId || 0) === input.targetHostId) return true;
      return addresses.has(String(row.targetAddress || "").trim().toLowerCase());
    })
    .sort((a, b) => new Date(b.recordedAt || 0).getTime() - new Date(a.recordedAt || 0).getTime())[0] || null;
}

export function summarizePhysicalTopologySegmentLabels(
  candidates: Array<{ at: number; pending: boolean; success: boolean; label: string }>,
  fallback: string,
) {
  const ordered = [...candidates].sort((a, b) => b.at - a.at);
  const newest = ordered[0];
  if (newest?.pending) return "探测中";
  const sameBurst = newest ? ordered.filter((candidate) => newest.at - candidate.at <= 5_000) : [];
  return sameBurst.find((candidate) => candidate.success)?.label || newest?.label || fallback;
}
