import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forward self-test leases recover lost deliveries and give claimed work a fresh timeout", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-selftest-dispatch-"));
  const databasePath = path.join(directory, "dispatch.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const tests = await import(url("server/repositories/forwardTestRepository.ts"));
      const metrics = await import(url("server/repositories/metricsRepository.ts"));
      const indexes = await runtime.queryRaw('PRAGMA index_list("forward_tests")');
      const indexColumns = await Promise.all(indexes.map(async (index) => (
        (await runtime.queryRaw('PRAGMA index_info("' + String(index.name).replaceAll('"', '""') + '")'))
          .map((column) => String(column.name))
      )));
      assert.equal(indexColumns.some((columns) => columns.join(",") === "status,createdAt"), true);
      assert.equal(indexColumns.some((columns) => columns.join(",") === "status,updatedAt"), true);
      const now = Math.floor(Date.now() / 1000);
      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1, 0, 10, 1, "pending", now, now],
      );

      assert.equal(await tests.hasActiveForwardTests(), true);
      assert.deepEqual([...await tests.getUnreportedForwardTestHosts(now * 1000)], []);
      assert.deepEqual([...await tests.getUnreportedForwardTestHosts((now + 4) * 1000)], [[10, 1]]);
      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.deepEqual(await tests.getPendingForwardTestsByHost(10), []);
      assert.deepEqual([...await tests.getUnreportedForwardTestHosts((now + 4) * 1000)], [[10, 1]]);
      assert.equal(await tests.markForwardTestRunning(1), false);

      await runtime.executeRaw('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "id" = ?', [now - 20, 1]);
      assert.deepEqual((await tests.getPendingForwardTestsByHost(10)).map((row) => Number(row.id)), [1]);
      assert.equal(await tests.markForwardTestRunning(1), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "success", latencyMs: 12 }), true);
      assert.equal(await tests.completeForwardTestIfActive(1, { status: "failed" }), false);
      assert.equal(await tests.hasActiveForwardTests(), false);
      assert.deepEqual([...await tests.getUnreportedForwardTestHosts((now + 4) * 1000)], []);

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [2, 0, 11, 1, "running", now - 60, now],
      );
      assert.equal(await tests.hasActiveForwardTests(), true);
      assert.deepEqual(await metrics.timeoutStaleForwardTests(30), []);
      assert.equal(await tests.completeForwardTestIfActive(2, { status: "success", latencyMs: 9 }), true);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        [3, 0, 12, 1, "running", now - 60, now - 40],
      );
      const timedOut = await metrics.timeoutStaleForwardTests(30);
      assert.deepEqual(timedOut.map((row) => Number(row.id)), [3]);
      assert.equal(await tests.hasActiveForwardTests(), false);
      assert.equal(await tests.completeForwardTestIfActive(3, { status: "success", latencyMs: 9 }), false);
      const timeoutRow = (await runtime.queryRaw('SELECT "status" FROM "forward_tests" WHERE "id" = ?', [3]))[0];
      assert.equal(timeoutRow.status, "timeout");

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "message", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          4, 4, 14, 1, "running", JSON.stringify({ kind: "direct" }), now - 60, now - 10,
          5, 0, 15, 1, "running", JSON.stringify({ kind: "tunnel", tunnelId: 5 }), now - 60, now - 10,
        ],
      );
      const timeoutForTest = (row) => {
        try {
          const kind = JSON.parse(String(row.message || "{}"))?.kind;
          return kind === "tunnel" ? 30 : 8;
        } catch {
          return 8;
        }
      };
      const shortTimeouts = await metrics.timeoutStaleForwardTests(8, timeoutForTest);
      assert.deepEqual(shortTimeouts.map((row) => [Number(row.id), Number(row.timeoutSeconds)]), [[4, 8]]);
      assert.equal(await tests.hasActiveForwardTests(), true);

      await runtime.executeRaw('UPDATE "forward_tests" SET "updatedAt" = ? WHERE "id" = ?', [now - 40, 5]);
      const runtimeTimeouts = await metrics.timeoutStaleForwardTests(8, timeoutForTest);
      assert.deepEqual(runtimeTimeouts.map((row) => [Number(row.id), Number(row.timeoutSeconds)]), [[5, 30]]);
      assert.equal(await tests.hasActiveForwardTests(), false);

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
        [
          6, 20, 20, 1, "success", now, now,
          7, 20, 20, 1, "failed", now, now,
        ],
      );
      const latestCompleted = await tests.getLatestForwardTest(20, { includeActive: false });
      assert.equal(Number(latestCompleted?.id), 7, "completed rows with equal timestamps must prefer the larger id");

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
        [
          8, 20, 20, 1, "pending", now, now,
          9, 20, 20, 1, "running", now, now,
        ],
      );
      const latestActive = await tests.getLatestForwardTest(20);
      assert.equal(Number(latestActive?.id), 9, "active rows with equal timestamps must prefer the larger id");

      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "message", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          10, 20, 21, 1, "success", JSON.stringify({ kind: "topology-total", targetIp: "198.51.100.21", targetPort: 30121, totalLatencyMs: 21 }), now, now,
          11, 20, 20, 1, "success", JSON.stringify({ kind: "topology-total", targetIp: "198.51.100.20", targetPort: 30120, totalLatencyMs: 11 }), now, now,
          12, 20, 20, 1, "failed", "other page's test", now + 1, now + 1,
        ],
      );
      assert.equal(Number((await tests.getLatestForwardTest(20, { hostId: 20, topologyTotal: true }))?.id), 11);
      assert.equal(Number((await tests.getLatestForwardTest(20, { hostId: 21, topologyTotal: true }))?.id), 10);
      assert.equal(Number((await tests.getLatestForwardTest(20, { hostId: 21, includeActive: false }))?.id), 10);
      const storedTopology = await tests.getLatestTopologyTestsForEntries([
        { ruleId: 20, entryHostId: 20 }, { ruleId: 20, entryHostId: 21 }, { ruleId: 20, entryHostId: 22 },
      ]);
      assert.equal(Number(storedTopology.get("20:20")?.id), 11, "show persisted TCP even while another test is pending");
      assert.equal(Number(storedTopology.get("20:21")?.id), 10);
      assert.equal(storedTopology.has("20:22"), false);
      const old = now - 100 * 3600;
      await runtime.executeRaw(
        'INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "message", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          13, 21, 20, 1, "success", JSON.stringify({ kind: "topology-total", totalLatencyMs: 9 }), old - 1, old - 1,
          14, 21, 20, 1, "success", JSON.stringify({ kind: "topology-total", totalLatencyMs: 10 }), old, old,
          15, 21, 20, 1, "success", "old ordinary test", old, old,
        ],
      );
      await tests.cleanOldForwardTests(72);
      assert.deepEqual((await runtime.queryRaw('SELECT id FROM "forward_tests" WHERE "ruleId" = 21 ORDER BY id')).map((row) => Number(row.id)), [14]);
      assert.equal(Number((await tests.getLatestTopologyTestsForEntries([{ ruleId: 21, entryHostId: 20 }])).get("21:20")?.id), 14);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
