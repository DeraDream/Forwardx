import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import QRCode from "qrcode";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  Link2,
  ListPlus,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Trash2,
  Upload,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation, useSearch } from "wouter";

const formatLabels: Record<string, string> = {
  clash: "Clash",
  egern: "Egern",
  loon: "Loon",
  raw: "原始节点",
};
type NodeForm = {
  id?: number;
  name: string;
  protocol: "ss" | "ssr" | "vmess" | "vless";
  link: string;
  groupName: string;
  enabled: boolean;
  groupIds?: number[];
  configSubscriptionIds?: number[];
  nodeSubscriptionIds?: number[];
};
const emptyNode: NodeForm = {
  name: "",
  protocol: "ss",
  link: "",
  groupName: "",
  enabled: true,
};
type ProxySubscriptionTab = "nodes" | "subscriptions" | "nodeSubscriptions" | "templates";
const proxySubscriptionTabItems: readonly SlidingTabItem<ProxySubscriptionTab>[] = [
  { value: "nodes", label: "节点库", icon: Server },
  { value: "subscriptions", label: "订阅管理", icon: Link2 },
  { value: "nodeSubscriptions", label: "节点订阅", icon: ListPlus },
  { value: "templates", label: "模板管理", icon: FileCode2 },
];

export default function ProxySubscriptionsPage() {
  const [, setLocation] = useLocation();
  // `useLocation` only subscribes to pathname changes. The tabs change only
  // the query string, so use Wouter's search subscription to re-render after
  // every tab navigation.
  const search = useSearch();
  const tab = new URLSearchParams(search).get("tab") || "nodes";
  const setTab = (value: string) =>
    setLocation(`/proxy-subscriptions?tab=${value}`);
  const utils = trpc.useUtils();
  const refreshNodeData = () => {
    void utils.proxySubscriptions.nodes.invalidate();
    void utils.proxySubscriptions.nodePage.invalidate();
    void utils.proxySubscriptions.nodeGroups.invalidate();
    void utils.proxySubscriptions.subscriptions.invalidate();
    void utils.proxySubscriptions.nodeSubscriptions.invalidate();
  };
  const { data: nodes = [] } = trpc.proxySubscriptions.nodes.useQuery();
  const [nodePage, setNodePage] = useState(1);
  const [nodePageSize, setNodePageSize] = useState(20);
  const [nodeSearch, setNodeSearch] = useState("");
  const [nodeGroupFilter, setNodeGroupFilter] = useState<number | null>(null);
  const [nodeProtocolFilter, setNodeProtocolFilter] = useState<string>("");
  const [nodeEnabledFilter, setNodeEnabledFilter] = useState<"" | "enabled" | "disabled">("");
  const [nodeSort, setNodeSort] = useState<"sortOrder" | "name" | "createdAt">("sortOrder");
  const [nodeDirection, setNodeDirection] = useState<"asc" | "desc">("asc");
  const [selectedNodePageIds, setSelectedNodePageIds] = useState<number[]>([]);
  const [nodeExportEncoding, setNodeExportEncoding] = useState<"plain" | "base64">("plain");
  const { data: nodeGroups = [] } = trpc.proxySubscriptions.nodeGroups.useQuery();
  const { data: nodeIps = [] } = trpc.proxySubscriptions.nodeIps.useQuery();
  const nodePageQuery = trpc.proxySubscriptions.nodePage.useQuery({
    page: nodePage,
    pageSize: nodePageSize,
    groupId: nodeGroupFilter || undefined,
    search: nodeSearch,
    protocol: nodeProtocolFilter as any || undefined,
    enabled: nodeEnabledFilter === "" ? undefined : nodeEnabledFilter === "enabled",
    sort: nodeSort,
    direction: nodeDirection,
  });
  const pagedNodes = nodePageQuery.data?.items || [];
  const { data: subscriptions = [] } =
    trpc.proxySubscriptions.subscriptions.useQuery();
  const { data: nodeSubscriptions = [] } =
    trpc.proxySubscriptions.nodeSubscriptions.useQuery();
  const { data: templates = [] } = trpc.proxySubscriptions.templates.useQuery();
  const [nodeDialog, setNodeDialog] = useState<NodeForm | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importName, setImportName] = useState("");
  const [importGroupIds, setImportGroupIds] = useState<number[]>([]);
  const [importConfigSubscriptionIds, setImportConfigSubscriptionIds] = useState<number[]>([]);
  const [importNodeSubscriptionIds, setImportNodeSubscriptionIds] = useState<number[]>([]);
  const [importReplaceIpId, setImportReplaceIpId] = useState<number | null>(null);
  const [importDuplicateStrategy, setImportDuplicateStrategy] = useState<"skip" | "replace" | "allow">("skip");
  const [importNewGroupName, setImportNewGroupName] = useState("");
  const [templateDialog, setTemplateDialog] = useState<{ id?: number; filename: string; content: string } | null>(null);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<number[]>([]);
  const templateFileInput = useRef<HTMLInputElement>(null);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [generatedSubscription, setGeneratedSubscription] = useState<{ name: string; token: string; filename: string } | null>(null);
  const [nodeSubscriptionOpen, setNodeSubscriptionOpen] = useState(false);
  const [subscriptionName, setSubscriptionName] = useState("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<number[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [subscriptionStep, setSubscriptionStep] = useState(1);
  const [strategyGroups, setStrategyGroups] = useState<{ name: string; nodeIds: number[] }[]>([]);
  const { data: detectedStrategyGroups = [] } = trpc.proxySubscriptions.templateStrategyGroups.useQuery({ templateId: selectedTemplateId || 1 }, { enabled: !!selectedTemplateId });
  const [editingSubscription, setEditingSubscription] = useState<any>(null);
  const [editingNodeSubscription, setEditingNodeSubscription] =
    useState<any>(null);
  const [accessLimit, setAccessLimit] = useState(0);
  const [expiresAtText, setExpiresAtText] = useState("");
  const [revoked, setRevoked] = useState(false);
  const [qrSubscription, setQrSubscription] = useState<{
    name: string;
    url: string;
  } | null>(null);
  const [qrData, setQrData] = useState("");
  const [previewSubscription, setPreviewSubscription] = useState<{
    name: string;
    url: string;
  } | null>(null);
  const [previewContent, setPreviewContent] = useState("");
  const [logTarget, setLogTarget] = useState<{
    id: number;
    kind: "config" | "nodes";
    name: string;
  } | null>(null);
  const [ipLibraryOpen, setIpLibraryOpen] = useState(false);
  const [ipForm, setIpForm] = useState<{ id?: number; address: string; alias: string }>({ address: "", alias: "" });
  const [groupLibraryOpen, setGroupLibraryOpen] = useState(false);
  const [groupForm, setGroupForm] = useState<{ id?: number; name: string }>({ name: "" });
  const [deleteNodeIds, setDeleteNodeIds] = useState<number[] | null>(null);
  const { data: accessLogs = [] } = trpc.proxySubscriptions.accessLogs.useQuery(
    {
      subscriptionId: logTarget?.id || 1,
      subscriptionKind: logTarget?.kind || "config",
    },
    { enabled: !!logTarget },
  );
  const saveNode = trpc.proxySubscriptions.saveNode.useMutation({
    onSuccess: () => {
      refreshNodeData();
      setNodeDialog(null);
      toast.success("节点已保存");
    },
    onError: (e) => toast.error(e.message),
  });
  const importNodes = trpc.proxySubscriptions.importNodes.useMutation({
    onSuccess: (r) => {
      refreshNodeData();
      setImportOpen(false);
      setImportText("");
      setImportNewGroupName("");
      toast.success(
        `已导入 ${r.imported} 个节点${r.skipped ? `，跳过 ${r.skipped} 条` : ""}`,
      );
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteNode = trpc.proxySubscriptions.deleteNode.useMutation({ onSuccess: refreshNodeData });
  const bulkNodes = trpc.proxySubscriptions.bulkNodes.useMutation({ onSuccess: () => { refreshNodeData(); setSelectedNodePageIds([]); } });
  const moveNode = trpc.proxySubscriptions.moveNode.useMutation({ onSuccess: refreshNodeData, onError: (error) => toast.error(error.message) });
  const saveNodeIp = trpc.proxySubscriptions.saveNodeIp.useMutation({ onSuccess: () => { void utils.proxySubscriptions.nodeIps.invalidate(); setIpForm({ address: "", alias: "" }); } });
  const deleteNodeIp = trpc.proxySubscriptions.deleteNodeIp.useMutation({ onSuccess: () => void utils.proxySubscriptions.nodeIps.invalidate() });
  const saveNodeGroup = trpc.proxySubscriptions.saveNodeGroup.useMutation({ onSuccess: () => { refreshNodeData(); setGroupForm({ name: "" }); } });
  const deleteNodeGroup = trpc.proxySubscriptions.deleteNodeGroup.useMutation({ onSuccess: refreshNodeData });
  const exportNodes = trpc.proxySubscriptions.exportNodes.useQuery({ ids: selectedNodePageIds, encoding: nodeExportEncoding }, { enabled: false });
  const { data: importInspection = [] } = trpc.proxySubscriptions.inspectImportNodes.useQuery({ links: importText, replaceAddress: nodeIps.find((item: any) => item.id === importReplaceIpId)?.address }, { enabled: importOpen && !!importText.trim() });
  const { data: deleteImpact = [] } = trpc.proxySubscriptions.nodeImpact.useQuery({ ids: deleteNodeIds || [] }, { enabled: !!deleteNodeIds?.length });
  const clearSubscriptionForm = () => {
    setSubscriptionName("");
    setSelectedNodeIds([]);
    setSelectedTemplateId(null);
    setSubscriptionStep(1);
    setStrategyGroups([]);
    setAccessLimit(0);
    setExpiresAtText("");
    setRevoked(false);
    setEditingSubscription(null);
    setEditingNodeSubscription(null);
  };
  const saveSubscription = trpc.proxySubscriptions.saveSubscription.useMutation(
    {
      onSuccess: (result) => {
        utils.proxySubscriptions.subscriptions.invalidate();
        setSubscriptionOpen(false);
        if (result.token) setGeneratedSubscription({ name: subscriptionName, token: result.token, filename: result.filename });
        clearSubscriptionForm();
        toast.success("订阅已保存");
      },
      onError: (e) => toast.error(e.message),
    },
  );
  const saveNodeSubscription =
    trpc.proxySubscriptions.saveNodeSubscription.useMutation({
      onSuccess: () => {
        utils.proxySubscriptions.nodeSubscriptions.invalidate();
        setNodeSubscriptionOpen(false);
        clearSubscriptionForm();
        toast.success("节点订阅已保存");
      },
      onError: (e) => toast.error(e.message),
    });
  const deleteSubscription =
    trpc.proxySubscriptions.deleteSubscription.useMutation({
      onSuccess: () => utils.proxySubscriptions.subscriptions.invalidate(),
    });
  const deleteNodeSubscription =
    trpc.proxySubscriptions.deleteNodeSubscription.useMutation({
      onSuccess: () => utils.proxySubscriptions.nodeSubscriptions.invalidate(),
    });
  const rotateToken = trpc.proxySubscriptions.rotateToken.useMutation({
    onSuccess: () => {
      utils.proxySubscriptions.subscriptions.invalidate();
      toast.success("订阅令牌已轮换");
    },
  });
  const rotateNodeToken =
    trpc.proxySubscriptions.rotateNodeSubscriptionToken.useMutation({
      onSuccess: () => {
        utils.proxySubscriptions.nodeSubscriptions.invalidate();
        toast.success("订阅令牌已轮换");
      },
    });
  const resetAccessCount = trpc.proxySubscriptions.resetAccessCount.useMutation(
    { onSuccess: () => utils.proxySubscriptions.subscriptions.invalidate() },
  );
  const resetNodeAccessCount =
    trpc.proxySubscriptions.resetNodeSubscriptionAccessCount.useMutation({
      onSuccess: () => utils.proxySubscriptions.nodeSubscriptions.invalidate(),
    });
  const setSubscriptionRevoked =
    trpc.proxySubscriptions.setSubscriptionRevoked.useMutation({
      onSuccess: () => utils.proxySubscriptions.subscriptions.invalidate(),
    });
  const setNodeSubscriptionRevoked =
    trpc.proxySubscriptions.setNodeSubscriptionRevoked.useMutation({
      onSuccess: () => utils.proxySubscriptions.nodeSubscriptions.invalidate(),
    });
  const saveTemplate = trpc.proxySubscriptions.saveTemplate.useMutation({
    onSuccess: () => {
      utils.proxySubscriptions.templates.invalidate();
      setTemplateDialog(null);
      toast.success("模板已保存");
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteTemplate = trpc.proxySubscriptions.deleteTemplate.useMutation({ onSuccess: (_result, input) => { void utils.proxySubscriptions.templates.invalidate(); setSelectedTemplateIds((current) => current.filter((id) => id !== input.id)); toast.success("模板已删除"); }, onError: (error) => toast.error(error.message) });
  const bulkDeleteTemplates = trpc.proxySubscriptions.bulkDeleteTemplates.useMutation({ onSuccess: () => { void utils.proxySubscriptions.templates.invalidate(); setSelectedTemplateIds([]); toast.success("已删除所选模板"); }, onError: (error) => toast.error(error.message) });
  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast.success("已复制");
  };
  const toggleNode = (id: number) =>
    setSelectedNodeIds((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id],
    );
  const openConfigSubscription = (sub?: any) => {
    setEditingSubscription(sub || null);
    setSubscriptionName(sub?.name || "");
    setSelectedNodeIds(sub?.nodeIds || []);
    setSelectedTemplateId(sub?.templateId || null);
    setStrategyGroups(sub?.strategyGroups || []);
    setSubscriptionStep(sub?.templateId ? 4 : 1);
    setAccessLimit(Number(sub?.accessLimit || 0));
    setExpiresAtText(
      sub?.expiresAt ? new Date(sub.expiresAt).toISOString().slice(0, 16) : "",
    );
    setRevoked(!!sub?.revoked);
    setSubscriptionOpen(true);
  };
  const openNodeSubscription = (sub?: any) => {
    setEditingNodeSubscription(sub || null);
    setSubscriptionName(sub?.name || "");
    setSelectedNodeIds(sub?.nodeIds || []);
    setAccessLimit(Number(sub?.accessLimit || 0));
    setExpiresAtText(
      sub?.expiresAt ? new Date(sub.expiresAt).toISOString().slice(0, 16) : "",
    );
    setRevoked(!!sub?.revoked);
    setNodeSubscriptionOpen(true);
  };
  useEffect(() => {
    if (!qrSubscription) {
      setQrData("");
      return;
    }
    void QRCode.toDataURL(qrSubscription.url, { width: 240, margin: 1 })
      .then(setQrData)
      .catch(() => setQrData(""));
  }, [qrSubscription]);
  useEffect(() => {
    let cancelled = false;
    if (!previewSubscription) {
      setPreviewContent("");
      return;
    }
    setPreviewContent("");
    void fetch(previewSubscription.url)
      .then((response) => response.ok ? response.text() : Promise.reject(new Error("订阅不可用")))
      .then((content) => { if (!cancelled) setPreviewContent(content); })
      .catch((error) => { if (!cancelled) setPreviewContent(`# ${error.message || "预览加载失败"}`); });
    return () => { cancelled = true; };
  }, [previewSubscription]);
  const download = (url: string, name: string, format = "yaml") => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name || "subscription"}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };
  const downloadNodeExport = async () => {
    const result = await exportNodes.refetch();
    if (!result.data) return;
    const blob = new Blob([result.data.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `proxy-nodes-${new Date().toISOString().slice(0, 10)}.${nodeExportEncoding === "base64" ? "base64.txt" : "txt"}`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    toast.success(`已导出 ${result.data.count} 个节点`);
  };
  const copySelectedNodes = async () => {
    const result = await exportNodes.refetch(); if (result.data) { await copy(result.data.content); toast.success(`已复制 ${result.data.count} 个节点`); }
  };
  return (
    <DashboardLayout>
      <main className="space-y-5 p-4 md:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">代理订阅</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理代理节点、公开订阅链接和客户端模板。
          </p>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          <SlidingTabsList
            items={proxySubscriptionTabItems}
            activeValue={tab as ProxySubscriptionTab}
            ariaLabel="代理订阅"
            minItemWidthRem={7.5}
          />
          <TabsContent value="nodes">
            <Card className="overflow-hidden">
              <CardHeader className="gap-4 space-y-0 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle>节点列表</CardTitle>
                  <CardDescription>
                    管理代理节点和分组，支持 SS、SSR、VLESS 与 VMess 链接。
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setGroupLibraryOpen(true)}>分组管理</Button>
                  <Button variant="outline" onClick={() => setIpLibraryOpen(true)}>IP 库</Button>
                  <Button variant="outline" onClick={() => setImportOpen(true)}>
                    <Upload className="mr-2 h-4 w-4" />
                    添加节点
                  </Button>
                  <select aria-label="导出格式" className="h-10 rounded-md border bg-background px-2 text-sm" value={nodeExportEncoding} onChange={(event) => setNodeExportEncoding(event.target.value as "plain" | "base64")}><option value="plain">纯链接</option><option value="base64">Base64</option></select>
                  <Button variant="outline" onClick={downloadNodeExport}>
                    <Download className="mr-2 h-4 w-4" />导出{selectedNodePageIds.length ? "所选" : "全部"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-1 overflow-x-auto border-b">
                  <Button variant={nodeGroupFilter === null ? "secondary" : "ghost"} size="sm" className="rounded-b-none" onClick={() => { setNodeGroupFilter(null); setNodePage(1); }}>全部 {nodePageQuery.data?.total ?? nodes.length}</Button>
                  {nodeGroups.map((group: any) => <Button key={group.id} variant={nodeGroupFilter === group.id ? "secondary" : "ghost"} size="sm" className="rounded-b-none" onClick={() => { setNodeGroupFilter(group.id); setNodePage(1); }}>{group.name} {group.nodeCount}</Button>)}
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]">
                  <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" value={nodeSearch} onChange={(event) => { setNodeSearch(event.target.value); setNodePage(1); }} placeholder="搜索名称、链接、服务器或分组" /></div>
                  <select className="h-10 rounded-md border bg-background px-3 text-sm" value={nodeProtocolFilter} onChange={(event) => { setNodeProtocolFilter(event.target.value); setNodePage(1); }}><option value="">所有协议</option>{["ss", "ssr", "vmess", "vless"].map((protocol) => <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>)}</select>
                  <select className="h-10 rounded-md border bg-background px-3 text-sm" value={nodeEnabledFilter} onChange={(event) => { setNodeEnabledFilter(event.target.value as any); setNodePage(1); }}><option value="">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></select>
                  <select className="h-10 rounded-md border bg-background px-3 text-sm" value={nodeSort} onChange={(event) => { setNodeSort(event.target.value as any); setNodePage(1); }}><option value="sortOrder">自定义排序</option><option value="name">节点名称</option><option value="createdAt">创建时间</option></select>
                  <Button variant="outline" onClick={() => { setNodeDirection((value) => value === "asc" ? "desc" : "asc"); }}><ArrowUpDown className="mr-2 h-4 w-4" />排序</Button>
                </div>
                {selectedNodePageIds.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm"><span>已选择 {selectedNodePageIds.length} 个节点</span><Button size="sm" variant="outline" onClick={copySelectedNodes}>复制所选</Button><Button size="sm" variant="outline" onClick={() => bulkNodes.mutate({ ids: selectedNodePageIds, action: "enable" })}>启用</Button><Button size="sm" variant="outline" onClick={() => bulkNodes.mutate({ ids: selectedNodePageIds, action: "disable" })}>停用</Button><Button size="sm" variant="destructive" onClick={() => setDeleteNodeIds(selectedNodePageIds)}>删除所选</Button><Button size="sm" variant="ghost" onClick={() => setSelectedNodePageIds([])}>取消选择</Button></div>}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"><input aria-label="选择当前页节点" type="checkbox" checked={pagedNodes.length > 0 && pagedNodes.every((node: any) => selectedNodePageIds.includes(node.id))} onChange={(event) => setSelectedNodePageIds(event.target.checked ? Array.from(new Set([...selectedNodePageIds, ...pagedNodes.map((node: any) => node.id)])) : selectedNodePageIds.filter((id) => !pagedNodes.some((node: any) => node.id === id)))} /></TableHead>
                      <TableHead>#</TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead>节点链接</TableHead>
                      <TableHead>创建时间</TableHead>
                      <TableHead>分组</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedNodes.map((node: any, index: number) => (
                      <TableRow key={node.id}>
                        <TableCell><input aria-label={`选择 ${node.name}`} type="checkbox" checked={selectedNodePageIds.includes(node.id)} onChange={() => setSelectedNodePageIds((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id])} /></TableCell>
                        <TableCell>{(nodePage - 1) * nodePageSize + index + 1}</TableCell>
                        <TableCell className="min-w-36 font-medium">{node.name} {!node.enabled && <Badge variant="secondary" className="ml-1">已禁用</Badge>}<div className="mt-1 text-xs text-muted-foreground">{String(node.protocol).toUpperCase()} · {node.server || "—"}{node.port ? `:${node.port}` : ""}</div></TableCell>
                        <TableCell className="max-w-80 font-mono text-xs text-muted-foreground"><button className="block max-w-full truncate text-left hover:text-foreground" title={node.link} onClick={() => copy(node.link)}>{node.link}</button></TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{node.createdAt ? new Date(Number(node.createdAt) * 1000).toLocaleString() : "—"}</TableCell>
                        <TableCell>{node.groups?.length ? node.groups.map((group: any) => <Badge key={group.id} variant="secondary" className="mr-1">{group.name}</Badge>) : "未分组"}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1"><Button variant="ghost" size="sm" onClick={() => setNodeDialog({ ...node, groupName: node.groupName || "" })}>编辑</Button><Button variant="ghost" size="sm" onClick={() => copy(node.link)}>复制</Button>{nodeSort === "sortOrder" && <><Button variant="ghost" size="icon" title="上移" disabled={index === 0} onClick={() => moveNode.mutate({ id: node.id, direction: "up" })}><ArrowUp className="h-4 w-4" /></Button><Button variant="ghost" size="icon" title="下移" disabled={index === pagedNodes.length - 1} onClick={() => moveNode.mutate({ id: node.id, direction: "down" })}><ArrowDown className="h-4 w-4" /></Button></>}<Button variant="ghost" size="sm" onClick={() => bulkNodes.mutate({ ids: [node.id], action: node.enabled ? "disable" : "enable" })}>{node.enabled ? "停用" : "恢复"}</Button><Button variant="ghost" size="icon" onClick={() => setDeleteNodeIds([node.id])}><Trash2 className="h-4 w-4 text-destructive" /></Button></div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!pagedNodes.length && (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          className="h-28 text-center text-muted-foreground"
                        >
                          尚无节点，粘贴订阅链接开始导入。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground"><span>共 {nodePageQuery.data?.total || 0} 个节点</span><select className="h-8 rounded-md border bg-background px-2" value={nodePageSize} onChange={(event) => { setNodePageSize(Number(event.target.value)); setNodePage(1); }}><option value="20">20/页</option><option value="50">50/页</option><option value="100">100/页</option></select><Button variant="outline" size="icon" disabled={nodePage <= 1} onClick={() => setNodePage((value) => value - 1)}><ChevronLeft className="h-4 w-4" /></Button><span>{nodePage}</span><Button variant="outline" size="icon" disabled={nodePage * nodePageSize >= (nodePageQuery.data?.total || 0)} onClick={() => setNodePage((value) => value + 1)}><ChevronRight className="h-4 w-4" /></Button></div>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="subscriptions">
            <div>
              <Card className="hidden">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle>配置订阅</CardTitle>
                    <CardDescription>
                      每个订阅绑定一个已创建模板，生成独立配置链接。
                    </CardDescription>
                  </div>
                  <Button onClick={() => openConfigSubscription()}>
                    <Plus className="mr-2 h-4 w-4" />
                    新建
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {subscriptions.map((sub: any) => (
                    <div key={sub.id} className="rounded-lg border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 font-medium">
                            {sub.name}
                            {sub.revoked && (
                              <Badge variant="destructive">已撤销</Badge>
                            )}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {sub.nodeIds.length} 个节点 · {sub.template?.filename || "旧版模板"} · 访问 {sub.accessCount}
                            {sub.accessLimit ? `/${sub.accessLimit}` : ""}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {(() => { const url = `${window.location.origin}/api/proxy-subscription/${sub.token}`; const isLoon = /loon/i.test(sub.template?.filename || ""); const isEgern = /egern/i.test(sub.template?.filename || ""); const importUrl = isEgern ? `egern://install-config?url=${encodeURIComponent(url)}` : isLoon ? `loon://import?sub=${encodeURIComponent(url)}` : ""; return <><Button size="sm" variant="outline" onClick={() => copy(url)}><Copy className="mr-1 h-3.5 w-3.5" />复制链接</Button><Button size="icon" variant="outline" title="预览配置" onClick={() => setPreviewSubscription({ name: sub.name, url })}><FileCode2 className="h-3.5 w-3.5" /></Button><Button size="icon" variant="outline" title="下载配置" onClick={() => download(url, sub.name, isLoon ? "conf" : "yaml")}><Upload className="h-3.5 w-3.5" /></Button>{importUrl && <Button size="icon" variant="outline" title="导入 App" onClick={() => { window.location.href = importUrl; }}><Link2 className="h-3.5 w-3.5" /></Button>}</>; })()}
                          <Button
                            size="icon"
                            variant="ghost"
                            title="编辑"
                            onClick={() => openConfigSubscription(sub)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="二维码"
                            onClick={() =>
                              setQrSubscription({
                                name: sub.name,
                                url: `${window.location.origin}/api/proxy-subscription/${sub.token}`,
                              })
                            }
                          >
                            <QrCode className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="访问日志"
                            onClick={() =>
                              setLogTarget({
                                id: sub.id,
                                kind: "config",
                                name: sub.name,
                              })
                            }
                          >
                            <ListPlus className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="重置访问计数"
                            onClick={() =>
                              resetAccessCount.mutate({ id: sub.id })
                            }
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="撤销/恢复"
                            onClick={() =>
                              setSubscriptionRevoked.mutate({
                                id: sub.id,
                                revoked: !sub.revoked,
                              })
                            }
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="重置令牌"
                            onClick={() => rotateToken.mutate({ id: sub.id })}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              deleteSubscription.mutate({ id: sub.id })
                            }
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!subscriptions.length && (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      尚未创建配置订阅。
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle>节点订阅</CardTitle>
                    <CardDescription>
                      输出 Base64 节点链接，供客户端自行识别。
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => openNodeSubscription()}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    新建
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {nodeSubscriptions.map((sub: any) => (
                    <div key={sub.id} className="rounded-lg border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 font-medium">
                            {sub.name}
                            {sub.revoked && (
                              <Badge variant="destructive">已撤销</Badge>
                            )}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {sub.nodeIds.length} 个节点 · 访问 {sub.accessCount}
                            {sub.accessLimit ? `/${sub.accessLimit}` : ""}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              copy(
                                `${window.location.origin}/api/proxy-node-subscription/${sub.token}`,
                              )
                            }
                          >
                            <Copy className="mr-1 h-3.5 w-3.5" />
                            复制链接
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="编辑"
                            onClick={() => openNodeSubscription(sub)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="二维码"
                            onClick={() =>
                              setQrSubscription({
                                name: sub.name,
                                url: `${window.location.origin}/api/proxy-node-subscription/${sub.token}`,
                              })
                            }
                          >
                            <QrCode className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="访问日志"
                            onClick={() =>
                              setLogTarget({
                                id: sub.id,
                                kind: "nodes",
                                name: sub.name,
                              })
                            }
                          >
                            <ListPlus className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="重置访问计数"
                            onClick={() =>
                              resetNodeAccessCount.mutate({ id: sub.id })
                            }
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="撤销/恢复"
                            onClick={() =>
                              setNodeSubscriptionRevoked.mutate({
                                id: sub.id,
                                revoked: !sub.revoked,
                              })
                            }
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="重置令牌"
                            onClick={() =>
                              rotateNodeToken.mutate({ id: sub.id })
                            }
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() =>
                              deleteNodeSubscription.mutate({ id: sub.id })
                            }
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!nodeSubscriptions.length && (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      尚未创建节点订阅。
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
          <TabsContent value="nodeSubscriptions">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0"><div><CardTitle>节点订阅</CardTitle><CardDescription>独立输出 Base64 节点链接，不与模板配置订阅混用。</CardDescription></div><Button onClick={() => openNodeSubscription()}><Plus className="mr-2 h-4 w-4" />新建订阅</Button></CardHeader>
              <CardContent className="space-y-3">{nodeSubscriptions.map((sub: any) => <div key={sub.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"><div><div className="font-medium">{sub.name}</div><div className="mt-1 text-sm text-muted-foreground">{sub.nodeIds.length} 个节点 · 访问 {sub.accessCount}{sub.accessLimit ? `/${sub.accessLimit}` : ""}</div></div><div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => copy(`${window.location.origin}/api/proxy-node-subscription/${sub.token}`)}><Copy className="mr-1 h-3.5 w-3.5" />复制链接</Button><Button size="icon" variant="ghost" title="编辑" onClick={() => openNodeSubscription(sub)}><Pencil className="h-4 w-4" /></Button><Button size="icon" variant="ghost" title="二维码" onClick={() => setQrSubscription({ name: sub.name, url: `${window.location.origin}/api/proxy-node-subscription/${sub.token}` })}><QrCode className="h-4 w-4" /></Button><Button size="icon" variant="ghost" onClick={() => deleteNodeSubscription.mutate({ id: sub.id })}><Trash2 className="h-4 w-4 text-destructive" /></Button></div></div>)}{!nodeSubscriptions.length && <div className="py-12 text-center text-sm text-muted-foreground">尚未创建节点订阅。</div>}</CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="templates">
            <Card onDragOver={(event) => event.preventDefault()} onDrop={async (event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (!file) return; if (!/\.(ya?ml|conf)$/i.test(file.name)) { toast.error("仅支持 .yaml、.yml 或 .conf 模板文件"); return; } setTemplateDialog({ filename: file.name, content: await file.text() }); }}>
              <CardHeader className="gap-4 space-y-0 lg:flex-row lg:items-center lg:justify-between">
                <div><CardTitle>模板列表</CardTitle><CardDescription>维护 Clash、Surge、Egern 等订阅输出模板。</CardDescription></div>
                <div className="flex flex-wrap gap-2"><input ref={templateFileInput} className="hidden" type="file" accept=".yaml,.yml,.conf,text/yaml,text/plain" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; setTemplateDialog({ filename: file.name, content: await file.text() }); event.target.value = ""; }} /><Button variant="outline" onClick={() => templateFileInput.current?.click()}>导入本地文件</Button><Button onClick={() => setTemplateDialog({ filename: "template.yaml", content: "proxies:\n  {{PROXY_NODES}}\n" })}><Plus className="mr-2 h-4 w-4" />添加模板</Button></div>
              </CardHeader>
              <CardContent>
                <div className="mb-3 text-sm text-muted-foreground">共 {templates.length} 个模板 <span className="float-right">可拖拽 .yaml / .yml / .conf 文件到此页面后导入</span></div>
                <Table><TableHeader><TableRow><TableHead className="w-10"><input aria-label="选择全部模板" type="checkbox" checked={templates.length > 0 && templates.every((item: any) => selectedTemplateIds.includes(item.id))} onChange={(event) => setSelectedTemplateIds(event.target.checked ? templates.map((item: any) => item.id) : [])} /></TableHead><TableHead>模板文件名</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{templates.map((item: any) => <TableRow key={item.id}><TableCell><input aria-label={`选择 ${item.filename}`} type="checkbox" checked={selectedTemplateIds.includes(item.id)} onChange={() => setSelectedTemplateIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /></TableCell><TableCell className="font-medium">{item.filename}</TableCell><TableCell className="text-sm text-muted-foreground">{item.createdAt ? new Date(Number(item.createdAt) * 1000).toLocaleString() : "—"}</TableCell><TableCell className="text-right"><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => { const blob = new Blob([item.content], { type: "text/plain;charset=utf-8" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = item.filename; anchor.click(); URL.revokeObjectURL(url); }}>导出</Button><Button size="sm" variant="ghost" onClick={() => setTemplateDialog({ id: item.id, filename: item.filename, content: item.content })}>编辑</Button><Button size="sm" variant="ghost" className="text-destructive" onClick={() => deleteTemplate.mutate({ id: item.id })}>删除</Button></div></TableCell></TableRow>)}{!templates.length && <TableRow><TableCell colSpan={4} className="h-28 text-center text-muted-foreground">尚未添加模板。可新建模板或导入本地文件。</TableCell></TableRow>}</TableBody></Table>
                {selectedTemplateIds.length > 0 && <div className="mt-4 flex gap-2"><Button variant="outline" size="sm" onClick={() => setSelectedTemplateIds(templates.map((item: any) => item.id))}>全选</Button><Button variant="outline" size="sm" onClick={() => setSelectedTemplateIds([])}>取消选择</Button><Button variant="destructive" size="sm" onClick={() => bulkDeleteTemplates.mutate({ ids: selectedTemplateIds })}>批量删除</Button></div>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
        <Dialog open={groupLibraryOpen} onOpenChange={setGroupLibraryOpen}>
          <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>节点分组</DialogTitle><DialogDescription>节点可同时属于多个分组；删除分组不会删除节点。</DialogDescription></DialogHeader><div className="flex gap-2"><Input value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="分组名称" /><Button disabled={!groupForm.name.trim()} onClick={() => saveNodeGroup.mutate(groupForm)}>保存</Button></div><div className="divide-y rounded-md border">{nodeGroups.map((group: any) => <div key={group.id} className="flex items-center justify-between p-3"><span>{group.name} <span className="text-sm text-muted-foreground">{group.nodeCount} 个节点</span></span><div><Button variant="ghost" size="sm" onClick={() => setGroupForm(group)}>编辑</Button><Button variant="ghost" size="sm" onClick={() => deleteNodeGroup.mutate({ id: group.id })}>删除</Button></div></div>)}{!nodeGroups.length && <div className="p-6 text-center text-sm text-muted-foreground">尚未创建分组</div>}</div></DialogContent>
        </Dialog>
        <Dialog open={ipLibraryOpen} onOpenChange={setIpLibraryOpen}>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>IP 库</DialogTitle><DialogDescription>维护导入节点时可替换的入口 IP；编辑或删除不会影响已保存节点。</DialogDescription></DialogHeader>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><Input value={ipForm.address} onChange={(event) => setIpForm({ ...ipForm, address: event.target.value })} placeholder="例如 198.51.100.24 或 2001:db8::18" /><Input value={ipForm.alias} onChange={(event) => setIpForm({ ...ipForm, alias: event.target.value })} placeholder="例如：香港入口 A" /><Button disabled={!ipForm.address || !ipForm.alias} onClick={() => saveNodeIp.mutate(ipForm)}>加入 IP 库</Button></div>
            <Table><TableHeader><TableRow><TableHead>别名</TableHead><TableHead>IP 地址</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{nodeIps.map((item: any) => <TableRow key={item.id}><TableCell>{item.alias}</TableCell><TableCell className="font-mono">{item.address}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => setIpForm(item)}>编辑</Button><Button variant="ghost" size="sm" onClick={() => deleteNodeIp.mutate({ id: item.id })}>删除</Button></TableCell></TableRow>)}{!nodeIps.length && <TableRow><TableCell colSpan={3} className="h-20 text-center text-muted-foreground">尚未添加入口 IP</TableCell></TableRow>}</TableBody></Table>
          </DialogContent>
        </Dialog>
        <Dialog open={!!deleteNodeIds} onOpenChange={(open) => !open && setDeleteNodeIds(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>删除节点</DialogTitle><DialogDescription>将删除 {deleteNodeIds?.length || 0} 个节点，并从关联订阅中移除它们。</DialogDescription></DialogHeader>
            {deleteImpact.length > 0 && <div className="rounded-md border bg-muted/30 p-3 text-sm"><p className="font-medium">受影响的订阅</p><ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{deleteImpact.map((item: any) => <li key={`${item.kind}-${item.id}`}>{item.kind}：{item.name}</li>)}</ul></div>}
            <DialogFooter><Button variant="outline" onClick={() => setDeleteNodeIds(null)}>取消</Button><Button variant="destructive" onClick={() => { const ids = deleteNodeIds || []; setDeleteNodeIds(null); if (ids.length === 1) deleteNode.mutate({ id: ids[0] }); else if (ids.length) bulkNodes.mutate({ ids, action: "delete" }); }}>确认删除</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={!!templateDialog} onOpenChange={(open) => !open && setTemplateDialog(null)}>
          <DialogContent className="max-h-[92vh] max-w-[min(96vw,1400px)] overflow-y-auto">
            <DialogHeader><DialogTitle>{templateDialog?.id ? "编辑模板" : "添加模板"}</DialogTitle><DialogDescription>编辑 YAML / Conf 配置，右侧会实时同步预览。</DialogDescription></DialogHeader>
            {templateDialog && <div className="space-y-4"><Label>文件名<Input className="mt-2" value={templateDialog.filename} onChange={(event) => setTemplateDialog({ ...templateDialog, filename: event.target.value })} placeholder="clash.yaml" /></Label><div className="grid gap-4 lg:grid-cols-2"><div className="overflow-hidden rounded-md border"><div className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">模板编辑</div><Textarea className="min-h-[55vh] resize-y rounded-none border-0 font-mono text-xs focus-visible:ring-0" value={templateDialog.content} onChange={(event) => setTemplateDialog({ ...templateDialog, content: event.target.value })} /></div><div className="overflow-hidden rounded-md border"><div className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">实时预览</div><pre className="min-h-[55vh] whitespace-pre-wrap break-words p-3 font-mono text-xs leading-6 text-muted-foreground">{templateDialog.content}</pre></div></div></div>}
            <DialogFooter><Button variant="outline" onClick={() => setTemplateDialog(null)}>取消</Button><Button disabled={!templateDialog?.filename.trim() || !templateDialog.content.trim() || saveTemplate.isPending} onClick={() => templateDialog && saveTemplate.mutate(templateDialog)}><Check className="mr-2 h-4 w-4" />保存模板</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={!!generatedSubscription} onOpenChange={(open) => !open && setGeneratedSubscription(null)}>
          <DialogContent><DialogHeader><DialogTitle>订阅已生成</DialogTitle><DialogDescription>{generatedSubscription?.filename} 模板已生成专属订阅链接。</DialogDescription></DialogHeader>{generatedSubscription && (() => { const url = `${window.location.origin}/api/proxy-subscription/${generatedSubscription.token}`; const isEgern = /egern/i.test(generatedSubscription.filename); const isLoon = /loon/i.test(generatedSubscription.filename); const appUrl = isEgern ? `egern://install-config?url=${encodeURIComponent(url)}` : isLoon ? `loon://import?sub=${encodeURIComponent(url)}` : ""; return <div className="space-y-3"><Label>订阅链接<Input className="mt-2 font-mono text-xs" readOnly value={url} /></Label><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => copy(url)}><Copy className="mr-2 h-4 w-4" />复制链接</Button>{appUrl && <Button onClick={() => { window.location.href = appUrl; }}>导入 {isEgern ? "Egern" : "Loon"}</Button>}<Button variant="outline" onClick={() => setQrSubscription({ name: generatedSubscription.name, url })}><QrCode className="mr-2 h-4 w-4" />二维码</Button></div>{!appUrl && <p className="text-xs text-muted-foreground">该模板未配置 App 唤起方式，可复制链接或扫描二维码导入。</p>}</div>; })()}<DialogFooter><Button onClick={() => setGeneratedSubscription(null)}>完成</Button></DialogFooter></DialogContent>
        </Dialog>
        <Dialog
          open={!!nodeDialog}
          onOpenChange={(open) => !open && setNodeDialog(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {nodeDialog?.id ? "编辑节点" : "新建节点"}
              </DialogTitle>
              <DialogDescription>
                粘贴标准节点链接，服务器信息会自动识别。
              </DialogDescription>
            </DialogHeader>
            {nodeDialog && (
              <div className="grid gap-3">
                <Label>
                  名称
                  <Input
                    value={nodeDialog.name}
                    onChange={(e) =>
                      setNodeDialog({ ...nodeDialog, name: e.target.value })
                    }
                  />
                </Label>
                <Label>
                  协议
                  <select
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={nodeDialog.protocol}
                    onChange={(e) =>
                      setNodeDialog({
                        ...nodeDialog,
                        protocol: e.target.value as any,
                      })
                    }
                  >
                    {["ss", "ssr", "vless", "vmess"].map((p) => (
                      <option key={p}>{p.toUpperCase()}</option>
                    ))}
                  </select>
                </Label>
                <Label>
                  节点链接
                  <Textarea
                    value={nodeDialog.link}
                    onChange={(e) =>
                      setNodeDialog({ ...nodeDialog, link: e.target.value })
                    }
                  />
                </Label>
                <Label>
                  分组
                  <Input
                    value={nodeDialog.groupName}
                    onChange={(e) =>
                      setNodeDialog({
                        ...nodeDialog,
                        groupName: e.target.value,
                      })
                    }
                  />
                </Label>
                <div><Label>所属分组（可多选）</Label><div className="mt-2 flex flex-wrap gap-2">{nodeGroups.map((group: any) => <Button key={group.id} type="button" size="sm" variant={(nodeDialog.groupIds || []).includes(group.id) ? "default" : "outline"} onClick={() => setNodeDialog({ ...nodeDialog, groupIds: (nodeDialog.groupIds || []).includes(group.id) ? (nodeDialog.groupIds || []).filter((id) => id !== group.id) : [...(nodeDialog.groupIds || []), group.id] })}>{group.name}</Button>)}</div></div>
                <div><Label>关联配置订阅（可多选）</Label><div className="mt-2 flex flex-wrap gap-2">{subscriptions.map((sub: any) => <Button key={sub.id} type="button" size="sm" variant={(nodeDialog.configSubscriptionIds || []).includes(sub.id) ? "default" : "outline"} onClick={() => setNodeDialog({ ...nodeDialog, configSubscriptionIds: (nodeDialog.configSubscriptionIds || []).includes(sub.id) ? (nodeDialog.configSubscriptionIds || []).filter((id) => id !== sub.id) : [...(nodeDialog.configSubscriptionIds || []), sub.id] })}>{sub.name}</Button>)}</div></div>
                <div><Label>关联节点订阅（可多选）</Label><div className="mt-2 flex flex-wrap gap-2">{nodeSubscriptions.map((sub: any) => <Button key={sub.id} type="button" size="sm" variant={(nodeDialog.nodeSubscriptionIds || []).includes(sub.id) ? "default" : "outline"} onClick={() => setNodeDialog({ ...nodeDialog, nodeSubscriptionIds: (nodeDialog.nodeSubscriptionIds || []).includes(sub.id) ? (nodeDialog.nodeSubscriptionIds || []).filter((id) => id !== sub.id) : [...(nodeDialog.nodeSubscriptionIds || []), sub.id] })}>{sub.name}</Button>)}</div></div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={nodeDialog.enabled} onChange={(event) => setNodeDialog({ ...nodeDialog, enabled: event.target.checked })} />启用节点</label>
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => nodeDialog && saveNode.mutate(nodeDialog)}>
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>添加节点</DialogTitle>
              <DialogDescription>
                粘贴一个或多个节点链接；每行一个。名称会优先读取链接末尾备注。
              </DialogDescription>
            </DialogHeader>
            <Textarea
              className="min-h-56 font-mono text-xs"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="ss://...\nvless://..."
            />
            {!!importInspection.length && <div className="max-h-40 overflow-y-auto rounded-md border text-xs">{importInspection.map((item: any) => <div key={item.line} className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0"><span className="truncate">第 {item.line} 行 · {item.name || item.server || "未知节点"}</span><Badge variant={item.valid ? (item.duplicate ? "secondary" : "default") : "destructive"}>{item.valid ? (item.duplicate ? "重复" : item.protocol.toUpperCase()) : item.reason}</Badge></div>)}</div>}
            <div><Label>节点名称（可选，仅单条链接生效）</Label><Input className="mt-2" value={importName} onChange={(event) => setImportName(event.target.value)} placeholder="留空时自动读取链接末尾备注" /><p className="mt-1 text-xs text-muted-foreground">批量添加时，每条链接将使用自己的备注作为名称。</p></div>
            <div><Label>所属分组（可多选）</Label><div className="mt-2 flex flex-wrap gap-2">{nodeGroups.map((group: any) => <Button key={group.id} type="button" size="sm" variant={importGroupIds.includes(group.id) ? "default" : "outline"} onClick={() => setImportGroupIds((current) => current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id])}>{group.name}</Button>)}</div></div>
            <div><Label>创建新分组（可选）</Label><Input className="mt-2" value={importNewGroupName} onChange={(event) => setImportNewGroupName(event.target.value)} placeholder="例如：香港 · 新节点会同时加入该分组" /></div>
            <div><Label>关联配置订阅（可多选）</Label><div className="mt-2 flex flex-wrap gap-2">{subscriptions.map((sub: any) => <Button key={sub.id} type="button" size="sm" variant={importConfigSubscriptionIds.includes(sub.id) ? "default" : "outline"} onClick={() => setImportConfigSubscriptionIds((current) => current.includes(sub.id) ? current.filter((id) => id !== sub.id) : [...current, sub.id])}>{sub.name}</Button>)}</div></div>
            <div><Label>关联节点订阅（可多选）</Label><div className="mt-2 flex flex-wrap gap-2">{nodeSubscriptions.map((sub: any) => <Button key={sub.id} type="button" size="sm" variant={importNodeSubscriptionIds.includes(sub.id) ? "default" : "outline"} onClick={() => setImportNodeSubscriptionIds((current) => current.includes(sub.id) ? current.filter((id) => id !== sub.id) : [...current, sub.id])}>{sub.name}</Button>)}</div></div>
            <div><Label>替换入口 IP（仅 SS / VLESS）</Label><select className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" value={importReplaceIpId || ""} onChange={(event) => setImportReplaceIpId(event.target.value ? Number(event.target.value) : null)}><option value="">保持链接原服务器</option>{nodeIps.map((item: any) => <option key={item.id} value={item.id}>{item.alias} · {item.address}</option>)}</select><p className="mt-1 text-xs text-muted-foreground">仅影响本次导入，不会修改已保存节点；SSR / VMess 将保持原始服务器。</p></div>
            <div><Label>发现重复链接时</Label><select className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" value={importDuplicateStrategy} onChange={(event) => setImportDuplicateStrategy(event.target.value as any)}><option value="skip">跳过重复项</option><option value="replace">更新已有节点</option><option value="allow">仍然创建</option></select></div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button>
              <Button disabled={!importText.trim() || importNodes.isPending} onClick={() => importNodes.mutate({ links: importText, name: importName || undefined, groupIds: importGroupIds, newGroupName: importNewGroupName.trim() || undefined, configSubscriptionIds: importConfigSubscriptionIds, nodeSubscriptionIds: importNodeSubscriptionIds, replaceAddress: nodeIps.find((item: any) => item.id === importReplaceIpId)?.address, duplicateStrategy: importDuplicateStrategy })}>
                <ListPlus className="mr-2 h-4 w-4" />
                添加节点
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={subscriptionOpen}
          onOpenChange={(open) => {
            setSubscriptionOpen(open);
            if (!open) clearSubscriptionForm();
          }}
        >
          <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingSubscription ? "编辑订阅" : "新建订阅"}
              </DialogTitle>
              <DialogDescription>
                第 {subscriptionStep} / 4 步：选择模板、节点、策略组并生成订阅链接。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              {subscriptionStep === 4 && <><Label>
                名称
                <Input
                  value={subscriptionName}
                  onChange={(e) => setSubscriptionName(e.target.value)}
                />
              </Label>
              <div className="grid grid-cols-2 gap-3">
                <Label>
                  到期时间
                  <Input
                    type="datetime-local"
                    value={expiresAtText}
                    onChange={(e) => setExpiresAtText(e.target.value)}
                  />
                </Label>
                <Label>
                  访问上限（0 为不限）
                  <Input
                    type="number"
                    min="0"
                    value={accessLimit}
                    onChange={(e) =>
                      setAccessLimit(Math.max(0, Number(e.target.value || 0)))
                    }
                  />
                </Label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={revoked}
                  onChange={(e) => setRevoked(e.target.checked)}
                />
                保存后撤销此订阅
              </label></>}
              {subscriptionStep === 1 && <div><Label>选择模板（一次只能选择一个）</Label><div className="mt-2 space-y-2">{templates.map((template: any) => <button type="button" key={template.id} className={`flex w-full items-center justify-between rounded-md border p-3 text-left ${selectedTemplateId === template.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`} onClick={() => setSelectedTemplateId(template.id)}><span className="font-medium">{template.filename}</span><span className="text-xs text-muted-foreground">{template.content.length} 字符</span></button>)}{!templates.length && <p className="text-sm text-muted-foreground">请先在模板管理中创建或导入模板。</p>}</div></div>}
              {subscriptionStep === 2 && <div>
                <Label>节点</Label>
                <div className="mt-2 max-h-48 space-y-1 overflow-auto rounded-md border p-2">
                  {nodes
                    .filter((node: any) => node.enabled)
                    .map((node: any) => (
                      <button
                        type="button"
                        key={node.id}
                        onClick={() => toggleNode(node.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border ${selectedNodeIds.includes(node.id) ? "border-primary bg-primary text-primary-foreground" : ""}`}
                        >
                          {selectedNodeIds.includes(node.id) && (
                            <Check className="h-3 w-3" />
                          )}
                        </span>
                        {selectedNodeIds.includes(node.id) && (
                          <span className="text-muted-foreground">
                            {selectedNodeIds.indexOf(node.id) + 1}
                          </span>
                        )}
                        {node.name}
                        <span className="text-muted-foreground">
                          {String(node.protocol).toUpperCase()}
                        </span>
                      </button>
                    ))}
                </div>
              </div>}
              {subscriptionStep === 3 && <div><Label>策略组节点分配</Label><p className="mt-1 text-xs text-muted-foreground">已识别模板中的策略组；不需要分配的组可留空。模板中可用 <code>{"{{PROXY_GROUP:策略组名}}"}</code> 插入所选节点名称。</p><div className="mt-3 space-y-3">{detectedStrategyGroups.map((group: any) => { const selected = strategyGroups.find((item) => item.name === group.name)?.nodeIds || []; return <div key={group.name} className="rounded-md border p-3"><div className="font-medium">{group.name}</div><div className="mt-2 flex flex-wrap gap-2">{selectedNodeIds.map((id) => { const node: any = nodes.find((item: any) => item.id === id); if (!node) return null; return <Button key={id} type="button" size="sm" variant={selected.includes(id) ? "default" : "outline"} onClick={() => setStrategyGroups((current) => { const rest = current.filter((item) => item.name !== group.name); const next = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]; return next.length ? [...rest, { name: group.name, nodeIds: next }] : rest; })}>{node.name}</Button>; })}</div></div>; })}{!detectedStrategyGroups.length && <div className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">未在模板中识别到策略组，可跳过此步骤。</div>}</div></div>}
            </div>
            <DialogFooter>
              {subscriptionStep > 1 && <Button variant="outline" onClick={() => setSubscriptionStep((step) => step - 1)}>上一步</Button>}
              {subscriptionStep < 4 ? <Button disabled={(subscriptionStep === 1 && !selectedTemplateId) || (subscriptionStep === 2 && !selectedNodeIds.length)} onClick={() => setSubscriptionStep((step) => step + 1)}>下一步</Button> : <Button disabled={!subscriptionName || !selectedNodeIds.length || !selectedTemplateId} onClick={() => saveSubscription.mutate({ id: editingSubscription?.id, name: subscriptionName, nodeIds: selectedNodeIds, templateId: selectedTemplateId!, strategyGroups, expiresAt: expiresAtText ? new Date(expiresAtText) : null, accessLimit, revoked })}>{editingSubscription ? "保存修改" : "生成订阅"}</Button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={nodeSubscriptionOpen}
          onOpenChange={(open) => {
            setNodeSubscriptionOpen(open);
            if (!open) clearSubscriptionForm();
          }}
        >
          <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingNodeSubscription ? "编辑节点订阅" : "新建节点订阅"}
              </DialogTitle>
              <DialogDescription>
                独立的 Base64 节点订阅，与配置订阅使用不同令牌。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <Label>
                名称
                <Input
                  value={subscriptionName}
                  onChange={(e) => setSubscriptionName(e.target.value)}
                />
              </Label>
              <div className="grid grid-cols-2 gap-3">
                <Label>
                  到期时间
                  <Input
                    type="datetime-local"
                    value={expiresAtText}
                    onChange={(e) => setExpiresAtText(e.target.value)}
                  />
                </Label>
                <Label>
                  访问上限（0 为不限）
                  <Input
                    type="number"
                    min="0"
                    value={accessLimit}
                    onChange={(e) =>
                      setAccessLimit(Math.max(0, Number(e.target.value || 0)))
                    }
                  />
                </Label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={revoked}
                  onChange={(e) => setRevoked(e.target.checked)}
                />
                保存后撤销此订阅
              </label>
              <div>
                <Label>节点（点击顺序即输出顺序）</Label>
                <div className="mt-2 max-h-56 space-y-1 overflow-auto rounded-md border p-2">
                  {nodes
                    .filter((node: any) => node.enabled)
                    .map((node: any) => (
                      <button
                        type="button"
                        key={node.id}
                        onClick={() => toggleNode(node.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border ${selectedNodeIds.includes(node.id) ? "border-primary bg-primary text-primary-foreground" : ""}`}
                        >
                          {selectedNodeIds.includes(node.id) && (
                            <Check className="h-3 w-3" />
                          )}
                        </span>
                        {selectedNodeIds.includes(node.id) && (
                          <span className="text-muted-foreground">
                            {selectedNodeIds.indexOf(node.id) + 1}
                          </span>
                        )}
                        {node.name}
                        <span className="text-muted-foreground">
                          {String(node.protocol).toUpperCase()}
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={!subscriptionName || !selectedNodeIds.length}
                onClick={() =>
                  saveNodeSubscription.mutate({
                    id: editingNodeSubscription?.id,
                    name: subscriptionName,
                    nodeIds: selectedNodeIds,
                    expiresAt: expiresAtText ? new Date(expiresAtText) : null,
                    accessLimit,
                    revoked,
                  })
                }
              >
                {editingNodeSubscription ? "保存修改" : "创建节点订阅"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={!!previewSubscription} onOpenChange={(open) => !open && setPreviewSubscription(null)}>
          <DialogContent className="flex max-h-[88vh] max-w-4xl flex-col">
            <DialogHeader><DialogTitle>{previewSubscription?.name} 预览</DialogTitle><DialogDescription>这是公开订阅接口实时生成的内容。</DialogDescription></DialogHeader>
            <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-5">{previewContent || "正在加载…"}</pre>
            <DialogFooter><Button variant="outline" onClick={() => previewSubscription && copy(previewSubscription.url)}>复制订阅链接</Button><Button onClick={() => previewSubscription && download(previewSubscription.url, previewSubscription.name)}>下载</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={!!qrSubscription}
          onOpenChange={(open) => !open && setQrSubscription(null)}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{qrSubscription?.name} 订阅二维码</DialogTitle>
              <DialogDescription>
                使用支持订阅导入的客户端扫码或复制链接。
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-3">
              {qrData ? (
                <img
                  className="h-60 w-60 rounded-md bg-white p-2"
                  src={qrData}
                  alt="订阅二维码"
                />
              ) : (
                <div className="grid h-60 w-60 place-items-center text-sm text-muted-foreground">
                  二维码生成中…
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => qrSubscription && copy(qrSubscription.url)}
              >
                复制链接
              </Button>
              <Button onClick={() => setQrSubscription(null)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={!!logTarget}
          onOpenChange={(open) => !open && setLogTarget(null)}
        >
          <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{logTarget?.name} 访问日志</DialogTitle>
              <DialogDescription>最近 200 次访问记录。</DialogDescription>
            </DialogHeader>
            <div className="rounded-md border">
              {accessLogs.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>IP</TableHead>
                      <TableHead>格式</TableHead>
                      <TableHead>客户端</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accessLogs.map((log: any) => (
                      <TableRow key={log.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {new Date(
                            Number(log.accessedAt) * 1000,
                          ).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {log.ip}
                        </TableCell>
                        <TableCell>{log.format}</TableCell>
                        <TableCell className="max-w-52 truncate text-xs">
                          {log.userAgent || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  暂无访问记录。
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </main>
    </DashboardLayout>
  );
}
