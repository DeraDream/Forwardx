import assert from "node:assert/strict";
import test from "node:test";
import { isDirectPublicIpv4, selectLinkSpeedHost } from "./linkSpeedHost";

test("explicit link-speed host overrides automatic interface selection", () => {
  assert.equal(selectLinkSpeedHost({
    configured: "receiver.example.test",
    routeOutput: "1.1.1.1 via 160.236.110.1 dev ens3 src 160.236.111.114",
  }), "receiver.example.test");
});

test("automatic link-speed host uses the default route source instead of an unrelated egress NAT address", () => {
  assert.equal(selectLinkSpeedHost({
    routeOutput: "1.1.1.1 via 160.236.110.1 dev ens3 src 160.236.111.114 uid 0",
    interfaces: {
      ens3: [{ address: "160.236.111.114", family: "IPv4", internal: false }],
    },
  }), "160.236.111.114");
});

test("automatic link-speed host rejects private and benchmark interfaces", () => {
  assert.equal(selectLinkSpeedHost({
    routeOutput: "1.1.1.1 via 172.18.0.1 dev eth0 src 172.18.0.2",
    interfaces: {
      eth0: [{ address: "172.18.0.2", family: "IPv4", internal: false }],
      test0: [{ address: "198.18.1.1", family: "IPv4", internal: false }],
      ens3: [{ address: "203.8.113.25", family: 4, internal: false }],
    },
  }), "203.8.113.25");
});

test("direct public IPv4 classification excludes non-routable ranges", () => {
  assert.equal(isDirectPublicIpv4("160.236.111.114"), true);
  for (const address of ["127.0.0.1", "10.0.0.1", "172.18.0.2", "192.168.1.1", "100.64.0.1", "169.254.1.1", "198.18.1.1"] ) {
    assert.equal(isDirectPublicIpv4(address), false, address);
  }
});
