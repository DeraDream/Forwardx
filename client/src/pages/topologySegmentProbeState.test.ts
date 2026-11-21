import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTopologySegmentProbeIds,
  latestAutomaticTopologySegment,
  mergeTopologySegmentProbeResults,
  summarizePhysicalTopologySegmentLabels,
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

test("automatic segment selection is scoped by rule, source and target and uses the newest sample", () => {
  const selected = latestAutomaticTopologySegment([
    { ruleId: 7, sourceHostId: 1, targetHostId: 2, targetAddress: "10.0.0.2", latencyMs: 20, recordedAt: "2026-01-01T00:00:00Z" },
    { ruleId: 8, sourceHostId: 1, targetHostId: 2, targetAddress: "10.0.0.2", latencyMs: 999, recordedAt: "2026-01-01T00:02:00Z" },
    { ruleId: 7, sourceHostId: 1, targetHostId: 2, targetAddress: "10.0.0.2", latencyMs: null, isTimeout: true, recordedAt: "2026-01-01T00:01:00Z" },
  ], { ruleIds: new Set([7]), sourceHostId: 1, targetHostId: 2, targetAddresses: ["10.0.0.2"] });
  assert.equal(selected?.isTimeout, true);
});

test("topology selection ignores newer legacy TCP rows when physical RTT requires ping", () => {
  const selected = latestAutomaticTopologySegment([
    { ruleId: 31, sourceHostId: 4, targetHostId: 5, targetAddress: "203.0.113.5", method: "ping", latencyMs: 2, recordedAt: 100 },
    { ruleId: 31, sourceHostId: 4, targetHostId: 5, targetAddress: "203.0.113.5", method: "tcp", latencyMs: 202, recordedAt: 200 },
  ], { ruleIds: new Set([31]), sourceHostId: 4, targetHostId: 5, targetAddresses: ["203.0.113.5"], method: "ping" });
  assert.equal(selected?.latencyMs, 2);
});

test("automatic external target segments can be matched by address", () => {
  const selected = latestAutomaticTopologySegment([
    { ruleId: 7, sourceHostId: 1, targetHostId: null, targetAddress: "edge.example.com", latencyMs: 18, recordedAt: 10 },
  ], { ruleIds: new Set([7]), sourceHostId: 1, targetHostId: 0, targetAddresses: ["EDGE.EXAMPLE.COM"] });
  assert.equal(selected?.latencyMs, 18);
});

test("a downstream route failure cannot mark a concurrently successful shared physical leg as timeout", () => {
  assert.equal(summarizePhysicalTopologySegmentLabels([
    { at: 10_000, pending: false, success: false, label: "超时" },
    { at: 9_800, pending: false, success: true, label: "45 ms" },
  ], "待探测"), "45 ms");
});

test("a newer physical-leg failure replaces an old success from a previous burst", () => {
  assert.equal(summarizePhysicalTopologySegmentLabels([
    { at: 20_000, pending: false, success: false, label: "超时" },
    { at: 10_000, pending: false, success: true, label: "45 ms" },
  ], "待探测"), "超时");
});

test("path total is the sum of the displayed segment snapshot", () => {
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "33 ms", "1 ms"]), { pending: false, timeout: false, blocked: false, offline: false, latencyMs: 71 });
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "探测中", "1 ms"]), { pending: true, timeout: false, blocked: false, offline: false, latencyMs: null });
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "超时"]), { pending: false, timeout: true, blocked: false, offline: false, latencyMs: null });
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "阻断"]), { pending: false, timeout: true, blocked: true, offline: false, latencyMs: null });
  assert.deepEqual(summarizeTopologySegmentLabels(["37 ms", "离线"]), { pending: false, timeout: true, blocked: true, offline: true, latencyMs: null });
});
