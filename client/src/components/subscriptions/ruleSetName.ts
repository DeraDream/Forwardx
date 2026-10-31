/** Derive a display-only label for an unnamed Egern rule set. */
export function ruleSetDisplayName(source: string, fallback: string): string {
  const input = source.trim();
  if (!input) return fallback;
  let pathname = input;
  try {
    if (/^https?:\/\//i.test(input)) pathname = new URL(input).pathname;
    else pathname = input.split(/[?#]/, 1)[0];
  } catch { return fallback; }
  const filename = pathname.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  if (!filename) return fallback;
  let decoded = filename;
  try { decoded = decodeURIComponent(filename); } catch { /* Keep the original filename. */ }
  const name = decoded.replace(/\.(?:list|txt|yaml|yml|json|mrs|conf|rule|ruleset)$/i, "").trim();
  return name || fallback;
}
