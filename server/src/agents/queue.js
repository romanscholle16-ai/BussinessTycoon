// Persistent task queue on top of the Phase 2 `tasks` table. All state changes are compare-and-set updates
// inside IMMEDIATE transactions, so competing workers (threads, processes) cannot claim the same task.
import { assertTaskTransition, InvalidTransitionError, TASK_TERMINAL } from './states.js';
import { ValidationError, assertId, assertInt, assertNoSecrets, assertJsonSize, assertPlainObject } from './validate.js';
import { systemClock } from './registry.js';
import { DEFAULT_RETRY } from './config.js';

const TASK_TYPE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
export const retryDelayMs = (retryCount, { baseDelayMs, maxDelayMs } = DEFAULT_RETRY) => Math.min(maxDelayMs, baseDelayMs * 2 ** retryCount); // deterministic, bounded, no jitter

export class TaskQueue {
  constructor(db, repos, { clock = systemClock, leaseMs = 60000 } = {}) { this.db = db; this.repos = repos; this.clock = clock; this.leaseMs = leaseMs; }
  iso(offsetMs = 0) { return new Date(this.clock.now().getTime() + offsetMs).toISOString(); }
  get(id) { assertId(id, 'taskId'); return this.repos.tasks.get(id); }
  list(filter = {}, opts = {}) { return this.repos.tasks.list(filter, opts); }
  counts() { return Object.fromEntries(this.db.all('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').map((r) => [r.status, r.n])); }

  /** Creates a task in `pending`. Use submit() to also enqueue. */
  create(input) {
    assertPlainObject(input, 'task');
    if (typeof input.type !== 'string' || !TASK_TYPE_RE.test(input.type)) throw new ValidationError('type must look like "demo.noop"', 'type');
    const id = input.id === undefined ? undefined : assertId(input.id, 'id');
    for (const k of ['businessId', 'agentId', 'parentTaskId', 'correlationId']) if (input[k] != null) assertId(input[k], k);
    if (input.businessId && !this.repos.businesses.get(input.businessId)) throw new ValidationError(`unknown business "${input.businessId}"`, 'businessId');
    const priority = assertInt(input.priority ?? 5, 'priority', 0, 10), maxRetries = assertInt(input.maxRetries ?? 3, 'maxRetries', 0, 10);
    const timeoutMs = input.timeoutMs == null ? null : assertInt(input.timeoutMs, 'timeoutMs', 1, 3600000);
    const payload = input.payload ?? {}, metadata = input.metadata ?? {};
    assertNoSecrets(payload, 'payload'); assertNoSecrets(metadata, 'metadata'); assertJsonSize(payload, 'payload'); assertJsonSize(metadata, 'metadata');
    if (input.deadlineAt != null && Number.isNaN(Date.parse(input.deadlineAt))) throw new ValidationError('deadlineAt must be an ISO date', 'deadlineAt');
    return this.db.transaction(() => {
      const row = this.repos.tasks.insert({ id, business_id: input.businessId ?? null, agent_id: input.agentId ?? null, parent_task_id: input.parentTaskId ?? null, correlation_id: input.correlationId ?? null, type: input.type, status: 'pending', priority, payload, metadata, max_retries: maxRetries, timeout_ms: timeoutMs, deadline_at: input.deadlineAt ?? null, data_mode: input.dataMode ?? 'live' });
      this.#event(row, 'task.pending', 'create', { from: null, to: 'pending' });
      return row;
    });
  }
  enqueue(id) { return this.transition(id, 'queued', { expect: 'pending' }); }
  submit(input) { return this.db.transaction(() => this.enqueue(this.create(input).id)); }
  cancel(id, reason = 'cancelled') { const t = this.get(id); if (!t) throw new ValidationError(`task ${id} not found`, 'taskId'); return this.transition(id, 'cancelled', { reason, patch: { completed_at: this.iso(), lease_expires_at: null } }); }
  block(id, reason) { return this.transition(id, 'blocked', { reason, patch: { lease_expires_at: null } }); }
  unblock(id) { return this.transition(id, 'queued', { expect: 'blocked', patch: { agent_id: null } }); }

  /** Generic CAS transition + event. Throws InvalidTransitionError if illegal or if another actor changed the task first. */
  transition(id, to, { expect, reason = null, error = null, patch = {} } = {}) {
    return this.db.transaction(() => {
      const t = this.get(id); if (!t) throw new ValidationError(`task ${id} not found`, 'taskId');
      if (expect && t.status !== expect) throw new InvalidTransitionError('task', t.status, to);
      assertTaskTransition(t.status, to);
      const sets = { status: to, ...patch }, keys = Object.keys(sets);
      if (!keys.every((k) => /^[a-z_]+$/.test(k))) throw new Error('bad column');
      const r = this.db.run(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = ?`, [...keys.map((k) => sets[k]), id, t.status]);
      if (!r.changes) throw new InvalidTransitionError('task', this.get(id).status, to);
      const after = this.get(id);
      this.#event(after, `task.${to}`, reason ?? `transition:${to}`, { from: t.status, to }, error);
      return after;
    });
  }

  /**
   * Atomically picks the best eligible queued task for the agent and assigns it.
   * Eligible: status queued, not waiting on a retry delay, type in agent.config.taskTypes, business matches
   * (shared agents match any), and (unassigned or pre-assigned to this agent). Order: priority (0 first), then oldest.
   */
  claim(agent) {
    const types = agent.config?.taskTypes ?? []; if (!types.length) return null;
    const now = this.iso();
    return this.db.transaction(() => {
      const cand = this.db.get(
        `SELECT id FROM tasks WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND type IN (${types.map(() => '?').join(',')})
           AND (agent_id IS NULL OR agent_id = ?)
           AND (? IS NULL OR business_id IS NULL OR business_id = ?)
         ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1`, [now, ...types, agent.id, agent.business_id, agent.business_id]);
      if (!cand) return null;
      return this.transition(cand.id, 'assigned', { expect: 'queued', reason: `claimed by ${agent.id}`, patch: { agent_id: agent.id, claimed_at: now, lease_expires_at: this.iso(this.leaseMs) } });
    });
  }
  start(taskId, agent, timeoutMs) {
    const now = this.iso(), t = this.get(taskId);
    const limit = t.timeout_ms ?? timeoutMs;
    return this.transition(taskId, 'running', { expect: 'assigned', reason: `started by ${agent.id}`, patch: { started_at: now, timeout_ms: limit, lease_expires_at: this.iso(limit + 5000) } });
  }
  complete(taskId, result) { return this.transition(taskId, 'completed', { expect: 'running', patch: { result_json: result === undefined ? null : JSON.stringify(result), completed_at: this.iso(), lease_expires_at: null, error_code: null, error_message: null } }); }

  /**
   * Records a failed attempt. Retryable failures with attempts left go to `retrying` with a deterministic backoff;
   * everything else is a terminal `failed`. Returns the updated task.
   */
  fail(taskId, { code = 'error', message = '', retryable = false, retry = DEFAULT_RETRY } = {}) {
    const t = this.get(taskId), now = this.iso();
    const canRetry = retryable && t.retry_count < t.max_retries;
    const base = { error_code: code, error_message: String(message).slice(0, 500), lease_expires_at: null };
    if (canRetry) return this.transition(taskId, 'retrying', { error: `${code}: ${message}`, reason: `retry ${t.retry_count + 1}/${t.max_retries}`, patch: { ...base, retry_count: t.retry_count + 1, next_attempt_at: this.iso(retryDelayMs(t.retry_count, retry)), agent_id: null } });
    return this.transition(taskId, 'failed', { error: `${code}: ${message}`, reason: retryable ? 'retries exhausted' : 'non-retryable', patch: { ...base, completed_at: now } });
  }
  /** Puts an assigned/running task back on the queue unchanged (interrupted, shutdown, stale lease). Retry count is NOT consumed. */
  release(taskId, why) { return this.transition(taskId, 'queued', { reason: `released: ${why}`, patch: { agent_id: null, lease_expires_at: null, claimed_at: null, started_at: null } }); }

  /** retrying -> queued once the backoff has elapsed. */
  promoteDueRetries() {
    const due = this.db.all("SELECT id FROM tasks WHERE status = 'retrying' AND next_attempt_at <= ?", [this.iso()]);
    return due.map((r) => this.transition(r.id, 'queued', { expect: 'retrying', reason: 'retry due' }));
  }
  /** Running tasks past started_at + timeout_ms (detection). */
  findTimedOut() {
    const now = this.clock.now().getTime();
    return this.db.all("SELECT id FROM tasks WHERE status = 'running' AND started_at IS NOT NULL AND timeout_ms IS NOT NULL").map((r) => this.get(r.id)).filter((t) => Date.parse(t.started_at) + t.timeout_ms < now);
  }
  /** Fails every timed-out running task with the retryable `timeout` error. */
  handleTimeouts(retryFor = () => DEFAULT_RETRY) {
    return this.findTimedOut().map((t) => this.fail(t.id, { code: 'timeout', message: `exceeded ${t.timeout_ms}ms`, retryable: true, retry: retryFor(t) }));
  }
  /** Assigned tasks whose claim lease expired without starting (worker died between claim and start). */
  findExpiredLeases() { return this.db.all("SELECT id FROM tasks WHERE status = 'assigned' AND lease_expires_at < ?", [this.iso()]).map((r) => this.get(r.id)); }
  releaseExpiredLeases() { return this.findExpiredLeases().map((t) => this.release(t.id, 'lease expired')); }
  /** Not-yet-running tasks past their deadline are cancelled. */
  expireDeadlines() { return this.db.all("SELECT id FROM tasks WHERE status IN ('pending','queued','retrying','blocked') AND deadline_at IS NOT NULL AND deadline_at < ?", [this.iso()]).map((r) => this.transition(r.id, 'cancelled', { reason: 'deadline exceeded', error: 'deadline_exceeded', patch: { error_code: 'deadline_exceeded', completed_at: this.iso() } })); }
  /** Extends the lease of a task a live worker still owns. */
  renewLease(taskId, ms = this.leaseMs) { return this.db.run("UPDATE tasks SET lease_expires_at = ? WHERE id = ? AND status IN ('assigned','running')", [this.iso(ms), taskId]).changes === 1; }

  #event(t, type, action, meta, error = null) {
    this.repos.events.insert({ ts: this.iso(), type, severity: type === 'task.failed' ? 'error' : 'info', business_id: t.business_id, agent_id: t.agent_id, task_id: t.id, action, result: type.split('.')[1], error, metadata: { ...meta, priority: t.priority, retry_count: t.retry_count }, data_mode: t.data_mode });
  }
}
export { TASK_TERMINAL };
