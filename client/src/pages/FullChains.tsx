import { useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { LandingManagement } from "@/components/LandingManagement";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SortableDragHandle,
  SortableItem,
  SortableReorderContext,
  useSortableReorder,
} from "@/components/SortableDragHandle";
import {
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Route,
  Shuffle,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";

type Host = { id: number; name: string; ip: string; isLanding: boolean };
type Node = { hostId: number; ingressIp: string };
type PortCheck = { available: boolean | null; message: string } | null;
const busy = new Set(["checking-link", "checking-port", "checking-protocol", "deploying"]);
const normal = ["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"];
const ss2022 = [
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
];

function StatusBadge({ status, available, checking, unavailable, message }: {
  status: string; available: string; checking: string; unavailable: string; message?: string;
}) {
  const kind = status === "available" ? "ok" : status === "checking" ? "busy" : status === "error" ? "error" : "idle";
  const text = kind === "ok" ? available : kind === "busy" ? checking : kind === "error" ? unavailable : "待检查";
  return (
    <span
      key={status}
      title={kind === "error" ? message : undefined}
      className={`inline-flex animate-in fade-in-0 zoom-in-95 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium duration-200 motion-reduce:animate-none ${kind === "error" ? "border-destructive/50 bg-destructive/5 text-destructive" : kind === "idle" ? "border-muted-foreground/30 text-muted-foreground" : "border-emerald-500/50 bg-emerald-500/5 text-emerald-600"}`}
    >
      {kind === "busy" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : kind === "ok" ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : kind === "error" ? (
        <XCircle className="h-3.5 w-3.5" />
      ) : null}
      {text}
    </span>
  );
}

function Status({ node, protocol }: { node: any; protocol?: string }) {
  if (["checking", "done", "error"].includes(node.deployStatus))
    return <StatusBadge status={node.deployStatus === "done" ? "available" : node.deployStatus} available="已创建" checking="创建中" unavailable="创建失败" message={node.deployMessage} />;
  return <div className="flex items-center gap-2">
    <StatusBadge status={node.portStatus} available="端口可用" checking="检查端口中" unavailable="端口不可用" message={node.portMessage} />
    {protocol === "both" && <StatusBadge status={node.protocolStatus} available="UDP 可用" checking="检查 UDP 中" unavailable="UDP 不可用" message={node.protocolMessage} />}
  </div>;
}

function ChainNodes({
  nodes,
  hosts,
  disabled,
  setNodes,
  runtime,
  fixedLast = false,
  protocol,
}: {
  nodes: any[];
  hosts: Map<number, Host>;
  disabled?: boolean;
  setNodes?: (next: Node[]) => void;
  runtime?: boolean;
  fixedLast?: boolean;
  protocol?: string;
}) {
  const sortable = useSortableReorder({
    items: nodes,
    getId: (node) => node.hostId,
    disabled: !!disabled || !setNodes,
    onReorder: (items) => {
      const exit = fixedLast ? nodes.at(-1) : undefined;
      setNodes?.(
        exit
          ? [
              ...(items as Node[]).filter(
                (node) => node.hostId !== exit.hostId,
              ),
              exit,
            ]
          : (items as Node[]),
      );
    },
  });
  return (
    <SortableReorderContext
      sortable={sortable}
      strategy="vertical"
      restrictToList
    >
      {nodes.map((node: any, index: number) => (
        <div key={node.id ?? node.hostId}>
          <SortableItem
            id={node.hostId}
            disabled={
              !!disabled ||
              !setNodes ||
              (fixedLast && index === nodes.length - 1)
            }
          >
            {({ itemProps, handleProps }) => (
              <div
                {...itemProps}
                className="flex min-h-14 items-center gap-3 rounded-lg border bg-card px-3"
              >
                <SortableDragHandle
                  dragHandleProps={handleProps}
                  visible={
                    !!setNodes &&
                    !disabled &&
                    !(fixedLast && index === nodes.length - 1)
                  }
                />
                <span className="w-5 text-center text-xs text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {node.hostName || hosts.get(Number(node.hostId))?.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {node.ingressIp ||
                      node.publicIp ||
                      hosts.get(Number(node.hostId))?.ip}
                  </div>
                </div>
                {(setNodes || runtime) && (
                  <span
                    className={`rounded-full border px-2 py-1 text-xs font-medium ${index === nodes.length - 1 ? "border-cyan-400/50 bg-cyan-500/10 text-cyan-600" : index === 0 ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-600" : "border-amber-400/50 bg-amber-500/10 text-amber-600"}`}
                  >
                    {index === nodes.length - 1
                      ? "出口"
                      : index === 0
                        ? "入口"
                        : "中转"}
                  </span>
                )}
                {setNodes && (
                  <div className="flex items-center gap-1">
                    <Button
                      disabled={
                        disabled ||
                        index === 0 ||
                        (fixedLast && index === nodes.length - 1)
                      }
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        setNodes(
                          nodes.map((item, i, all) =>
                            i === index
                              ? all[i - 1]
                              : i === index - 1
                                ? all[index]
                                : item,
                          ),
                        )
                      }
                    >
                      ↑
                    </Button>
                    <Button
                      disabled={
                        disabled ||
                        index === nodes.length - 1 ||
                        (fixedLast && index === nodes.length - 1)
                      }
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        setNodes(
                          nodes.map((item, i, all) =>
                            i === index
                              ? all[i + 1]
                              : i === index + 1
                                ? all[index]
                                : item,
                          ),
                        )
                      }
                    >
                      ↓
                    </Button>
                    <Button
                      disabled={
                        disabled ||
                        index === nodes.length - 1 ||
                        (fixedLast && index === nodes.length - 1)
                      }
                      size="icon"
                      variant="ghost"
                      onClick={() =>
                        setNodes(
                          nodes.filter((_: Node, i: number) => i !== index),
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                {runtime && <Status node={node} protocol={protocol} />}
              </div>
            )}
          </SortableItem>
          {index < nodes.length - 1 && (
            <div className="flex h-8 items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="h-3 border-l border-dashed" />
              <span>
                下一跳延迟：
                {node.latencyMs ? (
                  `${node.latencyMs} ms`
                ) : node.latencyStatus === "checking" ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="inline h-3 w-3 animate-spin" />
                    检测中…
                  </span>
                ) : node.latencyStatus === "error" ? (
                  "检测失败"
                ) : (
                  "待检测"
                )}
              </span>
              <span className="h-3 border-l border-dashed" />
            </div>
          )}
        </div>
      ))}
    </SortableReorderContext>
  );
}

function CreateDialog({
  open,
  close,
  chains,
}: {
  open: boolean;
  close: () => void;
  chains: any[];
}) {
  const utils = trpc.useUtils();
  const hostsQuery = trpc.fullChains.hosts.useQuery(undefined, {
    enabled: open,
  });
  const random = trpc.fullChains.random.useQuery(undefined, { enabled: open });
  const create = trpc.fullChains.create.useMutation();
  const check = trpc.fullChains.check.useMutation();
  const checkLatency = trpc.fullChains.checkLatency.useMutation();
  const deploy = trpc.fullChains.deploy.useMutation();
  const [id, setId] = useState<number | undefined>(undefined);
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [protocol, setProtocol] = useState("both");
  const [type, setType] = useState("ss");
  const [method, setMethod] = useState(normal[1]);
  const [password, setPassword] = useState("");
  const [entryIp, setEntryIp] = useState("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const [landingHostId, setLandingHostId] = useState(0);
  const [portCheck, setPortCheck] = useState<PortCheck>(null);
  const createdDraft = useRef<number | undefined>(undefined);
  const remove = trpc.fullChains.remove.useMutation();
  const hosts = useMemo(
    () =>
      new Map<number, Host>(
        (hostsQuery.data || []).map((host: Host) => [host.id, host]),
      ),
    [hostsQuery.data],
  );
  const active = chains.find((item: any) => item.id === id);
  const locked = !!active && busy.has(active.status);
  const last = hosts.get(nodes.at(-1)?.hostId || 0);
  const discardCheckedDraft = () => {
    const draftId = createdDraft.current;
    if (!draftId) return;
    createdDraft.current = undefined;
    setId(undefined);
    void remove
      .mutateAsync({ id: draftId })
      .then(() => utils.fullChains.list.invalidate());
  };
  const changePort = (value: string) => {
    if (value !== port) discardCheckedDraft();
    setPort(value);
    setPortCheck(null);
  };
  const randomPort = async () => {
    const result = (await random.refetch()).data;
    if (result) changePort(String(result.port));
  };
  const randomPassword = async () => {
    const result = (await random.refetch()).data;
    if (result) setPassword(result.password);
  };
  const add = (value: string) => {
    const host = hosts.get(Number(value));
    if (!host || host.isLanding) return;
    setNodes((old) => {
      const exit = old.find((node) => node.hostId === landingHostId);
      return [
        ...old.filter(
          (node) => node.hostId !== host.id && node.hostId !== landingHostId,
        ),
        { hostId: host.id, ingressIp: "" },
        ...(exit ? [exit] : []),
      ];
    });
  };
  const selectLandingHost = (value: string) => {
    const hostId = Number(value);
    setLandingHostId(hostId);
    setNodes((old) => [
      ...old.filter(
        (node) => node.hostId !== hostId && node.hostId !== landingHostId,
      ),
      { hostId, ingressIp: "" },
    ]);
    setPortCheck(null);
  };
  const valid =
    nodes.length >= 2 &&
    !!last?.isLanding &&
    Number(port) >= 1 &&
    Number(port) <= 65535 &&
    password.length >= 8;
  const save = async () => {
    if (!valid)
      throw new Error("至少两台机器，末端必须是落地机，并填写有效端口和密码");
    const result = await create.mutateAsync({
      name: name.trim() || `全链路-${port}`,
      port: Number(port),
      protocol: protocol as "tcp" | "both",
      ssProtocol: type as "ss" | "ss2022",
      method: method as any,
      password,
      allowPublicIntermediate: true,
      nodes,
    });
    setId(result.id);
    createdDraft.current = result.id;
    return result.id;
  };
  const closeDialog = () => {
    const draftId = createdDraft.current;
    createdDraft.current = undefined;
    setId(undefined);
    setName("");
    setPort("");
    setPassword("");
    setEntryIp("");
    setNodes([]);
    setLandingHostId(0);
    setPortCheck(null);
    close();
    if (draftId)
      void remove
        .mutateAsync({ id: draftId })
        .then(() => utils.fullChains.list.invalidate());
  };
  useEffect(() => {
    if (
      !open ||
      active ||
      !last?.isLanding ||
      Number(port) < 1 ||
      Number(port) > 65535
    )
      return;
    const timer = window.setTimeout(
      () =>
        void (async () => {
          setPortCheck({ available: null, message: "检测中" });
          try {
            const result = await utils.landing.checkPort.fetch({
              hostId: last.id,
              port: Number(port),
            });
            if (result.complete) {
              setPortCheck({
                available: result.available,
                message: result.available ? "端口可用" : "端口不可用",
              });
              return;
            }
            for (let i = 0; i < 20; i++) {
              await new Promise((resolve) => window.setTimeout(resolve, 500));
              const next = await utils.landing.portCheckStatus.fetch({
                checkId: result.checkId!,
              });
              if (next.complete) {
                setPortCheck({
                  available: next.available,
                  message: next.available ? "端口可用" : "端口不可用",
                });
                return;
              }
            }
            setPortCheck({ available: false, message: "端口不可用" });
          } catch {
            setPortCheck({ available: false, message: "端口不可用" });
          }
        })(),
      450,
    );
    return () => window.clearTimeout(timer);
  }, [
    open,
    active,
    last?.id,
    last?.isLanding,
    port,
    utils.landing.checkPort,
    utils.landing.portCheckStatus,
  ]);
  const ensureDraft = async () => id || save();
  const run = async (kind: "port" | "latency" | "deploy") => {
    try {
      const chainId = kind === "deploy" ? id : await ensureDraft();
      if (!chainId) return;
      if (kind === "port") await check.mutateAsync({ id: chainId });
      if (kind === "latency") await checkLatency.mutateAsync({ id: chainId });
      if (kind === "deploy") {
        await deploy.mutateAsync({ id: chainId });
        createdDraft.current = undefined;
        closeDialog();
      }
      await utils.fullChains.list.invalidate();
    } catch (error: any) {
      toast.error(error.message);
    }
  };
  const configReady = valid && portCheck?.available !== false;
  const primary =
    active?.status === "ready-to-deploy"
      ? "创建链路"
      : active?.status === "running"
        ? "已创建"
        : !active || active.status === "draft" || active.status === "error"
          ? "检查链路"
          : active.statusMessage || "检查链路中";
  const primaryAction =
    active?.status === "ready-to-deploy"
      ? "deploy"
      : "port";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !locked && closeDialog()}
    >
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>新建全链路</DialogTitle>
          <DialogDescription>
            先完成检查，再确认部署。入口在首位，末端为公网直连落地 SS。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6 py-4">
          <>
            <div className="order-0 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
              <Label>使用落地机</Label>
              <Select
                value={landingHostId ? String(landingHostId) : ""}
                onValueChange={selectLandingHost}
              >
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="请选择落地机" />
                </SelectTrigger>
                <SelectContent>
                  {(hostsQuery.data || [])
                    .filter((host: Host) => host.isLanding)
                    .map((host: Host) => (
                      <SelectItem key={host.id} value={String(host.id)}>
                        {host.name} · {host.ip}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="order-1 grid grid-cols-3 gap-3">
              <div className="min-w-0 space-y-1.5">
                <Label>链路名称</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="HK → JP 落地"
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label>端口</Label>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Input
                      type="number"
                      className={
                        portCheck?.available === false
                          ? "border-destructive pr-16"
                          : portCheck?.available === true
                            ? "border-emerald-500 pr-14"
                            : "pr-16"
                      }
                      value={port}
                      disabled={locked || active?.status === "running"}
                      onChange={(e) => changePort(e.target.value)}
                    />
                    {portCheck && (
                      <span
                        className={`absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-medium ${portCheck.available === false ? "text-destructive" : portCheck.available ? "text-emerald-600" : "text-muted-foreground"}`}
                      >
                        {portCheck.message}
                      </span>
                    )}
                  </div>
                  <Button
                    size="icon"
                    variant="outline"
                    disabled={locked || active?.status === "running"}
                    onClick={() => void randomPort()}
                  >
                    <Shuffle className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label>协议</Label>
                <Select value={protocol} onValueChange={setProtocol}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">TCP + UDP</SelectItem>
                    <SelectItem value="tcp">TCP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="order-2 grid grid-cols-12 gap-3">
              <div className="col-span-3 min-w-0 space-y-1.5">
                <Label>SS 类型</Label>
                <Select
                  value={type}
                  onValueChange={(value) => {
                    setType(value);
                    setMethod(value === "ss" ? normal[1] : ss2022[0]);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ss">SS</SelectItem>
                    <SelectItem value="ss2022">SS2022</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-4 min-w-0 space-y-1.5">
                <Label>加密方式</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(type === "ss" ? normal : ss2022).map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-5 min-w-0 space-y-1.5">
                <Label>密码</Label>
                <div className="flex gap-2">
                  <Input
                    className={password.length < 8 ? "border-destructive" : undefined}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => void randomPassword()}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="order-3 space-y-1.5">
              <Label>入口 IP</Label>
              <Input
                value={entryIp}
                placeholder="默认使用入口机公网 IP"
                onChange={(event) => {
                  const value = event.target.value;
                  setEntryIp(value);
                  setNodes((old) =>
                    old.map((node, index) =>
                      index === 0 ? { ...node, ingressIp: value } : node,
                    ),
                  );
                }}
              />
            </div>
            <div className="order-4 flex items-center justify-between border-t pt-3">
              <Label>链路主机顺序</Label>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={locked || checkLatency.isPending || !valid}
                  onClick={() => void run("latency")}
                >
                  {checkLatency.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  检查延迟
                </Button>
                <Select value="" onValueChange={add}>
                  <SelectTrigger className="h-8 w-52">
                    <SelectValue placeholder="添加机器" />
                  </SelectTrigger>
                  <SelectContent>
                    {(hostsQuery.data || [])
                      .filter(
                        (host: Host) =>
                          host.id !== landingHostId &&
                          !host.isLanding &&
                          !nodes.some((node) => node.hostId === host.id),
                      )
                      .map((host: Host) => (
                        <SelectItem key={host.id} value={String(host.id)}>
                          {host.name} · {host.ip}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="order-5 rounded-lg border p-2">
              <ChainNodes
                nodes={active?.nodes || nodes}
                hosts={hosts}
                setNodes={setNodes}
                disabled={!!active || locked}
                runtime
                fixedLast
                protocol={active?.protocol || protocol}
              />
            </div>
          </>
          {active && (
            <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
              {active.statusMessage || active.status}
            </div>
          )}
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" disabled={locked} onClick={closeDialog}>
            取消
          </Button>
          <Button
            disabled={
              locked ||
              create.isPending ||
              check.isPending ||
              deploy.isPending ||
              !configReady ||
              (!!active &&
                !["draft", "error", "ready-to-deploy"].includes(
                  active.status,
                ))
            }
            onClick={() => void run(primaryAction)}
          >
            {(create.isPending || check.isPending || deploy.isPending) && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            {primary}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FullChainsPage() {
  const [open, setOpen] = useState(false);
  const confirmDialog = useConfirmDialog();
  const utils = trpc.useUtils();
  const chains = trpc.fullChains.list.useQuery(undefined, {
    refetchInterval: 1500,
  });
  const services = trpc.landing.list.useQuery(undefined, { refetchInterval: 5000 });
  const remove = trpc.fullChains.remove.useMutation({
    onSuccess: () => void utils.fullChains.list.invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const data = (chains.data || []).filter((chain: any) =>
    ["deploying", "running", "cancelled", "error"].includes(
      String(chain.status),
    ),
  );
  return (
    <DashboardLayout>
      <div className="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">全链路</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              独立部署多跳转发，末端自动生成公网直连 SS。
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            新建全链路
          </Button>
        </div>
        <LandingManagement
          viewMode="compact"
          serviceIds={data.map((chain: any) => Number(chain.landingServiceId)).filter(Boolean)}
          showServices={false}
        />
        {data.length ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.map((chain: any) => {
              const service = (services.data || []).find((item: any) => Number(item.id) === Number(chain.landingServiceId));
              const removeChain = async () => {
                if (await confirmDialog({ title: "删除全链路", description: <>确定删除“{chain.name}”吗？会停止链路和末端 SS 并清理对应端口。</>, confirmText: "删除", tone: "destructive" })) remove.mutate({ id: chain.id });
              };
              return service ? <LandingManagement key={chain.id} viewMode="compact" serviceId={Number(chain.landingServiceId)} showTraffic={false} onRemove={() => void removeChain()} /> : <Card key={chain.id}><CardContent className="p-4 text-sm text-muted-foreground">{chain.name}：部署信息加载中</CardContent></Card>;
            })}
          </div>
        ) : (
          <Card className="border-dashed">
            <CardContent className="grid min-h-64 place-items-center text-center">
              <div>
                <Route className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                <div className="font-medium">还没有全链路</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  先检查，再部署。
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        <CreateDialog
          key={open ? "open" : "closed"}
          open={open}
          close={() => setOpen(false)}
          chains={chains.data || []}
        />
      </div>
    </DashboardLayout>
  );
}
