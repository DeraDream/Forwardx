import { useEffect, useMemo, useRef, useState } from "react";
import { topologyPathEdgeIds } from "./networkTopologyPaths";
import { topologyRuleHref } from "./topologyRuleLink";
import { improveTopologyOrder } from "./topologyLayout";
import { routeTopologyGraph, topologyRoutePath } from "./topologyRouting";
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
  ): Array<{ hostIds: number[]; landing: PhysicalNode }> => {
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
      }));
    }

    const nested = resolveRuleTail(referenced, nextVisited);
    const result: Array<{ hostIds: number[]; landing: PhysicalNode }> = [];
    for (const current of currentVariants) {
      for (const tail of nested) {
        const hostIds = joinTopologyHostPaths(current, tail.hostIds);
        if (!hostIds) { state.incomplete = true; continue; }
        if (result.length >= MAX_TOPOLOGY_VARIANTS) { state.truncated = true; return result; }
        result.push({ hostIds, landing: tail.landing });
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
      if (chain?.status === "draft" && chain?.isEnabled === false) continue;
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

  const maxColumn = Math.max(landingColumn, ...Array.from(columns.keys()));
  const routed = routeTopologyGraph(positionedNodes, edges, directOnlySinkIds);
  return {
    nodes: positionedNodes,
    edges,
    ...routed,
    maxRelays: Math.max(0, maxColumn - 1),
    landingColumn: maxColumn,
  };
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

function NetworkTopologyContent() {
  const [category, setCategory] = useState<TopologyCategory>("all");
  const [search, setSearch] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // null means the first available entry; "all" explicitly shows the full graph.
  const [entryFilter, setEntryFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"paths" | "graph">("paths");
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pathRowRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [showMinimap, setShowMinimap] = useState(false);
  const [qualityTarget, setQualityTarget] = useState<LinkQualityTarget | null>(null);

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
  const graph = useMemo(() => buildGraph(visiblePaths), [visiblePaths]);
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
    const height = Math.max(240, Math.min(window.innerHeight * 0.65, 600));
    // Keep labels readable by default; users can still choose a full overview.
    const minimumReadableZoom = window.innerWidth < 640 ? 0.6 : 0.7;
    const nextZoom = Math.min(1, Math.max(minimumReadableZoom, Math.min(width / canvasWidth, height / canvasHeight)));
    setZoom(nextZoom);
    const frame = requestAnimationFrame(() => canvas.scrollTo({ left: 0, top: Math.max(0, graph.centerY * nextZoom - height / 2) }));
    return () => cancelAnimationFrame(frame);
  }, [activeEntry, canvasHeight, canvasWidth, category, graph.centerY, graph.nodes.length, isLoading, viewMode]);

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
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => { setSearch(event.target.value); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); setEntryFilter("all"); }} placeholder="搜索规则、入口、节点或落地" className="h-8 pl-8 text-xs" />
        </div>
      </div>

      {[rulesQuery, hostsQuery, tunnelsQuery, groupsQuery, landingQuery, fullChainsQuery].some((query) => query.isError) && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">部分拓扑数据加载失败，当前图和影响范围可能不完整，请刷新后重试。</div>
      )}
      {!isLoading && (topology.incomplete || topology.truncated) && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
        {topology.incomplete && "部分资源缺失、受权限限制或路径存在循环，无法安全展开；未绘制无法确认的路径。"}
        {topology.truncated && ` 候选组合过多，单项最多显示 ${MAX_TOPOLOGY_VARIANTS} 条；请筛选或查看原始规则。`}
      </div>}

      {!isLoading && entryGroups.length > 0 && (
        <Card className="border-border/45 bg-card/45">
          <CardContent className="space-y-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">按入口查看</span>
              <Button size="sm" variant={activeEntry === "all" ? "secondary" : "ghost"} onClick={() => { setEntryFilter("all"); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); }}>全部入口</Button>
              {entryGroups.map((group) => (
                <Button key={group.entry.id} size="sm" variant={activeEntry === group.entry.id ? "secondary" : "ghost"} onClick={() => { setEntryFilter(group.entry.id); setSelectedPathId(null); setSelectedNodeId(null); setSelectedEdgeId(null); }}>
                  {group.entry.label} <span className="ml-1 text-muted-foreground">({group.paths.length})</span>
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">默认只展示一个入口；展开路径列表并选择规则，可高亮其完整路径。统计按当前筛选的路径角色计算，同一主机可能兼任多个角色。</p>
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium text-muted-foreground">展示方式</span><Button size="sm" variant={viewMode === "paths" ? "secondary" : "outline"} onClick={() => setViewMode("paths")}>按路径分行</Button><Button size="sm" variant={viewMode === "graph" ? "secondary" : "outline"} onClick={() => setViewMode("graph")}>汇总拓扑</Button></div>
            {entryGroups.filter((group) => activeEntry === "all" || activeEntry === group.entry.id).map((group) => (
              <details key={group.entry.id} className="rounded-lg border border-border/45 bg-card/50">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{group.entry.label} · {group.paths.length} 条路径</summary>
                <div className="max-h-72 space-y-1 overflow-auto border-t border-border/40 p-2">
                  {group.paths.map((path) => (
                    <button key={path.id} type="button" onClick={() => { setEntryFilter(group.entry.id); setSelectedPathId(path.id); setSelectedNodeId(null); setSelectedEdgeId(null); requestAnimationFrame(() => (viewMode === "paths" ? pathRowRefs.current.get(path.id) : canvasRef.current)?.scrollIntoView({ behavior: "smooth", block: "nearest" })); }} className={cn("w-full rounded-md px-2 py-2 text-left text-xs hover:bg-accent", selectedPathId === path.id && "bg-accent ring-1 ring-primary/40")}>
                      <span className="font-medium">{path.name}</span> <span className="text-muted-foreground">· {categoryLabel(path.category)}</span>
                      <span className="mt-1 block break-words text-muted-foreground">{[path.entry, ...path.relays, path.landing].map((node) => node.label).join(" → ")}</span>
                    </button>
                  ))}
                </div>
              </details>
            ))}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <DataSectionLoading label="正在加载网络拓扑" />
      ) : graph.nodes.length === 0 ? (
        <Card className="border-dashed border-border/50 bg-card/40">
          <CardContent className="flex min-h-72 flex-col items-center justify-center gap-2 text-center">
            <Network className="h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">当前筛选没有可展示的物理链路</div>
            <div className="text-xs text-muted-foreground">调整类型或搜索条件后重试。</div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
          {viewMode === "paths" ? <Card className="overflow-hidden border-border/45 bg-card/45">
            <CardContent className="space-y-3 p-3">
              <p className="text-xs text-muted-foreground">每条路径独立一行；同一台主机可能重复显示，但不会新增主机或转发。点击节点或连线查看关联信息。</p>
              {visiblePaths.map((path) => {
                const nodes = [path.entry, ...path.relays, path.landing];
                return <div key={path.id} data-topology-path={path.id} ref={(element) => { if (element) pathRowRefs.current.set(path.id, element); else pathRowRefs.current.delete(path.id); }} className={cn("rounded-lg border border-border/45 bg-background/40 p-3", selectedPathId === path.id && "ring-2 ring-primary/40")}>
                  <button type="button" className="mb-2 max-w-full truncate text-left text-xs font-semibold hover:text-primary" onClick={() => { setSelectedPathId(path.id); setSelectedNodeId(null); setSelectedEdgeId(null); }}>{path.name} <span className="font-normal text-muted-foreground">· {categoryLabel(path.category)}</span></button>
                  <div className="overflow-x-auto pb-1"><div className="flex w-max items-center">
                    {nodes.map((node, index) => <div key={`${path.id}:${index}`} className="flex items-center">
                      {index > 0 && (nodes[index - 1].id === node.id ? <span className="w-14 shrink-0 text-center text-[10px] text-muted-foreground">本机</span> : <button type="button" data-path-edge={`${nodes[index - 1].id}=>${node.id}`} aria-label={`查看 ${nodes[index - 1].label} 到 ${node.label} 的关联路径`} onClick={() => { setSelectedPathId(path.id); setSelectedNodeId(null); setSelectedEdgeId(`${nodes[index - 1].id}=>${node.id}`); }} className="relative flex h-10 w-14 shrink-0 items-center justify-center text-muted-foreground hover:text-primary"><span className="h-px w-full bg-current" /><ArrowRight className="absolute right-0 h-3 w-3" /></button>)}
                      <button type="button" data-path-node={node.id} onClick={() => { setSelectedPathId(path.id); setSelectedNodeId(node.id); setSelectedEdgeId(null); }} className={cn("flex h-[58px] w-[188px] shrink-0 flex-col justify-center rounded-lg border px-3 text-left shadow-sm hover:shadow-md", nodeTone(node), selectedNodeId === node.id && "ring-2 ring-primary/40")}>
                        <span className="flex min-w-0 items-center gap-1.5"><span className="shrink-0 text-muted-foreground">{nodeIcon(node.kind)}</span><span className="truncate text-xs font-semibold">{node.label}</span>{node.online != null && <span className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", node.online ? "bg-emerald-500" : "bg-destructive")} />}</span>
                        <span className="mt-1 truncate text-[10px] text-muted-foreground">{node.subtitle || node.detail || "—"}</span>
                      </button>
                    </div>)}
                  </div></div>
                </div>;
              })}
            </CardContent>
          </Card> : <Card className="overflow-hidden border-border/45 bg-card/45">
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center gap-2 border-b border-border/40 p-2">
                <span className="mr-auto text-xs text-muted-foreground">{activeEntry === "all" ? "全部入口" : entryGroups.find((group) => group.entry.id === activeEntry)?.entry.label} · {visiblePaths.length} 条路径</span>
                {selectedPath && <Button size="sm" variant="ghost" onClick={() => setSelectedPathId(null)}>取消高亮</Button>}
                <Button size="sm" variant="outline" aria-label="缩小拓扑" onClick={() => setZoom((value) => Math.max(0.2, Math.round((value - 0.1) * 10) / 10))}>−</Button>
                <Button size="sm" variant="ghost" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
                <Button size="sm" variant="outline" aria-label="放大拓扑" onClick={() => setZoom((value) => Math.min(1.5, Math.round((value + 0.1) * 10) / 10))}>＋</Button>
                <Button size="sm" variant="outline" onClick={() => setZoom(Math.min(1, Math.max(0.2, (canvasRef.current?.clientWidth || canvasWidth) / canvasWidth)))}>适应宽度</Button>
                <Button size="sm" variant="outline" onClick={() => { const canvas = canvasRef.current; if (!canvas) return; setZoom(Math.min(1, Math.max(0.2, Math.min(canvas.clientWidth / canvasWidth, Math.max(240, Math.min(window.innerHeight * 0.65, 600)) / canvasHeight)))); canvas.scrollTo({ left: 0, top: 0 }); }}>适应画布</Button>
                <Button size="sm" variant="outline" onClick={() => setShowMinimap((value) => !value)}>{showMinimap ? "隐藏小地图" : "小地图"}</Button>
                {selectedNode && <Button size="sm" variant="outline" onClick={() => focusNode(selectedNode.id)}>定位选中节点</Button>}
              </div>
              {showMinimap && <div className="border-b border-border/40 p-2"><svg role="img" aria-label="拓扑小地图，点击可移动画布" viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} className="h-28 w-full max-w-[240px] cursor-crosshair rounded border border-border/50 bg-muted/20" onClick={(event) => {
                const canvas = canvasRef.current, bounds = event.currentTarget.getBoundingClientRect();
                if (!canvas || !bounds.width || !bounds.height) return;
                const scale = Math.min(bounds.width / canvasWidth, bounds.height / canvasHeight);
                const offsetX = (bounds.width - canvasWidth * scale) / 2, offsetY = (bounds.height - canvasHeight * scale) / 2;
                const x = (event.clientX - bounds.left - offsetX) / scale, y = (event.clientY - bounds.top - offsetY) / scale;
                canvas.scrollTo({ left: Math.max(0, x * zoom - canvas.clientWidth / 2), top: Math.max(0, y * zoom - canvas.clientHeight / 2), behavior: "smooth" });
              }}>
                {graph.edges.map((edge) => { const points = graph.edgeRoutes.get(edge.id); return points ? <path key={edge.id} d={topologyRoutePath(points)} fill="none" stroke="currentColor" strokeWidth="3" className="text-muted-foreground" /> : null; })}
                {graph.nodes.map((node) => { const pos = graph.positions.get(node.id); return pos ? <rect key={node.id} x={pos.x} y={pos.y} width={pos.width} height={pos.height} rx="6" fill="currentColor" className={selectedNodeId === node.id || highlightedNodes.has(node.id) ? "text-primary" : "text-muted-foreground/50"} /> : null; })}
              </svg><p className="mt-1 text-[10px] text-muted-foreground">点击小地图移动画布；鼠标可拖动画布，触屏可直接滑动。</p></div>}
              <div ref={canvasRef} className="max-h-[70vh] cursor-grab overflow-auto active:cursor-grabbing" onPointerDown={(event) => {
                if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as Element).closest("button, a, [role=button]")) return;
                const canvas = event.currentTarget; dragRef.current = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
                canvas.setPointerCapture(event.pointerId);
              }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag) return; event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x); event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y); }}
                onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
                <div style={{ width: canvasWidth * zoom, height: canvasHeight * zoom }}>
                <div className="relative origin-top-left" style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${zoom})` }}>
                <div className="absolute top-0" style={{ left: 0, width: graph.width, height: graph.height }}>
                  <div
                    className="absolute left-0 top-0 h-11 border-b border-border/35 bg-muted/10"
                    style={{ width: graph.width }}
                  />
                  <div className="absolute top-3 text-xs font-medium text-muted-foreground" style={{ left: graph.columnX.get(0) }}>入口</div>
                  {Array.from({ length: graph.maxRelays }).map((_, index) => (
                    <div
                      key={"relay-title-" + index}
                      className="absolute top-3 text-xs font-medium text-muted-foreground"
                      style={{ left: graph.columnX.get(index + 1) }}
                    >
                      中转 {index + 1}
                    </div>
                  ))}
                  <div
                    className="absolute top-3 text-xs font-medium text-muted-foreground"
                    style={{ left: graph.columnX.get(graph.landingColumn) }}
                  >
                    落地 / 最终目标
                  </div>

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
                          <path data-topology-edge={edge.id} d={path} fill="none" stroke="transparent" strokeWidth="10" style={{ pointerEvents: "stroke", cursor: "pointer" }}
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
          </Card>}

          <Card className="h-fit border-border/45 bg-card/60 xl:sticky xl:top-4">
            <CardContent className="space-y-4 p-4">
              {selectedEdge && !selectedNode && (
                <div className="space-y-2 border-b border-border/40 pb-3 text-xs">
                  <div className="text-sm font-semibold">连线关联</div>
                  <div className="break-words">{graph.nodes.find((node) => node.id === selectedEdge.from)?.label} → {graph.nodes.find((node) => node.id === selectedEdge.to)?.label}</div>
                  <p className="text-muted-foreground">当前筛选下 {edgePaths.length} 条配置路径经过此方向。相同主机间可能存在不同端口或规则，连线已合并，不代表单条连接。</p>
                  <div className="max-h-40 space-y-1 overflow-auto">{edgePaths.map((path) => <button key={path.id} type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-accent" onClick={() => { setEntryFilter(path.entry.id); setSelectedPathId(path.id); setSelectedEdgeId(null); }}>{path.name} · {categoryLabel(path.category)}</button>)}</div>
                  <p className="text-muted-foreground">连线可用性：未单独验证</p>
                </div>
              )}
              {selectedPath && !selectedNode && !selectedEdge && (
                <div className="space-y-2 border-b border-border/40 pb-3 text-xs">
                  <div className="text-sm font-semibold">{selectedPath.name}</div>
                  <div className="text-muted-foreground">{categoryLabel(selectedPath.category)} · 配置路径</div>
                  <div className="break-words leading-6">{[selectedPath.entry, ...selectedPath.relays, selectedPath.landing].map((node) => node.label).join(" → ")}</div>
                  {selectedRule && <div className="space-y-1 text-muted-foreground"><div>规则协议：{String(selectedRule.protocol || "未知").toUpperCase()}</div><div>入口端口：{selectedRule.sourcePort || "未知"}</div><div>规则目标：{selectedRule.targetIp || "未知"}{selectedRule.targetPort ? `:${selectedRule.targetPort}` : ""}</div></div>}
                  <p className="text-muted-foreground">路径根据面板配置生成，不代表端到端业务已验证。</p>
                  <a className="text-primary underline" href={selectedRule ? topologyRuleHref(Number(selectedRule.id)) : "/tunnels"}>打开{selectedRule ? "该转发规则" : "链路管理"}</a>
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
        <span className="inline-flex items-center gap-1"><ArrowRight className="h-3 w-3" />从左向右为实际转发方向</span>
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
