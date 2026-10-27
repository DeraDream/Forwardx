import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
};
type Props = {
  value: string;
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
const ruleTypes = [
  "domain",
  "domain_suffix",
  "domain_keyword",
  "domain_regex",
  "domain_wildcard",
  "geoip",
  "ip_cidr",
  "ip_cidr6",
  "asn",
  "url_regex",
  "user_agent",
  "dest_port",
  "protocol",
  "rule_set",
  "default",
];
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
    return { name: "", type, policies: [], ...(settings || {}) } as Group;
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
export function EgernVisualEditor({ value, onChange, onError, onDirtyChange }: Props) {
  const [root, setRoot] = useState<Record<string, unknown>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [expanded, setExpanded] = useState<number[]>([]);
  const markDirty = () => onDirtyChange(true);
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
          policy_groups: groups.map(({ type, policies, ...settings }) => ({
            [type]: {
              ...settings,
              ...(policies.filter(Boolean).length
                ? { policies: policies.filter(Boolean) }
                : {}),
            },
          })),
          rules: rules.map(({ type, ...settings }) => ({ [type]: settings })),
        },
        { lineWidth: 0 },
      ),
    [root, groups, rules],
  );
  const sync = () => { onChange(output); onDirtyChange(false); };
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
  const removeGroup = (index: number) => {
    markDirty();
    const name = groups[index]?.name;
    setGroups((items) => items.filter((_, position) => position !== index));
    setRules((items) => items.filter((rule) => rule.policy !== name));
    setExpanded((items) => items.filter((position) => position !== index).map((position) => position > index ? position - 1 : position));
  };
  return (
    <section className="min-h-0 flex-1 overflow-auto p-3" onChangeCapture={markDirty}>
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
              <GripVertical className="size-4 shrink-0 text-muted-foreground" />
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
                              .map((item) => item.trim()),
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
                  <Select
                    value={rule.type}
                    onValueChange={(type) => {
                      markDirty();
                      setRules((items) =>
                        items.map((item, position) =>
                          position === ruleIndex
                            ? { ...item, type }
                            : item,
                        ),
                      );
                    }}
                  >
                    <SelectTrigger className="h-9 min-w-32 border-input bg-background text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{ruleTypes.map((type) => <SelectItem key={type} value={type} className="text-xs">{type}</SelectItem>)}</SelectContent>
                  </Select>
                  {rule.type !== "default" && (
                    <Input
                      className="h-9"
                      value={rule.match || ""}
                      onChange={(event) =>
                        setRules((items) =>
                          items.map((item, position) =>
                            position === ruleIndex
                              ? { ...item, match: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  )}
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
                    { type: "domain_suffix", match: "", policy: group.name },
                  ]);
                }}
              >
                添加规则
              </Button>
              <Button size="sm" onClick={sync}>
                应用此组更改
              </Button>
            </div>
          )}
        </article>
      ))}
      {!groups.length && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          暂无策略组
        </p>
      )}
    </section>
  );
}
