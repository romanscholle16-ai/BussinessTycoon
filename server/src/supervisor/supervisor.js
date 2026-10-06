// The Supervisor: the control brain on top of the Agent OS. It observes, plans (policy.js), dispatches THROUGH the Agent OS,
// recovers, records decisions and checkpoints. It never runs handlers itself and never bypasses agent permissions.
import { randomUUID } from 'node:crypto';
import { assertSupervisorTransition, SUPERVISOR_STATES } from './states.js';
import { normalizeSupervisorConfig } from './config.js';
import { observe } from './observe.js';
import { planDispatch, incompatibility } from './policy.js';
import { SupervisorStore } from './store.js';
import { TaskError } from '../agents/handlers.js';

export class SupervisorLockError extends Error { constructor(holder) { super('another Supervisor instance holds the lock'); this.name = 'SupervisorLockError'; this.code = 'supervisor_already_running'; this.holder = holder; } }
const MAX_SEEN = 500;

export class Supervisor {
  constructor({ os, config = {}, processRunId = null, instanceId = randomUUID() }) {
    this.os = os; this.db = os.db; this.repos = os.repos; this.clock = os.clock; this.cfg = normalizeSupervisorConfig(config);
    this.instanceId = instanceId; this.processRunId = processRunId ?? this.repos.runs.start('supervisor-standalone');
    this.store = new SupervisorStore(this.db, this.repos, this.clock);
    this.state = 'stopped'; this.runId = null; this.seq = 0; this.timer = null; this.cycling = null; this.inflight = new Set();
    this.seen = new Map(); this.recoveryAttempts = {}; this.activeLimits = new Set(); this.failures = 0;
    this.counters = { cycles: 0, dispatched: 0, skipped: 0, recoveries: 0, decisions: 0, cycleFailures: 0 };
    this.lastCycle = null; this.lastCheckpointAt = 0; this.startedAt = null; this.previousRun = null;
  }
  get now() { return this.clock.now().getTime(); }
  iso() { return this.clock.now().toISOString(); }

  // ---------- lifecycle ----------
  #set(to, why) { assertSupervisorTransition(this.state, to); const from = this.state; this.state = to; this.repos.events.insert({ ts: this.iso(), type: 'supervisor.lifecycle', severity: to === 'failed' ? 'error' : 'info', action: to, result: why ?? to, metadata: { from, to, runId: this.runId, instanceId: this.instanceId }, data_mode: 'live' }); }

  async start({ loop = true } = {}) {
    assertSupervisorTransition(this.state, 'starting');
    const lock = this.store.acquire(this.instanceId, this.processRunId, this.cfg.lockTtlMs);
    if (!lock.acquired) throw new SupervisorLockError(lock.holder);
    this.#set('starting');
    const prev = this.store.load();
    this.runId = randomUUID(); this.startedAt = this.iso(); this.failures = 0;
    const interrupted = !!prev && !prev.cleanShutdown && ['starting', 'running', 'paused', 'stopping'].includes(prev.state) && prev.runId !== this.runId;
    if (prev) { this.seq = prev.lastCycleSeq ?? 0; this.recoveryAttempts = prev.recoveryAttempts ?? {}; for (const k of prev.seenDecisions ?? []) this.seen.set(k, true); this.counters = { ...this.counters, ...(prev.counters ?? {}) }; }
    this.previousRun = prev ? { runId: prev.runId, interrupted, lastCycleAt: prev.lastCycleAt ?? null, lastCycleSeq: prev.lastCycleSeq ?? 0 } : null;
    this.#set('running');
    this.#decide(interrupted ? 'supervisor.resumed_after_interruption' : 'supervisor.started', { severity: interrupted ? 'warn' : 'info', reason: interrupted ? 'previous run did not shut down cleanly' : 'start', meta: { previousRunId: prev?.runId ?? null, lastCycleSeq: prev?.lastCycleSeq ?? null, lockTakenOver: lock.tookOver } });
    this.#checkpoint(true);
    if (loop) this.#schedule(0);
    return this.status();
  }
  pause() { this.#set('paused'); this.#decide('supervisor.paused', { reason: 'pause requested' }); this.#checkpoint(true); }
  resume() { this.#set('running'); this.#decide('supervisor.resumed', { reason: 'resume requested' }); this.#checkpoint(true); }
  async stop() {
    if (this.state === 'stopped') return this.status();
    this.#set('stopping'); this.#clearTimer();
    try { await this.cycling; } catch { /* already handled */ }
    this.#decide('supervisor.stopped', { reason: 'clean shutdown', meta: { inFlight: this.inflight.size } });
    this.#set('stopped'); this.#checkpoint(true, true); this.store.release(this.instanceId);
    return this.status();
  }
  #fail(reason) { this.#clearTimer(); try { this.#set('failed', reason); } catch { /* already terminal */ } this.#decide('supervisor.failed', { severity: 'error', reason, result: 'failed' }); this.#checkpoint(true); this.store.release(this.instanceId); }
  #clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  #schedule(ms) {
    this.#clearTimer(); if (this.state !== 'running' && this.state !== 'paused') return;
    this.timer = setTimeout(async () => { this.timer = null; await this.cycle(); this.#schedule(this.cfg.pollMs); }, ms); this.timer.unref?.();
  }

  // ---------- one control cycle ----------
  /** Runs one observe -> recover -> plan -> dispatch -> checkpoint pass. `wait` also waits for dispatched tasks to finish (tests). */
  async cycle({ wait = false } = {}) {
    if (this.state !== 'running') return { skipped: this.state };
    if (this.cycling) return { skipped: 'busy' };
    this.cycling = this.#cycle().finally(() => { this.cycling = null; });
    const out = await this.cycling;
    if (wait) await this.drain();
    return out;
  }
  async drain() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }
  #track(p) { const w = p.catch(() => {}).finally(() => this.inflight.delete(w)); this.inflight.add(w); }

  async #cycle() {
    const seq = ++this.seq, now = this.now; this.counters.cycles++;
    try {
      if (!this.store.renew(this.instanceId)) { this.#fail('lock lost to another instance'); return { seq, failed: 'lock_lost' }; }
      const os = this.os, summary = { seq, dispatched: [], recovered: 0, skipped: 0, limits: [], promotedRetries: 0, expiredDeadlines: 0 };
      summary.promotedRetries = os.queue.promoteDueRetries().length;
      summary.expiredDeadlines = os.queue.expireDeadlines().length;
      let snap = observe(os, { seq, supervisorState: this.state, runId: this.runId, now, cfg: this.cfg });
      const recovered = await this.#recover(snap);
      summary.recovered = recovered;
      if (recovered || summary.promotedRetries) snap = observe(os, { seq, supervisorState: this.state, runId: this.runId, now: this.now, cfg: this.cfg });
      const plan = planDispatch(snap, this.cfg, this.now, os.handlers);
      for (const d of plan.dispatch) {
        let res = null;
        try { res = os.dispatch(d.taskId, d.agentId); }
        catch (e) { this.#decide('dispatch.failed', { severity: 'error', task: this.#t(snap, d.taskId), agentId: d.agentId, result: 'failed', reason: String(e.message).slice(0, 200) }); continue; }
        if (!res) { this.#decide('dispatch.skipped', { severity: 'debug', task: this.#t(snap, d.taskId), agentId: d.agentId, result: 'noop', reason: 'task or agent no longer eligible (claim not granted)' }); continue; }
        this.counters.dispatched++; summary.dispatched.push(d.taskId);
        this.#decide('task.dispatched', { task: res.task, agentId: d.agentId, reason: 'selected by scheduling policy', meta: { rank: d.rank, agentChoice: d.agentChoice } });
        this.#track(res.done);
      }
      for (const s of plan.skipped) if (s.reason === 'no_compatible_agent') { summary.skipped++; this.counters.skipped++; this.#decide('task.skipped', { task: this.#t(snap, s.taskId), result: 'skipped', reason: s.reason, meta: { detail: s.detail }, dedupe: `skip:${s.taskId}:${s.reason}` }); }
      for (const l of plan.limits) if (!this.activeLimits.has(l)) this.#decide('limit.reached', { severity: 'warn', result: 'limited', reason: l, meta: { limits: this.cfg.limits } });
      this.activeLimits = new Set(plan.limits); summary.limits = plan.limits;
      this.failures = 0; this.lastCycle = { ...summary, at: this.iso(), ok: true, queue: snap.queue };
      this.#checkpoint(false, false, summary.dispatched.length > 0 || recovered > 0);
      return summary;
    } catch (e) {
      this.failures++; this.counters.cycleFailures++; this.lastCycle = { seq, at: this.iso(), ok: false, error: String(e.message).slice(0, 200) };
      this.#decide('cycle.failed', { severity: 'error', result: 'failed', reason: String(e.message).slice(0, 200), meta: { consecutive: this.failures } });
      if (this.failures >= this.cfg.maxConsecutiveCycleFailures) this.#fail(`${this.failures} consecutive cycle failures`);
      return { seq, failed: 'cycle_error' };
    }
  }
  #t(snap, id) { return snap.candidates.find((t) => t.id === id) ?? snap.activeTasks.find((t) => t.id === id) ?? { id }; }

  // ---------- recovery (non-destructive; uses Agent OS lifecycle/queue APIs; infrastructure recovery never consumes a retry) ----------
  async #recover(snap) {
    const os = this.os, q = os.queue; let n = 0; const guard = async (fn) => { try { await fn(); n++; this.counters.recoveries++; } catch (e) { if (e?.code !== 'invalid_transition') this.#decide('recovery.failed', { severity: 'error', result: 'failed', reason: String(e.message).slice(0, 200) }); } };
    for (const id of [...snap.stale.expiredLeases].sort()) await guard(() => { const t = q.release(id, 'lease expired (supervisor)'); this.#decide('recovery.lease_released', { task: t, result: 'requeued', reason: 'assignment lease expired before the task started', meta: { retryConsumed: false } }); });
    for (const id of [...snap.stale.orphanedRunning].sort()) await guard(() => { const t = q.release(id, 'no live executor (supervisor)'); this.#decide('recovery.task_interrupted', { task: t, result: 'requeued', reason: 'task marked running but nothing is executing it', meta: { retryConsumed: false } }); });
    // Overdue tasks that a live executor still holds: abort them; the runtime fails them with the retryable `timeout` error.
    // (Overdue tasks with no executor were already requeued above as orphans: infrastructure loss, not an execution failure.)
    for (const id of [...snap.stale.timedOut].sort()) if (os.isInflight(id)) await guard(() => { os.abortTask(id, new TaskError('timeout', 'exceeded timeout (supervisor)', { retryable: true })); this.#decide('recovery.task_timeout', { task: q.get(id), result: 'abort_requested', reason: 'running task exceeded its timeout', meta: { retryConsumed: true } }); });
    const compatibleWork = (a) => snap.candidates.some((t) => incompatibility(a, t, os.handlers) === null);
    const agentById = new Map(snap.agents.map((a) => [a.id, a]));
    const targets = [];
    for (const id of [...snap.stale.agents].sort()) targets.push([agentById.get(id), 'stale_heartbeat']);
    for (const id of [...snap.failedAgents].sort()) targets.push([agentById.get(id), 'failed_runtime']);
    for (const id of [...snap.stoppedAgents].sort()) { const a = agentById.get(id); if (compatibleWork(a)) targets.push([a, 'stopped_with_eligible_work']); }
    for (const [a, cause] of targets) if (await this.#recoverAgent(a, cause)) { n++; this.counters.recoveries++; }
    return n;
  }
  async #recoverAgent(a, cause) {
    const rec = this.cfg.recovery, now = this.now, id = a.id, rt = this.os.runtime(id);
    const attempts = (this.recoveryAttempts[id] ?? []).filter((ts) => now - ts < rec.windowMs);
    if (attempts.length >= rec.maxAgentRecoveries) {
      this.recoveryAttempts[id] = attempts;
      if (a.status !== 'failed') { try { rt.fail(new Error('recovery attempts exhausted')); } catch { /* ignore */ } }
      this.#decide('recovery.refused', { severity: 'error', agentId: id, result: 'escalated', reason: `recovery attempts exhausted (${rec.maxAgentRecoveries} in ${rec.windowMs}ms); agent left failed for human/Phase 19 attention`, meta: { cause, escalate: true }, dedupe: `refused:${id}` });
      return false;
    }
    this.recoveryAttempts[id] = [...attempts, now];
    try {
      if (a.status === 'failed') this.os.registry.transition(id, 'stopped', { reason: 'supervisor recovery' });
      else if (['ready', 'running', 'blocked'].includes(a.status)) await rt.stop({ graceMs: this.os.settings.stopGraceMs });
      await rt.start();
      this.#decide('recovery.agent_restarted', { agentId: id, result: 'ready', reason: cause, meta: { attempt: attempts.length + 1, previousStatus: a.status } });
      return true;
    } catch (e) { this.#decide('recovery.agent_restart_failed', { severity: 'error', agentId: id, result: 'failed', reason: String(e.message).slice(0, 200), meta: { cause } }); return false; }
  }

  // ---------- decisions & checkpoints ----------
  /** Appends a decision to the append-only events table (type supervisor.decision / supervisor.lifecycle). `dedupe` suppresses repeats, persisted across restarts. */
  #decide(kind, { severity = 'info', task = null, agentId = null, result = 'ok', reason = null, meta = {}, dedupe = null } = {}) {
    if (dedupe) { if (this.seen.has(dedupe)) return false; this.seen.set(dedupe, true); while (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value); }
    const agent = agentId ? this.repos.agents.get(agentId) : null; this.counters.decisions++;
    const businessId = task ? (task.business_id ?? task.businessId ?? null) : agent?.business_id ?? null;
    this.repos.events.insert({ ts: this.iso(), type: kind.startsWith('supervisor.') ? 'supervisor.lifecycle' : 'supervisor.decision', severity, business_id: businessId, agent_id: agent?.id ?? null, task_id: task?.id && this.repos.tasks.get(task.id) ? task.id : null, action: kind, result, error: severity === 'error' ? reason : null, metadata: { reason, runId: this.runId, seq: this.seq, ...meta }, data_mode: task?.data_mode ?? task?.dataMode ?? agent?.data_mode ?? 'live' });
    return true;
  }
  #checkpoint(force = false, clean = false, acted = false) {
    const now = this.now; if (!force && !acted && now - this.lastCheckpointAt < this.cfg.checkpointIntervalMs) return;
    this.lastCheckpointAt = now;
    this.store.save({ version: 1, runId: this.runId, instanceId: this.instanceId, processRunId: this.processRunId, state: this.state, startedAt: this.startedAt, lastCycleSeq: this.seq, lastCycleAt: this.lastCycle?.at ?? null, lastCycleOk: this.lastCycle?.ok ?? null,
      counters: this.counters, recoveryAttempts: this.recoveryAttempts, seenDecisions: [...this.seen.keys()].slice(-200), cleanShutdown: clean, config: { pollMs: this.cfg.pollMs, limits: this.cfg.limits, scheduling: this.cfg.scheduling }, updatedAt: this.iso() });
  }

  status() {
    return { state: this.state, runId: this.runId, instanceId: this.instanceId, cycle: this.seq, lastCycle: this.lastCycle, counters: { ...this.counters }, inFlight: this.inflight.size, activeLimits: [...this.activeLimits], previousRun: this.previousRun,
      config: { pollMs: this.cfg.pollMs, limits: this.cfg.limits, scheduling: this.cfg.scheduling, recovery: this.cfg.recovery }, startedAt: this.startedAt };
  }
  decisions({ limit = 50, kind = null, sinceTs = null } = {}) {
    const f = ["type IN ('supervisor.decision','supervisor.lifecycle')"], p = [];
    if (kind) { f.push('action = ?'); p.push(kind); } if (sinceTs) { f.push('ts >= ?'); p.push(sinceTs); }
    return this.db.all(`SELECT id, ts, type, severity, business_id, agent_id, task_id, action, result, metadata_json FROM events WHERE ${f.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`, [...p, Math.min(limit, 200)]).map((r) => ({ id: r.id, ts: r.ts, kind: r.action, severity: r.severity, result: r.result, businessId: r.business_id, agentId: r.agent_id, taskId: r.task_id, details: JSON.parse(r.metadata_json) }));
  }
}
export { SUPERVISOR_STATES };
