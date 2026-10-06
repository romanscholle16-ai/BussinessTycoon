// Supervisor lifecycle. stopped -> starting -> running <-> paused; stopping -> stopped; failed -> starting (explicit restart) | stopped.
import { InvalidTransitionError } from '../agents/states.js';
export const SUPERVISOR_STATES = ['stopped', 'starting', 'running', 'paused', 'stopping', 'failed'];
const T = { stopped: ['starting'], starting: ['running', 'failed', 'stopped'], running: ['paused', 'stopping', 'failed'], paused: ['running', 'stopping', 'failed'], stopping: ['stopped', 'failed'], failed: ['starting', 'stopped'] };
export const SUPERVISOR_TRANSITIONS = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, new Set(v)]));
export function assertSupervisorTransition(from, to) { if (!SUPERVISOR_TRANSITIONS[from]?.has(to)) throw new InvalidTransitionError('supervisor', from, to); }
