// Deterministic provider selection. PURE: same inputs -> same ordered candidates. No learning, no randomness.
//   1. Explicit request.provider (alone, unless request.allowFallback adds the configured order after it).
//   2. Otherwise the configured order: activeProvider, then fallbackProviders (only providers listed there are ever used implicitly).
//   3. Ineligible providers are removed with a recorded reason: disabled, misconfigured, unavailable, rate_limited, temporarily_failed,
//      missing capability (e.g. JSON output), or a model the provider does not offer.
//   4. selection="cost" (or request.prefer="cost") re-sorts the eligible set by worst-case estimated cost (unknown cost last),
//      then lower observed failure rate, then lower average latency, then configured order.
export function selectProviders({ request, config, registry, now, costOf = () => null }) {
  const order = [config.activeProvider, ...config.fallbackProviders].filter((n) => n && n !== 'none');
  let wanted = request.provider ? [request.provider, ...(request.allowFallback ? order.filter((n) => n !== request.provider) : [])] : order;
  const rejected = [], ok = [];
  for (const name of wanted) {
    if (!registry.providers[name]) { rejected.push({ provider: name, reason: 'unknown provider' }); continue; }
    const v = registry.view(name, now);
    if (v.status !== 'configured' && v.status !== 'available') { rejected.push({ provider: name, status: v.status, reason: v.reason ?? v.status }); continue; }
    if (request.jsonSchema && !v.capabilities.json) { rejected.push({ provider: name, status: v.status, reason: 'does not support structured output' }); continue; }
    if (request.model && !(request.provider === name || v.models.includes(request.model))) { rejected.push({ provider: name, status: v.status, reason: `model ${request.model} is not offered by this provider` }); continue; }
    ok.push({ name, v, idx: ok.length });
  }
  if ((config.selection === 'cost' || request.prefer === 'cost') && !request.provider) {
    const rate = (v) => (v.stats.requests >= 4 ? v.stats.failed / v.stats.requests : 0);
    ok.sort((a, b) => { const ca = costOf(a.name), cb = costOf(b.name); return (ca === null) - (cb === null) || (ca ?? 0) - (cb ?? 0) || rate(a.v) - rate(b.v) || (a.v.stats.avgLatencyMs ?? Infinity) - (b.v.stats.avgLatencyMs ?? Infinity) || a.idx - b.idx; });
  }
  return { candidates: ok.map((x) => x.name), rejected };
}
