import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { getLandingPortCheck, requestLandingPortCheck } from "../landingPortChecks";

const METHODS = [
  "aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305",
] as const;
const randomSecret = (length = 28) => Array.from(crypto.getRandomValues(new Uint8Array(length)), (v) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[v % 64]).join("");
const isAdmin = (user: any) => String(user?.role) === "admin";

async function requireEligibleHost(user: any, hostId: number) {
  const host = await db.getHostById(hostId) as any;
  if (!host) throw new Error("主机不存在");
  if (!isAdmin(user) && Number(host.userId) !== Number(user.id)) throw new Error("无权使用该主机");
  const eligible = await db.getLandingHostByHostId(hostId);
  if (!eligible) throw new Error("该主机尚未在链路管理中标记为落地机");
  return host;
}

function publicEndpoint(host: any) {
  return String(host?.entryIp || host?.ipv4 || host?.ip || "").trim();
}

export const landingRouter = router({
  eligibleHosts: protectedProcedure.query(async ({ ctx }) => {
    const markers = await db.getLandingHosts(isAdmin(ctx.user) ? undefined : ctx.user.id);
    const result = [] as any[];
    for (const marker of markers) {
      const host = await db.getHostById(marker.hostId) as any;
      if (!host) continue;
      result.push({ ...marker, host: { id: Number(host.id), name: host.name, ip: publicEndpoint(host), isOnline: !!host.isOnline, agentVersion: host.agentVersion || "" } });
    }
    return result;
  }),
  markHost: protectedProcedure.input(z.object({ hostId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const host = await db.getHostById(input.hostId) as any;
    if (!host) throw new Error("主机不存在");
    if (!isAdmin(ctx.user) && Number(host.userId) !== Number(ctx.user.id)) throw new Error("无权标记该主机");
    const existing = await db.getLandingHostByHostId(input.hostId);
    if (existing) return existing;
    const id = await db.createLandingHost({ hostId: input.hostId, userId: Number(host.userId) });
    return { id, hostId: input.hostId };
  }),
  unmarkHost: protectedProcedure.input(z.object({ hostId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const marker = await db.getLandingHostByHostId(input.hostId) as any;
    if (!marker) return { success: true };
    if (!isAdmin(ctx.user) && Number(marker.userId) !== Number(ctx.user.id)) throw new Error("无权取消标记该主机");
    const services = await db.getLandingServicesForHost(input.hostId);
    if (services.length) throw new Error("该落地机仍有 Shadowsocks 服务，请先删除服务");
    await db.deleteLandingHost(input.hostId);
    return { success: true };
  }),
  list: protectedProcedure.query(async ({ ctx }) => db.getLandingServices(isAdmin(ctx.user) ? undefined : ctx.user.id, true)),
  checkPort: protectedProcedure.input(z.object({ hostId: z.number().int().positive(), port: z.number().int().min(1).max(65535), excludeId: z.number().int().positive().optional() })).query(async ({ input, ctx }) => {
    await requireEligibleHost(ctx.user, input.hostId);
    const services = await db.getLandingServicesForHost(input.hostId);
    const occupied = services.some((item: any) => Number(item.port) === input.port && Number(item.id) !== Number(input.excludeId || 0));
    if (occupied) return { available: false, complete: true, message: "端口已被另一个落地服务使用" };
    const check = requestLandingPortCheck(input.hostId, input.port);
    pushAgentRefresh(input.hostId, "landing-port-check", { urgent: true });
    return { available: null, complete: false, checkId: check.id, message: "正在请求 Agent 检测端口" };
  }),
  portCheckStatus: protectedProcedure.input(z.object({ checkId: z.string().uuid() })).query(({ input }) => {
    const check = getLandingPortCheck(input.checkId);
    if (!check) return { complete: true, available: false, message: "端口检测已过期，请重新检测" };
    return { complete: !!check.completedAt, available: check.completedAt ? !!check.available : null, message: check.message || "Agent 正在检测端口" };
  }),
  create: protectedProcedure.input(z.object({
    hostId: z.number().int().positive(), name: z.string().trim().min(1).max(80), protocol: z.enum(["ss", "ss2022"]),
    method: z.enum(METHODS), password: z.string().trim().min(8).max(256), port: z.number().int().min(1).max(65535),
  })).mutation(async ({ input, ctx }) => {
    const host = await requireEligibleHost(ctx.user, input.hostId);
    const wants2022 = input.protocol === "ss2022";
    if (wants2022 !== input.method.startsWith("2022-")) throw new Error("SS2022 必须使用 2022 加密方式，普通 SS 不能使用 2022 加密方式");
    const port = await db.getLandingServicesForHost(input.hostId);
    if (port.some((item: any) => Number(item.port) === input.port)) throw new Error("端口已被另一个落地服务使用");
    const id = await db.createLandingService({ ...input, userId: Number(host.userId), isEnabled: true, status: "pending", statusMessage: "等待 Agent 部署" });
    pushAgentRefresh(input.hostId, "landing-service-create", { urgent: true });
    return { id, status: "pending" };
  }),
  random: protectedProcedure.query(() => ({ password: randomSecret(), port: Math.floor(20000 + Math.random() * 30000) })),
  remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const service = await db.getLandingServiceById(input.id, true) as any;
    if (!service) return { success: true };
    if (!isAdmin(ctx.user) && Number(service.userId) !== Number(ctx.user.id)) throw new Error("无权删除该服务");
    await db.updateLandingService(input.id, { isEnabled: false, status: "removing", statusMessage: "等待 Agent 清理" });
    pushAgentRefresh(Number(service.hostId), "landing-service-remove", { urgent: true });
    return { success: true };
  }),
});
