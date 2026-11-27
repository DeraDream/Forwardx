import { isAgentVersionAtLeast, isIptablesOnlyAgentVersion, normalizeVersion } from "./agentRouteUtils";

// Full-link speed tests predate the current standard Agent release. The
// iptables ingress namespace was added later than listener-mode speed tests.
export const LINK_SPEED_AGENT_MIN_VERSION = "2.2.243";
export const LINK_SPEED_IPTABLES_MIN_VERSION = "2.2.246";

export function linkSpeedAgentRequirement(version: string | null | undefined, entryMode: "listener" | "iptables") {
  const standalone = isIptablesOnlyAgentVersion(version);
  const minimum = entryMode === "iptables" ? LINK_SPEED_IPTABLES_MIN_VERSION : LINK_SPEED_AGENT_MIN_VERSION;
  if (standalone && entryMode !== "iptables") {
    return { supported: false, reason: "轻量 Agent 仅支持 iptables 入口测速" };
  }
  if (!isAgentVersionAtLeast(version, minimum)) {
    return {
      supported: false,
      reason: `${standalone ? "轻量 Agent" : "入口 Agent"} 版本 ${normalizeVersion(version) || "未上报"} 不支持该入口测速，需要协议版本 ${minimum} 或更高版本`,
    };
  }
  return { supported: true, reason: null };
}
