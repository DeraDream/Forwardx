import { and, asc, eq } from "drizzle-orm";
import { landingHosts, landingServices } from "../../drizzle/schema";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate, queryRaw } from "../dbRuntime";
import { epochSeconds, quoteIdentifier } from "../dbCompat";

const bool = (value: unknown) => value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";

function asDate(value: unknown) {
  return value instanceof Date ? value : new Date(Number(value || 0) * 1000);
}

export function mapLandingHost(row: any) {
  return { ...row, id: Number(row.id), hostId: Number(row.hostId), userId: Number(row.userId), isEnabled: bool(row.isEnabled), createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt) };
}

export function mapLandingService(row: any, includeSecret = false) {
  const mapped: any = {
    ...row,
    id: Number(row.id), hostId: Number(row.hostId), userId: Number(row.userId), port: Number(row.port),
    isEnabled: bool(row.isEnabled), latencyTargetPort: Number(row.latencyTargetPort || 443),
    latestLatencyMs: row.latestLatencyMs === null || row.latestLatencyMs === undefined ? null : Number(row.latestLatencyMs),
    latestLatencyIsTimeout: bool(row.latestLatencyIsTimeout), latestLatencyAt: row.latestLatencyAt ? asDate(row.latestLatencyAt) : null,
    createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt),
  };
  if (!includeSecret) delete mapped.password;
  return mapped;
}

export async function getLandingHosts(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = userId ? await db.select().from(landingHosts).where(eq(landingHosts.userId, userId)).orderBy(asc(landingHosts.id)) : await db.select().from(landingHosts).orderBy(asc(landingHosts.id));
  return rows.map(mapLandingHost);
}

export async function getLandingHostByHostId(hostId: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(landingHosts).where(eq(landingHosts.hostId, hostId)).limit(1);
  return rows[0] ? mapLandingHost(rows[0]) : null;
}

export async function createLandingHost(input: { hostId: number; userId: number }) {
  return insertAndGetId("landing_hosts", { ...input, isEnabled: true, createdAt: nowDate(), updatedAt: nowDate() } as any);
}

export async function updateLandingHost(hostId: number, patch: any) {
  const db = await getDb();
  if (!db) return;
  await db.update(landingHosts).set({ ...patch, updatedAt: nowDate() }).where(eq(landingHosts.hostId, hostId));
}

export async function deleteLandingHost(hostId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(landingHosts).where(eq(landingHosts.hostId, hostId));
}

export async function getLandingServices(userId?: number, includeSecret = false) {
  const db = await getDb();
  if (!db) return [];
  const rows = userId ? await db.select().from(landingServices).where(eq(landingServices.userId, userId)).orderBy(asc(landingServices.hostId), asc(landingServices.port)) : await db.select().from(landingServices).orderBy(asc(landingServices.hostId), asc(landingServices.port));
  const mapped = rows.map((row: any) => mapLandingService(row, includeSecret));
  const summaries = await getLandingServiceTrafficSummaries(mapped.map((row: any) => row.id));
  return mapped.map((row: any) => ({ ...row, traffic: summaries.get(row.id) || { bytesIn24h: 0, bytesOut24h: 0, bytesInTotal: 0, bytesOutTotal: 0 } }));
}

async function getLandingServiceTrafficSummaries(ids: number[]) {
  const result = new Map<number, any>(); const db = await getDb(); if (!db || ids.length === 0) return result;
  const q = quoteIdentifier; const marks = ids.map(() => "?").join(","); const cutoff = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const rows = await queryRaw<any>(`SELECT ${q("serviceId")} serviceId, SUM(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("bytesIn")} ELSE 0 END) bytesIn24h, SUM(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("bytesOut")} ELSE 0 END) bytesOut24h, SUM(${q("bytesIn")}) bytesInTotal, SUM(${q("bytesOut")}) bytesOutTotal FROM ${q("landing_service_traffic_stats")} WHERE ${q("serviceId")} IN (${marks}) GROUP BY ${q("serviceId")}`, [cutoff, cutoff, ...ids]).catch(() => []);
  const samples = await queryRaw<any>(`SELECT ${q("serviceId")} serviceId, ${q("bytesIn")} bytesIn, ${q("bytesOut")} bytesOut, ${q("recordedAt")} recordedAt FROM ${q("landing_service_traffic_stats")} WHERE ${q("serviceId")} IN (${marks}) ORDER BY ${q("recordedAt")} DESC, ${q("id")} DESC`, ids).catch(() => []);
  const newest = new Map<number, any>(); const previous = new Map<number, any>();
  for (const sample of samples) { const id = Number(sample.serviceId); if (!newest.has(id)) newest.set(id, sample); else if (!previous.has(id)) previous.set(id, sample); }
  for (const row of rows) {
    const id = Number(row.serviceId), latest = newest.get(id), before = previous.get(id);
    const seconds = latest && before ? Math.max(1, Number(latest.recordedAt || 0) - Number(before.recordedAt || 0)) : 0;
    result.set(id, { bytesIn24h: Number(row.bytesIn24h || 0), bytesOut24h: Number(row.bytesOut24h || 0), bytesInTotal: Number(row.bytesInTotal || 0), bytesOutTotal: Number(row.bytesOutTotal || 0), bytesInRate: seconds ? Number(latest.bytesIn || 0) / seconds : 0, bytesOutRate: seconds ? Number(latest.bytesOut || 0) / seconds : 0 });
  }
  return result;
}

export async function getLandingServiceById(id: number, includeSecret = false) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(landingServices).where(eq(landingServices.id, id)).limit(1);
  return rows[0] ? mapLandingService(rows[0], includeSecret) : null;
}

export async function getLandingServicesForHost(hostId: number, includeSecret = true, includeDisabled = false) {
  const db = await getDb();
  if (!db) return [];
  const rows = includeDisabled
    ? await db.select().from(landingServices).where(eq(landingServices.hostId, hostId)).orderBy(asc(landingServices.id))
    : await db.select().from(landingServices).where(and(eq(landingServices.hostId, hostId), eq(landingServices.isEnabled, true))).orderBy(asc(landingServices.id));
  return rows.map((row: any) => mapLandingService(row, includeSecret));
}

export async function createLandingService(input: any) {
  return insertAndGetId("landing_services", { ...input, createdAt: nowDate(), updatedAt: nowDate() } as any);
}

export async function updateLandingService(id: number, patch: any) {
  const db = await getDb();
  if (!db) return;
  await db.update(landingServices).set({ ...patch, updatedAt: nowDate() }).where(eq(landingServices.id, id));
}

export async function deleteLandingService(id: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(landingServices).where(eq(landingServices.id, id));
}

export async function recordLandingServiceTraffic(items: Array<{ serviceId: number; hostId: number; userId: number; bytesIn: number; bytesOut: number }>) {
  const q = quoteIdentifier; const now = epochSeconds(nowDate());
  for (const item of items) {
    await executeRaw(`INSERT INTO ${q("landing_service_traffic_stats")} (${q("serviceId")},${q("hostId")},${q("bytesIn")},${q("bytesOut")},${q("recordedAt")}) VALUES (?,?,?,?,?)`, [item.serviceId,item.hostId,item.bytesIn,item.bytesOut,now]);
    const suffix = getDatabaseKind() === "mysql" ? `ON DUPLICATE KEY UPDATE ${q("bytesIn")}=${q("bytesIn")}+VALUES(${q("bytesIn")}),${q("bytesOut")}=${q("bytesOut")}+VALUES(${q("bytesOut")}),${q("updatedAt")} = VALUES(${q("updatedAt")})` : `ON CONFLICT (${q("serviceId")},${q("hostId")}) DO UPDATE SET ${q("bytesIn")}=${q("landing_service_traffic_counters")}.${q("bytesIn")}+excluded.${q("bytesIn")},${q("bytesOut")}=${q("landing_service_traffic_counters")}.${q("bytesOut")}+excluded.${q("bytesOut")},${q("updatedAt")}=excluded.${q("updatedAt")}`;
    await executeRaw(`INSERT INTO ${q("landing_service_traffic_counters")} (${q("serviceId")},${q("hostId")},${q("userId")},${q("bytesIn")},${q("bytesOut")},${q("updatedAt")}) VALUES (?,?,?,?,?,?) ${suffix}`, [item.serviceId,item.hostId,item.userId,item.bytesIn,item.bytesOut,now]);
  }
}

export async function recordLandingServiceLatency(items: Array<{ serviceId: number; hostId: number; latencyMs: number | null; isTimeout: boolean }>) {
  const q = quoteIdentifier; const now = epochSeconds(nowDate());
  for (const item of items) {
    await executeRaw(
      `INSERT INTO ${q("landing_service_latency_stats")} (${q("serviceId")},${q("hostId")},${q("latencyMs")},${q("isTimeout")},${q("recordedAt")}) VALUES (?,?,?,?,?)`,
      [item.serviceId, item.hostId, item.latencyMs, item.isTimeout, now],
    );
  }
}

export async function getLandingServiceLatencySeries(serviceId: number, since: Date) {
  const q = quoteIdentifier; const cutoff = epochSeconds(since);
  const rows = await queryRaw<any>(
    `SELECT ${q("latencyMs")} latencyMs, ${q("isTimeout")} isTimeout, ${q("recordedAt")} recordedAt FROM ${q("landing_service_latency_stats")} WHERE ${q("serviceId")} = ? AND ${q("recordedAt")} >= ? ORDER BY ${q("recordedAt")} ASC, ${q("id")} ASC`,
    [serviceId, cutoff],
  ).catch(() => []);
  return rows.map((row: any) => ({ latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs), isTimeout: bool(row.isTimeout), recordedAt: asDate(row.recordedAt) }));
}
