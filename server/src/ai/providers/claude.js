// Claude via the Anthropic Messages API (raw HTTP with fetch: keeps the project dependency-free; swap in the SDK behind this class if ever wanted).
import { AiError } from '../errors.js';
import { requestJson } from '../http.js';
import { originOf, textOf, int } from './base.js';
import { redact } from '../redact.js';

const NO_SAMPLING = /^claude-(opus-5|opus-4-[678]|sonnet-5|fable|mythos)/; // sampling parameters (temperature/top_p/top_k) are rejected on these models
const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_use', pause_turn: 'pause' };

export class ClaudeProvider {
  name = 'claude'; kind = 'cloud';
  constructor(cfg, { apiKey = null } = {}) { this.cfg = cfg; this.apiKey = apiKey && String(apiKey).trim() ? String(apiKey).trim() : null; }
  get secrets() { return this.apiKey ? [this.apiKey] : []; }
  describe() {
    const problem = this.cfg.problem ?? (!this.apiKey ? 'ANTHROPIC_API_KEY is not set' : !this.cfg.model ? 'no model configured' : null);
    return { configured: !problem, problem, model: this.cfg.model, models: Object.keys(this.cfg.pricing ?? {}), capabilities: { text: true, json: true, temperature: !NO_SAMPLING.test(this.cfg.model ?? '') }, endpointOrigin: originOf(this.cfg.endpoint), integration: 'Anthropic Messages API (HTTP)' };
  }
  async complete(req, { signal, timeoutMs, fetchImpl }) {
    const model = req.model ?? this.cfg.model, body = { model, max_tokens: req.maxTokens, messages: [{ role: 'user', content: req.prompt }] }, ignored = [];
    if (req.system) body.system = req.system;
    if (req.temperature != null) { if (NO_SAMPLING.test(model)) ignored.push('temperature'); else body.temperature = req.temperature; }
    if (req.jsonSchema) body.output_config = { format: { type: 'json_schema', schema: req.jsonSchema } };
    let r;
    try { r = await requestJson(`${this.cfg.endpoint}/v1/messages`, { headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, body, timeoutMs, signal, fetchImpl }); }
    catch (e) { if (e instanceof AiError) e.message = redact(e.message, { secrets: this.secrets }); throw e; }
    const j = r.json;
    if (j?.stop_reason === 'refusal') throw new AiError('safety_refusal', `the model declined the request${j.stop_details?.category ? ` (${redact(j.stop_details.category, { max: 40 })})` : ''}`, { retryable: false });
    const output = textOf(j?.content);
    if (!output && j?.stop_reason !== 'end_turn') throw new AiError('malformed_response', 'response contained no text content');
    return { output, finishReason: FINISH[j.stop_reason] ?? j.stop_reason ?? 'stop', requestId: typeof (r.headers.get?.('request-id') ?? j.id) === 'string' ? (r.headers.get?.('request-id') ?? j.id) : null, usage: j?.usage ? { inputTokens: int(j.usage.input_tokens), outputTokens: int(j.usage.output_tokens) } : null, model: j.model ?? model, ignored };
  }
}
