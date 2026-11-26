import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { decryptPayload } from "./agentCrypto";
import { registerAgentEventClient } from "./agentEvents";
import { completeExternalForwardPortCheck, requestExternalForwardPortCheck } from "./externalForwardPorts";

class FakeResponse extends EventEmitter {
  writes: string[] = [];
  write(value: string) { this.writes.push(value); return true; }
  end() { this.emit("finish"); }
}

test("real-time checks use authenticated SSE request/response and reject wrong hosts", async () => {
  const hostId = 918273;
  const token = "port-check-test-token";
  const res = new FakeResponse();
  const stream = registerAgentEventClient(hostId, token, res as any);
  try {
    const pending = requestExternalForwardPortCheck(hostId, 18443, "tcp");
    const frame = res.writes[0];
    const envelope = JSON.parse(frame.match(/^event: message\ndata: (.+)\n\n$/s)?.[1] || "null");
    const message = decryptPayload(envelope, token);
    assert.equal(message.type, "agent-external-port-check");
    assert.equal(message.data.port, 18443);
    const requestId = message.data.requestId;
    assert.equal(completeExternalForwardPortCheck(hostId + 1, { requestId, error: "", conflict: "" }), false);
    assert.equal(completeExternalForwardPortCheck(hostId, { requestId, error: "", conflict: "18443/tcp nft" }), true);
    assert.match(await pending || "", /占用/);
    assert.equal(completeExternalForwardPortCheck(hostId, { requestId, error: "", conflict: "" }), false);
  } finally {
    stream.close();
  }
});

test("real-time port checks reject invalid requests and unavailable Agents", async () => {
  assert.match(await requestExternalForwardPortCheck(1, 0, "tcp") || "", /参数无效/);
  assert.match(await requestExternalForwardPortCheck(918274, 18443, "tcp") || "", /连接不可用/);
});
