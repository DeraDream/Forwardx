import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Copy, GitFork } from "lucide-react";
import { cn } from "@/lib/utils";

export type TopologyDensity = "compact" | "standard" | "detailed";
// The routing boxes must match the actual cards, so changing density never
// makes an edge pass through a card or detach from its ports.
export const topologyCardSize = (density: TopologyDensity) => density === "compact"
  ? { width: 244, height: 100 }
  : density === "detailed" ? { width: 288, height: 138 } : { width: 272, height: 106 };

export type TopologyNodeTelemetry = {
  cpu?: number | null;
  speedIn?: number | null;
  speedOut?: number | null;
  trafficUsed?: number | null;
  trafficLimit?: number | null;
};

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value, unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount < 10 && unit > 0 ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
};

export function TopologyGraphNodeCard({ node, icon, width, height, density, telemetry, sharedCount, highlighted, dimmed, selected, copied, onSelect, onHover, onCopy }: {
  node: { label: string; subtitle?: string; detail?: string; kind: "entry" | "relay" | "landing"; online?: boolean | null };
  icon: ReactNode;
  width: number;
  height: number;
  density: TopologyDensity;
  telemetry?: TopologyNodeTelemetry;
  sharedCount: number;
  highlighted: boolean;
  dimmed: boolean;
  selected: boolean;
  copied: boolean;
  onSelect: (element: HTMLElement) => void;
  onHover: (hover: boolean) => void;
  onCopy: () => void;
}) {
  const color = node.kind === "entry" ? "var(--topology-entry)" : node.kind === "relay" ? "var(--topology-relay)" : "var(--topology-landing)";
  const ip = node.subtitle || node.detail || "";
  const speed = (value: number | null | undefined) => value == null ? "—" : `${formatBytes(value)}/s`;
  const limit = Number(telemetry?.trafficLimit || 0);
  const used = telemetry?.trafficUsed;
  const percent = limit > 0 && used != null ? Math.max(0, Math.round(used / limit * 100)) : null;
  const cpu = telemetry?.cpu == null || !Number.isFinite(Number(telemetry.cpu)) ? null : Math.max(0, Math.round(Number(telemetry.cpu)));
  return <div
    role="button" tabIndex={0} aria-label={`选择经过 ${node.label} 的路径`}
    onClick={(event) => onSelect(event.currentTarget)}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(event.currentTarget); } }}
    onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
    style={{ width, height, borderColor: highlighted || selected ? color : undefined }}
    className={cn("relative cursor-pointer select-none overflow-hidden rounded-xl border bg-card/95 text-foreground shadow-sm transition-[opacity,box-shadow,border-color] duration-150", (highlighted || selected) && "z-10 shadow-md ring-2 ring-primary/30", dimmed && "opacity-25", node.online === false && "grayscale")}
  >
    <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: node.online === false ? "var(--muted-foreground)" : color }} />
    <div className="flex h-full flex-col gap-1.5 py-2 pl-3.5 pr-2.5">
      <div className="flex min-w-0 items-center gap-1.5 leading-none">
        <span className="shrink-0 text-base">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold tracking-tight" title={node.label}>{node.label}</span>
        <span className="shrink-0 rounded border px-1 py-0.5 text-[10px] font-medium leading-none" style={{ color, borderColor: `color-mix(in oklch, ${color} 25%, var(--border))`, backgroundColor: `color-mix(in oklch, ${color} 10%, var(--card))` }}>{node.kind === "entry" ? "入口" : node.kind === "relay" ? "中转" : "落地"}</span>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", node.online === false ? "bg-muted-foreground" : node.online === true ? "bg-emerald-500" : "bg-muted-foreground/40")} title={node.online === false ? "离线" : node.online === true ? "在线" : "状态未知"} />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono" title={ip || "暂无 IP"}>{ip || "暂无 IP"}</span>
        {ip && <button type="button" className="shrink-0 rounded p-0.5 hover:bg-muted" title="复制节点 IP" aria-label={`复制 ${node.label} 的 IP`} onClick={(event) => { event.stopPropagation(); onCopy(); }}>{copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}</button>}
      </div>
      <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] leading-none">
        <span className="flex min-w-0 items-center gap-0.5 truncate text-emerald-600 dark:text-emerald-400"><ArrowDown className="h-2.5 w-2.5 shrink-0" />{speed(telemetry?.speedIn)}</span>
        <span className="flex min-w-0 items-center gap-0.5 truncate text-amber-600 dark:text-amber-400"><ArrowUp className="h-2.5 w-2.5 shrink-0" />{speed(telemetry?.speedOut)}</span>
      </div>
      <div className="flex items-center gap-1 text-[10px] leading-none text-primary" title="经过此节点的逻辑路径数，点击选择完整路径">
        <GitFork className="h-2.5 w-2.5" /><span>{sharedCount > 1 ? `${sharedCount} 条路径经过` : sharedCount === 1 ? "独立路径" : "暂无路径"}</span>
      </div>
      {density === "detailed" && <div className="mt-auto grid grid-cols-2 gap-2 border-t border-border/60 pt-1.5 text-[9px] leading-none text-muted-foreground">
        <div><div className="flex justify-between gap-1"><span>CPU</span><span className="font-mono text-foreground">{cpu === null ? "—" : `${cpu}%`}</span></div><div className="mt-1 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-indigo-500 dark:bg-sky-400" style={{ width: `${Math.min(100, cpu ?? 0)}%` }} /></div></div>
        <div title={percent === null ? "未设置流量额度" : `${formatBytes(used!)} / ${formatBytes(limit)}`}><div className="flex justify-between gap-1"><span>月流量</span><span className="font-mono text-foreground">{percent === null ? "—" : `${percent}%`}</span></div><div className="mt-1 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-violet-500 dark:bg-violet-400" style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></div></div>
      </div>}
    </div>
  </div>;
}
