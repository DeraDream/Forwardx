import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import Database from "better-sqlite3";
import { startSublinkService, stopSublinkService, exportSublinkBackup, importSublinkBackup } from "./sublinkService";
import { decryptMigrationSnapshotBackup, encryptMigrationSnapshot } from "./migration";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch("http://127.0.0.1:8000/api/v1/version", { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* starting */ }
    await wait(100);
  }
  throw new Error("SublinkX did not become ready");
}

test("real SublinkX backup survives encryption, restore and supervised restart", { skip: process.env.FORWARDX_SUBLINK_INTEGRATION !== "1", timeout: 120_000 }, async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(8000, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const root = mkdtempSync(path.join(os.tmpdir(), "forwardx-sublink-integration-"));
  const previous = process.env.FORWARDX_SUBLINK_DATA_DIR;
  try {
    const binDir = path.join(root, "dist", "sublinkx");
    mkdirSync(binDir, { recursive: true });
    const binary = path.join(binDir, `sublink-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`);
    execFileSync("go", ["build", "-o", binary, "."], { cwd: path.resolve("services/sublinkx"), stdio: "pipe" });
    const data = path.join(root, "data");
    process.env.FORWARDX_SUBLINK_DATA_DIR = data;
    startSublinkService(path.join(root, "dist"));
    await waitReady();
    writeFileSync(path.join(data, "template", "backup-test.conf"), "[Plugin]\nhttps://example.com/a.plugin\n");
    mkdirSync(path.join(data, "rule_templates"), { recursive: true });
    writeFileSync(path.join(data, "rule_templates", "backup-test.yaml"), "modules: []\n");
    const dbPath = path.join(data, "db", "sublink.db");
    let db = new Database(dbPath);
    db.exec("CREATE TABLE backup_probe (value TEXT NOT NULL); INSERT INTO backup_probe VALUES ('original');");
    db.prepare("INSERT INTO nodes (id,name,link) VALUES (?,?,?)").run(7001, "test-node", "trojan://password@example.com:443#test");
    db.prepare("INSERT INTO subcriptions (id,name,config,token) VALUES (?,?,?,?)").run(7001, "test-sub", '{"output_type":"loon"}', "test-token");
    db.prepare("INSERT INTO node_subscriptions (id,name,token) VALUES (?,?,?)").run(7001, "test-node-sub", "test-node-token");
    db.prepare("INSERT INTO subcription_nodes (subcription_id,node_id) VALUES (?,?)").run(7001, 7001);
    db.prepare("INSERT INTO node_subscription_nodes (node_subscription_id,node_id) VALUES (?,?)").run(7001, 7001);
    db.close();
    const archive = await exportSublinkBackup();
    const encrypted = JSON.stringify(encryptMigrationSnapshot({ version: 1, exportedAt: Date.now(), tables: {}, sublinkBackup: archive }, "backup-password"));
    assert.throws(() => decryptMigrationSnapshotBackup(encrypted, "wrong-password"), /密码错误/);
    await assert.rejects(importSublinkBackup(Buffer.from("invalid archive").toString("base64")));
    await waitReady();
    db = new Database(dbPath);
    db.exec("UPDATE backup_probe SET value = 'changed'");
    db.close();
    writeFileSync(path.join(data, "template", "backup-test.conf"), "changed\n");
    await importSublinkBackup(decryptMigrationSnapshotBackup(encrypted, "backup-password").sublinkBackup!);
    await wait(3500);
    await waitReady();
    db = new Database(dbPath, { readonly: true });
    assert.equal((db.prepare("SELECT value FROM backup_probe").get() as { value: string }).value, "original");
    assert.equal((db.prepare("SELECT token FROM subcriptions WHERE id=7001").get() as { token: string }).token, "test-token");
    assert.equal((db.prepare("SELECT token FROM node_subscriptions WHERE id=7001").get() as { token: string }).token, "test-node-token");
    assert.equal((db.prepare("SELECT node_id FROM subcription_nodes WHERE subcription_id=7001").get() as { node_id: number }).node_id, 7001);
    assert.equal((db.prepare("SELECT node_id FROM node_subscription_nodes WHERE node_subscription_id=7001").get() as { node_id: number }).node_id, 7001);
    db.close();
    assert.equal(readFileSync(path.join(data, "template", "backup-test.conf"), "utf8"), "[Plugin]\nhttps://example.com/a.plugin\n");
    assert.equal(readFileSync(path.join(data, "rule_templates", "backup-test.yaml"), "utf8"), "modules: []\n");
  } finally {
    stopSublinkService();
    await wait(500);
    if (previous === undefined) delete process.env.FORWARDX_SUBLINK_DATA_DIR; else process.env.FORWARDX_SUBLINK_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
