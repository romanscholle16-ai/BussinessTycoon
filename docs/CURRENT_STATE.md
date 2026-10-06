# CURRENT STATE (primary handoff document — read first)

## Project identity
Autonomous Tycoon — Windows-hosted autonomous-business platform with a 32-bit futuristic 2D tycoon game UI (responsive web/PWA, used from Android). Four businesses: Etsy/POD, Game Assets, Affiliate, Fiverr. See MASTER_PLAN.md.

## Phase status
- Current phase: **PHASE 4 — Supervisor (COMPLETE)**
- Completed phases: PHASE 0, PHASE 1, PHASE 2, PHASE 3, PHASE 4
- Phase 0 status: **COMPLETE** (branch `claude/autonomous-tycoon-phase-0-fur6cl`)
- Phase 1: **COMPLETE.** Design gate resolved: user chose concept 9, "Iso Command Hub" (docs/GAME_SPECIFICATION.md).
- Phase 2: **COMPLETE** — SQLite (node:sqlite) storage foundation, migrations, repositories, demo/test/live separation, DB health (docs/DATABASE_SPECIFICATION.md).
- Phase 3: **COMPLETE** — shared Agent OS (registry, lifecycle, persistent queue with safe claiming, retries/timeouts, heartbeats/health, capabilities, metrics/XP placeholders, checkpoints, graceful shutdown, demo agents). See AGENT_SPECIFICATIONS.md.
- Phase 4: **COMPLETE** — Supervisor control loop on top of the Agent OS (deterministic scheduling with aging/fairness, limits, recovery, decisions, checkpoints, single-instance lock, status API, small live HQ panel). See AGENT_SPECIFICATIONS.md.
- Next authorized phase: **PHASE 5 — Observability** (NOT started; requires explicit user authorization)

## Architecture status
Documented (ARCHITECTURE.md). Implemented: config loader, HTTP server with `/api/health` + static client serving, the Phase 1 game client (isometric command hub PWA, still mock data), the Phase 2 database layer (`server/src/db/`, `database/migrations/`), the Phase 3 Agent OS (`server/src/agents/`), and the Phase 4 Supervisor (`server/src/supervisor/`; API in `server/src/api/agentRoutes.js`). Real handlers, providers, businesses, observability beyond the Supervisor decision log are NOT started.

## Technology stack
Node.js >= 22.13 (ESM JS, zero npm deps; Agent OS is plain in-process JS), node:test, JSON config + env, SQLite via node:sqlite, Canvas 2D PWA (Phase 1), Playwright (Phase 15). See DECISIONS.md.

## Status table
| Area | Status |
|---|---|
| Structure, docs, config, tests, git | completed |
| Game client (Phase 1, mock data) | completed |
| Database (Phase 2) | completed |
| Agent OS (Phase 3) | completed |
| Supervisor (Phase 4) | completed |
| Providers, businesses, finance, etc. | not started |
| Blocked | none |
| Deferred | see BACKLOG.md |

## Known issues
See KNOWN_ISSUES.md (not validated on Windows yet).

## Last successful validation
`npm test` → 58/58 pass (Phase 0 smoke 4, Phase 1 client 5, Phase 2 database 10, Phase 3 Agent OS 19, Phase 4 Supervisor 20); full suite run 13 times without a failure after fixing one order-dependent test. Real-server check: demo tasks created over HTTP are dispatched by the Supervisor and completed, decisions/status API respond, SIGTERM stops Supervisor then agents cleanly, Phase 1 UI loads with the live Supervisor block and no console errors.
DB commands: `npm run db:status|db:migrate|db:seed-demo|db:check|db:reset`.
Run: `npm test` (all) or `npm run test:smoke`.
Run the app: `npm start` → http://127.0.0.1:8787/ (phone on LAN: set TYCOON_HOST=0.0.0.0).

## Last Git commit
See `git log -1` (a commit cannot contain its own hash).

## How to resume
1. Read AGENTS.md, this file, CHECKLIST.md, then the spec for the authorized phase in PHASES.md.
2. Work only in the authorized phase; update this file, CHECKLIST.md, project_state.json, CHANGELOG.md, commit.
