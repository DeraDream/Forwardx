import { useMemo, useState } from "react";
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
import { getTunnelHopIds } from "@/lib/tunnelDisplay";
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

function enabledMember(member: any) {
  return member?.isEnabled !== false && Number(member?.isEnabled ?? 1) !== 0;
}

function uniqNumbers(values: number[]) {
  const result: number[] = [];
  for (const value of values) {
    if (value > 0 && !result.includes(value)) result.push(value);
  }
  return result;
}

function expandMemberHostIds(member: any, tunnelById: Map<number, any>) {
  if (!enabledMember(member)) return [] as number[];
  if (String(member?.memberType || "host") === "tunnel") {
    const tunnel = tunnelById.get(Number(member?.tunnelId || 0));
    return uniqNumbers(getTunnelHopIds(tunnel));
  }
  const hostId = Number(member?.hostId || 0);
  return hostId > 0 ? [hostId] : [];
}

function groupPhysicalVariants(group: any, groupById: Map<number, any>, tunnelById: Map<number, any>) {
  if (!group) return [] as number[][];
  const mode = normalizeGroupMode(group);
  const members = (Array.isArray(group?.members) ? group.members : [])
    .filter(enabledMember)
    .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0));

  if (mode === "chain") {
    const orderedChain = members.flatMap((member: any) => expandMemberHostIds(member, tunnelById));
    const entryGroup = Number(group?.entryGroupId || 0) > 0
      ? groupById.get(Number(group.entryGroupId))
      : null;
    const entryMembers = (Array.isArray(entryGroup?.members) ? entryGroup.members : [])
      .filter(enabledMember)
      .sort((a: any, b: any) => Number(a?.priority || 0) - Number(b?.priority || 0));

    if (entryMembers.length > 0) {
      return entryMembers
        .map((member: any) => [...expandMemberHostIds(member, tunnelById), ...orderedChain])
        .map(uniqNumbers)
        .filter((ids: number[]) => ids.length > 0);
    }

    return orderedChain.length > 0 ? [uniqNumbers(orderedChain)] : [];
  }

  // 端口转发、转发组、入口组、出口组的成员是并列候选，不应画成串联链路。
  return members
    .map((member: any) => uniqNumbers(expandMemberHostIds(member, tunnelById)))
    .filter((ids: number[]) => ids.length > 0);
}

function directRuleVariants(rule: any, groupById: Map<number, any>, tunnelById: Map<number, any>) {
  const group = Number(rule?.forwardGroupId || 0) > 0 ? groupById.get(Number(rule.forwardGroupId)) : null;
  if (group) {
    const variants = groupPhysicalVariants(group, groupById, tunnelById);
    if (variants.length > 0) return variants;
  }

  const tunnel = Number(rule?.tunnelId || 0) > 0 ? tunnelById.get(Number(rule.tunnelId)) : null;
  if (tunnel) {
    const ids = uniqNumbers(getTunnelHopIds(tunnel));
    if (ids.length > 0) return [ids];
  }

  const hostId = Number(rule?.hostId || 0);
  return hostId > 0 ? [[hostId]] : [[]];
}

function buildPhysicalPaths(
  rules: any[],
  hosts: any[],
  tunnels: any[],
  groups: any[],
  landings: any[],
  fullChains: any[],
  category: TopologyCategory,
  search: string,
) {
  const hostById = new Map<number, any>(hosts.map((host: any) => [Number(host.id), host]));
  const tunnelById = new Map<number, any>(tunnels.map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const groupById = new Map<number, any>(groups.map((group: any) => [Number(group.id), group]));
  const landingById = new Map<number, any>(landings.map((landing: any) => [Number(landing.id), landing]));
  const ruleById = new Map<number, any>(rules.map((rule: any) => [Number(rule.id), rule]));
  const query = search.trim().toLowerCase();

  const makeRelay = (pathId: string, hostId: number, index: number): PhysicalNode => {
    const host = hostById.get(hostId);
    return {
      id: pathId + ":relay:" + index + ":" + hostId,
      kind: "relay",
      label: String(host?.name || "主机 #" + hostId),
      subtitle: hostAddress(host),
      detail: "中转节点",
      online: host?.isOnline !== false,
    };
  };

  const makeLandingForRule = (pathId: string, rule: any): PhysicalNode => {
    const landing = Number(rule?.targetLandingServiceId || 0) > 0
      ? landingById.get(Number(rule.targetLandingServiceId))
      : null;
    if (landing) {
      return {
        id: pathId + ":landing:ss:" + Number(landing.id),
        kind: "landing",
        label: String(landing.name || "落地 SS #" + landing.id),
        subtitle: String(landing.endpoint || landing.host?.exitIp || landing.host?.ip || landing.targetIp || ""),
        detail: landing.port ? "SS · " + String(landing.port) : "落地 SS",
        online: landing?.host?.isOnline !== false,
      };
    }
    const targetIp = String(rule?.targetIp || "未知目标");
    const targetPort = Number(rule?.targetPort || 0);
    return {
      id: pathId + ":landing:target:" + targetIp + ":" + targetPort,
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
    if (ruleId > 0 && visited.has(ruleId)) {
      return directRuleVariants(rule, groupById, tunnelById).map((hostIds, index) => ({
        hostIds,
        landing: makeLandingForRule("cycle:" + ruleId + ":" + index, rule),
      }));
    }

    const nextVisited = new Set(visited);
    if (ruleId > 0) nextVisited.add(ruleId);
    const currentVariants = directRuleVariants(rule, groupById, tunnelById);
    const targetRuleId = Number(rule?.targetRuleId || 0);
    const referenced = targetRuleId > 0 ? ruleById.get(targetRuleId) : null;

    if (!referenced) {
      return currentVariants.map((hostIds, index) => ({
        hostIds,
        landing: makeLandingForRule("rule:" + ruleId + ":" + index, rule),
      }));
    }

    const nested = resolveRuleTail(referenced, nextVisited);
    const result: Array<{ hostIds: number[]; landing: PhysicalNode }> = [];
    for (const current of currentVariants) {
      for (const tail of nested) {
        result.push({
          hostIds: uniqNumbers([...current, ...tail.hostIds]),
          landing: tail.landing,
        });
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
      const firstHost = tail.hostIds.length > 0 ? hostById.get(tail.hostIds[0]) : null;
      const entrySubtitleParts = [
        firstHost?.name ? String(firstHost.name) : "",
        Number(rule?.sourcePort || 0) > 0 ? ":" + Number(rule.sourcePort) : "",
      ].filter(Boolean);

      const entry: PhysicalNode = {
        id: pathId + ":entry",
        kind: "entry",
        label: String(rule?.name || "规则 #" + rule.id),
        subtitle: entrySubtitleParts.join(" "),
        detail: categoryLabel(currentCategory),
        online: firstHost ? firstHost.isOnline !== false : null,
        qualityTarget: {
          scope: "rule",
          id: Number(rule.id),
          name: String(rule?.name || "规则 #" + rule.id),
          subtitle: "该入口规则的历史链路质量",
        },
      };

      const relayHostIds = tail.hostIds;
      const relays = relayHostIds.map((hostId, index) => makeRelay(pathId, hostId, index));
      const landing = { ...tail.landing, id: pathId + ":landing" };

      const haystack = [
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
      const expandedHostIds: number[] = [];
      for (const node of Array.isArray(chain?.nodes) ? chain.nodes : []) {
        if (String(node?.nodeType || "host") === "forward-chain" && Number(node?.forwardGroupId || 0) > 0) {
          const group = groupById.get(Number(node.forwardGroupId));
          const variants = groupPhysicalVariants(group, groupById, tunnelById);
          if (variants.length > 0) expandedHostIds.push(...variants[0]);
        } else {
          const hostId = Number(node?.hostId || 0);
          if (hostId > 0) expandedHostIds.push(hostId);
        }
      }

      const hostIds = uniqNumbers(expandedHostIds);
      if (hostIds.length === 0) continue;
      const pathId = "fullchain:" + Number(chain.id);
      const entryHost = hostById.get(hostIds[0]);
      const landingHostId = hostIds[hostIds.length - 1];
      const landingHost = hostById.get(landingHostId);
      const middleHostIds = hostIds.slice(1, -1);

      const entry: PhysicalNode = {
        id: pathId + ":entry",
        kind: "entry",
        label: String(entryHost?.name || chain?.name || "全链路 #" + chain.id),
        subtitle: String(chain?.name || "全链路") + (Number(chain?.port || 0) > 0 ? " · :" + Number(chain.port) : ""),
        detail: "全链路入口",
        online: entryHost?.isOnline !== false,
        qualityTarget: {
          scope: "full-chain",
          id: Number(chain.id),
          name: String(chain?.name || "全链路 #" + chain.id),
          subtitle: "该全链路的历史探测质量",
        },
      };

      const relays = middleHostIds.map((hostId, index) => makeRelay(pathId, hostId, index));
      const landing: PhysicalNode = {
        id: pathId + ":landing",
        kind: "landing",
        label: String(landingHost?.name || "落地主机 #" + landingHostId),
        subtitle: hostAddress(landingHost),
        detail: "落地 SS",
        online: landingHost?.isOnline !== false,
      };

      const haystack = [
        entry.label,
        entry.subtitle,
        ...relays.flatMap((node) => [node.label, node.subtitle]),
        landing.label,
        landing.subtitle,
      ].join(" ").toLowerCase();
      if (query && !haystack.includes(query)) continue;

      paths.push({
        id: pathId,
        name: String(chain?.name || "全链路 #" + chain.id),
        category: "fullchain",
        entry,
        relays,
        landing,
      });
    }
  }

  return paths;
}

function buildGraph(paths: PhysicalPath[]) {
  const maxRelays = Math.max(0, ...paths.map((path) => path.relays.length));
  const landingColumn = maxRelays + 1;
  const nodes: PositionedNode[] = [];
  const edges: TopologyEdge[] = [];
  const columns = new Map<number, PositionedNode[]>();

  const addNode = (node: PhysicalNode, column: number) => {
    const positioned: PositionedNode = { ...node, column, row: 0 };
    const list = columns.get(column) || [];
    positioned.row = list.length;
    list.push(positioned);
    columns.set(column, list);
    nodes.push(positioned);
  };

  for (const path of paths) {
    addNode(path.entry, 0);
    path.relays.forEach((relay, index) => addNode(relay, index + 1));
    addNode(path.landing, landingColumn);

    const ordered = [path.entry, ...path.relays, path.landing];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      edges.push({
        id: path.id + ":edge:" + i,
        from: ordered[i].id,
        to: ordered[i + 1].id,
      });
    }
  }

  const xGap = 238;
  const yGap = 82;
  const xOffset = 32;
  const yOffset = 62;
  const nodeWidth = 188;
  const nodeHeight = 58;
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  let maxRows = 1;

  for (const [column, list] of columns) {
    maxRows = Math.max(maxRows, list.length);
    list.forEach((node, row) => {
      positions.set(node.id, {
        x: xOffset + column * xGap,
        y: yOffset + row * yGap,
        width: nodeWidth,
        height: nodeHeight,
      });
    });
  }

  return {
    nodes,
    edges,
    positions,
    maxRelays,
    landingColumn,
    width: Math.max(820, xOffset * 2 + landingColumn * xGap + nodeWidth),
    height: Math.max(440, yOffset + maxRows * yGap + 24),
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

  const paths = useMemo(
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

  const graph = useMemo(() => buildGraph(paths), [paths]);
  const selectedNode = selectedNodeId
    ? graph.nodes.find((node) => node.id === selectedNodeId) || null
    : null;
  const isLoading = rulesQuery.isLoading || hostsQuery.isLoading || tunnelsQuery.isLoading || groupsQuery.isLoading || landingQuery.isLoading || fullChainsQuery.isLoading;

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

  const relayCount = paths.reduce((sum, path) => sum + path.relays.length, 0);
  const landingCount = paths.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">网络拓扑</h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            只展示真实转发方向：入口 → 中转节点（0~N）→ 落地 / 最终目标。
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleRefresh()} disabled={isLoading}>
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">链路路径</div><div className="mt-1 text-xl font-semibold">{paths.length}</div></CardContent></Card>
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">入口</div><div className="mt-1 text-xl font-semibold">{paths.length}</div></CardContent></Card>
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
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索入口、节点或落地" className="h-8 pl-8 text-xs" />
        </div>
      </div>

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
          <Card className="overflow-hidden border-border/45 bg-card/45">
            <CardContent className="p-0">
              <div className="overflow-auto">
                <div className="relative" style={{ width: graph.width, height: graph.height }}>
                  <div
                    className="absolute left-0 top-0 h-11 border-b border-border/35 bg-muted/10"
                    style={{ width: graph.width }}
                  />
                  <div className="absolute left-8 top-3 text-xs font-medium text-muted-foreground">入口</div>
                  {Array.from({ length: graph.maxRelays }).map((_, index) => (
                    <div
                      key={"relay-title-" + index}
                      className="absolute top-3 text-xs font-medium text-muted-foreground"
                      style={{ left: 32 + (index + 1) * 238 }}
                    >
                      中转 {index + 1}
                    </div>
                  ))}
                  <div
                    className="absolute top-3 text-xs font-medium text-muted-foreground"
                    style={{ left: 32 + graph.landingColumn * 238 }}
                  >
                    落地 / 最终目标
                  </div>

                  <svg className="pointer-events-none absolute inset-0 h-full w-full" width={graph.width} height={graph.height}>
                    {graph.edges.map((edge) => {
                      const from = graph.positions.get(edge.from);
                      const to = graph.positions.get(edge.to);
                      if (!from || !to) return null;
                      const x1 = from.x + from.width;
                      const y1 = from.y + from.height / 2;
                      const x2 = to.x;
                      const y2 = to.y + to.height / 2;
                      const control = Math.max(42, (x2 - x1) * 0.42);
                      return (
                        <path
                          key={edge.id}
                          d={"M " + x1 + " " + y1 + " C " + (x1 + control) + " " + y1 + ", " + (x2 - control) + " " + y2 + ", " + x2 + " " + y2}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="text-border"
                          opacity="0.9"
                        />
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
                        onClick={() => setSelectedNodeId(node.id)}
                        className={cn(
                          "absolute flex flex-col justify-center rounded-lg border px-3 py-2 text-left shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:shadow-md",
                          nodeTone(node),
                          selected && "ring-2 ring-primary/35",
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
            </CardContent>
          </Card>

          <Card className="h-fit border-border/45 bg-card/60 xl:sticky xl:top-4">
            <CardContent className="space-y-4 p-4">
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
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">链路角色</span><span>{selectedNode.kind === "entry" ? "入口" : selectedNode.kind === "relay" ? "中转" : "落地 / 最终目标"}</span></div>
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">说明</span><span className="text-right">{selectedNode.detail || "—"}</span></div>
                    {selectedNode.online != null && (
                      <div className="flex justify-between gap-2">
                        <span className="text-muted-foreground">在线状态</span>
                        <Badge variant="outline" className={cn("h-5 text-[10px]", selectedNode.online ? "border-emerald-500/30 text-emerald-600" : "border-destructive/30 text-destructive")}>
                          {selectedNode.online ? "在线" : "离线"}
                        </Badge>
                      </div>
                    )}
                  </div>
                  {selectedNode.qualityTarget && (
                    <Button variant="outline" className="w-full gap-2" onClick={() => setQualityTarget(selectedNode.qualityTarget || null)}>
                      <Activity className="h-4 w-4" />
                      查看链路质量
                    </Button>
                  )}
                </>
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center text-center">
                  <Layers3 className="h-7 w-7 text-muted-foreground" />
                  <div className="mt-2 text-sm font-medium">选择一个链路节点</div>
                  <p className="mt-1 text-xs text-muted-foreground">拓扑现在只表达真实方向，不再把规则资源对象混进物理路径。</p>
                </div>
              )}
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
