function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function selectRuleProbeCompletion(
  tests: Array<{ status: string; latencyMs?: number | null; message?: string | null }>,
  queued: number,
) {
  if (queued <= 1) {
    const test = tests[0];
    return test && !["pending", "running"].includes(test.status) ? test : null;
  }
  // A chain has several hop jobs: an individual hop is not an end-to-end
  // measurement. Only its finished aggregate can update the rule card.
  if (tests.length < queued) return null;
  return tests.find((test) => {
    if (["pending", "running"].includes(test.status)) return false;
    try { return JSON.parse(test.message || "{}").kind === "forward-chain-hop-summary"; }
    catch { return false; }
  }) || null;
}

export function formatRuleDetailLatency(
  latest: { latestLatencyMs?: number | null; latestLatencyIsTimeout?: boolean } | undefined,
  probe?: { status: string; latencyMs?: number | null } | null,
) {
  if (probe?.status === "pending" || probe?.status === "running") return "⏳ 探测中";
  if (probe?.status === "success") {
    const measured = Number(probe.latencyMs);
    if (probe.latencyMs != null && Number.isFinite(measured) && measured >= 0) return `${Math.round(measured)} ms（本次探测）`;
    return "本次探测成功，未返回延迟值";
  }
  if (probe?.status === "unreported") return "等待探测报告超时";
  if (probe && (probe.status === "failed" || probe.status === "timeout")) {
    return probe.status === "timeout" ? "本次探测超时" : "本次探测失败";
  }
  if (latest?.latestLatencyIsTimeout) return "最近一次探测超时";
  const cached = Number(latest?.latestLatencyMs);
  return latest?.latestLatencyMs != null && Number.isFinite(cached) && cached >= 0
    ? `${Math.round(cached)} ms（最近记录）` : "暂无延迟记录";
}

export function formatTelegramRuleProbeResult(ruleId: number, entryName: string, test: { status?: string; latencyMs?: number | null }) {
  const header = `<b>⚡ 探测延迟 · 规则 #${ruleId}</b>\n入口：${escapeHtml(entryName)}\n`;
  if (test.status === "pending" || test.status === "running") return `${header}⏳ 探测中，请稍后查看结果。`;
  if (test.status === "success") {
    const latency = test.latencyMs == null ? null : Number(test.latencyMs);
    return `${header}${latency !== null && Number.isFinite(latency) && latency >= 0
      ? `✅ TCP 延迟：<b>${Math.round(latency)} ms</b>` : "✅ 探测成功，但未返回延迟值。"}`;
  }
  return `${header}❌ ${test.status === "timeout" ? "探测超时" : "探测失败"}（无有效延迟）。`;
}
