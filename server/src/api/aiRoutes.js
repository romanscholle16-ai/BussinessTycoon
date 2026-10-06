// Read-only AI provider status. Never returns credentials, headers, prompts or file paths.
import { ValidationError } from '../agents/validate.js';
import { createLogger } from '../observability/logger.js';
import { PHASE } from '../version.js';

const log = createLogger('api.ai');
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (res, code, error, message) => send(res, code, { ok: false, error, message, timestamp: new Date().toISOString() });

export async function handleAiApi(req, res, services) {
  const url = new URL(req.url, 'http://x');
  if (!/^\/api\/ai(\/|$)/.test(url.pathname)) return false;
  if (req.method !== 'GET') { fail(res, 405, 'method_not_allowed', 'AI endpoints are read-only'); return true; }
  if (url.pathname !== '/api/ai/providers') { fail(res, 404, 'not_found', 'unknown endpoint'); return true; }
  if (!services.ai) { fail(res, 503, 'ai_unavailable', 'the AI service is not running'); return true; }
  try {
    for (const k of url.searchParams.keys()) if (k !== 'refresh') throw new ValidationError(`unknown parameter "${k}"`, k);
    if (url.searchParams.getAll('refresh').length > 1) throw new ValidationError('refresh given more than once', 'refresh');
    const r = url.searchParams.get('refresh'); if (r !== null && !['0', '1', 'true', 'false'].includes(r)) throw new ValidationError('refresh must be 0/1/true/false', 'refresh');
    const data = await services.ai.status({ refresh: r === '1' || r === 'true' });
    send(res, 200, { ok: true, timestamp: new Date().toISOString(), data, meta: { phase: PHASE } });
  } catch (e) {
    if (e instanceof ValidationError) fail(res, 400, 'validation', e.message);
    else { log.error('ai_status_error', { error: e }); fail(res, 500, 'internal', 'internal error'); }
  }
  return true;
}
