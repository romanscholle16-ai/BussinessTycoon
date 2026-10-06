// Database location. Never inside source-controlled code: must be under <repo>/runtime or outside the repo entirely.
import { resolve, sep } from 'node:path';
import { ROOT } from '../config/index.js';

export const DB_FILENAME = 'tycoon.sqlite';

export function resolveDataDir(config) {
  const dir = resolve(ROOT, config.paths.data);
  const runtime = resolve(ROOT, 'runtime');
  const insideRepo = dir === ROOT || dir.startsWith(ROOT + sep);
  const insideRuntime = dir === runtime || dir.startsWith(runtime + sep);
  if (insideRepo && !insideRuntime) throw new Error('Unsafe data directory: inside the repository but outside runtime/. Use runtime/... or a path outside the repository.');
  return dir;
}
export const resolveDbPath = (config) => resolve(resolveDataDir(config), DB_FILENAME);
