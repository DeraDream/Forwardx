import { and, asc, eq } from "drizzle-orm";
import { landingHosts, landingServices } from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "../dbRuntime";

const bool = (value: unknown) => value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";

function asDate(value: unknown) {
  return value instanceof Date ? value : new Date(Number(value || 0) * 1000);
}

export function mapLandingHost(row: any) {
  return { ...row, id: Number(row.id), hostId: Number(row.hostId), userId: Number(row.userId), createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt) };
}

export function mapLandingService(row: any, includeSecret = false) {
  const mapped: any = {
    ...row,
    id: Number(row.id), hostId: Number(row.hostId), userId: Number(row.userId), port: Number(row.port),
    isEnabled: bool(row.isEnabled), createdAt: asDate(row.createdAt), updatedAt: asDate(row.updatedAt),
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
  return insertAndGetId("landing_hosts", { ...input, createdAt: nowDate(), updatedAt: nowDate() } as any);
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
  return rows.map((row: any) => mapLandingService(row, includeSecret));
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
