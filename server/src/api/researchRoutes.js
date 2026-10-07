// Research API. Create/inspect/cancel runs. There is deliberately NO endpoint that fetches an arbitrary URL:
// pages are only fetched by the engine, for discovered sources, through the validated safe retriever.
import { ValidationError } from '../agents/validate.js';
import { NotFoundError, ConflictError, UnavailableError } from '../research/service.js';
import { createLogger } from '../observability/logger.js';
import { PHASE } from '../version.js';

const log = createLogger('api.research');
const MAX_BODY = 32 * 1024;
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (res, code, error, message) => send(res, code, { ok: false, error, message, timestamp: new Date().toISOString() });
const ok = (res, code, data) => send(res, code, { ok: true, timestamp: new Date().toISOString(), data, meta: { phase: PHASE } });

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new ValidationError('content-type must be application/json');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new ValidationError('request body too large'); chunks.push(c); }
  let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw new ValidationError('invalid JSON'); }
  return v;
}
const params = (url, allowed) => {
  const out = {}; for (const k of url.searchParams.keys()) if (!allowed.includes(k)) throw new ValidationError(`unknown parameter "${k}"`, k);
  for (const k of allowed) { const all = url.searchParams.getAll(k); if (all.length > 1) throw new ValidationError(`${k} given more than once`, k); if (all.length) out[k] = all[0]; }
  return out;
};

export async function handleResearchApi(req, res, services) {
  const url = new URL(req.url, 'http://x'), path = url.pathname;
  if (!/^\/api\/research(\/|$)/.test(path)) return false;
  const svc = services.research, m = req.method;
  try {
    if (!svc) return fail(res, 503, 'research_unavailable', 'the research engine is not running (database not ready)'), true;
    let r;
    if (path === '/api/research/status') { if (m !== 'GET') return fail(res, 405, 'method_not_allowed', 'GET only'), true; return ok(res, 200, svc.status()), true; }
    if (path === '/api/research/runs') {
      if (m === 'GET') return ok(res, 200, svc.listRuns(params(url, ['status', 'limit', 'offset']))), true;
      if (m === 'POST') { if ([...url.searchParams.keys()].length) throw new ValidationError('no query parameters accepted'); return ok(res, 201, { run: svc.createRun(await readJson(req)) }), true; }
      return fail(res, 405, 'method_not_allowed', 'GET or POST only'), true;
    }
    if ((r = /^\/api\/research\/runs\/([^/]+)$/.exec(path))) { if (m !== 'GET') return fail(res, 405, 'method_not_allowed', 'GET only'), true; params(url, []); return ok(res, 200, { run: svc.getRun(decodeURIComponent(r[1])) }), true; }
    if ((r = /^\/api\/research\/runs\/([^/]+)\/cancel$/.exec(path))) { if (m !== 'POST') return fail(res, 405, 'method_not_allowed', 'POST only'), true; params(url, []); return ok(res, 200, { run: svc.cancel(decodeURIComponent(r[1])) }), true; }
    if ((r = /^\/api\/research\/runs\/([^/]+)\/(sources|evidence|findings)$/.exec(path))) {
      if (m !== 'GET') return fail(res, 405, 'method_not_allowed', 'GET only'), true;
      const id = decodeURIComponent(r[1]);
      if (r[2] === 'sources') return ok(res, 200, svc.sources(id, params(url, ['status', 'limit', 'offset']))), true;
      if (r[2] === 'evidence') return ok(res, 200, svc.evidence(id, params(url, ['type', 'field', 'limit', 'offset']))), true;
      return ok(res, 200, svc.findings(id, params(url, ['type', 'limit', 'offset']))), true;
    }
    return fail(res, 404, 'not_found', 'unknown endpoint'), true;
  } catch (e) {
    if (e instanceof ValidationError) return fail(res, 400, 'validation', e.message), true;
    if (e instanceof NotFoundError) return fail(res, 404, 'not_found', e.message), true;
    if (e instanceof ConflictError) return fail(res, 409, 'conflict', e.message), true;
    if (e instanceof UnavailableError) return fail(res, 503, 'research_unavailable', e.message), true;
    log.error('research_api_error', { path: path.replace(/[^\w/-]/g, '').slice(0, 80), error: e });
    return fail(res, 500, 'internal', 'internal error'), true;
  }
}
