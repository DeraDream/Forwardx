import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROBE_REQUEST_SIZE,
  AGENT_PROBE_RESPONSE_SIZE,
  createAgentProbeTicket,
  verifyAgentProbeRequest,
  verifyAgentProbeResponse,
} from "./agentProbeProtocol";

const token = "forwardx-test-token";
const nonce = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const nowSeconds = 1_730_000_000;

test("Agent probe ticket has a stable authenticated wire format", () => {
  const ticket = createAgentProbeTicket({ token, transport: "tcp", nowSeconds, ttlSeconds: 60, nonce });
  assert.equal(ticket.request.length, AGENT_PROBE_REQUEST_SIZE);
  assert.equal(ticket.expectedResponse.length, AGENT_PROBE_RESPONSE_SIZE);
  assert.equal(ticket.expiresAt, nowSeconds + 60);
  assert.equal(ticket.request.toString("hex"), "465850310101000000000000671db4bc00112233445566778899aabbccddeeff0ba73b9117eabbf561c990361c72ea9d938ba52ed5d3daeda76a7587863b005d");
  assert.equal(ticket.expectedResponse.toString("hex"), "465852310101000000112233445566778899aabbccddeeffbab224c6618162e247a91eda7f8707b5f3264f39b72353fd7cfe57f387b2ab6e");
});

test("Agent probe request verifies only for the intended transport and time window", () => {
  const ticket = createAgentProbeTicket({ token, transport: "udp", nowSeconds, ttlSeconds: 60, nonce });
  const verified = verifyAgentProbeRequest({ token, transport: "udp", request: ticket.request, nowSeconds: nowSeconds + 1 });
  assert.ok(verified);
  assert.equal(verified.nonce.toString("hex"), nonce.toString("hex"));
  assert.equal(verifyAgentProbeResponse(ticket.expectedResponse, verified.response), true);
  assert.equal(verifyAgentProbeRequest({ token, transport: "tcp", request: ticket.request, nowSeconds }), null);
  assert.equal(verifyAgentProbeRequest({ token, transport: "udp", request: ticket.request, nowSeconds: nowSeconds + 700 }), null);

  const tampered = Buffer.from(ticket.request);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(verifyAgentProbeRequest({ token, transport: "udp", request: tampered, nowSeconds }), null);
});
