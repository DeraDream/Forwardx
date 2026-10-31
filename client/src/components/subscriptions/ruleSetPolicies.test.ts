import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ruleSetPolicyOptions } from "./ruleSetPolicies";

test("Loon policies include native builtins and enabled named groups only", () => {
  const source = `[General]
foo = bar
[Proxy Group]
PROXY = select,node-a,DIRECT
节点选择 = select,PROXY,DIRECT
# 停用 = select,DIRECT
; ignored = select,DIRECT
[Rule]
FINAL,DIRECT
`;
  assert.deepEqual(ruleSetPolicyOptions("loon", source), ["DIRECT", "REJECT", "PROXY", "节点选择"]);
});

test("Egern policies include native builtins and every declared group type", () => {
  const source = `policy_groups:
  - select:
      name: 节点选择
      policies: [DIRECT]
  - external:
      name: 远程组
      type: select
  - conditional:
      name: 条件组
  - fallback:
      name: PROXY
rules: []
`;
  assert.deepEqual(ruleSetPolicyOptions("egern", source), ["DIRECT", "REJECT", "节点选择", "远程组", "条件组", "PROXY"]);
});

test("Egern does not invent a PROXY built-in and invalid YAML does not add options", () => {
  assert.deepEqual(ruleSetPolicyOptions("egern", "policy_groups: []"), ["DIRECT", "REJECT"]);
  assert.deepEqual(ruleSetPolicyOptions("egern", "policy_groups: ["), ["DIRECT", "REJECT"]);
});
