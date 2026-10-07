// Evidence extraction, confidence, conflict detection and deduplication. Deterministic; operates on structured data only.
import { createHash } from 'node:crypto';
import { terms, tokenize } from './model.js';

const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (n) => Math.max(0, Math.min(1, n));
export const levelOf = (score) => (score >= 0.75 ? 'high' : score >= 0.5 ? 'medium' : score >= 0.25 ? 'low' : 'insufficient');
export const LEVEL_RANK = { insufficient: 0, low: 1, medium: 2, high: 3 };
export const DIRECT_TYPES = new Set(['directly_observed_fact', 'quoted_source_claim']);
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** Splits text into bounded sentences with their index (location). */
export function sentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n+/).map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 600).map((s, i) => ({ s, i }));
}
/** First plausible numeric value in a sentence (years without units are skipped). Returns {value, unit} or null. */
export function extractNumber(sentence) {
  const re = /([$€£])?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|percent|k|thousand|m|million|b|billion|usd|eur|gbp|dollars|euros)?(?!\w)/gi; let m;
  while ((m = re.exec(sentence))) {
    const raw = `${m[2]}${m[3] ?? ''}`.replace(/,/g, ''), n = Number(raw); if (!Number.isFinite(n)) continue;
    const suf = (m[4] ?? '').toLowerCase(), cur = m[1];
    if (!cur && !suf && !m[3] && n >= 1900 && n <= 2100) continue; // looks like a year
    const mult = SCALE[suf] ?? 1; const unit = suf === '%' || suf === 'percent' ? '%' : cur === '$' || suf === 'usd' || suf === 'dollars' ? 'USD' : cur === '€' || suf === 'eur' || suf === 'euros' ? 'EUR' : cur === '£' || suf === 'gbp' ? 'GBP' : null;
    return { value: n * mult, unit };
  }
  return null;
}
const QUOTED = /["“”]|\baccording to\b|\b(said|says|claims?|claimed|reported|reports|estimates?|estimated)\b/i;

/** Extracts bounded evidence candidates from ONE source for the given plan fields. Returns [] when nothing relevant is found. */
export function extractEvidence({ source, fields, objective, limits, now }) {
  const sents = sentences(source.text), out = [], used = new Set();
  for (const f of fields) {
    const q = new Set([...terms(f.description), ...terms(objective.question).slice(0, 6)]), core = new Set(terms(f.description));
    const scored = sents.map(({ s, i }) => { const t = new Set(tokenize(s)); let hit = 0, coreHit = 0; for (const w of q) if (t.has(w)) hit++; for (const w of core) if (t.has(w)) coreHit++; const num = f.valueType === 'number' ? extractNumber(s) : null; return { s, i, rel: q.size ? hit / q.size : 0, coreHit, num }; })
      .filter((x) => x.coreHit >= Math.min(2, core.size) && x.rel >= 0.25 && (f.valueType !== 'number' || x.num))
      .sort((a, b) => b.rel - a.rel || a.i - b.i);
    for (const c of scored) {
      if (out.filter((e) => e.field === f.field).length >= limits.maxEvidencePerSource) break;
      const key = `${f.field}|${c.s.toLowerCase()}`; if (used.has(key)) continue; used.add(key);
      out.push({ field: f.field === 'answer' ? null : f.field, fieldKey: f.field, claim: c.s.slice(0, 400), excerpt: c.s.slice(0, 300), location: `sentence ${c.i + 1}`, evidenceType: QUOTED.test(c.s) ? 'quoted_source_claim' : 'directly_observed_fact', value: c.num ? c.num.value : null, unit: c.num ? (c.num.unit ?? f.unit ?? null) : null, relevance: r2(c.rel), method: 'rule:keyword_sentence_v1' });
    }
  }
  return out.map((e) => ({ ...e, observedAt: now }));
}

/** Evidence-level confidence: quality of the source weighted with how well the sentence matches the question. Bounded and explained. */
export function evidenceConfidence(e, sourceScore) {
  const score = r2(clamp(0.65 * sourceScore + 0.35 * clamp(e.relevance / 0.6)));
  return { score, level: levelOf(score) };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export { median };

/**
 * Groups numeric evidence of one field into clusters of mutually-consistent values (relative tolerance). >1 cluster = conflict.
 * Only evidence from DISTINCT sources with the SAME unit is comparable; values are never merged or "picked".
 */
export function detectConflicts({ evidence, sources, tolerance }) {
  const byField = new Map();
  for (const e of evidence) { if (!DIRECT_TYPES.has(e.evidence_type ?? e.evidenceType) || e.value == null || !e.field) continue; (byField.get(e.field) ?? byField.set(e.field, []).get(e.field)).push(e); }
  const conflicts = [];
  for (const [field, list] of byField) {
    const byUnit = new Map(); for (const e of list) (byUnit.get(e.unit ?? '') ?? byUnit.set(e.unit ?? '', []).get(e.unit ?? '')).push(e);
    for (const [unit, items] of byUnit) {
      const sorted = [...items].sort((a, b) => a.value - b.value || (a.id < b.id ? -1 : 1)), clusters = [];
      for (const e of sorted) { const last = clusters[clusters.length - 1], ref = last?.[last.length - 1]; if (last && Math.abs(e.value - ref.value) <= tolerance * Math.max(Math.abs(e.value), Math.abs(ref.value), 1e-9)) last.push(e); else clusters.push([e]); }
      const srcOf = (c) => new Set(c.map((e) => e.source_id));
      if (clusters.length > 1 && new Set(items.map((e) => e.source_id)).size > 1) {
        const claims = sorted.map((e) => ({ evidenceId: e.id, sourceId: e.source_id, value: e.value, unit: e.unit ?? null, quality: sources.get(e.source_id)?.quality_score ?? null, freshness: e.freshness, confidence: e.confidence }));
        conflicts.push({ field, unit: unit || null, clusters: clusters.map((c) => ({ values: c.map((e) => e.value), sources: srcOf(c).size })), claims, description: `${clusters.length} incompatible values for "${field}" (${[...new Set(sorted.map((e) => e.value))].slice(0, 6).join(', ')}) across ${new Set(items.map((e) => e.source_id)).size} sources; no value was chosen` });
      }
    }
  }
  return conflicts;
}

/**
 * Aggregate confidence for one field. Explicit weights, explicit reasons, hard caps (no fake precision):
 * a single independent source caps at medium; an unresolved conflict caps at low; no direct evidence is insufficient.
 */
export function fieldConfidence({ evidence, sources, conflict, objective }) {
  const direct = evidence.filter((e) => DIRECT_TYPES.has(e.evidence_type));
  if (!direct.length) return { level: 'insufficient', score: 0, reasons: ['no directly supported evidence'], independentSources: 0 };
  const srcIds = [...new Set(direct.map((e) => e.source_id))], srcs = srcIds.map((id) => sources.get(id)).filter(Boolean);
  const domains = new Set(srcs.map((s) => s.domain)), independent = domains.size;
  const quality = srcs.reduce((a, s) => a + (s.quality_score ?? 0), 0) / Math.max(1, srcs.length);
  const target = Math.max(1, objective.limits.minIndependentSources);
  const independence = clamp(independent / Math.max(target, 2));
  let agreement = 0.7, agreeReason = 'agreement not assessable for non-numeric claims';
  const nums = direct.filter((e) => e.value != null);
  if (nums.length >= 2) { const med = median(nums.map((e) => e.value)), tol = objective.limits.conflictTolerance; const ok = nums.filter((e) => Math.abs(e.value - med) <= tol * Math.max(Math.abs(med), 1e-9)).length; agreement = ok / nums.length; agreeReason = `${ok} of ${nums.length} values within ${Math.round(tol * 100)}% of the median`; } else if (nums.length === 1) { agreement = 0.6; agreeReason = 'only one numeric value (nothing to agree with)'; }
  const fresh = direct.reduce((a, e) => a + ({ fresh: 1, acceptable: 0.7, stale: 0.2, unknown: 0.4 }[e.freshness] ?? 0.4), 0) / direct.length;
  const directness = srcs.some((s) => s.primary) ? 1 : 0.6;
  const completeness = clamp(direct.length / 3);
  let score = r2(0.3 * quality + 0.25 * independence + 0.2 * agreement + 0.1 * fresh + 0.1 * directness + 0.05 * completeness);
  const reasons = [`average source quality ${r2(quality)}`, `${independent} independent source(s) (target ${target})`, agreeReason, `${direct.length} directly supported item(s)`];
  let level = levelOf(score);
  if (independent < 2 && LEVEL_RANK[level] > LEVEL_RANK.medium) { level = 'medium'; reasons.push('capped at medium: single independent source'); }
  if (conflict && LEVEL_RANK[level] > LEVEL_RANK.low) { level = 'low'; reasons.push('capped at low: unresolved conflict between sources'); }
  if (conflict) score = Math.min(score, 0.49);
  return { level, score: level === 'high' ? score : Math.min(score, level === 'medium' ? 0.74 : level === 'low' ? 0.49 : 0.24), reasons, independentSources: independent };
}

/** Dedup signatures: shingle set of normalized text (for copy/syndication detection). */
const shingles = (text) => { const w = tokenize(text).slice(0, 3000), s = new Set(); for (let i = 0; i + 4 <= w.length; i++) s.add(createHash('md5').update(w.slice(i, i + 4).join(' ')).digest('base64').slice(0, 8)); return s; };
export function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); }
/** Finds why `cand` duplicates one of `existing` (sources already kept), or null. Order: exact URL, canonical URL, identical content, near-duplicate copy. */
export function findDuplicate(cand, existing, { nearThreshold = 0.85 } = {}) {
  for (const s of existing) { if (s.url === cand.url || s.final_url === cand.url) return { of: s.id, kind: 'exact_url' }; }
  for (const s of existing) if (s.canonical_url === cand.canonicalUrl) return { of: s.id, kind: 'canonical_url' };
  for (const s of existing) if (s.content_hash && cand.contentHash && s.content_hash === cand.contentHash) return { of: s.id, kind: 'duplicate_content' };
  if (cand.text) { const cs = shingles(cand.text); for (const s of existing) if (s.text && jaccard(cs, shingles(s.text)) >= nearThreshold) return { of: s.id, kind: 'near_duplicate_copy' }; }
  return null;
}
