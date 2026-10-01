import { useMemo, useState } from "react";
import { Activity, Globe2, RefreshCw, ShieldCheck, Wifi, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";

type Family = "ipv4" | "ipv6";

function statusBadge(status: string) {
  if (status === "error") return <Badge className="border-red-200 bg-red-500/10 text-red-700">检测错误</Badge>;
  if (status === "blocked") return <Badge className="border-red-200 bg-red-500/15 text-red-700 dark:text-red-300">屏蔽</Badge>;
  if (status === "app_only") return <Badge className="border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300">仅 App</Badge>;
  if (status === "web_only") return <Badge className="border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300">仅 Web</Badge>;
  return <Badge className="border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">解锁</Badge>;
}

function statusCardClass(status: string) {
  if (status === "error" || status === "blocked") return "border-red-200/80 bg-red-500/5";
  if (status === "app_only" || status === "web_only") return "border-amber-200/80 bg-amber-500/5";
  return "border-emerald-200/80 bg-emerald-500/5";
}

function riskPercent(data: any): number | null {
  const score = Number(data?.score);
  if (data?.score !== null && data?.score !== undefined && Number.isFinite(score) && score >= 0) {
    return Math.min(100, Math.round(score));
  }
  const knownFlags = ["isDatacenter", "isVPN", "isProxy", "isTor", "isAbuser"]
    .filter((key) => typeof data?.[key] === "boolean");
  if (knownFlags.length === 0) return null;
  let derived = 0;
  if (data?.isDatacenter === true) derived += 20;
  if (data?.isVPN === true) derived += 25;
  if (data?.isProxy === true) derived += 25;
  if (data?.isTor === true) derived += 40;
  if (data?.isAbuser === true) derived += 35;
  return Math.min(100, derived);
}

export function HostNetworkProfileDialog({
  hostId,
  hostName,
  open,
  onOpenChange,
}: {
  hostId: number;
  hostName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [family, setFamily] = useState<Family>("ipv4");
  const query = trpc.networkProfile.status.useQuery(
    { hostId },
    { enabled: open && hostId > 0, refetchInterval: open ? 800 : false, refetchOnWindowFocus: false },
  );
  const start = trpc.networkProfile.start.useMutation({
    onError: (error) => toast.error(error.message),
    onSuccess: () => void query.refetch(),
  });
  const familyView = family === "ipv4" ? query.data?.ipv4 : query.data?.ipv6;
  const current = familyView?.running || familyView?.persisted;
  const running = familyView?.running?.status === "running";
  const data = current?.data || {};
  const identity = data.identity || {};
  const risk = data.risk || {};
  const apps = useMemo(() => Object.values(data.apps || {}) as any[], [data.apps]);
  const riskScore = riskPercent(risk);
  const steps = current?.steps || {};
  const completed = Object.values(steps).filter((item: any) => ["success", "error", "skip"].includes(item?.status)).length;
  const total = Math.max(5, Object.keys(steps).length);
  const progress = Math.min(100, Math.round((completed / total) * 100));
  const detectedIp = data.ip?.address || identity.ip || (family === "ipv4" ? query.data?.host.ipv4 : query.data?.host.ipv6);
  const ixpItems = Array.isArray(data.network?.ixp) ? data.network.ixp : [];
  const ixpNames = ixpItems.map((item: any) => typeof item === "string" ? item : item?.name).filter(Boolean);
  const bgpToolsIXPCount = Number.isFinite(Number(data.network?.bgpToolsIXPCount)) ? Number(data.network.bgpToolsIXPCount) : null;
  const ixpText = ixpNames.length
    ? ixpNames.join(" · ")
    : bgpToolsIXPCount !== null
      ? (bgpToolsIXPCount > 0 ? "BGP.Tools 检测到 " + bgpToolsIXPCount + " 个 IXP 路由接入" : "BGP.Tools 未检测到 IXP 路由接入")
      : data.network?.registered === false
        ? "PeeringDB 未登记"
        : Number(data.network?.ixCount) === 0
          ? "无 IXP 登记"
          : Array.isArray(data.network?.warnings) && data.network.warnings.some((item: any) => String(item).startsWith("PeeringDB:"))
            ? "IXP 检测失败"
            : "待检测";
  const riskLevelText: Record<string, string> = { low: "低", medium: "中等", high: "高", very_high: "极高", unknown: "未知" };
  const networkType = risk.networkType || (risk.isDatacenter === true ? "Hosting / Datacenter" : "");
  const rpkiText: Record<string, string> = { valid: "有效", invalid_asn: "ASN 不匹配", invalid_length: "前缀长度无效", unknown: "未配置 ROA" };
  const neighbours = Array.isArray(data.network?.neighbours) ? data.network.neighbours : [];
  const ipNatureText: Record<string, string> = { native: "原生 IP", broadcast: "广播 IP", unknown: "待确认" };
  const relationClass = (relation: string, index: number) => {
    const value = String(relation || "").toLowerCase();
    if (value.includes("left")) return "border-sky-300 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    if (value.includes("right")) return "border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    const palette = [
      "border-violet-300 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      "border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      "border-cyan-300 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      "border-rose-300 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    ];
    return palette[index % palette.length];
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Globe2 className="h-5 w-5" />网络画像 · {hostName || query.data?.host.name || `主机 #${hostId}`}</DialogTitle>
          <DialogDescription>IPv4 / IPv6 独立检测；重新检测时结果会边跑边更新。</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          {(["ipv4", "ipv6"] as Family[]).map((item) => (
            <Button key={item} variant={family === item ? "default" : "outline"} size="sm" onClick={() => setFamily(item)}>
              {item === "ipv4" ? "IPv4" : "IPv6"}
              {item === "ipv4" && query.data?.host.ipv4 ? <span className="ml-1 max-w-36 truncate font-mono text-[10px] opacity-80">{query.data.host.ipv4}</span> : null}
              {item === "ipv6" && query.data?.host.ipv6 ? <span className="ml-1 max-w-36 truncate font-mono text-[10px] opacity-80">{query.data.host.ipv6}</span> : null}
            </Button>
          ))}
        </div>

        {running && (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 animate-pulse" />正在检测，结果会实时出现</span><span>{progress}%</span></div>
            <Progress value={progress} />
          </div>
        )}

        {!current ? (
          <div className="rounded-lg border border-dashed py-14 text-center text-sm text-muted-foreground">该协议族还没有检测记录。</div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-sky-200/70 bg-sky-500/[0.035] p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-sky-700 dark:text-sky-300"><Wifi className="h-4 w-4" />IP / ASN</div>
                <div className="space-y-1 text-xs">
                  <div className="font-mono text-sm font-semibold text-sky-700 dark:text-sky-300">{detectedIp || "检测中..."}</div>
                  <div><span className="text-muted-foreground">ASN：</span><span className="font-medium text-violet-700 dark:text-violet-300">{identity.asn || "待检测"}</span></div>
                  <div><span className="text-muted-foreground">运营商：</span><span className="font-medium text-indigo-700 dark:text-indigo-300">{identity.company || identity.isp || "待检测"}</span></div>
                  <div><span className="text-muted-foreground">地区：</span><span className="font-medium text-emerald-700 dark:text-emerald-300">{[identity.flag, identity.city, identity.region, identity.country].filter(Boolean).join(" · ") || "待检测"}</span></div>
                  <div><span className="text-muted-foreground">IP 属性：</span><span className={identity.ipNature === "broadcast" ? "font-semibold text-red-600 dark:text-red-400" : identity.ipNature === "native" ? "font-semibold text-emerald-600 dark:text-emerald-400" : "font-medium text-amber-700 dark:text-amber-300"}>{ipNatureText[String(identity.ipNature || "unknown")] || "待确认"}</span></div>
                  <div><span className="text-muted-foreground">使用类型：</span><span className="font-medium text-amber-700 dark:text-amber-300">{networkType || "待检测"}</span>{identity.domain ? <span className="text-muted-foreground"> · {identity.domain}</span> : null}</div>
                </div>
              </div>
              <div className="rounded-lg border border-amber-200/70 bg-amber-500/[0.035] p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300"><ShieldCheck className="h-4 w-4" />IP 风险</div>
                <div className="mb-2 flex items-center justify-between text-xs"><span>综合风险</span><span>{riskScore === null ? "暂无评分" : `${riskScore}/100 · ${riskLevelText[String(risk.level || "unknown")] || risk.level}`}</span></div>
                <Progress value={riskScore ?? 0} className={riskScore == null ? "" : riskScore < 25 ? "[&>div]:bg-emerald-500" : riskScore < 60 ? "[&>div]:bg-amber-500" : "[&>div]:bg-red-500"} />
                <div className="mt-2 flex flex-wrap gap-1">
                  {riskScore !== null && riskScore < 25 && <Badge className="border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">低风险</Badge>}
                  {riskScore !== null && riskScore >= 25 && riskScore < 60 && <Badge className="border-amber-200 bg-amber-500/15 text-amber-700 dark:text-amber-300">中等风险</Badge>}
                  {riskScore !== null && riskScore >= 60 && <Badge className="border-red-200 bg-red-500/15 text-red-700 dark:text-red-300">高风险</Badge>}
                  {risk.isDatacenter === true && <Badge variant="secondary">机房</Badge>}
                  {risk.isVPN === true && <Badge variant="secondary">VPN</Badge>}
                  {risk.isProxy === true && <Badge variant="secondary">Proxy</Badge>}
                  {risk.isTor === true && <Badge variant="destructive">Tor</Badge>}
                  {risk.isAbuser === true && <Badge variant="destructive">滥用记录</Badge>}
                  {networkType && <Badge variant="outline">{networkType}</Badge>}
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">数据源：{risk.provider === "multi-source" ? "多库综合" : risk.provider || "待检测"}</div>
                {riskScore === null && <div className="mt-1 text-xs text-muted-foreground">暂无可用评分。</div>}
              </div>
            </div>


            <div className="rounded-lg border border-violet-200/60 bg-violet-500/[0.025] p-3">
              <div className="mb-1 flex items-center justify-between"><div className="text-sm font-medium text-violet-700 dark:text-violet-300">应用解锁 / 可达性</div><span className="text-xs text-muted-foreground">{apps.length ? `${apps.length} 项已返回` : "等待结果"}</span></div>
              <div className="mb-3 text-[11px] text-muted-foreground">应用结果显示“解锁 / 屏蔽”；ChatGPT 会额外区分“仅 App / 仅 Web”，网络或接口本身异常时单独显示“检测错误”。</div>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {apps.map((app: any) => (
                  <div key={app.id} className={`flex min-h-14 items-center justify-between gap-2 rounded-md border px-2.5 py-2 ${statusCardClass(String(app.status || "unknown"))}`}>
                    <div className="min-w-0"><div className="truncate text-sm font-medium">{app.name || app.id}</div><div className="truncate text-[10px] text-muted-foreground" title={app.note || app.message || ""}>{app.region ? `${app.region}${app.latencyMs != null ? ` · ${app.latencyMs} ms` : ""}` : (app.latencyMs != null ? `${app.latencyMs} ms` : app.message || app.note || "")}</div></div>
                    {statusBadge(String(app.status || "unknown"))}
                  </div>
                ))}
                {apps.length === 0 && <div className="col-span-full py-5 text-center text-xs text-muted-foreground">检测开始后会逐项显示，不需要等待全部完成。</div>}
              </div>
            </div>

            <div className="rounded-lg border border-cyan-200/60 bg-cyan-500/[0.025] p-3">
              <div className="mb-2 text-sm font-medium text-cyan-700 dark:text-cyan-300">网络 / IXP</div>
              <div className="grid gap-1 text-xs sm:grid-cols-2">
                <div>ASN：{data.network?.asn || identity.asnNumber || identity.asn || "待检测"}</div>
                <div>网络名称：{data.network?.name || identity.company || "待检测"}</div>
                <div>Prefix：{data.network?.prefix || "待检测"}</div>
                <div>RPKI：{data.network?.rpki ? (rpkiText[String(data.network.rpki)] || data.network.rpki) : "待检测"}</div>
                <div className="sm:col-span-2">
                  <div className="mb-1.5 text-muted-foreground">互联网互联 ASN：</div>
                  {neighbours.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {neighbours.map((item: any, index: number) => (
                        <div key={`${item.asn}-${index}`} className={`min-w-[78px] rounded-md border px-2 py-1 text-center leading-tight ${relationClass(item.relation, index)}`}>
                          <div className="text-[11px] font-semibold">AS{item.asn}</div>
                          <div className="max-w-[96px] truncate text-[10px] font-medium" title={item.fullName || item.name || ""}>{item.name || "未知"}</div>
                        </div>
                      ))}
                    </div>
                  ) : <span className="text-muted-foreground">待检测</span>}
                </div>
                <div className="sm:col-span-2">IXP：{ixpText}</div>
                <div>PeeringDB 交换点 / 机房：{data.network?.ixCount ?? "—"} / {data.network?.facilityCount ?? "—"}</div>
                <div>AS 邻居：{data.network?.neighbourUnique ?? "—"}（左 {data.network?.neighbourLeft ?? "—"} / 右 {data.network?.neighbourRight ?? "—"}）</div>
                <div>上游：{data.network?.upstreamCount ?? "—"}{data.network?.transitFree === true ? "（Transit-free）" : ""}</div>
                <div>Peers：{data.network?.peerCount ?? "—"}</div>
                <div className="sm:col-span-2 text-[11px] text-muted-foreground">BGP 接入统计优先参考 BGP.Tools；互联 ASN 继续结合 RIPEstat，IXP 名称来自 PeeringDB。</div>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {current?.completedAt ? `上次完成：${new Date(current.completedAt).toLocaleString()}` : current?.updatedAt ? `更新：${new Date(current.updatedAt).toLocaleTimeString()}` : ""}
          </div>
          <div className="flex gap-2">
            {family === "ipv6" && !query.data?.host.ipv6 && !current ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><XCircle className="h-3.5 w-3.5" />当前未上报 IPv6</span> : null}
            <Button variant="outline" disabled={start.isPending || running} onClick={() => start.mutate({ hostId, family, mode: "quick" })}>快速检测</Button>
            <Button disabled={start.isPending || running} onClick={() => start.mutate({ hostId, family, mode: "full" })}>{running ? <Activity className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{current ? "重新完整检测" : "完整检测"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
