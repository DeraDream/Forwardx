import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildOverviewGraph, buildPhysicalPaths, groupTopologyListRows, relationshipOverviewPaths } from "./NetworkTopology";

const hosts = [1,2,3,4,5,6].map((id) => ({ id, name: `host-${id}`, ip: `192.0.2.${id}`, isOnline: true }));
const tunnel = { id: 100, mode: "tls", hopHostIds: [2,3], loadBalanceEnabled: true, loadBalanceStrategy: "round_robin", loadBalanceExits: [{ hostId: 4, isEnabled: true }] };
const group = { id: 10, groupMode: "chain", members: [
  { memberType: "host", hostId: 1, priority: 1, isEnabled: true },
  { memberType: "tunnel", tunnelId: 100, priority: 2, isEnabled: true },
  { memberType: "host", hostId: 5, priority: 3, isEnabled: true },
] };
const pathIds = (path: any) => [path.entry, ...path.relays, path.landing].map((node: any) => node.id);

test("nested multi-exit tunnel branches are expanded in rules and full chains", () => {
  const rules = [{ id: 1, name: "nested rule", hostId: 1, forwardGroupId: 10, targetIp: "198.51.100.9", targetPort: 443 }];
  const fullChains = [{ id: 2, name: "nested full chain", status: "running", isEnabled: true, nodes: [{ hostId: 1 }, { nodeType: "forward-chain", forwardGroupId: 10 }, { hostId: 6 }] }];
  const result = buildPhysicalPaths(rules, hosts, [tunnel], [group], [], fullChains, "all", "");
  assert.equal(result.truncated, false);
  const rulePaths = result.paths.filter((path) => path.name === "nested rule").map(pathIds);
  const fullPaths = result.paths.filter((path) => path.name === "nested full chain").map(pathIds);
  assert.deepEqual(rulePaths, [["host:1","host:2","host:3","host:5","target:198.51.100.9:443"],["host:1","host:2","host:4","host:5","target:198.51.100.9:443"]]);
  assert.deepEqual(fullPaths, [["host:1","host:2","host:3","host:5","host:6"],["host:1","host:2","host:4","host:5","host:6"]]);
  assert.deepEqual(result.paths.filter((path) => path.name === "nested rule").map((path) => path.segmentRuleIds), [[1], [1]]);
});

test("nested target rules retain every segment rule ID", () => {
  const rules = [
    { id: 1, name: "entry", hostId: 1, targetRuleId: 2, targetIp: "192.0.2.2", targetPort: 1000 },
    { id: 2, name: "chain", hostId: 2, forwardGroupId: 20, targetIp: "198.51.100.10", targetPort: 443 },
  ];
  const groups = [{ id: 20, groupMode: "chain", members: [{memberType:"host",hostId:2,isEnabled:true},{memberType:"host",hostId:3,isEnabled:true}] }];
  const result = buildPhysicalPaths(rules, hosts, [], groups, [], [], "all", "");
  assert.deepEqual(result.paths.find((path) => path.ruleId === 1)?.segmentRuleIds, [1, 2]);
});

test("multi-entry chain remains separate graph paths but one list row", () => {
  const rules = [{ id: 99, name: "shared chain", hostId: 1, forwardGroupId: 20, targetIp: "198.51.100.10", targetPort: 443 }];
  const groups = [
    { id: 10, groupMode: "entry", members: [{ memberType: "host", hostId: 1, isEnabled: true }, { memberType: "host", hostId: 6, isEnabled: true }] },
    { id: 20, groupMode: "chain", entryGroupId: 10, members: [{ memberType: "host", hostId: 2, isEnabled: true }, { memberType: "host", hostId: 3, isEnabled: true }] },
  ];
  const result = buildPhysicalPaths(rules, hosts, [], groups, [], [], "all", "");
  assert.equal(result.paths.length, 2);
  const rows = groupTopologyListRows(result.paths);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].entrances.map((path) => path.entry.id), ["host:1", "host:6"]);
  assert.deepEqual(rows[0].path.relays.map((node) => node.id), ["host:2", "host:3"]);
});

test("relationship overview places standalone forwards above chains and shared direct landings below forwarded landings", () => {
  const rules = [
    { id: 1, name: "IX chain", hostId: 1, forwardGroupId: 20, targetIp: "198.51.100.10", targetPort: 443 },
    { id: 2, name: "IX direct", hostId: 1, targetIp: "198.51.100.11", targetPort: 443 },
    { id: 3, name: "unrelated direct", hostId: 6, targetIp: "198.51.100.12", targetPort: 443 },
  ];
  const groups = [{ id: 20, groupMode: "chain", members: [{ memberType: "host", hostId: 1, isEnabled: true }, { memberType: "host", hostId: 2, isEnabled: true }] }];
  const result = buildPhysicalPaths(rules, hosts, [], groups, [], [], "all", "");
  const overview = relationshipOverviewPaths(result.paths);
  assert.deepEqual(overview.map((path) => path.name).sort(), ["IX chain", "IX direct", "unrelated direct"]);
  const graph = buildOverviewGraph(overview);
  const pos = graph.positions;
  assert.ok(pos.get("host:6")!.y < pos.get("host:1")!.y, "standalone port forwards go above the forwarding chain");
  assert.ok(pos.get("target:198.51.100.11:443")!.y > pos.get("target:198.51.100.10:443")!.y, "shared direct landings go below forwarded destinations");
  assert.ok(graph.edges.some((edge) => edge.from === "host:1" && edge.to === "target:198.51.100.11:443"));
  assert.ok(graph.edges.some((edge) => edge.from === "host:2" && edge.to === "target:198.51.100.10:443"));
});

test("the deeper shared route anchors entries regardless of their names, without routing through cards", () => {
  const node = (id: string, label = id) => ({ id, label, kind: "relay" });
  const mk = node("mk", "AAA short"), poA = node("po-a", "ZZZ deep A"), poB = node("po-b", "ZZZ deep B");
  const qhix = node("qhix"), hk = node("hk"), sg = node("sg"), exit = node("exit"), direct = node("direct");
  const paths = [
    { id: "deep-a", entry: poA, relays: [qhix, hk, sg], landing: exit },
    { id: "deep-b", entry: poB, relays: [qhix, hk, sg], landing: exit },
    { id: "short", entry: mk, relays: [hk, sg], landing: exit },
    { id: "direct", entry: qhix, relays: [], landing: direct },
  ] as any;
  const graph = buildOverviewGraph(paths);
  assert.ok(graph.positions.get("mk")!.y > graph.positions.get("po-a")!.y);
  assert.ok(graph.positions.get("mk")!.y > graph.positions.get("po-b")!.y);
  assert.equal(graph.nodes.filter((node) => node.id === "hk").length, 1);
  assert.ok(graph.edges.some((edge) => edge.from === "qhix" && edge.to === "hk"));
  assert.ok(graph.edges.some((edge) => edge.from === "mk" && edge.to === "hk"));
  const route = graph.edgeRoutes.get("mk=>hk")!;
  const cubic = (t: number) => ({
    x: (1-t)**3*route[0].x + 3*(1-t)**2*t*route[1].x + 3*(1-t)*t*t*route[2].x + t**3*route[3].x,
    y: (1-t)**3*route[0].y + 3*(1-t)**2*t*route[1].y + 3*(1-t)*t*t*route[2].y + t**3*route[3].y,
  });
  const qhixBox = graph.positions.get("qhix")!;
  for (let index = 0; index <= 200; index++) {
    const progress = index / 200 * (route.length - 1);
    const segment = Math.min(route.length - 2, Math.floor(progress));
    const a = route[segment], b = route[segment + 1], t = progress - segment;
    const point = route.length === 4 ? cubic(index / 200) : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    assert.ok(!(point.x > qhixBox.x && point.x < qhixBox.x + qhixBox.width
      && point.y > qhixBox.y && point.y < qhixBox.y + qhixBox.height), "short path passed through QHIX");
  }
});

test("transitively connected direct paths remain in the chain band without duplicate nodes", () => {
  const node = (id: string) => ({ id, label: id, kind: "relay" });
  const paths = [
    { id: "chain", entry: node("a"), relays: [node("b")], landing: node("c") },
    { id: "joined", entry: node("b"), relays: [], landing: node("d") },
    { id: "indirect", entry: node("d"), relays: [], landing: node("e") },
  ] as any;
  const graph = buildOverviewGraph(paths);
  assert.equal(graph.nodes.filter((node) => node.id === "d").length, 1);
  assert.ok(graph.edges.some((edge) => edge.from === "d" && edge.to === "e"));
});

test("parallel entry, shared relays and direct convergence exits keep their real connections", () => {
  const node = (id: string) => ({ id, label: id, kind: "relay" });
  const paths = [
    ...["po0-999", "po0-1288"].flatMap((entry) => ["sg", "jp"].map((exit) => ({
      id: `${entry}-${exit}`, category: "chain", name: "shared", entry: node(entry),
      relays: [node("qhix"), node("hk"), node(exit)], landing: node(`${exit}-landing`),
    }))),
    { id: "direct", category: "local", name: "direct", entry: node("qhix"), relays: [], landing: node("direct-landing") },
  ] as any;
  const graph = buildOverviewGraph(paths);
  const y = (id: string) => graph.positions.get(id)!.y;
  const center = (id: string) => y(id) + graph.positions.get(id)!.height / 2;
  assert.ok(y("po0-999") !== y("po0-1288"));
  assert.equal(center("qhix"), center("hk"));
  assert.equal((center("sg") + center("jp")) / 2, center("hk"));
  assert.ok(y("direct-landing") > y("sg-landing"));
  assert.ok(y("direct-landing") > y("jp-landing"));
  assert.ok(graph.edges.some((edge) => edge.from === "qhix" && edge.to === "direct-landing"));
  assert.ok(!graph.edges.some((edge) => edge.from === "sg" && edge.to === "direct-landing"));
});

test("two QHIX direct routes stay ordered and clear the SG/JP relay cards", () => {
  const node = (id: string) => ({ id, label: id, kind: "relay" });
  const paths = [
    ...["po0-999", "po0-1288"].flatMap((entry) => [
      ...["sgs", "legend", "onidel"].map((landing) => ({ id: `${entry}-${landing}`, category: "chain", entry: node(entry), relays: [node("qhix"), node("hk"), node("sg")], landing: node(landing) })),
      ...["jps", "us"].map((landing) => ({ id: `${entry}-${landing}`, category: "chain", entry: node(entry), relays: [node("qhix"), node("hk"), node("jp")], landing: node(landing) })),
    ]),
    ...["hks", "ciallo"].map((landing) => ({ id: `direct-${landing}`, category: "local", entry: node("qhix"), relays: [], landing: node(landing) })),
  ] as any;
  const graph = buildOverviewGraph(paths);
  const upper = graph.edgeRoutes.get("qhix=>hks")!, lower = graph.edgeRoutes.get("qhix=>ciallo")!;
  // The displayed destination order, not the lexical ID order, determines the ports.
  const ordered = [upper, lower].sort((a, b) => a[3].y - b[3].y);
  const cubic = (points: typeof upper, t: number) => {
    const weights = [(1-t)**3, 3*(1-t)**2*t, 3*(1-t)*t*t, t**3];
    return { x: points.reduce((sum, point, i) => sum + point.x * weights[i], 0), y: points.reduce((sum, point, i) => sum + point.y * weights[i], 0) };
  };
  const relays = ["hk", "sg", "jp"].map((id) => graph.positions.get(id)!);
  for (let index = 0; index <= 100; index++) {
    const t = index / 100;
    const first = cubic(ordered[0], t), second = cubic(ordered[1], t);
    assert.ok(first.y < second.y, `direct routes crossed at ${t}`);
    for (const point of [first, second]) for (const box of relays) {
      assert.ok(!(point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height), `direct route crossed a relay card at ${t}`);
    }
  }
  assert.ok(graph.positions.get("hks")!.y > graph.positions.get("jps")!.y);
  assert.ok(graph.positions.get("ciallo")!.y > graph.positions.get("jps")!.y);
});

test("overview excludes draft, cancelled and not-yet-deployed full chains", () => {
  const chains = ["draft", "ports-ready", "ready-to-deploy", "cancelled", "running"].map((status, id) => ({
    id: id + 1, name: status, status, isEnabled: true, nodes: [{hostId:1}, {hostId:2}, {hostId:3}],
  }));
  const result = buildPhysicalPaths([], hosts, [], [], [], chains, "all", "");
  assert.deepEqual(result.paths.map(p => p.name), ["running"]);
});

test("missing references and cycles are marked incomplete rather than drawn as direct routes", () => {
  const missing = buildPhysicalPaths([{ id: 1, hostId: 1, tunnelId: 999, targetIp: "198.51.100.9", targetPort: 443 }], hosts, [], [], [], [], "all", "");
  assert.equal(missing.incomplete, true); assert.equal(missing.paths.length, 0);
  const cyclic = buildPhysicalPaths([{ id: 2, hostId: 1, targetRuleId: 3 }, { id: 3, hostId: 2, targetRuleId: 2 }], hosts, [], [], [], [], "all", "");
  assert.equal(cyclic.incomplete, true); assert.equal(cyclic.paths.length, 0);
});

test("topology nodes retain managed-host and external-target country metadata", () => {
  const geoHosts = hosts.map((host) => host.id === 1
    ? { ...host, geoCountryCode: "HK", geoCountryName: "Hong Kong", geoEmoji: "🇭🇰" }
    : host);
  const targetGeo = new Map([["example.com", {
    geoCountryCode: "US",
    geoCountryName: "United States",
    geoEmoji: "🇺🇸",
  }]]);
  const result = buildPhysicalPaths(
    [{ id: 9, name: "geo rule", hostId: 1, targetIp: "Example.COM", targetPort: 443 }],
    geoHosts,
    [],
    [],
    [],
    [],
    "all",
    "",
    targetGeo,
  );
  const path = result.paths[0];
  assert.equal(path.entry.geoCountryCode, "HK");
  assert.equal(path.entry.geoCountryName, "Hong Kong");
  assert.equal(path.landing.geoCountryCode, "US");
  assert.equal(path.landing.geoCountryName, "United States");
});
