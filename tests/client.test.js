import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadConfig } from '../server/src/config/index.js';
import { createApp } from '../server/src/api/app.js';
import { evaluateSpend, DEFAULT_RULES } from '../client/public/js/rules.js';
import { DEMO } from '../client/public/js/data/mock.js';
import { GRID, iso, hitTest } from '../client/public/js/world.js';
import { bizPanel, modePanel, kpiBar } from '../client/public/js/ui.js';

test('spend rules: $0-5 auto, $5-25 rules, $25+ human, budget respected', () => {
  assert.deepEqual(evaluateSpend(4, 50).tier, 'auto');
  assert.deepEqual(evaluateSpend(5, 50).tier, 'auto');
  assert.deepEqual(evaluateSpend(5.01, 50).tier, 'rules');
  assert.equal(evaluateSpend(25, 50).allowed, true);
  const big = evaluateSpend(25.01, 1000);
  assert.equal(big.tier, 'human'); assert.equal(big.allowed, false);
  assert.equal(evaluateSpend(10, 3).allowed, false);
  assert.equal(evaluateSpend(-1, 50).allowed, false);
  assert.equal(DEFAULT_RULES.autoMaxUsd, 5);
});

test('demo data is internally consistent and labelled', () => {
  assert.equal(DEMO.banner, 'DEMO DATA');
  assert.equal(DEMO.biz.length, 4);
  for (const b of DEMO.biz) {
    assert.ok(Math.abs(b.profit - (b.rev - b.cost)) < 0.011, b.id);
    assert.ok(Math.abs(Object.values(b.cats).reduce((a, c) => a + c, 0) - b.cost) < 0.011, `${b.id} cost categories sum to cost`);
  }
  assert.ok(Math.abs(DEMO.net - (DEMO.rev - DEMO.cost)) < 0.011);
  for (const k of ['etsy', 'assets', 'affiliate', 'fiverr', 'hq']) assert.ok(GRID[k]);
});

test('world hit-testing selects the tower under a point', () => {
  for (const k of Object.keys(GRID)) { const [x, y] = iso(...GRID[k]); assert.equal(hitTest(x, y - 10), k); }
  assert.equal(hitTest(9999, 9999), null);
});

test('panels render for every business and mode without throwing', () => {
  const D = { ...DEMO, rules: { autoMaxUsd: 5, rulesMaxUsd: 25 } };
  const S = { mode: 'city', sel: null, tab: 'why', budget: D.budget.remaining, done: new Set(), inst: new Set(), levels: {} };
  assert.match(kpiBar(D, S), /NET 7D/);
  for (const id of ['hq', ...D.biz.map((b) => b.id)]) for (const tab of ['why', 'cost', 'agents', 'up']) { S.tab = tab; assert.ok(bizPanel(D, S, id).length > 50); }
  for (const m of ['biz', 'agents', 'money', 'todo', 'log']) assert.ok(modePanel(D, S, m).length > 50, m);
  assert.match(bizPanel(D, { ...S, tab: 'up' }, 'fiverr'), /REQUEST APPROVAL/); // $30 upgrade needs a human
});

test('PWA assets exist and are served', async () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'client/public/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  const server = createApp(loadConfig({}));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    for (const p of ['/', '/styles.css', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/js/main.js']) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 200, p);
    }
  } finally { server.close(); }
});
