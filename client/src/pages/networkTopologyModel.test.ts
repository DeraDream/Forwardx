import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPhysicalPaths, groupTopologyListRows, relationshipOverviewPaths } from "./NetworkTopology";

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

test("relationship overview keeps an entry's direct landing but omits standalone direct forwards", () => {
  const rules = [
    { id: 1, name: "IX chain", hostId: 1, forwardGroupId: 20, targetIp: "198.51.100.10", targetPort: 443 },
    { id: 2, name: "IX direct", hostId: 1, targetIp: "198.51.100.11", targetPort: 443 },
    { id: 3, name: "unrelated direct", hostId: 6, targetIp: "198.51.100.12", targetPort: 443 },
  ];
  const groups = [{ id: 20, groupMode: "chain", members: [{ memberType: "host", hostId: 1, isEnabled: true }, { memberType: "host", hostId: 2, isEnabled: true }] }];
  const result = buildPhysicalPaths(rules, hosts, [], groups, [], [], "all", "");
  assert.deepEqual(relationshipOverviewPaths(result.paths).map((path) => path.name).sort(), ["IX chain", "IX direct"]);
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
