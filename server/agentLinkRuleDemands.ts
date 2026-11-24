import * as db from "./db";

function enabled(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

function addressKey(value: unknown) {
  return String(value || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

export async function directRuleAgentLinkCandidates(sourceHostIdValue: number, rules: any[], resolveTargetAddress: (rule: any) => string) {
  const sourceHostId = Number(sourceHostIdValue || 0);
  if (sourceHostId <= 0) return [];
  const allHosts = await db.getHosts();
  const hostByAddress = new Map<string, number>();
  for (const host of allHosts as any[]) {
    for (const value of [host.ip, host.ipv4, host.ipv6, host.entryIp, host.tunnelEntryIp, host.ddnsDomain]) {
      const key = addressKey(value);
      if (key && !hostByAddress.has(key)) hostByAddress.set(key, Number(host.id));
    }
  }
  const ruleHostCache = new Map<number, number>();
  const landingHostCache = new Map<number, number>();
  const candidates: Array<{ sourceHostId: number; targetHostId: number; targetAddress: string }> = [];
  for (const rule of rules || []) {
    if (!rule || !enabled(rule.isEnabled) || !enabled(rule.isRunning) || enabled(rule.pendingDelete) || Number(rule.tunnelId || 0) > 0) continue;
    const targetAddress = String(resolveTargetAddress(rule) || rule.targetIp || "").trim();
    if (!targetAddress) continue;
    let targetHostId = 0;
    const targetRuleId = Number(rule.targetRuleId || 0);
    if (targetRuleId > 0) {
      if (!ruleHostCache.has(targetRuleId)) {
        const targetRule = await db.getForwardRuleById(targetRuleId) as any;
        ruleHostCache.set(targetRuleId, Number(targetRule?.hostId || 0));
      }
      targetHostId = Number(ruleHostCache.get(targetRuleId) || 0);
    }
    const landingServiceId = Number(rule.targetLandingServiceId || 0);
    if (!targetHostId && landingServiceId > 0) {
      if (!landingHostCache.has(landingServiceId)) {
        const landing = await db.getLandingServiceById(landingServiceId) as any;
        landingHostCache.set(landingServiceId, Number(landing?.hostId || 0));
      }
      targetHostId = Number(landingHostCache.get(landingServiceId) || 0);
    }
    if (!targetHostId) targetHostId = Number(hostByAddress.get(addressKey(targetAddress)) || 0);
    if (targetHostId > 0 && targetHostId !== sourceHostId) candidates.push({ sourceHostId, targetHostId, targetAddress });
  }
  return candidates;
}
