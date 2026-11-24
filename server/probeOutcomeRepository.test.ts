import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("rule endpoint and service health histories stay in separate stores", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const repository = await import("./repositories/probeOutcomeRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-probe-outcome-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "probe.db") } });
    await ensureDatabaseSchema();
    const endpoint = {
      ruleId: 10,
      sourceHostId: 1,
      targetHostId: 2,
      targetAddress: "198.51.100.2",
      targetPort: 443,
      transport: "tcp" as const,
      probeMethod: "tcp-connect",
      probeRoundId: "round-1",
      latencyMs: 12,
      isTimeout: false,
      probeCount: 3,
      probeSuccesses: 2,
    };
    await repository.recordRuleEndpointLatencyStats([endpoint, endpoint]);
    const endpointRows = await repository.getRuleEndpointLatencyHistory(10);
    assert.equal(endpointRows.length, 1);
    assert.equal(Number(endpointRows[0].latencyMs), 12);
    assert.equal(Number(endpointRows[0].probeSuccesses), 2);

    const health = {
      serviceType: "landing-service",
      serviceId: 20,
      hostId: 2,
      targetAddress: "127.0.0.1",
      targetPort: 8388,
      transport: "tcp" as const,
      probeMethod: "protocol-health",
      probeRoundId: "round-1",
      status: "healthy" as const,
      latencyMs: 5,
      probeCount: 1,
      probeSuccesses: 1,
    };
    await repository.recordServiceHealthStats([health, health]);
    const healthRows = await repository.getServiceHealthHistory("landing-service", 20);
    assert.equal(healthRows.length, 1);
    assert.equal(healthRows[0].status, "healthy");
    assert.equal(Number(healthRows[0].latencyMs), 5);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
