# CHANGELOG
## Phase 0 — Foundation & Project Control
- Project structure, config loader, minimal health server, smoke tests.
- Full documentation set in /docs, AGENTS.md rules, machine-readable `project_state.json`.
- .gitignore and `.env.example` (no secrets).

## Phase 1 (intermediate) — Design Lab
- Five prototype UI concepts under client/public/lab (demo data), static serving in server, docs/DESIGN_LAB.md. Design NOT selected.
- Design Lab round 2: concepts 6–10 (modern cyberpunk workspaces). Design still NOT selected.

## Phase 1 — Game Client (final)
- Selected design: Iso Command Hub (user choice). Client in client/public (ES modules, Canvas 2D, PWA manifest + service worker, icons), mock data module, spend-rule module, client tests.
- Fixed `npm test` (Node 22 directory argument).

## Phase 2 — Database & Persistent State
- node:sqlite storage layer, SQL migrations (0001_core, 0002_finance_progression), repositories, seed strategy (foundation + explicit demo), DB health in /api/health, graceful shutdown, scripts/db.js CLI, tests/db.test.js.
