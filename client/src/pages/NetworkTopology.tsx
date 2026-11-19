import { useEffect, useMemo, useRef, useState } from "react";
import { topologyPathEdgeIds } from "./networkTopologyPaths";
import { parseLinkTestMessage } from "@/components/LinkTestLatencySummary";
import { topologyRuleHref } from "./topologyRuleLink";
import { improveTopologyOrder } from "./topologyLayout";
import { routeSmoothLayeredTopologyGraph, topologyRoutePath } from "./topologyRouting";
import { topologyEnabledFlag, visibleTopologyTunnelVariants } from "./topologyTunnelVariants";
import { combineTopologyHostVariants, joinTopologyHostPaths, MAX_TOPOLOGY_VARIANTS, type TopologyExpansionState } from "./topologyExpansion";
import {
  Activity,
  ArrowRight,
  Layers3,
  Network,
  RefreshCw,
  Route,
  Search,
  Server,
  Stethoscope,
  Waypoints,
} from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import DataSectionLoading from "@/components/DataSectionLoading";
import { LinkQualityDialog, type LinkQualityTarget } from "@/components/observability/LinkQualityDialog";
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

const categoryOptions: Array<{ value: TopologyCategory; label: string }> = [
  { value: "all", label: "全部" },
  { value: "local", label: "端口转发" },
  { value: "tunnel", label: "隧道" },
  { value: "chain", label: "转发链" },
  { value: "group", label: "转发组" },
  { value: "fullchain", label: "全链路" },
];

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

function NetworkTopologyContent() {
  const [category, setCategory] = useState<TopologyCategory>("all");
  const [search, setSearch] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Start with the complete network; operators can narrow the graph to one entry VPS.
  const [entryFilter, setEntryFilter] = useState<string | null>("all");
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [layoutMode, setLayoutMode] = useState<"lanes" | "graph">("lanes");
  const [qualityTarget, setQualityTarget] = useState<LinkQualityTarget | null>(null);
  const [probeMessage, setProbeMessage] = useState("");
  const startRuleLatencyTest = trpc.rules.startSelfTest.useMutation();

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
  const topologyRuleIds = useMemo(
    () => Array.from(new Set(paths.flatMap((path) => path.segmentRuleIds || [Number(path.ruleId || 0)]).filter((id) => id > 0))),
    [paths],
  );
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
  const topologyProbeRuleIdsRef = useRef<number[]>([]);
  const topologyPollRunningRef = useRef(false);
  const ruleLatencyTests = trpc.rules.latestTests.useQuery(
    { ruleIds: topologyRuleIds, includeActive: true },
    { enabled: topologyRuleIds.length > 0, refetchInterval: pollingInterval("active"), staleTime: 0, refetchOnWindowFocus: false },
  );
  // Reuse the exact same self-test mutation as the Rules page. This is the
  // only interactive topology polling; no topology-specific probe exists.
  useEffect(() => {
    topologyProbeRuleIdsRef.current = topologyRuleIds;
    if (topologyRuleIds.length === 0) return;
    let stopped = false;
    const run = async () => {
      if (stopped || topologyPollRunningRef.current) return;
      topologyPollRunningRef.current = true;
      try {
        await Promise.allSettled(topologyRuleIds.map((ruleId) => startRuleLatencyTest.mutateAsync({ ruleId })));
        await ruleLatencyTests.refetch();
      } finally { topologyPollRunningRef.current = false; }
    };
    void run();
    const timer = window.setInterval(() => void run(), 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [topologyRuleIds.join(",")]);
  const testByRule = useMemo(() => new Map((ruleLatencyTests.data || []).map((row: any) => [Number(row.ruleId), {
    parsed: parseLinkTestMessage(row.test?.message),
    recordedAt: new Date(row.test?.updatedAt || row.test?.createdAt || 0).getTime(),
  }])), [ruleLatencyTests.data]);
  const trafficRateQuery = trpc.rules.trafficRateBatch.useQuery(
    { ruleIds: rateRuleIds },
    {
      enabled: rateRuleIds.length > 0,
      // While topology is open the existing Agent reporter is requested at 1s.
      refetchInterval: pollingInterval("realtime"),
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
  const edgeMeasurementLabel = (edge: TopologyEdge) => {
    const sourceId = Number(edge.from.replace(/^host:/, ""));
    const targetId = Number(edge.to.replace(/^host:/, ""));
    const details = [...testByRule.values()].flatMap((test: any) => (test.parsed.details || []).map((detail: any) => ({ ...detail, recordedAt: test.recordedAt })))
      .filter((detail: any) => detail.fromHostId === sourceId && detail.toHostId === targetId)
      .sort((a: any, b: any) => b.recordedAt - a.recordedAt);
    if (!details.length) return "待探测";
    // A merged physical edge can belong to several rules/ports. Show only the
    // newest Rules-page test result; never concatenate unrelated port tests.
    const detail = details[0];
    return detail.pending ? "探测中" : !detail.success ? "超时" : `${Math.round(Number(detail.latencyMs) || 0)} ms`;
  };
  const requestPathProbe = async (ruleId: number) => {
    setProbeMessage("正在请求链路测试…");
    try {
      await startRuleLatencyTest.mutateAsync({ ruleId });
      setProbeMessage("已请求规则链路测试；结果自动刷新。");
      void ruleLatencyTests.refetch();
    } catch (error) {
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

  const handleRefresh = async () => {
    await Promise.all([
      rulesQuery.refetch(),
      hostsQuery.refetch(),
      tunnelsQuery.refetch(),
      groupsQuery.refetch(),
      landingQuery.refetch(),
      fullChainsQuery.refetch(),
    ]);
  };

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

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">网络拓扑</h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
按面板可见配置展示入口、中转及目标；外部专线、未管理转发及复杂嵌套组的部分候选路径可能未包含。
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleRefresh()} disabled={isLoading}>
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">链路路径</div><div className="mt-1 text-xl font-semibold">{paths.length}</div></CardContent></Card>
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">入口</div><div className="mt-1 text-xl font-semibold">{entryCount}</div></CardContent></Card>
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">中转节点</div><div className="mt-1 text-xl font-semibold">{relayCount}</div></CardContent></Card>
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">落地 / 目标</div><div className="mt-1 text-xl font-semibold">{landingCount}</div></CardContent></Card>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border/45 bg-card/45 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {categoryOptions.map((option) => (
            <Button
              key={option.value}
              variant={category === option.value ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={() => {
                setCategory(option.value);
                setSelectedNodeId(null);
                setSelectedPathId(null);
                setSelectedEdgeId(null);
                setEntryFilter(null);
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <div className="inline-flex shrink-0 rounded-md border border-border/50 p-0.5">
            <Button size="sm" variant={layoutMode === "lanes" ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => setLayoutMode("lanes")}>链路视图</Button>
            <Button size="sm" variant={layoutMode === "graph" ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => setLayoutMode("graph")}>关系总览</Button>
          </div>
          <div className="relative min-w-0 flex-1 sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => { setSearch(event.target.value); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); setEntryFilter("all"); }} placeholder="搜索规则、入口、节点或落地" className="h-8 pl-8 text-xs" />
          </div>
        </div>
      </div>

      {[rulesQuery, hostsQuery, tunnelsQuery, groupsQuery, landingQuery, fullChainsQuery].some((query) => query.isError) && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">部分拓扑数据加载失败，当前图和影响范围可能不完整，请刷新后重试。</div>
      )}
      {!isLoading && (topology.incomplete || topology.truncated) && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
        {topology.incomplete && "部分资源缺失、受权限限制或路径存在循环，无法安全展开；未绘制无法确认的路径。"}
        {topology.truncated && ` 候选组合过多，单项最多显示 ${MAX_TOPOLOGY_VARIANTS} 条；请筛选或查看原始规则。`}
      </div>}

      {isLoading ? (
        <DataSectionLoading label="正在加载网络拓扑" />
      ) : (layoutMode === "graph" ? graph.nodes.length === 0 : visiblePaths.length === 0) ? (
        <Card className="border-dashed border-border/50 bg-card/40">
          <CardContent className="flex min-h-72 flex-col items-center justify-center gap-2 text-center">
            <Network className="h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">当前筛选没有可展示的物理链路</div>
            <div className="text-xs text-muted-foreground">调整类型或搜索条件后重试。</div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {layoutMode === "lanes" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-[13rem_minmax(5rem,1fr)_13rem] gap-3 px-4 text-xs font-medium text-muted-foreground">
                <span>入口</span><span className="text-center">中转</span><span className="text-right">落地</span>
              </div>
              {visiblePaths.map((path) => (
                <TopologyLane
                  key={path.id}
                  path={path}
                  metrics={path.ruleId ? (() => {
                    const base = trafficByRule.get(path.ruleId);
                    const test = testByRule.get(path.ruleId);
                    const total = typeof test?.parsed.totalLatencyMs === "number" ? test.parsed.totalLatencyMs : null;
                    return base ? { ...base, latestLatencyMs: total ?? base.latestLatencyMs, latestLatencyIsTimeout: total == null ? base.latestLatencyIsTimeout : false } : undefined;
                  })() : undefined}
                  edgeLatency={(from, to) => edgeMeasurementLabel({ id: `${from.id}=>${to.id}`, from: from.id, to: to.id })}
                  selected={selectedPathId === path.id}
                  onSelectPath={() => { setSelectedPathId(path.id); setSelectedNodeId(null); setSelectedEdgeId(null); }}
                  onSelectNode={(node) => { setSelectedPathId(path.id); setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
                />
              ))}
            </div>
          ) : (
          <Card className="overflow-hidden border-border/45 bg-card/45">
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center gap-2 border-b border-border/40 p-2">
                <div className="mr-auto flex min-w-0 flex-wrap items-center gap-1">
                  <span className="mr-1 text-xs text-muted-foreground">入口机</span>
                  <Button size="sm" variant={activeEntry === "all" ? "secondary" : "ghost"} onClick={() => { setEntryFilter("all"); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); }}>全部</Button>
                  {entryGroups.map((group) => <Button key={group.entry.id} size="sm" variant={activeEntry === group.entry.id ? "secondary" : "ghost"} onClick={() => { setEntryFilter(group.entry.id); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); }}>{group.entry.label}</Button>)}
                  <span className="ml-1 text-xs text-muted-foreground">· {visiblePaths.length} 条路径</span>
                </div>
                {selectedPath && <Button size="sm" variant="ghost" onClick={() => setSelectedPathId(null)}>取消高亮</Button>}
                <Button size="sm" variant="outline" aria-label="缩小拓扑" onClick={() => setZoom((value) => Math.max(0.2, Math.round((value - 0.1) * 10) / 10))}>−</Button>
                <Button size="sm" variant="ghost" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
                <Button size="sm" variant="outline" aria-label="放大拓扑" onClick={() => setZoom((value) => Math.min(1.5, Math.round((value + 0.1) * 10) / 10))}>＋</Button>
                <Button size="sm" variant="outline" onClick={() => setZoom(Math.min(1, Math.max(0.2, (canvasRef.current?.clientWidth || canvasWidth) / canvasWidth)))}>适应宽度</Button>
                <Button size="sm" variant="outline" onClick={() => { const canvas = canvasRef.current; if (!canvas) return; setZoom(Math.min(1, Math.max(0.2, Math.min(canvas.clientWidth / canvasWidth, Math.max(240, Math.min(window.innerHeight * 0.65, 600)) / canvasHeight)))); canvas.scrollTo({ left: 0, top: 0 }); }}>适应画布</Button>
                {selectedNode && <Button size="sm" variant="outline" onClick={() => focusNode(selectedNode.id)}>定位选中节点</Button>}
              </div>
              <div ref={canvasRef} className="h-[65vh] min-h-80 cursor-grab overflow-hidden active:cursor-grabbing" onPointerDown={(event) => {
                if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as Element).closest("button, a, [role=button]")) return;
                const canvas = event.currentTarget; dragRef.current = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
                canvas.setPointerCapture(event.pointerId);
              }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag) return; event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x); event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y); }}
                onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
                <div style={{ width: canvasWidth * zoom, height: canvasHeight * zoom, marginInline: "auto", marginTop: Math.max(0, ((canvasRef.current?.clientHeight || 0) - canvasHeight * zoom) / 2) }}>
                <div className="relative origin-top-left" style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${zoom})` }}>
                <div className="absolute top-0" style={{ left: 0, width: graph.width, height: graph.height }}>
                  <svg data-topology-edges className="absolute inset-0 h-full w-full" width={graph.width} height={graph.height} style={{ pointerEvents: "none" }}>
                    {[...graph.edges].sort((a, b) => Number(selectedEdgeId === a.id || highlightedEdges.has(a.id)) - Number(selectedEdgeId === b.id || highlightedEdges.has(b.id))).map((edge) => {
                      const points = graph.edgeRoutes.get(edge.id);
                      if (!points) return null;
                      const path = topologyRoutePath(points);
                      const active = selectedEdgeId === edge.id || !!selectedPath && highlightedEdges.has(edge.id);
                      const faded = !!selectedPath && !highlightedEdges.has(edge.id) && selectedEdgeId !== edge.id;
                      return (
                        <g key={edge.id} opacity={faded ? 0.25 : 1}>
                          <path d={path} fill="none" stroke="currentColor" strokeWidth={active ? 7 : 5} className="text-card" />
                          <path d={path} fill="none" stroke="currentColor" strokeWidth={active ? 3 : 1.8} className={active ? "text-primary" : "text-muted-foreground/70"} />
                          {points.length === 4 && <text
                            x={(points[0].x + 3 * points[1].x + 3 * points[2].x + points[3].x) / 8}
                            y={(points[0].y + 3 * points[1].y + 3 * points[2].y + points[3].y) / 8 - 10}
                            textAnchor="middle" fill="currentColor" stroke="var(--background)" strokeWidth="4" paintOrder="stroke" className="text-xs text-primary">
                            {edgeMeasurementLabel(edge)}
                          </text>}
                          <path data-topology-edge={edge.id} d={path} fill="none" stroke="transparent" strokeWidth="10" style={{ pointerEvents: "stroke", cursor: "pointer", outline: "none" }}
                            role="button" tabIndex={0} aria-label={`查看 ${graph.nodes.find((node) => node.id === edge.from)?.label || edge.from} 到 ${graph.nodes.find((node) => node.id === edge.to)?.label || edge.to} 的关联路径`}
                            onClick={() => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedEdgeId(edge.id); setSelectedNodeId(null); } }} />
                        </g>
                      );
                    })}
                  </svg>

                  {graph.nodes.map((node) => {
                    const pos = graph.positions.get(node.id);
                    if (!pos) return null;
                    const selected = selectedNodeId === node.id;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        data-topology-node={node.id}
                        onClick={() => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
                        className={cn(
                          "absolute flex flex-col justify-center rounded-lg border px-3 py-2 text-left shadow-sm transition-[border-color,box-shadow] hover:shadow-md",
                          nodeTone(node),
                          selected && "ring-2 ring-primary/35",
                          selectedPath && highlightedNodes.has(node.id) && "ring-2 ring-primary/50",
                          selectedPath && !highlightedNodes.has(node.id) && "opacity-35",
                        )}
                        style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }}
                        title={node.label}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="shrink-0 text-muted-foreground">{nodeIcon(node.kind)}</span>
                          <span className="truncate text-xs font-semibold">{node.label}</span>
                          {node.online != null && (
                            <span className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", node.online ? "bg-emerald-500" : "bg-destructive")} />
                          )}
                        </div>
                        <div className="mt-1 truncate text-[10px] text-muted-foreground">{node.subtitle || node.detail || "—"}</div>
                      </button>
                    );
                  })}
                </div>
                </div>
                </div>
              </div>
            </CardContent>
          </Card>
          )}

          {probeMessage && <p role="status" className="text-sm text-muted-foreground">{probeMessage}</p>}
          <Card className="h-fit border-border/45 bg-card/60">
            <CardContent className="space-y-4 p-4">
              {selectedEdge && !selectedNode && (
                <div className="space-y-2 border-b border-border/40 pb-3 text-xs">
                  <div className="text-sm font-semibold">连线关联</div>
                  <div className="break-words">{graph.nodes.find((node) => node.id === selectedEdge.from)?.label} → {graph.nodes.find((node) => node.id === selectedEdge.to)?.label}</div>
                  <p className="text-muted-foreground">当前筛选下 {edgePaths.length} 条配置路径经过此方向。相同主机间可能存在不同端口或规则，连线已合并，不代表单条连接。</p>
                  <div className="max-h-40 space-y-1 overflow-auto">{edgePaths.map((path) => <button key={path.id} type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-accent" onClick={() => { setEntryFilter(path.entry.id); setSelectedPathId(path.id); setSelectedEdgeId(null); }}>{path.name} · {categoryLabel(path.category)}</button>)}</div>
                  <p className="text-muted-foreground">分段探测：{edgeMeasurementLabel(selectedEdge)}。TCP / Ping 结果不代表端到端业务可用；合并边可能包含多个目标端口。</p>
                </div>
              )}
              {selectedPath && !selectedNode && !selectedEdge && (
                <div className="space-y-2 border-b border-border/40 pb-3 text-xs">
                  <div className="text-sm font-semibold">{selectedPath.name}</div>
                  <div className="text-muted-foreground">{categoryLabel(selectedPath.category)} · 配置路径</div>
                  <div className="break-words leading-6">{[selectedPath.entry, ...selectedPath.relays, selectedPath.landing].map((node) => node.label).join(" → ")}</div>
                  {selectedRule && <div className="space-y-1 text-muted-foreground"><div>规则协议：{String(selectedRule.protocol || "未知").toUpperCase()}</div><div>入口端口：{selectedRule.sourcePort || "未知"}</div><div>规则目标：{selectedRule.targetIp || "未知"}{selectedRule.targetPort ? `:${selectedRule.targetPort}` : ""}</div></div>}
                  <p className="text-muted-foreground">路径根据面板配置生成，不代表端到端业务已验证。</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <a className="text-primary underline" href={selectedRule ? topologyRuleHref(Number(selectedRule.id)) : "/tunnels"}>打开{selectedRule ? "该转发规则" : "链路管理"}</a>
                    {selectedPath.ruleId && <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={startRuleLatencyTest.isPending} onClick={() => void requestPathProbe(selectedPath.ruleId!)}>
                      <Stethoscope className="h-3 w-3" />立即探测路径
                    </Button>}
                  </div>
                </div>
              )}
              {selectedNode ? (
                <>
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 rounded-md border border-border/50 bg-muted/30 p-2 text-muted-foreground">
                      {nodeIcon(selectedNode.kind)}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{selectedNode.label}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{selectedNode.subtitle || "暂无附加信息"}</div>
                    </div>
                  </div>
                  <div className="space-y-2 border-t border-border/40 pt-3 text-xs">
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">路径角色</span><span>{nodeRoles || "未知"}</span></div>
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">说明</span><span className="text-right">{selectedNode.detail || "—"}</span></div>
                    {selectedNode.online != null && (
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">主机状态（不代表链路正常）</span>
                        <Badge variant="outline" className={cn("h-5 text-[10px]", selectedNode.online ? "border-emerald-500/30 text-emerald-600" : "border-destructive/30 text-destructive")}>
                          {selectedNode.online ? "在线" : "离线"}
                        </Badge>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 border-t border-border/40 pt-3 text-xs">
                    <div className="font-medium">可能受影响的路径：{nodePaths.length}</div>
                    <p className="text-muted-foreground">仅按当前筛选的配置计算；是否实际中断取决于主备和运行状态。</p>
                    <div className="max-h-40 space-y-1 overflow-auto">{nodePaths.map((path) => <button key={path.id} type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-accent" onClick={() => { setEntryFilter(path.entry.id); setSelectedPathId(path.id); setSelectedNodeId(null); }}>{path.name} · {categoryLabel(path.category)}</button>)}</div>
                    <div className="flex flex-wrap gap-2"><a className="text-primary underline" href="/hosts">主机管理</a><a className="text-primary underline" href="/rules">转发规则</a><a className="text-primary underline" href="/tunnels">链路管理</a></div>
                  </div>
                  {selectedNode.qualityTarget && (
                    <Button variant="outline" className="w-full gap-2" onClick={() => setQualityTarget(selectedNode.qualityTarget || null)}>
                      <Activity className="h-4 w-4" />
                      查看关联规则的历史链路质量
                    </Button>
                  )}
                </>
              ) : !selectedPath && !selectedEdge ? (
                <div className="flex min-h-40 flex-col items-center justify-center text-center">
                  <Layers3 className="h-7 w-7 text-muted-foreground" />
                  <div className="mt-2 text-sm font-medium">选择一个链路节点</div>
                  <p className="mt-1 text-xs text-muted-foreground">选择节点查看详情，或从路径列表选择一条规则。</p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Waypoints className="h-3 w-3" />入口</span>
        <span className="inline-flex items-center gap-1"><Server className="h-3 w-3" />中转节点</span>
        <span className="inline-flex items-center gap-1"><Route className="h-3 w-3" />落地 / 最终目标</span>
        <span className="inline-flex items-center gap-1"><ArrowRight className="h-3 w-3" />曲线箭头为实际转发方向</span>
        <span className="ml-auto">纯展示：不修改规则、不下发 Agent、不切换链路。</span>
      </div>

      <LinkQualityDialog target={qualityTarget} open={!!qualityTarget} onOpenChange={(open) => !open && setQualityTarget(null)} />
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
