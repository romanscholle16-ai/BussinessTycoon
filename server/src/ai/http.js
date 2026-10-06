// Bounded HTTP for providers: timeout, cancellation, size cap, no redirects, no credential echo in errors.
import { AiError, categoryForStatus } from './errors.js';

const TIMEOUT = Symbol('timeout'), CANCEL = Symbol('cancel');

async function readBounded(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader(), chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new AiError('malformed_response', `response exceeded ${maxBytes} bytes`); } chunks.push(value); }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @returns {{status:number, headers:Headers, json:any, text:string}} for 2xx. Non-2xx throws AiError with the mapped category.
 * `parseError(json,status)` may return an extra message from the provider's error body (it is redacted by the caller).
 */
export async function requestJson(url, { method = 'POST', headers = {}, body, timeoutMs, signal, fetchImpl = globalThis.fetch, maxBytes = 2_000_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
  const onAbort = () => controller.abort(CANCEL);
  if (signal) { if (signal.aborted) { clearTimeout(timer); throw new AiError('cancelled', 'request cancelled', { retryable: false }); } signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    let res;
    try { res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' }); }
    catch (e) {
      if (controller.signal.reason === TIMEOUT) throw new AiError('timeout', `no response within ${timeoutMs}ms`);
      if (controller.signal.reason === CANCEL) throw new AiError('cancelled', 'request cancelled', { retryable: false });
      throw new AiError('unavailable', `could not reach the provider (${e?.cause?.code ?? e?.code ?? e?.name ?? 'network error'})`);
    }
    let text;
    try { text = await readBounded(res, maxBytes); }
    catch (e) { if (e instanceof AiError) throw e; if (controller.signal.reason === TIMEOUT) throw new AiError('timeout', `response not completed within ${timeoutMs}ms`); if (controller.signal.reason === CANCEL) throw new AiError('cancelled', 'request cancelled', { retryable: false }); throw new AiError('unavailable', 'connection dropped while reading the response'); }
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    if (res.status >= 200 && res.status < 300) { if (json === null) throw new AiError('malformed_response', 'provider returned a non-JSON body', { status: res.status }); return { status: res.status, headers: res.headers, json, text }; }
    const ra = Number(res.headers?.get?.('retry-after')); const retryAfterMs = Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, 3_600_000) : null;
    const cat = categoryForStatus(res.status);
    throw new AiError(cat, `provider returned HTTP ${res.status}`, { status: res.status, retryAfterMs, code: json?.error?.type ?? json?.error?.code ?? null, retryable: cat === 'rate_limit' || cat === 'provider_error' || cat === 'timeout' });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
