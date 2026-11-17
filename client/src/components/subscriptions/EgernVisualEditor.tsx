import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronUp, Code2, GripVertical, ImageIcon, Plus, Search, Trash2 } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ruleSetDisplayName } from "./ruleSetName";
import { usePointerListSort } from "./usePointerListSort";
import { RenameConfirmationDialog } from "./RenameConfirmationDialog";
import { DeletePolicyGroupDialog } from "./DeletePolicyGroupDialog";
import { ReferenceDetailsDialog } from "./ReferenceDetailsDialog";

type Group = {
  name: string;
  type: string;
  policies: string[];
  [key: string]: unknown;
};
type Rule = {
  type: string;
  match?: string;
  policy: string;
  disabled?: boolean;
  [key: string]: unknown;
};
type Props = {
  value: string;
  view?: "groups" | "rules";
  onChange: (value: string) => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onOpenRuleSet?: (name: string) => void;
  onFocusLine?: (line: number) => void;
};
const types = [
  "select",
  "auto_test",
  "smart",
  "fallback",
  "load_balance",
  "external",
  "conditional",
];
const typeLabels: Record<string, string> = {
  select: "手动选择",
  auto_test: "自动测速",
  smart: "智能选择",
  fallback: "故障转移",
  load_balance: "负载均衡",
  external: "外部策略",
  conditional: "条件策略",
};
const defaultLatencyTestURL = "http://www.gstatic.com/generate_204";
const getLatencyTestURL = (group: Group) =>
  typeof group.latency_test_url === "string" && group.latency_test_url.trim()
    ? group.latency_test_url
    : defaultLatencyTestURL;
function parse(value: string) {
  const doc = parseDocument(value, { prettyErrors: false, strict: true });
  if (doc.errors.length) throw new Error(String(doc.errors[0].message));
  const root = doc.toJS();
  if (!root || Array.isArray(root) || typeof root !== "object")
    throw new Error("Egern 根配置必须是 YAML 对象");
  const groups = (
    Array.isArray(root.policy_groups) ? root.policy_groups : []
  ).map((entry: Record<string, Record<string, unknown>>) => {
    const [type, settings] = Object.entries(entry || {})[0] || ["select", {}];
    const normalized = settings && typeof settings === "object" ? settings : {};
    const { policies, type: externalType, ...rest } = normalized;
    const group = {
      name: "",
      type,
      ...rest,
      ...(type === "external" && externalType ? { externalType: String(externalType) } : {}),
      policies: Array.isArray(policies) ? policies.map(String) : [],
    } as Group;
    if (group.type === "auto_test") {
      if (group.urls === null) delete group.urls;
      group.latency_test_url = getLatencyTestURL(group);
    }
    // 面板固定使用 Egern 默认的切换容差和超时，不暴露或保留覆写值。
    delete group.tolerance;
    delete group.timeout;
    return group;
  });
  const rules = (Array.isArray(root.rules) ? root.rules : []).map(
    (entry: Record<string, Record<string, unknown>>) => {
      const [type, settings] = Object.entries(entry || {})[0] || [
        "domain_suffix",
        { match: "", policy: "DIRECT" },
      ];
      return { type, ...(settings || {}) } as Rule;
    },
  );
  return { root, groups, rules };
}
const egernRuleTypeGroups = [
  { label: "域名", types: ["domain", "domain_suffix", "domain_keyword", "domain_regex", "domain_wildcard", "url_regex"] },
  { label: "IP / 地理", types: ["geoip", "ip_cidr", "ip_cidr6", "asn"] },
  { label: "网络与高级", types: ["dest_port", "protocol", "user_agent", "ssid", "bssid", "cellular", "rule_set", "and", "or", "not", "default"] },
];
const egernRuleDescriptions: Record<string, string> = {
  domain: "精确域名", domain_suffix: "域名及子域", domain_keyword: "域名关键词", domain_regex: "域名正则", domain_wildcard: "域名通配", url_regex: "URL 正则",
  geoip: "地区 IP", ip_cidr: "IPv4 网段", ip_cidr6: "IPv6 网段", asn: "自治系统", dest_port: "目标端口", protocol: "协议", user_agent: "用户代理", ssid: "Wi-Fi 名称", bssid: "Wi-Fi BSSID", cellular: "蜂窝网络类型", rule_set: "引用规则集", and: "全部子条件成立", or: "任一子条件成立", not: "子条件不成立", default: "其余全部流量",
};
const ruleSetName = (rule: Rule) => typeof rule.name === "string" && rule.name.trim() ? rule.name : ruleSetDisplayName(String(rule.match || ""), "规则集");
const ruleSetOptions = (rules: Rule[]) => rules.filter((rule) => rule.type === "rule_set" && ruleSetName(rule) && String(rule.match || "").trim()).map((rule) => ({ name: ruleSetName(rule), match: String(rule.match).trim() }));
const ruleSetKey = (item: { name: string; match: string }) => JSON.stringify([item.name, item.match]);
const ruleMatchLabel = (rule: Rule) => rule.type === "rule_set" ? ruleSetName(rule) : rule.type === "default" ? "匹配其余全部流量" : rule.match || "未填写";
const validDomain = (value: string) => /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value);
const validCidr = (value: string, v6 = false) => v6 ? /^[0-9a-f:]+\/\d{1,3}$/i.test(value) : /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(value) && value.split("/")[0].split(".").every((part) => Number(part) <= 255);
function ruleValidation(rule: Rule, policies: string[], knownRuleSets: Array<{ name: string; match: string }>) {
  const match = String(rule.match || "").trim();
  if (!rule.policy?.trim() || !policies.includes(rule.policy.trim())) return "请选择当前模板中有效的路由目标";
  if (rule.type !== "default" && !match) return "请填写规则匹配值";
  if (["domain", "domain_suffix"].includes(rule.type) && !validDomain(match)) return "域名格式无效";
  if (rule.type === "ip_cidr" && !validCidr(match)) return "IPv4 CIDR 格式无效，例如 1.2.3.0/24";
  if (rule.type === "ip_cidr6" && !validCidr(match, true)) return "IPv6 CIDR 格式无效";
  if (rule.type === "asn" && !/^AS?\d+$/i.test(match)) return "ASN 格式无效，例如 AS13335";
  if (rule.type === "geoip" && !/^[a-z]{2}$/i.test(match)) return "GeoIP 请使用两位国家/地区代码";
  if (rule.type === "dest_port" && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(match)) return "端口需使用 Egern 支持的格式，例如 80,443,8000-9000";
  if (rule.type === "protocol" && !["tcp", "udp", "http", "https", "quic", "stun"].includes(match.toLowerCase())) return "协议仅支持 tcp、udp、http、https、quic、stun";
  if (rule.type === "bssid" && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(match)) return "BSSID 格式无效，例如 00:11:22:33:44:55";
  if (rule.type === "rule_set" && !knownRuleSets.some((item) => item.name === ruleSetName(rule) && item.match === match)) return "请选择当前模板中已有的规则集";
  return "";
}
function egernRuleTagClass(type: string) {
  const normalized = type.toUpperCase();
  if (normalized === "RULE_SET") return "border-cyan-500/40 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300";
  if (normalized.includes("CIDR") || normalized.includes("ASN")) return "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
  if (normalized === "GEOIP") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (normalized.includes("KEYWORD") || normalized.includes("REGEX")) return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function EgernRuleDialog({
  editor,
  groups,
  policyOptions,
  knownRuleSets,
  onEditorChange,
  onSave,
}: {
  editor: { index: number | null; rule: Rule } | null;
  groups: Group[];
  policyOptions: string[];
  knownRuleSets: Array<{ name: string; match: string }>;
  onEditorChange: (editor: { index: number | null; rule: Rule } | null) => void;
  onSave: () => void;
}) {
  if (!editor) return null;
  const selectType = (type: string) => onEditorChange({ ...editor, rule: { ...editor.rule, type, ...(type === "default" ? { match: undefined } : {}) } });
  const setPolicy = (policy: string) => onEditorChange({ ...editor, rule: { ...editor.rule, policy } });
  const parameter = editor.rule.type === "rule_set" ? ruleSetName(editor.rule) : editor.rule.match || "";
  return <Dialog open onOpenChange={(open) => !open && onEditorChange(null)}>
    <DialogContent onPointerDownOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => event.preventDefault()} className="max-w-[900px] gap-0 overflow-hidden border border-border bg-card p-0 text-card-foreground shadow-2xl sm:p-0">
      <DialogHeader className="border-b border-border bg-muted/30 px-6 py-5 pr-16"><DialogTitle className="flex items-center gap-3 text-xl text-foreground"><span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary"><Code2 className="size-5" /></span>{editor.index === null ? "添加流量规则" : "编辑流量规则"}</DialogTitle><p className="mt-1 text-sm text-muted-foreground">规则会关联到当前策略组，并实时写入右侧预览。</p></DialogHeader>
      <div className="grid max-h-[min(650px,calc(100svh-13rem))] gap-5 overflow-y-auto p-6">
        <section className="rounded-xl border border-border bg-muted/15 p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-foreground">匹配类型</p><p className="mt-0.5 text-xs text-muted-foreground">选择要识别的流量特征</p></div><span className={`rounded border px-2 py-1 font-mono text-[10px] font-semibold ${egernRuleTagClass(editor.rule.type)}`}>{editor.rule.type}</span></div><div className="space-y-3">{egernRuleTypeGroups.map((group) => <div key={group.label}><p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{group.label}</p><div className="flex flex-wrap gap-1.5">{group.types.map((type) => <button key={type} type="button" onClick={() => selectType(type)} className={`flex max-w-[160px] flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors ${editor.rule.type === type ? `${egernRuleTagClass(type)} ring-1 ring-current/20` : "border-border bg-background text-muted-foreground hover:border-primary/45 hover:text-foreground"}`}><span className="font-mono text-[11px] font-semibold leading-tight">{type.toUpperCase()}</span><span className="font-sans text-[10px] font-normal leading-tight opacity-75">{egernRuleDescriptions[type]}</span></button>)}</div></div>)}</div></section>
        <div className="grid gap-5 md:grid-cols-[1.05fr_.95fr]"><section className="grid content-start gap-3 rounded-xl border border-border bg-card p-4"><div><p className="text-sm font-semibold text-foreground">路由目标</p><p className="mt-0.5 text-xs text-muted-foreground">命中后将流量发送到此目标</p></div><div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setPolicy("DIRECT")} className={`rounded-lg border p-3 text-left transition-colors ${editor.rule.policy === "DIRECT" ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-background hover:border-emerald-500/40"}`}><span className="block text-xs font-semibold">→ DIRECT</span><span className="mt-1 block text-[10px] text-muted-foreground">直连访问</span></button><button type="button" onClick={() => setPolicy("REJECT")} className={`rounded-lg border p-3 text-left transition-colors ${editor.rule.policy === "REJECT" ? "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300" : "border-border bg-background hover:border-rose-500/40"}`}><span className="block text-xs font-semibold">⊘ REJECT</span><span className="mt-1 block text-[10px] text-muted-foreground">拒绝连接</span></button></div><label className="grid gap-1.5 text-xs font-medium text-foreground">代理策略组 <span className="text-[10px] font-normal text-muted-foreground">选择策略组会覆盖上方内置动作</span><Select value={policyOptions.includes(editor.rule.policy) ? editor.rule.policy : "__custom"} onValueChange={(policy) => policy !== "__custom" && setPolicy(policy)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{!policyOptions.includes(editor.rule.policy) && <SelectItem value="__custom">{editor.rule.policy || "自定义目标"}</SelectItem>}{policyOptions.map((policy) => <SelectItem key={policy} value={policy}>{policy}</SelectItem>)}</SelectContent></Select></label></section><section className="grid content-start gap-3 rounded-xl border border-border bg-card p-4"><div><p className="text-sm font-semibold text-foreground">规则参数</p><p className="mt-0.5 text-xs text-muted-foreground">{editor.rule.type === "default" ? "DEFAULT 将兜底匹配尚未命中的流量。" : "输入此类型对应的匹配内容。"}</p></div>{editor.rule.type === "default" ? <div className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-3 font-mono text-xs text-primary">DEFAULT（无需填写匹配值）</div> : editor.rule.type === "rule_set" ? <Select value={knownRuleSets.find((item) => item.name === ruleSetName(editor.rule) && item.match === String(editor.rule.match || "").trim()) ? ruleSetKey({ name: ruleSetName(editor.rule), match: String(editor.rule.match || "").trim() }) : "__custom"} onValueChange={(key) => { const item = knownRuleSets.find((candidate) => ruleSetKey(candidate) === key); if (item) onEditorChange({ ...editor, rule: { ...editor.rule, name: item.name, match: item.match } }); }}><SelectTrigger className="h-11 font-mono"><SelectValue placeholder="选择规则集" /></SelectTrigger><SelectContent><SelectItem value="__custom" disabled>{parameter || "引用不存在的规则集"}</SelectItem>{knownRuleSets.map((item) => <SelectItem key={ruleSetKey(item)} value={ruleSetKey(item)}>{item.name}</SelectItem>)}</SelectContent></Select> : <Input value={parameter} onChange={(event) => onEditorChange({ ...editor, rule: { ...editor.rule, match: event.target.value } })} placeholder={editor.rule.type.includes("cidr") ? "例如 1.2.3.0/24" : "请输入匹配内容"} className="h-11 border-border bg-background font-mono text-sm text-foreground" />}</section></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-medium">规则名称（name，可选）<Input value={String(editor.rule.name || "")} onChange={(event) => onEditorChange({ ...editor, rule: { ...editor.rule, name: event.target.value || undefined } })} placeholder="用于日志与调试" /></label>{["geoip", "ip_cidr", "ip_cidr6", "asn"].includes(editor.rule.type) && <label className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs"><span><b className="block">仅匹配已解析 IP</b><small className="block text-muted-foreground">no_resolve</small></span><Switch checked={editor.rule.no_resolve === true} onCheckedChange={(no_resolve) => onEditorChange({ ...editor, rule: { ...editor.rule, no_resolve } })} /></label>}</div>
        <label className="flex min-h-[76px] items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs"><span className="min-w-0"><b className="block text-foreground">启用规则</b><small className="mt-1 block text-muted-foreground">关闭后保留在模板中，但不参与匹配。</small></span><Switch className="shrink-0" checked={!editor.rule.disabled} onCheckedChange={(enabled) => onEditorChange({ ...editor, rule: { ...editor.rule, disabled: !enabled } })} /></label>
        <section className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-3"><div className="mb-1 text-[11px] font-medium text-primary">生成预览</div><code className="block break-all font-mono text-sm text-foreground">{editor.rule.type}{editor.rule.type === "default" ? "" : `: ${parameter || "匹配内容"}`} → {editor.rule.policy || "DIRECT"}</code></section>
      </div>
      <DialogFooter className="border-t border-border bg-muted/30 px-6 py-4"><Button variant="outline" onClick={() => onEditorChange(null)}>取消</Button><Button onClick={onSave}>应用规则</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function EgernRuleWorkspace({ groups, rules, policyOptions, knownRuleSets, onRulesChange, onOpenRuleSet }: { groups: Group[]; rules: Rule[]; policyOptions: string[]; knownRuleSets: Array<{ name: string; match: string }>; onRulesChange: (rules: Rule[]) => void; onOpenRuleSet?: (name: string) => void }) {
  const [filter, setFilter] = useState<"all" | "direct" | "reject" | "orphan">("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ index: number | null; rule: Rule } | null>(null);
  const dragIndex = useRef<number | null>(null);
  const groupNames = new Set(groups.map((group) => group.name.trim()).filter(Boolean));
  const categoryOf = (rule: Rule) => rule.policy === "DIRECT" ? "direct" : rule.policy === "REJECT" ? "reject" : groupNames.has(rule.policy) ? "group" : "orphan";
  const count = (category: "direct" | "reject" | "orphan") => rules.filter((rule) => categoryOf(rule) === category).length;
  const visible = rules.map((rule, index) => ({ rule, index, category: categoryOf(rule) })).filter(({ rule, category }) => {
    const keyword = query.trim().toLowerCase();
    return (filter === "all" || category === filter) && (!keyword || `${rule.type} ${rule.match || ""} ${rule.policy}`.toLowerCase().includes(keyword));
  });
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = [...rules];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onRulesChange(next);
  };
  const pointerSort = usePointerListSort(reorder, (index) => <div className="w-[min(640px,calc(100vw-3rem))] rounded-lg border border-primary/60 bg-card px-4 py-3 shadow-2xl"><b className="font-mono text-sm">{rules[index]?.type}</b><span className="ml-3 text-sm">{ruleMatchLabel(rules[index] || { type: "", policy: "" })}</span></div>);
  const save = () => {
    if (!editor) return;
    const rule = { ...editor.rule, policy: editor.rule.policy.trim() || "DIRECT" };
    const error = ruleValidation(rule, policyOptions, knownRuleSets);
    if (error) { window.alert(error); return; }
    if (rule.type === "default") delete rule.match;
    onRulesChange(editor.index === null ? [...rules, rule] : rules.map((item, index) => index === editor.index ? rule : item));
    setEditor(null);
  };
  return <section className="grid min-h-0 flex-1 gap-4 overflow-hidden bg-muted/20 p-4 lg:grid-cols-[minmax(0,1.04fr)_minmax(380px,.96fr)]">
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border bg-muted/30 px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">全量分流规则 <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">{rules.length}</span></p><p className="mt-0.5 text-xs text-muted-foreground">按从上到下顺序匹配；命中首条规则即停止。</p></div><Button size="sm" onClick={() => setEditor({ index: null, rule: { type: "domain_suffix", match: "", policy: groups[0]?.name || "DIRECT" } })}><Plus className="mr-1 size-4" />新建规则</Button></div><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant={filter === "all" ? "secondary" : "outline"} className="h-7 text-xs" onClick={() => setFilter("all")}>全部全局（{rules.length}）</Button><Button size="sm" variant={filter === "direct" ? "secondary" : "outline"} className="h-7 border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-300" onClick={() => setFilter("direct")}>DIRECT 直连（{count("direct")}）</Button><Button size="sm" variant={filter === "reject" ? "secondary" : "outline"} className="h-7 border-rose-500/30 text-xs text-rose-700 dark:text-rose-300" onClick={() => setFilter("reject")}>REJECT 拦截（{count("reject")}）</Button>{count("orphan") > 0 && <Button size="sm" variant={filter === "orphan" ? "destructive" : "outline"} className="h-7 text-xs" onClick={() => setFilter("orphan")}>未归属异常（{count("orphan")}）</Button>}<div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-7 pl-7 text-xs" placeholder="过滤规则类型、匹配值或目标" /></div></div></header>
      {count("orphan") > 0 && filter !== "direct" && filter !== "reject" && <div className="m-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">检测到 {count("orphan")} 条目标策略组不存在的规则。请重新指定可用策略。</div>}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain" onPointerMove={pointerSort.move} onPointerUp={pointerSort.end} onPointerCancel={pointerSort.end}><div className="min-w-[650px]"><div className="grid grid-cols-12 gap-2 border-b border-border bg-muted/50 px-3 py-2 text-[10px] font-medium text-muted-foreground"><span className="col-span-1">#</span><span className="col-span-3">规则类型</span><span className="col-span-3">匹配载荷</span><span className="col-span-3">路由目标</span><span className="col-span-2 text-right">操作</span></div>{visible.map(({ rule, index }) => { const direct = rule.policy === "DIRECT"; const reject = rule.policy === "REJECT"; return <div key={index} data-pointer-sort-index={index} className="grid grid-cols-12 items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0 hover:bg-muted/35"><span className="col-span-1 flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><span onPointerDown={(event) => pointerSort.begin(index, event)}><GripVertical className="size-4 cursor-grab touch-none" aria-label="长按拖动排序" /></span>{String(index + 1).padStart(2, "0")}</span><div className="col-span-3"><span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${egernRuleTagClass(rule.type)}`}>{rule.type}</span></div><div className="col-span-3 flex min-w-0 items-center gap-1 rounded bg-muted/70 px-1.5 py-1"><code className="min-w-0 flex-1 truncate text-[11px]">{ruleMatchLabel(rule)}</code>{rule.type === "rule_set" && ruleSetName(rule) && <Button variant="ghost" size="icon" className="size-5 shrink-0 text-cyan-700 hover:bg-cyan-500/10 hover:text-cyan-700 dark:text-cyan-300 dark:hover:text-cyan-300" aria-label={`打开规则集 ${ruleSetName(rule)}`} title={`打开规则集 ${ruleSetName(rule)}`} onClick={() => onOpenRuleSet?.(ruleSetName(rule))}><ArrowUpRight className="size-3.5" /></Button>}</div><div className="col-span-3"><span className={`inline-flex max-w-full rounded px-2 py-1 font-mono text-[11px] font-semibold ${direct ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : reject ? "bg-rose-500/15 text-rose-700 dark:text-rose-300" : "bg-primary/15 text-primary"}`}>{direct ? "➜ " : reject ? "⊘ " : ""}{rule.policy || "未指定"}</span></div><div className="col-span-2 flex justify-end gap-1"><Switch aria-label={`启用规则 ${index + 1}`} checked={!rule.disabled} onCheckedChange={(enabled) => onRulesChange(rules.map((item, position) => position === index ? { ...item, disabled: !enabled } : item))} /><Button variant="ghost" size="icon" className="size-7" aria-label="编辑规则" onClick={() => setEditor({ index, rule: { ...rule } })}><Code2 className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" aria-label="删除规则" onClick={() => onRulesChange(rules.filter((_, position) => position !== index))}><Trash2 className="size-3.5" /></Button></div></div>; })}{pointerSort.overlay}{!visible.length && <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">没有匹配的规则</div>}</div></div>
    </section>
    <section className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background lg:flex"><header className="border-b border-border bg-muted/30 px-4 py-3"><p className="text-sm font-semibold">Egern 原生规则</p><p className="mt-0.5 text-xs text-muted-foreground">启用状态、类型与目标会即时写入 YAML。</p></header><pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-6 text-muted-foreground">{stringify({ rules: rules.map(({ type, ...settings }) => ({ [type]: settings })) }, { lineWidth: 0 })}</pre></section>
    <EgernRuleDialog editor={editor} groups={groups} policyOptions={policyOptions} knownRuleSets={knownRuleSets} onEditorChange={setEditor} onSave={save} />
  </section>;
}

export function EgernVisualEditor({ value, view = "groups", onChange, onError, onDirtyChange, onOpenRuleSet, onFocusLine }: Props) {
  const [root, setRoot] = useState<Record<string, unknown>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [expandedRules, setExpandedRules] = useState<number[]>([]);
  const [ruleEditor, setRuleEditor] = useState<{ index: number | null; rule: Rule } | null>(null);
  const [memberPickerIndex, setMemberPickerIndex] = useState<number | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [groupRename, setGroupRename] = useState<{ index: number; previous: string; next: string; error?: string; references: Array<{ label: string; count: number }> } | null>(null);
  const [groupDelete, setGroupDelete] = useState<{ index: number; name: string; references: Array<{ label: string; count: number }> } | null>(null);
  const [referenceGroupIndex, setReferenceGroupIndex] = useState<number | null>(null);
  const groupNameInputs = useRef(new Map<number, HTMLInputElement>());
  const [rulesDirty, setRulesDirty] = useState(false);
  const previousOutput = useRef("");
  const groupDragIndex = useRef<number | null>(null);
  const ruleDragIndex = useRef<number | null>(null);
  const markDirty = () => { setRulesDirty(true); onDirtyChange(true); };
  useEffect(() => {
    try {
      const next = parse(value);
      setRoot(next.root);
      setGroups(next.groups);
      setRules(next.rules);
      onDirtyChange(false);
      onError("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Egern 格式错误");
    }
  }, [value]);
  const output = useMemo(
    () =>
      stringify(
        {
          ...root,
          policy_groups: groups.map(({ type, policies, externalType, ...settings }) => {
            if (type === "auto_test") {
              if (settings.urls === null) delete settings.urls;
              settings.latency_test_url = getLatencyTestURL({ type, policies, ...settings } as Group);
            }
            return {
              [type]: {
                ...settings,
                ...(type === "external" && externalType ? { type: externalType } : {}),
                ...((Array.isArray(policies) ? policies : []).filter(Boolean).length
                  ? { policies: (Array.isArray(policies) ? policies : []).filter(Boolean) }
                  : {}),
              },
            };
          }),
          rules: rules.map(({ type, ...settings }) => ({ [type]: settings })),
        },
        { lineWidth: 0 },
      ),
    [root, groups, rules],
  );
  const sync = () => {
    const names = groups.map((group) => group.name.trim());
    if (names.some((name) => !name) || new Set(names).size !== names.length) { onError("Egern 策略组名称必须非空且全局唯一"); return; }
    const knownRuleSets = ruleSetOptions(rules);
    const ruleSetNames = knownRuleSets.map((item) => item.name);
    if (new Set(ruleSetNames).size !== ruleSetNames.length) { onError("Egern 规则集名称必须唯一，才能安全引用"); return; }
    const invalidRule = rules.map((rule) => ruleValidation(rule, policyCandidates, knownRuleSets)).find(Boolean);
    if (invalidRule) { onError(invalidRule); return; }
    onChange(output); setRulesDirty(false); onDirtyChange(false);
  };
  // Keep rule edits in the parent template immediately, so the dialog-level
  // Save action cannot discard a pending Egern visual edit.
  useEffect(() => { if (rulesDirty) sync(); }, [rulesDirty, output]);
  useEffect(() => {
    const previous = previousOutput.current;
    previousOutput.current = output;
    if (!previous || previous === output) return;
    const before = previous.split("\n");
    const line = output.split("\n").findIndex((item, index) => item !== before[index]);
    onFocusLine?.(Math.max(1, line + 1));
  }, [output, onFocusLine]);
  const proxyNames = useMemo(() => {
    const proxies = Array.isArray(root.proxies) ? root.proxies : [];
    return proxies.flatMap((entry: any) => entry && typeof entry === "object" ? Object.values(entry as Record<string, any>) : [])
      .map((settings: any) => String(settings?.name || "").trim()).filter(Boolean);
  }, [root]);
  const policyCandidates = useMemo(() => [...new Set(["DIRECT", "REJECT", ...proxyNames, ...groups.map((group) => group.name.trim()).filter(Boolean)])], [groups, proxyNames]);
  const memberPickerGroup = memberPickerIndex === null ? null : groups[memberPickerIndex] || null;
  const memberCandidates = useMemo(() => {
    const query = memberQuery.trim().toLowerCase();
    return [...new Set(["DIRECT", "REJECT", ...groups.map((group) => group.name.trim()).filter(Boolean)])].filter((candidate) => candidate !== memberPickerGroup?.name && (!query || candidate.toLowerCase().includes(query)));
  }, [groups, memberPickerGroup?.name, memberQuery]);
  const groupRules = (name: string) =>
    rules
      .map((rule, index) => ({ rule, index }))
      .filter((item) => item.rule.policy === name);
  const renameGroup = (index: number, name: string, previousOverride?: string) => {
    const previous = previousOverride ?? groups[index]?.name;
    if (previous === undefined || previous === name) { setGroups((items) => items.map((item, position) => position === index ? { ...item, name } : item)); return; }
    // Egern allows policies in nested conditional rules too; update every
    // policy-bearing field while retaining unknown native settings.
    const renameReferences = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(renameReferences);
      if (!value || typeof value !== "object") return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(record).map(([key, current]) => [key,
        key === "policies" && Array.isArray(current) ? current.map((policy) => policy === previous ? name : policy) :
        (key === "policy" || key === "default_policy") && current === previous ? name : renameReferences(current),
      ]));
    };
    setGroups((items) => items.map((item, position) => {
      const renamed = renameReferences(item) as Group;
      return position === index ? { ...renamed, name } : renamed;
    }));
    setRules((items) => items.map((rule) => renameReferences(rule) as Rule));
  };
  const checkGroupRename = (index: number, previous: string, next: string) => {
    const trimmed = next.trim();
    if (previous === trimmed) { setGroups((items) => items.map((item, position) => position === index ? { ...item, name: previous } : item)); return; }
    const duplicate = groups.some((group, position) => position !== index && group.name.trim() === trimmed);
    setGroupRename({ index, previous, next: trimmed, error: !trimmed ? "名称不能为空" : duplicate ? "名称已被另一个策略组使用" : undefined, references: [
      { label: "流量规则", count: rules.filter((rule) => rule.type !== "rule_set" && rule.policy === previous).length },
      { label: "规则集的命中策略", count: rules.filter((rule) => rule.type === "rule_set" && rule.policy === previous).length },
      { label: "策略组成员（嵌套策略组）", count: groups.reduce((total, group) => total + group.policies.filter((policy) => policy === previous).length, 0) },
    ] });
  };
  const moveGroup = (index: number, amount: number) =>
    setGroups((items) => {
      const next = [...items];
      const target = index + amount;
      if (target < 0 || target >= next.length) return items;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const reorderRules = (from: number, to: number) => {
    if (from === to) return;
    markDirty();
    setRules((items) => { const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next; });
  };
  const reorderGroups = (from: number, to: number) => {
    if (from === to) return;
    markDirty();
    setGroups((items) => { const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next; });
  };
  const groupPointerSort = usePointerListSort(reorderGroups, (index) => <div className="flex min-h-11 w-[min(900px,calc(100vw-3rem))] items-center gap-2 rounded-md border border-primary/70 bg-card px-3 py-2.5 text-sm font-semibold shadow-2xl"><GripVertical className="size-4 shrink-0 text-muted-foreground" /><span>{groups[index]?.name || `未命名策略组 ${index + 1}`}</span><span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary">{typeLabels[groups[index]?.type || "select"] || groups[index]?.type || "select"}</span></div>);
  const rulePointerSort = usePointerListSort(reorderRules, (index) => <div className="flex w-[min(640px,calc(100vw-3rem))] items-center gap-3 rounded-md border border-primary/70 bg-card px-3 py-2.5 shadow-2xl"><GripVertical className="size-4 shrink-0 text-muted-foreground" /><b className="font-mono text-xs">{rules[index]?.type || "RULE"}</b><span className="truncate text-sm">{ruleMatchLabel(rules[index] || { type: "", policy: "" })}</span></div>);
  const groupReferenceDetails = (index: number) => { const name = groups[index]?.name || ""; return [{ label: "流量规则", items: rules.filter((rule) => rule.type !== "rule_set" && rule.policy === name).map((rule) => ({ primary: `${rule.type}: ${ruleMatchLabel(rule)} → ${name}`, onNavigate: () => { setReferenceGroupIndex(null); } })) }, { label: "规则集的命中策略", items: rules.filter((rule) => rule.type === "rule_set" && rule.policy === name).map((rule) => ({ primary: `${ruleSetName(rule)} → ${name}`, onNavigate: () => { setReferenceGroupIndex(null); onOpenRuleSet?.(ruleSetName(rule)); } })) }, { label: "策略组成员（嵌套策略组）", items: groups.filter((group) => group.policies.includes(name)).map((group) => ({ primary: `${group.name} 的成员包含 ${name}`, onNavigate: () => setReferenceGroupIndex(null) })) }]; };
  const requestRemoveGroup = (index: number) => { const name = groups[index]?.name || ""; setGroupDelete({ index, name, references: [{ label: "流量规则", count: rules.filter((rule) => rule.type !== "rule_set" && rule.policy === name).length }, { label: "规则集的命中策略", count: rules.filter((rule) => rule.type === "rule_set" && rule.policy === name).length }, { label: "策略组成员（嵌套策略组）", count: groups.reduce((total, group) => total + group.policies.filter((policy) => policy === name).length, 0) }] }); };
  const removeGroup = (direct: boolean) => {
    if (!groupDelete) return;
    markDirty();
    const { index, name } = groupDelete;
    setGroups((items) => items.filter((_, position) => position !== index).map((group) => ({ ...group, policies: group.policies.filter((policy) => policy !== name) })));
    setRules((items) => direct ? items.map((rule) => rule.policy === name ? { ...rule, policy: "DIRECT" } : rule) : items.filter((rule) => rule.policy !== name));
    setExpanded((items) => items.filter((position) => position !== index).map((position) => position > index ? position - 1 : position));
    setExpandedRules((items) => items.filter((position) => position !== index).map((position) => position > index ? position - 1 : position));
    setGroupDelete(null);
  };
  const allGroupsExpanded = groups.length > 0 && expanded.length === groups.length;
  if (view === "rules") return <EgernRuleWorkspace
    groups={groups}
    rules={rules}
    policyOptions={policyCandidates}
    knownRuleSets={ruleSetOptions(rules)}
    onRulesChange={(next) => { markDirty(); setRules(next); }}
    onOpenRuleSet={onOpenRuleSet}
  />;
  return (
    <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3" onChangeCapture={markDirty} onPointerMove={(event) => { groupPointerSort.move(event); rulePointerSort.move(event); }} onPointerUp={(event) => { groupPointerSort.end(event); rulePointerSort.end(event); }} onPointerCancel={(event) => { groupPointerSort.end(event); rulePointerSort.end(event); }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <strong className="text-sm">策略组 <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">{groups.length}</span></strong>
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setExpanded(allGroupsExpanded ? [] : groups.map((_, index) => index))}>{allGroupsExpanded ? "全部收起" : "全部展开"}</Button><Button
          size="sm"
          onClick={() => {
            markDirty();
            setGroups((items) => [
              ...items,
              {
                name: `策略组 ${items.length + 1}`,
                type: "select",
                policies: ["DIRECT"],
              },
            ]);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          添加策略组
        </Button></div>
      </div>
      {groups.map((group, index) => (
        <article
          key={index}
          data-pointer-sort-index={index}
          className="mb-3 rounded-md border border-border/70"
        >
          <div
            className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left text-sm font-semibold"
          >
            <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() =>
              setExpanded((items) =>
                items.includes(index)
                  ? items.filter((item) => item !== index)
                  : [...items, index],
              )
            }
          >
              <span onPointerDown={(event) => groupPointerSort.begin(index, event)}><GripVertical className="size-4 shrink-0 cursor-grab touch-none text-muted-foreground" aria-label="长按拖动排序" /></span>
              {typeof group.icon === "string" && /^https?:\/\//i.test(group.icon) ? <img src={group.icon} alt="" className="size-4 shrink-0 rounded object-contain" /> : group.icon ? <ImageIcon className="size-4 shrink-0 text-primary" aria-label={String(group.icon)} /> : null}
              <span className="truncate">{group.name || `未命名策略组 ${index + 1}`}</span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary">{typeLabels[group.type] || group.type}</span>
            </button>
            <Button variant="ghost" size="icon" className="size-7" disabled={!index} onClick={() => { markDirty(); moveGroup(index, -1); }}><ChevronUp className="size-4" /></Button>
            <Button variant="ghost" size="icon" className="size-7" disabled={index === groups.length - 1} onClick={() => { markDirty(); moveGroup(index, 1); }}><ChevronDown className="size-4" /></Button>
            <Button variant="ghost" size="icon" className="size-7" title="查看引用关系" onClick={() => setReferenceGroupIndex(index)}><ArrowUpRight className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" onClick={() => requestRemoveGroup(index)}><Trash2 className="size-4" /></Button>
          </div>
          {expanded.includes(index) && (
            <div className="flex flex-col gap-4 border-t border-border bg-muted/20 p-4">
              <div className="order-1 grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-medium">策略组名称<Input
                  value={group.name}
                  placeholder="策略组名称"
                  ref={(element) => { if (element) groupNameInputs.current.set(index, element); else groupNameInputs.current.delete(index); }}
                  onFocus={(event) => { event.currentTarget.dataset.previousName = group.name; }}
                  onChange={(event) => setGroups((items) => items.map((item, position) => position === index ? { ...item, name: event.target.value } : item))}
                  onBlur={(event) => checkGroupRename(index, event.currentTarget.dataset.previousName || group.name, event.target.value)}
                /></label>
                <label className="grid gap-1.5 text-xs font-medium">组类型<Select
                  value={group.type}
                  onValueChange={(type) => {
                    markDirty();
                    setGroups((items) =>
                      items.map((item, position) =>
                        position === index
                          ? {
                              ...item,
                              type,
                              ...(type === "auto_test" ? { latency_test_url: getLatencyTestURL(item) } : {}),
                            }
                          : item,
                      ),
                    );
                  }}
                >
                  <SelectTrigger className="h-10 border-input bg-background"><SelectValue /></SelectTrigger>
                  <SelectContent>{types.map((type) => <SelectItem key={type} value={type}>{typeLabels[type]}</SelectItem>)}</SelectContent>
                </Select></label>
              </div>
              {group.type !== "external" && group.type !== "conditional" && <section className="order-4 space-y-2">
                <div className="flex items-center justify-between text-xs font-medium"><span>策略组成员</span><span className="text-muted-foreground">已选 {group.policies.filter(Boolean).length} 项</span></div>
                <div className="space-y-2">{group.policies.filter(Boolean).map((policy, policyIndex) => <div key={`${policy}-${policyIndex}`} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm"><GripVertical className="size-4 text-muted-foreground" /><span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{["DIRECT", "REJECT"].includes(policy) ? "BUILT-IN" : "GROUP"}</span><span className="min-w-0 flex-1 truncate">{policy}</span><Button variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive" onClick={() => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, policies: item.policies.filter((_, currentIndex) => currentIndex !== policyIndex) } : item)); }}>移除</Button></div>)}</div>
                <Button variant="outline" className="w-full border-dashed" onClick={() => { setMemberQuery(""); setMemberPickerIndex(index); }}><Plus className="mr-1 size-4" />添加成员</Button>
              </section>}
              {group.type !== "conditional" && <section className="order-3 grid gap-3 sm:grid-cols-2">
                <label className="order-1 grid gap-1 text-xs font-medium">图标（icon）<Input value={String(group.icon || "")} onChange={(event) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, icon: event.target.value || undefined } : item)); }} placeholder="SF Symbol 或 URL" /></label>
                <label className="order-3 grid gap-1 text-xs font-medium">筛选关键词（filter）<Input value={String(group.filter || "")} onChange={(event) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, filter: event.target.value || undefined } : item)); }} placeholder="例如：香港|HK|Hong Kong" /></label>
                <label className="order-4 grid gap-1 text-xs font-medium">排除关键词（exclude_filter）<Input value={String(group.exclude_filter || "")} onChange={(event) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, exclude_filter: event.target.value || undefined } : item)); }} placeholder="例如：游戏|IPLC|Traffic" /></label>
                <label className="order-2 flex h-10 self-end items-center justify-between rounded border border-border bg-background px-3 text-xs"><span>在 Egern UI 隐藏（hidden）</span><Switch checked={group.hidden === true} onCheckedChange={(hidden) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, hidden } : item)); }} /></label>
              </section>}
              {group.type === "conditional" && <section className="order-2 grid gap-3 rounded-lg border border-border bg-muted/15 p-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-medium">环境规则（rules，JSON 数组）<Input value={Array.isArray(group.rules) ? JSON.stringify(group.rules) : ""} onChange={(event) => { try { const rules = event.target.value ? JSON.parse(event.target.value) : []; if (!Array.isArray(rules)) return; markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, rules } : item)); } catch { /* 仅在 JSON 有效时写入 */ } }} placeholder='[{"ssid":{"match":"Home-*","policy":"DIRECT"}}]' /></label><label className="grid gap-1 text-xs font-medium">默认策略（default_policy）<Input value={String(group.default_policy || "DIRECT")} onChange={(event) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, default_policy: event.target.value } : item)); }} /></label><label className="grid gap-1 text-xs font-medium">图标（icon）<Input value={String(group.icon || "")} onChange={(event) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, icon: event.target.value || undefined } : item)); }} /></label><label className="flex items-center justify-between rounded border border-border bg-background px-3 py-2 text-xs"><span>在 Egern UI 隐藏（hidden）</span><Switch checked={group.hidden === true} onCheckedChange={(hidden) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, hidden } : item)); }} /></label></section>}
              {group.type === "external" && <label className="order-2 grid gap-1 text-xs font-medium">订阅节点选择策略（type）<Select value={String((group as any).externalType || "select")} onValueChange={(externalType) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, externalType } : item)); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["select", "auto_test", "smart", "fallback", "load_balance"].map((type) => <SelectItem key={type} value={type}>{typeLabels[type]}</SelectItem>)}</SelectContent></Select></label>}
              {(group.type === "auto_test" || (group.type === "external" && (group as any).externalType === "auto_test")) && <div className="order-2 grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-medium">测速 URL<Input value={getLatencyTestURL(group)} placeholder={defaultLatencyTestURL} onChange={(event) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, latency_test_url: event.target.value } : item)); }} /></label><label className="grid gap-1 text-xs font-medium">检查间隔（interval）<Input inputMode="numeric" value={group.interval === undefined ? "" : String(group.interval)} onChange={(event) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, interval: event.target.value === "" ? undefined : Number(event.target.value) } : item)); }} placeholder="600" /></label></div>}
              {(group.type === "load_balance" || (group.type === "external" && (group as any).externalType === "load_balance")) && <label className="order-4 grid gap-1 text-xs font-medium">负载均衡算法<Select value={String(group.algorithm || "hash")} onValueChange={(algorithm) => { markDirty(); setGroups((items) => items.map((item, position) => position === index ? { ...item, algorithm } : item)); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="hash">hash（按目标固定）</SelectItem><SelectItem value="round_robin">round_robin（轮询）</SelectItem></SelectContent></Select></label>}
              <section className="order-5 border-t border-border/70 pt-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <button
                    className="flex items-center gap-2 text-left text-xs font-semibold text-foreground"
                    onClick={() => setExpandedRules((items) => items.includes(index) ? items.filter((item) => item !== index) : [...items, index])}
                  >
                    流量规则
                    <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary">
                      {groupRules(group.name).length} 条规则
                    </span>
                  </button>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-primary/40 bg-primary/10 px-2.5 text-xs text-primary hover:bg-primary/15 hover:text-primary"
                      onClick={() => setRuleEditor({ index: null, rule: { type: "domain_suffix", match: "", policy: group.name } })}
                    >
                      <Plus className="mr-1 size-3.5" />添加规则
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpandedRules((items) => items.includes(index) ? items.filter((item) => item !== index) : [...items, index])}>
                      {expandedRules.includes(index) ? <ChevronUp className="mr-1 size-3.5" /> : <ChevronDown className="mr-1 size-3.5" />}
                      {expandedRules.includes(index) ? "收起" : "展开"}
                    </Button>
                  </div>
                </div>
                {expandedRules.includes(index) && (
                  <div className="overflow-hidden rounded-lg border border-border bg-background">
                    <div className="grid grid-cols-12 gap-2 border-b border-border bg-muted/55 px-3 py-2 font-sans text-[11px] font-medium text-muted-foreground">
                      <div className="col-span-3">规则类型</div><div className="col-span-4">匹配目标值</div><div className="col-span-3">指向策略 / 节点</div><div className="col-span-2 pr-1 text-right">操作</div>
                    </div>
                    <div className="max-h-64 divide-y divide-border/70 overflow-y-auto font-mono text-xs">
                      {groupRules(group.name).map(({ rule, index: ruleIndex }) => {
                        const directTarget = ["DIRECT", "REJECT"].includes(rule.policy);
                        return <div key={ruleIndex} data-pointer-sort-index={ruleIndex} className="grid grid-cols-12 items-center gap-2 px-3 py-2.5 transition-colors hover:bg-muted/45">
                          <div className="col-span-3 flex min-w-0 items-center gap-1"><span onPointerDown={(event) => rulePointerSort.begin(ruleIndex, event)}><GripVertical className="size-4 shrink-0 cursor-grab touch-none text-muted-foreground" aria-label="长按拖动排序" /></span><span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${egernRuleTagClass(rule.type)}`}>{rule.type}</span></div>
                          <div className="col-span-4 flex min-w-0 items-center gap-1"><div className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={String(rule.match || "")}>{ruleMatchLabel(rule)}</div>{rule.type === "rule_set" && ruleSetName(rule) && <Button variant="ghost" size="icon" className="size-6 shrink-0 text-cyan-700 hover:bg-cyan-500/10 hover:text-cyan-700 dark:text-cyan-300 dark:hover:text-cyan-300" aria-label={`打开规则集 ${ruleSetName(rule)}`} title={`打开规则集 ${ruleSetName(rule)}`} onClick={() => onOpenRuleSet?.(ruleSetName(rule))}><ArrowUpRight className="size-3.5" /></Button>}</div>
                          <div className={`col-span-3 min-w-0 truncate font-sans text-[11px] ${directTarget ? "text-sky-700 dark:text-sky-300" : "text-primary"}`}><span className="truncate font-medium">{rule.policy}</span></div>
                          <div className="col-span-2 flex items-center justify-end gap-1.5 font-sans"><Switch aria-label="启用规则" checked={!rule.disabled} onCheckedChange={(enabled) => { markDirty(); setRules((items) => items.map((item, position) => position === ruleIndex ? { ...item, disabled: !enabled } : item)); }} /><Button variant="ghost" size="sm" className="h-7 px-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setRuleEditor({ index: ruleIndex, rule: { ...rule } })}>编辑</Button><Button variant="ghost" size="sm" className="h-7 px-1 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => { markDirty(); setRules((items) => items.filter((_, position) => position !== ruleIndex)); }}>删除</Button></div>
                        </div>;
                      })}
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </article>
      ))}
      {!groups.length && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          暂无策略组
        </p>
      )}
      {groupPointerSort.overlay}{rulePointerSort.overlay}
      <Dialog open={memberPickerGroup !== null} onOpenChange={(open) => !open && setMemberPickerIndex(null)}><DialogContent className="max-w-[900px] gap-0 overflow-hidden p-0"><DialogHeader className="border-b border-border bg-muted/30 px-6 py-5"><DialogTitle>添加成员到策略组</DialogTitle><p className="mt-1 text-sm text-muted-foreground">{memberPickerGroup?.name || "未命名策略组"} · 选择策略组或内置动作；节点由服务器动态注入，无需写入模板。</p></DialogHeader><div className="grid max-h-[min(600px,calc(100svh-13rem))] min-h-0 md:grid-cols-2"><section className="min-h-0 overflow-auto p-5"><div className="relative mb-4"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} className="pl-9" placeholder="搜索策略组或内置动作" /></div><div className="space-y-2">{memberCandidates.map((candidate) => { const selected = Boolean(memberPickerGroup?.policies.includes(candidate)); return <button type="button" key={candidate} className="flex w-full items-center gap-3 rounded-lg border border-border bg-muted/20 p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5" onClick={() => { if (memberPickerIndex === null || !memberPickerGroup) return; markDirty(); setGroups((items) => items.map((item, position) => position === memberPickerIndex ? { ...item, policies: selected ? item.policies.filter((value) => value !== candidate) : [...item.policies, candidate] } : item)); }}><span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{["DIRECT", "REJECT"].includes(candidate) ? "BUILT-IN" : "GROUP"}</span><span className="flex-1 font-medium">{candidate}</span>{selected ? <span className="text-primary">已选</span> : <Plus className="size-4 text-muted-foreground" />}</button>; })}</div></section><section className="min-h-0 overflow-auto border-t border-border bg-muted/15 p-5 md:border-l md:border-t-0"><div className="mb-3 flex items-center justify-between"><strong>已选成员</strong><span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{memberPickerGroup?.policies.filter(Boolean).length || 0} 项</span></div><div className="space-y-2">{memberPickerGroup?.policies.filter(Boolean).map((member, position, members) => <div key={`${member}-${position}`} className="flex items-center gap-2 rounded-lg border border-border bg-card p-3"><GripVertical className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm">{member}</span><Button variant="ghost" size="icon" className="size-8" disabled={!position} onClick={() => { if (memberPickerIndex === null) return; markDirty(); setGroups((items) => items.map((item, index) => index === memberPickerIndex ? { ...item, policies: members.map((value, current) => current === position ? members[position - 1] : current === position - 1 ? members[position] : value) } : item)); }}><ChevronUp className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8" disabled={position === members.length - 1} onClick={() => { if (memberPickerIndex === null) return; markDirty(); setGroups((items) => items.map((item, index) => index === memberPickerIndex ? { ...item, policies: members.map((value, current) => current === position ? members[position + 1] : current === position + 1 ? members[position] : value) } : item)); }}><ChevronDown className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-destructive" onClick={() => { if (memberPickerIndex === null) return; markDirty(); setGroups((items) => items.map((item, index) => index === memberPickerIndex ? { ...item, policies: item.policies.filter((_, current) => current !== position) } : item)); }}><Trash2 className="size-4" /></Button></div>)}</div></section></div><DialogFooter className="border-t border-border bg-muted/30 px-6 py-4"><Button onClick={() => setMemberPickerIndex(null)}>确认成员</Button></DialogFooter></DialogContent></Dialog>
      <EgernRuleDialog editor={ruleEditor} groups={groups} policyOptions={policyCandidates} knownRuleSets={ruleSetOptions(rules)} onEditorChange={setRuleEditor} onSave={() => {
        if (!ruleEditor) return;
        const error = ruleValidation(ruleEditor.rule, policyCandidates, ruleSetOptions(rules));
        if (error) { window.alert(error); return; }
        markDirty();
        setRules((items) => ruleEditor.index === null ? [...items, ruleEditor.rule] : items.map((item, position) => position === ruleEditor.index ? ruleEditor.rule : item));
        setRuleEditor(null);
      }} />
      {referenceGroupIndex !== null && <ReferenceDetailsDialog open title="策略组引用关系" name={groups[referenceGroupIndex]?.name || ""} sections={groupReferenceDetails(referenceGroupIndex)} onOpenChange={() => setReferenceGroupIndex(null)} />}
      {groupDelete && <DeletePolicyGroupDialog open name={groupDelete.name} references={groupDelete.references} onCancel={() => setGroupDelete(null)} onRemoveRules={() => removeGroup(false)} onUseDirect={() => removeGroup(true)} />}
      {groupRename && <RenameConfirmationDialog open kind="策略组" previous={groupRename.previous} next={groupRename.next} error={groupRename.error} references={groupRename.references} onReturn={() => { const pending = groupRename; setGroupRename(null); requestAnimationFrame(() => groupNameInputs.current.get(pending.index)?.focus()); }} onCancel={() => { const pending = groupRename; setGroups((items) => items.map((item, position) => position === pending.index ? { ...item, name: pending.previous } : item)); setGroupRename(null); }} onConfirm={() => { const pending = groupRename; renameGroup(pending.index, pending.next, pending.previous); setGroupRename(null); }} />}
    </section>
  );
}
