import { createPortal } from "react-dom";
import type { Dispatch, SetStateAction } from "react";
import { Boxes, Check, ClipboardPaste, Copy, Info, Link2, Network, Plus, X } from "lucide-react";
import { useOverlayContainer } from "@/components/ui/overlay-root";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

type Ip = { ID: number; Alias: string; Address: string };
type Sub = { ID: number; Name: string };
type Props = {
  open: boolean; name: string; setName: Dispatch<SetStateAction<string>>;
  link: string; setLink: Dispatch<SetStateAction<string>>;
  replace: boolean; setReplace: Dispatch<SetStateAction<boolean>>;
  replaceId: string; setReplaceId: Dispatch<SetStateAction<string>>;
  ips: Ip[]; openIpLibrary: () => void;
  groups: string[]; newGroup: string; setNewGroup: Dispatch<SetStateAction<string>>; openCreateGroup: () => void;
  selectedGroups: string[]; setSelectedGroups: Dispatch<SetStateAction<string[]>>;
  subscriptions: Sub[]; selectedSubscriptions: number[]; setSelectedSubscriptions: Dispatch<SetStateAction<number[]>>;
  saving: boolean; onSave: () => void; onClose: () => void;
};

function Toggle({ on }: { on: boolean }) { return <span className={`block size-5 rounded-full bg-white transition ${on ? "translate-x-5" : ""}`} />; }

export function NodeAddDialog(p: Props) {
  const overlay = useOverlayContainer();
  if (!p.open) return null;
  const protocol = p.link.match(/^([a-z0-9+-]+):\/\//i)?.[1]?.toUpperCase() || "Node URI";
  const selectedIp = p.ips.find((ip) => String(ip.ID) === p.replaceId);
  const firstLink = p.link.trim().split(/[\n,]/)[0] || "";
  const tag = firstLink.includes("#") ? decodeURIComponent(firstLink.split("#").at(-1) || "") : "";
  const target = firstLink.match(/@([^:/?#]+)(?::(\d+))?/) || firstLink.match(/\/\/([^:/?#]+)(?::(\d+))?/);
  const host = target?.[1] || "--";
  const port = target?.[2] || "--";
  const readClipboard = async () => { try { const value = await navigator.clipboard.readText(); if (value) p.setLink(value); } catch { /* browser denied clipboard access */ } };
  const copyPreview = async () => { try { await navigator.clipboard.writeText(firstLink); } catch { /* clipboard may be unavailable */ } };
  const toggleGroup = (group: string) => p.setSelectedGroups((current) => current.includes(group) ? current.filter((item) => item !== group) : [...current, group]);
  const toggleSubscription = (id: number) => p.setSelectedSubscriptions((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const dialog = <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/55 p-3 dark:bg-black/70">
    <section className="my-auto w-full max-w-5xl overflow-hidden rounded-[22px] border border-border bg-card shadow-2xl">
      <header className="flex items-start justify-between border-b border-border px-7 py-6">
        <div><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary/15 text-primary"><Plus /></span><h2 className="text-2xl font-bold">添加节点</h2><Badge variant="outline" className="border-primary/35 text-primary">Node Importer</Badge><Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">● 将创建 {p.link.split(/\n|,/).filter(Boolean).length || 1} 个节点</Badge></div><p className="mt-2 text-sm text-muted-foreground">粘贴原始 SS / 节点链接，从入口 IP 库选择目标入口 IP 替换地址，原端口、密码与加密参数保持不变。</p></div><Button variant="ghost" size="icon" onClick={p.onClose}><X /></Button>
      </header>
      <main className="max-h-[68vh] space-y-6 overflow-y-auto px-7 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><b className="flex items-center gap-2"><span className="size-2 rounded-full bg-primary" />单节点精细配置与入口 IP 替换</b><div className="flex items-center gap-2"><Button size="sm" variant="secondary" className="gap-1.5 text-primary" onClick={() => void readClipboard()}><ClipboardPaste className="size-4" />从剪贴板读取并自动解析</Button><Button size="sm" variant="outline" className="gap-1"><Info className="size-3.5" />协议说明</Button><button type="button" className="px-2 text-sm text-muted-foreground hover:text-destructive" onClick={() => { p.setLink(""); p.setName(""); }}>清空</button></div></div>
        <label className="block space-y-2"><span className="flex justify-between text-sm font-medium">节点自定义名称 <small className="font-normal text-muted-foreground">（可选，留空自动提取链接注释）</small><button type="button" className="font-normal text-primary" onClick={() => tag && p.setName(tag)}>自动提取末尾 #Tag</button></span><Input value={p.name} onChange={(event) => p.setName(event.target.value)} placeholder="例如 BageVM5GS" /></label>
        <label className="block space-y-2"><span className="flex items-center justify-between text-sm font-medium">节点链接（Node URI）<i className="text-destructive"> *</i><span className="ml-auto flex gap-1">{["SS", "VLESS", "VMESS", "Trojan", "Hysteria2"].map((item) => <Badge key={item} variant="outline" className="font-mono text-[10px]">{item}</Badge>)}</span></span><textarea value={p.link} onChange={(event) => p.setLink(event.target.value)} className="min-h-28 w-full rounded-xl border bg-background p-4 font-mono text-sm" placeholder="ss://、vless://、vmess://、trojan:// 或 hysteria2://" /><small className="flex items-center gap-1 text-muted-foreground"><Info className="size-3.5 text-primary" />系统将自动解析节点协议与连接参数，并支持在下方选择中转入口 IP 替换直连地址。</small></label>
        {firstLink && <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/20 px-3 py-2 text-xs"><span className="border-r border-border pr-3 text-emerald-600 dark:text-emerald-400">● 实时解析成功</span><Badge variant="outline">协议：{protocol}</Badge><Badge variant="secondary">直连目标：<code className="ml-1">{host}</code></Badge><Badge variant="secondary">端口：<code className="ml-1">{port}</code></Badge></div>}
        <section className="rounded-2xl border border-primary/35 bg-primary/[.04] p-5"><div className="flex items-center justify-between"><div><h3 className="font-bold"><Network className="mr-2 inline size-5 text-primary" />替换入口 IP（IP Relay Replacement）</h3><p className="mt-1 text-sm text-muted-foreground">从入口 IP 库选择目标入口 IP 直接完成地址替换，其余端口、密码及加密参数完全保持不变。</p></div><button type="button" aria-label="切换入口 IP 替换" onClick={() => p.setReplace((value) => !value)} className={`h-7 w-12 rounded-full p-1 transition ${p.replace ? "bg-primary" : "bg-muted"}`}><Toggle on={p.replace} /></button></div>{p.replace && <div className="mt-5 border-t border-border/70 pt-4"><div className="flex justify-between"><label className="text-sm font-medium">选择入口 IP 节点</label><button type="button" className="text-sm text-primary" onClick={p.openIpLibrary}>+ 管理 IP 库</button></div><select value={p.replaceId} onChange={(event) => p.setReplaceId(event.target.value)} className="mt-2 h-11 w-full rounded-lg border bg-background px-3"><option value="">选择目标入口 IP</option>{p.ips.map((ip) => <option key={ip.ID} value={ip.ID}>{ip.Alias} · {ip.Address}</option>)}</select>{selectedIp && <><div className="mt-4 grid grid-cols-3 items-center rounded-lg border bg-background/70 p-3 text-center text-sm"><span>原直连：<b className="font-mono">{host}:{port}</b></span><span className="text-primary">入口中转转发 →</span><span>中转入口：<b className="font-mono text-primary">{selectedIp.Address}:{port}</b></span></div><div className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>保存后的最终节点链接（Read-only Preview）</span><button type="button" className="flex items-center gap-1 text-primary" onClick={() => void copyPreview()}><Copy className="size-3.5" />复制链接</button></div><code className="mt-1 block overflow-x-auto rounded-lg border bg-background px-3 py-2 text-xs">{firstLink.replace(host, selectedIp.Address)}</code></>}</div>}</section>
        <div className="grid gap-5 md:grid-cols-2">
          <section className="rounded-2xl border border-border bg-muted/10 p-4"><div className="flex items-center justify-between"><b className="flex gap-2"><Boxes className="size-4 text-primary" />所属分组（Node Groups）</b><Button type="button" size="sm" variant="outline" className="gap-1 text-primary" onClick={p.openCreateGroup}><Plus className="size-3.5" />创建新分组</Button></div><div className="mt-3 flex min-h-11 flex-wrap gap-2 rounded-lg border border-border bg-background/60 p-2">{p.selectedGroups.length ? p.selectedGroups.map((group) => <button type="button" key={group} onClick={() => toggleGroup(group)} className="rounded-md bg-primary/15 px-2 py-1 text-xs text-primary">{group} ×</button>) : <span className="text-xs text-muted-foreground">点击下方选择已有分组</span>}</div><div className="mt-3 max-h-32 space-y-1 overflow-auto rounded-lg border border-border/70 p-2">{p.groups.map((group) => <button type="button" key={group} onClick={() => toggleGroup(group)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"><Checkbox checked={p.selectedGroups.includes(group)} /><span className="flex-1">{group}</span>{p.selectedGroups.includes(group) && <Check className="size-4 text-primary" />}</button>)}{!p.groups.length && <p className="p-2 text-xs text-muted-foreground">尚无已有分组，可创建一个。</p>}</div></section>
          <section className="rounded-2xl border border-border bg-muted/10 p-4"><div className="flex items-center justify-between"><b className="flex gap-2"><Link2 className="size-4 text-primary" />所属订阅 / 关联订阅</b><Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">已关联 {p.selectedSubscriptions.length} 个订阅</Badge></div><div className="mt-3 flex min-h-11 flex-wrap gap-2 rounded-lg border border-border bg-background/60 p-2">{p.selectedSubscriptions.length ? p.subscriptions.filter((sub) => p.selectedSubscriptions.includes(sub.ID)).map((sub) => <button type="button" key={sub.ID} onClick={() => toggleSubscription(sub.ID)} className="rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400">{sub.Name} ×</button>) : <span className="text-xs text-muted-foreground">尚未关联订阅</span>}</div><div className="mt-3 max-h-36 space-y-1 overflow-auto rounded-lg border border-border/70 p-2">{p.subscriptions.map((sub) => <button type="button" key={sub.ID} onClick={() => toggleSubscription(sub.ID)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"><Checkbox checked={p.selectedSubscriptions.includes(sub.ID)} /><span className="flex-1">{sub.Name}</span>{p.selectedSubscriptions.includes(sub.ID) && <Check className="size-4 text-primary" />}</button>)}{!p.subscriptions.length && <p className="p-2 text-xs text-muted-foreground">暂无可关联订阅</p>}</div></section>
        </div>
      </main>
      <footer className="flex items-center justify-between border-t bg-muted/15 px-7 py-5"><span className="text-sm text-muted-foreground">● 已解析有效节点：{protocol}</span><div className="flex gap-3"><Button variant="secondary" onClick={p.onClose}>取消</Button><Button disabled={!p.link.trim() || p.saving} onClick={p.onSave}>{p.saving ? "添加中…" : <><Check className="mr-1 size-4" />确认添加节点</>}</Button></div></footer>
    </section>
  </div>;
  return overlay ? createPortal(dialog, overlay) : dialog;
}
