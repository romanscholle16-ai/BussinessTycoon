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

---
# IMPLEMENTED IN PHASE 4 — Supervisor

The Supervisor (`server/src/supervisor/`) is the control brain **on top of** the Agent OS: `Supervisor → Agent OS → Agents → Tasks → Handlers`. It observes, plans, dispatches *through* `os.dispatch()`, recovers, and records decisions. It never runs handlers, never talks to the outside world, and cannot bypass agent permissions (it only dispatches tasks an agent is allowed to run, and the runtime re-checks). It is generic: no business-specific logic.

## Modules
`supervisor.js` lifecycle + control loop + recovery + decisions + checkpoints · `policy.js` pure scheduling policy · `observe.js` snapshot · `store.js` persisted state + single-instance lock (on `checkpoints`) · `states.js` lifecycle table · `config.js` limits/defaults.
Agent OS extensions made for it (no duplicated queue logic): `queue.claimTask(taskId, agent)`, `runtime.dispatch(taskId)`, `os.dispatch(taskId, agentId)`, `os.maintain()`, `os.startHeartbeats()`, `os.isInflight()`. Two Phase 3 fixes: queue timestamps (`created_at`) now come from the injected clock, and abort reasons carrying a known code (`timeout`, `cancelled`, `shutdown`, `agent_failed`, `agent_stale`) keep their classification (a timeout is retryable; a cancel is not counted as a failure).

## Lifecycle
`stopped → starting → running ⇄ paused`; `running/paused → stopping → stopped`; `starting/running/paused/stopping → failed`; `failed → starting | stopped`. Invalid moves throw. Each change is a `supervisor.lifecycle` event and is checkpointed. **Single instance:** `start()` takes a lock stored in `checkpoints('supervisor','lock')` inside a `BEGIN IMMEDIATE` transaction; it is refused (`SupervisorLockError`, state stays unchanged) while another instance holds it, its process run is still `running` and its lease (`lockTtlMs`, renewed every cycle) is fresh. A lock left by a crashed/finished process run, or an expired lease, is taken over; the displaced instance fails safely on its next cycle (`lock_lost`).

## Control loop (`cycle()`; timer every `pollMs`, default 1 s; unref'd; stops cleanly)
1. renew lock → 2. promote due retries, cancel expired deadlines → 3. **observe** → 4. **recover** (re-observe if anything changed) → 5. **plan** (pure) → 6. **dispatch** via Agent OS (not awaited: tasks run concurrently, bounded by limits) → 7. record decisions → 8. checkpoint. Overlapping cycles are refused (`busy`). Three consecutive cycle exceptions (configurable) move the Supervisor to `failed` and release the lock. A paused Supervisor does not dispatch or recover; running tasks continue.

## Observation snapshot
Agents (status, health, heartbeat, current task, capabilities, businesses, task types, recent failures, availability, stale flag), candidate tasks (queued and past any retry delay; two bounded reads — by priority and by age, `maxCandidates` each — so old work stays visible), active tasks, in-flight ids, queue counts, and stale/expired/orphaned/timed-out lists. Estimated cost comes only from `task.metadata.estimatedCostMinor` when present; nothing financial is invented.

## Scheduling policy (deterministic, documented in `policy.js`)
Eligible = queued, retry delay elapsed, an agent exists that is allowed to run it (task type, business, allow-list, capability, handler registered). Order, left to right: **(1) effective priority** = max(0, priority − aging boost), boost = min(`maxAgingBoost`, ⌊waited / `agingStepMs`⌋) (defaults: 60 s per level, up to 10 levels — so a long-waiting low-priority task eventually competes as priority 0, then wins by age: **starvation protection**); **(2) deadline** earlier first (none last); **(3) business load** fewer active/planned tasks first (**fairness**); **(4) age** older first (retried tasks wait from `next_attempt_at`); **(5) task id**. Agent for the chosen task: specialist (agent business = task business) before shared, then least-recently-active, then agent id. No revenue/ROI input (that is Phase 16).

## Limits (`config.supervisor.limits`)
`maxConcurrentTasks` (3), `maxDispatchPerCycle` (5), `maxTasksPerAgent` (fixed 1), `maxRetryDispatchPerCycle` (2; only retried tasks are capped, other work still flows), `maxEstimatedCostPerCycleMinor` (null = off; tasks without an estimate count 0). A limit that blocks work records one `limit.reached` decision when it starts blocking (edge-triggered) and dispatch stops/continues accordingly. No money moves.

## Recovery (non-destructive, bounded; infrastructure recovery never consumes a retry)
| Condition | Action | Decision |
|---|---|---|
| assigned task, lease expired | `release` → queued | `recovery.lease_released` |
| task `running` with no live executor (e.g. process died) | `release` → queued | `recovery.task_interrupted` |
| task past its timeout with a live executor | abort → runtime fails it with retryable `timeout` (consumes a retry, as in Phase 3) | `recovery.task_timeout` |
| agent stale (no heartbeat) | graceful stop (its task is released) + restart | `recovery.agent_restarted` |
| agent `failed` | `failed → stopped → ready` | `recovery.agent_restarted` |
| agent `stopped` and compatible queued work exists | start | `recovery.agent_restarted` |
| more than `maxAgentRecoveries` (3) per `windowMs` (10 min) for one agent | mark `failed`, **escalate**, stop trying | `recovery.refused` (error, once) |
Never: delete anything, retry a terminal `failed` task, restart `paused`/`retired` agents. Retryable failures follow the Phase 3 `retrying` backoff; the Supervisor only promotes them when due and dispatches them within the retry cap.

## Decisions
Appended to `events` (`type='supervisor.decision'`, lifecycle changes `type='supervisor.lifecycle'`), with task/agent/business ids and metadata (rank, reason, run id, cycle). Recorded only for meaningful actions: `task.dispatched` (with rank/agent choice), `task.skipped` (no compatible agent; once per task, persisted across restarts), `limit.reached`, `recovery.*`, `dispatch.failed/skipped`, `cycle.failed`, `supervisor.started/resumed_after_interruption/paused/resumed/stopped/failed`. Idle cycles write nothing.

## Checkpoint (`checkpoints('supervisor','state')`)
Run id, state, last cycle seq/time/ok, counters, recovery attempt history, last 200 dedupe keys, config snapshot, `cleanShutdown`. Written on lifecycle changes, after cycles that acted, and at most every `checkpointIntervalMs` (5 s) otherwise. On start, `cleanShutdown=false` with an active state ⇒ the previous run was interrupted: a `supervisor.resumed_after_interruption` decision is recorded, the sequence/recovery history/dedupe set resume, and the normal recovery rules requeue anything the dead process left half-done.

## Severity changes made in Phase 5
Retry scheduled, task released after interruption, recovery actions, skipped (unservable) tasks and limit hits are `warning`; the Supervisor entering `failed` is `critical`; terminal task failures and escalations stay `error`.

## Not in Phase 4
Approvals/human control (Phase 20), budgets in money (Phase 12), ROI-based allocation (Phase 16), agent creation (Phase 18), multi-process scheduling, per-business quotas, automatic failing of permanently unservable tasks.
