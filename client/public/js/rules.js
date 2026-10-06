// Spend-approval rules (docs/SECURITY_SPECIFICATION.md). Pure and unit-tested; thresholds are configurable.
export const DEFAULT_RULES = { autoMaxUsd: 5, rulesMaxUsd: 25 };

/** @returns {{tier:'auto'|'rules'|'human', allowed:boolean, reason:string}} */
export function evaluateSpend(costUsd, budgetRemainingUsd, rules = DEFAULT_RULES) {
  if (!(costUsd >= 0)) return { tier: 'human', allowed: false, reason: 'Invalid amount' };
  if (costUsd > rules.rulesMaxUsd) return { tier: 'human', allowed: false, reason: `Over $${rules.rulesMaxUsd}: needs your approval` };
  if (costUsd > budgetRemainingUsd) return { tier: costUsd <= rules.autoMaxUsd ? 'auto' : 'rules', allowed: false, reason: 'Not enough budget left' };
  return costUsd <= rules.autoMaxUsd
    ? { tier: 'auto', allowed: true, reason: `Auto-approved (up to $${rules.autoMaxUsd})` }
    : { tier: 'rules', allowed: true, reason: 'Approved by spending rules' };
}
