import { and, desc, eq, isNull, or } from "drizzle-orm";
import { forwardTests, InsertForwardTest, tunnelLatencyStats } from "../../drizzle/schema";
import { executeRaw, getDb, insertAndGetId, nowDate, queryRaw, rawAffectedRows } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";
import { selfTestSweepActivity } from "../selfTestTiming";

// ==================== Forward Tests ====================

export async function createForwardTest(data: InsertForwardTest) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const id = await insertAndGetId("forward_tests", data as any);
  selfTestSweepActivity.markActive();
  return id;
}

export async function hasActiveForwardTests() {
  const db = await getDb();
  if (!db) return false;
  const q = quoteIdentifier;
  const rows = await queryRaw<{ id: number }>(
    `SELECT ${q("id")}
       FROM ${q("forward_tests")}
      WHERE ${q("status")} IN ('pending', 'running')
      LIMIT 1`,
  );
  return rows.length > 0;
}

const FORWARD_TEST_LEASE_SECONDS = 8;

// Heartbeat delivery is not an acknowledgement: it claims a test before the
// Agent receives the response. Return aged in-flight hosts so the scheduler
// can re-send an independent pull notification until a result arrives.
export async function getUnreportedForwardTestHosts(now = Date.now()) {
  const cutoff = Math.floor((now - 2_000) / 1_000);
  const rows = await queryRaw<{ hostId: number; id: number }>(
    `SELECT ${quoteIdentifier("hostId")} AS hostId, ${quoteIdentifier("id")} AS id
       FROM ${quoteIdentifier("forward_tests")}
      WHERE (${quoteIdentifier("status")} = 'pending' AND ${quoteIdentifier("createdAt")} < ?)
         OR (${quoteIdentifier("status")} = 'running' AND ${quoteIdentifier("updatedAt")} < ?)
      ORDER BY ${quoteIdentifier("id")} DESC LIMIT 256`,
    [cutoff, cutoff],
  );
  const hosts = new Map<number, number>();
  for (const row of rows) {
    const id = Number(row.hostId);
    if (id > 0 && !hosts.has(id)) hosts.set(id, Number(row.id));
  }
  return hosts;
}

// Claiming an unbounded backlog marks jobs running before the Agent has even
// accepted them; keep each heartbeat/pull within the Agent worker capacity.
export async function getPendingForwardTestsByHost(hostId: number, leaseSeconds = FORWARD_TEST_LEASE_SECONDS, limit = 16) {
  const cutoff = Math.floor((Date.now() - Math.max(1, leaseSeconds) * 1000) / 1000);
  const boundedLimit = Math.max(1, Math.min(64, Math.floor(limit) || 16));
  return queryRaw<any>(
    `SELECT *
       FROM ${quoteIdentifier("forward_tests")}
      WHERE ${quoteIdentifier("hostId")} = ?
        AND (${quoteIdentifier("status")} = 'pending'
          OR (${quoteIdentifier("status")} = 'running' AND ${quoteIdentifier("updatedAt")} < ?))
      ORDER BY ${quoteIdentifier("createdAt")} ASC, ${quoteIdentifier("id")} ASC
      LIMIT ?`,
    [hostId, cutoff, boundedLimit],
  );
}

export async function markForwardTestRunning(id: number, leaseSeconds = FORWARD_TEST_LEASE_SECONDS) {
  const db = await getDb();
  if (!db) return false;
  const q = quoteIdentifier;
  const cutoff = Math.floor((Date.now() - Math.max(1, leaseSeconds) * 1000) / 1000);
  const result = await executeRaw(
    `UPDATE ${q("forward_tests")}
     SET ${q("status")} = 'running',
         ${q("updatedAt")} = ?
     WHERE ${q("id")} = ?
       AND (${q("status")} = 'pending'
         OR (${q("status")} = 'running' AND ${q("updatedAt")} < ?))`,
    [nowDate(), id, cutoff],
  );
  const claimed = rawAffectedRows(result) > 0;
  if (claimed) selfTestSweepActivity.markActive();
  return claimed;
}

export async function updateForwardTestResult(
  id: number,
  data: {
    status: "success" | "failed" | "timeout";
    listenOk?: boolean;
    targetReachable?: boolean;
    forwardOk?: boolean;
    latencyMs?: number | null;
    message?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  await db.update(forwardTests).set({ ...data, updatedAt: nowDate() } as any).where(eq(forwardTests.id, id));
}

export async function completeForwardTestIfActive(
  id: number,
  data: Parameters<typeof updateForwardTestResult>[1],
) {
  const q = quoteIdentifier;
  const result = await executeRaw(
    `UPDATE ${q("forward_tests")}
        SET ${q("status")} = ?,
            ${q("listenOk")} = ?,
            ${q("targetReachable")} = ?,
            ${q("forwardOk")} = ?,
            ${q("latencyMs")} = ?,
            ${q("message")} = ?,
            ${q("updatedAt")} = ?
      WHERE ${q("id")} = ?
        AND ${q("status")} IN ('pending', 'running')`,
    [
      data.status,
      data.listenOk ?? false,
      data.targetReachable ?? false,
      data.forwardOk ?? false,
      data.latencyMs ?? null,
      data.message ?? null,
      nowDate(),
      id,
    ],
  );
  return rawAffectedRows(result) > 0;
}

export async function getLatestTunnelLatency(tunnelId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(tunnelLatencyStats)
    .where(and(
      eq(tunnelLatencyStats.tunnelId, tunnelId),
      or(
        isNull(tunnelLatencyStats.seriesKey),
        eq(tunnelLatencyStats.seriesKey, ""),
        eq(tunnelLatencyStats.seriesKey, "total"),
      ),
    ))
    .orderBy(desc(tunnelLatencyStats.id))
    .limit(1);
  return rows[0];
}

export async function getLatestForwardTest(ruleId: number, options: { includeActive?: boolean } = {}) {
  const db = await getDb();
  if (!db) return undefined;
  const table = quoteIdentifier("forward_tests");
  const ruleCol = quoteIdentifier("ruleId");
  const statusCol = quoteIdentifier("status");
  const idCol = quoteIdentifier("id");
  const updatedCol = quoteIdentifier("updatedAt");
  const createdCol = quoteIdentifier("createdAt");
  const messageCol = quoteIdentifier("message");
  if (options.includeActive !== false) {
    const pendingRows = await queryRaw<any>(
      `SELECT * FROM ${table} WHERE ${ruleCol} = ? AND ${statusCol} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
      [ruleId],
    );
    if (pendingRows[0]) return pendingRows[0];
  }
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${ruleCol} = ? AND ${statusCol} IN ('success', 'failed', 'timeout') ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' OR ${messageCol} LIKE '%"kind":"forward-via-tunnel"%' THEN 0 ELSE 1 END, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
    [ruleId],
  );
  return rows[0];
}

export async function getForwardTestById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(forwardTests).where(eq(forwardTests.id, id)).limit(1);
  return rows[0];
}

export async function cleanOldForwardTests(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  await executeRaw(
    `DELETE FROM ${quoteIdentifier("forward_tests")} WHERE ${quoteIdentifier("updatedAt")} < ?`,
    [cutoff],
  );
}

