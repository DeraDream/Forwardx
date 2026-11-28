function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
