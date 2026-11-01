export function topologyTunnelVariants(input: { hops: number[]; entries?: number[]; exits?: number[]; relayFailover?: boolean }) {
  const unique = (items: number[]) => [...new Set(items.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const hops = input.hops.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (new Set(hops).size !== hops.length) return [];
  if (hops.length < 2) return hops.length ? [hops] : [];
  const entries = unique(input.entries || []);
  const exits = unique(input.exits || []);
  const sources = entries.length ? entries : [hops[0]];
  const destinations = exits.length ? exits : [hops[hops.length - 1]];
  const relays = hops.slice(1, -1);
  const relayPaths = input.relayFailover && relays.length >= 2 ? relays.map((relay) => [relay]) : [relays];
  const result: number[][] = [];
  for (const entry of sources) for (const via of relayPaths) for (const exit of destinations) {
    const ids = [entry, ...via, exit];
    // Do not manufacture new edges by removing an intermediate loop.
    if (new Set(ids).size !== ids.length) continue;
    result.push(ids);
  }
  return result;
}
