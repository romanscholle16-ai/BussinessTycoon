// Deterministic analysis over structured evidence: aggregation, comparison, trend, gap and contradiction signals -> generic findings.
import { fieldConfidence, median, DIRECT_TYPES, LEVEL_RANK } from './evidence.js';

const r2 = (n) => Math.round(n * 100) / 100;
const fmt = (v, unit) => `${Number.isInteger(v) ? v : r2(v)}${unit ? ` ${unit}` : ''}`;

/** @returns {{summaries, derived, findings}} Pure: no I/O. `conflicts` rows carry ids. Findings never imply business actions. */
export function analyzeEvidence({ objective, fields, sources, evidence, conflicts }) {
  const summaries = [], derived = [], findings = [], target = objective.limits.confidenceTarget;
  for (const f of fields) {
    const key = f.implicit ? null : f.field, label = f.implicit ? 'answer' : f.field;
    const direct = evidence.filter((e) => (e.field ?? null) === key && DIRECT_TYPES.has(e.evidence_type));
    const conflict = conflicts.find((c) => c.field === label && c.status === 'unresolved') ?? null;
    const conf = fieldConfidence({ evidence: direct, sources, conflict, objective });
    const nums = direct.filter((e) => e.value != null);
    const units = [...new Set(nums.map((e) => e.unit ?? ''))];
    const sum = { field: label, description: f.description, supported: direct.length > 0, evidenceIds: direct.map((e) => e.id), values: nums.map((e) => e.value), unit: units.length === 1 ? (units[0] || null) : null, independentSources: conf.independentSources, confidence: conf.level, confidenceScore: conf.score, confidenceReasons: conf.reasons, conflictIds: conflict ? [conflict.id] : [], satisfied: false };
    sum.satisfied = sum.supported && !conflict && LEVEL_RANK[conf.level] >= LEVEL_RANK[target] && conf.independentSources >= objective.limits.minIndependentSources;
    summaries.push(sum);
    const freshOf = (list) => (list.some((e) => e.freshness === 'stale') ? 'stale' : list.every((e) => e.freshness === 'fresh') ? 'fresh' : list.some((e) => e.freshness === 'unknown') ? 'unknown' : 'acceptable');
    if (!direct.length) { findings.push({ type: 'unanswered_question', statement: `No retrieved source directly supported: ${f.description}`, basis: 'none', field: label, evidenceIds: [], confidence: 'insufficient', confidenceScore: 0, rationale: 'No directly supported evidence was extracted for this required information.', freshness: 'unknown', conflictIds: [], status: 'unsupported' }); continue; }
    let statement, basis = 'sourced', ids = direct.map((e) => e.id);
    if (nums.length && units.length === 1) {
      const vals = nums.map((e) => e.value);
      if (conflict) statement = `Sources disagree about ${f.description}: values ${[...new Set(vals)].sort((a, b) => a - b).map((v) => fmt(v, sum.unit)).join(', ')}. No value is asserted.`;
      else if (nums.length >= 2) {
        const med = median(vals), lo = Math.min(...vals), hi = Math.max(...vals), id = `calc:${label}`;
        derived.push({ key: id, field: key, claim: `Median of ${nums.length} sourced values for ${f.description}: ${fmt(med, sum.unit)} (range ${fmt(lo, sum.unit)}–${fmt(hi, sum.unit)})`, value: med, unit: sum.unit, derivedFrom: nums.map((e) => e.id), confidence: conf.level, confidenceScore: conf.score, freshness: freshOf(nums), method: 'calc:median_v1' });
        statement = `${f.description}: median ${fmt(med, sum.unit)} (range ${fmt(lo, sum.unit)}–${fmt(hi, sum.unit)}) across ${nums.length} sourced values`; basis = 'derived'; ids = [`@${id}`, ...ids];
      } else statement = `${f.description}: ${fmt(vals[0], sum.unit)} (single sourced value)`;
    } else { const best = [...direct].sort((a, b) => b.confidence_score - a.confidence_score || (a.id < b.id ? -1 : 1))[0]; statement = conflict ? `Sources disagree about ${f.description}.` : best.claim; }
    findings.push({ type: f.findingType ?? 'constraint', statement: statement.slice(0, 600), basis, field: label, evidenceIds: ids, confidence: conf.level, confidenceScore: conf.score, rationale: conf.reasons.join('; '), freshness: freshOf(direct), conflictIds: sum.conflictIds, status: conflict ? 'conflicted' : sum.satisfied ? 'supported' : 'tentative' });
    if (!conflict && conf.independentSources < objective.limits.minIndependentSources) findings.push({ type: 'gap', statement: `"${label}" rests on ${conf.independentSources} independent source(s); the objective asks for ${objective.limits.minIndependentSources}.`, basis: 'derived', field: label, evidenceIds: direct.map((e) => e.id), confidence: 'medium', confidenceScore: 0.5, rationale: 'Counted from distinct source domains; duplicates and copies are not independent.', freshness: 'unknown', conflictIds: [], status: 'supported' });
    // trend: only from dated sources with comparable units; never inferred when dates are unknown
    const dated = nums.map((e) => ({ e, d: sources.get(e.source_id)?.published_at })).filter((x) => x.d && units.length === 1).sort((a, b) => Date.parse(a.d) - Date.parse(b.d));
    if (!conflict && dated.length >= 2 && Date.parse(dated[0].d) !== Date.parse(dated[dated.length - 1].d)) {
      const a = dated[0], b = dated[dated.length - 1], pct = a.e.value ? r2(((b.e.value - a.e.value) / Math.abs(a.e.value)) * 100) : null, dir = b.e.value > a.e.value ? 'higher' : b.e.value < a.e.value ? 'lower' : 'unchanged';
      findings.push({ type: 'trend', statement: `${f.description}: the later source (${b.d.slice(0, 10)}) reports ${fmt(b.e.value, sum.unit)}, ${dir} than the earlier one (${a.d.slice(0, 10)}: ${fmt(a.e.value, sum.unit)})${pct == null ? '' : ` (${pct}%)`}. Based on two dated sources only.`, basis: 'derived', field: label, evidenceIds: [a.e.id, b.e.id], confidence: 'low', confidenceScore: 0.3, rationale: 'Comparison of two dated sources; not a statistical trend.', freshness: freshOf([a.e, b.e]), conflictIds: [], status: 'tentative' });
    }
  }
  return { summaries, derived, findings };
}

/** Validates model output for inferences; returns accepted items and a count of rejected ones. Model output is never trusted as fact. */
export function validateInferences(structured, knownEvidenceIds) {
  const accepted = []; let rejected = 0;
  const items = Array.isArray(structured?.inferences) ? structured.inferences.slice(0, 10) : null;
  if (!items) return { accepted, rejected: 1, malformed: true };
  for (const it of items) {
    const ok = it && typeof it === 'object' && typeof it.statement === 'string' && it.statement.trim().length >= 10 && it.statement.length <= 400
      && Array.isArray(it.evidenceIds) && it.evidenceIds.length > 0 && it.evidenceIds.length <= 10 && it.evidenceIds.every((id) => typeof id === 'string' && knownEvidenceIds.has(id))
      && ['opportunity', 'trend', 'risk', 'recommendation'].includes(it.type);
    if (!ok) { rejected++; continue; }
    accepted.push({ type: it.type, statement: it.statement.trim(), evidenceIds: [...new Set(it.evidenceIds)], modelConfidence: ['low', 'medium'].includes(it.confidence) ? it.confidence : 'low' });
  }
  return { accepted, rejected, malformed: false };
}
export const INFERENCE_SCHEMA = { type: 'object', properties: { inferences: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['opportunity', 'trend', 'risk', 'recommendation'] }, statement: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } }, confidence: { type: 'string', enum: ['low', 'medium'] } }, required: ['type', 'statement', 'evidenceIds'] } } }, required: ['inferences'] };
