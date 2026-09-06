import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureDatabaseSchema } from "./dbSchema";

test("landing host and service tables are included in the portable schema", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?) ORDER BY name")
      .all("table", "landing_hosts", "landing_services") as Array<{ name: string }>;
    assert.deepEqual(rows.map((row) => row.name), ["landing_hosts", "landing_services"]);
  } finally {
    sqlite.close();
  }
});
