import assert from "node:assert/strict";
import test from "node:test";
import {
  claimLinkSpeedTask,
  createLinkSpeedJob,
  getLinkSpeedBenchmarkLease,
  reportLinkSpeedTask,
  takeLinkSpeedTasks,
} from "./linkSpeedTasks";

test("full-link speed tasks advance prepare, run and cleanup while retaining measurements", () => {
  const hostId = 987654;
  const status = createLinkSpeedJob({
    userId: 1,
    ruleId: 22,
    entryHostId: hostId,
    pathId: "rule:22:0",
    name: "HK-SG",
    protocol: "tcp",
    duration: 3,
    rateMbps: 0,
    route: [
      { hostId, name: "HK", transport: "规则入口", agentVersion: "2.2.243" },
      { hostId: hostId + 1, name: "SG", transport: "落地 SS", agentVersion: "2.2.243" },
    ],
    entryAddress: "127.0.0.1",
    entryPort: 29539,
    ssMethod: "aes-256-gcm",
    ssPassword: "secret-password",
    benchmarkHost: "panel.example.com",
    benchmarkPort: 5202,
  });

  const prepare = takeLinkSpeedTasks(hostId)[0];
  assert.equal(prepare.op, "prepare");
  assert.equal(claimLinkSpeedTask(hostId, prepare.taskId, prepare.jobId), true);
  assert.ok(getLinkSpeedBenchmarkLease(prepare.token));
  assert.equal(reportLinkSpeedTask(hostId, { taskId: prepare.taskId, jobId: prepare.jobId, state: "ready" }), true);

  const run = takeLinkSpeedTasks(hostId)[0];
  assert.equal(run.op, "run");
  assert.equal(reportLinkSpeedTask(hostId, {
    taskId: run.taskId,
    jobId: run.jobId,
    samples: [{ direction: "upload", elapsedMs: 100, bytes: 1000, mbps: 0.08 }],
    upload: { bytes: 3000, durationMs: 3000, mbps: 0.008, peakMbps: 0.08 },
    download: { bytes: 6000, durationMs: 3000, mbps: 0.016, peakMbps: 0.1 },
    state: "completed",
  }), true);
  assert.equal(status.state, "completed");
  assert.equal(status.samples.length, 1);
  assert.equal(status.upload?.bytes, 3000);
  assert.equal(status.download?.bytes, 6000);
  assert.equal(getLinkSpeedBenchmarkLease(prepare.token), null);

  const stop = takeLinkSpeedTasks(hostId)[0];
  assert.equal(stop.op, "stop");
  assert.equal(reportLinkSpeedTask(hostId, { taskId: stop.taskId, jobId: stop.jobId, state: "stopped" }), true);
});
