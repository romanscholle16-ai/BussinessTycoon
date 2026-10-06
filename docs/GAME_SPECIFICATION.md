# GAME SPECIFICATION (implemented from Phase 1)
- 32-bit pixel-art, futuristic theme, bird's-eye 2D, no player character.
- Zoom, pan, touch-friendly; responsive for Android phone browsers; PWA.
- Central headquarters hub + four business buildings (Etsy/POD, Game Assets, Affiliate, Fiverr); upgradeable.
- Game reflects REAL system state (progress, tasks, finances) — never fake-only.
- Systems: XP, agent levels, reputation, leaderboards, quests, missions, unlockable upgrades.
- Views: real financial stats, event timeline, system health, detailed progress/status per building/agent.
- Client talks to server via HTTP + live event stream. Phase 1 uses mock data only.
- Tech: Canvas 2D, vanilla JS, no heavy engine unless justified in DECISIONS.md.

## SELECTED DESIGN (chosen by the user): "Iso Command Hub" (Design Lab concept 9)
Chosen from ten Design Lab prototypes; no modifications requested. Implemented in `client/public/` (served at `/`).
- **World**: pannable/pinch-zoomable isometric neon city on Canvas 2D. Supervisor tower at center (HQ); four business towers at the corners. Tower height = revenue (+ upgrade levels); glow green = profit, red = loss; ▲ LOSS / ◔ WATCH flags float above struggling businesses. Money-flow packets travel toward HQ for profitable businesses and away for losing ones (toggle with the `$` button).
- **HUD**: top KPI strip (net 7d, revenue, cost, budget, actions needing the user); permanent DEMO DATA label while mock data is used; zoom/recenter/flow controls.
- **Panels**: tap a tower for the inspector (WHY / COSTS / AGENTS / UPGRADE); tapping HQ shows the Supervisor and system health. Bottom dock: CITY, BIZ (ranked by ROI + opportunities), AGENTS (Supervisor + roster), MONEY (P&L, cost split, upgrades), TODO (approvals + quests), LOG (event timeline). On phones panels are bottom sheets; at >=900px they dock on the right.
- **Spend rules in UI**: upgrades show their approval tier ($0–5 auto, $5–25 within rules, $25+ becomes a request in TODO). Rules live in `js/rules.js` (unit-tested).
- **Principle**: nothing in the UI is a fake reward; progression/quests show their verification source. All current numbers are mock data until Phases 2+ supply real ones.

### Phase 4 addition
The HQ (Supervisor tower) panel shows a LIVE SUPERVISOR block (state, cycle, in-flight, queue counts, limits, last decisions) from `/api/supervisor/*`, with a clear note when the API is unreachable; everything else is still mock data. The selected design is unchanged.

### Phase 1 client layout
`client/public/` — `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js` (app-shell cache; /api never cached), `icons/`, `js/{main,world,camera,ui,rules,util}.js`, `js/data/mock.js` (the only data source; replace in later phases). `lab/` holds the throwaway Design Lab prototypes, kept for reference.
