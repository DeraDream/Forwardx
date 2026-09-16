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
    assert.ok(nodeColumns.some((column) => column.name === "latencyDetails"));
  } finally {
    sqlite.close();
  }
});

test("portable schema upgrades legacy full-chain nodes for forward-chain references", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec('CREATE TABLE full_chain_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, chainId INTEGER NOT NULL, hostId INTEGER NOT NULL, sortOrder INTEGER NOT NULL)');
    sqlite.exec('INSERT INTO full_chain_nodes (chainId, hostId, sortOrder) VALUES (1, 11, 0)');
    await ensureDatabaseSchema(sqlite);
    const columns = sqlite.prepare("PRAGMA table_info(full_chain_nodes)").all() as Array<{ name: string; notnull: number }>;
    assert.equal(columns.find((column) => column.name === "hostId")?.notnull, 0);
    assert.ok(columns.some((column) => column.name === "forwardGroupId"));
    assert.ok(columns.some((column) => column.name === "latencyDetails"));
    assert.deepEqual(sqlite.prepare('SELECT nodeType, hostId, forwardGroupId FROM full_chain_nodes').get(), { nodeType: "host", hostId: 11, forwardGroupId: null });
  } finally {
    sqlite.close();
  }
});
