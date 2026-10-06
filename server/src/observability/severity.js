// Event severity model. Storage keeps the Phase 2 value 'warn'; the public name is 'warning'.
//
// Rules (deterministic; producers choose by these definitions):
//   debug     internal diagnostics that never need attention (e.g. a dispatch claim that lost a race). Rare; never per-cycle.
//   info      normal lifecycle and activity: state changes, task queued/assigned/running/completed/cancelled, dispatches.
//   warning   abnormal but the system keeps working: retry scheduled, task released after an interruption, agent restarted
//             by recovery, limit reached, task nobody can run, previous run ended uncleanly.
//   error     an operation could not complete: a task failed terminally, an agent failed, dispatch/cycle/recovery failed,
//             recovery refused (escalation). An ordinary task failure is an ERROR, never critical.
//   critical  continued autonomous operation or integrity is threatened: the Supervisor entered `failed`, lock lost.
export const SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical'];
const STORED = { debug: 'debug', info: 'info', warning: 'warn', warn: 'warn', error: 'error', critical: 'critical' };
const PUBLIC = { debug: 'debug', info: 'info', warn: 'warning', error: 'error', critical: 'critical' };
export const toStored = (s) => STORED[s] ?? null;
export const toPublic = (s) => PUBLIC[s] ?? 'info';
export const rank = (s) => SEVERITIES.indexOf(toPublic(STORED[s] ?? s));
/** Stored severities at or above the given level. */
export const storedAtLeast = (level) => SEVERITIES.slice(SEVERITIES.indexOf(level)).map(toStored);
