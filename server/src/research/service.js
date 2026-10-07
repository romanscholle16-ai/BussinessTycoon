// Research service: run creation (as Agent OS tasks), reads for the API, cancellation, reconciliation, provider wiring.
import { ValidationError, isId } from '../agents/validate.js';
import { TaskError } from '../agents/handlers.js';
import { validateObjective, TERMINAL_STATES, RUN_STATES, CONFIDENCE_LEVELS, FINDING_TYPES } from './model.js';
import { createResearchEngine } from './engine.js';
import { createSafeRetriever } from './retrieval.js';
import { createJsonSearchProvider } from './discovery.js';
import { normalizePolicy } from './urlsafe.js';

export class NotFoundError extends Error { constructor(m = 'not found') { super(m); this.name = 'NotFoundError'; } }
export class ConflictError extends Error { constructor(m) { super(m); this.name = 'ConflictError'; } }
export class UnavailableError extends Error { constructor(m) { super(m); this.name = 'UnavailableError'; } }

const parse = (r) => { if (!r) return r; const o = {}; for (const [k, v] of Object.entries(r)) o[k.endsWith('_json') ? k.slice(0, -5) : k] = k.endsWith('_json') && v != null ? JSON.parse(v) : v; return o; };
const bounded = (v, d, min, max, f) => { if (v == null) return d; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${f} must be an integer ${min}..${max}`, f); return n; };
const oneOf = (v, list, f) => { if (v == null) return null; if (!list.includes(v)) throw new ValidationError(`${f} must be one of ${list.join(', ')}`, f); return v; };
export const RESEARCH_CAPABILITIES = ['research', 'source_discovery', 'source_retrieval', 'evidence_analysis', 'analyze', 'ai'];
export const RESEARCH_AGENT = { id: 'research-engine', name: 'Research Engine', role: 'Research', businessId: null, taskTypes: ['research.run'], permissions: { capabilities: RESEARCH_CAPABILITIES, businesses: ['*'] }, limits: { timeoutMs: 1_800_000 } };

/** Non-secret research config from the environment. Discovery providers are OFF unless an endpoint is configured. */
export function researchConfigFromEnv(env = process.env, base = {}) {
  const r = { enabled: true, discovery: { jsonSearchEndpoint: null }, network: {}, retrieval: {}, ...base };
  if (env.RESEARCH_SEARCH_URL) r.discovery = { ...r.discovery, jsonSearchEndpoint: env.RESEARCH_SEARCH_URL };
  if (env.RESEARCH_ALLOW_LOCALHOST === '1') r.network = { ...r.network, allowLoopback: true, allowHttp: true, allowedPorts: [80, 443, 8080, 8888] };
  if (env.RESEARCH_ENABLED === '0') r.enabled = false;
  return r;
}

export function createResearchService({ db, repos, agentOS = null, ai = null, config = {}, providers = null, clock = { now: () => Date.now() }, logger = null }) {
  const problems = [];
  const policy = normalizePolicy(config.network);
  let discovery, retrieval;
  if (providers) { discovery = providers.discovery ?? []; retrieval = providers.retrieval ?? []; }
  else {
    discovery = []; retrieval = [createSafeRetriever({ policy, limits: config.retrieval })];
    if (config.discovery?.jsonSearchEndpoint) { try { discovery.push(createJsonSearchProvider({ endpoint: config.discovery.jsonSearchEndpoint, networkPolicy: policy })); } catch (e) { problems.push(`search endpoint rejected by the network policy (${e.code ?? 'invalid'})`); } }
  }
  const dataMode = discovery.some((p) => p.kind === 'mock') ? 'test' : 'live';
  const engine = createResearchEngine({ db, repos, providers: { discovery, retrieval, networkPolicy: policy }, ai, clock });

  function reconcile() {
    // A non-terminal run whose task already ended (failed/cancelled after retries/timeouts) can never progress: say so instead of hanging.
    const stuck = db.all(`SELECT r.id, t.status AS ts, t.error_code AS ec FROM research_runs r JOIN tasks t ON t.id = r.task_id WHERE r.status NOT IN (${TERMINAL_STATES.map(() => '?').join(',')}) AND t.status IN ('failed','cancelled','completed')`, TERMINAL_STATES);
    for (const s of stuck) { const cancelled = s.ts === 'cancelled'; repos.researchRuns.update(s.id, { status: cancelled ? 'cancelled' : 'failed', stop_reason: cancelled ? 'cancelled' : 'error', error_code: cancelled ? null : (s.ec ?? 'task_failed'), error_message: cancelled ? null : 'the Agent OS task ended before the run finished', completed_at: new Date(clock.now()).toISOString() }); }
    return stuck.length;
  }
  const summarize = (r) => {
    const c = db.get(`SELECT (SELECT COUNT(*) FROM research_evidence WHERE run_id = ?1 AND evidence_type IN ('directly_observed_fact','quoted_source_claim')) AS direct, (SELECT COUNT(*) FROM research_evidence WHERE run_id = ?1) AS evidence, (SELECT COUNT(*) FROM research_findings WHERE run_id = ?1) AS findings, (SELECT COUNT(*) FROM research_conflicts WHERE run_id = ?1 AND status = 'unresolved') AS conflicts, (SELECT COUNT(*) FROM research_sources WHERE run_id = ?1) AS sources`, [r.id]);
    const cn = r.counters ?? {}, pv = r.provenance ?? {}, plan = r.plan;
    const stages = ['planning', 'discovering', 'retrieving', 'evaluating', 'analyzing', 'synthesizing', 'validating'], idx = stages.indexOf(r.status);
    return {
      id: r.id, title: r.title, status: r.status, stage: TERMINAL_STATES.includes(r.status) ? 'done' : r.status, progress: TERMINAL_STATES.includes(r.status) ? 1 : Math.round((Math.max(0, idx) / stages.length) * 100) / 100,
      question: r.objective?.question ?? null, businessId: r.business_id, taskId: r.task_id, correlationId: r.correlation_id, priority: r.priority, dataMode: r.data_mode,
      counts: { sourcesDiscovered: cn.discovered ?? c.sources, sourcesRetrieved: cn.retrieved ?? 0, sourcesFailed: cn.failed ?? 0, duplicates: cn.duplicates ?? 0, evidence: c.evidence, directEvidence: c.direct, findings: c.findings, conflicts: c.conflicts, aiCalls: cn.aiCalls ?? 0 },
      confidence: r.confidence, confidenceScore: r.confidence_score, stopReason: r.stop_reason, error: r.error_code ? { code: r.error_code, message: r.error_message } : null, cancelRequested: !!r.cancel_requested,
      providers: { discovery: Object.keys(pv.discovery?.failures ?? {}).length || pv.discovery?.attempts?.length ? { attempts: pv.discovery.attempts.length, failures: pv.discovery.failures, fallbackUsed: pv.discovery.fallbackUsed } : null, ai: pv.ai ? { calls: pv.ai.calls ?? 0, provider: pv.ai.provider ?? null, model: pv.ai.model ?? null, costUsd: pv.ai.costUsd ?? null, skipped: pv.ai.skipped ?? null } : null },
      activeMs: r.active_ms, createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, completedAt: r.completed_at, planSummary: plan ? { subquestions: plan.subquestions.length, queries: plan.subquestions.reduce((a, s) => a + s.queries.length, 0) } : null,
    };
  }
  const getRow = (id) => { if (!isId(id)) throw new ValidationError('invalid run id', 'id'); const r = repos.researchRuns.get(id); if (!r) throw new NotFoundError('research run not found'); return r; };

  return {
    problems, engine, discovery, retrieval, dataMode, reconcile, policy,
    status: () => ({ enabled: config.enabled !== false, discoveryProviders: discovery.map((p) => ({ id: p.id, kind: p.kind })), retrievalProviders: retrieval.map((p) => ({ id: p.id, kind: p.kind })), networkPolicy: { allowHttp: policy.allowHttp, allowLoopback: policy.allowLoopback, allowPrivateNetworks: policy.allowPrivateNetworks, allowedPorts: policy.allowedPorts }, problems }),

    createRun(input) {
      if (config.enabled === false) throw new UnavailableError('the research engine is disabled');
      if (!agentOS) throw new UnavailableError('the Agent OS is not running; research runs need it to execute');
      const objective = validateObjective(input);
      if (objective.businessId && !repos.businesses.get(objective.businessId)) throw new ValidationError(`unknown business "${objective.businessId}"`, 'businessId');
      return db.transaction(() => {
        const run = repos.researchRuns.insert({ status: 'created', title: objective.title, objective, limits: objective.limits, business_id: objective.businessId, priority: objective.priority, correlation_id: objective.context.correlationId, data_mode: dataMode, created_at: new Date(clock.now()).toISOString() });
        const task = agentOS.queue.submit({ type: 'research.run', businessId: objective.businessId, priority: objective.priority, payload: { runId: run.id }, maxRetries: 2, timeoutMs: Math.min(3_600_000, objective.limits.maxTimeMs + 120_000), correlationId: run.correlation_id ?? run.id, dataMode });
        return summarize(repos.researchRuns.update(run.id, { task_id: task.id, correlation_id: run.correlation_id ?? run.id }));
      });
    },
    getRun(id) { reconcile(); const r = getRow(id); return { ...summarize(r), objective: r.objective, plan: r.plan, result: r.result, limits: r.limits }; },
    listRuns({ status, limit, offset } = {}) {
      reconcile();
      const st = oneOf(status, RUN_STATES, 'status'), lim = bounded(limit, 25, 1, 100, 'limit'), off = bounded(offset, 0, 0, 100000, 'offset');
      const total = repos.researchRuns.count(st ? { status: st } : {});
      return { runs: repos.researchRuns.list(st ? { status: st } : {}, { limit: lim, offset: off, orderBy: 'created_at desc, id asc' }).map(summarize), total, limit: lim, offset: off };
    },
    sources(id, { status, limit, offset } = {}) {
      getRow(id); const st = oneOf(status, ['discovered', 'retrieved', 'failed', 'skipped', 'duplicate'], 'status'), lim = bounded(limit, 50, 1, 200, 'limit'), off = bounded(offset, 0, 0, 100000, 'offset');
      const rows = db.all(`SELECT * FROM research_sources WHERE run_id = ? ${st ? 'AND status = ?' : ''} ORDER BY created_at, id LIMIT ? OFFSET ?`, st ? [id, st, lim, off] : [id, lim, off]).map(parse);
      const total = db.get(`SELECT COUNT(*) AS n FROM research_sources WHERE run_id = ? ${st ? 'AND status = ?' : ''}`, st ? [id, st] : [id]).n;
      return { sources: rows.map((s) => ({ id: s.id, url: s.url, canonicalUrl: s.canonical_url, finalUrl: s.final_url, domain: s.domain, title: s.title, status: s.status, type: s.source_type, qualityScore: s.quality_score, quality: s.quality ? { score: s.quality.score, primary: s.quality.primary, freshness: s.quality.freshness, factors: s.quality.factors } : null, discovery: { query: s.discovery?.query, rank: s.discovery?.rank, provider: s.discovery?.provider, discoveredAt: s.discovery?.discoveredAt }, retrieval: s.retrieval ? { provider: s.retrieval.provider ?? null, httpStatus: s.retrieval.httpStatus ?? null, contentType: s.retrieval.contentType ?? null, limitations: s.retrieval.limitations ?? [], failure: s.retrieval.failure ? { code: s.retrieval.failure.code, message: s.retrieval.failure.message } : null } : null, author: s.author, publishedAt: s.published_at, language: s.language, wordCount: s.word_count, charCount: s.char_count, extractionStatus: s.extraction_status, duplicateOf: s.duplicate_of, duplicateKind: s.duplicate_kind, retrievedAt: s.retrieved_at, contentHash: s.content_hash })), total, limit: lim, offset: off };
    },
    evidence(id, { type, field, limit, offset } = {}) {
      getRow(id); const t = oneOf(type, ['directly_observed_fact', 'quoted_source_claim', 'derived_calculation', 'model_inference', 'hypothesis'], 'type'), lim = bounded(limit, 50, 1, 200, 'limit'), off = bounded(offset, 0, 0, 100000, 'offset');
      if (field != null && !/^[a-z][a-z0-9_]{1,39}$/.test(field)) throw new ValidationError('invalid field', 'field');
      const w = ['run_id = ?'], p = [id]; if (t) { w.push('evidence_type = ?'); p.push(t); } if (field) { w.push('field = ?'); p.push(field); }
      const rows = db.all(`SELECT * FROM research_evidence WHERE ${w.join(' AND ')} ORDER BY observed_at, id LIMIT ? OFFSET ?`, [...p, lim, off]).map(parse);
      const total = db.get(`SELECT COUNT(*) AS n FROM research_evidence WHERE ${w.join(' AND ')}`, p).n;
      return { evidence: rows.map((e) => ({ id: e.id, sourceId: e.source_id, sourceUrl: e.source_url, claim: e.claim, excerpt: e.excerpt, location: e.location, type: e.evidence_type, directSourceEvidence: e.evidence_type === 'directly_observed_fact' || e.evidence_type === 'quoted_source_claim', field: e.field, value: e.value, unit: e.unit, observedAt: e.observed_at, freshness: e.freshness, confidence: e.confidence, confidenceScore: e.confidence_score, method: e.method, derivedFrom: e.derived_from, researchId: e.run_id })), total, limit: lim, offset: off };
    },
    findings(id, { type, limit, offset } = {}) {
      getRow(id); const t = oneOf(type, FINDING_TYPES, 'type'), lim = bounded(limit, 50, 1, 200, 'limit'), off = bounded(offset, 0, 0, 100000, 'offset');
      const rows = db.all(`SELECT * FROM research_findings WHERE run_id = ? ${t ? 'AND type = ?' : ''} ORDER BY rowid LIMIT ? OFFSET ?`, t ? [id, t, lim, off] : [id, lim, off]).map(parse);
      const total = db.get(`SELECT COUNT(*) AS n FROM research_findings WHERE run_id = ? ${t ? 'AND type = ?' : ''}`, t ? [id, t] : [id]).n;
      const conflicts = db.all('SELECT * FROM research_conflicts WHERE run_id = ? ORDER BY field', [id]).map(parse).map((c) => ({ id: c.id, field: c.field, description: c.description, claims: c.claims, status: c.status }));
      return { findings: rows.map((f) => ({ id: f.id, type: f.type, statement: f.statement, basis: f.basis, field: f.field, evidenceIds: f.evidence_ids, confidence: f.confidence, confidenceScore: f.confidence_score, rationale: f.rationale, freshness: f.freshness, conflictIds: f.conflict_ids, status: f.status })), conflicts, total, limit: lim, offset: off };
    },
    cancel(id) {
      const r = getRow(id); if (TERMINAL_STATES.includes(r.status)) throw new ConflictError(`run is already ${r.status}`);
      const task = r.task_id ? agentOS?.queue.get(r.task_id) : null;
      repos.researchRuns.update(id, { cancel_requested: 1 });
      if (task && task.status === 'running') { try { agentOS.cancelTask(task.id, 'research run cancelled'); } catch { /* the engine also observes the flag */ } }
      else {
        if (task && !['completed', 'failed', 'cancelled'].includes(task.status)) { try { agentOS.cancelTask(task.id, 'research run cancelled'); } catch { /* ignore */ } }
        repos.researchRuns.update(id, { status: 'cancelled', stop_reason: 'cancelled', completed_at: new Date(clock.now()).toISOString() });
        try { repos.events.insert({ ts: new Date(clock.now()).toISOString(), type: 'research.run_cancelled', severity: 'info', action: 'research run cancelled', metadata: { runId: id, stage: r.status }, data_mode: r.data_mode, business_id: r.business_id, task_id: r.task_id }); } catch { /* ignore */ }
      }
      return this.getRun(id);
    },
  };
}

/** Registers the Agent OS task handler. Capability `research` gates the task type; the engine additionally checks each stage's capability. */
export function registerResearchHandlers(registry, service) {
  registry.register('research.run', 'research', async ({ task, agent, signal }) => {
    const runId = task.payload?.runId; if (!isId(runId)) throw new TaskError('research_bad_payload', 'payload.runId is required', { retryable: false });
    let run;
    try { run = await service.engine.execute(runId, { signal, agent }); }
    catch (e) { if (e.code === 'interrupted') throw new TaskError('research_interrupted', e.message, { retryable: true }); if (e.message === 'research run not found') throw new TaskError('research_run_missing', e.message, { retryable: false }); throw e; }
    if (run.status === 'failed') throw new TaskError(`research_${run.error_code ?? 'failed'}`, run.error_message ?? 'research run failed', { retryable: false });
    return { runId, status: run.status, stopReason: run.stop_reason, confidence: run.confidence, counts: run.counters };
  });
  return registry;
}
export { CONFIDENCE_LEVELS };
