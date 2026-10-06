// Input validation shared by the Agent OS and the API.
export class ValidationError extends Error { constructor(message, field) { super(message); this.name = 'ValidationError'; this.code = 'validation'; this.field = field; } }
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SECRET_KEY_RE = /(secret|password|passwd|token(?!s)|api[_-]?key|apikey|credential|private[_-]?key|authorization|cookie)/i;

export function assertId(v, field = 'id') { if (typeof v !== 'string' || !ID_RE.test(v)) throw new ValidationError(`${field} must match ${ID_RE}`, field); return v; }
export const isId = (v) => typeof v === 'string' && ID_RE.test(v);
export function assertInt(v, field, min, max) { if (!Number.isInteger(v) || v < min || v > max) throw new ValidationError(`${field} must be an integer ${min}..${max}`, field); return v; }
export function assertPlainObject(v, field) { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(`${field} must be an object`, field); return v; }

/** Rejects any object key that looks like a credential, at any depth (agent config and task payloads must hold no secrets). */
export function assertNoSecrets(value, path = 'config') {
  if (Array.isArray(value)) value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (SECRET_KEY_RE.test(k)) throw new ValidationError(`${path}.${k}: credential-like keys are not allowed (keep secrets in environment configuration)`, path); assertNoSecrets(v, `${path}.${k}`); }
}
export function assertJsonSize(value, field, maxBytes = 16384) { if (Buffer.byteLength(JSON.stringify(value ?? null)) > maxBytes) throw new ValidationError(`${field} is too large (max ${maxBytes} bytes)`, field); }
