import { topologyPathEdgeIds } from "./networkTopologyPaths";

export type FocusPath = { id: string; nodeIds: string[] };

/** A shared physical leg previews every route using it; selection locks one route. */
export function topologyUsageCounts(paths: FocusPath[]) {
  const nodes = new Map<string, number>();
  const edges = new Map<string, number>();
  for (const path of paths) {
    for (const id of new Set(path.nodeIds)) nodes.set(id, (nodes.get(id) || 0) + 1);
    for (const id of new Set(topologyPathEdgeIds(path.nodeIds))) edges.set(id, (edges.get(id) || 0) + 1);
  }
  return { nodes, edges };
}

export function topologyFocus(paths: FocusPath[], focus: { nodeId?: string | null; edgeId?: string | null; pathId?: string | null }) {
  const matches = focus.nodeId
    ? paths.filter((path) => path.nodeIds.includes(focus.nodeId!))
    : focus.edgeId
      ? paths.filter((path) => topologyPathEdgeIds(path.nodeIds).includes(focus.edgeId!))
      : paths.filter((path) => path.id === focus.pathId);
  return {
    nodeIds: new Set(matches.flatMap((path) => path.nodeIds)),
    edgeIds: new Set(matches.flatMap((path) => topologyPathEdgeIds(path.nodeIds))),
    count: matches.length,
  };
}
