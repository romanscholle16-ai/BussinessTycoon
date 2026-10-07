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
| KI-019 | Tasks that no agent may run (e.g. needs a disabled capability) stay queued forever (one `task.skipped` decision) until a deadline cancels them | Phase 20 (approvals) |
| KI-020 | A stale agent running a handler that ignores AbortSignal is abandoned, not killed; its task may run again concurrently with the abandoned handler (demo handlers are abortable) | Phase 19 |
| KI-021 | Supervisor is single-process; lock lease (15 s) means a hung-but-alive instance is only displaced after the lease expires | by design |
| KI-022 | Only the HQ panel shows live Supervisor data; the rest of the UI is mock until Phase 5 | Phase 5 |
| KI-023 | `maxEstimatedCostPerCycleMinor` uses optional task estimates only; there is no real cost accounting yet | Phase 12 |
| KI-024 | Events are never pruned; the table grows without bound (indexes keep queries fast: see DATABASE_SPECIFICATION) | retention policy in BACKLOG (Phase 24) |
| KI-025 | `error.code`/`retryable` are inferred from the `code: message` convention and current task state; free-text errors show `code: null` | acceptable until a typed error taxonomy exists |
| KI-026 | Health `events` rule counts error events, so a burst of ordinary demo task failures can mark the system degraded for 15 minutes | by design (thresholds configurable) |
| KI-027 | UI polls every 5 s and does not stream; the timeline can lag up to 5 s | SSE later |
| KI-028 | Per-agent windowed metrics come from `tasks`; agent counters in `agents.metrics_json` are all-time only | acceptable |
| KI-029 | Dashboard KPIs, towers, finance, quests and business tabs are still mock (labelled) | later phases |
| KI-030 | **No live provider test was possible**: no ANTHROPIC_API_KEY/OPENAI_API_KEY and no Ollama server exist in this environment; adapters are verified against request/response doubles that mirror the documented wire formats (plus a real refused local connection) | verify with real credentials/servers before relying on them |
| KI-031 | Provider adapters speak raw HTTP; wire formats can drift (e.g. new Claude model parameter rules); sampling parameters are omitted for models known to reject them | adapter-local fixes |
| KI-032 | Built-in Claude prices are a dated snapshot (2026-09-25); override `ai.providers.claude.pricing` when prices change | config |
| KI-033 | Pre-call input size is estimated at 4 characters per token; real counts come only from the provider response | by design |
| KI-034 | Provider state (breaker, rate limits, stats) is in memory and resets on restart | acceptable |
| KI-035 | An Agent OS retry of an AI task is a new paid call; there is no cross-attempt budget yet | Phase 12 |
| KI-036 | OpenAI-compatible structured output uses `json_object` on non-OpenAI endpoints; schema is not enforced there | adapter limitation |
| KI-037 | Freebuff is not integrated | needs a documented API |
| KI-038 | **No live discovery provider was tested**: no keyless public search API is integrated and none is hardcoded; discovery is verified with deterministic mocks and a JSON-search double. A live *retrieval* smoke test (`https://example.com/`) succeeded through the safe retriever | configure `RESEARCH_SEARCH_URL` (e.g. SearXNG) |
| KI-039 | Evidence extraction is rule-based (keyword-matching sentences, first number per sentence); it can miss or mis-scope claims, and units like "3.5 million USD" lose the currency | later improvement / AI assist |
| KI-040 | Conflict detection covers numeric values with identical units only; contradictory text claims are not detected | backlog |
| KI-041 | Pages that need JavaScript render nothing useful (limitation is recorded on the source); no PDF support | by design |
| KI-042 | Source type is a heuristic (TLD/host shape/provider hint), so most sources are `unknown`; quality still reflects content factors | by design |
| KI-043 | No automatic pruning of old research runs/page text | operator/Phase 24 |
| KI-044 | Retrieval is sequential (one page at a time) | acceptable; keeps load bounded |
| KI-045 | Near-duplicate detection uses shingle overlap only; paraphrased/syndicated rewrites are not detected | by design |
| KI-046 | An Agent OS retry resumes a run, but a retry after a crash inside an AI call may repeat that call once (`done` flag is set after the call returns) | acceptable |
