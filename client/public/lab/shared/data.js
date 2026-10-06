// DEMO DATA ONLY. Not real revenue, sales or customers. Used to compare UI concepts.
window.TYCOON_DEMO = (() => {
  const biz = [
    { id: 'etsy', name: 'Etsy POD Factory', short: 'POD', color: '#ff8a3d', level: 2, rev: 38.5, cost: 21.2, queue: 6, health: 96, status: 'profit',
      cats: { ai: 6.1, api: 1.2, fees: 4.9, pod: 7.5, ads: 0, other: 1.5 },
      why: 'Retro-gaming mug designs convert at 3.1%. POD cost is the biggest expense; a cheaper provider could add ~+$2/wk.',
      opp: 'Rising niche: "cozy cyberpunk" posters, low competition (score 82).', headline: '14 listings live, 9 pending QA' },
    { id: 'assets', name: 'Game Asset Factory', short: 'ASSET', color: '#38d6ff', level: 1, rev: 19.8, cost: 14.1, queue: 4, health: 91, status: 'profit',
      cats: { ai: 9.4, api: 0.8, fees: 2.4, pod: 0, ads: 0, other: 1.5 },
      why: 'Tileset packs sell steadily. Image generation is 67% of cost; batching prompts could cut it.',
      opp: 'Demand spike: 16x16 sci-fi UI icon packs (score 77).', headline: '3 packs live, 2 in production' },
    { id: 'affiliate', name: 'Affiliate Network', short: 'AFF', color: '#7dff6b', level: 1, rev: 12.9, cost: 9.3, queue: 5, health: 88, status: 'watch',
      cats: { ai: 5.0, api: 1.1, fees: 0, pod: 0, ads: 0, other: 3.2 },
      why: 'Clicks are growing (+38%) but conversions are low on 2 of 5 articles. Optimization agent is testing new CTAs.',
      opp: 'Program found: low-barrier hosting affiliate, approval likely (score 71).', headline: '5 articles live, 212 clicks' },
    { id: 'fiverr', name: 'Fiverr Creative Studio', short: 'GIG', color: '#c77dff', level: 1, rev: 0, cost: 13.8, queue: 3, health: 74, status: 'loss',
      cats: { ai: 4.4, api: 0.9, fees: 0, pod: 0, ads: 6.0, other: 2.5 },
      why: 'No orders yet: spent $6 on promotion while gig ranking is still low. Supervisor suggests pausing ads until portfolio improves.',
      opp: 'Logo-for-streamers gigs are in demand (score 69).', headline: '2 gigs live, 0 orders', attention: 'Approve pausing ad spend?' },
  ];
  biz.forEach(b => { b.profit = +(b.rev - b.cost).toFixed(2); b.roi = b.cost ? b.profit / b.cost : 0; b.margin = b.rev ? b.profit / b.rev : 0; });
  const agents = [
    { id: 'a1', name: 'Scout-01', role: 'Research', biz: 'etsy', lvl: 4, xp: 62, succ: 0.92, cost: 2.1, state: 'working', task: 'Scanning demand: "retro gaming" mugs' },
    { id: 'a2', name: 'Prism-02', role: 'Creation', biz: 'etsy', lvl: 3, xp: 40, succ: 0.88, cost: 5.9, state: 'working', task: 'Generating 4 poster concepts' },
    { id: 'a3', name: 'Guard-03', role: 'QA', biz: 'etsy', lvl: 3, xp: 71, succ: 0.95, cost: 0.6, state: 'working', task: 'IP/similarity check on 9 designs' },
    { id: 'a4', name: 'Forge-04', role: 'Creation', biz: 'assets', lvl: 2, xp: 55, succ: 0.84, cost: 8.8, state: 'working', task: 'Sci-fi tileset 32x32, batch 2' },
    { id: 'a5', name: 'Radar-05', role: 'Opportunity', biz: 'assets', lvl: 2, xp: 20, succ: 0.8, cost: 0.9, state: 'idle', task: 'Waiting for next market scan' },
    { id: 'a6', name: 'Scribe-06', role: 'Creation', biz: 'affiliate', lvl: 2, xp: 33, succ: 0.86, cost: 4.7, state: 'working', task: 'Drafting "best budget VPS" guide' },
    { id: 'a7', name: 'Lens-07', role: 'Analytics', biz: 'affiliate', lvl: 2, xp: 48, succ: 0.9, cost: 0.7, state: 'working', task: 'Tracking click-to-sale funnel' },
    { id: 'a8', name: 'Pitch-08', role: 'Strategy', biz: 'fiverr', lvl: 1, xp: 70, succ: 0.7, cost: 3.2, state: 'blocked', task: 'Needs approval: pause ad spend' },
    { id: 'a9', name: 'Pub-09', role: 'Publishing', biz: 'shared', lvl: 3, xp: 12, succ: 0.93, cost: 1.1, state: 'working', task: 'Publishing 2 listings (sandbox)' },
    { id: 'a10', name: 'Ledger-10', role: 'Financial', biz: 'shared', lvl: 3, xp: 80, succ: 0.99, cost: 0.4, state: 'working', task: 'Reconciling weekly costs' },
    { id: 'a11', name: 'Medic-11', role: 'Recovery', biz: 'shared', lvl: 2, xp: 35, succ: 0.97, cost: 0.2, state: 'idle', task: 'Recovered browser session 2h ago' },
    { id: 'a12', name: 'Aegis-12', role: 'Safety', biz: 'shared', lvl: 2, xp: 58, succ: 0.98, cost: 0.3, state: 'working', task: 'Policy scan of new listings' },
  ];
  const events = [
    { t: '2m', biz: 'etsy', kind: 'sale', text: 'Order received: retro controller mug' },
    { t: '9m', biz: 'etsy', kind: 'qa', text: 'QA rejected 1 design (too similar to existing work)' },
    { t: '21m', biz: 'affiliate', kind: 'opt', text: 'Optimizer started A/B test on call-to-action' },
    { t: '40m', biz: 'assets', kind: 'find', text: 'Opportunity discovered: sci-fi UI icon packs' },
    { t: '1h', biz: 'fiverr', kind: 'warn', text: 'Ad spend $6 produced 0 orders' },
    { t: '2h', biz: 'shared', kind: 'recover', text: 'Recovery agent restored browser session (no data lost)' },
    { t: '3h', biz: 'shared', kind: 'sup', text: 'Supervisor moved $4 budget from Fiverr ads to Etsy research' },
    { t: '5h', biz: 'assets', kind: 'sale', text: 'Tileset pack sold' },
  ];
  const quests = [
    { id: 'q1', title: 'First profitable week', desc: 'Network net profit above $0 for 7 days', prog: 1, goal: 1, reward: '+120 XP', real: 'Verified from ledger' },
    { id: 'q2', title: 'Fiverr first order', desc: 'Receive the first real customer order', prog: 0, goal: 1, reward: 'Unlock Fiverr L2', real: 'Verified from orders' },
    { id: 'q3', title: 'Cut AI cost 15%', desc: 'Lower AI spend per published item', prog: 9, goal: 15, reward: '+1 agent slot', real: 'Measured per item' },
    { id: 'q4', title: '$100 lifetime revenue', desc: 'Total real revenue across businesses', prog: 71.2, goal: 100, reward: 'Capital tier 2', real: 'Verified from ledger' },
  ];
  const upgrades = [
    { id: 'u1', biz: 'etsy', name: 'Cheaper POD routing', cost: 4, effect: '+$2/wk expected margin', payback: '2 wks' },
    { id: 'u2', biz: 'etsy', name: 'Trend radar v2', cost: 18, effect: 'Better niche picks, est. +8% conversion', payback: '5 wks' },
    { id: 'u3', biz: 'assets', name: 'Prompt batching', cost: 6, effect: '-20% image cost', payback: '3 wks' },
    { id: 'u4', biz: 'affiliate', name: 'CTA optimizer', cost: 12, effect: 'Est. +15% conversions', payback: '4 wks' },
    { id: 'u5', biz: 'fiverr', name: 'Portfolio generator', cost: 30, effect: 'Needed for gig ranking; requires approval', payback: 'unknown' },
  ];
  const sum = k => biz.reduce((a, b) => a + b[k], 0);
  return {
    banner: 'DEMO DATA', biz, agents, events, quests, upgrades,
    supervisor: { state: 'Rebalancing budget', load: 0.64, decisions: ['Pause Fiverr ads (needs you)', 'Shift $4 to Etsy research (done)', 'Queue 3 asset batches for tonight'], approvals: 2 },
    approvalsPending: [
      { id: 'p1', text: 'Pause Fiverr ad spend ($6/wk)', cost: 0, tier: 'human' },
      { id: 'p2', text: 'Buy Portfolio generator ($30)', cost: 30, tier: 'human' },
    ],
    budget: { total: 100, remaining: 41.6 }, rev: +sum('rev').toFixed(2), cost: +sum('cost').toFixed(2), net: +(sum('rev') - sum('cost')).toFixed(2),
    health: { server: 'ok', internet: 'ok', providers: '2/3 ok', browser: 'ok' },
    empire: { level: 3, xp: 340, next: 500 },
    trend: [-4, -2, 0.5, 2, 4.1, 8.3, 12.8],
  };
})();
