import { createPortal } from "react-dom";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Check, ClipboardList, GripVertical, Plus, Search, Tag, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useOverlayContainer } from "@/components/ui/overlay-root";
import { cn } from "@/lib/utils";

type Node = { ID: number; Name: string; Link: string; Disabled?: boolean };
type Props = {
  open: boolean;
  title?: string;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  expireAt: string;
  setExpireAt: Dispatch<SetStateAction<string>>;
  accessLimit: string;
  setAccessLimit: Dispatch<SetStateAction<string>>;
  nodes: Node[];
  selectedNodeIds: number[];
  toggleNode: (id: number) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
};

export function NodeSubscriptionDialog(p: Props) {
  const [query, setQuery] = useState("");
  const overlayContainer = useOverlayContainer();
  const selected = useMemo(() => p.selectedNodeIds.map((id) => p.nodes.find((node) => node.ID === id)).filter((node): node is Node => Boolean(node)), [p.nodes, p.selectedNodeIds]);
  const available = useMemo(() => p.nodes.filter((node) => !node.Disabled && `${node.Name} ${node.Link}`.toLowerCase().includes(query.trim().toLowerCase())), [p.nodes, query]);
  if (!p.open) return null;
  const dialog = <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/55 p-3 dark:bg-black/70">
    <section className="my-auto w-full max-w-5xl overflow-hidden rounded-[22px] border border-border bg-card shadow-2xl">
      <header className="flex items-start justify-between border-b border-border px-7 py-6">
        <div><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary/15 text-primary"><ClipboardList className="size-5" /></span><h2 className="text-2xl font-bold">{p.title || "新建节点订阅"}</h2><Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">Node Subscription</Badge></div><p className="mt-2 text-sm text-muted-foreground">选择需要公开的节点，系统将生成独立的节点订阅链接。</p></div>
        <Button variant="ghost" size="icon" onClick={p.onClose}><X /></Button>
      </header>
      <main className="max-h-[68vh] overflow-y-auto px-7 py-7">
        <div className="grid gap-5 md:grid-cols-3"><label className="space-y-2 md:col-span-3"><b className="text-sm">订阅名称 <i className="text-destructive">*</i></b><div className="relative"><Tag className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={p.name} onChange={(event) => p.setName(event.target.value)} className="h-11 pl-10" placeholder="例如：全球高速" /></div></label><label className="space-y-2"><b className="text-sm">到期时间 <span className="font-normal text-muted-foreground">（可选）</span></b><Input type="datetime-local" value={p.expireAt} onChange={(event) => p.setExpireAt(event.target.value)} /></label><label className="space-y-2"><b className="text-sm">访问限额 <span className="font-normal text-muted-foreground">（可选）</span></b><Input type="number" min="0" value={p.accessLimit} onChange={(event) => p.setAccessLimit(event.target.value)} placeholder="留空表示不限" /></label><div className="rounded-lg border border-border bg-muted/15 px-4 py-2 text-sm text-muted-foreground"><b className="block text-foreground">已选 {selected.length} 个节点</b>输出会按右侧列表顺序排列。</div></div>
        <div className="mt-6 grid gap-5 lg:grid-cols-2"><section className="overflow-hidden rounded-xl border border-border bg-muted/10"><header className="flex items-center justify-between border-b border-border px-4 py-3"><b>可选节点 <Badge variant="secondary" className="ml-2">{available.length}</Badge></b><span className="text-sm text-primary">加入当前列表 →</span></header><div className="p-3"><div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 pl-9" placeholder="搜索节点名称、国家或协议..." /></div><div className="mt-3 max-h-72 space-y-2 overflow-y-auto">{available.map((node) => { const checked = p.selectedNodeIds.includes(node.ID); return <button type="button" key={node.ID} onClick={() => p.toggleNode(node.ID)} className={cn("flex w-full items-center gap-3 rounded-lg border p-3 text-left", checked ? "border-primary/50 bg-primary/10" : "border-border bg-card hover:border-primary/35")}><Checkbox checked={checked} /><span className="min-w-0 flex-1"><b className="block truncate text-sm">{node.Name}</b><small className="block truncate text-xs text-muted-foreground">{node.Link}</small></span><Plus className="size-4 text-muted-foreground" /></button>; })}{!available.length && <p className="py-10 text-center text-sm text-muted-foreground">没有匹配的节点</p>}</div></div></section>
          <section className="overflow-hidden rounded-xl border border-border bg-muted/10"><header className="flex items-center justify-between border-b border-border px-4 py-3"><b>已选节点 <Badge variant="secondary" className="ml-2">{selected.length} 个</Badge></b><button type="button" className="flex items-center gap-1 text-sm text-destructive" onClick={() => selected.forEach((node) => p.toggleNode(node.ID))}><Trash2 className="size-4" />清空</button></header><p className="px-4 py-2 text-xs text-muted-foreground">节点将按自上而下的顺序输出</p><div className="max-h-[323px] space-y-2 overflow-y-auto border-t border-border p-3">{selected.map((node, index) => <div key={node.ID} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"><GripVertical className="size-4 text-muted-foreground" /><Badge variant="secondary">#{index + 1}</Badge><span className="min-w-0 flex-1"><b className="block truncate text-sm">{node.Name}</b><small className="text-xs text-muted-foreground">{node.Link.split(":")[0]?.toUpperCase()}</small></span><button type="button" onClick={() => p.toggleNode(node.ID)} aria-label={`移除 ${node.Name}`}><X className="size-4 text-muted-foreground hover:text-destructive" /></button></div>)}{!selected.length && <p className="py-16 text-center text-sm text-muted-foreground">从左侧选择节点</p>}</div></section></div>
      </main>
      <footer className="flex justify-between border-t border-border bg-muted/15 px-7 py-5"><Button variant="secondary" onClick={p.onClose}>取消</Button><Button disabled={!p.name.trim() || !selected.length || p.saving} onClick={p.onSave}>{p.saving ? "保存中…" : <><Check className="mr-1 size-4" />{p.title ? "保存节点订阅" : "生成节点订阅"}</>}</Button></footer>
    </section>
  </div>;
  return overlayContainer ? createPortal(dialog, overlayContainer) : dialog;
}
