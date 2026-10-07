// URL validation, canonicalization and the network-target (SSRF) policy. Pure functions, no I/O.
import { isIP } from 'node:net';

export class UrlRejected extends Error { constructor(code, message) { super(message); this.name = 'UrlRejected'; this.code = code; } }

/** Policy defaults are the safest: public HTTPS only, ports 80/443. Loopback/private/http must be enabled explicitly (tests, local search infra). */
export const DEFAULT_NETWORK_POLICY = Object.freeze({ allowHttp: false, allowLoopback: false, allowPrivateNetworks: false, allowedPorts: [80, 443], maxUrlLength: 2048 });
export const normalizePolicy = (p = {}) => ({ ...DEFAULT_NETWORK_POLICY, ...p, allowedPorts: [...(p.allowedPorts ?? DEFAULT_NETWORK_POLICY.allowedPorts)] });

const v4 = (ip) => ip.split('.').map(Number);
const inV4 = (o, a, b, c, d, bits) => { const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0, base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0, mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return (n & mask) === (base & mask); };

/** Classifies an IP literal: 'public' | 'loopback' | 'private' | 'reserved' (link-local, metadata, multicast, documentation, unspecified, ...). */
export function classifyIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = v4(ip);
    if (inV4(o, 127, 0, 0, 0, 8)) return 'loopback';
    if (inV4(o, 10, 0, 0, 0, 8) || inV4(o, 172, 16, 0, 0, 12) || inV4(o, 192, 168, 0, 0, 16) || inV4(o, 100, 64, 0, 0, 10)) return 'private';
    if (inV4(o, 0, 0, 0, 0, 8) || inV4(o, 169, 254, 0, 0, 16) || inV4(o, 192, 0, 0, 0, 24) || inV4(o, 192, 0, 2, 0, 24) || inV4(o, 198, 18, 0, 0, 15) || inV4(o, 198, 51, 100, 0, 24) || inV4(o, 203, 0, 113, 0, 24) || inV4(o, 224, 0, 0, 0, 4) || inV4(o, 240, 0, 0, 0, 4)) return 'reserved';
    return 'public';
  }
  if (kind === 6) {
    const s = expandV6(ip); if (!s) return 'reserved';
    const w = s.split(':').map((x) => parseInt(x, 16));
    const embedded = (hi, lo) => classifyIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    if (w.every((x, i) => i === 7 ? x === 1 : x === 0)) return 'loopback';
    if (w.every((x) => x === 0)) return 'reserved';
    if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return embedded(w[6], w[7]); // IPv4-mapped
    if (w.slice(0, 6).every((x) => x === 0)) return embedded(w[6], w[7]); // IPv4-compatible (deprecated)
    if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return embedded(w[6], w[7]); // NAT64
    if (w[0] === 0x2002) return embedded(w[1], w[2]); // 6to4
    if ((w[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7
    if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return 'reserved'; // link-local, site-local
    if ((w[0] & 0xff00) === 0xff00) return 'reserved'; // multicast
    if (w[0] === 0x2001 && w[1] === 0x0db8) return 'reserved'; // documentation
    return 'public';
  }
  return 'reserved';
}
function expandV6(ip) {
  let s = ip.replace(/%.*$/, '');
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s); if (m) { const o = v4(m[2]); s = `${m[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`; }
  const [head, tail, extra] = s.split('::'); if (extra !== undefined) return null;
  const h = head ? head.split(':') : [], t = tail === undefined ? [] : tail ? tail.split(':') : [];
  if (tail === undefined) return h.length === 8 ? h.map((x) => x.padStart(4, '0')).join(':') : null;
  const fill = 8 - h.length - t.length; if (fill < 0) return null;
  return [...h, ...Array(fill).fill('0'), ...t].map((x) => x.padStart(4, '0')).join(':');
}

/** Returns null when the address is allowed by the policy, else a rejection code. */
export function addressRejection(ip, policy) {
  const c = classifyIp(ip);
  if (c === 'public') return null;
  if (c === 'loopback') return policy.allowLoopback ? null : 'loopback_blocked';
  if (c === 'private') return policy.allowPrivateNetworks ? null : 'private_network_blocked';
  return 'reserved_address_blocked'; // link-local / metadata / multicast / documentation are never allowed
}
const NAME_BLOCK = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|lan|intranet|corp)$/i;

/** Validates a URL string against the policy. Returns the parsed URL. Throws UrlRejected with a safe message. */
export function validateUrl(input, policy = DEFAULT_NETWORK_POLICY) {
  if (typeof input !== 'string' || !input.trim()) throw new UrlRejected('invalid_url', 'URL must be a non-empty string');
  if (input.length > policy.maxUrlLength) throw new UrlRejected('invalid_url', 'URL is too long');
  if (/[\u0000-\u001f\u007f\s]/.test(input.trim())) throw new UrlRejected('invalid_url', 'URL contains control characters or whitespace');
  let u; try { u = new URL(input.trim()); } catch { throw new UrlRejected('invalid_url', 'URL could not be parsed'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UrlRejected('unsupported_scheme', `scheme "${u.protocol.replace(':', '')}" is not supported`);
  if (u.username || u.password) throw new UrlRejected('credentials_in_url', 'URLs with embedded credentials are rejected');
  if (!u.hostname) throw new UrlRejected('invalid_url', 'URL has no host');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host) !== 0;
  if (u.protocol === 'http:') {
    const loop = literal ? classifyIp(host) === 'loopback' : /(^|\.)localhost$/i.test(host);
    if (!policy.allowHttp || !loop) throw new UrlRejected('http_not_allowed', 'plain HTTP is only allowed for explicitly enabled localhost test infrastructure');
  }
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!policy.allowedPorts.includes(port)) throw new UrlRejected('port_not_allowed', `port ${port} is not allowed`);
  if (literal) { const r = addressRejection(host, policy); if (r) throw new UrlRejected(r, 'target address is not allowed by the network policy'); }
  else if (/(^|\.)localhost$/i.test(host)) { if (!policy.allowLoopback) throw new UrlRejected('loopback_blocked', 'localhost is not allowed by the network policy'); }
  else if (NAME_BLOCK.test(host) && !policy.allowPrivateNetworks) throw new UrlRejected('private_network_blocked', 'internal host names are not allowed by the network policy');
  else if (!host.includes('.')) throw new UrlRejected('private_network_blocked', 'single-label host names are not allowed by the network policy');
  return u;
}

/** Checks DNS answers (all of them) against the policy. `addresses` = [{address}] or strings. */
export function assertResolvedAllowed(addresses, policy) {
  if (!addresses?.length) throw new UrlRejected('dns_failure', 'host name did not resolve');
  for (const a of addresses) { const ip = typeof a === 'string' ? a : a.address, r = addressRejection(ip, policy); if (r) throw new UrlRejected(r, 'host resolves to an address that is not allowed by the network policy'); }
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|msclkid|mc_[a-z]+|ref|ref_src|igshid|_hsenc|_hsmi)$/i;
/** Canonical form for dedup: lowercase host, no fragment, no default port, no tracking params, sorted query, no trailing slash (except root). */
export function canonicalizeUrl(input) {
  const u = new URL(input); u.hash = ''; u.hostname = u.hostname.replace(/^www\./, ''); u.username = ''; u.password = '';
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  u.search = ''; for (const [k, v] of params) u.searchParams.append(k, v);
  let s = u.toString(); if (u.pathname !== '/' && u.pathname.endsWith('/') && !u.search) s = s.replace(/\/$/, ''); else if (u.pathname !== '/' && u.pathname.endsWith('/')) s = s.replace(/\/\?/, '?');
  return s;
}
export const domainOf = (url) => new URL(url).hostname.replace(/^www\./, '').toLowerCase();
/** URL safe for events/logs: origin + path only (no query string, fragment or credentials). */
export const loggableUrl = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 200); } catch { return '[invalid url]'; } };
