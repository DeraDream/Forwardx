import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("annotations are persisted per user and reject stale writes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forwardx-topology-"));
  try {
    const script = String.raw`
      import assert from 'node:assert/strict';
      const runtime = await import('./server/dbRuntime.ts');
      const schema = await import('./server/dbSchema.ts');
      const { topologyAnnotationsRouter } = await import('./server/routers/topologyAnnotations.ts');
      await runtime.connectDatabase({ type: 'sqlite', sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const caller = (id) => topologyAnnotationsRouter.createCaller({ req: { headers: {} }, res: {}, user: { id, role: 'user' }, authSession: null, authFailureReason: null });
      const a = caller(1), b = caller(2);
      const item = { id: 'b0f1c121-9a69-48f5-b640-a5a4b2e2f6e1', name: 'A', address: '', target: 'QHIX', targetNodeId: 'host:7', note: '' };
      assert.deepEqual(await a.list(), []);
      await a.save({ expected: [], items: [item] });
      assert.deepEqual(await a.list(), [item]);
      assert.deepEqual(await b.list(), []);
      await assert.rejects(a.save({ expected: [], items: [] }), /其他页面修改/);
      assert.deepEqual(await a.list(), [item]);
      await a.save({ expected: [item], items: [] });
      assert.deepEqual(await a.list(), []);
      const other = { ...item, id: 'c0f1c121-9a69-48f5-b640-a5a4b2e2f6e1', name: 'B' };
      const concurrent = await Promise.allSettled([a.save({ expected: [], items: [item] }), a.save({ expected: [], items: [other] })]);
      assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
      assert.equal((await a.list()).length, 1);
      const anonymous = topologyAnnotationsRouter.createCaller({ req: { headers: {} }, res: {}, user: null, authSession: null, authFailureReason: null });
      await assert.rejects(anonymous.list());
      console.log('ok');
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(dir, "db.sqlite") }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
