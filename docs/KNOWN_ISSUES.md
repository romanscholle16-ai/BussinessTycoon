# KNOWN ISSUES
| ID | Issue | Status |
|---|---|---|
| KI-001 | Not yet validated on Windows (dev environment is Linux); paths use `node:path` to stay portable | open, verify in Phase 22 |
| KI-002 | Server has only a health endpoint; no auth | by design until Phase 20 |
| KI-003 | `node:sqlite` vs better-sqlite3 | resolved in Phase 2 (D-015) |
| KI-005 | Client shows MOCK data only; no live API yet | by design until Phases 2–5 |
| KI-006 | Not tested on a real Android device or Windows; PWA install prompt needs HTTPS or localhost (LAN http will not offer install) | verify in Phase 22 |
| KI-007 | Lab prototypes (client/public/lab) duplicate code and are unmaintained | keep for reference; delete when no longer needed |
| KI-008 | `node:sqlite` prints an ExperimentalWarning on Node 22 (use `--no-warnings` to hide); API may change in later Node versions | accepted; isolated in database.js |
| KI-009 | Client still shows mock data; nothing reads the database yet | Phase 3+/5 |
| KI-010 | No automated backups, restore tooling, or corruption recovery yet | BACKLOG (Phase 19/24) |
| KI-011 | Demo rows cannot be deleted individually (append-only tables); use `db:reset` in dev | by design |
| KI-012 | Not tested on Windows (file locking / WAL on network drives untested); keep the data dir on a local disk | verify in Phase 22 |
| KI-013 | Agent OS runs one task at a time per agent; handlers run in-process (a handler that ignores AbortSignal cannot be killed, only abandoned) | Phase 4/19 |
| KI-014 | Stale-agent/timeout/lease handling detects and releases tasks but does not restart or replace agents | Phase 4/19 |
| KI-015 | XP/reputation/level rules are placeholders | Phase 13 |
| KI-016 | UI still on mock data; demo agents/tasks are visible only through the API | Phase 5 |
| KI-017 | Existing dev databases keep the old Phase 2 mock agents (migrated to the new states); `npm run db:reset` for a clean demo set | dev only |
| KI-018 | Time-based tests use short real timers (≤ ~100 ms); a heavily loaded machine could make them slow | monitor |
