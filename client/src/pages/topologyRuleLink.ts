export function topologyRuleFocusId(search: string): number | null {
  const raw = new URLSearchParams(search).get("focusRule");
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function topologyRuleHref(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid rule ID");
  return `/rules?focusRule=${id}`;
}
