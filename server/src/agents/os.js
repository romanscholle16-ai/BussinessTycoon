// The shared Agent OS: one registry, one queue, one handler registry, one runtime per agent. All businesses use this.
import { AgentRegistry, systemClock } from './registry.js';
import { TaskQueue } from './queue.js';
import { HandlerRegistry, demoHandlers } from './handlers.js';
import { AgentRuntime } from './runtime.js';

export class AgentOS {
  constructor({ db, repos, clock = systemClock, handlers = demoHandlers(new HandlerRegistry()), config = {} }) {
    this.db = db; this.repos = repos; this.clock = clock; this.handlers = handlers;
    this.settings = { pollMs: 500, leaseMs: 60000, stopGraceMs: 2000, ...config };
    this.registry = new AgentRegistry(db, repos, { clock }); this.queue = new TaskQueue(db, repos, { clock, leaseMs: this.settings.leaseMs });
    this.runtimes = new Map(); this.inflight = new Map(); this.loop = null; this.stepping = false; this.heartbeatsOn = false;
  }
  runtime(id) { if (!this.registry.get(id)) throw new Error(`unknown agent ${id}`); let r = this.runtimes.get(id); if (!r) { r = new AgentRuntime(this, id); this.runtimes.set(id, r); } return r; }
  registerAgent(def, opts) { const a = this.registry.register(def, opts); this.runtime(a.id); return a; }

  /** Boot-time repair: nothing is running yet, so any agent/task still marked active belongs to a dead process. */
  reconcileAfterRestart() {
    const released = [], stopped = [];
    this.db.transaction(() => {
      for (const t of this.repos.tasks.list({ status: ['assigned', 'running'] }, { limit: 1000 })) released.push(this.queue.release(t.id, 'process restart').id);
      for (const a of this.repos.agents.list({ status: ['ready', 'running', 'blocked', 'stopping'] }, { limit: 1000 })) {
        if (a.status !== 'stopping') this.registry.transition(a.id, 'stopping', { reason: 'process restart' });
        this.registry.transition(a.id, 'stopped', { reason: 'process restart' }); stopped.push(a.id);
      }
    });
    return { releasedTasks: released, stoppedAgents: stopped };
  }
  async startAll() { const started = []; for (const a of this.repos.agents.list({ status: ['created', 'stopped'] }, { limit: 1000 })) { await this.runtime(a.id).start(); started.push(a.id); } return started; }
  async stopAll() { for (const a of this.repos.agents.list({ status: ['ready', 'running', 'paused', 'blocked', 'failed'] }, { limit: 1000 })) await this.runtime(a.id).stop({ graceMs: this.settings.stopGraceMs }); }

  abortTask(taskId, reason) { const c = taskId && this.inflight.get(taskId); if (c) c.abort(reason); return !!c; }
  cancelTask(taskId, reason = 'cancelled') { const t = this.queue.cancel(taskId, reason); this.abortTask(taskId, Object.assign(new Error('cancelled'), { code: 'cancelled', retryable: false })); return t; }

  /** Queue housekeeping: due retries, deadlines, expired leases, timed-out tasks. Used by step() (Phase 3 loop); the Supervisor does its own with decisions. */
  maintain() {
    this.queue.promoteDueRetries(); this.queue.expireDeadlines(); this.queue.releaseExpiredLeases();
    for (const t of this.queue.findTimedOut()) { if (!this.abortTask(t.id, Object.assign(new Error('timeout'), { code: 'timeout', retryable: true }))) this.queue.fail(t.id, { code: 'timeout', message: `exceeded ${t.timeout_ms}ms`, retryable: true }); }
  }
  /** One maintenance + self-dispatch pass (Phase 3 mode, used when no Supervisor is running). Returns the tasks that finished in this pass. */
  async step() {
    if (this.stepping) return []; this.stepping = true;
    try {
      this.maintain();
      const done = [];
      for (const a of this.registry.list()) { if (a.status !== 'ready') continue; const t = await this.runtime(a.id).tick(); if (t) done.push(t); }
      return done;
    } finally { this.stepping = false; }
  }
  /** Supervisor entry point: hand one specific queued task to one specific agent. Returns {task, done} or null if the claim lost a race / is ineligible. */
  dispatch(taskId, agentId) { return this.runtime(agentId).dispatch(taskId); }
  isInflight(taskId) { return this.inflight.has(taskId); }
  startHeartbeats() { this.heartbeatsOn = true; for (const a of this.registry.list({ status: 'ready' })) this.runtime(a.id).startHeartbeatTimer(); }
  async runUntilIdle({ maxSteps = 100 } = {}) { const all = []; for (let i = 0; i < maxSteps; i++) { const d = await this.step(); if (!d.length) break; all.push(...d); } return all; }
  startLoop() { if (this.loop) return; const tick = async () => { try { await this.step(); } catch (e) { console.error(JSON.stringify({ level: 'error', msg: 'agent_loop_error', error: String(e.message).slice(0, 200) })); } this.loop = setTimeout(tick, this.settings.pollMs); this.loop.unref?.(); }; this.loop = setTimeout(tick, 0); this.loop.unref?.(); this.startHeartbeats(); }
  stopLoop() { if (this.loop) { clearTimeout(this.loop); this.loop = null; } }
  async shutdown() { this.stopLoop(); await this.stopAll(); }

  detect() { return { staleAgents: this.registry.findStale().map((a) => a.id), timedOutTasks: this.queue.findTimedOut().map((t) => t.id), expiredLeases: this.queue.findExpiredLeases().map((t) => t.id) }; }
  status() {
    const agents = {}; for (const a of this.repos.agents.list({}, { limit: 1000 })) agents[a.status] = (agents[a.status] ?? 0) + 1;
    return { loopRunning: !!this.loop, agents, tasks: this.queue.counts(), detection: this.detect() };
  }
}
export const createAgentOS = (opts) => new AgentOS(opts);
