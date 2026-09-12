import { executeRaw, getDatabaseKind, insertAndGetId, queryRaw } from "../dbRuntime";
import { epochSeconds, quoteIdentifier } from "../dbCompat";

const q = quoteIdentifier;
const now = () => Math.floor(Date.now() / 1000);

export type FullChainCreate = {
  userId: number; name: string; port: number; protocol: "tcp" | "both";
  ssProtocol: "ss" | "ss2022"; method: string; password: string;
  allowPublicIntermediate: boolean; nodes: { hostId: number; ingressIp?: string | null }[];
};

export async function createFullChain(input: FullChainCreate) {
  const id = await insertAndGetId("full_chains", {
    userId: input.userId, name: input.name, port: input.port, protocol: input.protocol,
    ssProtocol: input.ssProtocol, method: input.method, password: input.password,
    allowPublicIntermediate: input.allowPublicIntermediate, status: "draft", isEnabled: true,
  });
  for (const [sortOrder, node] of input.nodes.entries()) {
    await insertAndGetId("full_chain_nodes", { chainId: id, hostId: node.hostId, sortOrder, ingressIp: node.ingressIp || null, portStatus: "pending", protocolStatus: "pending", deployStatus: "pending", latencyStatus: "pending" });
  }
  return id;
}

export async function getFullChainById(id: number) {
  const rows = await queryRaw<any>(`SELECT * FROM ${q("full_chains")} WHERE ${q("id")} = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

export async function getFullChainNodes(chainId: number) {
  return queryRaw<any>(`SELECT n.*, h.${q("name")} AS ${q("hostName")}, COALESCE(h.${q("entryIp")}, h.${q("ipv4")}, h.${q("ip")}) AS ${q("publicIp")}, h.${q("isOnline")} AS ${q("hostOnline")}
    FROM ${q("full_chain_nodes")} n LEFT JOIN ${q("hosts")} h ON h.${q("id")} = n.${q("hostId")}
    WHERE n.${q("chainId")} = ? ORDER BY n.${q("sortOrder")} ASC`, [chainId]);
}

export async function listFullChains(userId?: number) {
  const where = userId ? `WHERE c.${q("userId")} = ?` : "";
  const chains = await queryRaw<any>(`SELECT c.* FROM ${q("full_chains")} c ${where} ORDER BY c.${q("createdAt")} DESC, c.${q("id")} DESC`, userId ? [userId] : []);
  const traffic = await getFullChainTrafficSummaries(chains.map((chain) => Number(chain.id)));
  return Promise.all(chains.map(async (chain) => ({ ...chain, nodes: await getFullChainNodes(Number(chain.id)), traffic: traffic.get(Number(chain.id)) || emptyTraffic() })));
}

const emptyTraffic = () => ({ bytesIn24h: 0, bytesOut24h: 0, connections24h: 0, bytesInTotal: 0, bytesOutTotal: 0, connectionsTotal: 0 });

async function getFullChainTrafficSummaries(ids: number[]) {
  const result = new Map<number, ReturnType<typeof emptyTraffic>>();
  if (!ids.length) return result;
  const marks = ids.map(() => "?").join(",");
  const cutoff = now() - 24 * 3600;
  const rows = await queryRaw<any>(`SELECT ${q("chainId")} chainId, SUM(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("bytesIn")} ELSE 0 END) bytesIn24h, SUM(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("bytesOut")} ELSE 0 END) bytesOut24h, SUM(CASE WHEN ${q("recordedAt")} >= ? THEN ${q("connections")} ELSE 0 END) connections24h, SUM(${q("bytesIn")}) bytesInTotal, SUM(${q("bytesOut")}) bytesOutTotal, SUM(${q("connections")}) connectionsTotal FROM ${q("full_chain_traffic_stats")} WHERE ${q("chainId")} IN (${marks}) GROUP BY ${q("chainId")}`, [cutoff, cutoff, cutoff, ...ids]);
  for (const row of rows) result.set(Number(row.chainId), { bytesIn24h: Number(row.bytesIn24h || 0), bytesOut24h: Number(row.bytesOut24h || 0), connections24h: Number(row.connections24h || 0), bytesInTotal: Number(row.bytesInTotal || 0), bytesOutTotal: Number(row.bytesOutTotal || 0), connectionsTotal: Number(row.connectionsTotal || 0) });
  return result;
}

export async function recordFullChainTraffic(items: Array<{ serviceId: number; hostId: number; userId: number; bytesIn: number; bytesOut: number; connections: number }>) {
  const at = epochSeconds(new Date());
  for (const item of items) {
    const chains = await queryRaw<any>(`SELECT ${q("id")} id FROM ${q("full_chains")} WHERE ${q("landingServiceId")} = ?`, [item.serviceId]);
    for (const chain of chains) {
      const chainId = Number(chain.id);
      await executeRaw(`INSERT INTO ${q("full_chain_traffic_stats")} (${q("chainId")},${q("hostId")},${q("bytesIn")},${q("bytesOut")},${q("connections")},${q("recordedAt")}) VALUES (?,?,?,?,?,?)`, [chainId, item.hostId, item.bytesIn, item.bytesOut, item.connections, at]);
      const suffix = getDatabaseKind() === "mysql" ? `ON DUPLICATE KEY UPDATE ${q("bytesIn")}=${q("bytesIn")}+VALUES(${q("bytesIn")}),${q("bytesOut")}=${q("bytesOut")}+VALUES(${q("bytesOut")}),${q("connections")}=${q("connections")}+VALUES(${q("connections")}),${q("updatedAt")}=VALUES(${q("updatedAt")})` : `ON CONFLICT (${q("chainId")},${q("hostId")}) DO UPDATE SET ${q("bytesIn")}=${q("full_chain_traffic_counters")}.${q("bytesIn")}+excluded.${q("bytesIn")},${q("bytesOut")}=${q("full_chain_traffic_counters")}.${q("bytesOut")}+excluded.${q("bytesOut")},${q("connections")}=${q("full_chain_traffic_counters")}.${q("connections")}+excluded.${q("connections")},${q("updatedAt")}=excluded.${q("updatedAt")}`;
      await executeRaw(`INSERT INTO ${q("full_chain_traffic_counters")} (${q("chainId")},${q("hostId")},${q("userId")},${q("bytesIn")},${q("bytesOut")},${q("connections")},${q("updatedAt")}) VALUES (?,?,?,?,?,?,?) ${suffix}`, [chainId, item.hostId, item.userId, item.bytesIn, item.bytesOut, item.connections, at]);
    }
  }
}

export async function resetFullChainHistoryForLandingService(serviceId: number) {
  const chains = await queryRaw<any>(`SELECT ${q("id")} id FROM ${q("full_chains")} WHERE ${q("landingServiceId")} = ?`, [serviceId]);
  for (const chain of chains) {
    const chainId = Number(chain.id);
    await executeRaw(`DELETE FROM ${q("full_chain_latency_stats")} WHERE ${q("chainId")} = ?`, [chainId]);
    await executeRaw(`DELETE FROM ${q("full_chain_traffic_stats")} WHERE ${q("chainId")} = ?`, [chainId]);
    await executeRaw(`DELETE FROM ${q("full_chain_traffic_counters")} WHERE ${q("chainId")} = ?`, [chainId]);
  }
  return { chainIds: chains.map((chain) => Number(chain.id)) };
}

export async function updateFullChain(id: number, patch: Record<string, any>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await executeRaw(`UPDATE ${q("full_chains")} SET ${keys.map((key) => `${q(key)} = ?`).join(", ")}, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`, [...keys.map((key) => patch[key]), now(), id]);
}

export async function updateFullChainNode(id: number, patch: Record<string, any>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await executeRaw(`UPDATE ${q("full_chain_nodes")} SET ${keys.map((key) => `${q(key)} = ?`).join(", ")}, ${q("updatedAt")} = ? WHERE ${q("id")} = ?`, [...keys.map((key) => patch[key]), now(), id]);
}

export async function replaceFullChainConfig(id: number, input: FullChainCreate) {
  await executeRaw(`DELETE FROM ${q("full_chain_nodes")} WHERE ${q("chainId")} = ?`, [id]);
  await updateFullChain(id, {
    name: input.name, port: input.port, protocol: input.protocol, ssProtocol: input.ssProtocol,
    method: input.method, password: input.password, allowPublicIntermediate: input.allowPublicIntermediate,
    landingServiceId: null, latestLatencyMs: null, isEnabled: true, status: "draft", statusMessage: "配置已保存，等待重新检查",
  });
  for (const [sortOrder, node] of input.nodes.entries()) {
    await insertAndGetId("full_chain_nodes", { chainId: id, hostId: node.hostId, sortOrder, ingressIp: node.ingressIp || null, portStatus: "pending", protocolStatus: "pending", deployStatus: "pending", latencyStatus: "pending" });
  }
}

export async function recordFullChainLatency(chainId: number, latencyMs: number | null, details: unknown) {
  await insertAndGetId("full_chain_latency_stats", { chainId, latencyMs, isTimeout: latencyMs === null, details: JSON.stringify(details) });
}

export async function getFullChainLatencySeries(chainId: number, hours: number) {
  return queryRaw<any>(`SELECT * FROM ${q("full_chain_latency_stats")} WHERE ${q("chainId")} = ? AND ${q("recordedAt")} >= ? ORDER BY ${q("recordedAt")} ASC`, [chainId, now() - hours * 3600]);
}

export async function getFullChainRuntimeTasks(hostId: number) {
  return queryRaw<any>(`SELECT n.*, c.${q("port")} AS ${q("chainPort")}, c.${q("protocol")} AS ${q("chainProtocol")}
    FROM ${q("full_chain_nodes")} n JOIN ${q("full_chains")} c ON c.${q("id")} = n.${q("chainId")}
    WHERE n.${q("hostId")} = ? AND ((c.${q("isEnabled")} = ? AND (n.${q("portStatus")} = 'checking' OR n.${q("protocolStatus")} = 'checking' OR n.${q("latencyStatus")} = 'checking' OR n.${q("firewallStatus")} = 'checking')) OR n.${q("firewallStatus")} = 'removing')`, [hostId, true]);
}

export async function getFullChainNodeByRuleId(ruleId: number) {
  const rows = await queryRaw<any>(`SELECT * FROM ${q("full_chain_nodes")} WHERE ${q("generatedRuleId")} = ? LIMIT 1`, [ruleId]);
  return rows[0] || null;
}

export async function deleteFullChain(id: number) {
  await executeRaw(`DELETE FROM ${q("full_chain_latency_stats")} WHERE ${q("chainId")} = ?`, [id]);
  await executeRaw(`DELETE FROM ${q("full_chain_traffic_stats")} WHERE ${q("chainId")} = ?`, [id]);
  await executeRaw(`DELETE FROM ${q("full_chain_traffic_counters")} WHERE ${q("chainId")} = ?`, [id]);
  await executeRaw(`DELETE FROM ${q("full_chain_nodes")} WHERE ${q("chainId")} = ?`, [id]);
  await executeRaw(`DELETE FROM ${q("full_chains")} WHERE ${q("id")} = ?`, [id]);
}
