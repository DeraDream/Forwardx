import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, ChevronDown, ChevronUp, Code2, Copy, Link2, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { moduleRanges, toggleModuleComment, uncommentModuleEntries } from "./moduleToggle";

type Kind = "egern" | "loon";
type SectionCounts = Record<string, number>;
type Module = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  interval: number;
  local: boolean;
  tags: string[];
  description: string;
  author: string;
  version: string;
  icon: string;
  content: string;
  compatArguments: string;
  env: string;
  sections: SectionCounts;
};
type Props = { kind: Kind; value: string; onChange: (value: string) => void; onDirtyChange: (dirty: boolean) => void; onError: (message: string) => void; onFocusLine: (line: number) => void };
type Inspection = { kind: Kind | "surge"; name: string; description?: string; author?: string; version?: string; icon?: string; tags?: string[]; sections?: SectionCounts; content?: string };

const emptyModule = (): Module => ({ id: crypto.randomUUID(), name: "", url: "", enabled: true, interval: 86400, local: false, tags: [], description: "", author: "", version: "", icon: "", content: "", compatArguments: "", env: "", sections: {} });
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const interval = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 86400;

async function inspectContent(content: string): Promise<Inspection> {
  const response = await fetch("/api/v1/module/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
  const payload = await response.json().catch(() => ({})) as { data?: Inspection; msg?: string };
  if (!response.ok || !payload.data) throw new Error(payload.msg || "模块解析失败");
  return payload.data;
}
async function inspectUrl(url: string) {
  const response = await fetch("/api/v1/module/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
  const payload = await response.json().catch(() => ({})) as { data?: Inspection; msg?: string };
  if (!response.ok || !payload.data) throw new Error(payload.msg || "模块拉取失败");
  return payload.data;
}

function toModule(item: unknown, index: number): Module {
  const record = typeof item === "string" ? { url: item } : (item || {}) as Record<string, unknown>;
  const moduleURL = text(record.url);
  const sections = record.sections && typeof record.sections === "object" && !Array.isArray(record.sections) ? record.sections as SectionCounts : {};
  return {
    id: text(record.id) || `module-${index}`,
    name: text(record.name) || moduleURL || `模块 ${index + 1}`,
    url: moduleURL, enabled: record.enabled !== false, interval: interval(record.update_interval ?? record.interval), local: record.local === true || (!!moduleURL && !/^https?:\/\//i.test(moduleURL)),
    tags: Array.isArray(record.tags) ? record.tags.map(text).filter(Boolean) : [],
    description: text(record.description), author: text(record.author), version: text(record.version), icon: text(record.icon), content: text(record.content), compatArguments: record.compat_arguments && typeof record.compat_arguments === "object" ? stringify(record.compat_arguments, { lineWidth: 0 }).trimEnd() : "", env: record.env && typeof record.env === "object" ? stringify(record.env, { lineWidth: 0 }).trimEnd() : "", sections,
  };
}
function parseEgern(value: string) {
  const document = parseDocument(uncommentModuleEntries("egern", value), { prettyErrors: false, strict: true });
  if (document.errors.length) throw new Error(String(document.errors[0].message));
  const root = document.toJS() as Record<string, unknown> | null;
  if (!root || Array.isArray(root)) throw new Error("Egern 根配置必须是 YAML 对象");
  const ranges = moduleRanges("egern", value);
  return { root, modules: Array.isArray(root.modules) ? root.modules.map((item, index) => ({ ...toModule(item, index), enabled: !ranges[index]?.disabled && toModule(item, index).enabled })) : [] };
}
function parseLoon(value: string) {
  const ranges = moduleRanges("loon", value);
  const lines = uncommentModuleEntries("loon", value).replace(/\r/g, "").split("\n");
  const start = lines.findIndex((line) => /^\s*\[Plugin\]\s*$/i.test(line));
  if (start < 0) return { lines, modules: [] as Module[], start: -1, end: -1 };
  const end = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]\s*$/.test(line));
  const block = lines.slice(start + 1, end < 0 ? lines.length : end);
  const modules = block.flatMap((line, index) => {
    const raw = line.trim();
    if (!raw || /^\s*[#;]/.test(line)) return [];
    const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    const first = parts.shift() || "";
    let name = first;
    let url = first;
    // Native Loon [Plugin] entries are usually `url,tag=...,enable=true`.
    // Keep compatibility with the older `name = url,...` form as well.
    if (!/^https?:\/\//i.test(first) && first.includes("=")) {
      const pair = first.split(/=(.*)/s);
      name = pair[0].trim();
      url = (pair[1] || "").trim();
    } else {
      name = first;
    }
    const options = new Map(parts.map((part) => { const [key, ...rest] = part.split("="); return [key.trim().toLowerCase(), rest.join("=").trim()]; }));
    return [toModule({ id: `loon-${index}`, name, url, enabled: !ranges.find((range) => range.start === start + 1 + index)?.disabled && options.get("enable") !== "false", interval: options.get("interval"), local: !/^https?:\/\//i.test(url), tags: (options.get("tag") || "").split("|").filter(Boolean) }, index)];
  });
  return { lines, modules, start, end };
}
function parse(kind: Kind, value: string) { return kind === "egern" ? parseEgern(value) : parseLoon(value); }

function render(kind: Kind, value: string, modules: Module[]) {
  if (kind === "egern") {
    const parsed = parseEgern(value);
    // A template stores module references. The fetched module body is only a
    // preview; Egern owns downloading and executing the referenced module.
    const existing = Array.isArray(parsed.root.modules) ? parsed.root.modules : [];
    parsed.root.modules = modules.map((module) => {
      const previousIndex = /^module-(\d+)$/.exec(module.id);
      const previous = previousIndex ? existing[Number(previousIndex[1])] : undefined;
      const fields: Record<string, unknown> = previous && typeof previous === "object" && !Array.isArray(previous) ? { ...previous as Record<string, unknown> } : {};
      if (module.name && module.name !== module.url) fields.name = module.name; else delete fields.name;
      fields.url = module.url;
      if (!module.local) fields.update_interval = module.interval; else delete fields.update_interval;
      fields.enabled = true;
      delete fields.compat_arguments; delete fields.env;
      return { ...fields, ...yamlObjectField("compat_arguments", module.compatArguments), ...yamlObjectField("env", module.env) };
    });
    const document = parseDocument(uncommentModuleEntries("egern", value), { prettyErrors: false, strict: true });
    document.set("modules", parsed.root.modules);
    let output = document.toString({ lineWidth: 0 });
    modules.forEach((module, index) => { if (!module.enabled) output = toggleModuleComment("egern", output, index, false).source; });
    return output;
  }
  const parsed = parseLoon(value);
  // Loon's [Plugin] profile section is kept native. tag and enable are
  // supported plugin options; the panel-only refresh interval is not emitted.
  const rows = modules.map((module) => {
    const oldIndex = /^loon-(\d+)$/.exec(module.id);
    const oldLine = oldIndex && parsed.start >= 0 ? parsed.lines[parsed.start + 1 + Number(oldIndex[1])] : "";
    const options = (oldLine || "").split(",").slice(1).filter((part) => !/^\s*(?:tag|enable)\s*=/i.test(part));
    return `${module.enabled ? "" : "# "}${module.url}${options.length ? `,${options.join(",")}` : ""}${module.tags[0] ? `,tag=${module.tags[0]}` : ""},enable=true`;
  });
  const ranges = moduleRanges("loon", value);
  const blockEnd = parsed.end < 0 ? parsed.lines.length : parsed.end;
  const oldEntries = new Set(ranges.map((range) => range.start));
  const remaining = parsed.lines.slice(parsed.start + 1, blockEnd).filter((_, index) => !oldEntries.has(parsed.start + 1 + index));
  const base = parsed.start < 0
    ? `${value.trimEnd()}\n\n[Plugin]\n${rows.join("\n")}\n`
    : [...parsed.lines.slice(0, parsed.start + 1), ...rows, ...remaining, ...parsed.lines.slice(blockEnd)].join("\n").replace(/\n*$/, "\n");
  return base;
}

function yamlObjectField(key: string, value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = parseDocument(value, { prettyErrors: false, strict: true }).toJS();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${key} 必须是 YAML 对象`);
    return { [key]: parsed };
  } catch { throw new Error(`${key} 必须是 YAML 对象`); }
}

function ModuleIcon({ icon, kind, onVisible }: { icon: string; kind: Kind; onVisible: () => void }) {
  const [failed, setFailed] = useState(false);
  const element = useRef<HTMLSpanElement>(null);
  const visibleCallback = useRef(onVisible);
  visibleCallback.current = onVisible;
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); visibleCallback.current(); }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const imageUrl = /^https?:\/\/\S+$/i.test(icon.trim()) ? icon.trim() : "";
  return <span ref={element} className={`grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg ${kind === "egern" ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" : "bg-primary/10 text-primary"}`}>
    {imageUrl && !failed ? <img src={imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setFailed(true)} /> : <Braces className="size-4" />}
  </span>;
}

function SectionBadges({ sections }: { sections: SectionCounts }) {
  const entries = Object.entries(sections);
  return <div className="flex flex-wrap gap-1.5">{entries.length ? entries.map(([name, count]) => <span key={name} className="rounded bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary">{name} {count}</span>) : <span className="text-xs text-muted-foreground">尚未解析模块内容</span>}</div>;
}

const directiveKeys: Record<string, string[]> = { egern: ["url_rewrites", "header_rewrites", "body_rewrites", "map_locals", "scriptings", "mitm", "rules", "dns", "http_captures", "widgets", "bypass_tunnel_proxy", "real_ip_domains"], loon: ["General", "Argument", "Rule", "Url Rewrite", "Host", "Script", "MITM"] };
type LoonScriptRow = { type: string; matcher: string; scriptPath: string; requiresBody: string; binaryBodyMode: string; timeout: string; argument: string; tag: string; enable: string };
const scriptTypes = ["http-request", "http-response", "cron", "network-changed", "generic"];
function parseScriptRows(value: string): LoonScriptRow[] {
  return value.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith(";" )).map((line) => {
    const type = scriptTypes.find((item) => line.toLowerCase().startsWith(`${item} `) || line.toLowerCase() === item) || "http-response";
    let rest = line.slice(type.length).trim();
    let matcher = "";
    if (type === "http-request" || type === "http-response" || type === "cron") {
      const match = rest.match(/^((?:"[^"]*")|(?:\S+))\s*(.*)$/);
      if (match) { matcher = match[1].replace(/^"|"$/g, ""); rest = match[2]; }
    }
    const get = (key: string) => rest.match(new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^,\\s]+))`, "i"))?.[1] || rest.match(new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^,\\s]+))`, "i"))?.[2] || "";
    return { type, matcher, scriptPath: get("script-path"), requiresBody: get("requires-body"), binaryBodyMode: get("binary-body-mode"), timeout: get("timeout"), argument: get("argument"), tag: get("tag"), enable: get("enable") };
  });
}
function renderScriptRows(rows: LoonScriptRow[]) {
  return rows.map((row) => {
    const matcher = row.type === "http-request" || row.type === "http-response" || row.type === "cron" ? ` ${row.type === "cron" ? `"${row.matcher}"` : row.matcher}` : "";
    const fields = [["script-path", row.scriptPath], ["requires-body", row.requiresBody], ["binary-body-mode", row.binaryBodyMode], ["timeout", row.timeout], ["argument", row.argument], ["tag", row.tag], ["enable", row.enable]].filter(([, value]) => value).map(([key, value]) => `${key}=${key === "argument" && /[, ]/.test(value) ? `"${value}"` : value}`).join(",");
    return `${row.type}${matcher}${fields ? ` ${fields}` : ""}`.trim();
  }).join("\n");
}
function LoonScriptEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const rows = parseScriptRows(value);
  const update = (index: number, patch: Partial<LoonScriptRow>) => onChange(renderScriptRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row)));
  return <div className="space-y-2">{rows.map((row, index) => <div key={index} className="grid gap-2 rounded-md border border-border bg-background p-2 md:grid-cols-[130px_minmax(130px,1fr)_minmax(150px,1fr)_90px_32px]"><select className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" value={row.type} onChange={(event) => update(index, { type: event.target.value })}>{scriptTypes.map((type) => <option key={type}>{type}</option>)}</select><Input className="h-8 font-mono text-[11px]" value={row.matcher} onChange={(event) => update(index, { matcher: event.target.value })} placeholder="匹配表达式 / cron" /><Input className="h-8 font-mono text-[11px]" value={row.scriptPath} onChange={(event) => update(index, { scriptPath: event.target.value })} placeholder="script-path" /><Input className="h-8 font-mono text-[11px]" value={row.tag} onChange={(event) => update(index, { tag: event.target.value })} placeholder="tag" /><Button variant="ghost" size="icon" className="size-8 text-destructive" onClick={() => onChange(renderScriptRows(rows.filter((_, rowIndex) => rowIndex !== index)))}><Trash2 className="size-3.5" /></Button><div className="grid gap-2 sm:grid-cols-4 md:col-span-5"><Input className="h-8 text-[11px]" value={row.requiresBody} onChange={(event) => update(index, { requiresBody: event.target.value })} placeholder="requires-body" /><Input className="h-8 text-[11px]" value={row.binaryBodyMode} onChange={(event) => update(index, { binaryBodyMode: event.target.value })} placeholder="binary-body-mode" /><Input className="h-8 text-[11px]" value={row.timeout} onChange={(event) => update(index, { timeout: event.target.value })} placeholder="timeout" /><Input className="h-8 text-[11px]" value={row.argument} onChange={(event) => update(index, { argument: event.target.value })} placeholder="argument" /></div></div>)}<Button size="sm" variant="outline" onClick={() => onChange(renderScriptRows([...rows, { type: "http-response", matcher: "", scriptPath: "", requiresBody: "", binaryBodyMode: "", timeout: "", argument: "", tag: "", enable: "" }]))}><Plus className="mr-1 size-3.5" />添加脚本</Button></div>;
}
function writeModuleMetadata(kind: Kind, content: string, module: Module) {
  if (!content.trim()) return content;
  if (kind === "egern") {
    try {
      const root = parseDocument(content, { prettyErrors: false, strict: true }).toJS() as Record<string, unknown>;
      if (module.name) root.name = module.name;
      if (module.description) root.description = module.description;
      if (module.author) root.author = module.author;
      if (module.icon) root.icon = module.icon;
      return stringify(root, { lineWidth: 0 });
    } catch { return content; }
  }
  const fields: Array<[string, string]> = [["name", module.name], ["desc", module.description], ["author", module.author], ["icon", module.icon], ["tag", kind === "loon" ? module.tags.join(",") : ""]];
  const lines = content.replace(/\r/g, "").split("\n");
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const match = line.match(/^\s*#!([^=\s]+)\s*=.*$/);
    if (!match) return line;
    const key = match[1].toLowerCase();
    const field = fields.find(([name]) => name === key);
    if (!field || !field[1]) return line;
    seen.add(key);
    return `#!${field[0]}= ${field[1]}`;
  });
  const missing = fields.filter(([name, value]) => value && !seen.has(name)).map(([name, value]) => `#!${name}= ${value}`);
  return missing.length ? [...missing, ...output].join("\n") : output.join("\n");
}

type LoonArgumentRow = { name: string; type: string; defaultValue: string; options: string };
function parseArgumentRows(value: string): LoonArgumentRow[] {
  return value.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith(";" )).map((line) => {
    const [name, rest = ""] = line.split(/=(.*)/s);
    const parts = rest.split(",").map((part) => part.trim()).filter(Boolean);
    const type = parts.shift() || "input";
    const defaultValue = (parts.shift() || "").replace(/^\"|\"$/g, "");
    return { name: name.trim(), type, defaultValue, options: parts.join(",") };
  });
}
function renderArgumentRows(rows: LoonArgumentRow[]) { return rows.map((row) => `${row.name} = ${row.type}${row.defaultValue ? `,"${row.defaultValue}"` : ""}${row.options ? `,${row.options}` : ""}`).join("\n"); }
function LoonArgumentEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const rows = parseArgumentRows(value);
  const update = (index: number, patch: Partial<LoonArgumentRow>) => onChange(renderArgumentRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row)));
  return <div className="space-y-2">{rows.map((row, index) => <div key={index} className="grid gap-2 rounded-md border border-border bg-background p-2 sm:grid-cols-[1fr_100px_1fr_1fr_32px]"><Input className="h-8 text-[11px]" value={row.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="参数名" /><select className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" value={row.type} onChange={(event) => update(index, { type: event.target.value })}><option value="input">input</option><option value="select">select</option><option value="switch">switch</option></select><Input className="h-8 text-[11px]" value={row.defaultValue} onChange={(event) => update(index, { defaultValue: event.target.value })} placeholder="默认值" /><Input className="h-8 text-[11px]" value={row.options} onChange={(event) => update(index, { options: event.target.value })} placeholder="tag=...,desc=..." /><Button variant="ghost" size="icon" className="size-8 text-destructive" onClick={() => onChange(renderArgumentRows(rows.filter((_, rowIndex) => rowIndex !== index)))}><Trash2 className="size-3.5" /></Button></div>)}<Button size="sm" variant="outline" onClick={() => onChange(renderArgumentRows([...rows, { name: "newArgument", type: "input", defaultValue: "", options: "" }]))}><Plus className="mr-1 size-3.5" />添加参数</Button></div>;
}

function StructuredDirectives({ kind, value, onChange }: { kind: Kind; value: string; onChange: (value: string) => void }) {
  const keys = directiveKeys[kind];
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      if (kind === "egern") {
        const root = parseDocument(value, { prettyErrors: false, strict: true }).toJS() as Record<string, unknown>;
        setDraft(Object.fromEntries(keys.filter((key) => root?.[key] !== undefined).map((key) => [key, stringify(root[key], { lineWidth: 0 }).trimEnd()])));
      } else {
        const lines = value.replace(/\r/g, "").split("\n");
        const next: Record<string, string> = {};
        let section = "";
        for (const line of lines) {
          const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
          if (heading) { section = heading[1]; const canonical = keys.find((key) => key.toLowerCase() === section.toLowerCase()); if (canonical) next[canonical] = ""; continue; }
          const canonical = keys.find((key) => key.toLowerCase() === section.toLowerCase());
          if (canonical) next[canonical] = `${next[canonical] || ""}${line}\n`;
        }
        setDraft(Object.fromEntries(Object.entries(next).map(([key, text]) => [key, text.trimEnd()])));
      }
    } catch { setDraft({}); }
  }, [kind, value]);
  const update = (key: string, next: string) => {
    const nextDraft = { ...draft, [key]: next };
    setDraft(nextDraft);
    try {
      if (kind === "egern") {
        const root = parseDocument(value, { prettyErrors: false, strict: true }).toJS() as Record<string, unknown>;
        for (const name of keys) if (nextDraft[name]?.trim()) root[name] = parseDocument(nextDraft[name], { prettyErrors: false, strict: true }).toJS(); else delete root[name];
        onChange(stringify(root, { lineWidth: 0 }));
      } else {
        const lines = value.replace(/\r/g, "").split("\n");
        const output: string[] = []; let active = "";
        for (const line of lines) {
          const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
          if (heading) {
            active = heading[1];
            const canonical = keys.find((key) => key.toLowerCase() === active.toLowerCase());
            if (canonical) { output.push(line); output.push(...(nextDraft[canonical] || "").split("\n").filter(Boolean)); continue; }
          }
          if (keys.some((key) => key.toLowerCase() === active.toLowerCase())) continue;
          output.push(line);
        }
        onChange(output.join("\n"));
      }
    } catch { /* keep the draft visible until the user fixes syntax */ }
  };
  return <div className="space-y-3 rounded-lg border border-border bg-background/50 p-3"><div className="flex items-center justify-between"><div><p className="text-xs font-semibold text-foreground">结构化指令编辑</p><p className="mt-0.5 text-[11px] text-muted-foreground">逐模块编辑 Rewrite、Script、MITM、Rule 和 DNS；源码会同步更新。</p></div><Code2 className="size-4 text-primary" /></div>{keys.map((key) => <label key={key} className="grid gap-1.5 text-[11px] font-medium"><span className="font-mono text-primary">{kind === "loon" ? `[${key}]` : key}</span>{kind === "loon" && key === "Script" ? <LoonScriptEditor value={draft[key] || ""} onChange={(next) => update(key, next)} /> : kind === "loon" && key === "Argument" ? <LoonArgumentEditor value={draft[key] || ""} onChange={(next) => update(key, next)} /> : <textarea className="min-h-16 resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" value={draft[key] || ""} onChange={(event) => update(key, event.target.value)} placeholder={kind === "loon" ? "每行一条原生指令" : "YAML 数组或对象"} />}</label>)}</div>;
}

export function ModuleVisualEditor({ kind, value, onChange, onDirtyChange, onError, onFocusLine }: Props) {
  const [modules, setModules] = useState<Module[]>([]);
  const [editing, setEditing] = useState<Module | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inspectionStatus, setInspectionStatus] = useState<Record<string, string>>({});
  const inspectionsInFlight = useRef(new Set<string>());
  useEffect(() => { try { const parsed = parse(kind, value).modules; setModules((previous) => parsed.map((item) => { const old = previous.find((entry) => entry.url === item.url); return old ? { ...item, author: old.author, description: old.description, version: old.version, icon: old.icon, content: old.content, sections: old.sections } : item; })); onError(""); onDirtyChange(false); } catch (error) { onError(error instanceof Error ? error.message : "模块配置解析失败"); } }, [kind, value]);
  const inspectExpanded = async (module: Module, force = false) => {
    const requestKey = `${module.id}\n${module.url}`;
    if (module.local || !/^https?:\/\//i.test(module.url) || inspectionsInFlight.current.has(requestKey) || (!force && inspectionStatus[module.id])) return;
    inspectionsInFlight.current.add(requestKey);
    setInspectionStatus((previous) => ({ ...previous, [module.id]: "识别中…" }));
    try {
      const result = await inspectUrl(module.url);
      if (kind === "loon" && result.kind !== "loon") throw new Error(`识别为 ${result.kind}，不是 Loon 插件`);
      setModules((items) => items.map((item) => item.id === module.id && item.url === module.url ? { ...item, author: result.author || "", description: result.description || "", version: result.version || "", icon: result.icon || "", content: result.content || "", sections: result.sections || {} } : item));
      setInspectionStatus((previous) => ({ ...previous, [module.id]: "已识别" }));
      if (force) toast.success("模块拉取并识别成功，详情已更新");
    } catch (error) {
      const message = error instanceof Error ? error.message : "识别失败";
      setInspectionStatus((previous) => ({ ...previous, [module.id]: message }));
      if (force) toast.error(message);
    } finally {
      inspectionsInFlight.current.delete(requestKey);
    }
  };
  const apply = (next: Module[]) => {
    try {
      const updated = render(kind, value, next);
      setModules(next);
      onChange(updated);
      onError("");
      return true;
    } catch (error) { onError(error instanceof Error ? error.message : "无法更新模块配置"); return false; }
  };
  const toggle = (index: number, enabled: boolean) => {
    try {
      const result = toggleModuleComment(kind, value, index, enabled);
      onChange(result.source);
      onFocusLine(result.line);
    } catch (error) { toast.error(error instanceof Error ? error.message : "无法切换模块状态"); }
  };
  const move = (index: number, amount: number) => { const target = index + amount; if (target < 0 || target >= modules.length) return; const next = [...modules]; [next[index], next[target]] = [next[target], next[index]]; apply(next); };
  const copyModuleURL = async (url: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      toast.success("模块地址已复制");
    } catch { toast.error("复制失败，请检查浏览器剪贴板权限"); }
  };
  const remote = useMemo(() => modules.filter((item) => !item.local).length, [modules]);
  const filteredModules = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return modules;
    return modules.filter((item) => `${item.name} ${item.url} ${item.author} ${item.tags.join(" ")}`.toLowerCase().includes(keyword));
  }, [modules, query]);
  const platform = kind === "egern" ? "Egern Module" : "Loon Plugin";
  return <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3"><div><p className="text-sm font-semibold text-foreground">模块 / 插件 <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{modules.length} 个</span></p><p className="mt-0.5 text-xs text-muted-foreground">编辑 {platform} 引用并预览模块内容；更新和执行由客户端执行。</p></div><div className="flex gap-2"><label className="cursor-pointer"><input className="hidden" type="file" accept={kind === "loon" ? ".plugin,.conf,.txt" : ".yaml,.yml,.txt"} onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; const content = await file.text(); setEditing({ ...emptyModule(), name: file.name.replace(/\.[^.]+$/, ""), local: true, url: `./${file.name}`, content }); event.currentTarget.value = ""; }} /><Button size="sm" variant="outline" asChild><span><Upload className="mr-1 size-4" />导入并预览源码</span></Button></label><Button size="sm" onClick={() => setEditing(emptyModule())}><Plus className="mr-1 size-4" />新建模块/插件</Button></div></header>
    <div className="min-h-0 flex-1 overflow-auto p-4"><div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground"><ShieldCheck className="size-4 shrink-0 text-primary" />仅 Egern/Loon 显示此页。远程模块只做一次性识别，更新和执行由 Egern/Loon App 负责。</div>
      <div className="mb-4 flex gap-2"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-10 bg-card pl-9" placeholder="搜索模块名称、URL 或作者…" /></div><Button variant="outline" size="icon" className="size-10" title="清除识别状态" onClick={() => { setInspectionStatus({}); toast.info("已清除识别状态，重新展开模块可再次识别"); }}><RefreshCw className="size-4" /></Button></div>
      <div className="space-y-3">{filteredModules.map((module) => { const index = modules.findIndex((item) => item.id === module.id); return <article key={module.id} className={`overflow-hidden rounded-xl border border-border bg-card shadow-sm ${module.enabled ? (kind === "egern" ? "border-t-2 border-t-cyan-500" : "border-t-2 border-t-primary") : "opacity-75"}`}><div className="flex items-center gap-3 px-4 py-3"><ModuleIcon key={module.icon} icon={module.icon} kind={kind} onVisible={() => { if (!module.icon) void inspectExpanded(module); }} /><button className="min-w-0 flex-1 text-left" onClick={() => { if (expanded === module.id) setExpanded(null); else { setExpanded(module.id); void inspectExpanded(module); } }}><div className="flex min-w-0 items-center gap-2"><p className="truncate text-sm font-semibold text-foreground">{module.name || "未命名模块"}</p>{module.version && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{module.version}</span>}</div><p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{module.local ? "本地内容" : "HTTP 远程"} · {kind === "egern" && !module.local ? `${module.interval.toLocaleString()}s` : "客户端管理"}{module.author ? ` · ${module.author}` : ""}</p></button><span className={`hidden items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium sm:inline-flex ${module.enabled ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}><i className={`size-1.5 rounded-full ${module.enabled ? "bg-emerald-500" : "bg-muted-foreground"}`} />{module.enabled ? "已启用" : "已停用"}</span><Switch checked={module.enabled} onCheckedChange={(enabled) => toggle(index, enabled)} aria-label={`启用 ${module.name}`} /><Button variant="ghost" size="icon" className="size-8 shrink-0" disabled={module.local || !/^https?:\/\//i.test(module.url) || inspectionStatus[module.id] === "识别中…"} title={module.local ? "本地文件请在编辑中导入或校验" : "拉取并识别模块"} aria-label={`拉取并识别 ${module.name}`} onClick={() => void inspectExpanded(module, true)}><RefreshCw className={`size-4 ${inspectionStatus[module.id] === "识别中…" ? "animate-spin" : ""}`} /></Button><Button variant="ghost" size="icon" className="size-8" disabled={!index} onClick={() => move(index, -1)}><ChevronUp className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8" disabled={index === modules.length - 1} onClick={() => move(index, 1)}><ChevronDown className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8" onClick={() => setEditing(module)}><Pencil className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" onClick={() => apply(modules.filter((item) => item.id !== module.id))}><Trash2 className="size-4" /></Button></div>{expanded === module.id && <div className="space-y-4 border-t border-border bg-muted/25 px-4 py-4"><div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground"><Link2 className="size-3.5 text-primary" />{/^https?:\/\/\S+$/i.test(module.url) ? <a href={module.url} target="_blank" rel="noopener noreferrer" title={module.url} className="min-w-0 flex-1 truncate text-primary underline-offset-4 hover:underline">{module.url}</a> : <span className="min-w-0 flex-1 truncate" title={module.url}>{module.url || "本地内联内容"}</span>}<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" disabled={!module.url} title="复制模块地址" aria-label={`复制 ${module.name} 的地址`} onClick={() => void copyModuleURL(module.url)}><Copy className="size-3.5" /></Button></div><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Metadata</p><p className="mt-1 truncate text-xs font-medium">{module.author || "未填写作者"}</p></div><div className="rounded-lg border border-border bg-card p-3"><p className="text-[10px] text-muted-foreground">功能模块</p><p className="mt-1 text-xs font-medium">{Object.keys(module.sections).length || 0} 类指令</p></div><div className="rounded-lg border border-border bg-card p-3"><p className="text-[10px] text-muted-foreground">更新策略</p><p className="mt-1 text-xs font-medium">{module.local ? "本地文件" : kind === "egern" ? `${module.interval.toLocaleString()} 秒` : "由 Loon 客户端管理"}</p></div></div>{inspectionStatus[module.id] && <p role="status" className="break-words text-xs text-muted-foreground">{inspectionStatus[module.id]}</p>}{module.description && <p className="text-xs text-muted-foreground">{module.description}</p>}<SectionBadges sections={module.sections} />{module.content && <pre className="max-h-52 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-5 text-muted-foreground">{module.content}</pre>}<div className="flex justify-end"><Button variant="outline" size="sm" onClick={() => setEditing(module)}><Pencil className="mr-1 size-3.5" />编辑模块详情</Button></div></div>}</article>; })}{modules.length > 0 && !filteredModules.length && <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">没有匹配的模块</div>}{!modules.length && <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-border bg-card/50 p-6 text-center"><div><Code2 className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="text-sm font-medium text-foreground">尚未添加模块</p><p className="mt-1 text-xs text-muted-foreground">可添加远程 URL 或导入本地 {platform} 源码。</p></div></div>}</div></div>
    <footer className="flex items-center justify-between border-t border-border bg-card px-4 py-3 text-xs text-muted-foreground"><span>模块总计 {modules.length} · 远程 {remote} · 本地 {modules.length - remote}</span><span>更改已同步至预览，保存模板后写入文件</span></footer>
    <ModuleDialog kind={kind} module={editing} onClose={() => setEditing(null)} onSave={(module) => { if (apply(modules.some((item) => item.id === module.id) ? modules.map((item) => item.id === module.id ? module : item) : [...modules, module])) setEditing(null); }} />
  </section>;
}

function ModuleDialog({ kind, module, onClose, onSave }: { kind: Kind; module: Module | null; onClose: () => void; onSave: (module: Module) => void }) {
  const [draft, setDraft] = useState<Module | null>(module);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(module), [module]);
  if (!draft) return null;
  const patch = (next: Partial<Module>) => setDraft({ ...draft, ...next });
  const applyInspection = (result: Inspection) => { if (kind === "loon" && result.kind !== "loon") throw new Error(`该内容识别为 ${result.kind}，不是 Loon 插件`); patch({ name: draft.name || result.name, description: result.description || draft.description, author: result.author || draft.author, version: result.version || draft.version, icon: result.icon || draft.icon, content: result.content || draft.content, sections: result.sections || {}, tags: result.tags || draft.tags }); };
  const inspectRemote = async () => { if (!draft.url.trim() || draft.local) return; setBusy(true); try { applyInspection(await inspectUrl(draft.url.trim())); toast.success("模块格式识别成功"); } catch (error) { toast.error(error instanceof Error ? error.message : "模块识别失败"); } finally { setBusy(false); } };
  const inspectLocal = async () => { if (!draft.content.trim()) return; setBusy(true); try { applyInspection(await inspectContent(draft.content)); toast.success("本地模块语法校验通过"); } catch (error) { toast.error(error instanceof Error ? error.message : "模块校验失败"); } finally { setBusy(false); } };
  return <Dialog open={Boolean(module)} onOpenChange={(open) => !open && onClose()}><DialogContent className="max-h-[92svh] max-w-3xl overflow-y-auto border-border bg-card p-0 text-card-foreground sm:p-0"><DialogHeader className="border-b border-border bg-muted/30 px-6 py-5"><DialogTitle>{module?.name ? "编辑模块 / 插件" : "新建模块 / 插件"}</DialogTitle><DialogDescription>{kind === "egern" ? "Egern YAML Module" : "Loon .plugin"} · 内容按原生语法校验。</DialogDescription></DialogHeader><div className="grid gap-4 p-6"><div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">{kind === "egern" ? "模块名称" : "面板名称（Loon 引用不保存名称）"}<Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如 YouTube 广告拦截" /></label><label className="grid gap-1.5 text-xs font-medium">版本（源码元数据）<Input value={draft.version} onChange={(event) => patch({ version: event.target.value })} placeholder="v1.0.0" /></label></div><div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">作者<Input value={draft.author} onChange={(event) => patch({ author: event.target.value })} /></label>{kind === "egern" ? <label className="grid gap-1.5 text-xs font-medium">远程更新周期（秒）<Input type="number" min="60" value={draft.interval} onChange={(event) => patch({ interval: interval(event.target.value) })} /><small className="font-normal text-muted-foreground">写入 Egern 的 update_interval；面板不执行刷新。</small></label> : <div className="flex items-center rounded-md border border-border bg-muted/20 px-3 text-xs text-muted-foreground">Loon 插件更新由 Loon 客户端管理</div>}</div><div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">描述<Input value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label><label className="grid gap-1.5 text-xs font-medium">图标 URL<Input className="font-mono" value={draft.icon} onChange={(event) => patch({ icon: event.target.value })} placeholder="https://example.com/icon.png" /></label></div><label className="grid gap-1.5 text-xs font-medium">远程 URL / 本地路径<div className="flex gap-2"><Input className="font-mono" value={draft.url} onChange={(event) => patch({ url: event.target.value })} placeholder="https://example.com/module.yaml" /><Button type="button" variant="outline" disabled={draft.local || busy || !draft.url.trim()} onClick={() => void inspectRemote()}>{busy ? "识别中…" : "拉取并识别"}</Button></div></label><div className="grid gap-2 rounded-lg border border-border bg-muted/20 p-2 sm:grid-cols-2"><button type="button" className={`rounded-md px-3 py-2 text-left text-xs transition-colors ${!draft.local ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-background"}`} onClick={() => patch({ local: false })}><b className="block">HTTP / HTTPS 远程</b><small className="opacity-80">由 Egern/Loon 客户端更新</small></button><button type="button" className={`rounded-md px-3 py-2 text-left text-xs transition-colors ${draft.local ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-background"}`} onClick={() => patch({ local: true })}><b className="block">本地文件引用</b><small className="opacity-80">引用客户端可访问的 .plugin / .yaml 文件</small></button></div>{kind === "egern" && <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">模块参数覆盖（compat_arguments）<textarea className="min-h-24 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" value={draft.compatArguments} onChange={(event) => patch({ compatArguments: event.target.value })} placeholder="API_KEY: demo\nREGION: cn" /></label><label className="grid gap-1.5 text-xs font-medium">环境变量（env）<textarea className="min-h-24 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" value={draft.env} onChange={(event) => patch({ env: event.target.value })} placeholder={'REFRESH_INTERVAL: "300"'} /></label></div>}<label className="grid gap-1.5 text-xs font-medium">模块源码预览（不写入模板引用）<textarea className="min-h-48 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" value={draft.content} onChange={(event) => patch({ content: event.target.value })} placeholder={kind === "loon" ? "#!name=...\n[Rewrite]\n..." : "name: ...\nurl_rewrites:\n  - ..."} /></label>{draft.content.trim() && !(kind === "egern" && /^\s*(?:#!|\[)/m.test(draft.content)) && <StructuredDirectives kind={kind} value={draft.content} onChange={(content) => patch({ content })} />}<div className="flex items-center justify-between"><SectionBadges sections={draft.sections} />{draft.content.trim() && <Button type="button" variant="outline" size="sm" onClick={() => void inspectLocal()} disabled={busy}>校验并提取结构</Button>}</div>{kind === "loon" && <label className="grid gap-1.5 text-xs font-medium">插件标签（逗号分隔）<Input value={draft.tags.join(", ")} onChange={(event) => patch({ tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="boxjs, official" /></label>}</div><DialogFooter className="border-t border-border bg-muted/15 px-6 py-4"><Button variant="outline" onClick={onClose}><X className="mr-1 size-4" />取消</Button><Button disabled={!draft.name.trim() || !draft.url.trim()} onClick={() => onSave({ ...draft, content: writeModuleMetadata(kind, draft.content, draft) })}>保存模块</Button></DialogFooter></DialogContent></Dialog>;
}
