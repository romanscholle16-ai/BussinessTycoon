// Provider-independent discovery. Providers return raw hits; this module normalizes, validates and bounds them.
// No commercial provider is hardcoded and no credentials are needed: the deterministic mock is built in, a generic JSON search
// adapter (e.g. a self-hosted SearXNG) is configured by endpoint only.
import { validateUrl, canonicalizeUrl, domainOf, normalizePolicy } from './urlsafe.js';
import { tokenize } from './model.js';

export class DiscoveryError extends Error { constructor(code, message, { retryable = false } = {}) { super(message); this.name = 'DiscoveryError'; this.code = code; this.retryable = retryable; } }

/** Deterministic mock: ranks a fixed corpus by term overlap (ties by URL). `script` can inject failures per call index. */
export class MockDiscoveryProvider {
  constructor({ id = 'mock', corpus = [], failWith = null, script = null } = {}) { this.id = id; this.kind = 'mock'; this.corpus = corpus; this.failWith = failWith; this.script = script; this.calls = 0; }
  async discover({ query, limit = 10, signal }) {
    const n = this.calls++; if (signal?.aborted) throw new DiscoveryError('cancelled', 'discovery cancelled');
    const f = this.script?.[n] ?? this.failWith; if (f) throw new DiscoveryError(f.code ?? 'unavailable', f.message ?? 'mock provider unavailable', { retryable: !!f.retryable });
    const q = new Set(tokenize(query));
    return this.corpus.map((d) => { const t = tokenize(`${d.title} ${d.snippet ?? ''} ${(d.keywords ?? []).join(' ')}`); const hit = t.filter((w) => q.has(w)).length; return { d, hit }; })
      .filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit || (a.d.url < b.d.url ? -1 : 1)).slice(0, limit).map((x, i) => ({ title: x.d.title, url: x.d.url, snippet: x.d.snippet ?? null, rank: i + 1, typeHint: x.d.typeHint ?? null }));
  }
}

/** Generic JSON search adapter: GET {endpoint}?q=...&format=json -> {results:[{title,url,content}]}. Endpoint is operator-configured; no key. */
export function createJsonSearchProvider({ id = 'json_search', endpoint, fetchImpl = globalThis.fetch, timeoutMs = 8000, networkPolicy } = {}) {
  const policy = normalizePolicy(networkPolicy);
  const ep = validateUrl(endpoint, policy); // the operator endpoint obeys the same explicit network policy
  return { id, kind: 'json_search', async discover({ query, limit = 10, signal }) {
    const u = new URL(ep); u.searchParams.set('q', query); u.searchParams.set('format', 'json');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs), onAbort = () => ctl.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(u, { signal: ctl.signal, redirect: 'error', headers: { accept: 'application/json' } });
      if (!res.ok) throw new DiscoveryError(res.status === 429 ? 'rate_limited' : 'unavailable', `search provider returned HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
      const text = await res.text(); if (text.length > 1_000_000) throw new DiscoveryError('malformed_response', 'search response too large');
      let j; try { j = JSON.parse(text); } catch { throw new DiscoveryError('malformed_response', 'search provider returned non-JSON'); }
      if (!Array.isArray(j?.results)) throw new DiscoveryError('malformed_response', 'search provider returned an unexpected shape');
      return j.results.slice(0, limit).map((r, i) => ({ title: typeof r.title === 'string' ? r.title : null, url: r.url, snippet: typeof r.content === 'string' ? r.content : null, rank: i + 1 }));
    } catch (e) {
      if (e instanceof DiscoveryError) throw e;
      if (signal?.aborted) throw new DiscoveryError('cancelled', 'discovery cancelled');
      throw new DiscoveryError(ctl.signal.aborted ? 'timeout' : 'unavailable', ctl.signal.aborted ? 'search provider timed out' : `search provider unreachable (${e?.cause?.code ?? e?.code ?? 'network error'})`, { retryable: true });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  } };
}

/** Normalizes raw hits: valid URLs only (policy-checked), canonical dedup within the batch, bounded text. Returns {hits, dropped}. */
export function normalizeHits(raw, { provider, query, policy, now = () => new Date().toISOString(), limit = 10 }) {
  const hits = [], seen = new Set(); let dropped = 0;
  if (!Array.isArray(raw)) throw new DiscoveryError('malformed_response', 'provider returned a non-list result');
  for (const r of raw) {
    if (hits.length >= limit) break;
    try {
      if (!r || typeof r.url !== 'string') throw new Error('no url');
      const u = validateUrl(r.url, policy), canonical = canonicalizeUrl(u.toString());
      if (seen.has(canonical)) { dropped++; continue; } seen.add(canonical);
      hits.push({ query, title: typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null, url: u.toString(), canonicalUrl: canonical, domain: domainOf(u.toString()), snippet: typeof r.snippet === 'string' ? r.snippet.replace(/\s+/g, ' ').trim().slice(0, 500) : null, rank: Number.isInteger(r.rank) && r.rank > 0 ? r.rank : hits.length + 1, provider, typeHint: typeof r.typeHint === 'string' ? r.typeHint : null, discoveredAt: now() });
    } catch { dropped++; }
  }
  return { hits, dropped };
}

/** Deterministic mock retrieval provider: serves documents from a fixed corpus through the same URL policy and normalization. */
import { extractHtml, plainText } from './html.js';
import { RetrievalError } from './retrieval.js';
export class MockRetrievalProvider {
  constructor({ id = 'mock', docs = {}, policy, failures = {}, maxTextChars = 20000 } = {}) { this.id = id; this.kind = 'mock'; this.docs = docs; this.failures = failures; this.policy = normalizePolicy(policy); this.maxTextChars = maxTextChars; this.calls = []; }
  async retrieve(url, { signal } = {}) {
    this.calls.push(url); if (signal?.aborted) throw new RetrievalError('cancelled', 'retrieval cancelled');
    let u; try { u = validateUrl(url, this.policy); } catch (e) { throw new RetrievalError(e.code ?? 'invalid_url', e.message); }
    const key = canonicalizeUrl(u.toString()), f = this.failures[key] ?? this.failures[url]; if (f) throw new RetrievalError(f.code, f.message ?? f.code, { retryable: !!f.retryable });
    const d = this.docs[key] ?? this.docs[url]; if (!d) throw new RetrievalError('http_error', 'the site returned HTTP 404');
    const ex = d.html ? extractHtml(d.html, { maxChars: this.maxTextChars }) : plainText(d.text ?? '', { maxChars: this.maxTextChars });
    if (!ex.text) throw new RetrievalError('empty_content', 'no readable text could be extracted');
    return { requestedUrl: url, finalUrl: d.finalUrl ?? u.toString(), redirectChain: [], status: 200, contentType: d.html ? 'text/html' : 'text/plain', title: d.title ?? ex.title, text: ex.text, author: d.author ?? ex.author, publishedAt: d.publishedAt ?? ex.publishedAt, language: d.language ?? ex.language, canonicalHref: ex.canonicalHref, contentLength: Buffer.byteLength(d.html ?? d.text ?? ''), retrievedAt: d.retrievedAt ?? new Date().toISOString(), provider: this.id, limitations: ex.truncated ? [`text truncated to ${this.maxTextChars} characters`] : [], extractionStatus: ex.truncated ? 'truncated' : 'complete' };
  }
}
