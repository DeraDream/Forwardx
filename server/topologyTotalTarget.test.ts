import assert from "node:assert/strict";
import test from "node:test";
import { parseSelfTestMeta } from "./agentRouteUtils";
import { selectTopologyTotalTarget, topologyTotalResultMessage } from "./topologyTotalTarget";

test("total TCP selects exactly the chosen entrance's next listener, not downstream hops", () => {
  const segments = [
    { fromHostId: 1, targetIp: "198.51.100.2", targetPort: 31001 },
    { fromHostId: 3, targetIp: "198.51.100.2", targetPort: 31003 },
    { fromHostId: 2, targetIp: "198.51.100.4", targetPort: 443 },
  ];
  assert.deepEqual(selectTopologyTotalTarget(segments, 1), { targetIp: "198.51.100.2", targetPort: 31001 });
  assert.deepEqual(selectTopologyTotalTarget(segments, 3), { targetIp: "198.51.100.2", targetPort: 31003 });
  assert.equal(selectTopologyTotalTarget(segments, 5), null);
  assert.equal(selectTopologyTotalTarget([{ fromHostId: 1, targetIp: "198.51.100.2", targetPort: 0 }], 1), null);
});

test("completed TCP results retain topology-specific metadata and a single-handshake total", () => {
  const target = { targetIp: "198.51.100.2", targetPort: 31001 };
  const success = topologyTotalResultMessage(target, "TCP 可达", 12);
  assert.equal(parseSelfTestMeta(success)?.kind, "topology-total");
  assert.deepEqual(JSON.parse(success), { kind: "topology-total", ...target, message: "TCP 可达", totalLatencyMs: 12 });
  assert.equal(JSON.parse(success).totalLatencyMs, 12);
  assert.equal(JSON.parse(topologyTotalResultMessage(target, "超时", null)).totalLatencyMs, null);
});
