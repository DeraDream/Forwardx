import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export type TopologyDensity = "compact" | "standard" | "detailed";
export const topologyCardSize = (density: TopologyDensity) => density === "compact"
  ? { width: 196, height: 82 }
  : density === "detailed" ? { width: 244, height: 146 } : { width: 218, height: 110 };

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
  return <div
    role="button" tabIndex={0} aria-label={`选择经过 ${node.label} 的路径`}
    onClick={(event) => onSelect(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(event.currentTarget); } }}
    onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
    style={{ width, height, borderColor: highlighted || selected ? color : undefined }}
    className={cn("relative overflow-hidden rounded-xl border bg-card/95 text-foreground shadow-sm transition-[opacity,box-shadow,border-color] duration-150", (highlighted || selected) && "z-10 shadow-md ring-2 ring-primary/30", dimmed && "opacity-25", node.online === false && "grayscale")}
  >
    <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
    <div className="flex h-full flex-col gap-1 px-2.5 py-2 pl-3.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold leading-tight">
        <span className="shrink-0">{icon}</span><span className="min-w-0 flex-1 truncate" title={node.label}>{node.label}</span>
        <span className="shrink-0 rounded px-1 py-0.5 text-[9px]" style={{ color, backgroundColor: `color-mix(in oklch, ${color} 12%, var(--card))` }}>{node.kind === "entry" ? "入口" : node.kind === "relay" ? "中转" : "落地"}</span>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", node.online === false ? "bg-destructive" : node.online === true ? "bg-emerald-500" : "bg-muted-foreground")} title={node.online === false ? "离线" : node.online === true ? "在线" : "状态未知"} />
      </div>
      <div className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={ip || "暂无 IP"}>{ip || "暂无 IP"}</span>
        {ip && <button type="button" className="shrink-0 rounded p-0.5 hover:bg-muted" title="复制节点 IP" aria-label={`复制 ${node.label} 的 IP`} onClick={(event) => { event.stopPropagation(); onCopy(); }}><Copy className="h-3 w-3" /></button>}
        {copied && <span className="shrink-0 text-emerald-600">已复制</span>}
      </div>
      {density !== "compact" && <div className="flex min-w-0 items-center gap-1.5 text-[9px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-0.5 truncate text-emerald-600"><ArrowDown className="h-2.5 w-2.5 shrink-0" />{speed(telemetry?.speedIn)}</span>
        <span className="flex min-w-0 items-center gap-0.5 truncate text-amber-600"><ArrowUp className="h-2.5 w-2.5 shrink-0" />{speed(telemetry?.speedOut)}</span>
      </div>}
      {density === "compact" && <div className="truncate text-[9px] text-muted-foreground">↓ {speed(telemetry?.speedIn)}　↑ {speed(telemetry?.speedOut)}</div>}
      {density !== "compact" && sharedCount > 1 && <div className="truncate text-[9px] text-primary">{sharedCount} 条路径经过</div>}
      {density === "detailed" && <div className="mt-auto grid grid-cols-2 gap-1 border-t border-border/50 pt-1 text-[9px] text-muted-foreground">
        <span>CPU <b className="text-foreground">{telemetry?.cpu == null ? "—" : `${Math.round(telemetry.cpu)}%`}</b></span>
        <span className="truncate" title={percent === null ? "未设置流量额度" : `${formatBytes(used!)} / ${formatBytes(limit)}`}>月流量 <b className="text-foreground">{percent === null ? "—" : `${percent}%`}</b></span>
        <span className="col-span-2 h-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></span>
      </div>}
    </div>
  </div>;
}
