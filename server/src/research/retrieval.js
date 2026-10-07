// Safe retrieval: URL policy, DNS pre-check + connection-time DNS guard, manual redirects with per-hop validation,
// strict timeout/size/redirect limits, content-type allowlist, robots.txt respect, no JS execution, no cookies, no auth.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { createHash } from 'node:crypto';
import { validateUrl, assertResolvedAllowed, canonicalizeUrl, domainOf, normalizePolicy, UrlRejected } from './urlsafe.js';
import { extractHtml, plainText, countWords } from './html.js';

export class RetrievalError extends Error { constructor(code, message, { retryable = false } = {}) { super(message); this.name = 'RetrievalError'; this.code = code; this.retryable = retryable; } }
export const RETRIEVAL_DEFAULTS = Object.freeze({ timeoutMs: 8000, maxBytes: 1_000_000, maxRedirects: 3, maxTextChars: 20000, respectRobots: true, userAgent: 'AutonomousTycoonResearch/0.7 (bounded research bot)' });
const ALLOWED_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json|text\/xml|application\/xml)\b/i;
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const contentHash = (text) => sha(text.toLowerCase().replace(/\s+/g, ' ').trim());

/** DNS lookup that refuses disallowed addresses at CONNECT time (closes the check-then-connect rebinding window). */
export function guardedLookup(policy, resolver = dns.lookup) {
  return (hostname, options, cb) => {
    const done = typeof options === 'function' ? options : cb, opts = typeof options === 'function' ? {} : options;
    resolver(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return done(err);
      try { assertResolvedAllowed(addrs, policy); } catch (e) { return done(Object.assign(new Error(e.message), { code: e.code })); }
      if (opts.all) return done(null, addrs);
      done(null, addrs[0].address, addrs[0].family);
    });
  };
}

/** Real transport on node:http(s). One request, no redirects, no cookies, identity encoding, body capped at maxBytes. */
export function createNodeTransport({ lookupResolver } = {}) {
  return ({ url, policy, timeoutMs, maxBytes, signal, headers }) => new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    let settled = false; const fin = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); } };
    const req = mod.request(url, { method: 'GET', headers: { ...headers, 'accept-encoding': 'identity', connection: 'close' }, lookup: guardedLookup(policy, lookupResolver), agent: false }, (res) => {
      const len = Number(res.headers['content-length']);
      const isRedirect = res.statusCode >= 300 && res.statusCode < 400;
      if (!isRedirect && Number.isFinite(len) && len > maxBytes) { fin(reject, new RetrievalError('response_too_large', `response exceeds ${maxBytes} bytes`)); res.destroy(); return; }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { fin(reject, new RetrievalError('response_too_large', `response exceeds ${maxBytes} bytes`)); res.destroy(); } else chunks.push(c); });
      res.on('end', () => fin(resolve, { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])), body: Buffer.concat(chunks) }));
      res.on('error', () => fin(reject, new RetrievalError('network_error', 'connection dropped while reading', { retryable: true })));
      res.on('aborted', () => fin(reject, new RetrievalError('network_error', 'connection dropped while reading', { retryable: true })));
    });
    const timer = setTimeout(() => { fin(reject, new RetrievalError('timeout', `no complete response within ${timeoutMs}ms`, { retryable: true })); req.destroy(); }, timeoutMs);
    const onAbort = () => { fin(reject, new RetrievalError('cancelled', 'retrieval cancelled')); req.destroy(); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    req.on('error', (e) => { const blocked = e.code && /_blocked$|^dns_failure$/.test(e.code); fin(reject, blocked ? new RetrievalError(e.code, 'target address is not allowed by the network policy') : new RetrievalError('network_error', `could not reach the host (${e.code ?? 'network error'})`, { retryable: true })); });
    req.end();
  });
}

function parseRobots(text, agent = '*') {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false; if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
  }
  const g = groups.find((x) => x.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a))) ?? groups.find((x) => x.agents.includes('*'));
  return (path) => { let best = null; for (const r of g?.rules ?? []) { if (!r.path) continue; const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')); if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r; } return best ? best.allow : true; };
}

/**
 * Creates a retriever. `resolver(hostname) -> Promise<[{address}]>` and `transport(opts)` are injectable (tests use doubles; production
 * uses node dns + node http(s)). `retrieve(url, {signal})` returns a normalized document or throws RetrievalError with a SAFE message.
 */
export function createSafeRetriever({ policy: policyIn, limits = {}, transport = createNodeTransport(), resolver = (h) => dns.promises.lookup(h, { all: true }), id = 'http' } = {}) {
  const policy = normalizePolicy(policyIn), L = { ...RETRIEVAL_DEFAULTS, ...limits }, robotsCache = new Map();
  const headers = { 'user-agent': L.userAgent, accept: 'text/html,text/plain,application/json;q=0.8,*/*;q=0.1' };

  async function checkTarget(u) {
    try {
      validateUrl(u.toString(), policy);
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (/^[\d.]+$/.test(host) || host.includes(':')) return; // literal IP already validated
      let addrs; try { addrs = await resolver(host); } catch { throw new UrlRejected('dns_failure', 'host name did not resolve'); }
      assertResolvedAllowed(addrs, policy);
    } catch (e) { if (e instanceof UrlRejected) throw new RetrievalError(e.code, e.message); throw e; }
  }
  async function fetchOnce(u, signal, maxBytes = L.maxBytes) { await checkTarget(u); return transport({ url: u, policy, timeoutMs: L.timeoutMs, maxBytes, signal, headers }); }

  async function robotsAllows(u, signal) {
    if (!L.respectRobots) return true;
    const key = u.origin; let allow = robotsCache.get(key);
    if (!allow) {
      try {
        const r = await fetchOnce(new URL('/robots.txt', u.origin), signal, 200_000);
        if (r.status >= 500) allow = () => false; // robots unreachable by server error: assume disallowed
        else if (r.status >= 200 && r.status < 300) allow = parseRobots(r.body.toString('utf8'), L.userAgent);
        else allow = () => true; // 404/401/403 etc.: no robots rules published
      } catch (e) { if (e.code === 'cancelled') throw e; allow = () => false; } // cannot confirm permission: do not fetch
      robotsCache.set(key, allow);
    }
    return allow(u.pathname + u.search);
  }

  async function retrieve(inputUrl, { signal } = {}) {
    if (signal?.aborted) throw new RetrievalError('cancelled', 'retrieval cancelled');
    let u; try { u = validateUrl(inputUrl, policy); } catch (e) { throw new RetrievalError(e.code ?? 'invalid_url', e.message); }
    const limitations = [], chain = [u.toString()];
    if (!(await robotsAllows(u, signal))) throw new RetrievalError('robots_disallowed', 'robots.txt does not allow retrieval of this URL');
    let res, hops = 0;
    for (;;) {
      res = await fetchOnce(u, signal);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (++hops > L.maxRedirects) throw new RetrievalError('too_many_redirects', `more than ${L.maxRedirects} redirects`);
        let next; try { next = new URL(res.headers.location, u); } catch { throw new RetrievalError('invalid_redirect', 'redirect target could not be parsed'); }
        if (u.protocol === 'https:' && next.protocol === 'http:') throw new RetrievalError('redirect_downgrade', 'redirect from HTTPS to HTTP refused');
        try { validateUrl(next.toString(), policy); } catch (e) { throw new RetrievalError(e.code === 'invalid_url' ? 'invalid_redirect' : e.code, `redirect refused: ${e.message}`); }
        if (!(await robotsAllows(next, signal))) throw new RetrievalError('robots_disallowed', 'robots.txt does not allow the redirect target');
        u = next; chain.push(u.toString()); continue;
      }
      break;
    }
    if (res.status === 401 || res.status === 403 || res.status === 402) throw new RetrievalError('access_denied', `the site requires access that research does not bypass (HTTP ${res.status})`);
    if (res.status === 429) throw new RetrievalError('rate_limited', 'the site rate-limited the request', { retryable: true });
    if (res.status >= 500) throw new RetrievalError('server_error', `the site returned HTTP ${res.status}`, { retryable: true });
    if (res.status < 200 || res.status >= 300) throw new RetrievalError('http_error', `the site returned HTTP ${res.status}`);
    const ctype = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!ctype || !ALLOWED_TYPES.test(ctype)) throw new RetrievalError('unsupported_content_type', `content type "${ctype.slice(0, 60) || 'unknown'}" is not supported`);
    const raw = res.body.toString('utf8');
    if (raw.includes('\u0000') || raw.includes('���')) throw new RetrievalError('malformed_content', 'content is not valid text');
    const ex = /html|xml/.test(ctype) && ctype !== 'text/xml' && ctype !== 'application/xml' ? extractHtml(raw, { maxChars: L.maxTextChars }) : plainText(raw, { maxChars: L.maxTextChars });
    if (ex.truncated) limitations.push(`text truncated to ${L.maxTextChars} characters`);
    if (/<script\b/i.test(raw)) limitations.push('page scripts are never executed; script-rendered content is not captured');
    if (!ex.text) throw new RetrievalError('empty_content', 'no readable text could be extracted');
    const finalUrl = u.toString();
    return { requestedUrl: inputUrl, finalUrl, redirectChain: chain.length > 1 ? chain.map((x) => canonicalizeUrl(x)) : [], status: res.status, contentType: ctype, title: ex.title, text: ex.text, author: ex.author, publishedAt: ex.publishedAt, language: ex.language, canonicalHref: ex.canonicalHref, contentLength: res.body.length, retrievedAt: new Date().toISOString(), provider: id, limitations, extractionStatus: ex.truncated ? 'truncated' : 'complete' };
  }
  return { id, kind: 'http', policy, limits: L, retrieve };
}

/** Normalizes a retrieved document into the stored source shape (nothing is invented: unknown stays null). */
export function normalizeDocument(doc, { maxTextChars = 20000 } = {}) {
  const text = doc.text.slice(0, maxTextChars);
  let canonical = canonicalizeUrl(doc.finalUrl ?? doc.requestedUrl);
  if (doc.canonicalHref) { try { const c = new URL(doc.canonicalHref, doc.finalUrl); if (domainOf(c.toString()) === domainOf(doc.finalUrl) && /^https?:$/.test(c.protocol)) canonical = canonicalizeUrl(c.toString()); } catch { /* ignore */ } } // only same-domain canonical hints are trusted
  return { canonicalUrl: canonical, finalUrl: doc.finalUrl, domain: domainOf(doc.finalUrl), title: doc.title ?? null, text, author: doc.author ?? null, publishedAt: doc.publishedAt ?? null, language: doc.language ?? null, contentType: doc.contentType, contentLength: doc.contentLength, wordCount: countWords(text), charCount: text.length, extractionStatus: doc.extractionStatus, contentHash: contentHash(text), retrievedAt: doc.retrievedAt, provider: doc.provider, limitations: doc.limitations ?? [], httpStatus: doc.status ?? null, redirectChain: doc.redirectChain ?? [] };
}
