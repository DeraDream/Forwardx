import { exitGroupUsesMultipleExits } from "../shared/exitStrategy";
import { isTunnelRelayFailover, tunnelRelayCandidates } from "../shared/tunnelRelay";

type TunnelLatencySeriesSample = {
  seriesKey?: string | null;
  latencyMs?: number | null;
  isTimeout?: boolean;
  recordedAt?: unknown;
};

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

export function timestampMs(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedDetailPathKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase();
  return key === "primary" || /^(?:exit|relay)-\d+$/.test(key) || /^relay-branch-\d+-\d+$/.test(key) ? key : null;
}

function detailPathRank(key: string) {
  if (/^relay-branch-\d+-\d+$/.test(key)) return -1;
  if (key === "primary") return 0;
  const match = key.match(/^(relay|exit)-(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return (match[1] === "relay" ? 100_000 : 200_000) + Number(match[2] || 0);
}

/** Selects the branch whose sample formed the latest total latency row. */
export function selectTunnelLatencyDetailPathKey(
  latest: TunnelLatencySeriesSample | null | undefined,
  series: TunnelLatencySeriesSample[],
) {
  const explicit = normalizedDetailPathKey(latest?.seriesKey);
  if (explicit) return explicit;
  const latestAt = timestampMs(latest?.recordedAt);
  if (latestAt <= 0) return "default";
  const latestTimeout = !!latest?.isTimeout;
  const latestLatency = typeof latest?.latencyMs === "number" && latest.latencyMs > 0
    ? Number(latest.latencyMs)
    : null;
  const candidates = (series || []).flatMap((sample) => {
    const key = normalizedDetailPathKey(sample?.seriesKey);
    const recordedAt = timestampMs(sample?.recordedAt);
    if (!key || recordedAt <= 0 || Math.abs(recordedAt - latestAt) > 1_000) return [];
    const sampleTimeout = !!sample?.isTimeout;
    const sampleLatency = typeof sample?.latencyMs === "number" && sample.latencyMs > 0
      ? Number(sample.latencyMs)
      : null;
    if (sampleTimeout !== latestTimeout) return [];
    if (!latestTimeout && sampleLatency !== latestLatency) return [];
    return [{ key, rank: detailPathRank(key) }];
  });
  candidates.sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
  return candidates[0]?.key || "default";
}

export function structuredTunnelMessageMatchesLatency(
  generatedAt: unknown,
  latencyRecordedAt: unknown,
  maxSkewMs = 30_000,
) {
  const referenceAt = timestampMs(latencyRecordedAt);
  if (referenceAt <= 0) return true;
  const messageAt = timestampMs(generatedAt);
  return messageAt > 0 && Math.abs(messageAt - referenceAt) <= Math.max(1_000, maxSkewMs);
}

export function tunnelLatencySampleIsAfterBaseline(sample: any, baselineId: unknown) {
  const sampleId = positiveInteger(sample?.id);
  const baseline = positiveInteger(baselineId);
  return sampleId > 0 && (baseline <= 0 || sampleId > baseline);
}

export function tunnelDetailHostEdges(details: any[]) {
  const edges: Array<[number, number]> = [];
  for (const detail of details || []) {
    const explicitFrom = positiveInteger(detail?.fromHostId);
    const explicitTo = positiveInteger(detail?.toHostId);
    if (explicitFrom > 0 && explicitTo > 0) {
      edges.push([explicitFrom, explicitTo]);
      continue;
    }
    const labels = [detail?.hopLabel, detail?.routeLabel]
      .map((value) => String(value || ""))
      .filter(Boolean);
    for (const label of labels) {
      const match = label.match(/(\d+)\s*->\s*(\d+)/);
      const from = positiveInteger(match?.[1]);
      const to = positiveInteger(match?.[2]);
      if (from <= 0 || to <= 0) continue;
      edges.push([from, to]);
      break;
    }
  }
  return edges;
}

function uniqueHostIds(values: unknown[]) {
  return Array.from(new Set(values.map(positiveInteger).filter((value) => value > 0)));
}

/** Hosts that actively originate a tunnel latency probe for the current topology. */
export function tunnelLatencyProbeSourceHostIds(entryHostIds: number[], hops: any[]) {
  const hopRows = Array.isArray(hops) ? hops : [];
  return uniqueHostIds([
    ...(entryHostIds || []),
    ...(hopRows.length >= 3 ? hopRows.slice(1, -1).map((hop) => hop?.hostId) : []),
  ]);
}

export function tunnelDetailsMatchTopology(input: {
  tunnel: any;
  hops: any[];
  exitNodes?: any[];
  entryHostIds?: number[];
  details: any[];
}) {
  const { tunnel } = input;
  const details = tunnelDetailHostEdges(input.details);
  if (details.length === 0) return false;
  const hops = Array.isArray(input.hops) ? input.hops : [];
  const hopHostIds = hops.length >= 2
    ? uniqueHostIds(hops.map((hop) => hop?.hostId))
    : uniqueHostIds([tunnel?.entryHostId, tunnel?.exitHostId]);
  if (hopHostIds.length < 2) return false;
  const entryHostIds = uniqueHostIds([
    tunnel?.entryHostId,
    hopHostIds[0],
    ...(input.entryHostIds || []),
  ]);
  if (entryHostIds.length === 0) return false;
  const detailEdgeSet = new Set(details.map(([from, to]) => `${from}->${to}`));

  if (isTunnelRelayFailover(tunnel, hops)) {
    const relayHostIds = uniqueHostIds(tunnelRelayCandidates(hops).map((hop: any) => hop?.hostId));
    const primaryExitHostId = positiveInteger(hops[hops.length - 1]?.hostId);
    const extraExitHostIds = tunnel?.loadBalanceEnabled && exitGroupUsesMultipleExits(tunnel?.loadBalanceStrategy)
      ? uniqueHostIds((input.exitNodes || []).filter((node) => node?.isEnabled !== false && node?.isEnabled !== 0 && node?.isEnabled !== "0" && positiveInteger(node?.listenPort) > 0).map((node) => node?.hostId))
      : [];
    const exitHostIds = uniqueHostIds([primaryExitHostId, ...extraExitHostIds]);
    if (relayHostIds.length < 2 || !exitHostIds.length) return false;
    const allowedEdges = new Set<string>();
    for (const relayHostId of relayHostIds) {
      for (const entryHostId of entryHostIds) allowedEdges.add(`${entryHostId}->${relayHostId}`);
      for (const exitHostId of exitHostIds) allowedEdges.add(`${relayHostId}->${exitHostId}`);
    }
    if (!details.every(([from, to]) => allowedEdges.has(`${from}->${to}`))) return false;
    const usedRelays = relayHostIds.filter((relayHostId) => (
      exitHostIds.some((exitHostId) => detailEdgeSet.has(`${relayHostId}->${exitHostId}`))
      || entryHostIds.some((entryHostId) => detailEdgeSet.has(`${entryHostId}->${relayHostId}`))
    ));
    return usedRelays.length > 0 && usedRelays.every((relayHostId) => (
      exitHostIds.some((exitHostId) => detailEdgeSet.has(`${relayHostId}->${exitHostId}`))
      && entryHostIds.some((entryHostId) => detailEdgeSet.has(`${entryHostId}->${relayHostId}`))
    ));
  }

  const firstNextHostId = hopHostIds[1];
  const allowedEdges = new Set<string>();
  const requiredEdges = new Set<string>();
  const extraExitHostIds = tunnel?.loadBalanceEnabled && exitGroupUsesMultipleExits(tunnel?.loadBalanceStrategy)
    ? uniqueHostIds((input.exitNodes || []).filter((node) => node?.isEnabled !== false && node?.isEnabled !== 0 && node?.isEnabled !== "0" && positiveInteger(node?.listenPort) > 0).map((node) => node?.hostId))
    : [];
  const exitHostIds = uniqueHostIds([hopHostIds[hopHostIds.length - 1], ...extraExitHostIds]);
  for (const entryHostId of entryHostIds) {
    const edge = `${entryHostId}->${firstNextHostId}`;
    allowedEdges.add(edge);
    if (hopHostIds.length > 2 || !extraExitHostIds.length) requiredEdges.add(edge);
    if (hopHostIds.length === 2) for (const exitHostId of exitHostIds) allowedEdges.add(`${entryHostId}->${exitHostId}`);
  }
  for (let index = 1; index < hopHostIds.length - 1; index += 1) {
    const edge = `${hopHostIds[index]}->${hopHostIds[index + 1]}`;
    allowedEdges.add(edge);
    if (index < hopHostIds.length - 2 || !extraExitHostIds.length) requiredEdges.add(edge);
  }
  const lastSource = hopHostIds[hopHostIds.length - 2];
  if (hopHostIds.length > 2) for (const exitHostId of exitHostIds) allowedEdges.add(`${lastSource}->${exitHostId}`);
  const hasRequiredExit = !extraExitHostIds.length || (hopHostIds.length === 2
    ? entryHostIds.every((entry) => exitHostIds.some((exit) => detailEdgeSet.has(`${entry}->${exit}`)))
    : exitHostIds.some((exit) => detailEdgeSet.has(`${lastSource}->${exit}`)));
  return hasRequiredExit && details.every(([from, to]) => allowedEdges.has(`${from}->${to}`))
    && Array.from(requiredEdges).every((edge) => detailEdgeSet.has(edge));
}
