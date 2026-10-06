# CURRENT STATE (primary handoff document — read first)

## Project identity
Autonomous Tycoon — Windows-hosted autonomous-business platform with a 32-bit futuristic 2D tycoon game UI (responsive web/PWA, used from Android). Four businesses: Etsy/POD, Game Assets, Affiliate, Fiverr. See MASTER_PLAN.md.

## Phase status
- Current phase: **PHASE 0 — Foundation & Project Control**
- Completed phases: PHASE 0 (reviewed and accepted by the user)
- Phase 0 status: **COMPLETE** (branch `claude/autonomous-tycoon-phase-0-fur6cl`)
- Phase 1: **IN PROGRESS — stopped at DESIGN-SELECTION GATE.** Ten prototypes built in two rounds (see DESIGN_LAB.md); user has NOT chosen. Do not lock a design, polish one concept, or make the final Phase 1 commit until the user chooses.
- Next step: wait for the user's choice (1–5, a combination, or modifications), then complete Phase 1 on that direction

## Architecture status
Documented (ARCHITECTURE.md). Implemented: config loader (`server/src/config`), minimal HTTP server with `/api/health` (`server/src/api`). Everything else not started.

## Technology stack
Node.js >= 22 (ESM JS, zero npm deps), node:test, JSON config + env, SQLite (Phase 2), Canvas 2D PWA (Phase 1), Playwright (Phase 15). See DECISIONS.md.

## Status table
| Area | Status |
|---|---|
| Structure, docs, config, tests, git | completed |
| Game client | not started |
| Database | not started |
| Agent OS / Supervisor | not started |
| Providers, businesses, finance, etc. | not started |
| Blocked | none |
| Deferred | see BACKLOG.md |

## Known issues
See KNOWN_ISSUES.md (not validated on Windows yet).

## Last successful validation
`node --test tests/smoke.test.js` → 3/3 pass (project layout, config, server health).
Run: `npm run test:smoke`.

## Last Git commit
See `git log -1` (a commit cannot contain its own hash).

## How to resume
1. Read AGENTS.md, this file, CHECKLIST.md, then the spec for the authorized phase in PHASES.md.
2. Work only in the authorized phase; update this file, CHECKLIST.md, project_state.json, CHANGELOG.md, commit.
