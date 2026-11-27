import assert from "node:assert/strict";
import test from "node:test";
import { linkSpeedAgentRequirement } from "./linkSpeedAgentCapability";

test("lightweight iptables agents use their supported speed protocol, not the latest standard Agent version", () => {
  assert.equal(linkSpeedAgentRequirement("2.2.248-iptables-only.1.0.7", "iptables").supported, true);
  assert.equal(linkSpeedAgentRequirement("2.2.248-iptables-only.1.0.0", "iptables").supported, true);
  assert.equal(linkSpeedAgentRequirement("2.2.245-iptables-only.1.0.0", "iptables").supported, false);
  assert.match(linkSpeedAgentRequirement("2.2.248-iptables-only.1.0.7", "listener").reason || "", /仅支持 iptables/);
});

test("standard agents are checked against stable per-entry-mode feature versions", () => {
  assert.equal(linkSpeedAgentRequirement("2.2.243", "listener").supported, true);
  assert.equal(linkSpeedAgentRequirement("2.2.242", "listener").supported, false);
  assert.equal(linkSpeedAgentRequirement("2.2.246", "iptables").supported, true);
  assert.equal(linkSpeedAgentRequirement("2.2.245", "iptables").supported, false);
  assert.equal(linkSpeedAgentRequirement(null, "iptables").supported, false);
});
