// Persist data, never shell commands. A listener edit must not replay cleanup
// against another host/port/backend. Rebuild commands with the normal builder.
type SwitchRule = { hostId: number; sourcePort: number; forwardType: string; protocol: string; targetIp: string; targetPort: number };
export type PendingLandingSwitch = { listener: string; from: string; port: number; to: string; toPort: number; issuedAt: number };
const listener = (r: SwitchRule) => JSON.stringify([r.hostId, r.sourcePort, r.forwardType, r.protocol]);
export function makePendingSwitch(rule: SwitchRule, from: string, port: number, to: string, toPort: number, issuedAt: number): PendingLandingSwitch {
  return { listener: listener(rule), from, port, to, toPort, issuedAt };
}
export function readPendingSwitch(rule: SwitchRule & { landingSwitchPending?: string | null }): PendingLandingSwitch | null {
  if (!rule.landingSwitchPending) return null;
  let p: PendingLandingSwitch;
  try { p = JSON.parse(rule.landingSwitchPending); } catch { return null; }
  return p?.listener === listener(rule) && p.to === rule.targetIp && p.toPort === rule.targetPort
    && typeof p.from === "string" && /^[a-zA-Z0-9_.:\[\]-]+$/.test(p.from)
    && Number.isInteger(p.port) && p.port > 0 && p.port <= 65535 && Number.isSafeInteger(p.issuedAt) && p.issuedAt > 0 ? p : null;
}
