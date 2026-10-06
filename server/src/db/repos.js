// Practical repositories: whitelisted columns, parameterized SQL only, JSON columns parsed/stringified.
import { randomUUID } from 'node:crypto';

export class RepoError extends Error { constructor(m) { super(m); this.name = 'RepoError'; } }
const MODES = ['demo', 'test', 'live'];

function makeRepo(db, { table, pk = 'id', cols, json = [], updatedAt = false, generateId = true, readOnly = false }) {
  const all = new Set([pk, ...cols]);
  const jsonCols = new Set(json.map((j) => `${j}_json`));
  const col = (name) => {
    const real = json.includes(name) ? `${name}_json` : name;
    if (!all.has(real)) throw new RepoError(`Unknown column "${name}" for ${table}`);
    return real;
  };
  const enc = (real, v) => (jsonCols.has(real) && v !== null && v !== undefined ? JSON.stringify(v) : v);
  const dec = (row) => {
    if (!row) return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) { if (jsonCols.has(k)) out[k.slice(0, -5)] = v === null ? null : JSON.parse(v); else out[k] = v; }
    return out;
  };
  const where = (filter) => {
    const keys = Object.keys(filter), params = [];
    const sql = keys.map((k) => { const real = col(k), v = filter[k]; if (Array.isArray(v)) { params.push(...v); return `${real} IN (${v.map(() => '?').join(',')})`; } if (v === null) return `${real} IS NULL`; params.push(v); return `${real} = ?`; }).join(' AND ');
    return { sql: sql ? `WHERE ${sql}` : '', params };
  };
  const repo = {
    get: (id) => dec(db.get(`SELECT * FROM ${table} WHERE ${pk} = ?`, [id])),
    list(filter = {}, { limit = 100, offset = 0, orderBy } = {}) {
      const w = where(filter), order = orderBy ? `ORDER BY ${orderBy.split(',').map((o) => { const [c, d = 'asc'] = o.trim().split(/\s+/); if (!/^(asc|desc)$/i.test(d)) throw new RepoError('bad order'); return `${col(c)} ${d.toUpperCase()}`; }).join(', ')}` : '';
      return db.all(`SELECT * FROM ${table} ${w.sql} ${order} LIMIT ? OFFSET ?`, [...w.params, Math.min(Number(limit) | 0, 1000), Number(offset) | 0]).map(dec);
    },
    count(filter = {}) { const w = where(filter); return db.get(`SELECT COUNT(*) AS n FROM ${table} ${w.sql}`, w.params).n; },
    insert(obj) {
      const o = { ...obj }; if (generateId && o[pk] === undefined) o[pk] = randomUUID();
      const keys = Object.keys(o).filter((k) => o[k] !== undefined), reals = keys.map(col);
      db.run(`INSERT INTO ${table} (${reals.join(', ')}) VALUES (${reals.map(() => '?').join(', ')})`, keys.map((k, i) => enc(reals[i], o[k])));
      return repo.get(o[pk]);
    },
  };
  if (!readOnly) repo.update = (id, patch) => {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (keys.some((k) => col(k) === pk)) throw new RepoError('Primary key cannot be updated');
    const sets = keys.map((k) => `${col(k)} = ?`), params = keys.map((k) => enc(col(k), patch[k]));
    if (updatedAt) sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    if (!sets.length) return repo.get(id);
    const r = db.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${pk} = ?`, [...params, id]);
    if (!r.changes) throw new RepoError(`${table} ${id} not found`);
    return repo.get(id);
  };
  return repo;
}

export function createRepos(db) {
  const base = ['data_mode'];
  const businesses = makeRepo(db, { table: 'businesses', cols: ['name', 'kind', 'status', 'level', 'config_json', ...base, 'created_at', 'updated_at'], json: ['config'], updatedAt: true, generateId: false });
  const agents = makeRepo(db, { table: 'agents', cols: ['name', 'role', 'business_id', 'status', 'level', 'xp', 'reputation', 'health', 'metrics_json', 'config_json', ...base, 'created_at', 'updated_at', 'retired_at'], json: ['metrics', 'config'], updatedAt: true });
  const tasks = makeRepo(db, { table: 'tasks', cols: ['business_id', 'agent_id', 'parent_task_id', 'correlation_id', 'type', 'status', 'priority', 'payload_json', 'result_json', 'retry_count', 'max_retries', 'error_code', 'error_message', 'created_at', 'updated_at', 'started_at', 'completed_at', 'next_attempt_at', ...base], json: ['payload', 'result'], updatedAt: true });
  const events = makeRepo(db, { table: 'events', cols: ['ts', 'type', 'severity', 'business_id', 'agent_id', 'task_id', 'action', 'result', 'cost_minor', 'currency', 'error', 'metadata_json', ...base], json: ['metadata'], readOnly: true });
  const ledger = makeRepo(db, { table: 'ledger_entries', cols: ['ts', 'business_id', 'type', 'category', 'amount_minor', 'currency', 'source', 'reference', 'task_id', 'agent_id', 'metadata_json', ...base], json: ['metadata'], readOnly: true });
  const approvals = makeRepo(db, { table: 'approvals', cols: ['request_type', 'business_id', 'task_id', 'agent_id', 'action', 'amount_minor', 'currency', 'reason', 'expected_benefit', 'risk', 'status', 'expires_at', 'created_at', 'resolved_at', 'resolution', 'resolved_by', ...base] });
  const quests = makeRepo(db, { table: 'quests', cols: ['key', 'title', 'description', 'business_id', 'status', 'progress', 'goal', 'reward_json', 'verification_json', 'created_at', 'completed_at', ...base], json: ['reward', 'verification'] });
  const upgrades = makeRepo(db, { table: 'upgrades', cols: ['key', 'name', 'business_id', 'cost_minor', 'currency', 'effect_json', 'status', 'approval_id', 'installed_at', ...base], json: ['effect'] });
  const achievements = makeRepo(db, { table: 'achievements', cols: ['key', 'title', 'description', 'subject_type', 'subject_id', 'unlocked_at', 'evidence_json', ...base], json: ['evidence'], readOnly: true });
  const leaderboard = makeRepo(db, { table: 'leaderboard_metrics', cols: ['subject_type', 'subject_id', 'metric', 'value', 'period', 'recorded_at', ...base], generateId: false, readOnly: true });
  const metrics = makeRepo(db, { table: 'business_metrics', cols: ['business_id', 'metric', 'value', 'period', 'recorded_at', ...base], generateId: false, readOnly: true });

  const requireMode = (mode) => { if (!MODES.includes(mode)) throw new RepoError('data mode (demo|test|live) is required'); return mode; };

  const ledgerApi = {
    ...ledger,
    /** Totals in minor units for ONE data mode (callers must choose; modes are never mixed). */
    summary({ mode, businessId = null, since = null, until = null }) {
      requireMode(mode);
      const p = [mode], f = ['data_mode = ?'];
      if (businessId) { f.push('business_id = ?'); p.push(businessId); }
      if (since) { f.push('ts >= ?'); p.push(since); }
      if (until) { f.push('ts < ?'); p.push(until); }
      const rows = db.all(`SELECT type, category, SUM(amount_minor) AS total FROM ledger_entries WHERE ${f.join(' AND ')} GROUP BY type, category`, p);
      const byCategory = {}; let revenueMinor = 0, expenseMinor = 0;
      for (const r of rows) { byCategory[r.category] = r.total; if (r.type === 'revenue') revenueMinor += r.total; else expenseMinor += r.total; }
      return { mode, revenueMinor, expenseMinor, netMinor: revenueMinor - expenseMinor, byCategory };
    },
  };
  const approvalsApi = {
    ...approvals,
    /** Atomically resolve a pending approval. Returns the row, or throws if it was not pending. */
    resolve(id, { status, resolution = null, resolvedBy = null }) {
      if (!['approved', 'denied', 'cancelled', 'expired'].includes(status)) throw new RepoError('invalid resolution status');
      const r = db.run("UPDATE approvals SET status = ?, resolution = ?, resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending'", [status, resolution, resolvedBy, id]);
      if (!r.changes) throw new RepoError(`approval ${id} is not pending`);
      return approvals.get(id);
    },
  };
  const systemState = {
    get(key) { const r = db.get('SELECT value_json FROM system_state WHERE key = ?', [key]); return r ? JSON.parse(r.value_json) : undefined; },
    set(key, value, kind = 'state') { db.run("INSERT INTO system_state (key, kind, value_json) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, kind = excluded.kind, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", [key, kind, JSON.stringify(value)]); },
    list(kind = null) { return db.all(`SELECT key, kind, value_json, updated_at FROM system_state ${kind ? 'WHERE kind = ?' : ''} ORDER BY key`, kind ? [kind] : []).map((r) => ({ key: r.key, kind: r.kind, value: JSON.parse(r.value_json), updated_at: r.updated_at })); },
  };
  const checkpoints = {
    save(scope, key, state, mode = 'live') { requireMode(mode); db.run("INSERT INTO checkpoints (scope, key, state_json, data_mode) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET state_json = excluded.state_json, version = version + 1, data_mode = excluded.data_mode, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", [scope, key, JSON.stringify(state), mode]); },
    load(scope, key) { const r = db.get('SELECT * FROM checkpoints WHERE scope = ? AND key = ?', [scope, key]); return r ? { scope, key, version: r.version, state: JSON.parse(r.state_json), updated_at: r.updated_at, data_mode: r.data_mode } : undefined; },
    list(scope) { return db.all('SELECT key FROM checkpoints WHERE scope = ? ORDER BY key', [scope]).map((r) => r.key); },
  };
  const progression = {
    get(subjectType, subjectId, mode) { requireMode(mode); return db.get('SELECT * FROM progression WHERE subject_type = ? AND subject_id = ? AND data_mode = ?', [subjectType, subjectId, mode]); },
    upsert(subjectType, subjectId, mode, { xp = 0, level = 1, reputation = 0 }) { requireMode(mode); db.run("INSERT INTO progression (subject_type, subject_id, data_mode, xp, level, reputation) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(subject_type, subject_id, data_mode) DO UPDATE SET xp = excluded.xp, level = excluded.level, reputation = excluded.reputation, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')", [subjectType, subjectId, mode, xp, level, reputation]); return progression.get(subjectType, subjectId, mode); },
  };
  const runs = {
    start(appVersion = null) { const id = randomUUID(); db.run('INSERT INTO process_runs (id, pid, app_version) VALUES (?, ?, ?)', [id, process.pid, appVersion]); return id; },
    end(id) { db.run("UPDATE process_runs SET status = 'clean', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'running'", [id]); },
    /** Marks earlier runs that never ended as crashed; returns how many (recovery foundation). */
    markCrashed(exceptId) { return db.run("UPDATE process_runs SET status = 'crashed' WHERE status = 'running' AND id <> ?", [exceptId]).changes; },
  };
  return { businesses, agents, tasks, events, ledger: ledgerApi, approvals: approvalsApi, quests, upgrades, achievements, leaderboard, metrics, systemState, checkpoints, progression, runs };
}
