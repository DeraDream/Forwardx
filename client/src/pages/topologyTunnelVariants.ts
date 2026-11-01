import { MAX_TOPOLOGY_VARIANTS, type TopologyExpansionState } from "./topologyExpansion";
import { getTunnelHopIds } from "../lib/tunnelDisplay";
import { exitGroupUsesMultipleExits } from "@shared/exitStrategy";
import { isTunnelRelayFailover } from "@shared/tunnelRelay";

export function topologyEnabledFlag(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || (typeof value === "string" && ["1", "true"].includes(value.trim().toLowerCase()));
}

export function visibleTopologyTunnelVariants(tunnel: any, entryGroup: any, state: TopologyExpansionState) {
  const hops = getTunnelHopIds(tunnel);
  if (hops.length < 2) { state.incomplete = true; return []; }
  if (Number(tunnel?.entryGroupId || 0) > 0 && !Array.isArray(entryGroup?.members)) state.incomplete = true;
  const entries = (Array.isArray(entryGroup?.members) ? entryGroup.members : [])
    .filter((member: any) => topologyEnabledFlag(member?.isEnabled, true) && String(member?.memberType || "host") === "host")
    .map((member: any) => Number(member.hostId || 0));
  if (Number(tunnel?.entryGroupId || 0) > 0 && !entries.some((id: number) => id > 0)) state.incomplete = true;
  const exits = [Number(hops[hops.length - 1] || 0)];
  if (topologyEnabledFlag(tunnel?.loadBalanceEnabled) && exitGroupUsesMultipleExits(tunnel?.loadBalanceStrategy)) {
    for (const exit of Array.isArray(tunnel?.loadBalanceExits) ? tunnel.loadBalanceExits : []) {
      if (topologyEnabledFlag(exit?.isEnabled, true)) exits.push(Number(exit.hostId || 0));
    }
    if (!exits.slice(1).some((id) => id > 0)) state.incomplete = true;
  }
  const hopObjects = hops.map((hostId: number) => ({ hostId }));
  return topologyTunnelVariants({ hops, entries, exits, relayFailover: isTunnelRelayFailover(tunnel, hopObjects), state });
}

export function topologyTunnelVariants(input: { hops: number[]; entries?: number[]; exits?: number[]; relayFailover?: boolean; state?: TopologyExpansionState }) {
  const unique = (items: number[]) => [...new Set(items.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const hops = input.hops.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (new Set(hops).size !== hops.length) { if (input.state) input.state.incomplete = true; return []; }
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
    if (new Set(ids).size !== ids.length) { if (input.state) input.state.incomplete = true; continue; }
    if (result.length >= MAX_TOPOLOGY_VARIANTS) { if (input.state) input.state.truncated = true; return result; }
    result.push(ids);
  }
  return result;
}
