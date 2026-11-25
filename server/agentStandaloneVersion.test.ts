import assert from "node:assert/strict";
import test from "node:test";
import { isAgentVersionAtLeast, isAgentVersionBehind, isIptablesOnlyAgentVersion } from "./agentRouteUtils";

test("iptables-only agent retains protocol capability but uses a separate upgrade channel", () => {
  const standalone = "2.2.248-iptables-only.1.0.0";
  assert.equal(isIptablesOnlyAgentVersion(standalone), true);
  assert.equal(isAgentVersionAtLeast(standalone, "2.2.200"), true);
  assert.equal(isAgentVersionBehind(standalone, "2.2.249"), false);
  assert.equal(isAgentVersionBehind("2.2.248", "2.2.249"), true);
  assert.equal(isIptablesOnlyAgentVersion("2.2.248"), false);
});
