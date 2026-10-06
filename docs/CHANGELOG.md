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

## Phase 3 — Agent Operating System
- Shared Agent OS (`server/src/agents/`): state machines, registry, persistent queue with safe claiming, retries/timeouts/leases/deadlines, heartbeats/health, capability model, metrics/XP/reputation placeholders, checkpoints, graceful shutdown, boot reconcile, demo agents and handlers.
- Migration 0003 (agents/tasks rebuilt, agent_progress_events); migration runner FK directive.
- API: agents, tasks, agent-os status, demo task create/cancel. Server starts the Agent OS and shuts it down gracefully.
- Tests: tests/agents.test.js (19 tests).

## Phase 4 — Supervisor
- `server/src/supervisor/`: lifecycle, single-instance lock, control loop, observation, deterministic scheduling policy with aging/fairness, limits, recovery, decisions, checkpoints. Agent OS extended with targeted dispatch. Phase 3 fixes: clock-based `created_at`, abort-reason classification.
- API: `/api/supervisor/status`, `/decisions`, demo pause/resume. Server starts/stops the Supervisor. Iso Command Hub HQ panel shows live Supervisor status and recent decisions (minimal change).
- Tests: tests/supervisor.test.js (20 tests). No migration.

## Phase 5 — Observability
- `server/src/observability/` (severity, sanitizing, strict query parsing, event/trace/error queries, deterministic health, windowed metrics, structured logger); `/api/system/health`, `/api/system/metrics`, `/api/events[/:id]`, `/api/errors`, `/api/activity`; richer `/api/health`.
- Migration 0004 (indexes only). Producer severity rules (retry/release/recovery = warning, Supervisor failed = critical). Console logging replaced by the structured logger. Supervisor status gained `stateSince`/`lastOkCycleAt`.
- Iso Command Hub: health pill, live HQ health + Supervisor, real event timeline, real agent roster (design unchanged).
- Tests: tests/observability.test.js (16 tests).
