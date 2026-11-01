import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("manual multi-hop multi-exit test dispatches and aggregates independent branches", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forwardx-branch-manual-"));
  try {
    const script = String.raw`
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import express from 'express';
      const runtime = await import('./server/dbRuntime.ts');
      const schema = await import('./server/dbSchema.ts');
      const { tunnelsRouter } = await import('./server/routers/tunnels.ts');
      const { registerAgentSelfTestRoutes } = await import('./server/agentSelfTestRoutes.ts');
      const { settleTimedOutTunnelTests } = await import('./server/scheduler.ts');
      const { clearTunnelHopBatch } = await import('./server/tunnelHopTestState.ts');
      await runtime.connectDatabase({ type: 'sqlite', sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO users (id, username, password, name, role) VALUES (?, ?, ?, ?, ?)', [1, 'test', 'x', 'test', 'admin']);
      for (const id of [10,20,21,30,40]) await runtime.executeRaw('INSERT INTO hosts (id, name, ip, hostType, agentToken, userId) VALUES (?, ?, ?, ?, ?, ?)', [id, 'host-' + id, '127.0.0.' + id, 'slave', 'token-' + id, 1]);
      await runtime.executeRaw('INSERT INTO tunnels (id, name, entryHostId, exitHostId, mode, listenPort, loadBalanceEnabled, loadBalanceStrategy, userId, isEnabled, isRunning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, 'branch', 10, 30, 'tls', 10030, 1, 'round_robin', 1, 1, 1]);
      for (const [seq,id,port] of [[0,10,0],[1,20,10020],[2,30,10030]]) await runtime.executeRaw('INSERT INTO tunnel_hops (tunnelId,seq,hostId,listenPort) VALUES (?,?,?,?)', [1,seq,id,port]);
      await runtime.executeRaw('INSERT INTO tunnel_exit_nodes (tunnelId,seq,hostId,listenPort,isEnabled) VALUES (?,?,?,?,?)', [1,1,40,10040,1]);
      const caller = tunnelsRouter.createCaller({ req: { headers: {} }, res: {}, user: { id: 1, role: 'admin' }, authSession: null, authFailureReason: null });
      const queued = await caller.test({ id: 1 }); assert.equal(queued.pending, true);
      const tests = await runtime.queryRaw('SELECT id, hostId, message FROM forward_tests ORDER BY id');
      assert.equal(tests.length, 3);
      assert.deepEqual(tests.map((item) => [Number(item.hostId), JSON.parse(item.message).targetPort]), [[10,10020],[20,10030],[20,10040]]);
      const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || '').replace(/^Bearer /, ''); next(); });
      registerAgentSelfTestRoutes(app);
      const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      for (const [index, row] of tests.entries()) {
        const response = await fetch(base + '/api/agent/selftest-result', { method: 'POST', headers: { authorization: 'Bearer token-' + row.hostId, 'content-type': 'application/json' }, body: JSON.stringify({ testId: Number(row.id), targetReachable: index !== 2, latencyMs: index === 0 ? 5 : index === 1 ? 10 : null, message: index === 2 ? 'timeout' : null }) });
        assert.equal(response.status, 200, await response.text());
      }
      const [tunnel] = await runtime.queryRaw('SELECT lastTestStatus, lastLatencyMs, lastTestMessage FROM tunnels WHERE id = 1');
      assert.equal(tunnel.lastTestStatus, 'success'); assert.equal(Number(tunnel.lastLatencyMs), 15);
      const details = JSON.parse(tunnel.lastTestMessage).details; assert.equal(details.length, 3); assert.equal(details[2].success, false);
      const rows = await runtime.queryRaw('SELECT seriesKey, latencyMs, isTimeout FROM tunnel_latency_stats ORDER BY id');
      const byKey = new Map(rows.map((row) => [row.seriesKey, row]));
      assert.equal(Number(byKey.get('primary').latencyMs), 15); assert.equal(Number(byKey.get('exit-2').isTimeout), 1);
      await runtime.executeRaw('INSERT INTO forward_groups (id,name,groupMode,targetIp,isEnabled,userId) VALUES (?,?,?,?,?,?)', [2,'entries','entry','127.0.0.1',1,1]);
      for (const [id,host] of [[21,10],[22,20]]) await runtime.executeRaw('INSERT INTO forward_group_members (id,groupId,memberType,hostId,priority,isEnabled) VALUES (?,?,?,?,?,?)', [id,2,'host',host,id,1]);
      await runtime.executeRaw('INSERT INTO tunnels (id,name,entryHostId,exitHostId,entryGroupId,mode,listenPort,loadBalanceEnabled,loadBalanceStrategy,userId,isEnabled,isRunning) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [2,'matrix',10,30,2,'tls',10030,1,'round_robin',1,1,1]);
      for (const [seq,id,port] of [[0,10,0],[1,30,10030]]) await runtime.executeRaw('INSERT INTO tunnel_hops (tunnelId,seq,hostId,listenPort) VALUES (?,?,?,?)', [2,seq,id,port]);
      await runtime.executeRaw('INSERT INTO tunnel_exit_nodes (tunnelId,seq,hostId,listenPort,isEnabled) VALUES (?,?,?,?,?)', [2,1,40,10040,1]);
      assert.equal((await caller.test({ id: 2 })).pending, true);
      const matrix = (await runtime.queryRaw('SELECT id,hostId,message FROM forward_tests ORDER BY id')).filter((row) => typeof row.message === 'string' && row.message.startsWith('{') && JSON.parse(row.message)?.tunnelId === 2);
      assert.deepEqual(matrix.map((row) => [Number(row.hostId),JSON.parse(row.message).targetPort]), [[10,10030],[20,10030],[10,10040],[20,10040]]);
      for (const [index,row] of matrix.entries()) {
        const response = await fetch(base + '/api/agent/selftest-result', { method: 'POST', headers: { authorization: 'Bearer token-' + row.hostId, 'content-type': 'application/json' }, body: JSON.stringify({ testId: Number(row.id), targetReachable: index !== 1, latencyMs: index !== 1 ? (index + 1) * 5 : null, message: index === 1 ? 'timeout' : null }) });
        assert.equal(response.status, 200, await response.text());
      }
      const [matrixTunnel] = await runtime.queryRaw('SELECT lastTestStatus,lastLatencyMs,lastTestMessage FROM tunnels WHERE id = 2');
      assert.equal(matrixTunnel.lastTestStatus, 'success'); assert.equal(Number(matrixTunnel.lastLatencyMs), 20);
      assert.equal(JSON.parse(matrixTunnel.lastTestMessage).details.length, 4);
      await runtime.executeRaw('DELETE FROM tunnel_hops WHERE tunnelId = 2');
      assert.equal((await caller.test({ id: 2 })).pending, true);
      const legacyRows = (await runtime.queryRaw('SELECT id,hostId,message FROM forward_tests ORDER BY id')).filter((row) => typeof row.message === 'string' && row.message.startsWith('{') && JSON.parse(row.message)?.tunnelId === 2);
      assert.deepEqual(legacyRows.map((row) => [Number(row.hostId),JSON.parse(row.message).targetPort]), [[10,10030],[20,10030],[10,10040],[20,10040]]);
      await runtime.executeRaw('UPDATE forward_group_members SET isEnabled = 0 WHERE id = 22');
      const staleEntry = legacyRows[0];
      const staleResponse = await fetch(base + '/api/agent/selftest-result', { method: 'POST', headers: { authorization: 'Bearer token-' + staleEntry.hostId, 'content-type': 'application/json' }, body: JSON.stringify({ testId: Number(staleEntry.id), targetReachable: true, latencyMs: 5 }) });
      assert.equal(staleResponse.status, 200);
      const [changedEntry] = await runtime.queryRaw('SELECT lastTestStatus,lastTestMessage FROM tunnels WHERE id = 2');
      assert.equal(changedEntry.lastTestStatus, 'failed'); assert.match(changedEntry.lastTestMessage, /拓扑已变更/);
      await caller.test({ id: 1 });
      const oldBatchRows = (await runtime.queryRaw('SELECT id,hostId,message FROM forward_tests ORDER BY id')).filter((row) => typeof row.message === 'string' && row.message.startsWith('{') && JSON.parse(row.message)?.tunnelId === 1);
      await caller.test({ id: 1 });
      const pendingRows = (await runtime.queryRaw('SELECT id,hostId,message FROM forward_tests ORDER BY id')).filter((row) => typeof row.message === 'string' && row.message.startsWith('{') && JSON.parse(row.message)?.tunnelId === 1);
      const old = oldBatchRows[0], current = pendingRows[pendingRows.length - 3];
      const send = async (row) => fetch(base + '/api/agent/selftest-result', { method: 'POST', headers: { authorization: 'Bearer token-' + row.hostId, 'content-type': 'application/json' }, body: JSON.stringify({ testId: Number(row.id), targetReachable: true, latencyMs: 5 }) });
      assert.equal((await send(old)).status, 200);
      assert.equal((await runtime.queryRaw('SELECT lastTestStatus FROM tunnels WHERE id = 1'))[0].lastTestStatus, 'pending');
      await runtime.executeRaw('UPDATE tunnel_exit_nodes SET listenPort = ? WHERE tunnelId = ?', [10041,1]);
      assert.equal((await send(current)).status, 200);
      const [changed] = await runtime.queryRaw('SELECT lastTestStatus,lastTestMessage FROM tunnels WHERE id = 1');
      assert.equal(changed.lastTestStatus, 'failed'); assert.match(changed.lastTestMessage, /拓扑已变更/);
      await runtime.executeRaw('INSERT INTO tunnels (id,name,entryHostId,exitHostId,mode,relayMode,listenPort,loadBalanceEnabled,loadBalanceStrategy,userId,isEnabled,isRunning) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [3,'relay-branches',10,30,'tls','failover',10030,1,'round_robin',1,1,1]);
      for (const [seq,id,port] of [[0,10,0],[1,20,10020],[2,21,10021],[3,30,10030]]) await runtime.executeRaw('INSERT INTO tunnel_hops (tunnelId,seq,hostId,listenPort) VALUES (?,?,?,?)', [3,seq,id,port]);
      await runtime.executeRaw('INSERT INTO tunnel_exit_nodes (tunnelId,seq,hostId,listenPort,isEnabled) VALUES (?,?,?,?,?)', [3,1,40,10040,1]);
      assert.equal((await caller.test({ id: 3 })).pending, true);
      const relayRows = (await runtime.queryRaw('SELECT id,hostId,message FROM forward_tests ORDER BY id')).filter((row) => typeof row.message === 'string' && row.message.startsWith('{') && JSON.parse(row.message)?.tunnelId === 3);
      assert.deepEqual(relayRows.map((row) => [Number(row.hostId),JSON.parse(row.message).targetPort]), [[10,10020],[20,10030],[20,10040],[10,10021],[21,10030],[21,10040]]);
      for (const [index,row] of relayRows.entries()) {
        const values = [5,10,null,7,null,20];
        const response = await fetch(base + '/api/agent/selftest-result', { method: 'POST', headers: { authorization: 'Bearer token-' + row.hostId, 'content-type': 'application/json' }, body: JSON.stringify({ testId: Number(row.id), targetReachable: values[index] !== null, latencyMs: values[index], message: values[index] === null ? 'timeout' : null }) });
        assert.equal(response.status, 200, await response.text());
      }
      const [relayTunnel] = await runtime.queryRaw('SELECT lastTestStatus,lastLatencyMs,lastTestMessage FROM tunnels WHERE id = 3');
      assert.equal(relayTunnel.lastTestStatus, 'success'); assert.equal(Number(relayTunnel.lastLatencyMs), 27);
      assert.equal(JSON.parse(relayTunnel.lastTestMessage).details.length, 6);
      await caller.test({ id: 3 });
      const timeoutRows = (await runtime.queryRaw('SELECT id,hostId,message FROM forward_tests ORDER BY id')).filter((row) => typeof row.message === 'string' && row.message.startsWith('{') && JSON.parse(row.message)?.tunnelId === 3);
      assert.equal(timeoutRows.length, 6);
      for (const row of timeoutRows.slice(0,5)) assert.equal((await send(row)).status, 200);
      await settleTimedOutTunnelTests([{ ...timeoutRows[5], ruleId: 0 }], 30);
      const [timed] = await runtime.queryRaw('SELECT lastTestStatus,lastTestMessage FROM tunnels WHERE id = 3');
      assert.equal(timed.lastTestStatus, 'success');
      assert.equal(JSON.parse(timed.lastTestMessage).details.filter((detail) => !detail.success).length, 1);
      assert.ok((await runtime.queryRaw("SELECT * FROM tunnel_latency_stats WHERE tunnelId = 3 AND seriesKey = 'exit-2' ORDER BY id DESC LIMIT 1")).length);
      await caller.test({ id: 3 });
      const restartRows = (await runtime.queryRaw('SELECT id,hostId,message FROM forward_tests ORDER BY id')).filter((row) => typeof row.message === 'string' && row.message.startsWith('{') && JSON.parse(row.message)?.tunnelId === 3);
      clearTunnelHopBatch(3);
      assert.equal((await send(restartRows[restartRows.length - 6])).status, 200);
      const [restarted] = await runtime.queryRaw('SELECT lastTestStatus,lastTestMessage FROM tunnels WHERE id = 3');
      assert.equal(restarted.lastTestStatus, 'failed'); assert.match(restarted.lastTestMessage, /状态已失效/);
      await new Promise((resolve) => server.close(resolve)); console.log('ok'); process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(dir, "db.sqlite") }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ok/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
