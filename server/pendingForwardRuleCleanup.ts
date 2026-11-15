/**
 * A pending-delete rule may already be marked stopped when a tunnel is
 * deleted. Only retire its database record after an Agent has reported a
 * complete runtime snapshot without an owner for the old port/rule.
 *
 * Pending rules must keep reserving their ports until this point: otherwise
 * a newly created listener can race with the old runtime's shutdown.
 */
export function canFinalizeSettledPendingRule(input: {
  pendingDelete: boolean;
  isRunning: boolean;
  ruleId: number;
  sourcePort: number;
  completeRuntimeSnapshot: boolean;
  localRules: Array<{ ruleId?: unknown; port?: unknown }>;
}): boolean {
  if (!input.pendingDelete || input.isRunning || !input.completeRuntimeSnapshot) return false;
  const ruleId = Number(input.ruleId || 0);
  const port = Number(input.sourcePort || 0);
  if (ruleId <= 0 || port <= 0) return false;
  return !input.localRules.some((local) =>
    Number(local.ruleId || 0) === ruleId || Number(local.port || 0) === port
  );
}
