import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { SlidingTabsList, type SlidingTabItem } from "@/components/ui/sliding-tabs";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SubscriptionWizard } from "@/components/subscriptions/SubscriptionWizard";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Clock3, Copy, Ellipsis, FileCode2, FileText, Library, LayoutGrid, Link2, List, Loader2, Network, Pencil, Plus, Power, RefreshCw, Search, Server, Trash2, UsersRound } from "lucide-react";

type SubscriptionSection = "subscriptions" | "node-subscriptions" | "nodes" | "templates";
type SubscriptionViewMode = "card" | "table";

type SublinkResponse<T> = { code?: string; data?: T; msg?: string };
type SubscriptionLog = { ID: number; IP?: string; Date?: string; Addr?: string; Count?: number };
type SubscriptionRecord = {
  ID: number;
  Name: string;
  Config?: string;
  Token?: string;
  Revoked?: boolean;
  ExpireAt?: string | null;
  AccessLimit?: number;
  AccessCount?: number;
  CreatedAt?: string;
  CreateDate?: string;
  Nodes?: Array<{ ID: number; Name: string; Disabled?: boolean }>;
  SubLogs?: SubscriptionLog[];
};
type NodeRecord = { ID: number; Name: string; Link: string; Disabled?: boolean; CreatedAt?: string; GroupNodes?: Array<{ ID: number; Name: string }> };
type NodeSubscriptionRecord = Omit<SubscriptionRecord, "Config">;
type TemplateRecord = { File: string; Text: string; CreateDate?: string };
type TemplateApiRecord = TemplateRecord & { file?: string; text?: string; create_date?: string };
type NodeListResponse = { items?: NodeRecord[] };
type IPEntry = { ID: number; Alias: string; Address: string; CreatedAt?: string };
type EditorMode = "subscription" | "node-subscription" | "node" | "template-add" | "template-edit" | "template-import" | null;

const SUBSCRIPTION_VIEW_MODE_STORAGE_KEY = "forwardx.subscriptionCenter.viewMode";

const sections: readonly SlidingTabItem<SubscriptionSection>[] = [
  { value: "subscriptions", label: "订阅列表", icon: Link2 },
  { value: "node-subscriptions", label: "节点订阅", icon: Network },
  { value: "nodes", label: "节点列表", icon: Server },
  { value: "templates", label: "订阅模板", icon: FileCode2 },
];

const sectionDescriptions: Record<SubscriptionSection, string> = {
  subscriptions: "管理订阅、节点顺序、访问限制与输出格式。",
  "node-subscriptions": "管理从远端拉取和更新的节点订阅源。",
  nodes: "管理可用于订阅输出的代理节点与分组。",
  templates: "管理客户端输出模板，并在发布前预览结果。",
};

function getStoredViewMode(): SubscriptionViewMode {
  if (typeof window === "undefined") return "table";
  try {
    return window.localStorage.getItem(SUBSCRIPTION_VIEW_MODE_STORAGE_KEY) === "card" ? "card" : "table";
  } catch {
    return "table";
  }
}

function storeViewMode(viewMode: SubscriptionViewMode) {
  try {
    window.localStorage.setItem(SUBSCRIPTION_VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {
    // The selected layout is optional; the page remains usable in restricted browsers.
  }
}

async function sublinkRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const payload = await response.json().catch(() => ({})) as SublinkResponse<T>;
  if (!response.ok || (payload.code && payload.code !== "00000")) {
    throw new Error(payload.msg || "代理订阅服务请求失败");
  }
  return payload.data as T;
}

function outputTypeOf(subscription: SubscriptionRecord) {
  try {
    const outputType = JSON.parse(subscription.Config || "{}").output_type;
    return ["clash", "surge", "egern", "loon"].includes(outputType) ? outputType : "clash";
  } catch {
    return "clash";
  }
}

function formatDate(value?: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace("T", " ").replace(/\.\d+Z?$/, "");
  return date.toLocaleString("zh-CN", { hour12: false });
}

function isExpired(subscription: SubscriptionRecord) {
  return !!subscription.ExpireAt && new Date(subscription.ExpireAt).getTime() < Date.now();
}

function statusOf(subscription: SubscriptionRecord) {
  if (subscription.Revoked) return { label: "已失效", className: "border-destructive/30 bg-destructive/10 text-destructive" };
  if (isExpired(subscription)) return { label: "已过期", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" };
  return { label: "有效", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" };
}

function subscriptionUrl(subscription: SubscriptionRecord, client: string) {
  const url = new URL("/c/", window.location.origin);
  url.searchParams.set("token", subscription.Token || "");
  url.searchParams.set("client", client);
  return url.toString();
}

function templatePolicyGroups(text: string, outputType: string) {
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/);
  if (outputType === "surge" || outputType === "loon") {
    const start = lines.findIndex((line) => /^\s*\[Proxy Group\]\s*$/i.test(line));
    if (start < 0) return [];
    const names: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\s*\[[^\]]+\]\s*$/.test(line)) break;
      const match = line.replace(/^\s*#.*$/, "").match(/^\s*([^=,#]+?)\s*=/);
      if (match?.[1]?.trim()) names.push(match[1].trim());
    }
    return [...new Set(names)];
  }
  const start = lines.findIndex((line) => /^\s*(?:proxy-groups|policy-groups)\s*:\s*$/i.test(line));
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S[^:]*:\s*$/.test(line)) break;
    const match = line.match(/^\s*-\s*name\s*:\s*["']?([^"'\n#]+)["']?/i);
    if (match?.[1]?.trim()) names.push(match[1].trim());
  }
  return [...new Set(names)];
}

export default function SubscriptionCenterPage() {
  const [activeSection, setActiveSection] = useState<SubscriptionSection>("subscriptions");
  const [viewMode, setViewMode] = useState<SubscriptionViewMode>(getStoredViewMode);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRecord[]>([]);
  const [nodeSubscriptions, setNodeSubscriptions] = useState<NodeSubscriptionRecord[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [clientSubscription, setClientSubscription] = useState<SubscriptionRecord | null>(null);
  const [logSubscription, setLogSubscription] = useState<SubscriptionRecord | null>(null);
  const [templatePreview, setTemplatePreview] = useState<TemplateRecord | null>(null);
  const [ipLibraryOpen, setIpLibraryOpen] = useState(false);
  const [ipEntries, setIpEntries] = useState<IPEntry[]>([]);
  const [ipForm, setIpForm] = useState({ ID: 0, Alias: "", Address: "" });
  const [isSavingIp, setIsSavingIp] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [editorName, setEditorName] = useState("");
  const [editorLink, setEditorLink] = useState("");
  const [editorNodeIds, setEditorNodeIds] = useState<number[]>([]);
  const [editorExpireAt, setEditorExpireAt] = useState("");
  const [editorAccessLimit, setEditorAccessLimit] = useState("");
  const [editorOutputType, setEditorOutputType] = useState("clash");
  const [templateFilename, setTemplateFilename] = useState("");
  const [templateOriginalFilename, setTemplateOriginalFilename] = useState("");
  const [templateText, setTemplateText] = useState("");
  const [templateFindOpen, setTemplateFindOpen] = useState(false);
  const [templateFindText, setTemplateFindText] = useState("");
  const [templateReplaceText, setTemplateReplaceText] = useState("");
  const [subscriptionStep, setSubscriptionStep] = useState(0);
  const [subscriptionTemplate, setSubscriptionTemplate] = useState("");
  const [subscriptionUdp, setSubscriptionUdp] = useState(true);
  const [subscriptionCert, setSubscriptionCert] = useState(true);
  const [policyGroupName, setPolicyGroupName] = useState("");
  const [policyGroups, setPolicyGroups] = useState<Record<string, { mode: "all" | "include" | "none"; nodes: number[] }>>({});
  const [editorGroups, setEditorGroups] = useState<string[]>([]);
  const [editorNewGroup, setEditorNewGroup] = useState("");
  const [editorSubscriptionIds, setEditorSubscriptionIds] = useState<number[]>([]);
  const [replaceIpEnabled, setReplaceIpEnabled] = useState(false);
  const [replaceIpId, setReplaceIpId] = useState("");
  const [isSavingEditor, setIsSavingEditor] = useState(false);
  const templateFileInputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirmDialog();
  const activeItem = sections.find((item) => item.value === activeSection)!;
  const ActiveIcon = activeItem.icon || Link2;
  const selectedSubscriptionTemplateText = useMemo(() => {
    const defaultFile = editorOutputType === "surge" ? "surge.conf" : editorOutputType === "loon" ? "loon.conf" : editorOutputType === "egern" ? "egern.yaml" : "clash.yaml";
    const requested = (subscriptionTemplate || `./template/${defaultFile}`).replace(/^\.\/template\//, "");
    return templates.find((template) => template.File === requested)?.Text || "";
  }, [editorOutputType, subscriptionTemplate, templates]);
  const selectedTemplatePolicyGroups = useMemo(() => templatePolicyGroups(selectedSubscriptionTemplateText, editorOutputType), [selectedSubscriptionTemplateText, editorOutputType]);

  useEffect(() => {
    if (editorMode !== "subscription" || subscriptionStep !== 3) return;
    setPolicyGroups((current) => Object.fromEntries(selectedTemplatePolicyGroups.map((name) => [name, current[name] || { mode: "all" as const, nodes: [] }])));
  }, [editorMode, subscriptionStep, selectedTemplatePolicyGroups]);

  const loadSubscriptions = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [subscriptionData, nodeSubscriptionData, nodeData, templateData] = await Promise.all([
        sublinkRequest<SubscriptionRecord[]>("/api/v1/subcription/get"),
        sublinkRequest<NodeSubscriptionRecord[]>("/api/v1/node-subscription/get"),
        sublinkRequest<NodeListResponse>("/api/v1/nodes/get?all=1"),
        sublinkRequest<TemplateApiRecord[]>("/api/v1/template/get"),
      ]);
      setSubscriptions(Array.isArray(subscriptionData) ? subscriptionData : []);
      setNodeSubscriptions(Array.isArray(nodeSubscriptionData) ? nodeSubscriptionData : []);
      setNodes(Array.isArray(nodeData) ? nodeData : (nodeData?.items || []));
      setTemplates(Array.isArray(templateData) ? templateData.map((item) => ({
        File: item.File || item.file || "未命名模板",
        Text: item.Text ?? item.text ?? "",
        CreateDate: item.CreateDate || item.create_date,
      })) : []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "订阅列表加载失败");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSubscriptions();
  }, [loadSubscriptions]);

  const visibleSubscriptions = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    if (!keyword) return subscriptions;
    return subscriptions.filter((item) => `${item.Name} ${outputTypeOf(item)}`.toLowerCase().includes(keyword));
  }, [searchQuery, subscriptions]);

  const changeViewMode = (nextViewMode: SubscriptionViewMode) => {
    setViewMode(nextViewMode);
    storeViewMode(nextViewMode);
  };

  const postSubscriptionAction = async (path: string, id: number) => {
    const body = new FormData();
    body.set("id", String(id));
    await sublinkRequest(path, { method: "POST", body });
    await loadSubscriptions();
  };

  const handleResetToken = async (subscription: SubscriptionRecord) => {
    if (!await confirm({
      title: "重置订阅 Token",
      description: `重置「${subscription.Name}」后，旧订阅地址会立刻失效。`,
      confirmText: "重置 Token",
    })) return;
    try {
      await postSubscriptionAction("/api/v1/subcription/reset-token", subscription.ID);
      toast.success("Token 已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Token 重置失败");
    }
  };

  const handleDelete = async (subscription: SubscriptionRecord) => {
    if (!await confirm({
      title: "删除订阅",
      description: `确定删除「${subscription.Name}」吗？此操作无法撤销。`,
      confirmText: "删除",
      tone: "destructive",
    })) return;
    try {
      await sublinkRequest(`/api/v1/subcription/delete?id=${encodeURIComponent(String(subscription.ID))}`, { method: "DELETE" });
      toast.success("订阅已删除");
      await loadSubscriptions();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除订阅失败");
    }
  };

  const copySubscriptionUrl = async (subscription: SubscriptionRecord, client = outputTypeOf(subscription)) => {
    try {
      await navigator.clipboard.writeText(subscriptionUrl(subscription, client));
      toast.success("订阅地址已复制");
    } catch {
      toast.error("复制失败，请检查浏览器权限");
    }
  };

  const copyNodeSubscriptionUrl = async (subscription: NodeSubscriptionRecord) => {
    try {
      const url = new URL("/n/", window.location.origin);
      url.searchParams.set("token", subscription.Token || "");
      await navigator.clipboard.writeText(url.toString());
      toast.success("节点订阅地址已复制");
    } catch {
      toast.error("复制失败，请检查浏览器权限");
    }
  };

  const toggleNode = async (node: NodeRecord) => {
    const body = new FormData();
    body.set("id", String(node.ID));
    body.set("disabled", String(!node.Disabled));
    try {
      await sublinkRequest("/api/v1/nodes/disabled", { method: "POST", body });
      toast.success(node.Disabled ? "节点已启用" : "节点已停用");
      await loadSubscriptions();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "节点状态更新失败");
    }
  };

  const deleteResource = async (kind: "node-subscription" | "nodes" | "template", label: string, value: string | number) => {
    if (!await confirm({ title: `删除${label}`, description: `确定删除「${label}」吗？此操作无法撤销。`, confirmText: "删除", tone: "destructive" })) return;
    try {
      if (kind === "template") {
        const body = new FormData();
        body.set("filename", String(value));
        await sublinkRequest("/api/v1/template/delete", { method: "POST", body });
      } else {
        await sublinkRequest(`/api/v1/${kind}/delete?id=${encodeURIComponent(String(value))}`, { method: "DELETE" });
      }
      toast.success("已删除");
      await loadSubscriptions();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  const loadIpLibrary = async () => {
    try {
      const data = await sublinkRequest<IPEntry[]>("/api/v1/ip-library");
      setIpEntries(Array.isArray(data) ? data : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "IP 库读取失败");
    }
  };

  const openIpLibrary = () => {
    setIpLibraryOpen(true);
    setIpForm({ ID: 0, Alias: "", Address: "" });
    void loadIpLibrary();
  };

  const saveIpEntry = async () => {
    if (!ipForm.Alias.trim() || !ipForm.Address.trim()) {
      toast.error("请填写 IP 地址和别名");
      return;
    }
    setIsSavingIp(true);
    try {
      const body = new FormData();
      body.set("alias", ipForm.Alias.trim());
      body.set("address", ipForm.Address.trim());
      if (ipForm.ID) body.set("id", String(ipForm.ID));
      await sublinkRequest(`/api/v1/ip-library/${ipForm.ID ? "update" : "add"}`, { method: "POST", body });
      toast.success(ipForm.ID ? "IP 库记录已更新" : "已加入 IP 库");
      setIpForm({ ID: 0, Alias: "", Address: "" });
      await loadIpLibrary();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "IP 库保存失败");
    } finally {
      setIsSavingIp(false);
    }
  };

  const removeIpEntry = async (entry: IPEntry) => {
    if (!await confirm({ title: "从 IP 库删除", description: `确定删除「${entry.Alias} · ${entry.Address}」吗？已保存的节点不会改变。`, confirmText: "删除", tone: "destructive" })) return;
    try {
      await sublinkRequest(`/api/v1/ip-library/delete?id=${encodeURIComponent(String(entry.ID))}`, { method: "DELETE" });
      toast.success("IP 库记录已删除");
      await loadIpLibrary();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "IP 库删除失败");
    }
  };

  const openEditor = (mode: Exclude<EditorMode, null>, template?: TemplateRecord) => {
    setEditorMode(mode);
    setEditorName(""); setEditorLink(""); setEditorNodeIds([]); setEditorExpireAt(""); setEditorAccessLimit(""); setEditorOutputType("clash");
    setTemplateFilename(template?.File || ""); setTemplateOriginalFilename(template?.File || ""); setTemplateText(template?.Text || "");
    setSubscriptionStep(0); setSubscriptionTemplate(""); setSubscriptionUdp(true); setSubscriptionCert(true); setPolicyGroupName(""); setPolicyGroups({});
    setEditorGroups([]); setEditorNewGroup(""); setEditorSubscriptionIds([]); setReplaceIpEnabled(false); setReplaceIpId("");
    if (mode === "node") void loadIpLibrary();
  };

  const toggleEditorNode = (id: number) => setEditorNodeIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const saveEditor = async () => {
    if (!editorMode) return;
    setIsSavingEditor(true);
    try {
      if (editorMode === "node") {
        const links = editorLink.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
        if (!links.length) throw new Error("请填写至少一个节点链接");
        if (links.length > 1 && editorName.trim()) throw new Error("批量添加时请留空节点名称，以链接注释作为名称");
        if (replaceIpEnabled && !replaceIpId) throw new Error("请选择节点库入口 IP");
        for (const link of links) { const body = new FormData(); body.set("name", links.length === 1 ? editorName.trim() : ""); body.set("link", link); body.set("group", editorGroups.length ? editorGroups.join(",") : editorNewGroup.trim()); body.set("subscription_ids", editorSubscriptionIds.join(",")); if (replaceIpEnabled) body.set("replace_ip_id", replaceIpId); await sublinkRequest("/api/v1/nodes/add", { method: "POST", body }); }
      } else if (editorMode === "subscription" || editorMode === "node-subscription") {
        if (!editorName.trim() || !editorNodeIds.length) throw new Error("请填写名称并至少选择一个节点");
        const body = new FormData(); body.set("name", editorName.trim()); body.set("nodes", editorNodeIds.join(",")); body.set("expire_at", editorExpireAt); body.set("access_limit", editorAccessLimit);
        if (editorMode === "subscription") body.set("config", JSON.stringify({ output_type: editorOutputType, clash: editorOutputType === "clash" ? subscriptionTemplate : "", surge: editorOutputType === "surge" ? subscriptionTemplate : "", egern: editorOutputType === "egern" ? subscriptionTemplate : "", loon: editorOutputType === "loon" ? subscriptionTemplate : "", udp: subscriptionUdp, cert: subscriptionCert, group_nodes: Object.fromEntries(Object.entries(policyGroups).map(([name, rule]) => [name, { mode: rule.mode, nodes: rule.mode === "include" ? rule.nodes.map((id) => nodes.find((node) => node.ID === id)?.Name).filter(Boolean) : [] }])) }));
        await sublinkRequest(`/api/v1/${editorMode === "subscription" ? "subcription" : "node-subscription"}/add`, { method: "POST", body });
      } else {
        if (!templateFilename.trim() || !templateText.trim()) throw new Error("请填写模板文件名和模板内容");
        const body = new FormData(); body.set("filename", templateFilename.trim()); body.set("text", templateText);
        if (editorMode === "template-edit") { body.set("oldname", templateOriginalFilename); await sublinkRequest("/api/v1/template/update", { method: "POST", body }); }
        else await sublinkRequest("/api/v1/template/add", { method: "POST", body });
      }
      toast.success(editorMode === "template-import" ? "模板已导入" : "保存成功");
      setEditorMode(null); await loadSubscriptions();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally { setIsSavingEditor(false); }
  };

  const importTemplateFile = async (file?: File) => {
    if (!file) return;
    try {
      openEditor("template-import");
      setTemplateFilename(file.name); setTemplateText(await file.text());
    } catch { toast.error("模板文件读取失败"); }
  };

  const replaceTemplateText = () => {
    if (!templateFindText) return;
    setTemplateText((current) => current.split(templateFindText).join(templateReplaceText));
  };

  const renderMoreActions = (subscription: SubscriptionRecord) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`${subscription.Name} 更多操作`}>
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setLogSubscription(subscription)}>
          <Clock3 className="h-4 w-4" />访问记录
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toast.info("新版编辑向导将在下一步接入") }>
          <Pencil className="h-4 w-4" />编辑
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleResetToken(subscription)}>
          <RefreshCw className="h-4 w-4" />重置 Token
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void handleDelete(subscription)}>
          <Trash2 className="h-4 w-4" />删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const isSubscriptionWizardOpen = ["subscription"].includes(editorMode ?? "");

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">订阅</h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">统一管理订阅、节点与客户端模板</p>
          </div>
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <div className="flex items-center overflow-hidden rounded-md border border-border/40">
              <Button
                aria-label="方块视图"
                title="方块视图"
                variant={viewMode === "card" ? "secondary" : "ghost"}
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-none",
                  viewMode !== "card" && "text-muted-foreground",
                )}
                onClick={() => changeViewMode("card")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                aria-label="直铺视图"
                title="直铺视图"
                variant={viewMode === "table" ? "secondary" : "ghost"}
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-none",
                  viewMode !== "table" && "text-muted-foreground",
                )}
                onClick={() => changeViewMode("table")}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
            <Button className="gap-2" onClick={() => openEditor(activeSection === "subscriptions" ? "subscription" : activeSection === "node-subscriptions" ? "node-subscription" : activeSection === "nodes" ? "node" : "template-add")}>
              <Plus className="h-4 w-4" />
              新建
            </Button>
          </div>
        </div>

        <Tabs value={activeSection} onValueChange={(value) => setActiveSection(value as SubscriptionSection)}>
          <SlidingTabsList items={sections} activeValue={activeSection} ariaLabel="订阅" minItemWidthRem={7.5} />
        </Tabs>

        {activeSection === "subscriptions" ? (
          <section className="overflow-visible bg-transparent">
            <CardHeader className="flex flex-col gap-4 px-0 pb-5 pt-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-base">全部订阅</CardTitle>
                  <CardDescription className="mt-1">订阅地址与使用情况</CardDescription>
                </div>
                <Badge variant="outline" className="ml-1 tabular-nums">{subscriptions.length.toString().padStart(2, "0")} 条</Badge>
              </div>
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索订阅名称" className="h-9 pl-9" />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在读取订阅数据</div>
              ) : loadError ? (
                <div className="grid min-h-72 place-items-center p-6 text-center">
                  <div className="space-y-3"><p className="text-sm text-muted-foreground">{loadError}</p><Button variant="outline" size="sm" onClick={() => void loadSubscriptions()}>重新加载</Button></div>
                </div>
              ) : viewMode === "card" ? (
                <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
                  {visibleSubscriptions.map((subscription) => {
                    const status = statusOf(subscription);
                    const accessCount = Number(subscription.AccessCount || 0);
                    const accessLimit = Number(subscription.AccessLimit || 0);
                    const progress = accessLimit > 0 ? Math.min(100, Math.round(accessCount / accessLimit * 100)) : 100;
                    return (
                      <article key={subscription.ID} className="flex min-h-64 flex-col rounded-xl border border-border/55 bg-background/45 p-4 shadow-sm transition-colors hover:border-primary/35 hover:bg-background/65">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="truncate font-semibold">{subscription.Name}</h2>
                            <p className="mt-1 text-xs text-muted-foreground">{outputTypeOf(subscription).toUpperCase()} · {subscription.Nodes?.filter((node) => !node.Disabled).length || 0} 个可用节点</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Badge variant="outline" className={cn("gap-1.5", status.className)}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status.label}</Badge>
                            {renderMoreActions(subscription)}
                          </div>
                        </div>
                        <div className="mt-7">
                          <div className="flex items-end gap-1.5"><span className="text-4xl font-semibold tracking-tight tabular-nums">{accessCount.toLocaleString()}</span><span className="mb-1 text-sm text-muted-foreground">次访问</span></div>
                          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
                          <p className="mt-2 text-xs text-muted-foreground">{accessLimit > 0 ? `访问限制 ${accessCount.toLocaleString()} / ${accessLimit.toLocaleString()}` : "访问次数不限"}</p>
                        </div>
                        <div className="mt-auto pt-7">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />创建于 {formatDate(subscription.CreatedAt || subscription.CreateDate)}</div>
                          <Button variant="outline" className="mt-4 w-full gap-2" onClick={() => setClientSubscription(subscription)}><UsersRound className="h-4 w-4" />查看客户端</Button>
                        </div>
                      </article>
                    );
                  })}
                  {!visibleSubscriptions.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">暂无匹配的订阅</p>}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>订阅名称</TableHead><TableHead>客户端</TableHead><TableHead>状态</TableHead><TableHead>访问量</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                    <TableBody>{visibleSubscriptions.map((subscription) => {
                      const status = statusOf(subscription);
                      const accessCount = Number(subscription.AccessCount || 0);
                      const accessLimit = Number(subscription.AccessLimit || 0);
                      return <TableRow key={subscription.ID}>
                        <TableCell><div className="font-medium">{subscription.Name}</div><div className="mt-1 text-xs text-muted-foreground">订阅地址 · Token 已启用</div></TableCell>
                        <TableCell><Button variant="ghost" size="sm" className="h-8 text-primary" onClick={() => setClientSubscription(subscription)}>查看客户端</Button></TableCell>
                        <TableCell><Badge variant="outline" className={cn("gap-1.5", status.className)}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status.label}</Badge></TableCell>
                        <TableCell><div className="font-semibold tabular-nums">{accessCount.toLocaleString()} <span className="text-xs font-normal text-muted-foreground">次</span></div><div className="mt-2 h-1 w-36 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${accessLimit > 0 ? Math.min(100, accessCount / accessLimit * 100) : 100}%` }} /></div></TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(subscription.CreatedAt || subscription.CreateDate)}</TableCell>
                        <TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" className="h-8" onClick={() => setLogSubscription(subscription)}>记录</Button><Button variant="ghost" size="sm" className="h-8" onClick={() => void copySubscriptionUrl(subscription)}><Copy className="h-3.5 w-3.5" /></Button>{renderMoreActions(subscription)}</div></TableCell>
                      </TableRow>;
                    })}</TableBody>
                  </Table>
                  {!visibleSubscriptions.length && <p className="py-16 text-center text-sm text-muted-foreground">暂无匹配的订阅</p>}
                </div>
              )}
            </CardContent>
          </section>
        ) : (
          <section className="bg-transparent">
            <CardHeader className="flex-row items-start justify-between gap-4 px-0 pb-5 pt-0">
              <div><CardTitle className="flex items-center gap-2 text-lg"><ActiveIcon className="h-5 w-5 text-primary" />{activeItem.label}</CardTitle><CardDescription className="mt-1.5">{sectionDescriptions[activeSection]}</CardDescription></div>
              <div className="flex shrink-0 gap-2">
                {activeSection === "nodes" && <Button variant="outline" size="sm" className="gap-2" onClick={openIpLibrary}><Library className="h-4 w-4" />节点库</Button>}
                {activeSection === "templates" && <Button variant="outline" size="sm" className="gap-2" onClick={() => templateFileInputRef.current?.click()}><FileText className="h-4 w-4" />导入模板</Button>}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? <div className="grid min-h-64 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在读取数据</div> : loadError ? <div className="py-16 text-center text-sm text-muted-foreground">{loadError}</div> : activeSection === "node-subscriptions" ? (
                viewMode === "card" ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{nodeSubscriptions.map((item) => {
                  const count = Number(item.AccessCount || 0); const limit = Number(item.AccessLimit || 0); const status = statusOf(item);
                  return <article key={item.ID} className="flex min-h-56 flex-col rounded-xl border border-border/55 bg-background/45 p-4 shadow-sm transition-colors hover:border-primary/35 hover:bg-background/65"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold">{item.Name}</h2><p className="mt-1 text-xs text-muted-foreground">原始节点订阅 · {item.Nodes?.filter((node) => !node.Disabled).length || 0} 个可用节点</p></div><Badge variant="outline" className={cn("gap-1.5", status.className)}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status.label}</Badge></div><div className="mt-7"><div className="flex items-end gap-1.5"><span className="text-4xl font-semibold tracking-tight tabular-nums">{count.toLocaleString()}</span><span className="mb-1 text-sm text-muted-foreground">次访问</span></div><p className="mt-2 text-xs text-muted-foreground">{limit ? `访问限制 ${count.toLocaleString()} / ${limit.toLocaleString()}` : "访问次数不限"}</p></div><div className="mt-auto flex items-center justify-between pt-7 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{formatDate(item.CreatedAt)}</span><Button variant="outline" size="sm" className="gap-2" onClick={() => void copyNodeSubscriptionUrl(item)}><Copy className="h-3.5 w-3.5" />复制链接</Button></div></article>;
                })}{!nodeSubscriptions.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">暂无节点订阅</p>}</div> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>名称</TableHead><TableHead>可用节点</TableHead><TableHead>访问量</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{nodeSubscriptions.map((item) => <TableRow key={item.ID}><TableCell><div className="font-medium">{item.Name}</div><div className="mt-1 text-xs text-muted-foreground">原始节点订阅</div></TableCell><TableCell>{item.Nodes?.filter((node) => !node.Disabled).length || 0}</TableCell><TableCell className="tabular-nums">{Number(item.AccessCount || 0).toLocaleString()} 次</TableCell><TableCell><Badge variant="outline" className={cn("gap-1.5", statusOf(item).className)}>{statusOf(item).label}</Badge></TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" className="gap-2" onClick={() => void copyNodeSubscriptionUrl(item)}><Copy className="h-3.5 w-3.5" />复制链接</Button></TableCell></TableRow>)}</TableBody></Table>{!nodeSubscriptions.length && <p className="py-16 text-center text-sm text-muted-foreground">暂无节点订阅</p>}</div>
              ) : activeSection === "nodes" ? (
                viewMode === "card" ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{nodes.map((node) => <article key={node.ID} className="flex min-h-52 flex-col rounded-xl border border-border/55 bg-background/45 p-4 shadow-sm transition-colors hover:border-primary/35 hover:bg-background/65"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold">{node.Name}</h2><p className="mt-1 truncate font-mono text-xs text-muted-foreground">{node.Link}</p></div><Badge variant="outline" className={node.Disabled ? "border-muted-foreground/25 text-muted-foreground" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}>{node.Disabled ? "已停用" : "可用"}</Badge></div><div className="mt-6 flex flex-wrap gap-1.5">{node.GroupNodes?.map((group) => <Badge key={group.ID} variant="secondary" className="font-normal">{group.Name}</Badge>)}{!node.GroupNodes?.length && <span className="text-xs text-muted-foreground">未分组节点</span>}</div><div className="mt-auto flex justify-between gap-2 pt-7"><Button variant="outline" size="sm" className="gap-2" onClick={() => void navigator.clipboard.writeText(node.Link).then(() => toast.success("节点链接已复制"))}><Copy className="h-3.5 w-3.5" />复制节点</Button><Button variant="ghost" size="sm" className="gap-2" onClick={() => void toggleNode(node)}><Power className="h-3.5 w-3.5" />{node.Disabled ? "启用" : "停用"}</Button></div></article>)}{!nodes.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">暂无节点</p>}</div> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>节点</TableHead><TableHead>协议</TableHead><TableHead>分组</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{nodes.map((node) => <TableRow key={node.ID}><TableCell><div className="font-medium">{node.Name}</div><div className="mt-1 max-w-80 truncate font-mono text-xs text-muted-foreground">{node.Link}</div></TableCell><TableCell className="uppercase">{node.Link.split(":")[0] || "--"}</TableCell><TableCell>{node.GroupNodes?.map((group) => group.Name).join("、") || "--"}</TableCell><TableCell><Badge variant="outline" className={node.Disabled ? "text-muted-foreground" : "border-emerald-500/30 text-emerald-600"}>{node.Disabled ? "已停用" : "可用"}</Badge></TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => void toggleNode(node)}>{node.Disabled ? "启用" : "停用"}</Button></TableCell></TableRow>)}</TableBody></Table>{!nodes.length && <p className="py-16 text-center text-sm text-muted-foreground">暂无节点</p>}</div>
              ) : (
                viewMode === "card" ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{templates.map((template) => <article key={template.File} className="flex min-h-52 flex-col rounded-xl border border-border/55 bg-background/45 p-4 shadow-sm transition-colors hover:border-primary/35 hover:bg-background/65"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold">{template.File}</h2><p className="mt-1 text-xs text-muted-foreground">{template.File.endsWith(".conf") ? "Surge 配置模板" : "Clash YAML 模板"}</p></div><FileCode2 className="h-5 w-5 shrink-0 text-primary" /></div><pre className="mt-5 line-clamp-3 overflow-hidden rounded-lg bg-muted/35 p-3 font-mono text-xs leading-5 text-muted-foreground">{template.Text}</pre><div className="mt-auto flex items-center justify-between gap-2 pt-5 text-xs text-muted-foreground"><span>{formatDate(template.CreateDate)}</span><div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => openEditor("template-edit", template)}>编辑</Button><Button variant="outline" size="sm" onClick={() => setTemplatePreview(template)}>查看</Button></div></div></article>)}{!templates.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">暂无订阅模板</p>}</div> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>模板文件</TableHead><TableHead>类型</TableHead><TableHead>更新时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{templates.map((template) => <TableRow key={template.File}><TableCell className="font-medium">{template.File}</TableCell><TableCell>{template.File.endsWith(".conf") ? "Surge" : "Clash YAML"}</TableCell><TableCell className="text-xs text-muted-foreground">{formatDate(template.CreateDate)}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => openEditor("template-edit", template)}>编辑</Button><Button variant="ghost" size="sm" onClick={() => setTemplatePreview(template)}>查看</Button></TableCell></TableRow>)}</TableBody></Table>{!templates.length && <p className="py-16 text-center text-sm text-muted-foreground">暂无订阅模板</p>}</div>
              )}
            </CardContent>
          </section>
        )}
        <input ref={templateFileInputRef} className="hidden" type="file" accept=".yaml,.yml,.conf,.list,text/yaml,text/plain" onChange={(event) => { void importTemplateFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        {isSubscriptionWizardOpen ? <SubscriptionWizard
          open
          step={subscriptionStep} setStep={setSubscriptionStep}
          name={editorName} setName={setEditorName}
          expireAt={editorExpireAt} setExpireAt={setEditorExpireAt}
          accessLimit={editorAccessLimit} setAccessLimit={setEditorAccessLimit}
          outputType={editorOutputType} setOutputType={setEditorOutputType}
          template={subscriptionTemplate} setTemplate={setSubscriptionTemplate}
          udp={subscriptionUdp} setUdp={setSubscriptionUdp}
          cert={subscriptionCert} setCert={setSubscriptionCert}
          nodes={nodes} selectedNodeIds={editorNodeIds} toggleNode={toggleEditorNode}
          templates={templates} policyGroups={policyGroups} setPolicyGroups={setPolicyGroups}
          policyGroupName={policyGroupName} setPolicyGroupName={setPolicyGroupName}
          saving={isSavingEditor} onSave={() => void saveEditor()} onClose={() => setEditorMode(null)}
        /> : <Dialog open={!!editorMode} onOpenChange={(open) => { if (!open) setEditorMode(null); }}>
          <DialogContent className={cn("max-w-2xl", (editorMode === "template-add" || editorMode === "template-edit" || editorMode === "template-import") && "max-w-[calc(100vw-4rem)]") }>
            <DialogHeader><DialogTitle>{editorMode === "subscription" ? "新建订阅" : editorMode === "node-subscription" ? "新建节点订阅" : editorMode === "node" ? "新建节点" : editorMode === "template-edit" ? "编辑模板" : editorMode === "template-import" ? "导入模板预览" : "新建模板"}</DialogTitle><DialogDescription>{editorMode === "template-import" ? "文件尚未写入服务器；确认内容后保存即可导入。" : "字段会直接写入现有代理订阅服务。"}</DialogDescription></DialogHeader>
            {editorMode === "subscription" ? <div className="space-y-5"><div className="flex flex-wrap gap-2">{["基本信息", "输出模板", "选择节点", "策略组分配", "确认保存"].map((title, index) => <Button key={title} variant={subscriptionStep === index ? "secondary" : "ghost"} size="sm" disabled={index > subscriptionStep + 1} onClick={() => setSubscriptionStep(index)}>{index + 1}. {title}</Button>)}</div>{subscriptionStep === 0 && <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2 sm:col-span-2"><label className="text-sm font-medium">订阅名称</label><Input value={editorName} onChange={(event) => setEditorName(event.target.value)} placeholder="例如 myclash" /></div><div className="space-y-2"><label className="text-sm font-medium">到期时间</label><Input type="datetime-local" value={editorExpireAt} onChange={(event) => setEditorExpireAt(event.target.value)} /></div><div className="space-y-2"><label className="text-sm font-medium">访问次数限制</label><Input type="number" min="0" value={editorAccessLimit} onChange={(event) => setEditorAccessLimit(event.target.value)} placeholder="留空表示不限" /></div></div>}{subscriptionStep === 1 && <div className="space-y-4"><div className="space-y-2"><label className="text-sm font-medium">订阅类型</label><select value={editorOutputType} onChange={(event) => setEditorOutputType(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="clash">Clash / V2Ray</option><option value="surge">Surge</option><option value="egern">Egern</option><option value="loon">Loon</option></select></div><div className="space-y-2"><label className="text-sm font-medium">{editorOutputType.toUpperCase()} 模板</label><select value={subscriptionTemplate} onChange={(event) => setSubscriptionTemplate(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">使用默认模板</option>{templates.map((template) => <option key={template.File} value={`./template/${template.File}`}>{template.File}</option>)}</select></div><div className="flex gap-5 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={subscriptionUdp} onChange={(event) => setSubscriptionUdp(event.target.checked)} />启用 UDP</label><label className="flex items-center gap-2"><input type="checkbox" checked={subscriptionCert} onChange={(event) => setSubscriptionCert(event.target.checked)} />跳过证书验证</label></div></div>}{subscriptionStep === 2 && <div className="grid gap-4 md:grid-cols-2"><div className="rounded-lg border border-border/60 p-3"><p className="mb-2 text-sm font-medium">可选节点</p>{nodes.filter((node) => !node.Disabled && !editorNodeIds.includes(node.ID)).map((node) => <button key={node.ID} className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-muted" onClick={() => toggleEditorNode(node.ID)}>{node.Name}<span className="float-right text-muted-foreground">加入</span></button>)}</div><div className="rounded-lg border border-border/60 p-3"><p className="mb-2 text-sm font-medium">已选节点 · {editorNodeIds.length}</p>{editorNodeIds.map((id, index) => <div key={id} className="flex items-center gap-2 py-2 text-sm"><span className="text-muted-foreground">{index + 1}</span><span className="flex-1">{nodes.find((node) => node.ID === id)?.Name}</span><Button variant="ghost" size="sm" onClick={() => toggleEditorNode(id)}>移除</Button></div>)}</div></div>}{subscriptionStep === 3 && <div className="space-y-3"><div className="flex gap-2"><Input value={policyGroupName} onChange={(event) => setPolicyGroupName(event.target.value)} placeholder="策略组名称，例如：节点选择" /><Button variant="outline" onClick={() => { const name = policyGroupName.trim(); if (name) { setPolicyGroups((current) => ({ ...current, [name]: { mode: "all", nodes: [] } })); setPolicyGroupName(""); } }}>添加策略组</Button></div>{Object.entries(policyGroups).map(([name, rule]) => <div key={name} className="rounded-lg border border-border/60 p-3"><div className="flex items-center justify-between"><strong className="text-sm">{name}</strong><Button variant="ghost" size="sm" onClick={() => setPolicyGroups((current) => { const next = { ...current }; delete next[name]; return next; })}>移除</Button></div><select value={rule.mode} onChange={(event) => setPolicyGroups((current) => ({ ...current, [name]: { ...rule, mode: event.target.value as "all" | "include" | "none" } }))} className="mt-2 h-9 rounded border border-input bg-background px-2 text-sm"><option value="all">全部已选节点</option><option value="include">指定节点</option><option value="none">不注入节点</option></select>{rule.mode === "include" && <div className="mt-2 flex flex-wrap gap-2">{editorNodeIds.map((id) => <label key={id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={rule.nodes.includes(id)} onChange={() => setPolicyGroups((current) => ({ ...current, [name]: { ...rule, nodes: rule.nodes.includes(id) ? rule.nodes.filter((item) => item !== id) : [...rule.nodes, id] } }))} />{nodes.find((node) => node.ID === id)?.Name}</label>)}</div>}</div>)}</div>}{subscriptionStep === 4 && <div className="space-y-2 rounded-lg border border-border/60 p-4 text-sm"><p><b>名称：</b>{editorName || "未填写"}</p><p><b>类型：</b>{editorOutputType.toUpperCase()}</p><p><b>节点：</b>{editorNodeIds.length} 个</p><p><b>策略组：</b>{Object.keys(policyGroups).length} 个</p></div>}<div className="flex justify-between"><Button variant="outline" disabled={subscriptionStep === 0} onClick={() => setSubscriptionStep((step) => step - 1)}>上一步</Button>{subscriptionStep < 4 ? <Button onClick={() => { if (subscriptionStep === 0 && !editorName.trim()) return toast.error("请输入订阅名称"); if (subscriptionStep === 2 && !editorNodeIds.length) return toast.error("至少选择一个节点"); setSubscriptionStep((step) => step + 1); }}>下一步</Button> : null}</div></div> : editorMode === "node" ? <div className="space-y-4"><div className="space-y-2"><label className="text-sm font-medium">节点名称</label><Input value={editorName} onChange={(event) => setEditorName(event.target.value)} placeholder="单条可填写；批量添加时留空自动读取链接注释" /></div><div className="space-y-2"><label className="text-sm font-medium">节点链接</label><textarea value={editorLink} onChange={(event) => setEditorLink(event.target.value)} placeholder="支持一个或多个链接，每行一条" className="min-h-32 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs" /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={replaceIpEnabled} onChange={(event) => setReplaceIpEnabled(event.target.checked)} />替换入口 IP（SS / VLESS）</label>{replaceIpEnabled && <select value={replaceIpId} onChange={(event) => setReplaceIpId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">选择节点库入口 IP</option>{ipEntries.map((entry) => <option key={entry.ID} value={entry.ID}>{entry.Alias} · {entry.Address}</option>)}</select>}<div className="grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-sm font-medium">所属分组</p><div className="max-h-28 overflow-auto rounded border border-border/60 p-2">{Array.from(new Set(nodes.flatMap((node) => node.GroupNodes?.map((group) => group.Name) || []))).map((group) => <label key={group} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={editorGroups.includes(group)} onChange={() => setEditorGroups((current) => current.includes(group) ? current.filter((item) => item !== group) : [...current, group])} />{group}</label>)}</div><Input className="mt-2" value={editorNewGroup} onChange={(event) => setEditorNewGroup(event.target.value)} placeholder="或新建分组名称" /></div><div><p className="mb-2 text-sm font-medium">关联订阅</p><div className="max-h-36 overflow-auto rounded border border-border/60 p-2">{subscriptions.map((sub) => <label key={sub.ID} className="block py-1 text-sm"><input type="checkbox" checked={editorSubscriptionIds.includes(sub.ID)} onChange={() => setEditorSubscriptionIds((current) => current.includes(sub.ID) ? current.filter((item) => item !== sub.ID) : [...current, sub.ID])} /> {sub.Name}</label>)}</div></div></div></div> : (editorMode === "node-subscription") ? <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><label className="text-sm font-medium">名称</label><Input value={editorName} onChange={(event) => setEditorName(event.target.value)} placeholder="例如：全球高速" /></div><div className="space-y-2"><label className="text-sm font-medium">访问限额（可选）</label><Input type="number" min="0" value={editorAccessLimit} onChange={(event) => setEditorAccessLimit(event.target.value)} placeholder="留空表示不限" /></div><div className="space-y-2"><label className="text-sm font-medium">到期时间（可选）</label><Input type="datetime-local" value={editorExpireAt} onChange={(event) => setEditorExpireAt(event.target.value)} /></div></div><div className="space-y-2"><div className="flex items-center justify-between"><label className="text-sm font-medium">选择节点</label><span className="text-xs text-muted-foreground">已选 {editorNodeIds.length} 个</span></div><div className="grid max-h-56 gap-2 overflow-auto rounded-lg border border-border/60 p-3 sm:grid-cols-2">{nodes.filter((node) => !node.Disabled).map((node) => <label key={node.ID} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"><input type="checkbox" checked={editorNodeIds.includes(node.ID)} onChange={() => toggleEditorNode(node.ID)} /><span className="min-w-0 truncate text-sm">{node.Name}</span><span className="ml-auto text-xs text-muted-foreground">{node.Link.split(":")[0]}</span></label>)}</div></div></div> : <div className="space-y-4"><div className="flex items-end gap-3"><div className="min-w-0 flex-1 space-y-2"><label className="text-sm font-medium">文件名</label><Input value={templateFilename} onChange={(event) => setTemplateFilename(event.target.value)} placeholder="例如：my-clash.yaml" /></div><Button variant="outline" size="sm" className="mb-0.5 gap-2" onClick={() => setTemplateFindOpen((open) => !open)}><Search className="h-3.5 w-3.5" />查找替换</Button></div>{templateFindOpen && <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 sm:grid-cols-[1fr_1fr_auto]"><Input value={templateFindText} onChange={(event) => setTemplateFindText(event.target.value)} placeholder="查找内容" /><Input value={templateReplaceText} onChange={(event) => setTemplateReplaceText(event.target.value)} placeholder="替换为" /><Button variant="secondary" onClick={replaceTemplateText}>全部替换</Button></div>}<div className="grid min-h-[58svh] gap-4 lg:grid-cols-2"><section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/10"><div className="flex items-center justify-between border-b border-border/60 px-4 py-3"><span className="text-sm font-semibold">YAML 编辑</span><span className="text-xs text-muted-foreground">Tab 缩进 2 个空格</span></div><div className="flex min-h-0 flex-1 overflow-hidden font-mono text-xs leading-6"><div aria-hidden className="select-none overflow-hidden border-r border-border/60 bg-muted/30 px-3 py-3 text-right text-muted-foreground">{Array.from({ length: Math.max(1, templateText.split("\n").length) }, (_, index) => <div key={index}>{index + 1}</div>)}</div><textarea value={templateText} onChange={(event) => setTemplateText(event.target.value)} placeholder="输入或粘贴模板内容" spellCheck={false} className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-6 outline-none" /></div></section><section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/10"><div className="flex items-center justify-between border-b border-border/60 px-4 py-3"><span className="text-sm font-semibold">实时预览</span><span className="text-xs text-muted-foreground">同步显示当前内容</span></div><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground">{templateText || "# 暂无内容"}</pre></section></div></div>}
            <DialogFooter><Button variant="outline" onClick={() => setEditorMode(null)}>取消</Button><Button onClick={() => void saveEditor()} disabled={isSavingEditor}>{isSavingEditor ? "保存中…" : editorMode === "template-import" ? "保存模板" : "保存"}</Button></DialogFooter>
          </DialogContent>
        </Dialog>}
        <Dialog open={!!clientSubscription} onOpenChange={(open) => { if (!open) setClientSubscription(null); }}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{clientSubscription?.Name || "订阅"} · 客户端地址</DialogTitle>
              <DialogDescription>选择客户端专用地址并复制到对应客户端中。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 overflow-y-auto py-1">
              {clientSubscription && (outputTypeOf(clientSubscription) === "clash" ? ["clash", "v2ray"] : [outputTypeOf(clientSubscription)]).map((client) => (
                <div key={client} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3"><span className="font-medium uppercase">{client}</span><Button size="sm" variant="outline" className="gap-2" onClick={() => void copySubscriptionUrl(clientSubscription, client)}><Copy className="h-3.5 w-3.5" />复制</Button></div>
                  <Input readOnly value={subscriptionUrl(clientSubscription, client)} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
                </div>
              ))}
            </div>
            <DialogFooter><Button variant="outline" onClick={() => setClientSubscription(null)}>关闭</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={!!logSubscription} onOpenChange={(open) => { if (!open) setLogSubscription(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>{logSubscription?.Name || "订阅"} · 访问记录</DialogTitle><DialogDescription>展示该订阅已记录的客户端访问。</DialogDescription></DialogHeader>
            <div className="max-h-[55svh] overflow-auto rounded-lg border border-border/60">
              <Table><TableHeader><TableRow><TableHead>IP</TableHead><TableHead>地址</TableHead><TableHead>次数</TableHead><TableHead>时间</TableHead></TableRow></TableHeader><TableBody>
                {(logSubscription?.SubLogs || []).map((log) => <TableRow key={log.ID}><TableCell className="font-mono text-xs">{log.IP || "--"}</TableCell><TableCell>{log.Addr || "--"}</TableCell><TableCell>{Number(log.Count || 0).toLocaleString()}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(log.Date)}</TableCell></TableRow>)}
              </TableBody></Table>
              {!logSubscription?.SubLogs?.length && <p className="py-12 text-center text-sm text-muted-foreground">暂未记录访问</p>}
            </div>
            <DialogFooter><Button variant="outline" onClick={() => setLogSubscription(null)}>关闭</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={!!templatePreview} onOpenChange={(open) => { if (!open) setTemplatePreview(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>{templatePreview?.File || "订阅模板"}</DialogTitle><DialogDescription>模板预览。编辑与新建将在下一步接入。</DialogDescription></DialogHeader>
            <pre className="max-h-[60svh] overflow-auto rounded-lg border border-border/60 bg-muted/20 p-4 font-mono text-xs leading-6 text-foreground">{templatePreview?.Text || ""}</pre>
            <DialogFooter><Button variant="outline" onClick={() => setTemplatePreview(null)}>关闭</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={ipLibraryOpen} onOpenChange={setIpLibraryOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>节点库</DialogTitle><DialogDescription>维护转发链路第一台机器的入口 IP；修改或删除不会影响已经保存的节点。</DialogDescription></DialogHeader>
            <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 sm:grid-cols-[1fr_1fr_auto]">
              <Input value={ipForm.Address} onChange={(event) => setIpForm((current) => ({ ...current, Address: event.target.value }))} placeholder="IP 地址，例如 198.51.100.24" />
              <Input value={ipForm.Alias} onChange={(event) => setIpForm((current) => ({ ...current, Alias: event.target.value }))} placeholder="别名，例如：香港入口 A" onKeyDown={(event) => { if (event.key === "Enter") void saveIpEntry(); }} />
              <div className="flex gap-2"><Button onClick={() => void saveIpEntry()} disabled={isSavingIp}>{isSavingIp ? "保存中" : ipForm.ID ? "保存" : "加入节点库"}</Button>{ipForm.ID ? <Button variant="ghost" onClick={() => setIpForm({ ID: 0, Alias: "", Address: "" })}>取消</Button> : null}</div>
            </div>
            <div className="max-h-[45svh] overflow-auto rounded-lg border border-border/60">
              <Table><TableHeader><TableRow><TableHead>别名</TableHead><TableHead>IP 地址</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{ipEntries.map((entry) => <TableRow key={entry.ID}><TableCell className="font-medium">{entry.Alias}</TableCell><TableCell className="font-mono text-xs">{entry.Address}</TableCell><TableCell className="text-xs text-muted-foreground">{formatDate(entry.CreatedAt)}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => setIpForm({ ID: entry.ID, Alias: entry.Alias, Address: entry.Address })}>编辑</Button><Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void removeIpEntry(entry)}>删除</Button></TableCell></TableRow>)}</TableBody></Table>
              {!ipEntries.length && <p className="py-12 text-center text-sm text-muted-foreground">节点库还是空的</p>}
            </div>
            <DialogFooter><Button variant="outline" onClick={() => setIpLibraryOpen(false)}>关闭</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
