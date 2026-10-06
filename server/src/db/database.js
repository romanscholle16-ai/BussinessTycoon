// Thin wrapper over node:sqlite (built in to Node >= 22.13). Synchronous API; safe pragmas; transactions.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const bind = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export class Db {
  #raw; #depth = 0; #cache = new Map(); closed = false;
  constructor(raw, path) { this.#raw = raw; this.path = path; }

  static open(path, { busyTimeoutMs = 5000, readOnly = false } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const raw = new DatabaseSync(path, { readOnly });
    raw.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}; PRAGMA foreign_keys = ON;`);
    if (!readOnly) raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    return new Db(raw, path);
  }
  #stmt(sql) { let s = this.#cache.get(sql); if (!s) { s = this.#raw.prepare(sql); this.#cache.set(sql, s); } return s; }
  exec(sql) { this.#raw.exec(sql); }
  run(sql, params = []) { const r = this.#stmt(sql).run(...params.map(bind)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }
  get(sql, params = []) { return this.#stmt(sql).get(...params.map(bind)); }
  all(sql, params = []) { return this.#stmt(sql).all(...params.map(bind)); }
  pragma(name) { const row = this.#raw.prepare(`PRAGMA ${name}`).get(); return row ? Object.values(row)[0] : undefined; }

  /** Runs fn inside a transaction (BEGIN IMMEDIATE) or a savepoint when nested. Rolls back if fn throws. fn must be synchronous. */
  transaction(fn) {
    const nested = this.#depth > 0, sp = `sp_${this.#depth}`;
    this.#raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const out = fn(this);
      if (out && typeof out.then === 'function') throw new Error('transaction callbacks must be synchronous');
      this.#depth--;
      this.#raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      return out;
    } catch (err) {
      this.#depth--;
      this.#raw.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
      throw err;
    }
  }
  get inTransaction() { return this.#depth > 0; }

  integrityCheck() { const rows = this.all('PRAGMA integrity_check'); return rows.length === 1 && rows[0].integrity_check === 'ok' ? { ok: true, problems: [] } : { ok: false, problems: rows.map((r) => r.integrity_check) }; }
  foreignKeyCheck() { const rows = this.all('PRAGMA foreign_key_check'); return { ok: rows.length === 0, violations: rows.map((r) => ({ ...r })) }; }

  close() {
    if (this.closed) return;
    try { if (this.path !== ':memory:') this.#raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    this.#cache.clear(); this.#raw.close(); this.closed = true;
  }
}
