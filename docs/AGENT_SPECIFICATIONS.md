# AGENT SPECIFICATIONS (design target; implemented from Phase 3)

One shared Agent OS. Businesses supply task types/tools; agents are role-based.

## Roles
Research, Opportunity, Strategy, Creation, QA, Publishing, Analytics, Optimization, Financial, Recovery, Safety, Supervisor.

| Role | Responsibility |
|---|---|
| Research | Gather market/trend/competitor data from legitimate sources |
| Opportunity | Score and rank opportunities (demand, competition, margin, risk) |
| Strategy | Choose what to create/publish and how |
| Creation | Produce designs/assets/content/gig deliverables via providers |
| QA | Quality, IP/similarity, policy checks; can block |
| Publishing | Publish via legitimate APIs/automation; requires approval gate |
| Analytics | Track views, clicks, conversions, sales |
| Optimization | Propose and test improvements |
| Financial | Track costs/revenue; enforce spend tiers |
| Recovery | Retry, resume, repair failed tasks/browsers/connections |
| Safety | Detect risk; escalate to human; can halt |
| Supervisor | Schedule, allocate, prioritize, lifecycle (Phase 4+) |

## Required agent record (future)
id, role, business scope, version, state (candidate/active/suspended/retired), permissions, XP, level, reputation, metrics (success rate, cost, latency, quality), health, current task, persistent memory/state, created/updated timestamps.

## Lifecycle (Phase 18; NOT in Phase 0)
create candidate → test in sandbox → compare vs incumbent → promote → monitor → retire. Supervisor-driven, audited, reversible.

## Permissions
Capability-based (e.g. `publish:etsy`, `spend:<=5`, `browser:use`). Default deny. Safety agent and human can revoke.

## Task contract
`{id, business, type, role, input, priority, budget, state, attempts, parent, result, cost, error}`; states: queued, running, waiting_approval, succeeded, failed, retrying, cancelled.

---
# IMPLEMENTED IN PHASE 3 — Agent Operating System foundation

One shared Agent OS (`server/src/agents/`) serves every business; business agents are **configurations** (role + business + capabilities + task types + limits) on the same runtime. No Etsy/Fiverr/Affiliate/Asset-specific systems exist. Only deterministic `demo.*` handlers ship; nothing contacts the outside world.

## Modules
`states.js` state machines · `validate.js` input/ID/secret checks · `capabilities.js` permission model · `config.js` agent definition validation · `registry.js` AgentRegistry (persistence, transitions, heartbeat, health, metrics, XP/reputation) · `queue.js` TaskQueue · `handlers.js` handler registry + demo handlers · `runtime.js` per-agent AgentRuntime · `os.js` AgentOS (wiring, loop, boot reconcile, detection) · `demo.js` five demo agents.

## Agent state machine (`agents.status`)
`created → ready ⇄ running`; `ready/running/blocked → paused → ready`; `ready/running → blocked → ready`; `ready/running/paused/blocked → stopping → stopped → ready` (restart); any active state → `failed → stopped`; `created/paused/stopped/failed → retired` (final).
Rules: an agent can only reach `running` from `ready`; `stopped` must pass through `ready`; `retired` is final; self-transitions are invalid. Every change is a compare-and-set update plus an `agent.<state>` event. Pausing while a task runs lets that task finish; the agent then stays `paused`.

## Task state machine (`tasks.status`)
`pending → queued → assigned → running → completed | failed | retrying | cancelled`; `retrying → queued` (after backoff); `blocked` parks a task (`→ queued/pending/cancelled`); `assigned/running → queued` means *released* (interrupted by shutdown/restart/expired lease; **does not consume a retry**). `completed/failed/cancelled` are terminal. Every transition is persisted with a `task.<state>` event.

## Execution
`claim(agent)` → `start` → handler(ctx) → `complete` / `fail`. The handler gets `{task, agent, signal, clock, checkpoint}` and no network helpers. Before the handler runs, `assertCan(agent, handler.capability, {businessId})` is enforced; denial fails the task `permission_denied` (non-retryable) without running it. A thrown `TaskError` carries `code` and `retryable`; any other thrown error is non-retryable `unhandled_error`.

## Queue
Persistent in `tasks`. Claim picks the best eligible `queued` task: not waiting on `next_attempt_at`, type in the agent's `taskTypes`, business matches (business agents: own business or business-less tasks; shared agents: any), unassigned or pre-assigned to that agent; order = priority (0 first), oldest first. Claiming is one `BEGIN IMMEDIATE` transaction with compare-and-set (`WHERE status='queued'`), tested across connections and across processes. Leases (`lease_expires_at`) mark ownership; expired claims are released. Deadlines (`deadline_at`) cancel tasks that never started. The Agent OS loop (`step`) runs maintenance (due retries, deadlines, expired leases, timed-out tasks) and lets each `ready` agent run one task. This is dispatch only; the Supervisor (Phase 4) adds scheduling, priorities across businesses, budgets.

## Retry / timeout
Retryable failure with attempts left → `retrying`, `retry_count+1`, `next_attempt_at = now + min(maxDelay, base·2^retry_count)` (deterministic, no jitter; defaults 1 s base, 60 s cap). Exhausted or non-retryable → terminal `failed`. Timeouts (default 30 s, per agent limit or per task `timeout_ms`) are enforced in-process via AbortSignal and are retryable; running tasks past `started_at + timeout_ms` are also detected from the database (for workers that died).

## Heartbeat / health
`heartbeat()` persists `last_heartbeat_at`, `last_activity_at`, `health`, `health_status`. Health: `failed` (agent failed) · `unknown` (inactive or never beat) · `stalled` (no heartbeat within `staleAfterMs`, default 30 s) · `degraded` (≥3 failures in last 5 outcomes, or health < 50) · `healthy`. `findStale()`/`detect()` only *detect*; automatic recovery is Phase 4/19.

## Permissions
Default deny. Catalog: `research`, `analyze`, `generate` (enabled; internal/deterministic only) and `publish`, `spend`, `communicate`, `configure` (**disabled; cannot be granted in Phase 3**). Agents also carry a business allow-list (`['*']` only for shared agents). Agent definitions and task payloads reject credential-like keys (`token`, `password`, `apiKey`, …) at any depth.

## Metrics, XP, reputation (placeholders)
Persisted in `agents.metrics_json`: tasks completed/failed, retries, total exec ms, estimated/actual cost, uptime, recent outcomes; derived success rate, avg exec ms, efficiency. **Revenue contribution stays `null` unless a real value is recorded.** XP: +10 only when a task verifiably completes; reputation +0.1 per completion, −0.2 per terminal failure; level = 1 + ⌊xp/100⌋. Rows in `agent_progress_events` (append-only) record each change with reason and `data_mode`. These deterministic rules are test scaffolding; real balancing belongs to Phase 13.

## Checkpoints & shutdown
`checkpoints('agent', id)` = status, current task, last heartbeat, last task, health; `checkpoints('task', id)` = final status, agent, retry count. Graceful stop: `stopping` → abort in-flight handlers → wait up to `stopGraceMs` → unfinished task is **released to `queued`** (never marked complete) → `stopped`. On boot `reconcileAfterRestart()` requeues tasks left `assigned/running` by a dead process and marks agents left active as `stopped`; `startAll()` then restarts them. Paused/failed/retired agents are left alone.

## Demo agents (`data_mode='demo'`, ids `demo-*`, names `DEMO …`)
Research (etsy), Analytics (shared), Creation (assets), QA (etsy), Publishing (affiliate; deliberately has **no** publish capability). Created only by `npm run db:seed-demo`, never in production.

## Deferred (not in Phase 3)
Supervisor scheduling/allocation/budgets, automatic stale-agent recovery, agent creation/evaluation/promotion, real handlers/providers, multi-task concurrency per agent, real progression balancing.
