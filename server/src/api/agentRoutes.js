// Minimal Agent OS inspection API + demo-task controls. Read-only except demo tasks (data_mode='demo', never in production).
import { isId, ValidationError } from '../agents/validate.js';
import { InvalidTransitionError } from '../agents/states.js';

const MAX_BODY = 16 * 1024;
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const err = (res, code, error, message) => send(res, code, { error, message });

export const publicAgent = (os, a) => ({
  id: a.id, name: a.name, role: a.role, businessId: a.business_id, status: a.status, level: a.level, xp: a.xp, reputation: a.reputation,
  health: a.health, healthStatus: os.registry.assessHealth(a), capabilities: a.permissions.capabilities, businesses: a.permissions.businesses,
  taskTypes: a.config.taskTypes, limits: a.config.limits, currentTaskId: a.current_task_id, lastHeartbeatAt: a.last_heartbeat_at, lastActivityAt: a.last_activity_at,
  metrics: os.registry.metricsView(a), dataMode: a.data_mode, createdAt: a.created_at, updatedAt: a.updated_at,
});
export const publicTask = (t) => ({
  id: t.id, type: t.type, businessId: t.business_id, agentId: t.agent_id, parentTaskId: t.parent_task_id, correlationId: t.correlation_id, status: t.status, priority: t.priority,
  payload: t.payload, result: t.result, retryCount: t.retry_count, maxRetries: t.max_retries, timeoutMs: t.timeout_ms, error: t.error_code ? { code: t.error_code, message: t.error_message } : null,
  createdAt: t.created_at, startedAt: t.started_at, completedAt: t.completed_at, nextAttemptAt: t.next_attempt_at, deadlineAt: t.deadline_at, dataMode: t.data_mode,
});

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ValidationError('content-type must be application/json');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new ValidationError('request body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new ValidationError('invalid JSON'); }
}
const qInt = (v, d, min, max) => { if (v == null) return d; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError('invalid numeric query parameter'); return n; };

/** Returns true if the request was handled. */
export async function handleAgentApi(req, res, config, services) {
  const url = new URL(req.url, 'http://x'), path = url.pathname, q = url.searchParams;
  const m = req.method;
  const isAgentApi = /^\/api\/(agents|tasks|agent-os|demo\/tasks)(\/|$)/.test(path);
  if (!isAgentApi) return false;
  const os = services.agentOS;
  if (!os) { err(res, 503, 'agent_os_unavailable', 'Agent OS is not running (database not ready)'); return true; }
  try {
    let r;
    if (m === 'GET' && path === '/api/agents') {
      const status = q.get('status') ?? undefined, role = q.get('role') ?? undefined, business = q.get('business') ?? undefined;
      if (business && !isId(business)) throw new ValidationError('invalid business');
      return send(res, 200, { agents: os.registry.list({ status, role, business, available: q.get('available') === 'true' }).map((a) => publicAgent(os, a)) }), true;
    }
    if (m === 'GET' && (r = /^\/api\/agents\/([^/]+)(\/status)?$/.exec(path))) {
      if (!isId(r[1])) throw new ValidationError('invalid agent id');
      const a = os.registry.get(r[1]); if (!a) return err(res, 404, 'not_found', 'agent not found'), true;
      if (r[2]) { const p = publicAgent(os, a); return send(res, 200, { id: p.id, status: p.status, healthStatus: p.healthStatus, health: p.health, currentTaskId: p.currentTaskId, lastHeartbeatAt: p.lastHeartbeatAt, lastActivityAt: p.lastActivityAt }), true; }
      return send(res, 200, { agent: publicAgent(os, a) }), true;
    }
    if (m === 'GET' && path === '/api/tasks') {
      const f = {}; for (const [k, col] of [['status', 'status'], ['business', 'business_id'], ['agent', 'agent_id'], ['type', 'type']]) { const v = q.get(k); if (v) { if (k !== 'status' && k !== 'type' && !isId(v)) throw new ValidationError(`invalid ${k}`); f[col] = v; } }
      return send(res, 200, { tasks: os.queue.list(f, { limit: qInt(q.get('limit'), 50, 1, 200), offset: qInt(q.get('offset'), 0, 0, 100000), orderBy: 'created_at desc' }).map(publicTask) }), true;
    }
    if (m === 'GET' && (r = /^\/api\/tasks\/([^/]+)$/.exec(path))) {
      if (!isId(r[1])) throw new ValidationError('invalid task id');
      const t = os.queue.get(r[1]); return t ? send(res, 200, { task: publicTask(t) }) : err(res, 404, 'not_found', 'task not found'), true;
    }
    if (m === 'GET' && path === '/api/agent-os/status') return send(res, 200, os.status()), true;
    if (path.startsWith('/api/demo/tasks')) {
      if (config.env === 'production') return err(res, 403, 'forbidden', 'demo tasks are disabled in production'), true;
      if (m === 'POST' && path === '/api/demo/tasks') {
        const b = await readJson(req);
        if (typeof b.type !== 'string' || !b.type.startsWith('demo.') || !os.handlers.get(b.type)) throw new ValidationError('type must be a registered demo.* task type');
        const t = os.queue.submit({ type: b.type, businessId: b.businessId ?? null, priority: b.priority, payload: b.payload, maxRetries: b.maxRetries, timeoutMs: b.timeoutMs, dataMode: 'demo' });
        return send(res, 201, { task: publicTask(t) }), true;
      }
      if (m === 'POST' && (r = /^\/api\/demo\/tasks\/([^/]+)\/cancel$/.exec(path))) {
        if (!isId(r[1])) throw new ValidationError('invalid task id');
        const t = os.queue.get(r[1]); if (!t) return err(res, 404, 'not_found', 'task not found'), true;
        if (t.data_mode !== 'demo') return err(res, 403, 'forbidden', 'only demo tasks can be cancelled through this endpoint'), true;
        return send(res, 200, { task: publicTask(os.cancelTask(t.id, 'cancelled via demo API')) }), true;
      }
    }
    err(res, m === 'GET' || m === 'POST' ? 404 : 405, 'not_found', 'unknown endpoint'); return true;
  } catch (e) {
    if (e instanceof ValidationError) return err(res, 400, 'validation', e.message), true;
    if (e instanceof InvalidTransitionError) return err(res, 409, 'invalid_transition', e.message), true;
    console.error(JSON.stringify({ level: 'error', msg: 'api_error', error: String(e.message).slice(0, 200) }));
    return err(res, 500, 'internal', 'internal error'), true;
  }
}
