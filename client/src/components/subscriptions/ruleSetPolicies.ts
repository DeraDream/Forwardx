import { parseDocument } from "yaml";

type Kind = "egern" | "loon";

/** Use only native built-ins and policy groups present in the current template. */
export function ruleSetPolicyOptions(kind: Kind, value: string): string[] {
  const groups: string[] = [];
  if (kind === "loon") {
    let inGroups = false;
    for (const line of value.replace(/\r/g, "").split("\n")) {
      const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (heading) { inGroups = heading[1].trim().toLowerCase() === "proxy group"; continue; }
      if (!inGroups || /^\s*[#;]/.test(line)) continue;
      const match = line.match(/^\s*([^=]+?)\s*=/);
      if (match?.[1].trim()) groups.push(match[1].trim());
    }
  } else {
    const document = parseDocument(value, { prettyErrors: false, strict: true });
    if (!document.errors.length) {
      const root = document.toJS() as Record<string, unknown> | null;
      if (root && Array.isArray(root.policy_groups)) {
        for (const group of root.policy_groups) {
          if (!group || typeof group !== "object" || Array.isArray(group)) continue;
          for (const settings of Object.values(group)) {
            if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
            const name = (settings as Record<string, unknown>).name;
            if (typeof name === "string" && name.trim()) groups.push(name.trim());
          }
        }
      }
    }
  }
  return [...new Set(["DIRECT", "REJECT", ...(kind === "loon" ? ["PROXY"] : []), ...groups])];
}
