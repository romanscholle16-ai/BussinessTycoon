// Read-only observability API. Envelope: {ok, timestamp, data, meta}. Errors: {ok:false, error, message, timestamp}.
// Nothing here mutates the system; all filters are validated, bounded, and bound as SQL parameters.
import { ValidationError } from '../agents/validate.js';
import { parseEventQuery, parseMetricsQuery, parseHealthQuery } from '../observability/query.js';
import { createLogger } from '../observability/logger.js';
import { PHASE } from '../version.js';

const log = createLogger('api.observability');
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const okBody = (data, meta = {}) => ({ ok: true, timestamp: new Date().toISOString(), data, meta: { phase: PHASE, ...meta } });
const fail = (res, code, error, message) => send(res, code, { ok: false, error, message, timestamp: new Date().toISOString() });
const ROUTE = /^\/api\/(system\/health|system\/metrics|events(\/[^/]+)?|errors|activity)$/;

/** Returns true if handled. `services.observability` is required for these routes. */
export async function handleObservabilityApi(req, res, services) {
  const url = new URL(req.url, 'http://x'), path = url.pathname, m = ROUTE.exec(path);
  if (!m) return false;
  if (req.method !== 'GET') { fail(res, 405, 'method_not_allowed', 'observability endpoints are read-only'); return true; }
  const obs = services.observability;
  if (!obs) { fail(res, 503, 'observability_unavailable', 'observability is not running'); return true; }
  const p = url.searchParams, now = obs.now();
  try {
    if (path === '/api/system/health') { const h = obs.health(parseHealthQuery(p)); return send(res, 200, okBody(h, { deep: p.get('deep') === '1' || p.get('deep') === 'true' })), true; }
    if (!obs.dbReady()) return fail(res, 503, 'database_unavailable', 'the database is not available'), true;
    if (path === '/api/system/metrics') { const win = parseMetricsQuery(p, { now, startupAt: obs.startedAt }); return send(res, 200, okBody(obs.metrics(win), { window: win.label })), true; }
    if (path === '/api/errors') {
      const q = parseEventQuery(p, { now, allowExtra: ['includeWarnings'] });
      if (q.includeWarnings !== undefined && !['true', 'false'].includes(q.includeWarnings)) throw new ValidationError('includeWarnings must be true or false', 'includeWarnings');
      const r = obs.events.errors(q); return send(res, 200, okBody({ errors: r.errors }, { count: r.errors.length, limit: q.limit, nextBefore: r.nextBefore, since: q.since ?? null })), true;
    }
    const q = parseEventQuery(p, { now });
    if (path === '/api/activity') {
      if (!q.severity && !q.minSeverity) q.minSeverity = 'info'; // activity hides debug diagnostics unless asked
      const r = obs.events.list(q); return send(res, 200, okBody({ events: r.events }, { count: r.events.length, limit: q.limit, nextBefore: r.nextBefore, since: q.since ?? null, counts: obs.events.severityCounts(q.since ?? new Date(now - 86400e3).toISOString()) })), true;
    }
    if (m[2]) { // /api/events/:id
      if (p.size) throw new ValidationError('this endpoint takes no query parameters');
      const t = obs.events.trace(decodeURIComponent(m[2].slice(1))); return t ? send(res, 200, okBody(t)) : fail(res, 404, 'not_found', 'event not found'), true;
    }
    const r = obs.events.list(q); return send(res, 200, okBody({ events: r.events }, { count: r.events.length, limit: q.limit, nextBefore: r.nextBefore, since: q.since ?? null })), true;
  } catch (e) {
    if (e instanceof ValidationError) return fail(res, 400, 'validation', e.message), true;
    if (e?.code === 'unavailable') return fail(res, 503, 'database_unavailable', 'the database is not available'), true;
    log.error('observability_error', { path, error: e }); return fail(res, 500, 'internal', 'internal error'), true;
  }
}
