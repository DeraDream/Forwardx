import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { cancelFullChain, deployFullChain, startFullChain, startFullChainProtocolCheck } from "../fullChainRuntime";
import { pushAgentRefresh } from "../agentEvents";

const methods = ["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305"] as const;
const secret = () => Array.from(crypto.getRandomValues(new Uint8Array(28)), (v) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[v % 64]).join("");
const isAdmin = (user: any) => String(user?.role) === "admin";
const ownerId = (user: any) => isAdmin(user) ? undefined : Number(user.id);

async function requireChain(user: any, id: number) {
  const chain = await db.getFullChainById(id) as any;
  if (!chain) throw new Error("全链路不存在");
  if (!isAdmin(user) && Number(chain.userId) !== Number(user.id)) throw new Error("无权操作此全链路");
  return chain;
}

const nodeInput = z.object({ hostId: z.number().int().positive(), ingressIp: z.string().trim().max(253).optional().nullable() });
const createInput = z.object({
  name: z.string().trim().min(1).max(80), port: z.number().int().min(1).max(65535), protocol: z.enum(["tcp", "both"]).default("both"),
  ssProtocol: z.enum(["ss", "ss2022"]), method: z.enum(methods), password: z.string().trim().min(8).max(256),
  allowPublicIntermediate: z.boolean().default(true), nodes: z.array(nodeInput).min(2).max(12),
});

function sameNodes(current: any[], next: Array<{ hostId: number; ingressIp?: string | null }>) {
  return current.length === next.length && current.every((node, index) =>
    Number(node.hostId) === Number(next[index].hostId) &&
    String(node.ingressIp || "") === String(next[index].ingressIp || ""),
  );
}

export const fullChainsRouter = router({
  list: protectedProcedure.query(({ ctx }) => db.listFullChains(ownerId(ctx.user))),
  latencySeries: protectedProcedure.input(z.object({ id: z.number().int().positive(), hours: z.number().int().min(1).max(168).default(72) })).query(async ({ input, ctx }) => {
    await requireChain(ctx.user, input.id);
    return db.getFullChainLatencySeries(input.id, input.hours);
  }),
  hosts: protectedProcedure.query(async ({ ctx }) => {
    const hosts = await db.getHosts(ownerId(ctx.user));
    const markers = await db.getLandingHosts(ownerId(ctx.user));
    const landingIds = new Set(markers.map((row: any) => Number(row.hostId)));
    return hosts.map((host: any) => ({ id: Number(host.id), name: host.name, ip: host.entryIp || host.ipv4 || host.ip || "", isOnline: !!host.isOnline, isLanding: landingIds.has(Number(host.id)) }));
  }),
  random: protectedProcedure.query(() => ({ password: secret(), port: Math.floor(20000 + Math.random() * 30000) })),
  create: protectedProcedure.input(createInput).mutation(async ({ input, ctx }) => {
    if (new Set(input.nodes.map((node) => node.hostId)).size !== input.nodes.length) throw new Error("同一台机器只能出现一次");
    if ((input.ssProtocol === "ss2022") !== input.method.startsWith("2022-")) throw new Error("SS 类型与加密方式不匹配");
    for (const node of input.nodes) {
      const host = await db.getHostById(node.hostId) as any;
      if (!host || (!isAdmin(ctx.user) && Number(host.userId) !== Number(ctx.user.id))) throw new Error("链路中包含无权使用的主机");
    }
    const last = input.nodes[input.nodes.length - 1];
    if (!await db.getLandingHostByHostId(last.hostId)) throw new Error("末端 SS 必须选择已标记的落地机");
    const id = await db.createFullChain({ ...input, userId: Number(ctx.user.id) });
    return { id };
  }),
  update: protectedProcedure.input(createInput.extend({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const old = await requireChain(ctx.user, input.id);
    if (["checking-link", "checking-port", "checking-protocol", "deploying"].includes(String(old.status))) throw new Error("全链路正在执行，暂不能编辑");
    if (new Set(input.nodes.map((node) => node.hostId)).size !== input.nodes.length) throw new Error("同一台机器只能出现一次");
    if ((input.ssProtocol === "ss2022") !== input.method.startsWith("2022-")) throw new Error("SS 类型与加密方式不匹配");
    for (const node of input.nodes) {
      const host = await db.getHostById(node.hostId) as any;
      if (!host || (!isAdmin(ctx.user) && Number(host.userId) !== Number(ctx.user.id))) throw new Error("链路中包含无权使用的主机");
    }
    if (!await db.getLandingHostByHostId(input.nodes[input.nodes.length - 1].hostId)) throw new Error("末端 SS 必须选择已标记的落地机");
    const oldNodes = await db.getFullChainNodes(input.id);
    let requiresRedeploy =
      Number(old.port) !== input.port ||
      String(old.protocol) !== input.protocol ||
      !!old.allowPublicIntermediate !== input.allowPublicIntermediate ||
      !sameNodes(oldNodes, input.nodes);
    const landingService = Number(old.landingServiceId) > 0
      ? await db.getLandingServiceById(Number(old.landingServiceId), true) as any
      : null;
    if (!landingService) requiresRedeploy = true;

    if (!requiresRedeploy) {
      await db.updateFullChain(input.id, {
        name: input.name, ssProtocol: input.ssProtocol, method: input.method, password: input.password,
      });
      await db.updateLandingService(Number(landingService.id), {
        name: input.name, protocol: input.ssProtocol, method: input.method, password: input.password,
        previousPort: Number(landingService.port), recreatePending: true,
        status: "pending", statusMessage: "全链路落地 SS 更新中",
      });
      pushAgentRefresh(Number(landingService.hostId), "full-chain-landing-update", { urgent: true });
      return { id: input.id, requiresRedeploy: false };
    }

    await cancelFullChain(input.id);
    await db.replaceFullChainConfig(input.id, { ...input, userId: Number(old.userId) });
    return { id: input.id, requiresRedeploy: true };
  }),
  start: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const chain = await requireChain(ctx.user, input.id);
    if (["checking-link", "checking-port", "checking-protocol", "deploying"].includes(String(chain.status))) throw new Error("全链路正在执行，暂不可重试");
    await cancelFullChain(input.id);
    await db.updateFullChain(input.id, { isEnabled: true, status: "draft", statusMessage: "准备重试", landingServiceId: null });
    await startFullChain(input.id);
    return { success: true };
  }),
  check: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const chain = await requireChain(ctx.user, input.id);
    if (["checking-link", "checking-port", "checking-protocol", "deploying"].includes(String(chain.status))) throw new Error("全链路正在执行");
    await startFullChain(input.id);
    return { success: true };
  }),
  checkProtocol: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const chain = await requireChain(ctx.user, input.id);
    if (["checking-link", "checking-protocol", "deploying"].includes(String(chain.status))) throw new Error("全链路正在执行");
    await startFullChainProtocolCheck(input.id);
    return { success: true };
  }),
  deploy: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    await requireChain(ctx.user, input.id);
    await deployFullChain(input.id);
    return { success: true };
  }),
  cancel: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    await requireChain(ctx.user, input.id); await cancelFullChain(input.id); return { success: true };
  }),
  checkLatency: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    await requireChain(ctx.user, input.id);
    const nodes = await db.getFullChainNodes(input.id);
    for (const node of nodes.slice(0, -1)) { await db.updateFullChainNode(Number(node.id), { latencyStatus: "checking", latencyMs: null }); pushAgentRefresh(Number(node.hostId), "full-chain-latency", { urgent: true }); }
    return { success: true };
  }),
  remove: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    await requireChain(ctx.user, input.id); await cancelFullChain(input.id); await db.deleteFullChain(input.id); return { success: true };
  }),
});
