import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Agent probe port is a permanent per-host system reservation", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const reserved = await import("./systemReservedPorts");
  const tunnelRepository = await import("./repositories/tunnelRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-reserved-port-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "ports.db") } });
    await ensureDatabaseSchema();
    await runtime.executeRaw(`INSERT INTO users (id, username, password) VALUES (1, 'reserved-port', 'test')`);
    await runtime.executeRaw(
      `INSERT INTO hosts (id, name, ip, userId, agentProbePort) VALUES (1, 'host', '198.51.100.1', 1, 12345)`,
    );
    assert.equal(await reserved.isSystemReservedPort(1, 12345), true);
    assert.equal(await reserved.isSystemReservedPort(1, 9811), false);
    await assert.rejects(() => reserved.assertPortNotSystemReserved(1, 12345), /Agent 探测端口/);
    assert.equal(await tunnelRepository.isPortUsedOnHost(1, 12345), true);
    assert.equal((await tunnelRepository.getUsedPortsOnHost(1)).has(12345), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
