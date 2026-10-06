// Database CLI: status | migrate | seed-demo | check | reset (dev only). Bounded, no network.
import { rmSync, existsSync } from 'node:fs';
import { loadConfig } from '../server/src/config/index.js';
import { resolveDbPath } from '../server/src/db/paths.js';
import { Db } from '../server/src/db/database.js';
import { loadMigrations, migrate, migrationStatus } from '../server/src/db/migrate.js';
import { createRepos } from '../server/src/db/repos.js';
import { seedFoundation, seedDemo } from '../server/src/db/seed.js';

const config = loadConfig(); const cmd = process.argv[2];
const path = resolveDbPath(config);
const out = (o) => console.log(JSON.stringify(o, null, 2));
try {
  if (cmd === 'reset') {
    if (config.env === 'production') throw new Error('Refusing to reset a production database');
    for (const f of [path, path + '-wal', path + '-shm']) if (existsSync(f)) rmSync(f);
    out({ reset: true });
  } else if (['status', 'migrate', 'seed-demo', 'check'].includes(cmd)) {
    const db = Db.open(path, { busyTimeoutMs: config.database.busyTimeoutMs });
    try {
      if (cmd === 'status') { const s = migrationStatus(db, loadMigrations()); out({ current: s.current, latest: s.latest, pending: s.pending, problems: s.problems }); }
      if (cmd === 'migrate') out(migrate(db, loadMigrations()));
      if (cmd === 'seed-demo') { migrate(db, loadMigrations()); out(seedDemo(db, createRepos(db), { env: config.env })); }
      if (cmd === 'check') { migrate(db, loadMigrations()); seedFoundation(createRepos(db)); const i = db.integrityCheck(), f = db.foreignKeyCheck(); out({ integrity: i, foreignKeys: f }); if (!i.ok || !f.ok) process.exitCode = 1; }
    } finally { db.close(); }
  } else { console.error('usage: node scripts/db.js status|migrate|seed-demo|check|reset'); process.exitCode = 2; }
} catch (err) { console.error(JSON.stringify({ error: err.message })); process.exitCode = 1; }
