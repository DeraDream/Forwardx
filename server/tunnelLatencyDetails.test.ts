import assert from "node:assert/strict";
import test from "node:test";
import {
  selectTunnelLatencyDetailPathKey,
  structuredTunnelMessageMatchesLatency,
  tunnelLatencySampleIsAfterBaseline,
  tunnelDetailHostEdges,
  tunnelDetailsMatchTopology,
  tunnelLatencyProbeSourceHostIds,
} from "./tunnelLatencyDetails";

test("latest total latency selects the matching branch from the same sample batch", () => {
  const recordedAt = new Date("2026-07-31T10:00:00.000Z");
  assert.equal(selectTunnelLatencyDetailPathKey({
    seriesKey: "total",
    latencyMs: 48,
    isTimeout: false,
    recordedAt,
  }, [
    { seriesKey: "primary", latencyMs: 21, isTimeout: false, recordedAt },
    { seriesKey: "exit-2", latencyMs: 48, isTimeout: false, recordedAt },
    { seriesKey: "exit-3", latencyMs: 48, isTimeout: false, recordedAt: new Date(recordedAt.getTime() - 60_000) },
  ]), "exit-2");

  assert.equal(selectTunnelLatencyDetailPathKey({
    seriesKey: "total",
    latencyMs: null,
    isTimeout: true,
    recordedAt,
  }, [
    { seriesKey: "relay-2", latencyMs: null, isTimeout: true, recordedAt },
    { seriesKey: "relay-1", latencyMs: null, isTimeout: true, recordedAt },
  ]), "relay-1");
});

test("relay plus exit selects the exact path that formed the total", () => {
  const recordedAt = new Date("2026-07-31T10:00:00.000Z");
  const selected = selectTunnelLatencyDetailPathKey({ seriesKey: "total", latencyMs: 27, isTimeout: false, recordedAt }, [
    { seriesKey: "exit-2", latencyMs: 27, isTimeout: false, recordedAt },
    { seriesKey: "relay-branch-21-40", latencyMs: 27, isTimeout: false, recordedAt },
    { seriesKey: "relay-branch-20-40", latencyMs: null, isTimeout: true, recordedAt },
  ]);
  assert.equal(selected, "relay-branch-21-40");
});

test("structured fallback must belong to the current latency sample", () => {
  const recordedAt = new Date("2026-07-31T10:00:00.000Z");
  assert.equal(structuredTunnelMessageMatchesLatency("2026-07-31T09:59:30.000Z", recordedAt), true);
  assert.equal(structuredTunnelMessageMatchesLatency("2026-07-31T09:59:29.999Z", recordedAt), false);
  assert.equal(structuredTunnelMessageMatchesLatency(undefined, recordedAt), false);
});

test("a timed-out refresh cannot reuse its baseline latency row", () => {
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 41 }, 41), false);
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 42 }, 41), true);
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 40 }, 41), false);
  assert.equal(tunnelLatencySampleIsAfterBaseline({ id: 42 }, 0), true);
  assert.equal(tunnelLatencySampleIsAfterBaseline(undefined, 41), false);
});

test("explicit detail host ids take precedence over stale labels", () => {
  assert.deepEqual(tunnelDetailHostEdges([{
    fromHostId: 10,
    toHostId: 20,
    hopLabel: "1/1 90->91",
    routeLabel: "old 90 -> 91",
  }]), [[10, 20]]);
});

test("relay failover validates complete candidate paths instead of a linear relay chain", () => {
  const tunnel = {
    id: 71,
    mode: "forwardx",
    relayMode: "failover",
    entryHostId: 10,
    exitHostId: 40,
  };
  const hops = [
    { hostId: 10 },
    { hostId: 20 },
    { hostId: 30 },
    { hostId: 40 },
  ];
  assert.equal(tunnelDetailsMatchTopology({
    tunnel,
    hops,
    entryHostIds: [10, 11],
    details: [
      { fromHostId: 11, toHostId: 30, hopLabel: "stale 10->20" },
      { fromHostId: 30, toHostId: 40 },
    ],
  }), true);
  assert.equal(tunnelDetailsMatchTopology({
    tunnel,
    hops,
    entryHostIds: [10, 11],
    details: [
      { fromHostId: 10, toHostId: 20 },
      { fromHostId: 20, toHostId: 30 },
      { fromHostId: 30, toHostId: 40 },
    ],
  }), false);
  assert.equal(tunnelDetailsMatchTopology({
    tunnel,
    hops,
    entryHostIds: [10, 11],
    details: [
      { fromHostId: 10, toHostId: 20 },
      { fromHostId: 30, toHostId: 40 },
    ],
  }), false);
});

test("relay failover details may end at an enabled alternate exit", () => {
  const tunnel = { mode: "forwardx", relayMode: "failover", entryHostId: 10, exitHostId: 40, loadBalanceEnabled: true, loadBalanceStrategy: "round_robin" };
  const hops = [{ hostId: 10 }, { hostId: 20 }, { hostId: 30 }, { hostId: 40 }];
  const exitNodes = [{ hostId: 50, listenPort: 10050, isEnabled: true }];
  assert.equal(tunnelDetailsMatchTopology({ tunnel, hops, exitNodes, details: [{ fromHostId: 10, toHostId: 30 }, { fromHostId: 30, toHostId: 50 }] }), true);
  assert.equal(tunnelDetailsMatchTopology({ tunnel, hops, exitNodes, details: [{ fromHostId: 10, toHostId: 20 }, { fromHostId: 30, toHostId: 50 }] }), false);
});

test("multi-hop branch details accept a complete alternate path but reject unrelated or incomplete paths", () => {
  const tunnel = { entryHostId: 10, exitHostId: 30, loadBalanceEnabled: true, loadBalanceStrategy: "round_robin" };
  const hops = [{ hostId: 10 }, { hostId: 20 }, { hostId: 30 }];
  const exitNodes = [{ hostId: 40, listenPort: 10040, isEnabled: true }];
  const check = (details: any[]) => tunnelDetailsMatchTopology({ tunnel, hops, exitNodes, details });
  assert.equal(check([{ fromHostId: 10, toHostId: 20 }, { fromHostId: 20, toHostId: 40 }]), true);
  assert.equal(check([{ fromHostId: 10, toHostId: 20 }, { fromHostId: 20, toHostId: 30 }, { fromHostId: 20, toHostId: 40 }]), true);
  assert.equal(check([{ fromHostId: 10, toHostId: 20 }, { fromHostId: 20, toHostId: 50 }]), false);
  assert.equal(check([{ fromHostId: 20, toHostId: 40 }]), false);
});

test("a forced tunnel refresh targets entries and relay sources but not exits", () => {
  const hops = [
    { hostId: 10 },
    { hostId: 20 },
    { hostId: 30 },
    { hostId: 40 },
  ];
  assert.deepEqual(tunnelLatencyProbeSourceHostIds([10, 11], hops), [10, 11, 20, 30]);
  assert.deepEqual(tunnelLatencyProbeSourceHostIds([10, 11], []), [10, 11]);
});
