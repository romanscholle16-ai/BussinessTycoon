// Bounded foundation validation: runs only the smoke test.
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['--test', 'tests/smoke.test.js'], { stdio: 'inherit', timeout: 60000 });
process.exit(r.status ?? 1);
