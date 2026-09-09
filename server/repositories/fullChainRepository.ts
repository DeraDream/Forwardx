import { executeRaw, insertAndGetId, queryRaw } from "../dbRuntime";
import { quoteIdentifier } from "../dbCompat";

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
  return Promise.all(chains.map(async (chain) => ({ ...chain, nodes: await getFullChainNodes(Number(chain.id)) })));
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
  await executeRaw(`DELETE FROM ${q("full_chain_nodes")} WHERE ${q("chainId")} = ?`, [id]);
  await executeRaw(`DELETE FROM ${q("full_chains")} WHERE ${q("id")} = ?`, [id]);
}
