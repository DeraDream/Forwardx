import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureDatabaseSchema } from "./dbSchema";

test("portable schema creates isolated full-chain resources", async () => {
  const sqlite = new Database(":memory:");
  try {
    await ensureDatabaseSchema(sqlite);
    const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?, ?, ?) ORDER BY name")
      .all("table", "full_chain_nodes", "full_chain_traffic_counters", "full_chain_traffic_stats", "full_chains") as Array<{ name: string }>;
    assert.deepEqual(rows.map((row) => row.name), ["full_chain_nodes", "full_chain_traffic_counters", "full_chain_traffic_stats", "full_chains"]);
    const nodeColumns = sqlite.prepare("PRAGMA table_info(full_chain_nodes)").all() as Array<{ name: string }>;
    assert.ok(nodeColumns.some((column) => column.name === "firewallStatus"));
  } finally {
    sqlite.close();
  }
});
