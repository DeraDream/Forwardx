import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { topologyPathEdgeIds } from "./networkTopologyPaths";
import { parseLinkTestMessage } from "@/components/LinkTestLatencySummary";
import { topologyRuleHref } from "./topologyRuleLink";
import { activeTopologySegmentProbeIds, latestAutomaticTopologySegment, mergeTopologySegmentProbeResults, summarizePhysicalTopologySegmentLabels, summarizeTopologySegmentLabels, topologySegmentProbeKey, type AutomaticTopologySegment, type TopologySegmentProbe } from "./topologySegmentProbeState";
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

export function buildGraph(paths: PhysicalPath[]) {
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
  assignTopologyBranchRows(columns, edges, rootIds, directOnlySinkIds);

  // The relationship overview is a layered physical graph: shared HK→SG and
  // HK→JP legs are represented once, while the router reserves lanes around
  // cards so a dense connection bends rather than crossing a node.
  const routed = routeSmoothLayeredTopologyGraph(positionedNodes, edges, directOnlySinkIds);
  return { nodes: positionedNodes, edges, ...routed };
}

export function buildOverviewGraph(paths: PhysicalPath[]) {
  const chainPaths = paths.filter((path) => path.relays.length > 0);
  const chainNodeIds = new Set(chainPaths.flatMap((path) =>
    [path.entry, ...path.relays, path.landing].map((node) => node.id)));
  const standalone = paths.filter((path) => path.relays.length === 0
    && ![path.entry.id, path.landing.id].some((id) => chainNodeIds.has(id)));
  const connected = paths.filter((path) => !standalone.includes(path));
  if (!standalone.length) return buildGraph(connected);
  if (!connected.length) return buildGraph(standalone);
  const direct = buildGraph(standalone);
  const chain = buildGraph(connected);
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

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-4 py-1"><span className="shrink-0 text-muted-foreground">{label}</span><div className="text-right text-foreground">{children}</div></div>;
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "slate" }) {
  return <div className="rounded-2xl border border-border/60 bg-muted/35 p-4"><div className="text-muted-foreground">{label}</div><b className={cn("mt-2 block font-mono text-sm", tone === "emerald" ? "text-chart-2" : tone === "amber" ? "text-chart-4" : "text-foreground")}>{value}</b></div>;
}

function MobileTopologyPathCard({
  path,
  entrances,
  metrics,
  rule,
  probing,
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
  const latency = metrics?.segmentPending
    ? "探测中"
    : metrics?.latestLatencyIsTimeout
      ? metrics.latestLatencyIsBlocked ? "阻断" : "超时"
      : metrics?.latestLatencyMs != null ? `${Math.round(metrics.latestLatencyMs)} ms` : "待探测";
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
          <button type="button" onClick={onProbePath} disabled={!path.ruleId || probing} className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-60", !working || metrics?.latestLatencyIsTimeout ? "border-destructive/35 bg-destructive/10 text-destructive" : "border-chart-2/30 bg-chart-2/10 text-chart-2")}>
            {probing ? <Loader2 className="h-3 w-3 animate-spin" /> : <i className={cn("h-1.5 w-1.5 rounded-full", !working || metrics?.latestLatencyIsTimeout ? "bg-destructive" : "bg-chart-2")} />}
            {!working ? "已停用" : probing ? "探测中" : metrics?.latestLatencyIsTimeout ? latency : "运行中"}
          </button>
        </div>

        <div className="mt-3 overflow-hidden rounded-xl bg-muted/35 text-center">
          <div className="grid grid-cols-3 gap-2 p-3">
            <div><div className="text-[10px] text-muted-foreground">端到端</div><div className={cn("mt-1 font-mono text-xs font-bold", metrics?.latestLatencyIsTimeout ? "text-destructive" : "text-chart-3")}>{latency}</div></div>
            <div><div className="text-[10px] text-muted-foreground">实时下载</div><div className="mt-1 whitespace-nowrap font-mono text-xs font-bold text-chart-2">↓ {metrics ? `${formatTopologyBytes(metrics.bytesOutPerSecond)}/s` : "—"}</div></div>
            <div><div className="text-[10px] text-muted-foreground">实时上传</div><div className="mt-1 whitespace-nowrap font-mono text-xs font-bold text-chart-4">↑ {metrics ? `${formatTopologyBytes(metrics.bytesInPerSecond)}/s` : "—"}</div></div>
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
                <button type="button" disabled={!entry.ruleId || probing} onClick={() => onProbeEntryEdge(entry, edge)} className="shrink-0 font-mono text-blue-700">{entryEdgeLabel(entry, to)} →</button>
              </div>;
            })}
            <p className="text-center text-[10px] text-muted-foreground">共同汇入 {nodes[1]?.label}</p>
          </div>}
          {nodes.slice(entrances.length > 1 ? 1 : 0).map((node, offset) => {
            const index = offset + (entrances.length > 1 ? 1 : 0);
            const previous = index > 0 && !(index === 1 && entrances.length > 1) ? nodes[index - 1] : null;
            const segmentLabel = previous ? edgeLabel(previous, node) : "";
            const edge = previous ? { id: `${previous.id}=>${node.id}`, from: previous.id, to: node.id } : null;
            const waiting = segmentLabel === "待探测" || segmentLabel === "探测中";
            const segmentProbing = segmentLabel === "探测中";
            const failed = segmentLabel === "超时" || segmentLabel === "阻断" || segmentLabel === "离线";
            const role = index === 0 ? "入口" : index === nodes.length - 1 ? "落地 SS" : "中转";
            return <div key={`${path.id}:${node.id}:${index}`}>
              {previous && edge && (
                <div className="relative flex h-12 items-center justify-center">
                  <span className={cn("absolute inset-y-0 left-1/2 w-px -translate-x-1/2", failed ? "bg-destructive/30" : waiting ? "border-l border-dashed border-chart-4/50" : "bg-border")} />
                  <button type="button" disabled={!path.ruleId || segmentProbing || probing || previous.online === false} onClick={() => onProbeEdge(edge)} className={cn("relative rounded-md border bg-card px-2 py-0.5 font-mono text-[10px] font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-70", failed ? "border-destructive/35 text-destructive" : waiting ? "border-chart-4/35 text-chart-4" : "border-border text-muted-foreground")}>
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
  // A physical edge can be shared by multiple logical routes. Do not silently
  // pick whichever route happens to be first in the latest query response.
  const [sharedEdgeSelection, setSharedEdgeSelection] = useState<{ edgeId: string; pathIds: string[]; probe?: boolean; anchor?: { left: number; top: number; above: boolean } } | null>(null);
  const sharedEdgePopupRef = useRef<HTMLElement | null>(null);
  const [probingRuleIds, setProbingRuleIds] = useState<Set<number>>(() => new Set());
  const probingStartedAtRef = useRef(new Map<number, number>());
  const probingBaselineAtRef = useRef(new Map<number, number>());
  // Each logical path edge owns a stable local snapshot. Polling a new job must
  // never clear completed results for unrelated edges.
  const [segmentProbes, setSegmentProbes] = useState<Record<string, TopologySegmentProbe>>({});
  const [initialSegmentRefreshes, setInitialSegmentRefreshes] = useState<Record<number, number>>({});
  const initialSegmentRefreshRequestedRef = useRef(new Set<number>());
  const segmentProbeLocksRef = useRef(new Set<string>());
  const selectedRuleId = Number(/^rule:(\d+)(?::|$)/.exec(selectedPathId || "")?.[1] || 0);
  // Start with the complete network; operators can narrow the graph to one entry VPS.
  const [entryFilter, setEntryFilter] = useState<string | null>("all");
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [layoutMode, setLayoutMode] = useState<"split" | "list" | "topo">("split");
  const [qualityTarget, setQualityTarget] = useState<LinkQualityTarget | null>(null);
  const [networkProfileTarget, setNetworkProfileTarget] = useState<{ hostId: number; hostName: string } | null>(null);
  const [detailTab, setDetailTab] = useState<"basic" | "performance" | "history">("basic");
  const [checkedPathIds, setCheckedPathIds] = useState<Set<string>>(() => new Set());
  const [probeMessage, setProbeMessage] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [blockTooltip, setBlockTooltip] = useState<{ incident: TopologyBlockLog; left: number; top: number; above: boolean } | null>(null);
  const blockTooltipTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!sharedEdgeSelection) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !sharedEdgePopupRef.current?.contains(target)) setSharedEdgeSelection(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSharedEdgeSelection(null);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [sharedEdgeSelection]);
  const startRuleLatencyTest = trpc.rules.startSelfTest.useMutation();
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
  const automaticSegmentQuery = trpc.diagnostics.latestSegments.useQuery(
    { ruleIds: topologyRuleIds },
    { enabled: topologyRuleIds.length > 0, refetchInterval: pollingInterval("fast"), refetchIntervalInBackground: true, staleTime: 1_000, refetchOnWindowFocus: true, placeholderData: (previousData) => previousData },
  );
  const automaticSegments = (automaticSegmentQuery.data || []) as AutomaticTopologySegment[];
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
  // Keep the last completed legacy result while a newer sample is pending.
  // A fresh page has no cache and correctly shows "待探测" until its first result.
  const completedLatencyTestsRef = useRef(new Map<number, TopologyRuleTest>());
  const ruleLatencyTests = trpc.rules.latestTests.useQuery(
    { ruleIds: topologyRuleIds, includeActive: true },
    { enabled: topologyRuleIds.length > 0, refetchInterval: pollingInterval("active"), staleTime: 0, refetchOnWindowFocus: false },
  );
  // Path IDs include a variant suffix (for example rule:12:0); querying by
  // string slicing produced NaN and made the real history panel look empty.
  const selectedPathHistoryQuery = trpc.rules.tcpingSeries.useQuery(
    { ruleId: selectedRuleId, hours: 24 },
    { enabled: selectedRuleId > 0, refetchInterval: pollingInterval("slow"), refetchOnWindowFocus: false },
  );
  // Topology is observational by default. Full-route tests are started only
  // from the total-latency control; individual edges use diagnostic jobs below.
  const testByRule = useMemo(() => new Map((ruleLatencyTests.data || []).map((row: any) => {
    const ruleId = Number(row.ruleId);
    const candidate: TopologyRuleTest = {
      parsed: parseLinkTestMessage(row.test?.message),
      recordedAt: new Date(row.test?.updatedAt || row.test?.createdAt || 0).getTime(),
      status: String(row.test?.status || "pending"),
      latencyMs: typeof row.test?.latencyMs === "number" ? row.test.latencyMs : null,
    };
    const completed = candidate.parsed.details.length > 0 || ["success", "failed", "timeout"].includes(candidate.status);
    if (completed) completedLatencyTestsRef.current.set(ruleId, candidate);
    return [ruleId, completed ? candidate : completedLatencyTestsRef.current.get(ruleId) || candidate];
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
        for (const ruleId of current) {
          const startedAt = probingStartedAtRef.current.get(ruleId) || 0;
          const test = testByRule.get(ruleId);
          const baselineAt = probingBaselineAtRef.current.get(ruleId) || 0;
          const terminal = !!test && ["success", "failed", "timeout"].includes(test.status) && test.recordedAt > baselineAt;
          if (terminal || now - startedAt >= 60_000) {
            next.delete(ruleId);
            probingStartedAtRef.current.delete(ruleId);
            probingBaselineAtRef.current.delete(ruleId);
          }
        }
        return next.size === current.size ? current : next;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [testByRule, probingRuleIds.size]);
  const trafficRateQuery = trpc.rules.trafficRateBatch.useQuery(
    { ruleIds: rateRuleIds },
    {
      enabled: rateRuleIds.length > 0,
      // While topology is open the existing Agent reporter is requested at 1s.
      // Match the topology Agent reporter's 500ms interactive interval.
      refetchInterval: 500,
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
  );
  const trafficByRule = useMemo(() => {
    const metrics = new Map<number, TopologyPathMetrics>();
    topologyRuleIds.forEach((ruleId) => metrics.set(ruleId, {
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
  }, [topologyRuleIds, trafficQuery.data, trafficRateQuery.data]);

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
  const graph = useMemo(() => buildOverviewGraph(overviewPaths), [overviewPaths]);
  const topologyAgentPairs = useMemo(() => graph.edges.flatMap((edge) => {
    const sourceHostId = Number(edge.from.replace(/^host:/, ""));
    const targetHostId = Number(edge.to.replace(/^host:/, ""));
    return sourceHostId > 0 && targetHostId > 0 ? [{ sourceHostId, targetHostId }] : [];
  }), [graph.edges]);
  const topologyAgentEdgesQuery = trpc.agentLinks.topologyEdges.useQuery(
    { pairs: topologyAgentPairs.length ? topologyAgentPairs : [{ sourceHostId: 1, targetHostId: 2 }] },
    { enabled: topologyAgentPairs.length > 0, refetchInterval: pollingInterval("normal"), refetchOnWindowFocus: false },
  );
  const topologyAgentEdges = (topologyAgentEdgesQuery.data || []) as Array<any>;
  const topologyAgentLatestQuery = trpc.agentLinks.latest.useQuery(
    { edges: topologyAgentEdges.length ? topologyAgentEdges : [{ sourceHostId: 1, targetHostId: 2, targetAddress: "placeholder.invalid", targetPort: 1, transport: "tcp" }] },
    { enabled: topologyAgentEdges.length > 0, refetchInterval: pollingInterval("fast"), refetchOnWindowFocus: false },
  );
  const topologyAgentLatestByPair = useMemo(() => {
    const result = new Map<string, any>();
    for (const sample of topologyAgentLatestQuery.data || []) {
      const key = `${Number((sample as any).sourceHostId)}:${Number((sample as any).targetHostId)}`;
      const previous = result.get(key);
      // TCP preserves the established topology latency meaning; use UDP only
      // when no TCP Agent Link sample exists for this exact physical pair.
      if (!previous
        || ((sample as any).transport === "tcp" && previous.transport !== "tcp")
        || ((sample as any).transport === previous.transport
          && new Date((sample as any).recordedAt || 0).getTime() > new Date(previous.recordedAt || 0).getTime())) result.set(key, sample);
    }
    return result;
  }, [topologyAgentLatestQuery.data]);
  const canvasWidth = graph.width;
  const canvasHeight = graph.height;
  const selectedPath = visiblePaths.find((path) => path.id === selectedPathId) || null;
  const selectedRule = selectedPath?.id.startsWith("rule:")
    ? (rulesQuery.data || []).find((rule: any) => Number(rule.id) === Number(selectedPath.id.split(":")[1])) as any
    : null;
  const highlightedNodes = new Set(selectedPath ? [selectedPath.entry, ...selectedPath.relays, selectedPath.landing].map((node) => node.id) : []);
  const highlightedEdges = new Set(selectedPath ? topologyPathEdgeIds([selectedPath.entry, ...selectedPath.relays, selectedPath.landing].map((node) => node.id)) : []);
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
  const automaticSegmentFresh = (segment: AutomaticTopologySegment) => Date.now() - new Date(segment.recordedAt || 0).getTime() <= 30_000;
  const agentLinkEdgeMeasurement = (edge: TopologyEdge) => {
    const sourceHostId = Number(edge.from.replace(/^host:/, ""));
    const targetHostId = Number(edge.to.replace(/^host:/, ""));
    const sample = topologyAgentLatestByPair.get(`${sourceHostId}:${targetHostId}`);
    if (!sample || Date.now() - new Date(sample.recordedAt || 0).getTime() > 90_000) return null;
    const successes = Number(sample.probeSuccesses || 0);
    // Agent Link's first failed sample is not a confirmed outage. Let the
    // topology's sustained-failure state machine decide when to show blocked.
    if (successes <= 0 || sample.latencyMs == null) return null;
    return {
      at: new Date(sample.recordedAt || 0).getTime(),
      pending: false,
      success: successes > 0 && sample.latencyMs !== null && sample.latencyMs !== undefined,
      label: successes > 0 && sample.latencyMs !== null && sample.latencyMs !== undefined ? `${Math.round(Number(sample.latencyMs))} ms` : "超时",
    };
  };
  const edgeLockedByPathProbe = (edge: TopologyEdge) => paths.some((candidate) => (
    !!candidate.ruleId && probingRuleIds.has(candidate.ruleId)
    && topologyPathEdgeIds([candidate.entry, ...candidate.relays, candidate.landing].map((node) => node.id)).includes(edge.id)
  ));
  // A graph edge is one physical leg even when several logical rules reuse it.
  // Show the freshest physical measurement instead of presenting it as several paths.
  const physicalEdgeMeasurementLabel = (edge: TopologyEdge, edgePaths: PhysicalPath[], includePending = true) => {
    if (edgeSourceOffline(edge)) return "离线";
    const candidates = [
      ...(agentLinkEdgeMeasurement(edge) ? [agentLinkEdgeMeasurement(edge)!] : []),
      ...(includePending ? edgePaths.filter((path) => !!path.ruleId && probingRuleIds.has(path.ruleId)).map((path) => ({
        at: probingStartedAtRef.current.get(Number(path.ruleId)) || Date.now(),
        pending: true,
        success: false,
        label: "探测中",
      })) : []),
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
      ...edgePaths.map((path) => automaticEdgeMeasurement(edge, path)).filter((segment): segment is AutomaticTopologySegment => !!segment && automaticSegmentFresh(segment)).map((segment) => ({
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
      automaticSegmentQuery.isLoading || topologyAgentLatestQuery.isLoading ? "加载中" : "待探测");
    if ((label === "待探测" || label === "待复测") && edgePaths.some((path) => !!path.ruleId && !!initialSegmentRefreshes[path.ruleId])) return "探测中";
    return label === "待复测" ? "待探测" : label;
  };
  const pathEdgeMeasurementLabel = (path: PhysicalPath, edge: TopologyEdge) => {
    if (edgeSourceOffline(edge)) return "离线";
    if (path.ruleId && probingRuleIds.has(path.ruleId)) return "探测中";
    const ownProbe = segmentProbeFor(path, edge);
    if (ownProbe && ["pending", "running"].includes(ownProbe.status)) return "探测中";
    const edgePaths = paths.filter((candidate) => topologyPathEdgeIds([candidate.entry, ...candidate.relays, candidate.landing].map((node) => node.id)).includes(edge.id));
    const measured = physicalEdgeMeasurementLabel(edge, edgePaths, false);
    if ((measured === "待探测" || measured === "待复测") && path.ruleId && initialSegmentRefreshes[path.ruleId]) return "探测中";
    if (measured === "待探测" && (automaticSegmentQuery.isLoading || topologyAgentLatestQuery.isLoading)) return "加载中";
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
    if (!ruleId || edgeLockedByPathProbe(edge) || !Number.isSafeInteger(fromHostId) || fromHostId <= 0 || !targetAddress || segmentProbeLocksRef.current.has(key) || ["pending", "running"].includes(String(current?.status || ""))) return;
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
  const requestPathProbe = async (ruleId: number) => {
    if (ruleId <= 0) return;
    if (probingRuleIds.has(ruleId)) {
      setProbeMessage("该链路正在探测中，请等待本轮端到端 TCP 结果返回。");
      return;
    }
    const startedAt = Date.now();
    probingStartedAtRef.current.set(ruleId, startedAt);
    probingBaselineAtRef.current.set(ruleId, testByRule.get(ruleId)?.recordedAt || 0);
    setProbingRuleIds((current) => new Set(current).add(ruleId));
    setProbeMessage("正在执行端到端 TCP 探测并刷新逐跳 Ping…");
    try {
      await startRuleLatencyTest.mutateAsync({ ruleId });
      // The total uses the rule's forwarded TCP path. Segment refresh remains
      // ICMP so every displayed hop keeps the shared physical-edge measurement model.
      void refreshPathSegments.mutateAsync({ ruleId }).catch(() => undefined);
      setProbeMessage("探测任务已下发，正在等待端到端 TCP 与逐跳 Ping 结果…");
      void ruleLatencyTests.refetch();
      void automaticSegmentQuery.refetch();
    } catch (error) {
      probingStartedAtRef.current.delete(ruleId);
      probingBaselineAtRef.current.delete(ruleId);
      setProbingRuleIds((current) => { const next = new Set(current); next.delete(ruleId); return next; });
      setProbeMessage(`链路探测失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // When the first snapshot has no usable result, actually request a fresh
  // Agent measurement before showing a probing state. Never dispatch a rule
  // self-test merely because the user opened the observational topology.
  useEffect(() => {
    if (!automaticSegmentQuery.isFetched || rulesQuery.isLoading || hostsQuery.isLoading) return;
    const candidates = new Map<number, PhysicalPath[]>();
    for (const path of paths) {
      if (!path.ruleId || path.category === "fullchain") continue;
      candidates.set(path.ruleId, [...(candidates.get(path.ruleId) || []), path]);
    }
    for (const [ruleId, variants] of candidates) {
      if (initialSegmentRefreshRequestedRef.current.has(ruleId)) continue;
      initialSegmentRefreshRequestedRef.current.add(ruleId);
      const needsRefresh = variants.some((path) => {
        const nodes = [path.entry, ...path.relays, path.landing];
        return nodes.slice(1).some((node, index) => {
          const edge = { id: `${nodes[index].id}=>${node.id}`, from: nodes[index].id, to: node.id };
          const sample = automaticEdgeMeasurement(edge, path);
          return !agentLinkEdgeMeasurement(edge) && (!sample || !automaticSegmentFresh(sample) || sample.latencyMs == null);
        });
      });
      if (!needsRefresh) continue;
      const startedAt = Date.now();
      setInitialSegmentRefreshes((current) => ({ ...current, [ruleId]: startedAt }));
      void refreshPathSegments.mutateAsync({ ruleId }).then((result) => {
        if (result.requested > 0) return;
        setInitialSegmentRefreshes((current) => { const next = { ...current }; delete next[ruleId]; return next; });
      }).catch(() => {
        setInitialSegmentRefreshes((current) => { const next = { ...current }; delete next[ruleId]; return next; });
      });
    }
  }, [automaticSegmentQuery.isFetched, automaticSegments, paths, rulesQuery.isLoading, hostsQuery.isLoading]);

  useEffect(() => {
    if (!Object.keys(initialSegmentRefreshes).length) return;
    const timer = window.setInterval(() => setInitialSegmentRefreshes((current) => {
      let changed = false;
      const next = { ...current };
      for (const [key, startedAt] of Object.entries(current)) {
        const ruleId = Number(key);
        const variants = paths.filter((path) => path.ruleId === ruleId);
        const complete = variants.every((path) => {
          const nodes = [path.entry, ...path.relays, path.landing];
          return nodes.slice(1).every((node, index) => {
            const edge = { id: `${nodes[index].id}=>${node.id}`, from: nodes[index].id, to: node.id };
            const sample = automaticEdgeMeasurement(edge, path);
            const agentSample = agentLinkEdgeMeasurement(edge);
            return (sample && new Date(sample.recordedAt || 0).getTime() >= startedAt - 1_000)
              || (agentSample && agentSample.at >= startedAt - 1_000);
          });
        });
        if (complete || Date.now() - startedAt >= 45_000) { delete next[ruleId]; changed = true; }
      }
      return changed ? next : current;
    }), 1_000);
    return () => window.clearInterval(timer);
  }, [automaticSegments, initialSegmentRefreshes, paths, topologyAgentLatestByPair]);

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
    const nextZoom = mobileGraph
      ? Math.min(1, Math.max(0.65, width / canvasWidth))
      : Math.min(1, width / canvasWidth, canvas.clientHeight / canvasHeight);
    setZoom(nextZoom);
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
  const pathSegmentSummary = (path: PhysicalPath) => {
    const nodes = [path.entry, ...path.relays, path.landing];
    const labels = nodes.slice(1).map((node, index) => pathEdgeMeasurementLabel(path, {
      id: `${nodes[index].id}=>${node.id}`,
      from: nodes[index].id,
      to: node.id,
    }));
    return summarizeTopologySegmentLabels(labels);
  };
  const metricsForPath = (path: PhysicalPath) => {
    const base = path.ruleId ? trafficByRule.get(path.ruleId) : undefined;
    if (!base) return undefined;
    const segment = pathSegmentSummary(path);
    const test = testByRule.get(Number(path.ruleId || 0));
    if (segment.pending) {
      const previous = typeof test?.parsed.totalLatencyMs === "number" ? test.parsed.totalLatencyMs
        : test?.status === "success" && typeof test.latencyMs === "number" ? test.latencyMs
        : !base.latestLatencyIsTimeout ? base.latestLatencyMs : null;
      return { ...base, latestLatencyMs: previous, latestLatencyIsTimeout: false, latestLatencyIsBlocked: false, segmentPending: true };
    }
    // A transient ICMP miss must not erase a completed rule measurement. A
    // confirmed blocked edge still takes precedence over any older total.
    if (segment.blocked) return { ...base, latestLatencyMs: null, latestLatencyIsTimeout: true, latestLatencyIsBlocked: true, segmentPending: false };
    const total = typeof test?.parsed.totalLatencyMs === "number"
      ? test.parsed.totalLatencyMs
      : typeof test?.latencyMs === "number" ? test.latencyMs : null;
    if (test && ["failed", "timeout"].includes(test.status)) return { ...base, latestLatencyMs: null, latestLatencyIsTimeout: true, latestLatencyIsBlocked: false, segmentPending: false };
    if (total !== null) return { ...base, latestLatencyMs: total, latestLatencyIsTimeout: false, latestLatencyIsBlocked: false, segmentPending: false };
    if (segment.timeout) return { ...base, latestLatencyMs: null, latestLatencyIsTimeout: true, latestLatencyIsBlocked: false, segmentPending: false };
    if (segment.latencyMs !== null) return { ...base, latestLatencyMs: segment.latencyMs, latestLatencyIsTimeout: false, latestLatencyIsBlocked: false, segmentPending: false };
    return { ...base, latestLatencyMs: base.latestLatencyMs, latestLatencyIsTimeout: base.latestLatencyIsTimeout, latestLatencyIsBlocked: false, segmentPending: false };
  };
  const selectedPathMetrics = selectedPath?.ruleId ? metricsForPath(selectedPath) : undefined;
  const selectedPathNodes = selectedPath ? [selectedPath.entry, ...selectedPath.relays, selectedPath.landing] : [];
  const selectedPathHistorySamples = (selectedPathHistoryQuery.data || []) as Array<{ latencyMs: number | null; isTimeout?: boolean; probeCount?: number; probeSuccesses?: number; recordedAt: Date | string }>;
  const selectedPathHistory = selectedPathHistorySamples.filter((sample) => sample.isTimeout !== true && typeof sample.latencyMs === "number" && Number.isFinite(sample.latencyMs));
  const selectedHistoryValues = selectedPathHistory.map((sample) => Number(sample.latencyMs));
  const selectedProbeCounts = selectedPathHistorySamples.reduce((total, sample) => {
    const count = Number(sample.probeCount);
    const successes = Number(sample.probeSuccesses);
    const probeCount = Number.isInteger(count) && count > 0 ? count : 1;
    const probeSuccesses = Number.isInteger(successes) ? Math.max(0, Math.min(probeCount, successes)) : (sample.isTimeout || sample.latencyMs == null ? 0 : probeCount);
    return { count: total.count + probeCount, successes: total.successes + probeSuccesses };
  }, { count: 0, successes: 0 });
  const selectedPacketLoss = selectedProbeCounts.count > 0
    ? (selectedProbeCounts.count - selectedProbeCounts.successes) / selectedProbeCounts.count * 100
    : null;
  const selectedJitter = selectedHistoryValues.length > 1
    ? selectedHistoryValues.slice(1).reduce((total, value, index) => total + Math.abs(value - selectedHistoryValues[index]), 0) / (selectedHistoryValues.length - 1)
    : null;
  const selectedHistoryPolyline = useMemo(() => {
    if (selectedHistoryValues.length < 2) return "";
    const min = Math.min(...selectedHistoryValues); const max = Math.max(...selectedHistoryValues); const spread = Math.max(1, max - min);
    return selectedHistoryValues.map((value, index) => `${(index / (selectedHistoryValues.length - 1)) * 100},${42 - ((value - min) / spread) * 34}`).join(" ");
  }, [selectedHistoryValues.join(",")]);

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(value);
    window.setTimeout(() => setCopied((current) => current === value ? null : current), 1400);
  };
  const pathMetrics = (path: PhysicalPath) => metricsForPath(path);
  const selectPath = (path: PhysicalPath) => { setSelectedPathId(path.id); setSelectedNodeId(null); setSelectedEdgeId(null); setSharedEdgeSelection(null); };
  const graphPopupAnchor = (event: MouseEvent<SVGElement>, point: { x: number; y: number }) => {
    const svgBounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    const rootBounds = canvasRef.current?.closest(".network-topology-root")?.getBoundingClientRect();
    const viewportX = svgBounds ? svgBounds.left + point.x * (svgBounds.width / graph.width) : event.clientX;
    const viewportY = svgBounds ? svgBounds.top + point.y * (svgBounds.height / graph.height) : event.clientY;
    const anchorX = viewportX - (rootBounds?.left || 0);
    const anchorY = viewportY - (rootBounds?.top || 0);
    const width = Math.min(440, (rootBounds?.width || window.innerWidth) - 32);
    return {
      left: Math.max(width / 2 + 16, Math.min(anchorX, (rootBounds?.width || window.innerWidth) - width / 2 - 16)),
      top: anchorY,
      above: true,
    };
  };
  const selectGraphEdge = (edge: TopologyEdge, probe = false, anchor?: { left: number; top: number; above: boolean }) => {
    const candidates = visiblePaths.filter((path) => topologyPathEdgeIds([path.entry, ...path.relays, path.landing].map((node) => node.id)).includes(edge.id));
    if (probe && candidates.some((path) => !!path.ruleId && probingRuleIds.has(path.ruleId))) {
      setProbeMessage("该物理链路正在随端到端任务探测中，请等待当前结果返回。");
      return;
    }
    const current = selectedPath && candidates.find((path) => path.id === selectedPath.id);
    const path = current || (candidates.length === 1 ? candidates[0] : null);
    if (path) {
      selectPath(path);
      setSelectedEdgeId(edge.id);
      if (probe && path.ruleId) void requestSegmentProbe(path, edge);
      return;
    }
    setSharedEdgeSelection({ edgeId: edge.id, pathIds: candidates.map((path) => path.id), probe, anchor });
  };
  const openLandingNetworkProfile = (path: PhysicalPath) => {
    const match = /^host:(\d+)$/.exec(path.landing.id);
    const hostId = Number(match?.[1] || 0);
    if (hostId > 0) setNetworkProfileTarget({ hostId, hostName: path.landing.label });
  };
  const sharedEdgeCandidates = sharedEdgeSelection
    ? visiblePaths.filter((path) => sharedEdgeSelection.pathIds.includes(path.id))
    : [];

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
        {layoutMode !== "topo" && <section className="hidden overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-md md:block"><div className="overflow-x-auto"><div className="min-w-[1000px]"><div className="grid grid-cols-[2.5rem_17rem_minmax(0,1fr)_7.5rem_8rem_9rem_7rem] items-center border-b border-slate-200/80 bg-slate-50/80 text-[12px] font-semibold text-slate-500"><div className="py-3 pl-4"><input type="checkbox" checked={visiblePaths.length > 0 && visiblePaths.every(p => checkedPathIds.has(p.id))} onChange={(e) => setCheckedPathIds(e.target.checked ? new Set(visiblePaths.map(p => p.id)) : new Set())} /></div><div className="px-3 py-3">链路名称 / 类型</div><div className="px-3 py-3 text-center">链路路径（入口 → 中转 → 落地）</div><div className="px-3 py-3">状态 / 总延迟</div><div className="px-3 py-3">实时速率</div><div className="px-3 py-3 text-center">流量 (24H)</div><div className="py-3 text-center">操作</div></div><div className="divide-y divide-slate-100">{listRows.map(({ path, entrances }) => { const nodes = [path.entry, ...path.relays, path.landing]; const speedRoute = nodes.map((node, index) => ({ hostId: physicalNodeHostId(node), name: node.label, transport: index === 0 ? "规则入口" : index === nodes.length - 1 ? "落地 SS" : "中转" })).filter(node => node.hostId > 0); const speedEntryHostId = physicalNodeHostId(path.entry); const metric = pathMetrics(path); const rule = path.ruleId ? (rulesQuery.data || []).find((item: any) => Number(item.id) === path.ruleId) as any : null; return <div key={path.id} onClick={() => { if (layoutMode === "split") selectPath(path); }} className={cn("grid grid-cols-[2.5rem_17rem_minmax(0,1fr)_7.5rem_8rem_9rem_7rem] items-center transition-colors hover:bg-slate-50/90", layoutMode === "split" && "cursor-pointer", selectedPathId === path.id && "bg-primary/5")}><div className="py-2.5 pl-4"><input type="checkbox" checked={entrances.every((entry) => checkedPathIds.has(entry.id))} onClick={event => event.stopPropagation()} onChange={e => setCheckedPathIds(old => { const next = new Set(old); for (const entry of entrances) e.target.checked ? next.add(entry.id) : next.delete(entry.id); return next; })} /></div><div className="min-w-0 px-3 py-2.5"><div className="flex items-center gap-2"><RouteTypeBadge category={path.category} /><div className="min-w-0"><div className="truncate font-semibold text-slate-900">{path.name}</div><div className="mt-0.5 flex items-center gap-1.5"><span className="font-mono text-[10px] text-slate-400">{topologyPathReference(path, rule?.sourcePort)}</span><RouteTypeLabel category={path.category} /></div></div></div></div><div className="min-w-0 overflow-hidden px-3 py-2.5"><div className="flex w-max min-w-max items-center gap-1.5 whitespace-nowrap">{nodes.map((node, index) => <div key={`${node.id}:${index}`} className="flex shrink-0 items-center gap-1.5">{index === 1 && entrances.length > 1 ? <span className="shrink-0 px-1 text-primary">→</span> : index > 0 && (() => { const edge = { id: `${nodes[index - 1].id}=>${node.id}`, from: nodes[index - 1].id, to: node.id }; const latency = pathEdgeMeasurementLabel(path, edge); const waiting = latency === "待探测" || latency === "探测中" || latency === "加载中"; const probeLocked = edgeLockedByPathProbe(edge); const blockedIncident = latency === "阻断" ? blockIncidentForSegment(automaticEdgeMeasurement(edge, path)) : null; return <span className="flex min-w-[44px] shrink-0 flex-col items-center gap-0.5"><button type="button" disabled={!path.ruleId || latency === "探测中" || probeLocked || edgeSourceOffline(edge)} onMouseEnter={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onMouseLeave={hideBlockTooltip} onFocus={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onBlur={hideBlockTooltip} onClick={(event) => { event.stopPropagation(); void requestSegmentProbe(path, edge); }} title={blockedIncident ? undefined : "点击仅探测此相邻节点间的 RTT"} className={cn("rounded-md border px-1 py-0 font-mono text-[10px] leading-4 transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60", waiting ? "border-amber-300 bg-amber-50 text-amber-700" : (latency === "超时" || latency === "阻断") ? "border-red-200 bg-red-50 text-red-600" : "border-slate-200 bg-white text-slate-500")}>{latency}</button><span className={cn("h-px w-full", waiting ? "border-t border-dashed border-amber-400" : "bg-slate-300")} /></span>; })()}{index === 0 && entrances.length > 1 ? <div className="flex flex-col gap-2">{entrances.map((entrance) => { const edge = { id: `${entrance.entry.id}=>${nodes[1].id}`, from: entrance.entry.id, to: nodes[1].id }; const latency = pathEdgeMeasurementLabel(entrance, edge); return <div key={entrance.id} className="flex items-center gap-2"><span className="flex max-w-[180px] items-center gap-1 rounded-lg border border-blue-100 bg-blue-50/70 px-2 py-1.5 text-xs font-semibold text-slate-800"><span>{nodeIcon(entrance.entry)}</span><span className="truncate">{entrance.entry.label}</span></span><button type="button" disabled={!entrance.ruleId || latency === "探测中" || edgeLockedByPathProbe(edge)} onClick={(event) => { event.stopPropagation(); void requestSegmentProbe(entrance, edge); }} title="点击探测此入口到下一节点" className="min-w-[48px] rounded border border-slate-200 px-1 text-center font-mono text-[10px] text-slate-600">{latency} →</button></div>; })}</div> : <button type="button" onClick={(event) => { event.stopPropagation(); copy(node.subtitle || node.label); }} title={`${node.label} · ${node.subtitle || node.detail || "—"}`} className={cn("relative flex w-fit max-w-[180px] shrink-0 items-center gap-1.5 overflow-hidden rounded-lg border px-2 py-1.5 text-left", index === 0 ? "border-blue-100 bg-blue-50/70" : index === nodes.length - 1 ? "border-amber-200 bg-amber-50/70" : "border-emerald-100 bg-emerald-50/70")}><span className="flex h-[18px] w-6 shrink-0 items-center justify-center">{nodeIcon(node)}</span><span className="min-w-0"><span className="block truncate text-[12px] font-semibold text-slate-800">{node.label}</span><span className="block truncate font-mono text-[10px] text-slate-500">{node.subtitle || node.detail || "—"}</span></span>{node.online === false && <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-slate-900/55 text-[11px] font-bold tracking-wide text-white backdrop-blur-[1px]"><span className="rounded-md border border-white/30 bg-red-600/90 px-2 py-0.5 shadow-sm">节点离线</span></span>}</button>}</div>)}</div></div><div className="px-3 py-2.5">{(() => { const probing = !!path.ruleId && probingRuleIds.has(path.ruleId); const working = path.category === "fullchain" || (topologyEnabledFlag(rule?.isEnabled, true) && !rule?.pendingDelete); const trigger = (event: MouseEvent) => { event.stopPropagation(); if (path.ruleId) void requestPathProbe(path.ruleId); }; return <div className="flex flex-col items-start gap-1.5"><span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", working ? "text-emerald-600" : "text-red-600")}><i className={cn("h-1.5 w-1.5 rounded-full", working ? "bg-emerald-500" : "bg-red-500")} />{working ? "运行中" : "已停用"}</span>{probing ? <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-blue-600 animate-pulse"><Loader2 className="h-3 w-3 animate-spin" />探测中…</span> : metric?.segmentPending ? <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-700"><Loader2 className="h-3 w-3 animate-spin" />逐跳更新中</span> : metric?.latestLatencyIsTimeout ? <button type="button" onClick={trigger} disabled={!path.ruleId} title={metric.latestLatencyIsBlocked ? "逐跳 Ping 已确认阻断；点击执行端到端 TCP 探测并同步刷新逐跳 Ping" : "当前端到端 TCP 探测超时；点击重新探测并同步刷新逐跳 Ping"} className="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60">{!metric.latestLatencyIsBlocked && <span className="mr-1 text-[9px] opacity-75">TCP</span>}{metric.latestLatencyIsBlocked ? "阻断" : "超时"}</button> : metric?.latestLatencyMs != null ? <button type="button" onClick={trigger} disabled={!path.ruleId} title="当前为端到端 TCP 延迟；点击重新探测并同步刷新逐跳 Ping" className="rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 font-mono text-[11px] font-bold text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-60"><span className="mr-1 text-[9px] font-normal opacity-75">TCP</span>{Math.round(metric.latestLatencyMs)} ms</button> : <button type="button" onClick={trigger} disabled={!path.ruleId} title="点击执行端到端 TCP 探测并同步刷新逐跳 Ping" className="rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60">点击探测</button>}{entrances.length > 1 && entrances.map((entrance) => { const summary = pathSegmentSummary(entrance); return <span key={entrance.id} className="text-[10px] text-slate-500">{entrance.entry.label}：{summary.latencyMs === null ? summary.pending ? "探测中" : summary.timeout ? "超时" : "待探测" : `${summary.latencyMs} ms（逐段估算）`}</span>; })}</div>; })()}</div><div className="px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-nowrap"><div className="flex items-center gap-1.5"><span className="font-bold text-emerald-600">↓</span><span className="font-medium text-slate-800">{metric ? `${formatTopologyBytes(metric.bytesOutPerSecond)}/s` : "—"}</span></div><div className="mt-1 flex items-center gap-1.5"><span className="font-bold text-amber-500">↑</span><span className="font-medium text-slate-600">{metric ? `${formatTopologyBytes(metric.bytesInPerSecond)}/s` : "—"}</span></div></div><div className="flex justify-center px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-nowrap"><div className="inline-flex flex-col items-center"><div className="flex items-center justify-center gap-1.5 text-[12px] font-bold text-slate-900"><HardDrive className="h-3.5 w-3.5 text-slate-400" /><span>{metric ? formatTopologyBytes(metric.bytesIn + metric.bytesOut) : "—"}</span></div>{metric ? <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-normal"><span className="font-bold text-emerald-600">↓</span><span className="text-slate-500">{formatTopologyBytes(metric.bytesOut)}</span><span className="text-slate-300">/</span><span className="font-bold text-amber-500">↑</span><span className="text-slate-500">{formatTopologyBytes(metric.bytesIn)}</span></div> : <div className="mt-1 text-slate-400">—</div>}</div></div><div className="flex items-center justify-center py-2.5 whitespace-nowrap"><button type="button" onClick={(event) => { event.stopPropagation(); if (path.ruleId) setQualityTarget({ scope: "rule", id: path.ruleId, name: path.name, subtitle: "规则链路质量历史" }); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50" title="查看链路质量" disabled={!path.ruleId}><Activity className="h-3.5 w-3.5" /></button><button type="button" onClick={(event) => { event.stopPropagation(); openLandingNetworkProfile(path); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50" title={/^host:\d+$/.test(path.landing.id) ? "最终落地机网络画像" : "最终目标不是面板托管 VPS，无法查看网络画像"} disabled={!/^host:\d+$/.test(path.landing.id)}><Earth className="h-3.5 w-3.5" /></button>{path.ruleId && (path.category === "local" || path.category === "chain") && <LinkSpeedTestButton ruleId={path.ruleId} entryHostId={speedEntryHostId} pathId={path.id} name={path.name} route={speedRoute} disabled={speedEntryHostId <= 0 || speedRoute.length < 2} />}</div></div>; })}</div></div></div></section>}

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
              probing={!!path.ruleId && probingRuleIds.has(path.ruleId)}
              onProbePath={() => path.ruleId && void requestPathProbe(path.ruleId)}
              onHistory={() => path.ruleId && setQualityTarget({ scope: "rule", id: path.ruleId, name: path.name, subtitle: "规则链路质量历史" })}
              onNetworkProfile={() => openLandingNetworkProfile(path)}
              edgeLabel={(from, to) => pathEdgeMeasurementLabel(path, { id: `${from.id}=>${to.id}`, from: from.id, to: to.id })}
              entryEdgeLabel={(entry, to) => pathEdgeMeasurementLabel(entry, { id: `${entry.entry.id}=>${to.id}`, from: entry.entry.id, to: to.id })}
              onProbeEdge={(edge) => void requestSegmentProbe(path, edge)}
              onProbeEntryEdge={(entry, edge) => void requestSegmentProbe(entry, edge)}
            />;
          })}
        </div>}
        {layoutMode !== "list" && <section className="overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-md"> <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/40 px-4 py-3"><div className="flex flex-wrap items-center gap-4"><h2 className="text-sm font-bold text-foreground">链路拓扑</h2><div className="flex gap-3.5 text-xs text-muted-foreground"><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-chart-3" />入口节点</span><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-chart-2" />中转节点</span><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-chart-4" />落地节点</span></div></div><div className="flex items-center gap-1.5"><button onClick={() => setZoom(1)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500"><Scan className="h-3.5 w-3.5" /></button><button onClick={() => setZoom(z => Math.max(.2, z - .1))} className="rounded-l-lg border border-slate-200 px-2 py-1">−</button><span className="border-y border-slate-200 px-2 py-1 font-mono text-[11px]">{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(z => Math.min(1.5, z + .1))} className="rounded-r-lg border border-slate-200 px-2 py-1">+</button></div></div><div ref={canvasRef} className="topo-grid-bg relative h-[340px] min-h-[280px] max-h-[48vh] touch-auto overflow-auto overscroll-contain p-2 md:h-auto md:max-h-none md:min-h-[430px]"><div style={{ width: graph.width * zoom, height: graph.height * zoom, margin: "auto" }}><div className="relative origin-top-left" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}><svg className="absolute inset-0 h-full w-full" width={graph.width} height={graph.height}><defs><marker id="topology-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--primary)" fillOpacity=".48" /></marker><marker id="topology-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--primary)" /></marker><marker id="topology-arrow-blocked" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--destructive)" /></marker><marker id="topology-arrow-offline" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--muted-foreground)" /></marker></defs>{graph.edges.map(edge => { const points = graph.edgeRoutes.get(edge.id); if (!points) return null; const active = highlightedEdges.has(edge.id) || selectedEdgeId === edge.id; const edgePaths = visiblePaths.filter((path) => topologyPathEdgeIds([path.entry, ...path.relays, path.landing].map((node) => node.id)).includes(edge.id)); const latencyLabel = physicalEdgeMeasurementLabel(edge, edgePaths); const blocked = latencyLabel === "阻断"; const offline = latencyLabel === "离线"; const blockedIncident = blocked ? edgePaths.map((path) => blockIncidentForSegment(automaticEdgeMeasurement(edge, path))).find(Boolean) || null : null; const labelPoint = points.length === 4 ? { x: (points[0].x + 3 * points[1].x + 3 * points[2].x + points[3].x) / 8, y: (points[0].y + 3 * points[1].y + 3 * points[2].y + points[3].y) / 8 } : points.length === 7 ? { x: (points[3].x + 3 * points[4].x + 3 * points[5].x + points[6].x) / 8, y: (points[3].y + 3 * points[4].y + 3 * points[5].y + points[6].y) / 8 } : { x: (points[0].x + points.at(-1)!.x) / 2, y: (points[0].y + points.at(-1)!.y) / 2 }; const labelX = labelPoint.x; const labelY = labelPoint.y - 8; const labelWidth = Math.max(38, latencyLabel.length * 6 + 14); return <g key={edge.id}><path d={topologyRoutePath(points)} fill="none" stroke="transparent" strokeWidth="12" style={{ cursor: "pointer", pointerEvents: "stroke" }} onMouseEnter={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onMouseLeave={hideBlockTooltip} onClick={(event) => selectGraphEdge(edge, false, graphPopupAnchor(event, { x: labelX, y: labelY }))} /><path d={topologyRoutePath(points)} fill="none" stroke={offline ? "var(--muted-foreground)" : blocked ? "var(--destructive)" : "var(--primary)"} strokeOpacity={offline || blocked || active ? 1 : .48} strokeWidth={blocked || active ? 2.4 : 1.5} strokeDasharray={offline ? "4 5" : undefined} style={{ pointerEvents: "none" }} markerEnd={`url(#${offline ? "topology-arrow-offline" : blocked ? "topology-arrow-blocked" : active ? "topology-arrow-active" : "topology-arrow"})`} className={active && !offline ? "edge-flow-active" : ""} /><rect x={labelX - labelWidth / 2} y={labelY - 11} width={labelWidth} height="20" rx="6" fill="var(--card)" fillOpacity=".96" stroke={offline ? "var(--muted-foreground)" : blocked ? "var(--destructive)" : active ? "var(--primary)" : "var(--border)"} strokeOpacity={active ? .45 : 1} style={{ cursor: "pointer" }} onMouseEnter={(event) => showBlockTooltip(event.currentTarget, blockedIncident)} onMouseLeave={hideBlockTooltip} onClick={(event) => { event.stopPropagation(); selectGraphEdge(edge, true, graphPopupAnchor(event, { x: labelX, y: labelY })); }}>{!blockedIncident && <title>点击立即重测此逻辑链路</title>}</rect><text pointerEvents="none" x={labelX} y={labelY + 3} textAnchor="middle" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontWeight={offline || blocked || active ? "600" : "500"} fill={offline ? "var(--muted-foreground)" : blocked ? "var(--destructive)" : active ? "var(--primary)" : "var(--muted-foreground)"}>{latencyLabel}</text></g>; })}</svg>{graph.nodes.map(node => { const pos = graph.positions.get(node.id); if (!pos) return null; const role = node.kind; const active = highlightedNodes.has(node.id) || selectedNodeId === node.id; return <button key={node.id} onClick={() => { setSelectedNodeId(node.id); setSelectedPathId(null); setSelectedEdgeId(null); }} style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }} className={cn("absolute flex items-center gap-2.5 overflow-hidden rounded-[10px] border px-3 py-2 text-left shadow-sm", role === "entry" ? "border-chart-3/30 bg-chart-3/10" : role === "relay" ? "border-chart-2/30 bg-chart-2/10" : "border-chart-4/30 bg-chart-4/10", active && "ring-2 ring-primary/30")}><span className="flex h-[18px] w-6 shrink-0 items-center justify-center">{nodeIcon(node)}</span><span className="min-w-0"><span className="flex items-center gap-1 text-xs font-bold text-foreground"><span className="truncate">{node.label}</span><i className={cn("ml-auto h-2 w-2 rounded-full", node.online === false ? "bg-destructive" : node.online === true ? "bg-chart-2" : "bg-muted-foreground/40")} /></span><span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{node.subtitle || node.detail || "—"}</span></span>{node.online === false && <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-slate-900/55 text-xs font-bold tracking-wide text-white backdrop-blur-[1px]"><span className="rounded-md border border-white/30 bg-red-600/90 px-2.5 py-1 shadow-sm">节点离线</span></span>}</button>; })}</div></div></div></section>}
      </>}
      {layoutMode !== "list" && selectedPath && <section className="overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-sm backdrop-blur-md">
        <div className="flex items-center justify-between border-b border-border/40 px-5 py-3.5"><h3 className="text-sm font-bold text-foreground">链路详情: <span>{selectedPath.name}</span></h3><span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium", selectedPathMetrics?.latestLatencyIsTimeout ? "border-red-200 bg-red-50 text-red-600" : "border-emerald-200 bg-emerald-50 text-emerald-600")}><i className={cn("h-1.5 w-1.5 rounded-full", selectedPathMetrics?.latestLatencyIsTimeout ? "bg-red-500" : "bg-emerald-500")} />{selectedPathMetrics?.latestLatencyIsTimeout ? "超时" : "运行中"}</span></div>
        <div className="flex gap-2 border-b border-border/40 px-5 pb-2 pt-3">{([ ["basic", "基本信息"], ["performance", "性能指标"], ["history", "历史趋势"] ] as const).map(([key, label]) => <button key={key} type="button" onClick={() => setDetailTab(key)} className={cn("rounded-lg px-3 py-1.5 text-xs", detailTab === key ? "border border-primary/30 bg-primary/10 font-semibold text-primary" : "font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground")}>{label}</button>)}</div>
        <div className="p-5">
          {detailTab === "basic" && <div className="space-y-4 text-xs"><DetailRow label="链路名称"><b className="text-slate-900">{selectedPath.name}</b><span className="ml-2 font-mono text-slate-400">{selectedPath.id}</span></DetailRow><DetailRow label="链路类型"><span className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600">{categoryLabel(selectedPath.category)}</span></DetailRow><DetailRow label="链路路径"><div className="flex flex-wrap justify-end gap-1">{selectedPathNodes.map((node, i) => <span key={`${node.id}:${i}`} className="inline-flex items-center gap-1">{i > 0 && <span className="text-slate-400">→</span>}<span className={cn("rounded-md border px-2 py-0.5", i === 0 ? "border-blue-200 bg-blue-50 text-blue-700" : i === selectedPathNodes.length - 1 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>{node.label}</span></span>)}</div></DetailRow><DetailRow label="节点数量"><b>{selectedPathNodes.length}</b></DetailRow><DetailRow label="24H 流量"><span className="font-mono"><span>{selectedPathMetrics ? formatTopologyBytes(selectedPathMetrics.bytesOut) : "—"}</span><b className="ml-1 text-emerald-600">↓</b><span className="mx-2 text-slate-300">/</span><span>{selectedPathMetrics ? formatTopologyBytes(selectedPathMetrics.bytesIn) : "—"}</span><b className="ml-1 text-amber-500">↑</b></span></DetailRow><DetailRow label="端到端 TCP"><span className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 font-mono font-semibold text-blue-600">{selectedPathMetrics?.latestLatencyMs != null ? `${Math.round(selectedPathMetrics.latestLatencyMs)} ms` : "待探测"}</span></DetailRow><DetailRow label="创建时间"><span className="font-mono text-slate-600">{selectedRule?.createdAt ? new Date(selectedRule.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span></DetailRow></div>}
          {detailTab === "performance" && <div className="space-y-5 text-xs"><div className="grid gap-3 sm:grid-cols-2"><MetricCard label="实时下行吞吐" value={`↓ ${selectedPathMetrics ? `${formatTopologyBytes(selectedPathMetrics.bytesOutPerSecond)}/s` : "—"}`} tone="emerald" /><MetricCard label="实时上行吞吐" value={`↑ ${selectedPathMetrics ? `${formatTopologyBytes(selectedPathMetrics.bytesInPerSecond)}/s` : "—"}`} tone="amber" /></div><div className="grid gap-3 sm:grid-cols-2"><MetricCard label="24H 丢包率" value={selectedPacketLoss == null ? "暂无记录" : `${selectedPacketLoss.toFixed(1)}%`} tone="slate" /><MetricCard label="网络抖动 (Jitter)" value={selectedJitter == null ? "暂无记录" : `${selectedJitter.toFixed(1)} ms`} tone="slate" /></div><div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"><h4 className="mb-3 font-bold text-slate-700">单跳 RTT 耗时分布</h4>{selectedPathNodes.slice(1).map((node, index, hops) => { const label = pathEdgeMeasurementLabel(selectedPath, { id: `${selectedPathNodes[index].id}=>${node.id}`, from: selectedPathNodes[index].id, to: node.id }); const latency = Number.parseFloat(label); const maxLatency = Math.max(...hops.map((hop, hopIndex) => Number.parseFloat(pathEdgeMeasurementLabel(selectedPath, { id: `${selectedPathNodes[hopIndex].id}=>${hop.id}`, from: selectedPathNodes[hopIndex].id, to: hop.id })) || 0), 1); const width = Number.isFinite(latency) ? `${Math.max(6, latency / maxLatency * 100)}%` : "0%"; return <div key={`${node.id}:${index}`} className="mb-3 last:mb-0"><div className="mb-1.5 flex justify-between text-slate-500"><span>第 {index + 1} 跳 ({selectedPathNodes[index].label} → {node.label})</span><b className="font-mono text-blue-600">{label}</b></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className={cn("h-full rounded-full", index === 0 ? "bg-blue-500" : "bg-emerald-500")} style={{ width }} /></div></div>; })}</div><button type="button" disabled={!selectedPath.ruleId || startRuleLatencyTest.isPending || probingRuleIds.has(selectedPath.ruleId)} onClick={() => selectedPath.ruleId && void requestPathProbe(selectedPath.ruleId)} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"><Activity className="h-4 w-4" />立即执行端到端 TCP 探测</button></div>}
          {detailTab === "history" && <div className="text-xs"><div className="mb-5 flex justify-between text-slate-500"><span>最近 24 小时往返延迟曲线 (ms)</span><b className="font-mono text-blue-600">当前端到端 TCP {selectedPathMetrics?.latestLatencyMs != null ? `${Math.round(selectedPathMetrics.latestLatencyMs)} ms` : "—"}</b></div><div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">{selectedPathHistoryQuery.isLoading ? <div className="py-16 text-center text-slate-400">正在加载真实历史延迟…</div> : selectedHistoryPolyline ? <><svg viewBox="0 0 100 48" preserveAspectRatio="none" className="h-40 w-full"><defs><linearGradient id="topology-history-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--primary)" stopOpacity=".22" /><stop offset="1" stopColor="var(--primary)" stopOpacity="0" /></linearGradient></defs><polyline points={`0,48 ${selectedHistoryPolyline} 100,48`} fill="url(#topology-history-area)" stroke="none" /><polyline points={selectedHistoryPolyline} fill="none" stroke="var(--primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg><div className="mt-2 flex justify-between font-mono text-[10px] text-slate-400"><span>24H 前</span><span>现在</span></div></> : <div className="py-16 text-center text-slate-400">当前路径暂无真实历史延迟记录。</div>}</div><div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 text-slate-600">历史趋势来自规则真实 TCPing 记录；未检测到的数据不会使用模拟值补全。</div></div>}
        </div>
      </section>}

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

      {sharedEdgeSelection && <section ref={sharedEdgePopupRef} className="absolute z-50 w-[min(27.5rem,calc(100vw-2rem))] max-h-[18rem] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl" style={{ left: sharedEdgeSelection.anchor?.left ?? "50%", top: sharedEdgeSelection.anchor ? sharedEdgeSelection.anchor.above ? sharedEdgeSelection.anchor.top - 10 : sharedEdgeSelection.anchor.top + 10 : "50%", transform: sharedEdgeSelection.anchor ? sharedEdgeSelection.anchor.above ? "translate(-50%, -100%)" : "translateX(-50%)" : "translate(-50%, -50%)" }}><div className="flex items-start justify-between gap-3"><div><h3 className="text-[13px] font-bold text-foreground">选择经过此共享链路的路径</h3><p className="mt-1 text-[11px] text-muted-foreground">该物理链路被 {sharedEdgeCandidates.length} 条逻辑链路共用，请选择完整路径。</p></div><button type="button" onClick={() => setSharedEdgeSelection(null)} className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground">取消</button></div><div className="mt-3 space-y-1.5">{sharedEdgeCandidates.map((path) => { const nodes = [path.entry, ...path.relays, path.landing]; return <button type="button" key={path.id} onClick={() => { selectPath(path); setSelectedEdgeId(sharedEdgeSelection.edgeId); if (sharedEdgeSelection.probe && path.ruleId) { const [from, to] = sharedEdgeSelection.edgeId.split("=>"); void requestSegmentProbe(path, { id: sharedEdgeSelection.edgeId, from, to }); } }} className="w-full rounded-lg border border-border bg-muted/35 p-2.5 text-left transition hover:border-primary/40 hover:bg-primary/5"><div className="mb-1.5 flex items-center justify-between gap-3"><b className="truncate text-xs text-foreground">{path.name}</b><RouteTypeLabel category={path.category} /></div><div className="flex flex-wrap items-center gap-1 text-[10px]">{nodes.map((node, index) => <span key={`${node.id}:${index}`} className="inline-flex items-center gap-1">{index > 0 && <span className="text-slate-400">→</span>}<span className={cn("rounded border px-1.5 py-0.5", index === 0 ? "border-blue-200 bg-blue-50 text-blue-700" : index === nodes.length - 1 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>{node.label}</span></span>)}</div></button>; })}</div></section>}
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
