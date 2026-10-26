import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { parseDocument, stringify } from "yaml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
export function EgernVisualEditor({ value, onChange, onError }: Props) {
  const [root, setRoot] = useState<Record<string, unknown>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [expanded, setExpanded] = useState<number[]>([]);
  useEffect(() => {
    try {
      const next = parse(value);
      setRoot(next.root);
      setGroups(next.groups);
      setRules(next.rules);
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
  const sync = () => onChange(output);
  const groupRules = (name: string) =>
    rules
      .map((rule, index) => ({ rule, index }))
      .filter((item) => item.rule.policy === name);
  return (
    <section className="min-h-0 flex-1 overflow-auto p-3">
      <div className="mb-3 flex items-center justify-between">
        <strong className="text-sm">Egern 策略组 · {groups.length}</strong>
        <Button
          size="sm"
          onClick={() =>
            setGroups((items) => [
              ...items,
              {
                name: `策略组 ${items.length + 1}`,
                type: "select",
                policies: ["DIRECT"],
              },
            ])
          }
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
          <button
            className="flex w-full items-center justify-between bg-muted/30 px-3 py-3 text-left text-sm font-semibold"
            onClick={() =>
              setExpanded((items) =>
                items.includes(index)
                  ? items.filter((item) => item !== index)
                  : [...items, index],
              )
            }
          >
            {group.name || `未命名策略组 ${index + 1}`}
            <span className="text-xs text-muted-foreground">{group.type}</span>
          </button>
          {expanded.includes(index) && (
            <div className="space-y-3 p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  value={group.name}
                  placeholder="策略组名称"
                  onChange={(event) =>
                    setGroups((items) =>
                      items.map((item, position) =>
                        position === index
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <select
                  className="h-10 rounded-md border border-input bg-background px-3"
                  value={group.type}
                  onChange={(event) =>
                    setGroups((items) =>
                      items.map((item, position) =>
                        position === index
                          ? { ...item, type: event.target.value }
                          : item,
                      ),
                    )
                  }
                >
                  {types.map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
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
                  <select
                    className="h-9 rounded border border-input bg-background px-2 text-xs"
                    value={rule.type}
                    onChange={(event) =>
                      setRules((items) =>
                        items.map((item, position) =>
                          position === ruleIndex
                            ? { ...item, type: event.target.value }
                            : item,
                        ),
                      )
                    }
                  >
                    {ruleTypes.map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
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
                    onClick={() =>
                      setRules((items) =>
                        items.filter((_, position) => position !== ruleIndex),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setRules((items) => [
                    ...items,
                    { type: "domain_suffix", match: "", policy: group.name },
                  ])
                }
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
