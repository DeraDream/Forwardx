import assert from "node:assert/strict";
import test from "node:test";
import { calculateLinkQuality, filterLinkQualitySamples } from "./linkQuality";

test("calculateLinkQuality summarizes successful samples and percentiles", () => {
  const base = Date.parse("2026-09-30T00:00:00Z");
  const stats = calculateLinkQuality([
    { recordedAt: base, latencyMs: 20, isTimeout: false },
    { recordedAt: base + 60_000, latencyMs: 30, isTimeout: false },
    { recordedAt: base + 120_000, latencyMs: 40, isTimeout: false },
    { recordedAt: base + 180_000, latencyMs: 50, isTimeout: false },
  ]);

  assert.equal(stats.total, 4);
  assert.equal(stats.success, 4);
  assert.equal(stats.timeout, 0);
  assert.equal(stats.availability, 100);
  assert.equal(stats.average, 35);
  assert.equal(stats.p50, 35);
  assert.equal(stats.min, 20);
  assert.equal(stats.max, 50);
  assert.equal(stats.jitter, 10);
  assert.equal(stats.currentLatency, 50);
  assert.equal(stats.currentIsTimeout, false);
});

test("calculateLinkQuality counts timeouts and consecutive failures", () => {
  const base = Date.parse("2026-09-30T00:00:00Z");
  const stats = calculateLinkQuality([
    { recordedAt: base, latencyMs: 25, isTimeout: false },
    { recordedAt: base + 60_000, latencyMs: null, isTimeout: true },
    { recordedAt: base + 120_000, latencyMs: null, isTimeout: true },
  ]);

  assert.equal(stats.total, 3);
  assert.equal(stats.success, 1);
  assert.equal(stats.timeout, 2);
  assert.equal(stats.timeoutRate, 66.7);
  assert.equal(stats.availability, 33.3);
  assert.equal(stats.currentIsTimeout, true);
  assert.equal(stats.currentLatency, null);
  assert.equal(stats.consecutiveFailures, 2);
  assert.equal(stats.status, "degraded");
});

test("filterLinkQualitySamples keeps only requested time window", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const rows = filterLinkQualitySamples([
    { recordedAt: now - 30 * 60_000, latencyMs: 20 },
    { recordedAt: now - 2 * 60 * 60_000, latencyMs: 30 },
  ], 1, now);

  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].latencyMs), 20);
});

test("calculateLinkQuality reports no-data for an empty series", () => {
  const stats = calculateLinkQuality([]);
  assert.equal(stats.status, "no-data");
  assert.equal(stats.total, 0);
  assert.equal(stats.availability, null);
});
