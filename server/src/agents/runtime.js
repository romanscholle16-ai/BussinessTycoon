// AgentRuntime: drives ONE persisted agent through its lifecycle and executes claimed tasks via pluggable handlers.
import { assertCan, PermissionError } from './capabilities.js';
import { TaskError } from './handlers.js';
import { InvalidTransitionError } from './states.js';

const ACTIVE = ['ready', 'running', 'paused', 'blocked'];
export class AgentRuntime {
  constructor(os, agentId) { this.os = os; this.id = agentId; this.running = null; this.hbTimer = null; }
  get agent() { return this.os.registry.get(this.id); }
  get #reg() { return this.os.registry; }

  async start() { const a = this.agent; this.#reg.transition(this.id, 'ready', { reason: a.status === 'stopped' ? 'restart' : 'start' }); this.#checkpoint(); return this.agent; }
  pause(reason = 'paused') { const r = this.#reg.transition(this.id, 'paused', { reason }); this.#checkpoint(); return r; }
  resume() { const r = this.#reg.transition(this.id, 'ready', { reason: 'resume', extra: {} }); this.#checkpoint(); return r; }
  block(reason) { const r = this.#reg.transition(this.id, 'blocked', { reason }); this.#checkpoint(); return r; }
  unblock() { return this.resume(); }
  heartbeat(health) { if (!ACTIVE.includes(this.agent.status)) return this.agent; const a = this.#reg.heartbeat(this.id, { health }); this.#checkpoint(); return a; }

  /** Graceful stop: stopping -> abort in-flight work -> wait up to graceMs -> release any unfinished task -> stopped. */
  async stop({ graceMs = 2000 } = {}) {
    const a = this.agent;
    if (['stopped', 'retired', 'created'].includes(a.status)) return a;
    if (a.status === 'failed') return this.#reg.transition(this.id, 'stopped', { reason: 'acknowledge failure' });
    this.#reg.transition(this.id, 'stopping', { reason: 'stop requested' });
    this.os.abortTask(a.current_task_id, new TaskError('shutdown', 'agent stopping'));
    if (this.running) await Promise.race([this.running.catch(() => {}), new Promise((r) => setTimeout(r, graceMs).unref?.())]);
    this.#releaseCurrent('agent stopped');
    this.#stopHeartbeatTimer();
    const out = this.#reg.transition(this.id, 'stopped', { reason: 'stopped' }); this.#checkpoint(); return out;
  }
  /** Marks the agent failed (fatal error). Its unfinished task goes back on the queue; retries are not consumed. */
  fail(error) {
    const a = this.agent; this.os.abortTask(a.current_task_id, new TaskError('agent_failed', 'agent failed'));
    this.#releaseCurrent('agent failed'); this.#stopHeartbeatTimer();
    const out = this.#reg.transition(this.id, 'failed', { reason: 'fatal error', error: error?.message ?? String(error) }); this.#checkpoint(); return out;
  }
  startHeartbeatTimer() { const ms = this.agent.config.runtime.heartbeatIntervalMs; this.hbTimer ??= setInterval(() => { try { this.heartbeat(); } catch { /* agent no longer active */ } }, ms); this.hbTimer.unref?.(); }
  #stopHeartbeatTimer() { if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; } }
  #releaseCurrent(why) {
    const a = this.agent; if (!a.current_task_id) return;
    const t = this.os.queue.get(a.current_task_id);
    if (t && ['assigned', 'running'].includes(t.status)) this.os.queue.release(t.id, why);
    this.#reg.setCurrentTask(this.id, null);
  }

  /** Claims and executes at most one task. Returns the final task row, or null when idle. */
  async tick() {
    if (this.running) return null;
    const a = this.agent; if (a.status !== 'ready') return null;
    this.heartbeat();
    const task = this.os.queue.claim(a); if (!task) return null;
    this.running = this.#execute(a, task).finally(() => { this.running = null; });
    return this.running;
  }

  async #execute(agent, task) {
    const os = this.os, reg = this.#reg, q = os.queue;
    try { reg.transition(this.id, 'running', { reason: `task ${task.id}`, extra: { current_task_id: task.id } }); }
    catch (e) { q.release(task.id, 'agent not ready'); return q.get(task.id); }
    const retry = agent.config.retry, timeoutMs = task.timeout_ms ?? agent.config.limits.timeoutMs;
    const handler = os.handlers.get(task.type);
    let final;
    try {
      if (!handler) final = q.fail(task.id, { code: 'no_handler', message: `no handler for ${task.type}`, retryable: false, retry });
      else {
        try { assertCan(agent, handler.capability, { businessId: task.business_id }); }
        catch (e) { if (e instanceof PermissionError) final = q.fail(task.id, { code: 'permission_denied', message: e.message, retryable: false, retry }); else throw e; }
      }
      if (!final) {
        const started = os.clock.now().getTime();
        q.start(task.id, agent, timeoutMs);
        const controller = new AbortController(); os.inflight.set(task.id, controller);
        const timer = setTimeout(() => controller.abort(new TaskError('timeout', `exceeded ${timeoutMs}ms`, { retryable: true })), timeoutMs); timer.unref?.();
        const aborted = new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(controller.signal.reason), { once: true }));
        try {
          const ctx = { task: q.get(task.id), agent, signal: controller.signal, clock: os.clock, checkpoint: (state) => os.repos.checkpoints.save('task', task.id, state, task.data_mode) };
          const result = await Promise.race([handler.fn(ctx), aborted]);
          final = this.#settle(task.id, () => q.complete(task.id, result));
          if (final?.status === 'completed') { reg.recordOutcome(this.id, { ok: true, execMs: os.clock.now().getTime() - started }); reg.award(this.id, { xp: 10, reputation: 0.1, reason: 'task_completed', taskId: task.id }); }
        } catch (err) {
          const e = err instanceof TaskError ? err : new TaskError('unhandled_error', err?.message ?? String(err), { retryable: false });
          if (e.code === 'shutdown' || e.code === 'agent_failed') final = this.#settle(task.id, () => q.release(task.id, e.message));
          else if (e.code === 'cancelled') final = q.get(task.id);
          else {
            final = this.#settle(task.id, () => q.fail(task.id, { code: e.code, message: e.message, retryable: e.retryable, retry }));
            if (final) { const retried = final.status === 'retrying'; reg.recordOutcome(this.id, { ok: false, retried, execMs: os.clock.now().getTime() - started }); if (final.status === 'failed') reg.award(this.id, { reputation: -0.2, reason: `task_failed:${e.code}`, taskId: task.id }); }
          }
        } finally { clearTimeout(timer); os.inflight.delete(task.id); }
      } else {
        reg.recordOutcome(this.id, { ok: false }); reg.award(this.id, { reputation: -0.2, reason: `task_failed:${final.error_code}`, taskId: task.id });
      }
    } finally {
      reg.setCurrentTask(this.id, null);
      const now = reg.get(this.id);
      if (now.status === 'running') reg.transition(this.id, 'ready', { reason: 'task finished' });
      os.repos.checkpoints.save('task', task.id, { status: q.get(task.id).status, agentId: this.id, retryCount: q.get(task.id).retry_count, finishedAt: os.clock.now().toISOString() }, task.data_mode);
      this.#checkpoint(task.id);
    }
    return q.get(task.id);
  }
  /** Runs a transition; if someone else already moved the task (cancelled, timed out elsewhere), keep their state. */
  #settle(taskId, fn) { try { return fn(); } catch (e) { if (e instanceof InvalidTransitionError) return this.os.queue.get(taskId); throw e; } }
  #checkpoint(lastTaskId) {
    const a = this.agent;
    this.os.repos.checkpoints.save('agent', a.id, { status: a.status, currentTaskId: a.current_task_id, lastHeartbeatAt: a.last_heartbeat_at, lastTaskId: lastTaskId ?? null, health: a.health_status }, a.data_mode);
  }
}
