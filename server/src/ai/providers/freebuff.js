// Freebuff: an adapter BOUNDARY only. No stable, documented programmatic provider API for Freebuff is available in this environment,
// so nothing is invented here: the provider is always reported as not integrated and can never be selected.
// If a supported API appears, implement complete() here (and describe()/probe()) without touching the service, Agent OS or Supervisor.
import { AiError } from '../errors.js';

export class FreebuffProvider {
  name = 'freebuff'; kind = 'adapter';
  constructor(cfg = {}) { this.cfg = cfg; }
  get secrets() { return []; }
  describe() { return { configured: false, problem: 'not integrated: no stable programmatic API is available', model: null, models: [], capabilities: { text: false, json: false, temperature: false }, endpointOrigin: null, integration: 'adapter boundary (not integrated)' }; }
  async complete() { throw new AiError('configuration', 'Freebuff is not integrated (no programmatic API available)', { retryable: false }); }
}
