import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("entry Agent probes both SS listeners and receives old-target cleanup plus TCP/UDP switch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-landing-agent-"));
  try {
    const script = String.raw`
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import express from 'express';
      const runtime = await import('./server/dbRuntime.ts');
      const schema = await import('./server/dbSchema.ts');
      const reports = await import('./server/agentReportRoutes.ts');
      const heartbeat = await import('./server/agentHeartbeatRoute.ts');
      const db = await import('./server/db.ts');
      const { runLandingGroupFailoverSweep } = await import('./server/landingGroupFailover.ts');
      await runtime.connectDatabase({ type: 'sqlite', sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const restarting = process.env.RESTART_PANEL === '1';
      if (!restarting) {
      await runtime.executeRaw('INSERT INTO users (id,username,password,role) VALUES (1,?,?,?)', ['owner','x','admin']);
      for (const id of [11,12,13]) await runtime.executeRaw('INSERT INTO hosts (id,name,ip,ipv4,hostType,agentToken,userId,agentVersion,isOnline,lastHeartbeat) VALUES (?,?,?,?,?,?,?,?,?,?)', [id,'host-'+id,'198.51.100.'+id,'198.51.100.'+id,'slave','token-'+id,1,'2.2.248',1,Math.floor(Date.now()/1000)]);
      await runtime.executeRaw('INSERT INTO landing_groups (id,name,userId,activeServiceId) VALUES (1,?,?,?)', ['backup',1,42]);
      for (const [priority,id] of [[0,12],[1,13]]) await runtime.executeRaw('INSERT INTO landing_group_members (groupId,hostId,priority) VALUES (1,?,?)', [id,priority]);
      for (const [id,hostId] of [[42,12],[43,13]]) await runtime.executeRaw('INSERT INTO landing_services (id,hostId,userId,name,landingGroupId,protocol,method,password,port,endpoint,status,isEnabled) VALUES (?,?,1,?,1,?,?,?,?,?,?,1)', [id,hostId,'SS','ss','aes-256-gcm','12345678',32123,'198.51.100.'+hostId,'running']);
      await runtime.executeRaw('INSERT INTO forward_rules (id,hostId,userId,name,forwardType,protocol,sourcePort,targetIp,targetPort,targetLandingServiceId,targetLandingGroupId,isEnabled,isRunning) VALUES (50,11,1,?,?,?,?,?,?,42,1,1,1)', ['forward','iptables','both',31000,'198.51.100.12',32123]);
      }
      const app = express(); app.use(express.json()); app.use((req,_res,next) => { req.agentToken = String(req.headers.authorization || '').replace(/^Bearer /,''); next(); });
      reports.registerAgentReportRoutes(app); heartbeat.registerAgentHeartbeatRoute(app);
      (await import('./server/agentStatusRoutes.ts')).registerAgentStatusRoutes(app);
      const server = http.createServer(app); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      const request = async (route, payload) => { const response = await fetch(base + route, { method:'POST', headers:{ authorization:'Bearer token-11', 'content-type':'application/json' }, body:JSON.stringify(payload) }); const body = await response.json(); assert.equal(response.status,200,JSON.stringify(body)); return body; };
      try {
        if (!restarting) {
        const first = await request('/api/agent/heartbeat', { agentVersion:'2.2.248', forceReconcile:true });
        const plans = (first.forwardGroupProbes || []).filter(probe => probe.probeType === 'landing');
        assert.deepEqual(plans.map(probe => probe.memberId).sort(), [42,43]);
        await request('/api/agent/tcping', { forwardGroups: plans.map(probe => ({ ...probe, probeCount:1, probeSuccesses:probe.memberId === 42 ? 0 : 1, isTimeout:probe.memberId === 42, latencyMs:probe.memberId === 42 ? 0 : 8 })) });
        assert.equal((await runtime.queryRaw('SELECT * FROM landing_group_probe_latest')).length, 2);
        const tick = Date.now(); await runLandingGroupFailoverSweep(tick); await runLandingGroupFailoverSweep(tick + 61_000);
        assert.equal((await runtime.queryRaw('SELECT activeServiceId FROM landing_groups WHERE id = 1'))[0].activeServiceId, 43);
        }
        const switched = await request('/api/agent/heartbeat', { agentVersion:'2.2.248', forceReconcile:true });
        const rule = await db.getForwardRuleById(50);
        assert.equal(rule.targetLandingServiceId, 43);
        assert.equal(rule.targetIp, '198.51.100.13');
        assert.equal(rule.protocol, 'both');
        const actions = switched.desiredState?.actions || switched.actions || [];
        const apply = actions.find(action => action.ruleId === 50 && action.op === 'apply' && action.targetIp === '198.51.100.13' && action.protocol === 'both');
        assert.ok(apply, JSON.stringify(actions.map(action => [action.ruleId, action.op, action.targetIp])));
        assert.ok((apply.preCommands || []).some(command => command.includes('198.51.100.12') && command.includes('tcp')), 'old TCP target cleanup must precede apply');
        assert.ok((apply.preCommands || []).some(command => command.includes('198.51.100.12') && command.includes('udp')), 'old UDP target cleanup must precede apply');
        assert.ok((apply.preCommands || []).every(command => !command.includes('198.51.100.13')), 'old-target cleanup must not remove the newly selected listener');
        const pending = rule.landingSwitchPending;
        assert.equal(JSON.parse(pending).issuedAt, apply.issuedAt);
        if (restarting) {
          const ack = { ruleId: 50, statusType: 'rule', forwardType: 'iptables', sourcePort: 31000, protocol: 'both', targetPort: 32123, actionOp: 'apply', actionSucceeded: true, isRunning: true, issuedAt: apply.issuedAt };
          await request('/api/agent/rule-status', { ...ack, issuedAt: ack.issuedAt - 1 });
          await request('/api/agent/rule-status', { ...ack, isRunning: false, actionSucceeded: false });
          assert.equal((await db.getForwardRuleById(50)).landingSwitchPending, pending);
          // Advance past the normal active-work resend throttle (60 seconds).
          const clock = Date.now.bind(Date); Date.now = () => clock() + 65_000;
          const retry = await request('/api/agent/heartbeat', { agentVersion:'2.2.248', forceReconcile:true, agentBootId:'test-entry-restarted' });
          const resent = (retry.desiredState?.actions || retry.actions || []).find(action => action.ruleId === 50 && action.op === 'apply');
          assert.ok(resent, 'a fresh Agent heartbeat after a failed apply must receive the handoff');
          assert.deepEqual(resent.preCommands, apply.preCommands);
          assert.equal(resent.reportStatus, true);
          assert.equal(resent.issuedAt, apply.issuedAt);
          await request('/api/agent/rule-status', ack);
          assert.equal((await db.getForwardRuleById(50)).landingSwitchPending, null);
        }
      } finally { await new Promise(resolve => server.close(resolve)); await runtime.closeDatabase(); }
    `;
    // Drop the initial response (no ACK), then start a fresh panel process
    // against the same database; no heartbeat or action caches survive.
    for (const restart of ["0", "1"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, RESTART_PANEL: restart, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "landing.db") }, encoding: "utf8", timeout: 90_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
