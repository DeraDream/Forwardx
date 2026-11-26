import { asc, eq } from "drizzle-orm";
import { landingGroups, landingGroupMembers, landingGroupProbeLatest, landingServices, forwardRules } from "../../drizzle/schema";
import { getDb, insertAndGetId, nowDate, withDatabaseTransaction } from "../dbRuntime";

export async function listLandingGroups(userId?: number) {
  const db = await getDb();
  if (!db) return [];
  const groups = userId
    ? await db.select().from(landingGroups).where(eq(landingGroups.userId, userId)).orderBy(asc(landingGroups.id))
    : await db.select().from(landingGroups).orderBy(asc(landingGroups.id));
  const members = await db.select().from(landingGroupMembers).orderBy(asc(landingGroupMembers.priority));
  return groups.map((group: typeof landingGroups.$inferSelect) => ({ ...group, hostIds: members.filter((member: typeof landingGroupMembers.$inferSelect) => member.groupId === group.id).map((member: typeof landingGroupMembers.$inferSelect) => member.hostId) }));
}

export async function getLandingGroup(id: number) {
  const db = await getDb();
  if (!db) return null;
  const [group] = await db.select().from(landingGroups).where(eq(landingGroups.id, id)).limit(1);
  if (!group) return null;
  const members = await db.select().from(landingGroupMembers).where(eq(landingGroupMembers.groupId, id)).orderBy(asc(landingGroupMembers.priority));
  return { ...group, hostIds: members.map((member: typeof landingGroupMembers.$inferSelect) => member.hostId) };
}

export async function saveLandingGroup(input: { id?: number; name: string; userId: number; hostIds: number[] }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return withDatabaseTransaction(async () => {
    const id = input.id || await insertAndGetId("landing_groups", { name: input.name, userId: input.userId, createdAt: nowDate(), updatedAt: nowDate() });
    if (input.id) await db.update(landingGroups).set({ name: input.name, updatedAt: nowDate() }).where(eq(landingGroups.id, id));
    await db.delete(landingGroupMembers).where(eq(landingGroupMembers.groupId, id));
    for (const [priority, hostId] of input.hostIds.entries()) {
      await insertAndGetId("landing_group_members", { groupId: id, hostId, priority });
    }
    return id;
  });
}

export async function setLandingGroupActive(id: number, serviceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(landingGroups).set({ activeServiceId: serviceId, activeUnhealthySince: null, primaryHealthySince: null, recoveryServiceId: null }).where(eq(landingGroups.id, id));
}

export async function removeLandingGroup(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return withDatabaseTransaction(async () => {
    const services = await db.select({ id: landingServices.id }).from(landingServices).where(eq(landingServices.landingGroupId, id)).limit(1);
    if (services.length) throw new Error("落地组仍有关联 SS，请先处理其服务");
    const rules = await db.select({ id: forwardRules.id }).from(forwardRules).where(eq(forwardRules.targetLandingGroupId, id)).limit(1);
    if (rules.length) throw new Error("落地组仍有转发规则引用，请先解绑规则");
    await db.delete(landingGroupProbeLatest).where(eq(landingGroupProbeLatest.groupId, id));
    await db.delete(landingGroupMembers).where(eq(landingGroupMembers.groupId, id));
    await db.delete(landingGroups).where(eq(landingGroups.id, id));
  });
}
