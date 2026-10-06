// Secret redaction for anything that can leave the AI layer (errors, events, logs, API output).
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted-key]'], [/sk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|x-goog-api-key)\s*[:=]\s*(?:bearer\s+|basic\s+)?["']?[^\s"',;]+/gi, '$1: [redacted]'],
  [/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/(password|passwd|secret|token)\s*[:=]\s*["']?[^\s"',;]+/gi, '$1: [redacted]'],
  [/\b[A-Fa-f0-9]{40,}\b/g, '[redacted-hex]'],
];
const PATH_RE = /(?:[A-Za-z]:\\[^\s"']*|\/(?:home|root|usr|var|tmp|etc|opt|mnt|Users|private)\/[^\s"']*)/g;

/** Redacts known credential shapes, any exact secret values supplied, and filesystem paths; bounds length. */
export function redact(text, { secrets = [], max = 300 } = {}) {
  let s = String(text ?? '');
  for (const v of secrets) if (typeof v === 'string' && v.length >= 6) s = s.split(v).join('[redacted]');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  s = s.replace(PATH_RE, '[path]');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
