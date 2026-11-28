import assert from "node:assert/strict";
import test from "node:test";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileTopologyPathCard } from "./NetworkTopology";

const entry = { id: "host:1", kind: "entry" as const, label: "入口", online: true };
const landing = { id: "host:2", kind: "landing" as const, label: "落地", online: true };
const path = { id: "rule:11:0", ruleId: 11, name: "手机列表", category: "fullchain" as const, entry, relays: [], landing };
const onProbePath = () => {};
const base: Parameters<typeof MobileTopologyPathCard>[0] = {
  path, entrances: [path], rule: { isEnabled: true }, probing: false, totalFallback: "待探测",
  metrics: { bytesIn: 100, bytesOut: 200, bytesInPerSecond: 1024, bytesOutPerSecond: 2048, latestLatencyMs: 9, latestLatencyIsTimeout: false },
  onProbePath, onHistory: () => {}, onNetworkProfile: () => {},
  edgeLabel: () => "3 ms", entryEdgeLabel: () => "3 ms",
  onProbeEdge: () => {}, onProbeEntryEdge: () => {},
};

function totalProbeControls(node: ReactNode): Array<{ title: string; onClick?: () => void; disabled?: boolean }> {
  if (Array.isArray(node)) return node.flatMap(totalProbeControls);
  if (!isValidElement(node)) return [];
  const props = node.props as { title?: string; onClick?: () => void; disabled?: boolean; children?: ReactNode };
  const found = props.title?.includes("端到端 TCP")
    ? [{ title: props.title, onClick: props.onClick, disabled: props.disabled }] : [];
  return [...found, ...totalProbeControls(props.children)];
}

test("mobile list hides live rates, preserves 24H traffic, and exposes the stored TCP total as a probe button", () => {
  const html = renderToStaticMarkup(<MobileTopologyPathCard {...base} />);
  assert.doesNotMatch(html, /实时下载|实时上传|KB\/s/);
  assert.match(html, /24H 总流量/);
  assert.match(html, /24H 下载/);
  assert.match(html, /24H 上传/);
  assert.match(html, /总延迟（端到端 TCP）/);
  assert.match(html, /TCP 9 ms/);
  assert.doesNotMatch(html, /<button[^>]*>TCP 9 ms<\/button>/);
  assert.match(html, /TCP 探测/);
  const controls = totalProbeControls(MobileTopologyPathCard(base));
  assert.equal(controls.length, 1);
  assert.equal(controls[0].onClick, onProbePath);
  assert.equal(controls[0].disabled, false);
  assert.doesNotMatch(html, /<button[^>]*>运行中/);
});

test("mobile TCP total button mirrors the desktop loading, no-result, failure and probing states", () => {
  const missing = { ...base, metrics: { ...base.metrics!, latestLatencyMs: null }, totalFallback: "待探测" };
  assert.match(renderToStaticMarkup(<MobileTopologyPathCard {...missing} />), /待探测/);
  assert.equal(totalProbeControls(MobileTopologyPathCard(missing))[0].onClick, onProbePath);
  const loading = { ...missing, totalFallback: "读取中" };
  assert.equal(totalProbeControls(MobileTopologyPathCard(loading))[0].disabled, true);
  const failed = { ...base, metrics: { ...base.metrics!, latestLatencyIsTimeout: true, latestLatencyMs: null } };
  assert.match(renderToStaticMarkup(<MobileTopologyPathCard {...failed} />), /TCP 超时/);
  assert.equal(totalProbeControls(MobileTopologyPathCard(failed))[0].onClick, onProbePath);
  const probing = { ...base, probing: true };
  assert.match(renderToStaticMarkup(<MobileTopologyPathCard {...probing} />), /探测中…/);
  assert.match(renderToStaticMarkup(<MobileTopologyPathCard {...probing} />), /探测中/);
  assert.equal(totalProbeControls(MobileTopologyPathCard(probing)).length, 1);
  assert.equal(totalProbeControls(MobileTopologyPathCard(probing))[0].disabled, true);
  const noRule = { ...base, path: { ...path, ruleId: undefined } };
  assert.equal(totalProbeControls(MobileTopologyPathCard(noRule))[0].disabled, true);
});

test("mobile local and chain cards have no throughput test action", () => {
  for (const category of ["local", "chain"] as const) {
    const html = renderToStaticMarkup(<MobileTopologyPathCard {...base} path={{ ...path, category }} />);
    assert.doesNotMatch(html, /链路测速|sslocal/);
    assert.match(html, /链路质量|网络画像/);
  }
});
