import { and, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
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

export async function getLatestForwardTest(ruleId: number, options: { includeActive?: boolean; hostId?: number; topologyTotal?: boolean } = {}) {
  const db = await getDb();
  if (!db) return undefined;
  const table = quoteIdentifier("forward_tests");
  const ruleCol = quoteIdentifier("ruleId");
  const statusCol = quoteIdentifier("status");
  const idCol = quoteIdentifier("id");
  const updatedCol = quoteIdentifier("updatedAt");
  const createdCol = quoteIdentifier("createdAt");
  const messageCol = quoteIdentifier("message");
  const hostFilter = options.hostId ? ` AND ${quoteIdentifier("hostId")} = ?` : "";
  const params = options.hostId ? [ruleId, options.hostId] : [ruleId];
  if (options.topologyTotal) {
    const topologyRows = await queryRaw<any>(
      `SELECT * FROM ${table} WHERE ${ruleCol} = ?${hostFilter} AND ${messageCol} LIKE '%"kind":"topology-total"%'
        AND ${statusCol} IN (${options.includeActive === false ? "'success', 'failed', 'timeout'" : "'pending', 'running', 'success', 'failed', 'timeout'"})
        ORDER BY ${idCol} DESC LIMIT 1`, params,
    );
    if (topologyRows[0]) return topologyRows[0];
  }
  const directOnly = options.topologyTotal
    ? ` AND ${messageCol} NOT LIKE '%forward-chain-hop-summary%' AND ${messageCol} NOT LIKE '%"kind":"forward-via-tunnel"%'`
    : "";
  if (options.includeActive !== false) {
    const pendingRows = await queryRaw<any>(
      `SELECT * FROM ${table} WHERE ${ruleCol} = ?${hostFilter}${directOnly} AND ${statusCol} IN ('pending', 'running') ORDER BY ${updatedCol} DESC, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
      params,
    );
    if (pendingRows[0]) return pendingRows[0];
  }
  const rows = await queryRaw<any>(
    `SELECT * FROM ${table} WHERE ${ruleCol} = ?${hostFilter}${directOnly} AND ${statusCol} IN ('success', 'failed', 'timeout') ORDER BY ${updatedCol} DESC, CASE WHEN ${messageCol} LIKE '%forward-chain-hop-summary%' OR ${messageCol} LIKE '%"kind":"forward-via-tunnel"%' THEN 0 ELSE 1 END, ${createdCol} DESC, ${idCol} DESC LIMIT 1`,
    params,
  );
  return rows[0];
}

// Topology opens with up to 100 entrances. Fetch their stored terminal TCP
// results in one indexed query instead of 1-3 round trips per entrance.
export async function getLatestTopologyTestsForEntries(entries: Array<{ ruleId: number; entryHostId: number }>) {
  if (!entries.length) return new Map<string, any>();
  const q = quoteIdentifier;
  const ruleIds = [...new Set(entries.map((entry) => entry.ruleId))];
  const hostIds = [...new Set(entries.map((entry) => entry.entryHostId))];
  const rows = await queryRaw<any>(
    `SELECT * FROM (
       SELECT t.*, ROW_NUMBER() OVER (
         PARTITION BY t.${q("ruleId")}, t.${q("hostId")}
         ORDER BY CASE WHEN t.${q("message")} LIKE '%"kind":"topology-total"%' THEN 0 ELSE 1 END,
                  CASE WHEN t.${q("message")} LIKE '%"kind":"topology-total"%' THEN t.${q("id")} ELSE NULL END DESC,
                  t.${q("updatedAt")} DESC, t.${q("createdAt")} DESC, t.${q("id")} DESC
       ) AS ${q("sampleRank")}
       FROM ${q("forward_tests")} t
       WHERE t.${q("ruleId")} IN (${ruleIds.map(() => "?").join(",")})
         AND t.${q("hostId")} IN (${hostIds.map(() => "?").join(",")})
         AND t.${q("status")} IN ('success', 'failed', 'timeout')
         AND t.${q("message")} NOT LIKE '%forward-chain-hop-summary%'
         AND t.${q("message")} NOT LIKE '%"kind":"forward-via-tunnel"%'
     ) latest WHERE latest.${q("sampleRank")} = 1`,
    [...ruleIds, ...hostIds],
  );
  return new Map(rows.map((row) => [`${Number(row.ruleId)}:${Number(row.hostId)}`, row]));
}

// A rule self-test can enqueue multiple hops. Resolve its exact batch before
// any hop overwrites its metadata with the aggregate result.
export async function getForwardTestBatchIds(ruleId: number, batchId: string) {
  const db = await getDb();
  if (!db || !/^[a-z0-9-]{1,100}$/i.test(batchId)) return [] as number[];
  const rows = await db.select({ id: forwardTests.id }).from(forwardTests)
    .where(and(eq(forwardTests.ruleId, ruleId), like(forwardTests.message, `%"batchId":"${batchId}"%`)))
    .orderBy(forwardTests.id);
  return rows.map((row: { id: number }) => row.id);
}

export async function getForwardTestsByIds(ruleId: number, ids: number[]) {
  const db = await getDb();
  const safe = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!db || !safe.length) return [] as Array<typeof forwardTests.$inferSelect>;
  return db.select().from(forwardTests).where(and(eq(forwardTests.ruleId, ruleId), inArray(forwardTests.id, safe)));
}

export async function getForwardTestById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(forwardTests).where(eq(forwardTests.id, id)).limit(1);
  return rows[0];
}

export async function cleanOldForwardTests(retainHours = 72) {
  const cutoff = Math.floor((Date.now() - retainHours * 3600 * 1000) / 1000);
  const q = quoteIdentifier;
  const table = q("forward_tests");
  // Keep one completed, entry-specific TCP total per rule/host even after the
  // ordinary 72-hour test-log retention. Without this, a quiet topology would
  // return to "click to probe" despite previously having a stored result.
  await executeRaw(
    `DELETE FROM ${table} WHERE ${q("updatedAt")} < ? AND (
       ${q("message")} IS NULL OR ${q("message")} NOT LIKE '%"kind":"topology-total"%'
       OR ${q("status")} NOT IN ('success', 'failed', 'timeout')
       OR ${q("id")} NOT IN (
         SELECT keep.${q("id")} FROM (
           SELECT MAX(${q("id")}) AS ${q("id")} FROM ${table}
           WHERE ${q("message")} LIKE '%"kind":"topology-total"%'
             AND ${q("status")} IN ('success', 'failed', 'timeout')
           GROUP BY ${q("ruleId")}, ${q("hostId")}
         ) keep
       )
     )`,
    [cutoff],
  );
}

