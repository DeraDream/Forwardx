import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildPhysicalPaths } from "./NetworkTopology";

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
  const fullChains = [{ id: 2, name: "nested full chain", nodes: [{ hostId: 1 }, { nodeType: "forward-chain", forwardGroupId: 10 }, { hostId: 6 }] }];
  const result = buildPhysicalPaths(rules, hosts, [tunnel], [group], [], fullChains, "all", "");
  assert.equal(result.truncated, false);
  const rulePaths = result.paths.filter((path) => path.name === "nested rule").map(pathIds);
  const fullPaths = result.paths.filter((path) => path.name === "nested full chain").map(pathIds);
  assert.deepEqual(rulePaths, [["host:1","host:2","host:3","host:5","target:198.51.100.9:443"],["host:1","host:2","host:4","host:5","target:198.51.100.9:443"]]);
  assert.deepEqual(fullPaths, [["host:1","host:2","host:3","host:5","host:6"],["host:1","host:2","host:4","host:5","host:6"]]);
});

test("missing references and cycles are marked incomplete rather than drawn as direct routes", () => {
  const missing = buildPhysicalPaths([{ id: 1, hostId: 1, tunnelId: 999, targetIp: "198.51.100.9", targetPort: 443 }], hosts, [], [], [], [], "all", "");
  assert.equal(missing.incomplete, true); assert.equal(missing.paths.length, 0);
  const cyclic = buildPhysicalPaths([{ id: 2, hostId: 1, targetRuleId: 3 }, { id: 3, hostId: 2, targetRuleId: 2 }], hosts, [], [], [], [], "all", "");
  assert.equal(cyclic.incomplete, true); assert.equal(cyclic.paths.length, 0);
});
