type LayoutNode = { id: string; label: string; column: number; row: number };
type LayoutEdge = { from: string; to: string };

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
