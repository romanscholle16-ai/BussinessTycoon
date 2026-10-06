# KNOWN ISSUES
| ID | Issue | Status |
|---|---|---|
| KI-001 | Not yet validated on Windows (dev environment is Linux); paths use `node:path` to stay portable | open, verify in Phase 22 |
| KI-002 | Server has only a health endpoint; no auth | by design until Phase 20 |
| KI-003 | `node:sqlite` vs better-sqlite3 undecided | deferred to Phase 2 |
| KI-005 | Client shows MOCK data only; no live API yet | by design until Phases 2–5 |
| KI-006 | Not tested on a real Android device or Windows; PWA install prompt needs HTTPS or localhost (LAN http will not offer install) | verify in Phase 22 |
| KI-007 | Lab prototypes (client/public/lab) duplicate code and are unmaintained | keep for reference; delete when no longer needed |
