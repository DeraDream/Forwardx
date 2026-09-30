import assert from "node:assert/strict";
import test from "node:test";
import { beginPasskeyLogin, beginPasskeyRegistration, passkeyRequestContext } from "./passkey";

test("passkey request context honors forwarded HTTPS host", () => {
  const context = passkeyRequestContext({
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "panel.example.com",
      host: "127.0.0.1:3000",
    },
    secure: false,
  });
  assert.deepEqual(context, {
    rpId: "panel.example.com",
    origin: "https://panel.example.com",
  });
});

test("passkey login options require user verification", () => {
  const options = beginPasskeyLogin({
    headers: { host: "panel.example.com", "x-forwarded-proto": "https" },
    secure: false,
  });
  assert.equal(options.rpId, "panel.example.com");
  assert.equal(options.userVerification, "required");
  assert.ok(options.challenge.length >= 32);
});

test("passkey registration produces discoverable credential options", () => {
  const options = beginPasskeyRegistration({
    req: {
      headers: { host: "panel.example.com", "x-forwarded-proto": "https" },
      secure: false,
    },
    userId: 7,
    username: "user@example.com",
    displayName: "Forward User",
    userHandle: "dXNlci1oYW5kbGU",
    existingCredentialIds: [],
  });
  assert.equal(options.rp.id, "panel.example.com");
  assert.equal(options.authenticatorSelection.residentKey, "required");
  assert.equal(options.authenticatorSelection.userVerification, "required");
  assert.equal(options.attestation, "none");
});
