import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { topologyPathEdgeIds } from "./networkTopologyPaths";
import { topologyFocus, topologyUsageCounts } from "./networkTopologyFocus";
import { TopologyGraphNodeCard, topologyCardSize, type TopologyDensity } from "./TopologyGraphNodeCard";
import { clampTopologyZoom, fitTopologyZoom, topologyCanvasOverflow } from "./topologyCanvasViewport";
import { parseLinkTestMessage } from "@/components/LinkTestLatencySummary";
import { topologyRuleHref } from "./topologyRuleLink";
import { activeTopologySegmentProbeIds, latestAutomaticTopologySegment, mergeTopologySegmentProbeResults, summarizePhysicalTopologySegmentLabels, topologySegmentProbeKey, type AutomaticTopologySegment, type TopologySegmentProbe } from "./topologySegmentProbeState";
import { acyclicTopologyLayerEdges, assignTopologyBranchRows } from "./topologyLayout";
import { routeSmoothLayeredTopologyGraph, topologyRoutePath } from "./topologyRouting";
import { topologyEnabledFlag, visibleTopologyTunnelVariants } from "./topologyTunnelVariants";
import { combineTopologyHostVariants, joinTopologyHostPaths, MAX_TOPOLOGY_VARIANTS, type TopologyExpansionState } from "./topologyExpansion";
import {
  Activity,
  ArrowRight,
  Check,
  Copy,
  Cpu,
  Earth,
  Flag,
  Gauge,
  Layers,
  Layers3,
  LayoutGrid,
  Link2,
  Loader2,
  HardDrive,
  List,
  LogIn,
  Network,
  Route,
  Scan,
  Search,
  Server,
  Stethoscope,
  Waypoints,
} from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { LinkQualityDialog, type LinkQualityTarget } from "@/components/observability/LinkQualityDialog";
import { LinkSpeedTestButton } from "@/components/LinkSpeedTest";
import { HostNetworkProfileDialog } from "@/components/HostNetworkProfileDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { cn } from "@/lib/utils";

type TopologyCategory = "all" | "local" | "tunnel" | "chain" | "group" | "fullchain";
type PhysicalNodeKind = "entry" | "relay" | "landing";

type PhysicalNode = {
  id: string;
  kind: PhysicalNodeKind;
  label: string;
  subtitle?: string;
  detail?: string;
  online?: boolean | null;
  geoCountryCode?: string | null;
  geoCountryName?: string | null;
  geoEmoji?: string | null;
  qualityTarget?: LinkQualityTarget | null;
};

type PhysicalPath = {
  id: string;
  ruleId?: number;
  // A visible entry rule may explicitly reference another rule. Each physical
  // leg reports under its own visible rule ID, so the path must query all of
  // them rather than only the entry rule.
  segmentRuleIds?: number[];
  name: string;
  category: Exclude<TopologyCategory, "all">;
  entry: PhysicalNode;
  relays: PhysicalNode[];
  landing: PhysicalNode;
};

type PositionedNode = PhysicalNode & {
  column: number;
  row: number;
};

type TopologyEdge = {
  id: string;
  from: string;
  to: string;
};

type TopologyRuleTest = {
  parsed: ReturnType<typeof parseLinkTestMessage>;
  recordedAt: number;
  status: string;
  latencyMs: number | null;
};

type TopologyBlockLog = {
  id: string;
  incidentId: number;
  type: "blocked" | "recovered";
  occurredAt: Date | string;
  failureStartedAt: Date | string;
  blockedAt: Date | string;
  recoveredAt: Date | string | null;
  sourceHostId: number;
  sourceName: string;
  targetHostId: number | null;
  targetName: string;
  targetAddress: string;
  recoveryLatencyMs: number | null;
};

const categoryOptions: Array<{ value: TopologyCategory; label: string }> = [
  { value: "all", label: "全部" },
  { value: "local", label: "端口转发" },
  { value: "tunnel", label: "隧道" },
  { value: "chain", label: "转发链" },
  { value: "group", label: "转发组" },
  { value: "fullchain", label: "全链路" },
];
const categorySortOrder = new Map<TopologyCategory, number>(categoryOptions.map((option, index) => [option.value, index]));

type RouteVisualType = Exclude<TopologyCategory, "all">;
const routeVisuals: Record<TopologyCategory, { bg: string; border: string; text: string; active: string; badge: string }> = {
  all: { bg: "bg-primary/10", border: "border-primary/25", text: "text-primary", active: "border-primary bg-primary text-primary-foreground", badge: "border-primary/25 bg-primary/10 text-primary" },
  local: { bg: "bg-chart-3/10", border: "border-chart-3/30", text: "text-chart-3", active: "border-primary bg-primary text-primary-foreground", badge: "border-chart-3/30 bg-chart-3/10 text-chart-3" },
  tunnel: { bg: "bg-chart-1/10", border: "border-chart-1/30", text: "text-chart-1", active: "border-primary bg-primary text-primary-foreground", badge: "border-chart-1/30 bg-chart-1/10 text-chart-1" },
  chain: { bg: "bg-chart-2/10", border: "border-chart-2/30", text: "text-chart-2", active: "border-primary bg-primary text-primary-foreground", badge: "border-chart-2/30 bg-chart-2/10 text-chart-2" },
  group: { bg: "bg-chart-4/10", border: "border-chart-4/30", text: "text-chart-4", active: "border-primary bg-primary text-primary-foreground", badge: "border-chart-4/30 bg-chart-4/10 text-chart-4" },
  fullchain: { bg: "bg-chart-1/10", border: "border-chart-1/30", text: "text-chart-1", active: "border-primary bg-primary text-primary-foreground", badge: "border-chart-1/30 bg-chart-1/10 text-chart-1" },
};

function RouteTypeIcon({ category, className = "h-4 w-4" }: { category: RouteVisualType; className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    {category === "local" && <><circle cx="5" cy="12" r="2.2" /><circle cx="19" cy="12" r="2.2" /><path d="M7.5 12h8.5" /><path d="M13 9l3 3-3 3" /></>}
    {category === "tunnel" && <><path d="M4 7h16" /><path d="M4 17h16" /><path d="M6 12h11" /><path d="M14 9.5L17 12l-3 2.5" /></>}
    {category === "chain" && <><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 1 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" /></>}
    {category === "group" && <><circle cx="5" cy="12" r="2.2" /><circle cx="19" cy="6.5" r="2.2" /><circle cx="19" cy="17.5" r="2.2" /><path d="M7.2 12H11c1.5 0 2-5.5 4.2-5.5h1.6" /><path d="M11 12c1.5 0 2 5.5 4.2 5.5h1.6" /></>}
    {category === "fullchain" && <><circle cx="5.5" cy="17.5" r="2.2" /><circle cx="18.5" cy="6.5" r="2.2" /><path d="M7.7 17.5h4.8a2.5 2.5 0 0 0 2.5-2.5V9a2.5 2.5 0 0 1 2.5-2.5h.8" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></>}
  </svg>;
}

function RouteTypeBadge({ category }: { category: RouteVisualType }) {
  const visual = routeVisuals[category];
  return <span title={categoryLabel(category)} className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", visual.bg, visual.border, visual.text)}><RouteTypeIcon category={category} /></span>;
}

function RouteTypeLabel({ category }: { category: RouteVisualType }) {
  const visual = routeVisuals[category];
  return <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", visual.badge)}>{categoryLabel(category)}</span>;
}

function normalizeGroupMode(group: any) {
  const mode = String(group?.groupMode || "failover");
  return mode === "port" || mode === "chain" || mode === "entry" || mode === "exit" ? mode : "failover";
}

function ruleCategory(rule: any, groupById: Map<number, any>): Exclude<TopologyCategory, "all" | "fullchain"> {
  const group = Number(rule?.forwardGroupId || 0) > 0 ? groupById.get(Number(rule.forwardGroupId)) : null;
  const mode = normalizeGroupMode(group);
  if (mode === "port") return "local";
  if (mode === "chain") return "chain";
  if (group) return "group";
  if (Number(rule?.tunnelId || 0) > 0) return "tunnel";
  return "local";
}

function categoryLabel(category: Exclude<TopologyCategory, "all">) {
  return categoryOptions.find((item) => item.value === category)?.label || category;
}

function hostAddress(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ip || "").trim();
}

function physicalNodeHostId(node: PhysicalNode) {
  const match = /^host:(\d+)$/.exec(String(node?.id || ""));
  return match ? Number(match[1]) : 0;
}

function hostOnline(host: any): boolean | null {
  if (host?.isOnline === true || host?.isOnline === 1 || host?.isOnline === "1" || host?.isOnline === "true") return true;
  if (host?.isOnline === false || host?.isOnline === 0 || host?.isOnline === "0" || host?.isOnline === "false") return false;
  return null;
}

function enabledMember(member: any) {
  return topologyEnabledFlag(member?.isEnabled, true);
}

function memberPhysicalVariants(member: any, groupById: Map<number, any>, tunnelById: Map<number, any>, state: TopologyExpansionState): number[][] {
  if (!enabledMember(member)) return [];
  if (String(member?.memberType || "host") === "tunnel") {
    const tunnel = tunnelById.get(Number(member?.tunnelId || 0));
    if (!tunnel) { state.incomplete = true; return []; }
    return visibleTunnelVariants(tunnel, groupById, state);
  }
  const hostId = Number(member?.hostId || 0);
  if (!Number.isSafeInteger(hostId) || hostId <= 0) { state.incomplete = true; return []; }
  return [[hostId]];
}

function groupPhysicalVariants(group: any, groupById: Map<number, any>, tunnelById: Map<number, any>, state: TopologyExpansionState) {
  if (!group) { state.incomplete = true; return [] as number[][]; }
  const mode = normalizeGroupMode(group);
  const members = (Array.isArray(group?.members) ? group.members : [])
    .filter(enabledMember)
    .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0));
  if (!members.length) { state.incomplete = true; return []; }

  if (mode === "chain") {
    let paths: number[][] = [[]];
    for (const member of members) {
      const variants = memberPhysicalVariants(member, groupById, tunnelById, state);
      if (!variants.length) { state.incomplete = true; return []; }
      paths = combineTopologyHostVariants(paths, variants, state);
      if (!paths.length) return [];
    }
    if (Number(group?.entryGroupId || 0) > 0) {
      const entryGroup = groupById.get(Number(group.entryGroupId)) || group.entryGroup;
      const entryMembers = (Array.isArray(entryGroup?.members) ? entryGroup.members : []).filter(enabledMember)
        .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0));
      if (!entryMembers.length) { state.incomplete = true; return []; }
      const entryVariants: number[][] = [];
      outer: for (const member of entryMembers) {
        for (const variant of memberPhysicalVariants(member, groupById, tunnelById, state)) {
          if (entryVariants.length >= MAX_TOPOLOGY_VARIANTS) { state.truncated = true; break outer; }
          entryVariants.push(variant);
        }
      }
      return combineTopologyHostVariants(entryVariants, paths, state);
    }
    return paths.filter((ids) => ids.length > 0);
  }

  // 端口转发、转发组、入口组、出口组的成员是并列候选，不应画成串联链路。
  const variants: number[][] = [];
  for (const member of members) {
    for (const path of memberPhysicalVariants(member, groupById, tunnelById, state)) {
      if (variants.length >= MAX_TOPOLOGY_VARIANTS) { state.truncated = true; return variants; }
      variants.push(path);
    }
  }
  return variants;
}

function visibleTunnelVariants(tunnel: any, groupById: Map<number, any>, state: TopologyExpansionState) {
  const entryGroup = groupById.get(Number(tunnel?.entryGroupId || 0)) || tunnel?.entryGroup;
  return visibleTopologyTunnelVariants(tunnel, entryGroup, state);
}

function directRuleVariants(rule: any, groupById: Map<number, any>, tunnelById: Map<number, any>, state: TopologyExpansionState) {
  const groupId = Number(rule?.forwardGroupId || 0);
  if (groupId > 0) {
    const group = groupById.get(groupId);
    if (!group) { state.incomplete = true; return []; }
    return groupPhysicalVariants(group, groupById, tunnelById, state);
  }

  const tunnelId = Number(rule?.tunnelId || 0);
  if (tunnelId > 0) {
    const tunnel = tunnelById.get(tunnelId);
    if (!tunnel) { state.incomplete = true; return []; }
    return visibleTunnelVariants(tunnel, groupById, state);
  }

  const hostId = Number(rule?.hostId || 0);
  if (!Number.isSafeInteger(hostId) || hostId <= 0) { state.incomplete = true; return []; }
  return [[hostId]];
}

export function buildPhysicalPaths(
  rules: any[],
  hosts: any[],
  tunnels: any[],
  groups: any[],
  landings: any[],
  fullChains: any[],
  category: TopologyCategory,
  search: string,
  targetGeoByAddress: ReadonlyMap<string, any> = new Map(),
) {
  const state: TopologyExpansionState = { truncated: false, incomplete: false };
  const hostById = new Map<number, any>(hosts.map((host: any) => [Number(host.id), host]));
  const tunnelById = new Map<number, any>(tunnels.map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const groupById = new Map<number, any>(groups.map((group: any) => [Number(group.id), group]));
  const landingById = new Map<number, any>(landings.map((landing: any) => [Number(landing.id), landing]));
  const ruleById = new Map<number, any>(rules.map((rule: any) => [Number(rule.id), rule]));
  const hostByAddress = new Map<string, any>();
  for (const host of hosts) {
    for (const value of [host?.entryIp, host?.ipv4, host?.ip, host?.publicIp, host?.exitIp]) {
      const address = String(value || "").trim().toLowerCase();
      if (address && !hostByAddress.has(address)) hostByAddress.set(address, host);
    }
  }
  const query = search.trim().toLowerCase();

  const makeHostNode = (
    hostId: number,
    kind: PhysicalNodeKind,
    detail: string,
    qualityTarget?: LinkQualityTarget | null,
  ): PhysicalNode => {
    const host = hostById.get(hostId);
    if (!host) state.incomplete = true;
    return {
      id: "host:" + hostId,
      kind,
      label: String(host?.name || "主机 #" + hostId),
      subtitle: hostAddress(host),
      detail,
      online: hostOnline(host),
      geoCountryCode: host?.geoCountryCode || null,
      geoCountryName: host?.geoCountryName || null,
      geoEmoji: host?.geoEmoji || null,
      qualityTarget: qualityTarget || null,
    };
  };

  const makeLandingForRule = (_pathId: string, rule: any): PhysicalNode => {
    const landing = Number(rule?.targetLandingServiceId || 0) > 0
      ? landingById.get(Number(rule.targetLandingServiceId))
      : null;
    if (landing) {
      const landingHostId = Number(landing?.hostId || landing?.host?.id || 0);
      const landingHost = landingHostId > 0 ? hostById.get(landingHostId) : null;
      if (landingHostId > 0) {
        return {
          id: "host:" + landingHostId,
          kind: "landing",
          label: String(landingHost?.name || landing.name || "落地主机 #" + landingHostId),
          subtitle: hostAddress(landingHost) || String(landing.endpoint || ""),
          detail: landing.port ? "落地 SS · " + String(landing.port) : "落地 SS",
          online: hostOnline(landingHost),
          geoCountryCode: landingHost?.geoCountryCode || null,
          geoCountryName: landingHost?.geoCountryName || null,
          geoEmoji: landingHost?.geoEmoji || null,
        };
      }
      const landingAddress = String(landing.endpoint || landing.targetIp || "").trim();
      const landingGeo = targetGeoByAddress.get(landingAddress.toLowerCase());
      return {
        id: "landing:" + Number(landing.id),
        kind: "landing",
        label: String(landing.name || "落地 SS #" + landing.id),
        subtitle: landingAddress,
        detail: landing.port ? "外部 SS · " + String(landing.port) : "外部 SS",
        online: null,
        geoCountryCode: landingGeo?.geoCountryCode || null,
        geoCountryName: landingGeo?.geoCountryName || null,
        geoEmoji: landingGeo?.geoEmoji || null,
      };
    }

    const targetIp = String(rule?.targetIp || "未知目标").trim();
    const targetPort = Number(rule?.targetPort || 0);
    const matchedHost = hostByAddress.get(targetIp.toLowerCase());
    if (matchedHost && Number(matchedHost.id || 0) > 0) {
      const hostId = Number(matchedHost.id);
      return {
        id: "host:" + hostId,
        kind: "landing",
        label: String(matchedHost.name || "主机 #" + hostId),
        subtitle: hostAddress(matchedHost),
        detail: targetPort > 0 ? "最终目标 · " + String(targetPort) : "最终目标",
        online: hostOnline(matchedHost),
        geoCountryCode: matchedHost?.geoCountryCode || null,
        geoCountryName: matchedHost?.geoCountryName || null,
        geoEmoji: matchedHost?.geoEmoji || null,
      };
    }

    const targetGeo = targetGeoByAddress.get(targetIp.toLowerCase());
    return {
      id: "target:" + targetIp + ":" + targetPort,
      kind: "landing",
      label: targetIp,
      subtitle: targetPort > 0 ? String(targetPort) : "",
      detail: "最终目标",
      online: null,
      geoCountryCode: targetGeo?.geoCountryCode || null,
      geoCountryName: targetGeo?.geoCountryName || null,
      geoEmoji: targetGeo?.geoEmoji || null,
    };
  };

  const resolveRuleTail = (
    rule: any,
    visited: Set<number>,
  ): Array<{ hostIds: number[]; landing: PhysicalNode; ruleIds: number[] }> => {
    const ruleId = Number(rule?.id || 0);
    if (ruleId > 0 && visited.has(ruleId)) { state.incomplete = true; return []; }

    const nextVisited = new Set(visited);
    if (ruleId > 0) nextVisited.add(ruleId);
    const currentVariants = directRuleVariants(rule, groupById, tunnelById, state);
    const targetRuleId = Number(rule?.targetRuleId || 0);
    const referenced = targetRuleId > 0 ? ruleById.get(targetRuleId) : null;

    if (targetRuleId > 0 && !referenced) { state.incomplete = true; return []; }
    if (!referenced) {
      return currentVariants.map((hostIds: number[], index: number) => ({
        hostIds,
        landing: makeLandingForRule("rule:" + ruleId + ":" + index, rule),
        ruleIds: ruleId > 0 ? [ruleId] : [],
      }));
    }

    const nested = resolveRuleTail(referenced, nextVisited);
    const result: Array<{ hostIds: number[]; landing: PhysicalNode; ruleIds: number[] }> = [];
    for (const current of currentVariants) {
      for (const tail of nested) {
        const hostIds = joinTopologyHostPaths(current, tail.hostIds);
        if (!hostIds) { state.incomplete = true; continue; }
        if (result.length >= MAX_TOPOLOGY_VARIANTS) { state.truncated = true; return result; }
        result.push({ hostIds, landing: tail.landing, ruleIds: Array.from(new Set([ruleId, ...tail.ruleIds].filter((id) => id > 0)))});
      }
    }
    return result;
  };

  const paths: PhysicalPath[] = [];

  for (const rule of rules) {
    // 运行时子规则由模板生成，拓扑只展示用户可见的主规则，避免重复画同一条物理路径。
    if (rule?.pendingDelete) continue;
    if (Number(rule?.forwardGroupRuleId || 0) > 0) continue;

    const currentCategory = ruleCategory(rule, groupById);
    if (category !== "all" && category !== currentCategory) continue;

    const tails = resolveRuleTail(rule, new Set());
    tails.forEach((tail, variantIndex) => {
      const pathId = "rule:" + Number(rule.id) + ":" + variantIndex;
      const physicalHostIds = tail.hostIds;
      const entryHostId = Number(physicalHostIds[0] || 0);
      if (entryHostId <= 0) return;

      const entry = makeHostNode(
        entryHostId,
        "entry",
        categoryLabel(currentCategory) + "入口",
        {
          scope: "rule",
          id: Number(rule.id),
          name: String(rule?.name || "规则 #" + rule.id),
          subtitle: "该规则的历史链路质量",
        },
      );

      const relayHostIds = physicalHostIds.slice(1);
      const relays = relayHostIds.map((hostId) => makeHostNode(hostId, "relay", "中转节点"));
      const landing = tail.landing;

      const haystack = [
        rule?.name,
        entry.label,
        entry.subtitle,
        ...relays.flatMap((node) => [node.label, node.subtitle]),
        landing.label,
        landing.subtitle,
      ].join(" ").toLowerCase();
      if (query && !haystack.includes(query)) return;

      paths.push({
        id: pathId,
        ruleId: Number(rule.id),
        segmentRuleIds: tail.ruleIds,
        name: String(rule?.name || "规则 #" + rule.id),
        category: currentCategory,
        entry,
        relays,
        landing,
      });
    });
  }

  if (category === "all" || category === "fullchain") {
    for (const chain of fullChains || []) {
      if (chain?.status !== "running" || !topologyEnabledFlag(chain?.isEnabled, true)) continue;
      const nodes = Array.isArray(chain?.nodes) ? chain.nodes : [];
      let variants: number[][] = nodes.length ? [[]] : [];
      for (const node of nodes) {
        let nodeVariants: number[][];
        if (String(node?.nodeType || "host") === "forward-chain") {
          const group = groupById.get(Number(node?.forwardGroupId || 0));
          nodeVariants = groupPhysicalVariants(group, groupById, tunnelById, state);
        } else {
          const hostId = Number(node?.hostId || 0);
          nodeVariants = Number.isSafeInteger(hostId) && hostId > 0 ? [[hostId]] : [];
        }
        if (!nodeVariants.length) { state.incomplete = true; variants = []; break; }
        variants = combineTopologyHostVariants(variants, nodeVariants, state);
        if (!variants.length) break;
      }
      variants.forEach((hostIds, variantIndex) => {
        if (hostIds.length === 0) return;
        const pathId = "fullchain:" + Number(chain.id) + ":" + variantIndex;
        const landingHostId = hostIds[hostIds.length - 1];
        const landingHost = hostById.get(landingHostId);
        const middleHostIds = hostIds.slice(1, -1);
        const entry = makeHostNode(Number(hostIds[0]), "entry", "全链路入口", {
          scope: "full-chain", id: Number(chain.id), name: String(chain?.name || "全链路 #" + chain.id), subtitle: "该全链路的历史探测质量",
        });
        if (chain?.name) entry.detail = "全链路入口 · " + String(chain.name);
        const relays = middleHostIds.map((hostId) => makeHostNode(hostId, "relay", "中转节点"));
        const landing: PhysicalNode = {
          id: "host:" + landingHostId, kind: "landing", label: String(landingHost?.name || "落地主机 #" + landingHostId),
          subtitle: hostAddress(landingHost), detail: "落地 SS", online: hostOnline(landingHost),
          geoCountryCode: landingHost?.geoCountryCode || null,
          geoCountryName: landingHost?.geoCountryName || null,
          geoEmoji: landingHost?.geoEmoji || null,
        };
        const haystack = [chain?.name, entry.label, entry.subtitle, ...relays.flatMap((node) => [node.label, node.subtitle]), landing.label, landing.subtitle].join(" ").toLowerCase();
        if (query && !haystack.includes(query)) return;
        paths.push({ id: pathId, name: String(chain?.name || "全链路 #" + chain.id), category: "fullchain", entry, relays, landing });
      });
    }
  }

  return { paths, ...state };
}

export function groupTopologyListRows(paths: PhysicalPath[]) {
  const rows: Array<{ path: PhysicalPath; entrances: PhysicalPath[] }> = [];
  const byRoute = new Map<string, typeof rows[number]>();
  for (const path of paths) {
    const key = path.category === "chain" && path.ruleId
      ? `${path.ruleId}:${[...path.relays, path.landing].map((node) => node.id).join("=>")}`
      : path.id;
    const existing = byRoute.get(key);
    if (existing && existing.entrances.every((entry) => entry.entry.id !== path.entry.id)) {
      existing.entrances.push(path);
    } else {
      const row = { path, entrances: [path] };
      rows.push(row);
      if (!existing) byRoute.set(key, row);
    }
  }
  return rows;
}

// Keep direct forwards in the overview; standalone forwards occupy an upper
// band while direct exits sharing a chain node remain attached to that chain.
export function relationshipOverviewPaths(paths: PhysicalPath[]) {
  return paths;
}

export function buildGraph(paths: PhysicalPath[], cardSize?: { width: number; height: number }) {
  const nodeMap = new Map<string, PhysicalNode>();
  const edgeMap = new Map<string, TopologyEdge>();
  const desiredDepth = new Map<string, number>();

  const mergeNode = (node: PhysicalNode) => {
    const existing = nodeMap.get(node.id);
    if (!existing) {
      nodeMap.set(node.id, node);
      return;
    }
    nodeMap.set(node.id, {
      ...existing,
      ...node,
      label: existing.label || node.label,
      subtitle: existing.subtitle || node.subtitle,
      detail: existing.detail || node.detail,
      online:
        existing.online === false || node.online === false
          ? false
          : existing.online ?? node.online,
      qualityTarget: existing.qualityTarget || node.qualityTarget,
    });
  };

  const addEdge = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    const id = from + "=>" + to;
    if (!edgeMap.has(id)) edgeMap.set(id, { id, from, to });
  };

  for (const path of paths) {
    mergeNode(path.entry);
    desiredDepth.set(path.entry.id, Math.min(desiredDepth.get(path.entry.id) ?? 0, 0));

    path.relays.forEach((relay, index) => {
      mergeNode(relay);
      desiredDepth.set(relay.id, Math.max(desiredDepth.get(relay.id) || 0, index + 1));
    });

    mergeNode(path.landing);
    desiredDepth.set(
      path.landing.id,
      Math.max(desiredDepth.get(path.landing.id) || 0, path.relays.length + 1),
    );

    const ordered = [path.entry, ...path.relays, path.landing];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      addEdge(ordered[index].id, ordered[index + 1].id);
    }
  }

  const rawNodes = Array.from(nodeMap.values());
  const edges = Array.from(edgeMap.values());

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) || []), edge.to]);
  }

  const rootIds = new Set(
    rawNodes
      .filter((node) => (incoming.get(node.id) || []).length === 0)
      .map((node) => node.id),
  );
  const sinkIds = new Set(
    rawNodes
      .filter((node) => (outgoing.get(node.id) || []).length === 0)
      .map((node) => node.id),
  );

  // 角色由整张真实物理图决定：
  // 没有上游的是入口，有上下游的是中转，没有下游的是落地/最终目标。
  const classifiedNodes = rawNodes.map((node): PhysicalNode => ({
    ...node,
    kind: rootIds.has(node.id) ? "entry" : sinkIds.has(node.id) ? "landing" : "relay",
  }));

  const depth = new Map<string, number>();
  for (const node of classifiedNodes) {
    depth.set(node.id, rootIds.has(node.id) ? 0 : Math.max(1, desiredDepth.get(node.id) || 1));
  }

  // 最长依赖路径决定中间层级，确保普通边始终从左向右。服务引用可能
  // 把物理图闭合成环；环的回边仍会绘制，但绝不能参与最长路径松弛，
  // 否则每一轮都会把整段环推到深度上限，形成超宽画布。
  const layerEdges = acyclicTopologyLayerEdges(classifiedNodes.map((node) => node.id), edges);
  for (let pass = 0; pass < Math.max(1, classifiedNodes.length); pass += 1) {
    let changed = false;
    for (const edge of layerEdges) {
      const nextDepth = (depth.get(edge.from) || 0) + 1;
      if (nextDepth > (depth.get(edge.to) || 0)) {
        depth.set(edge.to, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const nonSinkDepths = classifiedNodes
    .filter((node) => !sinkIds.has(node.id))
    .map((node) => depth.get(node.id) || 0);
  const maxMiddleDepth = Math.max(0, ...nonSinkDepths);
  // A landing reached directly from the entry or first convergence node is
  // below the forwarded-chain landings, even when that convergence node has
  // incoming edges from multiple group members and is not itself a root.
  const directOnlySinkIds = new Set(
    Array.from(sinkIds).filter((sinkId) => {
      const parents = incoming.get(sinkId) || [];
      return parents.length > 0 && parents.every((parentId) =>
        rootIds.has(parentId) || (maxMiddleDepth > 1 && (depth.get(parentId) || 0) === 1));
    }),
  );
  const landingColumn = Math.max(1, maxMiddleDepth + 1);
  for (const node of classifiedNodes) {
    if (sinkIds.has(node.id) && !rootIds.has(node.id)) depth.set(node.id, landingColumn);
  }

  const columns = new Map<number, PositionedNode[]>();
  const positionedNodes: PositionedNode[] = classifiedNodes.map((node) => {
    const column = rootIds.has(node.id) ? 0 : depth.get(node.id) || 1;
    const positioned: PositionedNode = { ...node, column, row: 0 };
    const list = columns.get(column) || [];
    list.push(positioned);
    columns.set(column, list);
    return positioned;
  });

  // A split keeps its own horizontal lane until it converges again. This is
  // deliberately stronger than a barycentric sort: referenced forwarding
  // services must not be squeezed into the direct forwarding service row.
  // A longer physical route is the visual spine; rule counts and host names
  // must not push a shorter entry above the route it joins later.
  const rootEdges = new Map([...rootIds].map((id) => [id, new Set<string>()] as const));
  const rootDepth = new Map<string, number>();
  for (const path of paths) {
    const edgesForRoot = rootEdges.get(path.entry.id);
    if (!edgesForRoot) continue;
    rootDepth.set(path.entry.id, Math.max(rootDepth.get(path.entry.id) || 0, path.relays.length));
    topologyPathEdgeIds([path.entry, ...path.relays, path.landing].map((node) => node.id))
      .forEach((edgeId) => edgesForRoot.add(edgeId));
  }
  const edgeFrequency = new Map<string, number>();
  for (const edgeIds of rootEdges.values()) for (const edgeId of edgeIds)
    edgeFrequency.set(edgeId, (edgeFrequency.get(edgeId) || 0) + 1);
  const rootPriority = new Map([...rootIds].map((id) => [id, {
    depth: rootDepth.get(id) || 0,
    shared: [...(rootEdges.get(id) || [])].filter((edgeId) => (edgeFrequency.get(edgeId) || 0) > 1).length,
  }] as const));
  assignTopologyBranchRows(columns, edges, rootIds, directOnlySinkIds, rootPriority);

  // The relationship overview is a layered physical graph: shared HK→SG and
  // HK→JP legs are represented once, while the router reserves lanes around
  // cards so a dense connection bends rather than crossing a node.
  const routed = routeSmoothLayeredTopologyGraph(positionedNodes, edges, directOnlySinkIds, cardSize);
  return { nodes: positionedNodes, edges, ...routed };
}

export function buildOverviewGraph(paths: PhysicalPath[], cardSize?: { width: number; height: number }) {
  const chainPaths = paths.filter((path) => path.relays.length > 0);
  const chainNodeIds = new Set(chainPaths.flatMap((path) =>
    [path.entry, ...path.relays, path.landing].map((node) => node.id)));
  // Grow the chain component through direct paths as well: a direct path can
  // share a node with another direct path which itself touches a chain. Splitting
  // those paths into separate bands would render that shared node twice.
  const connectedIds = new Set(chainNodeIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const path of paths) {
      if (path.relays.length > 0 || ![path.entry.id, path.landing.id].some((id) => connectedIds.has(id))) continue;
      for (const id of [path.entry.id, path.landing.id]) {
        if (!connectedIds.has(id)) { connectedIds.add(id); expanded = true; }
      }
    }
  }
  const standalone = paths.filter((path) => path.relays.length === 0
    && ![path.entry.id, path.landing.id].some((id) => connectedIds.has(id)));
  const connected = paths.filter((path) => !standalone.includes(path));
  if (!standalone.length) return buildGraph(connected, cardSize);
  if (!connected.length) return buildGraph(standalone, cardSize);
  const direct = buildGraph(standalone, cardSize);
  const chain = buildGraph(connected, cardSize);
  const offset = direct.height + 64;
  return {
    ...chain,
    nodes: [...direct.nodes, ...chain.nodes],
    edges: [...direct.edges, ...chain.edges],
    positions: new Map([...direct.positions, ...[...chain.positions].map(([id, box]) => [id, { ...box, y: box.y + offset }] as const)]),
    edgeRoutes: new Map([...direct.edgeRoutes, ...[...chain.edgeRoutes].map(([id, points]) => [id, points.map((point) => ({ ...point, y: point.y + offset }))] as const)]),
    width: Math.max(direct.width, chain.width),
    height: offset + chain.height,
  };
}

function fallbackNodeIcon(kind: PhysicalNodeKind) {
  if (kind === "entry") return <Waypoints className="h-3.5 w-3.5" />;
  if (kind === "relay") return <Server className="h-3.5 w-3.5" />;
  return <Route className="h-3.5 w-3.5" />;
}

function nodeIcon(node: PhysicalNode) {
  const countryCode = String(node.geoCountryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) return fallbackNodeIcon(node.kind);
  const countryName = String(node.geoCountryName || countryCode).trim();
  return (
    <span className="inline-flex h-[18px] w-6 shrink-0 items-center justify-center" title={countryName}>
      <img
        src={`https://flagcdn.com/24x18/${countryCode.toLowerCase()}.png`}
        alt={`${countryName}国旗`}
        referrerPolicy="no-referrer"
        className="h-[18px] w-6 rounded-[3px] border border-black/10 object-cover shadow-sm"
        onError={(event) => {
          event.currentTarget.style.display = "none";
          const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
          if (fallback) fallback.style.display = "inline-flex";
        }}
      />
      <span className="hidden h-full w-full items-center justify-center" aria-hidden="true">
        {node.geoEmoji || fallbackNodeIcon(node.kind)}
      </span>
    </span>
  );
}

function nodeTone(node: PhysicalNode) {
  if (node.kind === "entry") return "border-chart-3/30 bg-chart-3/10";
  if (node.kind === "relay") {
    return node.online === false
      ? "border-destructive/35 bg-destructive/10"
      : "border-chart-2/30 bg-chart-2/10";
  }
  return node.online === false
    ? "border-destructive/35 bg-destructive/10"
    : "border-chart-4/30 bg-chart-4/10";
}

function topologyPathReference(path: PhysicalPath, sourcePort?: unknown) {
  if (path.ruleId) {
    const port = String(sourcePort ?? "").trim();
    if (port) return `端口 ${port}`;
    const variant = Number(path.id.split(":")[2] || 0);
    return variant > 0 ? `#${path.ruleId} · 分支 ${variant + 1}` : `#${path.ruleId}`;
  }
  const [, id, variantText] = path.id.split(":");
  const variant = Number(variantText || 0);
  return `${path.category === "fullchain" ? "全链路" : "链路"} #${id || "—"}${variant > 0 ? ` · 分支 ${variant + 1}` : ""}`;
}

function formatTopologyBytes(value: number) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
}

type TopologyPathMetrics = {
  bytesIn: number;
  bytesOut: number;
  bytesInPerSecond: number;
  bytesOutPerSecond: number;
  latestLatencyMs: number | null;
  latestLatencyIsTimeout: boolean;
  latestLatencyIsBlocked?: boolean;
  segmentPending?: boolean;
};

function TopologyEntryBranch({
  entrances,
  next,
  selectedPathId,
  edgeLabel,
  probeDisabled,
  onProbe,
  onSelect,
}: {
  entrances: PhysicalPath[];
  next: PhysicalNode;
  selectedPathId: string | null;
  edgeLabel: (entry: PhysicalPath, edge: TopologyEdge) => string;
  probeDisabled: (entry: PhysicalPath, edge: TopologyEdge, label: string) => boolean;
  onProbe: (entry: PhysicalPath, edge: TopologyEdge) => void;
  onSelect: (entry: PhysicalPath) => void;
}) {
  const rowHeight = 64;
  const height = entrances.length * rowHeight;
  const middle = height / 2;
  const branches = entrances.map((entry, index) => {
    const edge = { id: `${entry.entry.id}=>${next.id}`, from: entry.entry.id, to: next.id };
    return { entry, edge, y: index * rowHeight + rowHeight / 2, label: edgeLabel(entry, edge) };
  });
  const selected = branches.some(({ entry, label }) => entry.id === selectedPathId && label !== "阻断" && label !== "离线");
  return <div className="flex shrink-0 items-center gap-1.5">
    <div className="flex w-44 shrink-0 flex-col">
      {branches.map(({ entry }) => <div key={entry.id} className="flex h-16 items-center"><button type="button" onClick={(event) => { event.stopPropagation(); onSelect(entry); }} title={`${entry.entry.label} · ${entry.entry.subtitle || "IP 未知"}`} className="flex h-12 w-full items-center gap-1.5 rounded-lg border border-blue-100 bg-blue-50/70 px-2 text-left text-xs font-semibold text-slate-800 hover:border-primary/60"><span className="shrink-0">{nodeIcon(entry.entry)}</span><span className="min-w-0"><span className="block truncate">{entry.entry.label}</span><span className="block truncate font-mono text-[10px] font-normal text-slate-500">{entry.entry.subtitle || "IP 未知"}</span></span></button></div>)}
    </div>
    <div className="relative w-28 shrink-0" style={{ height }}>
      <svg className="absolute inset-0" width="112" height={height} viewBox={`0 0 112 ${height}`} aria-hidden="true">
        {branches.map(({ entry, y, label }) => <path key={entry.id} d={`M 0 ${y} C 42 ${y}, 36 ${middle}, 76 ${middle}`} fill="none" stroke={label === "阻断" || label === "离线" ? "var(--destructive)" : "var(--primary)"} strokeOpacity={entry.id === selectedPathId ? 1 : .55} strokeWidth={entry.id === selectedPathId ? 2 : 1.5} className={entry.id === selectedPathId && label !== "阻断" && label !== "离线" ? "edge-flow-active" : ""} />)}
        <path d={`M 76 ${middle} H 103`} fill="none" stroke="var(--primary)" strokeOpacity={selected ? 1 : .55} strokeWidth={selected ? 2 : 1.5} className={selected ? "edge-flow-active" : ""} />
      </svg>
      {branches.map(({ entry, edge, y, label }) => <button key={entry.id} type="button" style={{ top: y - 19, left: 4 }} disabled={probeDisabled(entry, edge, label)} onClick={(event) => { event.stopPropagation(); onProbe(entry, edge); }} title="点击探测此入口到下一节点" className="absolute rounded border border-border/70 bg-card px-1 font-mono text-[10px] text-muted-foreground hover:text-primary disabled:cursor-not-allowed disabled:opacity-60">{label}</button>)}
      <ArrowRight aria-hidden="true" className="absolute right-0 top-1/2 h-3 w-3 -translate-y-1/2 text-primary" />
    </div>
  </div>;
}

function TopologyLane({
  path,
  metrics,
  edgeLatency,
  selected,
  onSelectPath,
  onSelectNode,
}: {
  path: PhysicalPath;
  metrics?: TopologyPathMetrics;
  edgeLatency?: (from: PhysicalNode, to: PhysicalNode) => string;
  selected: boolean;
  onSelectPath: () => void;
  onSelectNode: (node: PhysicalNode) => void;
}) {
  const nodes = [path.entry, ...path.relays, path.landing];
  return (
    <section
      className={cn(
        "rounded-xl border bg-card/40 p-3 transition-colors sm:p-4",
        selected ? "border-primary/50 ring-1 ring-primary/20" : "border-border/45",
      )}
    >
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 text-left"
        onClick={onSelectPath}
      >
        <Route className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate text-sm font-semibold">{path.name}</span>
        <Badge variant="outline" className="ml-auto h-5 shrink-0 text-[10px]">
          {categoryLabel(path.category)}
        </Badge>
        <span className="text-xs text-muted-foreground">{nodes.length} 跳</span>
        {metrics && <span className="text-xs tabular-nums text-muted-foreground">24H ↓{formatTopologyBytes(metrics.bytesOut)} ↑{formatTopologyBytes(metrics.bytesIn)}</span>}
        {metrics?.latestLatencyIsTimeout ? <Badge variant="outline" className="h-5 border-destructive/35 text-[10px] text-destructive">链路延迟超时</Badge> : metrics?.latestLatencyMs != null ? <Badge variant="outline" className="h-5 border-primary/30 text-[10px] tabular-nums">链路延迟 {Math.round(metrics.latestLatencyMs)} ms</Badge> : <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">链路延迟未测试</Badge>}
      </button>
      <div className="mt-3 overflow-x-auto pb-1">
        <div className="flex min-w-max items-stretch gap-0">
          {nodes.map((node, index) => {
            const isManagedVps = node.id.startsWith("host:");
            return (
            <div key={`${path.id}:${node.id}:${index}`} className="flex items-center">
              {index > 0 && (() => {
                const label = edgeLatency?.(nodes[index - 1], nodes[index]) || "待探测";
                return <div className="relative flex w-14 shrink-0 items-center px-1.5">
                  <span className="h-0 flex-1 border-t border-dashed border-primary/65" />
                  <ArrowRight className="-ml-0.5 h-3 w-3 shrink-0 text-primary" />
                  <span className={cn("absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border bg-background px-1 text-[9px] tabular-nums", label === "待探测" || label === "探测中" ? "border-border/50 text-muted-foreground" : label === "超时" ? "border-destructive/35 text-destructive" : "border-border/50 text-muted-foreground")}>{label}</span>
                </div>;
              })()}
              <button
                type="button"
                onClick={() => onSelectNode(node)}
                className={cn(
                  "w-44 rounded-lg border p-2.5 text-left shadow-sm transition hover:border-primary/55 hover:shadow-md",
                  nodeTone(node),
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold">{node.label}</span>
                </div>
                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  {index === 0 ? "入口" : index === nodes.length - 1 ? "落地 / 最终目标" : "中转"}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-foreground/80">{node.subtitle || node.detail || "—"}</div>
                {metrics && isManagedVps ? (
                  <div className="mt-2 flex items-center justify-between border-t border-border/35 pt-1.5 text-[10px] tabular-nums">
                    <span className="text-emerald-600 dark:text-emerald-400">↓ {formatTopologyBytes(metrics.bytesOutPerSecond)}/s</span>
                    <span className="text-amber-600 dark:text-amber-400">↑ {formatTopologyBytes(metrics.bytesInPerSecond)}/s</span>
                  </div>
                ) : (
                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {node.online === true ? "节点在线" : node.online === false ? "节点离线" : "状态未知"}
                  </div>
                )}
              </button>
            </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TopologyTableRow({
  path,
  metrics,
  edgeLatency,
  selected,
  onSelectPath,
  onSelectNode,
  checked,
  onCheckedChange,
  onProbe,
  onHistory,
}: {
  path: PhysicalPath;
  metrics?: TopologyPathMetrics;
  edgeLatency: (from: PhysicalNode, to: PhysicalNode) => string;
  selected: boolean;
  onSelectPath: () => void;
  onSelectNode: (node: PhysicalNode) => void;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onProbe: () => void;
  onHistory: () => void;
}) {
  const nodes = [path.entry, ...path.relays, path.landing];
  return <div className={cn("grid min-w-[1040px] grid-cols-[1.5rem_11rem_minmax(32rem,1fr)_5.5rem_5.5rem_7rem_4rem] items-center gap-3 border-t border-border/40 px-4 py-3 transition-colors", selected ? "bg-primary/5" : "hover:bg-muted/25")}>
    <input type="checkbox" aria-label={`选择 ${path.name}`} checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} className="h-4 w-4 accent-primary" />
    <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={onSelectPath}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-primary"><Route className="h-4 w-4" /></span>
      <span className="min-w-0"><span className="block truncate text-sm font-semibold">{path.name}</span><span className="block truncate text-[11px] text-muted-foreground">{path.id}</span></span>
    </button>
    <div className="flex min-w-0 items-center gap-2 overflow-x-auto py-0.5">
      {nodes.map((node, index) => <div key={`${path.id}:${node.id}:${index}`} className="flex shrink-0 items-center gap-2">
        {index > 0 && <div className="flex w-12 shrink-0 flex-col items-center gap-0.5"><span className="text-[10px] tabular-nums text-primary">{edgeLatency(nodes[index - 1], node)}</span><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /></div>}
        <button type="button" onClick={(event) => { event.stopPropagation(); onSelectNode(node); }} className={cn("w-44 rounded-xl border px-3 py-2 text-left transition hover:shadow-sm", nodeTone(node))}>
          <span className="flex items-center gap-1.5"><span className="shrink-0">{nodeIcon(node)}</span><span className="truncate text-xs font-semibold">{node.label}</span>{node.online != null && <span className={cn("ml-auto h-2 w-2 rounded-full", node.online ? "bg-emerald-500" : "bg-destructive")} />}</span>
          <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{node.subtitle || node.detail || "—"}</span>
        </button>
      </div>)}
    </div>
    <span className="justify-self-center rounded-md bg-muted px-2 py-1 text-xs">{categoryLabel(path.category)}</span>
    <span className={cn("justify-self-center inline-flex items-center gap-1 text-xs", !metrics ? "text-muted-foreground" : metrics.latestLatencyIsTimeout ? "text-destructive" : "text-emerald-600")}><span className={cn("h-2 w-2 rounded-full", !metrics ? "bg-muted-foreground" : metrics.latestLatencyIsTimeout ? "bg-destructive" : "bg-emerald-500")} />{!metrics ? "状态未知" : metrics.latestLatencyIsTimeout ? "超时" : "运行中"}</span>
    <div className="justify-self-end text-right text-xs tabular-nums">{metrics ? <><div><span className="text-emerald-600">↓</span> {formatTopologyBytes(metrics.bytesOut)} <span className="text-amber-600">↑</span> {formatTopologyBytes(metrics.bytesIn)}</div><span className={cn("mt-1 inline-block rounded border px-1.5 py-0.5 font-medium", metrics.latestLatencyIsTimeout ? "border-destructive/30 text-destructive" : "border-primary/25 text-primary")}>{metrics.latestLatencyIsTimeout ? "超时" : metrics.latestLatencyMs != null ? `${Math.round(metrics.latestLatencyMs)} ms` : "未测试"}</span></> : <span className="text-muted-foreground">—</span>}</div>
    <div className="flex justify-end gap-1"><Button size="icon" variant="ghost" className="h-7 w-7" title="查看历史链路质量" disabled={!path.ruleId} onClick={onHistory}><Activity className="h-3.5 w-3.5" /></Button><Button size="icon" variant="ghost" className="h-7 w-7" title="立即探测路径" disabled={!path.ruleId} onClick={onProbe}><Stethoscope className="h-3.5 w-3.5" /></Button></div>
  </div>;
}

export function MobileTopologyPathCard({
  path,
  entrances,
  metrics,
  rule,
  probing,
  totalFallback,
  onProbePath,
  onHistory,
  onNetworkProfile,
  edgeLabel,
  entryEdgeLabel,
  onProbeEdge,
  onProbeEntryEdge,
}: {
  path: PhysicalPath;
  entrances: PhysicalPath[];
  metrics?: TopologyPathMetrics;
  rule?: any;
  probing: boolean;
  totalFallback: string;
  onProbePath: () => void;
  onHistory: () => void;
  onNetworkProfile: () => void;
  edgeLabel: (from: PhysicalNode, to: PhysicalNode) => string;
  entryEdgeLabel: (entry: PhysicalPath, to: PhysicalNode) => string;
  onProbeEdge: (edge: TopologyEdge) => void;
  onProbeEntryEdge: (entry: PhysicalPath, edge: TopologyEdge) => void;
}) {
  const nodes = [path.entry, ...path.relays, path.landing];
  const speedRoute = nodes
    .map((node, index) => ({
      hostId: physicalNodeHostId(node),
      name: node.label,
      transport: index === 0 ? "规则入口" : index === nodes.length - 1 ? "落地 SS" : "中转",
    }))
    .filter((node) => node.hostId > 0);
  const speedEntryHostId = physicalNodeHostId(path.entry);
  const working = path.category === "fullchain" || (topologyEnabledFlag(rule?.isEnabled, true) && !rule?.pendingDelete);
  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-md md:hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <RouteTypeBadge category={path.category} />
            <div className="min-w-0">
              <div className="truncate text-base font-bold text-foreground">{path.name}</div>
              <div className="mt-1 flex items-center gap-1.5"><span className="font-mono text-[10px] text-muted-foreground">{topologyPathReference(path, rule?.sourcePort)}</span><RouteTypeLabel category={path.category} /></div>
            </div>
          </div>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold", working ? "border-chart-2/30 bg-chart-2/10 text-chart-2" : "border-destructive/35 bg-destructive/10 text-destructive")}>
            <i className={cn("h-1.5 w-1.5 rounded-full", working ? "bg-chart-2" : "bg-destructive")} />
            {working ? "运行中" : "已停用"}
          </span>
        </div>

        <div className="mt-3 overflow-hidden rounded-xl bg-muted/35 text-center">
          <div className="flex items-center justify-between gap-3 p-3">
            <span className="text-[11px] text-muted-foreground">总延迟（端到端 TCP）</span>
            {probing ? <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-mono text-xs font-semibold text-blue-600"><Loader2 className="h-3 w-3 animate-spin" />探测中…</span>
              : metrics?.latestLatencyIsTimeout ? <button type="button" onClick={onProbePath} disabled={!path.ruleId} title="当前端到端 TCP 探测超时；点击重新探测" className="rounded-md border border-destructive/35 bg-destructive/10 px-2 py-1 font-mono text-xs font-semibold text-destructive disabled:opacity-60">TCP {metrics.latestLatencyIsBlocked ? "阻断" : "超时"}</button>
              : metrics?.latestLatencyMs != null ? <button type="button" onClick={onProbePath} disabled={!path.ruleId} title="当前为端到端 TCP 延迟；点击重新探测" className="rounded-md border border-violet-200 bg-violet-50 px-2 py-1 font-mono text-xs font-bold text-violet-700 disabled:opacity-60">TCP {Math.round(metrics.latestLatencyMs)} ms</button>
              : <button type="button" onClick={onProbePath} disabled={!path.ruleId || totalFallback !== "待探测"} title="点击执行端到端 TCP 探测" className="rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700 disabled:opacity-60">{totalFallback === "待探测" ? "点击探测" : totalFallback}</button>}
          </div>
          <div className="grid grid-cols-3 gap-2 border-t border-border/50 px-3 py-2.5">
            <div><div className="text-[10px] text-muted-foreground">24H 总流量</div><div className="mt-1 whitespace-nowrap font-mono text-[11px] font-bold text-foreground">{metrics ? formatTopologyBytes(metrics.bytesIn + metrics.bytesOut) : "—"}</div></div>
            <div><div className="text-[10px] text-muted-foreground">24H 下载</div><div className="mt-1 whitespace-nowrap font-mono text-[11px] font-semibold text-chart-2">↓ {metrics ? formatTopologyBytes(metrics.bytesOut) : "—"}</div></div>
            <div><div className="text-[10px] text-muted-foreground">24H 上传</div><div className="mt-1 whitespace-nowrap font-mono text-[11px] font-semibold text-chart-4">↑ {metrics ? formatTopologyBytes(metrics.bytesIn) : "—"}</div></div>
          </div>
        </div>

        <div className="mx-auto mt-4 max-w-sm">
          {entrances.length > 1 && <div className="space-y-2 rounded-xl border border-blue-200/60 p-2">
            {entrances.map((entry) => {
              const to = nodes[1];
              const edge = { id: `${entry.entry.id}=>${to.id}`, from: entry.entry.id, to: to.id };
              return <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs">
                <span className="truncate font-semibold">{entry.entry.label}</span>
                <button type="button" disabled={!entry.ruleId} onClick={() => onProbeEntryEdge(entry, edge)} className="shrink-0 font-mono text-blue-700">{entryEdgeLabel(entry, to)} →</button>
              </div>;
            })}
            <p className="text-center text-[10px] text-muted-foreground">共同汇入 {nodes[1]?.label}</p>
          </div>}
          {nodes.slice(entrances.length > 1 ? 1 : 0).map((node, offset) => {
            const index = offset + (entrances.length > 1 ? 1 : 0);
            const previous = index > 0 && !(index === 1 && entrances.length > 1) ? nodes[index - 1] : null;
            const segmentLabel = previous ? edgeLabel(previous, node) : "";
            const edge = previous ? { id: `${previous.id}=>${node.id}`, from: previous.id, to: node.id } : null;
            const waiting = segmentLabel === "待探测" || segmentLabel === "探测中" || segmentLabel === "读取中";
            const segmentProbing = segmentLabel === "探测中";
            const failed = segmentLabel === "超时" || segmentLabel === "阻断" || segmentLabel === "离线";
            const role = index === 0 ? "入口" : index === nodes.length - 1 ? "落地 SS" : "中转";
            return <div key={`${path.id}:${node.id}:${index}`}>
              {previous && edge && (
                <div className="relative flex h-12 items-center justify-center">
                  <span className={cn("absolute inset-y-0 left-1/2 w-px -translate-x-1/2", failed ? "bg-destructive/30" : waiting ? "border-l border-dashed border-chart-4/50" : "bg-border")} />
                  <button type="button" disabled={!path.ruleId || segmentProbing || previous.online === false} onClick={() => onProbeEdge(edge)} className={cn("relative rounded-md border bg-card px-2 py-0.5 font-mono text-[10px] font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-70", failed ? "border-destructive/35 text-destructive" : waiting ? "border-chart-4/35 text-chart-4" : "border-border text-muted-foreground")}>
                    {segmentLabel}
                  </button>
                </div>
              )}
              <div className={cn("relative flex items-center gap-3 overflow-hidden rounded-xl border px-3 py-3 shadow-sm", index === 0 ? "border-chart-3/30 bg-chart-3/10" : index === nodes.length - 1 ? "border-chart-4/30 bg-chart-4/10" : "border-chart-2/30 bg-chart-2/10")}>
                <span className="flex h-[24px] w-8 shrink-0 items-center justify-center">{nodeIcon(node)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="truncate text-sm font-bold text-foreground">{node.label}</span><span className="shrink-0 rounded bg-card/75 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">{role}</span></div>
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{node.subtitle || node.detail || "—"}</div>
                </div>
                <i className={cn("h-2 w-2 shrink-0 rounded-full", node.online === false ? "bg-destructive" : node.online === true ? "bg-chart-2" : "bg-muted-foreground/40")} />
                {node.online === false && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-xs font-bold text-white backdrop-blur-[1px]">节点离线</span>}
              </div>
            </div>;
          })}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/40 pt-3">
          <Button type="button" size="sm" variant="outline" onClick={onHistory} disabled={!path.ruleId} className="h-9 px-2 text-xs"><Activity className="mr-1.5 h-3.5 w-3.5" />链路质量</Button>
          <Button type="button" size="sm" variant="outline" onClick={onNetworkProfile} disabled={!/^host:\d+$/.test(path.landing.id)} className="h-9 px-2 text-xs"><Earth className="mr-1.5 h-3.5 w-3.5" />网络画像</Button>
          {path.ruleId && (path.category === "local" || path.category === "chain")
            ? <LinkSpeedTestButton ruleId={path.ruleId} entryHostId={speedEntryHostId} pathId={path.id} name={path.name} route={speedRoute} disabled={speedEntryHostId <= 0 || speedRoute.length < 2} buttonLabel="链路测速" buttonClassName="w-full px-2" />
            : <Button type="button" size="sm" variant="outline" disabled className="h-9 px-2 text-xs"><Gauge className="mr-1.5 h-3.5 w-3.5" />链路测速</Button>}
        </div>
      </div>
    </section>
  );
}

function formatTopologyLogTime(value: Date | string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replaceAll("/", "-");
}

function formatTopologyDuration(durationMs: number) {
  let seconds = Math.max(0, Math.floor(durationMs / 1_000));
  const days = Math.floor(seconds / 86_400); seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600); seconds %= 3_600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  return `${days ? `${days}天` : ""}${hours || days ? `${hours}时` : ""}${minutes || hours || days ? `${minutes}分` : ""}${seconds}秒`;
}

function NetworkTopologyContent() {
  const [category, setCategory] = useState<TopologyCategory>("all");
  const [search, setSearch] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodePathSelection, setNodePathSelection] = useState<{ nodeId: string; pathIds: string[]; anchor: { left: number; top: number } } | null>(null);
  const nodePathPopupRef = useRef<HTMLElement | null>(null);
  const [hoveredGraphNodeId, setHoveredGraphNodeId] = useState<string | null>(null);
  const [hoveredGraphEdgeId, setHoveredGraphEdgeId] = useState<string | null>(null);
  const [density, setDensity] = useState<TopologyDensity>("standard");
  const [probingRuleIds, setProbingRuleIds] = useState<Set<string>>(() => new Set());
  const probingStartedAtRef = useRef(new Map<string, number>());
  const probingBaselineAtRef = useRef(new Map<string, number>());
  // Each logical path edge owns a stable local snapshot. Polling a new job must
  // never clear completed results for unrelated edges.
  const [segmentProbes, setSegmentProbes] = useState<Record<string, TopologySegmentProbe>>({});
  const segmentProbeLocksRef = useRef(new Set<string>());
  // Start with the complete network; operators can narrow the graph to one entry VPS.
  const [entryFilter, setEntryFilter] = useState<string | null>("all");
  const [zoom, setZoom] = useState(1);
  const [canvasActivated, setCanvasActivated] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const deactivate = (event: PointerEvent) => {
      if (event.target instanceof Node && !canvasRef.current?.contains(event.target)) setCanvasActivated(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      setCanvasActivated(false);
      setSelectedPathId(null);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setNodePathSelection(null);
      setHoveredGraphNodeId(null);
      setHoveredGraphEdgeId(null);
    };
    document.addEventListener("pointerdown", deactivate);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", deactivate); document.removeEventListener("keydown", escape); };
  }, []);
  const [layoutMode, setLayoutMode] = useState<"split" | "list" | "topo">("split");
  const [qualityTarget, setQualityTarget] = useState<LinkQualityTarget | null>(null);
  const [networkProfileTarget, setNetworkProfileTarget] = useState<{ hostId: number; hostName: string } | null>(null);
  const [checkedPathIds, setCheckedPathIds] = useState<Set<string>>(() => new Set());
  const [probeMessage, setProbeMessage] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [blockTooltip, setBlockTooltip] = useState<{ incident: TopologyBlockLog; left: number; top: number; above: boolean } | null>(null);
  const blockTooltipTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!nodePathSelection) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !nodePathPopupRef.current?.contains(target) && !(target as Element).closest?.("[data-topology-node]")) setNodePathSelection(null);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [nodePathSelection]);
  const startRuleLatencyTest = trpc.rules.startTopologyTotalTest.useMutation();
  const refreshPathSegments = trpc.diagnostics.refreshSegments.useMutation();
  const startSegmentProbe = trpc.diagnostics.startSegment.useMutation();
  const activeSegmentProbeIds = useMemo(() => activeTopologySegmentProbeIds(segmentProbes), [segmentProbes]);
  const segmentProbeStatus = trpc.diagnostics.status.useQuery(
    { testIds: activeSegmentProbeIds.length ? activeSegmentProbeIds : [1] },
    { enabled: activeSegmentProbeIds.length > 0, refetchInterval: activeSegmentProbeIds.length > 0 ? pollingInterval("realtime") : false, refetchOnWindowFocus: false },
  );
  useEffect(() => {
    if (!segmentProbeStatus.data?.length) return;
    setSegmentProbes((current) => mergeTopologySegmentProbeResults(current, segmentProbeStatus.data as any[]));
  }, [segmentProbeStatus.data]);

  const hostsQuery = trpc.hosts.options.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
  });
  const tunnelsQuery = trpc.tunnels.options.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
  });
  const groupsQuery = trpc.forwardGroups.options.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
  });
  const rulesQuery = trpc.rules.list.useQuery({ scope: "all" } as any, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const landingQuery = trpc.landing.list.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
  });
  const fullChainsQuery = trpc.fullChains.list.useQuery(undefined, {
    refetchInterval: pollingInterval("slow"),
    staleTime: 20_000,
    refetchOnWindowFocus: false,
  });
  const topologyTargetAddresses = useMemo(
    () => Array.from(new Set(
      ((rulesQuery.data || []) as any[])
        .map((rule) => String(rule?.targetIp || "").trim())
        .filter(Boolean),
    )).slice(0, 100),
    [rulesQuery.data],
  );
  const targetGeoQuery = trpc.rules.targetGeoBatch.useQuery(
    { targets: topologyTargetAddresses },
    {
      enabled: topologyTargetAddresses.length > 0,
      staleTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  );
  const targetGeoByAddress = useMemo(() => {
    const map = new Map<string, any>();
    for (const row of targetGeoQuery.data || []) {
      const address = String((row as any)?.target || "").trim().toLowerCase();
      const geo = (row as any)?.geo;
      if (address && geo) map.set(address, geo);
    }
    return map;
  }, [targetGeoQuery.data]);

  const topology = useMemo(
    () => buildPhysicalPaths(
      (rulesQuery.data || []) as any[],
      (hostsQuery.data || []) as any[],
      (tunnelsQuery.data || []) as any[],
      (groupsQuery.data || []) as any[],
      (landingQuery.data || []) as any[],
      (fullChainsQuery.data || []) as any[],
      category,
      search,
      targetGeoByAddress,
    ),
    [rulesQuery.data, hostsQuery.data, tunnelsQuery.data, groupsQuery.data, landingQuery.data, fullChainsQuery.data, category, search, targetGeoByAddress],
  );
  const paths = topology.paths;
  // 分类按钮的计数必须基于全部可见配置计算，不能使用当前分类筛选后的 paths。
  const allCategoryPaths = useMemo(
    () => buildPhysicalPaths(
      (rulesQuery.data || []) as any[],
      (hostsQuery.data || []) as any[],
      (tunnelsQuery.data || []) as any[],
      (groupsQuery.data || []) as any[],
      (landingQuery.data || []) as any[],
      (fullChainsQuery.data || []) as any[],
      "all",
      search,
      targetGeoByAddress,
    ).paths,
    [rulesQuery.data, hostsQuery.data, tunnelsQuery.data, groupsQuery.data, landingQuery.data, fullChainsQuery.data, search, targetGeoByAddress],
  );
  const categoryCounts = useMemo(() => {
    const listPaths = groupTopologyListRows(allCategoryPaths).map((row) => row.path);
    const counts = new Map<TopologyCategory, number>([["all", listPaths.length]]);
    categoryOptions.filter((option) => option.value !== "all").forEach((option) => {
      counts.set(option.value, listPaths.filter((path) => path.category === option.value).length);
    });
    return counts;
  }, [allCategoryPaths]);
  const topologyRuleIds = useMemo(
    () => Array.from(new Set(paths.flatMap((path) => path.segmentRuleIds || [Number(path.ruleId || 0)]).filter((id) => id > 0))),
    [paths],
  );
  // Read the persisted current-value table on entry. Subsequent one-second
  // updates read only the same small snapshot (no probe history scans).
  const automaticSegmentQuery = trpc.diagnostics.latestSegments.useQuery(
    { ruleIds: topologyRuleIds },
    { enabled: topologyRuleIds.length > 0, staleTime: 0, refetchOnWindowFocus: false, placeholderData: (previousData) => previousData },
  );
  const [segmentPollTick, setSegmentPollTick] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setSegmentPollTick(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const segmentDeltaQuery = trpc.diagnostics.latestSegments.useQuery(
    { ruleIds: topologyRuleIds, recentSeconds: 5, pollTick: segmentPollTick },
    { enabled: topologyRuleIds.length > 0, refetchIntervalInBackground: true, staleTime: 0, refetchOnWindowFocus: false },
  );
  const recentSegmentSamplesRef = useRef(new Map<string, AutomaticTopologySegment>());
  const [segmentRevision, setSegmentRevision] = useState(0);
  useEffect(() => {
    let changed = false;
    for (const sample of (segmentDeltaQuery.data || []) as AutomaticTopologySegment[]) {
      const key = `${sample.ruleId}:${sample.segmentKey}`;
      const old = recentSegmentSamplesRef.current.get(key);
      if (old && new Date(sample.recordedAt || 0).getTime() < new Date(old.recordedAt || 0).getTime()) continue;
      if (!old || old.latencyMs !== sample.latencyMs || old.isTimeout !== sample.isTimeout || old.blocked !== sample.blocked) changed = true;
      recentSegmentSamplesRef.current.set(key, sample);
    }
    // A repeated Ping value and status merely refreshes the sample's recency;
    // it does not require rebuilding the graph or list.
    if (changed) setSegmentRevision((revision) => revision + 1);
  }, [segmentDeltaQuery.data]);
  const automaticSegments = useMemo(() => {
    const merged = new Map<string, AutomaticTopologySegment>();
    for (const sample of (automaticSegmentQuery.data || []) as AutomaticTopologySegment[]) merged.set(`${sample.ruleId}:${sample.segmentKey}`, sample);
    for (const [key, sample] of recentSegmentSamplesRef.current) {
      const old = merged.get(key);
      if (!old || new Date(sample.recordedAt || 0).getTime() >= new Date(old.recordedAt || 0).getTime()) merged.set(key, sample);
    }
    return Array.from(merged.values());
  }, [automaticSegmentQuery.data, segmentRevision]);
  const topologyBlockLogsQuery = trpc.diagnostics.topologyBlockLogs.useQuery(
    { limit: 200 },
    { refetchInterval: pollingInterval("fast"), refetchIntervalInBackground: true, staleTime: 1_000 },
  );
  const topologyBlockLogs = (topologyBlockLogsQuery.data || []) as TopologyBlockLog[];
  const [topologyLogNow, setTopologyLogNow] = useState(() => Date.now());
  useEffect(() => {
    if (!topologyBlockLogs.some((entry) => entry.type === "blocked" && !entry.recoveredAt)) return;
    const timer = window.setInterval(() => setTopologyLogNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [topologyBlockLogs]);
  const activeBlockIncidents = useMemo(
    () => topologyBlockLogs.filter((entry) => entry.type === "blocked" && !entry.recoveredAt),
    [topologyBlockLogs],
  );
  const blockIncidentForSegment = (segment: AutomaticTopologySegment | null) => segment ? activeBlockIncidents.find((incident) => (
    incident.sourceHostId === Number(segment.sourceHostId)
    && incident.targetAddress.trim().toLowerCase() === String(segment.targetAddress || "").trim().toLowerCase()
  )) || null : null;
  const hideBlockTooltip = () => {
    if (blockTooltipTimerRef.current !== null) window.clearTimeout(blockTooltipTimerRef.current);
    blockTooltipTimerRef.current = null;
    setBlockTooltip(null);
  };
  const showBlockTooltip = (element: Element, incident: TopologyBlockLog | null) => {
    hideBlockTooltip();
    if (!incident) return;
    const rect = element.getBoundingClientRect();
    blockTooltipTimerRef.current = window.setTimeout(() => {
      const width = 320;
      const above = rect.top >= 170;
      setBlockTooltip({
        incident,
        left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2)),
        top: above ? rect.top - 10 : rect.bottom + 10,
        above,
      });
      blockTooltipTimerRef.current = null;
    }, 450);
  };
  useEffect(() => () => {
    if (blockTooltipTimerRef.current !== null) window.clearTimeout(blockTooltipTimerRef.current);
  }, []);
  const trafficQuery = trpc.rules.trafficSummary.useQuery(
    { hours: 24, range: "24h", ruleIds: topologyRuleIds },
    {
      enabled: topologyRuleIds.length > 0,
      refetchInterval: pollingInterval("normal"),
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      placeholderData: (previousData) => previousData,
    },
  );
  const rateRuleIds = useMemo(() => topologyRuleIds.slice(0, 100), [topologyRuleIds]);
  const topologySourceHostIds = useMemo(() => Array.from(new Set(paths.flatMap((path) =>
    [path.entry, ...path.relays].map(physicalNodeHostId).filter((id) => id > 0),
  ))).slice(0, 200), [paths]);
  const [topologyWatchId] = useState(() => globalThis.crypto?.randomUUID?.()
    ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (digit) => {
      const value = Math.floor(Math.random() * 16);
      return (digit === "x" ? value : (value & 3) | 8).toString(16);
    }));
  const stopTopologyWatcher = trpc.rules.stopTopologyWatcher.useMutation();
  useEffect(() => {
    const leave = () => { void stopTopologyWatcher.mutateAsync({ watchId: topologyWatchId }).catch(() => undefined); };
    const leaveOnPageHide = () => {
      // Keepalive survives tab close; the tRPC call above also supports native
      // clients and ordinary in-app navigation.
      leave();
      void fetch("/api/trpc/rules.stopTopologyWatcher", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { watchId: topologyWatchId } }),
        credentials: "same-origin", keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", leaveOnPageHide);
    return () => { window.removeEventListener("pagehide", leaveOnPageHide); leave(); };
  }, [topologyWatchId, stopTopologyWatcher.mutateAsync]);
  // Preserve each entrance's stored TCP result while a newer job is pending.
  const completedLatencyTestsRef = useRef(new Map<string, TopologyRuleTest>());
  const topologyTestEntries = useMemo(() => Array.from(new Map(paths.filter((path) => path.ruleId && physicalNodeHostId(path.entry) > 0)
    .map((path) => {
      const entry = { ruleId: Number(path.ruleId), entryHostId: physicalNodeHostId(path.entry) };
      return [`${entry.ruleId}:${entry.entryHostId}`, entry] as const;
    })).values()).slice(0, 100), [paths]);
  const ruleLatencyTests = trpc.rules.latestTopologyTests.useQuery(
    { entries: topologyTestEntries },
    { enabled: topologyTestEntries.length > 0, refetchInterval: pollingInterval(probingRuleIds.size ? "realtime" : "slow"), refetchIntervalInBackground: true, staleTime: 0, refetchOnWindowFocus: false },
  );
  // Topology is observational by default. Full-route tests are started only
  // from the total-latency control; individual edges use diagnostic jobs below.
  const testByRule = useMemo(() => new Map((ruleLatencyTests.data || []).map((row: any) => {
    const key = `${Number(row.ruleId)}:${Number(row.entryHostId)}`;
    const candidate: TopologyRuleTest = {
      parsed: parseLinkTestMessage(row.test?.message),
      recordedAt: new Date(row.test?.updatedAt || row.test?.createdAt || 0).getTime(),
      status: String(row.test?.status || "pending"),
      latencyMs: typeof row.test?.latencyMs === "number" ? row.test.latencyMs : null,
    };
    const completed = candidate.parsed.details.length > 0 || ["success", "failed", "timeout"].includes(candidate.status);
    if (completed) completedLatencyTestsRef.current.set(key, candidate);
    return [key, completed ? candidate : completedLatencyTestsRef.current.get(key) || candidate];
  })), [ruleLatencyTests.data]);
  // A total-latency click is an end-to-end rule TCP test. Keep the whole
  // logical path locked until that test reaches a terminal state; segment Ping
  // refreshes may finish earlier but must not release the path-level lock.
  useEffect(() => {
    if (!probingRuleIds.size) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setProbingRuleIds((current) => {
        const next = new Set(current);
        for (const key of current) {
          const startedAt = probingStartedAtRef.current.get(key) || 0;
          const test = testByRule.get(key);
          const baselineAt = probingBaselineAtRef.current.get(key) || 0;
          const terminal = !!test && ["success", "failed", "timeout"].includes(test.status) && test.recordedAt > baselineAt;
          if (terminal || now - startedAt >= 60_000) {
            next.delete(key);
            probingStartedAtRef.current.delete(key);
            probingBaselineAtRef.current.delete(key);
          }
        }
        return next.size === current.size ? current : next;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [testByRule, probingRuleIds.size]);
  const trafficRateQuery = trpc.rules.trafficRateBatch.useQuery(
    { ruleIds: rateRuleIds, sourceHostIds: topologySourceHostIds, watchId: topologyWatchId },
    {
      enabled: rateRuleIds.length > 0 || topologySourceHostIds.length > 0,
      // While topology is open the existing Agent reporter is requested at 1s.
      // Match the topology Agent reporter's 500ms interactive interval.
      refetchInterval: 500,
      refetchIntervalInBackground: true,
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
  );
  const trafficByRule = useMemo(() => {
    const metrics = new Map<number, TopologyPathMetrics>();
    // Total TCP tests are keyed by the path's rule, which can differ from
    // its physical segment rule IDs (notably full chains).
    new Set([...topologyRuleIds, ...paths.map((path) => Number(path.ruleId || 0))].filter((id) => id > 0)).forEach((ruleId) => metrics.set(ruleId, {
      bytesIn: 0,
      bytesOut: 0,
      bytesInPerSecond: 0,
      bytesOutPerSecond: 0,
      latestLatencyMs: null,
      latestLatencyIsTimeout: false,
    }));
    (trafficQuery.data || []).forEach((row: any) => {
      const ruleId = Number(row.ruleId || 0);
      if (ruleId <= 0) return;
      const current = metrics.get(ruleId) || {
        bytesIn: 0,
        bytesOut: 0,
        bytesInPerSecond: 0,
        bytesOutPerSecond: 0,
        latestLatencyMs: null,
        latestLatencyIsTimeout: false,
      };
      current.bytesIn += Math.max(0, Number(row.bytesIn) || 0);
      current.bytesOut += Math.max(0, Number(row.bytesOut) || 0);
      const updatedAt = row.latestLatencyAt ? new Date(row.latestLatencyAt).getTime() : 0;
      const currentAt = (current as any)._latestAt || 0;
      if (updatedAt >= currentAt) {
        current.latestLatencyMs = row.latestLatencyMs == null ? null : Number(row.latestLatencyMs);
        current.latestLatencyIsTimeout = !!row.latestLatencyIsTimeout;
        (current as any)._latestAt = updatedAt;
      }
      metrics.set(ruleId, current);
    });
    (trafficRateQuery.data || []).forEach((row: any) => {
      const metric = metrics.get(Number(row.ruleId || 0));
      if (!metric) return;
      metric.bytesInPerSecond = Math.max(0, Number(row.bytesInPerSecond) || 0);
      metric.bytesOutPerSecond = Math.max(0, Number(row.bytesOutPerSecond) || 0);
    });
    return metrics;
  }, [topologyRuleIds, paths, trafficQuery.data, trafficRateQuery.data]);

  const entryGroups = useMemo(() => {
    const groups = new Map<string, { entry: PhysicalNode; paths: PhysicalPath[] }>();
    for (const path of paths) {
      const group = groups.get(path.entry.id) || { entry: path.entry, paths: [] };
      group.paths.push(path);
      groups.set(path.entry.id, group);
    }
    return Array.from(groups.values()).sort((a, b) => a.entry.label.localeCompare(b.entry.label, "zh-CN"));
  }, [paths]);
  const activeEntry = entryFilter === "all" || entryGroups.some((group) => group.entry.id === entryFilter)
    ? entryFilter
    : entryGroups[0]?.entry.id || "all";
  const visiblePaths = useMemo(() => {
    const filtered = activeEntry === "all" ? paths : paths.filter((path) => path.entry.id === activeEntry);
    if (category !== "all") return filtered;
    // The aggregate list follows the category tabs so identical route types
    // remain adjacent while preserving their existing order within each type.
    return [...filtered].sort((left, right) => (
      (categorySortOrder.get(left.category) ?? Number.MAX_SAFE_INTEGER)
      - (categorySortOrder.get(right.category) ?? Number.MAX_SAFE_INTEGER)
    ));
  }, [paths, activeEntry, category]);
  // Only the list collapses entry variants; the canvas retains physical edges.
  const listRows = useMemo(() => groupTopologyListRows(visiblePaths), [visiblePaths]);
  const overviewPaths = useMemo(() => relationshipOverviewPaths(visiblePaths), [visiblePaths]);
  const graph = useMemo(() => buildOverviewGraph(overviewPaths, topologyCardSize(density)), [overviewPaths, density]);
  const graphHostIds = useMemo(() => Array.from(new Set(graph.nodes.map(physicalNodeHostId).filter((id) => id > 0))).slice(0, 500), [graph.nodes]);
  const graphMetricHostKey = graphHostIds.join(",");
  const watchGraphMetrics = trpc.hosts.watchMetrics.useMutation();
  useEffect(() => {
    if (layoutMode === "list" || !graphMetricHostKey) return;
    const hostIds = graphMetricHostKey.split(",").map(Number);
    const watch = () => {
      for (let start = 0; start < hostIds.length; start += 200) {
        watchGraphMetrics.mutate({ hostIds: hostIds.slice(start, start + 200) });
      }
    };
    watch();
    const timer = window.setInterval(watch, pollingInterval("live") || 2_000);
    return () => window.clearInterval(timer);
  }, [graphMetricHostKey, layoutMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const graphHostMetrics = trpc.hosts.latestMetricsSummary.useQuery({ hostIds: graphHostIds }, {
    enabled: graphHostIds.length > 0 && layoutMode !== "list", refetchInterval: pollingInterval("live"),
  });
  const graphHostTraffic = trpc.hosts.trafficSummary.useQuery({ hostIds: graphHostIds }, {
    enabled: graphHostIds.length > 0 && layoutMode !== "list", refetchInterval: pollingInterval("slow"),
  });
  const hostMetricsById = new Map((graphHostMetrics.data || []).map((row) => [Number(row.hostId), row]));
  const hostTrafficById = new Map((graphHostTraffic.data || []).map((row) => [Number(row.hostId), row]));
  const hostById = new Map(((hostsQuery.data || []) as any[]).map((host) => [Number(host.id), host]));
  const canvasWidth = graph.width;
  const canvasHeight = graph.height;
  const selectedPath = visiblePaths.find((path) => path.id === selectedPathId) || null;
  const graphFocusPaths = useMemo(() => visiblePaths.map((path) => ({ id: path.id, nodeIds: [path.entry, ...path.relays, path.landing].map((node) => node.id) })), [visiblePaths]);
  const focused = topologyFocus(graphFocusPaths, {
    nodeId: hoveredGraphNodeId || nodePathSelection?.nodeId,
    edgeId: hoveredGraphNodeId || nodePathSelection ? null : hoveredGraphEdgeId,
    pathId: selectedPath?.id,
  });
  const highlightedNodes = focused.nodeIds;
  const highlightedEdges = focused.edgeIds;
  const { edges: graphEdgeCounts, nodes: graphNodeCounts } = useMemo(() => topologyUsageCounts(graphFocusPaths), [graphFocusPaths]);
  const selectedNode = selectedNodeId
    ? graph.nodes.find((node) => node.id === selectedNodeId) || null
    : null;
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId) || null;
  const automaticEdgeMeasurement = (edge: TopologyEdge, path?: PhysicalPath | null) => {
    if (!path) return null;
    const sourceHostId = Number(edge.from.replace(/^host:/, ""));
    const targetHostId = Number(edge.to.replace(/^host:/, ""));
    const targetNode = graph.nodes.find((node) => node.id === edge.to);
    const ruleIds = new Set((path.segmentRuleIds || [Number(path.ruleId || 0)]).map(Number).filter((id) => id > 0));
    const targetAddresses = [targetNode?.label, targetNode?.subtitle].map((value) => String(value || "").trim()).filter(Boolean);
    return latestAutomaticTopologySegment(automaticSegments, { ruleIds, sourceHostId, targetHostId, targetAddresses, method: "ping" });
  };
  const automaticSegmentLabel = (segment: AutomaticTopologySegment) => segment.blocked
    ? "阻断"
    : segment.latencyMs == null
      ? "待复测"
      : `${Math.round(Number(segment.latencyMs))} ms`;
  const segmentProbeKey = (path: PhysicalPath, edge: TopologyEdge) => topologySegmentProbeKey(path.id, edge.id);
  const segmentProbeFor = (path: PhysicalPath, edge: TopologyEdge) => segmentProbes[segmentProbeKey(path, edge)] || null;
  const edgeSourceNode = (edge: TopologyEdge) => graph.nodes.find((node) => node.id === edge.from) || null;
  const edgeSourceOffline = (edge: TopologyEdge) => edgeSourceNode(edge)?.online === false;
  // A graph edge is one physical leg even when several logical rules reuse it.
  // Show the freshest physical measurement instead of presenting it as several paths.
  const physicalEdgeMeasurementLabel = (edge: TopologyEdge, edgePaths: PhysicalPath[], includePending = true) => {
    if (edgeSourceOffline(edge)) return "离线";
    const candidates = [
      ...edgePaths.map((path) => segmentProbeFor(path, edge)).filter((probe): probe is TopologySegmentProbe => {
        if (!probe || (!includePending && ["pending", "running"].includes(probe.status))) return false;
        // A one-off manual failure must not bypass the shared 15-second
        // continuous-failure state machine. The next automatic sample decides
        // whether the physical edge remains healthy or becomes blocked.
        return ["pending", "running"].includes(probe.status) || (probe.success && probe.latencyMs !== null);
      }).map((probe) => ({
        at: probe.requestedAt,
        pending: ["pending", "running"].includes(probe.status),
        success: probe.success && probe.latencyMs !== null,
        label: probe.success && probe.latencyMs !== null ? `${Math.round(probe.latencyMs)} ms` : "超时",
      })),
      ...edgePaths.map((path) => automaticEdgeMeasurement(edge, path)).filter((segment): segment is AutomaticTopologySegment => !!segment).map((segment) => ({
        at: new Date(segment.recordedAt || 0).getTime(),
        pending: false,
        success: !segment.isTimeout && segment.latencyMs !== null,
        label: automaticSegmentLabel(segment),
      })),
    ];
    // Agents collect reused physical legs in one burst. If one logical rule's
    // downstream target is offline, do not let that route-specific failure
    // overwrite a successful measurement of the same source -> next-hop leg.
    const label = summarizePhysicalTopologySegmentLabels(candidates,
      automaticSegmentQuery.isError ? "读取失败" : automaticSegmentQuery.isFetched && !automaticSegmentQuery.isPlaceholderData ? "待探测" : "读取中");
    return label === "待复测" ? "待探测" : label;
  };
  const pathEdgeMeasurementLabel = (path: PhysicalPath, edge: TopologyEdge) => {
    if (edgeSourceOffline(edge)) return "离线";
    const ownProbe = segmentProbeFor(path, edge);
    if (ownProbe && ["pending", "running"].includes(ownProbe.status)) return "探测中";
    const edgePaths = paths.filter((candidate) => topologyPathEdgeIds([candidate.entry, ...candidate.relays, candidate.landing].map((node) => node.id)).includes(edge.id));
    const measured = physicalEdgeMeasurementLabel(edge, edgePaths, false);
    return measured === "待复测" ? "待探测" : measured;
  };
  const requestSegmentProbe = async (path: PhysicalPath, edge: TopologyEdge) => {
    const ruleId = Number(path.ruleId || 0);
    const fromHostId = Number(edge.from.replace(/^host:/, ""));
    const target = graph.nodes.find((node) => node.id === edge.to);
    const targetAddress = String(target?.id.startsWith("target:") ? target.label : (target?.subtitle || target?.label || "")).trim();
    const key = segmentProbeKey(path, edge);
    const current = segmentProbeFor(path, edge);
    if (edgeSourceOffline(edge)) {
      setProbeMessage(`${edgeSourceNode(edge)?.label || "源节点"} 已离线，无法发起此段 Ping 探测。`);
      return;
    }
    if (!ruleId || !Number.isSafeInteger(fromHostId) || fromHostId <= 0 || !targetAddress || segmentProbeLocksRef.current.has(key) || ["pending", "running"].includes(String(current?.status || ""))) return;
    if (activeSegmentProbeIds.length >= 64) {
      setProbeMessage("当前并发单跳探测过多，请等待已有任务完成。");
      return;
    }
    const previousProbe = current;
    const requestedAt = Date.now();
    segmentProbeLocksRef.current.add(key);
    setSegmentProbes((previous) => ({ ...previous, [key]: { ruleId, testId: 0, status: "pending", success: false, latencyMs: previousProbe?.latencyMs ?? null, requestedAt } }));
    try {
      const result = await startSegmentProbe.mutateAsync({ ruleId, fromHostId, targetAddress });
      setSegmentProbes((previous) => ({ ...previous, [key]: { ruleId, testId: Number(result.testId), status: "pending", success: false, latencyMs: previous[key]?.latencyMs ?? null, requestedAt } }));
      setProbeMessage(`已下发 ${targetAddress} 单跳 RTT 探测…`);
    } catch (error) {
      setSegmentProbes((previous) => {
        const next = { ...previous };
        if (previousProbe) next[key] = previousProbe;
        else delete next[key];
        return next;
      });
      setProbeMessage(`单跳探测请求失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      segmentProbeLocksRef.current.delete(key);
    }
  };
  const requestPathProbe = async (path: PhysicalPath) => {
    const ruleId = Number(path.ruleId || 0);
    const entryHostId = physicalNodeHostId(path.entry);
    if (ruleId <= 0 || entryHostId <= 0) return;
    const key = `${ruleId}:${entryHostId}`;
    if (probingRuleIds.has(key)) {
      setProbeMessage("该入口正在探测中，请等待本轮端到端 TCP 结果返回。");
      return;
    }
    const startedAt = Date.now();
    probingStartedAtRef.current.set(key, startedAt);
    probingBaselineAtRef.current.set(key, testByRule.get(key)?.recordedAt || 0);
    setProbingRuleIds((current) => new Set(current).add(key));
    setProbeMessage("正在执行入口端到端 TCP 探测…");
    try {
      await startRuleLatencyTest.mutateAsync({ ruleId, entryHostId });
      setProbeMessage("TCP 探测任务已下发，逐跳 Ping 将按原有采样周期独立更新。");
      void ruleLatencyTests.refetch();
    } catch (error) {
      probingStartedAtRef.current.delete(key);
      probingBaselineAtRef.current.delete(key);
      setProbingRuleIds((current) => { const next = new Set(current); next.delete(key); return next; });
      setProbeMessage(`链路探测失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const nodePaths = selectedNode ? paths.filter((path) => [path.entry, ...path.relays, path.landing].some((node) => node.id === selectedNode.id)) : [];
  const edgePaths = selectedEdge ? paths.filter((path) => topologyPathEdgeIds([path.entry, ...path.relays, path.landing].map((node) => node.id)).includes(selectedEdge.id)) : [];
  const nodeRoles = selectedNode ? [
    nodePaths.some((path) => path.entry.id === selectedNode.id) && "入口",
    nodePaths.some((path) => path.relays.some((node) => node.id === selectedNode.id)) && "中转",
    nodePaths.some((path) => path.landing.id === selectedNode.id) && "目标",
  ].filter(Boolean).join("、") : "";
  const isLoading = rulesQuery.isLoading || hostsQuery.isLoading || tunnelsQuery.isLoading || groupsQuery.isLoading || landingQuery.isLoading || fullChainsQuery.isLoading;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (isLoading || !canvas || graph.nodes.length === 0 || canvas.clientWidth < 2 || canvas.clientHeight < 2) return;
    const width = Math.max(1, canvas.clientWidth);
    const mobileGraph = window.matchMedia("(max-width: 767px)").matches;
    setZoom(fitTopologyZoom(width, canvas.clientHeight, canvasWidth, canvasHeight, mobileGraph));
    let positionFrame = 0;
    const zoomFrame = requestAnimationFrame(() => {
      positionFrame = requestAnimationFrame(() => {
        if (!canvas.isConnected) return;
        if (mobileGraph) {
          canvas.scrollTo({
            left: Math.max(0, (canvas.scrollWidth - canvas.clientWidth) / 2),
            top: Math.max(0, (canvas.scrollHeight - canvas.clientHeight) / 2),
          });
          return;
        }
        canvas.scrollTo({ left: 0, top: 0 });
      });
    });
    return () => {
      cancelAnimationFrame(zoomFrame);
      cancelAnimationFrame(positionFrame);
    };
  }, [activeEntry, canvasHeight, canvasWidth, category, graph.centerY, graph.nodes.length, isLoading, layoutMode]);

  const focusNode = (nodeId: string) => {
    const position = graph.positions.get(nodeId);
    const canvas = canvasRef.current;
    if (!position || !canvas) return;
    canvas.scrollTo({ left: Math.max(0, (position.x + position.width / 2) * zoom - canvas.clientWidth / 2),
      top: Math.max(0, (position.y + position.height / 2) * zoom - canvas.clientHeight / 2), behavior: "smooth" });
  };
  // Roles are counted per configured path; one host may occupy multiple roles.
  const entryCount = new Set(paths.map((path) => path.entry.id)).size;
  const relayCount = new Set(paths.flatMap((path) => path.relays.map((node) => node.id))).size;
  const landingCount = new Set(paths.map((path) => path.landing.id)).size;
  const metricsForPath = (path: PhysicalPath) => {
    const base = path.ruleId ? trafficByRule.get(path.ruleId) : undefined;
    if (!base) return undefined;
    // Ping is a separate physical-edge metric. Neither its failures nor the
    // sum of its samples may overwrite the entrance's TCP measurement.
    const test = testByRule.get(`${Number(path.ruleId || 0)}:${physicalNodeHostId(path.entry)}`);
    if (test && ["failed", "timeout"].includes(test.status)) return { ...base, latestLatencyMs: null, latestLatencyIsTimeout: true, latestLatencyIsBlocked: false, segmentPending: false };
    const total = test?.status === "success"
      ? typeof test.parsed.totalLatencyMs === "number" ? test.parsed.totalLatencyMs : test.latencyMs
      : null;
    return { ...base, latestLatencyMs: total, latestLatencyIsTimeout: false, latestLatencyIsBlocked: false, segmentPending: false };
  };
  const selectedPathMetrics = selectedPath?.ruleId ? metricsForPath(selectedPath) : undefined;
  const selectedPathNodes = selectedPath ? [selectedPath.entry, ...selectedPath.relays, selectedPath.landing] : [];

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(value);
    window.setTimeout(() => setCopied((current) => current === value ? null : current), 1400);
  };
  const pathMetrics = (path: PhysicalPath) => metricsForPath(path);
  const selectPath = (path: PhysicalPath) => { setSelectedPathId(path.id); setSelectedNodeId(null); setSelectedEdgeId(null); setNodePathSelection(null); };
  const selectGraphNode = (node: PhysicalNode, element: HTMLElement) => {
    const candidates = visiblePaths.filter((path) => [path.entry, ...path.relays, path.landing].some((item) => item.id === node.id));
    if (!candidates.length) return;
    const bounds = element.getBoundingClientRect();
    const rootBounds = element.closest(".network-topology-root")?.getBoundingClientRect();
    const left = bounds.left + bounds.width / 2 - (rootBounds?.left || 0);
    setNodePathSelection({ nodeId: node.id, pathIds: candidates.map((path) => path.id), anchor: { left, top: bounds.top - (rootBounds?.top || 0) - 8 } });
    setSelectedNodeId(node.id);
  };
  const openLandingNetworkProfile = (path: PhysicalPath) => {
    const match = /^host:(\d+)$/.exec(path.landing.id);
    const hostId = Number(match?.[1] || 0);
    if (hostId > 0) setNetworkProfileTarget({ hostId, hostName: path.landing.label });
  };
  useEffect(() => {
    if (!nodePathSelection) return;
    const update = () => {
      const element = Array.from(canvasRef.current?.querySelectorAll<HTMLElement>("[data-topology-node-id]") || [])
        .find((item) => item.dataset.topologyNodeId === nodePathSelection.nodeId);
      const root = canvasRef.current?.closest(".network-topology-root");
      if (!element || !root) return;
      const bounds = element.getBoundingClientRect();
      const rootBounds = root.getBoundingClientRect();
      const anchor = { left: bounds.left + bounds.width / 2 - rootBounds.left, top: bounds.top - rootBounds.top - 8 };
      setNodePathSelection((current) => current && current.nodeId === nodePathSelection.nodeId
        && (current.anchor.left !== anchor.left || current.anchor.top !== anchor.top) ? { ...current, anchor } : current);
    };
    update();
    const canvas = canvasRef.current;
    canvas?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { canvas?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [nodePathSelection?.nodeId, zoom, density, layoutMode]);
  const nodePathCandidates = nodePathSelection
    ? visiblePaths.filter((path) => nodePathSelection.pathIds.includes(path.id))
    : [];
  const popupContainerWidth = canvasRef.current?.closest(".network-topology-root")?.clientWidth || 360;
  const nodePopupWidth = Math.min(320, Math.max(200, popupContainerWidth - 32));
  const nodePopupLeft = nodePathSelection
    ? Math.max(nodePopupWidth / 2 + 16, Math.min(nodePathSelection.anchor.left, popupContainerWidth - nodePopupWidth / 2 - 16))
    : 0;

  return (
    <div className="network-topology-root relative space-y-5 text-foreground">
      <style>{`
        @keyframes topoDashFlow { to { stroke-dashoffset: -24; } }
        .network-topology-root {
          color: var(--foreground);
          color-scheme: light;
          /* Topology roles are semantic, not theme accents. Keep them distinct even
             when a personalized theme intentionally uses a monochromatic chart palette. */
          --topology-entry: oklch(0.58 0.17 255);
          --topology-relay: oklch(0.59 0.15 155);
          --topology-special: oklch(0.60 0.13 215);
          --topology-landing: oklch(0.69 0.16 65);
        }
        .dark .network-topology-root {
          color-scheme: dark;
          --topology-entry: oklch(0.74 0.14 255);
          --topology-relay: oklch(0.74 0.14 155);
          --topology-special: oklch(0.76 0.12 215);
          --topology-landing: oklch(0.80 0.14 75);
        }
        .network-topology-root input[type="checkbox"] { accent-color: var(--primary); }
        .network-topology-root [class~="text-chart-1"] { color: var(--topology-special); }
        .network-topology-root [class~="text-chart-2"] { color: var(--topology-relay); }
        .network-topology-root [class~="text-chart-3"] { color: var(--topology-entry); }
        .network-topology-root [class~="text-chart-4"] { color: var(--topology-landing); }
        .network-topology-root [class~="bg-chart-1/10"] { background-color: color-mix(in oklch, var(--topology-special) 12%, var(--card)); }
        .network-topology-root [class~="bg-chart-2/10"] { background-color: color-mix(in oklch, var(--topology-relay) 12%, var(--card)); }
        .network-topology-root [class~="bg-chart-3/10"] { background-color: color-mix(in oklch, var(--topology-entry) 12%, var(--card)); }
        .network-topology-root [class~="bg-chart-4/10"] { background-color: color-mix(in oklch, var(--topology-landing) 12%, var(--card)); }
        .network-topology-root [class~="bg-chart-2"] { background-color: var(--topology-relay); }
        .network-topology-root [class~="bg-chart-3"] { background-color: var(--topology-entry); }
        .network-topology-root [class~="bg-chart-4"] { background-color: var(--topology-landing); }
        .network-topology-root [class~="border-chart-1/30"] { border-color: color-mix(in oklch, var(--topology-special) 35%, var(--border)); }
        .network-topology-root [class~="border-chart-2/30"] { border-color: color-mix(in oklch, var(--topology-relay) 35%, var(--border)); }
        .network-topology-root [class~="border-chart-3/30"] { border-color: color-mix(in oklch, var(--topology-entry) 35%, var(--border)); }
        .network-topology-root [class~="border-chart-4/30"],
        .network-topology-root [class~="border-chart-4/35"] { border-color: color-mix(in oklch, var(--topology-landing) 38%, var(--border)); }
        .network-topology-root [class~="border-chart-4/50"] { border-color: color-mix(in oklch, var(--topology-landing) 52%, var(--border)); }
        .edge-flow-active { stroke-dasharray: 6 6; animation: topoDashFlow .85s linear infinite; }
        @keyframes topologyListFlow { to { background-position: 16px 0; } }
        .topology-list-edge-flow {
          background: repeating-linear-gradient(90deg, var(--primary) 0 7px, transparent 7px 16px);
          background-size: 16px 2px;
          animation: topologyListFlow .85s linear infinite;
        }
        .topo-grid-bg {
          background-color: color-mix(in oklch, var(--card) 88%, var(--muted) 12%);
          background-image: radial-gradient(color-mix(in oklch, var(--muted-foreground) 36%, transparent) 1px, transparent 1px);
          background-size: 18px 18px;
          scrollbar-color: color-mix(in oklch, var(--muted-foreground) 45%, transparent) transparent;
        }
        .network-topology-root [class~="bg-white"] { background-color: var(--card); }
        .network-topology-root [class~="bg-white/75"] { background-color: color-mix(in oklch, var(--card) 82%, transparent); }
        .network-topology-root [class~="bg-white/20"] { background-color: color-mix(in oklch, var(--primary-foreground) 18%, transparent); }
        .network-topology-root [class~="bg-slate-50"],
        .network-topology-root [class~="bg-slate-50/60"],
        .network-topology-root [class~="bg-slate-50/70"],
        .network-topology-root [class~="bg-slate-50/80"],
        .network-topology-root [class~="bg-slate-50/90"] { background-color: color-mix(in oklch, var(--muted) 48%, var(--card)); }
        .network-topology-root [class~="bg-slate-100"],
        .network-topology-root [class~="bg-slate-100/90"] { background-color: var(--muted); }
        .network-topology-root [class~="bg-slate-200"] { background-color: var(--border); }
        .network-topology-root [class~="bg-slate-300"] { background-color: color-mix(in oklch, var(--muted-foreground) 42%, transparent); }
        .network-topology-root [class~="text-slate-900"],
        .network-topology-root [class~="text-slate-800"],
        .network-topology-root [class~="text-slate-700"] { color: var(--foreground); }
        .network-topology-root [class~="text-slate-600"],
        .network-topology-root [class~="text-slate-500"],
        .network-topology-root [class~="text-slate-400"],
        .network-topology-root [class~="text-slate-300"] { color: var(--muted-foreground); }
        .network-topology-root [class~="border-slate-100"],
        .network-topology-root [class~="border-slate-200"],
        .network-topology-root [class~="border-slate-200/60"],
        .network-topology-root [class~="border-slate-200/70"],
        .network-topology-root [class~="border-slate-200/80"],
        .network-topology-root [class~="border-slate-200/90"] { border-color: var(--border); }
        .network-topology-root [class~="divide-slate-100"] > :not(:last-child) { border-color: color-mix(in oklch, var(--border) 70%, transparent); }
        .network-topology-root [class~="hover:bg-slate-50"]:hover,
        .network-topology-root [class~="hover:bg-slate-50/90"]:hover { background-color: var(--accent); }
        .network-topology-root [class~="hover:text-slate-700"]:hover,
        .network-topology-root [class~="hover:text-slate-800"]:hover { color: var(--accent-foreground); }
        .network-topology-root [class~="focus:bg-white"]:focus { background-color: var(--card); }

        .network-topology-root [class~="bg-blue-50"],
        .network-topology-root [class~="bg-blue-50/60"],
        .network-topology-root [class~="bg-blue-50/70"],
        .network-topology-root [class~="bg-sky-50"] { background-color: color-mix(in oklch, var(--topology-entry) 12%, var(--card)); }
        .network-topology-root [class~="bg-blue-500"],
        .network-topology-root [class~="bg-sky-500"] { background-color: var(--topology-entry); }
        .network-topology-root [class~="text-blue-500"],
        .network-topology-root [class~="text-blue-600"],
        .network-topology-root [class~="text-blue-700"],
        .network-topology-root [class~="text-sky-500"],
        .network-topology-root [class~="text-sky-600"] { color: var(--topology-entry); }
        .network-topology-root [class~="border-blue-100"],
        .network-topology-root [class~="border-blue-200"],
        .network-topology-root [class~="border-blue-200/80"] { border-color: color-mix(in oklch, var(--topology-entry) 38%, var(--border)); }
        .network-topology-root [class~="ring-blue-500/30"] { --tw-ring-color: color-mix(in oklch, var(--topology-entry) 35%, transparent); }

        .network-topology-root [class~="bg-emerald-50"],
        .network-topology-root [class~="bg-emerald-50/45"],
        .network-topology-root [class~="bg-emerald-50/70"],
        .network-topology-root [class~="bg-emerald-500/5"],
        .network-topology-root [class~="bg-teal-50"] { background-color: color-mix(in oklch, var(--topology-relay) 12%, var(--card)); }
        .network-topology-root [class~="bg-emerald-100"] { background-color: color-mix(in oklch, var(--topology-relay) 20%, var(--card)); }
        .network-topology-root [class~="bg-emerald-500"] { background-color: var(--topology-relay); }
        .network-topology-root [class~="text-emerald-500"],
        .network-topology-root [class~="text-emerald-600"],
        .network-topology-root [class~="text-emerald-700"],
        .network-topology-root [class~="text-teal-700"] { color: var(--topology-relay); }
        .network-topology-root [class~="border-emerald-100"],
        .network-topology-root [class~="border-emerald-200"],
        .network-topology-root [class~="border-emerald-500/30"],
        .network-topology-root [class~="border-teal-200/80"] { border-color: color-mix(in oklch, var(--topology-relay) 38%, var(--border)); }

        .network-topology-root [class~="bg-indigo-50"],
        .network-topology-root [class~="bg-violet-50"] { background-color: color-mix(in oklch, var(--topology-special) 12%, var(--card)); }
        .network-topology-root [class~="text-indigo-700"],
        .network-topology-root [class~="text-violet-700"] { color: var(--topology-special); }
        .network-topology-root [class~="border-indigo-200/80"],
        .network-topology-root [class~="border-violet-200"],
        .network-topology-root [class~="border-violet-200/80"] { border-color: color-mix(in oklch, var(--topology-special) 38%, var(--border)); }
        .network-topology-root [class~="hover:bg-violet-100"]:hover { background-color: color-mix(in oklch, var(--topology-special) 18%, var(--card)); }

        .network-topology-root [class~="bg-amber-50"],
        .network-topology-root [class~="bg-amber-50/70"],
        .network-topology-root [class~="bg-amber-500/5"] { background-color: color-mix(in oklch, var(--topology-landing) 12%, var(--card)); }
        .network-topology-root [class~="bg-amber-500"] { background-color: var(--topology-landing); }
        .network-topology-root [class~="text-amber-500"],
        .network-topology-root [class~="text-amber-600"],
        .network-topology-root [class~="text-amber-700"],
        .network-topology-root [class~="text-amber-800"] { color: var(--topology-landing); }
        .network-topology-root [class~="border-amber-200"],
        .network-topology-root [class~="border-amber-200/80"],
        .network-topology-root [class~="border-amber-300"],
        .network-topology-root [class~="border-amber-400"],
        .network-topology-root [class~="border-amber-500/30"] { border-color: color-mix(in oklch, var(--topology-landing) 42%, var(--border)); }
        .network-topology-root [class~="hover:bg-amber-100"]:hover { background-color: color-mix(in oklch, var(--topology-landing) 18%, var(--card)); }

        .network-topology-root [class~="bg-red-50"],
        .network-topology-root [class~="bg-red-50/45"] { background-color: color-mix(in oklch, var(--destructive) 12%, var(--card)); }
        .network-topology-root [class~="bg-red-100"],
        .network-topology-root [class~="bg-red-200"] { background-color: color-mix(in oklch, var(--destructive) 20%, var(--card)); }
        .network-topology-root [class~="bg-red-500"] { background-color: var(--destructive); }
        .network-topology-root [class~="bg-red-600/90"] { background-color: color-mix(in oklch, var(--destructive) 90%, transparent); }
        .network-topology-root [class~="text-red-400"],
        .network-topology-root [class~="text-red-600"],
        .network-topology-root [class~="text-red-700"] { color: var(--destructive); }
        .network-topology-root [class~="border-red-200"] { border-color: color-mix(in oklch, var(--destructive) 42%, var(--border)); }
        .network-topology-root [class~="hover:bg-red-100"]:hover { background-color: color-mix(in oklch, var(--destructive) 18%, var(--card)); }
        .no-scrollbar::-webkit-scrollbar { display:none; } .no-scrollbar { scrollbar-width:none; }
      `}</style>
      <header className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">关系总览</h1><p className="text-xs text-muted-foreground sm:text-[13px]">查看节点之间的链路关系、延迟与转发路径，支持列表与拓扑两种视图。</p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["链路总数", paths.length, Layers, "blue"], ["入口节点", entryCount, LogIn, "sky"], ["中转节点", relayCount, Cpu, "emerald"], ["落地节点", landingCount, Flag, "amber"],
        ].map(([label, count, Icon, tone]: any) => <div key={label} className="group flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur-md sm:px-5"><div className="flex items-center gap-3.5"><div className={cn("flex h-11 w-11 items-center justify-center rounded-xl", tone === "blue" && "bg-chart-3/10 text-chart-3", tone === "sky" && "bg-chart-3/10 text-chart-3", tone === "emerald" && "bg-chart-2/10 text-chart-2", tone === "amber" && "bg-chart-4/10 text-chart-4")}><Icon className="h-5 w-5" /></div><div><div className="text-xs font-medium text-muted-foreground">{label}</div><div className="mt-0.5 font-mono text-2xl font-bold leading-none text-foreground">{count}</div></div></div><svg className="h-11 w-24" viewBox="0 0 100 44"><path d="M 2 34 C 18 31, 28 23, 42 26 C 58 29, 66 13, 78 17 C 89 20, 93 9, 98 11" fill="none" stroke="currentColor" strokeWidth="2" className={cn(tone === "blue" && "text-chart-3", tone === "sky" && "text-chart-3", tone === "emerald" && "text-chart-2", tone === "amber" && "text-chart-4")} /></svg></div>)}
      </section>

      <section className="rounded-xl border border-border/60 bg-card/80 p-3 shadow-sm backdrop-blur-md"><div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center"><div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto pb-1 xl:pb-0">{categoryOptions.map((option) => { const active = category === option.value; const visual = routeVisuals[option.value]; return <button key={option.value} type="button" onClick={() => { setCategory(option.value); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); }} className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border px-3 py-1.5 text-xs font-medium transition-all", active ? `${visual.active} shadow-sm` : "border-border/70 bg-card/70 text-foreground hover:bg-accent", !active && visual.text)}>{option.value === "all" ? <LayoutGrid className="h-3.5 w-3.5" /> : <RouteTypeIcon category={option.value} className="h-3.5 w-3.5" />}<span>{option.label}</span><span className={cn("rounded-md px-1.5 py-0.5 font-mono text-[11px] leading-none", active ? "bg-primary-foreground/15 text-primary-foreground" : "bg-muted text-muted-foreground")}>{categoryCounts.get(option.value) || 0}</span></button>; })}</div><div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center"><div className="inline-flex rounded-[10px] border border-border/60 bg-muted/80 p-1"><button onClick={() => setLayoutMode("split")} className={cn("rounded-lg px-2.5 py-1 text-xs font-medium", layoutMode === "split" && "bg-card text-primary shadow-sm")}>总览视图</button><button onClick={() => setLayoutMode("list")} className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium", layoutMode === "list" ? "bg-card text-primary shadow-sm" : "text-muted-foreground")}><List className="h-3.5 w-3.5" />链路列表</button><button onClick={() => setLayoutMode("topo")} className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium", layoutMode === "topo" ? "bg-card text-primary shadow-sm" : "text-muted-foreground")}><Network className="h-3.5 w-3.5" />拓扑视图</button></div><div className="relative sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input value={search} onChange={(event) => { setSearch(event.target.value); setSelectedPathId(null); }} placeholder="搜索链路、节点或 IP..." className="w-full rounded-[10px] border border-input bg-background/70 py-1.5 pl-8 pr-7 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:bg-card" /></div></div></div></section>

      {[rulesQuery, hostsQuery, tunnelsQuery, groupsQuery, landingQuery, fullChainsQuery].some((q) => q.isError) && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-600">部分拓扑数据加载失败，请刷新后重试。</div>}
      {isLoading ? <DataSectionLoading label="正在加载网络拓扑" /> : <>
        {layoutMode !== "topo" && <section className="hidden overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-md md:block"><div className="overflow-x-auto"><div className="min-w-[1000px]"><div className="grid grid-cols-[2.5rem_17rem_minmax(0,1fr)_7.5rem_9rem_7rem] items-center border-b border-slate-200/80 bg-slate-50/80 text-[12px] font-semibold text-slate-500"><div className="py-3 pl-4"><input type="checkbox" checked={visiblePaths.length > 0 && visiblePaths.every(p => checkedPathIds.has(p.id))} onChange={(e) => setCheckedPathIds(e.target.checked ? new Set(visiblePaths.map(p => p.id)) : new Set())} /></div><div className="px-3 py-3">链路名称 / 类型</div><div className="px-3 py-3 text-center">链路路径（入口 → 中转 → 落地）</div><div className="px-3 py-3">状态 / 总延迟</div><div className="px-3 py-3 text-center">流量 (24H)</div><div className="py-3 text-center">操作</div></div><div className="divide-y divide-slate-100">{listRows.map(({ path, entrances }) => { const nodes = [path.entry, ...path.relays, path.landing]; const speedRoute = nodes.map((node, index) => ({ hostId: physicalNodeHostId(node), name: node.label, transport: index === 0 ? "规则入口" : index === nodes.length - 1 ? "落地 SS" : "中转" })).filter(node => node.hostId > 0); const speedEntryHostId = physicalNodeHostId(path.entry); const metric = pathMetrics(path); const rule = path.ruleId ? (rulesQuery.data || []).find((item: any) => Number(item.id) === path.ruleId) as any : null; return <div key={path.id} onClick={() => selectPath(path)} className={cn("grid grid-cols-[2.5rem_17rem_minmax(0,1fr)_7.5rem_9rem_7rem] cursor-pointer items-center transition-colors hover:bg-slate-50/90", (selectedPathId === path.id || entrances.some((entry) => entry.id === selectedPathId)) && "bg-primary/5")}><div className="py-2.5 pl-4"><input type="checkbox" checked={entrances.every((entry) => checkedPathIds.has(entry.id))} onClick={event => event.stopPropagation()} onChange={e => setCheckedPathIds(old => { const next = new Set(old); for (const entry of entrances) e.target.checked ? next.add(entry.id) : next.delete(entry.id); return next; })} /></div><div className="min-w-0 px-3 py-2.5"><div className="flex items-center gap-2"><RouteTypeBadge category={path.category} /><div className="min-w-0"><div className="truncate font-semibold text-slate-900">{path.name}</div><div className="mt-0.5 flex items-center gap-1.5"><span className="font-mono text-[10px] text-slate-400">{topologyPathReference(path, rule?.sourcePort)}</span><RouteTypeLabel category={path.category} /></div></div></div></div><div className="min-w-0 overflow-hidden px-3 py-2.5"><div className="flex w-max min-w-max items-center gap-1.5 whitespace-nowrap">{nodes.map((node, index) => <div key={`${node.id}:${index}`} className="flex shrink-0 items-center gap-1.5">{index === 1 && entrances.length > 1 ? null : index > 0 && (() => { const edge = { id: `${nodes[index - 1].id}=>${node.id}`, from: nodes[index - 1].id, to: node.id }; const latency = pathEdgeMeasurementLabel(path, edge); const waiting = latency === "待探测" || latency === "探测中" || latency === "读取中"; const blockedIncident = latency === "阻断" ? blockIncidentForSegment(automaticEdgeMeasurement(edge, path)) : null; return <span className="flex min-w-[44px] shrink-0 flex-col items-center gap-0.5"><button type="button" disabled={!path.ruleId || latency === "探测中" || edgeSourceOffline(edge)} onMouseEnter={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onMouseLeave={hideBlockTooltip} onFocus={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onBlur={hideBlockTooltip} onClick={(event) => { event.stopPropagation(); void requestSegmentProbe(path, edge); }} title={blockedIncident ? undefined : "点击仅探测此相邻节点间的 RTT"} className={cn("rounded-md border px-1 py-0 font-mono text-[10px] leading-4 transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60", waiting ? "border-amber-300 bg-amber-50 text-amber-700" : (latency === "超时" || latency === "阻断") ? "border-red-200 bg-red-50 text-red-600" : "border-slate-200 bg-white text-slate-500")}>{latency}</button><span className={cn("w-full", (selectedPathId === path.id || entrances.some((entry) => entry.id === selectedPathId)) && latency !== "阻断" && latency !== "离线" ? "topology-list-edge-flow h-[2px]" : waiting ? "h-px border-t border-dashed border-amber-400" : "h-px bg-slate-300")} /></span>; })()}{index === 0 && entrances.length > 1 ? <TopologyEntryBranch entrances={entrances} next={nodes[1]} selectedPathId={selectedPathId} edgeLabel={(entry, edge) => pathEdgeMeasurementLabel(entry, edge)} probeDisabled={(entry, edge, label) => !entry.ruleId || label === "探测中"} onProbe={(entry, edge) => void requestSegmentProbe(entry, edge)} onSelect={selectPath} /> : <button type="button" onClick={(event) => { event.stopPropagation(); copy(node.subtitle || node.label); }} title={`${node.label} · ${node.subtitle || node.detail || "—"}`} className={cn("relative flex w-fit max-w-[180px] shrink-0 items-center gap-1.5 overflow-hidden rounded-lg border px-2 py-1.5 text-left", index === 0 ? "border-blue-100 bg-blue-50/70" : index === nodes.length - 1 ? "border-amber-200 bg-amber-50/70" : "border-emerald-100 bg-emerald-50/70")}><span className="flex h-[18px] w-6 shrink-0 items-center justify-center">{nodeIcon(node)}</span><span className="min-w-0"><span className="block truncate text-[12px] font-semibold text-slate-800">{node.label}</span><span className="block truncate font-mono text-[10px] text-slate-500">{node.subtitle || node.detail || "—"}</span></span>{node.online === false && <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-slate-900/55 text-[11px] font-bold tracking-wide text-white backdrop-blur-[1px]"><span className="rounded-md border border-white/30 bg-red-600/90 px-2 py-0.5 shadow-sm">节点离线</span></span>}</button>}</div>)}</div></div><div className="px-3 py-2.5">{(() => { const probing = !!path.ruleId && probingRuleIds.has(`${path.ruleId}:${physicalNodeHostId(path.entry)}`); const working = path.category === "fullchain" || (topologyEnabledFlag(rule?.isEnabled, true) && !rule?.pendingDelete); const trigger = (event: MouseEvent) => { event.stopPropagation(); if (path.ruleId) void requestPathProbe(path); }; return <div className="flex flex-col items-start gap-1.5"><span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", working ? "text-emerald-600" : "text-red-600")}><i className={cn("h-1.5 w-1.5 rounded-full", working ? "bg-emerald-500" : "bg-red-500")} />{working ? "运行中" : "已停用"}</span>{probing ? <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-blue-600 animate-pulse"><Loader2 className="h-3 w-3 animate-spin" />探测中…</span> : metric?.segmentPending ? <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-700"><Loader2 className="h-3 w-3 animate-spin" />逐跳更新中</span> : metric?.latestLatencyIsTimeout ? <button type="button" onClick={trigger} disabled={!path.ruleId} title="当前端到端 TCP 探测超时；点击重新探测" className="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60">{!metric.latestLatencyIsBlocked && <span className="mr-1 text-[9px] opacity-75">TCP</span>}{metric.latestLatencyIsBlocked ? "阻断" : "超时"}</button> : metric?.latestLatencyMs != null ? <button type="button" onClick={trigger} disabled={!path.ruleId} title="当前为端到端 TCP 延迟；点击重新探测" className="rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 font-mono text-[11px] font-bold text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-60"><span className="mr-1 text-[9px] font-normal opacity-75">TCP</span>{Math.round(metric.latestLatencyMs)} ms</button> : <button type="button" onClick={trigger} disabled={!path.ruleId} title="点击执行端到端 TCP 探测" className="rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60">{ruleLatencyTests.isError ? "读取失败" : ruleLatencyTests.isFetched ? "点击探测" : "读取中"}</button>}{entrances.length > 1 && entrances.map((entrance) => { const entryMetric = metricsForPath(entrance); return <span key={entrance.id} className="text-[10px] text-slate-500">{entrance.entry.label}：{entryMetric?.latestLatencyIsTimeout ? "TCP 超时" : entryMetric?.latestLatencyMs != null ? `TCP ${Math.round(entryMetric.latestLatencyMs)} ms` : ruleLatencyTests.isFetched ? "待探测" : "读取中"}</span>; })}</div>; })()}</div><div className="flex justify-center px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-nowrap"><div className="inline-flex flex-col items-center"><div className="flex items-center justify-center gap-1.5 text-[12px] font-bold text-slate-900"><HardDrive className="h-3.5 w-3.5 text-slate-400" /><span>{metric ? formatTopologyBytes(metric.bytesIn + metric.bytesOut) : "—"}</span></div>{metric ? <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-normal"><span className="font-bold text-emerald-600">↓</span><span className="text-slate-500">{formatTopologyBytes(metric.bytesOut)}</span><span className="text-slate-300">/</span><span className="font-bold text-amber-500">↑</span><span className="text-slate-500">{formatTopologyBytes(metric.bytesIn)}</span></div> : <div className="mt-1 text-slate-400">—</div>}</div></div><div className="flex items-center justify-center py-2.5 whitespace-nowrap"><button type="button" onClick={(event) => { event.stopPropagation(); if (path.ruleId) setQualityTarget({ scope: "rule", id: path.ruleId, name: path.name, subtitle: "规则链路质量历史" }); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50" title="查看链路质量" disabled={!path.ruleId}><Activity className="h-3.5 w-3.5" /></button><button type="button" onClick={(event) => { event.stopPropagation(); openLandingNetworkProfile(path); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50" title={/^host:\d+$/.test(path.landing.id) ? "最终落地机网络画像" : "最终目标不是面板托管 VPS，无法查看网络画像"} disabled={!/^host:\d+$/.test(path.landing.id)}><Earth className="h-3.5 w-3.5" /></button>{path.ruleId && (path.category === "local" || path.category === "chain") && <LinkSpeedTestButton ruleId={path.ruleId} entryHostId={speedEntryHostId} pathId={path.id} name={path.name} route={speedRoute} disabled={speedEntryHostId <= 0 || speedRoute.length < 2} />}</div></div>; })}</div></div></div></section>}

        {layoutMode !== "topo" && <div className="space-y-3 md:hidden">
          {listRows.length === 0 ? <section className="rounded-xl border border-border/60 bg-card/80 px-4 py-12 text-center text-sm text-muted-foreground shadow-sm backdrop-blur-md">当前筛选条件下没有可显示的链路</section> : listRows.map(({ path, entrances }) => {
            const metric = pathMetrics(path);
            const rule = path.ruleId ? (rulesQuery.data || []).find((item: any) => Number(item.id) === path.ruleId) : null;
            return <MobileTopologyPathCard
              key={path.id}
              path={path}
              entrances={entrances}
              metrics={metric}
              rule={rule}
              probing={!!path.ruleId && probingRuleIds.has(`${path.ruleId}:${physicalNodeHostId(path.entry)}`)}
              totalFallback={ruleLatencyTests.isError ? "读取失败" : ruleLatencyTests.isFetched ? "待探测" : "读取中"}
              onProbePath={() => path.ruleId && void requestPathProbe(path)}
              onHistory={() => path.ruleId && setQualityTarget({ scope: "rule", id: path.ruleId, name: path.name, subtitle: "规则链路质量历史" })}
              onNetworkProfile={() => openLandingNetworkProfile(path)}
              edgeLabel={(from, to) => pathEdgeMeasurementLabel(path, { id: `${from.id}=>${to.id}`, from: from.id, to: to.id })}
              entryEdgeLabel={(entry, to) => pathEdgeMeasurementLabel(entry, { id: `${entry.entry.id}=>${to.id}`, from: entry.entry.id, to: to.id })}
              onProbeEdge={(edge) => void requestSegmentProbe(path, edge)}
              onProbeEntryEdge={(entry, edge) => void requestSegmentProbe(entry, edge)}
            />;
          })}
        </div>}
        {layoutMode !== "list" && <section className="overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-md"> <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/40 px-4 py-2.5 text-[11px]"><div className="flex items-center gap-2"><Network className="h-4 w-4 text-primary" /><h2 className="font-bold text-foreground">转发链路实时拓扑图谱</h2><span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-emerald-600">{graph.nodes.filter((node) => node.online === true).length}/{graph.nodes.length} 在线</span></div><div className="flex flex-wrap gap-3 text-muted-foreground"><span>🔵 入口节点</span><span>🟢 中转节点</span><span>🟠 落地节点</span><span>⚪ 离线/备用</span></div><div className="ml-auto flex rounded-lg border border-border bg-muted/50 p-0.5">{(["compact", "standard", "detailed"] as const).map((mode) => <button key={mode} type="button" onClick={() => { setDensity(mode); setNodePathSelection(null); }} className={cn("rounded-md px-2 py-1 text-[11px]", density === mode ? "bg-card font-semibold text-primary shadow-sm" : "text-muted-foreground hover:text-foreground")}>{mode === "compact" ? "紧凑" : mode === "standard" ? "标准" : "详细遥测"}</button>)}</div><div className="flex items-center rounded-lg border border-border bg-card text-foreground"><button type="button" onClick={() => setZoom((value) => clampTopologyZoom(value - .1))} className="px-2 py-1 hover:bg-muted" aria-label="缩小拓扑">−</button><span className="border-x border-border px-2 py-1 font-mono" aria-label="当前缩放比例">{Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom((value) => clampTopologyZoom(value + .1))} className="px-2 py-1 hover:bg-muted" aria-label="放大拓扑">+</button><button type="button" onClick={() => { const canvas = canvasRef.current; if (canvas) setZoom(fitTopologyZoom(canvas.clientWidth, canvas.clientHeight, graph.width, graph.height, window.matchMedia('(max-width: 767px)').matches)); }} className="border-l border-border px-2 py-1 hover:bg-muted" title="适配画布" aria-label="适配画布"><Scan className="h-3.5 w-3.5" /></button></div></div><div ref={canvasRef} onPointerDown={() => setCanvasActivated(true)} onClick={(event) => {
          const target = event.target;
          if (!(target instanceof Element) || target.closest("[data-topology-node], [data-topology-edge]")) return;
          setSelectedPathId(null);
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
          setNodePathSelection(null);
        }} className={cn("topo-grid-bg relative h-[min(70vh,720px)] min-h-[320px] touch-auto p-2", topologyCanvasOverflow(canvasActivated))} aria-label="网络拓扑画布，点击后可用鼠标滚轮滚动画布">
          {selectedPath && <div className="pointer-events-none absolute left-4 top-3 z-20 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground" aria-label="当前选中链路信息">
            <div className="flex min-w-0 flex-wrap items-center gap-1"><span className="mr-1 shrink-0 font-medium">链路路径:</span>{selectedPathNodes.map((node, index) => <span key={`${node.id}:${index}`} className="inline-flex items-center gap-1">{index > 0 && <span className="text-muted-foreground">→</span>}<span className={cn("rounded-md border px-2 py-0.5", index === 0 ? "border-blue-200 bg-blue-50 text-blue-700" : index === selectedPathNodes.length - 1 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>{node.label}</span></span>)}</div>
            <div className="flex shrink-0 items-center gap-2"><span className="font-medium">总延迟:</span><span className={cn("rounded-md border px-2.5 py-1 font-mono font-semibold", selectedPathMetrics?.latestLatencyIsTimeout ? "border-red-200 bg-red-50 text-red-600" : "border-blue-200 bg-blue-50 text-blue-600")}>{selectedPathMetrics?.latestLatencyIsTimeout ? "超时" : selectedPathMetrics?.latestLatencyMs != null ? `${Math.round(selectedPathMetrics.latestLatencyMs)} ms` : ruleLatencyTests.isFetched ? "待探测" : "读取中"}</span></div>
          </div>}
          <div className={selectedPath ? "mt-20 sm:mt-14" : undefined} style={{ width: graph.width * zoom, height: graph.height * zoom, marginLeft: "auto", marginRight: "auto" }}><div className="relative origin-top-left" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}><svg className="absolute inset-0 h-full w-full" width={graph.width} height={graph.height}><defs><marker id="topology-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--primary)" fillOpacity=".48" /></marker><marker id="topology-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--primary)" /></marker><marker id="topology-arrow-blocked" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--destructive)" /></marker><marker id="topology-arrow-offline" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--muted-foreground)" /></marker></defs>{graph.edges.map(edge => { const points = graph.edgeRoutes.get(edge.id); if (!points) return null; const active = highlightedEdges.has(edge.id); const edgePaths = visiblePaths.filter((path) => topologyPathEdgeIds([path.entry, ...path.relays, path.landing].map((node) => node.id)).includes(edge.id)); const sharedCount = graphEdgeCounts.get(edge.id) || 0; const dimmed = focused.count > 0 && !active; const latencyLabel = physicalEdgeMeasurementLabel(edge, edgePaths); const probing = latencyLabel === "探测中"; const blocked = latencyLabel === "阻断"; const offline = latencyLabel === "离线"; const blockedIncident = blocked ? edgePaths.map((path) => blockIncidentForSegment(automaticEdgeMeasurement(edge, path))).find(Boolean) || null : null; const labelPoint = points.length === 4 ? { x: (points[0].x + 3 * points[1].x + 3 * points[2].x + points[3].x) / 8, y: (points[0].y + 3 * points[1].y + 3 * points[2].y + points[3].y) / 8 } : points.length === 6 ? { x: (points[2].x + points[3].x) / 2, y: points[2].y } : { x: (points[0].x + points.at(-1)!.x) / 2, y: (points[0].y + points.at(-1)!.y) / 2 }; const labelX = labelPoint.x; const labelY = labelPoint.y - 8; const labelWidth = Math.max(38, latencyLabel.length * 6 + 14); const countWidth = sharedCount > 1 ? Math.max(22, String(sharedCount).length * 6 + 14) : 0; const pillX = labelX - (labelWidth + (countWidth ? countWidth + 2 : 0)) / 2; return <g key={edge.id} data-topology-edge opacity={dimmed ? .18 : 1} onMouseEnter={() => setHoveredGraphEdgeId(edge.id)} onMouseLeave={() => setHoveredGraphEdgeId(null)}><path d={topologyRoutePath(points)} fill="none" stroke="transparent" strokeWidth="12" style={{ cursor: "pointer", pointerEvents: "stroke" }} onMouseEnter={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onMouseLeave={hideBlockTooltip} onClick={() => { const choice = edgePaths.find((path) => path.id === selectedPath?.id) || (edgePaths.length === 1 ? edgePaths[0] : null); if (choice) { selectPath(choice); setSelectedEdgeId(edge.id); } }} /><path d={topologyRoutePath(points)} fill="none" stroke={offline ? "var(--muted-foreground)" : blocked ? "var(--destructive)" : "var(--primary)"} strokeOpacity={offline || blocked || active ? 1 : .48} strokeWidth={blocked || active ? 2.4 : 1.5} strokeDasharray={offline ? "4 5" : undefined} style={{ pointerEvents: "none" }} markerEnd={`url(#${offline ? "topology-arrow-offline" : blocked ? "topology-arrow-blocked" : active ? "topology-arrow-active" : "topology-arrow"})`} className={(probing || active) && !offline && !blocked ? "edge-flow-active" : ""} /><rect x={pillX} y={labelY - 11} width={labelWidth} height="20" rx="6" fill="var(--card)" fillOpacity=".96" stroke={offline ? "var(--muted-foreground)" : blocked ? "var(--destructive)" : active ? "var(--primary)" : "var(--border)"} strokeOpacity={active ? .45 : 1} style={{ cursor: "pointer" }} onMouseEnter={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onMouseLeave={hideBlockTooltip} onClick={(event) => { event.stopPropagation(); const choice = edgePaths.find((path) => path.id === selectedPath?.id) || (edgePaths.length === 1 ? edgePaths[0] : null); if (choice?.ruleId) void requestSegmentProbe(choice, edge); }}>{!blockedIncident && <title>{sharedCount > 1 ? `共 ${sharedCount} 条路径；点击节点选择路径后可重测此段` : "点击重测此段链路"}</title>}</rect><text pointerEvents="none" x={pillX + labelWidth / 2} y={labelY + 3} textAnchor="middle" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontWeight={offline || blocked || active ? "600" : "500"} fill={offline ? "var(--muted-foreground)" : blocked ? "var(--destructive)" : active ? "var(--primary)" : "var(--muted-foreground)"}>{latencyLabel}</text>{countWidth > 0 && <><rect x={pillX + labelWidth + 2} y={labelY - 9} width={countWidth} height="16" rx="4" fill="var(--primary)" fillOpacity={active ? .95 : .13} pointerEvents="none" /><text pointerEvents="none" x={pillX + labelWidth + 2 + countWidth / 2} y={labelY + 2.5} textAnchor="middle" fontSize="9" fontWeight="700" fill={active ? "var(--primary-foreground)" : "var(--primary)"}>×{sharedCount}</text></>}</g>; })}</svg>{graph.nodes.map(node => { const pos = graph.positions.get(node.id); if (!pos) return null; const active = highlightedNodes.has(node.id); const hostId = physicalNodeHostId(node); const metric = hostMetricsById.get(hostId); const traffic = hostTrafficById.get(hostId); const host = hostById.get(hostId); const inBytes = traffic?.bytesIn; const outBytes = traffic?.bytesOut; const used = host?.trafficMeasureMode === "outbound" ? outBytes : host?.trafficMeasureMode === "max" ? inBytes != null && outBytes != null ? Math.max(inBytes, outBytes) : null : inBytes != null && outBytes != null ? inBytes + outBytes : null; return <div key={node.id} data-topology-node data-topology-node-id={node.id} className="absolute" style={{ left: pos.x, top: pos.y }}><TopologyGraphNodeCard node={node} icon={nodeIcon(node)} width={pos.width} height={pos.height} density={density} telemetry={{ cpu: metric?.cpuUsage, speedIn: metric?.networkSpeedIn, speedOut: metric?.networkSpeedOut, trafficUsed: used, trafficLimit: host?.trafficLimit }} sharedCount={graphNodeCounts.get(node.id) || 0} highlighted={active} selected={selectedNodeId === node.id} dimmed={focused.count > 0 && !active} copied={copied === (node.subtitle || node.label)} onSelect={(element) => selectGraphNode(node, element)} onHover={(hover) => setHoveredGraphNodeId(hover ? node.id : null)} onCopy={() => copy(node.subtitle || node.label)} /></div>; })}</div></div></div></section>}
      </>}
      <section className="overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-md">
        <div className="flex items-center justify-between border-b border-border/40 px-5 py-3.5">
          <div><h2 className="text-sm font-bold text-foreground">拓扑阻断日志</h2><p className="mt-0.5 text-[11px] text-muted-foreground">仅记录持续阻断及恢复事件，相同物理边不会重复刷屏。</p></div>
          <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">最近 {topologyBlockLogs.length} 条</span>
        </div>
        {topologyBlockLogsQuery.isLoading ? <div className="px-5 py-10 text-center text-xs text-slate-400">正在加载阻断日志…</div> : topologyBlockLogs.length === 0 ? <div className="px-5 py-10 text-center text-xs text-slate-400">暂无阻断或恢复记录</div> : <div className="max-h-[28rem] divide-y divide-slate-100 overflow-y-auto">
          {topologyBlockLogs.map((entry) => {
            const failureStartedAt = new Date(entry.failureStartedAt).getTime();
            const recoveredAt = entry.recoveredAt ? new Date(entry.recoveredAt).getTime() : null;
            const blockedAt = new Date(entry.blockedAt).getTime();
            const target = entry.targetAddress && entry.targetAddress !== entry.targetName ? `${entry.targetName}（${entry.targetAddress}）` : entry.targetName;
            const duration = entry.type === "recovered"
              ? (recoveredAt || new Date(entry.occurredAt).getTime()) - failureStartedAt
              : (recoveredAt ? blockedAt : topologyLogNow) - failureStartedAt;
            const message = entry.type === "recovered"
              ? `${entry.sourceName} 探测 ${target} 已恢复，阻断共持续 ${formatTopologyDuration(duration)}${entry.recoveryLatencyMs == null ? "" : `，恢复延迟 ${Math.round(entry.recoveryLatencyMs)} ms`}。`
              : `监测到 ${entry.sourceName} 探测 ${target} 出现阻断，${recoveredAt ? "阻断确认时" : "当前"}已持续 ${formatTopologyDuration(duration)}。`;
            return <div key={entry.id} className={cn("grid gap-2 px-5 py-3 text-xs sm:grid-cols-[10.5rem_minmax(0,1fr)]", entry.type === "blocked" ? "bg-red-50/45" : "bg-emerald-50/45")}>
              <time className={cn("font-mono text-[11px] font-semibold", entry.type === "blocked" ? "text-red-600" : "text-emerald-600")}>{formatTopologyLogTime(entry.occurredAt)}</time>
              <div className={cn("leading-5", entry.type === "blocked" ? "text-red-700" : "text-emerald-700")}><span className={cn("mr-2 inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-bold", entry.type === "blocked" ? "border-red-200 bg-red-100 text-red-700" : "border-emerald-200 bg-emerald-100 text-emerald-700")}>{entry.type === "blocked" ? "阻断" : "恢复"}</span>{message}</div>
            </div>;
          })}
        </div>}
      </section>

      {nodePathSelection && <section ref={nodePathPopupRef} className="absolute z-50 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl" style={{ width: nodePopupWidth, left: nodePopupLeft, top: nodePathSelection.anchor.top, transform: "translate(-50%, -100%)" }}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2"><div className="min-w-0"><h3 className="text-xs font-bold">选择经过此节点的路径 <span className="text-primary">{nodePathCandidates.length}条</span></h3><p className="truncate text-[10px] text-muted-foreground">{graph.nodes.find((node) => node.id === nodePathSelection.nodeId)?.label}</p></div><button type="button" onClick={() => setNodePathSelection(null)} className="rounded px-1 text-muted-foreground hover:text-foreground" aria-label="关闭路径选择">×</button></div>
        <div className="max-h-64 space-y-1 overflow-y-auto p-2">{nodePathCandidates.map((path) => <button type="button" key={path.id} onClick={() => selectPath(path)} className="w-full rounded-lg border border-border bg-muted/30 p-2 text-left hover:border-primary/50 hover:bg-primary/5"><span className="flex items-center justify-between gap-2 text-[11px] font-semibold"><span className="truncate">{path.name}</span><RouteTypeLabel category={path.category} /></span><span className="mt-1 block text-[10px] leading-4 text-muted-foreground">{[path.entry, ...path.relays, path.landing].map((node) => node.label).join(" → ")}</span></button>)}</div>
        <span className="absolute -bottom-[6px] h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-border bg-popover" style={{ left: Math.max(12, Math.min(nodePopupWidth - 12, nodePopupWidth / 2 + nodePathSelection.anchor.left - nodePopupLeft)) }} />
      </section>}
      {blockTooltip && createPortal((() => {
        const incident = blockTooltip.incident;
        const target = incident.targetAddress && incident.targetAddress !== incident.targetName ? `${incident.targetName}（${incident.targetAddress}）` : incident.targetName;
        const duration = topologyLogNow - new Date(incident.failureStartedAt).getTime();
        return <div className="pointer-events-none fixed z-[1000] w-80 rounded-xl border border-destructive/35 bg-popover p-3.5 text-popover-foreground shadow-2xl" style={{ left: blockTooltip.left, top: blockTooltip.top, transform: blockTooltip.above ? "translateY(-100%)" : undefined }}>
          <div className="mb-2 flex items-center justify-between gap-3"><span className="inline-flex rounded-md border border-destructive/35 bg-destructive/10 px-2 py-0.5 text-[11px] font-bold text-destructive">物理链路阻断</span><span className="text-[10px] text-muted-foreground">ICMP Ping</span></div>
          <div className="text-xs font-semibold text-foreground">{incident.sourceName} <span className="px-1 text-destructive">→</span> {target}</div>
          <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] font-semibold leading-5 text-destructive"><span className="font-mono">{formatTopologyLogTime(incident.failureStartedAt)}</span> 开始阻断，已持续 <span className="font-mono">{formatTopologyDuration(duration)}</span>。</div>
          <div className="mt-2 grid grid-cols-[4.5rem_1fr] gap-y-1 text-[10px]"><span className="text-muted-foreground">确认阻断</span><span className="font-mono text-foreground/80">{formatTopologyLogTime(incident.blockedAt)}</span><span className="text-muted-foreground">探测频率</span><span className="text-foreground/80">每 5 秒持续探测，恢复后自动清除</span></div>
        </div>;
      })(), document.body)}
      {probeMessage && <p className="text-xs text-muted-foreground">{probeMessage}</p>}
      <LinkQualityDialog target={qualityTarget} open={!!qualityTarget} onOpenChange={(open) => !open && setQualityTarget(null)} />
      {networkProfileTarget && <HostNetworkProfileDialog hostId={networkProfileTarget.hostId} hostName={networkProfileTarget.hostName} open onOpenChange={(open) => !open && setNetworkProfileTarget(null)} />}
    </div>
  );
}

export default function NetworkTopologyPage() {
  return (
    <DashboardLayout>
      <NetworkTopologyContent />
    </DashboardLayout>
  );
}
