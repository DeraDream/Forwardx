import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Gauge, RefreshCw, TimerOff, Waves } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { trpc } from "@/lib/trpc";
import { calculateLinkQuality, filterLinkQualitySamples, linkQualitySampleTime, linkQualityStatusLabel, type LinkQualitySample } from "@/lib/linkQuality";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { pollingInterval } from "@/lib/polling";

export type LinkQualityScope = "rule" | "tunnel" | "chain" | "full-chain";
export type LinkQualityTarget = { scope: LinkQualityScope; id: number; name: string; subtitle?: string };
type RangeHours = 1 | 24 | 168;

const rangeOptions: Array<{ value: RangeHours; label: string }> = [
  { value: 1, label: "1H" }, { value: 24, label: "24H" }, { value: 168, label: "7D" },
];

function formatLatency(value: number | null) { return value == null ? "—" : `${Math.round(value)} ms`; }
function formatPercent(value: number | null) { return value == null ? "—" : `${Number(value).toFixed(1)}%`; }
function formatDateTime(value: number | null) {
  if (!value) return "—";
  const date = new Date(value); const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function formatAgo(value: number | null) {
  if (!value) return "无数据";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function CompactStat({ label, value, hint, icon: Icon }: { label: string; value: string; hint?: string; icon: typeof Activity }) {
  return <div className="rounded-lg border border-border/55 bg-card/75 px-2.5 py-2 transition-colors hover:border-border">
    <div className="flex items-center justify-between gap-2 text-[11px] font-medium leading-none text-muted-foreground"><span>{label}</span><Icon className="h-3 w-3 shrink-0 text-muted-foreground/75" /></div>
    <div className="mt-1.5 truncate font-mono text-[15px] font-bold leading-tight tracking-tight text-foreground">{value}</div>
    {hint && <div className="mt-1 truncate text-[10px] leading-none text-muted-foreground">{hint}</div>}
  </div>;
}

export function LinkQualityDialog({ target, open, onOpenChange }: { target: LinkQualityTarget | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [rangeHours, setRangeHours] = useState<RangeHours>(24);
  const [smooth, setSmooth] = useState(false);
  const enabled = open && !!target?.id;
  const ruleQuery = trpc.rules.tcpingSeries.useQuery({ ruleId: Number(target?.id || 0), hours: 168 }, { enabled: enabled && target?.scope === "rule", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false });
  const tunnelQuery = trpc.tunnels.latencySeries.useQuery({ tunnelId: Number(target?.id || 0), hours: 168 }, { enabled: enabled && target?.scope === "tunnel", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false });
  const chainQuery = trpc.forwardGroups.latencySeries.useQuery({ groupId: Number(target?.id || 0), hours: 168 }, { enabled: enabled && target?.scope === "chain", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false });
  const fullChainQuery = trpc.fullChains.latencySeries.useQuery({ id: Number(target?.id || 0), hours: 168 }, { enabled: enabled && target?.scope === "full-chain", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false });
  const activeQuery = target?.scope === "tunnel" ? tunnelQuery : target?.scope === "chain" ? chainQuery : target?.scope === "full-chain" ? fullChainQuery : ruleQuery;
  const rawSeries = (activeQuery.data || []) as LinkQualitySample[];
  const rangedSeries = useMemo(() => filterLinkQualitySamples(rawSeries, rangeHours), [rawSeries, rangeHours]);
  const stats = useMemo(() => calculateLinkQuality(rangedSeries), [rangedSeries]);
  const chartData = useMemo(() => rangedSeries.map((sample) => {
    const at = new Date(linkQualitySampleTime(sample.recordedAt));
    const timeout = sample.isTimeout === true || Number(sample.isTimeout) === 1;
    const pad = (value: number) => String(value).padStart(2, "0");
    return { label: `${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`, latency: timeout ? null : Number(sample.latencyMs ?? 0), timeout };
  }), [rangedSeries]);
  const unstable = stats.status === "unstable" || stats.status === "degraded";
  const windowLabel = rangeHours === 1 ? "近 1 小时" : rangeHours === 24 ? "近 24 小时" : "近 7 天";

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[820px]">
      <DialogHeader className="shrink-0 border-b border-border/50 px-4 py-3 pr-12 sm:px-5">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-[15px] tracking-tight"><Activity className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.2} /><span className="truncate">链路质量 · {target?.name || "未命名链路"}</span></DialogTitle>
        <DialogDescription className="mt-1 pl-6 text-[11px] leading-none">{target?.subtitle || "规则链路质量历史"} · 最近探测 {formatAgo(stats.lastRecordedAt)}</DialogDescription>
      </DialogHeader>

      <div className="dialog-scroll-area min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex items-center rounded-lg border border-border/60 bg-muted/55 p-0.5">{rangeOptions.map((option) => <button key={option.value} type="button" onClick={() => setRangeHours(option.value)} className={option.value === rangeHours ? "rounded-md bg-card px-2.5 py-0.5 font-mono text-[11px] font-semibold text-foreground shadow-sm" : "rounded-md px-2.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"}>{option.label}</button>)}</div>
          <div className="flex items-center gap-2"><span className={unstable ? "inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium leading-none text-amber-700 dark:text-amber-300" : "inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium leading-none text-emerald-700 dark:text-emerald-300"}>{unstable ? <Clock3 className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}{linkQualityStatusLabel(stats.status)}</span><Button type="button" variant="outline" size="sm" className="h-7 gap-1 px-2.5 text-[11px]" onClick={() => void activeQuery.refetch()} disabled={activeQuery.isFetching}><RefreshCw className={activeQuery.isFetching ? "h-3 w-3 animate-spin" : "h-3 w-3"} />刷新</Button></div>
        </div>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <CompactStat label="当前延迟" value={stats.currentIsTimeout ? "超时" : formatLatency(stats.currentLatency)} hint={formatDateTime(stats.lastRecordedAt)} icon={Activity} />
          <CompactStat label="可用率" value={formatPercent(stats.availability)} hint={`${stats.success}/${stats.total || 0} 次成功`} icon={CheckCircle2} />
          <CompactStat label="P95" value={formatLatency(stats.p95)} hint="95% 探测低于该值" icon={Gauge} />
          <CompactStat label="抖动" value={formatLatency(stats.jitter)} hint="相邻成功样本平均波动" icon={Waves} />
          <CompactStat label="超时率" value={formatPercent(stats.timeoutRate)} hint={`${stats.timeout} 次超时`} icon={TimerOff} />
          <CompactStat label="连续异常" value={String(stats.consecutiveFailures)} hint={stats.lastFailureAt ? `最近 ${formatDateTime(stats.lastFailureAt)}` : "暂无异常"} icon={AlertTriangle} />
        </section>

        <section className="rounded-xl border border-border/55 bg-card/65 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-[13px] font-bold leading-none text-foreground">延迟趋势</h2><p className="mt-1 text-[11px] leading-none text-muted-foreground">只读取历史探测样本；超时点不会伪造成 0 ms。</p></div><div className="flex items-center gap-2.5"><span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{stats.total} 个样本</span><span className="border-l border-border/60 pl-2 text-[11px] font-medium text-foreground">平滑</span><Switch checked={smooth} onCheckedChange={setSmooth} aria-label="平滑延迟趋势" className="scale-75 origin-right" /></div></div>
          <div className="h-[155px] w-full text-primary">{chartData.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}><defs><linearGradient id="linkQualityGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={smooth ? .30 : .14} /><stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity="0" /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} /><XAxis dataKey="label" minTickGap={48} tick={{ fontSize: 9 }} interval="preserveStartEnd" /><YAxis width={44} tick={{ fontSize: 9 }} tickFormatter={(value) => `${value}ms`} /><RechartsTooltip contentStyle={{ borderRadius: 8, fontSize: 11 }} formatter={(value: any) => [value == null ? "超时" : `${Math.round(Number(value))} ms`, "延迟"]} /><Area type={smooth ? "monotone" : "linear"} dataKey="latency" stroke="var(--color-chart-2)" strokeWidth={smooth ? 1.6 : 1.25} strokeLinecap="round" strokeLinejoin="round" fill="url(#linkQualityGradient)" fillOpacity={smooth ? 1 : .35} connectNulls={false} dot={false} activeDot={{ r: 3.5, fill: "var(--color-chart-2)", stroke: "var(--color-background)", strokeWidth: 2 }} isAnimationActive={false} /></AreaChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">当前时间范围暂无历史探测数据</div>}</div>
        </section>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4"><CompactStat label="最低延迟" value={formatLatency(stats.min)} icon={Activity} /><CompactStat label="平均延迟" value={formatLatency(stats.average)} icon={Gauge} /><CompactStat label="P50" value={formatLatency(stats.p50)} icon={Clock3} /><CompactStat label="最高延迟" value={formatLatency(stats.max)} icon={AlertTriangle} /></section>
        <div className="rounded-lg border border-border/45 bg-muted/25 px-3 py-2 text-[11px] text-muted-foreground"><div className="flex flex-wrap items-center gap-x-4 gap-y-1"><span>统计窗口：{windowLabel}</span><span>成功：{stats.success}</span><span>超时：{stats.timeout}</span><span>最近异常：{formatDateTime(stats.lastFailureAt)}</span></div></div>
      </div>
    </DialogContent>
  </Dialog>;
}
