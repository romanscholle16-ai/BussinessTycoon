// Output sanitizing for anything that leaves the server through observability APIs/logs.
// Redacts credential-like keys, drops stack traces, hides filesystem paths, bounds sizes. Deterministic.
const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|apikey|credential|private[_-]?key|authorization|cookie|session)/i;
const DROP_KEY = /^(stack|stacktrace|path|file|filename|cwd|dir|directory)$/i;
const PATH_RE = /(?:[A-Za-z]:\\[^\s"']*|\/(?:home|root|usr|var|tmp|etc|opt|mnt|Users|private)\/[^\s"']*)/g;
const MAX_STR = 300, MAX_KEYS = 40, MAX_ITEMS = 20, MAX_DEPTH = 4;

export function sanitizeText(s, max = MAX_STR) {
  const t = String(s).replace(PATH_RE, '[path]').replace(/\s+at\s+[^\n]*\([^)]*\)/g, '');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
export function sanitizeValue(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return sanitizeText(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => sanitizeValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v).slice(0, MAX_KEYS)) { if (DROP_KEY.test(k)) continue; out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitizeValue(val, depth + 1); }
    return out;
  }
  return String(v);
}
