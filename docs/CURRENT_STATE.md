# CURRENT STATE (primary handoff document — read first)

## Project identity
Autonomous Tycoon — Windows-hosted autonomous-business platform with a 32-bit futuristic 2D tycoon game UI (responsive web/PWA, used from Android). Four businesses: Etsy/POD, Game Assets, Affiliate, Fiverr. See MASTER_PLAN.md.

## Phase status
- Current phase: **PHASE 5 — Observability (COMPLETE)**
- Completed phases: PHASE 0, PHASE 1, PHASE 2, PHASE 3, PHASE 4, PHASE 5
- Phase 0 status: **COMPLETE** (branch `claude/autonomous-tycoon-phase-0-fur6cl`)
- Phase 1: **COMPLETE.** Design gate resolved: user chose concept 9, "Iso Command Hub" (docs/GAME_SPECIFICATION.md).
- Phase 2: **COMPLETE** — SQLite (node:sqlite) storage foundation, migrations, repositories, demo/test/live separation, DB health (docs/DATABASE_SPECIFICATION.md).
- Phase 3: **COMPLETE** — shared Agent OS (registry, lifecycle, persistent queue with safe claiming, retries/timeouts, heartbeats/health, capabilities, metrics/XP placeholders, checkpoints, graceful shutdown, demo agents). See AGENT_SPECIFICATIONS.md.
- Phase 4: **COMPLETE** — Supervisor control loop on top of the Agent OS (deterministic scheduling with aging/fairness, limits, recovery, decisions, checkpoints, single-instance lock, status API, small live HQ panel). See AGENT_SPECIFICATIONS.md.
- Phase 5: **COMPLETE** — read-only observability (events/trace/errors/activity, deterministic health, windowed metrics, structured logging) and real data in the Iso Command Hub for health, Supervisor, timeline and agents. See ARCHITECTURE.md (Observability).
- Next authorized phase: **PHASE 6 — AI Providers** (NOT started; requires explicit user authorization)

## Architecture status
Documented (ARCHITECTURE.md). Implemented: config loader, HTTP server with `/api/health` + static client serving, the Phase 1 game client (isometric command hub PWA, still mock data), the Phase 2 database layer (`server/src/db/`, `database/migrations/`), the Phase 3 Agent OS (`server/src/agents/`), the Phase 4 Supervisor (`server/src/supervisor/`), and the Phase 5 observability layer (`server/src/observability/`, `server/src/api/observabilityRoutes.js`). AI providers, research, businesses, finance are NOT started.

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
| Observability (Phase 5) | completed |
| Providers, businesses, finance, etc. | not started |
| Blocked | none |
| Deferred | see BACKLOG.md |

## Known issues
See KNOWN_ISSUES.md (not validated on Windows yet).

## Last successful validation
`npm test` → 74/74 pass (Phase 0 smoke 4, Phase 1 client 5, Phase 2 database 10, Phase 3 Agent OS 19, Phase 4 Supervisor 20, Phase 5 observability 16); full suite run 6 times without failure. Real-server checks: demo tasks (success/fail/flaky/forbidden) produce correct health, metrics, errors, activity and trace output; Phase 1 UI at phone size shows health pill, HQ health, live timeline with filters and live agents, no console errors, no horizontal scroll. Performance on 100k events + 20k tasks: health ~11 ms, default event list < 1 ms, 24 h metrics ~23 ms.
DB commands: `npm run db:status|db:migrate|db:seed-demo|db:check|db:reset`.
Run: `npm test` (all) or `npm run test:smoke`.
Run the app: `npm start` → http://127.0.0.1:8787/ (phone on LAN: set TYCOON_HOST=0.0.0.0).

## Last Git commit
See `git log -1` (a commit cannot contain its own hash).

## How to resume
1. Read AGENTS.md, this file, CHECKLIST.md, then the spec for the authorized phase in PHASES.md.
2. Work only in the authorized phase; update this file, CHECKLIST.md, project_state.json, CHANGELOG.md, commit.
