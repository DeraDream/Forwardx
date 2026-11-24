import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { requireHostAccess } from "./helpers";
import { buildAgentLinkDemands } from "../agentLinkDemandBuilder";
import {
  clearAgentLinkDemands,
  getAgentLinkDemandIdentities,
  replaceAgentLinkDemands,
  runAgentLinkProbeIdentities,
} from "../agentLinkScheduler";
import { aggregateAgentLinkPathRound } from "../../shared/agentLinkAggregation";
import { buildAgentLinkEdgeKey, type AgentLinkIdentity } from "../../shared/agentLink";

const transportSchema = z.enum(["tcp", "udp"]);
const edgeSchema = z.object({
  sourceHostId: z.number().int().positive(),
  targetHostId: z.number().int().positive(),
  targetAddress: z.string().trim().min(1).max(253),
  targetPort: z.number().int().min(1).max(65535),
  transport: transportSchema,
});
const hostPairSchema = z.object({
  sourceHostId: z.number().int().positive(),
  targetHostId: z.number().int().positive(),
});
const candidateSchema = z.object({
  sourceHostId: z.number().int().positive(),
  targetHostId: z.number().int().positive(),
  targetAddress: z.string().trim().min(1).max(253),
});

async function requireEdgeAccess(ctx: any, edges: Array<{ sourceHostId: number; targetHostId: number }>) {
  const hostIds = Array.from(new Set(edges.flatMap((edge) => [edge.sourceHostId, edge.targetHostId])));
  await Promise.all(hostIds.map((hostId) => requireHostAccess(ctx, hostId)));
}

function watcherOwner(userId: number, watcherId: string) {
  return `ui-agent-link:${Number(userId)}:${String(watcherId).trim()}`;
}

export const agentLinksRouter = router({
  topologyEdges: protectedProcedure.input(z.object({ pairs: z.array(hostPairSchema).min(1).max(200) })).query(async ({ input, ctx }) => {
    await requireEdgeAccess(ctx, input.pairs);
    return getAgentLinkDemandIdentities(input.pairs);
  }),

  latest: protectedProcedure.input(z.object({ edges: z.array(edgeSchema).min(1).max(200) })).query(async ({ input, ctx }) => {
    await requireEdgeAccess(ctx, input.edges);
    const edgeKeys = input.edges.map((edge) => buildAgentLinkEdgeKey(edge as AgentLinkIdentity)).filter(Boolean);
    return db.getAgentLinkLatest(edgeKeys);
  }),

  history: protectedProcedure.input(z.object({
    edge: edgeSchema,
    hours: z.number().min(0.1).max(30 * 24).default(24),
    limit: z.number().int().min(1).max(10_000).default(1_000),
  })).query(async ({ input, ctx }) => {
    await requireEdgeAccess(ctx, [input.edge]);
    const edgeKey = buildAgentLinkEdgeKey(input.edge as AgentLinkIdentity);
    return db.getAgentLinkHistory(edgeKey, {
      since: new Date(Date.now() - input.hours * 60 * 60 * 1000),
      limit: input.limit,
    });
  }),

  pathRound: protectedProcedure.input(z.object({
    edges: z.array(edgeSchema).min(1).max(100),
    probeRoundId: z.string().trim().min(1).max(128).optional(),
  })).query(async ({ input, ctx }) => {
    await requireEdgeAccess(ctx, input.edges);
    const edgeKeys = input.edges.map((edge) => buildAgentLinkEdgeKey(edge as AgentLinkIdentity)).filter(Boolean);
    let probeRoundId = String(input.probeRoundId || "").trim();
    if (!probeRoundId) {
      const latest = await db.getAgentLinkLatest(edgeKeys);
      probeRoundId = String(latest[0]?.probeRoundId || "");
    }
    const samples = probeRoundId ? await db.getAgentLinkRoundSamples(probeRoundId, edgeKeys) : [];
    return aggregateAgentLinkPathRound(edgeKeys, samples);
  }),

  watch: protectedProcedure.input(z.object({
    watcherId: z.string().uuid(),
    candidates: z.array(candidateSchema).min(1).max(100),
  })).mutation(async ({ input, ctx }) => {
    await requireEdgeAccess(ctx, input.candidates);
    const identities = await buildAgentLinkDemands(input.candidates);
    replaceAgentLinkDemands(watcherOwner(ctx.user.id, input.watcherId), identities, { mode: "interactive", ttlMs: 15_000 });
    return { edgeKeys: identities.map(buildAgentLinkEdgeKey) };
  }),

  unwatch: protectedProcedure.input(z.object({ watcherId: z.string().uuid() })).mutation(({ input, ctx }) => {
    clearAgentLinkDemands(watcherOwner(ctx.user.id, input.watcherId));
    return { success: true };
  }),

  probeNow: protectedProcedure.input(z.object({
    watcherId: z.string().uuid(),
    candidates: z.array(candidateSchema).min(1).max(100),
    transport: transportSchema.optional().default("tcp"),
  })).mutation(async ({ input, ctx }) => {
    await requireEdgeAccess(ctx, input.candidates);
    const identities = (await buildAgentLinkDemands(input.candidates)).filter((identity) => identity.transport === input.transport);
    replaceAgentLinkDemands(watcherOwner(ctx.user.id, input.watcherId), identities, { mode: "interactive", ttlMs: 15_000 });
    return runAgentLinkProbeIdentities(identities, "interactive");
  }),
});
