import * as db from "./db";
import { tunnelProbeTopologyKey } from "./probeTopology";
import { clearTunnelHopBatch, isCurrentTunnelHopBatch } from "./tunnelHopTestState";
import { withKeyedTaskLock } from "./keyedTaskLock";

export async function manualTunnelEntryHostIds(tunnel: any) {
  const enabled = (value: unknown, fallback = false) => {
    if (value === undefined || value === null || value === "") return fallback;
    return value === true || value === 1 || (typeof value === "string" && ["1", "true"].includes(value.trim().toLowerCase()));
  };
  const ids = new Set<number>();
  const groupId = Number(tunnel?.entryGroupId || 0);
  if (groupId > 0) {
    const group = await db.getForwardGroupById(groupId) as any;
    if (group && enabled(group.isEnabled) && String(group.groupMode || "") === "entry") {
      for (const member of group.members || []) {
        const id = Number(member?.hostId || 0);
        if (member?.memberType === "host" && enabled(member.isEnabled, true) && Number.isInteger(id) && id > 0) ids.add(id);
      }
    }
  }
  if (!ids.size && Number(tunnel?.entryHostId || 0) > 0) ids.add(Number(tunnel.entryHostId));
  return [...ids].sort((a, b) => a - b);
}

/** Reject outdated results without allowing an older batch to cancel a newer one. */
export async function withBranchedTunnelTest(meta: { tunnelId: number; batchId?: string; topologyKey?: string; entryHostIds?: number[] }, onAccepted: () => Promise<void>) {
  return withKeyedTaskLock(`tunnel:${meta.tunnelId}`, async () => {
    if (!isCurrentTunnelHopBatch(meta.tunnelId, meta.batchId)) {
      const tunnel = await db.getTunnelById(meta.tunnelId) as any;
      let pendingBatchId = "";
      try { pendingBatchId = String(JSON.parse(String(tunnel?.lastTestMessage || "")).batchId || ""); } catch { /* Legacy or non-structured result. */ }
      if (tunnel && String(tunnel.lastTestStatus || "") === "pending" && pendingBatchId && pendingBatchId === String(meta.batchId || "")) {
        await db.updateTunnelTestResult(meta.tunnelId, { status: "failed", latencyMs: null, message: "隧道测试状态已失效（可能因面板重启），请重新测试" });
      }
      return false;
    }
    const [tunnel, hops, exits] = await Promise.all([db.getTunnelById(meta.tunnelId), db.getTunnelHops(meta.tunnelId), db.getTunnelExitNodes(meta.tunnelId)]);
    const entries = tunnel ? await manualTunnelEntryHostIds(tunnel) : [];
    const expected = Array.isArray(meta.entryHostIds) ? [...meta.entryHostIds].map(Number).sort((a, b) => a - b) : [];
    const valid = !!tunnel && !!meta.topologyKey && tunnelProbeTopologyKey(tunnel, hops as any[], exits as any[]) === meta.topologyKey && entries.join(",") === expected.join(",");
    if (!valid) {
      clearTunnelHopBatch(meta.tunnelId);
      if (tunnel) await db.updateTunnelTestResult(meta.tunnelId, { status: "failed", latencyMs: null, message: "隧道拓扑已变更，测试结果已丢弃，请重新测试" });
    }
    if (!valid) return false;
    await onAccepted();
    return true;
  });
}
