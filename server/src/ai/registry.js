// Provider registry: constructs adapters from config and tracks their runtime state (availability, breaker, rate limits, stats).
// State is in memory only; every meaningful change is reported through onStateChange (the service turns it into an event).
import { ClaudeProvider } from './providers/claude.js';
import { OpenAiProvider } from './providers/openai.js';
import { OllamaProvider } from './providers/ollama.js';
import { MockProvider } from './providers/mock.js';
import { FreebuffProvider } from './providers/freebuff.js';
import { PROVIDER_NAMES } from './config.js';

export const STATUSES = ['configured', 'available', 'unavailable', 'disabled', 'misconfigured', 'rate_limited', 'temporarily_failed'];

export function buildProviders(config, { env = {}, overrides = {} } = {}) {
  const p = config.providers, out = {};
  out.claude = new ClaudeProvider(p.claude, { apiKey: env.ANTHROPIC_API_KEY });
  out.openai = new OpenAiProvider(p.openai, { apiKey: env.OPENAI_API_KEY });
  out.ollama = new OllamaProvider(p.ollama);
  out.mock = new MockProvider(p.mock);
  out.freebuff = new FreebuffProvider(p.freebuff);
  return { ...out, ...overrides };
}

export class ProviderRegistry {
  constructor({ config, providers, clock = { now: () => Date.now() }, onStateChange = () => {} }) {
    this.config = config; this.providers = providers; this.clock = clock; this.onStateChange = onStateChange; this.state = {};
    for (const n of PROVIDER_NAMES) this.state[n] = { status: null, reason: null, until: null, failures: 0, lastOkAt: null, lastError: null, probeAt: 0, requests: 0, ok: 0, failed: 0, totalLatencyMs: 0 };
  }
  get secrets() { return Object.values(this.providers).flatMap((p) => p.secrets ?? []); }
  names() { return PROVIDER_NAMES.filter((n) => this.providers[n]); }
  #base(name) {
    const cfg = this.config.providers[name], d = this.providers[name].describe();
    if (cfg.enabled === false) return { status: 'disabled', reason: 'disabled by configuration', d };
    if (!d.configured) return { status: 'misconfigured', reason: d.problem, d };
    return { status: 'configured', reason: null, d };
  }
  /** Effective view at `now`: configuration problems and runtime state combined. Expired cooldowns return to `configured` (half-open). */
  view(name, now = this.clock.now()) {
    const s = this.state[name], b = this.#base(name);
    let status = b.status, reason = b.reason;
    if (status === 'configured') {
      if (s.until !== null && now >= s.until) { s.until = null; if (['rate_limited', 'temporarily_failed', 'unavailable'].includes(s.status)) this.#set(name, 'configured', 'cooldown elapsed; trying again'); }
      if (s.status && s.status !== 'configured' && (s.until === null || now < s.until)) { status = s.status; reason = s.reason; }
      else if (s.lastOkAt !== null && s.status === 'available') status = 'available';
    }
    return { name, kind: this.providers[name].kind, enabled: this.config.providers[name].enabled !== false, configured: b.d.configured, status, reason, model: b.d.model, models: b.d.models, capabilities: b.d.capabilities, endpointOrigin: b.d.endpointOrigin, integration: b.d.integration, until: s.until, lastOkAt: s.lastOkAt, lastError: s.lastError, stats: { requests: s.requests, ok: s.ok, failed: s.failed, avgLatencyMs: s.ok ? Math.round(s.totalLatencyMs / s.ok) : null } };
  }
  eligible(name, now) { const v = this.view(name, now); return v.status === 'configured' || v.status === 'available'; }
  #set(name, status, reason, until = null) {
    const s = this.state[name], from = s.status ?? 'configured';
    s.status = status; s.reason = reason; s.until = until;
    // Only transitions into or out of a problem state are meaningful; configured <-> available is routine and not reported.
    const bad = ['misconfigured', 'unavailable', 'temporarily_failed', 'rate_limited'];
    if (from !== status && (bad.includes(status) || bad.includes(from))) this.onStateChange({ provider: name, from, to: status, reason });
  }
  recordSuccess(name, latencyMs) { const s = this.state[name]; s.requests++; s.ok++; s.totalLatencyMs += latencyMs; s.failures = 0; s.lastOkAt = this.clock.now(); s.lastError = null; this.#set(name, 'available', null); }
  recordFailure(name, err) {
    const s = this.state[name], now = this.clock.now(), b = this.config.breaker; s.requests++; s.failed++; s.lastError = { category: err.category, at: new Date(now).toISOString() };
    if (['authentication', 'authorization', 'configuration'].includes(err.category)) { this.#set(name, 'misconfigured', `${err.category} failed; fix the configuration or credentials and restart`); return; }
    if (err.category === 'rate_limit') { this.#set(name, 'rate_limited', 'rate limited by the provider', now + Math.min(err.retryAfterMs ?? b.cooldownMs, 3_600_000)); return; }
    if (['timeout', 'unavailable', 'provider_error', 'malformed_response'].includes(err.category)) { s.failures++; if (s.failures >= b.failureThreshold) this.#set(name, 'temporarily_failed', `${s.failures} consecutive failures (last: ${err.category})`, now + b.cooldownMs); }
  }
  recordProbe(name, result) {
    const s = this.state[name], now = this.clock.now(); s.probeAt = now;
    if (result.ok) { if (['unavailable', 'misconfigured'].includes(s.status)) this.#set(name, 'configured', null); return; }
    this.#set(name, result.category === 'configuration' ? 'misconfigured' : 'unavailable', result.message ?? 'probe failed', now + this.config.probeTtlMs);
  }
  needsProbe(name, now) { const s = this.state[name]; return typeof this.providers[name].probe === 'function' && this.view(name, now).status !== 'disabled' && this.view(name, now).configured && now - s.probeAt >= this.config.probeTtlMs; }
}
