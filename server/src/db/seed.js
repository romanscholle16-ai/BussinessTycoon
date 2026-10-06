// Seeding. seedFoundation: structural records every installation needs (idempotent, run at startup).
// seedDemo: clearly-marked DEMO records, only when explicitly invoked and never in production.
import { DEMO } from '../../../client/public/js/data/mock.js'; // same demo numbers as the Phase 1 client

export const BUSINESSES = [
  { id: 'etsy', name: 'Etsy POD Factory', kind: 'etsy_pod' },
  { id: 'assets', name: 'Game Asset Factory', kind: 'game_assets' },
  { id: 'affiliate', name: 'Affiliate Network', kind: 'affiliate' },
  { id: 'fiverr', name: 'Fiverr Creative Studio', kind: 'fiverr' },
];

export function seedFoundation(repos) {
  let created = 0;
  for (const b of BUSINESSES) if (!repos.businesses.get(b.id)) { repos.businesses.insert({ ...b, status: 'setup', data_mode: 'live' }); created++; }
  return { businessesCreated: created };
}

const cents = (n) => Math.round(n * 100);
const CAT = { ai: 'ai_cost', api: 'api_cost', fees: 'marketplace_fee', pod: 'pod_cost', ads: 'advertising', other: 'other_expense' };
const ago = (t) => { const m = /^(\d+)(m|h)$/.exec(t); const ms = m ? Number(m[1]) * (m[2] === 'h' ? 3600e3 : 60e3) : 0; return new Date(Date.now() - ms).toISOString(); };

export function seedDemo(db, repos, { env = 'development' } = {}) {
  if (env === 'production') throw new Error('Refusing to seed demo data in production');
  if (repos.systemState.get('demo_seeded_at')) return { seeded: false, reason: 'already seeded' };
  return db.transaction(() => {
    seedFoundation(repos);
    const mode = 'demo';
    for (const a of DEMO.agents) {
      repos.agents.insert({ id: `demo-${a.id}`, name: `DEMO ${a.name}`, role: a.role, business_id: a.biz === 'shared' ? null : a.biz, status: a.state === 'working' ? 'working' : a.state === 'blocked' ? 'blocked' : 'idle', level: a.lvl, xp: a.xp, health: 100, metrics: { successRate: a.succ, weeklyCostUsd: a.cost }, config: { note: 'demo' }, data_mode: mode });
      repos.tasks.insert({ id: `demo-t-${a.id}`, business_id: a.biz === 'shared' ? null : a.biz, agent_id: `demo-${a.id}`, type: 'demo.display', status: a.state === 'working' ? 'running' : a.state === 'blocked' ? 'waiting_approval' : 'queued', payload: { description: a.task }, data_mode: mode });
      repos.progression.upsert('agent', `demo-${a.id}`, mode, { xp: a.xp, level: a.lvl });
    }
    DEMO.events.forEach((e, i) => repos.events.insert({ id: `demo-e${i}`, ts: ago(e.t), type: `demo.${e.kind}`, severity: e.kind === 'warn' ? 'warn' : 'info', business_id: e.biz === 'shared' ? null : e.biz, action: e.text, result: 'demo', data_mode: mode }));
    for (const b of DEMO.biz) {
      if (b.rev > 0) repos.ledger.insert({ business_id: b.id, type: 'revenue', category: 'revenue', amount_minor: cents(b.rev), source: 'demo', reference: `demo-rev-${b.id}`, data_mode: mode, metadata: { note: 'DEMO – not real revenue' } });
      for (const [k, v] of Object.entries(b.cats)) if (v > 0) repos.ledger.insert({ business_id: b.id, type: 'expense', category: CAT[k], amount_minor: cents(v), source: 'demo', reference: `demo-${k}-${b.id}`, data_mode: mode, metadata: { note: 'DEMO – not a real cost' } });
      repos.progression.upsert('business', b.id, mode, { xp: b.level * 100, level: b.level });
    }
    repos.progression.upsert('empire', 'empire', mode, { xp: DEMO.empire.xp, level: DEMO.empire.level });
    for (const q of DEMO.quests) repos.quests.insert({ id: `demo-${q.id}`, key: q.id, title: q.title, description: q.desc, status: q.prog >= q.goal ? 'completed' : 'active', progress: q.prog, goal: q.goal, reward: { text: q.reward }, verification: { source: q.real }, data_mode: mode });
    for (const u of DEMO.upgrades) repos.upgrades.insert({ id: `demo-${u.id}`, key: u.id, name: u.name, business_id: u.biz, cost_minor: cents(u.cost), effect: { text: u.effect, payback: u.payback }, data_mode: mode });
    for (const p of DEMO.approvalsPending) repos.approvals.insert({ id: `demo-${p.id}`, request_type: p.cost ? 'spend' : 'action', business_id: 'fiverr', action: p.text, amount_minor: cents(p.cost), reason: 'DEMO request', risk: p.cost > 25 ? 'medium' : 'low', data_mode: mode });
    repos.checkpoints.save('demo', 'queue', { queued: 3, running: 8, note: 'demo' }, mode);
    repos.systemState.set('demo_seeded_at', new Date().toISOString());
    return { seeded: true };
  });
}
