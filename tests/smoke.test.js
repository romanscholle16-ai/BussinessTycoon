import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, ROOT } from '../server/src/config/index.js';
import { createApp } from '../server/src/api/app.js';

test('required project directories and docs exist', () => {
  for (const p of ['server/src', 'client', 'agents', 'businesses', 'database/migrations', 'config', 'tests', 'scripts',
    'runtime/data', 'runtime/logs', 'assets', 'client/public/lab/index.html', 'docs/CURRENT_STATE.md', 'docs/CHECKLIST.md', 'docs/project_state.json', 'AGENTS.md']) {
    assert.ok(existsSync(resolve(ROOT, p)), `missing ${p}`);
  }
});

test('config loads with defaults and no credentials required', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.server.port, 8787);
  assert.equal(cfg.budget.bootstrapUsd, 100);
});

test('server starts and answers /api/health', async () => {
  const server = createApp(loadConfig({}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  } finally {
    server.close();
  }
});

test('design lab is served and path traversal is blocked', async () => {
  const server = createApp(loadConfig({}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    for (const p of ['/lab/', '/lab/c1/', '/lab/c2/', '/lab/c3/', '/lab/c4/', '/lab/c5/', '/lab/shared/data.js']) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 200, p);
    }
    const bad = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
    assert.equal(bad.status, 404);
  } finally {
    server.close();
  }
});
