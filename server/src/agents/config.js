// Agent definition validation. Definitions contain no secrets; provider preferences are names only.
import { ValidationError, assertId, assertInt, assertNoSecrets, assertJsonSize, assertPlainObject } from './validate.js';
import { normalizePermissions } from './capabilities.js';

export const ROLES = ['Research', 'Opportunity', 'Strategy', 'Creation', 'QA', 'Publishing', 'Analytics', 'Optimization', 'Financial', 'Recovery', 'Safety', 'Supervisor'];
export const DEFAULT_LIMITS = { maxConcurrentTasks: 1, timeoutMs: 30000, maxRetries: 3 };
export const DEFAULT_RUNTIME = { heartbeatIntervalMs: 5000, staleAfterMs: 30000 };
export const DEFAULT_RETRY = { baseDelayMs: 1000, maxDelayMs: 60000 };

/** @returns normalized {id,name,role,businessId,permissions,config} ready for persistence */
export function normalizeAgentDefinition(def) {
  assertPlainObject(def, 'definition'); assertNoSecrets(def, 'definition'); assertJsonSize(def, 'definition');
  const id = def.id === undefined ? undefined : assertId(def.id, 'id');
  if (typeof def.name !== 'string' || !def.name.trim() || def.name.length > 80) throw new ValidationError('name must be 1-80 characters', 'name');
  if (!ROLES.includes(def.role)) throw new ValidationError(`role must be one of ${ROLES.join(', ')}`, 'role');
  const businessId = def.businessId == null ? null : assertId(def.businessId, 'businessId');
  const limits = { ...DEFAULT_LIMITS, ...(def.limits ?? {}) }, runtime = { ...DEFAULT_RUNTIME, ...(def.runtime ?? {}) }, retry = { ...DEFAULT_RETRY, ...(def.retry ?? {}) };
  assertInt(limits.maxConcurrentTasks, 'limits.maxConcurrentTasks', 1, 1); // one task per agent in Phase 3
  assertInt(limits.timeoutMs, 'limits.timeoutMs', 1, 3600000); assertInt(limits.maxRetries, 'limits.maxRetries', 0, 10);
  assertInt(runtime.heartbeatIntervalMs, 'runtime.heartbeatIntervalMs', 10, 600000); assertInt(runtime.staleAfterMs, 'runtime.staleAfterMs', 10, 3600000);
  assertInt(retry.baseDelayMs, 'retry.baseDelayMs', 0, 3600000); assertInt(retry.maxDelayMs, 'retry.maxDelayMs', 0, 86400000);
  const taskTypes = [...new Set(def.taskTypes ?? [])];
  if (!taskTypes.length) throw new ValidationError('taskTypes must list at least one task type', 'taskTypes');
  taskTypes.forEach((t) => { if (typeof t !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(t)) throw new ValidationError(`invalid task type "${t}"`, 'taskTypes'); });
  const providers = (def.providerPreferences ?? []).map((p) => assertId(p, 'providerPreferences'));
  return { id, name: def.name.trim(), role: def.role, businessId, permissions: normalizePermissions(def.permissions, businessId), config: { taskTypes, limits, runtime, retry, providerPreferences: providers, settings: def.settings ?? {} } };
}
