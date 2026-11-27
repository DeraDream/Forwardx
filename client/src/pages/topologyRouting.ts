export type TopologyRoutingNode = { id: string; column: number; row: number };
export type TopologyRoutingEdge = { id: string; from: string; to: string };
export type TopologyPoint = { x: number; y: number; curve?: boolean };
export type TopologyBox = { x: number; y: number; width: number; height: number };

/**
 * Orthogonal router retained for dense/minimap tests and fallback layouts.
 * Every edge gets a separate channel, so no segment enters a VPS card.
 */
export function routeTopologyGraph(nodes: TopologyRoutingNode[], inputEdges: TopologyRoutingEdge[], directOnly: Set<string>, cardSize?: { width: number; height: number }) {
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
  // Keep the relationship canvas dense enough for the dashboard while retaining
  // sufficient routing room around cards and arrow labels.
  const nodeWidth = cardSize?.width ?? 176, nodeHeight = Math.max(cardSize?.height ?? 56, (maxDegree + 1) * 8), laneStep = 8;
  const gapWidth = (column: number) => Math.max(50, 30 + ((sourceByGap.get(column)?.length || 0) + (targetByGap.get(column)?.length || 0)) * laneStep);
  const columnX = new Map<number, number>();
  columnX.set(0, 32 + gapWidth(-1));
  for (let column = 1; column <= maxColumn; column++) columnX.set(column, columnX.get(column - 1)! + nodeWidth + gapWidth(column - 1));
  const columns = new Map<number, TopologyRoutingNode[]>();
  for (const node of nodes) add(columns, node.column, node);
  for (const list of columns.values()) list.sort((a, b) => a.row - b.row);
  const rowGap = nodeHeight + 18;
  // Rows are branch lanes assigned by the layout. Do not re-center individual
  // columns or replace them with local array indexes: that would collapse a
  // referenced service branch back onto the direct-service branch.
  const maxRow = Math.max(0, ...nodes.map((node) => node.row));
  const maxSpan = nodeHeight + maxRow * rowGap + 34;
  const cardTop = 70 + edges.length * laneStep;
  const centerY = cardTop + maxSpan / 2;
  const positions = new Map<string, TopologyBox>();
  for (const [column, list] of columns) {
    for (const node of list) {
      positions.set(node.id, { x: columnX.get(column)!, y: cardTop + node.row * rowGap, width: nodeWidth, height: nodeHeight });
    }
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

function stableNumber(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0) / 0xffffffff;
}

/** A deterministic force layout for the VPS relationship canvas. */
export function routeNaturalTopologyGraph(nodes: TopologyRoutingNode[], inputEdges: TopologyRoutingEdge[]) {
  const edges = inputEdges.filter((edge) => edge.from !== edge.to && nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to));
  const count = Math.max(1, nodes.length);
  const width = Math.max(960, Math.min(1720, 620 + count * 105));
  const height = Math.max(600, Math.min(1060, 420 + count * 58));
  const cardWidth = 176, cardHeight = 58, padding = 90;
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) { degree.set(edge.from, (degree.get(edge.from) || 0) + 1); degree.set(edge.to, (degree.get(edge.to) || 0) + 1); }
  const points = new Map<string, { x: number; y: number }>();
  const center = { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) * 0.32;
  nodes.forEach((node, index) => {
    const angle = Math.PI * 2 * ((index / count) + stableNumber(node.id) * 0.18);
    const nodeRadius = Math.max(110, radius - (degree.get(node.id) || 0) * 18);
    points.set(node.id, { x: center.x + Math.cos(angle) * nodeRadius, y: center.y + Math.sin(angle) * nodeRadius });
  });
  for (let step = 0; step < 180; step += 1) {
    const force = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let a = 0; a < nodes.length; a += 1) for (let b = a + 1; b < nodes.length; b += 1) {
      const pa = points.get(nodes[a].id)!, pb = points.get(nodes[b].id)!;
      const dx = pa.x - pb.x, dy = pa.y - pb.y, distance = Math.max(1, Math.hypot(dx, dy));
      const strength = 42000 / (distance * distance);
      force.get(nodes[a].id)!.x += dx / distance * strength; force.get(nodes[a].id)!.y += dy / distance * strength;
      force.get(nodes[b].id)!.x -= dx / distance * strength; force.get(nodes[b].id)!.y -= dy / distance * strength;
    }
    for (const edge of edges) {
      const from = points.get(edge.from)!, to = points.get(edge.to)!;
      const dx = to.x - from.x, dy = to.y - from.y, distance = Math.max(1, Math.hypot(dx, dy));
      const strength = (distance - 235) * 0.018;
      force.get(edge.from)!.x += dx / distance * strength; force.get(edge.from)!.y += dy / distance * strength;
      force.get(edge.to)!.x -= dx / distance * strength; force.get(edge.to)!.y -= dy / distance * strength;
    }
    for (const node of nodes) {
      const point = points.get(node.id)!, next = force.get(node.id)!;
      next.x += (center.x - point.x) * 0.008; next.y += (center.y - point.y) * 0.008;
      point.x = Math.max(padding + cardWidth / 2, Math.min(width - padding - cardWidth / 2, point.x + Math.max(-18, Math.min(18, next.x))));
      point.y = Math.max(padding + cardHeight / 2, Math.min(height - padding - cardHeight / 2, point.y + Math.max(-18, Math.min(18, next.y))));
    }
    // Card collision resolution keeps labels readable even for hub-heavy graphs.
    for (let a = 0; a < nodes.length; a += 1) for (let b = a + 1; b < nodes.length; b += 1) {
      const pa = points.get(nodes[a].id)!, pb = points.get(nodes[b].id)!;
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      const overlapX = cardWidth + 28 - Math.abs(dx), overlapY = cardHeight + 28 - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      if (overlapX < overlapY) {
        const move = overlapX / 2 * (dx >= 0 ? 1 : -1); pa.x += move; pb.x -= move;
      } else {
        const move = overlapY / 2 * (dy >= 0 ? 1 : -1); pa.y += move; pb.y -= move;
      }
    }
  }
  const positions = new Map<string, TopologyBox>();
  for (const node of nodes) {
    const point = points.get(node.id)!;
    positions.set(node.id, { x: point.x - cardWidth / 2, y: point.y - cardHeight / 2, width: cardWidth, height: cardHeight });
  }
  const edgeRoutes = new Map<string, TopologyPoint[]>();
  const edgeAnchor = (box: TopologyBox, target: { x: number; y: number }) => {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const dx = target.x - cx, dy = target.y - cy;
    const scale = 1 / Math.max(Math.abs(dx) / (box.width / 2), Math.abs(dy) / (box.height / 2), 1);
    return { x: cx + dx * scale, y: cy + dy * scale };
  };
  for (const edge of edges) {
    const from = positions.get(edge.from)!, to = positions.get(edge.to)!;
    const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const dx = toCenter.x - fromCenter.x, dy = toCenter.y - fromCenter.y, distance = Math.max(1, Math.hypot(dx, dy));
    const start = edgeAnchor(from, toCenter), end = edgeAnchor(to, fromCenter);
    const bend = (stableNumber(edge.id) - 0.5) * Math.min(88, Math.max(24, distance * 0.22));
    const px = -dy / distance * bend, py = dx / distance * bend;
    edgeRoutes.set(edge.id, [
      start,
      { x: start.x + dx * 0.34 + px, y: start.y + dy * 0.34 + py, curve: true },
      { x: end.x - dx * 0.34 + px, y: end.y - dy * 0.34 + py, curve: true },
      end,
    ]);
  }
  return { positions, edgeRoutes, width, height, centerY: height / 2 };
}

/**
 * Layered relationship view: retain the deterministic entry → relay → landing
 * placement, but draw each physical edge as a Bézier lane rather than as a
 * right-angle circuit. Long direct-to-landing edges reserve an outside lane,
 * so they pass below the relay layer instead of through its cards.
 */
export function routeSmoothLayeredTopologyGraph(nodes: TopologyRoutingNode[], inputEdges: TopologyRoutingEdge[], directOnly: Set<string>, cardSize?: { width: number; height: number }) {
  if (!nodes.length) return {
    positions: new Map<string, TopologyBox>(), edgeRoutes: new Map<string, TopologyPoint[]>(),
    columnX: new Map<number, number>(), width: 820, height: 440, centerY: 220,
  };
  const base = routeTopologyGraph(nodes, inputEdges, directOnly, cardSize);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Give an early direct exit enough room to fan out below the relay row,
  // rather than dropping two parallel lines vertically beside the source.
  const directSourceColumns = [...new Set(inputEdges
    .filter((edge) => directOnly.has(edge.to) && (byId.get(edge.to)?.column || 0) - (byId.get(edge.from)?.column || 0) > 1)
    .map((edge) => byId.get(edge.from)!.column))].sort((a, b) => a - b);
  for (const [id, box] of base.positions) {
    box.x += directSourceColumns.filter((column) => byId.get(id)!.column > column).length * 120;
  }
  // Keep all relay stages centered on the forwarded landing group.  The
  // landing column has one continuous upper block for chain destinations and
  // a separate lower block for direct destinations.
  const groups = new Map<number, TopologyRoutingNode[]>();
  for (const node of nodes) groups.set(node.column, [...(groups.get(node.column) || []), node]);
  const landingColumn = Math.max(...groups.keys());
  const landingNodes = (groups.get(landingColumn) || []).sort((a, b) =>
    Number(directOnly.has(a.id)) - Number(directOnly.has(b.id)) || a.row - b.row);
  const mainCount = landingNodes.filter((node) => !directOnly.has(node.id)).length;
  const step = Math.max(...[...base.positions.values()].map((box) => box.height)) + 18;
  const anchor = Math.min(...[...base.positions.values()].map((box) => box.y)) + Math.max(0, mainCount - 1) * step / 2;
  for (const [column, group] of groups) {
    const ordered = column === landingColumn ? landingNodes : group.sort((a, b) => a.row - b.row);
    const mainLength = column === landingColumn ? mainCount : ordered.length;
    const start = anchor - Math.max(0, mainLength - 1) * step / 2;
    ordered.forEach((node, index) => {
      const box = base.positions.get(node.id);
      if (box) box.y = start + index * step;
    });
  }
  const outgoing = new Map<string, TopologyRoutingEdge[]>();
  const incoming = new Map<string, TopologyRoutingEdge[]>();
  for (const edge of inputEdges) {
    if (!base.positions.has(edge.from) || !base.positions.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge]);
  }
  // Match the vertical order of forwarded destinations to their actual relay
  // sources. SG-only landings stay together above JP-only landings; a landing
  // shared by both is placed between them. Direct landings remain at the end.
  const parentY = (node: TopologyRoutingNode) => {
    const parents = (incoming.get(node.id) || []).map((edge) => base.positions.get(edge.from)!)
      .filter(Boolean);
    return parents.length
      ? parents.reduce((sum, box) => sum + box.y + box.height / 2, 0) / parents.length
      : base.positions.get(node.id)!.y;
  };
  landingNodes.sort((a, b) => Number(directOnly.has(a.id)) - Number(directOnly.has(b.id))
    || parentY(a) - parentY(b) || a.row - b.row || a.id.localeCompare(b.id));
  const landingStart = anchor - Math.max(0, mainCount - 1) * step / 2;
  landingNodes.forEach((node, index) => { base.positions.get(node.id)!.y = landingStart + index * step; });
  const centerY = (id: string) => { const box = base.positions.get(id)!; return box.y + box.height / 2; };
  for (const list of outgoing.values()) list.sort((a, b) => centerY(a.to) - centerY(b.to) || a.id.localeCompare(b.id));
  for (const list of incoming.values()) list.sort((a, b) => centerY(a.from) - centerY(b.from) || a.id.localeCompare(b.id));
  const top = Math.min(...[...base.positions.values()].map((box) => box.y));

  const edgeRoutes = new Map<string, TopologyPoint[]>();
  [...base.edgeRoutes.keys()].sort().forEach((edgeId) => {
    const edge = inputEdges.find((candidate) => candidate.id === edgeId)!;
    const from = base.positions.get(edge.from)!;
    const to = base.positions.get(edge.to)!;
    const fromEdges = outgoing.get(edge.from) || [];
    const toEdges = incoming.get(edge.to) || [];
    const isDirectLanding = directOnly.has(edge.to);
    const sourceColumn = byId.get(edge.from)?.column || 0;
    const targetColumn = byId.get(edge.to)?.column || sourceColumn + 1;
    const spansRelayLayer = targetColumn - sourceColumn > 1;
    const directFromEdges = fromEdges.filter((candidate) => directOnly.has(candidate.to)
      && (byId.get(candidate.to)?.column || 0) - sourceColumn > 1);
    const directRank = directFromEdges.indexOf(edge);
    // Match source-port order to destination order: upper exits start above
    // lower exits, so their curves cannot swap places near the source card.
    const start = { x: from.x + from.width, y: from.y + from.height * (directRank >= 0
      ? 0.45 + 0.5 * (directRank + 1) / (directFromEdges.length + 1)
      : (fromEdges.indexOf(edge) + 1) / (fromEdges.length + 1)) };
    const end = { x: to.x, y: to.y + to.height * (toEdges.indexOf(edge) + 1) / (toEdges.length + 1) };
    const distance = Math.max(80, end.x - start.x);
    // Direct landings are already below forwarded landings. One long, shallow
    // cubic reaches each target without a hairpin or a shared horizontal bus.
    const rise = Math.max(0, end.y - start.y);
    edgeRoutes.set(edge.id, isDirectLanding && spansRelayLayer ? [
      start,
      { x: start.x + distance * .22, y: start.y + rise * .36, curve: true },
      { x: end.x - distance * .3, y: end.y - rise * .20, curve: true },
      end,
    ] : [
      start,
      { x: start.x + distance * 0.34, y: start.y, curve: true },
      { x: end.x - distance * 0.34, y: end.y, curve: true },
      end,
    ]);
  });
  // Overlaps between edges are fine; an edge crossing an unrelated VPS card is
  // not. Check the final Bezier geometry (rather than just its control points)
  // and send exceptional edges through an outside lane between card columns.
  const cards = [...base.positions.entries()];
  const inside = (x: number, y: number, box: TopologyBox) =>
    x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height;
  const hitsCard = (edge: TopologyRoutingEdge, points: TopologyPoint[]) => cards.some(([id, box]) => {
    if (id === edge.from || id === edge.to) return false;
    for (let segment = 1; segment < points.length; segment++) {
      const a = points[segment - 1], b = points[segment];
      const curve = points.length === 4 && !!points[1].curve;
      const length = curve
        ? points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0)
        : Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(16, Math.ceil(length / 6));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const x = curve
          ? (1 - t) ** 3 * points[0].x + 3 * (1 - t) ** 2 * t * points[1].x + 3 * (1 - t) * t * t * points[2].x + t ** 3 * points[3].x
          : a.x + (b.x - a.x) * t;
        const y = curve
          ? (1 - t) ** 3 * points[0].y + 3 * (1 - t) ** 2 * t * points[1].y + 3 * (1 - t) * t * t * points[2].y + t ** 3 * points[3].y
          : a.y + (b.y - a.y) * t;
        if (inside(x, y, box)) return true;
      }
      if (curve) break;
    }
    return false;
  });
  // A long link should not automatically arc above the entire graph. Try the
  // shallow curve first, then the shorter of the clear routes around cards in
  // the columns it actually crosses. Edges may overlap; cards may not.
  for (const edge of inputEdges) {
    const original = edgeRoutes.get(edge.id);
    const from = base.positions.get(edge.from), to = base.positions.get(edge.to);
    if (!original || !from || !to || directOnly.has(edge.to)
      || (byId.get(edge.to)?.column || 0) - (byId.get(edge.from)?.column || 0) <= 1
      || !hitsCard(edge, original)) continue;
    const obstacles = cards.filter(([id, box]) => id !== edge.from && id !== edge.to
      && box.x < to.x && box.x + box.width > from.x + from.width).map(([, box]) => box);
    if (!obstacles.length) continue;
    const start = original[0], end = original[3];
    const distance = Math.max(80, end.x - start.x);
    const upper = Math.min(...obstacles.map((box) => box.y)) - 24;
    const lower = Math.max(...obstacles.map((box) => box.y + box.height)) + 24;
    const options: Array<{ points: TopologyPoint[]; cost: number }> = [];
    for (const boundary of [upper, lower]) for (let offset = 0; offset < 8; offset++) {
      const lane = boundary + (boundary === upper ? -offset : offset) * 24;
      const candidate = [start,
        { x: start.x + distance * .34, y: lane, curve: true },
        { x: end.x - distance * .34, y: lane, curve: true }, end];
      if (hitsCard(edge, candidate)) continue;
      options.push({ points: candidate, cost: Math.abs(lane - start.y) + Math.abs(lane - end.y) });
      break;
    }
    options.sort((a, b) => a.cost - b.cost || a.points[1].y - b.points[1].y);
    if (options[0]) edgeRoutes.set(edge.id, options[0].points);
  }
  let detourIndex = 0;
  for (const edge of inputEdges) {
    const original = edgeRoutes.get(edge.id);
    if (!original || !hitsCard(edge, original)) continue;
    const from = base.positions.get(edge.from)!, to = base.positions.get(edge.to)!;
    const start = original[0], end = original[original.length - 1];
    const upper = Math.min(...cards.map(([, box]) => box.y)) - 32 - detourIndex * 16;
    const lower = Math.max(...cards.map(([, box]) => box.y + box.height)) + 32 + detourIndex * 16;
    const lanes = start.y > end.y ? [lower, upper] : [upper, lower];
    for (const lane of lanes) {
      const detour = [start, { x: from.x + from.width + 12, y: start.y },
        { x: from.x + from.width + 12, y: lane }, { x: to.x - 12, y: lane },
        { x: to.x - 12, y: end.y }, end];
      if (!hitsCard(edge, detour)) { edgeRoutes.set(edge.id, detour); detourIndex++; break; }
    }
  }
  // Crop the old orthogonal router's unused overhead and side margins.
  const points = [...edgeRoutes.values()].flat();
  const boxes = [...base.positions.values()];
  const left = Math.min(0, ...points.map(p => p.x), ...boxes.map(b => b.x));
  const minY = Math.min(...points.map(p => p.y), ...boxes.map(b => b.y), top);
  const shiftY = Number.isFinite(minY) ? 32 - minY : 0;
  for (const box of boxes) box.y += shiftY;
  for (const point of points) point.y += shiftY;
  const width = Math.max(320, ...boxes.map(b => b.x + b.width + 32), ...points.map(p => p.x + 32)) - left;
  const height = Math.max(240, ...boxes.map(b => b.y + b.height + 32), ...points.map(p => p.y + 32));
  return { ...base, edgeRoutes, width, height, centerY: height / 2 };
}

export function topologyRoutePath(points: TopologyPoint[]) {
  if (points.length === 4 && points[1]?.curve && points[2]?.curve) {
    return `M ${points[0].x} ${points[0].y} C ${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y} ${points[3].x} ${points[3].y}`;
  }
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
    const before = toward(current, previous, radius), after = toward(current, next, radius);
    path += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}
