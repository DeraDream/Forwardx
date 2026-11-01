import { strict as assert } from "node:assert";
import { test } from "node:test";
import { aggregateTunnelBranchTest, TUNNEL_ENTRY_BRANCH_GROUP as ENTRY, TUNNEL_EXIT_BRANCH_GROUP as EXIT } from "./tunnelBranchLatency";
import type { HopTestResult } from "./hopTestState";

function hop(latencyMs: number | null, groupKey?: string): HopTestResult {
  return { success: latencyMs !== null, latencyMs, message: null, hopLabel: "hop", groupKey };
}

test("shared section is counted once per route, never summed across exits", () => {
  const result = aggregateTunnelBranchTest([hop(5, ENTRY), hop(10), hop(20, EXIT), hop(40, EXIT)]);
  assert.equal(result.success, true);
  assert.equal(result.latencyMs, 55);
  assert.deepEqual(result.branches.map((branch) => branch.latencyMs), [35, 55]);
  assert.equal(result.partial, false);
});

test("partial exits and entries remain visible without false full success", () => {
  const result = aggregateTunnelBranchTest([hop(null, ENTRY), hop(7, ENTRY), hop(10), hop(null, EXIT), hop(20, EXIT)]);
  assert.equal(result.success, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.branches.map((branch) => branch.latencyMs), [null, 37]);
});

test("direct multi-entry groups measurements by exit, not by entry", () => {
  const row = (latency: number | null, label: string): HopTestResult => ({ ...hop(latency, EXIT), groupLabel: label });
  const result = aggregateTunnelBranchTest([row(5, "primary"), row(null, "primary"), row(20, "second"), row(30, "second")]);
  assert.equal(result.success, true);
  assert.equal(result.partial, true);
  assert.equal(result.latencyMs, 30);
  assert.deepEqual(result.branches.map((branch) => branch.latencyMs), [5, 30]);
});

test("relay alternatives are combined only with their own exit edges", () => {
  const row = (latency: number | null, key: string): HopTestResult => ({ ...hop(latency, key), groupLabel: key });
  const result = aggregateTunnelBranchTest([
    row(5, "relay-entry-20"), row(null, "relay-exit-20-40"), row(12, "relay-exit-20-50"),
    row(null, "relay-entry-30"), row(90, "relay-exit-30-40"), row(2, "relay-exit-30-50"),
  ]);
  assert.equal(result.success, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.branches.map((branch) => branch.latencyMs), [null, 17]);
  assert.equal(result.latencyMs, 17);
});

test("shared failure, all entries down or all exits down fails all routes", () => {
  for (const details of [
    [hop(5, ENTRY), hop(null), hop(20, EXIT)],
    [hop(null, ENTRY), hop(10), hop(20, EXIT)],
    [hop(5, ENTRY), hop(10), hop(null, EXIT)],
  ]) {
    const result = aggregateTunnelBranchTest(details);
    assert.equal(result.success, false);
    assert.equal(result.latencyMs, null);
    assert.equal(result.branches[0].latencyMs, null);
  }
});
