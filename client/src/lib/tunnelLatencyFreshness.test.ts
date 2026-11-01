import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isFreshTunnelLatency } from "./tunnelLatencyFreshness";

test("old, missing and implausibly future samples are not current health", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  assert.equal(isFreshTunnelLatency(new Date(now - 120_000), now), true);
  assert.equal(isFreshTunnelLatency(new Date(now - 120_001), now), false);
  assert.equal(isFreshTunnelLatency(null, now), false);
  assert.equal(isFreshTunnelLatency(new Date(now + 30_001), now), false);
});
