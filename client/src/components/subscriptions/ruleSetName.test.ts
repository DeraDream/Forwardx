import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ruleSetDisplayName } from "./ruleSetName";

test("derive a readable Egern label from remote rule source without query or extension", () => {
  assert.equal(ruleSetDisplayName("https://raw.githubusercontent.com/owner/repo/main/Steam/Steam.list?token=1#part", "fallback"), "Steam");
  assert.equal(ruleSetDisplayName("https://example.com/%E8%A7%84%E5%88%99.yaml", "fallback"), "规则");
  assert.equal(ruleSetDisplayName("./rules/LocalAreaNetwork.yaml", "fallback"), "LocalAreaNetwork");
});

test("invalid or missing names have a stable fallback", () => {
  assert.equal(ruleSetDisplayName("https://example.com/", "规则集 15"), "规则集 15");
  assert.equal(ruleSetDisplayName("", "规则集 14"), "规则集 14");
  assert.equal(ruleSetDisplayName("https://[invalid", "fallback"), "fallback");
});
