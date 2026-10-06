// Minimal Phase 0 HTTP server: health endpoint only. Real API arrives in later phases.
import { createServer } from 'node:http';

export function createApp(config) {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', phase: 0, env: config.env }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}
