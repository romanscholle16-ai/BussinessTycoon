# DATABASE SPECIFICATION

**Status: IMPLEMENTED in Phase 2** (storage foundation only; no agents, queue engine, Supervisor or finance logic yet).

## Technology decision
**Built-in `node:sqlite`** (SQLite 3.50.x bundled with Node 22.22). Chosen over `better-sqlite3` because: zero dependencies and **no native build** on Windows; transactions, prepared statements, STRICT tables, WAL and `json_valid` all work; the project already targets Node 22. Costs: the module is still flagged *experimental* in Node 22 (prints an `ExperimentalWarning` unless `--no-warnings`), and it is synchronous. The wrapper (`server/src/db/database.js`) is the only file that imports it, so switching to `better-sqlite3` later is a one-file change. Version adjustment: `engines.node` raised from `>=22` to **`>=22.13`** (first release where `node:sqlite` works without a flag).

## Location
`<data dir>/tycoon.sqlite` (+ `-wal`/`-shm`). Data dir = `config.paths.data` (default `runtime/data`, override with `TYCOON_DATA_DIR`). The path must be **under `<repo>/runtime/` or outside the repository entirely**; anything else (e.g. `server/src`, `docs`, `.`) is rejected (`paths.js`). Files are git-ignored (`*.sqlite`, `*-wal`, `*-shm`, `runtime/data/*`). Never commit a runtime database.

## Connection settings
`foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000ms` (config `database.busyTimeoutMs`). Transactions use `BEGIN IMMEDIATE` (writers queue instead of deadlocking); nested calls become savepoints. Transaction callbacks must be synchronous.

## Migrations
- Files: `database/migrations/NNNN_name.sql`, numbered contiguously from `0001`.
- Applied in order, **each in its own transaction**, recorded in `schema_migrations(version, name, checksum, applied_at)`.
- Safety: applied migrations are checksummed; editing one → `checksum_mismatch`; database newer than code → `db_newer_than_code`; filename gap/bad name → refused; a failing migration is rolled back fully and reported as `apply_failed`. Never edit an applied migration; add a new one.
- Startup: server auto-migrates when `database.autoMigrate` is true (default). If false, state is `migration_required`.
- Do not put `BEGIN/COMMIT` or `PRAGMA foreign_keys` in migration SQL (use the `-- migrate:foreign-keys=off` first-line directive for table rebuilds).
- CLI: `npm run db:status | db:migrate | db:seed-demo | db:check | db:reset` (`reset` is dev-only and refuses in production).

## Conventions
STRICT tables; TEXT ids (UUID, or slug for businesses); timestamps ISO-8601 UTC text; **money in integer minor units (cents)**, positive, direction given by `type`; JSON stored in `*_json` TEXT columns guarded by `json_valid`; repositories expose them without the suffix (`payload_json` ↔ `payload`).

## DEMO / TEST / LIVE
Every data table has `data_mode` in (`demo`,`test`,`live`), default `live`. Totals and progression are always queried **per mode** (`ledger.summary({mode})` requires a mode; modes are never mixed). Demo records are explicit: ids prefixed `demo-`, agent names prefixed `DEMO `, ledger metadata says "DEMO – not real revenue". The UI must never present `demo`/`test` rows as real results.

## Schema overview
| Area | Tables |
|---|---|
| System | `schema_migrations`, `system_state` (non-secret state/settings as key/JSON), `process_runs` (running/clean/crashed → unclean-shutdown detection), `checkpoints` (scope,key → state JSON, versioned) |
| Businesses | `businesses` (etsy, assets, affiliate, fiverr; status setup/active/paused/disabled), `business_metrics` |
| Agents | `agents` (role from the 12 roles, business or shared, status, level, xp, reputation, health, metrics/config JSON, retired_at) |
| Tasks | `tasks` (status, priority 0–10, payload/result JSON, retry_count/max_retries, error, parent_task_id, correlation_id, created/started/completed/next_attempt_at) |
| Events/audit | `events` (**append-only** via triggers: ts, type, severity, business/agent/task, action, result, cost_minor, error, metadata) |
| Finance | `ledger_entries` (**append-only**; type revenue/expense; categories revenue, ai_cost, api_cost, marketplace_fee, pod_cost, advertising, refund, other_expense; unique (source, reference) for idempotent imports; corrections are reversing entries) |
| Progression | `progression` (empire/business/agent xp, level, reputation), `achievements` (with evidence), `quests` (with verification), `upgrades`, `leaderboard_metrics` |
| Human control | `approvals` (request, amount, reason, expected benefit, risk, status, expiry, resolution) |

Indexes: task queue `(status, priority, next_attempt_at)`, tasks by business/agent/correlation, events by `ts` and `(business, ts)` and type, ledger by `(business, ts)` and `ts`, agents by business/status, approvals by status, quests/upgrades by status, metric lookups. Foreign keys enforce references; businesses/agents referenced by history cannot be deleted (retire instead).

## Data-access layer (`server/src/db/`)
`database.js` (open/close/run/get/all/transaction/integrity checks) · `migrate.js` · `paths.js` · `repos.js` (whitelisted-column repositories; parameterized SQL only; filter/order columns validated) · `seed.js` · `service.js` (startup, health, graceful close). Repos expose `get/list/count/insert/update` (events, ledger, achievements, metrics, leaderboard are insert-only) plus `ledger.summary`, `approvals.resolve` (atomic, once), `systemState`, `checkpoints`, `progression`, `runs`. No ORM; no business logic.

## Seeding
- `seedFoundation` (automatic, idempotent): the four business records (`live`, status `setup`, no metrics).
- `seedDemo` (explicit: `npm run db:seed-demo`): demo agents, tasks, events, ledger, quests, upgrades, approvals, progression – all `data_mode='demo'`, mirroring the Phase 1 mock numbers (net +$12.80). Refuses in production. Because events/ledger are append-only, demo data is removed with `npm run db:reset` (dev only).

## Health
`GET /api/health` → `status` (HTTP server) and `database.status`: `ok`, `unavailable`, `migration_required`, `migration_failed` (+ `error` code), or `not_configured`; plus `schemaVersion`, `latestVersion`, `pendingMigrations`. No paths or secrets. Full integrity/foreign-key checks: `npm run db:check`.

## Backup / recovery requirements (NOT built yet; see BACKLOG)
Backup: online-safe copy (`VACUUM INTO` or SQLite backup API) to a timestamped file in a separate location, on a schedule, with retention. Restore: stop app, replace DB (+ discard `-wal/-shm`), run `db:check`, start (migrations auto-apply). Integrity verification after each backup and on startup if the previous run crashed. Corruption recovery: restore latest good backup, replay from checkpoints, record in events. Safe shutdown: SIGINT/SIGTERM close the server then the DB (WAL checkpoint, run marked clean).

## Phase 3 schema changes (migration `0003_agent_os`)
SQLite cannot alter CHECK constraints, so `agents` and `tasks` were rebuilt (data preserved and states mapped: agents candidate→created, idle→ready, working→running, suspended→paused; tasks waiting_approval→blocked, succeeded→completed). The migration runner now supports a first-line directive `-- migrate:foreign-keys=off`: FK enforcement is disabled around that file only, `PRAGMA foreign_key_check` must be clean before commit, and enforcement is always restored. Tested by upgrading a populated version-2 database.
- `agents`: states `created, ready, running, paused, blocked, stopping, stopped, failed, retired`; new columns `health_status` (healthy/degraded/stalled/failed/unknown), `permissions_json` ({capabilities, businesses}), `current_task_id`, `last_heartbeat_at`, `last_activity_at`, `last_started_at`, `last_error`.
- `tasks`: states `pending, queued, assigned, running, completed, failed, retrying, cancelled, blocked`; new columns `metadata_json`, `timeout_ms`, `deadline_at`, `claimed_at`, `lease_expires_at`; queue index `(status, priority, next_attempt_at, created_at)` and lease index.
- New table `agent_progress_events` (append-only): XP/reputation deltas with reason, task and `data_mode`.
- Phase 2 demo seed now registers the five Phase 3 demo agents instead of the twelve mock rows (the client still shows its own mock data).

## Phase 4: no schema change
The Supervisor reuses existing storage: run state and the single-instance lock in `checkpoints` (scope `supervisor`, keys `state` and `lock`), decisions and lifecycle in append-only `events` (`supervisor.decision` / `supervisor.lifecycle`, indexed by `(type, ts)`), process identity in `process_runs`. The schema stays at version 3 (a test asserts this). Task `metadata.estimatedCostMinor` (validated non-negative integer) is the only cost input.

## Phase 5: migration `0004_observability_indexes` (indexes only)
`idx_events_task (task_id, ts)`, `idx_events_agent (agent_id, ts)`, `idx_events_severity (severity, ts)` (partial on non-null ids where applicable) and `idx_tasks_completed (completed_at)`, each justified by an observability query (task/agent traces, severity/error views, windowed task metrics). No table or data change; tested by upgrading a populated version-3 database (integrity and foreign keys verified, events untouched). The `events` schema already carried everything needed (correlation/retry/parent come from joining `tasks`); severity storage keeps `warn`, exposed as `warning`. Measured on 100,000 events + 20,000 tasks: default event list 0.5 ms, error view ~25 ms, health ~11 ms, 1 h metrics ~2 ms, 24 h metrics ~23 ms.

## Phase 6: no schema change
AI observability uses existing `events` rows (`ai.completed`, `ai.failed`, `ai.fallback`, `ai.provider_state`; `metadata_json` carries provider/model/attempts/latency/tokens/`costUsd`/`costBasis`; `cost_minor` stays 0 because AI costs are sub-cent: the precise USD value is in metadata and surfaced as `cost.amountUsd` by the observability API). Provider runtime state (breaker, rate limits) is in memory and is rebuilt after restart. Schema version stays 4.

## Phase 7: migration `0005_research` (additive; earlier migrations untouched)
Tables (STRICT, FKs on, `data_mode` on every row, JSON in `*_json` with `json_valid`): `research_runs` (objective, plan, limits, status, stop reason, confidence, result, provenance, counters, `active_ms`, `cancel_requested`, task/business/correlation links), `research_subquestions`, `research_sources` (unique per run+canonical URL; bounded `text`; quality JSON; duplicate links), `research_evidence` (CHECK: direct evidence requires a source), `research_conflicts`, `research_findings`. Children `ON DELETE CASCADE` from the run. Indexes match the API queries (`runs(created_at DESC,id)`, `runs(status,created_at DESC)`, `runs(task_id)`, `sources(run_id,status,created_at,id)`, `sources(run_id,content_hash)`, `evidence(run_id,evidence_type,id)`, `evidence(source_id)`, `conflicts(run_id)`, `findings(run_id,type,id)`). Run events are **not** a separate table: they use the append-only `events` table (`research.*`).
Retention: `research_sources.text` holds at most `limits.maxTextChars` (default 20 000, max 50 000) of *extracted* text — never raw HTML, headers, cookies or credentials — and is deleted with its run. There is no automatic pruning yet (KI-043).
