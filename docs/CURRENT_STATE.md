# CURRENT STATE (primary handoff document — read first)

## Project identity
Autonomous Tycoon — Windows-hosted autonomous-business platform with a 32-bit futuristic 2D tycoon game UI (responsive web/PWA, used from Android). Four businesses: Etsy/POD, Game Assets, Affiliate, Fiverr. See MASTER_PLAN.md.

## Phase status
- Current phase: **PHASE 2 — Database & Persistent State (COMPLETE)**
- Completed phases: PHASE 0, PHASE 1, PHASE 2
- Phase 0 status: **COMPLETE** (branch `claude/autonomous-tycoon-phase-0-fur6cl`)
- Phase 1: **COMPLETE.** Design gate resolved: user chose concept 9, "Iso Command Hub" (docs/GAME_SPECIFICATION.md).
- Phase 2: **COMPLETE** — SQLite (node:sqlite) storage foundation, migrations, repositories, demo/test/live separation, DB health (docs/DATABASE_SPECIFICATION.md).
- Next authorized phase: **PHASE 3 — Agent Operating System** (NOT started; requires explicit user authorization)

## Architecture status
Documented (ARCHITECTURE.md). Implemented: config loader, HTTP server with `/api/health` + static client serving, the Phase 1 game client (isometric command hub PWA, still mock data), and the Phase 2 database layer (`server/src/db/`, `database/migrations/`). Everything else not started.

## Technology stack
Node.js >= 22.13 (ESM JS, zero npm deps), node:test, JSON config + env, SQLite via node:sqlite, Canvas 2D PWA (Phase 1), Playwright (Phase 15). See DECISIONS.md.

## Status table
| Area | Status |
|---|---|
| Structure, docs, config, tests, git | completed |
| Game client (Phase 1, mock data) | completed |
| Database (Phase 2) | completed |
| Agent OS / Supervisor | not started |
| Providers, businesses, finance, etc. | not started |
| Blocked | none |
| Deferred | see BACKLOG.md |

## Known issues
See KNOWN_ISSUES.md (not validated on Windows yet).

## Last successful validation
`npm test` → 19/19 pass (Phase 0 smoke, Phase 1 client, Phase 2 database: migrations, persistence incl. cross-process, integrity, transactions, SQL safety, demo/live separation, path safety, health states). Live server check: health shows database ok; SIGTERM marks the run clean.
DB commands: `npm run db:status|db:migrate|db:seed-demo|db:check|db:reset`.
Run: `npm test` (all) or `npm run test:smoke`.
Run the app: `npm start` → http://127.0.0.1:8787/ (phone on LAN: set TYCOON_HOST=0.0.0.0).

## Last Git commit
See `git log -1` (a commit cannot contain its own hash).

## How to resume
1. Read AGENTS.md, this file, CHECKLIST.md, then the spec for the authorized phase in PHASES.md.
2. Work only in the authorized phase; update this file, CHECKLIST.md, project_state.json, CHANGELOG.md, commit.
