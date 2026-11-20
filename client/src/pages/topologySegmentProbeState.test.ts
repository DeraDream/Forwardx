import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTopologySegmentProbeIds,
  mergeTopologySegmentProbeResults,
  summarizeTopologySegmentLabels,
  topologySegmentProbeKey,
  type TopologySegmentProbe,
} from "./topologySegmentProbeState";

const probe = (testId: number, status: string, requestedAt: number, latencyMs: number | null = null): TopologySegmentProbe => ({
  ruleId: 7,
  testId,
  status,
  success: status === "success",
  latencyMs,
  requestedAt,
});

test("segment probe identity is isolated by complete logical path", () => {
  assert.notEqual(
    topologySegmentProbeKey("rule:7:0", "host:1=>host:2"),
    topologySegmentProbeKey("rule:7:1", "host:1=>host:2"),
  );
});

test("starting or polling one segment never clears completed unrelated segments", () => {
  const current = {
    first: probe(11, "success", 1, 32),
    second: probe(12, "pending", 2),
  };
  const next = mergeTopologySegmentProbeResults(current, [{ id: 12, status: "running", success: false, latencyMs: null }]);
  assert.deepEqual(next.first, current.first);
  assert.equal(next.second.status, "running");
  assert.equal(next.second.latencyMs, null);
});

test("only active jobs are polled and completed snapshots remain local", () => {
  const ids = activeTopologySegmentProbeIds({
    completed: probe(10, "success", 1, 25),
    failed: probe(11, "failed", 2),
    pending: probe(12, "pending", 3),
    running: probe(13, "running", 4),
  });
  assert.deepEqual(ids, [12, 13]);
});

test("path total is the sum of the displayed segment snapshot", () => {
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "33 ms", "1 ms"]), { pending: false, timeout: false, latencyMs: 71 });
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "探测中", "1 ms"]), { pending: true, timeout: false, latencyMs: null });
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "超时"]), { pending: false, timeout: true, latencyMs: null });
});
