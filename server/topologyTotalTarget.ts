// The total test targets only the first forwarding listener reached from the
// selected entrance; downstream probe targets must never become extra TCP jobs.
export function topologyTotalResultMessage(meta: { targetIp: string; targetPort: number }, message: string | null, latencyMs: number | null) {
  return JSON.stringify({ kind: "topology-total", targetIp: meta.targetIp, targetPort: meta.targetPort,
    message, totalLatencyMs: latencyMs });
}

export function selectTopologyTotalTarget(
  segments: Array<{ fromHostId: number; targetIp: string; targetPort: number }>,
  entryHostId: number,
): { targetIp: string; targetPort: number } | null {
  const first = segments.find((segment) => Number(segment.fromHostId) === entryHostId);
  const targetIp = String(first?.targetIp || "").trim();
  const targetPort = Number(first?.targetPort || 0);
  return targetIp && Number.isSafeInteger(targetPort) && targetPort >= 1 && targetPort <= 65535
    ? { targetIp, targetPort }
    : null;
}
