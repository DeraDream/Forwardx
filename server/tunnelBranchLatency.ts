import type { HopTestResult } from "./hopTestState";

/** Separate alternative entries and exits from the serial common section. */
export const TUNNEL_ENTRY_BRANCH_GROUP = "tunnel-entry-branches";
export const TUNNEL_EXIT_BRANCH_GROUP = "tunnel-exit-branches";

export function aggregateTunnelBranchTest(details: HopTestResult[]) {
  const entries = details.filter((item) => item.groupKey === TUNNEL_ENTRY_BRANCH_GROUP);
  const exits = details.filter((item) => item.groupKey === TUNNEL_EXIT_BRANCH_GROUP);
  const shared = details.filter((item) => item.groupKey !== TUNNEL_ENTRY_BRANCH_GROUP && item.groupKey !== TUNNEL_EXIT_BRANCH_GROUP);
  const ok = (item: HopTestResult) => item.success && typeof item.latencyMs === "number" && Number.isFinite(item.latencyMs) && item.latencyMs > 0;
  const relayEntries = details.flatMap((item) => {
    const match = String(item.groupKey || "").match(/^relay-entry-(\d+)$/);
    return match ? [{ relayId: Number(match[1]), item }] : [];
  });
  const relayExits = details.flatMap((item) => {
    const match = String(item.groupKey || "").match(/^relay-exit-(\d+)-(\d+)$/);
    return match ? [{ relayId: Number(match[1]), exitId: Number(match[2]), item }] : [];
  });
  if (relayEntries.length && relayExits.length) {
    const exitIds = [...new Set(relayExits.map((row) => row.exitId))];
    const branches = exitIds.map((exitId, index) => {
      const candidates = relayExits.filter((row) => row.exitId === exitId);
      const paths = candidates.flatMap((row) => ok(row.item)
        ? relayEntries.filter((entry) => entry.relayId === row.relayId && ok(entry.item)).map((entry) => Number(entry.item.latencyMs) + Number(row.item.latencyMs))
        : []);
      return { key: index === 0 ? "primary" : `exit-${index + 1}`, label: String(candidates[0]?.item.groupLabel || `出口 ${index + 1}`), latencyMs: paths.length ? Math.max(...paths) : null, success: paths.length > 0 };
    });
    const successful = branches.filter((branch) => branch.success);
    return { success: successful.length > 0, latencyMs: successful.length ? Math.max(...successful.map((branch) => Number(branch.latencyMs))) : null,
      partial: relayEntries.some((row) => !ok(row.item)) || relayExits.some((row) => !ok(row.item)), entries: relayEntries.map((row) => row.item), exits: relayExits.map((row) => row.item), shared: [] as HopTestResult[], branches };
  }
  const goodEntries = entries.filter(ok);
  if (entries.length === 0 && shared.length === 0 && exits.length > 0) {
    const groups = new Map<string, HopTestResult[]>();
    for (const item of exits) {
      const key = String(item.groupLabel || "");
      if (!key) continue;
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    const branches = [...groups.entries()].map(([label, candidates], index) => {
      const successful = candidates.filter(ok);
      return { key: index === 0 ? "primary" : `exit-${index + 1}`, label,
        latencyMs: successful.length ? Math.max(...successful.map((item) => Number(item.latencyMs))) : null,
        success: successful.length > 0 };
    });
    const successful = branches.filter((branch) => branch.success);
    return { success: successful.length > 0, latencyMs: successful.length ? Math.max(...successful.map((branch) => Number(branch.latencyMs))) : null,
      partial: exits.some((item) => !ok(item)), entries, exits, shared, branches };
  }
  const goodExits = exits.filter(ok);
  const sharedOk = shared.every(ok);
  const sharedMs = shared.reduce((sum, item) => sum + Number(item.latencyMs || 0), 0);
  const entryMs = goodEntries.length ? Math.max(...goodEntries.map((item) => Number(item.latencyMs))) : 0;
  const usable = entries.length > 0 && exits.length > 0 && goodEntries.length > 0 && sharedOk;
  const branches = exits.map((item, index) => ({
    key: index === 0 ? "primary" : `exit-${index + 1}`,
    label: item.routeLabel || item.hopLabel,
    latencyMs: usable && ok(item) ? entryMs + sharedMs + Number(item.latencyMs) : null,
    success: usable && ok(item),
  }));
  const successful = branches.filter((branch) => branch.success);
  return {
    success: successful.length > 0,
    latencyMs: successful.length ? Math.max(...successful.map((branch) => Number(branch.latencyMs))) : null,
    partial: successful.length !== exits.length || goodEntries.length !== entries.length,
    entries, exits, shared, branches,
  };
}
