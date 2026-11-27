import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A legacy database must expose its old values on the first page load after
// upgrade, without waiting for a fresh Agent probe or scanning history again.
test("topology snapshot backfills legacy rows once and never reads history on the page", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-topology-snapshot-"));
  const previousKind = process.env.DATABASE_TYPE;
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const schema = await import("./dbSchema");
  const metrics = await import("./repositories/metricsRepository");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "snapshot.db") } });
    await schema.ensureDatabaseSchema();
    const key = "topology-v1:1:203.0.113.2:0:ping";
    const now = Math.floor(Date.now() / 1000);
    for (const [ruleId, secondsAgo, latency, timedOut] of [
      [1, 60, 12, 0], [1, 40, 16, 0], [1, 25, null, 1], [1, 1, null, 1], [2, 10, 8, 0],
    ] as const) {
      await runtime.executeRaw(
        `INSERT INTO topology_segment_latency_stats
          (ruleId,sourceHostId,targetAddress,targetPort,segmentKey,method,latencyMs,isTimeout,probeCount,probeSuccesses,recordedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [ruleId, 1, "203.0.113.2", 0, key, "ping", latency, timedOut, 1, timedOut ? 0 : 1, now - secondsAgo],
      );
    }
    await runtime.executeRaw(
      `INSERT INTO topology_segment_incidents
        (userId,sourceHostId,sourceName,targetName,targetAddress,segmentKey,method,failureStartedAt,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [1, 1, "source", "target", "203.0.113.2", key, "ping", now - 25, now - 25, now - 1],
    );
    await schema.ensureDatabaseSchema();
    const initial = await metrics.getLatestTopologySegmentLatency([1, 2]);
    assert.equal(initial.length, 2);
    assert.equal(initial.find((row) => row.ruleId === 1)?.blocked, true);
    assert.equal(initial.find((row) => row.ruleId === 2)?.latencyMs, 8);
    const snapshot = await runtime.queryRaw<any>("SELECT * FROM topology_segment_latest ORDER BY ruleId");
    assert.equal(snapshot.length, 2);
    assert.equal(Number(snapshot[0].lastSuccessLatencyMs), 16);
    assert.equal(Number(snapshot[0].failureSince), now - 25);
    // The old table can remain untouched, but must no longer affect reads or grow.
    await metrics.recordTopologySegmentLatency([{
      ruleId: 1, sourceHostId: 1, targetAddress: "203.0.113.2", segmentKey: key,
      method: "ping", latencyMs: 4, isTimeout: false, recordedAt: new Date((now + 1) * 1000),
    }]);
    assert.equal((await metrics.getLatestTopologySegmentLatency([1]))[0].latencyMs, 4);
    assert.equal((await runtime.queryRaw<any>("SELECT COUNT(*) AS count FROM topology_segment_latency_stats"))[0].count, 5);
    const plan = await runtime.queryRaw<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM topology_segment_latest WHERE ruleId IN (?)", [1],
    );
    assert.match(plan.map((row) => row.detail).join(" | "), /idx_topology_segment_latest_ruleId/i);
  } finally {
    await runtime.closeDatabase();
    if (previousKind === undefined) delete process.env.DATABASE_TYPE;
    else process.env.DATABASE_TYPE = previousKind;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
