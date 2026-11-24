import assert from "node:assert/strict";
import test from "node:test";
import { agentProbeStatusChanged, normalizeAgentProbeStatus } from "./agentProbeStatus";

test("normalizes valid Agent probe status", () => {
  assert.deepEqual(normalizeAgentProbeStatus({
    version: 1,
    port: 9811,
    tcpReady: true,
    udpReady: 1,
    message: " ready ",
  }), {
    version: 1,
    port: 9811,
    tcpReady: true,
    udpReady: true,
    message: "ready",
  });
});

test("rejects unsupported or invalid Agent probe status", () => {
  assert.equal(normalizeAgentProbeStatus(null), null);
  assert.equal(normalizeAgentProbeStatus({ version: 2, port: 9811 }), null);
  assert.equal(normalizeAgentProbeStatus({ version: 1, port: 0 }), null);
});

test("detects Agent probe capability changes", () => {
  const report = normalizeAgentProbeStatus({ version: 1, port: 9811, tcpReady: true, udpReady: true });
  assert.equal(agentProbeStatusChanged({}, report), true);
  assert.equal(agentProbeStatusChanged({
    agentProbeVersion: 1,
    agentProbePort: 9811,
    agentProbeTcpReady: true,
    agentProbeUdpReady: true,
    agentProbeMessage: null,
  }, report), false);
});
