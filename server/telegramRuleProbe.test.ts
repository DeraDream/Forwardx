import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRuleDetailLatency, formatTelegramRuleProbeResult, selectRuleProbeCompletion } from "./telegramRuleProbe";

test("manual TCP probe reports pending, latency, timeout, and never invents a value", () => {
  assert.match(formatTelegramRuleProbeResult(7, "入口<&>", { status: "pending" }), /入口&lt;&amp;&gt;.*探测中/s);
  assert.match(formatTelegramRuleProbeResult(7, "入口", { status: "success", latencyMs: 12 }), /TCP 延迟：<b>12 ms<\/b>/);
  assert.match(formatTelegramRuleProbeResult(7, "入口", { status: "success", latencyMs: null }), /未返回延迟值/);
  assert.match(formatTelegramRuleProbeResult(7, "入口", { status: "timeout" }), /探测超时.*无有效延迟/);
});

test("rule detail shows cached latency, pending state and the completed manual result distinctly", () => {
  const cached = { latestLatencyMs: 53, latestLatencyIsTimeout: false };
  assert.equal(formatRuleDetailLatency(cached), "53 ms（最近记录）");
  assert.equal(formatRuleDetailLatency(cached, { status: "pending" }), "⏳ 探测中");
  assert.equal(formatRuleDetailLatency(cached, { status: "success", latencyMs: 44 }), "44 ms（本次探测）");
  assert.equal(formatRuleDetailLatency(cached, { status: "timeout" }), "本次探测超时");
  assert.equal(formatRuleDetailLatency(cached, { status: "unreported" }), "等待探测报告超时");
  assert.equal(formatRuleDetailLatency({ latestLatencyIsTimeout: true }), "最近一次探测超时");
});

test("chain self-test waits for its aggregate instead of showing one hop's latency", () => {
  const hop = { status: "success", latencyMs: 5, message: '{"kind":"forward-chain"}' };
  const aggregate = { status: "success", latencyMs: 58, message: '{"kind":"forward-chain-hop-summary","batchId":"fgr-1"}' };
  assert.equal(selectRuleProbeCompletion([hop], 2), null);
  assert.equal(selectRuleProbeCompletion([hop, { ...hop, latencyMs: 6 }], 2), null);
  assert.deepEqual(selectRuleProbeCompletion([hop, aggregate], 2), aggregate);
  assert.deepEqual(selectRuleProbeCompletion([hop], 1), hop);
});
