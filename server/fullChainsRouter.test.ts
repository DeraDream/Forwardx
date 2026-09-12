import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("panel can create only a unique chain ending at a marked landing host", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-full-chain-router-"));
  const databasePath = path.join(directory, "full-chain.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const db = await import(url("server/db.ts"));
    const { fullChainsRouter } = await import(url("server/routers/fullChains.ts"));
    let complete = false;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (1, ?, ?, ?, ?)', ["chain-user", "x", "Chain User", "user"]);
      for (const [id, name, ip] of [[11, "入口", "198.51.100.11"], [12, "中转", "198.51.100.12"], [13, "落地", "198.51.100.13"]]) {
        await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId") VALUES (?, ?, ?, ?, 1)', [id, name, ip, ip]);
      }
      await runtime.executeRaw('INSERT INTO "landing_hosts" ("hostId", "userId") VALUES (13, 1)');
      const caller = fullChainsRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "chain-user", role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
      const base = { name: "HK-JP", port: 32123, protocol: "both", ssProtocol: "ss", method: "aes-256-gcm", password: "12345678", allowPublicIntermediate: false };
      await assert.rejects(() => caller.create({ ...base, nodes: [{ hostId: 11 }, { hostId: 11 }] }), /只能出现一次/);
      await assert.rejects(() => caller.create({ ...base, nodes: [{ hostId: 11 }, { hostId: 12 }] }), /末端 SS/);
      const created = await caller.create({ ...base, nodes: [{ hostId: 11 }, { hostId: 12 }, { hostId: 13 }] });
      assert.ok(created.id > 0);
      const landingServiceId = await db.createLandingService({ hostId: 13, userId: 1, name: "HK-JP", protocol: "ss", method: "aes-256-gcm", password: "12345678", port: 32123, endpoint: "198.51.100.13:32123", isEnabled: true, status: "running" });
      await db.updateFullChain(created.id, { landingServiceId, status: "running" });
      const landingOnly = await caller.update({ ...base, id: created.id, name: "HK-JP-renamed", password: "abcdefgh", nodes: [{ hostId: 11 }, { hostId: 12 }, { hostId: 13 }] });
      assert.equal(landingOnly.requiresRedeploy, false, "名称或落地 SS 配置变更不得重部署整条链路");
      const landingService = await db.getLandingServiceById(landingServiceId, true);
      assert.equal(landingService.name, "HK-JP-renamed");
      assert.equal(landingService.password, "abcdefgh");
      const updated = await caller.update({ ...base, id: created.id, name: "HK-JP-edit", port: 32124, nodes: [{ hostId: 11 }, { hostId: 12 }, { hostId: 13 }] });
      assert.equal(updated.id, created.id, "编辑必须保留原全链路 ID");
      assert.equal(updated.requiresRedeploy, true, "端口变化必须重新检查并部署");
      const [chain] = await caller.list();
      assert.equal(chain.name, "HK-JP-edit");
      assert.equal(chain.port, 32124);
      assert.equal(chain.status, "draft");
      assert.deepEqual(chain.nodes.map((node) => Number(node.hostId)), [11, 12, 13]);
      assert.equal(chain.nodes[0].portStatus, "pending");

      complete = true;
    } finally { if (global.gc) global.gc(); await runtime.closeDatabase(); if (complete) process.exit(0); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath }, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("full-chain checks all nodes before deployment", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-full-chain-lifecycle-"));
  const databasePath = path.join(directory, "full-chain.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    const { fullChainsRouter } = await import(url("server/routers/fullChains.ts"));
    const { applyFullChainLandingStatus, applyFullChainRuleStatus, applyFullChainRuntimeStatus } = await import(url("server/fullChainRuntime.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (1, ?, ?, ?, ?)', ["chain-user", "x", "Chain User", "user"]);
      for (const [id, name, ip] of [[11, "入口", "198.51.100.11"], [12, "落地", "198.51.100.12"]]) await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId") VALUES (?, ?, ?, ?, 1)', [id, name, ip, ip]);
      await runtime.executeRaw('INSERT INTO "landing_hosts" ("hostId", "userId") VALUES (12, 1)');
      const caller = fullChainsRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "chain-user", role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
      const randomOne = await caller.random();
      const randomTwo = await caller.random();
      assert.match(randomOne.password, /^[A-Za-z0-9_-]{28}$/);
      assert.notEqual(randomOne.password, randomTwo.password, "each random-password request must produce a new value");
      assert.ok(randomOne.port >= 20000 && randomOne.port < 50000);
      assert.ok(randomTwo.port >= 20000 && randomTwo.port < 50000);
      const create = async (protocol, port) => caller.create({ name: "chain-" + protocol, port, protocol, ssProtocol: "ss", method: "aes-256-gcm", password: "12345678", allowPublicIntermediate: true, nodes: [{ hostId: 11 }, { hostId: 12 }] });
      const finishPorts = async (id) => { for (const node of (await caller.list()).find((item) => item.id === id).nodes) await applyFullChainRuntimeStatus(node.hostId, "full-chain-port-" + id + "-" + node.id, true, "端口可用"); };

      const tcp = await create("tcp", 32124);
      await caller.check({ id: tcp.id });
      await finishPorts(tcp.id);
      let tcpChain = (await caller.list()).find((item) => item.id === tcp.id);
      assert.equal(tcpChain.status, "ready-to-deploy");
      assert.equal(tcpChain.nodes[0].generatedRuleId, null, "port checks must not create forwarding rules");
      await caller.deploy({ id: tcp.id });
      tcpChain = (await caller.list()).find((item) => item.id === tcp.id);
      assert.equal(tcpChain.status, "deploying");
      assert.ok(Number(tcpChain.nodes[0].generatedRuleId) > 0, "deployment creates the first forwarding rule");
      assert.equal(tcpChain.nodes[0].deployStatus, "checking", "入口先开始部署");
      assert.equal(tcpChain.nodes[1].deployStatus, "pending", "下一台必须等待入口完成");
      await applyFullChainRuleStatus(tcpChain.nodes[0].generatedRuleId, true, "部署完毕");
      tcpChain = (await caller.list()).find((item) => item.id === tcp.id);
      assert.equal(tcpChain.nodes[0].deployStatus, "done");
      assert.equal(tcpChain.nodes[1].deployStatus, "checking", "入口完成后才部署落地机");
      await applyFullChainLandingStatus(tcpChain.landingServiceId, true, "部署完毕");
      tcpChain = (await caller.list()).find((item) => item.id === tcp.id);
      assert.equal(tcpChain.status, "running", "落地机完成后全链路才运行");
      assert.ok(tcpChain.nodes.every((node) => node.deployStatus === "done"));

      const both = await create("both", 32125);
      await caller.checkLatency({ id: both.id });
      let latencyChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(latencyChain.nodes[0].latencyStatus, "checking", "latency checks are tracked per hop");
      assert.equal(latencyChain.nodes[0].generatedRuleId, null, "latency checks must not deploy");
      await caller.check({ id: both.id });
      let portChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(portChain.status, "checking-link");
      assert.ok(portChain.nodes.every((node) => node.portStatus === "checking"), "port checks start on every node");
      assert.ok(portChain.nodes.every((node) => node.protocolStatus === "checking"), "UDP checks start on every node");
      await finishPorts(both.id);
      let bothChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(bothChain.status, "checking-link");
      assert.ok(bothChain.nodes.every((node) => node.portStatus === "available"), "every node reports port availability");
      assert.equal(bothChain.nodes[0].generatedRuleId, null);
      for (const node of (await caller.list()).find((item) => item.id === both.id).nodes) await applyFullChainRuntimeStatus(node.hostId, "full-chain-protocol-" + both.id + "-" + node.id, true, "协议可用");
      bothChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(bothChain.status, "ready-to-deploy");
      assert.ok(bothChain.nodes.every((node) => node.protocolStatus === "available"), "every node reports protocol availability");
      assert.equal(bothChain.nodes[0].generatedRuleId, null, "protocol checks must not deploy");

      await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId") VALUES (13, ?, ?, ?, 1)', ["中转", "198.51.100.13", "198.51.100.13"]);
      const complete = await caller.create({ name: "complete-latency", port: 32126, protocol: "both", ssProtocol: "ss", method: "aes-256-gcm", password: "12345678", allowPublicIntermediate: true, nodes: [{ hostId: 11 }, { hostId: 13 }, { hostId: 12 }] });
      await caller.checkLatency({ id: complete.id });
      const completeNodes = (await caller.list()).find((item) => item.id === complete.id).nodes;
      await applyFullChainRuntimeStatus(11, "full-chain-latency-" + complete.id + "-" + completeNodes[0].id, true, "latency_ms=8");
      await applyFullChainRuntimeStatus(13, "full-chain-latency-" + complete.id + "-" + completeNodes[1].id, true, "latency_ms=12");
      const completeChain = (await caller.list()).find((item) => item.id === complete.id);
      assert.equal(completeChain.latestLatencyMs, 20, "入口到出口延迟为所有跳数累计值");
      const latencyHistory = await caller.latencySeries({ id: complete.id, hours: 72 });
      assert.equal(latencyHistory.length, 1, "完整探测会保存一条全链路延迟记录");
      assert.equal(latencyHistory[0].latencyMs, 20);
      assert.deepEqual(JSON.parse(latencyHistory[0].details).map((item) => item.latencyMs), [8, 12, null]);

      const incomplete = await caller.create({ name: "incomplete-latency", port: 32126, protocol: "both", ssProtocol: "ss", method: "aes-256-gcm", password: "12345678", allowPublicIntermediate: true, nodes: [{ hostId: 11 }, { hostId: 13 }, { hostId: 12 }] });
      await caller.checkLatency({ id: incomplete.id });
      const incompleteNodes = (await caller.list()).find((item) => item.id === incomplete.id).nodes;
      await applyFullChainRuntimeStatus(11, "full-chain-latency-" + incomplete.id + "-" + incompleteNodes[0].id, true, "latency_ms=8");
      await applyFullChainRuntimeStatus(13, "full-chain-latency-" + incomplete.id + "-" + incompleteNodes[1].id, false, "timeout");
      const incompleteChain = (await caller.list()).find((item) => item.id === incomplete.id);
      assert.equal(incompleteChain.latestLatencyMs, null, "入口到出口缺少任一跳延迟时不得显示链路总延迟");
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath }, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
