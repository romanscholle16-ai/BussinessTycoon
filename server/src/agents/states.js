// Explicit state machines for agents and tasks. Every state change in the Agent OS goes through these tables.
export class InvalidTransitionError extends Error {
  constructor(kind, from, to) { super(`Invalid ${kind} transition: ${from} -> ${to}`); this.name = 'InvalidTransitionError'; this.code = 'invalid_transition'; this.kind = kind; this.from = from; this.to = to; }
}
const table = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, new Set(v)]));

/** created -> ready -> running <-> ready; pause/block are reversible; stopping -> stopped -> ready (restart); failed -> stopped; retired is final. */
export const AGENT_STATES = ['created', 'ready', 'running', 'paused', 'blocked', 'stopping', 'stopped', 'failed', 'retired'];
export const AGENT_TRANSITIONS = table({
  created: ['ready', 'retired'],
  ready: ['running', 'paused', 'blocked', 'stopping', 'failed'],
  running: ['ready', 'paused', 'blocked', 'stopping', 'failed'],
  paused: ['ready', 'stopping', 'failed', 'retired'],
  blocked: ['ready', 'paused', 'stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['ready', 'retired'],
  failed: ['stopped', 'retired'],
  retired: [],
});

/** pending -> queued -> assigned -> running -> completed | failed | retrying(-> queued) | cancelled; blocked parks a task; running/assigned -> queued = interrupted/released. */
export const TASK_STATES = ['pending', 'queued', 'assigned', 'running', 'completed', 'failed', 'retrying', 'cancelled', 'blocked'];
export const TASK_TRANSITIONS = table({
  pending: ['queued', 'blocked', 'cancelled'],
  queued: ['assigned', 'blocked', 'cancelled'],
  assigned: ['running', 'queued', 'cancelled', 'failed'],
  running: ['completed', 'failed', 'retrying', 'cancelled', 'blocked', 'queued'],
  retrying: ['queued', 'cancelled'],
  blocked: ['queued', 'pending', 'cancelled'],
  completed: [], failed: [], cancelled: [],
});
export const TASK_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export const canAgent = (from, to) => !!AGENT_TRANSITIONS[from]?.has(to);
export const canTask = (from, to) => !!TASK_TRANSITIONS[from]?.has(to);
export function assertAgentTransition(from, to) { if (!canAgent(from, to)) throw new InvalidTransitionError('agent', from, to); }
export function assertTaskTransition(from, to) { if (!canTask(from, to)) throw new InvalidTransitionError('task', from, to); }
