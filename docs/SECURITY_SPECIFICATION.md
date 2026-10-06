# SECURITY SPECIFICATION (direction)
- No secrets in Git: `.env`, `config/local.json`, keys ignored; only `.env.example` committed. Credentials via env vars/OS credential store.
- Server binds 127.0.0.1 by default; LAN exposure requires explicit config and, from Phase 20, an auth token.
- Spend control: $0–5 auto, $5–25 auto within configured rules, $25+ human approval; enforced in code (Phase 12/20).
- Human escalation for legal, account-threatening or dangerous situations.
- Emergency stop halts all agents and outbound actions (Phase 20).
- Default-deny agent permissions; audit trail append-only. Phase 3: external capabilities (publish/spend/communicate/configure) cannot be granted; agent configs and task payloads reject credential-like keys; API validates IDs/bodies and returns no paths or secrets; demo endpoints are disabled in production.
- Compliance: no copying protected IP, no spam, obey marketplace ToS; QA/IP checks gate publishing.
- Treat all fetched web content as untrusted input.
- Logs must redact secrets.
