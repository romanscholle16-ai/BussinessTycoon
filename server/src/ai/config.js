// AI configuration: defaults, validation, and env mapping. Credentials are NEVER part of this object (read separately from the environment).
import { BUILTIN_CLAUDE_PRICING } from './pricing.js';

export const PROVIDER_NAMES = ['claude', 'openai', 'ollama', 'mock', 'freebuff'];
export const DEFAULT_AI = {
  activeProvider: 'none', fallbackProviders: [], selection: 'preferred',
  timeoutMs: 30000, maxRetries: 1, retryBaseMs: 500, retryMaxMs: 4000, maxTotalMs: 60000, maxProviderAttempts: 3, probeTtlMs: 30000, probeTimeoutMs: 2000,
  limits: { maxInputChars: 100000, defaultMaxOutputTokens: 1024, maxOutputTokens: 16000, maxCostPerRequestUsd: null },
  breaker: { failureThreshold: 3, cooldownMs: 30000 },
  providers: {
    claude: { enabled: true, model: 'claude-opus-5-5', endpoint: 'https://api.anthropic.com', pricing: BUILTIN_CLAUDE_PRICING },
    openai: { enabled: true, model: null, endpoint: 'https://api.openai.com/v1', pricing: {} },
    ollama: { enabled: true, model: null, endpoint: 'http://127.0.0.1:11434', pricing: { '*': { inputPerMTokUsd: 0, outputPerMTokUsd: 0 } } }, // explicit: local inference has no per-token fee (hardware/energy not counted)
    mock: { enabled: false, model: 'mock-1', pricing: {} }, // deterministic test provider; auto-enabled only when named as active/fallback (never in production)
    freebuff: { enabled: false, model: null },
  },
};
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Returns the normalized endpoint (no trailing slash) or throws. https required; plain http only for loopback; no credentials, query or fragment. */
export function validateEndpoint(value) {
  let u; try { u = new URL(value); } catch { throw new Error('endpoint is not a valid URL'); }
  if (String(value).length > 200) throw new Error('endpoint is too long');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error('endpoint must use https (http is allowed only for localhost)');
  if (u.username || u.password) throw new Error('endpoint must not contain credentials');
  if (u.search || u.hash) throw new Error('endpoint must not contain a query string or fragment');
  return u.origin + u.pathname.replace(/\/+$/, '');
}
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const num = (v, d, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : d);
const int = (v, d, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : d);

/**
 * @returns {{config, problems: string[], enabled: boolean}}  Invalid values never crash startup: they are reported in
 * `problems`, and an invalid provider is marked misconfigured (its `problem` field) instead of silently used.
 */
export function normalizeAiConfig(input = {}, { allowMock = true } = {}) {
  const problems = [], d = DEFAULT_AI, raw = input ?? {};
  const c = {
    activeProvider: raw.activeProvider ?? d.activeProvider, fallbackProviders: Array.isArray(raw.fallbackProviders) ? [...new Set(raw.fallbackProviders)] : [], selection: raw.selection ?? d.selection,
    timeoutMs: int(raw.timeoutMs, d.timeoutMs, 100, 300000), maxRetries: int(raw.maxRetries, d.maxRetries, 0, 5), retryBaseMs: int(raw.retryBaseMs, d.retryBaseMs, 0, 60000), retryMaxMs: int(raw.retryMaxMs, d.retryMaxMs, 0, 120000),
    maxTotalMs: int(raw.maxTotalMs, d.maxTotalMs, 100, 600000), maxProviderAttempts: int(raw.maxProviderAttempts, d.maxProviderAttempts, 1, 5), probeTtlMs: int(raw.probeTtlMs, d.probeTtlMs, 1000, 3600000), probeTimeoutMs: int(raw.probeTimeoutMs, d.probeTimeoutMs, 100, 30000),
    limits: { maxInputChars: int(raw.limits?.maxInputChars, d.limits.maxInputChars, 1, 1_000_000), defaultMaxOutputTokens: int(raw.limits?.defaultMaxOutputTokens, d.limits.defaultMaxOutputTokens, 1, 64000), maxOutputTokens: int(raw.limits?.maxOutputTokens, d.limits.maxOutputTokens, 1, 128000), maxCostPerRequestUsd: raw.limits?.maxCostPerRequestUsd == null ? null : num(raw.limits.maxCostPerRequestUsd, null, 0, 1000) },
    breaker: { failureThreshold: int(raw.breaker?.failureThreshold, d.breaker.failureThreshold, 1, 20), cooldownMs: int(raw.breaker?.cooldownMs, d.breaker.cooldownMs, 100, 3600000) },
    providers: {},
  };
  if (raw.limits?.maxCostPerRequestUsd != null && c.limits.maxCostPerRequestUsd === null) problems.push('limits.maxCostPerRequestUsd is invalid and was ignored (no global cost ceiling applied)');
  if (!['preferred', 'cost'].includes(c.selection)) { problems.push(`selection "${c.selection}" is invalid; using "preferred"`); c.selection = 'preferred'; }
  c.limits.defaultMaxOutputTokens = Math.min(c.limits.defaultMaxOutputTokens, c.limits.maxOutputTokens);
  let enabled = true;
  if (c.activeProvider === 'none' || c.activeProvider === '' || c.activeProvider == null) { enabled = false; c.activeProvider = 'none'; }
  else if (!PROVIDER_NAMES.includes(c.activeProvider)) { problems.push(`activeProvider "${c.activeProvider}" is not a known provider; AI is disabled`); enabled = false; c.activeProvider = 'none'; }
  c.fallbackProviders = c.fallbackProviders.filter((p) => { if (PROVIDER_NAMES.includes(p) && p !== c.activeProvider) return true; problems.push(`fallback provider "${p}" ignored (unknown or same as active)`); return false; });
  for (const name of PROVIDER_NAMES) {
    const base = d.providers[name], r = raw.providers?.[name] ?? {}, named = name === c.activeProvider || c.fallbackProviders.includes(name), p = { enabled: r.enabled ?? (name === 'mock' ? named : base.enabled), model: r.model ?? base.model, endpoint: r.endpoint ?? base.endpoint, pricing: { ...(base.pricing ?? {}), ...(r.pricing ?? {}) }, problem: null };
    if (p.model !== null && p.model !== undefined && !MODEL_RE.test(String(p.model))) { p.problem = 'model name is invalid'; p.model = null; }
    if (p.endpoint) { try { p.endpoint = validateEndpoint(p.endpoint); } catch (e) { p.problem = `endpoint: ${e.message}`; p.endpoint = null; } }
    if (name === 'mock' && !allowMock && (p.enabled || named)) { p.enabled = false; problems.push('mock provider is not allowed in production'); if (c.activeProvider === 'mock') { enabled = false; c.activeProvider = 'none'; } c.fallbackProviders = c.fallbackProviders.filter((x) => x !== 'mock'); }
    if (r.maxTokensParam) p.maxTokensParam = r.maxTokensParam === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens';
    if (p.problem) problems.push(`${name}: ${p.problem}`);
    c.providers[name] = p;
  }
  return { config: c, problems, enabled };
}

/** Maps non-secret AI_* environment variables onto a config object. */
export function aiConfigFromEnv(env, base = {}) {
  const out = { ...base, providers: { ...(base.providers ?? {}) } }, set = (name, patch) => { out.providers[name] = { ...(out.providers[name] ?? {}), ...patch }; };
  if (env.AI_ACTIVE_PROVIDER !== undefined) out.activeProvider = env.AI_ACTIVE_PROVIDER.trim().toLowerCase();
  if (env.AI_FALLBACK_PROVIDERS !== undefined) out.fallbackProviders = env.AI_FALLBACK_PROVIDERS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (env.AI_SELECTION) out.selection = env.AI_SELECTION;
  const n = (k) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : undefined);
  if (n('AI_TIMEOUT_MS') !== undefined) out.timeoutMs = n('AI_TIMEOUT_MS'); if (n('AI_MAX_RETRIES') !== undefined) out.maxRetries = n('AI_MAX_RETRIES');
  if (n('AI_MAX_COST_PER_REQUEST_USD') !== undefined) out.limits = { ...(out.limits ?? {}), maxCostPerRequestUsd: n('AI_MAX_COST_PER_REQUEST_USD') };
  if (env.AI_CLAUDE_MODEL) set('claude', { model: env.AI_CLAUDE_MODEL }); if (env.AI_CLAUDE_ENDPOINT) set('claude', { endpoint: env.AI_CLAUDE_ENDPOINT });
  if (env.AI_OPENAI_MODEL) set('openai', { model: env.AI_OPENAI_MODEL }); if (env.AI_OPENAI_ENDPOINT) set('openai', { endpoint: env.AI_OPENAI_ENDPOINT });
  if (env.AI_OLLAMA_MODEL) set('ollama', { model: env.AI_OLLAMA_MODEL }); if (env.AI_OLLAMA_ENDPOINT) set('ollama', { endpoint: env.AI_OLLAMA_ENDPOINT });
  return out;
}
