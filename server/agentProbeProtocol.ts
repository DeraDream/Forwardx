import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AGENT_PROBE_PROTOCOL_VERSION } from "../shared/agentProbe";

export type AgentProbeTransport = "tcp" | "udp";

export const AGENT_PROBE_REQUEST_SIZE = 64;
export const AGENT_PROBE_RESPONSE_SIZE = 56;
export const AGENT_PROBE_NONCE_SIZE = 16;
export const AGENT_PROBE_MAC_SIZE = 32;
export const AGENT_PROBE_MAX_TICKET_LIFETIME_SECONDS = 10 * 60;
export const AGENT_PROBE_CLOCK_SKEW_SECONDS = 60;

const REQUEST_MAGIC = Buffer.from("FXP1", "ascii");
const RESPONSE_MAGIC = Buffer.from("FXR1", "ascii");
const TRANSPORT_CODE: Record<AgentProbeTransport, number> = { tcp: 1, udp: 2 };

function tokenBuffer(token: string) {
  const value = String(token || "");
  if (!value) throw new Error("Agent probe token is required");
  return Buffer.from(value, "utf8");
}

function normalizeNonce(value?: Buffer | Uint8Array | string) {
  if (value === undefined) return randomBytes(AGENT_PROBE_NONCE_SIZE);
  const nonce = typeof value === "string" ? Buffer.from(value, "hex") : Buffer.from(value);
  if (nonce.length !== AGENT_PROBE_NONCE_SIZE) throw new Error("Agent probe nonce must be 16 bytes");
  return nonce;
}

function hmac(token: string, data: Buffer) {
  return createHmac("sha256", tokenBuffer(token)).update(data).digest();
}

function requestHeader(transport: AgentProbeTransport, expiresAt: number, nonce: Buffer) {
  const header = Buffer.alloc(32);
  REQUEST_MAGIC.copy(header, 0);
  header[4] = AGENT_PROBE_PROTOCOL_VERSION;
  header[5] = TRANSPORT_CODE[transport];
  header.writeUInt16BE(0, 6);
  header.writeBigUInt64BE(BigInt(expiresAt), 8);
  nonce.copy(header, 16);
  return header;
}

function responseHeader(transport: AgentProbeTransport, nonce: Buffer) {
  const header = Buffer.alloc(24);
  RESPONSE_MAGIC.copy(header, 0);
  header[4] = AGENT_PROBE_PROTOCOL_VERSION;
  header[5] = TRANSPORT_CODE[transport];
  header.writeUInt16BE(0, 6);
  nonce.copy(header, 8);
  return header;
}

export function createAgentProbeTicket(input: {
  token: string;
  transport: AgentProbeTransport;
  nowSeconds?: number;
  expiresAtSeconds?: number;
  ttlSeconds?: number;
  nonce?: Buffer | Uint8Array | string;
}) {
  const nowSeconds = Math.floor(Number(input.nowSeconds ?? Date.now() / 1000));
  const ttlSeconds = Math.max(1, Math.min(
    AGENT_PROBE_MAX_TICKET_LIFETIME_SECONDS,
    Math.floor(Number(input.ttlSeconds ?? 60)),
  ));
  const expiresAt = Math.floor(Number(input.expiresAtSeconds ?? nowSeconds + ttlSeconds));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("Invalid Agent probe expiry");
  const nonce = normalizeNonce(input.nonce);
  const requestHead = requestHeader(input.transport, expiresAt, nonce);
  const responseHead = responseHeader(input.transport, nonce);
  const request = Buffer.concat([requestHead, hmac(input.token, requestHead)]);
  const expectedResponse = Buffer.concat([responseHead, hmac(input.token, responseHead)]);
  return {
    version: AGENT_PROBE_PROTOCOL_VERSION,
    transport: input.transport,
    expiresAt,
    nonce: nonce.toString("hex"),
    request,
    expectedResponse,
    requestBase64: request.toString("base64"),
    expectedResponseBase64: expectedResponse.toString("base64"),
  };
}

export function verifyAgentProbeRequest(input: {
  token: string;
  transport: AgentProbeTransport;
  request: Buffer | Uint8Array;
  nowSeconds?: number;
}) {
  const request = Buffer.from(input.request);
  if (request.length !== AGENT_PROBE_REQUEST_SIZE) return null;
  const header = request.subarray(0, 32);
  if (!header.subarray(0, 4).equals(REQUEST_MAGIC)) return null;
  if (header[4] !== AGENT_PROBE_PROTOCOL_VERSION || header[5] !== TRANSPORT_CODE[input.transport]) return null;
  if (header.readUInt16BE(6) !== 0) return null;
  const expiresAtBig = header.readBigUInt64BE(8);
  if (expiresAtBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const expiresAt = Number(expiresAtBig);
  const nowSeconds = Math.floor(Number(input.nowSeconds ?? Date.now() / 1000));
  if (expiresAt < nowSeconds - AGENT_PROBE_CLOCK_SKEW_SECONDS) return null;
  if (expiresAt > nowSeconds + AGENT_PROBE_MAX_TICKET_LIFETIME_SECONDS) return null;
  const expected = hmac(input.token, header);
  const actual = request.subarray(32);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return {
    expiresAt,
    nonce: Buffer.from(header.subarray(16, 32)),
    response: Buffer.concat([
      responseHeader(input.transport, Buffer.from(header.subarray(16, 32))),
      hmac(input.token, responseHeader(input.transport, Buffer.from(header.subarray(16, 32)))),
    ]),
  };
}

export function verifyAgentProbeResponse(expected: Buffer | Uint8Array, actual: Buffer | Uint8Array) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && left.length === AGENT_PROBE_RESPONSE_SIZE && timingSafeEqual(left, right);
}
