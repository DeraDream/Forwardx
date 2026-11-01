import { strict as assert } from "node:assert";
import { test } from "node:test";
import { routeTopologyGraph, topologyRoutePath, type TopologyBox, type TopologyPoint } from "./topologyRouting";

type Segment = { a: TopologyPoint; b: TopologyPoint; edge: string };
function segments(routes: Map<string, TopologyPoint[]>) {
  return [...routes].flatMap(([edge, points]) => points.slice(1).map((b, i) => ({ edge, a: points[i], b })).filter(({a,b}) => a.x !== b.x || a.y !== b.y));
}
function intersectsCard(segment: Segment, box: TopologyBox) {
  const {a,b} = segment;
  if (a.y === b.y) return a.y > box.y && a.y < box.y + box.height && Math.max(Math.min(a.x,b.x), box.x) < Math.min(Math.max(a.x,b.x), box.x + box.width);
  if (a.x === b.x) return a.x > box.x && a.x < box.x + box.width && Math.max(Math.min(a.y,b.y), box.y) < Math.min(Math.max(a.y,b.y), box.y + box.height);
  throw new Error("non-orthogonal edge");
}
function collinearOverlap(a: Segment, b: Segment) {
  if (a.a.y === a.b.y && b.a.y === b.b.y && a.a.y === b.a.y) return Math.max(Math.min(a.a.x,a.b.x),Math.min(b.a.x,b.b.x)) < Math.min(Math.max(a.a.x,a.b.x),Math.max(b.a.x,b.b.x));
  if (a.a.x === a.b.x && b.a.x === b.b.x && a.a.x === b.a.x) return Math.max(Math.min(a.a.y,a.b.y),Math.min(b.a.y,b.b.y)) < Math.min(Math.max(a.a.y,a.b.y),Math.max(b.a.y,b.b.y));
  return false;
}

test("non-planar multi-exit and long links do not pass through cards or overlap", () => {
  const nodes = Array.from({length: 9}, (_, index) => ({ id: `n${index}`, column: Math.floor(index / 3), row: index % 3 }));
  const edges = [
    ...[0,1,2].flatMap((from) => [3,4,5].map((to) => ({ id: `${from}-${to}`, from: `n${from}`, to: `n${to}` }))),
    { id: "long", from: "n0", to: "n8" }, { id: "back", from: "n7", to: "n1" },
    { id: "shared-exit", from: "n4", to: "n8" }, { id: "parallel", from: "n4", to: "n8" },
  ];
  const result = routeTopologyGraph(nodes, edges, new Set(["n8"]));
  const lines = segments(result.edgeRoutes);
  assert.equal(result.edgeRoutes.size, edges.length);
  for (const line of lines) for (const [id, box] of result.positions) assert.equal(intersectsCard(line, box), false, `${line.edge} crossed card ${id}`);
  for (let i = 0; i < lines.length; i++) for (let j = i+1; j < lines.length; j++) if (lines[i].edge !== lines[j].edge) assert.equal(collinearOverlap(lines[i], lines[j]), false, `${lines[i].edge} overlaps ${lines[j].edge}`);
  assert.match(topologyRoutePath(result.edgeRoutes.get("long")!), /^M .* L /);
});

test("routed edges stay clear across a range of dense mixed-direction graphs", () => {
  let seed = 0x12345678;
  const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 40; trial++) {
    const nodes = Array.from({length: 12}, (_, i) => ({id:`n${i}`,column:Math.floor(i/3),row:i%3}));
    const edges = Array.from({length: 20}, (_, i) => { let from = random(nodes.length), to = random(nodes.length); if (from === to) to = (to + 1) % nodes.length; return {id:`e${i}`,from:`n${from}`,to:`n${to}`}; });
    const routed = routeTopologyGraph(nodes, edges, new Set());
    const lines = segments(routed.edgeRoutes);
    for (const line of lines) for (const [id, box] of routed.positions) assert.equal(intersectsCard(line, box), false, `trial ${trial}: ${line.edge} crossed ${id}`);
    for (let i=0;i<lines.length;i++) for (let j=i+1;j<lines.length;j++) if (lines[i].edge !== lines[j].edge) assert.equal(collinearOverlap(lines[i], lines[j]), false, `trial ${trial}: overlapping ${lines[i].edge} and ${lines[j].edge}`);
  }
});

test("many edges have distinct card ports and empty graphs remain valid", () => {
  const nodes = [{id:"a",column:0,row:0}, ...Array.from({length: 20}, (_,i) => ({id:`b${i}`,column:1,row:i}))];
  const edges = nodes.slice(1).map((node) => ({ id: node.id, from:"a", to:node.id }));
  const result = routeTopologyGraph(nodes, edges, new Set());
  const ports = edges.map((edge) => result.edgeRoutes.get(edge.id)![0].y);
  assert.equal(new Set(ports).size, edges.length);
  assert.ok(result.positions.get("a")!.height > 58);
  assert.equal(routeTopologyGraph([], [], new Set()).edgeRoutes.size, 0);
});
