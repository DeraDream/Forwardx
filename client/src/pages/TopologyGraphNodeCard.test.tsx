import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TopologyGraphNodeCard, topologyCardSize } from "./TopologyGraphNodeCard";

const base = {
  node: { label: "QHIX", subtitle: "192.0.2.1", kind: "relay" as const, online: true },
  icon: "🌐", sharedCount: 3, highlighted: false, dimmed: false, selected: false,
  copied: false, onSelect: () => {}, onHover: () => {}, onCopy: () => {},
};

test("node density switches preserve genuine rates and never show sample packet loss", () => {
  const standard = renderToStaticMarkup(<TopologyGraphNodeCard {...base} {...topologyCardSize("standard")} density="standard"
    telemetry={{ speedIn: 1024, speedOut: 2048 }} />);
  assert.match(standard, /1\.0 KB\/s/);
  assert.match(standard, /2\.0 KB\/s/);
  assert.match(standard, /3 条路径经过/);
  assert.doesNotMatch(standard, /丢包/);
  const detailed = renderToStaticMarkup(<TopologyGraphNodeCard {...base} {...topologyCardSize("detailed")} density="detailed"
    telemetry={{ cpu: 24, trafficUsed: 25, trafficLimit: 100 }} />);
  assert.match(detailed, /CPU/);
  assert.match(detailed, /月流量/);
  assert.match(detailed, /25%/);
  const missing = renderToStaticMarkup(<TopologyGraphNodeCard {...base} {...topologyCardSize("compact")} density="compact" />);
  assert.match(missing, /—/);
  assert.match(missing, /3 条路径经过/, "compact mode must retain the path count");
  assert.doesNotMatch(missing, /CPU|月流量|>25%<|丢包/);
  const single = renderToStaticMarkup(<TopologyGraphNodeCard {...base} sharedCount={1} {...topologyCardSize("compact")} density="compact" />);
  assert.match(single, /独立路径/);
  assert.ok(topologyCardSize("compact").width < topologyCardSize("standard").width);
  assert.ok(topologyCardSize("standard").width < topologyCardSize("detailed").width);
});
