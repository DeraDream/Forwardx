import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("managed landing SS accepts unmarked standard Agents but excludes lightweight Agents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-landing-hosts-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      const { landingRouter } = await import(url("server/routers/landing.ts"));
      try {
        await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
        await schema.ensureDatabaseSchema();
        await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (1, ?, ?, ?)', ["owner", "x", "user"]);
        await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (2, ?, ?, ?)', ["other", "x", "user"]);
        for (const [id, owner, version] of [[11, 1, "2.4.139"], [12, 1, "2.4.139-iptables-only.1.0.2"], [13, 1, ""], [14, 2, "2.4.139"]]) {
          await runtime.executeRaw('INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "userId", "agentVersion") VALUES (?, ?, ?, ?, ?, ?)', [id, "host-" + id, "198.51.100." + id, "198.51.100." + id, owner, version]);
        }
        const caller = landingRouter.createCaller({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "owner", role: "user", accountEnabled: true }, authSession: null, authFailureReason: null });
        assert.deepEqual((await caller.deployableHosts()).map((item) => item.hostId), [11]);
        const input = { name: "SS", protocol: "ss", method: "aes-256-gcm", password: "test-password", port: 32123, endpoint: "198.51.100.11" };
        await assert.rejects(() => caller.create({ ...input, hostId: 12 }), /标准 Agent/);
        await assert.rejects(() => caller.checkPort({ hostId: 12, port: 32123 }), /标准 Agent/);
        await assert.rejects(() => caller.create({ ...input, hostId: 14 }), /无权/);
        const created = await caller.create({ ...input, hostId: 11 });
        assert.equal(created.external, false);
        assert.equal((await caller.list()).find((item) => item.id === created.id)?.hostId, 11);
        assert.deepEqual(await caller.eligibleHosts(), [], "creating a service must not implicitly create a legacy host marker");
        await caller.markHost({ hostId: 11 });
        await caller.setHostEnabled({ hostId: 11, isEnabled: false });
        assert.equal((await caller.deployableHosts()).find((item) => item.hostId === 11)?.hostDisabled, true);
        await assert.rejects(() => caller.create({ ...input, hostId: 11, port: 32124 }), /总开关已关闭/);
      } finally { await runtime.closeDatabase(); }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "landing.db") }, encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
