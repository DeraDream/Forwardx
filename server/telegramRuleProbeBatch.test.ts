import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("manual chain lookup keeps its batch when a hop becomes the aggregate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tg-probe-"));
  try {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      import path from "node:path";
      const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
      const runtime = await import(url("server/dbRuntime.ts"));
      const schema = await import(url("server/dbSchema.ts"));
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const repo = await import(url("server/repositories/forwardTestRepository.ts"));
      const batchId = "fgr-147-12345-abc";
      for (const [id, ruleId, message] of [
        [1, 147, JSON.stringify({ kind: "forward-chain", batchId })],
        [2, 147, JSON.stringify({ kind: "forward-chain-hop-summary", batchId })],
        [3, 999, JSON.stringify({ kind: "forward-chain", batchId })],
      ]) {
        await runtime.executeRaw('INSERT INTO "forward_tests" ("id", "ruleId", "hostId", "userId", "status", "message", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, ruleId, 1, 1, "success", message, 100, 100]);
      }
      const ids = await repo.getForwardTestBatchIds(147, batchId);
      assert.deepEqual(ids, [1, 2]);
      assert.deepEqual((await repo.getForwardTestsByIds(147, [1, 2, 3])).map((row) => row.id).sort(), [1, 2]);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(dir, "probe.db") }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
