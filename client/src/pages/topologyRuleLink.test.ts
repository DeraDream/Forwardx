import { strict as assert } from "node:assert";
import { test } from "node:test";
import { topologyRuleFocusId, topologyRuleHref } from "./topologyRuleLink";

test("topology rule links retain the exact rule ID", () => {
  assert.equal(topologyRuleHref(42), "/rules?focusRule=42");
  assert.equal(topologyRuleFocusId("tab=tunnel&focusRule=42"), 42);
});

test("rejects invalid and unsafe rule IDs", () => {
  for (const value of ["", "0", "-1", "1e3", "4.2", "9007199254740992"]) {
    assert.equal(topologyRuleFocusId(`focusRule=${value}`), null);
  }
  assert.throws(() => topologyRuleHref(0));
});
