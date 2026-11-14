import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Code2, GripVertical, Plus, Search, Trash2 } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ruleSetDisplayName } from "./ruleSetName";
import { usePointerListSort } from "./usePointerListSort";

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
    const { policies, ...rest } = normalized;
    const group = {
      name: "",
      type,
      ...rest,
      policies: Array.isArray(policies) ? policies.map(String) : [],
    } as Group;
    if (group.type === "auto_test") {
      if (group.urls === null) delete group.urls;
      group.latency_test_url = getLatencyTestURL(group);
    }
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
  { label: "网络与高级", types: ["dest_port", "protocol", "user_agent", "rule_set", "default"] },
];
const egernRuleDescriptions: Record<string, string> = {
  domain: "精确域名", domain_suffix: "域名及子域", domain_keyword: "域名关键词", domain_regex: "域名正则", domain_wildcard: "域名通配", url_regex: "URL 正则",
  geoip: "地区 IP", ip_cidr: "IPv4 网段", ip_cidr6: "IPv6 网段", asn: "自治系统", dest_port: "目标端口", protocol: "协议", user_agent: "用户代理", rule_set: "引用规则集", default: "其余全部流量",
};
const ruleSetName = (rule: Rule) => typeof rule.name === "string" && rule.name.trim() ? rule.name : ruleSetDisplayName(String(rule.match || ""), "规则集");
const ruleMatchLabel = (rule: Rule) => rule.type === "rule_set" ? ruleSetName(rule) : rule.type === "default" ? "匹配其余全部流量" : rule.match || "未填写";
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
  onEditorChange,
  onSave,
}: {
  editor: { index: number | null; rule: Rule } | null;
  groups: Group[];
  onEditorChange: (editor: { index: number | null; rule: Rule } | null) => void;
  onSave: () => void;
}) {
  const policyOptions = ["DIRECT", "REJECT", ...groups.map((group) => group.name.trim()).filter(Boolean)];
  if (!editor) return null;
  const selectType = (type: string) => onEditorChange({ ...editor, rule: { ...editor.rule, type, ...(type === "default" ? { match: undefined } : {}) } });
  const setPolicy = (policy: string) => onEditorChange({ ...editor, rule: { ...editor.rule, policy } });
  return <Dialog open onOpenChange={(open) => !open && onEditorChange(null)}>
    <DialogContent className="max-h-[calc(100svh-2rem)] max-w-4xl overflow-y-auto p-0">
      <DialogHeader className="border-b border-border px-6 py-5"><DialogTitle>{editor.index === null ? "新建流量规则" : "编辑流量规则"}</DialogTitle><p className="text-sm text-muted-foreground">规则会关联到当前策略组，并实时写入右侧预览。</p></DialogHeader>
      <div className="space-y-5 px-6 py-5">
        <section className="rounded-xl border border-border bg-muted/20 p-4"><p className="mb-3 text-sm font-semibold">匹配类型</p><div className="space-y-3">{egernRuleTypeGroups.map((group) => <div key={group.label}><p className="mb-2 text-xs font-medium text-muted-foreground">{group.label}</p><div className="flex flex-wrap gap-2">{group.types.map((type) => <button key={type} type="button" onClick={() => selectType(type)} className={`w-32 rounded-lg border p-2 text-left transition-colors ${editor.rule.type === type ? "border-primary bg-primary/10 text-primary" : "border-border bg-background hover:border-primary/50"}`}><b className="block font-mono text-xs">{type.toUpperCase()}</b><span className="mt-1 block text-[11px] leading-tight text-muted-foreground">{egernRuleDescriptions[type]}</span></button>)}</div></div>)}</div></section>
        <div className="grid gap-4 md:grid-cols-2">
          {editor.rule.type === "default" ? <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">MATCH 会匹配所有尚未命中的流量。</div> : <label className="grid gap-1.5 text-sm font-medium">规则参数<Input value={editor.rule.type === "rule_set" ? ruleSetName(editor.rule) : editor.rule.match || ""} onChange={(event) => onEditorChange({ ...editor, rule: editor.rule.type === "rule_set" ? { ...editor.rule, name: event.target.value } : { ...editor.rule, match: event.target.value } })} placeholder={editor.rule.type === "rule_set" ? "规则集名称" : "请输入匹配内容"} className="font-mono" /></label>}
          <label className="grid gap-1.5 text-sm font-medium">路由目标<Select value={policyOptions.includes(editor.rule.policy) ? editor.rule.policy : "__custom"} onValueChange={(policy) => policy !== "__custom" && setPolicy(policy)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{!policyOptions.includes(editor.rule.policy) && <SelectItem value="__custom">{editor.rule.policy || "自定义目标"}</SelectItem>}{policyOptions.map((policy) => <SelectItem key={policy} value={policy}>{policy === "DIRECT" ? "DIRECT（直连）" : policy === "REJECT" ? "REJECT（拒绝）" : policy}</SelectItem>)}</SelectContent></Select><Input value={editor.rule.policy} onChange={(event) => setPolicy(event.target.value)} placeholder="或输入策略组名称" /></label>
        </div>
        <label className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 text-xs"><span><b className="block">启用规则</b><small className="text-muted-foreground">关闭后保留在模板中，但不参与匹配。</small></span><Switch checked={!editor.rule.disabled} onCheckedChange={(enabled) => onEditorChange({ ...editor, rule: { ...editor.rule, disabled: !enabled } })} /></label>
      </div>
      <DialogFooter className="border-t border-border bg-muted/20 px-6 py-4"><Button variant="outline" onClick={() => onEditorChange(null)}>取消</Button><Button onClick={onSave}>应用规则</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function EgernRuleWorkspace({ groups, rules, onRulesChange }: { groups: Group[]; rules: Rule[]; onRulesChange: (rules: Rule[]) => void }) {
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
    if (rule.type === "default") delete rule.match;
    onRulesChange(editor.index === null ? [...rules, rule] : rules.map((item, index) => index === editor.index ? rule : item));
    setEditor(null);
  };
  return <section className="grid min-h-0 flex-1 gap-4 overflow-hidden bg-muted/20 p-4 lg:grid-cols-[minmax(0,1.04fr)_minmax(380px,.96fr)]">
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="border-b border-border bg-muted/30 px-4 py-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">全量分流规则 <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">{rules.length}</span></p><p className="mt-0.5 text-xs text-muted-foreground">按从上到下顺序匹配；命中首条规则即停止。</p></div><Button size="sm" onClick={() => setEditor({ index: null, rule: { type: "domain_suffix", match: "", policy: groups[0]?.name || "DIRECT" } })}><Plus className="mr-1 size-4" />新建规则</Button></div><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant={filter === "all" ? "secondary" : "outline"} className="h-7 text-xs" onClick={() => setFilter("all")}>全部全局（{rules.length}）</Button><Button size="sm" variant={filter === "direct" ? "secondary" : "outline"} className="h-7 border-emerald-500/30 text-xs text-emerald-700 dark:text-emerald-300" onClick={() => setFilter("direct")}>DIRECT 直连（{count("direct")}）</Button><Button size="sm" variant={filter === "reject" ? "secondary" : "outline"} className="h-7 border-rose-500/30 text-xs text-rose-700 dark:text-rose-300" onClick={() => setFilter("reject")}>REJECT 拦截（{count("reject")}）</Button>{count("orphan") > 0 && <Button size="sm" variant={filter === "orphan" ? "destructive" : "outline"} className="h-7 text-xs" onClick={() => setFilter("orphan")}>未归属异常（{count("orphan")}）</Button>}<div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-7 pl-7 text-xs" placeholder="过滤规则类型、匹配值或目标" /></div></div></header>
      {count("orphan") > 0 && filter !== "direct" && filter !== "reject" && <div className="m-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">检测到 {count("orphan")} 条目标策略组不存在的规则。请重新指定可用策略。</div>}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain" onPointerMove={pointerSort.move} onPointerUp={pointerSort.end} onPointerCancel={pointerSort.end}><div className="min-w-[650px]"><div className="grid grid-cols-12 gap-2 border-b border-border bg-muted/50 px-3 py-2 text-[10px] font-medium text-muted-foreground"><span className="col-span-1">#</span><span className="col-span-3">规则类型</span><span className="col-span-3">匹配载荷</span><span className="col-span-3">路由目标</span><span className="col-span-2 text-right">操作</span></div>{visible.map(({ rule, index }) => { const direct = rule.policy === "DIRECT"; const reject = rule.policy === "REJECT"; return <div key={index} data-pointer-sort-index={index} className="grid grid-cols-12 items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0 hover:bg-muted/35"><span className="col-span-1 flex items-center gap-1 font-mono text-[11px] text-muted-foreground"><span onPointerDown={(event) => pointerSort.begin(index, event)}><GripVertical className="size-4 cursor-grab touch-none" aria-label="长按拖动排序" /></span>{String(index + 1).padStart(2, "0")}</span><div className="col-span-3"><span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${egernRuleTagClass(rule.type)}`}>{rule.type}</span></div><code className="col-span-3 truncate rounded bg-muted/70 px-1.5 py-1 text-[11px]">{ruleMatchLabel(rule)}</code><div className="col-span-3"><span className={`inline-flex max-w-full rounded px-2 py-1 font-mono text-[11px] font-semibold ${direct ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : reject ? "bg-rose-500/15 text-rose-700 dark:text-rose-300" : "bg-primary/15 text-primary"}`}>{direct ? "➜ " : reject ? "⊘ " : ""}{rule.policy || "未指定"}</span></div><div className="col-span-2 flex justify-end gap-1"><Switch aria-label={`启用规则 ${index + 1}`} checked={!rule.disabled} onCheckedChange={(enabled) => onRulesChange(rules.map((item, position) => position === index ? { ...item, disabled: !enabled } : item))} /><Button variant="ghost" size="icon" className="size-7" aria-label="编辑规则" onClick={() => setEditor({ index, rule: { ...rule } })}><Code2 className="size-3.5" /></Button><Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" aria-label="删除规则" onClick={() => onRulesChange(rules.filter((_, position) => position !== index))}><Trash2 className="size-3.5" /></Button></div></div>; })}{pointerSort.overlay}{!visible.length && <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">没有匹配的规则</div>}</div></div>
    </section>
    <section className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background lg:flex"><header className="border-b border-border bg-muted/30 px-4 py-3"><p className="text-sm font-semibold">Egern 原生规则</p><p className="mt-0.5 text-xs text-muted-foreground">启用状态、类型与目标会即时写入 YAML。</p></header><pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-6 text-muted-foreground">{stringify({ rules: rules.map(({ type, ...settings }) => ({ [type]: settings })) }, { lineWidth: 0 })}</pre></section>
    <EgernRuleDialog editor={editor} groups={groups} onEditorChange={setEditor} onSave={save} />
  </section>;
}

export function EgernVisualEditor({ value, view = "groups", onChange, onError, onDirtyChange }: Props) {
  const [root, setRoot] = useState<Record<string, unknown>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [expandedRules, setExpandedRules] = useState<number[]>([]);
  const [ruleEditor, setRuleEditor] = useState<{ index: number | null; rule: Rule } | null>(null);
  const [rulesDirty, setRulesDirty] = useState(false);
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
          policy_groups: groups.map(({ type, policies, ...settings }) => {
            if (type === "auto_test") {
              if (settings.urls === null) delete settings.urls;
              settings.latency_test_url = getLatencyTestURL({ type, policies, ...settings } as Group);
            }
            return {
              [type]: {
                ...settings,
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
  const sync = () => { onChange(output); setRulesDirty(false); onDirtyChange(false); };
  // Keep rule edits in the parent template immediately, so the dialog-level
  // Save action cannot discard a pending Egern visual edit.
  useEffect(() => { if (rulesDirty) sync(); }, [rulesDirty, output]);
  const groupRules = (name: string) =>
    rules
      .map((rule, index) => ({ rule, index }))
      .filter((item) => item.rule.policy === name);
  const renameGroup = (index: number, name: string) => {
    const previous = groups[index]?.name;
    setGroups((items) => items.map((item, position) => position === index ? { ...item, name } : item));
    if (previous !== undefined && previous !== name) {
      setRules((items) => items.map((rule) => rule.policy === previous ? { ...rule, policy: name } : rule));
    }
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
  const groupPointerSort = usePointerListSort(reorderGroups, (index) => <div className="flex min-h-11 w-[min(900px,calc(100vw-3rem))] items-center gap-2 rounded-md border border-primary/70 bg-card px-3 py-2.5 text-sm font-semibold shadow-2xl"><GripVertical className="size-4 shrink-0 text-muted-foreground" /><span>{groups[index]?.name || `未命名策略组 ${index + 1}`}</span><span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary">{groups[index]?.type || "select"}</span></div>);
  const rulePointerSort = usePointerListSort(reorderRules, (index) => <div className="flex w-[min(640px,calc(100vw-3rem))] items-center gap-3 rounded-md border border-primary/70 bg-card px-3 py-2.5 shadow-2xl"><GripVertical className="size-4 shrink-0 text-muted-foreground" /><b className="font-mono text-xs">{rules[index]?.type || "RULE"}</b><span className="truncate text-sm">{ruleMatchLabel(rules[index] || { type: "", policy: "" })}</span></div>);
  const removeGroup = (index: number) => {
    markDirty();
    const name = groups[index]?.name;
    setGroups((items) => items.filter((_, position) => position !== index));
    setRules((items) => items.filter((rule) => rule.policy !== name));
    setExpanded((items) => items.filter((position) => position !== index).map((position) => position > index ? position - 1 : position));
    setExpandedRules((items) => items.filter((position) => position !== index).map((position) => position > index ? position - 1 : position));
  };
  if (view === "rules") return <EgernRuleWorkspace
    groups={groups}
    rules={rules}
    onRulesChange={(next) => { markDirty(); setRules(next); }}
  />;
  return (
    <section className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3" onChangeCapture={markDirty} onPointerMove={(event) => { groupPointerSort.move(event); rulePointerSort.move(event); }} onPointerUp={(event) => { groupPointerSort.end(event); rulePointerSort.end(event); }} onPointerCancel={(event) => { groupPointerSort.end(event); rulePointerSort.end(event); }}>
      <div className="mb-3 flex items-center justify-between">
        <strong className="text-sm">Egern 策略组 · {groups.length}</strong>
        <Button
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
        </Button>
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
              <span className="truncate">{group.name || `未命名策略组 ${index + 1}`}</span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary">{group.type}</span>
            </button>
            <Button variant="ghost" size="icon" className="size-7" disabled={!index} onClick={() => { markDirty(); moveGroup(index, -1); }}><ChevronUp className="size-4" /></Button>
            <Button variant="ghost" size="icon" className="size-7" disabled={index === groups.length - 1} onClick={() => { markDirty(); moveGroup(index, 1); }}><ChevronDown className="size-4" /></Button>
            <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" onClick={() => removeGroup(index)}><Trash2 className="size-4" /></Button>
          </div>
          {expanded.includes(index) && (
            <div className="space-y-3 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  value={group.name}
                  placeholder="策略组名称"
                  onChange={(event) => renameGroup(index, event.target.value)}
                />
                <Select
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
                  <SelectContent>{types.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Input
                value={group.policies.join(", ")}
                placeholder="策略组成员"
                onChange={(event) =>
                  setGroups((items) =>
                    items.map((item, position) =>
                      position === index
                        ? {
                            ...item,
                            policies: event.target.value
                              .split(",")
                              .map((item) => item.trim()),
                          }
                        : item,
                    ),
                  )
                }
              />
              {group.type === "auto_test" && (
                <label className="grid gap-1.5 text-xs font-medium">
                  测速 URL
                  <Input
                    value={getLatencyTestURL(group)}
                    placeholder={defaultLatencyTestURL}
                    onChange={(event) => setGroups((items) =>
                      items.map((item, position) => position === index
                        ? { ...item, latency_test_url: event.target.value }
                        : item,
                      ),
                    )}
                  />
                </label>
              )}
              <section className="border-t border-border/70 pt-3">
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
                          <div className="col-span-4 min-w-0"><div className="truncate text-[11px] text-foreground" title={String(rule.match || "")}>{ruleMatchLabel(rule)}</div></div>
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
      <EgernRuleDialog editor={ruleEditor} groups={groups} onEditorChange={setRuleEditor} onSave={() => {
        if (!ruleEditor) return;
        markDirty();
        setRules((items) => ruleEditor.index === null ? [...items, ruleEditor.rule] : items.map((item, position) => position === ruleEditor.index ? ruleEditor.rule : item));
        setRuleEditor(null);
      }} />
    </section>
  );
}
