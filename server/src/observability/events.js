// Event queries and serialization on the append-only `events` table. Read-only. All SQL is fixed text with bound parameters.
import { toPublic, toStored, storedAtLeast, SEVERITIES } from './severity.js';
import { sanitizeValue, sanitizeText } from './sanitize.js';
import { ValidationError, isId } from '../agents/validate.js';

const SELECT = `SELECT e.rowid AS rid, e.id, e.ts, e.type, e.severity, e.business_id, e.agent_id, e.task_id, e.action, e.result, e.cost_minor, e.currency, e.error, e.metadata_json, e.data_mode,
  t.correlation_id AS t_corr, t.parent_task_id AS t_parent, t.status AS t_status, t.type AS t_type, t.retry_count AS t_retry, t.max_retries AS t_max
  FROM events e LEFT JOIN tasks t ON t.id = e.task_id`;
const ERROR_CODE_RE = /^([a-z][a-z0-9_]{1,40}):\s/;

export function serializeEvent(r) {
  let meta = {}; try { meta = JSON.parse(r.metadata_json); } catch { /* keep {} */ }
  const component = r.type.split('.')[0];
  const reason = typeof meta.reason === 'string' ? meta.reason : null;
  const errText = r.error ? String(r.error) : null, code = errText ? (ERROR_CODE_RE.exec(errText)?.[1] ?? null) : null;
  const retry = r.t_retry != null && (r.type.startsWith('task.') || r.type.startsWith('recovery.') || meta.retry_count != null) ? { count: r.t_retry, max: r.t_max } : null;
  const { reason: _r, runId, seq, ...rest } = meta;
  const verb = r.type.split('.')[1], generic = /^(transition:|claimed by|started by|task )/.test(r.action) || r.action === r.type;
  const subject = r.type.startsWith('task.') ? `Task ${r.t_type ?? r.task_id ?? ''}`.trim() : r.type.startsWith('agent.') ? `Agent ${r.agent_id ?? ''}`.trim() : null;
  const isDecision = r.type === 'supervisor.decision' || r.type === 'supervisor.lifecycle';
  const message = reason ?? (subject ? `${subject} ${verb}${generic ? '' : ` (${r.action})`}` : isDecision ? r.action : r.action);
  return {
    id: r.id, ts: r.ts, kind: r.type, name: isDecision ? r.action : r.type, action: sanitizeText(r.action, 120), component, severity: toPublic(r.severity),
    message: sanitizeText(message, 240), result: r.result ? sanitizeText(r.result, 80) : null,
    businessId: r.business_id, agentId: r.agent_id, taskId: r.task_id, parentTaskId: r.t_parent ?? null, correlationId: r.t_corr ?? null,
    supervisorRunId: typeof runId === 'string' ? runId : null, cycle: Number.isInteger(seq) ? seq : null,
    error: errText ? { code, message: sanitizeText(code ? errText.replace(ERROR_CODE_RE, '') : errText, 240) } : null,
    retry, cost: r.cost_minor > 0 ? { amountMinor: r.cost_minor, currency: r.currency } : null, // cost is null unless a real cost was recorded
    dataMode: r.data_mode, details: sanitizeValue(rest),
  };
}

export class EventQueries {
  constructor(db) { this.db = db; }
  #where(q) {
    const f = [], p = [];
    if (q.since) { f.push('e.ts >= ?'); p.push(q.since); } if (q.until) { f.push('e.ts < ?'); p.push(q.until); }
    if (q.kind) { f.push("(e.type = ? OR (e.type IN ('supervisor.decision','supervisor.lifecycle') AND e.action = ?))"); p.push(q.kind, q.kind); } // kind matches an event type or a Supervisor decision name
    if (q.component) { f.push('e.type >= ? AND e.type < ?'); p.push(`${q.component}.`, `${q.component}/`); } // index-friendly prefix range ('/' follows '.')
    if (q.severity) { f.push('e.severity = ?'); p.push(toStored(q.severity)); }
    if (q.minSeverity) { const s = storedAtLeast(q.minSeverity); f.push(`e.severity IN (${s.map(() => '?').join(',')})`); p.push(...s); }
    if (q.business) { f.push('e.business_id = ?'); p.push(q.business); }
    if (q.agent) { f.push('e.agent_id = ?'); p.push(q.agent); }
    if (q.task) { f.push('e.task_id = ?'); p.push(q.task); }
    if (q.correlation) { f.push('e.task_id IN (SELECT id FROM tasks WHERE correlation_id = ?)'); p.push(q.correlation); }
    if (q.before) { const c = this.db.get('SELECT rowid AS rid, ts FROM events WHERE id = ?', [q.before]); if (!c) throw new ValidationError('unknown cursor', 'before'); f.push('(e.ts < ? OR (e.ts = ? AND e.rowid < ?))'); p.push(c.ts, c.ts, c.rid); }
    return { sql: f.length ? `WHERE ${f.join(' AND ')}` : '', params: p };
  }
  /** Newest first; stable cursor pagination via `before=<event id>`. Returns {events, nextBefore}. */
  list(q) {
    const w = this.#where(q), limit = Math.min(q.limit ?? 50, 200);
    const rows = this.db.all(`${SELECT} ${w.sql} ORDER BY e.ts DESC, e.rowid DESC LIMIT ?`, [...w.params, limit + 1]);
    const page = rows.slice(0, limit);
    return { events: page.map(serializeEvent), nextBefore: rows.length > limit ? page[page.length - 1].id : null };
  }
  count(q) { const w = this.#where(q); return this.db.get(`SELECT COUNT(*) AS n FROM events e ${w.sql}`, w.params).n; }
  get(id) { if (!isId(id)) throw new ValidationError('invalid event id', 'id'); const r = this.db.get(`${SELECT} WHERE e.id = ?`, [id]); return r ? serializeEvent(r) : null; }

  /** Everything that explains one event: the task's full timeline (task, agent, Supervisor decisions, retries, result). */
  trace(id) {
    const ev = this.get(id); if (!ev) return null;
    const timeline = ev.taskId ? this.db.all(`${SELECT} WHERE e.task_id = ? ORDER BY e.ts ASC, e.rowid ASC LIMIT 100`, [ev.taskId]).map(serializeEvent) : [];
    const task = ev.taskId ? this.db.get('SELECT id, type, status, priority, retry_count, max_retries, error_code, agent_id, business_id, correlation_id, parent_task_id, created_at, started_at, completed_at FROM tasks WHERE id = ?', [ev.taskId]) : null;
    return { event: ev, task: task && { id: task.id, type: task.type, status: task.status, priority: task.priority, retryCount: task.retry_count, maxRetries: task.max_retries, errorCode: task.error_code, agentId: task.agent_id, businessId: task.business_id, correlationId: task.correlation_id, parentTaskId: task.parent_task_id, createdAt: task.created_at, startedAt: task.started_at, completedAt: task.completed_at }, timeline };
  }

  /** Failures with context: current task/agent state, retryability, related Supervisor decisions, and a plain-language explanation. */
  errors(q) {
    const base = { ...q, minSeverity: q.includeWarnings === 'true' ? 'warning' : 'error' }; delete base.includeWarnings; delete base.severity;
    const { events, nextBefore } = this.list(base);
    const items = events.map((ev) => {
      const t = ev.taskId ? this.db.get('SELECT status, type, retry_count, max_retries, next_attempt_at FROM tasks WHERE id = ?', [ev.taskId]) : null;
      const a = ev.agentId ? this.db.get('SELECT name, status, health_status FROM agents WHERE id = ?', [ev.agentId]) : null;
      const decisions = ev.taskId ? this.db.all("SELECT id, ts, action FROM events WHERE task_id = ? AND type IN ('supervisor.decision') ORDER BY ts DESC LIMIT 5", [ev.taskId]).map((d) => ({ id: d.id, ts: d.ts, kind: d.action })) : [];
      const retryable = t ? ['retrying', 'queued'].includes(t.status) : null;
      const parts = [];
      if (t) parts.push(`Task ${t.type} is now ${t.status}`);
      if (ev.error) parts.push(`error ${ev.error.code ?? 'unclassified'}: ${ev.error.message}`); else parts.push(ev.message);
      if (t) parts.push(retryable ? `will retry (${t.retry_count}/${t.max_retries} retries used)` : t.status === 'failed' ? `not retried (${t.retry_count}/${t.max_retries} retries used)` : `${t.retry_count}/${t.max_retries} retries used`);
      return { event: ev, task: t && { id: ev.taskId, type: t.type, status: t.status, retryCount: t.retry_count, maxRetries: t.max_retries, nextAttemptAt: t.next_attempt_at }, agent: a && { id: ev.agentId, name: a.name, status: a.status, healthStatus: a.health_status }, retryable, relatedDecisions: decisions, explanation: sanitizeText(parts.join('; ') + '.', 400) };
    });
    return { errors: items, nextBefore };
  }
  /** Counts by public severity within a window (indexed by (severity, ts)). */
  severityCounts(sinceIso) {
    const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    for (const r of this.db.all('SELECT severity, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY severity', [sinceIso])) out[toPublic(r.severity)] += r.n;
    return out;
  }
  latest() { const r = this.db.get(`${SELECT} ORDER BY e.ts DESC, e.rowid DESC LIMIT 1`); return r ? serializeEvent(r) : null; }
}
