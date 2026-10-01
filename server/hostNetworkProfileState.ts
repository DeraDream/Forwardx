import * as db from "./db";

export type NetworkProfileFamily = "ipv4" | "ipv6";
export type NetworkProfileMode = "quick" | "full";
export type NetworkProfileStageStatus = "pending" | "running" | "success" | "error" | "skip";

export type HostNetworkProfileSnapshot = {
  taskId: string;
  hostId: number;
  family: NetworkProfileFamily;
  mode: NetworkProfileMode;
  status: "running" | "success" | "error";
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  error?: string | null;
  steps: Record<string, {
    status: NetworkProfileStageStatus;
    updatedAt: string;
    message?: string | null;
  }>;
  data: Record<string, any>;
};

const active = new Map<string, HostNetworkProfileSnapshot>();

function profileKey(hostId: number, family: NetworkProfileFamily) {
  return `host-network-profile:${hostId}:${family}`;
}
function activeKey(hostId: number, family: NetworkProfileFamily) {
  return `${hostId}:${family}`;
}
function nowIso() {
  return new Date().toISOString();
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export async function getPersistedHostNetworkProfile(hostId: number, family: NetworkProfileFamily) {
  const raw = await db.getSetting(profileKey(hostId, family));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostNetworkProfileSnapshot;
  } catch {
    return null;
  }
}

export function getActiveHostNetworkProfile(hostId: number, family: NetworkProfileFamily) {
  const value = active.get(activeKey(hostId, family));
  return value ? clone(value) : null;
}

export function startHostNetworkProfileTask(input: {
  hostId: number;
  family: NetworkProfileFamily;
  mode: NetworkProfileMode;
}) {
  const taskId = `network-profile-${input.hostId}-${input.family}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = nowIso();
  const snapshot: HostNetworkProfileSnapshot = {
    taskId,
    hostId: input.hostId,
    family: input.family,
    mode: input.mode,
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    steps: {
      ip: { status: "pending", updatedAt: now },
      identity: { status: "pending", updatedAt: now },
      network: { status: "pending", updatedAt: now },
      risk: { status: "pending", updatedAt: now },
      unlock: { status: "pending", updatedAt: now },
      mail: { status: "pending", updatedAt: now },
    },
    data: { apps: {} },
  };
  active.set(activeKey(input.hostId, input.family), snapshot);
  return clone(snapshot);
}

export async function reportHostNetworkProfile(input: {
  hostId: number;
  taskId: string;
  family: NetworkProfileFamily;
  stage: string;
  status: NetworkProfileStageStatus;
  data?: any;
  message?: string | null;
  completed?: boolean;
  failed?: boolean;
}) {
  const key = activeKey(input.hostId, input.family);
  const current = active.get(key);
  if (!current || current.taskId !== input.taskId) return false;

  const now = nowIso();
  current.updatedAt = now;
  current.steps[input.stage] = {
    status: input.status,
    updatedAt: now,
    message: input.message || null,
  };

  if (input.data !== undefined) {
    if (input.stage.startsWith("app:")) {
      const appId = input.stage.slice(4);
      current.data.apps = { ...(current.data.apps || {}), [appId]: input.data };
    } else {
      current.data[input.stage] = input.data;
    }
  }

  if (input.completed) {
    current.status = input.failed ? "error" : "success";
    current.completedAt = now;
    current.error = input.failed ? (input.message || "检测失败") : null;
    if (!input.failed) {
      for (const [name, step] of Object.entries(current.steps)) {
        if (step.status === "pending" || step.status === "running") {
          current.steps[name] = { ...step, status: "skip", updatedAt: now };
        }
      }
    }
    await db.setSetting(profileKey(input.hostId, input.family), JSON.stringify(current));
  }

  active.set(key, current);
  return true;
}

export async function hostNetworkProfileView(hostId: number, family: NetworkProfileFamily) {
  const running = getActiveHostNetworkProfile(hostId, family);
  const persisted = await getPersistedHostNetworkProfile(hostId, family);
  return { running, persisted };
}
