import { strict as assert } from "node:assert";
import { test } from "node:test";
import { acyclicTopologyLayerEdges, assignTopologyBranchRows, improveTopologyOrder } from "./topologyLayout";

test("referenced service branches receive a separate row until they merge", () => {
  const entry = { id: "entry", label: "entry", column: 0, row: 0 };
  const direct = { id: "direct", label: "direct", column: 3, row: 0 };
  const relayA = { id: "relay-a", label: "relay-a", column: 1, row: 0 };
  const relayB = { id: "relay-b", label: "relay-b", column: 2, row: 0 };
  const columns = new Map([[0, [entry]], [1, [relayA]], [2, [relayB]], [3, [direct]]]);
  assignTopologyBranchRows(columns, [
    { id: "direct", from: "entry", to: "direct" },
    { id: "branch-a", from: "entry", to: "relay-a" },
    { id: "branch-b", from: "relay-a", to: "relay-b" },
    { id: "merge", from: "relay-b", to: "direct" },
  ], new Set(["entry"]), new Set());
  assert.equal(entry.row, direct.row);
  assert.equal(relayA.row, relayB.row);
  assert.notEqual(relayA.row, entry.row);
});

test("cyclic service references retain a visible back edge without extending layered depth", () => {
  const edges = [
    { id: "entry-a", from: "entry", to: "a" },
    { id: "a-b", from: "a", to: "b" },
    { id: "b-a", from: "b", to: "a" },
    { id: "b-exit", from: "b", to: "exit" },
  ];
  const layerEdges = acyclicTopologyLayerEdges(["entry", "a", "b", "exit"], edges);
  assert.equal(layerEdges.size, 3);
  assert.equal([...layerEdges].some((edge) => edge.id === "a-b") && [...layerEdges].some((edge) => edge.id === "b-a"), false);
});

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
