// Panel renderers: return HTML strings from a snapshot + UI state. All dynamic text is escaped.
import { money, signed, pct, esc, clamp } from './util.js';
import { evaluateSpend } from './rules.js';

export const bizById = (D, id) => D.biz.find((b) => b.id === id);
const cls = (n) => (n >= 0 ? 'ok' : 'no');
export const agentRow = (a) => `<div class="agent st-${a.state}"><b class="name">${esc(a.name)}</b><span class="meta">${esc(a.role)} · L${a.lvl} · ${pct(a.succ)} ok · ${money(a.cost)}/wk</span><i class="xp"><u style="width:${a.xp}%"></u></i><span class="task">${a.state === 'blocked' ? '⚠ ' : ''}${esc(a.task)}</span></div>`;
export const eventRow = (e) => `<div class="ev k-${e.kind}"><time>${esc(e.t)}</time><span>${esc(e.text)}</span></div>`;
export const questRow = (q) => { const p = clamp(q.prog / q.goal, 0, 1); return `<div class="quest ${p >= 1 ? 'done' : ''}"><b>${esc(q.title)}</b><span>${esc(q.desc)}</span><i class="bar"><u style="width:${p * 100}%"></u></i><em>${p >= 1 ? '✔ done' : q.prog + '/' + q.goal} · ${esc(q.reward)} · ${esc(q.real)}</em></div>`; };
export const costBars = (b) => Object.entries(b.cats).filter(([, v]) => v > 0).map(([k, v]) => `<div class="cb"><span>${esc(k)}</span><i class="bar"><u style="width:${(v / (b.cost || 1)) * 100}%"></u></i><em>${money(v)}</em></div>`).join('');

export function kpiBar(D, S) {
  const todo = D.approvalsPending.filter((p) => !S.done.has(p.id)).length;
  return `<div><small>NET 7D</small><b class="${cls(D.net)}">${signed(D.net)}</b></div><div><small>REV</small><b>${money(D.rev, 0)}</b></div><div><small>COST</small><b>${money(D.cost, 0)}</b></div><div><small>BUDGET</small><b>${money(S.budget, 0)}</b></div><div><small>ACTION</small><b class="${todo ? 'no' : 'ok'}">${todo}</b></div>`;
}

function upgradeCard(D, S, u) {
  const r = evaluateSpend(u.cost, S.budget, D.rules), have = S.inst.has(u.id);
  const label = have ? 'INSTALLED' : r.tier === 'human' ? 'REQUEST APPROVAL' : 'INSTALL';
  return `<div class="note o"><b>${esc(u.name)} · ${money(u.cost, 0)}</b><br>${esc(u.effect)} · payback ${esc(u.payback)}<br><small>${esc(r.reason)}</small><br><button class="go" data-inst="${u.id}" ${have || (!r.allowed && r.tier !== 'human') ? 'disabled' : ''}>${label}</button></div>`;
}

export function bizPanel(D, S, id) {
  if (id === 'hq') return `<button class="x" data-x aria-label="Close">✕</button>${healthBlock(S.live?.health)}${supervisorLive(S.live)}${aiBlock(S.live?.ai)}<h2 style="color:var(--c)">SUPERVISOR (MOCK DATA)</h2><div class="row3"><div>STATE<b style="font-size:10px">${esc(D.supervisor.state)}</b></div><div>LOAD<b>${pct(D.supervisor.load)}</b></div><div>EMPIRE LV<b>${D.empire.level}</b></div></div>${D.supervisor.decisions.map((d) => `<div class="note o">${esc(d)}</div>`).join('')}<h2>SYSTEM HEALTH (MOCK DATA)</h2><div class="note">${Object.entries(D.health).map(([k, v]) => esc(k) + ': ' + esc(v)).join(' · ')}</div>`;
  const b = bizById(D, id), t = S.tab;
  const body = t === 'why' ? `<div class="note">WHY: ${esc(b.why)}</div><div class="note o">FOUND: ${esc(b.opp)}</div>${b.attention ? `<div class="note no-b">NEEDS YOU: ${esc(b.attention)}</div>` : ''}<div class="note">${esc(b.headline)} · queue ${b.queue} · health ${b.health}%</div>`
    : t === 'cost' ? costBars(b) : t === 'agents' ? D.agents.filter((a) => a.biz === id).map(agentRow).join('') || '<div class="note">Uses shared agents.</div>'
    : D.upgrades.filter((u) => u.biz === id).map((u) => upgradeCard(D, S, u)).join('');
  return `<button class="x" data-x aria-label="Close">✕</button><h2 style="color:${b.color}">${esc(b.name)} · Lv ${b.level + (S.levels[id] ?? 0)}</h2><div class="row3"><div>REVENUE<b>${money(b.rev)}</b></div><div>COST<b>${money(b.cost)}</b></div><div>PROFIT<b class="${cls(b.profit)}">${signed(b.profit)}</b></div></div><div class="tabs">${[['why', 'WHY'], ['cost', 'COSTS'], ['agents', 'AGENTS'], ['up', 'UPGRADE']].map(([k, n]) => `<button data-t="${k}" class="${t === k ? 'on' : ''}">${n}</button>`).join('')}</div>${body}`;
}

export function modePanel(D, S, mode) {
  if (mode === 'biz') return `<h2>BUSINESSES BY ROI</h2>${[...D.biz].sort((a, b) => b.roi - a.roi).map((b) => `<div class="note ${b.profit >= 0 ? 'o' : ''}" data-pick="${b.id}"><b style="color:${b.color}">${esc(b.name)}</b> ${signed(b.profit)} · ROI ${pct(b.roi)}<br>${esc(b.headline)}</div>`).join('')}<h2>OPPORTUNITIES</h2>${D.biz.map((b) => `<div class="note o"><b style="color:${b.color}">${esc(b.short)}</b> ${esc(b.opp)}</div>`).join('')}`;
  if (mode === 'agents') return `${S.live?.status ? '' : '<div class="note">Supervisor: no live connection (mock)</div>'}<h2>AGENTS${S.live?.agents ? ' · LIVE · ' + S.live.agents.length : ' · MOCK'}</h2>${agentsLive(D, S)}`;
  if (mode === 'money') return `<h2>FINANCE · 7 DAYS</h2><div class="row3"><div>REVENUE<b>${money(D.rev)}</b></div><div>COST<b>${money(D.cost)}</b></div><div>NET<b class="${cls(D.net)}">${signed(D.net)}</b></div></div>${D.biz.map((b) => `<div class="note ${b.profit >= 0 ? 'o' : ''}"><b style="color:${b.color}">${esc(b.name)}</b> <span class="${cls(b.profit)}">${signed(b.profit)}</span>${costBars(b)}</div>`).join('')}<h2>UPGRADES</h2>${D.upgrades.map((u) => upgradeCard(D, S, u)).join('')}`;
  if (mode === 'todo') return `<h2>NEEDS YOU</h2>${D.approvalsPending.filter((q) => !S.done.has(q.id)).map((q) => `<div class="note">${esc(q.text)}<br><small>${q.cost > D.rules.rulesMaxUsd ? 'over $' + D.rules.rulesMaxUsd + ': human approval' : 'confirm'}</small><br><button class="go" data-ok="${q.id}">APPROVE</button> <button class="go ghost" data-ok="${q.id}">DENY</button></div>`).join('') || '<div class="note o">ALL CLEAR</div>'}<h2>QUESTS</h2>${D.quests.map(questRow).join('')}`;
  if (mode === 'log') return timelinePanel(D, S);
  if (mode === 'research') return researchPanel(S.live?.research?.runs ?? null, S.live?.research ? { providers: S.live.research.providers } : null);
  return '';
}

const STEP_KINDS = new Set(['task.pending', 'task.queued', 'task.assigned', 'task.running', 'agent.created', 'agent.ready', 'agent.running']);
const SEV_LABEL = { debug: 'DBG', info: 'INFO', warning: 'WARN', error: 'ERR', critical: 'CRIT' };
const STATUS_CLASS = { healthy: 'ok', degraded: 'warn', critical: 'no', unknown: 'unk' };
const hhmmss = (iso) => (iso ? esc(iso.slice(11, 19)) : '--:--:--');
const ago = (iso, now = Date.now()) => { if (!iso) return 'never'; const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
export const healthLabel = (h) => (h ? h.status.toUpperCase() : 'NO LIVE DATA');

/** Small status pill under the KPI bar. */
export function healthPill(live) {
  const st = live?.health?.status ?? 'unknown';
  return `<button class="pill ${STATUS_CLASS[st]}" data-open="hq" aria-label="System health: ${esc(healthLabel(live?.health))}">SYSTEM ● ${esc(healthLabel(live?.health))}</button>`;
}
/** Real system health: overall status, component cards, issues, attention items. */
export function healthBlock(h) {
  if (!h) return '<div class="note">SYSTEM HEALTH: no live connection (the server API is unreachable).</div>';
  const cards = Object.entries(h.components).map(([k, c]) => `<div class="hc ${STATUS_CLASS[c.status]}"><b>${esc(k)}</b><span>${esc(c.status)}</span><small>${esc(c.reasons[0] ?? (c.status === 'unknown' ? 'not available' : 'ok'))}</small></div>`).join('');
  const att = (h.attention ?? []).map((a) => `<div class="note ${a.severity === 'error' ? 'no-b' : ''}">${esc(a.message)}</div>`).join('');
  return `<div class="note ${h.status === 'healthy' ? 'o' : h.status === 'critical' ? 'no-b' : ''}"><b>SYSTEM HEALTH · ${esc(h.status.toUpperCase())}</b><br>${esc(h.summary)}<br><small>${h.issues} issue(s) · checked ${esc(ago(h.checkedAt))}</small></div><div class="hgrid">${cards}</div>${att}`;
}
/** Live Supervisor block: state, queue, recovery counts, and recent decisions. */
export function supervisorLive(live) {
  if (!live?.status) return '<div class="note">SUPERVISOR: no live connection — showing mock data below.</div>';
  const sv = live.status, q = sv.lastCycle?.queue ?? {}, st = sv.state;
  return `<div class="note ${st === 'running' ? 'o' : 'no-b'}"><b>LIVE SUPERVISOR · ${esc(st.toUpperCase())}</b><br>cycle ${sv.cycle} · in flight ${sv.inFlight} · dispatched ${sv.counters.dispatched} · recoveries ${sv.counters.recoveries}<br>queue: ${q.queued ?? 0} queued · ${q.running ?? 0} running · ${q.retrying ?? 0} retrying · ${q.blocked ?? 0} blocked<br>last cycle ${esc(ago(sv.lastOkCycleAt))}${sv.activeLimits.length ? `<br>⚠ limit reached: ${sv.activeLimits.map(esc).join(', ')}` : ''}</div>
  <h2>RECENT DECISIONS</h2>${(live.decisions ?? []).slice(0, 5).map((d) => `<div class="ev sev-${esc(d.severity === 'warn' ? 'warning' : d.severity)}"><time>${hhmmss(d.ts)}</time><span>${esc(d.kind)} · ${esc(d.result)}</span></div>`).join('') || '<div class="note">no decisions yet</div>'}`;
}
/** Event timeline: real events with severity/component filters. Falls back to clearly labelled mock events when offline. */
export function timelinePanel(D, S) {
  const f = S.logFilter ?? { sev: 'info', comp: '' }, live = S.live?.events;
  const chip = (attr, val, label, on) => `<button class="chipb ${on ? 'on' : ''}" ${attr}="${val}">${label}</button>`;
  const filters = `<div class="chips">${[['info', 'ALL'], ['warning', 'WARN+'], ['error', 'ERRORS']].map(([v, l]) => chip('data-lf-sev', v, l, f.sev === v)).join('')}</div><div class="chips">${[['', 'ANY'], ['task', 'TASKS'], ['agent', 'AGENTS'], ['supervisor', 'SUPERVISOR']].map(([v, l]) => chip('data-lf-comp', v, l, f.comp === v)).join('')}${chip('data-lf-steps', f.steps ? '0' : '1', f.steps ? 'HIDE STEPS' : 'SHOW STEPS', false)}</div>`;
  if (!live) return `<h2>EVENT TIMELINE</h2><div class="note">No live connection — showing MOCK events.</div>${D.events.map(eventRow).join('')}`;
  const shown = f.steps ? live.events : live.events.filter((e) => !STEP_KINDS.has(e.kind) || e.severity !== 'info');
  const rows = shown.map((e) => `<div class="ev sev-${e.severity}"><time>${hhmmss(e.ts)}</time><span><b class="sevb">${SEV_LABEL[e.severity]}</b> ${e.kind.startsWith('supervisor.') ? `<b>${esc(e.name)}</b> · ` : ''}${esc(e.message)}<small>${esc(e.component)}${e.agentId ? ' · ' + esc(e.agentId) : ''}${e.taskId ? ' · task ' + esc(e.taskId.slice(0, 8)) : ''}${e.error?.code ? ' · ' + esc(e.error.code) : ''}${e.retry && e.retry.count ? ` · retry ${e.retry.count}/${e.retry.max}` : ''}${e.dataMode !== 'live' ? ' · ' + esc(e.dataMode.toUpperCase()) : ''}</small></span></div>`).join('');
  return `<h2>EVENT TIMELINE · LIVE</h2>${filters}${rows || '<div class="note">Nothing to show. Quiet is normal: idle Supervisor cycles are not logged, and routine task steps are hidden (SHOW STEPS).</div>'}`;
}
/** Real agent roster (status, health, current task, success rate, heartbeat age). */
export function agentsLive(D, S) {
  const live = S.live?.agents;
  if (!live) return `<div class="note">No live connection — showing MOCK agents.</div>${D.agents.map(agentRow).join('')}`;
  if (!live.length) return '<div class="note">No agents are registered yet.</div>';
  return live.map((a) => `<div class="agent st-${esc(a.status)}"><b class="name">${esc(a.name)}</b> <span class="hbadge ${STATUS_CLASS[a.healthStatus === 'stalled' || a.healthStatus === 'failed' ? (a.healthStatus === 'failed' ? 'critical' : 'degraded') : a.healthStatus === 'degraded' ? 'degraded' : a.healthStatus === 'healthy' ? 'healthy' : 'unknown']}">${esc(a.healthStatus)}</span><span class="meta">${esc(a.role)} · ${esc(a.status)} · L${a.level} · ${a.metrics.successRate == null ? 'no results yet' : Math.round(a.metrics.successRate * 100) + '% ok'} · beat ${esc(ago(a.lastHeartbeatAt))}</span><span class="task">${a.currentTaskId ? 'working: ' + esc(a.currentTaskId.slice(0, 8)) : 'idle'}${a.dataMode !== 'live' ? ' · ' + esc(a.dataMode.toUpperCase()) : ''}</span></div>`).join('');
}

/** AI provider status (operational only: no AI activity is shown unless it really happened). */
export function aiBlock(ai) {
  if (!ai) return '<div class="note">AI: status unavailable (no live connection).</div>';
  if (!ai.enabled) return `<div class="note"><b>AI · DISABLED</b><br>No provider is active (AI_ACTIVE_PROVIDER=none). Nothing is sent to any AI service.${ai.problems?.length ? '<br>⚠ ' + esc(ai.problems[0]) : ''}</div>`;
  const rows = ai.providers.filter((p) => p.role !== 'unused').map((p) => `<div class="ev ${['misconfigured', 'unavailable', 'temporarily_failed', 'rate_limited'].includes(p.status) ? 'sev-warning' : ''}"><time>${esc(p.role)}</time><span><b>${esc(p.name)}</b> · ${esc(p.status.replace('_', ' '))}${p.model ? ' · ' + esc(p.model) : ''}<small>${p.reason ? esc(p.reason) + ' · ' : ''}${p.pricing.known ? 'price known' : 'price unknown'}${p.lastError ? ' · last error ' + esc(p.lastError.category) : ''}${p.rateLimitedUntil ? ' · limited until ' + esc(p.rateLimitedUntil.slice(11, 19)) : ''}</small></span></div>`).join('');
  return `<div class="note o"><b>AI · ENABLED</b><br>active: ${esc(ai.activeProvider)} · fallback: ${ai.fallbackProviders.length ? ai.fallbackProviders.map(esc).join(', ') : 'none'} · selection: ${esc(ai.selection)}</div>${rows}`;
}

/** Research area: real persisted runs only. With no runs it says so (and why nothing will happen) instead of showing sample data. */
export function researchPanel(runs, status) {
  if (!runs) return '<h2>RESEARCH</h2><div class="note">Research: no live connection to the server.</div>';
  const prov = status?.providers, none = prov && !prov.discoveryProviders.length;
  const provLine = prov ? `<div class="note ${none ? '' : 'o'}"><b>Providers</b> · discovery: ${prov.discoveryProviders.length ? prov.discoveryProviders.map((p) => esc(p.id) + (p.kind === 'mock' ? ' (TEST)' : '')).join(', ') : 'none configured'} · retrieval: ${prov.retrievalProviders?.length ? prov.retrievalProviders.map((p) => esc(p.id)).join(', ') : 'none'}${none ? '<br>No search provider is configured, so new runs will end as failed (provider_unavailable). Nothing is fabricated.' : ''}${prov.problems?.length ? '<br>⚠ ' + esc(prov.problems[0]) : ''}</div>` : '';
  if (!runs.runs.length) return `<h2>RESEARCH · LIVE</h2>${provLine}<div class="note">No research runs yet. Runs appear here when created through the API (POST /api/research/runs) or by agents; this list shows persisted runs only.</div>`;
  const rows = runs.runs.map((r) => { const c = r.counts, active = r.stage !== 'done', cls = r.status === 'completed' ? 'o' : ['failed', 'conflicted', 'insufficient'].includes(r.status) ? 'w' : '';
    return `<div class="rs-run ${cls}"><b>${esc(r.title)}</b> <span class="hbadge ${r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'no' : 'unk'}">${esc(r.status)}</span>${r.dataMode !== 'live' ? ` <span class="hbadge unk">${esc(r.dataMode.toUpperCase())}</span>` : ''}<span class="meta">${esc(r.question ?? '')}</span><i class="bar"><u style="width:${Math.round(r.progress * 100)}%"></u></i><span class="meta">${active ? 'stage: ' + esc(r.stage) + ' · ' : ''}${c.sourcesDiscovered} found · ${c.sourcesRetrieved} retrieved${c.sourcesFailed ? ' · ' + c.sourcesFailed + ' failed' : ''}${c.duplicates ? ' · ' + c.duplicates + ' duplicate' : ''}</span><span class="meta">${c.evidence} evidence (${c.directEvidence} direct) · ${c.findings} finding${c.findings === 1 ? '' : 's'} · ${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'} · confidence ${esc(r.confidence ?? 'n/a')}</span>${r.stopReason ? `<span class="meta">stopped: ${esc(r.stopReason)}</span>` : ''}${r.error ? `<span class="meta">⚠ ${esc(r.error.code)}</span>` : ''}<span class="meta">${r.providers?.discovery ? 'discovery attempts ' + r.providers.discovery.attempts + (Object.keys(r.providers.discovery.failures ?? {}).length ? ' · failures ' + esc(JSON.stringify(r.providers.discovery.failures)) : '') : 'no discovery attempts'} · AI ${r.providers?.ai?.calls ? r.providers.ai.calls + ' call(s) via ' + esc(r.providers.ai.provider ?? '?') + (r.providers.ai.costUsd != null ? ' · $' + r.providers.ai.costUsd : ' · cost unknown') : 'not used'}</span></div>`; }).join('');
  return `<h2>RESEARCH · LIVE · ${runs.total}</h2>${provLine}${rows}`;
}
