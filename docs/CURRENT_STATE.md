# CURRENT STATE (primary handoff document — read first)

## Project identity
Autonomous Tycoon — Windows-hosted autonomous-business platform with a 32-bit futuristic 2D tycoon game UI (responsive web/PWA, used from Android). Four businesses: Etsy/POD, Game Assets, Affiliate, Fiverr. See MASTER_PLAN.md.

## Phase status
- Current phase: **PHASE 1 — Game Client (COMPLETE)**
- Completed phases: PHASE 0, PHASE 1
- Phase 0 status: **COMPLETE** (branch `claude/autonomous-tycoon-phase-0-fur6cl`)
- Phase 1: **COMPLETE.** Design gate resolved: user chose concept 9, "Iso Command Hub" (docs/GAME_SPECIFICATION.md).
- Next authorized phase: **PHASE 2 — Database** (NOT started; requires explicit user authorization)

## Architecture status
Documented (ARCHITECTURE.md). Implemented: config loader, HTTP server with `/api/health` + static client serving, and the Phase 1 game client (isometric command hub PWA, mock data only, `client/public/`). Everything else not started.

## Technology stack
Node.js >= 22 (ESM JS, zero npm deps), node:test, JSON config + env, SQLite (Phase 2), Canvas 2D PWA (Phase 1), Playwright (Phase 15). See DECISIONS.md.

## Status table
| Area | Status |
|---|---|
| Structure, docs, config, tests, git | completed |
| Game client (Phase 1, mock data) | completed |
| Database | not started |
| Agent OS / Supervisor | not started |
| Providers, businesses, finance, etc. | not started |
| Blocked | none |
| Deferred | see BACKLOG.md |

## Known issues
See KNOWN_ISSUES.md (not validated on Windows yet).

## Last successful validation
`npm test` → 9/9 pass (smoke + client: spend rules, mock-data consistency, hit-testing, panels, PWA assets). Browser check at phone size: no console errors, service worker registers, no horizontal scroll.
Run: `npm test` (all) or `npm run test:smoke`.
Run the app: `npm start` → http://127.0.0.1:8787/ (phone on LAN: set TYCOON_HOST=0.0.0.0).

## Last Git commit
See `git log -1` (a commit cannot contain its own hash).

## How to resume
1. Read AGENTS.md, this file, CHECKLIST.md, then the spec for the authorized phase in PHASES.md.
2. Work only in the authorized phase; update this file, CHECKLIST.md, project_state.json, CHANGELOG.md, commit.
