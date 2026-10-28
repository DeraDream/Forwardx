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
import { NodeSubscriptionDialog } from "@/components/subscriptions/NodeSubscriptionDialog";
import { NodeAddDialog } from "@/components/subscriptions/NodeAddDialog";
import { IpLibraryDialog } from "@/components/subscriptions/IpLibraryDialog";
import { TemplateImportDialog } from "@/components/subscriptions/TemplateImportDialog";
import { TemplateVisualEditorDialog } from "@/components/subscriptions/TemplateVisualEditorDialog";
import { parseDocument as parseYamlDocument } from "yaml";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Activity, Clock3, Copy, Database, Ellipsis, FileCode2, FileText, FolderPlus, Library, LayoutGrid, Link2, List, Loader2, MonitorSmartphone, Network, Pencil, Plus, Power, RefreshCw, Search, Server, Trash2, Upload, UsersRound } from "lucide-react";

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

/** 依据模板正文的格式特征识别客户端，不用文件扩展名猜测。 */
function templateFormat(template: TemplateRecord) {
  const source = template.Text.replace(/\r/g, "");
  if (/^\s*policy_groups\s*:/m.test(source) || /^\s*policy_groups_order\s*:/m.test(source)) return "Egern YAML";
  if (/^\s*#.*\bLoon\b/im.test(source) || /^\s*\[(?:Remote Proxy|Rewrite|Script|Plugin)\]\s*$/im.test(source)) return "Loon INI";
  if (/^\s*(?:proxy-groups|proxies|proxy-providers|rule-providers|mixed-port|tun)\s*:/m.test(source)) return "Clash YAML";
  return "未识别格式";
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

type NodeProtocol = "ss" | "ssr" | "vless" | "vmess" | "trojan" | "hy2" | "tuic" | "snell" | "other";

function nodeProtocol(link: string): NodeProtocol {
  const value = (link.match(/^([a-z0-9+-]+):\/\//i)?.[1] || "").toLowerCase();
  if (value === "hysteria2" || value === "hy2") return "hy2";
  if (["ss", "ssr", "vless", "vmess", "trojan", "tuic", "snell"].includes(value)) return value as NodeProtocol;
  return "other";
}

function nodeProtocolLabel(protocol: NodeProtocol) {
  return protocol === "hy2" ? "HY2" : protocol === "other" ? "未知" : protocol.toUpperCase();
}

function nodeProtocolClass(protocol: NodeProtocol) {
  return ({
    ss: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300",
    ssr: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300",
    vless: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300",
    vmess: "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-300",
    trojan: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    hy2: "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-300",
    tuic: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    snell: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
    other: "border-border bg-muted/60 text-muted-foreground",
  } as const)[protocol];
}

function nodeEndpoint(link: string) {
  const protocol = nodeProtocol(link);
  if (protocol === "ss") {
    const payload = link.replace(/^ss:\/\//i, "").split(/[?#]/)[0];
    // SIP002 links may put the entire method:password@host:port payload in Base64.
    // Decode only that legacy form; modern ss://method:password@host:port links
    // continue through the standard URL parser below.
    if (!payload.includes("@")) {
      try {
        const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
        const decoded = typeof atob === "function" ? atob(normalized) : "";
        const match = decoded.match(/@([^:/?#]+)(?::(\d+))?/);
        if (match?.[1]) return { host: match[1], port: match[2] || "--" };
      } catch {
        // Keep the regular parser fallback for malformed or non-Base64 links.
      }
    }
  }
  try {
    const url = new URL(link);
    return { host: url.hostname || "--", port: url.port || "--" };
  } catch {
    const match = link.match(/@([^:/?#]+)(?::(\d+))?/);
    return { host: match?.[1] || "--", port: match?.[2] || "--" };
  }
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
  if (outputType === "clash" || outputType === "egern") {
    const document = parseYamlDocument(text, { prettyErrors: false, strict: false });
    const root = document.toJS();
    if (!document.errors.length && root && !Array.isArray(root) && typeof root === "object") {
      const config = root as Record<string, unknown>;
      if (outputType === "clash") {
        const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
        const names = groups
          .filter((group): group is Record<string, unknown> => Boolean(group) && typeof group === "object" && !Array.isArray(group))
          .map((group) => String(group.name || "").trim())
          .filter(Boolean);
        if (names.length) return [...new Set(names)];
      }
      if (outputType === "egern") {
        const groups = Array.isArray(config.policy_groups) ? config.policy_groups : [];
        const names = groups.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          return Object.values(entry as Record<string, unknown>).flatMap((settings) =>
            settings && typeof settings === "object" && !Array.isArray(settings)
              ? [String((settings as Record<string, unknown>).name || "").trim()]
              : [],
          );
        }).filter(Boolean);
        if (names.length) return [...new Set(names)];
      }
    }
  }
  if (outputType === "egern") {
    const start = lines.findIndex((line) => /^\s*policy_groups\s*:\s*$/i.test(line));
    if (start < 0) return [];
    const sectionIndent = lines[start].search(/\S|$/);
    const names: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.search(/\S|$/);
      if (indent <= sectionIndent && !trimmed.startsWith("-")) break;
      const match = line.match(/^\s+name\s*:\s*["']?([^"'\n#]+)["']?\s*$/i);
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
  const [nodeGroups, setNodeGroups] = useState<string[]>([]);
  const nodeBackupInputRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [subscriptionClientFilter, setSubscriptionClientFilter] = useState<"all" | "clash" | "egern" | "loon">("all");
  const [nodeSearchQuery, setNodeSearchQuery] = useState("");
  const [nodeProtocolFilter, setNodeProtocolFilter] = useState<NodeProtocol | "all">("all");
  const [nodeGroupFilter, setNodeGroupFilter] = useState<string | "all">("all");
  const [clientSubscription, setClientSubscription] = useState<SubscriptionRecord | null>(null);
  const [logSubscription, setLogSubscription] = useState<SubscriptionRecord | null>(null);
  const [templatePreview, setTemplatePreview] = useState<TemplateRecord | null>(null);
  const [ipLibraryOpen, setIpLibraryOpen] = useState(false);
  const [ipEntries, setIpEntries] = useState<IPEntry[]>([]);
  const [ipForm, setIpForm] = useState({ ID: 0, Alias: "", Address: "" });
  const [isSavingIp, setIsSavingIp] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [editorName, setEditorName] = useState("");
  const [editorOriginalName, setEditorOriginalName] = useState("");
  const [editorLink, setEditorLink] = useState("");
  const [editingNode, setEditingNode] = useState<NodeRecord | null>(null);
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
  const [subscriptionDedupe, setSubscriptionDedupe] = useState(true);
  const [subscriptionDoh, setSubscriptionDoh] = useState(false);
  const [policyGroupName, setPolicyGroupName] = useState("");
  const [policyGroups, setPolicyGroups] = useState<Record<string, { mode: "all" | "include" | "none"; nodes: number[] }>>({});
  const [editorGroups, setEditorGroups] = useState<string[]>([]);
  const [editorNewGroup, setEditorNewGroup] = useState("");
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [createGroupName, setCreateGroupName] = useState("");
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [editorSubscriptionIds, setEditorSubscriptionIds] = useState<number[]>([]);
  const [replaceIpEnabled, setReplaceIpEnabled] = useState(false);
  const [replaceIpId, setReplaceIpId] = useState("");
  const [isSavingEditor, setIsSavingEditor] = useState(false);
  const confirm = useConfirmDialog();
  const activeItem = sections.find((item) => item.value === activeSection)!;
  const ActiveIcon = activeItem.icon || Link2;
  const selectedSubscriptionTemplateText = useMemo(() => {
    const defaultFile = editorOutputType === "loon" ? "loon.conf" : editorOutputType === "egern" ? "egern.yaml" : "clash.yaml";
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
      const [subscriptionData, nodeSubscriptionData, nodeData, templateData, groupData] = await Promise.all([
        sublinkRequest<SubscriptionRecord[]>("/api/v1/subcription/get"),
        sublinkRequest<NodeSubscriptionRecord[]>("/api/v1/node-subscription/get"),
        sublinkRequest<NodeListResponse>("/api/v1/nodes/get?all=1"),
        sublinkRequest<TemplateApiRecord[]>("/api/v1/template/get"),
        sublinkRequest<string[]>("/api/v1/nodes/group/get"),
      ]);
      setSubscriptions(Array.isArray(subscriptionData) ? subscriptionData : []);
      setNodeSubscriptions(Array.isArray(nodeSubscriptionData) ? nodeSubscriptionData : []);
      setNodes(Array.isArray(nodeData) ? nodeData : (nodeData?.items || []));
      setNodeGroups(Array.isArray(groupData) ? groupData : []);
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
    return subscriptions.filter((item) => {
      const client = outputTypeOf(item);
      return (subscriptionClientFilter === "all" || client === subscriptionClientFilter)
        && (!keyword || `${item.Name} ${client} ${item.Token || ""} ${(item.Nodes || []).length}`.toLowerCase().includes(keyword));
    });
  }, [searchQuery, subscriptionClientFilter, subscriptions]);
  const visibleNodeSubscriptions = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    return nodeSubscriptions.filter((item) => !keyword || `${item.Name} ${item.Token || ""} ${(item.Nodes || []).length}`.toLowerCase().includes(keyword));
  }, [nodeSubscriptions, searchQuery]);
  const visibleNodes = useMemo(() => {
    const keyword = nodeSearchQuery.trim().toLowerCase();
    return nodes.filter((node) => {
      const protocol = nodeProtocol(node.Link);
      const matchesProtocol = nodeProtocolFilter === "all" || protocol === nodeProtocolFilter;
      const matchesGroup = nodeGroupFilter === "all" || node.GroupNodes?.some((group) => group.Name === nodeGroupFilter);
      const matchesSearch = !keyword || `${node.Name} ${node.Link} ${(node.GroupNodes || []).map((group) => group.Name).join(" ")}`.toLowerCase().includes(keyword);
      return matchesProtocol && matchesGroup && matchesSearch;
    });
  }, [nodeGroupFilter, nodeProtocolFilter, nodeSearchQuery, nodes]);
  const nodeProtocolCounts = useMemo(() => nodes.reduce((result, node) => {
    const protocol = nodeProtocol(node.Link);
    result[protocol] = (result[protocol] || 0) + 1;
    return result;
  }, {} as Partial<Record<NodeProtocol, number>>), [nodes]);

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

  const setSubscriptionRevoked = async (subscription: SubscriptionRecord) => {
    const revoke = !subscription.Revoked;
    if (!await confirm({ title: revoke ? "停用订阅" : "恢复订阅", description: revoke ? `停用「${subscription.Name}」后，该订阅地址将立即不可用。` : `恢复「${subscription.Name}」的订阅访问吗？`, confirmText: revoke ? "停用" : "恢复", tone: revoke ? "destructive" : "default" })) return;
    try {
      const body = new FormData(); body.set("id", String(subscription.ID)); body.set("revoked", String(revoke));
      await sublinkRequest("/api/v1/subcription/revoked", { method: "POST", body });
      toast.success(revoke ? "订阅已停用" : "订阅已恢复"); await loadSubscriptions();
    } catch (error) { toast.error(error instanceof Error ? error.message : "订阅状态更新失败"); }
  };

  const editNodeSubscription = (subscription: NodeSubscriptionRecord) => {
    setEditorMode("node-subscription"); setEditorOriginalName(subscription.Name); setEditorName(subscription.Name);
    setEditorNodeIds((subscription.Nodes || []).map((node) => node.ID));
    setEditorExpireAt(subscription.ExpireAt ? new Date(subscription.ExpireAt).toISOString().slice(0, 16) : "");
    setEditorAccessLimit(subscription.AccessLimit ? String(subscription.AccessLimit) : "");
  };

  const postNodeSubscriptionAction = async (path: string, id: number) => {
    const body = new FormData(); body.set("id", String(id));
    await sublinkRequest(path, { method: "POST", body }); await loadSubscriptions();
  };

  const resetNodeSubscriptionToken = async (subscription: NodeSubscriptionRecord) => {
    if (!await confirm({ title: "重置节点订阅 Token", description: `重置「${subscription.Name}」后，旧链接会立刻失效。`, confirmText: "重置 Token" })) return;
    try { await postNodeSubscriptionAction("/api/v1/node-subscription/reset-token", subscription.ID); toast.success("节点订阅 Token 已重置"); } catch (error) { toast.error(error instanceof Error ? error.message : "Token 重置失败"); }
  };

  const setNodeSubscriptionRevoked = async (subscription: NodeSubscriptionRecord) => {
    const revoke = !subscription.Revoked;
    if (!await confirm({ title: revoke ? "停用节点订阅" : "恢复节点订阅", description: revoke ? `停用「${subscription.Name}」后，该链接将立即不可用。` : `恢复「${subscription.Name}」的访问吗？`, confirmText: revoke ? "停用" : "恢复", tone: revoke ? "destructive" : "default" })) return;
    try { const body = new FormData(); body.set("id", String(subscription.ID)); body.set("revoked", String(revoke)); await sublinkRequest("/api/v1/node-subscription/revoked", { method: "POST", body }); toast.success(revoke ? "节点订阅已停用" : "节点订阅已恢复"); await loadSubscriptions(); } catch (error) { toast.error(error instanceof Error ? error.message : "节点订阅状态更新失败"); }
  };

  const deleteNodeSubscription = async (subscription: NodeSubscriptionRecord) => {
    if (!await confirm({ title: "删除节点订阅", description: `确定删除「${subscription.Name}」吗？此操作无法撤销。`, confirmText: "删除", tone: "destructive" })) return;
    try { await sublinkRequest(`/api/v1/node-subscription/delete?id=${encodeURIComponent(String(subscription.ID))}`, { method: "DELETE" }); toast.success("节点订阅已删除"); await loadSubscriptions(); } catch (error) { toast.error(error instanceof Error ? error.message : "删除失败"); }
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

  const exportNodes = async () => {
    try {
      const response = await fetch("/api/v1/nodes/export", { credentials: "same-origin" });
      if (!response.ok) throw new Error("节点导出失败");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "sublink-nodes.json"; anchor.click();
      URL.revokeObjectURL(url);
      toast.success("节点备份已导出");
    } catch (error) { toast.error(error instanceof Error ? error.message : "节点导出失败"); }
  };

  const importNodeBackup = async (file?: File) => {
    if (!file) return;
    try {
      const body = new FormData(); body.set("file", file);
      await sublinkRequest("/api/v1/nodes/import", { method: "POST", body });
      toast.success("节点备份已导入");
      await loadSubscriptions();
    } catch (error) { toast.error(error instanceof Error ? error.message : "节点备份导入失败"); }
    finally { if (nodeBackupInputRef.current) nodeBackupInputRef.current.value = ""; }
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
    setEditorMode(mode); setEditorOriginalName("");
    setEditorName(""); setEditorLink(""); setEditorNodeIds([]); setEditorExpireAt(""); setEditorAccessLimit(""); setEditorOutputType("clash");
    setTemplateFilename(template?.File || ""); setTemplateOriginalFilename(template?.File || ""); setTemplateText(template?.Text || "");
    setSubscriptionStep(0); setSubscriptionTemplate(""); setSubscriptionUdp(true); setSubscriptionCert(true); setSubscriptionDedupe(true); setSubscriptionDoh(false); setPolicyGroupName(""); setPolicyGroups({});
    setEditorGroups([]); setEditorNewGroup(""); setEditorSubscriptionIds([]); setReplaceIpEnabled(false); setReplaceIpId(""); setEditingNode(null);
    if (mode === "node") void loadIpLibrary();
  };

  const openNodeEditor = (node: NodeRecord) => {
    openEditor("node");
    setEditingNode(node); setEditorName(node.Name); setEditorLink(node.Link);
    setEditorGroups((node.GroupNodes || []).map((group) => group.Name));
  };

  const toggleEditorNode = (id: number) => setEditorNodeIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const createNodeGroup = async () => {
    const name = createGroupName.trim();
    if (!name) return;
    setIsCreatingGroup(true);
    try {
      const body = new FormData(); body.set("name", name);
      await sublinkRequest("/api/v1/nodes/group/add", { method: "POST", body });
      await loadSubscriptions();
      setEditorGroups((current) => current.includes(name) ? current : [...current, name]);
      setCreateGroupName(""); setCreateGroupOpen(false);
      toast.success("分组已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建分组失败");
    } finally { setIsCreatingGroup(false); }
  };

  const editSubscription = (subscription: SubscriptionRecord) => {
    let config: Record<string, any> = {};
    try { config = JSON.parse(subscription.Config || "{}"); } catch { /* keep defaults */ }
    setEditorMode("subscription"); setEditorOriginalName(subscription.Name); setEditorName(subscription.Name);
    setEditorNodeIds((subscription.Nodes || []).map((node) => node.ID)); setEditorExpireAt(subscription.ExpireAt ? new Date(subscription.ExpireAt).toISOString().slice(0, 16) : ""); setEditorAccessLimit(subscription.AccessLimit ? String(subscription.AccessLimit) : "");
    setEditorOutputType(typeof config.output_type === "string" ? config.output_type : "clash"); setSubscriptionTemplate(typeof config.clash === "string" ? config.clash : ""); setSubscriptionUdp(config.udp === true || config.udp === "true"); setSubscriptionCert(config.cert === true || config.cert === "true"); setPolicyGroups(Object.fromEntries(Object.entries(config.group_nodes || {}).map(([name, rule]: [string, any]) => [name, { mode: rule.mode || "all", nodes: (rule.nodes || []).map((nodeName: string) => nodes.find((node) => node.Name === nodeName)?.ID).filter(Boolean) }]))); setSubscriptionStep(0);
  };

  const saveEditor = async () => {
    if (!editorMode) return;
    setIsSavingEditor(true);
    try {
      if (editorMode === "node") {
        const links = editorLink.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
        if (!links.length) throw new Error("请填写至少一个节点链接");
        if (links.length > 1 && editorName.trim()) throw new Error("批量添加时请留空节点名称，以链接注释作为名称");
        if (replaceIpEnabled && !replaceIpId) throw new Error("请选择节点库入口 IP");
        if (editingNode) {
          if (links.length !== 1 || !editorName.trim()) throw new Error("编辑节点时请填写名称和一个节点链接");
          const body = new FormData(); body.set("id", String(editingNode.ID)); body.set("name", editorName.trim()); body.set("link", links[0]); body.set("group", editorGroups.join(",")); if (replaceIpEnabled) body.set("replace_ip_id", replaceIpId); await sublinkRequest("/api/v1/nodes/update", { method: "POST", body });
        } else {
          for (const link of links) { const body = new FormData(); body.set("name", links.length === 1 ? editorName.trim() : ""); body.set("link", link); body.set("group", editorGroups.length ? editorGroups.join(",") : editorNewGroup.trim()); body.set("subscription_ids", editorSubscriptionIds.join(",")); if (replaceIpEnabled) body.set("replace_ip_id", replaceIpId); await sublinkRequest("/api/v1/nodes/add", { method: "POST", body }); }
        }
      } else if (editorMode === "subscription" || editorMode === "node-subscription") {
        if (!editorName.trim() || !editorNodeIds.length) throw new Error("请填写名称并至少选择一个节点");
        const body = new FormData(); body.set("name", editorName.trim()); body.set("nodes", editorNodeIds.join(",")); body.set("expire_at", editorExpireAt); body.set("access_limit", editorAccessLimit);
        if (editorMode === "subscription") body.set("config", JSON.stringify({ output_type: editorOutputType, clash: editorOutputType === "clash" ? subscriptionTemplate : "", surge: editorOutputType === "surge" ? subscriptionTemplate : "", egern: editorOutputType === "egern" ? subscriptionTemplate : "", loon: editorOutputType === "loon" ? subscriptionTemplate : "", udp: subscriptionUdp, cert: subscriptionCert, dedupe_nodes: subscriptionDedupe, doh_dns: subscriptionDoh, group_nodes: Object.fromEntries(Object.entries(policyGroups).map(([name, rule]) => [name, { mode: rule.mode, nodes: rule.mode === "include" ? rule.nodes.map((id) => nodes.find((node) => node.ID === id)?.Name).filter(Boolean) : [] }])) }));
        const isEditing = Boolean(editorOriginalName);
        if (isEditing) body.set("oldname", editorOriginalName);
        await sublinkRequest(`/api/v1/${editorMode === "subscription" ? "subcription" : "node-subscription"}/${isEditing ? "update" : "add"}`, { method: "POST", body });
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

  const saveImportedTemplate = async (filename: string, text: string) => {
    setIsSavingEditor(true);
    try {
      const body = new FormData(); body.set("filename", filename); body.set("text", text);
      await sublinkRequest("/api/v1/template/add", { method: "POST", body });
      toast.success("模板已导入");
      setEditorMode(null);
      await loadSubscriptions();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "模板导入失败");
      throw error;
    } finally { setIsSavingEditor(false); }
  };

  const saveVisualTemplate = async (filename: string, text: string) => {
    if (!filename.trim() || !text.trim()) {
      toast.error("请填写模板文件名和模板内容");
      return;
    }
    setIsSavingEditor(true);
    try {
      const body = new FormData();
      body.set("filename", filename.trim());
      body.set("text", text);
      if (editorMode === "template-edit") {
        body.set("oldname", templateOriginalFilename);
        await sublinkRequest("/api/v1/template/update", { method: "POST", body });
      } else {
        await sublinkRequest("/api/v1/template/add", { method: "POST", body });
      }
      toast.success(editorMode === "template-edit" ? "模板已保存" : "模板已创建");
      setEditorMode(null);
      await loadSubscriptions();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
      throw error;
    } finally {
      setIsSavingEditor(false);
    }
  };

  const fetchImportedTemplate = async (url: string) => {
    const body = new FormData(); body.set("url", url);
    return sublinkRequest<{ text: string; status: number }>("/api/v1/template/fetch", { method: "POST", body });
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
        <DropdownMenuItem onSelect={() => editSubscription(subscription)}>
          <Pencil className="h-4 w-4" />编辑
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleResetToken(subscription)}>
          <RefreshCw className="h-4 w-4" />重置 Token
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void setSubscriptionRevoked(subscription)}>
          <Power className="h-4 w-4" />{subscription.Revoked ? "恢复订阅" : "停用订阅"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void handleDelete(subscription)}>
          <Trash2 className="h-4 w-4" />删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderNodeSubscriptionActions = (subscription: NodeSubscriptionRecord) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`${subscription.Name} 更多操作`}><Ellipsis className="size-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => editNodeSubscription(subscription)}><Pencil className="size-4" />编辑</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void resetNodeSubscriptionToken(subscription)}><RefreshCw className="size-4" />重置 Token</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void setNodeSubscriptionRevoked(subscription)}><Power className="size-4" />{subscription.Revoked ? "恢复订阅" : "停用订阅"}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void deleteNodeSubscription(subscription)}><Trash2 className="size-4" />删除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const isSubscriptionWizardOpen = Boolean(editorMode === "subscription");
  const isNodeSubscriptionDialogOpen = Boolean(editorMode === "node-subscription");
  const isNodeAddDialogOpen = Boolean(editorMode === "node");
  const isTemplateImportDialogOpen = Boolean(editorMode === "template-import");
  const isTemplateVisualEditorOpen = Boolean(editorMode === "template-add" || editorMode === "template-edit");
  // Keep this fallback dialog independently typed: the three specialised
  // dialogs above short-circuit it at runtime, while its legacy JSX remains
  // available for all editor modes during a transition.
  const fallbackEditorMode: EditorMode = editorMode;

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
            <CardHeader className="space-y-4 px-0 pb-5 pt-0">
              <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-card/70 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary"><Link2 className="size-5" /></div><div><CardTitle className="text-lg">订阅链接</CardTitle><CardDescription className="mt-1">管理订阅地址、客户端入口、模板与访问统计</CardDescription><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"><span>总计 <b className="font-mono text-primary">{subscriptions.length}</b> 条</span><span className="text-emerald-600 dark:text-emerald-400">● 有效 {subscriptions.filter((item) => !item.Revoked && !isExpired(item)).length}</span><span className="text-destructive">● 异常 {subscriptions.filter((item) => item.Revoked || isExpired(item)).length}</span><span className="text-muted-foreground">累计请求 {subscriptions.reduce((sum, item) => sum + Number(item.AccessCount || 0), 0).toLocaleString()} 次</span></div></div></div>
                <Button className="shrink-0 gap-2" onClick={() => openEditor("subscription")}><Plus className="size-4" />添加订阅</Button>
              </div>
              <div className="flex flex-col gap-3 rounded-xl border border-border/55 bg-card/55 p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between"><div className="flex flex-wrap items-center gap-1.5">{(["all", "clash", "egern", "loon"] as const).map((client) => <Button key={client} size="sm" variant={subscriptionClientFilter === client ? "default" : "ghost"} className="h-8 gap-1.5" onClick={() => setSubscriptionClientFilter(client)}>{client === "all" ? "全部" : client === "clash" ? "Clash" : client === "egern" ? "Egern" : "Loon"}<span className="rounded bg-foreground/10 px-1 font-mono text-[10px]">{client === "all" ? subscriptions.length : subscriptions.filter((item) => outputTypeOf(item) === client).length}</span></Button>)}</div><div className="relative w-full lg:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索订阅名称、节点或 Token…" className="h-8 pl-8 text-xs" /></div></div>
            </CardHeader>
            <CardContent className={cn("p-0", viewMode === "table" && "overflow-hidden rounded-lg border border-border/40 bg-card/60 backdrop-blur-md")}>
              {isLoading ? (
                <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在读取订阅数据</div>
              ) : loadError ? (
                <div className="grid min-h-72 place-items-center p-6 text-center">
                  <div className="space-y-3"><p className="text-sm text-muted-foreground">{loadError}</p><Button variant="outline" size="sm" onClick={() => void loadSubscriptions()}>重新加载</Button></div>
                </div>
              ) : viewMode === "card" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-4">
                  {visibleSubscriptions.map((subscription) => {
                    const status = statusOf(subscription);
                    const accessCount = Number(subscription.AccessCount || 0);
                    const accessLimit = Number(subscription.AccessLimit || 0);
                    const progress = accessLimit > 0 ? Math.min(100, Math.round(accessCount / accessLimit * 100)) : 100;
                    return (
                      <article key={subscription.ID} className="flex min-h-72 flex-col rounded-xl border border-border/65 bg-card/75 p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="truncate font-semibold tracking-tight">{subscription.Name}</h2>
                            <p className="mt-1 font-mono text-[11px] text-muted-foreground">ID · {subscription.Token ? `${subscription.Token.slice(0, 8)}…` : `sub_${subscription.ID}`}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Badge variant="outline" className={cn("gap-1.5", status.className)}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status.label}</Badge>
                            {renderMoreActions(subscription)}
                          </div>
                        </div>
                        <div className="mt-4 flex items-center justify-between rounded-lg border border-border/55 bg-muted/30 px-3 py-2.5 text-xs"><div><p className="text-muted-foreground">客户端 / 模板</p><p className="mt-1 font-medium uppercase">{outputTypeOf(subscription)} <span className="font-normal text-muted-foreground">· 已选模板</span></p></div><div className="text-right"><p className="text-muted-foreground">关联节点</p><p className="mt-1 font-mono font-semibold text-primary">{subscription.Nodes?.filter((node) => !node.Disabled).length || 0} 个</p></div></div>
                        <div className="mt-3"><div className="flex items-end justify-between gap-2"><span className="flex items-center gap-1.5 text-xs text-secondary-foreground"><Activity className="size-3.5 text-primary" />访问统计</span><span className="font-mono text-xs font-semibold">{accessCount.toLocaleString()} <span className="font-sans font-normal text-muted-foreground">/ {accessLimit > 0 ? accessLimit.toLocaleString() : "不限"}</span></span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div></div>
                        <div className="mt-auto pt-7">
                          <div className="flex items-center justify-between text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Clock3 className="size-3.5" />{formatDate(subscription.CreatedAt || subscription.CreateDate)}</span><Button variant="ghost" size="icon" className="size-7" title="复制订阅链接" onClick={() => void copySubscriptionUrl(subscription)}><Copy className="size-3.5" /></Button></div>
                          <div className="mt-3 flex gap-2"><Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => setClientSubscription(subscription)}><MonitorSmartphone className="size-3.5" />客户端</Button><Button variant="ghost" size="icon" className="size-8" title="访问记录" onClick={() => setLogSubscription(subscription)}><Clock3 className="size-3.5" /></Button>{renderMoreActions(subscription)}</div>
                        </div>
                      </article>
                    );
                  })}
                  {!visibleSubscriptions.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">暂无匹配的订阅</p>}
                </div>
              ) : (
                <Card className="overflow-hidden border-border/40 bg-card/60 backdrop-blur-md">
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader><TableRow><TableHead>订阅名称 / 节点</TableHead><TableHead>客户端 / 模板</TableHead><TableHead>状态</TableHead><TableHead>访问次数 / 上限</TableHead><TableHead>创建时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                        <TableBody>{visibleSubscriptions.map((subscription) => {
                      const status = statusOf(subscription);
                      const accessCount = Number(subscription.AccessCount || 0);
                      const accessLimit = Number(subscription.AccessLimit || 0);
                      return <TableRow key={subscription.ID}>
                        <TableCell className="min-w-48"><div className="font-medium">{subscription.Name}</div><div className="mt-1 font-mono text-[11px] text-muted-foreground">{subscription.Token ? `ID · ${subscription.Token.slice(0, 8)}…` : `sub_${subscription.ID}`} · {subscription.Nodes?.filter((node) => !node.Disabled).length || 0} 个节点</div></TableCell>
                        <TableCell><Button variant="ghost" size="sm" className="h-8 gap-1.5 text-primary" onClick={() => setClientSubscription(subscription)}><MonitorSmartphone className="size-3.5" />{outputTypeOf(subscription).toUpperCase()}</Button><p className="mt-0.5 text-[11px] text-muted-foreground">已选模板</p></TableCell>
                        <TableCell><Badge variant="outline" className={cn("gap-1.5", status.className)}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status.label}</Badge></TableCell>
                        <TableCell><div className="font-mono font-semibold tabular-nums">{accessCount.toLocaleString()} <span className="font-sans text-xs font-normal text-muted-foreground">/ {accessLimit > 0 ? accessLimit.toLocaleString() : "不限"}</span></div><div className="mt-2 h-1 w-36 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${accessLimit > 0 ? Math.min(100, accessCount / accessLimit * 100) : 100}%` }} /></div></TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(subscription.CreatedAt || subscription.CreateDate)}</TableCell>
                        <TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => setClientSubscription(subscription)}><MonitorSmartphone className="size-3.5" />客户端</Button><Button variant="ghost" size="icon" className="size-8" title="复制订阅链接" onClick={() => void copySubscriptionUrl(subscription)}><Copy className="size-3.5" /></Button>{renderMoreActions(subscription)}</div></TableCell>
                      </TableRow>;
                        })}</TableBody>
                      </Table>
                      {!visibleSubscriptions.length && <p className="py-16 text-center text-sm text-muted-foreground">暂无匹配的订阅</p>}
                    </div>
                  </CardContent>
                </Card>
              )}
            </CardContent>
          </section>
        ) : (
          <section className="bg-transparent">
            <CardHeader className="flex-row items-start justify-between gap-4 px-0 pb-5 pt-0">
              <div><CardTitle className="flex items-center gap-2 text-lg"><ActiveIcon className="h-5 w-5 text-primary" />{activeItem.label}</CardTitle><CardDescription className="mt-1.5">{activeSection === "node-subscriptions" ? `原始节点订阅入口 · 共 ${nodeSubscriptions.length} 条 · 可用节点 ${nodeSubscriptions.reduce((sum, item) => sum + (item.Nodes?.filter((node) => !node.Disabled).length || 0), 0)} 个` : sectionDescriptions[activeSection]}</CardDescription></div>
              <div className="flex shrink-0 gap-2">
                {activeSection === "node-subscriptions" && <div className="relative hidden w-64 sm:block"><Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索节点订阅或 Token…" className="h-8 pl-8 text-xs" /></div>}
                {activeSection === "nodes" && <Button variant="outline" size="sm" className="gap-2" onClick={openIpLibrary}><Library className="h-4 w-4" />节点库</Button>}
                {activeSection === "templates" && <Button variant="outline" size="sm" className="gap-2" onClick={() => openEditor("template-import")}><FileText className="h-4 w-4" />导入模板</Button>}
              </div>
            </CardHeader>
            <CardContent className={cn("p-0", viewMode === "table" && "overflow-hidden rounded-lg border border-border/40 bg-card/60 backdrop-blur-md")}>
              {isLoading ? <div className="grid min-h-64 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在读取数据</div> : loadError ? <div className="py-16 text-center text-sm text-muted-foreground">{loadError}</div> : activeSection === "node-subscriptions" ? (
                viewMode === "card" ? <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-4">{visibleNodeSubscriptions.map((item) => {
                  const count = Number(item.AccessCount || 0); const limit = Number(item.AccessLimit || 0); const status = statusOf(item);
                  const progress = limit > 0 ? Math.min(100, Math.round(count / limit * 100)) : 100;
                  return <article key={item.ID} className="flex min-h-72 flex-col rounded-xl border border-border/65 bg-card/75 p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold tracking-tight">{item.Name}</h2><p className="mt-1 font-mono text-[11px] text-muted-foreground">RAW · {item.Token ? `${item.Token.slice(0, 8)}…` : `node_${item.ID}`}</p></div><Badge variant="outline" className={cn("gap-1.5", status.className)}><span className="size-1.5 rounded-full bg-current" />{status.label}</Badge></div><div className="mt-4 rounded-lg border border-border/55 bg-muted/30 px-3 py-2.5"><p className="text-xs text-muted-foreground">原始节点订阅</p><p className="mt-1 font-mono text-sm font-semibold text-primary">{item.Nodes?.filter((node) => !node.Disabled).length || 0} <span className="font-sans text-xs font-normal text-muted-foreground">个可用节点</span></p></div><div className="mt-3"><div className="flex items-end justify-between gap-2"><span className="flex items-center gap-1.5 text-xs text-secondary-foreground"><Activity className="size-3.5 text-primary" />访问统计</span><span className="font-mono text-xs font-semibold">{count.toLocaleString()} <span className="font-sans font-normal text-muted-foreground">/ {limit ? limit.toLocaleString() : "不限"}</span></span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} /></div></div><div className="mt-auto flex items-center justify-between border-t border-border/55 pt-3 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Clock3 className="size-3.5" />{formatDate(item.CreatedAt)}</span><div className="flex items-center gap-1"><Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void copyNodeSubscriptionUrl(item)}><Copy className="size-3.5" />复制链接</Button>{renderNodeSubscriptionActions(item)}</div></div></article>;
                })}{!visibleNodeSubscriptions.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">暂无匹配的节点订阅</p>}</div> : <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/70 shadow-sm"><Table><TableHeader><TableRow><TableHead>节点订阅</TableHead><TableHead>可用节点</TableHead><TableHead>访问次数 / 上限</TableHead><TableHead>创建时间</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{visibleNodeSubscriptions.map((item) => <TableRow key={item.ID}><TableCell><div className="font-medium">{item.Name}</div><div className="mt-1 font-mono text-[11px] text-muted-foreground">RAW · {item.Token ? `${item.Token.slice(0, 8)}…` : "Token 已启用"}</div></TableCell><TableCell className="font-mono text-primary">{item.Nodes?.filter((node) => !node.Disabled).length || 0} 个</TableCell><TableCell className="font-mono">{Number(item.AccessCount || 0).toLocaleString()} <span className="font-sans text-xs text-muted-foreground">/ {item.AccessLimit ? Number(item.AccessLimit).toLocaleString() : "不限"}</span></TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(item.CreatedAt)}</TableCell><TableCell><Badge variant="outline" className={cn("gap-1.5", statusOf(item).className)}><span className="size-1.5 rounded-full bg-current" />{statusOf(item).label}</Badge></TableCell><TableCell className="text-right"><div className="flex justify-end gap-1"><Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void copyNodeSubscriptionUrl(item)}><Copy className="size-3.5" />复制链接</Button>{renderNodeSubscriptionActions(item)}</div></TableCell></TableRow>)}</TableBody></Table>{!visibleNodeSubscriptions.length && <p className="py-16 text-center text-sm text-muted-foreground">暂无匹配的节点订阅</p>}</div>
              ) : activeSection === "nodes" ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-border/60 bg-card/70 p-4 shadow-sm sm:p-5">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                        <span className="font-semibold">总计 <b className="font-mono text-primary">{nodes.length}</b> 个节点</span>
                        <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><span className="size-1.5 rounded-full bg-current" />已启用 {nodes.filter((node) => !node.Disabled).length}</span>
                        <span className="flex items-center gap-1.5 text-destructive"><span className="size-1.5 rounded-full bg-current" />已停用 {nodes.filter((node) => node.Disabled).length}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={openIpLibrary}><Database className="size-3.5" />IP 库</Button>
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => nodeBackupInputRef.current?.click()}><Upload className="size-3.5" />导入备份</Button>
                        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void exportNodes()}><FileText className="size-3.5" />导出节点</Button>
                        <Button size="sm" className="gap-1.5" onClick={() => openEditor("node")}><Plus className="size-3.5" />添加节点</Button>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 rounded-xl border border-border/55 bg-card/55 p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <Button size="sm" variant={nodeGroupFilter === "all" ? "default" : "ghost"} className="h-8 gap-1.5" onClick={() => setNodeGroupFilter("all")}>全部 <span className="rounded bg-foreground/10 px-1 font-mono text-[10px]">{nodes.length}</span></Button>
                      {nodeGroups.map((group) => <Button key={group} size="sm" variant={nodeGroupFilter === group ? "secondary" : "ghost"} className="h-8 gap-1.5" onClick={() => setNodeGroupFilter(group)}><span className="size-1.5 rounded-full bg-primary" />{group}<span className="rounded bg-muted px-1 font-mono text-[10px]">{nodes.filter((node) => node.GroupNodes?.some((item) => item.Name === group)).length}</span></Button>)}
                      <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-primary" onClick={() => setCreateGroupOpen(true)}><FolderPlus className="size-3.5" />分组管理</Button>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="relative min-w-0 sm:w-60"><Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={nodeSearchQuery} onChange={(event) => setNodeSearchQuery(event.target.value)} placeholder="搜索别名 / IP / 端口…" className="h-8 pl-8 text-xs" /></div>
                      <div className="flex rounded-md bg-muted/70 p-0.5" aria-label="按协议筛选">{(["all", "ss", "vless", "trojan"] as const).map((protocol) => <Button key={protocol} variant="ghost" size="sm" className={cn("h-7 px-2.5 text-[11px]", nodeProtocolFilter === protocol && "bg-background shadow-sm text-primary")} onClick={() => setNodeProtocolFilter(protocol)}>{protocol === "all" ? "全部协议" : nodeProtocolLabel(protocol)}{protocol !== "all" && nodeProtocolCounts[protocol] ? <span className="ml-1 font-mono text-[10px] text-muted-foreground">{nodeProtocolCounts[protocol]}</span> : null}</Button>)}</div>
                    </div>
                  </div>
                  {viewMode === "card" ? <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-4">{visibleNodes.map((node, index) => {
                    const protocol = nodeProtocol(node.Link); const endpoint = nodeEndpoint(node.Link);
                    return <article key={node.ID} className={cn("flex min-h-72 flex-col overflow-hidden rounded-xl border bg-card/75 p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md", node.Disabled ? "border-border/50 opacity-70" : "border-border/70")}>
                      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate font-semibold tracking-tight">{node.Name}</h2><div className="mt-2 flex flex-wrap items-center gap-1.5"><Badge variant="outline" className={cn("rounded-md px-2 py-0 font-mono text-[10px] tracking-wide", nodeProtocolClass(protocol))}>{nodeProtocolLabel(protocol)}</Badge>{node.GroupNodes?.map((group) => <Badge key={group.ID} variant="secondary" className="rounded-md px-2 py-0 text-[10px] font-normal">● {group.Name}</Badge>)}</div></div><div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><span className="font-mono">#{String(index + 1).padStart(2, "0")}</span><Badge variant="outline" className={cn("gap-1 rounded-full px-2 py-0", node.Disabled ? "border-destructive/25 bg-destructive/10 text-destructive" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}><span className="size-1.5 rounded-full bg-current" />{node.Disabled ? "已停用" : "可用"}</Badge></div></div>
                      <div className="mt-4 rounded-lg border border-border/60 bg-muted/35 p-3 font-mono text-[11px]"><p className="text-[10px] text-muted-foreground">连接端点</p><div className="mt-1 flex items-baseline justify-between gap-2"><span className="truncate font-medium">{endpoint.host}</span><span className="shrink-0 text-muted-foreground">:{endpoint.port}</span></div><div className="mt-3 border-t border-border/55 pt-2"><p className="truncate text-muted-foreground">{node.Link}</p></div></div>
                      <div className="mt-auto flex items-center justify-between border-t border-border/55 pt-3 text-xs text-muted-foreground"><span>{formatDate(node.CreatedAt)}</span><div className="flex items-center gap-0.5"><Button variant="ghost" size="icon" className="size-7" title="编辑节点" onClick={() => openNodeEditor(node)}><Pencil className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7" title="复制节点链接" onClick={() => void navigator.clipboard.writeText(node.Link).then(() => toast.success("节点链接已复制"))}><Copy className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7" title={node.Disabled ? "启用节点" : "停用节点"} onClick={() => void toggleNode(node)}><Power className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" title="删除节点" onClick={() => void deleteResource("nodes", node.Name, node.ID)}><Trash2 className="size-3.5" /></Button></div></div>
                    </article>;
                  })}{!visibleNodes.length && <p className="col-span-full rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">未找到匹配的节点</p>}</div> : <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/70 shadow-sm"><Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="w-14 text-center">#</TableHead><TableHead>节点名称</TableHead><TableHead>协议</TableHead><TableHead>节点链接（Token / URI）</TableHead><TableHead>连接端点</TableHead><TableHead>所属分组</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{visibleNodes.map((node, index) => { const protocol = nodeProtocol(node.Link); const endpoint = nodeEndpoint(node.Link); return <TableRow key={node.ID} className={cn("group", node.Disabled && "opacity-60")}><TableCell className="text-center font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</TableCell><TableCell className="min-w-44"><div className="font-medium">{node.Name}</div><div className="mt-1 text-[11px] text-muted-foreground">创建于 {formatDate(node.CreatedAt)}</div></TableCell><TableCell><Badge variant="outline" className={cn("rounded-md px-2 py-0 font-mono text-[10px] tracking-wide", nodeProtocolClass(protocol))}>{nodeProtocolLabel(protocol)}</Badge></TableCell><TableCell className="max-w-64"><div className="flex items-center gap-1"><code className="block truncate text-xs text-muted-foreground">{node.Link}</code><Button variant="ghost" size="icon" className="size-7 shrink-0 opacity-60 group-hover:opacity-100" title="复制节点链接" onClick={() => void navigator.clipboard.writeText(node.Link).then(() => toast.success("节点链接已复制"))}><Copy className="size-3.5" /></Button></div></TableCell><TableCell className="font-mono text-xs"><span>{endpoint.host}</span><span className="mx-1.5 text-muted-foreground">:</span><span className="text-primary">{endpoint.port}</span></TableCell><TableCell><div className="flex max-w-40 flex-wrap gap-1">{node.GroupNodes?.map((group) => <Badge key={group.ID} variant="secondary" className="rounded-md text-[10px] font-normal">{group.Name}</Badge>) || <span className="text-muted-foreground">--</span>}</div></TableCell><TableCell><Badge variant="outline" className={cn("gap-1 rounded-full", node.Disabled ? "border-destructive/25 bg-destructive/10 text-destructive" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}><span className="size-1.5 rounded-full bg-current" />{node.Disabled ? "已停用" : "可用"}</Badge></TableCell><TableCell><div className="flex justify-end gap-0.5"><Button variant="ghost" size="icon" className="size-8" title="编辑节点" onClick={() => openNodeEditor(node)}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8" title={node.Disabled ? "启用节点" : "停用节点"} onClick={() => void toggleNode(node)}><Power className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" title="删除节点" onClick={() => void deleteResource("nodes", node.Name, node.ID)}><Trash2 className="size-4" /></Button></div></TableCell></TableRow>; })}</TableBody></Table>{!visibleNodes.length && <p className="py-16 text-center text-sm text-muted-foreground">未找到匹配的节点</p>}</div>}
                </div>
              ) : (
                viewMode === "card" ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{templates.map((template) => <article key={template.File} className="flex min-h-52 flex-col rounded-xl border border-border/55 bg-background/45 p-4 shadow-sm transition-colors hover:border-primary/35 hover:bg-background/65"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold">{template.File}</h2><p className="mt-1 text-xs text-muted-foreground">{templateFormat(template)} 模板</p></div><FileCode2 className="h-5 w-5 shrink-0 text-primary" /></div><pre className="mt-5 line-clamp-3 overflow-hidden rounded-lg bg-muted/35 p-3 font-mono text-xs leading-5 text-muted-foreground">{template.Text}</pre><div className="mt-auto flex items-center justify-between gap-2 pt-5 text-xs text-muted-foreground"><span>{formatDate(template.CreateDate)}</span><div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => openEditor("template-edit", template)}>编辑</Button><Button variant="outline" size="sm" onClick={() => setTemplatePreview(template)}>查看</Button></div></div></article>)}{!templates.length && <p className="col-span-full py-16 text-center text-sm text-muted-foreground">暂无订阅模板</p>}</div> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>模板文件</TableHead><TableHead>类型</TableHead><TableHead>更新时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{templates.map((template) => <TableRow key={template.File}><TableCell className="font-medium">{template.File}</TableCell><TableCell>{templateFormat(template)}</TableCell><TableCell className="text-xs text-muted-foreground">{formatDate(template.CreateDate)}</TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => openEditor("template-edit", template)}>编辑</Button><Button variant="ghost" size="sm" onClick={() => setTemplatePreview(template)}>查看</Button></TableCell></TableRow>)}</TableBody></Table>{!templates.length && <p className="py-16 text-center text-sm text-muted-foreground">暂无订阅模板</p>}</div>
              )}
            </CardContent>
          </section>
        )}
        {isTemplateImportDialogOpen ? <TemplateImportDialog open saving={isSavingEditor} onClose={() => setEditorMode(null)} onSave={saveImportedTemplate} onFetch={fetchImportedTemplate} /> : isTemplateVisualEditorOpen ? <TemplateVisualEditorDialog open saving={isSavingEditor} filename={templateFilename} text={templateText} onClose={() => setEditorMode(null)} onSave={saveVisualTemplate} /> : isSubscriptionWizardOpen ? <SubscriptionWizard
          open
          step={subscriptionStep} setStep={setSubscriptionStep}
          name={editorName} setName={setEditorName}
          expireAt={editorExpireAt} setExpireAt={setEditorExpireAt}
          accessLimit={editorAccessLimit} setAccessLimit={setEditorAccessLimit}
          outputType={editorOutputType} setOutputType={setEditorOutputType}
          template={subscriptionTemplate} setTemplate={setSubscriptionTemplate}
          udp={subscriptionUdp} setUdp={setSubscriptionUdp}
          cert={subscriptionCert} setCert={setSubscriptionCert}
          dedupe={subscriptionDedupe} setDedupe={setSubscriptionDedupe}
          doh={subscriptionDoh} setDoh={setSubscriptionDoh}
          nodes={nodes} selectedNodeIds={editorNodeIds} setSelectedNodeIds={setEditorNodeIds} toggleNode={toggleEditorNode}
          templates={templates} policyGroups={policyGroups} setPolicyGroups={setPolicyGroups}
          policyGroupName={policyGroupName} setPolicyGroupName={setPolicyGroupName}
          saving={isSavingEditor} onSave={() => void saveEditor()} onClose={() => setEditorMode(null)}
        /> : isNodeSubscriptionDialogOpen ? <NodeSubscriptionDialog
          open title={editorOriginalName ? "编辑节点订阅" : undefined}
          name={editorName} setName={setEditorName}
          expireAt={editorExpireAt} setExpireAt={setEditorExpireAt}
          accessLimit={editorAccessLimit} setAccessLimit={setEditorAccessLimit}
          nodes={nodes} selectedNodeIds={editorNodeIds} toggleNode={toggleEditorNode}
          saving={isSavingEditor} onSave={() => void saveEditor()} onClose={() => setEditorMode(null)}
        /> : isNodeAddDialogOpen ? <NodeAddDialog
          open title={editingNode ? "编辑节点" : undefined} name={editorName} setName={setEditorName} link={editorLink} setLink={setEditorLink}
          replace={replaceIpEnabled} setReplace={setReplaceIpEnabled} replaceId={replaceIpId} setReplaceId={setReplaceIpId}
          ips={ipEntries} openIpLibrary={openIpLibrary} groups={nodeGroups} newGroup={editorNewGroup} setNewGroup={setEditorNewGroup} openCreateGroup={() => setCreateGroupOpen(true)}
          selectedGroups={editorGroups} setSelectedGroups={setEditorGroups} subscriptions={subscriptions} selectedSubscriptions={editorSubscriptionIds} setSelectedSubscriptions={setEditorSubscriptionIds} showSubscriptions={!editingNode}
          saving={isSavingEditor} onSave={() => void saveEditor()} onClose={() => setEditorMode(null)}
        /> : <Dialog open={!!editorMode} onOpenChange={(open) => { if (!open) setEditorMode(null); }}>
          <DialogContent className={cn("max-w-2xl", (fallbackEditorMode === "template-add" || fallbackEditorMode === "template-edit" || fallbackEditorMode === "template-import") && "max-w-[calc(100vw-4rem)]") }>
            <DialogHeader><DialogTitle>{fallbackEditorMode === "subscription" ? "新建订阅" : fallbackEditorMode === "node-subscription" ? "新建节点订阅" : fallbackEditorMode === "node" ? "新建节点" : fallbackEditorMode === "template-edit" ? "编辑模板" : fallbackEditorMode === "template-import" ? "导入模板预览" : "新建模板"}</DialogTitle><DialogDescription>{fallbackEditorMode === "template-import" ? "文件尚未写入服务器；确认内容后保存即可导入。" : "字段会直接写入现有代理订阅服务。"}</DialogDescription></DialogHeader>
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
            <DialogHeader><DialogTitle>{templatePreview?.File || "订阅模板"}</DialogTitle><DialogDescription>模板内容预览；可随时关闭预览并进入可视化编辑器修改。</DialogDescription></DialogHeader>
            <pre className="max-h-[60svh] overflow-auto rounded-lg border border-border/60 bg-muted/20 p-4 font-mono text-xs leading-6 text-foreground">{templatePreview?.Text || ""}</pre>
            <DialogFooter><Button variant="outline" onClick={() => setTemplatePreview(null)}>关闭</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        <IpLibraryDialog open={ipLibraryOpen} onClose={() => setIpLibraryOpen(false)} entries={ipEntries} form={ipForm} setForm={setIpForm} saving={isSavingIp} onSave={() => void saveIpEntry()} onDelete={(entry) => void removeIpEntry(entry)} />
        <Dialog open={createGroupOpen} onOpenChange={(open) => { setCreateGroupOpen(open); if (!open) setCreateGroupName(""); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>创建新分组</DialogTitle>
              <DialogDescription>输入分组名称。创建成功后会自动刷新并选中该分组。</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={createGroupName}
              onChange={(event) => setCreateGroupName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void createNodeGroup(); }}
              placeholder="例如：香港 BGP 节点"
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateGroupOpen(false)}>取消</Button>
              <Button disabled={!createGroupName.trim() || isCreatingGroup} onClick={() => void createNodeGroup()}>{isCreatingGroup ? "创建中…" : "确定"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <input ref={nodeBackupInputRef} className="hidden" type="file" accept="application/json,.json" onChange={(event) => void importNodeBackup(event.target.files?.[0])} />
      </div>
    </DashboardLayout>
  );
}
