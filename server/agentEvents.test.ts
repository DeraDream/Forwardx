import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  pushAgentSupportBundle,
  markHostTopologyTrafficWatching,
  isHostTopologyTrafficWatching,
  stopHostTopologyTrafficWatching,
  registerAgentEventClient,
  unregisterAgentEventClient,
} from "./agentEvents";

test("topology stays interactive while mounted even if browser timers throttle, and stops on leave", () => {
  const now = 1_000_000;
  markHostTopologyTrafficWatching([2, 3], 120_000, now, "user:page-a");
  assert.equal(isHostTopologyTrafficWatching(3, now + 60_000), true);
  assert.equal(isHostTopologyTrafficWatching(4, now + 60_000), false);
  stopHostTopologyTrafficWatching("user:page-a");
  assert.equal(isHostTopologyTrafficWatching(3, now + 60_000), false);
  markHostTopologyTrafficWatching([2], 2_500, now);
  assert.equal(isHostTopologyTrafficWatching(2, now + 2_000), true);
  assert.equal(isHostTopologyTrafficWatching(2, now + 3_000), false);
});

class FakeEventResponse extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  failNextWrites = 0;
  ended = false;

  write(value: string) {
    this.writes.push(String(value));
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      return false;
    }
    return true;
  }

  end() {
    this.ended = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
  }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

function asResponse(value: FakeEventResponse) {
  return value as any;
}

test("Agent SSE queues complete event frames until the response drains", () => {
  const response = new FakeEventResponse();
  response.failNextWrites = 1;
  const stream = registerAgentEventClient(910_001, "event-test-token", asResponse(response));

  assert.equal(stream.writeEvent("ready", { success: true }), true);
  assert.equal(stream.writeEvent("agent-desired-state", { revision: 2 }), true);
  assert.equal(stream.writeComment("ping"), true);
  assert.equal(response.writes.length, 1, "events after backpressure should not enter the socket buffer");
  assert.match(response.writes[0], /^event: message\ndata: .+\n\n$/s);

  response.emit("drain");
  assert.equal(response.writes.length, 2, "queued state should flush after drain");
  assert.match(response.writes[1], /^event: message\ndata: .+\n\n$/s);
  stream.close();
});

test("Agent SSE destroys a connection whose bounded backlog is exhausted", () => {
  const response = new FakeEventResponse();
  response.failNextWrites = 1;
  const stream = registerAgentEventClient(910_002, "event-test-token", asResponse(response));

  assert.equal(stream.writeEvent("ready", { success: true }), true);
  for (let index = 0; index < 16; index += 1) {
    assert.equal(stream.writeEvent("agent-desired-state", { revision: index }), true);
  }
  assert.equal(stream.writeEvent("agent-desired-state", { revision: 17 }), false);
  assert.equal(response.destroyed, true);
  assert.equal(pushAgentSupportBundle(910_002, "after-close"), false, "closed streams must be unregistered");
});

test("Agent SSE response errors release the registered client", () => {
  const response = new FakeEventResponse();
  const stream = registerAgentEventClient(910_003, "event-test-token", asResponse(response));

  response.emit("error", new Error("socket reset"));
  assert.equal(response.destroyed, true);
  assert.equal(stream.writeEvent("agent-refresh", {}), false);
  assert.equal(pushAgentSupportBundle(910_003, "after-error"), false);
});

test("replacing an Agent SSE stream closes the old response without unregistering the new one", () => {
  const oldResponse = new FakeEventResponse();
  const newResponse = new FakeEventResponse();
  registerAgentEventClient(910_004, "old-token", asResponse(oldResponse));
  const newStream = registerAgentEventClient(910_004, "new-token", asResponse(newResponse));

  assert.equal(oldResponse.ended, true);
  unregisterAgentEventClient(910_004, asResponse(oldResponse));
  assert.equal(pushAgentSupportBundle(910_004, "new-stream"), true);
  assert.equal(newResponse.writes.length, 1);
  newStream.close();
});
