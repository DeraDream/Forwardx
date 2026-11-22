import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredRuleTunnelHopIds,
  mergeLinkTestRouteHost,
  selectLinkTestTopologySnapshot,
} from "./linkTestTopologyState";

test("a manual link test keeps the complete cached topology during a transient collapse", () => {
  const complete = {
    sourceLabel: "入口",
    targetLabel: "落地",
    nodeMeta: { 中转: { countryCode: "SG" } },
    plannedSegments: [
      { from: "入口", to: "中转" },
      { from: "中转", to: "落地" },
    ],
  };
  const collapsed = {
    sourceLabel: "入口",
    targetLabel: "落地",
    nodeMeta: {},
    plannedSegments: [{ from: "入口", to: "落地" }],
  };

  assert.equal(selectLinkTestTopologySnapshot(complete, collapsed, true), complete);
  assert.equal(selectLinkTestTopologySnapshot(complete, collapsed, false), collapsed);
});

test("a configured tunnel expands by host id regardless of the legacy forward type", () => {
  const tunnelById = new Map([
    [8, { id: 8, hopHostIds: [11, 12, 13] }],
  ]);

  assert.deepEqual(
    configuredRuleTunnelHopIds({ tunnelId: 8, forwardType: "forwardx" }, tunnelById),
    [11, 12, 13],
  );
  assert.deepEqual(
    configuredRuleTunnelHopIds({ tunnelId: 8, forwardType: "iptables" }, tunnelById),
    [11, 12, 13],
  );
});

test("route host metadata merges tunnel geo fallback with the visible host state", () => {
  const merged = mergeLinkTestRouteHost(
    { id: 3, name: "DataWave-SG", isOnline: true, ipv4: "82.109.97.96" },
    { id: 3, name: "DataWave-SG", geoCountryCode: "SG", geoCountryName: "Singapore", geoEmoji: "🇸🇬" },
  );

  assert.equal(merged.ipv4, "82.109.97.96");
  assert.equal(merged.isOnline, true);
  assert.equal(merged.geoCountryCode, "SG");
  assert.equal(merged.geoCountryName, "Singapore");
});
