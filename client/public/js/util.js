export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const money = (n, d = 2) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(d);
export const signed = (n, d = 2) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(d);
export const pct = (n) => Math.round(n * 100) + '%';
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
