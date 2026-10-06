// System health from real persisted/runtime state. Deterministic: same inputs -> same output. Read-only.
//
// Component status: healthy | degraded | critical | unknown.
// Overall: critical if any component is critical; else degraded if any is degraded; else healthy only when ALL core
// components (database, supervisor, agentOS) are healthy; otherwise unknown (not enough information, e.g. no agents yet or
// Supervisor disabled). An HTTP 200 alone never implies "healthy".
//
// Thresholds (config.observability.thresholds):
//   supervisor   cycle stale  > max(5*pollMs, 10s)  -> degraded;  > max(30*pollMs, 60s) -> critical;  failed >= failedCriticalMs (30s) -> critical (else degraded)
//                paused/stopped -> degraded; last cycle errored -> degraded; startup grace 10s before the first cycle is expected
//   agents       any failed or stale agent -> degraded; every non-retired agent failed -> critical; none registered -> unknown
//   tasks        in the last hour (>= 5 finished): failure rate >= 50% -> degraded, >= 80% with >= 10 finished -> critical;
//                expired leases / orphaned running / overdue-with-executor tasks -> degraded
//   events       last 15 min: >= 20 errors -> degraded, >= 100 -> critical; any critical event -> degraded, >= 3 -> critical
export const DEFAULT_THRESHOLDS = { supervisorStartupGraceMs: 10000, supervisorFailedCriticalMs: 30000, taskWindowMs: 3600e3, minFinished: 5, failureRateDegraded: 0.5, failureRateCritical: 0.8, minFinishedCritical: 10, eventWindowMs: 900e3, errorsDegraded: 20, errorsCritical: 100, criticalsDegraded: 1, criticalsCritical: 3, queueStallMs: 600e3 };
const ORDER = { healthy: 0, unknown: 0, degraded: 1, critical: 2 };
const comp = (status, reasons = [], details = {}) => ({ status, reasons, details });
const iso = (ms) => new Date(ms).toISOString();

function databaseHealth(ctx) {
  const h = ctx.database?.health?.();
  if (!h) return comp('unknown', ['database service not configured']);
  const d = { status: h.status, schemaVersion: h.schemaVersion ?? null, latestVersion: h.latestVersion ?? null, pendingMigrations: h.pendingMigrations ?? null };
  if (h.status === 'ok') {
    if (ctx.deep) { try { const i = ctx.database.db.integrityCheck(), f = ctx.database.db.foreignKeyCheck(); d.integrity = i.ok ? 'ok' : 'failed'; d.foreignKeys = f.ok ? 'ok' : 'failed'; if (!i.ok || !f.ok) return comp('critical', ['integrity check failed'], d); } catch { return comp('critical', ['integrity check could not run'], d); } }
    return comp('healthy', [], d);
  }
  if (h.status === 'migration_required') return comp('critical', ['database migrations are pending'], d);
  if (h.status === 'migration_failed') return comp('critical', [`database migration failed (${h.error ?? 'unknown'})`], d);
  if (h.status === 'closed') return comp('unknown', ['database is closed'], d);
  return comp('critical', ['database unavailable'], d);
}

function supervisorHealth(ctx) {
  const sv = ctx.supervisor, T = ctx.t;
  if (!sv) return comp('unknown', ['Supervisor is not running (disabled or failed to start)']);
  const s = sv.status(), now = ctx.now, poll = s.config.pollMs, d = { state: s.state, cycle: s.cycle, inFlight: s.inFlight, lastCycleAt: s.lastCycle?.at ?? null, lastSuccessfulCycleAt: s.lastOkCycleAt ?? null, activeLimits: s.activeLimits };
  const since = s.stateSince ? Date.parse(s.stateSince) : now;
  if (s.state === 'stopped' && !s.runId) return comp('unknown', ['Supervisor has not been started'], d);
  if (s.state === 'failed') return comp(now - since >= T.supervisorFailedCriticalMs ? 'critical' : 'degraded', ['Supervisor has failed and nothing is being scheduled'], d);
  if (s.state === 'paused') return comp('degraded', ['Supervisor is paused; no new work is dispatched'], d);
  if (s.state !== 'running') return comp('degraded', [`Supervisor is ${s.state}`], d);
  const reasons = []; let status = 'healthy';
  const last = s.lastOkCycleAt ? Date.parse(s.lastOkCycleAt) : null, age = last === null ? null : now - last;
  const staleAt = Math.max(5 * poll, 10000), critAt = Math.max(30 * poll, 60000);
  if (last === null) { if (now - since > Math.max(T.supervisorStartupGraceMs, 3 * poll)) { status = 'degraded'; reasons.push('Supervisor has not completed a cycle yet'); } }
  else if (age > critAt) { status = 'critical'; reasons.push('Supervisor control loop has stalled'); }
  else if (age > staleAt) { status = 'degraded'; reasons.push('Supervisor control loop is slower than expected'); }
  if (s.lastCycle && s.lastCycle.ok === false && status === 'healthy') { status = 'degraded'; reasons.push('the last Supervisor cycle failed'); }
  d.lastCycleAgeMs = age;
  return comp(status, reasons, d);
}

function agentHealth(ctx) {
  const agents = ctx.os.registry.list({}).filter((a) => a.status !== 'retired'), by = {};
  for (const a of agents) by[a.status] = (by[a.status] ?? 0) + 1;
  const stale = ctx.os.registry.findStale(new Date(ctx.now)).map((a) => a.id), failed = agents.filter((a) => a.status === 'failed');
  const d = { total: agents.length, byStatus: by, stale: stale.length, available: agents.filter((a) => a.status === 'ready' && !a.current_task_id).length };
  if (!agents.length) return comp('unknown', ['no agents are registered'], d);
  if (failed.length === agents.length) return comp('critical', ['every agent has failed'], d);
  const reasons = []; if (failed.length) reasons.push(`${failed.length} agent(s) failed`); if (stale.length) reasons.push(`${stale.length} agent(s) stopped sending heartbeats`);
  return comp(reasons.length ? 'degraded' : 'healthy', reasons, d);
}

function taskHealth(ctx) {
  const q = ctx.os.queue, T = ctx.t, since = iso(ctx.now - T.taskWindowMs);
  const counts = q.counts(), fin = ctx.db.get("SELECT SUM(status = 'completed') AS ok, SUM(status = 'failed') AS bad FROM tasks WHERE completed_at >= ? AND status IN ('completed','failed')", [since]);
  const ok = fin.ok ?? 0, bad = fin.bad ?? 0, finished = ok + bad, rate = finished ? bad / finished : null;
  const stale = { expiredLeases: q.findExpiredLeases().length, overdue: q.findTimedOut().length };
  const d = { counts, lastHour: { completed: ok, failed: bad, failureRate: rate }, stale };
  const reasons = []; let status = 'healthy';
  if (finished >= T.minFinishedCritical && rate >= T.failureRateCritical) { status = 'critical'; reasons.push(`${Math.round(rate * 100)}% of tasks failed in the last hour`); }
  else if (finished >= T.minFinished && rate >= T.failureRateDegraded) { status = 'degraded'; reasons.push(`${Math.round(rate * 100)}% of tasks failed in the last hour`); }
  if (stale.expiredLeases) { if (status === 'healthy') status = 'degraded'; reasons.push(`${stale.expiredLeases} task assignment(s) expired`); }
  if (stale.overdue) { if (status === 'healthy') status = 'degraded'; reasons.push(`${stale.overdue} running task(s) exceeded their timeout`); }
  return comp(status, reasons, d);
}

function eventHealth(ctx) {
  const T = ctx.t, c = ctx.events.severityCounts(iso(ctx.now - T.eventWindowMs)), latest = ctx.events.latest();
  const d = { windowMinutes: Math.round(T.eventWindowMs / 60000), recent: c, latestEventAt: latest?.ts ?? null };
  const reasons = []; let status = 'healthy';
  if (c.critical >= T.criticalsCritical || c.error >= T.errorsCritical) { status = 'critical'; reasons.push(`${c.critical} critical and ${c.error} error events in the last ${d.windowMinutes} minutes`); }
  else if (c.critical >= T.criticalsDegraded || c.error >= T.errorsDegraded) { status = 'degraded'; reasons.push(`${c.critical} critical and ${c.error} error events in the last ${d.windowMinutes} minutes`); }
  return comp(status, reasons, d);
}

/** Things that need a human's eye but do not by themselves make the system unhealthy. */
function attention(ctx, components) {
  const out = [], q = ctx.os.queue, c = q.counts(), T = ctx.t;
  if (c.blocked) out.push({ kind: 'blocked_tasks', severity: 'warning', count: c.blocked, message: `${c.blocked} task(s) are blocked waiting for something` });
  const failedAgents = components.agentOS.details.byStatus?.failed; if (failedAgents) out.push({ kind: 'failed_agents', severity: 'error', count: failedAgents, message: `${failedAgents} agent(s) are in the failed state` });
  const oldest = ctx.db.get("SELECT MIN(COALESCE(next_attempt_at, created_at)) AS t FROM tasks WHERE status = 'queued'")?.t;
  if (oldest && ctx.now - Date.parse(oldest) > T.queueStallMs) out.push({ kind: 'queue_waiting', severity: 'warning', count: c.queued ?? 0, message: `the oldest queued task has waited ${Math.round((ctx.now - Date.parse(oldest)) / 60000)} minutes` });
  const refused = ctx.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'supervisor.decision' AND action = 'recovery.refused' AND ts >= ?", [iso(ctx.now - 86400e3)]).n;
  if (refused) out.push({ kind: 'recovery_escalated', severity: 'error', count: refused, message: `${refused} agent recovery escalation(s) in the last 24 hours` });
  return out;
}

export function computeHealth(ctx) {
  const t = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds ?? {}) }, c = { ...ctx, t };
  const components = { server: comp('healthy', [], { uptimeSeconds: Math.max(0, Math.round((ctx.now - Date.parse(ctx.startedAt)) / 1000)), startedAt: ctx.startedAt, env: ctx.env }), database: databaseHealth(c) };
  const dbOk = components.database.status === 'healthy';
  const guard = (name, fn) => { if (!dbOk) return comp('unknown', ['database not available']); try { return fn(c); } catch { return comp('unknown', [`${name} state could not be read`]); } };
  components.supervisor = guard('supervisor', supervisorHealth); components.agentOS = guard('agent OS', agentHealth); components.tasks = guard('task', taskHealth); components.events = guard('event', eventHealth);
  const all = Object.values(components); const worst = Math.max(...all.map((x) => ORDER[x.status]));
  const core = [components.database, components.supervisor, components.agentOS];
  const status = worst === 2 ? 'critical' : worst === 1 ? 'degraded' : core.every((x) => x.status === 'healthy') ? 'healthy' : 'unknown';
  const issues = all.reduce((n, x) => n + x.reasons.length, 0);
  const reasons = Object.entries(components).flatMap(([k, v]) => v.reasons.map((r) => `${k}: ${r}`));
  return { status, issues, summary: status === 'healthy' ? 'All core components are working.' : reasons.slice(0, 3).join('; ') || 'Not enough information yet.', components, attention: dbOk ? safeAttention(c, components) : [], checkedAt: iso(ctx.now) };
}
const safeAttention = (c, comps) => { try { return attention(c, comps); } catch { return []; } };
