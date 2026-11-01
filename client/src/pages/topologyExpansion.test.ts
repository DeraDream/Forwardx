import { strict as assert } from "node:assert";
import { test } from "node:test";
import { combineTopologyHostVariants, joinTopologyHostPaths, MAX_TOPOLOGY_VARIANTS } from "./topologyExpansion";

test("nested route alternatives preserve shared boundaries and each destination", () => {
  const state = { truncated: false, incomplete: false };
  const entries = [[1, 3], [2, 3]];
  const exits = [[3, 4, 6], [3, 5, 6]];
  assert.deepEqual(combineTopologyHostVariants(entries, exits, state), [[1,3,4,6],[1,3,5,6],[2,3,4,6],[2,3,5,6]]);
  assert.deepEqual(state, { truncated: false, incomplete: false });
});

test("cycles are not simplified into fictitious direct edges", () => {
  const state = { truncated: false, incomplete: false };
  assert.equal(joinTopologyHostPaths([1,2,3], [3,1,4]), null);
  assert.deepEqual(combineTopologyHostVariants([[1,2,3]], [[3,1,4],[3,5]], state), [[1,2,3,5]]);
  assert.equal(state.incomplete, true);
});

test("large Cartesian expansions are bounded and explicitly marked", () => {
  const state = { truncated: false, incomplete: false };
  const left = Array.from({ length: 30 }, (_, index) => [index + 1]);
  const right = Array.from({ length: 30 }, (_, index) => [index + 100]);
  assert.equal(combineTopologyHostVariants(left, right, state).length, MAX_TOPOLOGY_VARIANTS);
  assert.equal(state.truncated, true);
});
