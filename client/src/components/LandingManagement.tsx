import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Copy, Plus, QrCode, Server, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { copyTextToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";

const normalMethods = ["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"];
const methods2022 = ["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"];
const base64Url = (value: string) => btoa(unescape(encodeURIComponent(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

function ssUri(service: any) {
  const endpoint = String(service?.host?.ip || service?.endpoint || "");
  if (!endpoint || !service?.password) return "";
  return `ss://${base64Url(`${service.method}:${service.password}`)}@${endpoint}:${service.port}#${encodeURIComponent(service.name)}`;
}

export function LandingManagement() {
  const utils = trpc.useUtils();
  const hostsQuery = trpc.hosts.list.useQuery();
  const eligibleQuery = trpc.landing.eligibleHosts.useQuery(undefined, { refetchInterval: 5000 });
  const servicesQuery = trpc.landing.list.useQuery(undefined, { refetchInterval: 5000 });
  const mark = trpc.landing.markHost.useMutation({ onSuccess: () => void eligibleQuery.refetch() });
  const unmark = trpc.landing.unmarkHost.useMutation({ onSuccess: () => void eligibleQuery.refetch() });
  const create = trpc.landing.create.useMutation({ onSuccess: () => { void servicesQuery.refetch(); setOpen(false); toast.success("已下发给 Agent 部署"); }, onError: (error) => toast.error(error.message) });
  const remove = trpc.landing.remove.useMutation({ onSuccess: () => void servicesQuery.refetch(), onError: (error) => toast.error(error.message) });
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState(0);
  const [protocol, setProtocol] = useState<"ss" | "ss2022">("ss");
  const [name, setName] = useState("落地 SS");
  const [method, setMethod] = useState(normalMethods[1]);
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(30000);
  const [portCheckText, setPortCheckText] = useState("");
  const [qrService, setQrService] = useState<any>(null);
  const [qrData, setQrData] = useState("");
  const eligible = eligibleQuery.data || [];
  const services = useMemo(() => (servicesQuery.data || []).map((item: any) => ({ ...item, host: eligible.find((entry: any) => Number(entry.hostId) === Number(item.hostId))?.host })), [eligible, servicesQuery.data]);
  const unmarkedHosts = useMemo(() => (hostsQuery.data || []).filter((host: any) => !eligible.some((entry: any) => Number(entry.hostId) === Number(host.id))), [eligible, hostsQuery.data]);
  const selectedEndpoint = eligible.find((entry: any) => Number(entry.hostId) === hostId)?.host?.ip || "";
  const submit = () => create.mutate({ hostId, name, protocol, method: method as any, password, port });
  const checkPort = async () => {
    if (!hostId || port < 1 || port > 65535) return;
    const first = await utils.landing.checkPort.fetch({ hostId, port });
    setPortCheckText(first.message);
    if (first.complete || !first.checkId) return;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      const next = await utils.landing.portCheckStatus.fetch({ checkId: first.checkId });
      setPortCheckText(next.message);
      if (next.complete) { if (!next.available) toast.error(next.message); return; }
    }
  };
  const random = async () => { const data = await utils.landing.random.fetch(); setPassword(data.password); setPort(data.port); };
  useEffect(() => { if (!qrService) return void setQrData(""); void QRCode.toDataURL(ssUri(qrService), { width: 240, margin: 1 }).then(setQrData).catch(() => setQrData("")); }, [qrService]);
  return <div className="space-y-5">
    <Card><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold">落地机</h2><p className="text-sm text-muted-foreground">这里只标记可创建落地服务的 VPS；标记本身不会改变 Agent 或现有链路。</p></div><select className="h-10 rounded-md border bg-background px-3 text-sm" defaultValue="" onChange={(event) => { const id = Number(event.target.value); if (id) mark.mutate({ hostId: id }); event.currentTarget.value = ""; }}><option value="">添加 VPS 为落地机…</option>{unmarkedHosts.map((host: any) => <option key={host.id} value={host.id}>{host.name} · {host.entryIp || host.ip}</option>)}</select></CardContent></Card>
    <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">落地服务</h2><p className="text-sm text-muted-foreground">一台落地机可运行多个 Shadowsocks / SS2022 服务。</p></div><Button onClick={() => { setHostId(Number(eligible[0]?.hostId || 0)); setOpen(true); }} disabled={!eligible.length}><Plus className="mr-2 h-4 w-4" />新建落地</Button></div>
    <div className="grid gap-3 md:grid-cols-2">{eligible.map((entry: any) => <Card key={entry.id}><CardContent className="flex items-center justify-between p-4"><div><div className="flex items-center gap-2 font-medium"><Server className="h-4 w-4" />{entry.host.name}{entry.host.isOnline ? <Badge>在线</Badge> : <Badge variant="secondary">离线</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">{entry.host.ip}</p></div><Button size="sm" variant="ghost" disabled={services.some((item: any) => Number(item.hostId) === Number(entry.hostId))} onClick={() => unmark.mutate({ hostId: entry.hostId })}>取消标记</Button></CardContent></Card>)}</div>
    <div className="grid gap-3 md:grid-cols-2">{services.map((service: any) => <Card key={service.id}><CardContent className="p-4"><div className="flex items-start justify-between"><div><div className="font-medium">{service.name}</div><p className="mt-1 text-sm text-muted-foreground">{service.protocol.toUpperCase()} · {service.method} · {service.host?.name || `主机 #${service.hostId}`}</p></div><Badge variant={service.status === "running" ? "default" : "secondary"}>{service.status === "running" ? "运行中" : service.status === "error" ? "错误" : "部署中"}</Badge></div><p className="mt-3 font-mono text-sm">{service.host?.ip || "-"}:{service.port}</p><p className="mt-1 text-xs text-muted-foreground">{service.statusMessage || "等待 Agent 状态"}</p><div className="mt-4 flex gap-2"><Button size="sm" variant="outline" onClick={() => setQrService(service)}><QrCode className="mr-1 h-4 w-4" />二维码</Button><Button size="sm" variant="outline" onClick={() => void copyTextToClipboard(ssUri(service)).then(() => toast.success("SS 链接已复制"))}><Copy className="mr-1 h-4 w-4" />复制</Button><Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => remove.mutate({ id: service.id })}><Trash2 className="h-4 w-4" /></Button></div></CardContent></Card>)}</div>
    {!eligible.length && <p className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">先将一台已有 VPS 标记为落地机。</p>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>新建落地服务</DialogTitle><DialogDescription>参数可分别自定义；创建后由对应 Agent 实际检测端口、下载并启动服务。</DialogDescription><div className="grid gap-4 py-2"><div className="grid gap-2"><Label>落地机</Label><select className="h-10 rounded-md border bg-background px-3" value={hostId} onChange={(e) => setHostId(Number(e.target.value))}>{eligible.map((item: any) => <option key={item.hostId} value={item.hostId}>{item.host.name} · {item.host.ip}</option>)}</select></div><div className="grid grid-cols-2 gap-3"><div className="grid gap-2"><Label>类型</Label><select className="h-10 rounded-md border bg-background px-3" value={protocol} onChange={(e) => { const next = e.target.value as "ss" | "ss2022"; setProtocol(next); setMethod(next === "ss" ? normalMethods[1] : methods2022[0]); }}><option value="ss">Shadowsocks</option><option value="ss2022">Shadowsocks 2022</option></select></div><div className="grid gap-2"><Label>加密方式</Label><select className="h-10 rounded-md border bg-background px-3" value={method} onChange={(e) => setMethod(e.target.value)}>{(protocol === "ss" ? normalMethods : methods2022).map((item) => <option key={item}>{item}</option>)}</select></div></div><div className="grid gap-2"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div><div className="grid grid-cols-[1fr_130px] gap-3"><div className="grid gap-2"><Label>密码</Label><Input value={password} onChange={(e) => setPassword(e.target.value)} /></div><div className="grid gap-2"><Label>端口</Label><Input type="number" value={port} onChange={(e) => { setPort(Number(e.target.value)); setPortCheckText(""); }} onBlur={() => void checkPort()} /></div></div><Button variant="outline" onClick={() => void random()}>随机生成密码和端口</Button>{selectedEndpoint && <p className="text-xs text-muted-foreground">将部署到：{selectedEndpoint}:{port}{portCheckText ? ` · ${portCheckText}` : ""}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button disabled={create.isPending || !hostId || password.length < 8} onClick={submit}>{create.isPending ? "下发中…" : "创建"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!qrService} onOpenChange={(value) => !value && setQrService(null)}><DialogContent className="max-w-sm"><DialogTitle>{qrService?.name}</DialogTitle>{qrData && <img className="mx-auto h-60 w-60" src={qrData} alt="SS 二维码" />}<Input value={ssUri(qrService)} readOnly /><DialogFooter><Button onClick={() => void copyTextToClipboard(ssUri(qrService)).then(() => toast.success("SS 链接已复制"))}>复制链接</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
