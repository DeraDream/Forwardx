import { eq } from "drizzle-orm";
import { hosts } from "../drizzle/schema";
import { getDb } from "./dbRuntime";
import { agentProbePortForHost } from "../shared/agentProbe";

export type SystemReservedPort = {
  kind: "agent-probe";
  hostId: number;
  port: number;
  message: string;
};

export async function getSystemReservedPortsForHost(hostIdValue: number): Promise<SystemReservedPort[]> {
  const hostId = Math.floor(Number(hostIdValue));
  if (!Number.isInteger(hostId) || hostId <= 0) return [];
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ agentProbePort: hosts.agentProbePort }).from(hosts).where(eq(hosts.id, hostId)).limit(1);
  if (!rows[0]) return [];
  const probePort = agentProbePortForHost(rows[0]);
  return [{
    kind: "agent-probe",
    hostId,
    port: probePort,
    message: `端口 ${probePort} 为 ForwardX Agent 探测端口，不能用于转发、隧道或落地服务`,
  }];
}

export async function getSystemReservedPort(hostIdValue: number, portValue: number): Promise<SystemReservedPort | null> {
  const hostId = Math.floor(Number(hostIdValue));
  const port = Math.floor(Number(portValue));
  if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const probePort = (await getSystemReservedPortsForHost(hostId))[0]?.port;
  if (port !== probePort) return null;
  return {
    kind: "agent-probe",
    hostId,
    port,
    message: `端口 ${port} 为 ForwardX Agent 探测端口，不能用于转发、隧道或落地服务`,
  };
}

export async function isSystemReservedPort(hostId: number, port: number) {
  return !!await getSystemReservedPort(hostId, port);
}

export async function assertPortNotSystemReserved(hostId: number, port: number) {
  const reserved = await getSystemReservedPort(hostId, port);
  if (reserved) throw new Error(reserved.message);
}
