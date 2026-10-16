import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("forced host deletion previews and removes landing, group, tunnel, and remote-rule references", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-forced-host-delete-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const events = await import(url("server/agentEvents.ts"));
    const { hostsRouter } = await import(url("server/routers/hosts.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const put = (table, columns, values) => runtime.executeRaw('INSERT INTO "' + table + '" (' + columns.map((x) => '"' + x + '"').join(',') + ') VALUES (' + values.map(() => '?').join(',') + ')', values);
    await put("users", ["id","username","password","role"], [1,"admin","x","admin"]);
    for (const [id, name] of [[1,"deleted"],[2,"relay"],[3,"exit"]]) await put("hosts", ["id","name","ip","userId","isOnline"], [id,name,"10.0.0." + id,1,id !== 1]);
    await db.createLandingHost({ hostId: 1, userId: 1 });
    const serviceId = await db.createLandingService({ hostId: 1, userId: 1, name: "landing", protocol: "ss", method: "aes-256-gcm", password: "12345678", port: 31001, endpoint: "10.0.0.1", isEnabled: true, status: "running" });
    await put("forward_rules", ["id","hostId","name","forwardType","protocol","sourcePort","targetIp","targetPort","userId","isEnabled","isRunning"], [11,1,"local","iptables","tcp",21001,"1.1.1.1",80,1,1,0]);
    await put("forward_rules", ["id","hostId","name","forwardType","protocol","sourcePort","targetIp","targetPort","targetLandingServiceId","userId","isEnabled","isRunning"], [12,2,"uses landing","iptables","tcp",21002,"10.0.0.1",31001,serviceId,1,1,1]);
    await put("forward_groups", ["id","name","groupType","groupMode","targetIp","userId","isEnabled"], [20,"chain group","host","chain","0.0.0.0",1,1]);
    await put("forward_group_members", ["id","groupId","memberType","hostId","priority","isEnabled"], [21,20,"host",1,0,1]);
    await put("forward_group_members", ["id","groupId","memberType","hostId","priority","isEnabled"], [22,20,"host",2,1,1]);
    await put("tunnels", ["id","name","entryHostId","exitHostId","listenPort","userId","isEnabled","isRunning"], [30,"mixed tunnel",1,2,25000,1,1,0]);
    await put("tunnel_hops", ["id","tunnelId","seq","hostId"], [31,30,0,1]);
    await put("tunnel_exit_nodes", ["id","tunnelId","seq","hostId","listenPort"], [32,30,0,3,25001]);
    class Response extends EventEmitter { constructor() { super(); this.writes = []; this.destroyed = false; this.writableEnded = false; this.writableFinished = false; } write(value) { this.writes.push(String(value)); return true; } end() {} destroy() { this.destroyed = true; this.emit("close"); } }
    const relayResponse = new Response(); events.registerAgentEventClient(2, "test-agent", relayResponse);
    const caller = hostsRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null });
    const impact = await caller.deleteImpact({ id: 1 });
    assert.equal(impact.rules.length, 1); assert.equal(impact.landingReferences.length, 1); assert.equal(impact.groups.length, 1); assert.equal(impact.tunnels.length, 1); assert.equal(impact.landingServices.length, 1);
    assert.deepEqual(impact.affectedHosts.map((item) => item.hostId).sort(), [2,3]);
    const result = await caller.forceDelete({ id: 1, acknowledgeOfflineRisk: true });
    assert.ok(relayResponse.writes.length > 0, "关联 VPS 必须实际收到强制删除刷新事件");
    assert.ok(result.jobId); assert.ok(!(await db.getHostById(1))); assert.ok(!(await db.getLandingServiceById(serviceId))); assert.ok(!(await db.getTunnelById(30)));
    for (const ruleId of [11, 12]) { const rule = await db.getForwardRuleById(ruleId); assert.ok(!rule || rule.pendingDelete, "规则 #" + ruleId + " 必须已删除或进入 Agent 清理队列"); }
    assert.equal(await db.getForwardGroupById(20), undefined, "不足两跳的转发链必须一并移除");
    const waitingJob = await caller.forceDeleteStatus({ jobId: result.jobId }); assert.equal(waitingJob.affectedHosts.length, 2); assert.equal(waitingJob.affectedHosts.find((item) => item.hostId === 2).state, "清理中");
    await db.finalizeForwardRuleDelete(12);
    const confirmedJob = await caller.forceDeleteStatus({ jobId: result.jobId }); assert.equal(confirmedJob.affectedHosts.find((item) => item.hostId === 2).state, "清理成功");
    await new Promise((resolve) => setTimeout(resolve, 20_100));
    const timedOutJob = await caller.forceDeleteStatus({ jobId: result.jobId }); assert.equal(timedOutJob.targetState, "清理失败：目标 VPS 20 秒内未回执"); assert.equal(timedOutJob.status, "complete");
    events.unregisterAgentEventClient(2, relayResponse);
    await runtime.closeDatabase();
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath }, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
