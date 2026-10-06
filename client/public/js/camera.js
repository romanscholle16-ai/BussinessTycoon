import { clamp } from './util.js';
/** Pan (drag), pinch zoom, wheel zoom, tap detection for a canvas. World units are art pixels. */
export class Camera {
  constructor(canvas, o = {}) {
    Object.assign(this, { x: 0, y: 0, z: 1, min: 0.5, max: 3, limit: 300, canvas, onTap: () => {} }, o);
    this.ptrs = new Map(); this.moved = 0; this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.touchAction = 'none';
    const resize = () => { const b = canvas.getBoundingClientRect(); this.w = b.width; this.h = b.height; canvas.width = b.width * this.dpr; canvas.height = b.height * this.dpr; };
    resize(); new ResizeObserver(resize).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); this.ptrs.set(e.pointerId, [e.clientX, e.clientY]); this.moved = 0; });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.ptrs.get(e.pointerId); if (!p) return;
      if (this.ptrs.size === 1) { const dx = e.clientX - p[0], dy = e.clientY - p[1]; this.moved += Math.abs(dx) + Math.abs(dy); this.x = clamp(this.x - dx / this.z, -this.limit, this.limit); this.y = clamp(this.y - dy / this.z, -this.limit, this.limit); }
      else if (this.ptrs.size === 2) { const other = [...this.ptrs.entries()].find(([id]) => id !== e.pointerId)[1]; const before = Math.hypot(p[0] - other[0], p[1] - other[1]); const after = Math.hypot(e.clientX - other[0], e.clientY - other[1]); if (before > 0) this.zoomBy(after / before); this.moved += 99; }
      this.ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    });
    const up = (e) => { if (!this.ptrs.has(e.pointerId)) return; if (this.ptrs.size === 1 && this.moved < 8 && e.type === 'pointerup') { const b = canvas.getBoundingClientRect(); const [wx, wy] = this.toWorld(e.clientX - b.left, e.clientY - b.top); this.onTap(wx, wy); } this.ptrs.delete(e.pointerId); };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  }
  zoomBy(f) { this.z = clamp(this.z * f, this.min, this.max); }
  toWorld(sx, sy) { return [(sx - this.w / 2) / this.z + this.x, (sy - this.h / 2) / this.z + this.y]; }
  begin(ctx) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, this.w, this.h); ctx.save(); ctx.translate(this.w / 2, this.h / 2); ctx.scale(this.z, this.z); ctx.translate(-this.x, -this.y); }
  end(ctx) { ctx.restore(); }
  focus(x, y, z) { this.x = x; this.y = y; if (z) this.z = clamp(z, this.min, this.max); }
}
