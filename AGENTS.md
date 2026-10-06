# Development-Agent Rules (Claude, Freebuff, or any agent)

1. Read `docs/CURRENT_STATE.md` FIRST, then `docs/CHECKLIST.md` and the relevant phase in `docs/PHASES.md` and specs.
2. Work ONLY inside the currently authorized phase. Do not start the next phase; stop after the authorized phase.
3. Do not invent phases or change the 26 predefined ones. Out-of-phase ideas go to `docs/BACKLOG.md`.
4. Do not redesign the master architecture; record changes in `docs/DECISIONS.md`.
5. Don't ask unnecessary questions; decide minor details yourself. Ask only for genuine blockers.
6. Minimize token usage: avoid repeated full-project exploration and speculative refactors.
7. Use targeted, bounded tests (`npm run test:smoke`); never run commands that can hang indefinitely.
8. Never commit secrets (.env, keys, tokens). Phase work needs no real credentials unless a phase states otherwise.
9. Update docs: CURRENT_STATE.md, CHECKLIST.md, project_state.json, CHANGELOG.md, KNOWN_ISSUES.md as relevant.
10. Report exact completion in the required report format; never claim anything unverified.
11. Commit completed work to Git with a clear message.
