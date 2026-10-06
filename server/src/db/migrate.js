// SQL-file migrations: database/migrations/NNNN_name.sql, applied in order, each in its own transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ROOT } from '../config/index.js';

export const MIGRATIONS_DIR = resolve(ROOT, 'database/migrations');
export class MigrationError extends Error { constructor(code, message) { super(message); this.name = 'MigrationError'; this.code = code; } }

export function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const list = files.map((file) => {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!m) throw new MigrationError('bad_filename', `Migration file name must look like 0001_name.sql: ${file}`);
    const sql = readFileSync(resolve(dir, file), 'utf8');
    return { version: Number(m[1]), name: m[2], file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
  list.forEach((m, i) => { if (m.version !== i + 1) throw new MigrationError('gap', `Migrations must be numbered contiguously from 0001 (found ${m.file} at position ${i + 1})`); });
  return list;
}

const hasTable = (db) => !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='schema_migrations'");

/** Read-only status: {current, latest, applied, pending, problems}. problems non-empty => do not run. */
export function migrationStatus(db, migrations = loadMigrations()) {
  const applied = hasTable(db) ? db.all('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version') : [];
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const problems = [];
  for (const a of applied) {
    const m = byVersion.get(a.version);
    if (!m) problems.push({ code: 'db_newer_than_code', message: `Database has migration ${a.version} (${a.name}) that this code does not know. Run a newer version of the application.` });
    else if (m.checksum !== a.checksum) problems.push({ code: 'checksum_mismatch', message: `Migration ${m.file} was modified after being applied.` });
  }
  const done = new Set(applied.map((a) => a.version));
  const pending = migrations.filter((m) => !done.has(m.version));
  const current = applied.length ? applied[applied.length - 1].version : 0;
  return { current, latest: migrations.length, applied, pending: pending.map((m) => ({ version: m.version, name: m.name })), problems, _pending: pending };
}

/** Applies all pending migrations; each is atomic. Throws MigrationError (schema is left at the last good version). */
export function migrate(db, migrations = loadMigrations()) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'))) STRICT');
  const st = migrationStatus(db, migrations);
  if (st.problems.length) throw new MigrationError(st.problems[0].code, st.problems[0].message);
  const ran = [];
  for (const m of st._pending) {
    try {
      db.transaction(() => { db.exec(m.sql); db.run('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)', [m.version, m.name, m.checksum]); });
    } catch (err) {
      throw new MigrationError('apply_failed', `Migration ${m.file} failed and was rolled back: ${err.message}`);
    }
    ran.push(m.version);
  }
  return { ran, current: ran.length ? ran[ran.length - 1] : st.current };
}
