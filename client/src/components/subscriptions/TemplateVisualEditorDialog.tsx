import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  Check,
  Clipboard,
  Code2,
  Copy,
  Eye,
  GripVertical,
  Plus,
  RefreshCw,
  Search,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  parseDocument as parseYamlDocument,
  stringify as stringifyYaml,
} from "yaml";
import { toast } from "sonner";
import { EgernVisualEditor } from "@/components/subscriptions/EgernVisualEditor";
import { LoonVisualEditor } from "@/components/subscriptions/LoonVisualEditor";

type Group = {
  name: string;
  type: string;
  proxies: string[];
  hidden?: boolean;
  url?: string;
  interval?: string;
  tolerance?: string;
  filter?: string;
  excludeFilter?: string;
};
type Rule = {
  type: string;
  value: string;
  target: string;
  enabled: boolean;
  noResolve?: boolean;
};
type Props = {
  open: boolean;
  saving: boolean;
  filename: string;
  text: string;
  onClose: () => void;
  onSave: (filename: string, text: string) => Promise<void> | void;
};

const groupTypes = ["select", "url-test", "fallback", "load-balance", "relay"];
const groupLabels: Record<string, string> = {
  select: "手动选择",
  "url-test": "自动测速",
  fallback: "故障转移",
  "load-balance": "负载均衡",
  relay: "链式代理",
};
const ruleTypes = [
  "DOMAIN",
  "DOMAIN-SUFFIX",
  "DOMAIN-KEYWORD",
  "DOMAIN-WILDCARD",
  "DOMAIN-REGEX",
  "GEOSITE",
  "IP-CIDR",
  "IP-CIDR6",
  "IP-SUFFIX",
  "IP-ASN",
  "GEOIP",
  "SRC-IP-CIDR",
  "SRC-IP-SUFFIX",
  "SRC-IP-ASN",
  "SRC-GEOIP",
  "DST-PORT",
  "SRC-PORT",
  "IN-PORT",
  "IN-TYPE",
  "IN-USER",
  "IN-NAME",
  "REMATCH-NAME",
  "PROCESS-NAME",
  "PROCESS-NAME-WILDCARD",
  "PROCESS-NAME-REGEX",
  "PROCESS-PATH",
  "PROCESS-PATH-WILDCARD",
  "PROCESS-PATH-REGEX",
  "UID",
  "NETWORK",
  "DSCP",
  "RULE-SET",
  "AND",
  "OR",
  "NOT",
  "SUB-RULE",
  "MATCH",
];

const editorFieldClass =
  "border border-border bg-background text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/30";

type CodeLanguage = "clash" | "egern" | "loon";

function highlightLine(line: string, language: CodeLanguage): ReactNode[] {
  if (!line) return [" "];
  const parts = line.match(/(#[^\n]*|;[^\n]*|\[[^\]]+\]|"[^"\n]*"|'[^'\n]*'|\b(?:true|false|null|yes|no)\b|\b\d+(?:\.\d+)?\b|[{}\[\],]|\b(?:DIRECT|REJECT|MATCH|DOMAIN(?:-SUFFIX|-KEYWORD|-REGEX|-WILDCARD)?|GEOIP|GEOSITE|IP-CIDR6?|RULE-SET|PROCESS-NAME|NETWORK|url-test|fallback|load-balance|select|auto_test|smart|policy_groups|proxy-groups|rule-providers|rules|proxies)\b)/gi) || [line];
  let cursor = 0;
  const nodes: ReactNode[] = [];
  const addPlain = (value: string) => value && nodes.push(value);
  parts.forEach((token, index) => {
    const position = line.indexOf(token, cursor);
    addPlain(line.slice(cursor, position));
    cursor = position + token.length;
    const isComment = token.startsWith("#") || token.startsWith(";");
    const isSection = token.startsWith("[") && token.endsWith("]");
    const isQuoted = token.startsWith("'") || token.startsWith('"');
    const isValue = /^(true|false|null|yes|no)$/i.test(token);
    const isNumber = /^\d/.test(token);
    const isPunctuation = /^[{}\[\],]$/.test(token);
    const color = isComment
      ? "text-emerald-600/80 dark:text-emerald-400/80"
      : isSection
        ? "text-violet-600 dark:text-violet-300"
        : isQuoted
          ? "text-amber-700 dark:text-amber-300"
          : isValue
            ? "text-fuchsia-600 dark:text-fuchsia-300"
            : isNumber
              ? "text-sky-600 dark:text-sky-300"
              : isPunctuation
                ? "text-muted-foreground"
                : "text-cyan-700 dark:text-cyan-300";
    nodes.push(<span key={`${token}-${index}`} className={color}>{token}</span>);
  });
  addPlain(line.slice(cursor));
  const keyMatch = line.match(/^(\s*(?:-\s*)?)([\w-]+)(?=\s*:)/);
  if (!keyMatch) return nodes;
  // Rebuild YAML key prefixes so structural keys remain distinct from values.
  const prefix = keyMatch[1];
  const key = keyMatch[2];
  const rest = line.slice(prefix.length + key.length);
  return [prefix, <span key="yaml-key" className="text-blue-700 dark:text-blue-300">{key}</span>, ...highlightLine(rest, language)];
}

function CodeSurface({
  value,
  onChange,
  language,
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);
  const lineRef = useRef<HTMLPreElement>(null);
  const lines = value.replace(/\r/g, "").split("\n");
  const syncScroll = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    if (overlayRef.current) overlayRef.current.style.transform = transform;
    if (lineRef.current) lineRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
  };
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[linear-gradient(90deg,hsl(var(--muted)/.55)_0, hsl(var(--muted)/.55)_3.5rem,transparent_3.5rem)] font-mono text-[12px] leading-7">
      <div className="absolute inset-0 overflow-hidden">
        <pre ref={lineRef} aria-hidden className="pointer-events-none absolute left-0 top-0 w-14 select-none border-r border-border/70 py-4 pr-3 text-right text-[11px] leading-7 text-muted-foreground/70">
          {lines.map((_, index) => <div key={index}>{index + 1}</div>)}
        </pre>
        <pre ref={overlayRef} aria-hidden className="pointer-events-none absolute left-14 top-0 min-w-max py-4 pl-4 pr-6 text-foreground">
          {lines.map((line, index) => {
            const indent = Math.floor((line.match(/^\s*/)?.[0].length || 0) / 2);
            return <div key={index} className="relative h-7 whitespace-pre">
              {Array.from({ length: indent }, (_, guide) => <i key={guide} className="absolute top-0 h-7 border-l border-dashed border-primary/25" style={{ left: `${guide * 14 + 8}px` }} />)}
              {highlightLine(line, language)}
            </div>;
          })}
        </pre>
      </div>
      {readOnly ? (
        <div className="relative z-10 h-full overflow-auto pl-14" onScroll={(event) => {
          const target = event.currentTarget;
          if (overlayRef.current) overlayRef.current.style.transform = `translate(${-target.scrollLeft}px, ${-target.scrollTop}px)`;
          if (lineRef.current) lineRef.current.style.transform = `translateY(${-target.scrollTop}px)`;
        }} />
      ) : (
        <textarea
          ref={textareaRef}
          aria-label={`${language} 代码`}
          className="relative z-10 block h-full w-full resize-none overflow-auto bg-transparent py-4 pl-[4.5rem] pr-6 font-mono text-[12px] leading-7 text-transparent caret-foreground outline-none selection:bg-primary/30"
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          wrap="off"
        />
      )}
    </div>
  );
}

function unquote(value: string) {
  return value.trim().replace(/^(?:"|')|(?:"|')$/g, "");
}
function ruleTagClass(type: string) {
  if (type.includes("CIDR") || type.includes("ASN"))
    return "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300";
  if (type === "GEOIP" || type === "GEOSITE")
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  if (type.includes("KEYWORD") || type.includes("REGEX") || type.includes("PROCESS"))
    return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300";
  if (type === "MATCH")
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function TemplateSelect({
  value,
  options,
  onValueChange,
  mono = false,
}: {
  value: string;
  options: string[];
  onValueChange: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={`h-12 rounded-lg border-border bg-background px-3 text-sm text-foreground shadow-sm focus:ring-primary/30 ${mono ? "font-mono" : ""}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => <SelectItem key={option} value={option} className={mono ? "font-mono text-xs" : ""}>{option}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
function parseTemplate(value: string) {
  const document = parseYamlDocument(value, {
    prettyErrors: false,
    strict: true,
  });
  const parsed = document.toJS();
  if (
    !document.errors.length &&
    parsed &&
    !Array.isArray(parsed) &&
    typeof parsed === "object"
  ) {
    const rawGroups = Array.isArray(parsed["proxy-groups"])
      ? parsed["proxy-groups"]
      : [];
    const groups = rawGroups
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
      .map((item) => ({
        name: String(item.name || ""),
        type: String(item.type || "select"),
        proxies: Array.isArray(item.proxies) ? item.proxies.map(String) : [],
        hidden: item.hidden === true,
        url: item.url == null ? "" : String(item.url),
        interval: item.interval == null ? "" : String(item.interval),
        tolerance: item.tolerance == null ? "" : String(item.tolerance),
        filter: item.filter == null ? "" : String(item.filter),
        excludeFilter:
          item["exclude-filter"] == null ? "" : String(item["exclude-filter"]),
      }));
    const rules = (Array.isArray(parsed.rules) ? parsed.rules : [])
      .map(String)
      .filter(Boolean)
      .map((text: string) => {
        const parts = text.split(",").map((part: string) => part.trim());
        return {
          type: parts[0]?.toUpperCase() || "DOMAIN-SUFFIX",
          value: parts[0]?.toUpperCase() === "MATCH" ? "" : parts[1] || "",
          target:
            parts[0]?.toUpperCase() === "MATCH"
              ? parts[1] || ""
              : parts
                  .slice(2)
                  .find((part: string) => !["no-resolve", "src"].includes(part)) || "",
          noResolve: parts.includes("no-resolve"),
          enabled: true,
        };
      });
    const disabledAt = value.indexOf("# 已停用规则（打开开关可恢复）");
    if (disabledAt >= 0) {
      value
        .slice(disabledAt)
        .split("\n")
        .forEach((line) => {
          const match = line.match(/^\s*#\s*-\s*(.+)$/);
          if (!match) return;
          const parts = match[1].split(",").map((part) => part.trim());
          const type = parts[0]?.toUpperCase() || "DOMAIN-SUFFIX";
          rules.push({
            type,
            value: type === "MATCH" ? "" : parts[1] || "",
            target:
              type === "MATCH"
                ? parts[1] || ""
                : parts
                    .slice(2)
                    .reverse()
                    .find((part) => !["no-resolve", "src"].includes(part)) ||
                  "",
            enabled: false,
          });
        });
    }
    return { groups, rules };
  }
  const groups: Group[] = [];
  const rules: Rule[] = [];
  const lines = value.replace(/\r/g, "").split("\n");
  let section = "";
  let current: Group | null = null;
  let collectingProxies = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    const top = line.match(/^([\w-]+):\s*$/);
    if (top) {
      section = top[1];
      current = null;
      collectingProxies = false;
      continue;
    }
    if (
      (section === "proxy-groups" || section === "policy-groups") &&
      /^\s*-\s+name\s*:/.test(line)
    ) {
      current = {
        name: unquote(line.replace(/^\s*-\s+name\s*:\s*/, "")),
        type: "select",
        proxies: [],
      };
      groups.push(current);
      collectingProxies = false;
      continue;
    }
    if (
      (section === "proxy-groups" || section === "policy-groups") &&
      current
    ) {
      const listItem = line.match(/^\s+-\s+(.+?)\s*$/);
      if (collectingProxies && listItem) {
        current.proxies.push(unquote(listItem[1]));
        continue;
      }
      const field = line.match(/^\s+([\w-]+)\s*:\s*(.*?)\s*$/);
      if (!field) continue;
      const [, key, val] = field;
      collectingProxies = key === "proxies" && !val;
      if (key === "type") current.type = unquote(val) || "select";
      if (key === "hidden") current.hidden = val === "true";
      if (key === "url") current.url = unquote(val);
      if (key === "interval") current.interval = unquote(val);
      if (key === "tolerance") current.tolerance = unquote(val);
      if (key === "filter") current.filter = unquote(val);
      if (key === "exclude-filter") current.excludeFilter = unquote(val);
      if (key === "proxies" && val)
        current.proxies = val
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map(unquote)
          .filter(Boolean);
      continue;
    }
    if (section === "rules" && /^\s*-\s*/.test(line)) {
      const disabled = /^\s*#/.test(raw);
      const text = raw.replace(/^\s*#?\s*-\s*/, "").trim();
      const parts = text.split(",").map((part) => part.trim());
      if (!parts[0]) continue;
      rules.push({
        type: parts[0].toUpperCase(),
        value: parts[0].toUpperCase() === "MATCH" ? "" : parts[1] || "",
        target:
          parts[0].toUpperCase() === "MATCH" ? parts[1] || "" : parts[2] || "",
        enabled: !disabled,
        noResolve: parts.includes("no-resolve"),
      });
    }
  }
  return { groups, rules };
}

function yamlQuote(value: string) {
  return /[:#,\[\]{}]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}
function withoutSections(source: string) {
  const lines = source.replace(/\r/g, "").split("\n");
  const output: string[] = [];
  let skip = false;
  for (const line of lines) {
    const section = line.match(
      /^(proxy-groups|policy-groups|rules):\s*(.*?)\s*$/i,
    );
    if (section) {
      skip = !section[2];
      continue;
    }
    if (skip && /^\S/.test(line) && !/^#/.test(line)) skip = false;
    if (!skip) output.push(line);
  }
  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function buildYaml(base: string, groups: Group[], rules: Rule[]) {
  const document = parseYamlDocument(base, {
    prettyErrors: false,
    strict: true,
  });
  const parsed = document.toJS();
  if (
    !document.errors.length &&
    parsed &&
    !Array.isArray(parsed) &&
    typeof parsed === "object"
  ) {
    const root: Record<string, unknown> = { ...parsed };
    root["proxy-groups"] = groups.map(({ excludeFilter, ...group }) => ({
      ...group,
      ...(excludeFilter ? { "exclude-filter": excludeFilter } : {}),
    }));
    root.rules = rules
      .filter((rule) => rule.enabled)
      .map((rule) =>
        rule.type === "MATCH"
          ? `MATCH,${rule.target}`
          : `${rule.type},${rule.value},${rule.target}${rule.noResolve ? ",no-resolve" : ""}`,
      );
    const disabled = rules
      .filter((rule) => !rule.enabled)
      .map(
        (rule) =>
          `# - ${rule.type === "MATCH" ? `MATCH,${rule.target}` : `${rule.type},${rule.value},${rule.target}`}`,
      );
    return `${stringifyYaml(root, { lineWidth: 0 }).trimEnd()}${disabled.length ? `\n\n# 已停用规则（打开开关可恢复）\n${disabled.join("\n")}` : ""}\n`;
  }
  const blocks = groups
    .map((group) =>
      [
        `  - name: ${yamlQuote(group.name || "未命名策略组")}`,
        `    type: ${group.type}`,
        group.hidden ? "    hidden: true" : "",
        group.url ? `    url: ${yamlQuote(group.url)}` : "",
        group.interval ? `    interval: ${group.interval}` : "",
        group.tolerance ? `    tolerance: ${group.tolerance}` : "",
        group.filter ? `    filter: ${yamlQuote(group.filter)}` : "",
        group.excludeFilter
          ? `    exclude-filter: ${yamlQuote(group.excludeFilter)}`
          : "",
        `    proxies: [${group.proxies.map(yamlQuote).join(", ")}]`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  const activeRules = rules
    .filter((rule) => rule.enabled)
    .map(
      (rule) =>
        `  - ${rule.type === "MATCH" ? `MATCH,${rule.target}` : `${rule.type},${rule.value},${rule.target}`}`,
    );
  const disabledRules = rules
    .filter((rule) => !rule.enabled)
    .map(
      (rule) =>
        `  # - ${rule.type === "MATCH" ? `MATCH,${rule.target}` : `${rule.type},${rule.value},${rule.target}`}`,
    );
  return (
    [
      withoutSections(base),
      "proxy-groups:",
      blocks || "  []",
      "rules:",
      ...(activeRules.length ? activeRules : ["  []"]),
      ...disabledRules,
    ]
      .filter(Boolean)
      .join("\n") + "\n"
  );
}

export function TemplateVisualEditorDialog({
  open,
  saving,
  filename: initialFilename,
  text: initialText,
  onClose,
  onSave,
}: Props) {
  const [filename, setFilename] = useState(initialFilename);
  const [source, setSource] = useState(initialText);
  const [groups, setGroups] = useState<Group[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [expandedRules, setExpandedRules] = useState<number[]>([]);
  const [openGroupTypeIndex, setOpenGroupTypeIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<"visual" | "code">("visual");
  const [copied, setCopied] = useState(false);
  const [ruleEditor, setRuleEditor] = useState<{
    index: number | null;
    target: string;
    type: string;
    value: string;
    noResolve: boolean;
  } | null>(null);
  const [memberPickerIndex, setMemberPickerIndex] = useState<number | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const initialOutputRef = useRef(initialText);
  useEffect(() => {
    if (!open) return;
    const parsed = parseTemplate(initialText);
    const nextGroups = parsed.groups.map((group) =>
      ["url-test", "fallback", "load-balance"].includes(group.type)
        ? { ...group, url: group.url || "http://www.gstatic.com/generate_204", interval: group.interval || "300" }
        : group,
    );
    const isClash = !/\.conf$/i.test(initialFilename) && !/^\s*\[/m.test(initialText) && !/^\s*policy_groups\s*:/m.test(initialText);
    initialOutputRef.current = isClash
      ? buildYaml(initialText, nextGroups, parsed.rules)
      : initialText;
    setFilename(initialFilename);
    setSource(initialText);
    setGroups(nextGroups);
    setRules(parsed.rules);
    setExpanded([]);
    setExpandedRules([]);
    setMode("visual");
    setCloseConfirmOpen(false);
  }, [open, initialFilename, initialText]);
  const yaml = useMemo(
    () => buildYaml(source, groups, rules),
    [source, groups, rules],
  );
  const codePreview = useMemo(
    () =>
      stringifyYaml(
        { "proxy-groups": parseTemplate(source).groups },
        { lineWidth: 0 },
      ),
    [source],
  );
  const ruleProviderNames = useMemo(() => {
    const parsed = parseYamlDocument(source, {
      prettyErrors: false,
      strict: true,
    }).toJS();
    const providers =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["rule-providers"]
        : null;
    return providers &&
      typeof providers === "object" &&
      !Array.isArray(providers)
      ? Object.keys(providers as Record<string, unknown>).sort()
      : [];
  }, [source]);
  const hasUnsavedChanges =
    filename !== initialFilename ||
    (mode === "code" ? source : yaml) !== initialOutputRef.current;
  const requestClose = () => {
    if (hasUnsavedChanges) {
      setCloseConfirmOpen(true);
      return;
    }
    onClose();
  };
  const update = (index: number, patch: Partial<Group>) =>
    setGroups((items) =>
      items.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    );
  const move = (index: number, amount: number) =>
    setGroups((items) => {
      const next = [...items];
      const destination = index + amount;
      if (destination < 0 || destination >= next.length) return items;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  const templateKind =
    /\.conf$/i.test(initialFilename) || /^\s*\[/m.test(initialText)
      ? "loon"
      : /^\s*policy_groups\s*:/m.test(initialText)
        ? "egern"
        : "clash";
  const codeLanguage = templateKind as CodeLanguage;
  const codeFormatLabel = templateKind === "loon" ? "Loon INI" : templateKind === "egern" ? "Egern YAML" : "Clash YAML";
  const visualAvailable = templateKind === "clash";
  const currentOutput =
    templateKind === "clash" && mode === "visual" ? yaml : source;
  const ruleTargetOptions = useMemo(
    () => [...new Set([...groups.map((group) => group.name.trim()).filter(Boolean), "DIRECT", "REJECT"])],
    [groups],
  );
  const memberPickerGroup = memberPickerIndex === null ? null : groups[memberPickerIndex] || null;
  const memberCandidates = useMemo(() => {
    const keyword = memberQuery.trim().toLowerCase();
    return ["DIRECT", "REJECT", ...groups.map((group) => group.name.trim()).filter(Boolean)]
      .filter((name, index, values) => values.indexOf(name) === index)
      .filter((name) => name !== memberPickerGroup?.name)
      .filter((name) => !keyword || name.toLowerCase().includes(keyword));
  }, [groups, memberPickerGroup?.name, memberQuery]);
  const save = async () => {
    const names = groups.map((group) => group.name.trim());
    if (!filename.trim()) return;
    if (
      templateKind === "clash" &&
      mode === "visual" &&
      (names.some((name) => !name) || new Set(names).size !== names.length)
    ) {
      toast.error("每个代理组都需要唯一的名称");
      return;
    }
    const invalid = rules.find(
      (rule) =>
        !rule.target.trim() || (rule.type !== "MATCH" && !rule.value.trim()),
    );
    if (templateKind === "clash" && mode === "visual" && invalid) {
      toast.error("请完善规则的匹配内容和目标策略组");
      return;
    }
    if (templateKind !== "loon") {
      const document = parseYamlDocument(currentOutput, {
        prettyErrors: false,
        strict: true,
      });
      if (document.errors.length) {
        toast.error(`YAML 格式错误：${document.errors[0].message}`);
        return;
      }
    } else if (!/^\s*\[[^\]]+\]/m.test(currentOutput)) {
      toast.error("Loon 配置至少需要一个 INI 分段，例如 [Proxy Group]");
      return;
    }
    await onSave(filename.trim(), currentOutput);
  };
  const toggle = (
    list: number[],
    value: number,
    set: (next: number[]) => void,
  ) =>
    set(
      list.includes(value)
        ? list.filter((item) => item !== value)
        : [...list, value],
    );
  const editorTabs = (
    <div className="flex gap-1 font-medium">
      <button
        className={`border-b-2 px-1 py-2 text-sm transition-colors ${mode === "visual" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        onClick={() => setMode("visual")}
      >
        <Eye className="mr-1 inline h-3.5 w-3.5" />
        可视化编辑
      </button>
      <button
        className={`border-b-2 px-1 py-2 text-sm transition-colors ${mode === "code" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        onClick={() => setMode("code")}
      >
        <Code2 className="mr-1 inline h-3.5 w-3.5" />
        {templateKind === "loon" ? "INI 代码" : "YAML 代码"}
      </button>
    </div>
  );
  const allGroupsExpanded = groups.length > 0 && expanded.length === groups.length;
  const toggleAllGroups = () =>
    setExpanded(allGroupsExpanded ? [] : groups.map((_, index) => index));
  const saveRuleEditor = () => {
    if (!ruleEditor) return;
    const type = ruleEditor.type;
    if (type !== "MATCH" && !ruleEditor.value.trim()) {
      toast.error("请输入匹配内容");
      return;
    }
    if (
      ["IP-CIDR", "IP-CIDR6"].includes(type) &&
      !(() => {
        const match = ruleEditor.value
          .trim()
          .match(/^([0-9a-fA-F:.]+)\/(\d{1,3})$/);
        if (!match) return false;
        const isV4 =
          /^\d{1,3}(?:\.\d{1,3}){3}$/.test(match[1]) &&
          match[1].split(".").every((part) => Number(part) <= 255);
        return Number(match[2]) <= (isV4 ? 32 : 128);
      })()
    ) {
      toast.error("请输入合法 CIDR，例如 1.2.3.0/24");
      return;
    }
    if (
      ["DST-PORT", "SRC-PORT"].includes(type) &&
      !/^\d+(?:-\d+)?(?:[\/,]\d+(?:-\d+)?)*$/.test(ruleEditor.value.trim())
    ) {
      toast.error("端口必须为 1-65535，可填写 80、80-443 或 80/443");
      return;
    }
    if (
      type === "RULE-SET" &&
      !ruleProviderNames.includes(ruleEditor.value.trim())
    ) {
      toast.error("请选择当前模板 rule-providers 中已有的规则集");
      return;
    }
    if (
      ["IP-ASN", "SRC-IP-ASN", "UID", "DSCP"].includes(type) &&
      !/^\d+$/.test(ruleEditor.value.trim())
    ) {
      toast.error("该规则的匹配内容必须是数字");
      return;
    }
    if (
      ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-WILDCARD"].includes(type) &&
      !/^[*?a-zA-Z0-9.-]+$/.test(ruleEditor.value.trim())
    ) {
      toast.error("域名只能包含字母、数字、点、连字符和通配符");
      return;
    }
    if (type === "NETWORK" && !/^(tcp|udp)$/i.test(ruleEditor.value.trim())) {
      toast.error("NETWORK 仅支持 tcp 或 udp");
      return;
    }
    const next: Rule = {
      type,
      value: type === "MATCH" ? "" : ruleEditor.value.trim(),
      target: ruleEditor.target,
      enabled: true,
      noResolve: ruleEditor.noResolve,
    };
    setRules((items) =>
      ruleEditor.index === null
        ? [...items, next]
        : items.map((item, index) =>
            index === ruleEditor.index
              ? { ...next, enabled: item.enabled }
              : item,
          ),
    );
    setRuleEditor(null);
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent className="flex h-[calc(100svh-50px)] max-h-[calc(100svh-50px)] w-[calc(100vw-1.5rem)] max-w-[1560px] flex-col gap-0 overflow-hidden border border-border bg-card p-0 text-card-foreground shadow-2xl [&>button]:hidden sm:w-[calc(100vw-3rem)] sm:p-0">
          <DialogHeader className="relative shrink-0 border-b border-border bg-muted/30 px-6 py-4 pr-20">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-primary/10 text-primary"><Code2 className="size-5" /></div>
              <div className="min-w-0"><DialogTitle className="flex items-center gap-2 truncate text-lg font-bold text-foreground">{filename || "编辑模板"}<span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary">{templateKind === "clash" ? "Mihomo Template" : templateKind.toUpperCase()}</span></DialogTitle><DialogDescription className="mt-0.5 text-xs text-muted-foreground">编辑代理分流与规则集模板配置</DialogDescription></div>
              <label className="ml-0 flex h-9 w-[280px] shrink-0 flex-nowrap items-center gap-2 rounded-md border border-border bg-background px-3 font-mono text-xs text-muted-foreground sm:ml-4"><span className="whitespace-nowrap">文件名</span><Input value={filename} onChange={(event) => setFilename(event.target.value)} placeholder="my-clash.yaml" className="h-7 min-w-0 border-0 bg-transparent p-0 font-mono text-sm text-foreground shadow-none focus-visible:ring-0" /></label>
              <div className="ml-auto flex items-center gap-2"><Button disabled={saving || !filename.trim()} onClick={() => void save()} className="h-9 bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90"><Save className="mr-1.5 size-4" />{saving ? "保存中…" : "保存模板"}</Button></div>
            </div>
            <Button variant="ghost" size="icon" onClick={requestClose} className="absolute right-2 top-4 size-9 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-5" /></Button>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/15 px-6 py-2.5"><div className="flex gap-6">{editorTabs}</div><div className="hidden items-center gap-5 font-mono text-[11px] text-muted-foreground md:flex"><span className="inline-flex items-center gap-2 text-primary"><i className="size-2 rounded-full bg-primary" />语法校验通过</span><span>UTF-8</span></div></div>
            {mode === "code" ? (
              <div className="grid min-h-0 flex-1 gap-4 overflow-hidden bg-muted/20 p-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,.95fr)]">
                <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
                  <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3 text-sm font-semibold text-foreground">
                    <span className="font-mono"><i className="mr-2 inline-block size-2 rounded-full bg-primary" />{codeFormatLabel} 全量编辑器</span><span className="font-mono text-[11px] font-normal text-muted-foreground">语法高亮 · 实时编辑</span>
                  </header>
                  <CodeSurface
                    value={source}
                    onChange={setSource}
                    language={codeLanguage}
                  />
                </section>
                <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background">
                  <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">配置代码预览 <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{codeFormatLabel}</span></p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{templateKind === "clash" ? "由左侧配置自动计算展开的 proxy-groups 数据拓扑" : "与左侧一致的只读语法预览"}</p>
                    </div>
                    <Button
                      aria-label="复制预览"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        void navigator.clipboard?.writeText(codePreview);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1200);
                      }}
                    >
                      {copied ? (
                        <Clipboard className="h-4 w-4 text-primary" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </header>
                  <CodeSurface value={templateKind === "clash" ? (codePreview || "# 暂无代理组配置") : source} language={codeLanguage} readOnly />
                </section>
              </div>
            ) : (
              <div className="grid min-h-0 flex-1 gap-4 overflow-hidden bg-muted/20 p-4 lg:grid-cols-[minmax(0,1.04fr)_minmax(420px,.96fr)]">
                <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                  <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        代理组配置 <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">
                          {groups.length}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        按策略组管理成员与流量规则
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground" onClick={toggleAllGroups}>
                        {allGroupsExpanded ? "全部收起" : "全部展开"}
                      </Button>
                      <Button
                        size="sm"
                        className="bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                        onClick={() => {
                          setGroups((items) => [
                            ...items,
                            { name: `策略组 ${items.length + 1}`, type: "select", proxies: ["DIRECT"] },
                          ]);
                          setExpanded((items) => [...items, groups.length]);
                        }}
                      >
                        <Plus className="mr-1 h-4 w-4" />
                        添加代理组
                      </Button>
                    </div>
                  </header>
                  {templateKind === "egern" ? (
                    <div className="min-h-0 flex-1 overflow-hidden [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_select]:border-border [&_select]:bg-background [&_select]:text-foreground">
                    <EgernVisualEditor
                      value={source}
                      onChange={setSource}
                      onError={(message) => {
                        if (message) toast.error(message);
                      }}
                    />
                    </div>
                  ) : templateKind === "loon" ? (
                    <div className="min-h-0 flex-1 overflow-hidden [&_input]:border-border [&_input]:bg-background [&_input]:text-foreground [&_select]:border-border [&_select]:bg-background [&_select]:text-foreground">
                    <LoonVisualEditor
                      value={source}
                      onChange={setSource}
                      onError={(message) => {
                        if (message) toast.error(message);
                      }}
                    />
                    </div>
                  ) : !visualAvailable ? (
                    <div className="m-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
                      此模板为 Surge、Loon 或 Egern 格式，请使用 YAML
                      代码直接编辑；Clash YAML 可使用策略组与规则可视化编辑。
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-auto p-3">
                      {groups.length === 0 ? (
                        <div className="grid h-48 place-items-center text-sm text-muted-foreground">
                          暂无代理组，点击“添加代理组”开始配置
                        </div>
                      ) : (
                        groups.map((group, index) => (
                          <article
                            key={index}
                            className="mb-2 overflow-hidden rounded-lg border border-border bg-card shadow-sm"
                          >
                              <div className="flex min-h-14 items-center gap-2 px-3">
                              <button
                                aria-label={`展开策略组 ${group.name}`}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                onClick={() =>
                                  toggle(expanded, index, setExpanded)
                                }
                              >
                                <GripVertical className="h-4 w-4 text-muted-foreground" />
                                <strong className="truncate text-sm text-foreground">
                                  {group.name || `未命名策略组 ${index + 1}`}
                                </strong>
                                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                  {groupLabels[group.type] || group.type}
                                </span>
                                <span className="hidden min-w-0 truncate font-mono text-[10px] text-muted-foreground sm:inline">
                                  · {group.type === "url-test" ? `自动测速 · 间隔 ${group.interval || 300}s` : `${rules.filter((rule) => rule.target === group.name).length} 条规则`} · {group.proxies.length} 个成员
                                </span>
                                {expanded.includes(index) ? (
                                  <ChevronUp className="ml-auto h-4 w-4" />
                                ) : (
                                  <ChevronDown className="ml-auto h-4 w-4" />
                                )}
                              </button>
                              <Button
                                aria-label="上移策略组"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-foreground"
                                disabled={!index}
                                onClick={() => move(index, -1)}
                              >
                                <ChevronUp className="h-4 w-4" />
                              </Button>
                              <Button
                                aria-label="下移策略组"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:bg-muted hover:text-foreground"
                                disabled={index === groups.length - 1}
                                onClick={() => move(index, 1)}
                              >
                                <ChevronDown className="h-4 w-4" />
                              </Button>
                              <Button
                                aria-label="删除策略组"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                                onClick={() =>
                                  setGroups((items) =>
                                    items.filter(
                                      (_, itemIndex) => itemIndex !== index,
                                    ),
                                  )
                                }
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                            {expanded.includes(index) && (
                              <div className="space-y-4 border-t border-border bg-muted/20 p-4">
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <label className="grid gap-1.5 text-xs font-medium">
                                    策略组名称
                                    <Input
                                      className={editorFieldClass}
                                      value={group.name}
                                      onChange={(event) =>
                                        update(index, {
                                          name: event.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                  <label className="grid gap-1.5 text-xs font-medium">
                                    组类型
                                    <div className="relative">
                                      <button
                                        type="button"
                                        aria-expanded={openGroupTypeIndex === index}
                                        className={`flex h-10 w-full items-center justify-between rounded-md px-3 text-left text-sm ${editorFieldClass}`}
                                        onClick={() => setOpenGroupTypeIndex((current) => current === index ? null : index)}
                                      >
                                        <span>{groupLabels[group.type] || group.type}</span>
                                        <ChevronDown className={`size-4 shrink-0 transition-transform ${openGroupTypeIndex === index ? "rotate-180" : ""}`} />
                                      </button>
                                      {openGroupTypeIndex === index && (
                                        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg">
                                          {groupTypes.map((type) => (
                                            <button
                                              type="button"
                                              key={type}
                                              className="flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-sm hover:bg-accent"
                                              onClick={() => {
                                                update(index, {
                                                  type,
                                                  ...( ["url-test", "fallback", "load-balance"].includes(type) && !group.url ? { url: "http://www.gstatic.com/generate_204" } : {}),
                                                  ...( ["url-test", "fallback", "load-balance"].includes(type) && !group.interval ? { interval: "300" } : {}),
                                                });
                                                setOpenGroupTypeIndex(null);
                                              }}
                                            >
                                              {groupLabels[type]}
                                              {group.type === type && <Check className="size-4 text-primary" />}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  </label>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-3">
                                  {["url-test", "fallback", "load-balance"].includes(group.type) && <>
                                    <label className="grid gap-1.5 text-xs font-medium">
                                      测速 URL
                                      <Input className={editorFieldClass} value={group.url || ""} onChange={(event) => update(index, { url: event.target.value })} placeholder="http://www.gstatic.com/generate_204" />
                                    </label>
                                    <label className="grid gap-1.5 text-xs font-medium">
                                      间隔（秒）
                                      <Input className={editorFieldClass} value={group.interval || ""} onChange={(event) => update(index, { interval: event.target.value })} placeholder="300" />
                                    </label>
                                  </>}
                                  <label className="flex items-end gap-2 pb-2 text-xs font-medium">
                                    <Switch
                                      checked={Boolean(group.hidden)}
                                      onCheckedChange={(hidden) =>
                                        update(index, { hidden })
                                      }
                                    />
                                    隐藏策略组
                                  </label>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <label className="grid gap-1.5 text-xs font-medium">筛选关键词（filter）<Input className={editorFieldClass} value={group.filter || ""} onChange={(event) => update(index, { filter: event.target.value })} placeholder="例如：香港|HK|Hong Kong" /></label>
                                  <label className="grid gap-1.5 text-xs font-medium">排除关键词（exclude-filter）<Input className={editorFieldClass} value={group.excludeFilter || ""} onChange={(event) => update(index, { excludeFilter: event.target.value })} placeholder="例如：游戏|IPLC|Traffic" /></label>
                                </div>
                                <section className="space-y-2">
                                  <div className="flex items-center justify-between text-xs font-medium"><span>代理组成员</span><span className="text-muted-foreground">已选 {group.proxies.length} 项</span></div>
                                  <div className="space-y-2">
                                    {group.proxies.map((member, memberIndex) => <div key={`${member}-${memberIndex}`} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm"><GripVertical className="size-4 text-muted-foreground" /><span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{member === "DIRECT" || member === "REJECT" ? "BUILT-IN" : "GROUP"}</span><span className="min-w-0 flex-1 truncate">{member}</span><Button variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive" onClick={() => update(index, { proxies: group.proxies.filter((_, itemIndex) => itemIndex !== memberIndex) })}>移除</Button></div>)}
                                  </div>
                                  <Button variant="outline" className="w-full border-dashed" onClick={() => { setMemberQuery(""); setMemberPickerIndex(index); }}><Plus className="mr-1 size-4" />添加成员</Button>
                                </section>
                                <section className="border-t border-border/70 pt-3">
                                  <div className="mb-3 flex items-center justify-between gap-2">
                                    <button
                                      className="flex items-center gap-2 text-left text-xs font-semibold text-foreground"
                                      onClick={() => toggle(expandedRules, index, setExpandedRules)}
                                    >
                                      流量规则
                                      <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary">
                                        {rules.filter((rule) => rule.target === group.name).length} 条规则
                                      </span>
                                    </button>
                                    <div className="flex items-center gap-1">
                                      <Button size="sm" variant="outline" className="h-7 border-primary/40 bg-primary/10 px-2.5 text-xs text-primary hover:bg-primary/15 hover:text-primary" onClick={() => setRuleEditor({ index: null, target: group.name, type: "DOMAIN-SUFFIX", value: "", noResolve: false })}>
                                        <Plus className="mr-1 size-3.5" />添加规则
                                      </Button>
                                      <Button variant="ghost" size="sm" className="h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => toggle(expandedRules, index, setExpandedRules)}>
                                        {expandedRules.includes(index) ? <ChevronUp className="mr-1 size-3.5" /> : <ChevronDown className="mr-1 size-3.5" />}
                                        {expandedRules.includes(index) ? "收起" : "展开"}
                                      </Button>
                                    </div>
                                  </div>
                                  {expandedRules.includes(index) && (
                                    <div className="overflow-hidden rounded-lg border border-border bg-background">
                                      <div className="grid grid-cols-12 gap-2 border-b border-border bg-muted/55 px-3 py-2 font-sans text-[11px] font-medium text-muted-foreground">
                                        <div className="col-span-3">规则类型</div>
                                        <div className="col-span-4">匹配目标值</div>
                                        <div className="col-span-3">指向策略 / 节点</div>
                                        <div className="col-span-2 pr-1 text-right">操作</div>
                                      </div>
                                      <div className="max-h-64 divide-y divide-border/70 overflow-y-auto font-mono text-xs">
                                        {rules.filter((rule) => rule.target === group.name).map((rule) => {
                                          const ruleIndex = rules.indexOf(rule);
                                          const directTarget = ["DIRECT", "REJECT"].includes(rule.target);
                                          return <div key={ruleIndex} className="grid grid-cols-12 items-center gap-2 px-3 py-2.5 transition-colors hover:bg-muted/45">
                                            <div className="col-span-3 flex min-w-0 flex-wrap items-center gap-1.5">
                                              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ruleTagClass(rule.type)}`}>{rule.type}</span>
                                              {rule.noResolve && <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 font-sans text-[10px] text-amber-700 dark:text-amber-300">no-resolve</span>}
                                            </div>
                                            <div className="col-span-4 truncate text-[11px] text-foreground" title={rule.value}>{rule.type === "MATCH" ? "匹配其余全部流量" : rule.value}</div>
                                            <div className={`col-span-3 flex min-w-0 items-center gap-1 truncate font-sans text-[11px] ${directTarget ? "text-sky-700 dark:text-sky-300" : "text-primary"}`}>
                                              <span>{directTarget ? "→" : "🚀"}</span><span className="truncate font-medium">{rule.target}</span>
                                            </div>
                                            <div className="col-span-2 flex items-center justify-end gap-1.5 font-sans">
                                              <Switch aria-label="启用规则" checked={rule.enabled} onCheckedChange={(enabled) => setRules((items) => items.map((item, position) => position === ruleIndex ? { ...item, enabled } : item))} />
                                              <Button variant="ghost" size="sm" className="h-7 px-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setRuleEditor({ index: ruleIndex, target: rule.target, type: rule.type, value: rule.value, noResolve: Boolean(rule.noResolve) })}>编辑</Button>
                                              <Button variant="ghost" size="sm" className="h-7 px-1 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setRules((items) => items.filter((_, position) => position !== ruleIndex))}>删除</Button>
                                            </div>
                                          </div>;
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </section>
                              </div>
                            )}
                          </article>
                        ))
                      )}
                    </div>
                  )}
                </section>
                <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background">
                  <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">代理组配置预览 <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">YAML 实时同步</span></p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        实时同步当前编辑内容
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        aria-label="刷新预览"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-primary"
                        onClick={() => setSource((current) => current)}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <Button
                        aria-label="复制预览"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-primary"
                        onClick={() => {
                          void navigator.clipboard?.writeText(
                            templateKind === "clash" ? yaml : source,
                          );
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 1200);
                        }}
                      >
                        {copied ? (
                          <Clipboard className="h-4 w-4 text-primary" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </header>
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-background p-5 font-mono text-xs leading-7 text-foreground">
                    {templateKind === "clash" ? yaml : source}
                  </pre>
                </section>
              </div>
            )}
          </div>
          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/30 px-5 py-2.5 text-xs text-muted-foreground">
            <span className="font-mono"><i className="mr-2 inline-block size-2 rounded-full bg-primary" />已同步至内存 · {templateKind === "clash" ? "Clash 内核格式无警告" : `${templateKind.toUpperCase()} 模板`}</span>
            <div className="flex gap-2">
            <Button variant="outline" className="border-border bg-transparent text-foreground hover:bg-muted hover:text-foreground" onClick={requestClose}>
              <X className="mr-1 h-4 w-4" />
              取消
            </Button>
            <Button
              className="bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
              disabled={saving || !filename.trim()}
              onClick={() => void save()}
            >
              {saving ? (
                "保存中…"
              ) : (
                <>
                  <Save className="mr-1 h-4 w-4" />
                  保存
                </>
              )}
            </Button>
            </div>
          </footer>
        </DialogContent>
      </Dialog>
      <Dialog open={memberPickerGroup !== null} onOpenChange={(next) => { if (!next) setMemberPickerIndex(null); }}>
        <DialogContent className="h-[min(760px,calc(100svh-3rem))] max-w-[1180px] gap-0 overflow-hidden border border-border bg-card p-0 text-card-foreground shadow-2xl sm:p-0">
          <DialogHeader className="border-b border-border bg-muted/30 px-6 py-5 pr-16">
            <DialogTitle className="flex items-center gap-3 text-xl text-foreground"><span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary"><Plus className="size-5" /></span>添加成员到代理组</DialogTitle>
            <DialogDescription>目标策略组：{memberPickerGroup?.name || "未命名策略组"} · 选择后会实时同步到 YAML 预览。</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1.15fr_.85fr]">
            <section className="min-h-0 overflow-auto border-r border-border p-5">
              <div className="relative mb-4"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input autoFocus className="pl-9" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索策略组、内置动作或节点名称" /></div>
              <div className="space-y-2">{memberCandidates.map((candidate) => { const selected = memberPickerGroup?.proxies.includes(candidate); return <button type="button" key={candidate} className="flex w-full items-center gap-3 rounded-lg border border-border bg-muted/20 p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5" onClick={() => { if (memberPickerIndex === null || !memberPickerGroup) return; update(memberPickerIndex, { proxies: selected ? memberPickerGroup.proxies.filter((value) => value !== candidate) : [...memberPickerGroup.proxies, candidate] }); }}><span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{candidate === "DIRECT" || candidate === "REJECT" ? "BUILT-IN" : "GROUP"}</span><span className="flex-1 font-medium">{candidate}</span>{selected ? <Check className="size-4 text-primary" /> : <Plus className="size-4 text-muted-foreground" />}</button>; })}</div>
            </section>
            <section className="min-h-0 overflow-auto bg-muted/15 p-5"><div className="mb-3 flex items-center justify-between"><strong>已选成员</strong><span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{memberPickerGroup?.proxies.length || 0} 项</span></div><div className="space-y-2">{memberPickerGroup?.proxies.map((member, index) => <div key={`${member}-${index}`} className="flex items-center gap-2 rounded-lg border border-border bg-card p-3"><GripVertical className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm">{member}</span><Button variant="ghost" size="icon" className="size-8" disabled={!index} onClick={() => { if (memberPickerIndex !== null) update(memberPickerIndex, { proxies: memberPickerGroup.proxies.map((value, position, values) => position === index ? values[index - 1] : position === index - 1 ? values[index] : value) }); }}><ChevronUp className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8" disabled={index === (memberPickerGroup.proxies.length - 1)} onClick={() => { if (memberPickerIndex !== null) update(memberPickerIndex, { proxies: memberPickerGroup.proxies.map((value, position, values) => position === index ? values[index + 1] : position === index + 1 ? values[index] : value) }); }}><ChevronDown className="size-4" /></Button></div>)}</div></section>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-6 py-4"><code className="max-w-[65%] truncate rounded bg-background px-3 py-2 text-xs text-primary">YAML: proxies: [{memberPickerGroup?.proxies.map((item) => `\"${item}\"`).join(", ")}]</code><div className="flex gap-2"><Button variant="outline" onClick={() => setMemberPickerIndex(null)}>取消</Button><Button onClick={() => setMemberPickerIndex(null)}>确认添加（已选 {memberPickerGroup?.proxies.length || 0} 项）</Button></div></div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(ruleEditor)}
        onOpenChange={(value) => {
          if (!value) setRuleEditor(null);
        }}
      >
        <DialogContent className="max-w-[900px] gap-0 overflow-hidden border border-border bg-card p-0 text-card-foreground shadow-2xl sm:p-0">
          <DialogHeader className="border-b border-border bg-muted/30 px-6 py-5 pr-16">
            <DialogTitle className="flex items-center gap-3 text-xl text-foreground"><span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary"><Code2 className="size-5" /></span>
              {ruleEditor?.index === null ? "添加流量规则" : "编辑流量规则"}
            </DialogTitle>
            <DialogDescription className="mt-1 text-muted-foreground">
              规则会关联到当前策略组，并实时写入右侧预览。
            </DialogDescription>
          </DialogHeader>
          {ruleEditor && (
            <div className="grid gap-6 p-6">
              <div className="grid gap-4 md:grid-cols-2"><label className="grid gap-2 text-sm font-semibold text-foreground">
                规则类型 <span className="ml-1 font-mono text-[10px] text-primary">必填</span>
                <TemplateSelect
                  value={ruleEditor.type}
                  options={ruleTypes}
                  mono
                  onValueChange={(type) =>
                    setRuleEditor({
                      ...ruleEditor,
                      type,
                      value: "",
                      noResolve: false,
                    })
                  }
                />
              </label>
              <label className="grid gap-2 text-sm font-semibold text-foreground">指向策略 / 目标代理组 <span className="font-mono text-[10px] text-primary">Policy</span><TemplateSelect value={ruleEditor.target} options={ruleTargetOptions} onValueChange={(target) => setRuleEditor({ ...ruleEditor, target })} /></label></div>
              {ruleEditor.type !== "MATCH" && (
                <label className="grid gap-2 text-sm font-semibold text-foreground">
                  规则目标值 <span className="font-mono text-[10px] text-muted-foreground">CIDR Mask / Target</span>
                  <Input
                    value={ruleEditor.value}
                    onChange={(event) =>
                      setRuleEditor({
                        ...ruleEditor,
                        value: event.target.value,
                      })
                    }
                    placeholder={
                      ruleEditor.type.includes("CIDR")
                        ? "例如 1.2.3.0/24"
                        : "请输入匹配内容"
                    }
                    className="h-12 border-border bg-background font-mono text-foreground placeholder:text-muted-foreground focus-visible:ring-primary" />
                </label>
              )}
              {["IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP"].includes(
                ruleEditor.type,
              ) && (
                <label className="flex items-center justify-between rounded-xl border border-border bg-muted/30 p-4 text-sm">
                  <span><b className="block text-foreground">不解析域名（no-resolve） <em className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 font-mono not-italic text-[10px] text-primary">IP 专属优化</em></b><small className="mt-1 block text-muted-foreground">跳过此规则前的 DNS 解析流程，降低请求响应延迟。</small></span>
                  <Switch
                    checked={ruleEditor.noResolve}
                    onCheckedChange={(noResolve) =>
                      setRuleEditor({ ...ruleEditor, noResolve })
                    }
                  />
                </label>
              )}
              <p className="rounded-xl border border-border bg-muted/20 p-4 font-mono text-sm text-primary">
                {ruleEditor.type}
                {ruleEditor.type === "MATCH"
                  ? ""
                  : `,${ruleEditor.value || "匹配内容"}`}
                ,{ruleEditor.target}
                {ruleEditor.noResolve ? ",no-resolve" : ""}
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-6 py-4">
            <Button variant="outline" className="border-border bg-transparent text-foreground hover:bg-muted hover:text-foreground" onClick={() => setRuleEditor(null)}>
              取消
            </Button>
            <Button className="bg-primary text-primary-foreground shadow-sm hover:bg-primary/90" onClick={saveRuleEditor}>应用规则</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen}>
        <DialogContent className="max-w-[420px] gap-0 overflow-hidden border border-border bg-card p-0 text-card-foreground shadow-2xl sm:p-0 [&>button]:hidden">
          <DialogHeader className="border-b border-border bg-muted/25 px-6 py-5">
            <DialogTitle className="flex items-center gap-3 text-lg text-foreground">
              <span className="grid size-9 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-300"><X className="size-5" /></span>
              放弃未保存的修改？
            </DialogTitle>
            <DialogDescription className="mt-2 text-sm text-muted-foreground">
              当前模板的更改尚未保存，关闭后将无法恢复。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 bg-muted/15 px-6 py-4">
            <Button variant="outline" className="border-border bg-background text-foreground hover:bg-muted" onClick={() => setCloseConfirmOpen(false)}>继续编辑</Button>
            <Button variant="destructive" onClick={() => { setCloseConfirmOpen(false); onClose(); }}>放弃并关闭</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
