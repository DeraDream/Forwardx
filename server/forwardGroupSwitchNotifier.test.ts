import assert from "node:assert/strict";
import test from "node:test";
import { forwardGroupSwitchMessage } from "./forwardGroupSwitchNotifier";

const at = new Date("2026-11-26T01:03:03Z");
const payload = {
  groupId: 10,
  groupName: "Po0<广州>&入口组",
  groupMode: "entry" as const,
  domain: "po0.example.org",
  recordType: "A",
  healthyCount: 1,
  enabledHostCount: 2,
  fromValue: "43.140.35.245",
  toValue: "42.193.170.239",
  reason: "入口异常达到观察时间，已自动剔除",
};

test("entry group failover message formats real counts and DNS change safely", () => {
  const text = forwardGroupSwitchMessage({ ...payload, changeKind: "failover" }, at);
  assert.match(text, /🟠 入口组 · 自动剔除/);
  assert.match(text, /Po0&lt;广州&gt;&amp;入口组/);
  assert.match(text, /健康入口：<b>1 \/ 2<\/b>/);
  assert.match(text, /解析变化：<code>43\.140\.35\.245<\/code> → <code>42\.193\.170\.239<\/code>/);
});

test("entry group recovery and mixed updates retain distinct labels", () => {
  const recovery = forwardGroupSwitchMessage({ ...payload, changeKind: "recovery", healthyCount: 2, toValue: "42.193.170.239, 43.140.35.245" }, at);
  assert.match(recovery, /🟢 入口组 · 自动恢复/);
  assert.match(recovery, /健康入口：<b>2 \/ 2<\/b>/);
  assert.match(recovery, /当前解析：<code>42\.193\.170\.239, 43\.140\.35\.245<\/code>/);
  assert.match(forwardGroupSwitchMessage({ ...payload, changeKind: "update" }, at), /🔄 入口组 · 解析更新/);
});

test("failover group notifications retain their existing message format", () => {
  const text = forwardGroupSwitchMessage({ ...payload, groupMode: "failover", fromLabel: "旧", toLabel: "新" }, at);
  assert.match(text, /ForwardX 转发组自动切换告警/);
});
