export type TopologyRoutingNode = { id: string; column: number; row: number };
export type TopologyRoutingEdge = { id: string; from: string; to: string };
export type TopologyPoint = { x: number; y: number };
export type TopologyBox = { x: number; y: number; width: number; height: number };

/**
 * Routes every edge through dedicated channels above and between cards. The
 * resulting polyline is rendered with rounded corners so links bend around VPS
 * cards instead of cutting through them.
 */
export function routeTopologyGraph(nodes: TopologyRoutingNode[], inputEdges: TopologyRoutingEdge[], directOnly: Set<string>) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = inputEdges.filter((edge) => edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to))
    .slice().sort((a, b) => a.id.localeCompare(b.id));
  const maxColumn = Math.max(1, ...nodes.map((node) => node.column));
  const outgoing = new Map<string, TopologyRoutingEdge[]>(), incoming = new Map<string, TopologyRoutingEdge[]>();
  const sourceByGap = new Map<number, TopologyRoutingEdge[]>(), targetByGap = new Map<number, TopologyRoutingEdge[]>();
  const add = <T>(map: Map<string, T[]> | Map<number, T[]>, key: any, value: T) => {
    const typed = map as Map<any, T[]>; const values = typed.get(key) || []; values.push(value); typed.set(key, values);
  };
  for (const edge of edges) {
    add(outgoing, edge.from, edge); add(incoming, edge.to, edge);
    add(sourceByGap, byId.get(edge.from)!.column, edge);
    add(targetByGap, byId.get(edge.to)!.column - 1, edge);
  }
  const maxDegree = Math.max(1, ...nodes.map((node) => Math.max(outgoing.get(node.id)?.length || 0, incoming.get(node.id)?.length || 0)));
  const nodeWidth = 188, nodeHeight = Math.max(58, (maxDegree + 1) * 8), laneStep = 10;
  const gapWidth = (column: number) => Math.max(50, 30 + ((sourceByGap.get(column)?.length || 0) + (targetByGap.get(column)?.length || 0)) * laneStep);
  const columnX = new Map<number, number>();
  columnX.set(0, 32 + gapWidth(-1));
  for (let column = 1; column <= maxColumn; column++) columnX.set(column, columnX.get(column - 1)! + nodeWidth + gapWidth(column - 1));
  const columns = new Map<number, TopologyRoutingNode[]>();
  for (const node of nodes) add(columns, node.column, node);
  for (const list of columns.values()) list.sort((a, b) => a.row - b.row);
  const rowGap = nodeHeight + 28;
  const maxRows = Math.max(1, ...[...columns.values()].map((list) => list.length));
  const maxSpan = nodeHeight + (maxRows - 1) * rowGap + 34;
  const cardTop = 70 + edges.length * laneStep;
  const centerY = cardTop + maxSpan / 2;
  const positions = new Map<string, TopologyBox>();
  for (const [column, list] of columns) {
    const directCount = list.filter((node) => directOnly.has(node.id)).length;
    const extraGap = directCount > 0 && directCount < list.length ? 34 : 0;
    const span = nodeHeight + Math.max(0, list.length - 1) * rowGap + extraGap;
    const start = centerY - span / 2;
    let directReached = false;
    list.forEach((node, row) => {
      if (directOnly.has(node.id)) directReached = true;
      positions.set(node.id, { x: columnX.get(column)!, y: start + row * rowGap + (directReached ? extraGap : 0), width: nodeWidth, height: nodeHeight });
    });
  }
  const edgeRoutes = new Map<string, TopologyPoint[]>();
  edges.forEach((edge, index) => {
    const from = positions.get(edge.from)!, to = positions.get(edge.to)!;
    const sourceColumn = byId.get(edge.from)!.column, targetGap = byId.get(edge.to)!.column - 1;
    const fromEdges = outgoing.get(edge.from)!, toEdges = incoming.get(edge.to)!;
    const sourceY = from.y + from.height * (fromEdges.indexOf(edge) + 1) / (fromEdges.length + 1);
    const targetY = to.y + to.height * (toEdges.indexOf(edge) + 1) / (toEdges.length + 1);
    const sourceX = from.x + from.width + 12 + sourceByGap.get(sourceColumn)!.indexOf(edge) * laneStep;
    const targetX = to.x - 12 - targetByGap.get(targetGap)!.indexOf(edge) * laneStep;
    const routeY = 54 + index * laneStep;
    edgeRoutes.set(edge.id, [
      { x: from.x + from.width, y: sourceY }, { x: sourceX, y: sourceY },
      { x: sourceX, y: routeY }, { x: targetX, y: routeY },
      { x: targetX, y: targetY }, { x: to.x, y: targetY },
    ]);
  });
  const width = Math.max(820, columnX.get(maxColumn)! + nodeWidth + gapWidth(maxColumn) + 32);
  const height = Math.max(440, cardTop + maxSpan + 34);
  return { positions, edgeRoutes, columnX, width, height, centerY };
}

export function topologyRoutePath(points: TopologyPoint[]) {
  if (points.length < 3) return points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  const distance = (a: TopologyPoint, b: TopologyPoint) => Math.hypot(b.x - a.x, b.y - a.y);
  const toward = (from: TopologyPoint, to: TopologyPoint, amount: number) => {
    const length = distance(from, to) || 1;
    return { x: from.x + (to.x - from.x) * amount / length, y: from.y + (to.y - from.y) * amount / length };
  };
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1], current = points[index], next = points[index + 1];
    const radius = Math.min(16, distance(previous, current) / 2, distance(current, next) / 2);
    const before = toward(current, previous, radius);
    const after = toward(current, next, radius);
    path += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}
