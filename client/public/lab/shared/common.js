// Shared helpers for DESIGN LAB prototypes. DEMO DATA only.
const D = window.TYCOON_DEMO;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n, d = 2) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(d);
const signed = (n, d = 2) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(d);
const pct = n => Math.round(n * 100) + '%';
const bizById = id => D.biz.find(b => b.id === id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const hash = (x, y) => { let n = (x * 374761393 + y * 668265263) | 0; n = (n ^ (n >> 13)) * 1274126177; return ((n ^ (n >> 16)) >>> 0) / 4294967295; };

// semantic HTML snippets; each concept styles these classes differently
const agentRow = a => `<div class="agent st-${a.state}"><b class="name">${a.name}</b><span class="meta">${a.role} · L${a.lvl} · ${pct(a.succ)} ok · ${money(a.cost)}/wk</span><i class="xp"><u style="width:${a.xp}%"></u></i><span class="task">${a.state === 'blocked' ? '⚠ ' : ''}${a.task}</span></div>`;
const eventRow = e => `<div class="ev k-${e.kind}"><time>${e.t}</time><span>${e.text}</span></div>`;
const questRow = q => { const p = clamp(q.prog / q.goal, 0, 1); return `<div class="quest ${p >= 1 ? 'done' : ''}"><b>${q.title}</b><span>${q.desc}</span><i class="bar"><u style="width:${p * 100}%"></u></i><em>${p >= 1 ? '✔ done' : q.prog + '/' + q.goal} · ${q.reward} · <small>${q.real}</small></em></div>`; };
const costBars = b => { const tot = b.cost || 1; return Object.entries(b.cats).filter(([, v]) => v > 0).map(([k, v]) => `<div class="cb"><span>${k}</span><i class="bar"><u style="width:${(v / tot) * 100}%"></u></i><em>${money(v)}</em></div>`).join(''); };

// shared lab chip: switch concepts + permanent DEMO DATA label
function labChip(current) {
  const names = ['Classic Tycoon', 'Command Center', 'Cyber City', 'Minimal Strategy', 'Living Empire', 'Neon Workspace', 'Terminal Ops', 'Bento Grid', 'Iso Command HUD', 'Pipeline Flow'];
  const d = document.createElement('div');
  d.id = 'labchip';
  d.innerHTML = `<button aria-label="Design lab menu">LAB ${current}▾</button><div class="menu" hidden>${names.map((n, i) => `<a href="../c${i + 1}/index.html" ${i + 1 === current ? 'class="cur"' : ''}>${i + 1}. ${n}</a>`).join('')}<a href="../">◀ Design Lab home</a><small>DEMO DATA – not real money</small></div>`;
  document.body.appendChild(d);
  d.querySelector('button').onclick = () => { const m = d.querySelector('.menu'); m.hidden = !m.hidden; };
}

// pan / pinch / wheel camera for canvases. world coords are "art pixels".
class Camera {
  constructor(canvas, o = {}) {
    Object.assign(this, { x: 0, y: 0, z: 1, min: 0.35, max: 3.5, canvas, onTap: o.onTap || (() => {}) });
    Object.assign(this, o);
    this.ptrs = new Map(); this.moved = 0; this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.touchAction = 'none';
    const r = () => { const b = canvas.getBoundingClientRect(); this.w = b.width; this.h = b.height; canvas.width = b.width * this.dpr; canvas.height = b.height * this.dpr; };
    r(); new ResizeObserver(r).observe(canvas);
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); this.ptrs.set(e.pointerId, [e.clientX, e.clientY]); this.moved = 0; this.t0 = performance.now(); });
    canvas.addEventListener('pointermove', e => {
      const p = this.ptrs.get(e.pointerId); if (!p) return;
      if (this.ptrs.size === 1) { const dx = e.clientX - p[0], dy = e.clientY - p[1]; this.moved += Math.abs(dx) + Math.abs(dy); this.x -= dx / this.z; this.y -= dy / this.z; this.clampPos(); }
      else if (this.ptrs.size === 2) {
        const o2 = [...this.ptrs.entries()].find(([id]) => id !== e.pointerId)[1];
        const before = Math.hypot(p[0] - o2[0], p[1] - o2[1]); const after = Math.hypot(e.clientX - o2[0], e.clientY - o2[1]);
        if (before > 0) this.zoomBy(after / before); this.moved += 99;
      }
      this.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    });
    const up = e => { if (this.ptrs.has(e.pointerId)) { if (this.ptrs.size === 1 && this.moved < 8 && e.type === 'pointerup') { const b = canvas.getBoundingClientRect(); const [wx, wy] = this.toWorld(e.clientX - b.left, e.clientY - b.top); this.onTap(wx, wy, e.clientX - b.left, e.clientY - b.top); } this.ptrs.delete(e.pointerId); } };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  }
  clampPos() { const L = this.limit || 400; this.x = clamp(this.x, -L, L); this.y = clamp(this.y, -L, L); }
  zoomBy(f) { this.z = clamp(this.z * f, this.min, this.max); }
  toWorld(sx, sy) { return [(sx - this.w / 2) / this.z + this.x, (sy - this.h / 2) / this.z + this.y]; }
  begin(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.w, this.h); ctx.save(); ctx.translate(this.w / 2, this.h / 2); ctx.scale(this.z, this.z); ctx.translate(-this.x, -this.y); ctx.imageSmoothingEnabled = false; }
  end(ctx) { ctx.restore(); }
  focus(x, y, z) { this.x = x; this.y = y; if (z) this.z = z; }
  view() { const hw = this.w / 2 / this.z, hh = this.h / 2 / this.z; return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh }; }
}
const text = (ctx, s, x, y, size, color, align = 'center') => { ctx.font = `bold ${size}px ui-monospace,Menlo,Consolas,monospace`; ctx.textAlign = align; ctx.fillStyle = color; ctx.fillText(s, Math.round(x), Math.round(y)); };

// demo 7-point cumulative-profit series per business (deterministic, DEMO DATA)
const series = (b, n = 7) => { const o = []; for (let i = 0; i < n; i++) { const f = i / (n - 1); o.push(b.profit * (f * f * (3 - 2 * f)) + (hash(i, b.rev | 0) - .5) * Math.abs(b.profit) * .25 * (i && i < n - 1 ? 1 : 0)); } return o; };
function spark(cv, d, color = '#00e5ff', fill = true) {
  const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth || 100, h = cv.clientHeight || 30; cv.width = w * dpr; cv.height = h * dpr;
  const x = cv.getContext('2d'); x.scale(dpr, dpr); const mn = Math.min(...d), mx = Math.max(...d), r = mx - mn || 1;
  const pt = (v, i) => [2 + i / (d.length - 1) * (w - 4), h - 3 - (v - mn) / r * (h - 8)];
  x.beginPath(); d.forEach((v, i) => { const [a, b] = pt(v, i); i ? x.lineTo(a, b) : x.moveTo(a, b); });
  x.strokeStyle = color; x.lineWidth = 1.6; x.stroke();
  if (fill) { x.lineTo(w - 2, h); x.lineTo(2, h); x.closePath(); x.globalAlpha = .18; x.fillStyle = color; x.fill(); x.globalAlpha = 1; }
  const [ex, ey] = pt(d[d.length - 1], d.length - 1); x.beginPath(); x.arc(ex, ey, 2.5, 0, 7); x.fillStyle = color; x.fill();
}
