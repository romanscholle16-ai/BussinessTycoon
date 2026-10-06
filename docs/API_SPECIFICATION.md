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
