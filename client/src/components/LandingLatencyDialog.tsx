import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LatencyStabilityStats } from "@/components/LatencyStabilityStats";
import { LatencyPeakCutToggle } from "@/components/LatencyPeakCutToggle";
import { DEFAULT_LATENCY_TIME_RANGE_HOURS, filterLatencySeriesByTimeRange, latencyTimeRangeLabel, LatencyTimeRangeSelect, type LatencyTimeRangeHours } from "@/components/LatencyTimeRangeSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { applyLatencyPeakCut, clipLatencyForChart, getLatencyStabilityStats, getLatencyYAxisMax, getLatencyYAxisTicks } from "@/lib/latencyChart";
import { trpc } from "@/lib/trpc";

type Datum = { recordedAt: string | Date; latencyMs?: number | null; isTimeout?: boolean | null };
type ChartPoint = { label: string; fullLabel: string; latency: number; latencyMs: number; chartLatency: number; isTimeout: boolean };

function formatTime(value: string | Date) {
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function LandingTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as ChartPoint | undefined;
  if (!point) return null;
  return <div className="pointer-events-none rounded-lg border border-border bg-card px-3 py-2 shadow-md"><p className="mb-1 text-xs text-muted-foreground">{point.fullLabel}</p><p className={point.isTimeout ? "text-sm font-semibold text-destructive" : "text-sm font-semibold tabular-nums text-emerald-600"}>{point.isTimeout ? "超时" : `${point.latencyMs} ms`}</p></div>;
}

export function LandingLatencyDialog({ open, onOpenChange, service }: { open: boolean; onOpenChange: (open: boolean) => void; service: any | null }) {
  const [timeRangeHours, setTimeRangeHours] = useState<LatencyTimeRangeHours>(DEFAULT_LATENCY_TIME_RANGE_HOURS);
  const [peakCutEnabled, setPeakCutEnabled] = useState(false);
  const serviceId = Number(service?.id || 0);
  const { data, isLoading } = trpc.landing.latencySeries.useQuery({ id: serviceId, hours: 72 }, { enabled: open && serviceId > 0, refetchInterval: open ? 10_000 : false });
  const ranged = useMemo(() => filterLatencySeriesByTimeRange((data || []) as Datum[], timeRangeHours), [data, timeRangeHours]);
  const rawChart = useMemo<ChartPoint[]>(() => ranged.map((item) => ({ label: formatTime(item.recordedAt), fullLabel: formatTime(item.recordedAt), latency: item.isTimeout ? 0 : Number(item.latencyMs || 0), latencyMs: item.isTimeout ? 0 : Number(item.latencyMs || 0), chartLatency: item.isTimeout ? 0 : clipLatencyForChart(Number(item.latencyMs || 0)), isTimeout: !!item.isTimeout })), [ranged]);
  const chart = useMemo(() => peakCutEnabled ? applyLatencyPeakCut(rawChart, [{ dataKey: "latencyMs", timeoutKey: "isTimeout" }, { dataKey: "chartLatency", timeoutKey: "isTimeout" }]) as ChartPoint[] : rawChart, [peakCutEnabled, rawChart]);
  const yMax = useMemo(() => getLatencyYAxisMax(Math.max(0, ...chart.map((item) => item.chartLatency)), 120), [chart]);
  const stats = useMemo(() => getLatencyStabilityStats(chart), [chart]);
  const [animated, setAnimated] = useState(false);
  useEffect(() => { if (open && chart.length) setAnimated(true); }, [open, chart.length]);

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[96svh] w-[calc(100vw-0.75rem)] max-w-[95vw] flex-col gap-3 overflow-hidden p-3 sm:max-w-3xl sm:p-6"><DialogHeader><div className="flex flex-col gap-2 pr-9 sm:flex-row sm:items-start sm:justify-between sm:pr-10"><div className="min-w-0"><DialogTitle className="truncate text-base sm:text-lg">落地 SS 延迟（TCPing）- {service?.name || ""}</DialogTitle><DialogDescription>探测目标：{service?.latencyTargetHost || "-"}:{service?.latencyTargetPort || "-"} · 最近 {latencyTimeRangeLabel(timeRangeHours)}</DialogDescription></div><div className="flex flex-wrap items-center gap-2 self-start"><LatencyTimeRangeSelect value={timeRangeHours} onChange={setTimeRangeHours} /><LatencyPeakCutToggle id={`landing-peak-cut-${serviceId || "current"}`} checked={peakCutEnabled} onCheckedChange={setPeakCutEnabled} /></div></div></DialogHeader><div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1"><div className="h-[42svh] min-h-[220px] w-full sm:h-72">{isLoading ? <Skeleton className="h-full w-full" /> : chart.length === 0 ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无 TCPing 延迟记录</div> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={chart} margin={{ top: 8, right: 10, left: -8, bottom: 0 }}><defs><linearGradient id="landingTcpingGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.3} /><stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.02} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" /><XAxis dataKey="label" tick={{ fontSize: 9 }} minTickGap={48} interval="preserveStartEnd" /><YAxis tick={{ fontSize: 9 }} tickFormatter={(value) => `${value}ms`} width={44} domain={[0, yMax]} ticks={getLatencyYAxisTicks(yMax)} allowDecimals={false} /><Tooltip content={<LandingTooltip />} cursor={{ stroke: "var(--color-muted-foreground)", strokeDasharray: "3 3" }} wrapperStyle={{ pointerEvents: "none" }} /><Area type="monotone" dataKey="chartLatency" stroke="var(--color-chart-2)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="url(#landingTcpingGradient)" dot={false} activeDot={{ r: 4 }} isAnimationActive={animated} animationDuration={500} /></AreaChart></ResponsiveContainer>}</div><LatencyStabilityStats stats={stats} /></div></DialogContent></Dialog>;
}
