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
