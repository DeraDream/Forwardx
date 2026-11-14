type ModuleKind = "loon" | "egern";

/** Locate top-level module entries without rewriting neighbouring configuration. */
export function moduleRanges(kind: ModuleKind, source: string): Array<{ start: number; end: number; disabled: boolean }> {
  const lines = source.replace(/\r/g, "").split("\n");
  if (kind === "loon") {
    const start = lines.findIndex((line) => /^\s*\[plugin\]\s*$/i.test(line));
    if (start < 0) return [];
    const ranges: Array<{ start: number; end: number; disabled: boolean }> = [];
    for (let i = start + 1; i < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[i]); i++) {
      const disabled = /^\s*#\s*(?:https?:\/\/|[^#\s]+\s*=\s*https?:\/\/)/i.test(lines[i]);
      const active = /^\s*(?:https?:\/\/|[^#;\s]+\s*=\s*https?:\/\/)/i.test(lines[i]);
      if (active || disabled) ranges.push({ start: i, end: i + 1, disabled });
    }
    return ranges;
  }
  const start = lines.findIndex((line) => /^modules\s*:\s*(?:#.*)?$/.test(line));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]) || /^#/.test(lines[end]) || /^-\s/.test(lines[end]))) end++;
  const ranges: Array<{ start: number; end: number; disabled: boolean }> = [];
  let indent: number | undefined;
  for (let i = start + 1; i < end; i++) {
    const match = lines[i].match(/^(\s*)(#\s*)?-\s+(?:name|url|enabled|update_interval|compat_arguments|env)\s*:/);
    if (!match) continue;
    if (indent === undefined) indent = match[1].length;
    if (match[1].length !== indent) continue;
    if (ranges.length) ranges[ranges.length - 1].end = i;
    ranges.push({ start: i, end, disabled: Boolean(match[2]) });
  }
  return ranges;
}

export function toggleModuleComment(kind: ModuleKind, source: string, index: number, enabled: boolean): { source: string; line: number } {
  const lines = source.replace(/\r/g, "").split("\n");
  const range = moduleRanges(kind, source)[index];
  if (!range) throw new Error("无法定位模块，请先应用模块更改");
  if (kind === "egern") {
    // Egern natively supports `enabled`; unlike Loon, keep the entire module
    // entry readable rather than commenting out its YAML block.
    if (range.disabled) for (let i = range.start; i < range.end; i++) lines[i] = lines[i].replace(/^(\s*)# ?/, "$1");
    const enabledLine = lines.findIndex((line, lineIndex) => lineIndex >= range.start && lineIndex < range.end && /^\s*enabled\s*:/.test(line));
    if (enabledLine >= 0) lines[enabledLine] = lines[enabledLine].replace(/^(\s*enabled\s*:\s*)(?:true|false)\b/i, `$1${enabled}`);
    else {
      const indent = (lines[range.start].match(/^(\s*)/)?.[1] || "") + "  ";
      lines.splice(range.start + 1, 0, `${indent}enabled: ${enabled}`);
    }
    return { source: lines.join("\n"), line: range.start + 1 };
  }
  if (range.disabled !== !enabled) {
    for (let i = range.start; i < range.end; i++) {
      if (!lines[i].trim()) continue;
      if (enabled) lines[i] = lines[i].replace(/^(\s*)# ?/, "$1");
      else lines[i] = lines[i].replace(/^(\s*)/, "$1# ");
    }
  }
  if (enabled) lines[range.start] = lines[range.start].replace(/(\benable\s*=\s*)false\b/i, "$1true");
  return { source: lines.join("\n"), line: range.start + 1 };
}

/** Make disabled entries readable to the list parser, leaving the original source intact. */
export function uncommentModuleEntries(kind: ModuleKind, source: string): string {
  const lines = source.replace(/\r/g, "").split("\n");
  for (const range of moduleRanges(kind, source)) {
    if (range.disabled) for (let i = range.start; i < range.end; i++) lines[i] = lines[i].replace(/^(\s*)# ?/, "$1");
  }
  return lines.join("\n");
}
