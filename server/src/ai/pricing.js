// Token usage and cost. Unknown stays unknown (null): nothing here guesses a price or a token count.
// Built-in Claude prices are the published per-million-token USD rates as of 2026-09-25 and are overridable in config.
export const BUILTIN_PRICING_AS_OF = '2026-09-25';
export const BUILTIN_CLAUDE_PRICING = {
  'claude-opus-5-5': { inputPerMTokUsd: 4, outputPerMTokUsd: 20 }, 'claude-opus-5': { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  'claude-opus-4-8': { inputPerMTokUsd: 5, outputPerMTokUsd: 25 }, 'claude-sonnet-5-5': { inputPerMTokUsd: 2, outputPerMTokUsd: 10 },
  'claude-sonnet-5': { inputPerMTokUsd: 2, outputPerMTokUsd: 10 }, 'claude-sonnet-4-6': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  'claude-haiku-4-5': { inputPerMTokUsd: 1, outputPerMTokUsd: 5 }, 'claude-fable-5-1': { inputPerMTokUsd: 10, outputPerMTokUsd: 50 },
};
const valid = (p) => p && Number.isFinite(p.inputPerMTokUsd) && p.inputPerMTokUsd >= 0 && Number.isFinite(p.outputPerMTokUsd) && p.outputPerMTokUsd >= 0;

/** Rough pre-call input size: 1 token per 4 characters, rounded up. ALWAYS labelled an estimate. */
export const estimateTokens = (chars) => Math.ceil(chars / 4);

/** Worst-case cost before a call (all input + max output tokens). null when the model has no known price. */
export function estimateMaxCostUsd(pricing, inputChars, maxOutputTokens) {
  if (!valid(pricing)) return null;
  return (estimateTokens(inputChars) * pricing.inputPerMTokUsd + maxOutputTokens * pricing.outputPerMTokUsd) / 1e6;
}
/** Actual cost from provider-reported usage. null unless BOTH the price and the token counts are known. */
export function actualCostUsd(pricing, usage) {
  if (!valid(pricing) || !usage || !Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens)) return null;
  return (usage.inputTokens * pricing.inputPerMTokUsd + usage.outputTokens * pricing.outputPerMTokUsd) / 1e6;
}
export const roundUsd = (n) => (n === null || n === undefined ? null : Math.round(n * 1e8) / 1e8);
