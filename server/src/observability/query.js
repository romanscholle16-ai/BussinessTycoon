// Strict validation of observability query parameters. Whitelisted keys only; every value is bounded; no SQL fragments come from input.
import { ValidationError, isId } from '../agents/validate.js';
import { SEVERITIES } from './severity.js';

export const MAX_LIMIT = 200, DEFAULT_LIMIT = 50, MAX_WINDOW_MS = 30 * 86400e3, DEFAULT_EVENT_WINDOW_MS = 24 * 3600e3;
export const WINDOWS = { '5m': 5 * 60e3, '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3 };
const KIND_RE = /^[a-z][a-z0-9_.]{0,63}$/, COMPONENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const check = (cond, msg, field) => { if (!cond) throw new ValidationError(msg, field); };
function iso(v, field) { const t = Date.parse(v); check(typeof v === 'string' && v.length <= 40 && !Number.isNaN(t), `${field} must be an ISO date`, field); return t; }
function int(v, field, min, max, d) { if (v == null) return d; check(/^\d{1,6}$/.test(v), `${field} must be an integer ${min}-${max}`, field); const n = Number(v); check(n >= min && n <= max, `${field} must be an integer ${min}-${max}`, field); return n; }
function rejectUnknown(params, allowed) { for (const k of params.keys()) check(allowed.includes(k), `unknown parameter "${k}"`, k); for (const k of allowed) check(params.getAll(k).length <= 1, `parameter "${k}" given more than once`, k); }

/** Event/activity/error list query. */
export function parseEventQuery(params, { now, allowExtra = [] } = {}) {
  rejectUnknown(params, ['limit', 'before', 'kind', 'component', 'severity', 'minSeverity', 'business', 'agent', 'task', 'correlation', 'since', 'until', 'window', ...allowExtra]);
  const q = { limit: int(params.get('limit'), 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT) };
  const get = (k) => params.get(k) || null;
  if (get('kind')) { check(KIND_RE.test(get('kind')), 'invalid kind', 'kind'); q.kind = get('kind'); }
  if (get('component')) { check(COMPONENT_RE.test(get('component')), 'invalid component', 'component'); q.component = get('component'); }
  if (get('severity')) { const s = get('severity') === 'warn' ? 'warning' : get('severity'); check(SEVERITIES.includes(s), `severity must be one of ${SEVERITIES.join(', ')}`, 'severity'); q.severity = s; }
  if (get('minSeverity')) { const s = get('minSeverity') === 'warn' ? 'warning' : get('minSeverity'); check(SEVERITIES.includes(s), `minSeverity must be one of ${SEVERITIES.join(', ')}`, 'minSeverity'); q.minSeverity = s; }
  check(!(q.severity && q.minSeverity), 'use either severity or minSeverity', 'severity');
  for (const [k, key] of [['business', 'business'], ['agent', 'agent'], ['task', 'task'], ['correlation', 'correlation'], ['before', 'before']]) if (get(k)) { check(isId(get(k)), `invalid ${k}`, k); q[key] = get(k); }
  let since = get('since') ? iso(get('since'), 'since') : null, until = get('until') ? iso(get('until'), 'until') : null;
  if (get('window')) { check(!since, 'use either window or since', 'window'); check(WINDOWS[get('window')], `window must be one of ${Object.keys(WINDOWS).join(', ')}`, 'window'); since = now - WINDOWS[get('window')]; }
  if (since !== null || until !== null) { const lo = since ?? 0, hi = until ?? now; check(hi >= lo, 'until must not be before since', 'until'); check(since === null || hi - lo <= MAX_WINDOW_MS, 'time range may not exceed 30 days', 'since'); }
  // Unfiltered listings are bounded to a default window so they stay cheap on a long-lived database.
  const narrowed = q.task || q.agent || q.correlation || q.before;
  if (since === null && !narrowed) since = now - DEFAULT_EVENT_WINDOW_MS;
  if (since !== null) q.since = new Date(since).toISOString(); if (until !== null) q.until = new Date(until).toISOString();
  for (const k of allowExtra) if (params.has(k)) q[k] = params.get(k);
  return q;
}

/** Metrics window: current | 5m | 1h | 24h | 7d | startup | explicit since/until (<= 30 days). */
export function parseMetricsQuery(params, { now, startupAt }) {
  rejectUnknown(params, ['window', 'since', 'until']);
  const w = params.get('window') ?? '1h';
  if (params.get('since') || params.get('until')) {
    const since = params.get('since') ? iso(params.get('since'), 'since') : null; const until = params.get('until') ? iso(params.get('until'), 'until') : now;
    check(since !== null, 'since is required with until', 'since'); check(until > since && until - since <= MAX_WINDOW_MS, 'range must be positive and at most 30 days', 'since');
    return { label: 'custom', since: new Date(since).toISOString(), until: new Date(until).toISOString() };
  }
  if (w === 'current') return { label: 'current', since: null, until: new Date(now).toISOString() };
  if (w === 'startup') return { label: 'startup', since: startupAt ?? new Date(now - WINDOWS['1h']).toISOString(), until: new Date(now).toISOString() };
  check(WINDOWS[w], `window must be one of current, startup, ${Object.keys(WINDOWS).join(', ')}`, 'window');
  return { label: w, since: new Date(now - WINDOWS[w]).toISOString(), until: new Date(now).toISOString() };
}
export function parseHealthQuery(params) { rejectUnknown(params, ['deep']); const d = params.get('deep'); check(d === null || d === '0' || d === '1' || d === 'true' || d === 'false', 'deep must be 0/1/true/false', 'deep'); return { deep: d === '1' || d === 'true' }; }
