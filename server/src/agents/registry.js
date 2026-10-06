// Agent Registry: persistence + lifecycle transitions + heartbeat/health for agents. Uses the Phase 2 database only.
import { assertAgentTransition, InvalidTransitionError, AGENT_STATES } from './states.js';
import { normalizeAgentDefinition } from './config.js';
import { ValidationError, assertId } from './validate.js';

export const systemClock = { now: () => new Date() };
export const levelForXp = (xp) => 1 + Math.floor(xp / 100); // placeholder rule; real balancing is Phase 13
const EMPTY_METRICS = { tasksCompleted: 0, tasksFailed: 0, retries: 0, totalExecMs: 0, estimatedCostMinor: 0, actualCostMinor: 0, revenueMinor: null, uptimeMs: 0, recentOutcomes: [] };

export class AgentRegistry {
  constructor(db, repos, { clock = systemClock } = {}) { this.db = db; this.repos = repos; this.clock = clock; }
  iso() { return this.clock.now().toISOString(); }

  register(def, { dataMode = 'live' } = {}) {
    const d = normalizeAgentDefinition(def);
    if (d.businessId && !this.repos.businesses.get(d.businessId)) throw new ValidationError(`unknown business "${d.businessId}"`, 'businessId');
    for (const b of d.permissions.businesses) if (b !== '*' && !this.repos.businesses.get(b)) throw new ValidationError(`unknown business "${b}" in permissions`, 'businesses');
    if (d.permissions.businesses.includes('*') && d.businessId) throw new ValidationError('only shared agents (no business) may hold "*" business access', 'businesses');
    const row = this.repos.agents.insert({ id: d.id, name: d.name, role: d.role, business_id: d.businessId, status: 'created', config: d.config, permissions: d.permissions, metrics: { ...EMPTY_METRICS }, data_mode: dataMode });
    this.#event(row, 'agent.created', 'register', { from: null, to: 'created' });
    return this.get(row.id);
  }

  get(id) { assertId(id, 'agentId'); return this.repos.agents.get(id); }
  list({ business, role, status, available, dataMode } = {}) {
    const f = {}; if (business !== undefined) f.business_id = business; if (role) f.role = role; if (status) { if (!AGENT_STATES.includes(status)) throw new ValidationError('unknown status', 'status'); f.status = status; } if (dataMode) f.data_mode = dataMode;
    let rows = this.repos.agents.list(f, { limit: 1000, orderBy: 'name' });
    if (available) rows = rows.filter((a) => a.status === 'ready' && !a.current_task_id);
    return rows;
  }
  byBusiness(businessId) { return this.list({ business: businessId }); }
  byRole(role) { return this.list({ role }); }
  byStatus(status) { return this.list({ status }); }
  available() { return this.list({ available: true }); }

  /** Compare-and-set lifecycle transition. Throws InvalidTransitionError for illegal moves or if the state changed underneath us. */
  transition(id, to, { reason = null, error = null, extra = {} } = {}) {
    const a = this.get(id); if (!a) throw new ValidationError(`agent ${id} not found`, 'agentId');
    assertAgentTransition(a.status, to);
    const now = this.iso(), sets = { status: to, last_activity_at: now, ...extra };
    if (to === 'ready' && a.status !== 'running') { sets.last_started_at = now; sets.last_heartbeat_at = now; }
    if (error) sets.last_error = String(error).slice(0, 500);
    if (to === 'retired') sets.retired_at = now;
    if (to === 'failed') sets.health_status = 'failed';
    if (to === 'stopped' || to === 'retired') { sets.current_task_id = null; sets.health_status = 'unknown'; this.#addUptime(a, now); }
    const keys = Object.keys(sets), cols = keys.map((k) => this.#col(k));
    const r = this.db.run(`UPDATE agents SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = ?`, [...keys.map((k) => sets[k]), id, a.status]);
    if (!r.changes) throw new InvalidTransitionError('agent', this.get(id)?.status ?? 'unknown', to);
    const after = this.get(id);
    this.#event(after, `agent.${to}`, reason ?? `transition:${to}`, { from: a.status, to }, error);
    return after;
  }
  #col(k) { if (!/^[a-z_]+$/.test(k)) throw new Error('bad column'); return k; }
  #addUptime(a, nowIso) { /* uptime accumulates while the agent was active (ready/running/paused/blocked) */
    if (['ready', 'running', 'paused', 'blocked', 'stopping'].includes(a.status) && a.last_started_at) { const m = { ...EMPTY_METRICS, ...a.metrics }; m.uptimeMs += Math.max(0, Date.parse(nowIso) - Date.parse(a.last_started_at)); this.repos.agents.update(a.id, { metrics: m }); }
  }

  heartbeat(id, { health } = {}) {
    const a = this.get(id); if (!a) throw new ValidationError(`agent ${id} not found`, 'agentId');
    if (!['ready', 'running', 'blocked', 'paused'].includes(a.status)) throw new InvalidTransitionError('agent', a.status, 'heartbeat');
    const now = this.iso(); const patch = { last_heartbeat_at: now, last_activity_at: now };
    if (health !== undefined) patch.health = Math.max(0, Math.min(100, Math.round(health)));
    this.repos.agents.update(id, patch);
    const after = this.get(id); const hs = this.assessHealth(after); this.repos.agents.update(id, { health_status: hs });
    return this.get(id);
  }
  setCurrentTask(id, taskId) { this.repos.agents.update(id, { current_task_id: taskId, last_activity_at: this.iso() }); }

  /** healthy | degraded | stalled | failed | unknown, from state, heartbeat age, and recent task outcomes. */
  assessHealth(a, now = this.clock.now()) {
    if (a.status === 'failed') return 'failed';
    if (!['ready', 'running', 'blocked', 'paused'].includes(a.status)) return 'unknown';
    if (!a.last_heartbeat_at) return 'unknown';
    const stale = a.config?.runtime?.staleAfterMs ?? 30000;
    if (now - Date.parse(a.last_heartbeat_at) > stale) return 'stalled';
    const recent = (a.metrics?.recentOutcomes ?? []).slice(-5);
    if (recent.filter((o) => o === 'fail').length >= 3 || a.health < 50) return 'degraded';
    return 'healthy';
  }
  /** Active agents whose heartbeat is older than their stale threshold (detection only; recovery is Phase 4/19). */
  findStale(now = this.clock.now()) { return this.repos.agents.list({ status: ['ready', 'running', 'blocked'] }, { limit: 1000 }).filter((a) => this.assessHealth(a, now) === 'stalled'); }

  /** Records a finished task attempt in the agent's persisted metrics. Revenue is never invented: pass null/undefined if unknown. */
  recordOutcome(id, { ok, retried = false, execMs = 0, estimatedCostMinor = 0, actualCostMinor = 0, revenueMinor = null }) {
    const a = this.get(id), m = { ...EMPTY_METRICS, ...a.metrics };
    if (ok) m.tasksCompleted++; else if (!retried) m.tasksFailed++;
    if (retried) m.retries++;
    m.totalExecMs += execMs; m.estimatedCostMinor += estimatedCostMinor; m.actualCostMinor += actualCostMinor;
    if (revenueMinor != null) m.revenueMinor = (m.revenueMinor ?? 0) + revenueMinor;
    m.recentOutcomes = [...m.recentOutcomes, ok ? 'ok' : 'fail'].slice(-10);
    this.repos.agents.update(id, { metrics: m });
  }
  /** Derived view of persisted counters. */
  metricsView(a) {
    const m = { ...EMPTY_METRICS, ...a.metrics }, done = m.tasksCompleted + m.tasksFailed;
    return { ...m, successRate: done ? m.tasksCompleted / done : null, avgExecMs: m.tasksCompleted ? Math.round(m.totalExecMs / m.tasksCompleted) : null, efficiency: m.estimatedCostMinor ? m.tasksCompleted / (m.estimatedCostMinor / 100) : null, dataMode: a.data_mode };
  }

  /** Deterministic rule: XP only for a verified completed task; reputation +0.1 per completion, -0.2 per terminal failure. Placeholder until Phase 13. */
  award(id, { xp = 0, reputation = 0, reason, taskId = null }) {
    const a = this.get(id);
    this.db.transaction(() => {
      if (xp) this.repos.agentProgress.insert({ ts: this.iso(), agent_id: id, kind: 'xp', delta: xp, reason, task_id: taskId, data_mode: a.data_mode });
      if (reputation) this.repos.agentProgress.insert({ ts: this.iso(), agent_id: id, kind: 'reputation', delta: reputation, reason, task_id: taskId, data_mode: a.data_mode });
      const newXp = Math.max(0, a.xp + xp), newRep = Math.round((a.reputation + reputation) * 1000) / 1000, level = levelForXp(newXp);
      this.repos.agents.update(id, { xp: newXp, reputation: newRep, level });
      this.repos.progression.upsert('agent', id, a.data_mode, { xp: newXp, level, reputation: newRep });
    });
  }

  #event(agent, type, action, meta, error = null) {
    this.repos.events.insert({ ts: this.iso(), type, severity: type === 'agent.failed' ? 'error' : 'info', business_id: agent.business_id, agent_id: agent.id, action, result: type.split('.')[1], error, metadata: meta, data_mode: agent.data_mode });
  }
}
