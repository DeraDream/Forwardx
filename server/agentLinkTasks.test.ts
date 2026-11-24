import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyAgentProbeRequest } from "./agentProbeProtocol";

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

test("Agent Link tasks are deduplicated, authenticated and persisted", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const tasks = await import("./agentLinkTasks");
  const repository = await import("./repositories/agentLinkRepository");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-agent-link-task-"));
  const databasePath = path.join(directory, "tasks.db");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: databasePath } });
    await ensureDatabaseSchema();
    const now = Math.floor(Date.now() / 1000);
    await runtime.executeRaw(
      `INSERT INTO users (id, username, password) VALUES (?, ?, ?)`,
      [1, "agent-link-test", "test"],
    );
    await runtime.executeRaw(
      `INSERT INTO hosts (id, name, ip, agentToken, agentProbeVersion, agentProbePort, agentProbeTcpReady, agentProbeUdpReady, agentProbeCheckedAt, userId)
       VALUES (?, ?, ?, ?, 1, 9811, 1, 1, ?, ?)`,
      [1, "source", "198.51.100.1", "source-token", now, 1],
    );
    await runtime.executeRaw(
      `INSERT INTO hosts (id, name, ip, agentToken, agentProbeVersion, agentProbePort, agentProbeTcpReady, agentProbeUdpReady, agentProbeCheckedAt, userId)
       VALUES (?, ?, ?, ?, 1, 9811, 1, 1, ?, ?)`,
      [2, "target", "198.51.100.2", "target-token", now, 1],
    );

    const input = {
      sourceHostId: 1,
      targetHostId: 2,
      targetAddress: "198.51.100.2",
      targetPort: 9811,
      transport: "udp" as const,
      probeRoundId: "round-task-1",
    };
    const task = await tasks.enqueueAgentLinkProbeTask(input);
    const duplicate = await tasks.enqueueAgentLinkProbeTask(input);
    assert.equal(duplicate.taskId, task.taskId);
    assert.equal(task.attempts.length, 5);
    assert.ok(tasks.hasQueuedAgentLinkProbeTasks(1));
    assert.equal(await tasks.completeAgentLinkProbeTask(1, {
      taskId: task.taskId,
      probeRoundId: task.probeRoundId,
      latencyMs: 12,
      probeSuccesses: 5,
    }), false, "queued tasks cannot be completed before dispatch");

    const dispatched = await tasks.takeAgentLinkProbeTasks(1);
    assert.equal(dispatched.length, 1);
    assert.equal(tasks.hasQueuedAgentLinkProbeTasks(1), false);
    for (const attempt of task.attempts) {
      const verified = verifyAgentProbeRequest({
        token: "target-token",
        transport: "udp",
        request: Buffer.from(attempt.request, "base64"),
      });
      assert.ok(verified);
      assert.equal(verified.response.toString("base64"), attempt.expectedResponse);
    }

    // The Agent has the task already; simulate a Panel restart before it
    // returns its result. Completion must restore authoritative identity from
    // the durable running row rather than trusting result fields.
    tasks.resetAgentLinkProbeTaskMemoryForTest();
    assert.equal(tasks.getAgentLinkProbeTaskState(task.taskId), null);
    assert.equal(await tasks.completeAgentLinkProbeTask(1, {
      taskId: task.taskId,
      probeRoundId: "wrong-round",
      latencyMs: 12,
      probeSuccesses: 5,
    }), false);
    assert.equal(await tasks.completeAgentLinkProbeTask(1, {
      taskId: task.taskId,
      probeRoundId: task.probeRoundId,
      latencyMs: 12,
      minLatencyMs: 20,
      maxLatencyMs: 10,
      probeSuccesses: 5,
    }), false, "impossible latency bounds are rejected");
    const concurrentReports = await Promise.all([
      tasks.completeAgentLinkProbeTask(1, {
        taskId: task.taskId,
        probeRoundId: task.probeRoundId,
        latencyMs: 12,
        minLatencyMs: 10,
        maxLatencyMs: 15,
        jitterMs: 2,
        probeSuccesses: 4,
      }),
      tasks.completeAgentLinkProbeTask(1, {
        taskId: task.taskId,
        probeRoundId: task.probeRoundId,
        latencyMs: 99,
        probeSuccesses: 5,
      }),
    ]);
    assert.deepEqual(concurrentReports, [true, false]);

    const latest = await repository.getAgentLinkLatest([task.edgeKey]);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].probeRoundId, task.probeRoundId);
    assert.equal(latest[0].probeCount, 5);
    assert.equal(latest[0].probeSuccesses, 4);
    assert.equal(latest[0].latencyMs, 12);
    const history = await repository.getAgentLinkHistory(task.edgeKey);
    assert.equal(history.length, 1);
    const completedDuplicate = await tasks.enqueueAgentLinkProbeTask(input);
    assert.equal(completedDuplicate.taskId, task.taskId, "the same edge and round retain one task identity");
    assert.equal(tasks.hasQueuedAgentLinkProbeTasks(1), false);

    const timeoutTask = await tasks.enqueueAgentLinkProbeTask({ ...input, probeRoundId: "round-task-timeout" });
    assert.equal((await tasks.takeAgentLinkProbeTasks(1)).length, 1);
    assert.equal(await tasks.completeAgentLinkProbeTask(1, {
      taskId: timeoutTask.taskId,
      probeRoundId: timeoutTask.probeRoundId,
      probeSuccesses: 0,
      errorCode: "timeout",
    }), true);
    const timeoutHistory = await repository.getAgentLinkHistory(timeoutTask.edgeKey);
    assert.equal(timeoutHistory.length, 2);
    assert.equal(timeoutHistory[0].probeRoundId, timeoutTask.probeRoundId);
    assert.equal(timeoutHistory[0].isTimeout, true);
    assert.equal(timeoutHistory[0].latencyMs, null);

    const expiredTask = await tasks.enqueueAgentLinkProbeTask({ ...input, probeRoundId: "round-task-expired" });
    tasks.resetAgentLinkProbeTaskMemoryForTest();
    assert.equal(await tasks.sweepExpiredAgentLinkProbeTasks(expiredTask.expiresAt + 1), 1);
    assert.equal(tasks.getAgentLinkProbeTaskState(expiredTask.taskId)?.status, "timeout");
    assert.equal(tasks.hasQueuedAgentLinkProbeTasks(1), false, "expired terminal tasks are removed from dispatch queue");
    const expiredHistory = await repository.getAgentLinkHistory(expiredTask.edgeKey);
    assert.equal(expiredHistory.length, 3);
    assert.ok(expiredHistory.some((sample) => sample.probeRoundId === expiredTask.probeRoundId && sample.isTimeout));

    const unavailableTask = await tasks.enqueueAgentLinkProbeTask({ ...input, probeRoundId: "round-task-capability" });
    await runtime.executeRaw(`UPDATE hosts SET agentProbeUdpReady = 0 WHERE id = 2`);
    assert.equal((await tasks.takeAgentLinkProbeTasks(1)).length, 0);
    const unavailableHistory = await repository.getAgentLinkHistory(unavailableTask.edgeKey);
    assert.ok(unavailableHistory.some((sample) => sample.probeRoundId === unavailableTask.probeRoundId
      && sample.isTimeout && sample.errorCode === "capability-unavailable"));

    const queueTasks: any[] = [];
    for (let index = 0; index < 257; index += 1) {
      queueTasks.push(await tasks.enqueueAgentLinkProbeTask({
        sourceHostId: 1,
        targetHostId: 2,
        targetAddress: `queued-target-${index}.example`,
        targetPort: 9811,
        transport: "tcp",
        probeRoundId: `queue-overflow-${index}`,
        attemptCount: 1,
      }));
    }
    assert.equal(await waitFor(() => tasks.getAgentLinkProbeTaskState(queueTasks[0].taskId)?.status === "timeout"), true);
    assert.equal(tasks.getAgentLinkProbeTaskState(queueTasks[1].taskId)?.status, "queued");
    const overflowHistory = await repository.getAgentLinkHistory(queueTasks[0].edgeKey);
    assert.equal(overflowHistory.length, 1);
    assert.equal(overflowHistory[0].isTimeout, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
