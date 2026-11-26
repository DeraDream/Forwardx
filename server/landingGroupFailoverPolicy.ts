export type LandingCandidate = { serviceId: number; healthy: boolean | null };
export type LandingGroupHealth = {
  activeServiceId: number | null;
  activeUnhealthySince: Date | null;
  primaryHealthySince: Date | null;
  recoveryServiceId: number | null;
};

// Only confirmed healthy members can become active. Unknown health never
// triggers a switch, and a confirmed failure must persist for 60 seconds.
export function nextLandingGroupHealth(
  state: LandingGroupHealth,
  candidates: LandingCandidate[],
  now = Date.now(),
): LandingGroupHealth {
  const current = candidates.find(item => item.serviceId === state.activeServiceId);
  const firstHealthy = candidates.find(item => item.healthy === true);
  const since = (value: Date | null) => value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() <= now ? value.getTime() : null;
  const clear = (serviceId: number | null): LandingGroupHealth => ({ activeServiceId: serviceId, activeUnhealthySince: null, primaryHealthySince: null, recoveryServiceId: null });
  if (!current) return clear(firstHealthy?.serviceId ?? null);
  if (current.healthy !== true) {
    const failureAt = current.healthy === false ? since(state.activeUnhealthySince) ?? now : null;
    if (failureAt !== null && now - failureAt >= 60_000 && firstHealthy && firstHealthy.serviceId !== current.serviceId) return clear(firstHealthy.serviceId);
    return { ...clear(current.serviceId), activeUnhealthySince: failureAt === null ? null : new Date(failureAt) };
  }
  const index = candidates.indexOf(current);
  const preferred = candidates.slice(0, index).find(item => item.healthy === true);
  if (!preferred) return clear(current.serviceId);
  // Recovery belongs to a specific candidate; another higher-priority
  // member must earn its own full healthy window.
  const recoveryAt = state.recoveryServiceId === preferred.serviceId ? since(state.primaryHealthySince) ?? now : now;
  if (now - recoveryAt >= 120_000) return clear(preferred.serviceId);
  return { ...clear(current.serviceId), primaryHealthySince: new Date(recoveryAt), recoveryServiceId: preferred.serviceId };
}
