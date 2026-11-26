import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalLandingSsUri } from "./ruleCopySs";

const service = { endpoint: "155.103.50.67", host: { exitIp: "203.0.113.5", ip: "192.0.2.5" }, method: "aes-256-gcm", password: "secret123", port: 30001, name: "landing" };
const decodeCredentials = (uri: string) => Buffer.from(uri.slice(5).split("@")[0].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString();

test("copying a final SS URI defaults to the saved landing service endpoint", () => {
  const uri = buildFinalLandingSsUri(service, "landing");
  assert.match(uri, /@155\.103\.50\.67:30001#landing$/);
  assert.equal(decodeCredentials(uri), "aes-256-gcm:secret123");
  assert.match(buildFinalLandingSsUri({ ...service, endpoint: "" }, "landing"), /@203\.0\.113\.5:30001#/);
});

test("entry IP and entry-group domain only change the URI host, not its credentials or port", () => {
  const original = buildFinalLandingSsUri(service, "landing");
  for (const address of ["42.193.170.239", "ix.example.org", "2001:db8::1"]) {
    const copied = buildFinalLandingSsUri(service, "entry", address);
    assert.equal(decodeCredentials(copied), decodeCredentials(original));
    assert.match(copied, new RegExp(`@${address.includes(":") ? "\\[2001:db8::1\\]" : address.replaceAll(".", "\\.")}:30001#landing$`));
  }
  assert.equal(buildFinalLandingSsUri(service, "entry", ""), "");
});
