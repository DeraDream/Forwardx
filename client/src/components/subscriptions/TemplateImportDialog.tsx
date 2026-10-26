import { createPortal } from "react-dom";
import { useMemo, useRef, useState } from "react";
import { Braces, CheckCircle2, CloudDownload, Code2, FileCode2, FilePlus2, Info, Link2, Loader2, PlusCircle, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOverlayContainer } from "@/components/ui/overlay-root";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Mode = "blank" | "paste" | "remote";
type Core = "clash" | "egern" | "loon";
type Props = { open: boolean; saving: boolean; onClose: () => void; onSave: (filename: string, text: string) => Promise<void>; onFetch: (url: string) => Promise<{ text: string; status: number }> };

const coreOptions: Array<{ value: Core; label: string; description: string }> = [
  { value: "clash", label: "Clash / Mihomo", description: "YAML 规范 / Meta 内核支持" },
  { value: "egern", label: "Egern", description: "iOS 体系专有语法架构" },
  { value: "loon", label: "Loon", description: "插件集成与轻量级代理" },
];

function skeleton(core: Core) {
  if (core === "loon") return "[General]\n\n[Proxy]\n\n[Proxy Group]\n\n[Rule]\n";
  if (core === "egern") return "version: 1\nproxies: []\npolicy_groups: []\nrules: []\n";
  return "mixed-port: 7890\nmode: rule\nlog-level: info\ndns:\n  enable: true\nproxies: []\nproxy-groups: []\nrules: []\n";
}

function filenameFor(core: Core) { return core === "loon" ? "loon.conf" : core === "egern" ? "egern.yaml" : "clash.yaml"; }

export function TemplateImportDialog({ open, saving, onClose, onSave, onFetch }: Props) {
  const overlay = useOverlayContainer();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("blank");
  const [core, setCore] = useState<Core>("clash");
  const [filename, setFilename] = useState("clash.yaml");
  const [code, setCode] = useState("");
  const [remoteURL, setRemoteURL] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchedStatus, setFetchedStatus] = useState<number | null>(null);
  const content = mode === "blank" ? skeleton(core) : code;
  const lineCount = Math.max(1, content.split("\n").length);
  const modeOptions: Array<{ value: Mode; label: string; icon: typeof FilePlus2 }> = [
    { value: "blank", label: "创建空白模板", icon: FilePlus2 }, { value: "paste", label: "粘贴代码", icon: Code2 }, { value: "remote", label: "从订阅导入", icon: CloudDownload },
  ];
  const canSave = filename.trim() && content.trim() && (mode !== "remote" || fetchedStatus !== null);
  const extension = filename.toLowerCase().endsWith(".conf") ? "CONF" : "YAML";

  const changeCore = (next: Core) => { setCore(next); if (!filename.trim() || filename === filenameFor(core)) setFilename(filenameFor(next)); };
  const chooseFile = async (file?: File) => { if (!file) return; try { setFilename(file.name); setCode(await file.text()); setMode("paste"); setFetchedStatus(null); } catch { toast.error("模板文件读取失败"); } };
  const fetchRemote = async () => {
    if (!remoteURL.trim()) return toast.error("请输入订阅地址");
    setFetching(true);
    try { const result = await onFetch(remoteURL.trim()); setCode(result.text); setFetchedStatus(result.status); toast.success("模板已拉取，可确认内容后创建"); }
    catch (error) { setFetchedStatus(null); toast.error(error instanceof Error ? error.message : "拉取模板失败"); }
    finally { setFetching(false); }
  };
  const formatCode = () => setCode((current) => current.replace(/\t/g, "  ").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n*$/, "\n"));
  const save = async () => { if (!filename.trim()) return toast.error("请输入模板文件名"); if (!content.trim()) return toast.error("模板内容不能为空"); if (!/\.(yaml|yml|conf|list)$/i.test(filename.trim())) return toast.error("文件名必须包含 .yaml、.yml、.conf 或 .list 扩展名"); await onSave(filename.trim(), content); };
  const preview = useMemo(() => content.split("\n").slice(0, 9).join("\n"), [content]);
  if (!open) return null;

  const dialog = <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/55 p-3 dark:bg-black/70">
    <section role="dialog" aria-modal="true" aria-label="导入模板" className="my-auto flex w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl">
      <div className="h-1 w-full bg-gradient-to-r from-transparent via-primary to-chart-1" />
      <header className="flex items-start justify-between px-6 pb-4 pt-6 sm:px-7"><div><div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-chart-1 shadow-[0_0_8px_color-mix(in_oklch,var(--chart-1)_75%,transparent)]" /><h2 className="text-[22px] font-semibold tracking-tight">创建模板</h2><Badge variant="secondary" className="font-mono text-[11px] tracking-wider">WIZARD</Badge></div><p className="mt-1.5 text-xs text-muted-foreground">创建或导入 Clash/Mihomo、Egern、Loon 模板。</p></div><Button aria-label="关闭" variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}><X className="size-[18px]" /></Button></header>
      <main className="max-h-[70vh] space-y-5 overflow-y-auto px-6 py-3 sm:px-7">
        <section className="space-y-1.5"><label className="flex items-center justify-between text-sm font-semibold">模板文件名 <span className="font-mono text-[11px] font-normal text-muted-foreground">支持 .yaml / .conf 扩展名</span></label><div className="relative"><FileCode2 className="pointer-events-none absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" /><Input value={filename} onChange={(event) => setFilename(event.target.value)} className="h-11 pl-10 pr-20 font-mono text-sm" placeholder="输入配置文件名称..." /><Badge variant="secondary" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px]">{extension}</Badge></div></section>
        <section className="space-y-1.5"><h3 className="text-sm font-semibold">创建方式</h3><div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">{modeOptions.map(({ value, label, icon: Icon }) => <button key={value} type="button" onClick={() => setMode(value)} className={cn("flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs transition-colors", mode === value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-background hover:text-foreground")}><Icon className="size-4" /><span className="hidden sm:inline">{label}</span></button>)}</div></section>
        <section className="space-y-1.5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">{mode === "blank" ? "目标内核类型" : "模板类型"}</h3><span className="font-mono text-[11px] text-muted-foreground">决定规则组语法与解析器</span></div><div className="grid grid-cols-3 gap-2">{coreOptions.map((option) => <button key={option.value} type="button" onClick={() => changeCore(option.value)} className={cn("relative rounded-lg border p-3 text-left transition-colors", core === option.value ? "border-primary/60 bg-primary/5 shadow-sm" : "border-border bg-muted/15 hover:bg-muted/35")}><div className="flex items-center justify-between gap-2"><b className="text-sm">{option.label}</b>{core === option.value && <CheckCircle2 className="size-4 text-primary" />}</div><p className="mt-1 text-[11px] text-muted-foreground">{option.description}</p></button>)}</div></section>
        {mode === "blank" && <section className="space-y-2 pt-1"><div className="flex gap-3 rounded-lg bg-muted/45 p-3.5"><Info className="mt-0.5 size-5 shrink-0 text-chart-1" /><div><p className="text-sm font-medium">会创建基础 {coreOptions.find((option) => option.value === core)?.label} 模板；之后可在可视化编辑器添加代理组。</p><p className="mt-1 text-xs text-muted-foreground">系统将自动注入通用 DNS 预设、基础路由规则占位及全局出站策略结构。</p></div></div><div className="flex items-center justify-between rounded-lg bg-muted/60 px-3.5 py-2.5 font-mono text-[11px] text-muted-foreground"><span><i className="mr-2 inline-block size-2 rounded-full bg-emerald-500" />skeleton_init: <b className="text-primary">[dns, proxies, proxy-groups, rules]</b></span><span>~{lineCount} 行默认框架</span></div></section>}
        {mode === "paste" && <section className="space-y-1.5"><div className="flex items-center justify-between"><h3 className="flex items-center gap-1.5 text-sm font-semibold"><Braces className="size-4 text-chart-1" />粘贴 {extension} 内容</h3><div className="flex gap-2 text-xs"><button type="button" onClick={() => fileRef.current?.click()} className="text-primary hover:underline"><Upload className="mr-1 inline size-3.5" />选择文件</button><button type="button" onClick={formatCode} className="text-primary hover:underline">格式化</button><button type="button" onClick={() => setCode("")} className="text-muted-foreground hover:text-destructive"><Trash2 className="mr-1 inline size-3.5" />清空</button></div></div><div className="overflow-hidden rounded-lg border border-border bg-muted/25"><div className="flex items-center justify-between bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground"><span><i className="mr-1.5 inline-block size-2 rounded-full bg-destructive" /><i className="mr-1.5 inline-block size-2 rounded-full bg-chart-1" /><i className="mr-2 inline-block size-2 rounded-full bg-emerald-500" />{extension} · UTF-8</span><span>Read/Write</span></div><div className="flex min-h-48 font-mono text-xs leading-6"><div aria-hidden className="select-none border-r border-border/70 px-3 py-3 text-right text-muted-foreground">{Array.from({ length: Math.max(8, lineCount) }, (_, index) => <div key={index}>{index + 1}</div>)}</div><textarea aria-label="模板代码" value={code} onChange={(event) => { setCode(event.target.value); setFetchedStatus(null); }} spellCheck={false} className="min-h-48 flex-1 resize-y bg-transparent p-3 font-mono text-xs leading-6 outline-none" placeholder="粘贴 YAML / CONF 模板内容" /></div><div className="flex justify-between bg-muted/35 px-3 py-1.5 text-[11px] text-muted-foreground"><span className="text-emerald-600 dark:text-emerald-400">● 已输入 {lineCount} 行代码</span><span>支持 Ctrl+V / ⌘+V 粘贴</span></div></div></section>}
        {mode === "remote" && <section className="space-y-3 pt-1"><div className="space-y-1.5"><label className="flex justify-between text-sm font-semibold">订阅地址 <span className="font-mono text-[11px] font-normal text-emerald-600 dark:text-emerald-400">HTTPS 建议</span></label><div className="flex gap-2"><div className="relative flex-1"><Link2 className="pointer-events-none absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" /><Input type="url" value={remoteURL} onChange={(event) => { setRemoteURL(event.target.value); setFetchedStatus(null); }} className="h-[42px] pl-10 font-mono text-sm" placeholder="https://example.com/config.yaml" /></div><Button type="button" variant="secondary" className="h-[42px] gap-1.5 text-primary" disabled={fetching} onClick={() => void fetchRemote()}>{fetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{fetching ? "拉取中…" : "拉取"}</Button></div></div>{fetchedStatus !== null && <div className="space-y-1.5"><div className="flex justify-between text-sm font-semibold">拉取结果 <Badge className="ml-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">{fetchedStatus} OK</Badge></div><pre className="max-h-40 overflow-auto rounded-lg bg-muted/45 p-4 font-mono text-xs leading-5 text-foreground">{preview}</pre></div>}<div className="flex gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"><Info className="size-4 shrink-0" />仅支持公开 HTTP(S) 地址；本地、回环及私有网络地址会被服务器拒绝。</div></section>}
      </main>
      <footer className="mt-3 flex items-center justify-between border-t border-border bg-muted/25 px-6 py-4 sm:px-7"><span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Info className="size-4 text-primary" />生成的配置将同步至本地规则集群</span><div className="flex gap-2"><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!canSave || saving} onClick={() => void save()}>{saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : <PlusCircle className="mr-1 size-4" />}{saving ? "创建中…" : "创建"}</Button></div></footer>
      <input ref={fileRef} className="hidden" type="file" accept=".yaml,.yml,.conf,.list,text/yaml,text/plain" onChange={(event) => { void chooseFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    </section>
  </div>;
  return overlay ? createPortal(dialog, overlay) : dialog;
}
