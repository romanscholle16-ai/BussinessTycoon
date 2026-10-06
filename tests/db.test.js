import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Db } from '../server/src/db/database.js';
import { loadMigrations, migrate, migrationStatus, MigrationError, MIGRATIONS_DIR } from '../server/src/db/migrate.js';
import { createRepos } from '../server/src/db/repos.js';
import { seedFoundation, seedDemo } from '../server/src/db/seed.js';
import { createDatabaseService } from '../server/src/db/service.js';
import { resolveDataDir } from '../server/src/db/paths.js';
import { createApp } from '../server/src/api/app.js';
import { loadConfig, ROOT } from '../server/src/config/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'tycoon-db-'));
const fresh = () => { const dir = tmp(), path = join(dir, 't.sqlite'), db = Db.open(path); migrate(db); return { dir, path, db, repos: createRepos(db) }; };
const cfgFor = (dir, extra = {}) => ({ ...loadConfig({}), paths: { data: dir }, database: { autoMigrate: true, busyTimeoutMs: 1000, ...extra } });
const tables = (db) => db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);

test('fresh database: migrations run, schema + safety pragmas present', () => {
  const { db, dir } = fresh();
  try {
    const t = tables(db);
    for (const n of ['schema_migrations', 'system_state', 'businesses', 'business_metrics', 'agents', 'tasks', 'events', 'ledger_entries', 'progression', 'achievements', 'quests', 'upgrades', 'leaderboard_metrics', 'approvals', 'checkpoints', 'process_runs']) assert.ok(t.includes(n), n);
    assert.equal(db.pragma('foreign_keys'), 1);
    assert.equal(db.pragma('journal_mode'), 'wal');
    assert.equal(db.pragma('busy_timeout'), 5000);
    const st = migrationStatus(db);
    assert.equal(st.current, st.latest); assert.equal(st.pending.length, 0); assert.ok(st.latest >= 2);
    assert.ok(db.integrityCheck().ok);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('persistence: records survive close and reopen', () => {
  const { db, dir, path } = fresh();
  try {
    let repos = createRepos(db); seedFoundation(repos);
    repos.agents.insert({ id: 'a1', name: 'Test Agent', role: 'Research', business_id: 'etsy', config: { k: [1, 2] }, data_mode: 'test' });
    repos.tasks.insert({ id: 't1', business_id: 'etsy', agent_id: 'a1', type: 'x', payload: { n: 1 }, data_mode: 'test' });
    repos.systemState.set('answer', { v: 42 });
    db.close();
    const db2 = Db.open(path); repos = createRepos(db2);
    assert.deepEqual(repos.agents.get('a1').config, { k: [1, 2] });
    assert.deepEqual(repos.tasks.get('t1').payload, { n: 1 });
    assert.deepEqual(repos.systemState.get('answer'), { v: 42 });
    assert.equal(repos.businesses.count(), 4);
    db2.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test('persistence across separate processes (CLI)', () => {
  const dir = tmp(), env = { ...process.env, TYCOON_DATA_DIR: dir };
  try {
    const run = (cmd) => spawnSync(process.execPath, ['--no-warnings', 'scripts/db.js', cmd], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
    const a = run('seed-demo'); assert.equal(a.status, 0, a.stderr); assert.equal(JSON.parse(a.stdout).seeded, true);
    const b = run('seed-demo'); assert.equal(JSON.parse(b.stdout).seeded, false); // second process sees first process's data
    const c = run('check'); assert.equal(c.status, 0, c.stderr);
    const prod = spawnSync(process.execPath, ['--no-warnings', 'scripts/db.js', 'seed-demo'], { cwd: ROOT, env: { ...env, TYCOON_ENV: 'production' }, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(prod.status, 0); // refuses to seed demo data in production
  } finally { rmSync(dir, { recursive: true }); }
});

test('migrations: ordered, idempotent, atomic, and mismatches are detected', () => {
  const db = Db.open(':memory:');
  const ms = loadMigrations();
  assert.deepEqual(ms.map((m) => m.version), ms.map((_, i) => i + 1));
  assert.equal(migrationStatus(db, ms).pending.length, ms.length); // before: all pending
  assert.deepEqual(migrate(db, ms).ran, ms.map((m) => m.version));
  assert.deepEqual(migrate(db, ms).ran, []); // repeat is a no-op
  assert.equal(db.get('SELECT COUNT(*) AS n FROM schema_migrations').n, ms.length);
  db.close();

  const dir = tmp();
  try {
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const d1 = Db.open(':memory:'); migrate(d1, loadMigrations(dir));
    // a bad new migration rolls back completely and leaves the schema at the last good version
    writeFileSync(join(dir, '9999_bad.sql'), 'x');
    assert.throws(() => loadMigrations(dir), (e) => e.code === 'gap');
    rmSync(join(dir, '9999_bad.sql'));
    const n = loadMigrations(dir).length + 1;
    writeFileSync(join(dir, `${String(n).padStart(4, '0')}_bad.sql`), 'CREATE TABLE half_done (id INTEGER); INSERT INTO nope VALUES (1);');
    assert.throws(() => migrate(d1, loadMigrations(dir)), (e) => e instanceof MigrationError && e.code === 'apply_failed');
    assert.equal(migrationStatus(d1, loadMigrations(dir)).current, n - 1);
    assert.ok(!tables(d1).includes('half_done'), 'partial migration must be rolled back');
    // editing an applied migration is detected
    const first = readdirSync(dir).sort()[0]; writeFileSync(join(dir, first), '-- tampered\n' + '');
    assert.throws(() => migrate(d1, loadMigrations(dir)), (e) => e.code === 'checksum_mismatch');
    // database newer than code
    const d2 = Db.open(':memory:'); migrate(d2, ms); d2.run("INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'future', 'x')");
    assert.throws(() => migrate(d2, ms), (e) => e.code === 'db_newer_than_code');
    d1.close(); d2.close();
  } finally { rmSync(dir, { recursive: true }); }
});

test('integrity: foreign keys, uniqueness, checks, and append-only tables', () => {
  const { db, dir, repos } = fresh();
  try {
    seedFoundation(repos);
    assert.throws(() => repos.tasks.insert({ type: 'x', business_id: 'nope' }), /FOREIGN KEY/);
    repos.agents.insert({ id: 'a1', name: 'Dup', role: 'QA', data_mode: 'test' });
    assert.throws(() => repos.agents.insert({ name: 'Dup', role: 'QA' }), /UNIQUE/);
    assert.throws(() => repos.agents.insert({ name: 'Bad Role', role: 'Wizard' }), /CHECK/);
    assert.throws(() => repos.tasks.insert({ type: 'x', status: 'bogus' }), /CHECK/);
    assert.throws(() => repos.tasks.insert({ type: 'x', priority: 99 }), /CHECK/);
    assert.throws(() => repos.businesses.insert({ id: 'z', name: 'Z', kind: 'etsy_pod' }), /UNIQUE|CHECK/);
    assert.throws(() => repos.agents.insert({ name: 'M', role: 'QA', data_mode: 'fake' }), /CHECK/);
    const good = { business_id: 'etsy', type: 'revenue', category: 'revenue', amount_minor: 500, source: 'test', reference: 'r1', data_mode: 'test' };
    repos.ledger.insert(good);
    assert.throws(() => repos.ledger.insert(good), /UNIQUE/); // idempotent imports
    assert.throws(() => repos.ledger.insert({ ...good, reference: 'r2', amount_minor: 0 }), /CHECK/);
    assert.throws(() => repos.ledger.insert({ ...good, reference: 'r3', category: 'ai_cost' }), /CHECK/); // revenue must use revenue category
    assert.throws(() => repos.ledger.insert({ ...good, reference: 'r4', business_id: 'ghost' }), /FOREIGN KEY/);
    const ev = repos.events.insert({ type: 't', action: 'a', data_mode: 'test' });
    assert.throws(() => db.run("UPDATE events SET action = 'x' WHERE id = ?", [ev.id]), /append-only/);
    assert.throws(() => db.run('DELETE FROM events WHERE id = ?', [ev.id]), /append-only/);
    assert.throws(() => db.run('DELETE FROM ledger_entries'), /append-only/);
    assert.throws(() => db.run('DELETE FROM businesses WHERE id = ?', ['etsy']), /FOREIGN KEY/); // referenced by ledger
    assert.throws(() => repos.agents.update('a1', { id: 'other' }), /Primary key/);
    assert.ok(db.foreignKeyCheck().ok);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('transactions: commit, rollback, nested savepoints', () => {
  const { db, dir, repos } = fresh();
  try {
    seedFoundation(repos);
    db.transaction(() => { repos.agents.insert({ id: 'c1', name: 'Committed', role: 'QA' }); });
    assert.ok(repos.agents.get('c1'));
    assert.throws(() => db.transaction(() => { repos.agents.insert({ id: 'r1', name: 'RolledBack', role: 'QA' }); throw new Error('boom'); }), /boom/);
    assert.equal(repos.agents.get('r1'), undefined);
    db.transaction(() => {
      repos.agents.insert({ id: 'o1', name: 'Outer', role: 'QA' });
      assert.throws(() => db.transaction(() => { repos.agents.insert({ id: 'i1', name: 'Inner', role: 'QA' }); throw new Error('inner'); }), /inner/);
    });
    assert.ok(repos.agents.get('o1')); assert.equal(repos.agents.get('i1'), undefined); // inner rolled back, outer kept
    assert.throws(() => db.transaction(async () => {}), /synchronous/);
    assert.equal(db.inTransaction, false);
    // failed DB constraint inside a transaction rolls the whole thing back
    assert.throws(() => db.transaction(() => { repos.agents.insert({ id: 'p1', name: 'P1', role: 'QA' }); repos.agents.insert({ id: 'p2', name: 'P1', role: 'QA' }); }), /UNIQUE/);
    assert.equal(repos.agents.get('p1'), undefined);
    // approvals resolve exactly once
    repos.approvals.insert({ id: 'ap', request_type: 'spend', action: 'x', amount_minor: 3000, data_mode: 'test' });
    assert.equal(repos.approvals.resolve('ap', { status: 'approved', resolvedBy: 'user' }).status, 'approved');
    assert.throws(() => repos.approvals.resolve('ap', { status: 'denied' }), /not pending/);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('SQL safety: values are parameterized and unknown columns/orderings are rejected', () => {
  const { db, dir, repos } = fresh();
  try {
    const evil = "x'); DROP TABLE agents; --";
    repos.agents.insert({ id: 'inj', name: evil, role: 'QA', data_mode: 'test' });
    assert.equal(repos.agents.get('inj').name, evil);
    assert.equal(repos.agents.list({ name: evil }).length, 1);
    assert.ok(tables(db).includes('agents'));
    assert.throws(() => repos.agents.list({ 'name = 1 OR 1=1 --': 1 }), /Unknown column/);
    assert.throws(() => repos.agents.list({}, { orderBy: 'name; DROP TABLE agents' }), /Unknown column|bad order/);
    assert.throws(() => repos.ledger.summary({}), /data mode/);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('demo seed is explicit, idempotent, clearly demo, and never mixes into live totals', () => {
  const { db, dir, repos } = fresh();
  try {
    assert.throws(() => seedDemo(db, repos, { env: 'production' }), /production/);
    assert.equal(seedDemo(db, repos).seeded, true);
    assert.equal(seedDemo(db, repos).seeded, false);
    for (const t of ['agents', 'tasks', 'events', 'ledger_entries', 'quests', 'upgrades', 'approvals']) assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE data_mode <> 'demo'`).n, 0, t);
    assert.ok(repos.agents.list({}).every((a) => a.name.startsWith('DEMO ')));
    const demo = repos.ledger.summary({ mode: 'demo' }), live = repos.ledger.summary({ mode: 'live' });
    assert.equal(live.revenueMinor, 0); assert.equal(live.expenseMinor, 0);
    assert.equal(demo.netMinor, 1280); // matches the Phase 1 mock: +$12.80
    assert.equal(repos.businesses.count({ data_mode: 'live' }), 4); // structural records only
    assert.ok(db.foreignKeyCheck().ok);
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test('data directory cannot point into source-controlled code', () => {
  const cfg = (p) => ({ paths: { data: p } });
  assert.throws(() => resolveDataDir(cfg('server/src')), /Unsafe/);
  assert.throws(() => resolveDataDir(cfg('docs')), /Unsafe/);
  assert.throws(() => resolveDataDir(cfg('.')), /Unsafe/);
  assert.throws(() => resolveDataDir(cfg('runtime/../database')), /Unsafe/);
  assert.ok(resolveDataDir(cfg('runtime/data')).endsWith(join('runtime', 'data')));
  assert.equal(resolveDataDir(cfg(tmpdir())), resolve(tmpdir()));
});

test('health: service states and /api/health', async () => {
  const dir = tmp(); let svc;
  const get = async (services) => { const s = createApp(loadConfig({}), services); await new Promise((r) => s.listen(0, '127.0.0.1', r)); try { const res = await fetch(`http://127.0.0.1:${s.address().port}/api/health`); return { code: res.status, body: await res.json() }; } finally { s.close(); } };
  try {
    assert.deepEqual((await get({})).body.database, { status: 'not_configured' });
    svc = createDatabaseService(cfgFor(dir)).open();
    let r = await get({ database: svc });
    assert.equal(r.code, 200); assert.equal(r.body.status, 'ok');
    assert.equal(r.body.database.status, 'ok'); assert.equal(r.body.database.pendingMigrations, 0);
    assert.ok(!JSON.stringify(r.body).includes(dir), 'no filesystem paths in health');
    svc.close(); assert.equal(svc.health().status, 'closed');
    // migration required (autoMigrate off)
    const dir2 = tmp(); const s2 = createDatabaseService(cfgFor(dir2, { autoMigrate: false })).open();
    r = await get({ database: s2 }); assert.equal(r.body.database.status, 'migration_required'); s2.close(); rmSync(dir2, { recursive: true });
    // migration failed (applied migration tampered)
    const mdir = tmp(); cpSync(MIGRATIONS_DIR, mdir, { recursive: true });
    const dir3 = tmp(); const ok = createDatabaseService(cfgFor(dir3), { migrationsDir: mdir }).open(); ok.close();
    writeFileSync(join(mdir, readdirSync(mdir).sort()[0]), '-- changed');
    const s3 = createDatabaseService(cfgFor(dir3), { migrationsDir: mdir }).open();
    r = await get({ database: s3 }); assert.equal(r.body.database.status, 'migration_failed'); assert.equal(r.body.database.error, 'checksum_mismatch'); assert.equal(r.body.status, 'ok'); s3.close();
    rmSync(dir3, { recursive: true }); rmSync(mdir, { recursive: true });
    // unavailable (db closed underneath a running service)
    const dir4 = tmp(); const s4 = createDatabaseService(cfgFor(dir4)).open(); s4.db.close();
    assert.equal(s4.health().status, 'unavailable'); rmSync(dir4, { recursive: true });
    // unclean shutdown detection: reopen without closing cleanly
    const dir5 = tmp(); const a = createDatabaseService(cfgFor(dir5)).open(); a.db.close();
    const b = createDatabaseService(cfgFor(dir5)).open(); assert.equal(b.previousCrashedRuns, 1); b.close(); rmSync(dir5, { recursive: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
