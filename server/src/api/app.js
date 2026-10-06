// Minimal HTTP server: health endpoint + static client files. Real API arrives in later phases.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ROOT } from '../config/index.js';
import { handleAgentApi } from './agentRoutes.js';
import { handleObservabilityApi } from './observabilityRoutes.js';
import { handleAiApi } from './aiRoutes.js';
import { PHASE } from '../version.js';

const PUBLIC_DIR = resolve(ROOT, 'client/public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(PUBLIC_DIR, '.' + path);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function createApp(config, services = {}) {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // status = the HTTP server answering (always 'ok' here); health = real overall system health (never inferred from the HTTP response).
      const database = services.database ? services.database.health() : { status: 'not_configured' };
      const sum = services.observability ? services.observability.summary() : { health: 'unknown', issues: 0, supervisor: { state: 'not_running', health: 'unknown' }, agentOS: { total: 0, available: 0, health: 'unknown' } };
      res.end(JSON.stringify({ status: 'ok', health: sum.health, issues: sum.issues, phase: PHASE, env: config.env, database, supervisor: sum.supervisor, agentOS: sum.agentOS }));
      return;
    }
    if (req.url.startsWith('/api/') && ((await handleObservabilityApi(req, res, services)) || (await handleAiApi(req, res, services)) || (await handleAgentApi(req, res, config, services)))) return;
    if (req.method === 'GET' && !req.url.startsWith('/api/') && (await serveStatic(req, res))) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}
