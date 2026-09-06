import crypto from "crypto";

type Check = { id: string; hostId: number; port: number; createdAt: number; completedAt?: number; available?: boolean; message?: string };
const checks = new Map<string, Check>();

function prune(now = Date.now()) {
  for (const [id, check] of checks) if (now - check.createdAt > 5 * 60_000) checks.delete(id);
}

export function requestLandingPortCheck(hostId: number, port: number) {
  prune();
  const id = crypto.randomUUID();
  checks.set(id, { id, hostId, port, createdAt: Date.now() });
  return checks.get(id)!;
}

export function takeLandingPortChecks(hostId: number) {
  prune();
  return [...checks.values()].filter((check) => check.hostId === hostId && !check.completedAt);
}

export function completeLandingPortCheck(hostId: number, id: string, available: boolean, message = "") {
  const check = checks.get(id);
  if (!check || check.hostId !== hostId) return null;
  check.completedAt = Date.now(); check.available = available; check.message = message;
  return check;
}

export function getLandingPortCheck(id: string) { prune(); return checks.get(id) || null; }
