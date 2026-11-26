import assert from "node:assert/strict";
import test from "node:test";
import { supportsManagedLandingSS } from "./landingHostEligibility";

test("managed SS requires a standard Agent, not a lightweight or unregistered host", () => {
  assert.equal(supportsManagedLandingSS({ agentVersion: "2.4.139" }), true);
  assert.equal(supportsManagedLandingSS({ agentVersion: "2.4.139-iptables-only.1.0.2" }), false);
  assert.equal(supportsManagedLandingSS({ agentVersion: "2.4.139-iptables-only.dev" }), false);
  assert.equal(supportsManagedLandingSS({ agentVersion: "" }), false);
  assert.equal(supportsManagedLandingSS(null), false);
});
