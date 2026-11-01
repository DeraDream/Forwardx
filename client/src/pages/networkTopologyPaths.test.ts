import { strict as assert } from "node:assert";
import { test } from "node:test";
import { topologyPathEdgeIds } from "./networkTopologyPaths";

test("highlights only consecutive directed edges of the chosen path", () => {
  assert.deepEqual(topologyPathEdgeIds(["entry", "relay", "exit", "target"]), [
    "entry=>relay", "relay=>exit", "exit=>target",
  ]);
  assert.deepEqual(topologyPathEdgeIds(["entry", "target"]), ["entry=>target"]);
});

test("ignores empty and self edges like the graph builder", () => {
  assert.deepEqual(topologyPathEdgeIds([]), []);
  assert.deepEqual(topologyPathEdgeIds(["a", "a", "", "b"]), []);
});
