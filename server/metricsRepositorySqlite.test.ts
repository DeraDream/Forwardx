import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("SQLite host metric summaries seek only the latest two rows per host", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const metrics = await import("./repositories/metricsRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-metrics-"));
  const databasePath = path.join(directory, "metrics.db");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    await ensureDatabaseSchema();
    let queueYielded = false;
    setImmediate(() => { queueYielded = true; });
    await Promise.all(Array.from({ length: 200 }, () => runtime.queryRaw("SELECT 1")));
    assert.equal(queueYielded, true, "a busy SQLite queue must periodically yield to timers and HTTP work");

    const now = Math.floor(Date.now() / 1000);
    await runtime.withSqliteExclusive((sqlite) => {
      const insert = sqlite.prepare(
        `INSERT INTO host_metrics (hostId, cpuUsage, networkIn, networkOut, recordedAt)
         VALUES (?, ?, ?, ?, ?)`,
      );
      sqlite.transaction(() => {
        insert.run(1, 10, 100, 200, now - 10);
        insert.run(1, 20, 130, 250, now);
        insert.run(2, 30, 500, 700, now - 20);
        insert.run(2, 40, 560, 760, now);
        for (let hostId = 1_000; hostId <= 1_100; hostId += 1) {
          insert.run(hostId, 1, hostId, hostId, now);
        }
        for (let index = 0; index < 2_100; index += 1) {
          insert.run(99, 1, index, index, now - 100 * 60 * 60 - index);
        }
      })();
    });

    const summaries = await metrics.getLatestHostMetricRows([2, 1]);
    assert.equal(summaries.length, 2);
    const first = summaries.find((row: any) => Number(row.hostId) === 1) as any;
    assert.equal(first.cpuUsage, 20);
    assert.equal(first.networkSpeedIn, 3);
    assert.equal(first.networkSpeedOut, 5);

    const snapshots = await metrics.getLatestHostMetricSnapshots([1, 2]);
    assert.deepEqual(
      snapshots.map((row) => [row.hostId, row.rn]),
      [[1, 1], [1, 2], [2, 1], [2, 2]],
    );

    const reverseHostIds = Array.from({ length: 101 }, (_, index) => 1_100 - index);
    const crossBatchSnapshots = await metrics.getLatestHostMetricSnapshots(reverseHostIds);
    assert.deepEqual(
      crossBatchSnapshots.map((row) => row.hostId),
      [...reverseHostIds].sort((a, b) => a - b),
      "SQLite metric batches must preserve the previous global host ordering",
    );

    const plan = await runtime.queryRaw<{ detail?: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id, hostId, recordedAt FROM host_metrics
        WHERE hostId = ?
        ORDER BY recordedAt DESC, id DESC
        LIMIT 2`,
      [1],
    );
    assert.match(plan.map((row) => String(row.detail || "")).join(" | "), /idx_host_metrics_hostId_recordedAt/i);

    const segmentRecordedAt = new Date((now - 10) * 1000);
    await metrics.recordTopologySegmentLatency([
      {
        ruleId: 1, sourceHostId: 1, targetHostId: 2,
        targetAddress: "198.51.100.2", targetPort: 443, segmentKey: "topology-v1:1:198.51.100.2:443:tcp",
        method: "tcp", latencyMs: 20, isTimeout: false, probeCount: 2, probeSuccesses: 2,
        recordedAt: segmentRecordedAt,
      },
      {
        ruleId: 1, sourceHostId: 1, targetHostId: 2,
        targetAddress: "198.51.100.2", targetPort: 443, segmentKey: "topology-v1:1:198.51.100.2:443:tcp",
        method: "tcp", latencyMs: null, isTimeout: true, probeCount: 2, probeSuccesses: 0,
        recordedAt: new Date((now - 5) * 1000),
      },
      {
        ruleId: 1, sourceHostId: 1, targetHostId: 2,
        targetAddress: "198.51.100.2", targetPort: 443, segmentKey: "topology-v1:1:198.51.100.2:443:tcp",
        method: "tcp", latencyMs: 40, isTimeout: false, probeCount: 2, probeSuccesses: 1,
        recordedAt: new Date(now * 1000),
      },
    ]);
    const segments = await metrics.getLatestTopologySegmentLatency([1]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].targetHostId, 2);
    assert.equal(segments[0].latencyMs, 40);
    assert.equal(segments[0].sampleCount, 1);
    assert.equal(segments[0].successRate, 0.5);
    assert.equal(segments[0].jitterMs, null);
    assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS count FROM topology_segment_latest'))[0].count, 1);
    assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS count FROM topology_segment_latency_stats'))[0].count, 0);

    await metrics.recordTopologySegmentLatency([{
      ruleId: 2, sourceHostId: 1, targetHostId: 2,
      targetAddress: "198.51.100.2", targetPort: 443, segmentKey: "topology-v1:1:198.51.100.2:443:tcp",
      method: "tcp", latencyMs: 55, isTimeout: false, recordedAt: new Date((now + 1) * 1000),
    }]);
    const sharedSegments = await metrics.getLatestTopologySegmentLatency([1, 2]);
    assert.deepEqual(sharedSegments.map((segment) => [segment.ruleId, segment.latencyMs]).sort((a, b) => Number(a[0]) - Number(b[0])), [[1, 40], [2, 55]]);
    const recentOnly = await metrics.getLatestTopologySegmentLatency([1, 2], now + 1);
    assert.deepEqual(recentOnly.map((segment) => [segment.ruleId, segment.latencyMs]), [[2, 55]]);

    const pingKey = "topology-v1:1:198.51.100.9:0:ping";
    await metrics.recordTopologySegmentLatency([
      { ruleId: 3, sourceHostId: 1, targetAddress: "198.51.100.9", targetPort: 0, segmentKey: pingKey, method: "ping", latencyMs: 8, isTimeout: false, recordedAt: new Date((now - 30) * 1000) },
      { ruleId: 3, sourceHostId: 1, targetAddress: "198.51.100.9", targetPort: 0, segmentKey: pingKey, method: "ping", latencyMs: null, isTimeout: true, recordedAt: new Date((now - 10) * 1000) },
      { ruleId: 3, sourceHostId: 1, targetAddress: "198.51.100.9", targetPort: 0, segmentKey: pingKey, method: "ping", latencyMs: null, isTimeout: true, recordedAt: new Date((now - 6) * 1000) },
      { ruleId: 3, sourceHostId: 1, targetAddress: "198.51.100.9", targetPort: 0, segmentKey: pingKey, method: "ping", latencyMs: null, isTimeout: true, recordedAt: new Date((now - 2) * 1000) },
    ]);
    const graceSegment = (await metrics.getLatestTopologySegmentLatency([3]))[0];
    assert.equal(graceSegment.blocked, false);
    assert.equal(graceSegment.isTimeout, false);
    assert.equal(graceSegment.latencyMs, 8);
    const blockedPingKey = "topology-v1:1:198.51.100.10:0:ping";
    await metrics.recordTopologySegmentLatency([
      { ruleId: 4, sourceHostId: 1, targetAddress: "198.51.100.10", targetPort: 0, segmentKey: blockedPingKey, method: "ping", latencyMs: 9, isTimeout: false, recordedAt: new Date((now - 40) * 1000) },
      { ruleId: 4, sourceHostId: 1, targetAddress: "198.51.100.10", targetPort: 0, segmentKey: blockedPingKey, method: "ping", latencyMs: null, isTimeout: true, recordedAt: new Date((now - 20) * 1000) },
      { ruleId: 4, sourceHostId: 1, targetAddress: "198.51.100.10", targetPort: 0, segmentKey: blockedPingKey, method: "ping", latencyMs: null, isTimeout: true, recordedAt: new Date((now - 10) * 1000) },
      { ruleId: 4, sourceHostId: 1, targetAddress: "198.51.100.10", targetPort: 0, segmentKey: blockedPingKey, method: "ping", latencyMs: null, isTimeout: true, recordedAt: new Date(now * 1000) },
    ]);
    const blockedSegment = (await metrics.getLatestTopologySegmentLatency([4]))[0];
    assert.equal(blockedSegment.blocked, true);
    assert.equal(blockedSegment.isTimeout, true);
    const blockedDelta = (await metrics.getLatestTopologySegmentLatency([4], now - 1))[0];
    assert.equal(blockedDelta.blocked, true);
    assert.equal(blockedDelta.isTimeout, true);
    const duplicateSecondKey = "topology-v1:1:198.51.100.20:0:ping";
    await metrics.recordTopologySegmentLatency([
      { ruleId: 5, sourceHostId: 1, targetAddress: "198.51.100.20", segmentKey: duplicateSecondKey, method: "ping", latencyMs: 11, isTimeout: false, recordedAt: new Date(now * 1000) },
      { ruleId: 5, sourceHostId: 1, targetAddress: "198.51.100.20", segmentKey: duplicateSecondKey, method: "ping", latencyMs: 12, isTimeout: false, recordedAt: new Date(now * 1000) },
    ]);
    const sameSecond = await metrics.getLatestTopologySegmentLatency([5], now - 1);
    assert.equal(sameSecond.length, 1);
    assert.equal(sameSecond[0].latencyMs, 12);

    const incidentBase = {
      ruleId: 7, userId: 1, sourceHostId: 1, sourceName: "Source", targetHostId: 2,
      targetName: "Target", targetAddress: "198.51.100.77", targetPort: 0,
      segmentKey: "topology-v1:1:198.51.100.77:0:ping", method: "ping" as const,
      probeCount: 1,
    };
    assert.deepEqual(await metrics.updateTopologySegmentIncidents([{ ...incidentBase, latencyMs: null, isTimeout: true, probeSuccesses: 0, recordedAt: new Date((now - 20) * 1000) }]), []);
    const blockedTransitions = await metrics.updateTopologySegmentIncidents([{ ...incidentBase, latencyMs: null, isTimeout: true, probeSuccesses: 0, recordedAt: new Date(now * 1000) }]);
    assert.deepEqual(blockedTransitions.map((event) => event.type), ["blocked"]);
    assert.equal(blockedTransitions[0].incidentId > 0, true);
    assert.deepEqual(await metrics.updateTopologySegmentIncidents([{ ...incidentBase, latencyMs: null, isTimeout: true, probeSuccesses: 0, recordedAt: new Date(now * 1000) }]), []);
    const activeIncidentLogs = await metrics.getTopologyBlockLogs({ userId: 1 });
    assert.equal(activeIncidentLogs.length, 1);
    assert.equal(activeIncidentLogs[0].type, "blocked");
    assert.equal(activeIncidentLogs[0].recoveredAt, null);
    const recoveredTransitions = await metrics.updateTopologySegmentIncidents([{ ...incidentBase, latencyMs: 6, isTimeout: false, probeSuccesses: 1, recordedAt: new Date((now + 5) * 1000) }]);
    assert.deepEqual(recoveredTransitions.map((event) => event.type), ["recovered"]);
    assert.equal(recoveredTransitions[0].incidentId, blockedTransitions[0].incidentId);
    assert.deepEqual(await metrics.updateTopologySegmentIncidents([{ ...incidentBase, latencyMs: 6, isTimeout: false, probeSuccesses: 1, recordedAt: new Date((now + 5) * 1000) }]), []);
    const recoveredIncidentLogs = await metrics.getTopologyBlockLogs({ userId: 1 });
    assert.deepEqual(recoveredIncidentLogs.map((entry) => entry.type), ["recovered", "blocked"]);
    assert.equal(recoveredIncidentLogs[0].recoveryLatencyMs, 6);
    const transientBase = { ...incidentBase, userId: 2, segmentKey: "topology-v1:1:198.51.100.78:0:ping", targetAddress: "198.51.100.78" };
    await metrics.updateTopologySegmentIncidents([{ ...transientBase, latencyMs: null, isTimeout: true, probeSuccesses: 0, recordedAt: new Date(now * 1000) }]);
    assert.deepEqual(await metrics.updateTopologySegmentIncidents([{ ...transientBase, latencyMs: 7, isTimeout: false, probeSuccesses: 1, recordedAt: new Date((now + 5) * 1000) }]), []);
    assert.equal((await metrics.getTopologyBlockLogs({ userId: 2 })).length, 0);

    await metrics.cleanOldHostMetrics(72);
    const [{ count }] = await runtime.queryRaw<{ count: number }>(
      `SELECT COUNT(*) AS count FROM host_metrics WHERE hostId = ?`,
      [99],
    );
    assert.equal(Number(count), 0);

    const expiredAt = now - 200 * 60 * 60;
    await runtime.withSqliteExclusive((sqlite) => {
      sqlite.prepare(
        `INSERT INTO agent_traffic_reports (hostId, producerId, reportId, receivedAt)
         VALUES (?, NULL, ?, ?)`,
      ).run(1, "expired-report", expiredAt);
      sqlite.prepare(
        `INSERT INTO traffic_stats (ruleId, hostId, bytesIn, bytesOut, connections, recordedAt)
         VALUES (?, ?, 0, 0, 0, ?)`,
      ).run(1, 1, expiredAt);
      sqlite.prepare(
        `INSERT INTO traffic_stat_buckets
           (bucketStart, bucketMinutes, userId, ruleId, hostId, bytesIn, bytesOut, connections, updatedAt)
         VALUES (?, 30, 1, 1, 1, 0, 0, 0, ?)`,
      ).run(expiredAt, expiredAt);
      sqlite.prepare(
        `INSERT INTO tcping_stats (ruleId, hostId, latencyMs, isTimeout, recordedAt)
         VALUES (1, 1, 1, 0, ?)`,
      ).run(expiredAt);
      sqlite.prepare(
        `INSERT INTO forward_group_latency_stats (groupId, latencyMs, isTimeout, recordedAt)
         VALUES (1, 1, 0, ?)`,
      ).run(expiredAt);
      sqlite.prepare(
        `INSERT INTO tunnel_latency_stats (tunnelId, latencyMs, isTimeout, recordedAt)
         VALUES (1, 1, 0, ?)`,
      ).run(expiredAt);
      sqlite.prepare(
        `INSERT OR REPLACE INTO system_settings (key, value, updatedAt)
         VALUES ('traffic-billing-rule-usage-v1', 'ready', ?)`,
      ).run(now);
    });

    await metrics.cleanOldTrafficStats(72);
    await metrics.cleanOldTrafficStatBuckets(72);
    await metrics.cleanOldTcpingStats(72);
    await metrics.cleanOldTunnelLatencyStats(72);
    for (const table of [
      "agent_traffic_reports",
      "traffic_stats",
      "traffic_stat_buckets",
      "tcping_stats",
      "forward_group_latency_stats",
      "tunnel_latency_stats",
    ]) {
      const rows = await runtime.queryRaw<{ count: number }>(`SELECT COUNT(*) AS count FROM "${table}"`);
      assert.equal(Number(rows[0]?.count || 0), 0, table);
    }
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
