import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { topologyPathEdgeIds } from "./networkTopologyPaths";
import { parseLinkTestMessage } from "@/components/LinkTestLatencySummary";
import { topologyRuleHref } from "./topologyRuleLink";
import { activeTopologySegmentProbeIds, latestAutomaticTopologySegment, mergeTopologySegmentProbeResults, summarizePhysicalTopologySegmentLabels, summarizeTopologySegmentLabels, topologySegmentProbeKey, type AutomaticTopologySegment, type TopologySegmentProbe } from "./topologySegmentProbeState";
import { improveTopologyOrder } from "./topologyLayout";
import { routeSmoothLayeredTopologyGraph, topologyRoutePath } from "./topologyRouting";
import { topologyEnabledFlag, visibleTopologyTunnelVariants } from "./topologyTunnelVariants";
import { combineTopologyHostVariants, joinTopologyHostPaths, MAX_TOPOLOGY_VARIANTS, type TopologyExpansionState } from "./topologyExpansion";
import {
  Activity,
  ArrowRight,
  BarChart2,
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

const categoryOptions: Array<{ value: TopologyCategory; label: string }> = [
  { value: "all", label: "全部" },
  { value: "local", label: "端口转发" },
  { value: "tunnel", label: "隧道" },
  { value: "chain", label: "转发链" },
  { value: "group", label: "转发组" },
  { value: "fullchain", label: "全链路" },
];

type RouteVisualType = Exclude<TopologyCategory, "all">;
const routeVisuals: Record<TopologyCategory, { bg: string; border: string; text: string; active: string; badge: string }> = {
  all: { bg: "bg-[#EFF6FF]", border: "border-[#DBEAFE]", text: "text-[#2563EB]", active: "bg-[#2563EB] border-[#2563EB] text-white", badge: "bg-blue-50 border-blue-200/80 text-blue-700" },
  local: { bg: "bg-[#EFF6FF]", border: "border-[#DBEAFE]", text: "text-[#2563EB]", active: "bg-[#2563EB] border-[#2563EB] text-white", badge: "bg-blue-50 border-blue-200/80 text-blue-700" },
  tunnel: { bg: "bg-[#EEF2FF]", border: "border-[#E0E7FF]", text: "text-[#4F46E5]", active: "bg-[#4F46E5] border-[#4F46E5] text-white", badge: "bg-indigo-50 border-indigo-200/80 text-indigo-700" },
  chain: { bg: "bg-[#F0FDFA]", border: "border-[#CCFBF1]", text: "text-[#0D9488]", active: "bg-[#0D9488] border-[#0D9488] text-white", badge: "bg-teal-50 border-teal-200/80 text-teal-700" },
  group: { bg: "bg-[#FFFBEB]", border: "border-[#FEF3C7]", text: "text-[#D97706]", active: "bg-[#D97706] border-[#D97706] text-white", badge: "bg-amber-50 border-amber-200/80 text-amber-800" },
  fullchain: { bg: "bg-[#F5F3FF]", border: "border-[#EDE9FE]", text: "text-[#7C3AED]", active: "bg-[#7C3AED] border-[#7C3AED] text-white", badge: "bg-violet-50 border-violet-200/80 text-violet-700" },
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
        };
      }
      return {
        id: "landing:" + Number(landing.id),
        kind: "landing",
        label: String(landing.name || "落地 SS #" + landing.id),
        subtitle: String(landing.endpoint || landing.targetIp || ""),
        detail: landing.port ? "外部 SS · " + String(landing.port) : "外部 SS",
        online: null,
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
      };
    }

    return {
      id: "target:" + targetIp + ":" + targetPort,
      kind: "landing",
      label: targetIp,
      subtitle: targetPort > 0 ? String(targetPort) : "",
      detail: "最终目标",
      online: null,
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
        };
        const haystack = [chain?.name, entry.label, entry.subtitle, ...relays.flatMap((node) => [node.label, node.subtitle]), landing.label, landing.subtitle].join(" ").toLowerCase();
        if (query && !haystack.includes(query)) return;
        paths.push({ id: pathId, name: String(chain?.name || "全链路 #" + chain.id), category: "fullchain", entry, relays, landing });
      });
    }
  }

  return { paths, ...state };
}

// This filter belongs only to the relationship overview. The per-rule link
// view must continue to show every configured direct forward.
export function relationshipOverviewPaths(paths: PhysicalPath[]) {
  const entriesWithRelayChains = new Set(paths.filter((path) => path.relays.length > 0).map((path) => path.entry.id));
  return paths.filter((path) => path.relays.length > 0 || entriesWithRelayChains.has(path.entry.id));
}

function buildGraph(paths: PhysicalPath[]) {
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

  // 直达落地：目标只由入口直接连接，完全没有经过中转。
  // 这类落地单独排到落地列下方，避免长连线横穿中转节点。
  const directOnlySinkIds = new Set(
    Array.from(sinkIds).filter((sinkId) => {
      const parents = incoming.get(sinkId) || [];
      return parents.length > 0 && parents.every((parentId) => rootIds.has(parentId));
    }),
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

  // 最长依赖路径决定中间层级，确保边始终从左向右。
  for (let pass = 0; pass < Math.max(1, classifiedNodes.length); pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const nextDepth = Math.min(10, (depth.get(edge.from) || 0) + 1);
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

  // 先根据上游重心排序，再做反向一遍参考下游重心，减少交叉线。
  const rowHint = new Map<string, number>();
  const sortedColumns = Array.from(columns.keys()).sort((a, b) => a - b);
  for (const column of sortedColumns) {
    const list = columns.get(column) || [];
    list.sort((a, b) => {
      if (column === 0) return a.label.localeCompare(b.label, "zh-CN");
      if (column === landingColumn) {
        const aDirect = directOnlySinkIds.has(a.id) ? 1 : 0;
        const bDirect = directOnlySinkIds.has(b.id) ? 1 : 0;
        if (aDirect !== bDirect) return aDirect - bDirect;
      }
      const aParents = incoming.get(a.id) || [];
      const bParents = incoming.get(b.id) || [];
      const aHint = aParents.length
        ? aParents.reduce((sum, id) => sum + (rowHint.get(id) || 0), 0) / aParents.length
        : Number.POSITIVE_INFINITY;
      const bHint = bParents.length
        ? bParents.reduce((sum, id) => sum + (rowHint.get(id) || 0), 0) / bParents.length
        : Number.POSITIVE_INFINITY;
      if (aHint !== bHint) return aHint - bHint;
      return a.label.localeCompare(b.label, "zh-CN");
    });
    list.forEach((node, row) => {
      node.row = row;
      rowHint.set(node.id, row);
    });
  }

  for (const column of [...sortedColumns].reverse()) {
    if (column === 0 || column === landingColumn) continue;
    const list = columns.get(column) || [];
    list.sort((a, b) => {
      const aChildren = outgoing.get(a.id) || [];
      const bChildren = outgoing.get(b.id) || [];
      const aHint = aChildren.length
        ? aChildren.reduce((sum, id) => sum + (rowHint.get(id) || 0), 0) / aChildren.length
        : Number.POSITIVE_INFINITY;
      const bHint = bChildren.length
        ? bChildren.reduce((sum, id) => sum + (rowHint.get(id) || 0), 0) / bChildren.length
        : Number.POSITIVE_INFINITY;
      if (aHint !== bHint) return aHint - bHint;
      return a.label.localeCompare(b.label, "zh-CN");
    });
    list.forEach((node, row) => {
      node.row = row;
      rowHint.set(node.id, row);
    });
  }

  improveTopologyOrder(columns, edges, directOnlySinkIds);

  // The relationship overview is a layered physical graph: shared HK→SG and
  // HK→JP legs are represented once, while the router reserves lanes around
  // cards so a dense connection bends rather than crossing a node.
  const routed = routeSmoothLayeredTopologyGraph(positionedNodes, edges, directOnlySinkIds);
  return { nodes: positionedNodes, edges, ...routed };
}

function nodeIcon(kind: PhysicalNodeKind) {
  if (kind === "entry") return <Waypoints className="h-3.5 w-3.5" />;
  if (kind === "relay") return <Server className="h-3.5 w-3.5" />;
  return <Route className="h-3.5 w-3.5" />;
}

function nodeTone(node: PhysicalNode) {
  if (node.kind === "entry") return "border-border/55 bg-card/90";
  if (node.kind === "relay") {
    return node.online === false
      ? "border-destructive/35 bg-destructive/5"
      : "border-emerald-500/30 bg-emerald-500/5";
  }
  return node.online === false
    ? "border-destructive/35 bg-destructive/5"
    : "border-amber-500/30 bg-amber-500/5";
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
        {metrics && <span className="text-xs tabular-nums text-muted-foreground">24H ↓{formatTopologyBytes(metrics.bytesIn)} ↑{formatTopologyBytes(metrics.bytesOut)}</span>}
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
                    <span className="text-emerald-600 dark:text-emerald-400">↓ {formatTopologyBytes(metrics.bytesInPerSecond)}/s</span>
                    <span className="text-amber-600 dark:text-amber-400">↑ {formatTopologyBytes(metrics.bytesOutPerSecond)}/s</span>
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
          <span className="flex items-center gap-1.5"><span className="shrink-0">{nodeIcon(node.kind)}</span><span className="truncate text-xs font-semibold">{node.label}</span>{node.online != null && <span className={cn("ml-auto h-2 w-2 rounded-full", node.online ? "bg-emerald-500" : "bg-destructive")} />}</span>
          <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{node.subtitle || node.detail || "—"}</span>
        </button>
      </div>)}
    </div>
    <span className="justify-self-center rounded-md bg-muted px-2 py-1 text-xs">{categoryLabel(path.category)}</span>
    <span className={cn("justify-self-center inline-flex items-center gap-1 text-xs", !metrics ? "text-muted-foreground" : metrics.latestLatencyIsTimeout ? "text-destructive" : "text-emerald-600")}><span className={cn("h-2 w-2 rounded-full", !metrics ? "bg-muted-foreground" : metrics.latestLatencyIsTimeout ? "bg-destructive" : "bg-emerald-500")} />{!metrics ? "状态未知" : metrics.latestLatencyIsTimeout ? "超时" : "运行中"}</span>
    <div className="justify-self-end text-right text-xs tabular-nums">{metrics ? <><div><span className="text-emerald-600">↓</span> {formatTopologyBytes(metrics.bytesIn)} <span className="text-amber-600">↑</span> {formatTopologyBytes(metrics.bytesOut)}</div><span className={cn("mt-1 inline-block rounded border px-1.5 py-0.5 font-medium", metrics.latestLatencyIsTimeout ? "border-destructive/30 text-destructive" : "border-primary/25 text-primary")}>{metrics.latestLatencyIsTimeout ? "超时" : metrics.latestLatencyMs != null ? `${Math.round(metrics.latestLatencyMs)} ms` : "未测试"}</span></> : <span className="text-muted-foreground">—</span>}</div>
    <div className="flex justify-end gap-1"><Button size="icon" variant="ghost" className="h-7 w-7" title="查看历史链路质量" disabled={!path.ruleId} onClick={onHistory}><Activity className="h-3.5 w-3.5" /></Button><Button size="icon" variant="ghost" className="h-7 w-7" title="立即探测路径" disabled={!path.ruleId} onClick={onProbe}><Stethoscope className="h-3.5 w-3.5" /></Button></div>
  </div>;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-4 py-1"><span className="shrink-0 text-slate-400">{label}</span><div className="text-right text-slate-700">{children}</div></div>;
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "slate" }) {
  return <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"><div className="text-slate-400">{label}</div><b className={cn("mt-2 block font-mono text-sm", tone === "emerald" ? "text-emerald-600" : tone === "amber" ? "text-amber-600" : "text-slate-700")}>{value}</b></div>;
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
  const [probingRuleIds, setProbingRuleIds] = useState<Set<number>>(() => new Set());
  const probingStartedAtRef = useRef(new Map<number, number>());
  // Each logical path edge owns a stable local snapshot. Polling a new job must
  // never clear completed results for unrelated edges.
  const [segmentProbes, setSegmentProbes] = useState<Record<string, TopologySegmentProbe>>({});
  const segmentProbeLocksRef = useRef(new Set<string>());
  const selectedRuleId = Number(/^rule:(\d+)(?::|$)/.exec(selectedPathId || "")?.[1] || 0);
  // Start with the complete network; operators can narrow the graph to one entry VPS.
  const [entryFilter, setEntryFilter] = useState<string | null>("all");
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [layoutMode, setLayoutMode] = useState<"split" | "list" | "topo">("split");
  const [qualityTarget, setQualityTarget] = useState<LinkQualityTarget | null>(null);
  const [networkProfileTarget, setNetworkProfileTarget] = useState<{ hostId: number; hostName: string } | null>(null);
  const [detailTab, setDetailTab] = useState<"basic" | "performance" | "history">("basic");
  const [checkedPathIds, setCheckedPathIds] = useState<Set<string>>(() => new Set());
  const [probeMessage, setProbeMessage] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const startRuleLatencyTest = trpc.rules.startSelfTest.useMutation();
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
    ),
    [rulesQuery.data, hostsQuery.data, tunnelsQuery.data, groupsQuery.data, landingQuery.data, fullChainsQuery.data, category, search],
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
    ).paths,
    [rulesQuery.data, hostsQuery.data, tunnelsQuery.data, groupsQuery.data, landingQuery.data, fullChainsQuery.data, search],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<TopologyCategory, number>([["all", allCategoryPaths.length]]);
    categoryOptions.filter((option) => option.value !== "all").forEach((option) => {
      counts.set(option.value, allCategoryPaths.filter((path) => path.category === option.value).length);
    });
    return counts;
  }, [allCategoryPaths]);
  const topologyRuleIds = useMemo(
    () => Array.from(new Set(paths.flatMap((path) => path.segmentRuleIds || [Number(path.ruleId || 0)]).filter((id) => id > 0))),
    [paths],
  );
  const automaticSegmentQuery = trpc.diagnostics.latestSegments.useQuery(
    { ruleIds: topologyRuleIds },
    { enabled: topologyRuleIds.length > 0, refetchInterval: pollingInterval("normal"), staleTime: 5_000, refetchOnWindowFocus: false, placeholderData: (previousData) => previousData },
  );
  const automaticSegments = (automaticSegmentQuery.data || []) as AutomaticTopologySegment[];
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
  // Keep the last completed result while the next 10-second test is pending.
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
  const latestTestStateByRule = useMemo(() => new Map((ruleLatencyTests.data || []).map((row: any) => {
    const test = row.test;
    return [Number(row.ruleId), {
      status: test ? String(test.status || "pending") : "idle",
      recordedAt: new Date(test?.updatedAt || test?.createdAt || 0).getTime(),
    }];
  })), [ruleLatencyTests.data]);
  const activeProbeRuleIds = useMemo(() => new Set(Array.from(latestTestStateByRule.entries())
    .filter(([, test]) => ["pending", "running"].includes(test.status) && Date.now() - test.recordedAt < 55_000)
    .map(([ruleId]) => ruleId)), [latestTestStateByRule]);
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
  // Keep the latency pill in its real "探测中" state until the Agent reports a
  // terminal result newer than the manual request. A stale server job is
  // released after the server-side 45s deadline rather than spinning forever.
  useEffect(() => {
    if (!probingRuleIds.size) return;
    setProbingRuleIds((current) => {
      const next = new Set(current);
      for (const ruleId of current) {
        const result = latestTestStateByRule.get(ruleId);
        const startedAt = probingStartedAtRef.current.get(ruleId) || 0;
        if (result && result.recordedAt >= startedAt && ["success", "failed", "timeout"].includes(result.status)) {
          next.delete(ruleId);
          probingStartedAtRef.current.delete(ruleId);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [latestTestStateByRule, probingRuleIds]);
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
  const visiblePaths = useMemo(
    () => activeEntry === "all" ? paths : paths.filter((path) => path.entry.id === activeEntry),
    [paths, activeEntry],
  );
  const overviewPaths = useMemo(() => relationshipOverviewPaths(visiblePaths), [visiblePaths]);
  const graph = useMemo(() => buildGraph(overviewPaths), [overviewPaths]);
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
    return latestAutomaticTopologySegment(automaticSegments, { ruleIds, sourceHostId, targetHostId, targetAddresses });
  };
  const automaticSegmentLabel = (segment: AutomaticTopologySegment) => segment.isTimeout || segment.latencyMs == null
    ? "超时"
    : `${Math.round(Number(segment.latencyMs))} ms`;
  const edgeMeasurementLabel = (edge: TopologyEdge, path?: PhysicalPath | null) => {
    const sourceId = Number(edge.from.replace(/^host:/, ""));
    const targetId = Number(edge.to.replace(/^host:/, ""));
    const targetNode = graph.nodes.find((node) => node.id === edge.to);
    const scopedRuleIds = path
      ? new Set((path.segmentRuleIds || [Number(path.ruleId || 0)]).map(Number).filter((id) => id > 0))
      : null;
    // Plain IP targets use the node label; its subtitle is the port. External
    // SS landings keep their endpoint in the subtitle, so accept both forms.
    const targetAddresses = [targetNode?.label, targetNode?.subtitle].map((value) => String(value || "").trim()).filter(Boolean);
    const automatic = automaticEdgeMeasurement(edge, path);
    const automaticAt = automatic ? new Date(automatic.recordedAt || 0).getTime() : 0;
    const allDetails = [...testByRule.entries()].flatMap(([ruleId, test]: any) => scopedRuleIds && !scopedRuleIds.has(ruleId)
      ? []
      : (test.parsed.details || []).map((detail: any) => ({ ...detail, ruleId, recordedAt: test.recordedAt })));
    const details = allDetails
      .filter((detail: any) => detail.fromHostId === sourceId && detail.toHostId === targetId)
      .sort((a: any, b: any) => b.recordedAt - a.recordedAt);
    if (details.length) {
      // A merged physical edge can belong to several rules/ports. Show only the
      // newest Rules-page test result; never concatenate unrelated port tests.
      const detail = details[0];
      if (automatic && automaticAt > detail.recordedAt) return automaticSegmentLabel(automatic);
      return detail.pending ? "探测中" : !detail.success ? "超时" : `${Math.round(Number(detail.latencyMs) || 0)} ms`;
    }
    // Every hop is measured by its upstream Agent against a concrete address.
    // This also covers external SS / domains, which deliberately have no host ID.
    const targetAddressSet = new Set(targetAddresses.map((address) => address.toLowerCase()));
    const addressMatchedDetails = allDetails
      .filter((detail: any) => detail.fromHostId === sourceId && (targetAddressSet.has(String(detail.targetIp || "").trim().toLowerCase()) || targetAddresses.some((address) => String(detail.routeLabel || detail.message || "").includes(address))))
      .sort((a: any, b: any) => b.recordedAt - a.recordedAt);
    if (addressMatchedDetails.length) {
      const detail = addressMatchedDetails[0];
      if (automatic && automaticAt > detail.recordedAt) return automaticSegmentLabel(automatic);
      return detail.pending ? "探测中" : !detail.success ? "超时" : `${Math.round(Number(detail.latencyMs) || 0)} ms`;
    }
    // A direct rule has a normal forward-test result rather than a chain
    // summary. Match its source host and the displayed target address.
    const directRuleIds = new Set((rulesQuery.data || []).filter((rule: any) => (
      Number(rule.hostId) === sourceId
      && targetAddresses.includes(String(rule.targetIp || "").trim())
      && (!scopedRuleIds || scopedRuleIds.has(Number(rule.id)))
    )).map((rule: any) => Number(rule.id)));
    const directTests = [...testByRule.entries()]
      .filter(([ruleId, test]) => directRuleIds.has(ruleId) && test.status !== "pending")
      .map(([, test]) => test)
      .sort((a, b) => b.recordedAt - a.recordedAt);
    if (!directTests.length) return automatic ? automaticSegmentLabel(automatic) : "待探测";
    const test = directTests[0];
    if (automatic && automaticAt > test.recordedAt) return automaticSegmentLabel(automatic);
    return test.status === "timeout" || test.status === "failed" ? "超时" : typeof test.latencyMs === "number" ? `${Math.round(test.latencyMs)} ms` : "待探测";
  };
  const segmentProbeKey = (path: PhysicalPath, edge: TopologyEdge) => topologySegmentProbeKey(path.id, edge.id);
  const segmentProbeFor = (path: PhysicalPath, edge: TopologyEdge) => segmentProbes[segmentProbeKey(path, edge)] || null;
  // A graph edge is one physical leg even when several logical rules reuse it.
  // Show the freshest physical measurement instead of presenting it as several paths.
  const physicalEdgeMeasurementLabel = (edge: TopologyEdge, edgePaths: PhysicalPath[], includePending = true) => {
    const candidates = [
      ...edgePaths.map((path) => segmentProbeFor(path, edge)).filter((probe): probe is TopologySegmentProbe => !!probe && (includePending || !["pending", "running"].includes(probe.status))).map((probe) => ({
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
    return summarizePhysicalTopologySegmentLabels(candidates, edgeMeasurementLabel(edge));
  };
  const pathEdgeMeasurementLabel = (path: PhysicalPath, edge: TopologyEdge) => {
    const ownProbe = segmentProbeFor(path, edge);
    if (ownProbe && ["pending", "running"].includes(ownProbe.status)) return "探测中";
    const edgePaths = paths.filter((candidate) => topologyPathEdgeIds([candidate.entry, ...candidate.relays, candidate.landing].map((node) => node.id)).includes(edge.id));
    return physicalEdgeMeasurementLabel(edge, edgePaths, false);
  };
  const requestSegmentProbe = async (path: PhysicalPath, edge: TopologyEdge) => {
    const ruleId = Number(path.ruleId || 0);
    const fromHostId = Number(edge.from.replace(/^host:/, ""));
    const target = graph.nodes.find((node) => node.id === edge.to);
    const targetAddress = String(target?.id.startsWith("target:") ? target.label : (target?.subtitle || target?.label || "")).trim();
    const key = segmentProbeKey(path, edge);
    const current = segmentProbeFor(path, edge);
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
  const requestPathProbe = async (ruleId: number) => {
    if (ruleId <= 0) return;
    if (probingRuleIds.has(ruleId) || activeProbeRuleIds.has(ruleId)) {
      setProbeMessage("该链路正在探测中，请等待本轮真实结果返回。");
      return;
    }
    probingStartedAtRef.current.set(ruleId, Date.now());
    setProbingRuleIds((current) => new Set(current).add(ruleId));
    setProbeMessage("正在请求端到端 RTT 探测…");
    try {
      await startRuleLatencyTest.mutateAsync({ ruleId });
      setSegmentProbes((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([, probe]) => probe.ruleId !== ruleId));
        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });
      setProbeMessage("探测任务已下发，正在等待 Agent 返回真实结果…");
      void ruleLatencyTests.refetch();
    } catch (error) {
      probingStartedAtRef.current.delete(ruleId);
      setProbingRuleIds((current) => { const next = new Set(current); next.delete(ruleId); return next; });
      setProbeMessage(`链路测试请求失败：${error instanceof Error ? error.message : String(error)}`);
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
    if (isLoading || !canvas || graph.nodes.length === 0) return;
    const width = Math.max(1, canvas.clientWidth);
    const nextZoom = Math.min(1, width / canvasWidth, canvas.clientHeight / canvasHeight);
    setZoom(nextZoom);
    const frame = requestAnimationFrame(() => canvas.scrollTo({ left: 0, top: 0 }));
    return () => cancelAnimationFrame(frame);
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
    if (segment.pending) return { ...base, latestLatencyMs: null, latestLatencyIsTimeout: false, segmentPending: true };
    if (segment.timeout) return { ...base, latestLatencyMs: null, latestLatencyIsTimeout: true, segmentPending: false };
    if (segment.latencyMs !== null) return { ...base, latestLatencyMs: segment.latencyMs, latestLatencyIsTimeout: false, segmentPending: false };
    const test = testByRule.get(Number(path.ruleId || 0));
    const total = typeof test?.parsed.totalLatencyMs === "number" ? test.parsed.totalLatencyMs : null;
    return { ...base, latestLatencyMs: total ?? base.latestLatencyMs, latestLatencyIsTimeout: total == null ? base.latestLatencyIsTimeout : false, segmentPending: false };
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
    <div className="network-topology-root relative space-y-5 text-slate-800">
      <style>{`
        @keyframes topoDashFlow { to { stroke-dashoffset: -24; } }
        .edge-flow-active { stroke-dasharray: 6 6; animation: topoDashFlow .85s linear infinite; }
        .topo-grid-bg { background-color:#FAFCFF; background-image:radial-gradient(#CBD5E1 1px,transparent 1px); background-size:18px 18px; }
        .no-scrollbar::-webkit-scrollbar { display:none; } .no-scrollbar { scrollbar-width:none; }
      `}</style>
      <header className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">关系总览</h1><p className="text-xs text-slate-500 sm:text-[13px]">查看节点之间的链路关系、延迟与转发路径，支持列表与拓扑两种视图。</p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["链路总数", paths.length, Layers, "blue"], ["入口节点", entryCount, LogIn, "sky"], ["中转节点", relayCount, Cpu, "emerald"], ["落地节点", landingCount, Flag, "amber"],
        ].map(([label, count, Icon, tone]: any) => <div key={label} className="group flex items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm sm:px-5"><div className="flex items-center gap-3.5"><div className={cn("flex h-11 w-11 items-center justify-center rounded-xl", tone === "blue" && "bg-blue-50 text-blue-600", tone === "sky" && "bg-sky-50 text-sky-600", tone === "emerald" && "bg-emerald-50 text-emerald-600", tone === "amber" && "bg-amber-50 text-amber-500")}><Icon className="h-5 w-5" /></div><div><div className="text-xs font-medium text-slate-500">{label}</div><div className="mt-0.5 font-mono text-2xl font-bold leading-none text-slate-900">{count}</div></div></div><svg className="h-11 w-24" viewBox="0 0 100 44"><path d="M 2 34 C 18 31, 28 23, 42 26 C 58 29, 66 13, 78 17 C 89 20, 93 9, 98 11" fill="none" stroke="currentColor" strokeWidth="2" className={cn(tone === "blue" && "text-blue-500", tone === "sky" && "text-sky-500", tone === "emerald" && "text-emerald-500", tone === "amber" && "text-amber-500")} /></svg></div>)}
      </section>

      <section className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm"><div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-center"><div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto pb-1 xl:pb-0">{categoryOptions.map((option) => { const active = category === option.value; const visual = routeVisuals[option.value]; return <button key={option.value} type="button" onClick={() => { setCategory(option.value); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); }} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] border px-3 py-1.5 text-xs font-medium transition-all", active ? `${visual.active} shadow-sm` : "border-slate-200/90 bg-white text-slate-700 hover:bg-slate-50", !active && visual.text)}>{option.value === "all" ? <LayoutGrid className="h-3.5 w-3.5" /> : <RouteTypeIcon category={option.value} className="h-3.5 w-3.5" />}<span>{option.label}</span><span className={cn("rounded-md px-1.5 py-0.5 font-mono text-[11px] leading-none", active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500")}>{categoryCounts.get(option.value) || 0}</span></button>; })}</div><div className="flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center"><div className="inline-flex rounded-[10px] border border-slate-200/60 bg-slate-100/90 p-1"><button onClick={() => setLayoutMode("split")} className={cn("rounded-lg px-2.5 py-1 text-xs font-medium", layoutMode === "split" && "bg-card text-primary shadow-sm")}>总览视图</button><button onClick={() => setLayoutMode("list")} className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium", layoutMode === "list" ? "bg-card text-primary shadow-sm" : "text-slate-600")}><List className="h-3.5 w-3.5" />链路列表</button><button onClick={() => setLayoutMode("topo")} className={cn("inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium", layoutMode === "topo" ? "bg-card text-primary shadow-sm" : "text-slate-600")}><Network className="h-3.5 w-3.5" />拓扑视图</button></div><div className="relative sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(event) => { setSearch(event.target.value); setSelectedPathId(null); }} placeholder="搜索链路、节点或 IP..." className="w-full rounded-[10px] border border-slate-200/90 bg-slate-50/90 py-1.5 pl-8 pr-7 text-xs text-slate-800 outline-none focus:border-primary focus:bg-white" /></div></div></div></section>

      {[rulesQuery, hostsQuery, tunnelsQuery, groupsQuery, landingQuery, fullChainsQuery].some((q) => q.isError) && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-600">部分拓扑数据加载失败，请刷新后重试。</div>}
      {isLoading ? <DataSectionLoading label="正在加载网络拓扑" /> : <>
        {layoutMode !== "topo" && <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm"><div className="overflow-x-auto"><div className="min-w-[1000px]"><div className="grid grid-cols-[2.5rem_17rem_minmax(0,1fr)_7.5rem_8rem_9rem_4.5rem] items-center border-b border-slate-200/80 bg-slate-50/80 text-[12px] font-semibold text-slate-500"><div className="py-3 pl-4"><input type="checkbox" checked={visiblePaths.length > 0 && visiblePaths.every(p => checkedPathIds.has(p.id))} onChange={(e) => setCheckedPathIds(e.target.checked ? new Set(visiblePaths.map(p => p.id)) : new Set())} /></div><div className="px-3 py-3">链路名称 / 类型</div><div className="px-3 py-3 text-center">链路路径（入口 → 中转 → 落地）</div><div className="px-3 py-3">状态 / 总延迟</div><div className="px-3 py-3">实时速率</div><div className="px-3 py-3">流量 (24H)</div><div className="py-3 pr-4 text-right">操作</div></div><div className="divide-y divide-slate-100">{visiblePaths.map(path => { const nodes = [path.entry, ...path.relays, path.landing]; const metric = pathMetrics(path); const rule = path.ruleId ? (rulesQuery.data || []).find((item: any) => Number(item.id) === path.ruleId) as any : null; return <div key={path.id} onClick={() => { if (layoutMode === "split") selectPath(path); }} className={cn("grid grid-cols-[2.5rem_17rem_minmax(0,1fr)_7.5rem_8rem_9rem_4.5rem] items-center transition-colors hover:bg-slate-50/90", layoutMode === "split" && "cursor-pointer", selectedPathId === path.id && "bg-primary/5")}><div className="py-2.5 pl-4"><input type="checkbox" checked={checkedPathIds.has(path.id)} onClick={event => event.stopPropagation()} onChange={e => setCheckedPathIds(old => { const next = new Set(old); e.target.checked ? next.add(path.id) : next.delete(path.id); return next; })} /></div><div className="min-w-0 px-3 py-2.5"><div className="flex items-center gap-2"><RouteTypeBadge category={path.category} /><div className="min-w-0"><div className="truncate font-semibold text-slate-900">{path.name}</div><div className="mt-0.5 flex items-center gap-1.5"><span className="font-mono text-[10px] text-slate-400">{topologyPathReference(path, rule?.sourcePort)}</span><RouteTypeLabel category={path.category} /></div></div></div></div><div className="min-w-0 overflow-hidden px-3 py-2.5"><div className="flex w-fit max-w-full items-center gap-1.5 whitespace-nowrap">{nodes.map((node, index) => <div key={`${node.id}:${index}`} className="flex min-w-0 items-center gap-1.5">{index > 0 && (() => { const edge = { id: `${nodes[index - 1].id}=>${node.id}`, from: nodes[index - 1].id, to: node.id }; const latency = pathEdgeMeasurementLabel(path, edge); const waiting = latency === "待探测" || latency === "探测中"; return <span className="flex min-w-[44px] shrink-0 flex-col items-center gap-0.5"><button type="button" disabled={!path.ruleId || latency === "探测中"} onClick={(event) => { event.stopPropagation(); void requestSegmentProbe(path, edge); }} title="点击仅探测此相邻节点间的 RTT" className={cn("rounded-md border px-1 py-0 font-mono text-[10px] leading-4 transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60", waiting ? "border-amber-300 bg-amber-50 text-amber-700" : latency === "超时" ? "border-red-200 bg-red-50 text-red-600" : "border-slate-200 bg-white text-slate-500")}>{latency}</button><span className={cn("h-px w-full", waiting ? "border-t border-dashed border-amber-400" : "bg-slate-300")} /></span>; })()}<button type="button" onClick={(event) => { event.stopPropagation(); copy(node.subtitle || node.label); }} title={`${node.label} · ${node.subtitle || node.detail || "—"}`} className={cn("flex w-fit max-w-[180px] shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left", index === 0 ? "border-blue-100 bg-blue-50/70" : index === nodes.length - 1 ? "border-amber-200 bg-amber-50/70" : "border-emerald-100 bg-emerald-50/70")}><span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", index === 0 ? "bg-blue-100 text-blue-600" : index === nodes.length - 1 ? "bg-amber-100 text-amber-600" : "bg-emerald-100 text-emerald-600")}>{index === 0 ? <Server className="h-3.5 w-3.5" /> : index === nodes.length - 1 ? <Flag className="h-3.5 w-3.5" /> : <Cpu className="h-3.5 w-3.5" />}</span><span className="min-w-0"><span className="block truncate text-[12px] font-semibold text-slate-800">{node.label}</span><span className="block truncate font-mono text-[10px] text-slate-500">{node.subtitle || node.detail || "—"}</span></span></button></div>)}</div></div><div className="px-3 py-2.5">{(() => { const probing = !!path.ruleId && (probingRuleIds.has(path.ruleId) || activeProbeRuleIds.has(path.ruleId)); const working = path.category === "fullchain" || (topologyEnabledFlag(rule?.isEnabled, true) && !rule?.pendingDelete); const trigger = (event: MouseEvent) => { event.stopPropagation(); if (path.ruleId) void requestPathProbe(path.ruleId); }; return <div className="flex flex-col items-start gap-1.5"><span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", working ? "text-emerald-600" : "text-red-600")}><i className={cn("h-1.5 w-1.5 rounded-full", working ? "bg-emerald-500" : "bg-red-500")} />{working ? "运行中" : "已停用"}</span>{probing ? <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-blue-600 animate-pulse"><Loader2 className="h-3 w-3 animate-spin" />探测中…</span> : metric?.segmentPending ? <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-700"><Loader2 className="h-3 w-3 animate-spin" />逐跳更新中</span> : metric?.latestLatencyIsTimeout ? <button type="button" onClick={trigger} disabled={!path.ruleId} title="当前数值为逐跳延迟合计；点击重新执行完整路径 RTT 探测" className="rounded-md border border-red-200 bg-red-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-red-600 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"><span className="mr-1 text-[10px] opacity-75">Σ</span>超时</button> : metric?.latestLatencyMs != null ? <button type="button" onClick={trigger} disabled={!path.ruleId} title="当前数值为逐跳延迟合计；点击重新执行完整路径 RTT 探测" className="rounded-md border border-violet-200 bg-violet-50 px-2 py-0.5 font-mono text-[11px] font-bold text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-60"><span className="mr-1 text-[10px] font-normal opacity-75">Σ</span>{Math.round(metric.latestLatencyMs)} ms</button> : <button type="button" onClick={trigger} disabled={!path.ruleId} title="点击执行完整路径 RTT 探测并刷新逐跳结果" className="rounded-md border border-dashed border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60">点击探测</button>}</div>; })()}</div><div className="px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-nowrap"><div className="flex items-center gap-1.5"><span className="font-bold text-emerald-600">↓</span><span className="font-medium text-slate-800">{metric ? `${formatTopologyBytes(metric.bytesInPerSecond)}/s` : "—"}</span></div><div className="mt-1 flex items-center gap-1.5"><span className="font-bold text-amber-500">↑</span><span className="font-medium text-slate-600">{metric ? `${formatTopologyBytes(metric.bytesOutPerSecond)}/s` : "—"}</span></div></div><div className="px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-nowrap"><div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-1.5 text-[12px] font-bold text-slate-900"><HardDrive className="h-3.5 w-3.5 text-slate-400" /><span>{metric ? formatTopologyBytes(metric.bytesIn + metric.bytesOut) : "—"}</span><span className="col-start-2 mt-0.5 text-[11px] font-normal text-slate-400">{metric ? <>{formatTopologyBytes(metric.bytesIn)} <span className="text-slate-300">/</span> {formatTopologyBytes(metric.bytesOut)}</> : "—"}</span></div></div><div className="py-2.5 pr-4 text-right whitespace-nowrap"><button type="button" onClick={(event) => { event.stopPropagation(); if (path.ruleId) setQualityTarget({ scope: "rule", id: path.ruleId, name: path.name, subtitle: "规则链路质量历史" }); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50" title="查看链路质量" disabled={!path.ruleId}><Gauge className="h-3.5 w-3.5" /></button><button type="button" onClick={(event) => { event.stopPropagation(); openLandingNetworkProfile(path); }} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50" title={/^host:\d+$/.test(path.landing.id) ? "最终落地机网络画像" : "最终目标不是面板托管 VPS，无法查看网络画像"} disabled={!/^host:\d+$/.test(path.landing.id)}><Earth className="h-3.5 w-3.5" /></button></div></div>; })}</div></div></div></section>}

        {layoutMode !== "list" && <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm"> <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3"><div className="flex flex-wrap items-center gap-4"><h2 className="text-sm font-bold text-slate-900">链路拓扑</h2><div className="flex gap-3.5 text-xs text-slate-600"><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-blue-500" />入口节点</span><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500" />中转节点</span><span><i className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-500" />落地节点</span></div></div><div className="flex items-center gap-1.5"><button onClick={() => setZoom(1)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500"><Scan className="h-3.5 w-3.5" /></button><button onClick={() => setZoom(z => Math.max(.2, z - .1))} className="rounded-l-lg border border-slate-200 px-2 py-1">−</button><span className="border-y border-slate-200 px-2 py-1 font-mono text-[11px]">{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(z => Math.min(1.5, z + .1))} className="rounded-r-lg border border-slate-200 px-2 py-1">+</button></div></div><div ref={canvasRef} className="topo-grid-bg relative min-h-[430px] overflow-auto p-2"><div style={{ width: graph.width * zoom, height: graph.height * zoom, margin: "auto" }}><div className="relative origin-top-left" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}><svg className="absolute inset-0 h-full w-full" width={graph.width} height={graph.height}><defs><marker id="topology-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--primary)" fillOpacity=".48" /></marker><marker id="topology-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="var(--primary)" /></marker></defs>{graph.edges.map(edge => { const points = graph.edgeRoutes.get(edge.id); if (!points) return null; const active = highlightedEdges.has(edge.id) || selectedEdgeId === edge.id; const edgePaths = visiblePaths.filter((path) => topologyPathEdgeIds([path.entry, ...path.relays, path.landing].map((node) => node.id)).includes(edge.id)); const latencyLabel = physicalEdgeMeasurementLabel(edge, edgePaths); const labelPoint = points.length === 4 ? { x: (points[0].x + 3 * points[1].x + 3 * points[2].x + points[3].x) / 8, y: (points[0].y + 3 * points[1].y + 3 * points[2].y + points[3].y) / 8 } : { x: (points[0].x + points.at(-1)!.x) / 2, y: (points[0].y + points.at(-1)!.y) / 2 }; const labelX = labelPoint.x; const labelY = labelPoint.y - 8; const labelWidth = Math.max(38, latencyLabel.length * 6 + 14); return <g key={edge.id}><path d={topologyRoutePath(points)} fill="none" stroke="transparent" strokeWidth="12" style={{ cursor: "pointer", pointerEvents: "stroke" }} onClick={(event) => selectGraphEdge(edge, false, graphPopupAnchor(event, { x: labelX, y: labelY }))} /><path d={topologyRoutePath(points)} fill="none" stroke="var(--primary)" strokeOpacity={active ? 1 : .48} strokeWidth={active ? 2.4 : 1.5} style={{ pointerEvents: "none" }} markerEnd={`url(#${active ? "topology-arrow-active" : "topology-arrow"})`} className={active ? "edge-flow-active" : ""} /><rect x={labelX - labelWidth / 2} y={labelY - 11} width={labelWidth} height="20" rx="6" fill="var(--card)" fillOpacity=".96" stroke={active ? "var(--primary)" : "var(--border)"} strokeOpacity={active ? .45 : 1} style={{ cursor: "pointer" }} onClick={(event) => { event.stopPropagation(); selectGraphEdge(edge, true, graphPopupAnchor(event, { x: labelX, y: labelY })); }}><title>点击立即重测此逻辑链路</title></rect><text pointerEvents="none" x={labelX} y={labelY + 3} textAnchor="middle" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontWeight={active ? "600" : "500"} fill={active ? "var(--primary)" : "var(--muted-foreground)"}>{latencyLabel}</text></g>; })}</svg>{graph.nodes.map(node => { const pos = graph.positions.get(node.id); if (!pos) return null; const role = node.kind; const active = highlightedNodes.has(node.id) || selectedNodeId === node.id; return <button key={node.id} onClick={() => { setSelectedNodeId(node.id); setSelectedPathId(null); setSelectedEdgeId(null); }} style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }} className={cn("absolute flex items-center gap-2.5 rounded-[10px] border px-3 py-2 text-left shadow-sm", role === "entry" ? "border-blue-200 bg-blue-50/70" : role === "relay" ? "border-emerald-200 bg-emerald-50/70" : "border-amber-200 bg-amber-50/70", active && "ring-2 ring-blue-500/30")}><span className={cn("flex h-7 w-7 items-center justify-center rounded-lg", role === "entry" ? "bg-blue-100 text-blue-600" : role === "relay" ? "bg-emerald-100 text-emerald-600" : "bg-amber-100 text-amber-600")}>{role === "entry" ? <Server className="h-3.5 w-3.5" /> : role === "relay" ? <Cpu className="h-3.5 w-3.5" /> : <Flag className="h-3.5 w-3.5" />}</span><span className="min-w-0"><span className="flex items-center gap-1 text-xs font-bold text-slate-900"><span className="truncate">{node.label}</span><i className={cn("ml-auto h-2 w-2 rounded-full", node.online === false ? "bg-red-500" : "bg-emerald-500")} /></span><span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500">{node.subtitle || node.detail || "—"}</span></span></button>; })}</div></div></div></section>}
      </>}
      {layoutMode !== "list" && selectedPath && <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5"><h3 className="text-sm font-bold text-slate-900">链路详情: <span>{selectedPath.name}</span></h3><span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium", selectedPathMetrics?.latestLatencyIsTimeout ? "border-red-200 bg-red-50 text-red-600" : "border-emerald-200 bg-emerald-50 text-emerald-600")}><i className={cn("h-1.5 w-1.5 rounded-full", selectedPathMetrics?.latestLatencyIsTimeout ? "bg-red-500" : "bg-emerald-500")} />{selectedPathMetrics?.latestLatencyIsTimeout ? "超时" : "运行中"}</span></div>
        <div className="flex gap-2 border-b border-slate-100 px-5 pb-2 pt-3">{([ ["basic", "基本信息"], ["performance", "性能指标"], ["history", "历史趋势"] ] as const).map(([key, label]) => <button key={key} type="button" onClick={() => setDetailTab(key)} className={cn("rounded-lg px-3 py-1.5 text-xs", detailTab === key ? "border border-primary/30 bg-primary/10 font-semibold text-primary" : "font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800")}>{label}</button>)}</div>
        <div className="p-5">
          {detailTab === "basic" && <div className="space-y-4 text-xs"><DetailRow label="链路名称"><b className="text-slate-900">{selectedPath.name}</b><span className="ml-2 font-mono text-slate-400">{selectedPath.id}</span></DetailRow><DetailRow label="链路类型"><span className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600">{categoryLabel(selectedPath.category)}</span></DetailRow><DetailRow label="链路路径"><div className="flex flex-wrap justify-end gap-1">{selectedPathNodes.map((node, i) => <span key={`${node.id}:${i}`} className="inline-flex items-center gap-1">{i > 0 && <span className="text-slate-400">→</span>}<span className={cn("rounded-md border px-2 py-0.5", i === 0 ? "border-blue-200 bg-blue-50 text-blue-700" : i === selectedPathNodes.length - 1 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>{node.label}</span></span>)}</div></DetailRow><DetailRow label="节点数量"><b>{selectedPathNodes.length}</b></DetailRow><DetailRow label="24H 流量"><span className="font-mono"><span>{selectedPathMetrics ? formatTopologyBytes(selectedPathMetrics.bytesIn) : "—"}</span><b className="ml-1 text-emerald-600">↓</b><span className="mx-2 text-slate-300">/</span><span>{selectedPathMetrics ? formatTopologyBytes(selectedPathMetrics.bytesOut) : "—"}</span><b className="ml-1 text-amber-500">↑</b></span></DetailRow><DetailRow label="逐跳合计"><span className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 font-mono font-semibold text-blue-600">{selectedPathMetrics?.latestLatencyMs != null ? `${Math.round(selectedPathMetrics.latestLatencyMs)} ms` : "待探测"}</span></DetailRow><DetailRow label="创建时间"><span className="font-mono text-slate-600">{selectedRule?.createdAt ? new Date(selectedRule.createdAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</span></DetailRow></div>}
          {detailTab === "performance" && <div className="space-y-5 text-xs"><div className="grid gap-3 sm:grid-cols-2"><MetricCard label="实时下行吞吐" value={`↓ ${selectedPathMetrics ? `${formatTopologyBytes(selectedPathMetrics.bytesInPerSecond)}/s` : "—"}`} tone="emerald" /><MetricCard label="实时上行吞吐" value={`↑ ${selectedPathMetrics ? `${formatTopologyBytes(selectedPathMetrics.bytesOutPerSecond)}/s` : "—"}`} tone="amber" /></div><div className="grid gap-3 sm:grid-cols-2"><MetricCard label="24H 丢包率" value={selectedPacketLoss == null ? "暂无记录" : `${selectedPacketLoss.toFixed(1)}%`} tone="slate" /><MetricCard label="网络抖动 (Jitter)" value={selectedJitter == null ? "暂无记录" : `${selectedJitter.toFixed(1)} ms`} tone="slate" /></div><div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"><h4 className="mb-3 font-bold text-slate-700">单跳 RTT 耗时分布</h4>{selectedPathNodes.slice(1).map((node, index, hops) => { const label = pathEdgeMeasurementLabel(selectedPath, { id: `${selectedPathNodes[index].id}=>${node.id}`, from: selectedPathNodes[index].id, to: node.id }); const latency = Number.parseFloat(label); const maxLatency = Math.max(...hops.map((hop, hopIndex) => Number.parseFloat(pathEdgeMeasurementLabel(selectedPath, { id: `${selectedPathNodes[hopIndex].id}=>${hop.id}`, from: selectedPathNodes[hopIndex].id, to: hop.id })) || 0), 1); const width = Number.isFinite(latency) ? `${Math.max(6, latency / maxLatency * 100)}%` : "0%"; return <div key={`${node.id}:${index}`} className="mb-3 last:mb-0"><div className="mb-1.5 flex justify-between text-slate-500"><span>第 {index + 1} 跳 ({selectedPathNodes[index].label} → {node.label})</span><b className="font-mono text-blue-600">{label}</b></div><div className="h-1.5 overflow-hidden rounded-full bg-slate-200"><div className={cn("h-full rounded-full", index === 0 ? "bg-blue-500" : "bg-emerald-500")} style={{ width }} /></div></div>; })}</div><button type="button" disabled={!selectedPath.ruleId || startRuleLatencyTest.isPending} onClick={() => selectedPath.ruleId && void requestPathProbe(selectedPath.ruleId)} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"><Activity className="h-4 w-4" />立即执行端到端 RTT 探测</button></div>}
          {detailTab === "history" && <div className="text-xs"><div className="mb-5 flex justify-between text-slate-500"><span>最近 24 小时往返延迟曲线 (ms)</span><b className="font-mono text-blue-600">当前逐跳合计 {selectedPathMetrics?.latestLatencyMs != null ? `${Math.round(selectedPathMetrics.latestLatencyMs)} ms` : "—"}</b></div><div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">{selectedPathHistoryQuery.isLoading ? <div className="py-16 text-center text-slate-400">正在加载真实历史延迟…</div> : selectedHistoryPolyline ? <><svg viewBox="0 0 100 48" preserveAspectRatio="none" className="h-40 w-full"><defs><linearGradient id="topology-history-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2563EB" stopOpacity=".22" /><stop offset="1" stopColor="#2563EB" stopOpacity="0" /></linearGradient></defs><polyline points={`0,48 ${selectedHistoryPolyline} 100,48`} fill="url(#topology-history-area)" stroke="none" /><polyline points={selectedHistoryPolyline} fill="none" stroke="#2563EB" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg><div className="mt-2 flex justify-between font-mono text-[10px] text-slate-400"><span>24H 前</span><span>现在</span></div></> : <div className="py-16 text-center text-slate-400">当前路径暂无真实历史延迟记录。</div>}</div><div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 text-slate-600">历史趋势来自规则真实 TCPing 记录；未检测到的数据不会使用模拟值补全。</div></div>}
        </div>
      </section>}
      {sharedEdgeSelection && <section className="absolute z-50 w-[min(27.5rem,calc(100vw-2rem))] max-h-[18rem] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl" style={{ left: sharedEdgeSelection.anchor?.left ?? "50%", top: sharedEdgeSelection.anchor ? sharedEdgeSelection.anchor.above ? sharedEdgeSelection.anchor.top - 10 : sharedEdgeSelection.anchor.top + 10 : "50%", transform: sharedEdgeSelection.anchor ? sharedEdgeSelection.anchor.above ? "translate(-50%, -100%)" : "translateX(-50%)" : "translate(-50%, -50%)" }}><div className="flex items-start justify-between gap-3"><div><h3 className="text-[13px] font-bold text-slate-900">选择经过此共享链路的路径</h3><p className="mt-1 text-[11px] text-slate-500">该物理链路被 {sharedEdgeCandidates.length} 条逻辑链路共用，请选择完整路径。</p></div><button type="button" onClick={() => setSharedEdgeSelection(null)} className="rounded-md px-1.5 py-1 text-[11px] text-slate-400 hover:bg-slate-50 hover:text-slate-700">取消</button></div><div className="mt-3 space-y-1.5">{sharedEdgeCandidates.map((path) => { const nodes = [path.entry, ...path.relays, path.landing]; return <button type="button" key={path.id} onClick={() => { selectPath(path); setSelectedEdgeId(sharedEdgeSelection.edgeId); if (sharedEdgeSelection.probe && path.ruleId) { const [from, to] = sharedEdgeSelection.edgeId.split("=>"); void requestSegmentProbe(path, { id: sharedEdgeSelection.edgeId, from, to }); } }} className="w-full rounded-lg border border-slate-200 bg-slate-50/60 p-2.5 text-left transition hover:border-primary/40 hover:bg-primary/5"><div className="mb-1.5 flex items-center justify-between gap-3"><b className="truncate text-xs text-slate-800">{path.name}</b><RouteTypeLabel category={path.category} /></div><div className="flex flex-wrap items-center gap-1 text-[10px]">{nodes.map((node, index) => <span key={`${node.id}:${index}`} className="inline-flex items-center gap-1">{index > 0 && <span className="text-slate-400">→</span>}<span className={cn("rounded border px-1.5 py-0.5", index === 0 ? "border-blue-200 bg-blue-50 text-blue-700" : index === nodes.length - 1 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>{node.label}</span></span>)}</div></button>; })}</div></section>}
      {probeMessage && <p className="text-xs text-slate-500">{probeMessage}</p>}
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
