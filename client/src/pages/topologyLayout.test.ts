import { strict as assert } from "node:assert";
import { test } from "node:test";
import { improveTopologyOrder } from "./topologyLayout";

test("crossing reduction swaps positions without changing path identities", () => {
  const a = { id: "a", label: "a", column: 0, row: 0 }, b = { id: "b", label: "b", column: 0, row: 1 };
  const c = { id: "c", label: "c", column: 1, row: 0 }, d = { id: "d", label: "d", column: 1, row: 1 };
  const columns = new Map([[0, [a, b]], [1, [c, d]]]);
  const edges = [{ from: "a", to: "d" }, { from: "b", to: "c" }];
  improveTopologyOrder(columns, edges, new Set());
  assert.equal((a.row - b.row) * (d.row - c.row) > 0, true);
  assert.deepEqual(edges, [{ from: "a", to: "d" }, { from: "b", to: "c" }]);
});

test("keeps explicit direct sinks after other sinks and handles empty graphs", () => {
  improveTopologyOrder(new Map(), [], new Set());
  const a = { id: "a", label: "a", column: 0, row: 0 };
  const b = { id: "b", label: "b", column: 1, row: 0 }, c = { id: "c", label: "c", column: 1, row: 1 };
  const columns = new Map([[0, [a]], [1, [b, c]]]);
  improveTopologyOrder(columns, [{ from: "a", to: "b" }, { from: "a", to: "c" }], new Set(["c"]));
  assert.equal(columns.get(1)?.at(-1)?.id, "c");
});
