import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("latest topology segments are user-scoped and explicit refresh wakes only allowed sources", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-topology-segments-router-"));
  const databasePath = path.join(directory, "segments.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const events = await import(url("server/agentEvents.ts"));
    const { diagnosticsRouter } = await import(url("server/routers/diagnostics.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id, username, password, name, role) VALUES (?,?,?,?,?), (?,?,?,?,?)', [1, "owner", "x", "Owner", "user", 2, "other", "x", "Other", "user"]);
      await runtime.executeRaw('INSERT INTO hosts (id, name, ip, ipv4, entryIp, userId) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?)', [11, "source", "198.51.100.11", "198.51.100.11", "198.51.100.11", 1, 12, "other", "198.51.100.12", "198.51.100.12", "198.51.100.12", 2]);
      await runtime.executeRaw('INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, isEnabled, isRunning, userId) VALUES (?,?,?,?,?,?,?,?,?), (?,?,?,?,?,?,?,?,?)', [101, 11, "mine", 20101, "203.0.113.1", 443, 1, 1, 1, 102, 12, "other", 20102, "203.0.113.2", 443, 1, 1, 2]);
      await db.recordTopologySegmentLatency([
        { ruleId: 101, sourceHostId: 11, targetAddress: "203.0.113.1", targetPort: 443, segmentKey: "mine", method: "tcp", latencyMs: 17, isTimeout: false },
        { ruleId: 102, sourceHostId: 12, targetAddress: "203.0.113.2", targetPort: 443, segmentKey: "other", method: "tcp", latencyMs: 99, isTimeout: false },
      ]);
      const caller = diagnosticsRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "owner", role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
      const rows = await caller.latestSegments({ ruleIds: [101, 102] });
      assert.deepEqual(rows.map((row) => [row.ruleId, row.latencyMs]), [[101, 17]]);
      assert.equal(events.hasHostTcpingRequest(11), false);
      assert.equal(events.hasHostTcpingRequest(12), false);
      const refresh = await caller.refreshSegments({ ruleId: 101 });
      assert.deepEqual(refresh.sourceHostIds, [11]);
      assert.equal(events.hasHostTcpingRequest(11), true);
      await assert.rejects(() => caller.refreshSegments({ ruleId: 102 }));
      assert.equal(events.hasHostTcpingRequest(12), false);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
