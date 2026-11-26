import assert from "node:assert/strict";
import test from "node:test";
import { topologyFocus, topologyUsageCounts } from "./networkTopologyFocus";

const paths = [
  { id: "one", nodeIds: ["a", "hub", "relay", "exit-1"] },
  { id: "two", nodeIds: ["b", "hub", "relay", "exit-2"] },
  { id: "three", nodeIds: ["c", "other"] },
];

test("hovering a shared line previews all complete related paths", () => {
  const result = topologyFocus(paths, { edgeId: "hub=>relay" });
  assert.equal(result.count, 2);
  assert.equal(topologyUsageCounts(paths).edges.get("hub=>relay"), 2);
  assert.equal(topologyUsageCounts(paths).nodes.get("hub"), 2);
  assert.deepEqual([...result.nodeIds].sort(), ["a", "b", "exit-1", "exit-2", "hub", "relay"]);
  assert.ok(result.edgeIds.has("a=>hub") && result.edgeIds.has("relay=>exit-2"));
  assert.ok(!result.edgeIds.has("c=>other"));
});

test("a node previews all routes and selecting one locks only its own route", () => {
  assert.equal(topologyFocus(paths, { nodeId: "hub" }).count, 2);
  const selected = topologyFocus(paths, { pathId: "two" });
  assert.deepEqual([...selected.nodeIds], ["b", "hub", "relay", "exit-2"]);
  assert.equal(topologyFocus(paths, { edgeId: "relay=>exit-1" }).count, 1);
});
