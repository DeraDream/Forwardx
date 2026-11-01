import { strict as assert } from "node:assert";
import { test } from "node:test";
import { branchedAutoPathKey, planDirectTunnelBranchProbes, planRelayTunnelBranchProbes, planTunnelBranchProbes } from "./tunnelBranchPlan";
import { TUNNEL_ENTRY_BRANCH_GROUP, TUNNEL_EXIT_BRANCH_GROUP } from "./tunnelBranchLatency";

const endpoint = (id: number) => ({ hostId: id, address: `host-${id}`, port: 10000 + id, name: `node-${id}` });
test("plans each entry and exit and probes the common section once", () => {
  const plan = planTunnelBranchProbes([{ hostId: 1, name: "a" }, { hostId: 2, name: "b" }], [endpoint(1), endpoint(3), endpoint(4), endpoint(5)], [endpoint(5), endpoint(6), endpoint(7)]);
  assert.deepEqual(plan.map((p) => [p.fromHostId, p.target.hostId]), [[1, 3], [2, 3], [3, 4], [4, 5], [4, 6], [4, 7]]);
  assert.equal(plan.filter((p) => p.groupKey === TUNNEL_ENTRY_BRANCH_GROUP).length, 2);
  assert.equal(plan.filter((p) => p.groupKey === TUNNEL_EXIT_BRANCH_GROUP).length, 3);
});
test("maps persisted branch series to the matching topology-specific path", () => {
  const tunnel = { loadBalanceEnabled: true, loadBalanceStrategy: "round_robin" };
  const hops = [endpoint(1), endpoint(2), endpoint(3)];
  const exits = [{ ...endpoint(5), listenPort: 10005, seq: 2 }, { ...endpoint(4), listenPort: 10004, seq: 1 }];
  assert.equal(branchedAutoPathKey(tunnel, hops, exits, "primary"), "branch-exit-3");
  assert.equal(branchedAutoPathKey(tunnel, hops, exits, "exit-2"), "branch-exit-4");
  assert.equal(branchedAutoPathKey(tunnel, hops, exits, "exit-3"), "branch-exit-5");
  assert.equal(branchedAutoPathKey(tunnel, hops, exits, "exit-4"), null);
});
test("direct multi-entry plans every entry-to-exit pair", () => {
  const plan = planDirectTunnelBranchProbes([{ hostId: 1, name: "a" }, { hostId: 2, name: "b" }], [endpoint(3), endpoint(4)]);
  assert.deepEqual(plan.map((p) => [p.fromHostId, p.target.hostId]), [[1, 3], [2, 3], [1, 4], [2, 4]]);
  assert.equal(plan[0].groupLabel, plan[1].groupLabel);
  assert.notEqual(plan[0].groupLabel, plan[2].groupLabel);
});
test("relay failover probes each entry-to-relay and relay-to-exit edge", () => {
  const plan = planRelayTunnelBranchProbes([{ hostId: 1, name: "a" }, { hostId: 2, name: "b" }], [endpoint(3), endpoint(4)], [endpoint(5), endpoint(6)]);
  assert.deepEqual(plan.map((p) => [p.fromHostId, p.target.hostId]), [[1,3],[2,3],[3,5],[3,6],[1,4],[2,4],[4,5],[4,6]]);
});
test("rejects missing and invalid endpoints before dispatch", () => {
  assert.throws(() => planTunnelBranchProbes([], [endpoint(1), endpoint(2), endpoint(3)], [endpoint(3)]));
  assert.throws(() => planTunnelBranchProbes([{ hostId: 1, name: "a" }], [endpoint(1), endpoint(2), endpoint(3)], [{ ...endpoint(3), port: 0 }]));
  assert.throws(() => planDirectTunnelBranchProbes(Array.from({ length: 129 }, (_, index) => ({ hostId: index + 1, name: "entry" })), [endpoint(300), endpoint(301)]), /最多探测/);
});
