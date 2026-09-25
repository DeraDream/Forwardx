import assert from "node:assert/strict";
import test from "node:test";
import { parseShadowsocksUri } from "./shadowsocksUri";

test("parses common Shadowsocks links", () => {
  assert.deepEqual(parseShadowsocksUri("ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@example.com:8388#Tokyo"), {
    protocol: "ss", method: "aes-256-gcm", password: "password", endpoint: "example.com", port: 8388, name: "Tokyo",
  });
  assert.deepEqual(parseShadowsocksUri("ss://YWVzLTEyOC1nY206cHc@example.com:443"), {
    protocol: "ss", method: "aes-128-gcm", password: "pw", endpoint: "example.com", port: 443, name: "",
  });
  assert.equal(parseShadowsocksUri("ss://aes-256-gcm:password@example.com:8388").password, "password");
});

test("rejects malformed Shadowsocks links", () => {
  assert.throws(() => parseShadowsocksUri("https://example.com"));
  assert.throws(() => parseShadowsocksUri("ss://bad"));
});
