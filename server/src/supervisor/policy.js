// Deterministic scheduling policy. PURE: (snapshot, config, now, handlers) -> plan. No database access, no side effects.
//
// Order of preference among eligible queued tasks (smaller is better, compared left to right):
//   1. effective priority  = max(0, priority - agingBoost); agingBoost = min(maxAgingBoost, floor(waitedMs / agingStepMs))
//   2. deadline            = earlier absolute deadline first; no deadline sorts last
//   3. business load       = fewer tasks already active/planned for the task's business first (fairness between businesses)
//   4. eligible-since      = older first (next_attempt_at for retried tasks, else created_at)
//   5. task id             = lexicographic (final stable tie-breaker)
// Agent choice for the selected task: specialist (agent.businessId == task.businessId) over shared agents,
//   then least-recently active (last_activity_at asc, never-active first), then agent id.
// Limits stop dispatch: concurrency, per-cycle count, per-cycle retry count, per-cycle estimated cost.
import { assertCan, PermissionError } from '../agents/capabilities.js';

/** null if the agent may run the task; otherwise a short reason code. Mirrors queue.claim + runtime permission checks. */
export function incompatibility(agent, task, handlers) {
  const h = handlers.get(task.type);
  if (!h) return 'no_handler';
  if (!agent.taskTypes.includes(task.type)) return 'task_type_not_supported';
  if (task.agentId && task.agentId !== agent.id) return 'assigned_elsewhere';
  if (agent.businessId && task.businessId && agent.businessId !== task.businessId) return 'business_mismatch';
  try { assertCan({ id: agent.id, permissions: { capabilities: agent.capabilities, businesses: agent.businesses } }, h.capability, { businessId: task.businessId }); }
  catch (e) { if (e instanceof PermissionError) return /may not act on business/.test(e.message) ? 'business_not_permitted' : 'capability_missing'; throw e; }
  return null;
}

const ms = (iso) => Date.parse(iso);
export function rankKey(task, now, cfg, businessLoad) {
  const since = ms(task.nextAttemptAt ?? task.createdAt), waited = Math.max(0, now - since);
  const boost = Math.min(cfg.scheduling.maxAgingBoost, Math.floor(waited / cfg.scheduling.agingStepMs));
  return { effPriority: Math.max(0, task.priority - boost), deadline: task.deadlineAt ? ms(task.deadlineAt) : Infinity, businessLoad: businessLoad.get(task.businessId ?? '') ?? 0, since, boost };
}
const cmpKey = (a, b, ta, tb) => a.effPriority - b.effPriority || (a.deadline === b.deadline ? 0 : a.deadline < b.deadline ? -1 : 1) || a.businessLoad - b.businessLoad || a.since - b.since || (ta.id < tb.id ? -1 : ta.id > tb.id ? 1 : 0);

/**
 * @returns {{dispatch: Array, skipped: Array, limits: Array}}
 *  dispatch: [{taskId, agentId, rank, agentChoice}] in dispatch order
 *  skipped:  [{taskId, reason, detail}]  reason: no_compatible_agent | deferred (agents busy or a limit was hit)
 *  limits:   names of limits that blocked at least one task this cycle
 */
export function planDispatch(snapshot, cfg, now, handlers) {
  const plan = { dispatch: [], skipped: [], limits: [] };
  const L = cfg.limits;
  let capacity = L.maxConcurrentTasks - snapshot.activeTasks.length;
  const load = new Map(); for (const t of snapshot.activeTasks) load.set(t.businessId ?? '', (load.get(t.businessId ?? '') ?? 0) + 1);
  const free = snapshot.agents.filter((a) => a.available);
  const used = new Set(), limitHit = new Set();
  let retries = 0, cost = 0, pending = [...snapshot.candidates];

  // Classify tasks nobody could ever run (independent of availability) so they never block the loop.
  const runnable = [];
  for (const t of pending) {
    const live = snapshot.agents.filter((a) => !['retired'].includes(a.status));
    const reasons = live.map((a) => incompatibility(a, t, handlers));
    if (!reasons.some((r) => r === null)) plan.skipped.push({ taskId: t.id, reason: 'no_compatible_agent', detail: [...new Set(reasons.filter(Boolean))].sort() });
    else runnable.push(t);
  }
  pending = runnable;

  while (pending.length) {
    if (capacity <= 0) { limitHit.add('maxConcurrentTasks'); break; }
    if (plan.dispatch.length >= L.maxDispatchPerCycle) { limitHit.add('maxDispatchPerCycle'); break; }
    // pick the best remaining task that fits the retry/cost limits and has a free compatible agent
    const ranked = pending.map((t) => ({ t, k: rankKey(t, now, cfg, load) })).sort((x, y) => cmpKey(x.k, y.k, x.t, y.t));
    let chosen = null;
    for (const { t, k } of ranked) {
      if (t.retryCount > 0 && retries >= L.maxRetryDispatchPerCycle) { limitHit.add('maxRetryDispatchPerCycle'); continue; }
      const est = t.estimatedCostMinor ?? 0;
      if (L.maxEstimatedCostPerCycleMinor !== null && cost + est > L.maxEstimatedCostPerCycleMinor) { limitHit.add('maxEstimatedCostPerCycleMinor'); continue; }
      const agents = free.filter((a) => !used.has(a.id) && incompatibility(a, t, handlers) === null);
      if (!agents.length) continue; // compatible agents exist but are busy: leave queued, not a decision
      agents.sort((a, b) => (Number(b.businessId === t.businessId && !!t.businessId) - Number(a.businessId === t.businessId && !!t.businessId)) || (a.lastActivityAt ?? '').localeCompare(b.lastActivityAt ?? '') || (a.id < b.id ? -1 : 1));
      chosen = { t, k, agent: agents[0], est }; break;
    }
    if (!chosen) break;
    const { t, k, agent, est } = chosen;
    plan.dispatch.push({ taskId: t.id, agentId: agent.id, rank: { priority: t.priority, effPriority: k.effPriority, agingBoost: k.boost, deadlineAt: t.deadlineAt, businessLoad: k.businessLoad, waitedMs: Math.max(0, now - k.since) }, agentChoice: agent.businessId && agent.businessId === t.businessId ? 'specialist' : 'shared_or_unscoped' });
    used.add(agent.id); capacity--; cost += est; if (t.retryCount > 0) retries++;
    load.set(t.businessId ?? '', (load.get(t.businessId ?? '') ?? 0) + 1);
    pending = pending.filter((x) => x.id !== t.id);
  }
  for (const t of pending) if (!plan.dispatch.some((d) => d.taskId === t.id)) plan.skipped.push({ taskId: t.id, reason: 'deferred', detail: [] });
  plan.limits = [...limitHit].sort();
  return plan;
}
