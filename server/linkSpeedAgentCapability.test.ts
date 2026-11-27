import assert from "node:assert/strict";
import test from "node:test";
import { linkSpeedAgentRequirement } from "./linkSpeedAgentCapability";

test("all lightweight agents reject full-link speed clients regardless of version or entry mode", () => {
  for (const version of ["2.2.248-iptables-only.1.0.7", "2.2.248-iptables-only.1.0.0"]) {
    for (const mode of ["iptables", "listener"] as const) {
      assert.match(linkSpeedAgentRequirement(version, mode).reason || "", /轻量 Agent 不支持全链路测速/);
    }
  }
});

test("standard agents are checked against stable per-entry-mode feature versions", () => {
  assert.equal(linkSpeedAgentRequirement("2.2.243", "listener").supported, true);
  assert.equal(linkSpeedAgentRequirement("2.2.242", "listener").supported, false);
  assert.equal(linkSpeedAgentRequirement("2.2.246", "iptables").supported, true);
  assert.equal(linkSpeedAgentRequirement("2.2.245", "iptables").supported, false);
  assert.equal(linkSpeedAgentRequirement(null, "iptables").supported, false);
});
