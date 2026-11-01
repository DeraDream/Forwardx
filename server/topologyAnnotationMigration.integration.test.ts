import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("incremental migration remaps annotation owner and host without exposing it to the old ID", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "forwardx-topology-migrate-"));
  try {
    const script = String.raw`
      import assert from 'node:assert/strict';
      const runtime = await import('./server/dbRuntime.ts');
      const schema = await import('./server/dbSchema.ts');
      const migration = await import('./server/migration.ts');
      await runtime.connectDatabase({ type:'sqlite', sqlite:{ path:process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw("INSERT INTO users (id,username,password,role) VALUES (1,'existing','x','admin')");
      await runtime.executeRaw("INSERT INTO hosts (id,name,ip,userId,agentToken) VALUES (1,'existing-host','192.0.2.1',1,'existing-token')");
      const annotation = { id:'b0f1c121-9a69-48f5-b640-a5a4b2e2f6e1', name:'专线 A', address:'', target:'新主机', targetNodeId:'host:100', note:'' };
      const result = await migration.importMigrationSnapshot({ version:1, exportedAt:Date.now(), dataScope:'essential', tables:{
        users:[{ id:10, username:'import-user', password:'hash', role:'user' }],
        hosts:[{ id:100, name:'import-host', ip:'192.0.2.100', userId:10, agentToken:'import-token' }],
        system_settings:[{ key:'topologyAnnotations:10', value:JSON.stringify([annotation]) }, { key:'topologyAnnotations:99', value:JSON.stringify([annotation]) }],
      }});
      assert.equal(result.mode,'incremental');
      const [user] = await runtime.queryRaw("SELECT id FROM users WHERE username = 'import-user'");
      const [host] = await runtime.queryRaw("SELECT id FROM hosts WHERE agentToken = 'import-token'");
      assert.notEqual(Number(user.id),10); assert.notEqual(Number(host.id),100);
      const rows = await runtime.queryRaw("SELECT key,value FROM system_settings WHERE key LIKE 'topologyAnnotations:%'");
      assert.equal(rows.length,1); assert.equal(rows[0].key,'topologyAnnotations:' + user.id);
      assert.equal(JSON.parse(rows[0].value)[0].targetNodeId,'host:' + host.id);
      console.log('ok'); process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(dir, "db.sqlite") }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ok/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
