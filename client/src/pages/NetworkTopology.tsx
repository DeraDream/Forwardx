import { useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  GitBranch,
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

type TopologyCategory = "all" | "local" | "tunnel" | "chain" | "group";
type TopologyNodeKind = "rule" | "resource" | "host" | "landing" | "target";

type TopologyNode = {
  id: string;
  kind: TopologyNodeKind;
  label: string;
  subtitle?: string;
  detail?: string;
  online?: boolean | null;
  qualityTarget?: LinkQualityTarget | null;
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
];

function normalizeGroupMode(group: any) {
  const mode = String(group?.groupMode || "failover");
  return mode === "port" || mode === "chain" || mode === "entry" || mode === "exit" ? mode : "failover";
}

function ruleCategory(rule: any, groupById: Map<number, any>): Exclude<TopologyCategory, "all"> {
  const group = Number(rule?.forwardGroupId || 0) > 0 ? groupById.get(Number(rule.forwardGroupId)) : null;
  const mode = normalizeGroupMode(group);
  if (mode === "port") return "local";
  if (mode === "chain") return "chain";
  if (group) return "group";
  if (Number(rule?.tunnelId || 0) > 0) return "tunnel";
  return "local";
}

function nodeIcon(kind: TopologyNodeKind, className = "h-4 w-4") {
  if (kind === "host") return <Server className={className} />;
  if (kind === "landing") return <Route className={className} />;
  if (kind === "resource") return <GitBranch className={className} />;
  if (kind === "target") return <ArrowRight className={className} />;
  return <Waypoints className={className} />;
}

function nodeTone(node: TopologyNode) {
  if (node.kind === "host") {
    return node.online === false
      ? "border-destructive/40 bg-destructive/5"
      : "border-emerald-500/30 bg-emerald-500/5";
  }
  if (node.kind === "landing") return "border-chart-4/30 bg-chart-4/5";
  if (node.kind === "resource") return "border-primary/30 bg-primary/5";
  if (node.kind === "target") return "border-amber-500/30 bg-amber-500/5";
  return "border-border/55 bg-card/90";
}

function upsertNode(map: Map<string, TopologyNode>, node: TopologyNode) {
  const existing = map.get(node.id);
  if (!existing) {
    map.set(node.id, node);
    return;
  }
  map.set(node.id, {
    ...existing,
    ...node,
    qualityTarget: existing.qualityTarget || node.qualityTarget,
  });
}

function edgeKey(from: string, to: string) {
  return from + "=>" + to;
}

function buildTopology(
  rules: any[],
  hosts: any[],
  tunnels: any[],
  groups: any[],
  landings: any[],
  category: TopologyCategory,
  search: string,
) {
  const hostById = new Map<number, any>(hosts.map((host: any) => [Number(host.id), host]));
  const tunnelById = new Map<number, any>(tunnels.map((tunnel: any) => [Number(tunnel.id), tunnel]));
  const groupById = new Map<number, any>(groups.map((group: any) => [Number(group.id), group]));
  const landingById = new Map<number, any>(landings.map((landing: any) => [Number(landing.id), landing]));
  const query = search.trim().toLowerCase();

  const filteredRules = rules.filter((rule: any) => {
    const currentCategory = ruleCategory(rule, groupById);
    if (category !== "all" && currentCategory !== category) return false;
    if (!query) return true;
    const group = groupById.get(Number(rule.forwardGroupId || 0));
    const tunnel = tunnelById.get(Number(rule.tunnelId || 0));
    const haystack = [
      rule.name,
      rule.targetIp,
      rule.targetPort,
      rule.sourcePort,
      group?.name,
      tunnel?.name,
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  const nodes = new Map<string, TopologyNode>();
  const edges = new Map<string, TopologyEdge>();

  const addEdge = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    const id = edgeKey(from, to);
    if (!edges.has(id)) edges.set(id, { id, from, to });
  };

  const addHost = (hostId: number) => {
    if (!hostId) return "";
    const host = hostById.get(hostId);
    const id = "host:" + hostId;
    upsertNode(nodes, {
      id,
      kind: "host",
      label: String(host?.name || "主机 #" + hostId),
      subtitle: String(host?.entryIp || host?.ipv4 || host?.ip || ""),
      detail: host?.isOnline === false ? "离线" : "在线",
      online: host?.isOnline !== false,
    });
    return id;
  };

  const addGroupHosts = (group: any) => {
    const entryMembers = Array.isArray(group?.entryGroup?.members) ? group.entryGroup.members : [];
    const members = [...entryMembers, ...(Array.isArray(group?.members) ? group.members : [])]
      .filter((member: any) => member?.isEnabled !== false);
    const ids: number[] = [];
    for (const member of members) {
      if (String(member?.memberType || "host") === "tunnel" && Number(member?.tunnelId || 0) > 0) {
        const nestedTunnel = tunnelById.get(Number(member.tunnelId));
        for (const hostId of getTunnelHopIds(nestedTunnel)) {
          if (hostId > 0 && !ids.includes(hostId)) ids.push(hostId);
        }
      } else {
        const hostId = Number(member?.hostId || 0);
        if (hostId > 0 && !ids.includes(hostId)) ids.push(hostId);
      }
    }
    return ids;
  };

  for (const rule of filteredRules) {
    const categoryValue = ruleCategory(rule, groupById);
    const ruleId = "rule:" + Number(rule.id);
    upsertNode(nodes, {
      id: ruleId,
      kind: "rule",
      label: String(rule.name || "规则 #" + rule.id),
      subtitle: String(rule.sourcePort || "-") + " → " + String(rule.targetPort || "-"),
      detail: categoryOptions.find((item) => item.value === categoryValue)?.label || categoryValue,
      qualityTarget: {
        scope: "rule",
        id: Number(rule.id),
        name: String(rule.name || "规则 #" + rule.id),
        subtitle: "规则历史探测质量",
      },
    });

    let previous = ruleId;
    const group = Number(rule.forwardGroupId || 0) > 0 ? groupById.get(Number(rule.forwardGroupId)) : null;
    const tunnel = Number(rule.tunnelId || 0) > 0 ? tunnelById.get(Number(rule.tunnelId)) : null;

    if (group) {
      const groupId = "group:" + Number(group.id);
      const mode = normalizeGroupMode(group);
      upsertNode(nodes, {
        id: groupId,
        kind: "resource",
        label: String(group.name || "资源 #" + group.id),
        subtitle: mode === "chain" ? "转发链" : mode === "port" ? "端口转发" : "转发组",
        detail: String(group.forwardType || ""),
        qualityTarget: mode === "chain" ? {
          scope: "chain",
          id: Number(group.id),
          name: String(group.name || "转发链 #" + group.id),
          subtitle: "转发链历史逐跳聚合质量",
        } : null,
      });
      addEdge(previous, groupId);
      previous = groupId;

      const hostIds = addGroupHosts(group);
      for (const hostId of hostIds) {
        const next = addHost(hostId);
        if (next) {
          addEdge(previous, next);
          previous = next;
        }
      }
    } else if (tunnel) {
      const tunnelId = "tunnel:" + Number(tunnel.id);
      upsertNode(nodes, {
        id: tunnelId,
        kind: "resource",
        label: String(tunnel.name || "隧道 #" + tunnel.id),
        subtitle: "隧道",
        detail: String(tunnel.mode || ""),
        qualityTarget: {
          scope: "tunnel",
          id: Number(tunnel.id),
          name: String(tunnel.name || "隧道 #" + tunnel.id),
          subtitle: "隧道入口到出口历史质量",
        },
      });
      addEdge(previous, tunnelId);
      previous = tunnelId;
      for (const hostId of getTunnelHopIds(tunnel)) {
        const next = addHost(hostId);
        if (next) {
          addEdge(previous, next);
          previous = next;
        }
      }
    } else {
      const next = addHost(Number(rule.hostId || 0));
      if (next) {
        addEdge(previous, next);
        previous = next;
      }
    }

    const landing = Number(rule.targetLandingServiceId || 0) > 0
      ? landingById.get(Number(rule.targetLandingServiceId))
      : null;
    if (landing) {
      const landingId = "landing:" + Number(landing.id);
      upsertNode(nodes, {
        id: landingId,
        kind: "landing",
        label: String(landing.name || "落地 SS #" + landing.id),
        subtitle: String(landing.endpoint || landing.host?.exitIp || landing.host?.ip || landing.targetIp || ""),
        detail: landing.port ? String(landing.port) : "",
      });
      addEdge(previous, landingId);
    } else {
      const targetText = String(rule.targetIp || "未知目标") + ":" + String(rule.targetPort || "-");
      const targetId = "target:" + targetText;
      upsertNode(nodes, {
        id: targetId,
        kind: "target",
        label: String(rule.targetIp || "未知目标"),
        subtitle: String(rule.targetPort || "-"),
        detail: "最终目标",
      });
      addEdge(previous, targetId);
    }
  }

  return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()), ruleCount: filteredRules.length };
}

function layoutTopology(nodes: TopologyNode[], edges: TopologyEdge[]) {
  const depth = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < Math.max(1, nodes.length); pass++) {
    let changed = false;
    for (const edge of edges) {
      const fromDepth = depth.get(edge.from) || 0;
      const toDepth = depth.get(edge.to) || 0;
      const nextDepth = Math.min(7, fromDepth + 1);
      if (nextDepth > toDepth) {
        depth.set(edge.to, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, TopologyNode[]>();
  for (const node of nodes) {
    const d = depth.get(node.id) || 0;
    const list = columns.get(d) || [];
    list.push(node);
    columns.set(d, list);
  }

  const xGap = 238;
  const yGap = 82;
  const xOffset = 28;
  const yOffset = 30;
  const nodeWidth = 188;
  const nodeHeight = 58;
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  let maxRows = 1;
  let maxDepth = 0;

  for (const [d, list] of columns) {
    maxDepth = Math.max(maxDepth, d);
    maxRows = Math.max(maxRows, list.length);
    list
      .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"))
      .forEach((node, index) => {
        positions.set(node.id, {
          x: xOffset + d * xGap,
          y: yOffset + index * yGap,
          width: nodeWidth,
          height: nodeHeight,
        });
      });
  }

  return {
    positions,
    width: Math.max(760, xOffset * 2 + maxDepth * xGap + nodeWidth),
    height: Math.max(420, yOffset * 2 + maxRows * yGap),
  };
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

  const topology = useMemo(
    () => buildTopology(
      (rulesQuery.data || []) as any[],
      (hostsQuery.data || []) as any[],
      (tunnelsQuery.data || []) as any[],
      (groupsQuery.data || []) as any[],
      (landingQuery.data || []) as any[],
      category,
      search,
    ),
    [rulesQuery.data, hostsQuery.data, tunnelsQuery.data, groupsQuery.data, landingQuery.data, category, search],
  );
  const layout = useMemo(() => layoutTopology(topology.nodes, topology.edges), [topology]);
  const nodeById = useMemo(() => new Map(topology.nodes.map((node) => [node.id, node])), [topology.nodes]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) || null : null;
  const isLoading = rulesQuery.isLoading || hostsQuery.isLoading || tunnelsQuery.isLoading || groupsQuery.isLoading || landingQuery.isLoading;

  const handleRefresh = async () => {
    await Promise.all([
      rulesQuery.refetch(),
      hostsQuery.refetch(),
      tunnelsQuery.refetch(),
      groupsQuery.refetch(),
      landingQuery.refetch(),
    ]);
  };

  const hostCount = topology.nodes.filter((node) => node.kind === "host").length;
  const resourceCount = topology.nodes.filter((node) => node.kind === "resource").length;
  const targetCount = topology.nodes.filter((node) => node.kind === "target" || node.kind === "landing").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">网络拓扑</h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            全局只读观测视图：展示规则、链路资源、节点与最终目标的引用及流量路径。
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void handleRefresh()} disabled={isLoading}>
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">规则</div><div className="mt-1 text-xl font-semibold">{topology.ruleCount}</div></CardContent></Card>
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">链路资源</div><div className="mt-1 text-xl font-semibold">{resourceCount}</div></CardContent></Card>
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">节点</div><div className="mt-1 text-xl font-semibold">{hostCount}</div></CardContent></Card>
        <Card className="border-border/40 bg-card/60"><CardContent className="p-3"><div className="text-xs text-muted-foreground">出口目标</div><div className="mt-1 text-xl font-semibold">{targetCount}</div></CardContent></Card>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border/45 bg-card/45 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {categoryOptions.map((option) => (
            <Button
              key={option.value}
              variant={category === option.value ? "secondary" : "ghost"}
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={() => setCategory(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索规则、链路或目标" className="h-8 pl-8 text-xs" />
        </div>
      </div>

      {isLoading ? (
        <DataSectionLoading label="正在加载网络拓扑" />
      ) : topology.nodes.length === 0 ? (
        <Card className="border-dashed border-border/50 bg-card/40">
          <CardContent className="flex min-h-72 flex-col items-center justify-center gap-2 text-center">
            <Network className="h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">当前筛选没有可展示的链路</div>
            <div className="text-xs text-muted-foreground">调整类型或搜索条件后重试。</div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
          <Card className="overflow-hidden border-border/45 bg-card/45">
            <CardContent className="p-0">
              <div className="overflow-auto">
                <div className="relative" style={{ width: layout.width, height: layout.height }}>
                  <svg className="pointer-events-none absolute inset-0 h-full w-full" width={layout.width} height={layout.height}>
                    {topology.edges.map((edge) => {
                      const from = layout.positions.get(edge.from);
                      const to = layout.positions.get(edge.to);
                      if (!from || !to) return null;
                      const x1 = from.x + from.width;
                      const y1 = from.y + from.height / 2;
                      const x2 = to.x;
                      const y2 = to.y + to.height / 2;
                      const mid = x1 + Math.max(36, (x2 - x1) / 2);
                      return (
                        <path
                          key={edge.id}
                          d={"M " + x1 + " " + y1 + " C " + mid + " " + y1 + ", " + (x2 - Math.max(36, (x2 - x1) / 2)) + " " + y2 + ", " + x2 + " " + y2}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="text-border"
                          opacity="0.85"
                        />
                      );
                    })}
                  </svg>

                  {topology.nodes.map((node) => {
                    const pos = layout.positions.get(node.id);
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
                          <span className="shrink-0 text-muted-foreground">{nodeIcon(node.kind, "h-3.5 w-3.5")}</span>
                          <span className="truncate text-xs font-semibold">{node.label}</span>
                          {node.kind === "host" && (
                            <span className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", node.online === false ? "bg-destructive" : "bg-emerald-500")} />
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
                      <div className="mt-1 text-xs text-muted-foreground">{selectedNode.subtitle || "暂无附加地址信息"}</div>
                    </div>
                  </div>
                  <div className="space-y-2 border-t border-border/40 pt-3 text-xs">
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">类型</span><span>{selectedNode.kind === "rule" ? "规则" : selectedNode.kind === "host" ? "主机" : selectedNode.kind === "resource" ? "链路资源" : selectedNode.kind === "landing" ? "落地 SS" : "最终目标"}</span></div>
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">状态/说明</span><span className="text-right">{selectedNode.detail || "—"}</span></div>
                    {selectedNode.kind === "host" && <div className="flex justify-between gap-2"><span className="text-muted-foreground">在线状态</span><Badge variant="outline" className={cn("h-5 text-[10px]", selectedNode.online === false ? "border-destructive/30 text-destructive" : "border-emerald-500/30 text-emerald-600")}>{selectedNode.online === false ? "离线" : "在线"}</Badge></div>}
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
                  <div className="mt-2 text-sm font-medium">选择一个拓扑节点</div>
                  <p className="mt-1 text-xs text-muted-foreground">查看资源类型、在线状态以及可用的历史链路质量。</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Waypoints className="h-3 w-3" />规则</span>
        <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />链路资源</span>
        <span className="inline-flex items-center gap-1"><Server className="h-3 w-3" />主机节点</span>
        <span className="inline-flex items-center gap-1"><Route className="h-3 w-3" />落地 SS</span>
        <span className="inline-flex items-center gap-1"><ArrowRight className="h-3 w-3" />最终目标</span>
        <span className="ml-auto">本页面只读取现有配置与状态，不下发 Agent、不修改转发规则。</span>
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
