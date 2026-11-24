type LayoutNode = { id: string; label: string; column: number; row: number };
type LayoutEdge = { from: string; to: string; id?: string };

/**
 * Select the forward edges used to assign layered columns. A service reference
 * can make the physical graph cyclic; feeding its back edge into longest-path
 * relaxation pushes every member of that cycle to the artificial depth cap.
 * The omitted edge is still rendered, it just does not advance a column.
 */
export function acyclicTopologyLayerEdges<T extends LayoutEdge>(nodeIds: Iterable<string>, edges: T[]) {
  const outgoing = new Map<string, T[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) || [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  for (const list of outgoing.values()) list.sort((a, b) => String(a.id || `${a.from}=>${a.to}`).localeCompare(String(b.id || `${b.from}=>${b.to}`)));
  const state = new Map<string, 0 | 1 | 2>();
  const forward = new Set<T>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const edge of outgoing.get(id) || []) {
      // A DFS back edge closes a real dependency cycle. Keep it visible, but
      // never use it for depth calculation.
      if (state.get(edge.to) === 1) continue;
      forward.add(edge);
      if (!state.get(edge.to)) visit(edge.to);
    }
    state.set(id, 2);
  };
  for (const id of [...nodeIds].sort((a, b) => a.localeCompare(b))) if (!state.get(id)) visit(id);
  return forward;
}

/**
 * Give each fork its own horizontal lane. A node remains unique; only the
 * row assigned to a non-primary branch changes until that branch converges.
 */
export function assignTopologyBranchRows<T extends LayoutNode>(columns: Map<number, T[]>, edges: LayoutEdge[], rootIds: Set<string>, directOnlyIds: Set<string>) {
  const byId = new Map([...columns.values()].flat().map((node) => [node.id, node]));
  const incoming = new Map<string, LayoutEdge[]>(), outgoing = new Map<string, LayoutEdge[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge]);
  }
  // The furthest non-direct continuation is the visual spine. Every other
  // continuation receives a separate lane instead of being squeezed into it.
  const primaryOut = new Map<string, LayoutEdge>();
  for (const [id, list] of outgoing) {
    const candidates = list.filter((edge) => !directOnlyIds.has(edge.to));
    const chosen = (candidates.length ? candidates : list).slice().sort((a, b) => {
      const aNode = byId.get(a.to)!, bNode = byId.get(b.to)!;
      return bNode.column - aNode.column
        || (outgoing.get(b.to)?.length || 0) - (outgoing.get(a.to)?.length || 0)
        || String(a.id || `${a.from}=>${a.to}`).localeCompare(String(b.id || `${b.from}=>${b.to}`));
    })[0];
    if (chosen) primaryOut.set(id, chosen);
  }

  let nextLane = 0;
  const keys = [...columns.keys()].sort((a, b) => a - b);
  for (const column of keys) {
    const list = columns.get(column) || [];
    const used = new Set<number>();
    for (const node of list.filter((node) => rootIds.has(node.id)).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))) {
      node.row = nextLane++;
      used.add(node.row);
    }
    for (const node of list.filter((node) => !rootIds.has(node.id)).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))) {
      const parents = incoming.get(node.id) || [];
      const preferred = parents.filter((edge) => primaryOut.get(edge.from) === edge);
      const choices = (preferred.length ? preferred : parents)
        .filter((edge) => byId.has(edge.from))
        .sort((a, b) => (byId.get(a.from)!.row - byId.get(b.from)!.row) || (byId.get(a.from)!.column - byId.get(b.from)!.column) || String(a.id || `${a.from}=>${a.to}`).localeCompare(String(b.id || `${b.from}=>${b.to}`)));
      const inheritedLane = !directOnlyIds.has(node.id) && preferred.length > 0 ? byId.get(choices[0]?.from || "")?.row : undefined;
      node.row = inheritedLane !== undefined && !used.has(inheritedLane) ? inheritedLane : nextLane++;
      used.add(node.row);
    }
    list.sort((a, b) => a.row - b.row || a.label.localeCompare(b.label, "zh-CN"));
  }
}

/** Reduce crossings without changing physical identity or inventing graph edges. */
export function improveTopologyOrder<T extends LayoutNode>(columns: Map<number, T[]>, edges: LayoutEdge[], bottomIds: Set<string>) {
  const nodes = [...columns.values()].flat();
  // Bound quadratic crossing calculations on very large installations.
  if (nodes.length > 200 || edges.length > 300) return;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keys = [...columns.keys()].sort((a, b) => a - b);
  const incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to]);
  }
  const centeredRow = (node: T) => node.row - ((columns.get(node.column)?.length || 1) - 1) / 2;
  const refreshRows = () => { for (const list of columns.values()) list.forEach((node, index) => { node.row = index; }); };
  const crossings = () => {
    let count = 0;
    for (let boundary = 0; boundary < (keys[keys.length - 1] || 0); boundary++) {
      const segments = edges.flatMap((edge) => {
        const from = byId.get(edge.from), to = byId.get(edge.to);
        if (!from || !to || from.column >= to.column || from.column > boundary || to.column <= boundary) return [];
        const y = (x: number) => centeredRow(from) + (centeredRow(to) - centeredRow(from)) * (x - from.column) / (to.column - from.column);
        return [{ edge, left: y(boundary), right: y(boundary + 1) }];
      });
      for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i], b = segments[j];
        if (a.edge.from === b.edge.from || a.edge.to === b.edge.to) continue;
        if ((a.left - b.left) * (a.right - b.right) < 0) count++;
      }
    }
    return count;
  };
  refreshRows();
  let bestScore = crossings();
  let best = new Map(keys.map((key) => [key, [...(columns.get(key) || [])]]));
  for (let sweep = 0; sweep < 6; sweep++) {
    const forward = sweep % 2 === 0;
    for (const column of forward ? keys : [...keys].reverse()) {
      const list = columns.get(column) || [];
      const neighbors = forward ? incoming : outgoing;
      const hint = (node: T) => {
        const linked = (neighbors.get(node.id) || []).flatMap((id) => { const other = byId.get(id); return other ? [centeredRow(other)] : []; });
        return linked.length ? linked.reduce((sum, value) => sum + value, 0) / linked.length : centeredRow(node);
      };
      const hints = new Map(list.map((node) => [node.id, hint(node)]));
      list.sort((a, b) => Number(bottomIds.has(a.id)) - Number(bottomIds.has(b.id)) || (hints.get(a.id)! - hints.get(b.id)!) || a.row - b.row || a.label.localeCompare(b.label, "zh-CN"));
      refreshRows();
    }
    const score = crossings();
    if (score < bestScore) { bestScore = score; best = new Map(keys.map((key) => [key, [...(columns.get(key) || [])]])); }
  }
  for (const key of keys) columns.set(key, best.get(key) || []);
  refreshRows();
}
