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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Copy,
  FileCode2,
  Link2,
  ListPlus,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Server,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation, useSearch } from "wouter";

const formatLabels: Record<string, string> = {
  clash: "Clash",
  egern: "Egern",
  loon: "Loon",
  raw: "原始节点",
};
const defaultTemplates: Record<string, string> = {
  clash: "proxies:\n{{PROXY_NODES}}\n",
  egern: "# Egern Profile\nproxy:\n{{PROXY_NODES}}\n",
  loon: "[Proxy]\n{{PROXY_NODES}}\n",
};
type NodeForm = {
  id?: number;
  name: string;
  protocol: "ss" | "ssr" | "vmess" | "vless";
  link: string;
  groupName: string;
  enabled: boolean;
};
const emptyNode: NodeForm = {
  name: "",
  protocol: "ss",
  link: "",
  groupName: "",
  enabled: true,
};

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
  const { data: nodes = [] } = trpc.proxySubscriptions.nodes.useQuery();
  const { data: subscriptions = [] } =
    trpc.proxySubscriptions.subscriptions.useQuery();
  const { data: nodeSubscriptions = [] } =
    trpc.proxySubscriptions.nodeSubscriptions.useQuery();
  const { data: templates = [] } = trpc.proxySubscriptions.templates.useQuery();
  const [nodeDialog, setNodeDialog] = useState<NodeForm | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [templateFormat, setTemplateFormat] = useState("clash");
  const [templateText, setTemplateText] = useState("");
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [nodeSubscriptionOpen, setNodeSubscriptionOpen] = useState(false);
  const [subscriptionName, setSubscriptionName] = useState("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<number[]>([]);
  const [selectedFormats, setSelectedFormats] = useState<string[]>(["clash"]);
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
  const { data: accessLogs = [] } = trpc.proxySubscriptions.accessLogs.useQuery(
    {
      subscriptionId: logTarget?.id || 1,
      subscriptionKind: logTarget?.kind || "config",
    },
    { enabled: !!logTarget },
  );
  const saveNode = trpc.proxySubscriptions.saveNode.useMutation({
    onSuccess: () => {
      utils.proxySubscriptions.nodes.invalidate();
      setNodeDialog(null);
      toast.success("节点已保存");
    },
    onError: (e) => toast.error(e.message),
  });
  const importNodes = trpc.proxySubscriptions.importNodes.useMutation({
    onSuccess: (r) => {
      utils.proxySubscriptions.nodes.invalidate();
      setImportOpen(false);
      setImportText("");
      toast.success(
        `已导入 ${r.imported} 个节点${r.skipped ? `，跳过 ${r.skipped} 条` : ""}`,
      );
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteNode = trpc.proxySubscriptions.deleteNode.useMutation({
    onSuccess: () => utils.proxySubscriptions.nodes.invalidate(),
  });
  const clearSubscriptionForm = () => {
    setSubscriptionName("");
    setSelectedNodeIds([]);
    setSelectedFormats(["clash"]);
    setAccessLimit(0);
    setExpiresAtText("");
    setRevoked(false);
    setEditingSubscription(null);
    setEditingNodeSubscription(null);
  };
  const saveSubscription = trpc.proxySubscriptions.saveSubscription.useMutation(
    {
      onSuccess: () => {
        utils.proxySubscriptions.subscriptions.invalidate();
        setSubscriptionOpen(false);
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
      toast.success("模板已保存");
    },
  });
  const activeTemplate = useMemo(
    () =>
      templates.find((item: any) => item.format === templateFormat)?.content ||
      defaultTemplates[templateFormat],
    [templates, templateFormat],
  );
  const openTemplate = (format: string) => {
    setTemplateFormat(format);
    setTemplateText(
      templates.find((item: any) => item.format === format)?.content ||
        defaultTemplates[format],
    );
  };
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
  const toggleFormat = (format: string) =>
    setSelectedFormats((current) =>
      current.includes(format)
        ? current.filter((value) => value !== format)
        : [...current, format],
    );
  const openConfigSubscription = (sub?: any) => {
    setEditingSubscription(sub || null);
    setSubscriptionName(sub?.name || "");
    setSelectedNodeIds(sub?.nodeIds || []);
    setSelectedFormats(
      sub?.formats?.filter((format: string) => format !== "raw") || ["clash"],
    );
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
  return (
    <DashboardLayout>
      <main className="space-y-5 p-4 md:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">代理订阅</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理代理节点、公开订阅链接和客户端模板。
          </p>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="nodes">
              <Server className="mr-2 h-4 w-4" />
              节点库
            </TabsTrigger>
            <TabsTrigger value="subscriptions">
              <Link2 className="mr-2 h-4 w-4" />
              订阅管理
            </TabsTrigger>
            <TabsTrigger value="templates">
              <FileCode2 className="mr-2 h-4 w-4" />
              模板管理
            </TabsTrigger>
          </TabsList>
          <TabsContent value="nodes">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>节点库</CardTitle>
                  <CardDescription>
                    支持 SS、SSR、VLESS 与 VMess 链接。
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setImportOpen(true)}>
                    <Upload className="mr-2 h-4 w-4" />
                    批量导入
                  </Button>
                  <Button onClick={() => setNodeDialog(emptyNode)}>
                    <Plus className="mr-2 h-4 w-4" />
                    新建节点
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead>协议</TableHead>
                      <TableHead>服务器</TableHead>
                      <TableHead>分组</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {nodes.map((node: any) => (
                      <TableRow key={node.id}>
                        <TableCell className="font-medium">
                          {node.name}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {String(node.protocol).toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {node.server || "—"}
                          {node.port ? `:${node.port}` : ""}
                        </TableCell>
                        <TableCell>{node.groupName || "未分组"}</TableCell>
                        <TableCell>
                          {node.enabled ? (
                            <Badge>启用</Badge>
                          ) : (
                            <Badge variant="secondary">停用</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setNodeDialog({
                                ...node,
                                groupName: node.groupName || "",
                              })
                            }
                          >
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteNode.mutate({ id: node.id })}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!nodes.length && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="h-28 text-center text-muted-foreground"
                        >
                          尚无节点，粘贴订阅链接开始导入。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="subscriptions">
            <div className="grid gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle>配置订阅</CardTitle>
                    <CardDescription>
                      生成 Clash、Egern 或 Loon 的完整配置。
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
                            {sub.nodeIds.length} 个节点 ·{" "}
                            {sub.formats
                              .map((f: string) => formatLabels[f])
                              .join(" / ")}{" "}
                            · 访问 {sub.accessCount}
                            {sub.accessLimit ? `/${sub.accessLimit}` : ""}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sub.formats.map((format: string) => {
                            const url = `${window.location.origin}/api/proxy-subscription/${sub.token}?format=${format}`;
                            const importUrl = format === "clash" ? `clash://install-config?url=${encodeURIComponent(url)}` : format === "loon" ? `loon://import?sub=${encodeURIComponent(url)}` : "";
                            return <span key={format} className="flex gap-1"><Button size="sm" variant="outline" onClick={() => copy(url)}><Copy className="mr-1 h-3.5 w-3.5" />{formatLabels[format]}</Button><Button size="icon" variant="outline" title="预览配置" onClick={() => setPreviewSubscription({ name: `${sub.name} · ${formatLabels[format]}`, url })}><FileCode2 className="h-3.5 w-3.5" /></Button><Button size="icon" variant="outline" title="下载配置" onClick={() => download(url, `${sub.name}-${format}`, format === "loon" ? "conf" : "yaml")}><Upload className="h-3.5 w-3.5" /></Button>{importUrl && <Button size="icon" variant="outline" title={`导入 ${formatLabels[format]}`} onClick={() => { window.location.href = importUrl; }}><Link2 className="h-3.5 w-3.5" /></Button>}</span>;
                          })}
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
                                url: `${window.location.origin}/api/proxy-subscription/${sub.token}?format=${sub.formats[0] || "clash"}`,
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
          <TabsContent value="templates">
            <div className="grid gap-4 md:grid-cols-3">
              {["clash", "egern", "loon"].map((format) => (
                <Card
                  key={format}
                  className={templateFormat === format ? "border-primary" : ""}
                >
                  <CardHeader>
                    <CardTitle>{formatLabels[format]} 模板</CardTitle>
                    <CardDescription>
                      使用 <code>{"{{PROXY_NODES}}"}</code> 插入节点。
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => openTemplate(format)}
                    >
                      编辑模板
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>{formatLabels[templateFormat]} 模板编辑器</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  className="min-h-[360px] font-mono text-xs"
                  value={templateText || activeTemplate}
                  onChange={(e) => setTemplateText(e.target.value)}
                />
                <Button
                  onClick={() =>
                    saveTemplate.mutate({
                      format: templateFormat as any,
                      content: templateText || activeTemplate,
                    })
                  }
                >
                  <Check className="mr-2 h-4 w-4" />
                  保存模板
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle>批量导入节点</DialogTitle>
              <DialogDescription>
                每行一个 SS、SSR、VLESS 或 VMess 链接。
              </DialogDescription>
            </DialogHeader>
            <Textarea
              className="min-h-56 font-mono text-xs"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <DialogFooter>
              <Button onClick={() => importNodes.mutate({ links: importText })}>
                <ListPlus className="mr-2 h-4 w-4" />
                导入
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
                节点勾选顺序即输出顺序；可设置到期、访问上限和撤销状态。
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
                <Label>输出格式</Label>
                <div className="mt-2 flex gap-2">
                  {Object.keys(formatLabels)
                    .filter((format) => format !== "raw")
                    .map((format) => (
                      <Button
                        key={format}
                        size="sm"
                        variant={
                          selectedFormats.includes(format)
                            ? "default"
                            : "outline"
                        }
                        onClick={() => toggleFormat(format)}
                      >
                        {formatLabels[format]}
                      </Button>
                    ))}
                </div>
              </div>
              <div>
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
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={
                  !subscriptionName ||
                  !selectedNodeIds.length ||
                  !selectedFormats.length
                }
                onClick={() =>
                  saveSubscription.mutate({
                    id: editingSubscription?.id,
                    name: subscriptionName,
                    nodeIds: selectedNodeIds,
                    formats: selectedFormats as any,
                    expiresAt: expiresAtText ? new Date(expiresAtText) : null,
                    accessLimit,
                    revoked,
                  })
                }
              >
                {editingSubscription ? "保存修改" : "创建订阅"}
              </Button>
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
