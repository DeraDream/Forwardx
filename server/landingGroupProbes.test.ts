import assert from "node:assert/strict";
import test from "node:test";
import { landingGroupPathHealthAt, LANDING_GROUP_PROBE_TTL_MS } from "./landingGroupProbes";

const now = Date.now();
const service = { id: 10, endpoint: "198.51.100.10", port: 32123 };
const sample = (sourceHostId: number, isTimeout = false, checkedAt = new Date(now)) => ({ serviceId: 10, sourceHostId, targetIp: service.endpoint, targetPort: service.port, isTimeout, checkedAt });

test("entry-to-SS probes require fresh matches from every bound entry", () => {
  assert.equal(landingGroupPathHealthAt([sample(1), sample(2)], service, [1, 2], now), true);
  assert.equal(landingGroupPathHealthAt([sample(1)], service, [1, 2], now), null);
  assert.equal(landingGroupPathHealthAt([sample(1), sample(2, true)], service, [1, 2], now), false);
  assert.equal(landingGroupPathHealthAt([sample(1, false, new Date(now - LANDING_GROUP_PROBE_TTL_MS - 1))], service, [1], now), null);
  assert.equal(landingGroupPathHealthAt([{ ...sample(1), targetPort: 32124 }], service, [1], now), null);
  assert.equal(landingGroupPathHealthAt([{ ...sample(1), targetIp: "198.51.100.11" }], service, [1], now), null);
  assert.equal(landingGroupPathHealthAt([sample(1)], service, [], now), null);
});
