# DECISIONS
| ID | Decision | Reason | Status |
|---|---|---|---|
| D-001 | Node.js 22 + ESM JavaScript, no TypeScript build in Phase 0 | Installed, Windows-friendly, zero build step. May adopt JSDoc types or TS later via decision entry | accepted |
| D-002 | Zero dependencies in Phase 0 | Minimal complexity; node:test and node:http suffice | accepted |
| D-003 | SQLite as database | Single-file, no service to run on Windows, adequate for single-host load | accepted |
| D-004 | Web/PWA client with Canvas 2D | Works in Android browser, no APK | accepted |
| D-005 | Provider adapter abstraction; sandbox fakes for development | No credentials available; avoids lock-in | accepted |
| D-006 | Config layering with secrets only via env | Safe git hygiene | accepted |
| D-007 | Server binds 127.0.0.1 by default | Secure default; LAN opt-in | accepted |
| D-008 | Playwright for future browser automation | Stable, Windows support | proposed (Phase 15) |
| D-009 | 26 phases fixed; new work → BACKLOG.md | Prevent scope drift | locked |
| D-010 | Docs in /docs are the source of truth; `docs/project_state.json` mirrors state | Agent-resumable | accepted |
| D-011 | UI direction = Design Lab concept 9 "Iso Command Hub" (user's choice) | User reviewed 10 concepts and picked it | locked |
| D-012 | Client is vanilla ES modules + Canvas 2D, no build step, no framework | Zero dependencies; Windows/Android friendly | accepted |
| D-013 | Client reads a single snapshot object (mock now, API later) | Lets Phase 2+ swap data without UI rewrite | accepted |
| D-014 | `npm test` uses `tests/*.test.js` glob (Node 22 does not accept a directory argument) | Phase 0 script was broken | accepted |
| D-015 | SQLite via built-in `node:sqlite`; `engines.node` >= 22.13 | No native build on Windows, zero deps, sufficient features; wrapper isolates it | accepted (supersedes KI-003) |
| D-016 | DB file must live under runtime/ or outside the repo | Prevent committing data / unsafe config | accepted |
| D-017 | Every data row carries data_mode demo/test/live; queries choose a mode | Demo data must never read as real results | locked |
| D-018 | Events and ledger are append-only (triggers); money in integer cents | Auditability, reproducible finance | accepted |
| D-019 | Auto-migrate on startup (configurable); migrations checksummed, never edited | Safe 24/7 upgrades | accepted |
| D-020 | One shared Agent OS; business agents are configurations, not separate systems | Maintainability, Supervisor control, consistent metrics/recovery | locked |
| D-021 | Capabilities with external effects (publish/spend/communicate/configure) exist but cannot be granted until their phases | Safety by construction in Phase 3 | accepted |
| D-022 | Claims are CAS updates inside BEGIN IMMEDIATE; released (interrupted) tasks do not consume retries; boot reconcile requeues orphaned tasks | No duplicate execution, no lost tasks on a single local server | accepted |
| D-023 | Iso Command Hub keeps using mock data until Phase 5 (observability API); Phase 3 exposes a read API only | Avoid UI churn; real data needs events/metrics from later phases | accepted |
| D-024 | Migration runner supports `-- migrate:foreign-keys=off` for table rebuilds | SQLite cannot alter CHECK constraints | accepted |
| D-025 | XP/reputation rules are deterministic placeholders (XP only on verified completion); balancing in Phase 13 | No fake progression | accepted |
| D-026 | Supervisor dispatches through `os.dispatch` (CAS claim of a specific task); the Agent OS self-dispatch loop is off when the Supervisor runs | One control brain, no duplicated queue logic | locked |
| D-027 | Supervisor persistence reuses `checkpoints` + `events` + `process_runs`; single-instance lock is a checkpoint row taken in a BEGIN IMMEDIATE transaction with a lease; no migration | No second persistence mechanism | accepted |
| D-028 | Scheduling order: aged priority → deadline → business load → age → id; agent: specialist → least recently active → id; aging gives starvation protection | Deterministic, testable, fair | accepted |
| D-029 | Infrastructure recovery (lease/orphan/stale agent) releases tasks without consuming retries; timeouts of live executors do; terminal failures are never retried; agents get ≤3 automatic restarts per 10 min then are escalated as failed | Matches Phase 3 retry semantics, avoids restart loops | accepted |
| D-030 | Decisions are edge-triggered/deduplicated (persisted keys); idle cycles write nothing | Avoid event spam | accepted |
