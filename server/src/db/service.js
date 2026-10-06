// Database service: owns the connection, startup migration, health state, graceful close.
import { Db } from './database.js';
import { resolveDbPath } from './paths.js';
import { loadMigrations, migrate, migrationStatus, MigrationError } from './migrate.js';
import { createRepos } from './repos.js';
import { seedFoundation } from './seed.js';

const APP_VERSION = '0.3.0';

export function createDatabaseService(config, { migrationsDir, path } = {}) {
  const autoMigrate = config.database?.autoMigrate ?? true;
  const busyTimeoutMs = config.database?.busyTimeoutMs ?? 5000;
  const svc = { status: 'closed', errorCode: null, db: null, repos: null, runId: null, previousCrashedRuns: 0 };
  const migrations = () => loadMigrations(migrationsDir);

  svc.open = () => {
    try {
      svc.db = Db.open(path ?? resolveDbPath(config), { busyTimeoutMs });
    } catch (err) { svc.status = 'unavailable'; svc.errorCode = err.code ?? 'open_failed'; return svc; }
    try {
      const ms = migrations(); let st = migrationStatus(svc.db, ms);
      if (st.problems.length) { svc.status = 'migration_failed'; svc.errorCode = st.problems[0].code; return svc; }
      if (st.pending.length) {
        if (!autoMigrate) { svc.status = 'migration_required'; return svc; }
        try { migrate(svc.db, ms); } catch (err) { svc.status = 'migration_failed'; svc.errorCode = err instanceof MigrationError ? err.code : 'migration_error'; return svc; }
      }
      svc.repos = createRepos(svc.db);
      seedFoundation(svc.repos);
      svc.runId = svc.repos.runs.start(APP_VERSION);
      svc.previousCrashedRuns = svc.repos.runs.markCrashed(svc.runId);
      svc.status = 'ok'; svc.errorCode = null;
    } catch (err) { svc.status = 'unavailable'; svc.errorCode = err.code ?? 'startup_failed'; }
    return svc;
  };

  /** Cheap health snapshot; no paths, no secrets. */
  svc.health = () => {
    const out = { status: svc.status };
    if (svc.errorCode) out.error = svc.errorCode;
    if (!svc.db || svc.db.closed) { if (svc.status === 'ok') out.status = 'unavailable'; return out; }
    try {
      svc.db.get('SELECT 1 AS ok');
      const st = migrationStatus(svc.db, migrations());
      Object.assign(out, { schemaVersion: st.current, latestVersion: st.latest, pendingMigrations: st.pending.length });
    } catch { out.status = 'unavailable'; }
    return out;
  };

  svc.close = () => {
    if (svc.db && !svc.db.closed) { try { if (svc.runId) svc.repos.runs.end(svc.runId); } catch { /* ignore */ } svc.db.close(); }
    svc.status = 'closed';
  };
  return svc;
}
