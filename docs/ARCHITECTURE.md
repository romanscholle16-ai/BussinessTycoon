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

The project still has ZERO npm dependencies. Agent OS (Phase 3): `server/src/agents/` — one shared runtime (registry, queue, handlers, per-agent runtime) on top of the database; see AGENT_SPECIFICATIONS.md. Supervisor (Phase 4): `server/src/supervisor/` — control loop that dispatches through the Agent OS (`Supervisor → Agent OS → Agents → Tasks → Handlers`); see AGENT_SPECIFICATIONS.md. The Iso Command Hub shows a small live Supervisor block on the HQ panel and otherwise still uses mock data (D-023). Storage layer: `server/src/db/` (see DATABASE_SPECIFICATION.md); the Phase 1 client still uses mock data and does not read the database yet.

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

## Observability (Phase 5) — `server/src/observability/`
Observe → Persist → Query → Explain → Display. It is **read-only**: it never changes system behavior; recovery stays with the Supervisor.
- `severity.js` severity model · `sanitize.js` redaction · `query.js` strict parameter validation · `events.js` event/trace/error queries on the append-only `events` table · `health.js` deterministic health rules · `metrics.js` windowed aggregates · `logger.js` structured process logger · `index.js` service (health cache, summary).
- Sources are existing persisted data only: `events`, `tasks`, `agents`, `businesses`, `process_runs`, `checkpoints`, plus read-only views of the live Supervisor/Agent OS objects. No new storage except four indexes (migration 0004).
- API: `server/src/api/observabilityRoutes.js` (`/api/system/health`, `/api/system/metrics`, `/api/events[/:id]`, `/api/errors`, `/api/activity`), richer `/api/health`.
- Client: health pill, live health/Supervisor blocks on the HQ panel, real event timeline (LOG), real agent roster (AGENTS); polling every 5 s while the tab is visible; everything else still labelled mock.

### Event model
One append-only `events` row per meaningful occurrence (Phase 2 schema, unchanged): `id, ts, type, severity, business_id, agent_id, task_id, action, result, cost_minor, currency, error, metadata_json, data_mode`. The API serializes each row to: `id, ts, kind (type), name (decision name for Supervisor events), action, component (type prefix: task/agent/supervisor/recovery…), severity, message, result, businessId, agentId, taskId, parentTaskId, correlationId, supervisorRunId, cycle, error{code,message}, retry{count,max}, cost (null unless a real cost was recorded), dataMode, details (sanitized metadata)`. Derived, never invented: `correlationId`/`parentTaskId`/`retry` come from joining the task; `component` from the type; `error.code` from the `code: message` convention; `supervisorRunId`/`cycle` from decision metadata.
### Severity rules
`debug` internal diagnostics (rare) · `info` normal lifecycle/activity · `warning` abnormal but functional (retry scheduled, task released after interruption, agent restarted by recovery, limit reached, unservable task, unclean previous shutdown) · `error` an operation could not complete (task failed terminally, agent failed, dispatch/cycle/recovery failed, recovery refused) · `critical` continued autonomous operation is threatened (Supervisor entered `failed`, lock lost). Ordinary task failures are `error`, never `critical`. Storage keeps the Phase 2 value `warn`; the API says `warning` (and accepts both).
### Correlation
`task → agent → Supervisor decision (same task id, run id, cycle) → retry events → final result`, joined by `task_id`; `correlation_id` (set on tasks) and `parent_task_id` link related tasks; `GET /api/events/:id` returns the full timeline of the event's task.
### Health rules (deterministic; thresholds in `health.js`, overridable via `observability.thresholds`)
Overall = critical if any component is critical; degraded if any is degraded; healthy only if database, Supervisor and Agent OS are all healthy; otherwise unknown (e.g. no agents registered, Supervisor disabled/not started). Components: **server** (always healthy while answering; uptime), **database** (service state; `?deep=1` adds integrity + foreign-key checks, cached 5 min; migration problems/unavailable = critical), **supervisor** (failed ≥30 s or loop silent > max(30×poll, 60 s) = critical; paused/stopped/failed <30 s/loop silent > max(5×poll, 10 s)/last cycle failed = degraded), **agentOS** (failed or stale agent = degraded; all agents failed = critical), **tasks** (last hour: failure rate ≥50% with ≥5 finished = degraded, ≥80% with ≥10 = critical; expired leases/overdue running tasks = degraded), **events** (last 15 min: ≥1 critical or ≥20 errors = degraded; ≥3 critical or ≥100 errors = critical). `attention` lists items that need a person but do not by themselves degrade health: blocked tasks, failed agents, a queue waiting > 10 min, recovery escalations in 24 h. Health is cached 2 s.
### Metrics
Windows: `current` (live counts only), `5m`, `1h` (default), `24h`, `7d`, `startup` (since this process run began), or explicit `since`/`until` (≤ 30 days, inclusive of `until`). Tasks (live counts by status; window completed/failed/cancelled, retries scheduled, success/failure rate, average execution ms), Agents (counts by state, available, stale, heartbeat age, per-agent all-time counters and window results), Supervisor (lifetime cycles/successful/failed/dispatches/skips/recoveries; window dispatches, skipped, limit hits, recovery actions/failures/escalations, cycle failures), Businesses (generic operations only: agents, queue depth, active tasks, window completed/failed/success rate, last activity; `notMeasured: revenue, profit, sales, roi`). Money-like fields are null; nothing is fabricated.
### Logging
Process logs are one JSON object per line on stdout/stderr (`ts, level, component, msg, ids, errorCode`), levels `debug…critical`, secrets/paths/stacks scrubbed, messages bounded, level from `logging.level`. The durable record is the `events` table, so events are **not mirrored** to logs (no duplicates) and **no log files are written** (nothing to rotate or grow; the Windows service wrapper/Task Scheduler can capture stdout in Phase 22). Events are not pruned yet (retention policy → BACKLOG).

## AI providers (Phase 6) — `server/src/ai/`
`Supervisor → Agent OS → Agent → Task → AI service → Provider`. The Agent OS and Supervisor know nothing about any provider; task handlers call `ai.complete(request)` and receive a provider-neutral result.
- **Modules:** `service.js` (validate → select → cost ceiling → bounded attempts → normalized result → one event) · `selection.js` (pure, deterministic) · `registry.js` (adapters + runtime state: availability, breaker, rate limits, stats) · `providers/{claude,openai,ollama,mock,freebuff}.js` · `config.js` · `pricing.js` · `http.js` (timeout, cancellation, size cap, no redirects) · `errors.js` · `redact.js` · `handlers.js` (`ai.complete` task handler, capability `ai`) · `server/src/api/aiRoutes.js`.
- **Zero dependencies:** Claude, OpenAI-compatible and Ollama adapters use `fetch` against their HTTP APIs behind the adapter interface (D-037); swapping in an SDK later touches one adapter file.
- **Provider contract** (`providers/base.js`): `describe()`, optional `probe()`, `complete(req, ctx)` returning `{output, finishReason, requestId, usage, model}` or throwing `AiError(category)`. Raw provider responses never leave the adapter.
- **Normalized result:** success `{ok:true, provider, model, output, structured, finishReason, requestId, usage:{inputTokens,outputTokens}|null, cost:{estimatedMaxUsd, actualUsd, basis:'actual'|'unknown', pricing}, ignoredParameters, attempts[], latencyMs, timestamp, correlation}`; failure `{ok:false, error:{category, message, retryable, retryAfterMs, details?}, attempts[], ...}`. Categories: `configuration, authentication, authorization, rate_limit, timeout, unavailable, provider_error, invalid_request, malformed_response, safety_refusal, budget_exceeded, disabled, cancelled, unknown`. `complete()` never throws for request/provider problems.
- **Provider status vocabulary:** `configured` (usable, untested) · `available` (last call/probe succeeded) · `unavailable` · `disabled` · `misconfigured` · `rate_limited` · `temporarily_failed`. A provider with a missing key/model, bad endpoint, or unreachable server is never "available".
- **Selection (deterministic):** explicit `request.provider` is used alone (no silent substitution) unless `allowFallback`; otherwise `activeProvider` then `fallbackProviders` in the listed order (only listed providers are used implicitly). Ineligible providers are dropped with a reason (status, no JSON support, model not offered). `selection=cost` (or `prefer:"cost"`) re-sorts by worst-case estimated cost (unknown last), then failure rate, then average latency, then configured order.
- **Failover (bounded):** per provider `1 + maxRetries` attempts with exponential backoff (`retryBaseMs`, capped by `retryMaxMs`; a `retry-after` longer than the cap fails over instead of sleeping), then the next candidate, at most `maxProviderAttempts` providers, all within `maxTotalMs`. Fail over on configuration/authentication/authorization/rate-limit/timeout/unavailable/provider_error/malformed_response; **never** on `safety_refusal`, `invalid_request`, `budget_exceeded` or `cancelled` (switching providers must not evade a refusal or hide a bug). Provider state: authentication/authorization/configuration failures mark it `misconfigured` until restart; rate limits mark it `rate_limited` until `retry-after`; N consecutive failed calls (`breaker.failureThreshold`, default 3) open a breaker (`temporarily_failed`) for `breaker.cooldownMs` (30 s), after which it is tried again (half-open). Ollama is probed lazily (server up + model installed), cached `probeTtlMs`; there are no polling loops or background timers.
- **Cost:** price per model from config (`providers.<p>.pricing.<model>.{inputPerMTokUsd,outputPerMTokUsd}`; `*` = any model). Built-in Claude prices (as of 2026-09-25) are overridable; OpenAI has none by default; Ollama is explicitly $0 per token (hardware/energy not counted). Pre-call: worst-case estimate (input chars/4 + `maxTokens`) is labelled an estimate. Post-call: actual cost only when the provider returned both token counts AND the price is known; otherwise `actualUsd:null, basis:'unknown'`. Nothing is assumed to be free or invented.
- **Budget safety:** the effective ceiling is the stricter of `request.maxCostUsd` and `limits.maxCostPerRequestUsd`. A provider whose estimate exceeds it — or whose cost is unknown — is not called (fail closed); the next candidate may still fit. No ceiling set ⇒ unpriced calls are allowed and reported with unknown cost. This layer never approves spending; the Phase 12/20 approval system will sit above it.
- **Agent OS integration:** `ai.complete` task type, handler capability `ai` (enabled, external; **never granted to demo agents**). Failures map to `TaskError('ai_<category>')`: `rate_limit/timeout/unavailable/provider_error/malformed_response` are retryable (existing bounded Agent OS/Supervisor retry rules apply and each retry is a new, separately costed call); `disabled/configuration/authentication/authorization/invalid_request/safety_refusal/budget_exceeded` are not. No output is ever faked.
- **Observability:** per call exactly one `ai.completed`/`ai.failed` event (provider, model, attempts summary, retries, fallbacks, latency, token counts, `costUsd`/`costBasis`, finish reason, prompt/output *sizes* only), an `ai.fallback` event per provider switch, and an `ai.provider_state` event when a provider enters or leaves a problem state; linked to task/agent/business (and correlation via the task). Mock-provider events are flagged `test`. Prompts, outputs and credentials are never stored. A disabled AI layer writes no events (the failing task already says why).
- **Freebuff:** an adapter boundary only. No stable programmatic provider API is available in this environment, so nothing was invented: it reports `not integrated`, cannot be selected, and the architecture does not depend on it.
