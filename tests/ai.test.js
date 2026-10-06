import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiService } from '../server/src/ai/service.js';
import { MockProvider } from '../server/src/ai/providers/mock.js';
import { normalizeAiConfig, aiConfigFromEnv, validateEndpoint } from '../server/src/ai/config.js';
import { selectProviders } from '../server/src/ai/selection.js';
import { ProviderRegistry, buildProviders } from '../server/src/ai/registry.js';
import { estimateMaxCostUsd, actualCostUsd } from '../server/src/ai/pricing.js';
import { redact } from '../server/src/ai/redact.js';
import { requestJson } from '../server/src/ai/http.js';
import { registerAiHandlers } from '../server/src/ai/handlers.js';
import { AiError } from '../server/src/ai/errors.js';
import { createDatabaseService as makeDb } from '../server/src/db/service.js';
import { seedDemo } from '../server/src/db/seed.js';
import { createAgentOS } from '../server/src/agents/os.js';
import { Supervisor } from '../server/src/supervisor/supervisor.js';
import { createObservability } from '../server/src/observability/index.js';
import { createApp } from '../server/src/api/app.js';
import { loadConfig, loadDotEnv, ROOT } from '../server/src/config/index.js';
import { aiBlock } from '../client/public/js/ui.js';

const KEY = 'sk-ant-TESTSECRET0123456789abcdef', OKEY = 'sk-proj-OPENAISECRET0123456789abcdef';
class Clock { constructor() { this.t = Date.parse('2030-01-01T00:00:00.000Z'); } now() { return this.t; } advance(ms) { this.t += ms; } }
const mkAi = ({ cfg = {}, env = {}, providers = {}, fetchImpl, repos = null, clock = new Clock() } = {}) => {
  const waits = []; const ai = createAiService({ config: cfg, env, providers, fetchImpl, repos, clock, sleepImpl: async (ms) => { waits.push(ms); clock.advance(ms); } }); return { ai, clock, waits };
};
const mock = (script, cfg = {}, opts = {}) => new MockProvider(cfg, { script, ...opts });
/** fetch double: handler(url, init) -> {status, body, headers} | throws. Honors AbortSignal. */
const fakeFetch = (handler) => { const calls = []; const f = (url, init) => new Promise((resolve, reject) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); Promise.resolve().then(() => handler(url, init, calls.length)).then((r) => { if (r === 'hang') return; resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} })); }, reject); }); f.calls = calls; return f; };
const claudeOk = (over = {}) => ({ status: 200, headers: { 'request-id': 'req_abc' }, body: { id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }], usage: { input_tokens: 1000, output_tokens: 500 }, ...over } });

test('provider contract: normalized success, deterministic, optional metadata, structured output', async () => {
  const { ai } = mkAi({ cfg: { activeProvider: 'mock', providers: { mock: { pricing: { 'mock-1': { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } } } } }, providers: { mock: mock(null) } });
  const a = await ai.complete({ prompt: 'hello world', purpose: 'unit.test' }), b = await ai.complete({ prompt: 'hello world', purpose: 'unit.test' });
  assert.equal(a.ok, true); assert.deepEqual([a.provider, a.model, a.output, a.finishReason], ['mock', 'mock-1', 'mock:hello world', 'stop']); assert.deepEqual(a.usage, { inputTokens: 3, outputTokens: 4 });
  assert.equal(a.output, b.output); assert.deepEqual(a.usage, b.usage); assert.equal(a.attempts.length, 1); assert.ok(a.timestamp && typeof a.latencyMs === 'number');
  assert.ok(!('raw' in a) && !('response' in a)); assert.equal(a.cost.basis, 'actual'); assert.equal(a.cost.actualUsd, (3 * 1 + 4 * 2) / 1e6);
  // provider reports no usage: no token counts or cost are invented
  const { ai: ai2 } = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: mock([{ output: 'x', usage: null }]) } });
  const n = await ai2.complete({ prompt: 'p' }); assert.equal(n.ok, true); assert.equal(n.usage, null); assert.equal(n.cost.actualUsd, null); assert.equal(n.cost.basis, 'unknown'); assert.equal(n.cost.pricing, 'unknown');
  // structured output: parsed on success, malformed JSON is a failure (no fake object)
  const { ai: ai3 } = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: mock([{ output: '{"a":1}' }, { output: 'not json' }]) } });
  const s = await ai3.complete({ prompt: 'p', jsonSchema: { type: 'object' } }); assert.deepEqual(s.structured, { a: 1 });
  const bad = await ai3.complete({ prompt: 'p', jsonSchema: { type: 'object' } }); assert.equal(bad.ok, false); assert.equal(bad.error.category, 'malformed_response');
  // malformed provider result
  const { ai: ai4 } = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: mock([{ malformed: true }]) } });
  const m = await ai4.complete({ prompt: 'p' }); assert.equal(m.ok, false); assert.equal(m.error.category, 'malformed_response'); assert.ok(m.attempts.length >= 1);
});

test('configuration: a fresh install has AI disabled and everything still works; invalid settings are reported, not fatal', async () => {
  const { ai } = mkAi(); const r = await ai.complete({ prompt: 'hi' });
  assert.equal(ai.enabled, false); assert.equal(r.ok, false); assert.equal(r.error.category, 'disabled'); assert.equal(r.error.retryable, false);
  const st = await ai.status(); assert.equal(st.enabled, false); assert.equal(st.activeProvider, 'none'); const by = Object.fromEntries(st.providers.map((p) => [p.name, p]));
  assert.equal(by.claude.status, 'misconfigured'); assert.match(by.claude.reason, /ANTHROPIC_API_KEY/); assert.equal(by.openai.status, 'misconfigured'); assert.equal(by.ollama.status, 'misconfigured'); assert.equal(by.freebuff.status, 'disabled'); assert.equal(by.mock.status, 'disabled');
  assert.equal(mkAi({ cfg: { activeProvider: 'none' } }).ai.enabled, false);
  const unk = normalizeAiConfig({ activeProvider: 'skynet', selection: 'random', timeoutMs: -5 }); assert.equal(unk.enabled, false); assert.ok(unk.problems.some((p) => /skynet/.test(p))); assert.equal(unk.config.timeoutMs, 30000); assert.equal(unk.config.selection, 'preferred');
  // endpoints: https only (http only for localhost), no credentials/query/fragment
  assert.equal(validateEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1'); assert.equal(validateEndpoint('http://localhost:11434'), 'http://localhost:11434');
  for (const bad of ['http://evil.example.com', 'https://user:pw@api.example.com', 'https://api.example.com/?k=1', 'https://api.example.com/#x', 'ftp://x', 'not a url']) assert.throws(() => validateEndpoint(bad), Error, bad);
  const bp = normalizeAiConfig({ activeProvider: 'openai', providers: { openai: { endpoint: 'https://user:topsecret@api.example.com', model: 'bad model!' } } });
  assert.equal(bp.config.providers.openai.endpoint, null); assert.equal(bp.config.providers.openai.model, null); assert.ok(bp.problems.every((p) => !p.includes('topsecret')), 'credentials in a URL are never echoed');
  const { ai: ai2 } = mkAi({ cfg: { activeProvider: 'openai', providers: { openai: { endpoint: 'http://remote.example.com', model: 'm' } } }, env: { OPENAI_API_KEY: OKEY } }); const r2 = await ai2.complete({ prompt: 'x' });
  assert.equal(r2.ok, false); assert.equal(r2.error.category, 'configuration'); assert.ok(!JSON.stringify(r2).includes(OKEY));
  // env mapping carries only non-secret settings; credentials never enter the config object
  const env = { AI_ACTIVE_PROVIDER: 'Claude', AI_FALLBACK_PROVIDERS: 'ollama, openai', AI_CLAUDE_MODEL: 'claude-sonnet-5-5', AI_OLLAMA_MODEL: 'llama3', AI_MAX_COST_PER_REQUEST_USD: '0.05', AI_TIMEOUT_MS: '5000', ANTHROPIC_API_KEY: KEY };
  const cfg = aiConfigFromEnv(env, {}); assert.equal(cfg.activeProvider, 'claude'); assert.deepEqual(cfg.fallbackProviders, ['ollama', 'openai']); assert.ok(!JSON.stringify(cfg).includes(KEY));
  const n = normalizeAiConfig(cfg); assert.equal(n.config.providers.claude.model, 'claude-sonnet-5-5'); assert.equal(n.config.limits.maxCostPerRequestUsd, 0.05); assert.equal(n.config.timeoutMs, 5000);
  const lc = loadConfig({ AI_ACTIVE_PROVIDER: 'mock', ANTHROPIC_API_KEY: KEY }); assert.equal(lc.ai.activeProvider, 'mock'); assert.ok(!JSON.stringify(lc).includes(KEY));
  // mock is refused in production; Freebuff can never be selected
  const prod = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: mock(null) } }); assert.equal(prod.ai.enabled, true);
  const p2 = createAiService({ config: { activeProvider: 'mock' }, allowMock: false }); assert.equal(p2.enabled, false); assert.ok(p2.problems.some((p) => /production/.test(p)));
  const fb = mkAi({ cfg: { activeProvider: 'freebuff' } }); const fr = await fb.ai.complete({ prompt: 'x' }); assert.equal(fr.ok, false); assert.notEqual(fr.error.category, undefined); assert.match(JSON.stringify((await fb.ai.status()).providers.find((p) => p.name === 'freebuff')), /not integrated|disabled/);
  // .env loader: sets only unset variables, handles comments/quotes, never logs
  const dir = mkdtempSync(join(tmpdir(), 'tycoon-env-')); try { writeFileSync(join(dir, '.env'), '# c\nAI_ACTIVE_PROVIDER=claude\nA_QUOTED="va lue"\nEXISTING=fromfile # note\nBAD LINE\n'); const e = { EXISTING: 'keep' }; assert.equal(loadDotEnv(e, join(dir, '.env')), 2); assert.deepEqual([e.AI_ACTIVE_PROVIDER, e.A_QUOTED, e.EXISTING], ['claude', 'va lue', 'keep']); assert.equal(loadDotEnv({}, join(dir, 'missing')), 0); } finally { rmSync(dir, { recursive: true }); }
});

test('Claude adapter: request shape, response mapping, error mapping, key never leaks', async () => {
  const f = fakeFetch(() => claudeOk()); const { ai } = mkAi({ cfg: { activeProvider: 'claude' }, env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: f });
  const r = await ai.complete({ prompt: 'Say hi', system: 'Be brief', maxTokens: 200, temperature: 0.2, jsonSchema: { type: 'object' }, purpose: 'unit.claude' });
  const c = f.calls[0]; assert.equal(c.url, 'https://api.anthropic.com/v1/messages'); assert.equal(c.init.headers['x-api-key'], KEY); assert.equal(c.init.headers['anthropic-version'], '2023-06-01'); assert.equal(c.init.redirect, 'error');
  assert.deepEqual([c.body.model, c.body.max_tokens, c.body.system], ['claude-opus-5-5', 200, 'Be brief']); assert.deepEqual(c.body.messages, [{ role: 'user', content: 'Say hi' }]); assert.ok(!('temperature' in c.body), 'sampling parameters are not sent to models that reject them'); assert.deepEqual(c.body.output_config.format.type, 'json_schema');
  assert.equal(r.ok, false, 'not JSON: the reply "Hello world" was requested as structured output'); assert.equal(r.error.category, 'malformed_response');
  const f2 = fakeFetch(() => claudeOk()); const { ai: ai2 } = mkAi({ cfg: { activeProvider: 'claude' }, env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: f2 });
  const ok = await ai2.complete({ prompt: 'Say hi', temperature: 0.7 }); assert.equal(ok.ok, true); assert.equal(ok.output, 'Hello world', 'thinking blocks are not part of the output'); assert.deepEqual(ok.usage, { inputTokens: 1000, outputTokens: 500 }); assert.equal(ok.requestId, 'req_abc'); assert.equal(ok.finishReason, 'stop'); assert.deepEqual(ok.ignoredParameters, ['temperature']);
  assert.equal(ok.cost.actualUsd, 0.014, '1000 in x $4/M + 500 out x $20/M'); assert.equal(ok.cost.basis, 'actual'); assert.ok(!JSON.stringify(ok).includes(KEY));
  // refusal is a normalized, non-retryable, non-failover result
  const { ai: ai3 } = mkAi({ cfg: { activeProvider: 'claude', fallbackProviders: ['mock'] }, env: { ANTHROPIC_API_KEY: KEY }, providers: { mock: mock([{ output: 'should not run' }]) }, fetchImpl: fakeFetch(() => claudeOk({ stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } })) });
  const rf = await ai3.complete({ prompt: 'x' }); assert.equal(rf.error.category, 'safety_refusal'); assert.equal(rf.error.retryable, false); assert.equal(rf.attempts.length, 1, 'a refusal never fails over to another provider');
  // HTTP error mapping (provider echoes the key in its message; it must be redacted)
  const cases = [[400, 'invalid_request'], [401, 'authentication'], [403, 'authorization'], [404, 'invalid_request'], [429, 'rate_limit'], [500, 'provider_error'], [529, 'provider_error']];
  for (const [status, cat] of cases) { const { ai: a } = mkAi({ cfg: { activeProvider: 'claude', maxRetries: 0 }, env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: fakeFetch(() => ({ status, headers: { 'retry-after': '2' }, body: { type: 'error', error: { type: 'x', message: `bad key ${KEY} at /home/user/app` } } })) }); const e = await a.complete({ prompt: 'x' }); assert.equal(e.error.category, cat, String(status)); assert.ok(!JSON.stringify(e).includes(KEY) && !JSON.stringify(e).includes('/home/user'), `no leak on ${status}`); }
  const { ai: net } = mkAi({ cfg: { activeProvider: 'claude', maxRetries: 0 }, env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } }); const ne = await net.complete({ prompt: 'x' }); assert.equal(ne.error.category, 'unavailable'); assert.match(ne.error.message, /ECONNREFUSED/);
  // no key: misconfigured, and no network request is ever made
  const f3 = fakeFetch(() => claudeOk()); const { ai: nokey } = mkAi({ cfg: { activeProvider: 'claude' }, fetchImpl: f3 }); const nk = await nokey.complete({ prompt: 'x' }); assert.equal(nk.error.category, 'configuration'); assert.equal(f3.calls.length, 0);
});

test('OpenAI and Ollama adapters', async () => {
  const f = fakeFetch((url) => ({ body: { id: 'chatcmpl-1', model: 'gpt-test', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } } }));
  const { ai } = mkAi({ cfg: { activeProvider: 'openai', providers: { openai: { model: 'gpt-test' } } }, env: { OPENAI_API_KEY: OKEY }, fetchImpl: f });
  const r = await ai.complete({ prompt: 'hi', system: 's', maxTokens: 50, temperature: 0 }); assert.equal(r.ok, true); const c = f.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(c.init.headers.authorization, `Bearer ${OKEY}`); assert.equal(c.body.max_completion_tokens, 50); assert.deepEqual(c.body.messages.map((m) => m.role), ['system', 'user']); assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 2 }); assert.equal(r.cost.actualUsd, null, 'no configured price => unknown cost, not zero'); assert.ok(!JSON.stringify(r).includes(OKEY));
  const f2 = fakeFetch(() => ({ body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } })); const { ai: compat } = mkAi({ cfg: { activeProvider: 'openai', providers: { openai: { model: 'm', endpoint: 'http://localhost:8080/v1' } } }, env: { OPENAI_API_KEY: OKEY }, fetchImpl: f2 }); await compat.complete({ prompt: 'x', maxTokens: 10 }); assert.equal(f2.calls[0].body.max_tokens, 10); assert.equal(f2.calls[0].url, 'http://localhost:8080/v1/chat/completions');
  assert.equal((await mkAi({ cfg: { activeProvider: 'openai' }, env: { OPENAI_API_KEY: OKEY } }).ai.complete({ prompt: 'x' })).error.category, 'configuration', 'no model configured');
  const { ai: ref } = mkAi({ cfg: { activeProvider: 'openai', providers: { openai: { model: 'm' } } }, env: { OPENAI_API_KEY: OKEY }, fetchImpl: fakeFetch(() => ({ body: { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] } })) }); assert.equal((await ref.complete({ prompt: 'x' })).error.category, 'safety_refusal');
  // Ollama: probe (server + model installed), chat mapping, clean failure when the server is down
  const up = fakeFetch((url) => (url.endsWith('/api/tags') ? { body: { models: [{ name: 'llama3:latest' }] } } : { body: { model: 'llama3', message: { content: 'local hi' }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 3 } }));
  const { ai: ol } = mkAi({ cfg: { activeProvider: 'ollama', providers: { ollama: { model: 'llama3' } } }, fetchImpl: up }); const lr = await ol.complete({ prompt: 'hi' });
  assert.equal(lr.ok, true); assert.equal(lr.output, 'local hi'); assert.deepEqual(lr.usage, { inputTokens: 11, outputTokens: 3 }); assert.equal(lr.cost.actualUsd, 0, 'local inference is explicitly configured as $0 per token'); assert.equal(up.calls[0].url, 'http://127.0.0.1:11434/api/tags', 'probed before first use'); assert.equal(up.calls[1].body.stream, false);
  const noModel = fakeFetch(() => ({ body: { models: [{ name: 'other:1b' }] } })); const { ai: nm } = mkAi({ cfg: { activeProvider: 'ollama', providers: { ollama: { model: 'llama3' } } }, fetchImpl: noModel }); const nr = await nm.complete({ prompt: 'x' }); assert.equal(nr.ok, false); assert.equal(nr.error.category, 'configuration'); assert.equal(noModel.calls.length, 1, 'probe only; chat not attempted');
  // REAL connection to a closed local port: fast, normalized, never hangs
  const t0 = Date.now(); const { ai: dead } = createAiService ? { ai: createAiService({ config: { activeProvider: 'ollama', providers: { ollama: { model: 'llama3', endpoint: 'http://127.0.0.1:1' } }, maxRetries: 0 } }) } : {}; const dr = await dead.complete({ prompt: 'x' }); assert.equal(dr.ok, false); assert.equal(dr.error.category, 'unavailable'); assert.ok(Date.now() - t0 < 5000);
  assert.equal((await dead.status()).providers.find((p) => p.name === 'ollama').status, 'unavailable');
});

test('selection: deterministic, preferred/fallback/explicit/cost-aware, capability and model aware', async () => {
  const mk = (cfg, env = {}) => { const { config } = normalizeAiConfig({ ...cfg, providers: { ollama: { model: 'llama3' }, openai: { model: 'gpt' }, ...(cfg.providers ?? {}) } }); const clock = new Clock(); const providers = buildProviders(config, { env: { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: OKEY, ...env }, overrides: { mock: mock(null) } }); return { config, registry: new ProviderRegistry({ config, providers, clock }), now: clock.now() }; };
  const pick = (cfg, request = {}, costOf) => { const m = mk(cfg); return selectProviders({ request, config: m.config, registry: m.registry, now: m.now, costOf }).candidates; };
  assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['ollama', 'openai'] }), ['claude', 'ollama', 'openai']);
  assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['ollama'] }, { provider: 'openai' }), ['openai'], 'explicit provider: no silent substitution');
  assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['ollama'] }, { provider: 'openai', allowFallback: true }), ['openai', 'claude', 'ollama']);
  assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: [] }), ['claude'], 'only listed providers are used implicitly');
  const m = mk({ activeProvider: 'claude', fallbackProviders: ['openai'] }, { ANTHROPIC_API_KEY: '' }); const sel = selectProviders({ request: {}, config: m.config, registry: m.registry, now: m.now }); assert.deepEqual(sel.candidates, ['openai']); assert.match(sel.rejected[0].reason, /ANTHROPIC_API_KEY/);
  assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['freebuff'] }), ['claude']); assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['ollama'], providers: { ollama: { enabled: false } } }), ['claude']);
  assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['ollama'] }, { model: 'claude-haiku-4-5' }), ['claude'], 'a model only the provider offers selects it'); assert.deepEqual(pick({ activeProvider: 'claude' }, { provider: 'claude', model: 'claude-sonnet-5-5' }), ['claude']);
  // cost-aware: cheapest known first, unknown last, stable on ties; explicit preferred ordering is untouched otherwise
  const costs = { claude: 0.02, openai: null, ollama: 0 }; assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['openai', 'ollama'], selection: 'cost' }, {}, (n) => costs[n]), ['ollama', 'claude', 'openai']);
  assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['openai', 'ollama'] }, { prefer: 'cost' }, (n) => costs[n]), ['ollama', 'claude', 'openai']); assert.deepEqual(pick({ activeProvider: 'claude', fallbackProviders: ['openai', 'ollama'] }, {}, (n) => costs[n]), ['claude', 'openai', 'ollama']);
  const a = pick({ activeProvider: 'claude', fallbackProviders: ['ollama'], selection: 'cost' }, {}, (n) => costs[n]), b = pick({ activeProvider: 'claude', fallbackProviders: ['ollama'], selection: 'cost' }, {}, (n) => costs[n]); assert.deepEqual(a, b);
  // an unavailable explicitly requested provider is a failure, never a surprise substitution
  const { ai } = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['claude'] }, providers: { mock: mock([{ output: 'x' }]) } }); const r = await ai.complete({ prompt: 'p', provider: 'openai' }); assert.equal(r.ok, false); assert.equal(r.error.category, 'configuration'); assert.ok(!r.attempts.length);
});

test('failover: bounded retries, permanent vs retryable, timeouts, rate limits, circuit breaker', async () => {
  // retryable failure on the first provider is retried there (with backoff), then succeeds
  const a = mock([{ error: { category: 'provider_error' } }, { output: 'recovered' }]); const t1 = mkAi({ cfg: { activeProvider: 'mock', retryBaseMs: 100 }, providers: { mock: a } });
  const r1 = await t1.ai.complete({ prompt: 'p' }); assert.equal(r1.output, 'recovered'); assert.deepEqual(t1.waits, [100]); assert.deepEqual(r1.attempts.map((x) => [x.ok, x.retry]), [[false, 0], [true, 1]]);
  // retries exhausted -> fail; attempts bounded (1 + maxRetries per provider); no retry storm
  const e = mock([{ error: { category: 'unavailable' } }]); const t2 = mkAi({ cfg: { activeProvider: 'mock', maxRetries: 2 }, providers: { mock: e } }); const r2 = await t2.ai.complete({ prompt: 'p' });
  assert.equal(r2.ok, false); assert.equal(r2.error.category, 'unavailable'); assert.equal(r2.error.retryable, true); assert.equal(e.calls.length, 3); assert.equal(t2.waits.length, 2); assert.deepEqual(t2.waits, [500, 1000], 'exponential backoff, capped');
  // permanent error does not retry; auth failures fail over and mark the provider misconfigured
  const auth = mock([{ error: { category: 'authentication' } }]), good = mock([{ output: 'fallback ok' }]); const t3 = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['openai'] }, env: { OPENAI_API_KEY: OKEY }, providers: { mock: auth, openai: good } });
  const r3 = await t3.ai.complete({ prompt: 'p' }); assert.equal(r3.ok, true); assert.equal(r3.provider, 'openai'); assert.equal(auth.calls.length, 1, 'authentication errors are not retried'); assert.equal(r3.attempts.length, 2);
  assert.equal((await t3.ai.status()).providers.find((p) => p.name === 'mock').status, 'misconfigured'); const r3b = await t3.ai.complete({ prompt: 'p' }); assert.equal(auth.calls.length, 1, 'a misconfigured provider is skipped'); assert.equal(r3b.attempts.length, 1);
  // invalid_request never fails over
  const inv = mock([{ error: { category: 'invalid_request' } }]), other = mock([{ output: 'x' }]); const t4 = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['openai'] }, env: { OPENAI_API_KEY: OKEY }, providers: { mock: inv, openai: other } }); const r4 = await t4.ai.complete({ prompt: 'p' }); assert.equal(r4.error.category, 'invalid_request'); assert.equal(other.calls.length, 0);
  // rate limit with a long retry-after fails over immediately; the limited provider is skipped until the window passes
  const rl = mock([{ error: { category: 'rate_limit', retryAfterMs: 20000 } }, { output: 'back' }]), alt = mock([{ output: 'alt' }]); const t5 = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['openai'] }, env: { OPENAI_API_KEY: OKEY }, providers: { mock: rl, openai: alt } });
  const r5 = await t5.ai.complete({ prompt: 'p' }); assert.equal(r5.provider, 'openai'); assert.equal(t5.waits.length, 0, 'did not sleep for a long retry-after'); let st = (await t5.ai.status()).providers.find((p) => p.name === 'mock'); assert.equal(st.status, 'rate_limited'); assert.ok(st.rateLimitedUntil);
  await t5.ai.complete({ prompt: 'p' }); assert.equal(rl.calls.length, 1, 'skipped while rate limited'); t5.clock.advance(21000); const r5c = await t5.ai.complete({ prompt: 'p' }); assert.equal(r5c.provider, 'mock'); assert.equal(r5c.output, 'back');
  // a short retry-after is honored in place
  const short = mock([{ error: { category: 'rate_limit', retryAfterMs: 700 } }, { output: 'ok' }]); const t6 = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: short } }); assert.equal((await t6.ai.complete({ prompt: 'p' })).output, 'ok'); assert.deepEqual(t6.waits, [700]);
  // circuit breaker: repeated failed calls open it, a cooldown closes it
  const flaky = mock([{ error: { category: 'provider_error' } }]); const t7 = mkAi({ cfg: { activeProvider: 'mock', maxRetries: 0, breaker: { failureThreshold: 2, cooldownMs: 10000 } }, providers: { mock: flaky } });
  await t7.ai.complete({ prompt: 'p' }); await t7.ai.complete({ prompt: 'p' }); assert.equal((await t7.ai.status()).providers.find((p) => p.name === 'mock').status, 'temporarily_failed'); const blocked = await t7.ai.complete({ prompt: 'p' }); assert.equal(flaky.calls.length, 2); assert.equal(blocked.error.category, 'unavailable'); assert.equal(blocked.error.retryable, true);
  t7.clock.advance(10001); await t7.ai.complete({ prompt: 'p' }); assert.equal(flaky.calls.length, 3, 'tried again after the cooldown');
  // all providers fail: clean failure, bounded provider attempts
  const mk3 = () => mock([{ error: { category: 'timeout' } }]); const ps = { mock: mk3(), openai: mk3(), claude: mk3() }; const t8 = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['openai', 'claude'], maxRetries: 0, maxProviderAttempts: 2 }, env: { OPENAI_API_KEY: OKEY, ANTHROPIC_API_KEY: KEY }, providers: ps });
  const r8 = await t8.ai.complete({ prompt: 'p' }); assert.equal(r8.ok, false); assert.equal(r8.error.category, 'timeout'); assert.equal(ps.mock.calls.length + ps.openai.calls.length + ps.claude.calls.length, 2, 'maxProviderAttempts bounds the chain'); assert.equal(ps.claude.calls.length, 0);
});

test('timeouts and cancellation are enforced and never hang', async () => {
  const hang = mock([{ hang: true }]); const { ai } = mkAi({ cfg: { activeProvider: 'mock', maxRetries: 0, timeoutMs: 200 }, providers: { mock: hang }, clock: { now: () => Date.now() } });
  const t0 = Date.now(); const r = await ai.complete({ prompt: 'p', timeoutMs: 150 }); assert.equal(r.ok, false); assert.equal(r.error.category, 'timeout'); assert.equal(r.error.retryable, true); assert.ok(Date.now() - t0 < 1500, 'returned promptly');
  assert.throws(() => { throw new Error('x'); }); await assert.rejects(requestJson('http://127.0.0.1/x', { timeoutMs: 50, fetchImpl: fakeFetch(() => 'hang') }), (e) => e.category === 'timeout');
  const ctl = new AbortController(); const h2 = mock([{ hang: true }]); const { ai: a2 } = mkAi({ cfg: { activeProvider: 'mock', maxRetries: 0 }, providers: { mock: h2 }, clock: { now: () => Date.now() } }); const p = a2.complete({ prompt: 'p', signal: ctl.signal }); setTimeout(() => ctl.abort(), 20); const cr = await p; assert.equal(cr.error.category, 'cancelled'); assert.equal(cr.error.retryable, false);
  const h3 = mock([{ hang: true }]); const { ai: a3 } = mkAi({ cfg: { activeProvider: 'mock', maxRetries: 0 }, providers: { mock: h3 }, clock: { now: () => Date.now() } }); const p3 = a3.complete({ prompt: 'p' }); setTimeout(() => a3.close(), 20); assert.equal((await p3).error.category, 'cancelled');
  const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length; const { ai: a4 } = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: mock(null) } }); await a4.complete({ prompt: 'p' }); assert.equal(process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length, before, 'no timers survive a call');
  assert.equal((await mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: mock(null) } }).ai.complete({ prompt: 'p', timeoutMs: 999999 })).error.category, 'invalid_request', 'a request cannot raise the configured timeout');
});

test('cost accounting and ceilings: known, unknown, estimated vs actual, fail-closed budgets', async () => {
  const P = { inputPerMTokUsd: 4, outputPerMTokUsd: 20 }; assert.equal(actualCostUsd(P, { inputTokens: 1000, outputTokens: 500 }), 0.014); assert.equal(actualCostUsd(P, null), null); assert.equal(actualCostUsd(P, { inputTokens: 5, outputTokens: null }), null); assert.equal(actualCostUsd(null, { inputTokens: 5, outputTokens: 5 }), null); assert.equal(estimateMaxCostUsd({}, 100, 10), null);
  assert.equal(estimateMaxCostUsd(P, 4000, 1000), (1000 * 4 + 1000 * 20) / 1e6);
  const price = { providers: { mock: { pricing: { 'mock-1': { inputPerMTokUsd: 1000, outputPerMTokUsd: 2000 } } } } };
  const m = mock([{ output: 'x', usage: { inputTokens: 100, outputTokens: 50 } }]); const { ai } = mkAi({ cfg: { activeProvider: 'mock', ...price }, providers: { mock: m } });
  const ok = await ai.complete({ prompt: 'a'.repeat(40), maxTokens: 10, maxCostUsd: 1 }); assert.equal(ok.ok, true); assert.equal(ok.cost.basis, 'actual'); assert.ok(ok.cost.estimatedMaxUsd > ok.cost.actualUsd * 0 && ok.cost.estimatedMaxUsd === (10 * 1000 + 10 * 2000) / 1e6); assert.equal(ok.cost.actualUsd, (100 * 1000 + 50 * 2000) / 1e6, 'actual (from reported usage) differs from the worst-case estimate');
  const calls = m.calls.length; const over = await ai.complete({ prompt: 'a'.repeat(40), maxTokens: 10, maxCostUsd: 0.01 }); assert.equal(over.ok, false); assert.equal(over.error.category, 'budget_exceeded'); assert.equal(over.error.retryable, false); assert.equal(m.calls.length, calls, 'nothing was sent');
  // unknown price + a ceiling = rejected (a failed lookup is never permission to spend)
  const { ai: ai2 } = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: mock(null) } }); const u = await ai2.complete({ prompt: 'p', maxCostUsd: 5 }); assert.equal(u.error.category, 'budget_exceeded'); assert.match(u.error.message, /unknown/); assert.equal((await ai2.complete({ prompt: 'p' })).ok, true, 'without a ceiling an unpriced call is allowed and its cost is reported as unknown');
  // the stricter of the request ceiling and the global ceiling applies
  const { ai: ai3 } = mkAi({ cfg: { activeProvider: 'mock', ...price, limits: { maxCostPerRequestUsd: 0.001 } }, providers: { mock: mock(null) } }); assert.equal((await ai3.complete({ prompt: 'p', maxTokens: 10, maxCostUsd: 100 })).error.category, 'budget_exceeded');
  // a provider over the ceiling is skipped in favor of one that fits (free local model)
  const free = mock([{ output: 'cheap' }]); const { ai: ai4 } = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['ollama'], ...price, providers: { ...price.providers, ollama: { model: 'llama3' } } }, providers: { mock: mock(null), ollama: Object.assign(free, { name: 'ollama', kind: 'local', probe: undefined }) } });
  const r4 = await ai4.complete({ prompt: 'p', maxTokens: 10, maxCostUsd: 0.001 }); assert.equal(r4.ok, true); assert.equal(r4.provider, 'ollama'); assert.deepEqual(r4.attempts.map((a) => a.category), ['budget_exceeded', null]);
  // cost-aware selection ranks by estimated cost
  const cheap = new MockProvider({ model: 'm' }, { script: [{ output: 'c' }] }), pricey = mock([{ output: 'p' }]); const { ai: ai5 } = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['openai'], selection: 'cost', providers: { mock: { pricing: { 'mock-1': { inputPerMTokUsd: 10, outputPerMTokUsd: 10 } } }, openai: { model: 'm', pricing: { m: { inputPerMTokUsd: 1, outputPerMTokUsd: 1 } } } } }, env: { OPENAI_API_KEY: OKEY }, providers: { mock: pricey, openai: Object.assign(cheap, { name: 'openai' }) } });
  assert.equal((await ai5.complete({ prompt: 'p' })).provider, 'openai');
});

test('security: credentials never leak; unsafe input is rejected', async () => {
  const red = redact(`Authorization: Bearer abcdefghijklmnop1234 x-api-key: ${KEY} password=hunter22 sk-proj-ABCDEFGHIJKLMNOPQRST /home/me/app.js`); for (const leak of ['abcdefghijklmnop1234', KEY, 'hunter22', 'sk-proj-ABCDEFGHIJKLMNOPQRST', '/home/me']) assert.ok(!red.includes(leak), leak); assert.match(red, /\[redacted/);
  assert.ok(!redact('token=abc123def456', { secrets: [] }).includes('abc123'));
  assert.equal(redact('the key is topsecretvalue99', { secrets: ['topsecretvalue99'] }), 'the key is [redacted]'); assert.ok(redact('x'.repeat(1000)).length <= 300);
  const { ai } = mkAi({ cfg: { activeProvider: 'claude' }, env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: fakeFetch(() => claudeOk()) });
  const bad = [[{ prompt: `please use ${KEY}` }, /credential/], [{ prompt: 'p', jsonSchema: { properties: { apiKey: {} } } }, /credential/], [{ prompt: '' }, /prompt/], [{ prompt: 'p', maxTokens: 0 }, /maxTokens/], [{ prompt: 'p', maxTokens: 10 ** 7 }, /maxTokens/], [{ prompt: 'x'.repeat(200000) }, /exceeds/], [{ prompt: 'p', temperature: 5 }, /temperature/], [{ prompt: 'p', provider: 'skynet' }, /provider/], [{ prompt: 'p', model: 'a b; rm' }, /model/], [{ prompt: 'p', context: { taskId: "x'; --" } }, /context/], [{ prompt: 'p', context: { shell: 'x' } }, /context/], [{ prompt: 'p', headers: { a: 1 } }, /unknown request field/], [null, /object/], [{ prompt: 'p', maxCostUsd: -1 }, /maxCostUsd/]];
  for (const [req, re] of bad) { const r = await ai.complete(req); assert.equal(r.ok, false, JSON.stringify(req)?.slice(0, 40)); assert.equal(r.error.category, 'invalid_request'); assert.match(r.error.message, re); assert.ok(!r.error.message.includes(KEY), 'a rejected prompt is not echoed'); }
  const st = JSON.stringify(await ai.status()); assert.ok(!st.includes(KEY) && !st.includes('x-api-key') && !/authorization/i.test(st));
});

test('observability: one summary event per call, fallbacks and state changes explained, no prompts stored, task-correlated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycoon-ai-')); const cfg = { ...loadConfig({}), paths: { data: dir } }; const svc = makeDb(cfg).open();
  try {
    const clock = new Clock(), os = createAgentOS({ db: svc.db, repos: svc.repos, config: { stopGraceMs: 100 } });
    os.registerAgent({ id: 'ag1', name: 'AI Agent', role: 'Creation', businessId: 'etsy', taskTypes: ['ai.complete'], permissions: { capabilities: ['ai'] } }, { dataMode: 'test' }); await os.startAll();
    const t = os.queue.submit({ type: 'ai.complete', businessId: 'etsy', correlationId: 'job-ai-1', payload: { prompt: 'x' }, dataMode: 'test' });
    const first = mock([{ error: { category: 'authentication' } }]); const second = new MockProvider({ model: 'm' }, { script: [{ output: 'SECRET-OUTPUT-TEXT', usage: { inputTokens: 100, outputTokens: 40 } }] });
    const { ai } = mkAi({ cfg: { activeProvider: 'mock', fallbackProviders: ['openai'], providers: { openai: { model: 'm', pricing: { m: { inputPerMTokUsd: 2, outputPerMTokUsd: 4 } } } } }, env: { OPENAI_API_KEY: OKEY }, providers: { mock: first, openai: Object.assign(second, { name: 'openai' }) }, repos: svc.repos, clock });
    const r = await ai.complete({ prompt: 'SUPER-PRIVATE-PROMPT-TEXT', purpose: 'obs.test', context: { taskId: t.id, agentId: 'ag1', businessId: 'etsy', correlationId: 'job-ai-1' } }); assert.equal(r.ok, true);
    const ev = svc.repos.events.list({}, { limit: 100 }).filter((e) => e.type.startsWith('ai.')); const kinds = ev.map((e) => e.type).sort(); assert.deepEqual(kinds, ['ai.completed', 'ai.fallback', 'ai.provider_state'], 'exactly one summary, one fallback, one state change');
    const done = ev.find((e) => e.type === 'ai.completed'); assert.equal(done.task_id, t.id); assert.equal(done.agent_id, 'ag1'); assert.equal(done.business_id, 'etsy'); assert.equal(done.severity, 'info'); assert.deepEqual([done.metadata.provider, done.metadata.fallbacks, done.metadata.inputTokens, done.metadata.outputTokens], ['openai', 1, 100, 40]); assert.equal(done.metadata.costUsd, (100 * 2 + 40 * 4) / 1e6); assert.deepEqual(done.metadata.attempts.map((a) => [a.provider, a.ok, a.category]), [['mock', false, 'authentication'], ['openai', true, null]]);
    const fb = ev.find((e) => e.type === 'ai.fallback'); assert.equal(fb.severity, 'warn'); assert.match(fb.error, /authentication/); assert.equal(ev.find((e) => e.type === 'ai.provider_state').severity, 'warn');
    const dump = JSON.stringify(svc.db.all('SELECT * FROM events')); for (const secret of ['SUPER-PRIVATE-PROMPT-TEXT', 'SECRET-OUTPUT-TEXT', OKEY, KEY]) assert.ok(!dump.includes(secret), 'prompts, outputs and keys are not stored');
    // failure summary
    const { ai: ai2 } = mkAi({ cfg: { activeProvider: 'mock', maxRetries: 0 }, providers: { mock: mock([{ error: { category: 'provider_error' } }]) }, repos: svc.repos, clock }); const f = await ai2.complete({ prompt: 'p', purpose: 'obs.fail', context: { taskId: t.id } }); assert.equal(f.ok, false);
    const fe = svc.repos.events.list({ type: 'ai.failed' })[0]; assert.equal(fe.severity, 'error'); assert.match(fe.error, /^provider_error:/);
    // via the Phase 5 observability layer: component filter, correlation, cost, trace
    const obs = createObservability({ database: svc, agentOS: os, supervisor: null, config: { observability: { healthCacheMs: 0 } } }); const list = obs.events.list({ limit: 50, component: 'ai', since: '2000-01-01T00:00:00.000Z' }).events;
    assert.ok(list.length >= 4 && list.every((e) => e.component === 'ai')); const c = list.find((e) => e.kind === 'ai.completed'); assert.equal(c.correlationId, 'job-ai-1'); assert.equal(c.cost.amountUsd, 0.000360); assert.equal(c.cost.basis, 'actual'); assert.match(c.message, /AI completed via openai/); assert.equal(c.details.inputTokens, 100, 'token COUNTS are not mistaken for credentials'); assert.equal(c.details.outputTokens, 40); assert.equal(c.dataMode, 'test', 'events from the mock/test path are flagged as test data');
    assert.ok(obs.events.errors({ limit: 20, since: '2000-01-01T00:00:00.000Z' }).errors.some((e) => e.event.kind === 'ai.failed'));
    // disabled AI does not spam the timeline
    const before = svc.repos.events.count(); const { ai: off } = mkAi({ repos: svc.repos }); for (let i = 0; i < 5; i++) await off.complete({ prompt: 'p' }); assert.equal(svc.repos.events.count(), before);
  } finally { svc.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Agent OS integration: AI tasks run through the provider layer; no AI means clean task failure; non-AI work unaffected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tycoon-ai2-')); const cfg = { ...loadConfig({}), paths: { data: dir } }; const svc = makeDb(cfg).open(); seedDemo(svc.db, svc.repos);
  try {
    const os = createAgentOS({ db: svc.db, repos: svc.repos, config: { stopGraceMs: 100 } });
    os.registerAgent({ id: 'ai-a', name: 'AI Worker', role: 'Creation', taskTypes: ['ai.complete', 'demo.noop'], permissions: { capabilities: ['ai', 'analyze'], businesses: ['*'] } }, { dataMode: 'test' }); await os.startAll();
    const m = mock([{ output: 'generated', usage: { inputTokens: 10, outputTokens: 5 } }]); const on = mkAi({ cfg: { activeProvider: 'mock' }, providers: { mock: m }, repos: svc.repos }); registerAiHandlers(os.handlers, on.ai);
    const t = os.queue.submit({ type: 'ai.complete', payload: { prompt: 'write something', maxTokens: 50 }, dataMode: 'test' }); await os.runUntilIdle();
    const done = os.queue.get(t.id); assert.equal(done.status, 'completed'); assert.equal(done.result.output, 'generated'); assert.equal(done.result.provider, 'mock'); assert.equal(done.result.usage.outputTokens, 5); assert.equal(done.result.cost.basis, 'unknown');
    const ev = svc.repos.events.list({ task_id: t.id }).map((e) => e.type); assert.ok(ev.includes('ai.completed') && ev.includes('task.completed'), 'task -> agent -> AI request is one trace');
    // existing non-AI work is unaffected; demo agents (no `ai` capability) can never run AI tasks
    const plain = os.queue.submit({ type: 'demo.noop', dataMode: 'test' }); await os.runUntilIdle(); assert.equal(os.queue.get(plain.id).status, 'completed');
    await os.startAll(); const noperm = os.queue.submit({ type: 'ai.complete', payload: { prompt: 'x' }, maxRetries: 0, dataMode: 'demo' }); os.registry.transition('ai-a', 'paused'); await os.runUntilIdle(); os.registry.transition('ai-a', 'ready'); assert.equal(os.queue.get(noperm.id).status, 'queued', 'no demo agent can claim an ai.complete task');
    assert.ok(!svc.repos.agents.list({ data_mode: 'demo' }, { limit: 50 }).some((a) => a.permissions.capabilities.includes('ai')));
    os.queue.cancel(noperm.id);
    // AI disabled: the task fails cleanly, non-retryable, with a clear normalized reason (no fake output)
    const off = mkAi({ repos: svc.repos }); os.handlers = os.handlers; const reg = os.handlers; reg.register ? null : null;
    const os2 = createAgentOS({ db: svc.db, repos: svc.repos, config: { stopGraceMs: 100 } }); registerAiHandlers(os2.handlers, off.ai); await os2.startAll();
    const t2 = os2.queue.submit({ type: 'ai.complete', payload: { prompt: 'x' }, dataMode: 'test', maxRetries: 3 }); await os2.runUntilIdle(); const f2 = os2.queue.get(t2.id); assert.equal(f2.status, 'failed'); assert.equal(f2.error_code, 'ai_disabled'); assert.equal(f2.retry_count, 0, 'a disabled AI layer is not retried'); assert.ok(f2.result === null);
    // transient provider outage: retried by the existing Agent OS retry model, bounded, then fails
    const down = mkAi({ cfg: { activeProvider: 'mock', maxRetries: 0 }, providers: { mock: mock([{ error: { category: 'unavailable' } }]) }, repos: svc.repos }); const os3 = createAgentOS({ db: svc.db, repos: svc.repos, config: { stopGraceMs: 100 } }); registerAiHandlers(os3.handlers, down.ai); await os3.startAll();
    const t3 = os3.queue.submit({ type: 'ai.complete', payload: { prompt: 'x' }, dataMode: 'test', maxRetries: 1 }); await os3.step(); assert.equal(os3.queue.get(t3.id).status, 'retrying'); assert.equal(os3.queue.get(t3.id).error_code, 'ai_unavailable'); os3.queue.transition(t3.id, 'queued', { patch: { next_attempt_at: null } }); await os3.step(); assert.equal(os3.queue.get(t3.id).status, 'failed'); assert.equal(os3.queue.get(t3.id).retry_count, 1);
    // the Supervisor dispatches AI tasks through the same path
    const sup = new Supervisor({ os, config: { checkpointIntervalMs: 0 }, processRunId: svc.runId }); await sup.start({ loop: false }); const t4 = os.queue.submit({ type: 'ai.complete', payload: { prompt: 'via supervisor' }, dataMode: 'test' }); await sup.cycle({ wait: true }); assert.equal(os.queue.get(t4.id).status, 'completed'); assert.ok(svc.repos.events.list({ task_id: t4.id }).some((e) => e.action === 'task.dispatched')); await sup.stop();
    await os.shutdown(); await os2.shutdown(); await os3.shutdown();
  } finally { svc.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('AI status API: read-only, bounded, validated, no secrets', async () => {
  const f = fakeFetch((url) => ({ body: { models: [{ name: 'llama3:latest' }] } }));
  const { ai } = mkAi({ cfg: { activeProvider: 'claude', fallbackProviders: ['ollama'], providers: { ollama: { model: 'llama3' } } }, env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: f });
  const cfg = loadConfig({}); const srv = createApp(cfg, { ai }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`; const get = async (p, init) => { const r = await fetch(base + p, init); return { code: r.status, body: await r.json() }; };
  try {
    let r = await get('/api/ai/providers'); assert.equal(r.code, 200); assert.equal(r.body.ok, true); assert.equal(r.body.data.enabled, true); assert.equal(r.body.data.activeProvider, 'claude'); const by = Object.fromEntries(r.body.data.providers.map((p) => [p.name, p]));
    assert.deepEqual([by.claude.role, by.claude.status, by.claude.model, by.claude.configured], ['active', 'configured', 'claude-opus-5-5', true]); assert.equal(by.claude.pricing.known, true); assert.equal(by.ollama.role, 'fallback'); assert.equal(by.openai.status, 'misconfigured'); assert.equal(by.claude.endpoint, 'https://api.anthropic.com');
    assert.ok(!JSON.stringify(r.body).includes(KEY) && !JSON.stringify(r.body).match(/x-api-key|\/home\/|\/tmp\//), 'no secrets or paths'); assert.ok(JSON.stringify(r.body).length < 6000, 'bounded');
    r = await get('/api/ai/providers?refresh=1'); assert.equal(r.code, 200); assert.equal(f.calls.filter((c) => c.url.endsWith('/api/tags')).length, 1, 'refresh probes the local server only'); assert.equal(r.body.data.providers.find((p) => p.name === 'ollama').status, 'configured');
    for (const bad of ['?refresh=maybe', '?x=1', '?refresh=1&refresh=0']) assert.equal((await get('/api/ai/providers' + bad)).code, 400, bad);
    assert.equal((await get('/api/ai/providers', { method: 'POST' })).code, 405); assert.equal((await get('/api/ai/providers', { method: 'DELETE' })).code, 405); assert.equal((await get('/api/ai/other')).code, 404);
    const none = createApp(cfg, {}); await new Promise((x) => none.listen(0, '127.0.0.1', x)); const r2 = await fetch(`http://127.0.0.1:${none.address().port}/api/ai/providers`); assert.equal(r2.status, 503); none.close();
    const off = createAiService({}); const s2 = createApp(cfg, { ai: off }); await new Promise((x) => s2.listen(0, '127.0.0.1', x)); const r3 = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/ai/providers`)).json(); assert.equal(r3.data.enabled, false); assert.equal(r3.data.activeProvider, 'none'); s2.close();
  } finally { srv.close(); }
});

test('dashboard rendering of AI status is honest and escaped', () => {
  assert.match(aiBlock(null), /unavailable/); assert.match(aiBlock({ enabled: false, problems: ['<b>x</b>'], providers: [] }), /AI · DISABLED/); assert.ok(!aiBlock({ enabled: false, problems: ['<b>x</b>'], providers: [] }).includes('<b>x'));
  const html = aiBlock({ enabled: true, activeProvider: 'claude', fallbackProviders: ['ollama'], selection: 'preferred', providers: [{ name: 'claude', role: 'active', status: 'rate_limited', reason: 'rate limited', model: 'claude-opus-5-5', pricing: { known: true }, lastError: { category: 'rate_limit' }, rateLimitedUntil: '2030-01-01T00:00:30.000Z' }, { name: 'ollama', role: 'fallback', status: 'configured', model: 'llama3', pricing: { known: false } }, { name: 'openai', role: 'unused', status: 'misconfigured', pricing: { known: false } }] });
  assert.match(html, /AI · ENABLED/); assert.match(html, /rate limited/); assert.match(html, /price unknown/); assert.ok(!html.includes('openai'), 'unused providers are not listed');
});

test('scope and source hygiene: no console, eval, process spawning, background timers, or business logic in the AI layer', () => {
  for (const file of [...readdirSync(join(ROOT, 'server/src/ai')), ...readdirSync(join(ROOT, 'server/src/ai/providers')).map((f) => `providers/${f}`)].filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(ROOT, 'server/src/ai', file), 'utf8').replace(/\/\/.*$/gm, ''); assert.ok(!/console\.|eval\(|new Function|child_process|setInterval|require\(|node:(http|https|net|dgram)/.test(src), file);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); assert.ok(!pkg.dependencies && !pkg.devDependencies, 'still zero npm dependencies');
});
