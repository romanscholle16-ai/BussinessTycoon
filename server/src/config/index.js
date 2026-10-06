// Config loader: config/default.json < config/<env>.json < config/local.json < TYCOON_* env vars.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function readJson(p) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig(env = process.env) {
  const dir = resolve(ROOT, 'config');
  let cfg = readJson(resolve(dir, 'default.json'));
  const mode = env.TYCOON_ENV ?? cfg.env ?? 'development';
  cfg = merge(cfg, readJson(resolve(dir, `${mode}.json`)));
  cfg = merge(cfg, readJson(resolve(dir, 'local.json')));
  cfg.env = mode;
  if (env.TYCOON_HOST) cfg.server.host = env.TYCOON_HOST;
  if (env.TYCOON_PORT) cfg.server.port = Number(env.TYCOON_PORT);
  if (env.TYCOON_LOG_LEVEL) cfg.logging.level = env.TYCOON_LOG_LEVEL;
  if (env.TYCOON_DATA_DIR) cfg.paths.data = env.TYCOON_DATA_DIR;
  if (env.TYCOON_LOG_DIR) cfg.logging.dir = env.TYCOON_LOG_DIR;
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) {
    throw new Error(`Invalid server port: ${cfg.server.port}`);
  }
  return cfg;
}
