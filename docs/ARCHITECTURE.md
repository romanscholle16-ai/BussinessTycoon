# ARCHITECTURE

## Layers
```
Android phone (browser/PWA)
  ↓ Wi-Fi (LAN)
client/            responsive web client (game UI)
  ↓ HTTP + WebSocket/SSE
server/            Windows Node.js server: API, config, auth, event stream
  ↓
core: Supervisor → Agent OS → business engines
  ↓
database (SQLite) · AI providers · automation (browser/API) · finance · logs
```

## Technology stack (decided Phase 0; see DECISIONS.md)
| Concern | Choice | Status |
|---|---|---|
| Runtime | Node.js >= 22 LTS (installed: v22.22.0), ESM JavaScript | in use |
| Client | Vanilla JS + HTML5 Canvas 2D, PWA (manifest + service worker); no framework unless Phase 1 proves need | Phase 1 |
| Server/API | Node `http` now; Fastify planned when API grows (Phase 1–2) | minimal in use |
| Database | SQLite (file in runtime/data) via Node built-in `node:sqlite` or better-sqlite3, decided in Phase 2 | Phase 2 |
| Migrations | Plain numbered `.sql` files in database/migrations applied by a small runner | Phase 2 |
| Testing | `node:test` built-in runner, zero dependencies | in use |
| Logging | Structured JSON lines to runtime/logs (pino-compatible shape) | Phase 5 |
| Config | config/default.json < config/<env>.json < config/local.json < TYCOON_* env vars; secrets only via env/.env | in use |
| Browser automation | Playwright (Chromium), isolated behind an adapter | Phase 15 |
| AI providers | Adapter interface `ProviderAdapter` with capability flags (text, image, vision), failover chain | Phase 6 |
| Windows service | node-windows or NSSM + scheduled task | Phase 22 |

Phase 0 has ZERO npm dependencies.

## Directory layout
- `server/src/` backend (config, api, core)
- `client/` web/PWA client (`public/` static assets)
- `agents/` Agent OS and role definitions (`roles/`)
- `businesses/` four business modules (etsy_pod, game_assets, affiliate, fiverr)
- `database/` migrations, seeds
- `config/` JSON configs (no secrets)
- `tests/`, `scripts/`
- `runtime/data`, `runtime/logs` git-ignored runtime state
- `assets/` raw and in-game assets
- `docs/` source-of-truth documentation

## Key principles
- Single Agent OS; businesses are plugins supplying task types, tools and policies.
- Everything is a persisted task; queues survive restart.
- Every action emits an event (see DATABASE_SPECIFICATION.md).
- Providers, automation and marketplaces sit behind adapters; a sandbox/fake adapter exists for each so development needs no credentials.
- Safety gate and approval gate are mandatory in the publish/spend path.
- Server binds to 127.0.0.1 by default; LAN exposure is explicit config.
