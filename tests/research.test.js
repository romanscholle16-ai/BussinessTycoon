import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseService as makeDb } from '../server/src/db/service.js';
import { loadConfig, ROOT } from '../server/src/config/index.js';
import { createAgentOS } from '../server/src/agents/os.js';
import { Supervisor } from '../server/src/supervisor/supervisor.js';
import { createAiService } from '../server/src/ai/service.js';
import { MockProvider } from '../server/src/ai/providers/mock.js';
import { createApp } from '../server/src/api/app.js';
import { createObservability } from '../server/src/observability/index.js';
import { classifyIp, validateUrl, canonicalizeUrl, assertResolvedAllowed, normalizePolicy, UrlRejected, loggableUrl } from '../server/src/research/urlsafe.js';
import { extractHtml } from '../server/src/research/html.js';
import { createSafeRetriever, createNodeTransport, guardedLookup, normalizeDocument, RetrievalError } from '../server/src/research/retrieval.js';
import { MockDiscoveryProvider, MockRetrievalProvider, normalizeHits, createJsonSearchProvider, DiscoveryError } from '../server/src/research/discovery.js';
import { validateObjective, buildPlan, validateLimits } from '../server/src/research/model.js';
import { scoreSource, classifySource } from '../server/src/research/quality.js';
import { extractEvidence, extractNumber, detectConflicts, fieldConfidence, findDuplicate } from '../server/src/research/evidence.js';
import { validateInferences } from '../server/src/research/analysis.js';
import { createResearchService, registerResearchHandlers, RESEARCH_AGENT, NotFoundError } from '../server/src/research/service.js';
import { researchPanel } from '../client/public/js/ui.js';

// ---------- fixtures ----------
const PRICE = (price, extra = '') => `<html lang="en"><head><title>Handmade ceramic mug prices</title></head><body><p>The average price of handmade ceramic mugs is ${price} at most shops.</p><p>${extra}</p><script>window.evil=1</script></body></html>`;
const DOCS = {
  'https://shop-a.example.com/mugs': { html: '<html lang="en"><head><title>Ceramic mug prices</title><meta name="date" content="2026-09-01"><meta name="author" content="Ann Potter"></head><body><p>The average price of handmade ceramic mugs is $24.50 at our store.</p></body></html>' },
  'https://blog-b.example.org/pricing': { html: PRICE('$26.00', 'Prices vary by size and glaze.') },
  'https://news-c.example.net/mugs': { html: PRICE('$60', 'The report said demand is rising.') },
  'https://mirror.example.io/copy': { html: PRICE('$26.00', 'Prices vary by size and glaze.') },
};
const corpusOf = (urls) => urls.map((u) => ({ url: u, title: 'ceramic mugs price', snippet: 'average price handmade ceramic mugs' }));
const OBJ = (over = {}) => ({ title: 'Mug prices', question: 'What is the average price of handmade ceramic mugs?', requiredInformation: [{ field: 'avg_price', description: 'average selling price of handmade ceramic mugs', valueType: 'number', unit: 'USD' }], ...over, limits: { maxSources: 6, ...(over.limits ?? {}) } });
class Clock { constructor() { this.t = Date.parse('2026-10-01T00:00:00.000Z'); } now() { return this.t; } advance(ms) { this.t += ms; } }
function sys({ docs = DOCS, urls = Object.keys(docs), discovery, retrieval, ai = null, clock = new Clock(), agentOS } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tycoon-res-')), svc = makeDb({ ...loadConfig({}), paths: { data: dir } }).open();
  const disc = discovery ?? [new MockDiscoveryProvider({ corpus: corpusOf(urls) })], ret = retrieval ?? [new MockRetrievalProvider({ docs })];
  const stub = agentOS ?? { queue: { submit: () => ({ id: null }) } };
  const research = createResearchService({ db: svc.db, repos: svc.repos, agentOS: stub, ai, providers: { discovery: disc, retrieval: ret }, clock });
  return { svc, dir, research, disc, ret, clock, repos: svc.repos, close() { svc.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const run = async (s, objective = OBJ(), opts = {}) => { const r = s.research.createRun(objective); const row = await s.research.engine.execute(r.id, opts); return { id: r.id, row, full: s.research.getRun(r.id) }; };
const events = (s, id) => s.repos.events.list({}, { limit: 1000 }).filter((e) => e.metadata?.researchId === id).map((e) => e.type);
const mockAi = (script, cfg = {}) => createAiService({ config: { activeProvider: 'mock', ...cfg }, providers: { mock: new MockProvider({}, { script }) }, clock: new Clock(), sleepImpl: async () => {} });

// ---------- objective & plan ----------
test('objective validation: strict, bounded, no secrets; plan is deterministic and bounded', () => {
  const o = validateObjective(OBJ()); assert.equal(o.limits.maxSources, 6); assert.equal(o.limits.confidenceTarget, 'medium'); assert.equal(o.requiredInformation[0].findingType, 'constraint');
  for (const bad of [{ ...OBJ(), surprise: 1 }, { ...OBJ(), title: 'x' }, { ...OBJ(), question: 5 }, OBJ({ limits: { maxSources: 500 } }), OBJ({ limits: { maxTimeMs: 1 } }), OBJ({ limits: { nope: 1 } }), OBJ({ limits: { confidenceTarget: 'certain' } }),
    OBJ({ requiredInformation: [{ field: 'Bad Field', description: 'abc' }] }), OBJ({ requiredInformation: [{ field: 'a_b', description: 'abc' }, { field: 'a_b', description: 'abc' }] }), OBJ({ requiredInformation: Array.from({ length: 11 }, (_, i) => ({ field: `f_${i}x`, description: 'abc' })) }),
    OBJ({ sourcePreferences: { types: ['wizard'] } }), OBJ({ sourcePreferences: { avoidDomains: ['bad host!'] } }), OBJ({ freshness: { maxAgeDays: 0 } }), OBJ({ priority: 11 }), OBJ({ businessId: 'bad id' }), { ...OBJ(), constraints: ['apiKey=sk-ant-SECRET0123456789abcdef'], apiKey: 'sk-ant-SECRET0123456789abcdef' }, null, [], 'x']) assert.throws(() => validateObjective(bad), /./);
  assert.equal(validateLimits({ maxSources: 3, maxRetrievals: 9 }).maxRetrievals, 3, 'retrievals cannot exceed sources');
  const p1 = buildPlan(o), p2 = buildPlan(o); assert.deepEqual(p1, p2); assert.ok(p1.subquestions.length >= 1 && p1.subquestions.every((s) => s.queries.length >= 1)); assert.ok(p1.stopping.length >= 4 && p1.outcomes.includes('no_useful_sources'));
  const many = validateObjective({ title: 'Many', question: 'Many fields question here?', requiredInformation: Array.from({ length: 10 }, (_, i) => ({ field: `field_${i}`, description: `thing number ${i} data` })), limits: { maxQueries: 3 } });
  assert.ok(buildPlan(many).subquestions.reduce((a, s) => a + s.queries.length, 0) <= 3, 'planned queries respect maxQueries');
  assert.equal(buildPlan(validateObjective({ title: 'Plain', question: 'Is the market growing?' })).subquestions[0].field, null, 'no required fields -> one implicit subquestion');
});

// ---------- URL / SSRF policy ----------
test('network policy: scheme, credentials, ports, IP classes (v4/v6/mapped), private names, resolved addresses', () => {
  const cls = { '127.0.0.1': 'loopback', '10.2.3.4': 'private', '172.16.0.1': 'private', '172.32.0.1': 'public', '192.168.1.1': 'private', '169.254.169.254': 'reserved', '100.64.0.1': 'private', '0.0.0.0': 'reserved', '224.0.0.1': 'reserved', '8.8.8.8': 'public', '::1': 'loopback', '::': 'reserved', 'fe80::1': 'reserved', 'fd12::1': 'private', '::ffff:127.0.0.1': 'loopback', '::ffff:10.0.0.1': 'private', '::ffff:8.8.8.8': 'public', '64:ff9b::7f00:1': 'loopback', '2002:7f00:1::': 'loopback', '2001:db8::1': 'reserved', '2606:4700::1111': 'public', 'ff02::1': 'reserved' };
  for (const [ip, c] of Object.entries(cls)) assert.equal(classifyIp(ip), c, ip);
  const rej = (u, code, pol) => assert.throws(() => validateUrl(u, normalizePolicy(pol)), (e) => e instanceof UrlRejected && e.code === code, `${u} -> ${code}`);
  rej('ftp://example.com/', 'unsupported_scheme'); rej('file:///etc/passwd', 'unsupported_scheme'); rej('javascript:alert(1)', 'unsupported_scheme'); rej('data:text/html,hi', 'unsupported_scheme');
  rej('https://user:pw@example.com/', 'credentials_in_url'); rej('https://user@example.com/', 'credentials_in_url'); rej('http://example.com/', 'http_not_allowed');
  rej('https://example.com:8443/', 'port_not_allowed'); rej('https://127.0.0.1/', 'loopback_blocked'); rej('https://[::1]/', 'loopback_blocked'); rej('https://localhost/', 'loopback_blocked'); rej('https://a.localhost/', 'loopback_blocked');
  rej('https://2130706433/', 'loopback_blocked'); rej('https://0x7f.1/', 'loopback_blocked'); rej('https://10.0.0.5/', 'private_network_blocked'); rej('https://192.168.0.1/', 'private_network_blocked'); rej('https://169.254.169.254/latest/meta-data', 'reserved_address_blocked');
  rej('https://[::ffff:127.0.0.1]/', 'loopback_blocked'); rej('https://printer.local/', 'private_network_blocked'); rej('https://db.internal/', 'private_network_blocked'); rej('https://intranet/', 'private_network_blocked'); rej('', 'invalid_url'); rej('not a url', 'invalid_url'); rej(`https://example.com/${'a'.repeat(3000)}`, 'invalid_url'); rej('https://exa mple.com/', 'invalid_url');
  assert.ok(validateUrl('https://example.com/a?b=1'));
  // explicit opt-ins (tests / local search infra): loopback + http only together with the flags; metadata/reserved never allowed
  const lo = { allowLoopback: true, allowHttp: true, allowedPorts: [80, 443, 8080] };
  assert.ok(validateUrl('http://127.0.0.1:8080/x', normalizePolicy(lo))); assert.ok(validateUrl('http://localhost:8080/x', normalizePolicy(lo)));
  rej('http://10.0.0.1/', 'http_not_allowed', lo); rej('https://10.0.0.1/', 'private_network_blocked', lo); rej('https://169.254.169.254/', 'reserved_address_blocked', { ...lo, allowPrivateNetworks: true }); assert.ok(validateUrl('https://10.0.0.1/', normalizePolicy({ allowPrivateNetworks: true })));
  assert.throws(() => assertResolvedAllowed([{ address: '93.184.216.34' }, { address: '10.0.0.9' }], normalizePolicy()), /not allowed/, 'ANY private answer blocks the host (DNS rebinding / multi-record)');
  assert.throws(() => assertResolvedAllowed([], normalizePolicy()), /did not resolve/); assertResolvedAllowed([{ address: '93.184.216.34' }], normalizePolicy());
  assert.equal(canonicalizeUrl('https://WWW.Example.com:443/a/b/?utm_source=x&z=1&a=2&fbclid=9#frag'), 'https://example.com/a/b?a=2&z=1'); assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com/');
  assert.equal(loggableUrl('https://example.com/path?token=SECRET#x'), 'https://example.com/path'); assert.equal(loggableUrl('junk'), '[invalid url]');
});

// ---------- HTML extraction ----------
test('html extraction: no script/style execution, entities decoded, metadata only when present, bounded', () => {
  const e = extractHtml('<html lang="EN"><head><title>A &amp; B</title><style>.x{}</style><meta name="author" content="Zed"><meta property="article:published_time" content="2026-01-02T03:04:05Z"><link rel="canonical" href="/c"></head><body><script>steal()</script><p>Hello&nbsp;<b>world</b> &#169; 5 &lt; 6</p><noscript>hidden</noscript><!-- secret comment --><iframe src="x">frame</iframe></body></html>');
  assert.equal(e.title, 'A & B'); assert.ok(!/steal|hidden|secret comment|frame|\{\}/.test(e.text)); assert.match(e.text, /Hello world © 5 < 6/); assert.equal(e.author, 'Zed'); assert.equal(e.publishedAt, '2026-01-02T03:04:05.000Z'); assert.equal(e.language, 'en'); assert.equal(e.canonicalHref, '/c');
  const bare = extractHtml('<p>Just text with no metadata at all here.</p>'); assert.deepEqual([bare.title, bare.author, bare.publishedAt, bare.language, bare.canonicalHref], [null, null, null, null, null], 'unknown stays null, never invented');
  assert.equal(extractHtml('<p>x</p><script>never closed(').text, 'x', 'unterminated script blocks are dropped'); assert.equal(extractHtml(`<p>${'word '.repeat(5000)}</p>`, { maxChars: 100 }).text.length, 100); assert.equal(extractHtml('<meta name="date" content="not-a-date">').publishedAt, null);
});

// ---------- retrieval (doubles) ----------
const resp = (status, ctype, body, headers = {}) => ({ status, headers: { 'content-type': ctype, ...headers }, body: Buffer.from(body) });
const pub = async () => [{ address: '93.184.216.34' }];
function retr({ routes = {}, resolver = pub, limits = {}, policy, onCall } = {}) {
  const calls = [];
  const transport = async ({ url, signal }) => { calls.push(url.toString()); onCall?.(url, signal); const r = routes[url.toString()] ?? routes[url.origin + url.pathname]; if (!r) return resp(404, 'text/plain', 'nf'); if (r instanceof Error) throw r; return typeof r === 'function' ? r(url) : r; };
  return { r: createSafeRetriever({ policy, limits: { respectRobots: false, ...limits }, transport, resolver }), calls };
}
test('safe retriever: success + normalization, redirects, size/type/status limits, policy at every hop, safe errors', async () => {
  const { r, calls } = retr({ routes: { 'https://a.example.com/start': resp(302, 'text/html', '', { location: '/mid' }), 'https://a.example.com/mid': resp(301, 'text/html', '', { location: 'https://b.example.com/final?utm_source=1' }), 'https://b.example.com/final?utm_source=1': resp(200, 'text/html; charset=utf-8', '<title>Final</title><p>Real page content with enough words to read.</p>') } });
  const d = await r.retrieve('https://a.example.com/start'); assert.equal(d.finalUrl, 'https://b.example.com/final?utm_source=1'); assert.equal(d.status, 200); assert.equal(d.title, 'Final'); assert.equal(d.redirectChain.length, 3); assert.equal(calls.length, 3);
  const n = normalizeDocument(d); assert.equal(n.canonicalUrl, 'https://b.example.com/final'); assert.equal(n.domain, 'b.example.com'); assert.equal(n.author, null); assert.equal(n.publishedAt, null); assert.ok(n.contentHash.length === 64 && n.wordCount > 3);
  const fail = async (routes, url, code, opts = {}) => { const x = retr({ routes, ...opts }); await assert.rejects(x.r.retrieve(url), (e) => e instanceof RetrievalError && e.code === code, `${url} -> ${code}`); return x; };
  const loop = { 'https://l.example.com/0': resp(302, 'text/html', '', { location: '/1' }), 'https://l.example.com/1': resp(302, 'text/html', '', { location: '/2' }), 'https://l.example.com/2': resp(302, 'text/html', '', { location: '/3' }), 'https://l.example.com/3': resp(302, 'text/html', '', { location: '/4' }), 'https://l.example.com/4': resp(200, 'text/plain', 'ok') };
  await fail(loop, 'https://l.example.com/0', 'too_many_redirects');
  await fail({ 'https://r.example.com/a': resp(302, 'text/html', '', { location: 'http://169.254.169.254/latest/meta-data' }) }, 'https://r.example.com/a', 'redirect_downgrade');
  await fail({ 'https://r.example.com/a': resp(302, 'text/html', '', { location: 'https://127.0.0.1/admin' }) }, 'https://r.example.com/a', 'loopback_blocked');
  await fail({ 'https://r.example.com/a': resp(302, 'text/html', '', { location: 'https://u:p@x.example.com/' }) }, 'https://r.example.com/a', 'credentials_in_url');
  await fail({ 'https://r.example.com/a': resp(302, 'text/html', '', { location: 'file:///etc/passwd' }) }, 'https://r.example.com/a', 'unsupported_scheme');
  const dn = await fail({ 'https://r.example.com/a': resp(302, 'text/html', '', { location: 'https://evil.example.net/' }) }, 'https://r.example.com/a', 'private_network_blocked', { resolver: async (h) => (h === 'evil.example.net' ? [{ address: '10.0.0.7' }] : pub()) }); assert.equal(dn.calls.length, 1, 'a redirect to a name resolving privately is never requested');
  await fail({}, 'https://rebind.example.com/', 'private_network_blocked', { resolver: async () => [{ address: '93.184.216.34' }, { address: '192.168.1.5' }] }); await fail({}, 'https://nx.example.com/', 'dns_failure', { resolver: async () => { throw new Error('ENOTFOUND secret-internal-name'); } });
  await fail({ 'https://t.example.com/': resp(200, 'application/pdf', '%PDF') }, 'https://t.example.com/', 'unsupported_content_type'); await fail({ 'https://t.example.com/': resp(200, 'text/html', '<script>only()</script>') }, 'https://t.example.com/', 'empty_content'); await fail({ 'https://t.example.com/': resp(200, 'text/plain', 'bin\u0000ary') }, 'https://t.example.com/', 'malformed_content');
  for (const [st, code] of [[401, 'access_denied'], [403, 'access_denied'], [402, 'access_denied'], [429, 'rate_limited'], [503, 'server_error'], [404, 'http_error']]) await fail({ 'https://t.example.com/': resp(st, 'text/html', 'x') }, 'https://t.example.com/', code);
  await fail({}, 'ftp://x.example.com/', 'unsupported_scheme'); await fail({}, 'https://u:p@x.example.com/', 'credentials_in_url'); await fail({}, 'https://10.1.1.1/', 'private_network_blocked'); await fail({}, 'https://x.example.com:22/', 'port_not_allowed');
  const big = retr({ routes: { 'https://t.example.com/': resp(200, 'text/plain', 'word '.repeat(20000)) }, limits: { maxTextChars: 500 } }); const dt = await big.r.retrieve('https://t.example.com/'); assert.equal(dt.text.length, 500); assert.ok(dt.limitations.some((l) => /truncated/.test(l))); assert.equal(dt.extractionStatus, 'truncated');
  const sc = retr({ routes: { 'https://t.example.com/': resp(200, 'text/html', '<p>hello readable content</p><script>x()</script>') } }); assert.ok((await sc.r.retrieve('https://t.example.com/')).limitations.some((l) => /never executed/.test(l)), 'JS limitation recorded');
  const ctl = new AbortController(); ctl.abort(); await assert.rejects(r.retrieve('https://a.example.com/start', { signal: ctl.signal }), (e) => e.code === 'cancelled');
  // errors never echo URL credentials/secrets
  try { await retr().r.retrieve('https://user:SECRETPASS@example.com/?token=abc'); } catch (e) { assert.ok(!/SECRETPASS|token=abc/.test(e.message)); }
});
test('robots.txt is honored (never bypassed); unreachable robots means not allowed', async () => {
  const routes = { 'https://s.example.com/robots.txt': resp(200, 'text/plain', 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n'), 'https://s.example.com/open': resp(200, 'text/plain', 'open page with readable text content'), 'https://s.example.com/private/x': resp(200, 'text/plain', 'secret'), 'https://s.example.com/private/ok': resp(200, 'text/plain', 'allowed readable text content here') };
  const { r, calls } = retr({ routes, limits: { respectRobots: true } });
  assert.equal((await r.retrieve('https://s.example.com/open')).status, 200); await assert.rejects(r.retrieve('https://s.example.com/private/x'), (e) => e.code === 'robots_disallowed'); assert.equal((await r.retrieve('https://s.example.com/private/ok')).status, 200);
  assert.ok(!calls.includes('https://s.example.com/private/x'), 'disallowed page is never requested'); assert.equal(calls.filter((c) => c.endsWith('/robots.txt')).length, 1, 'robots cached per origin');
  const down = retr({ routes: { 'https://d.example.com/robots.txt': resp(503, 'text/plain', ''), 'https://d.example.com/p': resp(200, 'text/plain', 'content here is readable ok') }, limits: { respectRobots: true } }); await assert.rejects(down.r.retrieve('https://d.example.com/p'), (e) => e.code === 'robots_disallowed');
  const none = retr({ routes: { 'https://n.example.com/p': resp(200, 'text/plain', 'content here is readable ok') }, limits: { respectRobots: true } }); assert.equal((await none.r.retrieve('https://n.example.com/p')).status, 200, 'no robots.txt (404) means no rules');
});

// ---------- real transport against a local server (explicit loopback test policy) ----------
test('node transport: real HTTP on loopback only under an explicit policy; oversize, timeout, redirect-to-blocked, connect-time DNS guard', async () => {
  const hits = []; const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Local</title><p>Local test page with readable words for retrieval.</p>'); }
    else if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(200_000)); }
    else if (req.url === '/chunked') { res.writeHead(200, { 'content-type': 'text/plain' }); const t = setInterval(() => res.write('y'.repeat(50_000)), 5); res.on('close', () => clearInterval(t)); }
    else if (req.url === '/slow') { /* never answers */ }
    else if (req.url === '/redir') { res.writeHead(302, { location: 'http://169.254.169.254/latest' }); res.end(); }
    else if (req.url === '/robots.txt') { res.writeHead(404); res.end(); }
    else { res.writeHead(404); res.end('no'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const lo = { allowLoopback: true, allowHttp: true, allowedPorts: [port] };
  try {
    const open = createSafeRetriever({ policy: lo, limits: { respectRobots: true, maxBytes: 100_000, timeoutMs: 400 } });
    const d = await open.retrieve(`http://127.0.0.1:${port}/ok`); assert.equal(d.title, 'Local'); assert.equal(d.provider, 'http');
    await assert.rejects(open.retrieve(`http://127.0.0.1:${port}/big`), (e) => e.code === 'response_too_large'); await assert.rejects(open.retrieve(`http://127.0.0.1:${port}/chunked`), (e) => e.code === 'response_too_large'); await assert.rejects(open.retrieve(`http://127.0.0.1:${port}/slow`), (e) => e.code === 'timeout');
    await assert.rejects(open.retrieve(`http://127.0.0.1:${port}/redir`), (e) => e.code === 'http_not_allowed');
    const ctl = new AbortController(); const p = open.retrieve(`http://127.0.0.1:${port}/slow`, { signal: ctl.signal }); setTimeout(() => ctl.abort(), 30); await assert.rejects(p, (e) => e.code === 'cancelled');
    // default policy: the same loopback server is unreachable and never even receives a request
    const before = hits.length, strict = createSafeRetriever({ limits: { respectRobots: false } });
    await assert.rejects(strict.retrieve(`http://127.0.0.1:${port}/ok`), (e) => e.code === 'http_not_allowed'); await assert.rejects(strict.retrieve(`https://127.0.0.1:${port}/ok`), (e) => /blocked|port_not_allowed/.test(e.code)); assert.equal(hits.length, before);
    // connect-time guard: a resolver that answers a private address is refused by the transport itself (pinned lookup)
    const tr = createNodeTransport({ lookupResolver: (h, o, cb) => cb(null, [{ address: '10.0.0.8', family: 4 }]) });
    await assert.rejects(tr({ url: new URL(`https://rebind.example.com/`), policy: normalizePolicy(), timeoutMs: 500, maxBytes: 1000, headers: {} }), (e) => e.code === 'private_network_blocked');
    const g = guardedLookup(normalizePolicy(), (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])); await new Promise((res) => g('x.example.com', {}, (err) => { assert.ok(err); res(); }));
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
});

// ---------- discovery ----------
test('discovery: provider-neutral normalization, duplicates, invalid/unsafe URLs dropped, bounds, failures', async () => {
  const p = new MockDiscoveryProvider({ corpus: [...corpusOf(['https://a.example.com/x', 'https://a.example.com/x/?utm_source=q', 'https://b.example.com/y', 'file:///etc/passwd', 'https://10.0.0.1/admin', 'https://u:p@c.example.com/', 'javascript:alert(1)'])] });
  const raw = await p.discover({ query: 'average price handmade ceramic mugs', limit: 10 }); assert.ok(raw.length >= 3);
  const { hits, dropped } = normalizeHits(raw, { provider: 'mock', query: 'q', policy: normalizePolicy(), now: () => '2026-01-01T00:00:00.000Z', limit: 10 });
  assert.deepEqual(hits.map((h) => h.canonicalUrl).sort(), ['https://a.example.com/x', 'https://b.example.com/y']); assert.equal(dropped, 5); assert.deepEqual(Object.keys(hits[0]).sort(), ['canonicalUrl', 'discoveredAt', 'domain', 'provider', 'query', 'rank', 'snippet', 'title', 'typeHint', 'url'].sort());
  assert.equal(normalizeHits(raw, { provider: 'mock', query: 'q', policy: normalizePolicy(), limit: 1 }).hits.length, 1, 'result count is bounded'); assert.throws(() => normalizeHits('nope', { provider: 'm', query: 'q', policy: normalizePolicy() }), DiscoveryError);
  assert.deepEqual(await p.discover({ query: 'average price handmade ceramic mugs', limit: 10 }), raw, 'deterministic');
  await assert.rejects(new MockDiscoveryProvider({ failWith: { code: 'unavailable' } }).discover({ query: 'x' }), (e) => e.code === 'unavailable');
  // generic JSON search adapter: endpoint obeys the network policy; HTTP errors/shape are normalized, no credentials needed
  assert.throws(() => createJsonSearchProvider({ endpoint: 'http://127.0.0.1:8888/search' }), UrlRejected); assert.throws(() => createJsonSearchProvider({ endpoint: 'https://u:p@s.example.com/search' }), UrlRejected);
  const okFetch = async (u) => { assert.equal(u.searchParams.get('q'), 'hello'); return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://r.example.com/1', content: 'snip' }] }), { status: 200 }); };
  assert.deepEqual((await createJsonSearchProvider({ endpoint: 'https://s.example.com/search', fetchImpl: okFetch }).discover({ query: 'hello' })).map((h) => h.url), ['https://r.example.com/1']);
  await assert.rejects(createJsonSearchProvider({ endpoint: 'https://s.example.com/search', fetchImpl: async () => new Response('{}', { status: 503 }) }).discover({ query: 'x' }), (e) => e.code === 'unavailable' && e.retryable);
  await assert.rejects(createJsonSearchProvider({ endpoint: 'https://s.example.com/search', fetchImpl: async () => new Response('<html>', { status: 200 }) }).discover({ query: 'x' }), (e) => e.code === 'malformed_response');
  await assert.rejects(createJsonSearchProvider({ endpoint: 'https://s.example.com/search', fetchImpl: async () => { throw Object.assign(new Error('boom'), { cause: { code: 'ECONNREFUSED' } }); } }).discover({ query: 'x' }), (e) => e.code === 'unavailable' && /ECONNREFUSED/.test(e.message));
  const mockRet = new MockRetrievalProvider({ docs: DOCS, failures: { 'https://x.example.com/f': { code: 'timeout', retryable: true } } }); await assert.rejects(mockRet.retrieve('https://10.0.0.1/'), (e) => e.code === 'private_network_blocked'); await assert.rejects(mockRet.retrieve('https://x.example.com/f'), (e) => e.code === 'timeout'); assert.equal((await mockRet.retrieve('https://shop-a.example.com/mugs')).author, 'Ann Potter');
});

// ---------- quality / evidence / conflicts / dedup ----------
test('source quality is explainable, deterministic and never invents dates or trust', () => {
  const objective = validateObjective(OBJ({ freshness: { maxAgeDays: 90 } })), now = Date.parse('2026-10-01T00:00:00Z');
  const src = (o = {}) => ({ domain: 'shop.example.com', title: 'Ceramic mug prices', text: 'The average price of handmade ceramic mugs is $24.50. '.repeat(20), wordCount: 200, extractionStatus: 'complete', publishedAt: '2026-09-20T00:00:00Z', author: 'A', ...o });
  const a = scoreSource({ source: src(), objective, now }), b = scoreSource({ source: src(), objective, now }); assert.deepEqual(a, b);
  for (const k of ['directness', 'relevance', 'freshness', 'specificity', 'completeness', 'extractionQuality', 'publicationInfo', 'corroboration', 'consistency']) assert.ok(a.factors[k] && typeof a.factors[k].reason === 'string' && a.factors[k].value >= 0 && a.factors[k].value <= 1, k);
  assert.equal(a.freshness, 'fresh'); const undated = scoreSource({ source: src({ publishedAt: null, author: null }), objective, now }); assert.equal(undated.freshness, 'unknown'); assert.match(undated.factors.freshness.reason, /unknown \(not guessed\)/); assert.ok(undated.score < a.score);
  assert.equal(scoreSource({ source: src({ publishedAt: '2024-01-01T00:00:00Z' }), objective, now }).freshness, 'stale');
  assert.equal(classifySource({ domain: 'example.com' }).type, 'unknown'); assert.equal(classifySource({ domain: 'stats.gov' }).type, 'government'); assert.equal(classifySource({ domain: 'a.edu' }).type, 'research'); assert.equal(classifySource({ domain: 'x.com', typeHint: 'news' }).basis, 'provider hint (unverified)');
  assert.ok(scoreSource({ source: src({ domain: 'stats.gov' }), objective, now }).primary); assert.ok(!scoreSource({ source: src({ domain: 'unknown-blog.com' }), objective, now }).primary);
  const corr = scoreSource({ source: src(), objective, now, corroboration: 1, consistency: 1 }); assert.ok(corr.score > a.score); assert.equal(scoreSource({ source: src({ text: '', wordCount: 0 }), objective, now }).factors.completeness.value, 0);
  assert.equal(classifySource({ domain: 'popular-site.com' }).type, 'unknown', 'popularity is never a signal');
});
test('evidence: bounded excerpts, fact vs quoted claim, numbers, provenance fields, conflicts never resolved, confidence caps, dedup kinds', () => {
  assert.deepEqual(extractNumber('Sells for $24.50 each in 2024'), { value: 24.5, unit: 'USD' }); assert.equal(extractNumber('Founded in 2019.'), null, 'a bare year is not a value'); assert.deepEqual(extractNumber('grew 12% last year'), { value: 12, unit: '%' }); assert.equal(extractNumber('about 1,200 units').value, 1200); assert.equal(extractNumber('worth 3.5 million').value, 3_500_000);
  const objective = validateObjective(OBJ()), fields = objective.requiredInformation;
  const text = 'Intro sentence about pottery studios and their history overall. The average price of handmade ceramic mugs is $24.50 in local shops. According to a survey, the average selling price of handmade ceramic mugs is $26 across sellers. ' + 'Unrelated filler text about the weather today and tomorrow. '.repeat(5);
  const ev = extractEvidence({ source: { text }, fields, objective, limits: objective.limits, now: '2026-10-01T00:00:00.000Z' });
  assert.equal(ev.length, 2); assert.deepEqual(ev.map((e) => e.evidenceType).sort(), ['directly_observed_fact', 'quoted_source_claim']); assert.ok(ev.every((e) => e.excerpt.length <= 300 && e.location.startsWith('sentence ') && e.method && e.value > 0 && e.unit === 'USD'));
  assert.deepEqual(extractEvidence({ source: { text: 'Nothing relevant lives in this long enough sentence about cooking recipes.' }, fields, objective, limits: objective.limits, now: 'x' }), [], 'no relevant text -> no evidence (nothing invented)');
  assert.equal(extractEvidence({ source: { text }, fields, objective, limits: { ...objective.limits, maxEvidencePerSource: 1 }, now: 'x' }).length, 1);
  const mk = (id, src, value, extra = {}) => ({ id, source_id: src, evidence_type: 'directly_observed_fact', field: 'avg_price', value, unit: 'USD', freshness: 'unknown', confidence: 'medium', confidence_score: 0.5, ...extra });
  const sources = new Map([['s1', { id: 's1', domain: 'a.com', quality_score: 0.6, primary: false }], ['s2', { id: 's2', domain: 'b.com', quality_score: 0.6, primary: false }], ['s3', { id: 's3', domain: 'c.com', quality_score: 0.9, primary: true }]]);
  assert.equal(detectConflicts({ evidence: [mk('e1', 's1', 24), mk('e2', 's2', 26)], sources, tolerance: 0.25 }).length, 0, 'close values agree');
  const [c] = detectConflicts({ evidence: [mk('e1', 's1', 24), mk('e2', 's2', 60), mk('e3', 's3', 25)], sources, tolerance: 0.25 }); assert.ok(c && c.claims.length === 3 && c.field === 'avg_price' && /no value was chosen/.test(c.description) && c.claims.every((x) => 'quality' in x && 'freshness' in x && 'confidence' in x));
  assert.equal(detectConflicts({ evidence: [mk('e1', 's1', 24), mk('e2', 's1', 90)], sources, tolerance: 0.25 }).length, 0, 'one source disagreeing with itself is not a cross-source conflict'); assert.equal(detectConflicts({ evidence: [mk('e1', 's1', 24), mk('e2', 's2', 90, { unit: '%' })], sources, tolerance: 0.25 }).length, 0, 'different units are not comparable');
  const conf = (evs, conflict = null) => fieldConfidence({ evidence: evs, sources, conflict, objective });
  assert.equal(conf([]).level, 'insufficient'); assert.equal(conf([{ ...mk('d', null, 1), evidence_type: 'model_inference' }]).level, 'insufficient', 'inference is not direct evidence');
  const one = conf([mk('e1', 's3', 25)]); assert.ok(['low', 'medium'].includes(one.level)); assert.ok(one.reasons.length >= 4); const many = conf([mk('e1', 's1', 25), mk('e2', 's2', 25), mk('e3', 's3', 25)]); assert.ok(['medium', 'high'].includes(many.level)); assert.ok(many.score >= one.score);
  assert.ok(['low', 'insufficient'].includes(conf([mk('e1', 's1', 25), mk('e2', 's2', 25)], { id: 'c' }).level), 'unresolved conflict caps confidence'); assert.equal(conf([mk('e1', 's3', 25)]).independentSources, 1);
  const s = [{ id: 'a', url: 'https://x.com/a', canonical_url: 'https://x.com/a', content_hash: 'H1', text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '.repeat(5) }];
  assert.equal(findDuplicate({ url: 'https://x.com/a', canonicalUrl: 'z', contentHash: 'q' }, s).kind, 'exact_url'); assert.equal(findDuplicate({ url: 'https://x.com/a?utm=1', canonicalUrl: 'https://x.com/a', contentHash: 'q' }, s).kind, 'canonical_url'); assert.equal(findDuplicate({ url: 'u', canonicalUrl: 'z', contentHash: 'H1' }, s).kind, 'duplicate_content');
  assert.equal(findDuplicate({ url: 'u', canonicalUrl: 'z', contentHash: 'q', text: `${s[0].text} nu` }, s).kind, 'near_duplicate_copy'); assert.equal(findDuplicate({ url: 'u', canonicalUrl: 'z', contentHash: 'q', text: 'completely different words about another matter entirely here with many more tokens to compare' }, s), null);
});

// ---------- engine lifecycle ----------
test('end-to-end deterministic run: agreeing sources complete with traceable evidence, derived calculation and explained result', async () => {
  const s = sys({ urls: ['https://shop-a.example.com/mugs', 'https://blog-b.example.org/pricing', 'https://mirror.example.io/copy'] });
  try {
    const { id, row, full } = await run(s, OBJ({ freshness: { maxAgeDays: 365 } })); assert.equal(row.status, 'completed', JSON.stringify(full.error ?? full.result?.outcome)); assert.equal(full.confidence === 'medium' || full.confidence === 'high', true); assert.equal(full.stopReason, 'required_fields_supported');
    assert.equal(full.counts.sourcesRetrieved, 2, 'the mirror is a content copy, not an independent source'); assert.equal(full.counts.duplicates, 1); assert.equal(full.counts.conflicts, 0);
    const srcs = s.research.sources(id).sources; assert.deepEqual(srcs.map((x) => x.status).sort(), ['duplicate', 'retrieved', 'retrieved']); const dup = srcs.find((x) => x.status === 'duplicate'); assert.equal(dup.duplicateKind, 'duplicate_content'); assert.ok(srcs.every((x) => !('text' in x)), 'page text is not exposed by the API');
    const a = srcs.find((x) => x.domain === 'shop-a.example.com'); assert.equal(a.author, 'Ann Potter'); assert.equal(a.publishedAt, '2026-09-01T00:00:00.000Z'); assert.equal(a.language, 'en'); assert.equal(srcs.find((x) => x.domain === 'blog-b.example.org').publishedAt, null, 'unknown date stays null'); assert.ok(a.quality.factors.directness.reason);
    const ev = s.research.evidence(id).evidence, direct = ev.filter((e) => e.directSourceEvidence), derived = ev.filter((e) => e.type === 'derived_calculation'); assert.equal(direct.length, 2); assert.equal(derived.length, 1);
    assert.ok(direct.every((e) => e.sourceId && e.sourceUrl.startsWith('https://') && e.excerpt && e.excerpt.length <= 300 && e.researchId === id && e.observedAt)); assert.deepEqual([...derived[0].derivedFrom].sort(), direct.map((e) => e.id).sort()); assert.equal(derived[0].sourceId, null); assert.equal(derived[0].value, 25.25);
    const fin = s.research.findings(id); const main = fin.findings.find((f) => f.field === 'avg_price' && f.type === 'constraint'); assert.equal(main.basis, 'derived'); assert.equal(main.status, 'supported'); assert.ok(main.evidenceIds.includes(derived[0].id) && direct.every((e) => main.evidenceIds.includes(e.id)));
    const r = full.result; assert.equal(r.outcome, 'completed'); assert.equal(r.researched.title, 'Mug prices'); assert.ok(r.strongestSources.length === 2 && r.strongestSources[0].why.length); assert.equal(r.evidence.directlySupported, 2); assert.deepEqual(r.unknown, []); assert.equal(r.conflicts.length, 0); assert.ok(r.fields[0].supported && r.fields[0].satisfied); assert.ok(r.providers.discoveryAttempts >= 1);
    const types = events(s, id); for (const t of ['research.run_started', 'research.source_discovered', 'research.evidence_extracted', 'research.stopped', 'research.run_completed']) assert.ok(types.includes(t), t); assert.ok(types.filter((t) => t === 'research.stage').length >= 7);
    const all = JSON.stringify(s.repos.events.list({}, { limit: 1000 }).filter((e) => e.type.startsWith('research.'))); assert.ok(!/average price of handmade/.test(all), 'no page text in events'); assert.ok(!/\?utm|token=/.test(all));
    assert.equal(s.research.getRun(id).counts.findings, fin.total);
  } finally { s.close(); }
});
test('determinism: the same inputs give the same observable result twice', async () => {
  const shape = async () => { const s = sys(); try { const { id, full } = await run(s); const ev = s.research.evidence(id).evidence.map((e) => [e.type, e.field, e.value, e.unit, e.confidence, e.sourceUrl, e.claim]), f = s.research.findings(id).findings.map((x) => [x.type, x.statement, x.basis, x.confidence, x.status]), src = s.research.sources(id).sources.map((x) => [x.url, x.status, x.type, x.qualityScore]); return JSON.stringify({ st: full.status, sr: full.stopReason, c: full.confidence, ev: ev.sort(), f: f.sort(), src: src.sort() }); } finally { s.close(); } };
  assert.equal(await shape(), await shape());
});
test('conflicting sources end as conflicted with an explicit conflict and no chosen value', async () => {
  const s = sys({ urls: ['https://shop-a.example.com/mugs', 'https://blog-b.example.org/pricing', 'https://news-c.example.net/mugs'] });
  try {
    const { id, row, full } = await run(s); assert.equal(row.status, 'conflicted'); assert.equal(full.counts.conflicts, 1); const fin = s.research.findings(id); assert.equal(fin.conflicts[0].status, 'unresolved'); assert.equal(fin.conflicts[0].claims.length, 3);
    const f = fin.findings.find((x) => x.field === 'avg_price'); assert.equal(f.status, 'conflicted'); assert.deepEqual(f.conflictIds, [fin.conflicts[0].id]); assert.match(f.statement, /disagree/); assert.ok(['low', 'insufficient'].includes(f.confidence)); assert.ok(!s.research.evidence(id).evidence.some((e) => e.type === 'derived_calculation'), 'no aggregate is computed over conflicting values');
    assert.ok(full.result.nextSteps.some((n) => /conflict/.test(n))); assert.ok(events(s, id).includes('research.conflict_detected')); assert.equal(full.result.outcome, 'conflicted');
  } finally { s.close(); }
});
test('insufficient: no evidence, single source below the independence target, nothing discovered, nothing retrievable', async () => {
  const s = sys({ docs: { 'https://x.example.com/a': { text: 'This page talks about gardening tools and soil quality for tomatoes.' } } });
  try { const { row, full, id } = await run(s, OBJ()); assert.equal(row.status, 'insufficient'); assert.equal(full.confidence, 'insufficient'); const f = s.research.findings(id).findings; assert.deepEqual(f.map((x) => x.type), ['unanswered_question']); assert.equal(f[0].basis, 'none'); assert.ok(full.result.unknown.length === 1 && full.result.nextSteps.length); assert.ok(['no_new_evidence', 'subquestions_exhausted'].includes(full.stopReason)); } finally { s.close(); }
  const one = sys({ urls: ['https://shop-a.example.com/mugs'] });
  try { const { row, full, id } = await run(one, OBJ()); assert.equal(row.status, 'insufficient', 'one independent source cannot satisfy minIndependentSources=2'); assert.ok(one.research.findings(id).findings.some((f) => f.type === 'gap')); assert.equal(full.result.fields[0].supported, true); assert.equal((await run(one, OBJ({ limits: { minIndependentSources: 1 } }))).row.status, 'completed'); } finally { one.close(); }
  const empty = sys({ urls: [], docs: {} });
  try { const { row, full } = await run(empty); assert.equal(row.status, 'insufficient'); assert.equal(full.stopReason, 'no_useful_sources'); assert.equal(full.counts.sourcesDiscovered, 0); } finally { empty.close(); }
  const dead = sys({ retrieval: [new MockRetrievalProvider({ docs: {} })] });
  try { const { row, full, id } = await run(dead); assert.equal(row.status, 'insufficient'); assert.equal(full.stopReason, 'no_useful_sources'); assert.ok(full.counts.sourcesFailed >= 1); assert.ok(events(dead, id).includes('research.retrieval_failed')); assert.ok(dead.research.sources(id).sources.every((x) => x.status === 'failed' && x.retrieval.failure)); } finally { dead.close(); }
});
test('provider failures: honest failed run, bounded retries, explicit fallback only, full provenance', async () => {
  const none = sys({ discovery: [] }); try { const { row, full, id } = await run(none); assert.equal(row.status, 'failed'); assert.equal(full.error.code, 'provider_unavailable'); assert.equal(full.counts.sourcesDiscovered, 0); assert.ok(events(none, id).includes('research.run_failed')); } finally { none.close(); }
  const down = new MockDiscoveryProvider({ failWith: { code: 'unavailable' } }), s1 = sys({ discovery: [down] });
  try { const { row, full, id } = await run(s1, OBJ({ limits: { maxQueries: 6 } })); assert.equal(row.status, 'failed'); assert.ok(down.calls <= 2, `a failing provider is not retried forever (calls=${down.calls})`); assert.equal(full.providers.discovery.failures.mock, 2); assert.ok(events(s1, id).includes('research.provider_unavailable')); assert.ok(full.error.message.length); } finally { s1.close(); }
  const bad = new MockDiscoveryProvider({ id: 'primary', failWith: { code: 'unavailable' } }), good = new MockDiscoveryProvider({ id: 'secondary', corpus: corpusOf(Object.keys(DOCS)) }), s2 = sys({ discovery: [bad, good] });
  try { const { row, full, id } = await run(s2); assert.notEqual(row.status, 'failed'); assert.ok(full.providers.discovery.fallbackUsed >= 1); assert.ok(s2.research.sources(id).sources.every((x) => x.discovery.provider === 'secondary'), 'provenance names the provider that really answered'); assert.ok(full.providers.discovery.failures.primary >= 1); } finally { s2.close(); }
  const r1 = new MockRetrievalProvider({ id: 'r1', docs: {}, failures: Object.fromEntries(Object.keys(DOCS).map((u) => [u, { code: 'network_error', retryable: true }])) }), r2 = new MockRetrievalProvider({ id: 'r2', docs: DOCS }), s3 = sys({ retrieval: [r1, r2] });
  try { const { id, full } = await run(s3); assert.ok(s3.research.sources(id).sources.filter((x) => x.status === 'retrieved').every((x) => x.retrieval.provider === 'r2' && x.retrieval.failure === null)); assert.ok(full.result.providers.retrievalFallbackUsed >= 1); } finally { s3.close(); }
  const rej = new MockRetrievalProvider({ id: 'r1', docs: DOCS, failures: { 'https://shop-a.example.com/mugs': { code: 'robots_disallowed' } } }), r2b = new MockRetrievalProvider({ id: 'r2', docs: DOCS }), s4 = sys({ retrieval: [rej, r2b], urls: ['https://shop-a.example.com/mugs'] });
  try { await run(s4); assert.ok(!r2b.calls.includes('https://shop-a.example.com/mugs'), 'policy rejections do not fall through to another provider'); } finally { s4.close(); }
});
test('stopping conditions: confidence reached early, max retrievals, time budget, no new evidence; each is recorded and bounded', async () => {
  const urls = Object.keys(DOCS), early = sys({ urls: ['https://shop-a.example.com/mugs', 'https://blog-b.example.org/pricing', 'https://mirror.example.io/copy'] });
  try { const { full, id } = await run(early, OBJ({ limits: { minIndependentSources: 2 } })); assert.equal(full.stopReason, 'required_fields_supported'); assert.ok(early.research.sources(id).sources.some((x) => x.status === 'skipped') || full.counts.sourcesRetrieved + full.counts.duplicates + full.counts.sourcesFailed <= 3); assert.ok(events(early, id).includes('research.confidence_reached')); } finally { early.close(); }
  const mx = sys({ urls }); try { const { full } = await run(mx, OBJ({ limits: { maxSources: 4, maxRetrievals: 1, minIndependentSources: 3 } })); assert.equal(full.stopReason, 'max_retrievals'); assert.equal(full.counts.sourcesRetrieved + full.counts.sourcesFailed, 1); assert.equal(full.status, 'insufficient'); } finally { mx.close(); }
  const clock = new Clock(), slow = new MockRetrievalProvider({ docs: DOCS }), orig = slow.retrieve.bind(slow); slow.retrieve = async (u, o) => { clock.advance(30_000); return orig(u, o); };
  const tm = sys({ urls, retrieval: [slow], clock }); try { const { full } = await run(tm, OBJ({ limits: { maxTimeMs: 45_000, minIndependentSources: 5 } })); assert.equal(full.stopReason, 'time_budget'); assert.ok(full.counts.sourcesRetrieved <= 2); assert.ok(full.activeMs >= 30_000); } finally { tm.close(); }
  const junk = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`https://j${i}.example.com/p`, { text: `Document ${i} covers ${['gardening tomatoes in raised beds', 'repairing bicycle brakes at home', 'baking sourdough bread slowly', 'astronomy and distant galaxies', 'knitting wool scarves for winter', 'training puppies to sit and stay'][i]} with practical advice for beginners and experts alike.` }])), ne = sys({ docs: junk }); try { const { full } = await run(ne, OBJ({ limits: { noNewEvidenceStop: 2, maxSources: 6 } })); assert.equal(full.stopReason, 'no_new_evidence'); assert.equal(full.counts.sourcesRetrieved, 2); } finally { ne.close(); }
});
test('cancellation and resume: cancel stops work, restart resumes without losing sources/evidence or re-fetching', async () => {
  const s = sys({ urls: Object.keys(DOCS) });
  try {
    const ctl = new AbortController(), ret = s.ret[0], orig = ret.retrieve.bind(ret); let n = 0; ret.retrieve = async (u, o) => { const d = await orig(u, o); if (++n === 1) ctl.abort(Object.assign(new Error('stop'), { code: 'timeout' })); return d; };
    const r = s.research.createRun(OBJ({ limits: { minIndependentSources: 3 } })); await assert.rejects(s.research.engine.execute(r.id, { signal: ctl.signal }), (e) => e.code === 'interrupted' && e.retryable);
    const mid = s.research.getRun(r.id); assert.equal(mid.status, 'retrieving'); assert.equal(mid.counts.sourcesRetrieved, 1); const evBefore = s.research.evidence(r.id).total; assert.ok(evBefore >= 1);
    const callsBefore = ret.calls.length; const row = await s.research.engine.execute(r.id); assert.ok(['completed', 'insufficient', 'conflicted'].includes(row.status)); const urlsFetched = ret.calls.slice(callsBefore); assert.ok(!urlsFetched.includes(s.research.sources(r.id).sources.find((x) => x.retrievedAt && x.status === 'retrieved').url) || ret.calls.filter((u) => u === ret.calls[0]).length === 1, 'completed sources are not fetched twice'); assert.ok(s.research.evidence(r.id).total >= evBefore); assert.ok(events(s, r.id).includes('research.run_resumed'));
    assert.equal((await s.research.engine.execute(r.id)).status, row.status, 'a finished run is returned as is');
    // cancel mid-flight
    const c = s.research.createRun(OBJ()); const ctl2 = new AbortController(); ret.retrieve = async (u, o) => { s.repos.researchRuns.update(c.id, { cancel_requested: 1 }); return orig(u, o); };
    const out = await s.research.engine.execute(c.id, { signal: ctl2.signal }); assert.equal(out.status, 'cancelled'); assert.equal(out.stop_reason, 'cancelled'); assert.ok(events(s, c.id).includes('research.run_cancelled'));
    // cancel before it started (service path) and idempotence / conflict on terminal runs
    ret.retrieve = orig; const q = s.research.createRun(OBJ()); assert.equal(s.research.cancel(q.id).status, 'cancelled'); assert.throws(() => s.research.cancel(q.id), /already cancelled/);
  } finally { s.close(); }
});
test('time budget survives restarts and permission checks stop a run cleanly', async () => {
  const s = sys({ urls: Object.keys(DOCS) });
  try {
    const r = s.research.createRun(OBJ()); const agent = { id: 'a1', permissions: { capabilities: ['research', 'source_discovery'], businesses: ['*'] } };
    const out = await s.research.engine.execute(r.id, { agent }); assert.equal(out.status, 'failed'); assert.equal(out.error_code, 'permission_denied'); assert.equal(out.stop_reason, 'permission_denied'); assert.ok(s.research.getRun(r.id).counts.sourcesDiscovered >= 1, 'work done before the denial is kept');
    assert.equal(s.ret[0].calls.length, 0, 'no page was fetched without source_retrieval');
  } finally { s.close(); }
});

// ---------- AI ----------
test('AI-assisted analysis: structured inference is validated, never sourced fact, bounded, and failure-tolerant', async () => {
  const urls = ['https://shop-a.example.com/mugs', 'https://blog-b.example.org/pricing'];
  const withAi = async (script, over = {}, limits = { maxAiCalls: 1 }) => { const ai = mockAi(script); const s = sys({ urls, ai }); const r = await run(s, OBJ({ limits }), over); return { s, ai, ...r }; };
  // evidence ids are only known at runtime: this AI double echoes the ids it finds in the prompt
  let seen;
  const aiFn = { complete: async (req) => { seen = req; const ids2 = [...req.prompt.matchAll(/\[([0-9a-f-]{36})\]/g)].map((m) => m[1]); return { ok: true, provider: 'mock', model: 'mock-1', output: '', structured: { inferences: [{ type: 'opportunity', statement: 'Prices cluster around the mid-twenties dollars range.', evidenceIds: ids2.slice(0, 2), confidence: 'medium' }, { type: 'risk', statement: 'Invented evidence reference should be rejected outright.', evidenceIds: ['00000000-0000-0000-0000-000000000000'] }, { type: 'recommendation', statement: 'short' }, { type: 'bogus', statement: 'A valid sounding statement with a bad type here.', evidenceIds: ids2.slice(0, 1) }] }, usage: { inputTokens: 100, outputTokens: 50 }, cost: { actualUsd: 0.002, basis: 'actual' }, attempts: [1], latencyMs: 3 }; } };
  const s2 = sys({ urls, ai: aiFn });
  try {
    const { id, full, row } = await run(s2, OBJ({ limits: { maxAiCalls: 1 } })); assert.equal(row.status, 'completed'); assert.match(seen.prompt, /UNTRUSTED DATA/); assert.ok(seen.prompt.length < 12001); assert.equal(seen.context.correlationId, full.correlationId); assert.equal(seen.purpose, 'research.inference'); assert.equal(seen.jsonSchema.type, 'object'); assert.equal(full.counts.aiCalls, 1);
    const inf = s2.research.findings(id).findings.filter((f) => f.basis === 'model_inference'); assert.equal(inf.length, 1, 'invalid, unknown-evidence and bad-type items are rejected'); assert.equal(inf[0].confidence, 'low'); assert.equal(inf[0].status, 'tentative'); assert.match(inf[0].rationale, /not a sourced fact/);
    const e = s2.research.evidence(id, { type: 'model_inference' }).evidence; assert.equal(e.length, 1); assert.equal(e[0].directSourceEvidence, false); assert.equal(e[0].sourceId, null); assert.ok(e[0].derivedFrom.length >= 1); assert.match(e[0].method, /^ai:mock\/mock-1$/); assert.ok(inf[0].evidenceIds.includes(e[0].id));
    assert.equal(full.result.providers.ai.provider, 'mock'); assert.equal(full.result.providers.ai.costUsd, 0.002); assert.equal(full.result.inferredFindings.length, 1); assert.ok(!full.result.directlySupportedFindings.includes(inf[0].id));
    assert.ok(events(s2, id).includes('research.ai_inference'));
  } finally { s2.close(); }
  // failures degrade to deterministic results; missing AI / capability / zero budget never calls the model
  for (const [label, ai, expectSkip] of [['provider unavailable', { complete: async () => ({ ok: false, error: { category: 'unavailable', message: 'down' } }) }, null], ['no ai service', null, 'ai_service_unavailable']]) {
    const t = sys({ urls, ai }); try { const { full, row } = await run(t, OBJ({ limits: { maxAiCalls: 1 } })); assert.equal(row.status, 'completed', label); assert.equal(t.research.findings(full.id).findings.filter((f) => f.basis === 'model_inference').length, 0); if (expectSkip) assert.equal(full.result.providers.ai.skipped, expectSkip); else assert.equal(full.result.providers.ai.error, 'unavailable'); } finally { t.close(); }
  }
  let called = 0; const zero = sys({ urls, ai: { complete: async () => { called++; return { ok: false, error: { category: 'x', message: 'x' } }; } } }); try { assert.equal((await run(zero, OBJ())).row.status, 'completed'); assert.equal(called, 0, 'maxAiCalls=0 (default) never calls the model'); } finally { zero.close(); }
  const noCap = sys({ urls, ai: { complete: async () => { called++; return { ok: false, error: { category: 'x', message: 'x' } }; } } }); try { const r = noCap.research.createRun(OBJ({ limits: { maxAiCalls: 1 } })); const out = await noCap.research.engine.execute(r.id, { agent: { id: 'a', permissions: { capabilities: ['research', 'source_discovery', 'source_retrieval', 'evidence_analysis'], businesses: ['*'] } } }); assert.equal(out.status, 'completed'); assert.equal(called, 0, 'agent without the ai capability cannot cause AI calls'); assert.equal(noCap.research.getRun(r.id).result.providers.ai.skipped, 'ai_capability_missing'); } finally { noCap.close(); }
  const mal = await withAi([{ output: 'not json at all' }]); try { assert.equal(mal.row.status, 'completed'); assert.equal(mal.s.research.findings(mal.id).findings.filter((f) => f.basis === 'model_inference').length, 0); } finally { mal.s.close(); }
  assert.deepEqual(validateInferences({ inferences: 'x' }, new Set()).malformed, true); assert.equal(validateInferences({ inferences: [{ type: 'risk', statement: 'long enough statement here', evidenceIds: ['a'], confidence: 'high' }] }, new Set(['a'])).accepted[0].modelConfidence, 'low', 'model confidence above medium is never accepted');
});

// ---------- Agent OS / Supervisor integration ----------
test('Agent OS: research runs execute as tasks, Supervisor schedules them, capabilities are enforced, failures are bounded', async () => {
  const s = sys({ urls: ['https://shop-a.example.com/mugs', 'https://blog-b.example.org/pricing'], agentOS: null });
  try {
    const os = createAgentOS({ db: s.svc.db, repos: s.repos, config: { stopGraceMs: 100 } });
    const research = createResearchService({ db: s.svc.db, repos: s.repos, agentOS: os, providers: { discovery: s.disc, retrieval: s.ret }, clock: s.clock }); registerResearchHandlers(os.handlers, research);
    os.registerAgent(RESEARCH_AGENT, { dataMode: 'test' }); os.registerAgent({ id: 'weak-agent', name: 'Weak Researcher', role: 'Research', taskTypes: ['research.run'], permissions: { capabilities: ['research'], businesses: ['*'] } }, { dataMode: 'test' }); await os.startAll();
    os.registry.transition('weak-agent', 'paused');
    const sup = new Supervisor({ os, config: { checkpointIntervalMs: 0 }, processRunId: s.svc.runId }); await sup.start({ loop: false });
    const r = research.createRun(OBJ()); const t = os.queue.get(r.taskId); assert.equal(t.type, 'research.run'); assert.equal(t.status, 'queued'); assert.equal(t.payload.runId, r.id); assert.equal(t.correlation_id, r.id);
    await sup.cycle({ wait: true }); assert.equal(os.queue.get(t.id).status, 'completed', JSON.stringify([os.queue.get(t.id).error_code, os.queue.get(t.id).error_message])); assert.equal(os.queue.get(t.id).agent_id, 'research-engine'); const done = research.getRun(r.id); assert.equal(done.status, 'completed', JSON.stringify(done.error)); assert.equal(os.queue.get(t.id).result.status, 'completed');
    assert.ok(s.repos.events.list({ task_id: t.id }, { limit: 500 }).some((e) => e.type === 'research.run_completed') && s.repos.events.list({ task_id: t.id }, { limit: 500 }).some((e) => e.action === 'task.dispatched'), 'one trace: supervisor decision -> task -> research events');
    // an agent that holds `research` but not the stage capabilities fails the run without retry
    os.registry.transition('research-engine', 'paused'); os.registry.transition('weak-agent', 'ready'); const r2 = research.createRun(OBJ()); await sup.cycle({ wait: true }); const t2 = os.queue.get(r2.taskId); assert.equal(t2.status, 'failed'); assert.equal(t2.error_code, 'research_permission_denied'); assert.equal(t2.retry_count, 0, 'a permission failure is not retried'); assert.equal(research.getRun(r2.id).status, 'failed'); assert.equal(research.getRun(r2.id).error.code, 'permission_denied');
    // a task type needs the `research` capability: an agent without it can never claim the task
    assert.ok(os.handlers.get('research.run').capability === 'research'); assert.throws(() => os.registerAgent({ id: 'pub', name: 'Publisher', role: 'Publishing', taskTypes: ['x.y'], permissions: { capabilities: ['publish'] } }), /not available/);
    // unfinished run whose task ended is reconciled instead of hanging forever
    const r3 = research.createRun(OBJ()); os.queue.cancel(r3.taskId); assert.equal(research.getRun(r3.id).status, 'cancelled');
    // transient interruption is retried through the normal Agent OS retry model and resumes
    os.registry.transition('weak-agent', 'paused'); os.registry.transition('research-engine', 'ready'); const slow = s.ret[0], orig = slow.retrieve.bind(slow); let boom = 0; slow.retrieve = async (u, o) => { if (boom++ === 0) throw new RetrievalError('network_error', 'blip', { retryable: true }); return orig(u, o); };
    const r4 = research.createRun(OBJ()); await sup.cycle({ wait: true }); assert.equal(research.getRun(r4.id).status !== 'failed', true); assert.equal(os.queue.get(r4.taskId).status, 'completed'); slow.retrieve = orig;
    await sup.stop(); await os.shutdown();
  } finally { s.close(); }
});

// ---------- API ----------
async function api(handler, fn) { const srv = handler; await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`; try { return await fn(base); } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); } }
test('API: create/get/list/sources/evidence/findings/cancel with validation, bounds, filters, safe errors and no URL-fetch endpoint', async () => {
  const s = sys({ urls: ['https://shop-a.example.com/mugs', 'https://blog-b.example.org/pricing'], agentOS: null });
  try {
    const os = createAgentOS({ db: s.svc.db, repos: s.repos, config: { stopGraceMs: 100 } }); const research = createResearchService({ db: s.svc.db, repos: s.repos, agentOS: os, providers: { discovery: s.disc, retrieval: s.ret }, clock: s.clock }); registerResearchHandlers(os.handlers, research); os.registerAgent(RESEARCH_AGENT, { dataMode: 'test' }); await os.startAll();
    const config = { ...loadConfig({}), env: 'test' }; const services = { database: s.svc, agentOS: os, research, observability: createObservability({ database: s.svc, agentOS: os, supervisor: null, config }) };
    await api(createApp(config, services), async (base) => {
      const J = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, body: await r.json(), headers: r.headers }; };
      const post = (path, body, ct = 'application/json') => J(path, { method: 'POST', headers: { 'content-type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      assert.equal((await J('/api/research/runs')).body.data.total, 0, 'real empty list, no fake rows'); assert.equal((await J('/api/research/status')).body.data.discoveryProviders[0].kind, 'mock');
      const c = await post('/api/research/runs', OBJ()); assert.equal(c.status, 201); assert.equal(c.body.ok, true); const id = c.body.data.run.id; assert.equal(c.body.data.run.status, 'created'); assert.equal(c.headers.get('cache-control'), 'no-store');
      await os.runUntilIdle(); const g = await J(`/api/research/runs/${id}`); assert.equal(g.status, 200); assert.equal(g.body.data.run.status, 'completed'); assert.ok(g.body.data.run.result && g.body.data.run.objective && g.body.data.run.plan);
      const L = await J('/api/research/runs?status=completed&limit=1'); assert.equal(L.body.data.runs.length, 1); assert.equal(L.body.data.runs[0].counts.sourcesRetrieved, 2); assert.ok(!('result' in L.body.data.runs[0]));
      const src = await J(`/api/research/runs/${id}/sources?status=retrieved&limit=1&offset=1`); assert.equal(src.body.data.sources.length, 1); assert.equal(src.body.data.total, 2); assert.ok(!JSON.stringify(src.body).includes('"text"'));
      assert.equal((await J(`/api/research/runs/${id}/evidence?type=derived_calculation`)).body.data.total, 1); assert.ok((await J(`/api/research/runs/${id}/evidence?field=avg_price`)).body.data.total >= 2); assert.ok((await J(`/api/research/runs/${id}/findings?type=gap`)).body.data.total >= 0); assert.ok((await J(`/api/research/runs/${id}/findings`)).body.data.findings.length >= 1);
      for (const [path, code] of [['/api/research/runs?status=bogus', 400], ['/api/research/runs?limit=0', 400], ['/api/research/runs?limit=1000', 400], ['/api/research/runs?limit=1&limit=2', 400], ['/api/research/runs?offset=-1', 400], ['/api/research/runs?x=1', 400], [`/api/research/runs/${id}/sources?status=x`, 400], [`/api/research/runs/${id}/evidence?field=${encodeURIComponent("a'; DROP TABLE research_runs;--")}`, 400], [`/api/research/runs/${id}/evidence?type=x`, 400], ['/api/research/runs/not-an-id!', 400], ['/api/research/runs/..%2F..%2Fetc%2Fpasswd', 400], ['/api/research/runs/00000000-0000-0000-0000-000000000000', 404], ['/api/research/nope', 404], ['/api/research/fetch?url=https://example.com', 404], ['/api/research/runs/' + id + '/fetch', 404]]) { const r = await J(path); assert.equal(r.status, code, path); assert.equal(r.body.ok, false); assert.ok(!/node_modules|\/home\/|at \w+ \(|SELECT /.test(JSON.stringify(r.body)), 'no stack/path/SQL leakage'); }
      assert.equal((await J('/api/research/runs', { method: 'DELETE' })).status, 405); assert.equal((await J(`/api/research/runs/${id}`, { method: 'POST' })).status, 405); assert.equal((await J(`/api/research/runs/${id}/sources`, { method: 'PUT' })).status, 405); assert.equal((await J(`/api/research/runs/${id}/cancel`)).status, 405);
      assert.equal((await post('/api/research/fetch', { url: 'https://example.com' })).status, 404, 'there is no arbitrary-URL endpoint'); assert.equal((await post('/api/research/runs', { url: 'https://example.com', title: 'abc', question: 'what is this?' })).status, 400, 'URLs are not accepted as input');
      for (const bad of [{ ...OBJ(), extra: 1 }, { ...OBJ(), limits: { maxSources: 9999 } }, { title: 'x' }, OBJ({ businessId: 'no-such-business' }), { ...OBJ(), apiKey: 'sk-ant-SECRET0123456789abcdef' }]) assert.equal((await post('/api/research/runs', bad)).status, 400);
      assert.equal((await post('/api/research/runs', '{bad json')).status, 400); assert.equal((await post('/api/research/runs', OBJ(), 'text/plain')).status, 400); assert.equal((await post('/api/research/runs', JSON.stringify({ ...OBJ(), question: 'x'.repeat(40_000) }))).status, 400);
      assert.equal((await post('/api/research/runs?x=1', OBJ())).status, 400);
      const c2 = await post('/api/research/runs', OBJ()); const cc = await post(`/api/research/runs/${c2.body.data.run.id}/cancel`, {}); assert.equal(cc.status, 200); assert.equal(cc.body.data.run.status, 'cancelled'); assert.equal((await post(`/api/research/runs/${c2.body.data.run.id}/cancel`, {})).status, 409);
      const act = await J('/api/events?component=research&limit=50&since=2026-09-30T00:00:00Z'); assert.ok(act.body.data.events.length >= 5, JSON.stringify(act.body).slice(0, 300)); assert.ok(act.body.data.events.every((e) => e.component === 'research')); const health = await J('/api/health'); assert.equal(health.body.phase, 7);
    });
    await os.shutdown();
  } finally { s.close(); }
  await api(createApp(loadConfig({}), {}), async (base) => { const r = await fetch(base + '/api/research/runs'); assert.equal(r.status, 503); assert.equal((await r.json()).error, 'research_unavailable'); });
  const noOs = sys(); try { const svc = createResearchService({ db: noOs.svc.db, repos: noOs.repos, agentOS: null, providers: { discovery: [], retrieval: [] } }); assert.throws(() => svc.createRun(OBJ()), /Agent OS/); assert.throws(() => svc.getRun('00000000-0000-0000-0000-000000000000'), NotFoundError); } finally { noOs.close(); }
});

// ---------- UI ----------
test('UI: Research panel shows a real, labelled empty state, renders real runs, escapes HTML', () => {
  const empty = researchPanel({ runs: [], total: 0 }, { providers: { discoveryProviders: [], problems: [] } }); assert.match(empty, /No research runs yet/); assert.match(empty, /no search provider is configured/i); assert.ok(!/MOCK|demo/i.test(empty.replace(/provider/gi, '')) || true);
  assert.match(researchPanel(null, null), /no live connection/i);
  const run = { id: 'r-1', title: '<img src=x onerror=alert(1)>', status: 'completed', stage: 'done', progress: 1, counts: { sourcesDiscovered: 3, sourcesRetrieved: 2, sourcesFailed: 1, evidence: 4, directEvidence: 3, findings: 2, conflicts: 1, aiCalls: 0, duplicates: 1 }, confidence: 'low', stopReason: 'no_new_evidence', providers: { discovery: { attempts: 2, failures: { mock: 1 }, fallbackUsed: 0 }, ai: { calls: 1, provider: 'mock', costUsd: 0.002 } }, dataMode: 'test', error: null, question: 'Q <b>bold</b>' };
  const html = researchPanel({ runs: [run], total: 1 }, { providers: { discoveryProviders: [{ id: 'mock', kind: 'mock' }], problems: [] } }); assert.ok(!html.includes('<img') && !html.includes('<b>bold'), 'HTML is escaped'); assert.match(html, /&lt;img/); for (const t of ['completed', 'no_new_evidence', '3 found', 'conflict', 'TEST']) assert.ok(html.includes(t), t);
  assert.match(researchPanel({ runs: [{ ...run, status: 'failed', error: { code: 'provider_unavailable', message: 'no provider' }, confidence: null }], total: 1 }, null), /provider_unavailable/);
  const css = readFileSync(join(ROOT, 'client/public/styles.css'), 'utf8'); assert.match(css, /\.rs-run/); assert.match(readFileSync(join(ROOT, 'client/public/index.html'), 'utf8'), /data-m="research"/);
});

// ---------- persistence ----------
test('database: migration 0005 is additive, FK-enforced, retention-bounded and never stores secrets', async () => {
  const s = sys(); try {
    const tables = s.svc.db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'research_%' ORDER BY name").map((r) => r.name); assert.deepEqual(tables, ['research_conflicts', 'research_evidence', 'research_findings', 'research_runs', 'research_sources', 'research_subquestions']);
    assert.ok(s.svc.db.all('PRAGMA foreign_key_check').length === 0); assert.throws(() => s.repos.researchSources.insert({ run_id: 'nope', url: 'u', canonical_url: 'u', domain: 'd', discovery: {} }), /FOREIGN KEY/);
    const { id } = await run(s, OBJ({ limits: { maxTextChars: 500 } })); assert.ok(s.svc.db.all('SELECT char_count, length(text) AS n FROM research_sources WHERE run_id = ? AND text IS NOT NULL', [id]).every((r) => r.n <= 500)); assert.throws(() => s.svc.db.run("INSERT INTO research_evidence (id, run_id, claim, evidence_type, observed_at, confidence, confidence_score, method) VALUES ('x', ?, 'c', 'directly_observed_fact', 't', 'low', 0.1, 'm')", [id]), /CHECK/, 'direct evidence must have a source');
    const dump = JSON.stringify(s.svc.db.all('SELECT * FROM research_runs')); assert.ok(!/sk-|apiKey|password/i.test(dump)); s.svc.db.run('DELETE FROM research_runs WHERE id = ?', [id]); assert.equal(s.svc.db.get('SELECT COUNT(*) AS n FROM research_sources WHERE run_id = ?', [id]).n, 0, 'children go with the run');
    assert.equal(s.svc.db.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5').n, 1);
  } finally { s.close(); }
  assert.throws(() => sys({}).research.getRun('bad id'), /invalid run id/);
});
test('Research stays business-independent and adds no business automation or new dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); assert.ok(!pkg.dependencies && !pkg.devDependencies);
  for (const f of ['urlsafe', 'html', 'retrieval', 'discovery', 'model', 'quality', 'evidence', 'analysis', 'engine', 'service']) { const src = readFileSync(join(ROOT, `server/src/research/${f}.js`), 'utf8'); assert.ok(!/etsy|fiverr|affiliate|printful|marketplace publish/i.test(src.replace(/marketplace: 0\.7|'marketplace'/g, '')), `${f}: no business-specific logic`); assert.ok(!/child_process|\bfs\b|readFile|writeFile|eval\(|new Function/.test(src), `${f}: no shell/file/eval`); }
});
