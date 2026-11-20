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

export function summarizeTopologySegmentLabels(labels: string[]) {
  if (labels.some((label) => label === "探测中")) return { pending: true, timeout: false, latencyMs: null };
  if (labels.some((label) => label === "超时")) return { pending: false, timeout: true, latencyMs: null };
  const values = labels.map((label) => Number.parseFloat(label));
  return values.length > 0 && values.every(Number.isFinite)
    ? { pending: false, timeout: false, latencyMs: Math.round(values.reduce((sum, value) => sum + value, 0)) }
    : { pending: false, timeout: false, latencyMs: null };
}
