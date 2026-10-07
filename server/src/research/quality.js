// Deterministic, explainable source quality. Every factor carries a reason; domain popularity is never used.
import { terms, tokenize } from './model.js';

const clamp = (n) => Math.max(0, Math.min(1, n));
const r2 = (n) => Math.round(n * 100) / 100;
export const PRIMARY_TYPES = new Set(['primary', 'official', 'government', 'company', 'marketplace']);
const DIRECTNESS = { primary: 1, official: 1, government: 0.95, research: 0.8, company: 0.75, marketplace: 0.7, news: 0.55, review: 0.4, community: 0.35, forum: 0.3, social: 0.25, unknown: 0.3 };

/** Source type is a HEURISTIC and says so: hint from the provider > TLD/host structure > 'unknown'. Nothing is "automatically true". */
export function classifySource({ domain, typeHint }) {
  if (typeHint && Object.hasOwn(DIRECTNESS, typeHint)) return { type: typeHint, basis: 'provider hint (unverified)' };
  const d = domain.toLowerCase();
  if (/\.gov(\.[a-z]{2})?$|\.mil$|\.gouv\.[a-z]{2}$|\.europa\.eu$/.test(d)) return { type: 'government', basis: 'government top-level domain' };
  if (/\.edu(\.[a-z]{2})?$|\.ac\.[a-z]{2}$|^arxiv\.org$|^doi\.org$/.test(d)) return { type: 'research', basis: 'academic domain' };
  if (/^(forum|forums|community|discuss|boards?)\./.test(d)) return { type: 'forum', basis: 'host name looks like a forum' };
  if (/^(docs|developer|developers|support|help)\./.test(d)) return { type: 'official', basis: 'host name looks like documentation/support' };
  return { type: 'unknown', basis: 'no reliable signal for the source type' };
}

function freshnessOf(publishedAt, maxAgeDays, now) {
  if (!publishedAt) return { label: 'unknown', ageDays: null };
  const age = Math.max(0, (now - Date.parse(publishedAt)) / 86_400_000), limit = maxAgeDays ?? 365;
  return { label: age <= limit * 0.5 ? 'fresh' : age <= limit ? 'acceptable' : 'stale', ageDays: Math.round(age) };
}
export { freshnessOf };

/**
 * @returns {{score:number, type:string, primary:boolean, freshness:string, factors:Record<string,{value:number,reason:string}>}}
 * `corroboration` (0..1) and `consistency` (0..1|null) come from the evaluation pass; before it they are neutral and marked so.
 */
export function scoreSource({ source, objective, now, corroboration = null, consistency = null }) {
  const { type, basis } = classifySource({ domain: source.domain, typeHint: source.typeHint ?? source.discovery?.typeHint });
  const qTerms = new Set([...terms(objective.question), ...objective.requiredInformation.flatMap((f) => terms(f.description))]);
  const body = tokenize(`${source.title ?? ''} ${source.text ?? ''}`), hits = new Set(body.filter((w) => qTerms.has(w)));
  const relevance = qTerms.size ? clamp(hits.size / Math.min(qTerms.size, 8)) : 0;
  const nums = (source.text ?? '').match(/\b\d[\d,.]*\b/g)?.length ?? 0, words = source.wordCount ?? 0;
  const specificity = words ? clamp(nums / Math.max(5, words / 40)) : 0;
  const completeness = clamp(words / 300);
  const fresh = freshnessOf(source.publishedAt, objective.freshness?.maxAgeDays, now);
  const extraction = source.extractionStatus === 'complete' ? 1 : source.extractionStatus === 'truncated' ? 0.7 : 0.4;
  const pub = (source.publishedAt ? 0.5 : 0) + (source.author ? 0.3 : 0) + (source.title ? 0.2 : 0);
  const f = {
    directness: { value: DIRECTNESS[type], reason: `${type} source (${basis})${PRIMARY_TYPES.has(type) ? '; treated as primary' : '; treated as secondary'}` },
    relevance: { value: r2(relevance), reason: `${hits.size} of the objective's key terms appear in the page` },
    freshness: { value: fresh.label === 'fresh' ? 1 : fresh.label === 'acceptable' ? 0.7 : fresh.label === 'stale' ? 0.2 : 0.4, reason: fresh.label === 'unknown' ? 'publication date unknown (not guessed)' : `${fresh.label}: ${fresh.ageDays} days old` },
    specificity: { value: r2(specificity), reason: `${nums} numeric figures in ${words} words` },
    completeness: { value: r2(completeness), reason: `${words} words extracted${source.extractionStatus === 'truncated' ? ' (truncated)' : ''}` },
    extractionQuality: { value: extraction, reason: `extraction ${source.extractionStatus ?? 'unknown'}` },
    publicationInfo: { value: r2(pub), reason: [source.publishedAt ? 'date present' : 'no date', source.author ? 'author present' : 'no author', source.title ? 'title present' : 'no title'].join(', ') },
    corroboration: { value: corroboration ?? 0.5, reason: corroboration == null ? 'not yet evaluated (neutral)' : corroboration >= 0.99 ? 'independently corroborated by other sources' : corroboration > 0.5 ? 'partly corroborated' : 'no independent corroboration' },
    consistency: { value: consistency ?? 0.5, reason: consistency == null ? 'not yet evaluated (neutral)' : consistency >= 0.99 ? 'consistent with the other sources' : 'disagrees with other sources' },
  };
  const W = { directness: 0.2, relevance: 0.2, freshness: 0.1, specificity: 0.1, completeness: 0.08, extractionQuality: 0.07, publicationInfo: 0.05, corroboration: 0.1, consistency: 0.1 };
  const score = r2(Object.entries(W).reduce((a, [k, w]) => a + w * f[k].value, 0));
  return { score, type, primary: PRIMARY_TYPES.has(type), freshness: fresh.label, factors: f, weights: W };
}
