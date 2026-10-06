// Deterministic provider for tests and demos. NEVER touches the network. Behaviors are scripted per call.
//   script entries: {output, usage, latencyMs, finishReason, requestId} | {error:{category, message?, retryAfterMs?}} | {malformed:true} | {hang:true}
//   The last script entry repeats unless `loop` is false (then further calls fail as provider_error).
import { AiError } from '../errors.js';

export class MockProvider {
  name = 'mock'; kind = 'mock';
  constructor(cfg = {}, { script = null, loop = true } = {}) { this.cfg = { model: 'mock-1', ...cfg }; this.script = script; this.loop = loop; this.calls = []; }
  get secrets() { return []; }
  describe() { return { configured: !this.cfg.problem, problem: this.cfg.problem ?? null, model: this.cfg.model, models: [this.cfg.model], capabilities: { text: true, json: true, temperature: true }, endpointOrigin: null, integration: 'in-process deterministic mock (no network)' }; }
  async complete(req, { signal }) {
    const i = this.calls.length; this.calls.push({ model: req.model ?? this.cfg.model, promptChars: req.prompt.length, at: i });
    const step = this.script ? (this.script[i] ?? (this.loop ? this.script[this.script.length - 1] : { error: { category: 'provider_error', message: 'script exhausted' } })) : {};
    if (step.latencyMs || step.hang) await new Promise((res, rej) => { const t = step.hang ? null : setTimeout(res, step.latencyMs); const abort = () => { clearTimeout(t); rej(new AiError(signal?.reason === 'timeout' ? 'timeout' : 'cancelled', 'mock aborted', { retryable: signal?.reason === 'timeout' })); }; if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); });
    if (step.error) throw new AiError(step.error.category, step.error.message ?? `mock ${step.error.category}`, { retryAfterMs: step.error.retryAfterMs ?? null });
    if (step.malformed) return { not: 'a valid result' };
    const output = step.output ?? `mock:${req.prompt.slice(0, 60)}`;
    return { output, finishReason: step.finishReason ?? 'stop', requestId: step.requestId ?? `mock-req-${i + 1}`, usage: step.usage === undefined ? { inputTokens: Math.ceil((req.prompt.length + (req.system?.length ?? 0)) / 4), outputTokens: Math.ceil(output.length / 4) } : step.usage, model: req.model ?? this.cfg.model, ignored: [] };
  }
}
