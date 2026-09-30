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
  if (status === "reachable" || status === "unlocked" || status === "native") return <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">可用</Badge>;
  if (status === "app_only" || status === "partial") return <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-300">部分</Badge>;
  if (status === "blocked") return <Badge variant="destructive">失败</Badge>;
  if (status === "error") return <Badge variant="outline">错误</Badge>;
  return <Badge variant="secondary">待确认</Badge>;
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
              <div className="rounded-lg border p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Wifi className="h-4 w-4" />IP / ASN</div>
                <div className="space-y-1 text-xs">
                  <div className="font-mono text-sm">{detectedIp || "检测中..."}</div>
                  <div>{identity.asn || "ASN 待检测"}</div>
                  <div>{identity.company || "运营商待检测"}</div>
                  <div>{[identity.city, identity.region, identity.country].filter(Boolean).join(" · ") || "地区待检测"}</div>
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4" />IP 风险</div>
                <div className="mb-2 flex items-center justify-between text-xs"><span>综合风险</span><span>{riskScore === null ? "暂无评分" : `${riskScore}/100`}</span></div>
                <Progress value={riskScore ?? 0} />
                <div className="mt-2 flex flex-wrap gap-1">
                  {risk.isDatacenter === true && <Badge variant="secondary">机房</Badge>}
                  {risk.isVPN === true && <Badge variant="secondary">VPN</Badge>}
                  {risk.isProxy === true && <Badge variant="secondary">Proxy</Badge>}
                  {risk.isTor === true && <Badge variant="destructive">Tor</Badge>}
                  {risk.isAbuser === true && <Badge variant="destructive">滥用记录</Badge>}
                  {riskScore === null && <span className="text-xs text-muted-foreground">风险评分源未配置或暂未返回</span>}
                </div>
              </div>
            </div>

            <div className="rounded-lg border p-3">
              <div className="mb-3 flex items-center justify-between"><div className="text-sm font-medium">应用解锁 / 可达性</div><span className="text-xs text-muted-foreground">{apps.length ? `${apps.length} 项已返回` : "等待结果"}</span></div>
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {apps.map((app: any) => (
                  <div key={app.id} className="flex min-h-14 items-center justify-between gap-2 rounded-md border bg-background/60 px-2.5 py-2">
                    <div className="min-w-0"><div className="truncate text-sm font-medium">{app.name || app.id}</div><div className="truncate text-[10px] text-muted-foreground">{app.region || (app.latencyMs != null ? `${app.latencyMs} ms` : app.message || "")}</div></div>
                    {statusBadge(String(app.status || "unknown"))}
                  </div>
                ))}
                {apps.length === 0 && <div className="col-span-full py-5 text-center text-xs text-muted-foreground">检测开始后会逐项显示，不需要等待全部完成。</div>}
              </div>
            </div>

            <div className="rounded-lg border p-3">
              <div className="mb-2 text-sm font-medium">网络 / IXP</div>
              <div className="grid gap-1 text-xs sm:grid-cols-2">
                <div>ASN：{data.network?.asn || identity.asn || "待检测"}</div>
                <div>Prefix：{data.network?.prefix || "待检测"}</div>
                <div>IXP：{Array.isArray(data.network?.ixp) && data.network.ixp.length ? data.network.ixp.join(" · ") : "待补全"}</div>
                <div>Peering：{data.network?.peers ?? "待补全"}</div>
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
