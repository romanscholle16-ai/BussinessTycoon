# DECISIONS
| ID | Decision | Reason | Status |
|---|---|---|---|
| D-001 | Node.js 22 + ESM JavaScript, no TypeScript build in Phase 0 | Installed, Windows-friendly, zero build step. May adopt JSDoc types or TS later via decision entry | accepted |
| D-002 | Zero dependencies in Phase 0 | Minimal complexity; node:test and node:http suffice | accepted |
| D-003 | SQLite as database | Single-file, no service to run on Windows, adequate for single-host load | accepted |
| D-004 | Web/PWA client with Canvas 2D | Works in Android browser, no APK | accepted |
| D-005 | Provider adapter abstraction; sandbox fakes for development | No credentials available; avoids lock-in | accepted |
| D-006 | Config layering with secrets only via env | Safe git hygiene | accepted |
| D-007 | Server binds 127.0.0.1 by default | Secure default; LAN opt-in | accepted |
| D-008 | Playwright for future browser automation | Stable, Windows support | proposed (Phase 15) |
| D-009 | 26 phases fixed; new work → BACKLOG.md | Prevent scope drift | locked |
| D-010 | Docs in /docs are the source of truth; `docs/project_state.json` mirrors state | Agent-resumable | accepted |
| D-011 | UI direction = Design Lab concept 9 "Iso Command Hub" (user's choice) | User reviewed 10 concepts and picked it | locked |
| D-012 | Client is vanilla ES modules + Canvas 2D, no build step, no framework | Zero dependencies; Windows/Android friendly | accepted |
| D-013 | Client reads a single snapshot object (mock now, API later) | Lets Phase 2+ swap data without UI rewrite | accepted |
| D-014 | `npm test` uses `tests/*.test.js` glob (Node 22 does not accept a directory argument) | Phase 0 script was broken | accepted |
