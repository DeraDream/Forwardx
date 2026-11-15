import assert from "node:assert/strict";
import test from "node:test";
import { canFinalizeSettledPendingRule } from "./pendingForwardRuleCleanup";

const settled = {
  pendingDelete: true,
  isRunning: false,
  ruleId: 116,
  sourcePort: 31287,
  completeRuntimeSnapshot: true,
  localRules: [],
};

test("settled deleted tunnel rule can finalize once the Agent reports no owner", () => {
  assert.equal(canFinalizeSettledPendingRule(settled), true);
  assert.equal(canFinalizeSettledPendingRule({
    ...settled,
    localRules: [{ ruleId: 117, port: 20000 }],
  }), true);
});

test("pending rule keeps its port until runtime state is confirmed clean", () => {
  assert.equal(canFinalizeSettledPendingRule({ ...settled, completeRuntimeSnapshot: false }), false);
  assert.equal(canFinalizeSettledPendingRule({
    ...settled,
    localRules: [{ ruleId: 116, port: 31287 }],
  }), false);
  assert.equal(canFinalizeSettledPendingRule({
    ...settled,
    localRules: [{ ruleId: 0, port: 31287 }],
  }), false);
  assert.equal(canFinalizeSettledPendingRule({
    ...settled,
    localRules: [{ ruleId: 999, port: 31287 }],
  }), false);
});

test("running or non-deleted rules are not finalized", () => {
  assert.equal(canFinalizeSettledPendingRule({ ...settled, isRunning: true }), false);
  assert.equal(canFinalizeSettledPendingRule({ ...settled, pendingDelete: false }), false);
});
