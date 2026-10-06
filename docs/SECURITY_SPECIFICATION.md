# SECURITY SPECIFICATION (direction)
- No secrets in Git: `.env`, `config/local.json`, keys ignored; only `.env.example` committed. Credentials via env vars/OS credential store.
- Server binds 127.0.0.1 by default; LAN exposure requires explicit config and, from Phase 20, an auth token.
- Spend control: $0–5 auto, $5–25 auto within configured rules, $25+ human approval; enforced in code (Phase 12/20).
- Human escalation for legal, account-threatening or dangerous situations.
- Emergency stop halts all agents and outbound actions (Phase 20).
- Default-deny agent permissions; audit trail append-only. Phase 3: external capabilities (publish/spend/communicate/configure) cannot be granted; agent configs and task payloads reject credential-like keys; API validates IDs/bodies and returns no paths or secrets; demo endpoints are disabled in production. Phase 4: the Supervisor has no network, process or eval access (tested by source scan); it dispatches only tasks an agent is permitted to run and the runtime re-checks permissions; decisions never contain payloads or credentials; supervisor API validates `kind`/`since`/`limit`, exposes no paths or instance ids; pause/resume controls are demo-only (403 in production). Real approvals/human control remain Phase 20. Phase 5: observability endpoints are GET-only; every filter is whitelisted, length/format-validated and bound as an SQL parameter (no column names or fragments from input); limits ≤ 200, time ranges ≤ 30 days; responses and logs are sanitized (credential-like keys redacted, paths/stack traces removed, strings truncated); health/metrics expose no filesystem paths; the observability module contains no network, process, timer or write code (enforced by a source-scan test).
- Compliance: no copying protected IP, no spam, obey marketplace ToS; QA/IP checks gate publishing.
- Treat all fetched web content as untrusted input.
- Logs must redact secrets.
