import assert from "node:assert/strict";
import test from "node:test";
import { aggregateAgentLinkPathRound } from "./agentLinkAggregation";
import { buildAgentLinkEdgeKey, normalizeAgentLinkProbeSample, parseAgentLinkEdgeKey } from "./agentLink";

function sample(edgeKey: string, latencyMs: number | null, round = "round-1") {
  return {
    edgeKey,
    sourceHostId: edgeKey === "edge-a" ? 1 : 2,
    targetHostId: edgeKey === "edge-a" ? 2 : 3,
    targetAddress: edgeKey === "edge-a" ? "198.51.100.2" : "198.51.100.3",
    targetPort: 9811,
    transport: "tcp" as const,
    probeRoundId: round,
    latencyMs,
    isTimeout: latencyMs === null,
    probeCount: 3,
    probeSuccesses: latencyMs === null ? 0 : 3,
  };
}

test("Agent Link key includes directed endpoints, address, port and transport", () => {
  assert.equal(buildAgentLinkEdgeKey({
    sourceHostId: 12,
    targetHostId: 25,
    targetAddress: "[2001:DB8::8]",
    targetPort: 9811,
    transport: "udp",
  }), "agent-link-v1:12:25:2001%3Adb8%3A%3A8:9811:udp");
});

test("parses only canonical Agent Link edge keys", () => {
  assert.deepEqual(parseAgentLinkEdgeKey("agent-link-v1:12:25:2001%3Adb8%3A%3A8:9811:udp"), {
    sourceHostId: 12,
    targetHostId: 25,
    targetAddress: "2001:db8::8",
    targetPort: 9811,
    transport: "udp",
  });
  assert.equal(parseAgentLinkEdgeKey("agent-link-v1:12:25:2001:db8::8:9811:udp"), null);
  assert.equal(parseAgentLinkEdgeKey("agent-link-v1:12:25:%E0%A4%A:9811:udp"), null);
});

test("normalizes Agent Link samples with probe counters as timeout authority", () => {
  const normalized = normalizeAgentLinkProbeSample({
    sourceHostId: 1,
    targetHostId: 2,
    targetAddress: "Example.COM",
    targetPort: 9811,
    transport: "tcp",
    probeRoundId: "round-1",
    latencyMs: 12.4,
    isTimeout: true,
    probeCount: 3,
    probeSuccesses: 2,
  });
  assert.ok(normalized);
  assert.equal(normalized.isTimeout, false);
  assert.equal(normalized.latencyMs, 12);
  assert.equal(normalized.targetAddress, "example.com");
});

test("path aggregate succeeds only with every required edge from the same round", () => {
  const ok = aggregateAgentLinkPathRound(["edge-a", "edge-b"], [sample("edge-a", 3), sample("edge-b", 7)]);
  assert.equal(ok.status, "success");
  assert.equal(ok.latencyMs, 10);

  const missing = aggregateAgentLinkPathRound(["edge-a", "edge-b"], [sample("edge-a", 3)]);
  assert.equal(missing.status, "timeout");
  assert.deepEqual(missing.missingEdgeKeys, ["edge-b"]);

  const timeout = aggregateAgentLinkPathRound(["edge-a", "edge-b"], [sample("edge-a", 3), sample("edge-b", null)]);
  assert.equal(timeout.status, "timeout");
  assert.deepEqual(timeout.timeoutEdgeKeys, ["edge-b"]);

  assert.throws(
    () => aggregateAgentLinkPathRound(["edge-a", "edge-b"], [sample("edge-a", 3, "round-1"), sample("edge-b", 7, "round-2")]),
    /one probeRoundId/,
  );
});
