# MASTER PLAN

## Purpose
Autonomous Tycoon is a Windows-hosted, internet-connected autonomous-business platform presented through a 32-bit futuristic 2D tycoon game. The game is the control, visualization and progression layer for REAL autonomous online businesses. The user interacts mainly from an Android phone over Wi-Fi via a responsive web client/PWA (no APK initially).

## Businesses (initial four)
1. Etsy / Print-on-Demand Factory
2. Game Asset Factory
3. Affiliate Publishing Network
4. Fiverr Creative Studio
Details: BUSINESS_SPECIFICATIONS.md.

## Locked requirements
- One shared Agent Operating System (not four separate automations).
- Provider abstraction; never hard-code one AI provider. GPT Images 2.5 preferred initial image provider, backups later.
- Windows 10/11 production target; client is a responsive web app/PWA.
- Bootstrap budget $100. Approval: $0–5 auto; $5–25 auto within configured rules; $25+ human approval. Must be configurable.
- Human escalation for dangerous, legally significant or account-threatening situations.
- No copying of protected artwork; no uncontrolled spam.
- Eventually: 24/7 operation, auto-start, persistent queues, crash/internet/provider/browser/task recovery, emergency stop.
- Full audit/observability for every meaningful operation.
- No real credentials exist; none are required until late phases.

## Long-term architecture
Android phone → (Wi-Fi) → responsive web/PWA client → Windows server → Supervisor → Agent OS → four business engines. Engines share research, tasks, AI provider access, browser/API automation, logging, finance, analytics, recovery, safety, progression. See ARCHITECTURE.md.

## Roadmap
26 fixed phases (0–25) in PHASES.md; progress in CHECKLIST.md; handoff in CURRENT_STATE.md.

## Working method
Strictly one authorized phase at a time. See ../AGENTS.md.
