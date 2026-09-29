import { useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Gauge, RefreshCw, TimerReset, Waves } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { trpc } from "@/lib/trpc";
import { calculateLinkQuality, filterLinkQualitySamples, linkQualityStatusLabel, type LinkQualitySample } from "@/lib/linkQuality";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { pollingInterval } from "@/lib/polling";

export type LinkQualityScope = "rule" | "tunnel" | "chain" | "full-chain";

export type LinkQualityTarget = {
  scope: LinkQualityScope;
  id: number;
  name: string;
  subtitle?: string;
};

type RangeHours = 1 | 24 | 168;

const rangeOptions: Array<{ value: RangeHours; label: string }> = [
  { value: 1, label: "1H" },
  { value: 24, label: "24H" },
  { value: 168, label: "7D" },
];

function formatLatency(value: number | null) {
  return value == null ? "—" : String(value) + " ms";
}

function formatPercent(value: number | null) {
  return value == null ? "—" : String(value) + "%";
}

function formatDateTime(value: number | null) {
  if (!value) return "—";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return pad(date.getMonth() + 1) + "/" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function formatAgo(value: number | null) {
  if (!value) return "无数据";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return String(seconds) + " 秒前";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return String(minutes) + " 分钟前";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return String(hours) + " 小时前";
  return String(Math.floor(hours / 24)) + " 天前";
}

function statusTone(status: ReturnType<typeof calculateLinkQuality>["status"]) {
  if (status === "healthy") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
  if (status === "unstable") return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300";
  if (status === "degraded") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

function StatCard({ label, value, hint, icon: Icon }: { label: string; value: string; hint?: string; icon: typeof Activity }) {
  return (
    <div className="rounded-lg border border-border/45 bg-card/55 p-3">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="mt-1.5 text-lg font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-1 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function LinkQualityDialog({ target, open, onOpenChange }: { target: LinkQualityTarget | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [rangeHours, setRangeHours] = useState<RangeHours>(24);
  const enabled = open && !!target?.id;

  const ruleQuery = trpc.rules.tcpingSeries.useQuery(
    { ruleId: Number(target?.id || 0), hours: 168 },
    { enabled: enabled && target?.scope === "rule", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false },
  );
  const tunnelQuery = trpc.tunnels.latencySeries.useQuery(
    { tunnelId: Number(target?.id || 0), hours: 168 },
    { enabled: enabled && target?.scope === "tunnel", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false },
  );
  const chainQuery = trpc.forwardGroups.latencySeries.useQuery(
    { groupId: Number(target?.id || 0), hours: 168 },
    { enabled: enabled && target?.scope === "chain", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false },
  );
  const fullChainQuery = trpc.fullChains.latencySeries.useQuery(
    { id: Number(target?.id || 0), hours: 168 },
    { enabled: enabled && target?.scope === "full-chain", refetchInterval: pollingInterval("slow", enabled), refetchOnWindowFocus: false },
  );

  const activeQuery =
    target?.scope === "tunnel"
      ? tunnelQuery
      : target?.scope === "chain"
        ? chainQuery
        : target?.scope === "full-chain"
          ? fullChainQuery
          : ruleQuery;
  const rawSeries = (activeQuery.data || []) as LinkQualitySample[];
  const rangedSeries = useMemo(() => filterLinkQualitySamples(rawSeries, rangeHours), [rawSeries, rangeHours]);
  const stats = useMemo(() => calculateLinkQuality(rangedSeries), [rangedSeries]);

  const chartData = useMemo(
    () => rangedSeries.map((sample) => {
      const at = new Date(sample.recordedAt || 0);
      const timeout = sample.isTimeout === true || Number(sample.isTimeout) === 1;
      const pad = (n: number) => String(n).padStart(2, "0");
      return {
        at: at.getTime(),
        label: pad(at.getMonth() + 1) + "/" + pad(at.getDate()) + " " + pad(at.getHours()) + ":" + pad(at.getMinutes()),
        latency: timeout ? null : Number(sample.latencyMs ?? 0),
        timeout,
      };
    }),
    [rangedSeries],
  );

  const handleRefresh = async () => {
    await activeQuery.refetch();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b border-border/50 px-4 pb-3 pt-4 pr-12 sm:px-5">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <Activity className="h-5 w-5 shrink-0 text-primary" />
            <span className="truncate">链路质量 · {target?.name || "未命名链路"}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{target?.subtitle || "基于历史探测记录计算，仅用于观测展示"}</span>
            <span>·</span>
            <span>最近探测 {formatAgo(stats.lastRecordedAt)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="dialog-scroll-area min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-md border border-border/50 bg-muted/20 p-1">
              {rangeOptions.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={rangeHours === option.value ? "secondary" : "ghost"}
                  className="h-7 min-w-12 px-2 text-xs"
                  onClick={() => setRangeHours(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={"h-7 gap-1.5 px-2.5 " + statusTone(stats.status)}>
                {stats.status === "degraded" ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {linkQualityStatusLabel(stats.status)}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => void handleRefresh()}
                disabled={activeQuery.isFetching}
                title="只刷新已有历史数据，不触发 Agent 探测"
              >
                <RefreshCw className={"h-3.5 w-3.5 " + (activeQuery.isFetching ? "animate-spin" : "")} />
                刷新
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="当前延迟" value={stats.currentIsTimeout ? "超时" : formatLatency(stats.currentLatency)} hint={formatDateTime(stats.lastRecordedAt)} icon={Activity} />
            <StatCard label="可用率" value={formatPercent(stats.availability)} hint={String(stats.success) + "/" + String(stats.total || 0) + " 次成功"} icon={CheckCircle2} />
            <StatCard label="P95" value={formatLatency(stats.p95)} hint="95% 探测低于该值" icon={Gauge} />
            <StatCard label="抖动" value={formatLatency(stats.jitter)} hint="相邻成功样本平均波动" icon={Waves} />
            <StatCard label="超时率" value={formatPercent(stats.timeoutRate)} hint={String(stats.timeout) + " 次超时"} icon={TimerReset} />
            <StatCard label="连续异常" value={String(stats.consecutiveFailures)} hint={stats.lastFailureAt ? "最近 " + formatDateTime(stats.lastFailureAt) : "暂无异常"} icon={AlertTriangle} />
          </div>

          <div className="rounded-xl border border-border/45 bg-card/45 p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">延迟趋势</div>
                <div className="mt-0.5 text-xs text-muted-foreground">只读取历史探测样本；超时点不会伪造成 0 ms。</div>
              </div>
              <span className="text-xs text-muted-foreground">{stats.total} 个样本</span>
            </div>
            <div className="h-64 w-full text-primary">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ left: -12, right: 8, top: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.22} vertical={false} />
                    <XAxis dataKey="label" minTickGap={36} tick={{ fontSize: 10 }} />
                    <YAxis width={48} tick={{ fontSize: 10 }} unit="ms" />
                    <RechartsTooltip
                      contentStyle={{ borderRadius: 8 }}
                      formatter={(value: any) => [value == null ? "超时" : String(value) + " ms", "延迟"]}
                      labelFormatter={(label) => String(label)}
                    />
                    <Area type="monotone" dataKey="latency" stroke="currentColor" fill="currentColor" fillOpacity={0.08} connectNulls={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border/50 text-sm text-muted-foreground">
                  当前时间范围暂无历史探测数据
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatCard label="最低延迟" value={formatLatency(stats.min)} icon={Activity} />
            <StatCard label="平均延迟" value={formatLatency(stats.average)} icon={Gauge} />
            <StatCard label="P50" value={formatLatency(stats.p50)} icon={Clock3} />
            <StatCard label="最高延迟" value={formatLatency(stats.max)} icon={AlertTriangle} />
          </div>

          <div className="rounded-lg border border-border/45 bg-muted/15 px-3 py-2.5 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>统计窗口：近 {rangeHours === 1 ? "1 小时" : rangeHours === 24 ? "24 小时" : "7 天"}</span>
              <span>成功：{stats.success}</span>
              <span>超时：{stats.timeout}</span>
              <span>最近异常：{formatDateTime(stats.lastFailureAt)}</span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
