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
| Client | Vanilla ES modules + Canvas 2D isometric hub, PWA (manifest + service worker); no framework, no build step | in use (Phase 1, mock data) |
| Server/API | Node `http` now; Fastify planned when API grows (Phase 1–2) | minimal in use |
| Database | SQLite via built-in `node:sqlite` (Node >= 22.13), file `runtime/data/tycoon.sqlite`, WAL, FK on | in use (Phase 2) |
| Migrations | Numbered `.sql` files in database/migrations, checksummed, transactional (`server/src/db/migrate.js`) | in use (Phase 2) |
| Testing | `node:test` built-in runner, zero dependencies | in use |
| Logging | Structured JSON lines to runtime/logs (pino-compatible shape) | Phase 5 |
| Config | config/default.json < config/<env>.json < config/local.json < TYCOON_* env vars; secrets only via env/.env | in use |
| Browser automation | Playwright (Chromium), isolated behind an adapter | Phase 15 |
| AI providers | Adapter interface `ProviderAdapter` with capability flags (text, image, vision), failover chain | Phase 6 |
| Windows service | node-windows or NSSM + scheduled task | Phase 22 |

The project still has ZERO npm dependencies. Storage layer: `server/src/db/` (see DATABASE_SPECIFICATION.md); the Phase 1 client still uses mock data and does not read the database yet.

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
