import { getAllSettings } from "./repositories/settingsRepository";
import { getTelegramAdminRecipients } from "./repositories/userRepository";
import { sendTelegramMessage } from "./telegramBot";
import { isTelegramBotReadyFromSettings } from "./telegramReady";
import type { TopologySegmentIncidentTransition } from "./repositories/metricsRepository";

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTopologyBlockNotification(event: TopologySegmentIncidentTransition) {
  const duration = Math.max(0, Math.floor((event.occurredAt.getTime() - event.failureStartedAt.getTime()) / 1_000));
  const time = event.occurredAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const source = escapeHtml(event.sourceName);
  const target = escapeHtml(event.targetName);
  const address = escapeHtml(event.targetAddress);
  const subject = `<b>${source} → ${target}</b> (<code>${address}</code>)`;
  return event.type === "blocked"
    ? [`<b>🔴 拓扑物理链路阻断</b>`, "", subject, `连续失败已确认，持续 ${duration} 秒。`, `时间：${escapeHtml(time)}`].join("\n")
    : [`<b>🟢 拓扑物理链路恢复</b>`, "", subject, `阻断共持续 ${duration} 秒${event.recoveryLatencyMs == null ? "" : `，恢复延迟 ${Math.max(0, event.recoveryLatencyMs)} ms`}。`, `时间：${escapeHtml(time)}`].join("\n");
}

// One physical edge can belong to several users' rules. Admins receive one
// message per actual edge transition, not one message per matching rule/user.
export function uniqueTopologyBlockTransitions(events: TopologySegmentIncidentTransition[]) {
  const unique = new Map<string, TopologySegmentIncidentTransition>();
  for (const event of events) {
    const key = `${event.type}:${event.sourceHostId}:${event.targetAddress.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()];
}

export async function notifyTopologyBlockTransitions(events: TopologySegmentIncidentTransition[]) {
  if (!events.length) return;
  const settings = await getAllSettings();
  if (settings.telegramTopologyBlockNotify !== "true" || !isTelegramBotReadyFromSettings(settings)) return;
  const recipients = await getTelegramAdminRecipients();
  for (const event of uniqueTopologyBlockTransitions(events)) {
    const text = formatTopologyBlockNotification(event);
    for (const user of recipients) {
      if (!user.telegramId) continue;
      try {
        await sendTelegramMessage(user.telegramId, text);
      } catch (error) {
        console.warn(`[Telegram] Topology block notification failed incident=${event.incidentId} admin=${user.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
