import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Play,
  RefreshCw,
  ScanSearch,
  Server,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { pollingInterval } from "@/lib/polling";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type DiagnosticScope = "rule" | "tunnel" | "chain" | "full-chain";

export type DiagnosticTarget = {
  scope: DiagnosticScope;
  id: number;
  name: string;
};

type CheckStatus = "pass" | "warn" | "fail" | "skip";

function statusMeta(status: CheckStatus) {
  if (status === "pass") {
    return {
      label: "正常",
      icon: CheckCircle2,
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    };
  }
  if (status === "warn") {
    return {
      label: "警告",
      icon: AlertTriangle,
      className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
    };
  }
  if (status === "fail") {
    return {
      label: "失败",
      icon: XCircle,
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    };
  }
  return {
    label: "跳过",
    icon: CircleDashed,
    className: "border-border/60 bg-muted/30 text-muted-foreground",
  };
}

function CheckRow({ item }: { item: any }) {
  const meta = statusMeta(item.status as CheckStatus);
  const Icon = meta.icon;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/45 bg-card/45 px-3 py-2.5">
      <Icon className={"mt-0.5 h-4 w-4 shrink-0 " + (item.status === "pass" ? "text-emerald-500" : item.status === "warn" ? "text-amber-500" : item.status === "fail" ? "text-destructive" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">{item.label}</div>
          <Badge variant="outline" className={"h-5 text-[10px] " + meta.className}>{meta.label}</Badge>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{item.message}</div>
        {item.detail ? <div className="mt-1 break-all text-[11px] text-muted-foreground/80">{item.detail}</div> : null}
      </div>
    </div>
  );
}

function roleLabel(role: string) {
  if (role === "entry") return "入口";
  if (role === "relay") return "中转";
  if (role === "landing") return "落地";
  return "目标";
}

function ProbeRow({ row, index }: { row: any; index: number }) {
  let parsed: any = null;
  try { parsed = JSON.parse(String(row?.message || "")); } catch {}
  const status = String(row?.status || "pending");
  const pending = status === "pending" || status === "running";
  const success = status === "success";
  const label = row?.routeLabel || parsed?.routeLabel || row?.hopLabel || parsed?.hopLabel || "第 " + (index + 1) + " 跳";
  const detail = parsed?.detail || (!parsed ? String(row?.message || "") : "");
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/45 bg-card/45 px-3 py-2.5">
      {pending ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
      ) : success ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{label}</span>
          <span className={success ? "text-xs font-semibold tabular-nums text-emerald-600" : pending ? "text-xs text-primary" : "text-xs font-medium text-destructive"}>
            {pending ? "探测中" : success && row?.latencyMs != null ? String(row.latencyMs) + " ms" : success ? "可达" : "失败"}
          </span>
        </div>
        {detail ? <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div> : null}
        {parsed?.resolvedTargetIp ? <div className="mt-1 text-[11px] text-muted-foreground">解析到 {parsed.resolvedTargetIp}</div> : null}
      </div>
    </div>
  );
}

export function DiagnosticDialog({
  target,
  open,
  onOpenChange,
}: {
  target: DiagnosticTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [testIds, setTestIds] = useState<number[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!open) {
      setTestIds([]);
      setStartedAt(null);
    }
  }, [open, target?.scope, target?.id]);

  const planQuery = trpc.diagnostics.plan.useQuery(
    { scope: target?.scope || "rule", id: Number(target?.id || 0) },
    {
      enabled: open && !!target?.id,
      refetchOnWindowFocus: false,
    },
  );

  const statusQuery = trpc.diagnostics.status.useQuery(
    { testIds: testIds.length ? testIds : [1] },
    {
      enabled: open && testIds.length > 0,
      refetchInterval: pollingInterval("interactive", open && testIds.length > 0),
      refetchOnWindowFocus: false,
    },
  );

  const startMutation = trpc.diagnostics.start.useMutation({
    onSuccess: (data) => {
      setTestIds((data?.testIds || []).map(Number).filter((id) => id > 0));
      setStartedAt(Date.now());
      void utils.diagnostics.plan.invalidate();
    },
  });

  const rows = statusQuery.data || [];
  const livePending = testIds.length > 0 && (rows.length < testIds.length || rows.some((row: any) => ["pending", "running"].includes(String(row.status))));
  const liveFailed = rows.filter((row: any) => ["failed", "timeout"].includes(String(row.status)));
  const livePassed = rows.filter((row: any) => String(row.status) === "success");

  const preflight = planQuery.data?.summary;
  const overall = useMemo(() => {
    if (preflight?.failed || liveFailed.length > 0) return "fail" as const;
    if (preflight?.warnings) return "warn" as const;
    if (testIds.length > 0 && !livePending && livePassed.length === testIds.length) return "pass" as const;
    return preflight?.status || "warn";
  }, [liveFailed.length, livePassed.length, livePending, preflight, testIds.length]);

  const failure = liveFailed[0];
  let failureMeta: any = null;
  try { failureMeta = failure ? JSON.parse(String((failure as any).message || "")) : null; } catch {}

  const duration = startedAt && !livePending && testIds.length > 0
    ? Math.max(0, (Date.now() - startedAt) / 1000)
    : null;

  const overallMeta = statusMeta(overall);
  const OverallIcon = overallMeta.icon;

  const run = () => {
    if (!target) return;
    startMutation.mutate({ scope: target.scope, id: target.id });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] max-w-[95vw] flex-col overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b border-border/50 px-4 pb-3 pt-4 pr-12 sm:px-5">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <ScanSearch className="h-5 w-5 shrink-0 text-primary" />
            <span className="truncate">一键诊断 · {target?.name || planQuery.data?.title || "链路"}</span>
          </DialogTitle>
          <DialogDescription>
            配置与 Agent 状态检查 + 独立实时探测。诊断探测不会修改规则、不会切链、不会重下发运行配置。
          </DialogDescription>
        </DialogHeader>

        <div className="dialog-scroll-area min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <div className="rounded-lg border border-border/45 bg-card/55 p-3">
              <div className="text-xs text-muted-foreground">诊断状态</div>
              <div className="mt-2 flex items-center gap-1.5">
                <OverallIcon className="h-4 w-4" />
                <span className="font-semibold">{livePending ? "诊断中" : overallMeta.label}</span>
              </div>
            </div>
            <div className="rounded-lg border border-border/45 bg-card/55 p-3">
              <div className="text-xs text-muted-foreground">配置通过</div>
              <div className="mt-1 text-xl font-semibold">{preflight?.passed ?? 0}</div>
            </div>
            <div className="rounded-lg border border-border/45 bg-card/55 p-3">
              <div className="text-xs text-muted-foreground">警告</div>
              <div className="mt-1 text-xl font-semibold">{preflight?.warnings ?? 0}</div>
            </div>
            <div className="rounded-lg border border-border/45 bg-card/55 p-3">
              <div className="text-xs text-muted-foreground">实时通过</div>
              <div className="mt-1 text-xl font-semibold">{livePassed.length}/{testIds.length || "—"}</div>
            </div>
            <div className="rounded-lg border border-border/45 bg-card/55 p-3">
              <div className="text-xs text-muted-foreground">耗时</div>
              <div className="mt-1 text-xl font-semibold">{duration == null ? "—" : duration.toFixed(1) + "s"}</div>
            </div>
          </div>

          {failure ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
                <AlertTriangle className="h-4 w-4" />
                疑似故障点
              </div>
              <div className="mt-1 text-sm">{failureMeta?.routeLabel || (failure as any).routeLabel || "实时探测失败"}</div>
              {failureMeta?.detail ? <div className="mt-1 text-xs text-muted-foreground">{failureMeta.detail}</div> : null}
            </div>
          ) : null}

          <div className="rounded-xl border border-border/45 bg-card/35 p-3">
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">基础检查</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {(planQuery.data?.checks || []).map((item: any) => <CheckRow key={item.key} item={item} />)}
              {planQuery.isLoading ? (
                <div className="col-span-full flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />正在读取配置与 Agent 状态
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-border/45 bg-card/35 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">实时逐跳探测</span>
              </div>
              {testIds.length > 0 ? <span className="text-xs text-muted-foreground">{livePassed.length + liveFailed.length}/{testIds.length} 已完成</span> : null}
            </div>
            {testIds.length === 0 ? (
              <div className="flex min-h-28 flex-col items-center justify-center rounded-lg border border-dashed border-border/50 text-center">
                <Server className="h-6 w-6 text-muted-foreground" />
                <div className="mt-2 text-sm font-medium">尚未执行实时探测</div>
                <div className="mt-1 text-xs text-muted-foreground">点击“开始诊断”后，各源 Agent 只执行 TCP/Ping 探测，不刷新运行配置。</div>
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((row: any, index: number) => <ProbeRow key={row.id} row={row} index={index} />)}
                {rows.length < testIds.length ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    等待 Agent 领取剩余探测任务…
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border/45 bg-card/35 p-3">
            <div className="mb-3 text-sm font-semibold">诊断路径</div>
            <div className="flex flex-wrap items-center gap-2">
              {(planQuery.data?.nodes || []).map((node: any, index: number) => (
                <div key={String(node.hostId) + "-" + index} className="flex items-center gap-2">
                  {index > 0 ? <span className="text-muted-foreground">→</span> : null}
                  <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <span className={node.online === false ? "h-2 w-2 rounded-full bg-destructive" : "h-2 w-2 rounded-full bg-emerald-500"} />
                      {node.name}
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{roleLabel(node.role)}{node.address ? " · " + node.address : ""}</div>
                  </div>
                </div>
              ))}
              {planQuery.data?.target ? (
                <>
                  <span className="text-muted-foreground">→</span>
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                    {planQuery.data.target}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border/50 px-4 py-3 sm:px-5">
          <Button variant="outline" onClick={() => void Promise.all([planQuery.refetch(), testIds.length ? statusQuery.refetch() : Promise.resolve()])}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          <Button onClick={run} disabled={!target || startMutation.isPending || livePending || !!planQuery.data?.summary?.failed}>
            {startMutation.isPending || livePending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {livePending ? "诊断中..." : testIds.length ? "重新诊断" : "开始诊断"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
