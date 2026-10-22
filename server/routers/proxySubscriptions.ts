import crypto from "crypto";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { executeRaw, queryRaw } from "../dbRuntime";

const formats = ["clash", "egern", "loon", "raw"] as const;
const protocols = ["ss", "ssr", "vmess", "vless"] as const;
const positiveIds = z.array(z.number().int().positive()).max(10_000).default([]);
const nodeInput = z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(160), protocol: z.enum(protocols), link: z.string().trim().min(3).max(12000), groupName: z.string().trim().max(80).optional().nullable(), enabled: z.boolean().default(true), groupIds: positiveIds.optional(), configSubscriptionIds: positiveIds.optional(), nodeSubscriptionIds: positiveIds.optional() });
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
    if (protocol === "ss") {
      const raw = link.slice(5); const splitAt = raw.search(/[?#]/); const encoded = splitAt < 0 ? raw : raw.slice(0, splitAt);
      // The old SS URI encodes the complete userinfo and endpoint.
      if (!encoded.includes("@")) {
        const decoded = decode(encoded); const at = decoded.lastIndexOf("@"); const colon = decoded.slice(at + 1).lastIndexOf(":");
        if (at >= 0 && colon > 0) return { server: decoded.slice(at + 1, at + 1 + colon), port: Number(decoded.slice(at + 2 + colon)) || null, name: decodeURIComponent((raw.match(/#(.*)$/)?.[1] || "")) || decoded.slice(at + 1) };
      }
    }
    const url = new URL(link);
    return { server: url.hostname, port: Number(url.port || 0) || null, name: decodeURIComponent(url.hash.slice(1)) || url.hostname };
  } catch { return { server: "", port: null, name: "" }; }
}
function replaceImportServer(link: string, address?: string) {
  if (!address) return link;
  const protocol = link.slice(0, link.indexOf(":" )).toLowerCase();
  if (protocol !== "ss" && protocol !== "vless") return link;
  try {
    const url = new URL(link);
    // URI-style SS links and VLESS links both have a real hostname.
    if (url.hostname && (protocol === "vless" || !!url.port)) { url.hostname = address; return url.toString(); }
  } catch { /* Try the legacy base64 SS form below. */ }
  if (protocol !== "ss") return link;
  // Legacy SS links encode `method:password@host:port` immediately after ss://.
  // Keep query, plugin and remark untouched while replacing only the host.
  try {
    const raw = link.slice(5);
    const splitAt = raw.search(/[?#]/);
    const encoded = splitAt < 0 ? raw : raw.slice(0, splitAt);
    const suffix = splitAt < 0 ? "" : raw.slice(splitAt);
    const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const at = decoded.lastIndexOf("@");
    const hostPort = decoded.slice(at + 1);
    const colon = hostPort.lastIndexOf(":");
    if (at < 0 || colon < 1) return link;
    const host = address.includes(":") ? `[${address}]` : address;
    const replaced = `${decoded.slice(0, at + 1)}${host}${hostPort.slice(colon)}`;
    return `ss://${Buffer.from(replaced).toString("base64").replace(/=+$/, "")}${suffix}`;
  } catch { return link; }
}
function nodeFingerprint(link: string) {
  const protocol = link.slice(0, link.indexOf(":")).toLowerCase();
  try {
    if (protocol === "vmess") {
      const parsed = JSON.parse(Buffer.from(link.slice(8).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      return `vmess:${String(parsed.id || "")}:${String(parsed.add || "").toLowerCase()}:${String(parsed.port || "")}:${String(parsed.net || "")}:${String(parsed.host || "")}:${String(parsed.path || "")}`;
    }
    const endpoint = parseEndpoint(link);
    // A normalized link catches harmless differences such as a different remark.
    const withoutRemark = link.split("#")[0].replace(/\/+$/, "");
    return `${protocol}:${endpoint.server.toLowerCase()}:${endpoint.port || ""}:${withoutRemark.toLowerCase()}`;
  } catch { return link.trim().toLowerCase(); }
}
function rowNode(row: any) { return { ...row, enabled: !!row.enabled, port: Number(row.port || 0) || null }; }
function rowSubscription(row: any) { return { ...row, nodeIds: JSON.parse(row.nodeIdsJson || "[]"), formats: JSON.parse(row.formatsJson || "[]"), revoked: !!row.revoked, expiresAt: row.expiresAt ? new Date(Number(row.expiresAt) * 1000) : null }; }
function ids(value: unknown) { return Array.from(new Set((Array.isArray(value) ? value : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))); }

async function syncLegacyGroups() {
  const rows = await queryRaw<any>("SELECT DISTINCT groupName FROM proxy_nodes WHERE groupName IS NOT NULL AND groupName<>''");
  for (const row of rows) {
    const name = String(row.groupName || "").trim();
    if (!name) continue;
    let group = (await queryRaw<any>("SELECT id FROM proxy_node_groups WHERE name=? LIMIT 1", [name]))[0];
    if (!group) {
      await executeRaw("INSERT INTO proxy_node_groups (name, createdAt, updatedAt) VALUES (?, ?, ?)", [name, now(), now()]);
      group = (await queryRaw<any>("SELECT id FROM proxy_node_groups WHERE name=? LIMIT 1", [name]))[0];
    }
    if (group) await executeRaw("INSERT INTO proxy_node_group_members (nodeId, groupId, createdAt) SELECT id, ?, ? FROM proxy_nodes WHERE groupName=? AND id NOT IN (SELECT nodeId FROM proxy_node_group_members WHERE groupId=?)", [group.id, now(), name, group.id]);
  }
}

async function syncNodeRelations(nodeId: number, groupIds?: number[], configSubscriptionIds?: number[], nodeSubscriptionIds?: number[]) {
  if (groupIds !== undefined) {
    await executeRaw("DELETE FROM proxy_node_group_members WHERE nodeId=?", [nodeId]);
    for (const groupId of ids(groupIds)) await executeRaw("INSERT INTO proxy_node_group_members (nodeId, groupId, createdAt) VALUES (?, ?, ?)", [nodeId, groupId, now()]);
  }
  for (const [table, selected] of [["proxy_subscriptions", configSubscriptionIds], ["proxy_node_subscriptions", nodeSubscriptionIds]] as const) {
    if (selected === undefined) continue;
    const selectedIds = new Set(ids(selected));
    const rows = await queryRaw<any>(`SELECT id, nodeIdsJson FROM ${table}`);
    for (const row of rows) {
      const current = ids(JSON.parse(row.nodeIdsJson || "[]"));
      const next = selectedIds.has(Number(row.id)) ? [...new Set([...current, nodeId])] : current.filter((id) => id !== nodeId);
      if (next.length !== current.length || next.some((id, index) => id !== current[index])) await executeRaw(`UPDATE ${table} SET nodeIdsJson=?, updatedAt=? WHERE id=?`, [JSON.stringify(next), now(), row.id]);
    }
  }
}

async function removeNodeRelations(nodeId: number) {
  await executeRaw("DELETE FROM proxy_node_group_members WHERE nodeId=?", [nodeId]);
  for (const table of ["proxy_subscriptions", "proxy_node_subscriptions"]) {
    const rows = await queryRaw<any>(`SELECT id, nodeIdsJson FROM ${table}`);
    for (const row of rows) {
      const current = ids(JSON.parse(row.nodeIdsJson || "[]"));
      const next = current.filter((id) => id !== nodeId);
      if (next.length !== current.length) await executeRaw(`UPDATE ${table} SET nodeIdsJson=?, updatedAt=? WHERE id=?`, [JSON.stringify(next), now(), row.id]);
    }
  }
}

async function enrichedNodes(source?: any[]) {
  await syncLegacyGroups();
  const nodes = (source || await queryRaw<any>("SELECT * FROM proxy_nodes ORDER BY sortOrder ASC, createdAt DESC, id DESC")).map(rowNode);
  if (!nodes.length) return [];
  const nodeIds = nodes.map((node) => Number(node.id));
  const marks = nodeIds.map(() => "?").join(",");
  const memberships = await queryRaw<any>(`SELECT m.nodeId, g.id, g.name FROM proxy_node_group_members m JOIN proxy_node_groups g ON g.id=m.groupId WHERE m.nodeId IN (${marks}) ORDER BY g.name ASC`, nodeIds);
  const config = (await queryRaw<any>("SELECT id, name, nodeIdsJson FROM proxy_subscriptions")).map(rowSubscription);
  const raw = (await queryRaw<any>("SELECT id, name, nodeIdsJson FROM proxy_node_subscriptions")).map(rowSubscription);
  return nodes.map((node) => ({ ...node, groupIds: memberships.filter((item) => Number(item.nodeId) === Number(node.id)).map((item) => Number(item.id)), groups: memberships.filter((item) => Number(item.nodeId) === Number(node.id)).map((item) => ({ id: Number(item.id), name: item.name })), configSubscriptionIds: config.filter((item) => item.nodeIds.includes(Number(node.id))).map((item) => Number(item.id)), nodeSubscriptionIds: raw.filter((item) => item.nodeIds.includes(Number(node.id))).map((item) => Number(item.id)) }));
}

export const proxySubscriptionsRouter = router({
  nodes: adminProcedure.query(async () => enrichedNodes()),
  nodePage: adminProcedure.input(z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(10).max(100).default(20), groupId: z.number().int().positive().optional(), search: z.string().trim().max(160).default(""), protocol: z.enum(protocols).optional(), enabled: z.boolean().optional(), sort: z.enum(["name", "createdAt", "updatedAt", "sortOrder"]).default("sortOrder"), direction: z.enum(["asc", "desc"]).default("asc") })).query(async ({ input }) => {
    await syncLegacyGroups();
    const where: string[] = []; const params: any[] = [];
    if (input.groupId) { where.push("EXISTS (SELECT 1 FROM proxy_node_group_members gm WHERE gm.nodeId=proxy_nodes.id AND gm.groupId=?)"); params.push(input.groupId); }
    if (input.protocol) { where.push("protocol=?"); params.push(input.protocol); }
    if (input.enabled !== undefined) { where.push("enabled=?"); params.push(input.enabled); }
    if (input.search) { const like = `%${input.search.toLowerCase()}%`; where.push("(LOWER(name) LIKE ? OR LOWER(link) LIKE ? OR LOWER(COALESCE(server,'')) LIKE ? OR EXISTS (SELECT 1 FROM proxy_node_group_members gm JOIN proxy_node_groups gg ON gg.id=gm.groupId WHERE gm.nodeId=proxy_nodes.id AND LOWER(gg.name) LIKE ?))"); params.push(like, like, like, like); }
    const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const sortColumn = { name: "name", createdAt: "createdAt", updatedAt: "updatedAt", sortOrder: "sortOrder" }[input.sort];
    const direction = input.direction === "desc" ? "DESC" : "ASC";
    const total = Number((await queryRaw<any>(`SELECT COUNT(*) AS count FROM proxy_nodes${filter}`, params))[0]?.count || 0);
    const rows = await queryRaw<any>(`SELECT * FROM proxy_nodes${filter} ORDER BY ${sortColumn} ${direction}, id ${direction} LIMIT ? OFFSET ?`, [...params, input.pageSize, (input.page - 1) * input.pageSize]);
    return { items: await enrichedNodes(rows), total, page: input.page, pageSize: input.pageSize };
  }),
  nodeGroups: adminProcedure.query(async () => {
    await syncLegacyGroups();
    const groups = await queryRaw<any>("SELECT g.*, COUNT(m.id) AS nodeCount FROM proxy_node_groups g LEFT JOIN proxy_node_group_members m ON m.groupId=g.id GROUP BY g.id ORDER BY g.name ASC");
    return groups.map((group) => ({ ...group, nodeCount: Number(group.nodeCount || 0) }));
  }),
  saveNodeGroup: adminProcedure.input(z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(80) })).mutation(async ({ input }) => {
    if (input.id) await executeRaw("UPDATE proxy_node_groups SET name=?, updatedAt=? WHERE id=?", [input.name, now(), input.id]);
    else await executeRaw("INSERT INTO proxy_node_groups (name, createdAt, updatedAt) VALUES (?, ?, ?)", [input.name, now(), now()]);
    const group = (await queryRaw<any>("SELECT id FROM proxy_node_groups WHERE name=? LIMIT 1", [input.name]))[0];
    return { success: true, id: Number(group?.id || input.id || 0) };
  }),
  deleteNodeGroup: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("DELETE FROM proxy_node_group_members WHERE groupId=?", [input.id]); await executeRaw("DELETE FROM proxy_node_groups WHERE id=?", [input.id]); return { success: true }; }),
  nodeIps: adminProcedure.query(async () => queryRaw<any>("SELECT * FROM proxy_node_ips ORDER BY alias ASC, id ASC")),
  saveNodeIp: adminProcedure.input(z.object({ id: z.number().int().positive().optional(), address: z.string().trim().ip({ version: "v4" }).or(z.string().trim().ip({ version: "v6" })), alias: z.string().trim().min(1).max(160) })).mutation(async ({ input }) => { if (input.id) await executeRaw("UPDATE proxy_node_ips SET address=?, alias=?, updatedAt=? WHERE id=?", [input.address, input.alias, now(), input.id]); else await executeRaw("INSERT INTO proxy_node_ips (address, alias, createdAt, updatedAt) VALUES (?, ?, ?, ?)", [input.address, input.alias, now(), now()]); return { success: true }; }),
  deleteNodeIp: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await executeRaw("DELETE FROM proxy_node_ips WHERE id=?", [input.id]); return { success: true }; }),
  saveNode: adminProcedure.input(nodeInput).mutation(async ({ input }) => {
    const endpoint = parseEndpoint(input.link);
    const values = [input.name || endpoint.name || "未命名节点", input.protocol, input.link, input.groupName || null, endpoint.server || null, endpoint.port, input.enabled, now()];
    let nodeId = input.id;
    if (nodeId) await executeRaw("UPDATE proxy_nodes SET name=?, protocol=?, link=?, groupName=?, server=?, port=?, enabled=?, updatedAt=? WHERE id=?", [...values, nodeId]);
    else {
      await executeRaw("INSERT INTO proxy_nodes (name, protocol, link, groupName, server, port, enabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [...values.slice(0, 7), 0, now(), now()]);
      nodeId = Number((await queryRaw<any>("SELECT id FROM proxy_nodes WHERE link=? ORDER BY id DESC LIMIT 1", [input.link]))[0]?.id || 0);
    }
    if (nodeId) await syncNodeRelations(nodeId, input.groupIds, input.configSubscriptionIds, input.nodeSubscriptionIds);
    return { success: true };
  }),
  inspectImportNodes: adminProcedure.input(z.object({ links: z.string().max(200_000), replaceAddress: z.string().ip({ version: "v4" }).or(z.string().ip({ version: "v6" })).optional() })).query(async ({ input }) => {
    const existing = await queryRaw<any>("SELECT id, link FROM proxy_nodes");
    const known = new Set(existing.map((item) => nodeFingerprint(String(item.link))));
    return input.links.split(/\r?\n/).map((raw, index) => {
      const source = raw.trim(); const link = replaceImportServer(source, input.replaceAddress);
      const protocol = link.slice(0, link.indexOf(":")).toLowerCase(); const endpoint = parseEndpoint(link);
      const valid = !!source && (protocols as readonly string[]).includes(protocol) && !!endpoint.server;
      return { line: index + 1, source, protocol, name: endpoint.name, server: endpoint.server, valid, duplicate: valid && known.has(nodeFingerprint(link)), reason: valid ? undefined : "无法识别的节点链接" };
    }).filter((item) => item.source);
  }),
  importNodes: adminProcedure.input(z.object({ links: z.string().min(1).max(200_000), name: z.string().trim().min(1).max(160).optional(), groupIds: positiveIds.optional(), newGroupName: z.string().trim().min(1).max(80).optional(), configSubscriptionIds: positiveIds.optional(), nodeSubscriptionIds: positiveIds.optional(), replaceAddress: z.string().ip({ version: "v4" }).or(z.string().ip({ version: "v6" })).optional(), duplicateStrategy: z.enum(["skip", "replace", "allow"]).default("skip") })).mutation(async ({ input }) => {
    const lines = input.links.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const groupIds = ids(input.groupIds);
    if (input.newGroupName) {
      let group = (await queryRaw<any>("SELECT id FROM proxy_node_groups WHERE name=? LIMIT 1", [input.newGroupName]))[0];
      if (!group) { await executeRaw("INSERT INTO proxy_node_groups (name, createdAt, updatedAt) VALUES (?, ?, ?)", [input.newGroupName, now(), now()]); group = (await queryRaw<any>("SELECT id FROM proxy_node_groups WHERE name=? LIMIT 1", [input.newGroupName]))[0]; }
      if (group?.id) groupIds.push(Number(group.id));
    }
    const existingRows = await queryRaw<any>("SELECT id, link FROM proxy_nodes");
    const existingByFingerprint = new Map(existingRows.map((row) => [nodeFingerprint(String(row.link)), row]));
    let imported = 0, skipped = 0;
    for (const sourceLink of lines) {
      const link = replaceImportServer(sourceLink, input.replaceAddress);
      const protocol = link.slice(0, link.indexOf(":" )).toLowerCase();
      if (!(protocols as readonly string[]).includes(protocol)) { skipped++; continue; }
      const endpoint = parseEndpoint(link);
      const nodeName = input.name && lines.length === 1 ? input.name : endpoint.name || `${protocol.toUpperCase()} 节点`;
      if (!endpoint.server) { skipped++; continue; }
      const existing = existingByFingerprint.get(nodeFingerprint(link));
      if (existing && input.duplicateStrategy === "skip") { skipped++; continue; }
      if (existing && input.duplicateStrategy === "replace") {
        await executeRaw("UPDATE proxy_nodes SET name=?, protocol=?, link=?, server=?, port=?, enabled=?, updatedAt=? WHERE id=?", [nodeName, protocol, link, endpoint.server || null, endpoint.port, true, now(), existing.id]);
        await syncNodeRelations(Number(existing.id), groupIds, input.configSubscriptionIds, input.nodeSubscriptionIds);
        existingByFingerprint.set(nodeFingerprint(link), { ...existing, link });
        imported++; continue;
      }
      await executeRaw("INSERT INTO proxy_nodes (name, protocol, link, server, port, enabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [nodeName, protocol, link, endpoint.server || null, endpoint.port, true, 0, now(), now()]);
      const nodeId = Number((await queryRaw<any>("SELECT id FROM proxy_nodes WHERE link=? ORDER BY id DESC LIMIT 1", [link]))[0]?.id || 0);
      if (nodeId) await syncNodeRelations(nodeId, groupIds, input.configSubscriptionIds, input.nodeSubscriptionIds);
      existingByFingerprint.set(nodeFingerprint(link), { id: nodeId, link });
      imported++;
    }
    return { imported, skipped };
  }),
  deleteNode: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await removeNodeRelations(input.id); await executeRaw("DELETE FROM proxy_nodes WHERE id=?", [input.id]); return { success: true }; }),
  nodeImpact: adminProcedure.input(z.object({ ids: positiveIds })).query(async ({ input }) => {
    const selected = new Set(ids(input.ids));
    const results: { kind: "配置订阅" | "节点订阅"; id: number; name: string }[] = [];
    for (const [table, kind] of [["proxy_subscriptions", "配置订阅"], ["proxy_node_subscriptions", "节点订阅"]] as const) for (const row of await queryRaw<any>(`SELECT id, name, nodeIdsJson FROM ${table}`)) if (ids(JSON.parse(row.nodeIdsJson || "[]")).some((id) => selected.has(id))) results.push({ kind, id: Number(row.id), name: String(row.name) });
    return results;
  }),
  moveNode: adminProcedure.input(z.object({ id: z.number().int().positive(), direction: z.enum(["up", "down"]) })).mutation(async ({ input }) => {
    const rows = await queryRaw<any>("SELECT id FROM proxy_nodes ORDER BY sortOrder ASC, id ASC"); const index = rows.findIndex((row) => Number(row.id) === input.id); const other = rows[index + (input.direction === "up" ? -1 : 1)];
    if (index < 0 || !other) return { moved: false };
    const current = rows[index]; await executeRaw("UPDATE proxy_nodes SET sortOrder=?, updatedAt=? WHERE id=?", [(index + (input.direction === "up" ? -1 : 1)) * 10, now(), current.id]); await executeRaw("UPDATE proxy_nodes SET sortOrder=?, updatedAt=? WHERE id=?", [index * 10, now(), other.id]); return { moved: true };
  }),
  bulkNodes: adminProcedure.input(z.object({ ids: z.array(z.number().int().positive()).min(1).max(10_000), action: z.enum(["enable", "disable", "delete", "sort"]), sortOrder: z.number().int().min(0).optional() })).mutation(async ({ input }) => {
    for (const [index, id] of ids(input.ids).entries()) {
      if (input.action === "delete") { await removeNodeRelations(id); await executeRaw("DELETE FROM proxy_nodes WHERE id=?", [id]); }
      else if (input.action === "sort") await executeRaw("UPDATE proxy_nodes SET sortOrder=?, updatedAt=? WHERE id=?", [Number(input.sortOrder || 0) + index, now(), id]);
      else await executeRaw("UPDATE proxy_nodes SET enabled=?, updatedAt=? WHERE id=?", [input.action === "enable", now(), id]);
    }
    return { success: true };
  }),
  exportNodes: adminProcedure.input(z.object({ ids: positiveIds.optional(), encoding: z.enum(["plain", "base64"]).default("plain") })).query(async ({ input }) => {
    const selected = ids(input.ids); const rows = selected.length ? await queryRaw<any>(`SELECT link FROM proxy_nodes WHERE id IN (${selected.map(() => "?").join(",")}) ORDER BY sortOrder ASC, id ASC`, selected) : await queryRaw<any>("SELECT link FROM proxy_nodes ORDER BY sortOrder ASC, id ASC");
    const text = rows.map((row) => row.link).join("\n") + (rows.length ? "\n" : ""); return { content: input.encoding === "base64" ? Buffer.from(text).toString("base64") : text, count: rows.length };
  }),
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
