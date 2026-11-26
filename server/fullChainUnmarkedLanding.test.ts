import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("full chain can use unmarked standard Agent as SS landing, not lightweight Agent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-unmarked-chain-"));
  try {
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
        await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (1, ?, ?, ?)', ["owner", "x", "user"]);
        for (const [id, version] of [[11, "2.4.139"], [12, "2.4.139"], [13, "2.4.139-iptables-only.1.0.2"]]) {
          await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "agentVersion") VALUES (?, ?, ?, ?, 1, ?)', [id, "host-" + id, "198.51.100." + id, "198.51.100." + id, version]);
        }
        const caller = fullChainsRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "owner", role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
        const hosts = await caller.hosts();
        assert.equal(hosts.find((host) => host.id === 12)?.isLanding, true);
        assert.equal(hosts.find((host) => host.id === 13)?.isLanding, false);
        const base = { name: "unmarked", port: 34567, protocol: "both", ssProtocol: "ss", method: "aes-256-gcm", password: "test-password", allowPublicIntermediate: true };
        await assert.rejects(() => caller.create({ ...base, nodes: [{ hostId: 11 }, { hostId: 13 }] }), /标准 Agent/);
        const created = await caller.create({ ...base, nodes: [{ hostId: 11 }, { hostId: 12 }] });
        assert.ok(created.id > 0);
        await caller.check({ id: created.id });
        assert.equal((await caller.list()).find((chain) => chain.id === created.id)?.status, "checking-link");
      } finally { await runtime.closeDatabase(); }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "full-chain.db") }, encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
