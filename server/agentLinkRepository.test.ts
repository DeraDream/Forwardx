import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgentLinkEdgeKey } from "../shared/agentLink";

test("Agent Link repository stores idempotent history and rejects stale latest updates", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const repository = await import("./repositories/agentLinkRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-link-"));
  const databasePath = path.join(directory, "agent-link.db");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    await ensureDatabaseSchema();
    const identity = {
      sourceHostId: 1,
      targetHostId: 2,
      targetAddress: "198.51.100.2",
      targetPort: 9811,
      transport: "tcp" as const,
    };
    const edgeKey = buildAgentLinkEdgeKey(identity);
    const base = {
      ...identity,
      probeCount: 3,
      probeSuccesses: 3,
      isTimeout: false,
    };
    await repository.recordAgentLinkProbeSample({
      ...base,
      probeRoundId: "round-new",
      latencyMs: 20,
      recordedAt: new Date(2_000_000 * 1000),
    });
    await repository.recordAgentLinkProbeSample({
      ...base,
      probeRoundId: "round-old",
      latencyMs: 99,
      recordedAt: new Date(1_999_000 * 1000),
    });
    await repository.recordAgentLinkProbeSample({
      ...base,
      probeRoundId: "round-new",
      latencyMs: 20,
      recordedAt: new Date(2_000_000 * 1000),
    });

    const latest = await repository.getAgentLinkLatest([edgeKey]);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].probeRoundId, "round-new");
    assert.equal(latest[0].latencyMs, 20);

    const history = await repository.getAgentLinkHistory(edgeKey);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((row) => row.probeRoundId), ["round-new", "round-old"]);
    assert.equal((await repository.getAgentLinkRoundSamples("round-new", [edgeKey])).length, 1);

    const indexes = await runtime.queryRaw<{ name: string }>("PRAGMA index_list(agent_link_latency_stats)");
    assert.ok(indexes.some((row) => String(row.name).includes("edgeKey_probeRoundId")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
