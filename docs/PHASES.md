# PHASES

Predefined, fixed list of 26 phases. Do not add, remove or reorder. Later-phase ideas go to BACKLOG.md.

Status vocabulary: `not started`, `in progress`, `completed`, `blocked`, `deferred`.

## PHASE 0 — Foundation & Project Control
- Scope: Repo structure, docs, state tracking, config, smoke test, Git.
- Acceptance: Docs complete; smoke test passes; committed.
- Status: completed

## PHASE 1 — Game Client
- Scope: Responsive PWA: 32-bit futuristic bird's-eye map, pan/zoom/touch, HQ + 4 business buildings (mock data).
- Acceptance: Runs on Android browser; pan/zoom smooth; installable PWA; no real backend data required.
- Status: not started

## PHASE 2 — Database
- Scope: SQLite schema, migrations, repositories for core entities.
- Acceptance: Migrations apply cleanly from empty; repository tests pass.
- Status: not started

## PHASE 3 — Agent Operating System
- Scope: Shared agent runtime: roles, state, permissions, task interface, persistence.
- Acceptance: Agents register, execute stub tasks, persist state; one OS shared by all businesses.
- Status: not started

## PHASE 4 — Supervisor
- Scope: Scheduler, task allocation, priorities, budgets, escalation (no agent creation yet).
- Acceptance: Supervisor schedules and recovers stub tasks; priority and budget rules enforced.
- Status: not started

## PHASE 5 — Observability
- Scope: Structured logs, event timeline, task/agent history, audit trail, health.
- Acceptance: Every task emits events with IDs; timeline queryable via API.
- Status: not started

## PHASE 6 — AI Providers
- Scope: Provider abstraction (Claude, Freebuff, OpenAI, Ollama), failover, image provider (GPT Images 2.5 preferred).
- Acceptance: Swap provider by config; failover tested with fakes; no hard-coded provider.
- Status: not started

## PHASE 7 — Research Engine
- Scope: Shared research: demand, competition, trends, gaps.
- Acceptance: Produces structured opportunity reports from sandboxed sources.
- Status: not started

## PHASE 8 — Etsy
- Scope: Etsy/POD business engine: research→design→IP check→POD select→listing→monitor.
- Acceptance: End-to-end in sandbox mode; IP/similarity gate blocks copies.
- Status: not started

## PHASE 9 — Game Assets
- Scope: Game asset business engine (2D assets; no VFX/audio/music).
- Acceptance: Asset pack pipeline works in sandbox with QA gate.
- Status: not started

## PHASE 10 — Affiliate
- Scope: Affiliate publishing network engine.
- Acceptance: Opportunity→program→content→publish→track in sandbox; anti-spam controls enforced.
- Status: not started

## PHASE 11 — Fiverr
- Scope: Fiverr studio engine incl. order handling and escalation.
- Acceptance: Order lifecycle simulated; risky cases escalate to human.
- Status: not started

## PHASE 12 — Finance
- Scope: Revenue/cost/profit/ROI tracking, budget approval tiers.
- Acceptance: Ledger accurate; $0-5 auto, $5-25 rules, $25+ human approval enforced.
- Status: not started

## PHASE 13 — Progression
- Scope: XP, agent levels, reputation, leaderboards.
- Acceptance: Progression derived from real events; shown in game.
- Status: not started

## PHASE 14 — Quests + Upgrades
- Scope: Quests, missions, unlockable upgrades, building upgrades.
- Acceptance: Quests/upgrades persist and gate real capabilities.
- Status: not started

## PHASE 15 — Automation
- Scope: Browser/API automation layer.
- Acceptance: Recoverable browser sessions; legitimate automation only.
- Status: not started

## PHASE 16 — Resource Optimization
- Scope: Cost/compute/provider optimization.
- Acceptance: Measured cost reduction without quality loss.
- Status: not started

## PHASE 17 — Self-Improvement
- Scope: Controlled self-improvement loop.
- Acceptance: Changes are tested, reversible, and audited.
- Status: not started

## PHASE 18 — Agent Creation
- Scope: Candidate agent creation, test, compare, promote, retire.
- Acceptance: Candidates evaluated before promotion; retirement works.
- Status: not started

## PHASE 19 — Reliability
- Scope: 24/7 operation, crash/internet/provider/browser recovery.
- Acceptance: Fault-injection tests pass.
- Status: not started

## PHASE 20 — Security / Human Control
- Scope: Secrets handling, auth, approvals, emergency stop.
- Acceptance: Emergency stop halts all agents; approvals enforced; audit complete.
- Status: not started

## PHASE 21 — Full Integration
- Scope: All pieces integrated end to end.
- Acceptance: Four businesses run under Supervisor with live game view.
- Status: not started

## PHASE 22 — Phone / Windows Deployment
- Scope: Windows service/auto-start, LAN access from Android.
- Acceptance: Survives reboot; phone connects over Wi-Fi.
- Status: not started

## PHASE 23 — Real-World Sandbox
- Scope: Limited real-world trials with tiny budgets.
- Acceptance: Real small-scale actions succeed under approval limits.
- Status: not started

## PHASE 24 — Production Readiness
- Scope: Hardening, backups, docs, runbooks.
- Acceptance: Readiness checklist signed off.
- Status: not started

## PHASE 25 — Autonomous Operation
- Scope: Continuous autonomous operation.
- Acceptance: Sustained unattended operation meeting targets.
- Status: not started
