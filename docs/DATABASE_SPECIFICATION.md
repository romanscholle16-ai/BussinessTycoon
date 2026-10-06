# DATABASE SPECIFICATION (direction; implemented Phase 2)
SQLite file in `runtime/data/` (git-ignored). Numbered SQL migrations in `database/migrations/`, forward-only, tracked in a `schema_migrations` table.

## Core entities (planned)
businesses, agents, agent_state, tasks, task_attempts, events, approvals, providers, provider_usage, ledger_entries, budgets, opportunities, listings/publications, metrics, quests, upgrades, progression (xp/levels/reputation), settings.

## Event record (every meaningful operation)
event_id, timestamp, business, agent, task, action, result, cost, error/retry info, decision info (JSON). Append-only; doubles as audit trail.

## Finance ledger (Phase 12)
Entries typed: revenue, ai_cost, api_cost, marketplace_fee, pod_cost, advertising, refund, other_cost; attributed to business, task and agent. Derived: gross/net profit, margin, ROI, per-task cost, agent contribution. Money stored as integer minor units.

## Principles
Persistent queues; idempotent task handlers; no secrets in DB; migrations tested from empty.
