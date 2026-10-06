// Isometric command-hub renderer (Phase 1 direction: Concept 9). Pure drawing; no DOM.
import { signed } from './util.js';
export const GRID = { hq: [0, 0], etsy: [-3, -3], assets: [3, -3], affiliate: [-3, 3], fiverr: [3, 3] };
const TW = 46, TH = 23, K = 1.9;
export const iso = (gx, gy) => [((gx - gy) * TW / 2) * K, ((gx + gy) * TH / 2) * K];
const hash = (x, y) => { let n = (x * 374761393 + y * 668265263) | 0; n = (n ^ (n >> 13)) * 1274126177; return ((n ^ (n >> 16)) >>> 0) / 4294967295; };
const label = (ctx, s, x, y, size, color) => { ctx.font = `bold ${size}px ui-monospace,Menlo,Consolas,monospace`; ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.fillText(s, Math.round(x), Math.round(y)); };

export function hitTest(wx, wy) {
  for (const k of Object.keys(GRID)) { const [x, y] = iso(...GRID[k]); if (Math.abs(wx - x) < 34 && wy > y - 80 && wy < y + 28) return k; }
  return null;
}
function prism(ctx, x, y, w, h, c, seed, glow, selected) {
  const dx = w * 0.9, dy = w * 0.45;
  ctx.save(); if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 16; }
  ctx.fillStyle = c + '55'; ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + dx, y - h + dy); ctx.lineTo(x, y - h + 2 * dy); ctx.lineTo(x - dx, y - h + dy); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#071a2e'; ctx.beginPath(); ctx.moveTo(x - dx, y - h + dy); ctx.lineTo(x, y - h + 2 * dy); ctx.lineTo(x, y + 2 * dy); ctx.lineTo(x - dx, y + dy); ctx.fill();
  ctx.fillStyle = '#05101e'; ctx.beginPath(); ctx.moveTo(x + dx, y - h + dy); ctx.lineTo(x, y - h + 2 * dy); ctx.lineTo(x, y + 2 * dy); ctx.lineTo(x + dx, y + dy); ctx.fill();
  ctx.strokeStyle = c; ctx.lineWidth = selected ? 2.5 : 1.2;
  ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + dx, y - h + dy); ctx.lineTo(x, y - h + 2 * dy); ctx.lineTo(x - dx, y - h + dy); ctx.closePath();
  ctx.moveTo(x - dx, y - h + dy); ctx.lineTo(x - dx, y + dy); ctx.lineTo(x, y + 2 * dy); ctx.lineTo(x + dx, y + dy); ctx.lineTo(x + dx, y - h + dy); ctx.moveTo(x, y - h + 2 * dy); ctx.lineTo(x, y + 2 * dy); ctx.stroke(); ctx.restore();
  for (let i = 1; i < h / 9; i++) if ((seed + i) % 3) { ctx.fillStyle = c + 'aa'; ctx.fillRect(x - dx + 5, y - h + dy + i * 9 + 2, 3, 3); ctx.fillRect(x + dx - 9, y - h + dy + i * 9 + 5, 3, 3); }
}
/** state: {biz, selected, layers:{flow:boolean}, levels:{[id]:number}} */
export function drawWorld(ctx, cam, t, state) {
  cam.begin(ctx); ctx.imageSmoothingEnabled = false;
  ctx.strokeStyle = '#0b2a44'; ctx.lineWidth = 1;
  for (let i = -8; i <= 8; i++) { const a = iso(i, -8), b = iso(i, 8), c = iso(-8, i), d = iso(8, i); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.moveTo(...c); ctx.lineTo(...d); ctx.stroke(); }
  for (const b of state.biz) {
    const [x, y] = iso(...GRID[b.id]), m = iso(GRID[b.id][0], 0), profit = b.profit >= 0, col = profit ? '#37ff9a' : '#ff4466';
    ctx.strokeStyle = col + '88'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(m[0], m[1] + 8); ctx.lineTo(x, y + 8); ctx.stroke();
    if (state.layers.flow) for (let i = 0; i < 3; i++) { // packets move toward HQ when profitable, away when losing
      const u = (t / 3000 + i / 3) % 1, v = profit ? 1 - u : u;
      const px = v < 0.5 ? m[0] * v * 2 : m[0] + (x - m[0]) * (v - 0.5) * 2, py = v < 0.5 ? 8 + m[1] * v * 2 : m[1] + 8 + (y - m[1]) * (v - 0.5) * 2;
      ctx.fillStyle = col; ctx.fillRect(px - 2, py - 2, 4, 4);
    }
  }
  const order = Object.keys(GRID).sort((a, b) => iso(...GRID[a])[1] - iso(...GRID[b])[1]);
  order.forEach((k, i) => {
    const [x, y] = iso(...GRID[k]), sel = state.selected === k;
    if (k === 'hq') { prism(ctx, x, y, 24, 70 + Math.sin(t / 500) * 2, '#00f0ff', i, '#00f0ff', sel); ctx.strokeStyle = '#00f0ff'; ctx.beginPath(); ctx.moveTo(x, y - 70); ctx.lineTo(x, y - 110); ctx.stroke(); label(ctx, 'SUPERVISOR', x, y + 38, 8, '#00f0ff'); return; }
    const b = state.biz.find((q) => q.id === k), extra = (state.levels[k] ?? 0) * 6, h = 20 + b.rev * 1.5 + extra, col = b.profit >= 0 ? '#37ff9a' : '#ff4466';
    prism(ctx, x, y, 22, h, b.color, i, col, sel);
    label(ctx, b.short, x, y + 38, 9, b.color); label(ctx, signed(b.profit, 1), x, y + 49, 9, col);
    if (b.status !== 'profit') label(ctx, b.status === 'loss' ? '▲ LOSS' : '◔ WATCH', x, y - h - 14 + Math.sin(t / 250) * 2, 9, b.status === 'loss' ? '#ff4466' : '#ffbe2e');
  });
  cam.end(ctx);
}
