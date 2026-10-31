import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FileText, Globe2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ruleSetPolicyOptions } from "./ruleSetPolicies";
import { ruleSetDisplayName } from "./ruleSetName";

type TemplateKind = "clash" | "egern" | "loon";
type RuleSet = {
  id: string;
  name: string;
  source: string;
  path?: string;
  sourceType: "http" | "file";
  behavior?: string;
  format?: string;
  policy?: string;
  interval?: string;
  enabled: boolean;
  /** 不在规则集面板直接展示的原生字段，编辑后必须保留。 */
  extra?: Record<string, unknown>;
  /** Egern 原 rules 数组的下标，用于无损保持相对顺序。 */
  originalIndex?: number;
  /** Display-only name derived from the source; do not serialize unless edited. */
  generatedName?: boolean;
};
type Props = {
  kind: TemplateKind;
  value: string;
  focusName?: string | null;
  focusNonce?: number;
  onChange: (value: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (message: string) => void;
};

const sourceKind = (source: string): "http" | "file" => /^https?:\/\//i.test(source.trim()) ? "http" : "file";
const labelFor = (kind: TemplateKind) => kind === "clash" ? "Clash / Mihomo" : kind === "egern" ? "Egern" : "Loon";

function loonSections(value: string) {
  const sections: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | undefined;
  value.replace(/\r/g, "").split("\n").forEach((line) => {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      current = { name: match[1], lines: [] };
      sections.push(current);
    } else if (current) current.lines.push(line);
  });
  return sections;
}

function readRuleSets(kind: TemplateKind, value: string): RuleSet[] {
  if (kind === "loon") {
    const remote = loonSections(value).find((section) => section.name.toLowerCase() === "remote rule");
    return (remote?.lines || []).flatMap((line, index) => {
      if (!line.trim() || /^\s*[#;]/.test(line)) return [];
      const [source = "", ...params] = line.split(",").map((part) => part.trim());
      const options = Object.fromEntries(params.map((part) => {
        const [key, ...rest] = part.split("=");
        return [key.trim().toLowerCase(), rest.join("=").trim()];
      }));
      const { tag, policy, enabled, interval, ...extra } = options;
      return [{ id: `loon:${index}`, name: tag || `规则集 ${index + 1}`, source, sourceType: sourceKind(source), policy: policy || "DIRECT", interval, enabled: enabled !== "false", extra }];
    });
  }
  const document = parseDocument(value, { prettyErrors: false, strict: false });
  const root = document.toJS();
  if (!root || Array.isArray(root) || typeof root !== "object") return [];
  const config = root as Record<string, unknown>;
  if (kind === "clash") {
    const providers = config["rule-providers"];
    if (!providers || Array.isArray(providers) || typeof providers !== "object") return [];
    return Object.entries(providers as Record<string, Record<string, unknown>>).map(([name, settings]) => {
      const source = String(settings.url || settings.path || "");
      return {
        id: `clash:${name}`,
        name,
        source,
        path: String(settings.path || ""),
        sourceType: settings.type === "file" ? "file" : sourceKind(source),
        behavior: ["classical", "domain", "ipcidr"].includes(String(settings.behavior)) ? settings.behavior as RuleSet["behavior"] : "classical",
        format: settings.format === "text" ? "text" : "yaml",
        interval: settings.interval === undefined ? "" : String(settings.interval),
        enabled: true,
      };
    });
  }
  const rules = Array.isArray(config.rules) ? config.rules : [];
  return rules.flatMap((entry, index) => {
    if (!entry || Array.isArray(entry) || typeof entry !== "object") return [];
    const settings = (entry as Record<string, unknown>).rule_set;
    if (!settings || Array.isArray(settings) || typeof settings !== "object") return [];
    const rule = settings as Record<string, unknown>;
    const source = String(rule.match || "");
    const { name, match, policy, update_interval, disabled, ...extra } = rule;
    return [{
      id: `egern:${index}`,
      name: name ? String(name) : ruleSetDisplayName(source, `规则集 ${index + 1}`),
      generatedName: !name,
      source: String(match || ""),
      sourceType: sourceKind(source),
      policy: String(policy || "DIRECT"),
      interval: update_interval === undefined ? "" : String(update_interval),
      enabled: disabled !== true,
      extra,
      originalIndex: index,
    }];
  });
}

function validate(item: RuleSet, kind: TemplateKind) {
  if (!item.name.trim()) return "请输入规则集名称";
  if (!item.source.trim()) return kind === "clash" && item.sourceType === "file" ? "请输入本地规则文件路径" : "请输入规则集地址";
  if (item.sourceType === "http" && !/^https?:\/\/\S+$/i.test(item.source.trim())) return "请输入有效的 HTTP(S) 地址";
  if ((kind === "egern" || kind === "loon") && !item.policy?.trim()) return "请输入命中后的策略目标";
  if (item.interval && (!/^\d+$/.test(item.interval) || Number(item.interval) < 1)) return "更新间隔必须是正整数（秒）";
  return "";
}

function writeRuleSets(kind: TemplateKind, value: string, items: RuleSet[]) {
  if (kind === "loon") {
    const sections = loonSections(value);
    let remote = sections.find((section) => section.name.toLowerCase() === "remote rule");
    if (!remote) {
      remote = { name: "Remote Rule", lines: [] };
      sections.push(remote);
    }
    const notes = remote.lines.filter((line) => !line.trim() || /^\s*[#;]/.test(line));
    remote.lines = [...notes, ...items.map((item) => {
      const extra = Object.entries(item.extra || {})
        .filter(([, value]) => String(value).trim())
        .map(([key, value]) => `${key}=${String(value).trim()}`);
      return `${item.source.trim()}, policy=${item.policy?.trim() || "DIRECT"}, tag=${item.name.trim()}, enabled=${item.enabled}${item.interval ? `, interval=${item.interval}` : ""}${extra.length ? `, ${extra.join(", ")}` : ""}`;
    })];
    return sections.map((section) => `[${section.name}]\n${section.lines.join("\n")}`.trimEnd()).join("\n\n").trimEnd() + "\n";
  }
  const document = parseDocument(value, { prettyErrors: false, strict: false });
  const root = document.toJS();
  const config = root && !Array.isArray(root) && typeof root === "object" ? root as Record<string, unknown> : {};
  if (kind === "clash") {
    config["rule-providers"] = Object.fromEntries(items.map((item) => [item.name.trim(), {
      type: item.sourceType,
      behavior: item.behavior || "classical",
      ...(item.sourceType === "http" ? { url: item.source.trim() } : { path: item.source.trim() }),
      ...(item.sourceType === "http" ? { path: item.path?.trim() || `./ruleset/${item.name.trim()}.yaml` } : {}),
      ...(item.interval ? { interval: Number(item.interval) } : {}),
      format: item.format || "yaml",
    }]));
  } else {
    const existing = Array.isArray(config.rules) ? config.rules : [];
    const byOriginalIndex = new Map(items.filter((item) => item.originalIndex !== undefined).map((item) => [item.originalIndex!, item]));
    const encode = (item: RuleSet) => ({ rule_set: {
      ...(item.extra || {}),
      ...(!item.generatedName ? { name: item.name.trim() } : {}), match: item.source.trim(), policy: item.policy?.trim() || "DIRECT", disabled: !item.enabled,
      ...(item.interval ? { update_interval: Number(item.interval) } : {}),
    } });
    const rebuilt = existing.flatMap((entry, index) => {
      if (!entry || Array.isArray(entry) || typeof entry !== "object" || !("rule_set" in (entry as Record<string, unknown>))) return [entry];
      const item = byOriginalIndex.get(index);
      return item ? [encode(item)] : [];
    });
    config.rules = [...rebuilt, ...items.filter((item) => item.originalIndex === undefined).map(encode)];
  }
  return stringify(config, { lineWidth: 0 });
}

export function RuleSetVisualEditor({ kind, value, focusName, focusNonce, onChange, onDirtyChange, onError }: Props) {
  const [items, setItems] = useState<RuleSet[]>([]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuleSet | null>(null);
  const isClash = kind === "clash";
  const policyOptions = useMemo(() => kind === "clash" ? [] : ruleSetPolicyOptions(kind, value), [kind, value]);
  useEffect(() => {
    try { setItems(readRuleSets(kind, value)); onError(""); onDirtyChange(false); }
    catch (error) { onError(error instanceof Error ? error.message : "规则集配置解析失败"); }
  }, [kind, value]);
  useEffect(() => {
    if (!focusName) return;
    const item = items.find((candidate) => candidate.name === focusName);
    if (!item) return;
    setExpanded((current) => current.includes(item.id) ? current : [...current, item.id]);
    setHighlighted(item.id);
    const flashClasses = ["border-cyan-500/70", "bg-cyan-500/10", "ring-2", "ring-cyan-500/25"];
    const frame = window.requestAnimationFrame(() => {
      const card = Array.from(document.querySelectorAll("article")).find((element) => element.querySelector("strong")?.textContent === focusName);
      card?.classList.add(...flashClasses);
      window.setTimeout(() => card?.classList.remove(...flashClasses), 1200);
    });
    const timeout = window.setTimeout(() => setHighlighted((current) => current === item.id ? null : current), 1200);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timeout); };
  }, [focusName, focusNonce, items]);
  const visible = useMemo(() => items.filter((item) => `${item.name} ${item.source} ${item.policy || ""}`.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);
  const commit = (next: RuleSet[]) => {
    setItems(next);
    onChange(writeRuleSets(kind, value, next));
    onDirtyChange(true);
  };
  const newItem = (): RuleSet => ({ id: `new:${crypto.randomUUID()}`, name: "", source: "", path: "", sourceType: "http", behavior: "classical", format: "yaml", policy: "DIRECT", interval: "86400", enabled: true });
  const save = () => {
    if (!editing) return;
    const message = validate(editing, kind);
    if (message) { onError(message); return; }
    const existing = items.find((item) => item.id === editing.id);
    if (!isClash && !policyOptions.includes(editing.policy || "") && existing?.policy !== editing.policy) { onError("请选择模板中存在的策略组或内置策略"); return; }
    const duplicate = kind !== "egern" && items.some((item) => item.name.trim() === editing.name.trim() && item.id !== editing.id);
    if (duplicate) { onError("规则集名称不能重复"); return; }
    const exists = items.some((item) => item.id === editing.id);
    commit(exists ? items.map((item) => item.id === editing.id ? editing : item) : [...items, editing]);
    setEditing(null); onError("");
  };
  return <section className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
    <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{labelFor(kind)} 规则集 <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">{items.length}</span></p><p className="mt-1 text-xs text-muted-foreground">{isClash ? "管理 rule-providers，并在流量规则中通过 RULE-SET 引用。" : kind === "egern" ? "管理 rule_set 远程或本地规则文件及其命中策略。" : "管理 [Remote Rule] 远程规则订阅及命中策略。"}</p></div>
        <Button size="sm" onClick={() => setEditing(newItem())}><Plus className="mr-1 size-4" />新建规则集</Button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="搜索规则集名称、地址或策略" /></div><div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">{isClash ? "Clash / Mihomo" : labelFor(kind)} 原生格式</div></div>
      <div className="grid gap-3">{visible.map((item) => <article key={item.id} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"><div className="flex items-center gap-3 px-4 py-3"><span className={`grid size-9 shrink-0 place-items-center rounded-lg ${item.sourceType === "http" ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-300" : "bg-violet-500/10 text-violet-600 dark:text-violet-300"}`}>{item.sourceType === "http" ? <Globe2 className="size-4" /> : <FileText className="size-4" />}</span><button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpanded((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{item.name}</strong><span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">{item.sourceType}</span>{item.behavior && <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{item.behavior}</span>}{item.format && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{item.format}</span>} {item.policy && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:text-emerald-300">→ {item.policy}</span>}</div><p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{item.source || "尚未配置地址"}</p></button>{!isClash && <Switch aria-label={`启用规则集 ${item.name}`} checked={item.enabled} onCheckedChange={(enabled) => commit(items.map((current) => current.id === item.id ? { ...current, enabled } : current))} />}<Button variant="ghost" size="icon" className="size-8" aria-label={`编辑 ${item.name}`} onClick={() => setEditing(item)}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" aria-label={`删除 ${item.name}`} onClick={() => commit(items.filter((current) => current.id !== item.id))}><Trash2 className="size-4" /></Button>{expanded.includes(item.id) ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}</div>{expanded.includes(item.id) && <div className="grid gap-2 border-t border-border bg-muted/20 px-4 py-3 text-xs sm:grid-cols-2"><div><span className="text-muted-foreground">来源：</span><code className="break-all text-foreground">{item.source}</code></div><div><span className="text-muted-foreground">{item.interval ? "更新间隔：" : "更新策略："}</span><span className="text-foreground">{item.interval ? `${item.interval} 秒` : item.sourceType === "http" ? "按客户端默认周期" : "本地静态文件"}</span></div>{item.policy && <div><span className="text-muted-foreground">命中策略：</span><span className="font-medium text-foreground">{item.policy}</span></div>}<div><span className="text-muted-foreground">状态：</span><span className={item.enabled ? "text-emerald-600 dark:text-emerald-300" : "text-muted-foreground"}>{item.enabled ? "已启用" : "已停用"}</span></div></div>}</article>)}{!visible.length && <div className="grid min-h-44 place-items-center rounded-xl border border-dashed border-border bg-card text-sm text-muted-foreground">{items.length ? "没有匹配的规则集" : "暂无规则集，点击“新建规则集”开始配置。"}</div>}</div>
    </div>
    <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}><DialogContent className="max-h-[calc(100svh-3rem)] max-w-[760px] overflow-y-auto border-border bg-card p-0 sm:p-0"><DialogHeader className="border-b border-border bg-muted/30 px-6 py-5"><DialogTitle>{items.some((item) => item.id === editing?.id) ? "编辑规则集" : "新建规则集"}</DialogTitle><DialogDescription>{labelFor(kind)} 将按原生格式保存此规则集配置。</DialogDescription></DialogHeader>{editing && <div className="grid gap-5 p-6"><div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">规则集名称<Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value, generatedName: false })} placeholder="例如 RejectAd" /></label>{!isClash && <label className="grid gap-1.5 text-xs font-medium">命中策略<Select value={editing.policy || "DIRECT"} onValueChange={(policy) => setEditing({ ...editing, policy })}><SelectTrigger><SelectValue placeholder="请选择策略" /></SelectTrigger><SelectContent>{editing.policy && !policyOptions.includes(editing.policy) && <SelectItem value={editing.policy} disabled>{editing.policy}（当前模板中未找到）</SelectItem>}{policyOptions.map((policy) => <SelectItem key={policy} value={policy}>{policy === "DIRECT" ? "DIRECT（直连）" : policy === "REJECT" ? "REJECT（拒绝）" : policy === "PROXY" && kind === "loon" ? "PROXY（Loon 内置代理）" : policy}</SelectItem>)}</SelectContent></Select>{editing.policy && !policyOptions.includes(editing.policy) && <small className="text-amber-600 dark:text-amber-400">当前目标不在内置策略或模板策略组中；可保留原值或选择有效策略。</small>}</label>}</div>{isClash && <div className="grid gap-3 sm:grid-cols-3"><label className="grid gap-1.5 text-xs font-medium">来源类型<Select value={editing.sourceType} onValueChange={(sourceType: "http" | "file") => setEditing({ ...editing, sourceType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="http">HTTP 远程订阅</SelectItem><SelectItem value="file">本地文件</SelectItem></SelectContent></Select></label><label className="grid gap-1.5 text-xs font-medium">行为模式<Select value={editing.behavior || "classical"} onValueChange={(behavior: RuleSet["behavior"]) => setEditing({ ...editing, behavior })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="classical">classical（混合规则）</SelectItem><SelectItem value="domain">domain（域名集合）</SelectItem><SelectItem value="ipcidr">ipcidr（IP 网段）</SelectItem></SelectContent></Select></label><label className="grid gap-1.5 text-xs font-medium">载荷格式<Select value={editing.format || "yaml"} onValueChange={(format: RuleSet["format"]) => setEditing({ ...editing, format })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="yaml">yaml</SelectItem><SelectItem value="text">text</SelectItem></SelectContent></Select></label></div>}<label className="grid gap-1.5 text-xs font-medium">{editing.sourceType === "file" ? "本地文件路径" : "远程规则地址"}<Input value={editing.source} onChange={(event) => setEditing({ ...editing, source: event.target.value, sourceType: sourceKind(event.target.value), ...(editing.generatedName ? { name: ruleSetDisplayName(event.target.value, `规则集 ${(editing.originalIndex ?? 0) + 1}`) } : {}) })} placeholder={editing.sourceType === "file" ? "./ruleset/reject.yaml" : "https://example.com/rules.yaml"} className="font-mono" /></label>{kind !== "loon" && <label className="grid gap-1.5 text-xs font-medium">更新间隔（秒）<Input inputMode="numeric" value={editing.interval || ""} onChange={(event) => setEditing({ ...editing, interval: event.target.value })} placeholder="远程规则集默认 86400" /></label>}{!isClash && <label className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs"><span><b className="block">启用规则集</b><small className="mt-0.5 block text-muted-foreground">关闭后保留配置，但不参与规则匹配。</small></span><Switch checked={editing.enabled} onCheckedChange={(enabled) => setEditing({ ...editing, enabled })} /></label>}<div className="flex justify-end gap-2 border-t border-border pt-4"><Button variant="outline" onClick={() => setEditing(null)}>取消</Button><Button onClick={save}>保存规则集</Button></div></div>}</DialogContent></Dialog>
  </section>;
}
