// Research objective model, limits and the deterministic planner. Business-independent: nothing here knows any business.
import { ValidationError, isId, assertNoSecrets, assertJsonSize } from '../agents/validate.js';

export const CONFIDENCE_LEVELS = ['insufficient', 'low', 'medium', 'high'];
export const SOURCE_TYPES = ['primary', 'official', 'marketplace', 'news', 'research', 'government', 'company', 'community', 'review', 'forum', 'social', 'unknown'];
export const FINDING_TYPES = ['opportunity', 'trend', 'gap', 'risk', 'constraint', 'recommendation', 'unanswered_question'];
export const RUN_STATES = ['created', 'planning', 'discovering', 'retrieving', 'evaluating', 'analyzing', 'synthesizing', 'validating', 'completed', 'insufficient', 'conflicted', 'failed', 'cancelled'];
export const ACTIVE_STAGES = RUN_STATES.slice(0, 8);
export const TERMINAL_STATES = ['completed', 'insufficient', 'conflicted', 'failed', 'cancelled'];
export const STOP_REASONS = ['confidence_target_reached', 'required_fields_supported', 'max_sources', 'max_retrievals', 'max_ai_calls', 'time_budget', 'provider_budget', 'no_new_evidence', 'subquestions_exhausted', 'no_useful_sources', 'provider_unavailable', 'cancelled', 'permission_denied', 'error'];

export const LIMIT_DEFAULTS = Object.freeze({ maxSources: 10, maxRetrievals: 10, maxQueries: 6, maxAiCalls: 0, maxTimeMs: 120_000, maxTextChars: 20_000, maxEvidencePerSource: 3, minIndependentSources: 2, noNewEvidenceStop: 3, confidenceTarget: 'medium', conflictTolerance: 0.25, maxCostUsd: 0 });
const LIMIT_RULES = { maxSources: [1, 50], maxRetrievals: [1, 50], maxQueries: [1, 12], maxAiCalls: [0, 5], maxTimeMs: [1000, 900_000], maxTextChars: [500, 50_000], maxEvidencePerSource: [1, 10], minIndependentSources: [1, 5], noNewEvidenceStop: [1, 20] };
const FIELD_RE = /^[a-z][a-z0-9_]{1,39}$/;
const str = (v, f, min, max, { optional = false } = {}) => { if (v == null && optional) return null; if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new ValidationError(`${f} must be a string of ${min}-${max} characters`, f); return v.trim(); };
const known = (o, allowed, f) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ValidationError(`unknown field "${f}${k}"`, f + k); };
const host = (h, f) => { if (typeof h !== 'string' || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(h)) throw new ValidationError(`${f} must contain host names`, f); return h.toLowerCase(); };

export function validateLimits(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('limits must be an object', 'limits');
  known(input, [...Object.keys(LIMIT_DEFAULTS)], 'limits.');
  const l = { ...LIMIT_DEFAULTS, ...input };
  for (const [k, [min, max]] of Object.entries(LIMIT_RULES)) if (!Number.isInteger(l[k]) || l[k] < min || l[k] > max) throw new ValidationError(`limits.${k} must be an integer ${min}..${max}`, `limits.${k}`);
  if (!['low', 'medium', 'high'].includes(l.confidenceTarget)) throw new ValidationError('limits.confidenceTarget must be low|medium|high', 'limits.confidenceTarget');
  if (typeof l.conflictTolerance !== 'number' || !(l.conflictTolerance >= 0.01 && l.conflictTolerance <= 1)) throw new ValidationError('limits.conflictTolerance must be 0.01..1', 'limits.conflictTolerance');
  if (typeof l.maxCostUsd !== 'number' || !(l.maxCostUsd >= 0 && l.maxCostUsd <= 10)) throw new ValidationError('limits.maxCostUsd must be 0..10', 'limits.maxCostUsd');
  if (l.maxRetrievals > l.maxSources) l.maxRetrievals = l.maxSources; // cannot retrieve more than may be discovered
  return l;
}

/** Validates and normalizes a research objective (strict: unknown fields are rejected). */
export function validateObjective(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('objective must be an object', 'objective');
  known(input, ['title', 'question', 'purpose', 'scope', 'requiredInformation', 'constraints', 'freshness', 'market', 'sourcePreferences', 'limits', 'priority', 'businessId', 'context'], '');
  assertNoSecrets(input, 'objective'); assertJsonSize(input, 'objective', 32768);
  const o = { title: str(input.title, 'title', 3, 200), question: str(input.question, 'question', 5, 1000), purpose: str(input.purpose, 'purpose', 0, 500, { optional: true }), scope: str(input.scope, 'scope', 0, 500, { optional: true }) };
  const req = input.requiredInformation ?? []; if (!Array.isArray(req) || req.length > 10) throw new ValidationError('requiredInformation must be an array of at most 10 items', 'requiredInformation');
  const seen = new Set();
  o.requiredInformation = req.map((r, i) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) throw new ValidationError(`requiredInformation[${i}] must be an object`, 'requiredInformation');
    known(r, ['field', 'description', 'valueType', 'unit', 'findingType'], `requiredInformation[${i}].`);
    if (typeof r.field !== 'string' || !FIELD_RE.test(r.field)) throw new ValidationError(`requiredInformation[${i}].field must match ${FIELD_RE}`, 'requiredInformation'); if (seen.has(r.field)) throw new ValidationError(`duplicate field "${r.field}"`, 'requiredInformation'); seen.add(r.field);
    const valueType = r.valueType ?? 'text'; if (!['number', 'text', 'boolean'].includes(valueType)) throw new ValidationError('valueType must be number|text|boolean', 'requiredInformation');
    const findingType = r.findingType ?? 'constraint'; if (!FINDING_TYPES.includes(findingType) || findingType === 'unanswered_question' || findingType === 'gap') throw new ValidationError('findingType is not allowed', 'requiredInformation');
    return { field: r.field, description: str(r.description, 'requiredInformation.description', 3, 300), valueType, unit: str(r.unit, 'requiredInformation.unit', 0, 20, { optional: true }), findingType };
  });
  const c = input.constraints ?? []; if (!Array.isArray(c) || c.length > 10) throw new ValidationError('constraints must be an array of at most 10 strings', 'constraints');
  o.constraints = c.map((x) => str(x, 'constraints', 1, 300));
  if (input.freshness != null) { if (typeof input.freshness !== 'object' || !Number.isInteger(input.freshness.maxAgeDays) || input.freshness.maxAgeDays < 1 || input.freshness.maxAgeDays > 3650) throw new ValidationError('freshness.maxAgeDays must be an integer 1..3650', 'freshness'); known(input.freshness, ['maxAgeDays'], 'freshness.'); o.freshness = { maxAgeDays: input.freshness.maxAgeDays }; } else o.freshness = null;
  const m = input.market ?? {}; known(m, ['geography', 'market', 'language'], 'market.'); o.market = { geography: str(m.geography, 'market.geography', 0, 100, { optional: true }), market: str(m.market, 'market.market', 0, 100, { optional: true }), language: str(m.language, 'market.language', 0, 20, { optional: true }) };
  const sp = input.sourcePreferences ?? {}; known(sp, ['types', 'preferDomains', 'avoidDomains'], 'sourcePreferences.');
  const types = sp.types ?? []; if (!Array.isArray(types) || types.some((t) => !SOURCE_TYPES.includes(t))) throw new ValidationError('sourcePreferences.types contains an unknown source type', 'sourcePreferences');
  const list = (v, f) => { if (v == null) return []; if (!Array.isArray(v) || v.length > 20) throw new ValidationError(`${f} must be an array of at most 20 host names`, f); return v.map((h) => host(h, f)); };
  o.sourcePreferences = { types: [...new Set(types)], preferDomains: list(sp.preferDomains, 'sourcePreferences.preferDomains'), avoidDomains: list(sp.avoidDomains, 'sourcePreferences.avoidDomains') };
  o.limits = validateLimits(input.limits ?? {});
  if (input.priority != null && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10)) throw new ValidationError('priority must be an integer 0..10', 'priority');
  o.priority = input.priority ?? 5;
  if (input.businessId != null && !isId(input.businessId)) throw new ValidationError('businessId is invalid', 'businessId'); o.businessId = input.businessId ?? null;
  const ctx = input.context ?? {}; known(ctx, ['taskId', 'agentId', 'correlationId'], 'context.');
  for (const k of ['taskId', 'agentId', 'correlationId']) if (ctx[k] != null && !isId(ctx[k])) throw new ValidationError(`context.${k} is invalid`, `context.${k}`);
  o.context = { taskId: ctx.taskId ?? null, agentId: ctx.agentId ?? null, correlationId: ctx.correlationId ?? null };
  return o;
}

const STOP = new Set('a an the of and or to in on for with by from at as is are was were be been this that these those it its how what which who when where why do does did can could should would will about into over than then there their they them you your our we i not no yes if any all some more most less per vs'.split(' '));
export const tokenize = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s%$.-]/gu, ' ').split(/\s+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w));
export const terms = (s) => [...new Set(tokenize(s))];

/** Deterministic bounded plan: one subquestion per required field (or one for the whole question), queries derived from objective text. */
export function buildPlan(objective) {
  const L = objective.limits, fields = objective.requiredInformation.length ? objective.requiredInformation : [{ field: 'answer', description: objective.question, valueType: 'text', unit: null, findingType: 'constraint', implicit: true }];
  const ctx = [objective.market.geography, objective.market.market].filter(Boolean).join(' ');
  const subquestions = fields.slice(0, L.maxQueries).map((f, idx) => {
    const text = f.implicit ? objective.question : `${objective.question} — required: ${f.description}`;
    const ft = terms(f.description);
    const queries = [...new Set([[...new Set([...terms(objective.question).slice(0, 5), ...ft.slice(0, 3)])].join(' ') + (ctx ? ` ${ctx}` : ''), `${ft.slice(0, 6).join(' ')}${ctx ? ` ${ctx}` : ''}`.trim()].filter(Boolean))];
    return { idx, text: text.slice(0, 600), field: f.implicit ? null : f.field, queries };
  });
  const capped = subquestions.map((s) => ({ ...s, queries: [] }));
  let n = 0; for (let round = 0; round < 2; round++) for (const [i, s] of subquestions.entries()) { if (n >= L.maxQueries) break; if (s.queries[round]) { capped[i].queries.push(s.queries[round]); n++; } }
  return {
    version: 1, subquestions: capped.filter((s) => s.queries.length),
    sourceTypes: objective.sourcePreferences.types, expectedEvidence: fields.map((f) => ({ field: f.implicit ? 'answer' : f.field, valueType: f.valueType, unit: f.unit ?? null })),
    stopping: ['all required fields supported at the confidence target without unresolved conflicts', 'max sources / retrievals / AI calls / time budget reached', 'no new useful evidence in consecutive retrievals', 'all subquestions exhausted', 'cancelled'],
    limits: { maxSources: L.maxSources, maxRetrievals: L.maxRetrievals, maxAiCalls: L.maxAiCalls, maxTimeMs: L.maxTimeMs, confidenceTarget: L.confidenceTarget },
    outcomes: ['sufficient_evidence', 'insufficient_evidence', 'conflicting_evidence', 'no_useful_sources', 'budget_or_time_limit'],
  };
}
export const fieldsOf = (objective) => (objective.requiredInformation.length ? objective.requiredInformation : [{ field: 'answer', description: objective.question, valueType: 'text', unit: null, findingType: 'constraint', implicit: true }]);
