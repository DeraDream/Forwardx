export const MAX_TOPOLOGY_VARIANTS = 512;
export type TopologyExpansionState = { truncated: boolean; incomplete: boolean };

/** Join adjacent resource paths only at their shared boundary; never erase a loop. */
export function joinTopologyHostPaths(left: number[], right: number[]) {
  const suffix = left.length > 0 && right.length > 0 && left[left.length - 1] === right[0] ? right.slice(1) : right;
  const joined = [...left, ...suffix];
  return new Set(joined).size === joined.length ? joined : null;
}

export function combineTopologyHostVariants(left: number[][], right: number[][], state: TopologyExpansionState) {
  const combined: number[][] = [];
  const seen = new Set<string>();
  for (const prefix of left) for (const suffix of right) {
    const path = joinTopologyHostPaths(prefix, suffix);
    if (!path) { state.incomplete = true; continue; }
    const key = path.join(",");
    if (seen.has(key)) continue;
    if (combined.length >= MAX_TOPOLOGY_VARIANTS) { state.truncated = true; return combined; }
    seen.add(key); combined.push(path);
  }
  return combined;
}
