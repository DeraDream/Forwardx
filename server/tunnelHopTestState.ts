import {
  createHopTestBatch,
  discardHopTestBatch,
  recordHopTestResult,
  registerHopTest,
  type HopTestAggregate,
  type HopTestResult,
} from "./hopTestState";

export type TunnelHopResult = HopTestResult;

const currentTunnelBatches = new Map<number, { batchId: string; createdAt: number }>();
const tunnelBatchOwners = new Map<string, number>();
const TUNNEL_BATCH_TTL_MS = 10 * 60 * 1000;

export function clearTunnelHopBatch(tunnelId: number) {
  const current = currentTunnelBatches.get(Number(tunnelId));
  if (!current) return;
  discardHopTestBatch(current.batchId);
  tunnelBatchOwners.delete(current.batchId);
  currentTunnelBatches.delete(Number(tunnelId));
}

export function isCurrentTunnelHopBatch(tunnelId: number, batchId: unknown) {
  return !!batchId && currentTunnelBatches.get(Number(tunnelId))?.batchId === String(batchId);
}

export function createTunnelHopBatch(tunnelId: number) {
  const now = Date.now();
  for (const [id, batch] of currentTunnelBatches) {
    if (now - batch.createdAt > TUNNEL_BATCH_TTL_MS) clearTunnelHopBatch(id);
  }
  clearTunnelHopBatch(tunnelId);
  const batchId = createHopTestBatch("tb", tunnelId);
  currentTunnelBatches.set(Number(tunnelId), { batchId, createdAt: now });
  tunnelBatchOwners.set(batchId, Number(tunnelId));
  return batchId;
}

export function registerTunnelHopTest(batchId: string, testId: number) {
  const ownerId = tunnelBatchOwners.get(batchId);
  if (!ownerId || currentTunnelBatches.get(ownerId)?.batchId !== batchId) return;
  registerHopTest(batchId, testId);
}

export function recordTunnelHopTestResult(
  testId: number,
  result: TunnelHopResult,
  options?: {
    successPrefix?: string;
    failurePrefix?: string;
    totalLabel?: string;
    latencyMode?: "sum" | "max" | "multi-source" | "branched";
  },
): null | (Omit<HopTestAggregate, "ownerId"> & { tunnelId: number }) {
  const aggregate = recordHopTestResult(testId, result, {
    successPrefix: options?.successPrefix || "多级隧道逐跳测试成功",
    failurePrefix: options?.failurePrefix || "多级隧道逐跳测试失败",
    totalLabel: options?.totalLabel,
    latencyMode: options?.latencyMode,
    successMode: options?.latencyMode === "max"
      ? "any"
      : options?.latencyMode === "multi-source"
        ? "multi-source"
        : "all",
  });
  if (!aggregate) return null;
  const current = currentTunnelBatches.get(Number(aggregate.ownerId));
  if (current) {
    tunnelBatchOwners.delete(current.batchId);
    currentTunnelBatches.delete(Number(aggregate.ownerId));
  }
  return {
    tunnelId: aggregate.ownerId,
    success: aggregate.success,
    latencyMs: aggregate.latencyMs,
    message: aggregate.message,
    details: aggregate.details,
  };
}
