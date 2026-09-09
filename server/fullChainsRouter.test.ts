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
