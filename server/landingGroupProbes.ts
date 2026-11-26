import { and, eq } from "drizzle-orm";
import { forwardRules, landingGroupProbeLatest, landingServices } from "../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "./dbRuntime";
import { withKeyedTaskLock } from "./keyedTaskLock";
import { getLandingGroup } from "./repositories/landingGroupRepository";

export const LANDING_GROUP_PROBE_TTL_MS = 90_000;

export function landingGroupProbeKey(groupId: number, serviceId: number, sourceHostId: number, address: string, port: number) {
  return `landing-group:${groupId}:service:${serviceId}:source:${sourceHostId}:${address.trim().toLowerCase()}:${port}:tcp`;
}

export async function landingGroupProbePlansForHost(hostId: number, rules: any[]) {
  const db = await getDb();
  if (!db) return [];
  const groupIds = Array.from(new Set(rules.filter(rule => Number(rule.hostId) === hostId && rule.isEnabled && !rule.pendingDelete && Number(rule.targetLandingGroupId) > 0).map(rule => Number(rule.targetLandingGroupId))));
  const plans: any[] = [];
  for (const groupId of groupIds) {
    const group = await getLandingGroup(groupId);
    if (!group || !rules.some(rule => Number(rule.hostId) === hostId && Number(rule.targetLandingGroupId) === groupId && Number(rule.userId) === group.userId)) continue;
    const services = await db.select().from(landingServices).where(eq(landingServices.landingGroupId, groupId));
    for (const service of services) {
      if (!group.hostIds.includes(service.hostId) || !service.isEnabled || service.isFullChainManaged || service.userId !== group.userId) continue;
      const address = String(service.endpoint || "").trim();
      if (!address) continue;
      plans.push({
        groupId, memberId: service.id, probeType: "landing", targetIp: address, targetPort: service.port,
        method: "tcp", hopIndex: 0, hopCount: 1,
        probeKey: landingGroupProbeKey(groupId, service.id, hostId, address, service.port),
        topologyKey: `landing-group:${groupId}:service:${service.id}:source:${hostId}`,
      });
    }
  }
  return plans;
}

export async function recordLandingGroupProbe(sourceHostId: number, report: {
  groupId: number; memberId?: number; probeType?: string; targetIp?: string; targetPort?: number;
  method?: string; probeKey?: string; isTimeout?: boolean;
}) {
  const groupId = Number(report.groupId), serviceId = Number(report.memberId), sourceId = Number(sourceHostId);
  if (report.probeType !== "landing" || !Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(serviceId) || serviceId <= 0 || sourceId <= 0 || report.method !== "tcp") return false;
  const db = await getDb();
  if (!db) return false;
  const group = await getLandingGroup(groupId);
  if (!group) return false;
  const [service] = await db.select().from(landingServices).where(eq(landingServices.id, serviceId)).limit(1);
  if (!service || !group.hostIds.includes(service.hostId) || service.landingGroupId !== groupId || !service.isEnabled || service.userId !== group.userId) return false;
  const [rule] = await db.select({ id: forwardRules.id }).from(forwardRules).where(and(eq(forwardRules.targetLandingGroupId, groupId), eq(forwardRules.hostId, sourceId), eq(forwardRules.userId, group.userId), eq(forwardRules.isEnabled, true), eq(forwardRules.pendingDelete, false))).limit(1);
  if (!rule) return false;
  const address = String(service.endpoint || "").trim();
  if (!address || String(report.targetIp || "").trim().toLowerCase() !== address.toLowerCase() || Number(report.targetPort) !== Number(service.port)) return false;
  if (report.probeKey !== landingGroupProbeKey(groupId, serviceId, sourceId, address, service.port)) return false;
  await withKeyedTaskLock(`landing-group-probe:${groupId}:${serviceId}:${sourceId}`, async () => {
    const [existing] = await db.select().from(landingGroupProbeLatest).where(and(eq(landingGroupProbeLatest.groupId, groupId), eq(landingGroupProbeLatest.serviceId, serviceId), eq(landingGroupProbeLatest.sourceHostId, sourceId))).limit(1);
    const patch = { targetIp: address, targetPort: service.port, isTimeout: !!report.isTimeout, checkedAt: nowDate() };
    if (existing) await db.update(landingGroupProbeLatest).set(patch).where(eq(landingGroupProbeLatest.id, existing.id));
    else await insertAndGetId("landing_group_probe_latest", { groupId, serviceId, sourceHostId: sourceId, ...patch });
  });
  return true;
}

export function landingGroupPathHealthAt(probes: Array<{ serviceId: number; sourceHostId: number; targetIp: string; targetPort: number; checkedAt: Date; isTimeout: boolean }>, service: { id: number; endpoint: string | null; port: number }, sourceHostIds: number[], now = Date.now()): boolean | null {
  let missing = false;
  for (const sourceHostId of sourceHostIds) {
    const probe = probes.find(item => Number(item.serviceId) === service.id && Number(item.sourceHostId) === sourceHostId);
    const checked = probe?.checkedAt instanceof Date ? probe.checkedAt.getTime() : Number(new Date(probe?.checkedAt as any).getTime());
    if (!probe || !Number.isFinite(checked) || checked > now + 60_000 || now - checked > LANDING_GROUP_PROBE_TTL_MS || probe.targetIp.toLowerCase() !== String(service.endpoint || "").trim().toLowerCase() || Number(probe.targetPort) !== Number(service.port)) { missing = true; continue; }
    if (probe.isTimeout) return false;
  }
  return sourceHostIds.length && !missing ? true : null;
}
