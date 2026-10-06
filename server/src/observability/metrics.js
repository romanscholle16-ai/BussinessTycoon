// Aggregate operational metrics from persisted data. Operational only: no revenue/profit/sales/ROI/customers exist here.
// Windowed queries use indexed columns (tasks.completed_at, events (type, ts)); `current` values are live counts.
const TASK_STATUSES = ['pending', 'queued', 'assigned', 'running', 'retrying', 'blocked', 'completed', 'failed', 'cancelled'];
const BUSINESSES = ['etsy', 'assets', 'affiliate', 'fiverr'];
const rate = (a, b) => (b ? a / b : null);

export function computeMetrics(ctx, win) {
  const { db, os, supervisor } = ctx, since = win.since, until = win.until;
  const counts = os.queue.counts(), current = Object.fromEntries(TASK_STATUSES.map((s) => [s, counts[s] ?? 0]));
  const fin = since ? db.get(`SELECT SUM(status='completed') AS completed, SUM(status='failed') AS failed, SUM(status='cancelled') AS cancelled,
      AVG(CASE WHEN status='completed' AND started_at IS NOT NULL THEN (julianday(completed_at) - julianday(started_at)) * 86400000.0 END) AS avg_ms
    FROM tasks WHERE completed_at >= ? AND completed_at <= ?`, [since, until]) : null;
  const done = fin?.completed ?? 0, failed = fin?.failed ?? 0;
  const retried = since ? db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'task.retrying' AND ts >= ? AND ts <= ?", [since, until]).n : null;
  const tasks = { current, window: since ? { completed: done, failed, cancelled: fin.cancelled ?? 0, retriesScheduled: retried, successRate: rate(done, done + failed), failureRate: rate(failed, done + failed), avgExecutionMs: fin.avg_ms == null ? null : Math.round(fin.avg_ms) } : null };

  const agentsAll = os.registry.list({}), active = agentsAll.filter((a) => a.status !== 'retired'), stale = new Set(os.registry.findStale(new Date(Date.parse(until))).map((a) => a.id));
  const perAgent = since ? Object.fromEntries(db.all("SELECT agent_id, SUM(status='completed') AS ok, SUM(status='failed') AS bad FROM tasks WHERE completed_at >= ? AND completed_at <= ? AND agent_id IS NOT NULL GROUP BY agent_id", [since, until]).map((r) => [r.agent_id, r])) : {};
  const hb = active.map((a) => a.last_heartbeat_at).filter(Boolean).map((t) => Date.parse(until) - Date.parse(t));
  const agents = {
    total: active.length, running: active.filter((a) => a.status === 'running').length, available: active.filter((a) => a.status === 'ready' && !a.current_task_id).length, paused: active.filter((a) => a.status === 'paused').length, blocked: active.filter((a) => a.status === 'blocked').length, failed: active.filter((a) => a.status === 'failed').length, stopped: active.filter((a) => a.status === 'stopped').length, stale: stale.size,
    maxHeartbeatAgeMs: hb.length ? Math.max(...hb) : null,
    perAgent: active.map((a) => { const m = os.registry.metricsView(a), w = perAgent[a.id]; return { id: a.id, name: a.name, role: a.role, businessId: a.business_id, status: a.status, healthStatus: os.registry.assessHealth(a, new Date(Date.parse(until))), dataMode: a.data_mode,
      allTime: { tasksCompleted: m.tasksCompleted, tasksFailed: m.tasksFailed, retries: m.retries, successRate: m.successRate, avgExecutionMs: m.avgExecMs, uptimeMs: m.uptimeMs, estimatedCostMinor: m.estimatedCostMinor, revenueMinor: null },
      window: since ? { completed: w?.ok ?? 0, failed: w?.bad ?? 0 } : null }; }),
  };

  let sup = null;
  if (supervisor) {
    const s = supervisor.status(), ev = since ? Object.fromEntries(db.all("SELECT action, COUNT(*) AS n FROM events WHERE type IN ('supervisor.decision','supervisor.lifecycle') AND ts >= ? AND ts <= ? GROUP BY action", [since, until]).map((r) => [r.action, r.n])) : null;
    const sum = (re) => ev ? Object.entries(ev).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0) : null;
    sup = { state: s.state, lifetime: { cycles: s.counters.cycles, successfulCycles: s.counters.cycles - s.counters.cycleFailures, failedCycles: s.counters.cycleFailures, dispatches: s.counters.dispatched, skippedTasks: s.counters.skipped, recoveries: s.counters.recoveries, decisions: s.counters.decisions }, inFlight: s.inFlight, activeLimits: s.activeLimits,
      window: ev && { dispatches: ev['task.dispatched'] ?? 0, skippedTasks: ev['task.skipped'] ?? 0, limitHits: ev['limit.reached'] ?? 0, recoveryActions: sum(/^recovery\.(lease_released|task_interrupted|task_timeout|agent_restarted)$/), recoveryFailures: sum(/^recovery\.(failed|agent_restart_failed)$/), recoveryEscalations: ev['recovery.refused'] ?? 0, cycleFailures: ev['cycle.failed'] ?? 0 } };
  }

  const byBiz = since ? Object.fromEntries(db.all("SELECT business_id, SUM(status='completed') AS ok, SUM(status='failed') AS bad FROM tasks WHERE completed_at >= ? AND completed_at <= ? AND business_id IS NOT NULL GROUP BY business_id", [since, until]).map((r) => [r.business_id, r])) : {};
  const queue = Object.fromEntries(db.all("SELECT business_id, SUM(status='queued') AS q, SUM(status IN ('assigned','running')) AS a FROM tasks WHERE business_id IS NOT NULL AND status IN ('queued','assigned','running') GROUP BY business_id").map((r) => [r.business_id, r]));
  const businesses = ctx.repos.businesses.list({}, { limit: 20 }).map((b) => { const w = byBiz[b.id], last = db.get('SELECT ts FROM events WHERE business_id = ? ORDER BY ts DESC LIMIT 1', [b.id]);
    return { id: b.id, name: b.name, status: b.status, agents: active.filter((a) => a.business_id === b.id).length, queueDepth: queue[b.id]?.q ?? 0, activeTasks: queue[b.id]?.a ?? 0, window: since ? { completed: w?.ok ?? 0, failed: w?.bad ?? 0, successRate: rate(w?.ok ?? 0, (w?.ok ?? 0) + (w?.bad ?? 0)) } : null, lastActivityAt: last?.ts ?? null, measured: ['tasks', 'agents', 'queue', 'activity'], notMeasured: ['revenue', 'profit', 'sales', 'roi'] }; });
  return { window: { label: win.label, since, until }, tasks, agents, supervisor: sup, businesses };
}
