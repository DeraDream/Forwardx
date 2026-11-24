import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
process.env.DATABASE_TYPE = "sqlite";

const tcpEdge = {
  sourceHostId: 1,
  targetHostId: 2,
  targetAddress: "198.51.100.2",
  targetPort: 9811,
  transport: "tcp" as const,
};

test("Agent Link demand registry deduplicates a physical directed edge across consumers", async () => {
  const scheduler = await import("./agentLinkScheduler");
  scheduler.replaceAgentLinkDemands("test-owner-a", [tcpEdge]);
  scheduler.replaceAgentLinkDemands("test-owner-b", [tcpEdge]);
  assert.equal(scheduler.getAgentLinkSchedulerState().edgeCount, 1);
  assert.equal(scheduler.getAgentLinkSchedulerState().ownerCount >= 2, true);
  assert.equal(scheduler.touchAgentLinkDemands("test-owner-a", 30_000), 1);
  scheduler.clearAgentLinkDemands("test-owner-a");
  assert.equal(scheduler.getAgentLinkSchedulerState().edgeCount, 1);
  scheduler.clearAgentLinkDemands("test-owner-b");
  assert.equal(scheduler.getAgentLinkSchedulerState().edgeCount, 0);
});

test("Agent Link scheduling refreshes a target Agent probe port before dispatch", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const tasks = await import("./agentLinkTasks");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-link-scheduler-"));
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: path.join(directory, "scheduler.db") } });
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    await runtime.executeRaw(`INSERT INTO users (id, username, password) VALUES (1, 'scheduler-user', 'test')`);
    await runtime.executeRaw(
      `INSERT INTO hosts (id, name, ip, agentToken, agentProbeVersion, agentProbePort, agentProbeTcpReady, agentProbeUdpReady, agentProbeCheckedAt, userId)
       VALUES (1, 'source', '198.51.100.1', 'source-token', 1, 9811, 1, 1, ?, 1),
              (2, 'target', '198.51.100.2', 'target-token', 1, 9822, 1, 1, ?, 1)`,
      [now, now],
    );
    const scheduler = await import("./agentLinkScheduler");
    scheduler.replaceAgentLinkDemands("test-port-refresh", [tcpEdge], { mode: "background", ttlMs: 30_000 });
    const round = await scheduler.runAgentLinkProbeRound("background");
    assert.equal(round.queued, 1);
    const dispatched = await tasks.takeAgentLinkProbeTasks(1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].targetPort, 9822);
    scheduler.clearAgentLinkDemands("test-port-refresh");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
