import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Activity, ChartNoAxesCombined, Copy, GitBranch, Link2, Pencil, QrCode, Server, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { LandingLatencyDialog } from "@/components/LandingLatencyDialog";
import { copyTextToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";

type LandingViewMode = "card" | "compact" | "table";
const normalMethods = ["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"];
const methods2022 = ["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"];
const base64Url = (value: string) => btoa(unescape(encodeURIComponent(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
const endpointOf = (service: any) => String(service?.endpoint || service?.host?.ip || "");
const ssUri = (service: any) => {
  const endpoint = endpointOf(service);
  return endpoint && service?.password ? `ss://${base64Url(`${service.method}:${service.password}`)}@${endpoint}:${service.port}#${encodeURIComponent(service.name)}` : "";
};
function formatBytes(value: unknown) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}
function formatRate(value: unknown) {
  return Number(value || 0) > 0 ? `${formatBytes(value)}/s` : "暂无数据";
}
function serviceStatus(service: any) {
  return service.status === "running" ? "运行中" : service.status === "error" ? "错误" : service.status === "removing" ? "删除中" : "部署中";
}
function statusVariant(service: any): "default" | "secondary" | "destructive" {
  return service.status === "running" ? "default" : service.status === "error" ? "destructive" : "secondary";
}

export function LandingHostManagement({ viewMode = "card" }: { viewMode?: "card" | "table" }) {
  const hostsQuery = trpc.hosts.list.useQuery();
  const eligibleQuery = trpc.landing.eligibleHosts.useQuery(undefined, { refetchInterval: 5000 });
  const servicesQuery = trpc.landing.list.useQuery(undefined, { refetchInterval: 5000 });
  const mark = trpc.landing.markHost.useMutation({ onSuccess: () => void eligibleQuery.refetch(), onError: error => toast.error(error.message) });
  const unmark = trpc.landing.unmarkHost.useMutation({ onSuccess: () => void eligibleQuery.refetch(), onError: error => toast.error(error.message) });
  const setEnabled = trpc.landing.setHostEnabled.useMutation({ onSuccess: () => { void eligibleQuery.refetch(); void servicesQuery.refetch(); }, onError: error => toast.error(error.message) });
  const eligible = eligibleQuery.data || [];
  const services = servicesQuery.data || [];
  const candidates = (hostsQuery.data || []).filter((host: any) => !eligible.some((entry: any) => Number(entry.hostId) === Number(host.id)));
  const hostCard = (entry: any) => <Card key={entry.id} className="w-full max-w-[34rem] border-border/45 bg-card/60 backdrop-blur-md"><CardContent className="space-y-4 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2 font-medium"><Server className="h-4 w-4" />{entry.host.name}<Badge variant={entry.host.isOnline ? "default" : "secondary"}>{entry.host.isOnline ? "在线" : "离线"}</Badge></div><p className="mt-1 font-mono text-sm text-muted-foreground">{entry.host.ip}</p></div><Switch checked={entry.isEnabled !== false} disabled={setEnabled.isPending} onCheckedChange={isEnabled => setEnabled.mutate({ hostId: entry.hostId, isEnabled })} /></div><p className="text-xs text-muted-foreground">{entry.isEnabled !== false ? "已启用：Agent 将保持此机落地 SS 服务运行。" : "已暂停：Agent 将停止此机全部落地 SS，服务与引用保留。"}</p><div className="grid grid-cols-3 gap-2 border-t pt-3 text-center text-xs"><div><Link2 className="mx-auto h-4 w-4 text-muted-foreground" /><b className="mt-1 block text-base">{Number(entry.landingServiceCount || 0)}</b>SS 链接</div><div><Server className="mx-auto h-4 w-4 text-muted-foreground" /><b className="mt-1 block text-base">{Number(entry.portForwardReferenceCount || 0)}</b>端口转发引用</div><div><GitBranch className="mx-auto h-4 w-4 text-muted-foreground" /><b className="mt-1 block text-base">{Number(entry.forwardChainReferenceCount || 0)}</b>转发链引用</div></div><div className="flex justify-end"><Button size="sm" variant="ghost" disabled={services.some((item: any) => Number(item.hostId) === Number(entry.hostId))} onClick={() => unmark.mutate({ hostId: entry.hostId })}>取消标记</Button></div></CardContent></Card>;
  return <div className="space-y-5"><Card className="border-border/45 bg-card/65 backdrop-blur-md"><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold">落地机</h2><p className="text-sm text-muted-foreground">这里只标记可创建落地服务的 VPS。关闭时 Agent 会停止该机全部 SS，服务与引用保留，重新开启后自动恢复。</p></div><select className="h-10 rounded-md border bg-background px-3 text-sm" defaultValue="" onChange={event => { const hostId = Number(event.target.value); if (hostId) mark.mutate({ hostId }); event.currentTarget.value = ""; }}><option value="">添加 VPS 为落地机…</option>{candidates.map((host: any) => <option key={host.id} value={host.id}>{host.name} · {host.entryIp || host.ip}</option>)}</select></CardContent></Card>{eligible.length === 0 ? <p className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">选择一台已有 VPS，将它标记为落地机。</p> : viewMode === "table" ? <Card className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>启用</TableHead><TableHead>状态</TableHead><TableHead>落地机</TableHead><TableHead>公共 IP</TableHead><TableHead>SS</TableHead><TableHead>端口转发引用</TableHead><TableHead>转发链引用</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{eligible.map((entry: any) => <TableRow key={entry.id}><TableCell><Switch checked={entry.isEnabled !== false} disabled={setEnabled.isPending} onCheckedChange={isEnabled => setEnabled.mutate({ hostId: entry.hostId, isEnabled })} /></TableCell><TableCell><Badge variant={entry.host.isOnline ? "default" : "secondary"}>{entry.host.isOnline ? "在线" : "离线"}</Badge></TableCell><TableCell>{entry.host.name}</TableCell><TableCell className="font-mono text-xs">{entry.host.ip}</TableCell><TableCell>{Number(entry.landingServiceCount || 0)}</TableCell><TableCell>{Number(entry.portForwardReferenceCount || 0)}</TableCell><TableCell>{Number(entry.forwardChainReferenceCount || 0)}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" disabled={services.some((item: any) => Number(item.hostId) === Number(entry.hostId))} onClick={() => unmark.mutate({ hostId: entry.hostId })}>取消标记</Button></TableCell></TableRow>)}</TableBody></Table></Card> : <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,30rem),34rem))] justify-start gap-3">{eligible.map(hostCard)}</div>}</div>;
}

export function LandingManagement({ viewMode = "card", createRequestKey }: { viewMode?: LandingViewMode; createRequestKey?: number }) {
  const utils = trpc.useUtils();
  const confirmDialog = useConfirmDialog();
  const eligibleQuery = trpc.landing.eligibleHosts.useQuery(undefined, { refetchInterval: 5000 });
  const servicesQuery = trpc.landing.list.useQuery(undefined, { refetchInterval: 5000 });
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState(0);
  const [protocol, setProtocol] = useState<"ss" | "ss2022">("ss");
  const [name, setName] = useState("落地 SS");
  const [method, setMethod] = useState(normalMethods[1]);
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(30000);
  const [endpoint, setEndpoint] = useState("");
  const [latencyTargetHost, setLatencyTargetHost] = useState("1.1.1.1");
  const [latencyTargetPort, setLatencyTargetPort] = useState(443);
  const [editing, setEditing] = useState<any>(null);
  const [portCheckText, setPortCheckText] = useState("");
  const [qrService, setQrService] = useState<any>(null);
  const [qrData, setQrData] = useState("");
  const [historyService, setHistoryService] = useState<any>(null);
  const eligible = eligibleQuery.data || [];
  const services = useMemo(() => (servicesQuery.data || []).map((item: any) => ({ ...item, host: eligible.find((entry: any) => Number(entry.hostId) === Number(item.hostId))?.host })), [eligible, servicesQuery.data]);
  const create = trpc.landing.create.useMutation({ onSuccess: () => { void servicesQuery.refetch(); setOpen(false); toast.success("已下发给 Agent 部署"); }, onError: error => toast.error(error.message) });
  const update = trpc.landing.update.useMutation({ onSuccess: () => { void servicesQuery.refetch(); setOpen(false); setEditing(null); toast.success("已下发给 Agent 更新"); }, onError: error => toast.error(error.message) });
  const remove = trpc.landing.remove.useMutation({ onSuccess: () => { void servicesQuery.refetch(); toast.success("已下发删除任务，正在等待 Agent 清理"); }, onError: error => toast.error(error.message) });
  const startLatencyTest = trpc.landing.startLatencyTest.useMutation({ onSuccess: () => { void servicesQuery.refetch(); toast.success("已下发立即 TCPing，结果将在几秒内刷新"); }, onError: error => toast.error(error.message) });
  const selectedEndpoint = eligible.find((entry: any) => Number(entry.hostId) === hostId)?.host?.ip || "";
  const isSaving = create.isPending || update.isPending;
  const openCreate = () => {
    const first = Number(eligible[0]?.hostId || 0);
    if (!first) return toast.error("请先在链路管理标记一台 VPS 为落地机");
    setHostId(first); setEndpoint(String(eligible.find((item: any) => Number(item.hostId) === first)?.host?.ip || ""));
    setEditing(null); setPortCheckText(""); setOpen(true);
  };
  useEffect(() => { if (createRequestKey) openCreate(); }, [createRequestKey]);
  useEffect(() => { if (!qrService) return void setQrData(""); void QRCode.toDataURL(ssUri(qrService), { width: 240, margin: 1 }).then(setQrData).catch(() => setQrData("")); }, [qrService]);
  const checkPort = async () => {
    if (!hostId || port < 1 || port > 65535) return;
    const first = await utils.landing.checkPort.fetch({ hostId, port, excludeId: editing?.id });
    setPortCheckText(first.message);
    if (first.complete || !first.checkId) return;
    for (let i = 0; i < 12; i += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 900));
      const next = await utils.landing.portCheckStatus.fetch({ checkId: first.checkId });
      setPortCheckText(next.message);
      if (next.complete) return;
    }
  };
  const openEdit = (service: any) => {
    setEditing(service); setHostId(Number(service.hostId)); setName(String(service.name)); setProtocol(service.protocol === "ss2022" ? "ss2022" : "ss");
    setMethod(String(service.method)); setPassword(String(service.password || "")); setPort(Number(service.port)); setEndpoint(endpointOf(service));
    setLatencyTargetHost(String(service.latencyTargetHost || "1.1.1.1")); setLatencyTargetPort(Number(service.latencyTargetPort || 443)); setPortCheckText(""); setOpen(true);
  };
  const confirmRemove = async (service: any) => {
    if (!await confirmDialog({ title: "删除落地 SS 服务", description: <>确定删除“{service.name}”吗？这会通知 Agent 停止服务并清理监听端口，已引用的规则将保留但无法连接。</>, confirmText: "删除", tone: "destructive" })) return;
    remove.mutate({ id: service.id });
  };
  const copyService = (service: any) => void copyTextToClipboard(ssUri(service)).then(() => toast.success("SS 链接已复制")).catch(() => toast.error("复制失败"));
  const actionButtons = (service: any, table = false) => <div className={table ? "flex justify-end gap-1" : "flex flex-wrap justify-end gap-1"}><Button size="icon" variant="ghost" title="TCP 延迟探测历史" onClick={() => setHistoryService(service)}><ChartNoAxesCombined className="h-4 w-4" /></Button><Button size="icon" variant="ghost" title="立即 TCP 延迟探测" disabled={startLatencyTest.isPending || service.status === "removing"} onClick={() => startLatencyTest.mutate({ id: service.id })}><Activity className="h-4 w-4" /></Button>{table && <Button size="icon" variant="ghost" title="编辑" onClick={() => openEdit(service)}><Pencil className="h-4 w-4" /></Button>}<Button size="icon" variant="ghost" title="复制 SS 链接" onClick={() => copyService(service)}><Copy className="h-4 w-4" /></Button><Button size="icon" variant="ghost" title="显示二维码" onClick={() => setQrService(service)}><QrCode className="h-4 w-4" /></Button><Button size="icon" variant="ghost" title="删除" className="text-destructive" disabled={remove.isPending || service.status === "removing"} onClick={() => void confirmRemove(service)}><Trash2 className="h-4 w-4" /></Button></div>;
  const card = (service: any) => <Card key={service.id} className="w-full max-w-[34rem] border-border/45 bg-card/65 backdrop-blur-md"><CardContent className={viewMode === "compact" ? "p-3" : "p-4"}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate font-medium">{service.name}</div><p className="mt-1 truncate text-sm text-muted-foreground">用户：当前用户 · {service.host?.name || `主机 #${service.hostId}`}</p></div><div className="flex shrink-0 items-center gap-1"><Button size="icon" variant="ghost" className="h-7 w-7" title="编辑" onClick={() => openEdit(service)}><Pencil className="h-3.5 w-3.5" /></Button><Badge variant={statusVariant(service)}>{serviceStatus(service)}</Badge></div></div><div className={viewMode === "compact" ? "mt-3 space-y-1.5 text-xs" : "mt-4 space-y-2 text-sm"}><div className={viewMode === "compact" ? "flex min-w-0 items-center justify-between gap-3" : "flex min-w-0 items-center justify-between gap-3 rounded-md border p-2"}><span className="shrink-0 text-muted-foreground">入口</span><span className="min-w-0 break-all text-right font-mono">{service.host?.ip || "-"}:{service.port}</span></div><div className={viewMode === "compact" ? "flex min-w-0 items-center justify-between gap-3" : "flex min-w-0 items-center justify-between gap-3 rounded-md border p-2"}><span className="shrink-0 text-muted-foreground">出口（公网）</span><span className="min-w-0 break-all text-right font-mono">{endpointOf(service) || "-"}:{service.port}</span></div></div><div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm"><span className="flex flex-wrap items-center gap-1">落地协议 <Badge variant="outline">{String(service.protocol).toUpperCase()}</Badge><Badge variant="outline">TCP + UDP</Badge></span><span className={service.latestLatencyIsTimeout ? "text-destructive" : "text-emerald-600"}>⌁ {service.latestLatencyIsTimeout ? "超时" : service.latestLatencyMs ? `${service.latestLatencyMs}ms` : "检测中"}</span></div><div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 text-sm sm:grid-cols-4"><div><div className="text-xs text-muted-foreground">24H 入向</div><div className="text-emerald-600">↓ {formatBytes(service.traffic?.bytesIn24h)}</div></div><div><div className="text-xs text-muted-foreground">24H 出向</div><div className="text-amber-600">↑ {formatBytes(service.traffic?.bytesOut24h)}</div></div><div><div className="text-xs text-muted-foreground">累计流量</div><div>↔ {formatBytes(Number(service.traffic?.bytesInTotal || 0) + Number(service.traffic?.bytesOutTotal || 0))}</div></div><div><div className="text-xs text-muted-foreground">当前速度</div><div className="text-xs">↓ {formatRate(service.traffic?.bytesInRate)}<br />↑ {formatRate(service.traffic?.bytesOutRate)}</div></div></div><div className="mt-4 border-t pt-3">{actionButtons(service)}</div></CardContent></Card>;
  const submit = () => editing ? update.mutate({ id: editing.id, name, protocol, method: method as any, password, port, endpoint, latencyTargetHost, latencyTargetPort }) : create.mutate({ hostId, name, protocol, method: method as any, password, port, endpoint, latencyTargetHost, latencyTargetPort });
  return <div className="space-y-5"><div><h2 className="text-lg font-semibold">落地服务</h2><p className="text-sm text-muted-foreground">一台落地机可运行多个 Shadowsocks / SS2022 服务；使用右上角“新建落地”创建。</p></div>{viewMode === "table" ? <Card className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>状态</TableHead><TableHead>名称 / 用户</TableHead><TableHead>落地机</TableHead><TableHead>入口</TableHead><TableHead>出口</TableHead><TableHead>协议</TableHead><TableHead>24H / 速度 / 延迟</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{services.map((service: any) => <TableRow key={service.id}><TableCell><Badge variant={statusVariant(service)}>{serviceStatus(service)}</Badge></TableCell><TableCell><div className="font-medium">{service.name}</div><div className="text-xs text-muted-foreground">用户：当前用户</div></TableCell><TableCell>{service.host?.name || `主机 #${service.hostId}`}</TableCell><TableCell className="font-mono text-xs">{service.host?.ip || "-"}:{service.port}</TableCell><TableCell className="font-mono text-xs">{endpointOf(service)}:{service.port}</TableCell><TableCell>{String(service.protocol).toUpperCase()} · TCP + UDP</TableCell><TableCell className="text-xs">↓ {formatBytes(service.traffic?.bytesIn24h)} / ↑ {formatBytes(service.traffic?.bytesOut24h)}<br />↓ {formatRate(service.traffic?.bytesInRate)} · ↑ {formatRate(service.traffic?.bytesOutRate)} · <span className={service.latestLatencyIsTimeout ? "text-destructive" : "text-emerald-600"}>{service.latestLatencyIsTimeout ? "超时" : service.latestLatencyMs ? `${service.latestLatencyMs}ms` : "检测中"}</span></TableCell><TableCell>{actionButtons(service, true)}</TableCell></TableRow>)}</TableBody></Table></Card> : <div className={viewMode === "compact" ? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),26rem))] justify-start gap-3" : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),34rem))] justify-start gap-3"}>{services.map(card)}</div>}<LandingLatencyDialog open={!!historyService} onOpenChange={value => { if (!value) setHistoryService(null); }} service={historyService} /><Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setEditing(null); }}><DialogContent><DialogTitle>{editing ? "编辑落地服务" : "新建落地服务"}</DialogTitle><DialogDescription>参数可分别自定义；保存后由对应 Agent 检测端口、下载并启动服务。</DialogDescription><div className="grid gap-4 py-2"><div className="grid gap-2"><Label>落地机</Label><select className="h-10 rounded-md border bg-background px-3" value={hostId} disabled={!!editing} onChange={e => { const next = Number(e.target.value); setHostId(next); setEndpoint(String(eligible.find((item: any) => Number(item.hostId) === next)?.host?.ip || "")); }}>{eligible.map((item: any) => <option key={item.hostId} value={item.hostId}>{item.host.name} · {item.host.ip}</option>)}</select></div><div className="grid grid-cols-2 gap-3"><div className="grid gap-2"><Label>类型</Label><select className="h-10 rounded-md border bg-background px-3" value={protocol} onChange={e => { const next = e.target.value as "ss" | "ss2022"; setProtocol(next); setMethod(next === "ss" ? normalMethods[1] : methods2022[0]); }}><option value="ss">Shadowsocks</option><option value="ss2022">Shadowsocks 2022</option></select></div><div className="grid gap-2"><Label>加密方式</Label><select className="h-10 rounded-md border bg-background px-3" value={method} onChange={e => setMethod(e.target.value)}>{(protocol === "ss" ? normalMethods : methods2022).map(item => <option key={item}>{item}</option>)}</select></div></div><div className="grid gap-2"><Label>名称</Label><Input value={name} onChange={e => setName(e.target.value)} /></div><div className="grid grid-cols-[1fr_130px] gap-3"><div className="grid gap-2"><Label>密码</Label><Input value={password} onChange={e => setPassword(e.target.value)} /></div><div className="grid gap-2"><Label>端口</Label><Input type="number" value={port} onChange={e => { setPort(Number(e.target.value)); setPortCheckText(""); }} onBlur={() => void checkPort()} /></div></div><div className="grid gap-2"><Label>出口公网地址</Label><Input value={endpoint} placeholder={selectedEndpoint || "例如：example.com"} onChange={e => setEndpoint(e.target.value)} /></div><div className="grid grid-cols-[1fr_130px] gap-3"><div className="grid gap-2"><Label>延迟测试地址</Label><Input value={latencyTargetHost} onChange={e => setLatencyTargetHost(e.target.value)} /></div><div className="grid gap-2"><Label>测试端口</Label><Input type="number" value={latencyTargetPort} onChange={e => setLatencyTargetPort(Number(e.target.value))} /></div></div><Button variant="outline" onClick={() => void utils.landing.random.fetch().then(data => { setPassword(data.password); setPort(data.port); setPortCheckText(""); })}>随机生成密码和端口</Button>{selectedEndpoint && <p className="text-xs text-muted-foreground">Agent 部署地址：{selectedEndpoint}:{port}{portCheckText ? ` · ${portCheckText}` : ""}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button disabled={isSaving || !hostId || !name || !password || !endpoint || port < 1 || port > 65535} onClick={submit}>{editing ? "保存" : "创建"}</Button></DialogFooter></DialogContent></Dialog><Dialog open={!!qrService} onOpenChange={value => { if (!value) setQrService(null); }}><DialogContent className="max-w-sm"><DialogTitle>{qrService?.name || "落地 SS"} 二维码</DialogTitle><DialogDescription>使用 Shadowsocks 客户端扫码添加。</DialogDescription><div className="flex justify-center py-3">{qrData ? <img className="h-60 w-60 rounded-md bg-white p-2" src={qrData} alt="SS 二维码" /> : <div className="grid h-60 w-60 place-items-center text-sm text-muted-foreground">二维码生成中…</div>}</div><DialogFooter><Button variant="outline" onClick={() => copyService(qrService)}>复制 SS 链接</Button><Button onClick={() => setQrService(null)}>关闭</Button></DialogFooter></DialogContent></Dialog></div>;
}
