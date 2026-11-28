import assert from "node:assert/strict";
import test from "node:test";
import { canDispatchAgentSelfTest, canRunTopologyTcpTest } from "./topologyTcpAgentCapability";

test("standalone Agent supports only topology TCP from v1.0.9", () => {
  assert.equal(canRunTopologyTcpTest("2.2.250-iptables-only.1.0.8"), false);
  assert.equal(canRunTopologyTcpTest("2.2.250-iptables-only.1.0.9"), true);
  assert.equal(canRunTopologyTcpTest("2.2.250-iptables-only.1.0.10"), true);
  assert.equal(canRunTopologyTcpTest("2.2.250"), true);
  assert.equal(canDispatchAgentSelfTest("2.2.250-iptables-only.1.0.9", "topology-total"), true);
  assert.equal(canDispatchAgentSelfTest("2.2.250-iptables-only.1.0.9", "forward-chain"), false);
  assert.equal(canDispatchAgentSelfTest("2.2.250-iptables-only.1.0.8", "topology-total"), false);
});
