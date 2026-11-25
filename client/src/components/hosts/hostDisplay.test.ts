import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, formatHostAgentVersion, isAgentVersionBehind } from "./hostDisplay";

test("formatBytes clamps values at the largest supported unit", () => {
  assert.equal(formatBytes(1024 ** 5), "1 PB");
  assert.equal(formatBytes(1024 ** 6), "1024 PB");
});

test("standalone Agent badge is short without changing the reported version", () => {
  assert.equal(formatHostAgentVersion("2.2.248-iptables-only.1.0.2"), "Lite v1.0.2");
  assert.equal(formatHostAgentVersion("2.2.248"), "v2.2.248");
  assert.equal(formatHostAgentVersion(null), "未上报");
});

test("standalone iptables Agent is excluded from standard update checks", () => {
  assert.equal(isAgentVersionBehind("2.2.248-iptables-only.1.0.0", "2.2.249"), false);
  assert.equal(isAgentVersionBehind("2.2.248", "2.2.249"), true);
});

test("formatBytes handles non-finite values", () => {
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
});
