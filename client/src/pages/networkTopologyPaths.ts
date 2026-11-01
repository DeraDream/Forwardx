/** Edge IDs follow the same ordering and encoding as the topology graph. */
export function topologyPathEdgeIds(nodeIds: string[]): string[] {
  const edges: string[] = [];
  for (let index = 0; index < nodeIds.length - 1; index += 1) {
    const from = nodeIds[index];
    const to = nodeIds[index + 1];
    if (from && to && from !== to) edges.push(`${from}=>${to}`);
  }
  return edges;
}
