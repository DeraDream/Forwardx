import assert from "node:assert/strict";
import test from "node:test";
import { formatTopologyBlockNotification, uniqueTopologyBlockTransitions } from "./topologyBlockNotifier";
import type { TopologySegmentIncidentTransition } from "./repositories/metricsRepository";

const blocked: TopologySegmentIncidentTransition = {
  incidentId: 11, userId: 1, sourceHostId: 4, type: "blocked",
  sourceName: "入口 <JP>", targetName: "出口 &SG", targetAddress: "203.0.113.1",
  failureStartedAt: new Date("2026-11-28T01:07:19Z"), occurredAt: new Date("2026-11-28T01:07:36Z"),
  recoveryLatencyMs: null,
};

test("topology block and recovery messages use confirmed incident times and escape names", () => {
  const text = formatTopologyBlockNotification(blocked);
  assert.match(text, /🔴 物理链路 · 已阻断/);
  assert.match(text, /连续探测失败：<b>17 秒<\/b>/);
  assert.match(text, /状态：已确认阻断/);
  assert.match(text, /入口 &lt;JP&gt; → 出口 &amp;SG/);
  assert.match(text, /目标：<code>203\.0\.113\.1<\/code>/);
  assert.doesNotMatch(text, /入口 <JP>/);
  const recovered = formatTopologyBlockNotification({ ...blocked, type: "recovered", occurredAt: new Date("2026-11-28T01:07:50Z"), recoveryLatencyMs: 94 });
  assert.match(recovered, /🟢 物理链路 · 已恢复/);
  assert.match(recovered, /阻断持续：<b>31 秒<\/b>/);
  assert.match(recovered, /恢复探测延迟：<b>94 ms<\/b>/);
  assert.doesNotMatch(formatTopologyBlockNotification({ ...blocked, type: "recovered", recoveryLatencyMs: null }), /恢复探测延迟/);
});

test("admin notifications deduplicate shared physical edges within one Agent report", () => {
  assert.deepEqual(uniqueTopologyBlockTransitions([
    blocked, { ...blocked, incidentId: 12, userId: 2 },
    { ...blocked, incidentId: 13, type: "recovered" },
    { ...blocked, incidentId: 14, targetAddress: "203.0.113.2" },
  ]).map((event) => event.incidentId), [11, 13, 14]);
});
