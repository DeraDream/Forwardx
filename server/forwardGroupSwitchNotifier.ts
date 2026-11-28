import { ENV } from "./env";
import { sendTelegramMessage } from "./telegramBot";
import { getAllSettings } from "./repositories/settingsRepository";
import { getTelegramAdminRecipients } from "./repositories/userRepository";

type ForwardGroupSwitchNotifyPayload = {
  groupId: number;
  groupName: string;
  groupMode: "failover" | "entry";
  changeKind?: "recovery" | "failover" | "update";
  healthyCount?: number;
  enabledHostCount?: number;
  domain?: string | null;
  recordType?: string | null;
  fromLabel?: string | null;
  fromValue?: string | null;
  toLabel?: string | null;
  toValue?: string | null;
  reason: string;
  detail?: string | null;
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTime(value = new Date()) {
  return value.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function valueOrDash(value: unknown) {
  const text = String(value || "").trim();
  return text || "-";
}

async function telegramForwardGroupSwitchEnabled() {
  const settings = await getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
  return botEnabled && botConfigured;
}

export function forwardGroupSwitchMessage(payload: ForwardGroupSwitchNotifyPayload, at = new Date()) {
  if (payload.groupMode === "entry") {
    const status = payload.changeKind === "recovery" ? "🟢 入口组 · 自动恢复"
      : payload.changeKind === "failover" ? "🟠 入口组 · 自动剔除" : "🔄 入口组 · 解析更新";
    const healthy = Number.isInteger(payload.healthyCount) && Number(payload.healthyCount) >= 0
      ? Number(payload.healthyCount) : null;
    const total = Number.isInteger(payload.enabledHostCount) && Number(payload.enabledHostCount) >= 0
      ? Number(payload.enabledHostCount) : null;
    const before = String(payload.fromValue || "").trim();
    const after = String(payload.toValue || "").trim();
    const lines = [
      `<b>${status}</b>`,
      "",
      `<b>${escapeHtml(payload.groupName)}</b> <code>#${payload.groupId}</code>`,
      payload.domain ? `域名：<code>${escapeHtml(payload.domain)}</code>　记录：<code>${escapeHtml(payload.recordType || "A")}</code>` : "",
      "",
      "<blockquote>",
      healthy !== null ? `健康入口：<b>${healthy}${total !== null ? ` / ${total}` : ""}</b>` : "",
      payload.changeKind === "failover" && before && after
        ? `解析变化：<code>${escapeHtml(before)}</code> → <code>${escapeHtml(after)}</code>`
        : `当前解析：<code>${escapeHtml(valueOrDash(after))}</code>`,
      `原因：${escapeHtml(payload.reason)}`,
      "</blockquote>",
      `🕒 ${escapeHtml(formatTime(at))}`,
    ];
    return lines.filter(Boolean).join("\n");
  }
  const title = "ForwardX 转发组自动切换告警";
  const modeLabel = "转发组";
  const lines = [
    `<b>▌ ${escapeHtml(title)}</b>`,
    "",
    `<b>${modeLabel}</b>：${escapeHtml(payload.groupName)} (#${escapeHtml(payload.groupId)})`,
    payload.domain ? `<b>域名</b>：<code>${escapeHtml(payload.domain)}</code>` : "",
    payload.recordType ? `<b>记录</b>：${escapeHtml(payload.recordType)}` : "",
    "",
    `<b>原因</b>：${escapeHtml(payload.reason)}`,
    payload.detail ? `<b>详情</b>：${escapeHtml(payload.detail)}` : "",
    "",
    `<b>切换前</b>：${escapeHtml(valueOrDash(payload.fromLabel))} / <code>${escapeHtml(valueOrDash(payload.fromValue))}</code>`,
    `<b>切换后</b>：${escapeHtml(valueOrDash(payload.toLabel))} / <code>${escapeHtml(valueOrDash(payload.toValue))}</code>`,
    `<b>时间</b>：${escapeHtml(formatTime())}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function notifyForwardGroupSwitch(payload: ForwardGroupSwitchNotifyPayload) {
  if (!(await telegramForwardGroupSwitchEnabled())) return;
  const recipients = await getTelegramAdminRecipients();
  if (recipients.length === 0) return;
  const text = forwardGroupSwitchMessage(payload);
  let sent = 0;
  let failed = 0;
  for (const user of recipients as any[]) {
    if (!user.telegramId) continue;
    try {
      await sendTelegramMessage(user.telegramId, text, payload.groupMode === "entry" ? { inline_keyboard: [
        [
          { text: "📡 查看入口组详情", callback_data: `fx:entry:view:${payload.groupId}` },
          { text: "📋 查看事件记录", callback_data: `fx:entry:events:${payload.groupId}` },
        ],
      ] } : undefined);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[Telegram] Forward group switch notify failed user=${user.id} group=${payload.groupId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sent > 0 || failed > 0) {
    console.info(`[Telegram] Forward group switch notify group=${payload.groupId} sent=${sent} failed=${failed}`);
  }
}
