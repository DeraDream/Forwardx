import { eq, isNotNull } from "drizzle-orm";
import { landingGroups, landingServices, hosts, landingHosts, forwardRules, landingGroupProbeLatest } from "../drizzle/schema";
import { getDb } from "./dbRuntime";
import { appendPanelLog } from "./_core/panelLogger";
import { pushAgentRefresh, requestHostTcping } from "./agentEvents";
import { landingGroupPathHealthAt } from "./landingGroupProbes";
import { isHostStatusOnline } from "./hostStatusNotifier";
import { listLandingGroups } from "./repositories/landingGroupRepository";
import { nextLandingGroupHealth } from "./landingGroupFailoverPolicy";

const lastProbeRequestAt = new Map<number, number>();

export async function runLandingGroupFailoverSweep(now = Date.now()) {
  const groups = await listLandingGroups();
  if (!groups.length) return;
  const database = await getDb();
  if (!database) return;
  // Avoid the public service list: it aggregates traffic history for every SS.
  const [services, hostRows, markers, rules, probes] = await Promise.all([
    database.select().from(landingServices), database.select().from(hosts),
    database.select().from(landingHosts), database.select({ id: forwardRules.id, hostId: forwardRules.hostId, targetLandingGroupId: forwardRules.targetLandingGroupId, pendingDelete: forwardRules.pendingDelete, isEnabled: forwardRules.isEnabled }).from(forwardRules).where(isNotNull(forwardRules.targetLandingGroupId)),
    database.select().from(landingGroupProbeLatest),
  ]);
  const hostById = new Map((hostRows as any[]).map(host => [Number(host.id), host]));
  const disabledHosts = new Set((markers as any[]).filter(marker => marker.isEnabled === false).map(marker => Number(marker.hostId)));
  for (const group of groups) {
    const boundRules = (rules as any[]).filter(rule => Number(rule.targetLandingGroupId) === Number(group.id) && !rule.pendingDelete && rule.isEnabled);
    if (!boundRules.length) continue;
    const sourceHostIds = Array.from(new Set(boundRules.map(rule => Number(rule.hostId))));
    const groupProbes = probes.filter((probe: typeof landingGroupProbeLatest.$inferSelect) => probe.groupId === group.id);
    for (const sourceId of sourceHostIds) {
      if (!isHostStatusOnline(hostById.get(sourceId)) || now - (lastProbeRequestAt.get(sourceId) || 0) < 25_000) continue;
      lastProbeRequestAt.set(sourceId, now);
      requestHostTcping(sourceId);
      pushAgentRefresh(sourceId, "landing-group-tcp-probe", { urgent: true });
    }
    const owned = (services as any[]).filter(service => Number(service.landingGroupId) === Number(group.id) && !service.isFullChainManaged);
    const reference = owned.find(service => Number(service.hostId) === Number(group.hostIds[0])) || owned.find(service => Number(service.id) === Number(group.activeServiceId)) || owned[0];
    if (!reference) continue;
    const candidates = group.hostIds.map((hostId: number) => owned.find((service: any) => Number(service.hostId) === Number(hostId))).filter(Boolean).map((service: any) => {
      const host = hostById.get(Number(service.hostId));
      const runtimeFailed = service.port !== reference.port || service.protocol !== reference.protocol || service.method !== reference.method || service.password !== reference.password || !service.isEnabled || disabledHosts.has(Number(service.hostId)) || !isHostStatusOnline(host) || service.status === "error" || service.status === "disabled" || service.status === "removing";
      return {
        serviceId: Number(service.id),
        healthy: runtimeFailed ? false : service.status === "running"
          ? landingGroupPathHealthAt(groupProbes, service, sourceHostIds, now) : null,
      };
    });
    const next = nextLandingGroupHealth(group, candidates, now);
    const time = (value: Date | null | undefined) => value instanceof Date ? value.getTime() : value ? new Date(value).getTime() : 0;
    if (Number(next.activeServiceId || 0) === Number(group.activeServiceId || 0)
      && time(next.activeUnhealthySince) === time(group.activeUnhealthySince)
      && time(next.primaryHealthySince) === time(group.primaryHealthySince)
      && Number(next.recoveryServiceId || 0) === Number(group.recoveryServiceId || 0)) continue;
    await database.update(landingGroups).set({
      activeServiceId: next.activeServiceId,
      activeUnhealthySince: next.activeUnhealthySince,
      primaryHealthySince: next.primaryHealthySince,
      recoveryServiceId: next.recoveryServiceId,
    }).where(eq(landingGroups.id, Number(group.id)));
    if (Number(next.activeServiceId || 0) !== Number(group.activeServiceId || 0)) {
      appendPanelLog("info", `[LandingGroup] group=${group.id} active=${group.activeServiceId || "none"}->${next.activeServiceId || "none"}`);
      for (const rule of boundRules) pushAgentRefresh(Number(rule.hostId), "landing-group-switch", { urgent: true });
    }
  }
}
