// Observation: one coherent, bounded snapshot of the system for a Supervisor cycle. Reads only; fabricates nothing.
const taskView = (t) => ({ id: t.id, businessId: t.business_id, type: t.type, status: t.status, priority: t.priority, retryCount: t.retry_count, maxRetries: t.max_retries, deadlineAt: t.deadline_at, nextAttemptAt: t.next_attempt_at, leaseExpiresAt: t.lease_expires_at, agentId: t.agent_id, createdAt: t.created_at, startedAt: t.started_at, timeoutMs: t.timeout_ms, estimatedCostMinor: Number.isInteger(t.metadata?.estimatedCostMinor) ? t.metadata.estimatedCostMinor : null, dataMode: t.data_mode });

export function observe(os, { seq, supervisorState, runId, now, cfg }) {
  const { db, registry, queue } = os, nowIso = new Date(now).toISOString();
  const agentsRaw = registry.list({}).filter((a) => a.status !== 'retired');
  const staleIds = new Set(registry.findStale(new Date(now)).map((a) => a.id));
  const agents = agentsRaw.map((a) => {
    const health = registry.assessHealth(a, new Date(now)), recent = (a.metrics?.recentOutcomes ?? []).slice(-5);
    return { id: a.id, name: a.name, role: a.role, businessId: a.business_id, status: a.status, health: a.health, healthStatus: health, lastHeartbeatAt: a.last_heartbeat_at, lastActivityAt: a.last_activity_at, currentTaskId: a.current_task_id,
      capabilities: a.permissions.capabilities, businesses: a.permissions.businesses, taskTypes: a.config.taskTypes, recentFailures: recent.filter((o) => o === 'fail').length, stale: staleIds.has(a.id),
      available: a.status === 'ready' && !a.current_task_id && !os.runtime(a.id).running && health !== 'stalled', dataMode: a.data_mode };
  });
  const N = cfg.scheduling.maxCandidates;
  // Two bounded reads (by priority, and by age) so old low-priority work stays visible and cannot be starved by a flood of urgent tasks.
  const ready = "status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)";
  const byPriority = db.all(`SELECT id FROM tasks WHERE ${ready} ORDER BY priority ASC, created_at ASC, id ASC LIMIT ?`, [nowIso, N]);
  const byAge = db.all(`SELECT id FROM tasks WHERE ${ready} ORDER BY COALESCE(next_attempt_at, created_at) ASC, id ASC LIMIT ?`, [nowIso, N]);
  const ids = [...new Set([...byPriority, ...byAge].map((r) => r.id))];
  const candidates = ids.map((id) => taskView(queue.get(id)));
  const activeTasks = db.all("SELECT id FROM tasks WHERE status IN ('assigned','running')").map((r) => taskView(queue.get(r.id)));
  const counts = queue.counts();
  const orphanedRunning = activeTasks.filter((t) => t.status === 'running' && !os.isInflight(t.id) && now - Date.parse(t.startedAt ?? nowIso) >= cfg.recovery.orphanGraceMs);
  return {
    seq, at: nowIso, supervisor: { state: supervisorState, runId },
    agents, candidates, activeTasks, inFlightTaskIds: activeTasks.filter((t) => os.isInflight(t.id)).map((t) => t.id),
    queue: { queued: counts.queued ?? 0, retrying: counts.retrying ?? 0, blocked: counts.blocked ?? 0, assigned: counts.assigned ?? 0, running: counts.running ?? 0, failed: counts.failed ?? 0, pending: counts.pending ?? 0 },
    stale: { agents: agents.filter((a) => a.stale).map((a) => a.id), expiredLeases: queue.findExpiredLeases().map((t) => t.id), orphanedRunning: orphanedRunning.map((t) => t.id), timedOut: queue.findTimedOut().map((t) => t.id) },
    failedAgents: agents.filter((a) => a.status === 'failed').map((a) => a.id), stoppedAgents: agents.filter((a) => a.status === 'stopped').map((a) => a.id),
  };
}
