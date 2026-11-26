import * as db from "./db";
import { isHostStatusOnline } from "./hostStatusNotifier";
import { getLandingGroup, setLandingGroupActive } from "./repositories/landingGroupRepository";

export async function resolveLandingGroupActiveService(groupId: number, userId: number) {
  const group = await getLandingGroup(groupId);
  if (!group || Number(group.userId) !== Number(userId)) throw new Error("无权使用该落地组");
  if (group.hostIds.length < 2) throw new Error("落地组至少需要两台成员才能启用主备");
  const [services, markers] = await Promise.all([db.getLandingServices(group.userId, true), db.getLandingHosts(group.userId)]);
  const disabled = new Set((markers as any[]).filter(marker => marker.isEnabled === false).map(marker => Number(marker.hostId)));
  const members = group.hostIds.map((hostId: number) => (services as any[]).find((service: any) => Number(service.landingGroupId) === group.id && Number(service.hostId) === hostId));
  if (members.some((service: any) => !service)) throw new Error("落地组所有成员均需先部署 SS 才能启用主备");
  const reference = members[0];
  if (members.some((service: any) => service.port !== reference.port || service.protocol !== reference.protocol || service.method !== reference.method || service.password !== reference.password)) {
    throw new Error("组内 SS 配置不一致，不能启用主备");
  }
  const available = [];
  for (const service of members) {
    const host = await db.getHostById(Number(service.hostId));
    if (service.isEnabled && service.status === "running" && !disabled.has(Number(service.hostId)) && isHostStatusOnline(host)) available.push(service);
  }
  const active = available.find(service => Number(service.id) === Number(group.activeServiceId)) || available[0];
  if (!active) throw new Error("落地组没有已运行且在线的 SS，不能启用主备");
  if (Number(active.id) !== Number(group.activeServiceId)) await setLandingGroupActive(group.id, Number(active.id));
  return { group, service: active };
}
