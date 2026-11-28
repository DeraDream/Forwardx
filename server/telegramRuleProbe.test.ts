import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTelegramRuleProbeResult } from "./telegramRuleProbe";

test("manual TCP probe reports pending, latency, timeout, and never invents a value", () => {
  assert.match(formatTelegramRuleProbeResult(7, "入口<&>", { status: "pending" }), /入口&lt;&amp;&gt;.*探测中/s);
  assert.match(formatTelegramRuleProbeResult(7, "入口", { status: "success", latencyMs: 12 }), /TCP 延迟：<b>12 ms<\/b>/);
  assert.match(formatTelegramRuleProbeResult(7, "入口", { status: "success", latencyMs: null }), /未返回延迟值/);
  assert.match(formatTelegramRuleProbeResult(7, "入口", { status: "timeout" }), /探测超时.*无有效延迟/);
});
