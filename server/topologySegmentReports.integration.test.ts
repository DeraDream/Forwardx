import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("topology segment report persists an Agent's reconciled next hop", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-topology-segment-"));
  const databasePath = path.join(directory, "segments.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import express from "express";
    import { pathToFileURL } from "node:url";
    import path from "node:path";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const reports = await import(moduleUrl("server/agentReportRoutes.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)', [1, "admin", "x", "Admin", "admin"]);
      await runtime.executeRaw('INSERT INTO hosts (id, name, ip, entryIp, hostType, agentToken, userId) VALUES (?,?,?,?,?,?,?)', [1, "source", "198.51.100.1", "198.51.100.1", "slave", "segment-token", 1]);
      await runtime.executeRaw('INSERT INTO hosts (id, name, ip, entryIp, hostType, agentToken, userId) VALUES (?,?,?,?,?,?,?)', [2, "next", "10.23.0.2", "10.23.0.2", "slave", "next-token", 1]);
      // The saved rule still has its logical destination. The Agent reports
      // the reconciled physical listener selected by a forwarding chain.
      await runtime.executeRaw('INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, protocol, isEnabled, isRunning, userId) VALUES (?,?,?,?,?,?,?,?,?,?)', [101, 1, "chain", 20001, "logical.example", 443, "tcp", 1, 1, 1]);
      await runtime.executeRaw('INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, protocol, forwardGroupRuleId, isEnabled, isRunning, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [102, 1, "runtime child A", 20002, "10.23.0.2", 31001, "tcp", 100, 1, 1, 1]);
      await runtime.executeRaw('INSERT INTO forward_rules (id, hostId, name, sourcePort, targetIp, targetPort, protocol, forwardGroupRuleId, isEnabled, isRunning, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [103, 1, "runtime child B", 20003, "10.23.0.2", 32001, "tcp", 200, 1, 1, 1]);

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace(/^Bearer /, ""); next(); });
      reports.registerAgentReportRoutes(app);
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/agent/tcping', {
        method: 'POST', headers: { authorization: 'Bearer segment-token', 'content-type': 'application/json' },
        body: JSON.stringify({ segments: [{
          ruleId: 101, segmentKey: 'topology-v1:1:10.23.0.2:31001:tcp', targetHostId: 2,
          targetIp: '10.23.0.2', targetPort: 31001, method: 'tcp', latencyMs: 18,
          isTimeout: false, probeCount: 3, probeSuccesses: 3,
        }] }),
      });
      assert.equal(response.status, 200, await response.text());
      const pingResponse = await fetch('http://127.0.0.1:' + server.address().port + '/api/agent/tcping', {
        method: 'POST', headers: { authorization: 'Bearer segment-token', 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, segments: [{
          ruleId: 102, segmentKey: 'topology-v1:1:10.23.0.2:0:ping', targetHostId: 2,
          targetIp: '10.23.0.2', targetPort: 0, method: 'ping', latencyMs: 2,
          isTimeout: false, probeCount: 3, probeSuccesses: 3,
        }] }),
      });
      assert.equal(pingResponse.status, 200, await pingResponse.text());
      const rows = await runtime.queryRaw('SELECT ruleId,sourceHostId,targetHostId,targetAddress,targetPort,latencyMs,isTimeout FROM topology_segment_latency_stats ORDER BY id');
      assert.deepEqual(rows.map((row) => [Number(row.ruleId), Number(row.sourceHostId), Number(row.targetHostId), row.targetAddress, Number(row.targetPort), Number(row.latencyMs), Number(row.isTimeout)]), [
        [101, 1, 2, '10.23.0.2', 31001, 18, 0],
        [100, 1, 2, '10.23.0.2', 0, 2, 0],
        [200, 1, 2, '10.23.0.2', 0, 2, 0],
      ]);
      await new Promise((resolve) => server.close(resolve));
    } finally { await runtime.closeDatabase(); }
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
