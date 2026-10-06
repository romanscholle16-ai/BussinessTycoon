// Observability service: read-only. Observe -> Persist (events/checkpoints already written by the system) -> Query -> Explain.
import { computeHealth, DEFAULT_THRESHOLDS } from './health.js';
import { computeMetrics } from './metrics.js';
import { EventQueries } from './events.js';

export function createObservability({ database, agentOS, supervisor, config = {}, clock = { now: () => new Date() } }) {
  const db = database?.db, events = db ? new EventQueries(db) : null;
  const cfg = config.observability ?? {}, cacheMs = cfg.healthCacheMs ?? 2000;
  const startedAt = (() => { try { return db && database.runId ? db.get('SELECT started_at FROM process_runs WHERE id = ?', [database.runId])?.started_at : null; } catch { return null; } })() ?? clock.now().toISOString();
  const cache = { at: 0, deepAt: 0, value: null, deep: null };
  const dbReady = () => !!db && !db.closed && database.status === 'ok';
  const base = () => ({ database, supervisor, os: agentOS, db, events, now: clock.now().getTime(), startedAt, env: config.env, thresholds: { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds ?? {}) } });
  return {
    startedAt, events, now: () => clock.now().getTime(),
    /** Cached for healthCacheMs (default 2 s) so frequent polling stays cheap; `deep` adds integrity checks, cached for 5 minutes. */
    health({ deep = false } = {}) {
      const now = clock.now().getTime();
      if (deep) { if (cache.deep && now - cache.deepAt < 300000) return cache.deep; }
      else if (cache.value && now - cache.at < cacheMs) return cache.value;
      let h;
      try { h = computeHealth({ ...base(), deep: deep && dbReady() }); }
      catch { h = { status: 'unknown', issues: 1, summary: 'health could not be computed', components: {}, attention: [], checkedAt: new Date(now).toISOString() }; }
      if (deep) { cache.deep = h; cache.deepAt = now; } else { cache.value = h; cache.at = now; }
      return h;
    },
    metrics(win) { if (!dbReady()) throw Object.assign(new Error('database not available'), { code: 'unavailable' }); return computeMetrics({ db, os: agentOS, supervisor, repos: database.repos }, win); },
    /** Compact summary for /api/health. */
    summary() {
      const h = this.health();
      return { health: h.status, issues: h.issues, supervisor: { state: supervisor?.state ?? 'not_running', health: h.components.supervisor?.status ?? 'unknown' }, agentOS: { total: h.components.agentOS?.details?.total ?? 0, available: h.components.agentOS?.details?.available ?? 0, health: h.components.agentOS?.status ?? 'unknown' }, tasks: h.components.tasks?.details?.counts ?? null };
    },
    dbReady,
  };
}
