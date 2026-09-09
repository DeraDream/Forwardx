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
    const { fullChainsRouter } = await import(url("server/routers/fullChains.ts"));
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
      const [chain] = await caller.list();
      assert.equal(chain.name, "HK-JP");
      assert.equal(chain.status, "draft");
      assert.deepEqual(chain.nodes.map((node) => Number(node.hostId)), [11, 12, 13]);
      assert.equal(chain.nodes[0].portStatus, "pending");
      await caller.check({ id: created.id });
      const [checking] = await caller.list();
      assert.equal(checking.status, "checking-port");
      assert.equal(checking.nodes[0].portStatus, "checking");
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath }, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("full-chain checks do not deploy, while TCP and TCP+UDP follow their required gates", () => {
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
    const { applyFullChainRuntimeStatus } = await import(url("server/fullChainRuntime.ts"));
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

      const both = await create("both", 32125);
      await caller.checkLatency({ id: both.id });
      let latencyChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(latencyChain.nodes[0].latencyStatus, "checking", "latency checks are tracked per hop");
      assert.equal(latencyChain.nodes[0].generatedRuleId, null, "latency checks must not deploy");
      await caller.check({ id: both.id });
      let portChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(portChain.nodes[0].portStatus, "checking", "port checks begin at the first node");
      assert.ok(portChain.nodes.slice(1).every((node) => node.portStatus === "pending"), "remaining nodes wait for their turn");
      await finishPorts(both.id);
      let bothChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(bothChain.status, "ports-ready");
      assert.ok(bothChain.nodes.every((node) => node.portStatus === "available"), "every node reports port availability");
      assert.equal(bothChain.nodes[0].generatedRuleId, null);
      await caller.checkProtocol({ id: both.id });
      let protocolChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(protocolChain.nodes[0].protocolStatus, "checking", "protocol checks begin at the first node");
      assert.ok(protocolChain.nodes.slice(1).every((node) => node.protocolStatus === "pending"), "remaining nodes wait for their turn");
      for (const node of (await caller.list()).find((item) => item.id === both.id).nodes) await applyFullChainRuntimeStatus(node.hostId, "full-chain-protocol-" + both.id + "-" + node.id, true, "协议可用");
      bothChain = (await caller.list()).find((item) => item.id === both.id);
      assert.equal(bothChain.status, "ready-to-deploy");
      assert.ok(bothChain.nodes.every((node) => node.protocolStatus === "available"), "every node reports protocol availability");
      assert.equal(bothChain.nodes[0].generatedRuleId, null, "protocol checks must not deploy");
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath }, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
