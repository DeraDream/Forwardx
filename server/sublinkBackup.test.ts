import { test } from "node:test";
import { strict as assert } from "node:assert";
import { exportSublinkBackup, importSublinkBackup } from "./sublinkService";
import { decryptMigrationSnapshotBackup, encryptMigrationSnapshot, pruneMigrationSnapshotForPanelBackup } from "./migration";

test("subscription archive is encrypted with panel backup and sent for restore", async () => {
  const originalFetch = globalThis.fetch;
  const archive = Buffer.from("subscription database and templates");
  let imported: Uint8Array | undefined;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /^http:\/\/127\.0\.0\.1:8000\/api\/v1\/backup\//);
    assert.match(String((init?.headers as Record<string, string>).Authorization), /^Bearer /);
    if (String(input).endsWith("/export")) return new Response(archive);
    const file = (init?.body as FormData).get("file") as File;
    imported = new Uint8Array(await file.arrayBuffer());
    return Response.json({ code: "00000" });
  };
  try {
    const snapshot = pruneMigrationSnapshotForPanelBackup({ version: 1, exportedAt: Date.now(), tables: {} });
    snapshot.sublinkBackup = await exportSublinkBackup();
    const encrypted = JSON.stringify(encryptMigrationSnapshot(snapshot, "password123"));
    assert.ok(!encrypted.includes(archive.toString()));
    const restored = decryptMigrationSnapshotBackup(encrypted, "password123");
    assert.equal(restored.sublinkBackup, snapshot.sublinkBackup);
    await importSublinkBackup(restored.sublinkBackup!);
    assert.deepEqual(Buffer.from(imported!), archive);
  } finally { globalThis.fetch = originalFetch; }
});

test("subscription backup errors and invalid imports are not silently accepted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ msg: "database unavailable" }, { status: 500 });
  try {
    await assert.rejects(exportSublinkBackup(), /database unavailable/);
    await assert.rejects(importSublinkBackup("invalid!"), /无效/);
  } finally { globalThis.fetch = originalFetch; }
});
