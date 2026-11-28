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
  assert.match(text, /持续 17 秒/);
  assert.match(text, /入口 &lt;JP&gt; → 出口 &amp;SG/);
  assert.doesNotMatch(text, /入口 <JP>/);
  const recovered = formatTopologyBlockNotification({ ...blocked, type: "recovered", occurredAt: new Date("2026-11-28T01:07:50Z"), recoveryLatencyMs: 94 });
  assert.match(recovered, /阻断共持续 31 秒，恢复延迟 94 ms/);
});

test("admin notifications deduplicate shared physical edges within one Agent report", () => {
  assert.deepEqual(uniqueTopologyBlockTransitions([
    blocked, { ...blocked, incidentId: 12, userId: 2 },
    { ...blocked, incidentId: 13, type: "recovered" },
    { ...blocked, incidentId: 14, targetAddress: "203.0.113.2" },
  ]).map((event) => event.incidentId), [11, 13, 14]);
});
