import { randomUUID } from "node:crypto";
import { pushAgentExternalPortCheck } from "./agentEvents";

export type ExternalForwardPort = { port: number; protocol: "tcp" | "udp"; owner: string };
type PendingCheck = {
  hostId: number;
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, PendingCheck>();
const MAX_PENDING = 1024;
const CHECK_TIMEOUT_MS = 8000;

// Responses are accepted only for a request made for this host on this panel process.
export function completeExternalForwardPortCheck(hostId: number, payload: any): boolean {
  const id = typeof payload?.requestId === "string" ? payload.requestId : "";
  const check = pending.get(id);
  if (!check || check.hostId !== hostId) return false;
  pending.delete(id);
  clearTimeout(check.timer);
  if (typeof payload?.error !== "string" || typeof payload?.conflict !== "string") {
    check.resolve("节点端口检查响应无效");
  } else if (payload.error) {
    check.resolve(`节点端口检查失败：${payload.error.slice(0, 160)}`);
  } else if (payload.conflict) {
    check.resolve(`端口已被节点上的外部转发占用：${payload.conflict.slice(0, 160)}`);
  } else {
    check.resolve(null);
  }
  return true;
}

export function requestExternalForwardPortCheck(hostId: number, port: number, protocol: unknown): Promise<string | null> {
  if (!Number.isInteger(hostId) || hostId <= 0 || !Number.isInteger(port) || port < 1 || port > 65535 || !["tcp", "udp", "both"].includes(String(protocol))) {
    return Promise.resolve("节点端口检查参数无效");
  }
  if (pending.size >= MAX_PENDING) return Promise.resolve("节点端口检查繁忙，请稍后重试");
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve("节点端口检查超时，请确认轻量 Agent 已连接面板");
    }, CHECK_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { hostId, resolve, timer });
    if (!pushAgentExternalPortCheck(hostId, { requestId, port, protocol })) {
      pending.delete(requestId);
      clearTimeout(timer);
      resolve("轻量 Agent 实时连接不可用，无法检查节点端口");
    }
  });
}

export async function assertExternalForwardPortAvailable(hostId: number, port: number, protocol: unknown): Promise<void> {
  const { getHostById } = await import("./db");
  const host = await getHostById(hostId);
  if (!String((host as any)?.agentVersion || "").includes("-iptables-only.")) return;
  const conflict = await requestExternalForwardPortCheck(hostId, port, protocol);
  if (conflict) throw new Error(conflict);
}
