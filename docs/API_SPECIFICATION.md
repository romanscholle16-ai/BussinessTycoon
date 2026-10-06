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
