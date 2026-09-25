import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("external landing SS is saved without a managed host", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-external-landing-"));
  const databasePath = path.join(directory, "landing.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { landingRouter } = await import(moduleUrl("server/routers/landing.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [1, "admin", "x", "admin"]);
      const caller = landingRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      const created = await caller.create({ name: "external", protocol: "ss", method: "aes-256-gcm", password: "external-secret", port: 443, endpoint: "ss.example.com" });
      assert.equal(created.external, true);
      const [service] = await caller.list();
      assert.equal(service.isExternal, true);
      assert.ok(Number(service.hostId) < 0);
      assert.equal(service.endpoint, "ss.example.com");
      assert.equal((await caller.eligibleHosts()).some((host) => Number(host.hostId) === Number(service.hostId)), false);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
