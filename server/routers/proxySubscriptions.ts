import crypto from "crypto";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { executeRaw, queryRaw } from "../dbRuntime";

const formats = ["clash", "egern", "loon", "raw"] as const;
const protocols = ["ss", "ssr", "vmess", "vless"] as const;
const nodeInput = z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(160), protocol: z.enum(protocols), link: z.string().trim().min(3).max(12000), groupName: z.string().trim().max(80).optional().nullable(), enabled: z.boolean().default(true) });
const subscriptionInput = z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(160), nodeIds: z.array(z.number().int().positive()).default([]), formats: z.array(z.enum(formats)).min(1), expiresAt: z.date().nullable().optional(), accessLimit: z.number().int().min(0).max(10_000_000).default(0), revoked: z.boolean().default(false) });
const nodeSubscriptionInput = z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(160), nodeIds: z.array(z.number().int().positive()).min(1), expiresAt: z.date().nullable().optional(), accessLimit: z.number().int().min(0).max(10_000_000).default(0), revoked: z.boolean().default(false) });

function now() { return Math.floor(Date.now() / 1000); }
function token() { return crypto.randomBytes(18).toString("base64url"); }
function parseEndpoint(link: string) {
  const protocol = link.slice(0, link.indexOf(":" )).toLowerCase();
  const decode = (value: string) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  try {
    if (protocol === "vmess") {
      const data = JSON.parse(decode(link.slice(8)));
      return { server: String(data.add || ""), port: Number(data.port || 0) || null, name: String(data.ps || data.add || "") };
    }
    if (protocol === "ssr") {
      const [base, query = ""] = decode(link.slice(6)).split("/?");
      const parts = base.split(":"); const port = Number(parts[parts.length - 5] || 0) || null; const server = parts.slice(0, -5).join(":");
      const remarks = new URLSearchParams(query).get("remarks");
      return { server, port, name: remarks ? decode(remarks) : `${server}:${port || ""}` };
    }
    const url = new URL(link);
    return { server: url.hostname, port: Number(url.port || 0) || null, name: decodeURIComponent(url.hash.slice(1)) || url.hostname };
  } catch { return { server: "", port: null, name: "" }; }
}
function rowNode(row: any) { return { ...row, enabled: !!row.enabled, port: Number(row.port || 0) || null }; }
function rowSubscription(row: any) { return { ...row, nodeIds: JSON.parse(row.nodeIdsJson || "[]"), formats: JSON.parse(row.formatsJson || "[]"), revoked: !!row.revoked, expiresAt: row.expiresAt ? new Date(Number(row.expiresAt) * 1000) : null }; }

export const proxySubscriptionsRouter = router({
  nodes: adminProcedure.query(async () => (await queryRaw<any>("SELECT * FROM proxy_nodes ORDER BY updatedAt DESC, id DESC")).map(rowNode)),
  saveNode: adminProcedure.input(nodeInput).mutation(async ({ input }) => {
    const endpoint = parseEndpoint(input.link);
    const values = [input.name || endpoint.name || "未命名节点", input.protocol, input.link, input.groupName || null, endpoint.server || null, endpoint.port, input.enabled, now()];
    if (input.id) await executeRaw("UPDATE proxy_nodes SET name=?, protocol=?, link=?, groupName=?, server=?, port=?, enabled=?, updatedAt=? WHERE id=?", [...values, input.id]);
    else await executeRaw("INSERT INTO proxy_nodes (name, protocol, link, groupName, server, port, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [...values, now()]);
    return { success: true };
  }),
  importNodes: adminProcedure.input(z.object({ links: z.string().min(1).max(200_000) })).mutation(async ({ input }) => {
    const lines = input.links.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let imported = 0, skipped = 0;
    for (const link of lines) {
      const protocol = link.slice(0, link.indexOf(":" )).toLowerCase();
      if (!(protocols as readonly string[]).includes(protocol)) { skipped++; continue; }
      const endpoint = parseEndpoint(link);
      await executeRaw("INSERT INTO proxy_nodes (name, protocol, link, server, port, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [endpoint.name || `${protocol.toUpperCase()} 节点`, protocol, link, endpoint.server || null, endpoint.port, true, now(), now()]);
      imported++;
    }
    return { imported, skipped };
  }),
  deleteNode: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("DELETE FROM proxy_nodes WHERE id=?", [input.id]); return { success: true }; }),
  subscriptions: adminProcedure.query(async () => (await queryRaw<any>("SELECT * FROM proxy_subscriptions ORDER BY updatedAt DESC, id DESC")).map(rowSubscription)),
  saveSubscription: adminProcedure.input(subscriptionInput).mutation(async ({ input }) => {
    const values = [input.name, JSON.stringify(input.nodeIds), JSON.stringify(input.formats), input.expiresAt ? Math.floor(input.expiresAt.getTime() / 1000) : null, input.accessLimit, input.revoked, now()];
    if (input.id) await executeRaw("UPDATE proxy_subscriptions SET name=?, nodeIdsJson=?, formatsJson=?, expiresAt=?, accessLimit=?, revoked=?, updatedAt=? WHERE id=?", [...values, input.id]);
    else await executeRaw("INSERT INTO proxy_subscriptions (name, token, nodeIdsJson, formatsJson, expiresAt, accessLimit, revoked, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [input.name, token(), ...values.slice(1), now()]);
    return { success: true };
  }),
  rotateToken: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("UPDATE proxy_subscriptions SET token=?, updatedAt=? WHERE id=?", [token(), now(), input.id]); return { success: true }; }),
  resetAccessCount: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("UPDATE proxy_subscriptions SET accessCount=0, updatedAt=? WHERE id=?", [now(), input.id]); return { success: true }; }),
  setSubscriptionRevoked: adminProcedure.input(z.object({ id: z.number().int().positive(), revoked: z.boolean() })).mutation(async ({ input }) => { await executeRaw("UPDATE proxy_subscriptions SET revoked=?, updatedAt=? WHERE id=?", [input.revoked, now(), input.id]); return { success: true }; }),
  deleteSubscription: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("DELETE FROM proxy_subscriptions WHERE id=?", [input.id]); return { success: true }; }),
  nodeSubscriptions: adminProcedure.query(async () => (await queryRaw<any>("SELECT * FROM proxy_node_subscriptions ORDER BY updatedAt DESC, id DESC")).map(rowSubscription)),
  saveNodeSubscription: adminProcedure.input(nodeSubscriptionInput).mutation(async ({ input }) => {
    const values = [input.name, JSON.stringify(input.nodeIds), input.expiresAt ? Math.floor(input.expiresAt.getTime() / 1000) : null, input.accessLimit, input.revoked, now()];
    if (input.id) await executeRaw("UPDATE proxy_node_subscriptions SET name=?, nodeIdsJson=?, expiresAt=?, accessLimit=?, revoked=?, updatedAt=? WHERE id=?", [...values, input.id]);
    else await executeRaw("INSERT INTO proxy_node_subscriptions (name, token, nodeIdsJson, expiresAt, accessLimit, revoked, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [input.name, token(), ...values.slice(1), now()]);
    return { success: true };
  }),
  rotateNodeSubscriptionToken: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("UPDATE proxy_node_subscriptions SET token=?, updatedAt=? WHERE id=?", [token(), now(), input.id]); return { success: true }; }),
  resetNodeSubscriptionAccessCount: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("UPDATE proxy_node_subscriptions SET accessCount=0, updatedAt=? WHERE id=?", [now(), input.id]); return { success: true }; }),
  setNodeSubscriptionRevoked: adminProcedure.input(z.object({ id: z.number().int().positive(), revoked: z.boolean() })).mutation(async ({ input }) => { await executeRaw("UPDATE proxy_node_subscriptions SET revoked=?, updatedAt=? WHERE id=?", [input.revoked, now(), input.id]); return { success: true }; }),
  deleteNodeSubscription: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("DELETE FROM proxy_node_subscriptions WHERE id=?", [input.id]); return { success: true }; }),
  templates: adminProcedure.query(async () => (await queryRaw<any>("SELECT * FROM proxy_templates ORDER BY format")).map((row) => ({ ...row }))),
  saveTemplate: adminProcedure.input(z.object({ format: z.enum(formats), content: z.string().min(1).max(300_000).refine((value) => value.includes("{{PROXY_NODES}}"), "模板必须包含 {{PROXY_NODES}} 占位符") })).mutation(async ({ input }) => {
    await executeRaw("DELETE FROM proxy_templates WHERE format=?", [input.format]);
    await executeRaw("INSERT INTO proxy_templates (format, content, updatedAt) VALUES (?, ?, ?)", [input.format, input.content, now()]);
    return { success: true };
  }),
  accessLogs: adminProcedure.input(z.object({ subscriptionId: z.number().int().positive(), subscriptionKind: z.enum(["config", "nodes"]).default("config") })).query(async ({ input }) => {
    return queryRaw<any>("SELECT * FROM proxy_subscription_logs WHERE subscriptionId=? AND subscriptionKind=? ORDER BY id DESC LIMIT 200", [input.subscriptionId, input.subscriptionKind]);
  }),
});
