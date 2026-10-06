# API SPECIFICATION (direction)
## Implemented (Phase 0)
- `GET /api/health` → `{status:"ok", phase, env}`

## Planned
REST JSON under `/api`, plus SSE/WebSocket `/api/stream` for live events.
Resources: businesses, agents, tasks, events, approvals, finance, quests, upgrades, system (health, emergency stop). Auth from Phase 20 (token for LAN access); versioned if breaking.

## AI provider interface (Phase 6)
```
ProviderAdapter { id, capabilities:{text,image,vision}, generate(request) -> {output, usage, costUsd}, health() }
```
Selected by config + Supervisor; failover chain; cost reported per call to finance. Providers: Claude, Freebuff, OpenAI, Ollama, future. Preferred image provider: GPT Images 2.5 with backups. A fake/sandbox provider is required for tests. No credentials needed until real providers are enabled.

## Phase 2 change: `GET /api/health`
```
200 {"status":"ok","phase":2,"env":"development","database":{"status":"ok","schemaVersion":2,"latestVersion":2,"pendingMigrations":0}}
```
`status` reports the HTTP server only (always 200 while the process serves). `database.status` is one of `ok | unavailable | migration_required | migration_failed | not_configured`; failures add `database.error` (a short code, never a path or secret). Static client files are served at `/` (excluding `/api/*`).

## Phase 3 additions (Agent OS foundation)
`/api/health` now reports `phase: 3`. All responses are JSON; IDs must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$` (else 400); bodies are limited to 16 KB and must be `application/json`. If the Agent OS is not running (database not ready): `503 {"error":"agent_os_unavailable"}`.

| Method & path | Purpose |
|---|---|
| `GET /api/agents?status=&role=&business=&available=true` | list agents (id, name, role, businessId, status, level, xp, reputation, health, healthStatus, capabilities, businesses, taskTypes, limits, currentTaskId, heartbeat times, metrics, dataMode) |
| `GET /api/agents/:id` · `GET /api/agents/:id/status` | one agent · compact status/health |
| `GET /api/tasks?status=&business=&agent=&type=&limit=&offset=` | list tasks (newest first, limit ≤ 200) |
| `GET /api/tasks/:id` | one task (status, payload, result, retry info, error {code,message}, timestamps, dataMode) |
| `GET /api/agent-os/status` | agent counts by state, task counts by status, loop flag, stale/timeout/lease detection |
| `POST /api/demo/tasks` `{type:"demo.*", businessId?, priority?, payload?, maxRetries?, timeoutMs?}` | create a **demo** task (registered `demo.*` types only; `data_mode='demo'`); 201. Disabled (403) in production |
| `POST /api/demo/tasks/:id/cancel` | cancel a **demo** task only (403 for others; 409 if already final) |

Errors: 400 `validation`, 403 `forbidden`, 404 `not_found`, 409 `invalid_transition`, 500 `internal` (no details). No credentials or file paths are ever returned. There are no endpoints that publish, spend, create agents, or touch the Supervisor.

## Phase 4 additions (Supervisor)
`/api/health` reports `phase: 4`. If no Supervisor is running: `503 {"error":"supervisor_unavailable"}`.
| Method & path | Purpose |
|---|---|
| `GET /api/supervisor/status` | `{supervisor:{state, runId, cycle, lastCycle{seq,dispatched,recovered,skipped,limits,at,ok,queue}, counters, inFlight, activeLimits, previousRun{runId,interrupted,lastCycleAt,lastCycleSeq}, config{pollMs,limits,scheduling,recovery}, startedAt}}` (no instance id, paths or secrets) |
| `GET /api/supervisor/decisions?limit=&kind=&since=` | newest-first decisions/lifecycle events: `{id, ts, kind, severity, result, businessId, agentId, taskId, details}`; `limit` 1–200 (default 50), `kind` like `task.dispatched`, `since` ISO date; bad values → 400 |
| `POST /api/demo/supervisor/pause` · `/resume` | development controls; 409 on an invalid transition; **403 in production** |
No endpoint can dispatch, assign, recover, or change limits directly; clients cannot bypass Agent OS permissions.

## Phase 5 additions (Observability) — read-only
`/api/health` (fast, small): `{status:"ok" (HTTP server), health:"healthy|degraded|critical|unknown", issues, phase:5, env, database{status,schemaVersion,latestVersion,pendingMigrations}, supervisor{state,health}, agentOS{total,available,health}}`.
New endpoints use the envelope `{ok:true, timestamp, data, meta:{phase,…}}`; errors are `{ok:false, error, message, timestamp}` (`validation` 400, `not_found` 404, `method_not_allowed` 405, `database_unavailable`/`observability_unavailable` 503). Older Phase 3/4 endpoints keep their existing shapes. Only `GET` is accepted; unknown or repeated query parameters are rejected with 400.
| Endpoint | Purpose / parameters |
|---|---|
| `GET /api/system/health[?deep=1]` | full component health, issues, attention list (works even when the database is down: status `critical`) |
| `GET /api/system/metrics[?window=current\|5m\|1h\|24h\|7d\|startup][&since=&until=]` | tasks/agents/Supervisor/business operational metrics |
| `GET /api/events` | newest first. `limit` 1–200 (50), `before=<event id>` cursor (`meta.nextBefore`), `kind` (event type or Supervisor decision name), `component`, `severity` or `minSeverity` (`debug,info,warning,error,critical`), `business`, `agent`, `task`, `correlation`, `since`/`until` (ISO, range ≤ 30 days) or `window` (`5m,1h,24h,7d`). Without `task/agent/correlation/before` the default window is the last 24 h |
| `GET /api/events/:id` | the event plus its task and the task's chronological timeline (task states, Supervisor decisions, retries, result) |
| `GET /api/errors` | events of severity ≥ error (`includeWarnings=true` adds warnings) with task/agent state, `retryable`, related Supervisor decisions and a plain-language `explanation`; same filters as events |
| `GET /api/activity` | like events with `minSeverity=info` by default (debug hidden) plus `meta.counts` by severity |
Responses are sanitized: credential-like keys redacted, file paths and stack traces removed, strings truncated; no endpoint exposes paths, secrets or SQL.
