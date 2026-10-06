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
  if (id === 'hq') return `<button class="x" data-x aria-label="Close">✕</button><h2 style="color:var(--c)">SUPERVISOR</h2><div class="row3"><div>STATE<b style="font-size:10px">${esc(D.supervisor.state)}</b></div><div>LOAD<b>${pct(D.supervisor.load)}</b></div><div>EMPIRE LV<b>${D.empire.level}</b></div></div>${D.supervisor.decisions.map((d) => `<div class="note o">${esc(d)}</div>`).join('')}<h2>SYSTEM HEALTH</h2><div class="note">${Object.entries(D.health).map(([k, v]) => esc(k) + ': ' + esc(v)).join(' · ')}</div>`;
  const b = bizById(D, id), t = S.tab;
  const body = t === 'why' ? `<div class="note">WHY: ${esc(b.why)}</div><div class="note o">FOUND: ${esc(b.opp)}</div>${b.attention ? `<div class="note no-b">NEEDS YOU: ${esc(b.attention)}</div>` : ''}<div class="note">${esc(b.headline)} · queue ${b.queue} · health ${b.health}%</div>`
    : t === 'cost' ? costBars(b) : t === 'agents' ? D.agents.filter((a) => a.biz === id).map(agentRow).join('') || '<div class="note">Uses shared agents.</div>'
    : D.upgrades.filter((u) => u.biz === id).map((u) => upgradeCard(D, S, u)).join('');
  return `<button class="x" data-x aria-label="Close">✕</button><h2 style="color:${b.color}">${esc(b.name)} · Lv ${b.level + (S.levels[id] ?? 0)}</h2><div class="row3"><div>REVENUE<b>${money(b.rev)}</b></div><div>COST<b>${money(b.cost)}</b></div><div>PROFIT<b class="${cls(b.profit)}">${signed(b.profit)}</b></div></div><div class="tabs">${[['why', 'WHY'], ['cost', 'COSTS'], ['agents', 'AGENTS'], ['up', 'UPGRADE']].map(([k, n]) => `<button data-t="${k}" class="${t === k ? 'on' : ''}">${n}</button>`).join('')}</div>${body}`;
}

export function modePanel(D, S, mode) {
  if (mode === 'biz') return `<h2>BUSINESSES BY ROI</h2>${[...D.biz].sort((a, b) => b.roi - a.roi).map((b) => `<div class="note ${b.profit >= 0 ? 'o' : ''}" data-pick="${b.id}"><b style="color:${b.color}">${esc(b.name)}</b> ${signed(b.profit)} · ROI ${pct(b.roi)}<br>${esc(b.headline)}</div>`).join('')}<h2>OPPORTUNITIES</h2>${D.biz.map((b) => `<div class="note o"><b style="color:${b.color}">${esc(b.short)}</b> ${esc(b.opp)}</div>`).join('')}`;
  if (mode === 'agents') return `<h2>SUPERVISOR</h2><div class="note o"><b>${esc(D.supervisor.state)}</b> · load ${pct(D.supervisor.load)}</div><h2>AGENTS · ${D.agents.length}</h2>${D.agents.map(agentRow).join('')}`;
  if (mode === 'money') return `<h2>FINANCE · 7 DAYS</h2><div class="row3"><div>REVENUE<b>${money(D.rev)}</b></div><div>COST<b>${money(D.cost)}</b></div><div>NET<b class="${cls(D.net)}">${signed(D.net)}</b></div></div>${D.biz.map((b) => `<div class="note ${b.profit >= 0 ? 'o' : ''}"><b style="color:${b.color}">${esc(b.name)}</b> <span class="${cls(b.profit)}">${signed(b.profit)}</span>${costBars(b)}</div>`).join('')}<h2>UPGRADES</h2>${D.upgrades.map((u) => upgradeCard(D, S, u)).join('')}`;
  if (mode === 'todo') return `<h2>NEEDS YOU</h2>${D.approvalsPending.filter((q) => !S.done.has(q.id)).map((q) => `<div class="note">${esc(q.text)}<br><small>${q.cost > D.rules.rulesMaxUsd ? 'over $' + D.rules.rulesMaxUsd + ': human approval' : 'confirm'}</small><br><button class="go" data-ok="${q.id}">APPROVE</button> <button class="go ghost" data-ok="${q.id}">DENY</button></div>`).join('') || '<div class="note o">ALL CLEAR</div>'}<h2>QUESTS</h2>${D.quests.map(questRow).join('')}`;
  if (mode === 'log') return `<h2>EVENT TIMELINE</h2>${D.events.map(eventRow).join('')}`;
  return '';
}
