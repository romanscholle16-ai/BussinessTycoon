// Normalized AI failure model. Providers throw AiError; the service converts everything to a provider-neutral result.
export const CATEGORIES = ['configuration', 'authentication', 'authorization', 'rate_limit', 'timeout', 'unavailable', 'provider_error', 'invalid_request', 'malformed_response', 'safety_refusal', 'budget_exceeded', 'disabled', 'cancelled', 'unknown'];
/** Worth retrying the same provider (after backoff). */
export const RETRYABLE = new Set(['rate_limit', 'timeout', 'unavailable', 'provider_error']);
/** The next configured provider may succeed. Safety refusals, bad requests, budget and cancellation never fail over. */
export const FAILOVER = new Set(['configuration', 'authentication', 'authorization', 'rate_limit', 'timeout', 'unavailable', 'provider_error', 'malformed_response', 'unknown']);

export class AiError extends Error {
  constructor(category, message, { retryable = RETRYABLE.has(category), retryAfterMs = null, status = null, code = null } = {}) {
    super(message); this.name = 'AiError'; this.category = CATEGORIES.includes(category) ? category : 'unknown'; this.retryable = retryable; this.retryAfterMs = retryAfterMs; this.status = status; this.code = code;
  }
}
/** Maps an HTTP status to a category (shared by the cloud adapters). */
export function categoryForStatus(status) {
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'invalid_request';
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_error'; // includes 529 overloaded
  return 'unknown';
}
