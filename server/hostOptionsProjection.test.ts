import assert from "node:assert/strict";
import test from "node:test";
import { compactHostOption } from "./repositories/hostRepository";

test("host options carry the same quota and accounting mode used by host management", () => {
  const host = compactHostOption({ id: 1, name: "DataWave-HK", trafficLimit: 1024 ** 4, trafficMeasureMode: "max", agentToken: "private" });
  assert.equal(host.trafficLimit, 1024 ** 4);
  assert.equal(host.trafficMeasureMode, "max");
  assert.equal("agentToken" in host, false);
  assert.equal(compactHostOption({ id: 2, trafficLimit: 0, trafficMeasureMode: "outbound" }).trafficLimit, 0);
});
