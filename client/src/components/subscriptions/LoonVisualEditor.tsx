import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Section = { name: string; lines: string[] };
type Group = {
  name: string;
  type: string;
  policies: string[];
  extras: string[];
};
type Rule = { value: string; target: string };
type Props = {
  value: string;
  view?: "groups" | "rules";
  onChange: (value: string) => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
};
const types = ["select", "url-test", "fallback", "load-balance"];
const targetOf = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .reverse()
    .find(
      (part) =>
        part &&
        !["no-resolve", "extended-matching", "force-remote-dns"].includes(
          part.toLowerCase(),
        ),
    ) || "";
function load(value: string) {
  const sections: Section[] = [];
  let current: Section | undefined;
  value
    .replace(/\r/g, "")
    .split("\n")
    .forEach((line) => {
      const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (heading) {
        current = { name: heading[1], lines: [] };
        sections.push(current);
      } else if (current) current.lines.push(line);
    });
  if (!sections.length)
    throw new Error("Loon 配置需要 INI 分段，例如 [Proxy Group]");
  const groupSection = sections.find(
    (item) => item.name.toLowerCase() === "proxy group",
  );
  const ruleSection = sections.find(
    (item) => item.name.toLowerCase() === "rule",
  );
  const groups = (groupSection?.lines || [])
    .filter((line) => line.includes("=") && !/^\s*[#;]/.test(line))
    .map((line) => {
      const [name, raw] = line.split(/=(.*)/s);
      const [type = "select", ...items] = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return {
        name: name.trim(),
        type: types.includes(type) ? type : "select",
        policies: items.filter((item) => !item.includes("=")),
        extras: items.filter((item) => item.includes("=")),
      };
    });
  const rules = (ruleSection?.lines || [])
    .filter((line) => line.trim() && !/^\s*[#;]/.test(line))
    .map((value) => ({ value, target: targetOf(value) }));
  return { sections, groups, rules };
}
export function LoonVisualEditor({ value, view = "groups", onChange, onError, onDirtyChange }: Props) {
  const [sections, setSections] = useState<Section[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [expanded, setExpanded] = useState<number[]>([]);
  const markDirty = () => onDirtyChange(true);
  useEffect(() => {
    try {
      const next = load(value);
      setSections(next.sections);
      setGroups(next.groups);
      setRules(next.rules);
      onDirtyChange(false);
      onError("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Loon 格式错误");
    }
  }, [value]);
  const output = useMemo(() => {
    const next = sections.map((section) => ({
      ...section,
      lines: [...section.lines],
    }));
    const pg = next.find((item) => item.name.toLowerCase() === "proxy group");
    const rs = next.find((item) => item.name.toLowerCase() === "rule");
    if (pg) {
      const notes = pg.lines.filter((line) => !line.trim() || /^\s*[#;]/.test(line));
      pg.lines = [
        ...notes,
        ...groups.map(
        (group) =>
          `${group.name} = ${[group.type, ...group.policies.filter(Boolean), ...group.extras].join(",")}`,
        ),
      ];
    }
    if (rs) {
      const notes = rs.lines.filter((line) => !line.trim() || /^\s*[#;]/.test(line));
      rs.lines = [...notes, ...rules.map((rule) => rule.value)];
    }
    return (
      next
        .map((section) =>
          `[${section.name}]\n${section.lines.join("\n")}`.trimEnd(),
        )
        .join("\n\n") + "\n"
    );
  }, [sections, groups, rules]);
  const groupRules = (name: string) =>
    rules
      .map((rule, index) => ({ rule, index }))
      .filter((item) => item.rule.target === name);
  const renameGroup = (index: number, name: string) => {
    const previous = groups[index]?.name;
    setGroups((items) => items.map((item, position) => position === index ? { ...item, name } : item));
    if (previous !== undefined && previous !== name) {
      setRules((items) => items.map((rule) => rule.target === previous ? { ...rule, target: name, value: rule.value.replace(new RegExp(`,\\s*${previous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), `,${name}`) } : rule));
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
  const removeGroup = (index: number) => {
    markDirty();
    const name = groups[index]?.name;
    setGroups((items) => items.filter((_, position) => position !== index));
    setRules((items) => items.filter((rule) => rule.target !== name));
    setExpanded((items) => items.filter((position) => position !== index).map((position) => position > index ? position - 1 : position));
  };
  if (view === "rules") return <section className="min-h-0 flex-1 overflow-auto p-3" onChangeCapture={markDirty}>
    <div className="mb-3 flex items-center justify-between"><div><strong className="text-sm">Loon 流量规则 · {rules.length}</strong><p className="mt-0.5 text-xs text-muted-foreground">按 [Rule] 原始顺序匹配；一行对应一条 Loon 规则。</p></div><Button size="sm" onClick={() => { markDirty(); setRules((items) => [...items, { value: "DOMAIN-SUFFIX,example.com,DIRECT", target: "DIRECT" }]); }}><Plus className="mr-1 size-4" />添加规则</Button></div>
    <div className="overflow-hidden rounded-xl border border-border"><div className="grid grid-cols-[34px_minmax(180px,1fr)_120px_36px] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-[10px] text-muted-foreground"><span>#</span><span>规则内容</span><span>路由目标</span><span /></div>{rules.map((rule, index) => <div key={index} className="grid grid-cols-[34px_minmax(180px,1fr)_120px_36px] items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"><span className="font-mono text-[11px] text-muted-foreground">{index + 1}</span><Input className="h-8 font-mono text-xs" value={rule.value} onChange={(event) => setRules((items) => items.map((item, position) => position === index ? { value: event.target.value, target: targetOf(event.target.value) } : item))} /><span className="truncate rounded bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary">{rule.target || "未指定"}</span><Button variant="ghost" size="icon" className="size-8 text-destructive" onClick={() => { markDirty(); setRules((items) => items.filter((_, position) => position !== index)); }}><Trash2 className="size-4" /></Button></div>)}</div>
    <div className="mt-3 flex justify-end"><Button onClick={() => { onChange(output); onDirtyChange(false); }}>应用规则更改</Button></div>
  </section>;
  return (
    <section className="min-h-0 flex-1 overflow-auto p-3" onChangeCapture={markDirty}>
      <div className="mb-3 flex items-center justify-between">
        <strong className="text-sm">Loon 策略组 · {groups.length}</strong>
        <Button
          size="sm"
          onClick={() => {
            markDirty();
            setSections((items) =>
              items.some((item) => item.name.toLowerCase() === "proxy group")
                ? items
                : [
                    ...items,
                    { name: "Proxy Group", lines: [] },
                    { name: "Rule", lines: [] },
                  ],
            );
            setGroups((items) => [
              ...items,
              {
                name: `策略组 ${items.length + 1}`,
                type: "select",
                policies: ["__LOON_ALL_NODES__", "DIRECT"],
                extras: [],
              },
            ]);
          }}
        >
          <Plus className="mr-1 h-4 w-4" />
          添加策略组
        </Button>
      </div>
      {groups.map((group, index) => (
        <article key={index} className="mb-3 overflow-hidden rounded-md border border-border/70">
          <div className="flex items-center gap-2 bg-muted/30 px-3 py-2.5">
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold" onClick={() => setExpanded((items) => items.includes(index) ? items.filter((item) => item !== index) : [...items, index])}>
              <GripVertical className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{group.name || `未命名策略组 ${index + 1}`}</span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary">{group.type}</span>
            </button>
            <Button variant="ghost" size="icon" className="size-7" disabled={!index} onClick={() => { markDirty(); moveGroup(index, -1); }}><ChevronUp className="size-4" /></Button>
            <Button variant="ghost" size="icon" className="size-7" disabled={index === groups.length - 1} onClick={() => { markDirty(); moveGroup(index, 1); }}><ChevronDown className="size-4" /></Button>
            <Button variant="ghost" size="icon" className="size-7 text-destructive hover:text-destructive" onClick={() => removeGroup(index)}><Trash2 className="size-4" /></Button>
          </div>
          {expanded.includes(index) && <div className="space-y-3 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              value={group.name}
              onChange={(event) => renameGroup(index, event.target.value)}
            />
            <Select
              value={group.type}
              onValueChange={(type) => {
                markDirty();
                setGroups((items) =>
                  items.map((item, position) =>
                    position === index
                      ? { ...item, type }
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
                          .map((part) => part.trim()),
                      }
                    : item,
                ),
              )
            }
          />
          <div className="border-t pt-2 text-sm font-semibold">
            流量规则（{groupRules(group.name).length}）
          </div>
          {groupRules(group.name).map(({ rule, index: ruleIndex }) => (
            <div key={ruleIndex} className="flex gap-2">
              <Input
                className="h-9"
                value={rule.value}
                onChange={(event) =>
                  setRules((items) =>
                    items.map((item, position) =>
                      position === ruleIndex
                        ? {
                            value: event.target.value,
                            target: targetOf(event.target.value),
                          }
                        : item,
                    ),
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  markDirty();
                  setRules((items) =>
                    items.filter((_, position) => position !== ruleIndex),
                  );
                }}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              markDirty();
              setRules((items) => [
                ...items,
                {
                  value: `DOMAIN-SUFFIX,example.com,${group.name}`,
                  target: group.name,
                },
              ]);
            }}
          >
            添加规则
          </Button>
          </div>}
        </article>
      ))}
      <Button onClick={() => { onChange(output); onDirtyChange(false); }}>应用更改</Button>
    </section>
  );
}
