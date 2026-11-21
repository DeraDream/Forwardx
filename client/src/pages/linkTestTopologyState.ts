import type { LinkTestPlannedSegment } from "@/components/LinkTestLatencySummary";

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
  if (freezeCurrent && current) return current;
  if (incoming?.plannedSegments.length) return incoming;
  return current;
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
