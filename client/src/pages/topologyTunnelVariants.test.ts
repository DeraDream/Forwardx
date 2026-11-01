import { strict as assert } from "node:assert";
import { test } from "node:test";
import { topologyTunnelVariants } from "./topologyTunnelVariants";

test("expands distinct entry and exit alternatives for a serial tunnel", () => {
  const result = topologyTunnelVariants({ hops: [1, 3, 4], entries: [1, 2], exits: [4, 5] });
  assert.deepEqual(result, [[1, 3, 4], [1, 3, 5], [2, 3, 4], [2, 3, 5]]);
});

test("relay failover candidates are alternatives, not sequential hops", () => {
  const result = topologyTunnelVariants({ hops: [1, 3, 4, 5], entries: [1], exits: [5, 6], relayFailover: true });
  assert.deepEqual(result, [[1, 3, 5], [1, 3, 6], [1, 4, 5], [1, 4, 6]]);
});

test("does not fabricate direct edges when a route contains a cycle", () => {
  assert.deepEqual(topologyTunnelVariants({ hops: [1, 2, 1, 3] }), []);
  assert.deepEqual(topologyTunnelVariants({ hops: [1, 2, 3], exits: [2] }), []);
});
