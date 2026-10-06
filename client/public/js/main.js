import { DEMO } from './data/mock.js';
import { $, $$ } from './util.js';
import { Camera } from './camera.js';
import { GRID, iso, hitTest, drawWorld } from './world.js';
import { kpiBar, bizPanel, modePanel } from './ui.js';
import { evaluateSpend } from './rules.js';

// Data source seam: Phase 2+ replaces this with the real API; the UI only sees a snapshot object.
const D = { ...DEMO, rules: { autoMaxUsd: 5, rulesMaxUsd: 25 } };
const S = { mode: 'city', sel: null, tab: 'why', budget: D.budget.remaining, done: new Set(), inst: new Set(), levels: {}, layers: { flow: true } };

const cv = $('#world'), ctx = cv.getContext('2d');
const fit = () => Math.max(0.5, Math.min(1.5, Math.min(cam.w / 600, (cam.h - 190) / 330)));
const cam = new Camera(cv, { min: 0.5, max: 2.8, limit: 260, onTap: (wx, wy) => {
  const k = hitTest(wx, wy);
  if (k) { S.sel = k; S.tab = 'why'; S.mode = 'city'; setDock('city'); const [x, y] = iso(...GRID[k]); const z = Math.max(cam.z, 1.2); cam.focus(x, y - 20 + (cam.h * 0.15) / z, z); } else S.sel = null;
  render();
} });

function render() {
  $('#kpi').innerHTML = kpiBar(D, S);
  const p = $('#panel'); let html = '';
  if (S.mode === 'city') html = S.sel ? bizPanel(D, S, S.sel) : '';
  else html = modePanel(D, S, S.mode);
  p.innerHTML = html; p.classList.toggle('on', !!html);
}
function setDock(m) { $$('#dock button').forEach((b) => { const on = b.dataset.m === m; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); }

document.addEventListener('click', (e) => {
  const t = e.target, d = t.dataset;
  if (d.m) { S.mode = d.m; if (d.m !== 'city') S.sel = null; setDock(d.m); render(); }
  if (d.x !== undefined) { S.sel = null; render(); }
  if (d.t) { S.tab = d.t; render(); }
  if (d.ok) { S.done.add(d.ok); render(); }
  if (d.inst) {
    const u = D.upgrades.find((q) => q.id === d.inst), r = evaluateSpend(u.cost, S.budget, D.rules);
    if (r.allowed) { S.budget -= u.cost; S.inst.add(u.id); S.levels[u.biz] = (S.levels[u.biz] ?? 0) + 1; }
    else if (r.tier === 'human') { D.approvalsPending.push({ id: 'req-' + u.id, text: `Buy ${u.name} ($${u.cost})`, cost: u.cost, tier: 'human' }); t.textContent = 'SENT TO TODO ✔'; t.disabled = true; $('#kpi').innerHTML = kpiBar(D, S); return; }
    render();
  }
  const pk = t.closest('[data-pick]'); if (pk) { S.mode = 'city'; S.sel = pk.dataset.pick; S.tab = 'why'; setDock('city'); render(); }
  if (d.layer === 'flow') { S.layers.flow = !S.layers.flow; t.classList.toggle('on', S.layers.flow); }
  if (d.zoom) cam.zoomBy(d.zoom === 'in' ? 1.3 : 1 / 1.3);
  if (d.zoom === 'fit') cam.focus(0, 20, fit());
});
function frame(t) { drawWorld(ctx, cam, t, { biz: D.biz, selected: S.sel, layers: S.layers, levels: S.levels }); requestAnimationFrame(frame); }
cam.focus(0, 20, fit()); render(); requestAnimationFrame(frame);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('/sw.js').catch(() => {});
