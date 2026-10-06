// The AI service: the ONLY thing Agent OS handlers talk to. Provider-neutral request in, provider-neutral result out.
// validate -> select providers -> cost ceiling -> bounded attempts (retry, then fail over) -> normalized result -> one summary event.
import { assertNoSecrets, assertJsonSize, isId, ValidationError } from '../agents/validate.js';
import { CATEGORIES, FAILOVER, AiError } from './errors.js';
import { normalizeAiConfig, PROVIDER_NAMES, aiConfigFromEnv } from './config.js';
import { buildProviders, ProviderRegistry } from './registry.js';
import { selectProviders } from './selection.js';
import { estimateMaxCostUsd, actualCostUsd, roundUsd } from './pricing.js';
import { redact } from './redact.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('ai');
const REQUEST_KEYS = ['prompt', 'system', 'maxTokens', 'temperature', 'jsonSchema', 'timeoutMs', 'provider', 'model', 'allowFallback', 'prefer', 'maxCostUsd', 'purpose', 'context', 'signal', 'dataMode'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/, PURPOSE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });

function pricingFor(cfg, model) { const p = cfg.pricing ?? {}; return p[model] ?? p['*'] ?? null; }

export function createAiService({ config: rawConfig = {}, env = {}, repos = null, clock = { now: () => Date.now() }, providers: overrides = {}, fetchImpl = globalThis.fetch, sleepImpl = sleep, allowMock = true } = {}) {
  const { config, problems, enabled } = normalizeAiConfig(aiConfigFromEnv(env, rawConfig), { allowMock });
  const providers = buildProviders(config, { env, overrides });
  const events = []; // state-change events are buffered until a request context exists
  const registry = new ProviderRegistry({ config, providers, clock, onStateChange: (c) => { recordEvent({ type: 'ai.provider_state', severity: c.to === 'available' || c.to === 'configured' ? 'info' : 'warn', action: `${c.provider}:${c.to}`, result: c.to, meta: { provider: c.provider, from: c.from, to: c.to, reason: redact(c.reason ?? '', { secrets: registry?.secrets }) }, provider: c.provider }); } });
  const inflight = new Set();
  const secrets = () => registry.secrets;

  function recordEvent({ type, severity = 'info', action, result, error = null, meta = {}, context = {}, provider, dataMode }) {
    if (!repos) return;
    const mode = dataMode ?? (providers[provider]?.kind === 'mock' ? 'test' : 'live'), row = { ts: new Date(clock.now()).toISOString(), type, severity, action, result, error, metadata: meta, data_mode: mode };
    const ids = { business_id: context.businessId ?? null, agent_id: context.agentId ?? null, task_id: context.taskId ?? null };
    try { repos.events.insert({ ...row, ...ids }); }
    catch { try { repos.events.insert(row); } catch (e) { log.warn('ai_event_not_recorded', { errorCode: 'event_write_failed' }); } } // observability must never break an AI call
  }

  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('request must be an object', 'request');
    for (const k of Object.keys(input)) if (!REQUEST_KEYS.includes(k)) throw new ValidationError(`unknown request field "${k}"`, k);
    const L = config.limits, r = {};
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new ValidationError('prompt must be a non-empty string', 'prompt');
    r.prompt = input.prompt; r.system = input.system ?? null;
    if (r.system !== null && (typeof r.system !== 'string' || r.system.length > 20000)) throw new ValidationError('system must be a string up to 20000 characters', 'system');
    if (r.prompt.length + (r.system?.length ?? 0) > L.maxInputChars) throw new ValidationError(`input exceeds ${L.maxInputChars} characters`, 'prompt');
    for (const s of secrets()) if (s.length >= 6 && (r.prompt.includes(s) || r.system?.includes(s))) throw new ValidationError('the prompt contains a configured credential and was not sent', 'prompt');
    r.maxTokens = input.maxTokens ?? L.defaultMaxOutputTokens;
    if (!Number.isInteger(r.maxTokens) || r.maxTokens < 1 || r.maxTokens > L.maxOutputTokens) throw new ValidationError(`maxTokens must be an integer 1-${L.maxOutputTokens}`, 'maxTokens');
    r.temperature = input.temperature ?? null; if (r.temperature !== null && !(typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2)) throw new ValidationError('temperature must be a number 0-2', 'temperature');
    r.jsonSchema = input.jsonSchema ?? null; if (r.jsonSchema !== null) { if (typeof r.jsonSchema !== 'object' || Array.isArray(r.jsonSchema)) throw new ValidationError('jsonSchema must be an object', 'jsonSchema'); assertNoSecrets(r.jsonSchema, 'jsonSchema'); assertJsonSize(r.jsonSchema, 'jsonSchema'); }
    r.timeoutMs = input.timeoutMs ?? config.timeoutMs; if (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 100 || r.timeoutMs > config.timeoutMs) throw new ValidationError(`timeoutMs must be an integer 100-${config.timeoutMs}`, 'timeoutMs');
    r.provider = input.provider ?? null; if (r.provider !== null && !PROVIDER_NAMES.includes(r.provider)) throw new ValidationError('unknown provider', 'provider');
    r.model = input.model ?? null; if (r.model !== null && (typeof r.model !== 'string' || !MODEL_RE.test(r.model))) throw new ValidationError('invalid model name', 'model');
    r.allowFallback = input.allowFallback === true; r.prefer = input.prefer ?? null; if (r.prefer !== null && r.prefer !== 'cost') throw new ValidationError('prefer must be "cost"', 'prefer');
    r.maxCostUsd = input.maxCostUsd ?? null; if (r.maxCostUsd !== null && !(typeof r.maxCostUsd === 'number' && r.maxCostUsd >= 0)) throw new ValidationError('maxCostUsd must be a non-negative number', 'maxCostUsd');
    r.purpose = input.purpose ?? 'general'; if (!PURPOSE_RE.test(r.purpose)) throw new ValidationError('invalid purpose', 'purpose');
    r.context = {}; for (const [k, v] of Object.entries(input.context ?? {})) { if (!['taskId', 'agentId', 'businessId', 'correlationId'].includes(k)) throw new ValidationError(`unknown context field "${k}"`, k); if (v != null && !isId(v)) throw new ValidationError(`invalid context.${k}`, k); r.context[k] = v ?? null; }
    r.signal = input.signal ?? null; r.dataMode = input.dataMode ?? null; if (r.dataMode !== null && !['demo', 'test', 'live'].includes(r.dataMode)) throw new ValidationError('invalid dataMode', 'dataMode');
    // The effective cost ceiling is the stricter of the request's and the global one.
    const ceilings = [r.maxCostUsd, config.limits.maxCostPerRequestUsd].filter((x) => x !== null); r.ceilingUsd = ceilings.length ? Math.min(...ceilings) : null;
    return r;
  }

  const fail = (req, category, message, extra = {}) => ({ ok: false, provider: extra.provider ?? null, model: extra.model ?? null, error: { category, message: extra.trusted ? String(message).slice(0, 300) : redact(message, { secrets: secrets() }), retryable: extra.retryable ?? false, retryAfterMs: extra.retryAfterMs ?? null, ...(extra.details ? { details: extra.details } : {}) }, attempts: extra.attempts ?? [], latencyMs: extra.latencyMs ?? 0, timestamp: new Date(clock.now()).toISOString(), correlation: req?.context ?? {}, cost: { estimatedMaxUsd: null, actualUsd: null, basis: 'unknown' } });

  async function probeIfNeeded(names) {
    for (const n of names) {
      const now = clock.now(); if (!registry.needsProbe(n, now)) continue;
      const c = new AbortController(); const res = await providers[n].probe({ signal: c.signal, timeoutMs: config.probeTimeoutMs, fetchImpl }).catch(() => ({ ok: false, category: 'unavailable', message: 'probe failed' }));
      registry.recordProbe(n, res);
    }
  }

  async function attemptOnce(name, req, remainingMs) {
    const prov = providers[name], timeoutMs = Math.max(50, Math.min(req.timeoutMs, remainingMs)), controller = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort('timeout'); }, timeoutMs), onCancel = () => controller.abort('cancel');
    req.signal?.addEventListener('abort', onCancel, { once: true }); inflight.add(controller);
    const started = clock.now();
    try {
      const raced = await Promise.race([prov.complete({ model: req.model ?? registry.view(name).model, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens, temperature: req.temperature, jsonSchema: req.jsonSchema }, { signal: controller.signal, timeoutMs, fetchImpl }), new Promise((_, rej) => controller.signal.addEventListener('abort', () => rej(new AiError(timedOut ? 'timeout' : 'cancelled', timedOut ? `no response within ${timeoutMs}ms` : 'request cancelled', { retryable: timedOut })), { once: true }))]);
      return { raw: raced, latencyMs: Math.max(0, clock.now() - started) };
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError('unknown', 'unexpected provider failure', { retryable: false });
      if (timedOut && err.category !== 'timeout') { err.category = 'timeout'; err.retryable = true; }
      err.message = redact(err.message, { secrets: secrets() }); err.latencyMs = Math.max(0, clock.now() - started); throw err;
    } finally { clearTimeout(timer); req.signal?.removeEventListener('abort', onCancel); inflight.delete(controller); }
  }

  /** Never throws for request/provider problems: always returns {ok:true,...} or {ok:false,error:{category,...}}. */
  async function complete(input) {
    const t0 = clock.now(); let req;
    try { req = normalize(input); } catch (e) { return fail(null, 'invalid_request', e instanceof ValidationError ? e.message : 'invalid request', { trusted: true }); }
    const done = (res) => finish(req, res, t0);
    if (!enabled) return done(fail(req, 'disabled', problems.length ? `AI is disabled (${problems[0]})` : 'AI is disabled (activeProvider is "none")'));

    const order = [config.activeProvider, ...config.fallbackProviders].filter((n) => n !== 'none'), want = req.provider ? [req.provider] : order;
    await probeIfNeeded([...new Set([...want, ...(req.allowFallback ? order : [])])]);
    const costOf = (name) => { const v = registry.view(name); const p = pricingFor(config.providers[name], req.model ?? v.model); return estimateMaxCostUsd(p, req.prompt.length + (req.system?.length ?? 0), req.maxTokens); };
    const sel = selectProviders({ request: req, config, registry, now: clock.now(), costOf });
    if (!sel.candidates.length) {
      const st = sel.rejected.map((r) => r.status);
      const cat = st.includes('rate_limited') ? 'rate_limit' : st.some((s) => ['unavailable', 'temporarily_failed'].includes(s)) ? 'unavailable' : 'configuration';
      return done(fail(req, cat, `no AI provider is available (${sel.rejected.map((r) => `${r.provider}: ${r.reason}`).join('; ') || 'none configured'})`, { retryable: cat !== 'configuration', details: sel.rejected }));
    }

    const attempts = [], deadline = t0 + config.maxTotalMs; let lastErr = null, budgetRejections = 0, tried = 0;
    for (const name of sel.candidates) {
      if (tried >= config.maxProviderAttempts) break;
      const v = registry.view(name), model = req.model ?? v.model, pricing = pricingFor(config.providers[name], model);
      const est = estimateMaxCostUsd(pricing, req.prompt.length + (req.system?.length ?? 0), req.maxTokens);
      if (req.ceilingUsd !== null && (est === null || est > req.ceilingUsd)) { budgetRejections++; attempts.push({ provider: name, model, ok: false, category: 'budget_exceeded', retry: 0, latencyMs: 0, note: est === null ? 'cost unknown' : `estimated max $${roundUsd(est)} exceeds ceiling $${req.ceilingUsd}` }); lastErr = new AiError('budget_exceeded', est === null ? `cost for ${name}/${model} is unknown, so the request was not sent under a cost ceiling` : `estimated worst-case cost $${roundUsd(est)} exceeds the $${req.ceilingUsd} ceiling`, { retryable: false }); continue; }
      tried++;
      for (let retry = 0; retry <= config.maxRetries; retry++) {
        const remaining = deadline - clock.now(); if (remaining < 50) { lastErr = new AiError('timeout', 'total time budget for this AI request was used up'); break; }
        try {
          const { raw, latencyMs } = await attemptOnce(name, req, remaining);
          const res = buildSuccess(name, model, pricing, est, raw, req);
          if (res.error) throw res.error;
          registry.recordSuccess(name, latencyMs); attempts.push({ provider: name, model, ok: true, category: null, retry, latencyMs });
          res.attempts = attempts; res.latencyMs = clock.now() - t0;
          return done(res);
        } catch (e) {
          const err = e instanceof AiError ? e : new AiError('unknown', 'unexpected failure'); lastErr = err;
          attempts.push({ provider: name, model, ok: false, category: err.category, retry, latencyMs: err.latencyMs ?? 0 });
          if (!FAILOVER.has(err.category)) return done(fail(req, err.category, err.message, { provider: name, model, retryable: false, attempts, latencyMs: clock.now() - t0 }));
          const wait = Math.min(config.retryMaxMs, err.retryAfterMs ?? config.retryBaseMs * 2 ** retry);
          const willRetry = err.retryable && retry < config.maxRetries && !(err.retryAfterMs !== null && err.retryAfterMs > config.retryMaxMs) && clock.now() + wait < deadline;
          if (!willRetry) { registry.recordFailure(name, err); break; } // provider state changes only when this provider is given up on
          await sleepImpl(wait, req.signal); if (req.signal?.aborted) return done(fail(req, 'cancelled', 'request cancelled', { attempts }));
        }
      }
      const idx = sel.candidates.indexOf(name), next = sel.candidates.slice(idx + 1).find(Boolean);
      if (next && tried < config.maxProviderAttempts) recordEvent({ type: 'ai.fallback', severity: 'warn', action: `${name}->${next}`, result: 'fallback', error: `${lastErr?.category}: ${lastErr?.message}`, meta: { from: name, to: next, reason: lastErr?.category, purpose: req.purpose }, context: req.context, provider: name, dataMode: req.dataMode ?? undefined });
    }
    if (budgetRejections && tried === 0) return done(fail(req, 'budget_exceeded', lastErr.message, { retryable: false, attempts, latencyMs: clock.now() - t0 }));
    const cat = lastErr?.category ?? 'unavailable';
    return done(fail(req, cat, `AI request failed after ${attempts.length} attempt(s) (${cat}): ${lastErr?.message ?? 'no provider answered'}`, { retryable: lastErr?.retryable ?? true, retryAfterMs: lastErr?.retryAfterMs ?? null, attempts, latencyMs: clock.now() - t0, details: sel.rejected }));
  }

  function buildSuccess(name, model, pricing, est, raw, req) {
    const bad = (m) => ({ error: new AiError('malformed_response', m) });
    if (!raw || typeof raw !== 'object' || typeof raw.output !== 'string') return bad('provider result had no text output');
    if (raw.output.length > 500_000) return bad('provider output exceeded the size limit');
    const usage = raw.usage && (Number.isInteger(raw.usage.inputTokens) || Number.isInteger(raw.usage.outputTokens)) ? { inputTokens: Number.isInteger(raw.usage.inputTokens) ? raw.usage.inputTokens : null, outputTokens: Number.isInteger(raw.usage.outputTokens) ? raw.usage.outputTokens : null } : null;
    let structured = null;
    if (req.jsonSchema) { try { structured = JSON.parse(raw.output); } catch { return bad('provider output was not valid JSON'); } }
    const actual = roundUsd(actualCostUsd(pricing, usage));
    return { ok: true, provider: name, model: raw.model ?? model, output: raw.output, structured, finishReason: typeof raw.finishReason === 'string' ? raw.finishReason.slice(0, 40) : 'stop', requestId: typeof raw.requestId === 'string' ? redact(raw.requestId, { max: 100 }) : null, usage,
      cost: { estimatedMaxUsd: roundUsd(est), actualUsd: actual, basis: actual !== null ? 'actual' : 'unknown', pricing: pricing ? 'configured' : 'unknown' }, ignoredParameters: raw.ignored ?? [], attempts: [], latencyMs: 0, timestamp: new Date(clock.now()).toISOString(), correlation: req.context };
  }

  /** One summary event per call (success or failure); fallbacks and provider state changes are separate events. */
  function finish(req, res, t0) {
    res.latencyMs = res.latencyMs || Math.max(0, clock.now() - t0);
    const summary = res.attempts.slice(0, 10).map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, category: a.category, retry: a.retry, latencyMs: a.latencyMs }));
    const meta = { purpose: req.purpose, provider: res.provider, model: res.model, attempts: summary, retries: res.attempts.filter((a) => a.retry > 0).length, fallbacks: new Set(res.attempts.map((a) => a.provider)).size - 1, latencyMs: res.latencyMs, promptChars: req.prompt.length, outputChars: res.ok ? res.output.length : null,
      inputTokens: res.usage?.inputTokens ?? null, outputTokens: res.usage?.outputTokens ?? null, costUsd: res.ok ? res.cost.actualUsd : null, costBasis: res.ok ? res.cost.basis : null, estimatedMaxUsd: res.cost?.estimatedMaxUsd ?? null, requestId: res.requestId ?? null, finishReason: res.ok ? res.finishReason : null };
    if (res.ok || res.error.category !== 'disabled') { // a disabled AI layer is reported by the failing task, not by a flood of events
      recordEvent({ type: res.ok ? 'ai.completed' : 'ai.failed', severity: res.ok ? 'info' : 'error', action: req.purpose, result: res.ok ? 'ok' : res.error.category, error: res.ok ? null : `${res.error.category}: ${res.error.message}`, meta, context: req.context, provider: res.provider ?? req.provider ?? config.activeProvider, dataMode: req.dataMode ?? undefined });
    }
    return res;
  }

  /** Read-only, credential-free provider overview. `refresh` runs the bounded Ollama probe (the only live check). */
  async function status({ refresh = false } = {}) {
    if (refresh) { const now = clock.now(); for (const n of registry.names()) { const v = registry.view(n, now); if (typeof providers[n].probe === 'function' && v.status !== 'disabled' && v.configured) registry.state[n].probeAt = 0; } await probeIfNeeded(registry.names()); }
    const now = clock.now();
    return { enabled, activeProvider: config.activeProvider, fallbackProviders: config.fallbackProviders, selection: config.selection, problems: problems.map((p) => redact(p, { secrets: secrets() })), limits: { timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, maxTotalMs: config.maxTotalMs, maxProviderAttempts: config.maxProviderAttempts, ...config.limits },
      providers: registry.names().map((n) => { const v = registry.view(n, now), cfg = config.providers[n], price = pricingFor(cfg, v.model); return { name: n, kind: v.kind, role: n === config.activeProvider ? 'active' : config.fallbackProviders.includes(n) ? 'fallback' : 'unused', enabled: v.enabled, configured: v.configured, status: v.status, reason: v.reason ? redact(v.reason, { secrets: secrets() }) : null, model: v.model, models: v.models, capabilities: v.capabilities, endpoint: v.endpointOrigin, integration: v.integration, rateLimitedUntil: v.status === 'rate_limited' && v.until ? new Date(v.until).toISOString() : null, retryAt: v.until && v.status !== 'rate_limited' ? new Date(v.until).toISOString() : null, lastOkAt: v.lastOkAt ? new Date(v.lastOkAt).toISOString() : null, lastError: v.lastError, stats: v.stats, pricing: price ? { known: true, inputPerMTokUsd: price.inputPerMTokUsd, outputPerMTokUsd: price.outputPerMTokUsd } : { known: false } }; }) };
  }
  function close() { for (const c of inflight) c.abort('cancel'); inflight.clear(); }
  return { complete, status, close, registry, config, enabled, problems, categories: CATEGORIES };
}
