// HTML -> plain text without executing anything: scripts/styles/comments/templates are removed, entities decoded, size bounded.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isInteger(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : ' '; }
  return ENT[e.toLowerCase()] ?? m;
});
const attr = (tag, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag); return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null; };
const clean = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/[ \t\f\r ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** @returns {{title, text, canonicalHref, author, publishedAt, language, truncated}} — metadata is null unless really present. */
export function extractHtml(html, { maxChars = 20000 } = {}) {
  const src = String(html).slice(0, 2_000_000);
  const head = (/<head[\s>][\s\S]*?<\/head>/i.exec(src) ?? [''])[0];
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (names) => { for (const t of metas) { const n = (attr(t, 'name') ?? attr(t, 'property') ?? attr(t, 'itemprop') ?? '').toLowerCase(); if (names.includes(n)) { const c = attr(t, 'content'); if (c) return clean(c).slice(0, 200); } } return null; };
  const titleRaw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  const title = titleRaw ? clean(decode(titleRaw[1].replace(/<[^>]*>/g, ' '))).slice(0, 300) || null : (meta(['og:title']) ?? null);
  const linkCanon = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => (attr(t, 'rel') ?? '').toLowerCase() === 'canonical');
  const publishedRaw = meta(['article:published_time', 'datepublished', 'date', 'dc.date', 'og:published_time', 'pubdate']);
  const publishedAt = publishedRaw && !Number.isNaN(Date.parse(publishedRaw)) ? new Date(Date.parse(publishedRaw)).toISOString() : null;
  const langAttr = /<html\b[^>]*>/i.exec(src); const language = (langAttr && attr(langAttr[0], 'lang'))?.toLowerCase().slice(0, 12) || null;
  let body = src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|iframe|object|embed|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[\s\S]*$/i, ' '); // unterminated blocks are dropped too
  body = body.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' ');
  const text = clean(decode(body)); const truncated = text.length > maxChars;
  return { title, text: truncated ? text.slice(0, maxChars) : text, canonicalHref: linkCanon ? attr(linkCanon, 'href') : null, author: meta(['author', 'article:author', 'dc.creator']), publishedAt, language, truncated };
}
export const plainText = (s, { maxChars = 20000 } = {}) => { const t = clean(String(s).slice(0, 2_000_000)); return { title: null, text: t.slice(0, maxChars), canonicalHref: null, author: null, publishedAt: null, language: null, truncated: t.length > maxChars }; };

/** Very small language hint: only returns a value when the page declares one; never guesses from content. */
export const countWords = (t) => (t ? t.split(/\s+/).filter(Boolean).length : 0);
