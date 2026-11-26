import { strict as assert } from "node:assert";
import { test } from "node:test";
import { routeSmoothLayeredTopologyGraph, routeTopologyGraph, topologyRoutePath, type TopologyBox, type TopologyPoint } from "./topologyRouting";

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

test("empty relationship overview has finite canvas dimensions", () => {
  const graph = routeSmoothLayeredTopologyGraph([], [], new Set());
  assert.ok(Number.isFinite(graph.width) && Number.isFinite(graph.height));
  assert.equal(graph.positions.size, 0);
});

test("relationship overview uses smooth curves and routes long direct exits outside relay cards", () => {
  const nodes = [
    { id: "entry", column: 0, row: 0 }, { id: "relay", column: 1, row: 0 },
    { id: "landing", column: 2, row: 0 }, { id: "direct", column: 2, row: 1 },
  ];
  const result = routeSmoothLayeredTopologyGraph(nodes, [
    { id: "chain-a", from: "entry", to: "relay" }, { id: "chain-b", from: "relay", to: "landing" },
    { id: "direct-exit", from: "entry", to: "direct" },
  ], new Set(["direct"]));
  assert.match(topologyRoutePath(result.edgeRoutes.get("chain-a")!), /^M .* C /);
  const direct = result.edgeRoutes.get("direct-exit")!;
  assert.equal(direct.length, 7);
  assert.match(topologyRoutePath(direct), /^M .* C .* C /);
  assert.ok(direct[2].y > result.positions.get("relay")!.y + result.positions.get("relay")!.height);
  assert.ok(result.positions.get("direct")!.y > result.positions.get("landing")!.y);
  assert.ok(direct[2].x < result.positions.get("relay")!.x, "the exit reaches its lower lane before the relay card");
  assert.ok(direct[3].y > result.positions.get("relay")!.y + result.positions.get("relay")!.height);
  assert.ok(direct[0].x < direct[1].x && direct[1].x < direct[2].x, "the exit fans out diagonally, not as a vertical hairpin");
});

test("forwarded destinations follow their relay order before direct destinations", () => {
  const nodes = [
    { id: "entry", column: 0, row: 0 }, { id: "hk", column: 1, row: 0 },
    { id: "sg", column: 2, row: 0 }, { id: "jp", column: 2, row: 1 },
    { id: "sg-1", column: 3, row: 0 }, { id: "jp-1", column: 3, row: 1 },
    { id: "shared", column: 3, row: 2 }, { id: "sg-2", column: 3, row: 3 },
    { id: "sg-3", column: 3, row: 4 }, { id: "direct", column: 3, row: 5 },
  ];
  const edges = [
    { id: "entry-hk", from: "entry", to: "hk" },
    { id: "hk-sg", from: "hk", to: "sg" }, { id: "hk-jp", from: "hk", to: "jp" },
    { id: "sg-1", from: "sg", to: "sg-1" },
    { id: "sg-2", from: "sg", to: "sg-2" }, { id: "sg-3", from: "sg", to: "sg-3" },
    { id: "jp-1", from: "jp", to: "jp-1" },
    { id: "shared-sg", from: "sg", to: "shared" }, { id: "shared-jp", from: "jp", to: "shared" },
    { id: "direct", from: "entry", to: "direct" },
  ];
  const graph = routeSmoothLayeredTopologyGraph(nodes, edges, new Set(["direct"]));
  const y = (id: string) => graph.positions.get(id)!.y;
  assert.ok(y("sg-1") < y("sg-2") && y("sg-2") < y("sg-3"));
  assert.ok(y("sg-3") < y("jp-1"), "SG destinations belong above the JP-only destination");
  assert.ok(y("jp-1") < y("direct"), "direct landing stays below the forwarded destinations");
  assert.deepEqual([...graph.edgeRoutes.keys()].sort(), edges.map((edge) => edge.id).sort(), "routing preserves all actual edges");
});

test("parallel direct exits have separate labeled lanes below the shared chain", () => {
  const nodes = [
    { id: "entry", column: 0, row: 0 }, { id: "merge", column: 1, row: 0 },
    { id: "hk", column: 2, row: 0 }, { id: "sg", column: 3, row: 0 },
    { id: "forwarded", column: 4, row: 0 },
    { id: "direct-a", column: 4, row: 1 }, { id: "direct-b", column: 4, row: 2 },
  ];
  const graph = routeSmoothLayeredTopologyGraph(nodes, [
    { id: "entry-merge", from: "entry", to: "merge" },
    { id: "merge-hk", from: "merge", to: "hk" },
    { id: "hk-sg", from: "hk", to: "sg" },
    { id: "sg-forwarded", from: "sg", to: "forwarded" },
    { id: "direct-a", from: "merge", to: "direct-a" },
    { id: "direct-b", from: "merge", to: "direct-b" },
  ], new Set(["direct-a", "direct-b"]));
  const first = graph.edgeRoutes.get("direct-a")!;
  const second = graph.edgeRoutes.get("direct-b")!;
  assert.ok(first[2].x < graph.positions.get("hk")!.x);
  assert.ok(first[2].y > graph.positions.get("sg")!.y + graph.positions.get("sg")!.height);
  assert.ok(Math.abs(first[2].y - second[2].y) >= 30, "latency badges need separate lanes");
  assert.ok(graph.positions.get("direct-a")!.y > graph.positions.get("forwarded")!.y);
  assert.ok(graph.positions.get("direct-b")!.y > graph.positions.get("direct-a")!.y);
});

test("long smooth edges use compact reusable lanes, independent of ordinary edge count", () => {
  const nodes = [
    { id: "a", column: 0, row: 0 }, { id: "b", column: 1, row: 0 },
    { id: "c", column: 2, row: 0 }, { id: "d", column: 3, row: 0 },
  ];
  const ordinary = Array.from({ length: 30 }, (_, index) => ({ id: `ordinary-${index}`, from: "a", to: "b" }));
  const graph = routeSmoothLayeredTopologyGraph(nodes, [...ordinary, { id: "long", from: "a", to: "d" }], new Set());
  const long = graph.edgeRoutes.get("long")!;
  // Ordinary links do not consume the long-link track budget.
  assert.equal(long[1].y, long[2].y);
  assert.ok(long[1].y > -80, "the long edge was sent to a lane based on all edge indices");
  assert.ok(graph.height < 500, "ordinary fan-out unnecessarily enlarged the canvas");
});

test("smooth fan-out ports follow destination positions, not edge IDs", () => {
  const nodes = [{id:"hk",column:0,row:0}, {id:"jp",column:1,row:0}, {id:"sg",column:1,row:1}];
  const graph = routeSmoothLayeredTopologyGraph(nodes, [
    {id:"z-upper",from:"hk",to:"jp"}, {id:"a-lower",from:"hk",to:"sg"},
  ], new Set());
  const upper = graph.edgeRoutes.get("z-upper")!;
  const lower = graph.edgeRoutes.get("a-lower")!;
  const y = (p: TopologyPoint[], t: number) => (1-t)**3*p[0].y + 3*(1-t)**2*t*p[1].y + 3*(1-t)*t*t*p[2].y + t**3*p[3].y;
  for (let i = 0; i <= 100; i++) assert.ok(y(upper, i/100) < y(lower, i/100), "fan-out curves crossed");
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
