import type { LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";
import { getTunnelHopIds } from "@/lib/tunnelDisplay";

export type LinkTestTopologySnapshot = {
  sourceLabel?: string;
  targetLabel?: string;
  nodeMeta?: Record<string, any>;
  plannedSegments: LinkTestPlannedSegment[];
};

export function selectLinkTestTopologySnapshot(
  current: LinkTestTopologySnapshot | null,
  incoming: LinkTestTopologySnapshot | null,
  freezeCurrent: boolean,
) {
  if (
    freezeCurrent
    && current
    && (!incoming || incoming.plannedSegments.length <= current.plannedSegments.length)
  ) return current;
  if (incoming?.plannedSegments.length) return incoming;
  return current;
}

export function configuredRuleTunnelHopIds(
  rule: any,
  tunnelById: Map<number, any>,
) {
  const tunnelId = Number(rule?.tunnelId || 0);
  if (tunnelId <= 0) return [];
  return getTunnelHopIds(tunnelById.get(tunnelId));
}

export function resolveLinkTestRuleRoute(
  rule: any,
  ruleById: Map<number, any>,
  landingById: Map<number, any>,
  hostIdsForRule: (rule: any) => number[],
) {
  const hostIds = hostIdsForRule(rule);
  const routeRules = [rule];
  const seen = new Set<number>([Number(rule?.id || 0)]);
  let terminalRule = rule;
  let targetLandingServiceId = Number(rule?.targetLandingServiceId || 0);

  while (Number(terminalRule?.targetRuleId || 0) > 0) {
    const targetRuleId = Number(terminalRule.targetRuleId);
    if (seen.has(targetRuleId)) break;
    const referencedRule = ruleById.get(targetRuleId);
    if (!referencedRule) break;
    seen.add(targetRuleId);
    routeRules.push(referencedRule);
    hostIds.push(...hostIdsForRule(referencedRule));
    terminalRule = referencedRule;
    targetLandingServiceId = Number(
      referencedRule?.targetLandingServiceId || targetLandingServiceId || 0,
    );
  }

  const landing = landingById.get(targetLandingServiceId) || null;
  if (Number(landing?.hostId || 0) > 0) hostIds.push(Number(landing.hostId));

  return {
    hostIds: hostIds.filter(
      (hostId: number, index: number) =>
        hostId > 0 && (index === 0 || hostId !== hostIds[index - 1]),
    ),
    targetIp: String(terminalRule?.targetIp || rule?.targetIp || ""),
    targetPort: Number(terminalRule?.targetPort || rule?.targetPort || 0),
    terminalRule,
    routeRules,
    landing,
    referenced: seen.size > 1 || !!landing,
  };
}

export function mergeLinkTestRouteHost(listHost: any, tunnelHost: any) {
  if (!listHost) return tunnelHost;
  if (!tunnelHost) return listHost;
  return {
    ...tunnelHost,
    ...listHost,
    geoCountryCode: listHost.geoCountryCode || tunnelHost.geoCountryCode || null,
    geoCountryName: listHost.geoCountryName || tunnelHost.geoCountryName || null,
    geoRegion: listHost.geoRegion || tunnelHost.geoRegion || null,
    geoEmoji: listHost.geoEmoji || tunnelHost.geoEmoji || null,
  };
}
