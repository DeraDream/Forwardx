import { strict as assert } from "node:assert";
import { test } from "node:test";
import { topologyTunnelVariants, visibleTopologyTunnelVariants } from "./topologyTunnelVariants";

test("disabled exit balancing never invents extra topology branches", () => {
  const state = { truncated: false, incomplete: false };
  const tunnel = { mode: "tls", hopHostIds: [1,2,3], loadBalanceEnabled: false, loadBalanceStrategy: "round_robin", loadBalanceExits: [{ hostId: 4, isEnabled: true }] };
  assert.deepEqual(visibleTopologyTunnelVariants(tunnel, null, state), [[1,2,3]]);
  assert.deepEqual(visibleTopologyTunnelVariants({ ...tunnel, loadBalanceEnabled: true }, null, state), [[1,2,3],[1,2,4]]);
  assert.deepEqual(visibleTopologyTunnelVariants({ ...tunnel, loadBalanceEnabled: "false" }, null, state), [[1,2,3]]);
});

test("expands distinct entry and exit alternatives for a serial tunnel", () => {
  const result = topologyTunnelVariants({ hops: [1, 3, 4], entries: [1, 2], exits: [4, 5] });
  assert.deepEqual(result, [[1, 3, 4], [1, 3, 5], [2, 3, 4], [2, 3, 5]]);
});

test("relay failover candidates are alternatives, not sequential hops", () => {
  const result = topologyTunnelVariants({ hops: [1, 3, 4, 5], entries: [1], exits: [5, 6], relayFailover: true });
  assert.deepEqual(result, [[1, 3, 5], [1, 3, 6], [1, 4, 5], [1, 4, 6]]);
});

test("large parallel tunnel variants are bounded and reported", () => {
  const state = { truncated: false, incomplete: false };
  const paths = topologyTunnelVariants({ hops: [1, 1000], entries: Array.from({ length: 30 }, (_, i) => i + 1), exits: Array.from({ length: 30 }, (_, i) => i + 100), state });
  assert.equal(paths.length, 512);
  assert.equal(state.truncated, true);
});

test("does not fabricate direct edges when a route contains a cycle", () => {
  assert.deepEqual(topologyTunnelVariants({ hops: [1, 2, 1, 3] }), []);
  assert.deepEqual(topologyTunnelVariants({ hops: [1, 2, 3], exits: [2] }), []);
});
