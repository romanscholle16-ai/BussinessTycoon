// Supervisor configuration: defaults + validation. Local and explicit; no money, no secrets.
import { ValidationError, assertInt } from '../agents/validate.js';

export const DEFAULTS = {
  enabled: true, autoStart: true, pollMs: 1000, lockTtlMs: 15000, checkpointIntervalMs: 5000, maxConsecutiveCycleFailures: 3,
  limits: { maxConcurrentTasks: 3, maxDispatchPerCycle: 5, maxTasksPerAgent: 1, maxRetryDispatchPerCycle: 2, maxEstimatedCostPerCycleMinor: null },
  scheduling: { agingStepMs: 60000, maxAgingBoost: 10, maxCandidates: 100 },
  recovery: { maxAgentRecoveries: 3, windowMs: 600000, orphanGraceMs: 1000 },
};

export function normalizeSupervisorConfig(input = {}) {
  const c = { ...DEFAULTS, ...input, limits: { ...DEFAULTS.limits, ...(input.limits ?? {}) }, scheduling: { ...DEFAULTS.scheduling, ...(input.scheduling ?? {}) }, recovery: { ...DEFAULTS.recovery, ...(input.recovery ?? {}) } };
  assertInt(c.pollMs, 'pollMs', 10, 3600000); assertInt(c.lockTtlMs, 'lockTtlMs', 100, 3600000); assertInt(c.checkpointIntervalMs, 'checkpointIntervalMs', 0, 3600000); assertInt(c.maxConsecutiveCycleFailures, 'maxConsecutiveCycleFailures', 1, 100);
  assertInt(c.limits.maxConcurrentTasks, 'limits.maxConcurrentTasks', 1, 100); assertInt(c.limits.maxDispatchPerCycle, 'limits.maxDispatchPerCycle', 1, 100);
  if (c.limits.maxTasksPerAgent !== 1) throw new ValidationError('limits.maxTasksPerAgent must be 1 (Agent OS runs one task per agent)', 'limits.maxTasksPerAgent');
  assertInt(c.limits.maxRetryDispatchPerCycle, 'limits.maxRetryDispatchPerCycle', 0, 100);
  if (c.limits.maxEstimatedCostPerCycleMinor !== null) assertInt(c.limits.maxEstimatedCostPerCycleMinor, 'limits.maxEstimatedCostPerCycleMinor', 0, 1e9);
  assertInt(c.scheduling.agingStepMs, 'scheduling.agingStepMs', 1, 86400000); assertInt(c.scheduling.maxAgingBoost, 'scheduling.maxAgingBoost', 0, 10); assertInt(c.scheduling.maxCandidates, 'scheduling.maxCandidates', 1, 1000);
  assertInt(c.recovery.maxAgentRecoveries, 'recovery.maxAgentRecoveries', 1, 100); assertInt(c.recovery.windowMs, 'recovery.windowMs', 1, 86400000); assertInt(c.recovery.orphanGraceMs, 'recovery.orphanGraceMs', 0, 3600000);
  return c;
}
