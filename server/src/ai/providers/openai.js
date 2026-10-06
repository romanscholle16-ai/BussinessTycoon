// OpenAI and OpenAI-compatible servers via the Chat Completions API (raw HTTP).
import { AiError } from '../errors.js';
import { requestJson } from '../http.js';
import { originOf, int } from './base.js';
import { redact } from '../redact.js';

export class OpenAiProvider {
  name = 'openai'; kind = 'cloud';
  constructor(cfg, { apiKey = null } = {}) { this.cfg = cfg; this.apiKey = apiKey && String(apiKey).trim() ? String(apiKey).trim() : null; }
  get secrets() { return this.apiKey ? [this.apiKey] : []; }
  describe() {
    const problem = this.cfg.problem ?? (!this.apiKey ? 'OPENAI_API_KEY is not set' : !this.cfg.model ? 'no model configured (set AI_OPENAI_MODEL)' : null);
    return { configured: !problem, problem, model: this.cfg.model, models: Object.keys(this.cfg.pricing ?? {}), capabilities: { text: true, json: true, temperature: true }, endpointOrigin: originOf(this.cfg.endpoint), integration: 'OpenAI Chat Completions API (HTTP)' };
  }
  async complete(req, { signal, timeoutMs, fetchImpl }) {
    const model = req.model ?? this.cfg.model, official = originOf(this.cfg.endpoint) === 'https://api.openai.com';
    const tokensKey = this.cfg.maxTokensParam ?? (official ? 'max_completion_tokens' : 'max_tokens');
    const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }];
    const body = { model, messages, [tokensKey]: req.maxTokens };
    if (req.temperature != null) body.temperature = req.temperature;
    if (req.jsonSchema) body.response_format = official ? { type: 'json_schema', json_schema: { name: 'result', schema: req.jsonSchema } } : { type: 'json_object' };
    let r;
    try { r = await requestJson(`${this.cfg.endpoint}/chat/completions`, { headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }, body, timeoutMs, signal, fetchImpl }); }
    catch (e) { if (e instanceof AiError) e.message = redact(e.message, { secrets: this.secrets }); throw e; }
    const choice = r.json?.choices?.[0], msg = choice?.message;
    if (msg?.refusal || choice?.finish_reason === 'content_filter') throw new AiError('safety_refusal', 'the model declined the request', { retryable: false });
    if (typeof msg?.content !== 'string') throw new AiError('malformed_response', 'response contained no message content');
    return { output: msg.content, finishReason: choice.finish_reason === 'length' ? 'length' : (choice.finish_reason ?? 'stop'), requestId: typeof r.json.id === 'string' ? r.json.id : null, usage: r.json.usage ? { inputTokens: int(r.json.usage.prompt_tokens), outputTokens: int(r.json.usage.completion_tokens) } : null, model: r.json.model ?? model, ignored: [] };
  }
}
