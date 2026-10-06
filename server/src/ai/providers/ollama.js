// Local models via an Ollama server (default http://127.0.0.1:11434). No credentials. The model is configuration, never assumed.
import { AiError } from '../errors.js';
import { requestJson } from '../http.js';
import { originOf, int } from './base.js';

export class OllamaProvider {
  name = 'ollama'; kind = 'local';
  constructor(cfg) { this.cfg = cfg; }
  get secrets() { return []; }
  describe() {
    const problem = this.cfg.problem ?? (!this.cfg.model ? 'no model configured (set AI_OLLAMA_MODEL)' : null);
    return { configured: !problem, problem, model: this.cfg.model, models: this.cfg.model ? [this.cfg.model] : [], capabilities: { text: true, json: true, temperature: true }, endpointOrigin: originOf(this.cfg.endpoint), integration: 'Ollama HTTP API' };
  }
  /** Bounded liveness check: the server must answer and the configured model must be installed. */
  async probe({ signal, timeoutMs, fetchImpl }) {
    try {
      const r = await requestJson(`${this.cfg.endpoint}/api/tags`, { method: 'GET', timeoutMs, signal, fetchImpl, maxBytes: 1_000_000 });
      const names = (r.json?.models ?? []).map((m) => m?.name).filter((n) => typeof n === 'string');
      const want = this.cfg.model, has = names.some((n) => n === want || n === `${want}:latest` || n.split(':')[0] === want);
      return has ? { ok: true } : { ok: false, category: 'configuration', message: `model "${want}" is not installed on the Ollama server` };
    } catch (e) { return { ok: false, category: e instanceof AiError ? e.category : 'unavailable', message: e instanceof AiError ? e.message : 'probe failed' }; }
  }
  async complete(req, { signal, timeoutMs, fetchImpl }) {
    const model = req.model ?? this.cfg.model;
    const body = { model, stream: false, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }], options: { num_predict: req.maxTokens, ...(req.temperature != null ? { temperature: req.temperature } : {}) } };
    if (req.jsonSchema) body.format = req.jsonSchema;
    const r = await requestJson(`${this.cfg.endpoint}/api/chat`, { headers: { 'content-type': 'application/json' }, body, timeoutMs, signal, fetchImpl });
    if (r.json?.error) throw new AiError('provider_error', 'the Ollama server reported an error', { retryable: true });
    if (typeof r.json?.message?.content !== 'string') throw new AiError('malformed_response', 'response contained no message content');
    const done = r.json.done_reason;
    return { output: r.json.message.content, finishReason: done === 'length' ? 'length' : 'stop', requestId: null, usage: r.json.prompt_eval_count !== undefined || r.json.eval_count !== undefined ? { inputTokens: int(r.json.prompt_eval_count), outputTokens: int(r.json.eval_count) } : null, model: r.json.model ?? model, ignored: [] };
  }
}
