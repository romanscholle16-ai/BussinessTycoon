// Structured application logger for the long-running service: one JSON object per line on stdout/stderr.
// Durable history lives in the append-only `events` table, so events are NOT mirrored here (no duplicates, no unbounded log files).
// Logs cover process-level facts only: startup/shutdown, database readiness, unexpected API/loop errors.
import { sanitizeText, sanitizeValue } from './sanitize.js';
import { SEVERITIES, rank } from './severity.js';

export function createLogger(component, { sink = console, level = 'info', now = () => new Date() } = {}) {
  const min = Math.max(0, SEVERITIES.indexOf(level === 'warn' ? 'warning' : level));
  const emit = (sev, msg, fields = {}) => {
    if (rank(sev) < min) return;
    const { errorCode = null, error = null, ...ids } = fields;
    const line = { ts: now().toISOString(), level: sev, component, msg: sanitizeText(msg, 200), ...sanitizeValue(ids), ...(errorCode ? { errorCode: sanitizeText(errorCode, 64) } : {}), ...(error ? { error: sanitizeText(error?.message ?? error, 200) } : {}) };
    const text = JSON.stringify(line);
    (sev === 'error' || sev === 'critical' ? sink.error : sev === 'warning' ? (sink.warn ?? sink.error) : sink.log).call(sink, text);
  };
  return { debug: (m, f) => emit('debug', m, f), info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warning', m, f), error: (m, f) => emit('error', m, f), critical: (m, f) => emit('critical', m, f), child: (c) => createLogger(`${component}.${c}`, { sink, level, now }) };
}
export const logger = createLogger('tycoon', { level: process.env.TYCOON_LOG_LEVEL ?? 'info' });
