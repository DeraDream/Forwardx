import assert from "node:assert/strict";
import test from "node:test";
import { lowestEntryChainLatency } from "./repositories/metricsRepository";

test("chain card chooses the lowest complete entry path, not the sum of entries and relays", () => {
  const children = [
    { id: 132, hostId: 1 }, { id: 133, hostId: 2 }, { id: 134, hostId: 3 },
    { id: 135, hostId: 13 }, { id: 136, hostId: 14 },
  ];
  const at = new Date("2026-11-26T02:37:30Z");
  const rows = new Map(children.map((child, i) => [child.id, {
    latencyMs: [5, 35, 37, 44, 43][i], isTimeout: false, recordedAt: at,
  }]));
  assert.deepEqual(lowestEntryChainLatency(new Set([13, 14]), children, rows), {
    latencyMs: 43, isTimeout: false, recordedAt: at,
  });
  assert.equal(lowestEntryChainLatency(new Set([99]), children, rows), null);
});

test("a failed entry is not chosen over a healthy entry", () => {
  const children = [{ id: 135, hostId: 13 }, { id: 136, hostId: 14 }];
  const earlier = new Date("2026-11-26T02:37:26Z");
  const later = new Date("2026-11-26T02:37:30Z");
  assert.deepEqual(lowestEntryChainLatency(new Set([13, 14]), children, new Map([
    [135, { latencyMs: 44, isTimeout: false, recordedAt: earlier }],
    [136, { latencyMs: null, isTimeout: true, recordedAt: later }],
  ])), { latencyMs: 44, isTimeout: false, recordedAt: earlier });
  assert.deepEqual(lowestEntryChainLatency(new Set([13, 14]), children, new Map([
    [136, { latencyMs: null, isTimeout: true, recordedAt: later }],
  ])), { latencyMs: null, isTimeout: true, recordedAt: later });
});
