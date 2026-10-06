# DESIGN LAB (Phase 1 design-selection gate)

**Status: AWAITING USER DECISION. No design is selected or locked.**

Five playable prototypes in `client/public/lab/` (served by `npm start` at `http://127.0.0.1:8787/lab/`; for a phone on the LAN set `TYCOON_HOST=0.0.0.0`). All use DEMO DATA (`lab/shared/data.js`), clearly labeled; nothing is real revenue. Prototype code is throwaway-quality and will be replaced once a direction is chosen.

| # | Concept | Core metaphor | Main interaction |
|---|---|---|---|
| 1 | Classic Tycoon | Bird's-eye pixel city, buildings grow with upgrades | Tap building → sheet (overview/agents/money/upgrades), buy upgrades (spend tiers shown) |
| 2 | Corporate Command Center | Dashboards, holo-map, agent network graph | KPI strip, ranked P&L table, decision queue (approve/deny), pan/zoom agent graph |
| 3 | Cyberpunk Automation City | Night city, districts, neon roads | Money-flow packets (green in / red out), drones, layer toggles, district cards |
| 4 | Minimalist Strategy | Ranked cards, one "next best action" | Tap-to-explain rows, budget allocation what-if, upgrade payback list, flat map |
| 5 | Living Autonomous Empire | Walking agents, evolving buildings | Discoveries, evolve buildings, milestone celebration, story timeline |

## Comparison
- **1 Classic** — strengths: instantly readable tycoon fantasy, buildings visibly level up, spend tiers visible. Weaknesses: finance is a tab away; map can hide detail on a phone.
- **2 Command Center** — strengths: best profit/cost/runway visibility, explicit approvals, agent graph. Weaknesses: least "game"; weakest return-to-play pull.
- **3 Cyber City** — strengths: strongest visual identity; money flow shows who earns/loses at a glance; feels alive. Weaknesses: decoration can bury numbers; heaviest rendering on phones.
- **4 Minimalist** — strengths: fastest "what's making money / what should I do next"; allocation what-if; lightest on phones. Weaknesses: lowest immersion; least world feel.
- **5 Living Empire** — strengths: highest "come back and check" appeal: discoveries, milestones, eras, agents visibly working. Weaknesses: charm can overshadow finance; needs the numbers from 4/2 alongside.

## Recommendation (not a decision)
Combination **4 + 5**, with **3's money-flow roads** as an optional map layer: a Minimalist "home" (net profit, next best action, ranked businesses with the *why*) as the default landing screen, and a Living Empire world one tap away for discoveries, agents at work, milestones and building evolution. This puts profitability and efficiency first on a phone while keeping the tycoon pull. If the user prefers map-first, 1 + 5 is the alternative.

## Design principles carried by every concept
Progress reflects real measured results only; no fake sales/profits; spend tiers ($0–5 auto, $5–25 within rules, $25+ human) are visible; items needing a human are surfaced; game score must never trade off against business performance.
