import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  onChange: (value: string) => void;
  onError: (message: string) => void;
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
export function LoonVisualEditor({ value, onChange, onError }: Props) {
  const [sections, setSections] = useState<Section[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  useEffect(() => {
    try {
      const next = load(value);
      setSections(next.sections);
      setGroups(next.groups);
      setRules(next.rules);
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
    if (pg)
      pg.lines = groups.map(
        (group) =>
          `${group.name} = ${[group.type, ...group.policies.filter(Boolean), ...group.extras].join(",")}`,
      );
    if (rs) rs.lines = rules.map((rule) => rule.value);
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
  return (
    <section className="min-h-0 flex-1 overflow-auto p-3">
      <div className="mb-3 flex items-center justify-between">
        <strong className="text-sm">Loon 策略组 · {groups.length}</strong>
        <Button
          size="sm"
          onClick={() => {
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
        <article
          key={index}
          className="mb-3 space-y-3 rounded-md border border-border/70 p-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              value={group.name}
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
                {
                  value: `DOMAIN-SUFFIX,example.com,${group.name}`,
                  target: group.name,
                },
              ])
            }
          >
            添加规则
          </Button>
        </article>
      ))}
      <Button onClick={() => onChange(output)}>应用更改</Button>
    </section>
  );
}
