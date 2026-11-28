import assert from "node:assert/strict";
import test from "node:test";
import { isTelegramMessageNotModified } from "./telegramEditError";

test("unchanged Telegram edits are harmless", () => {
  assert.equal(isTelegramMessageNotModified(new Error("Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message")), true);
});

test("other Telegram errors must still fail", () => {
  assert.equal(isTelegramMessageNotModified(new Error("Bad Request: message to edit not found")), false);
  assert.equal(isTelegramMessageNotModified(new Error("Forbidden: bot was blocked by the user")), false);
  assert.equal(isTelegramMessageNotModified(new Error("Network error: message is not modified")), false);
  assert.equal(isTelegramMessageNotModified("Bad Request: message is not modified"), false);
});
