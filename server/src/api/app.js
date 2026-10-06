// Minimal HTTP server: health endpoint + static client files. Real API arrives in later phases.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ROOT } from '../config/index.js';

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

export function createApp(config) {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', phase: 1, env: config.env }));
      return;
    }
    if (req.method === 'GET' && !req.url.startsWith('/api/') && (await serveStatic(req, res))) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}
