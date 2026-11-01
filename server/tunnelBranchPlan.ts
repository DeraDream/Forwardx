import { TUNNEL_ENTRY_BRANCH_GROUP, TUNNEL_EXIT_BRANCH_GROUP } from "./tunnelBranchLatency";
import { isTunnelRelayFailover } from "../shared/tunnelRelay";
import { exitGroupUsesMultipleExits } from "../shared/exitStrategy";

function multiHopExitEndpoints(tunnel: any, hops: any[], exitNodes: any[]) {
  const enabled = tunnel?.loadBalanceEnabled === true || tunnel?.loadBalanceEnabled === 1 || tunnel?.loadBalanceEnabled === "1" || tunnel?.loadBalanceEnabled === "true";
  if (!enabled || !exitGroupUsesMultipleExits(tunnel?.loadBalanceStrategy) || !Array.isArray(hops) || hops.length < 3) return [];
  const extras = [...(exitNodes || [])].filter((node) => node?.isEnabled !== false && node?.isEnabled !== 0 && node?.isEnabled !== "0" && node?.isEnabled !== "false" && Number(node?.hostId) > 0 && Number(node?.listenPort) > 0)
    .sort((a, b) => Number(a?.seq || 0) - Number(b?.seq || 0));
  return extras.length ? [hops[hops.length - 1], ...extras] : [];
}

export function branchedTunnelExitEndpoints(tunnel: any, hops: any[], exitNodes: any[]) {
  return isTunnelRelayFailover(tunnel, hops) ? [] : multiHopExitEndpoints(tunnel, hops, exitNodes);
}

export function relayBranchedTunnelExitEndpoints(tunnel: any, hops: any[], exitNodes: any[]) {
  return isTunnelRelayFailover(tunnel, hops) ? multiHopExitEndpoints(tunnel, hops, exitNodes) : [];
}

export function branchedAutoPathKey(tunnel: any, hops: any[], exits: any[], seriesKey: string) {
  const endpoints = branchedTunnelExitEndpoints(tunnel, hops, exits);
  if (!endpoints.length) return null;
  const match = String(seriesKey || "").match(/^exit-(\d+)$/);
  const index = seriesKey === "primary" ? 0 : match ? Number(match[1]) - 1 : -1;
  const hostId = Number(endpoints[index]?.hostId || 0);
  return hostId > 0 ? `branch-exit-${hostId}` : null;
}

const MAX_MANUAL_BRANCH_PROBES = 256;

export type BranchPlanEndpoint = { hostId: number; address: string; port: number; name: string };
export type BranchProbePlan = { fromHostId: number; target: BranchPlanEndpoint; hopLabel: string; routeLabel: string; groupKey?: string; groupLabel?: string };

export function planDirectTunnelBranchProbes(entries: Array<{ hostId: number; name: string }>, exits: BranchPlanEndpoint[]): BranchProbePlan[] {
  if (!entries.length || !exits.length || entries.some((entry) => !Number.isInteger(entry.hostId) || entry.hostId <= 0) || exits.some((exit) => !Number.isInteger(exit.hostId) || exit.hostId <= 0 || !exit.address || !Number.isInteger(exit.port) || exit.port <= 0 || exit.port > 65535)) throw new Error("多入口多出口拓扑的地址或端口无效");
  if (entries.length * exits.length > MAX_MANUAL_BRANCH_PROBES) throw new Error(`候选路径过多，单次最多探测 ${MAX_MANUAL_BRANCH_PROBES} 段`);
  return exits.flatMap((exit, exitIndex) => entries.map((entry, entryIndex) => ({
    fromHostId: entry.hostId, target: exit,
    hopLabel: `入口 ${entryIndex + 1}/${entries.length} 出口 ${exitIndex + 1}/${exits.length} ${entry.hostId}->${exit.hostId}`,
    routeLabel: `${entry.name} -> ${exit.name}`,
    groupKey: TUNNEL_EXIT_BRANCH_GROUP,
    groupLabel: `出口 ${exitIndex + 1} ${exit.name}`,
  })));
}

export function planRelayTunnelBranchProbes(entries: Array<{ hostId: number; name: string }>, relays: BranchPlanEndpoint[], exits: BranchPlanEndpoint[]): BranchProbePlan[] {
  if (!entries.length || relays.length < 2 || !exits.length || entries.some((entry) => !Number.isInteger(entry.hostId) || entry.hostId <= 0) || [...relays, ...exits].some((endpoint) => !Number.isInteger(endpoint.hostId) || endpoint.hostId <= 0 || !endpoint.address || !Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535)) throw new Error("中转主备多出口拓扑的地址或端口无效");
  if (relays.length * (entries.length + exits.length) > MAX_MANUAL_BRANCH_PROBES) throw new Error(`候选路径过多，单次最多探测 ${MAX_MANUAL_BRANCH_PROBES} 段`);
  const result: BranchProbePlan[] = [];
  for (const relay of relays) {
    for (const entry of entries) result.push({ fromHostId: entry.hostId, target: relay, hopLabel: `中转入口 ${entry.hostId}->${relay.hostId}`, routeLabel: `${entry.name} -> ${relay.name}`, groupKey: `relay-entry-${relay.hostId}`, groupLabel: `中转 ${relay.name}` });
    for (const exit of exits) result.push({ fromHostId: relay.hostId, target: exit, hopLabel: `中转出口 ${relay.hostId}->${exit.hostId}`, routeLabel: `${relay.name} -> ${exit.name}`, groupKey: `relay-exit-${relay.hostId}-${exit.hostId}`, groupLabel: exit.name });
  }
  return result;
}

/** Build a normal serial multi-hop topology: parallel entries, shared hops, parallel exits. */
export function planTunnelBranchProbes(entries: Array<{ hostId: number; name: string }>, hops: BranchPlanEndpoint[], exits: BranchPlanEndpoint[]): BranchProbePlan[] {
  if (!entries.length || hops.length < 3 || !exits.length) throw new Error("多出口逐跳拓扑不完整");
  const validEndpoint = (endpoint: BranchPlanEndpoint) => Number.isInteger(endpoint.hostId) && endpoint.hostId > 0 && !!endpoint.address && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535;
  if (entries.some((entry) => !Number.isInteger(entry.hostId) || entry.hostId <= 0) || hops.some((hop, index) => index > 0 && !validEndpoint(hop)) || exits.some((exit) => !validEndpoint(exit))) throw new Error("多出口逐跳测试的地址或端口无效");
  if (entries.length + Math.max(0, hops.length - 3) + exits.length > MAX_MANUAL_BRANCH_PROBES) throw new Error(`候选路径过多，单次最多探测 ${MAX_MANUAL_BRANCH_PROBES} 段`);
  const result: BranchProbePlan[] = [];
  for (const [index, entry] of entries.entries()) {
    result.push({ fromHostId: entry.hostId, target: hops[1], hopLabel: `入口 ${index + 1}/${entries.length} ${entry.hostId}->${hops[1].hostId}`, routeLabel: `${entry.name} -> ${hops[1].name}`, groupKey: TUNNEL_ENTRY_BRANCH_GROUP, groupLabel: "入口分支" });
  }
  for (let index = 1; index < hops.length - 2; index += 1) {
    result.push({ fromHostId: hops[index].hostId, target: hops[index + 1], hopLabel: `${index + 1}/${hops.length - 1} ${hops[index].hostId}->${hops[index + 1].hostId}`, routeLabel: `${hops[index].name} -> ${hops[index + 1].name}` });
  }
  const lastRelay = hops[hops.length - 2];
  for (const [index, exit] of exits.entries()) {
    result.push({ fromHostId: lastRelay.hostId, target: exit, hopLabel: `出口 ${index + 1}/${exits.length} ${lastRelay.hostId}->${exit.hostId}`, routeLabel: `${lastRelay.name} -> ${exit.name}`, groupKey: TUNNEL_EXIT_BRANCH_GROUP, groupLabel: "出口分支" });
  }
  return result;
}
