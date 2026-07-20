# Pipelane Agent Notes

Pipelane is a local review, refactor, and release runner for AI-assisted codebases. It ships a CLI and template kit that downstream repos install via `pipelane setup`, so changes here can affect every consumer the next time they update.

Use `REPO_GUIDANCE.md` as the authoritative deeper reference for invariants, roadmap memory, consumer-compatibility rules, and sensitive areas. Keep this file short and pointer-heavy.

## Quickstart

Verified on 2026-07-20 in this worktree:

- Install dependencies: `npm ci` passed; it also ran the package `prepare` hook, which runs `npm run build`.
- Test suite: `npm test` passed with 787 tests, 787 pass, 0 fail, 0 skipped. It runs only the default manifest in `scripts/run-tests.mjs` (`test/pipelane.test.mjs`, which imports `test/local-state.test.mjs`); `test/run-tests-runner.test.mjs` runs only when `PIPELANE_TEST_FILES` lists it.
- Typecheck: `npm run typecheck` passed.
- Build: `npm run build` passed.
- Lint: no `lint` script is defined in `package.json`.

## Gotchas

- Do not edit `templates/AGENTS.md` when changing guidance for this repo. That file is shipped template content for consumers.
- `CLAUDE.md` is a tracked symlink to this file so Claude-based tools read the same guidance. Keep the symlink target as `AGENTS.md`.
- `dist/` is build output from TypeScript plus copied dashboard assets; regenerate it with `npm run build` instead of hand-editing.
- The package has zero runtime dependencies. New runtime deps are a deliberate product decision; see `REPO_GUIDANCE.md`.
- Command templates under `templates/.claude/commands/` are managed consumer-facing surfaces. Preserve marker and consumer-extension conventions described in `REPO_GUIDANCE.md`.
- Pipelane is not an agent orchestrator; multi-agent fan-out was removed. Check current command handlers before describing or restoring old orchestration behavior.

## Entry Points

- `src/cli.ts` - top-level CLI dispatcher for setup, install, update, dashboard/board, review, and `run`.
- `src/operator/index.ts` - operator command dispatcher for `new`, `adopt`, `resume`, `pr`, `merge`, `deploy`, `clean`, `review`, `status`, `doctor`, `rollback`, `api`, and related commands.
- `src/operator/commands/` - individual command handlers.
- `src/operator/docs.ts` - setup and consumer documentation/template rendering.
- `src/operator/state.ts` and `src/operator/local-state.ts` - workflow config, persisted state, task locks, parsing, and managed local-state protection.
- `src/dashboard/` - local Pipelane Board server and static UI.
- `templates/` - files shipped into consumer repos.
- `test/` - Node test suite; `test/pipelane.test.mjs` carries most behavioral coverage.
- `scripts/run-tests.mjs` - canonical test runner used by `npm test`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
