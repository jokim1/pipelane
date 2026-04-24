# Repo Guidance

Last reviewed: 2026-04-23
Refresh cadence: 30 days or 50 commits
Drift-hint threshold: 20 commits / 30 days
Owners: jokim1

Pipelane is the release-pipeline kit consumed by downstream repos via
`pipelane:setup`. This file captures the repo-specific invariants that
`/fix` should honor when applying findings to pipelane's own source — the
dogfood reference, not the default scaffold. Keep it filled in; it is the
mirror of what we ask every consumer repo to maintain.

## What this project is

Pipelane is a release-cockpit CLI + template kit. It ships as an npm
package with a zero-runtime-deps design: every consumer repo inherits the
same slash commands (`/pr`, `/merge`, `/deploy`, `/smoke`, `/fix`, etc.)
plus a rendered `CLAUDE.md` operator contract. Consumers are live
production repos; regressions in the kit propagate everywhere on the next
`pipelane:setup`. Backwards compatibility for already-installed consumers
is load-bearing. "Has real users" applies — assume downstream pain on
every breaking change.

## Project invariants

Rules true for this repo only. `/fix` follows these even when a "cleaner"
approach seems available — invariants exist because past attempts at the
cleaner approach failed.

- **Template/consumer boundary is marker-gated.** Every file under
  `templates/.claude/commands/` opens with `<!-- pipelane:command:<name> -->`
  and ends with `<!-- pipelane:consumer-extension:start -->` /
  `<!-- pipelane:consumer-extension:end -->`. Consumer hand-edits inside
  the extension pair must survive re-sync. Enforced by `syncConsumerDocs`
  in `src/operator/docs.ts` via `captureManagedExtensionsByCommand` +
  `injectConsumerExtension`.
- **`MANAGED_EXTRA_COMMANDS` vs `WORKFLOW_COMMANDS` split is structural.**
  `WORKFLOW_COMMANDS` get aliased per consumer (`aliases.pr` → `/pr`).
  `MANAGED_EXTRA_COMMANDS` have fixed filenames (`pipelane.md`, `fix.md`)
  and are never aliased. Crossing the two lists breaks alias resolution or
  filename-collision detection. Enforced by
  `assertNoClaudeCollisions` + `desiredCommandFiles` in `docs.ts`.
- **Every `MANAGED_COMMANDS` member must have `LEGACY_CLAUDE_SIGNATURES`
  with `length >= 2`.** Enforced by the structural test at
  `test/pipelane.test.mjs:2171`. Signatures cover the pre-marker-upgrade
  path; dropping one below two breaks in-place upgrades on old consumer
  files.
- **`$ARGUMENTS` subcommand routing is first-token-equals, never
  starts-with.** `/pipelane update-this-thing` must NOT route to the
  `update` subcommand. `fix.md` and `pipelane.md` encode this explicitly.
  Re-check on every subcommand addition.
- **`CLAUDE.md` and `REPO_GUIDANCE.md` are consumer-owned forever.**
  Pipelane writes them once in `setupConsumerRepo` (docs.ts:555) when
  absent, never re-syncs. `pipelane:sync-docs` must never overwrite
  either file.
- **Atomic state writes.** `writeJsonFile` in `state.ts` uses tmp+rename;
  any new persisted state must use the same primitive. Non-atomic writes
  leave consumer repos with corrupt state on crash. Open follow-up in
  `docs/TODO.md` — Batch 2.
- **Symlinked `node_modules` warns on every setup.** Prevents `npm ci`
  wipe when working in a worktree that symlinks back to the main repo's
  `node_modules`. Added in 9d71d66; do not weaken the warning.
- **`renderTemplate` substitutes `{{PLACEHOLDER}}` only from a closed
  replacements map.** Every new template variable must land in the
  replacements object in `docs.ts:135`. Missing substitutions ship to
  consumer repos as literal `{{VAR}}`.
- **Probe freshness is load-bearing for the release gate.** Staging
  probes older than 24h flip the release lane fail-closed. Do not extend
  the freshness window without re-reading `docs/RELEASE_WORKFLOW.md`.

## Tech-stack rules

### Node / TypeScript

- Node version pinned at `>=22.0.0` in `package.json`. Don't use APIs
  that require newer.
- Zero runtime dependencies. `package.json` has no `dependencies`, only
  `devDependencies`. New deps need explicit review — the value
  proposition of pipelane is "one tiny install."
- Tests use `node --test` (not jest, not vitest). Test file lives at
  `test/pipelane.test.mjs`. Use `.mjs` ESM, `node:assert` for assertions.
- Build compiles TS → `dist/`. `bin/pipelane` prefers `dist/cli.js`,
  falls back to `src/cli.ts` for in-repo development. Don't break that
  fallback.
- All source modules end in `.ts` and import other modules with explicit
  `.ts` extensions (ESM resolution). Don't drop extensions.

### Templates

- Live under `templates/`. Kit root resolves via `templatePath` in
  `docs.ts:114`; do not hardcode paths.
- Every command template must include `<!-- pipelane:command:<name> -->`
  on line 1 so `isManagedClaudeCommand` detects it as managed.
- Consumer-extension pair at the end of every command template.
- `{{PLACEHOLDER}}` variables only from the `renderTemplate` replacements
  map — `PROJECT_KEY`, `DISPLAY_NAME`, `BASE_BRANCH`, `ALIAS_*`, etc.

## Deferred / don't-touch list

Tracked in `docs/TODO.md` and various `docs/*_PLAN.md`. `/fix` should
avoid opportunistic changes in these areas and will not surface drift
hints on files listed here.

- **v2.2 Codex dual-install re-scope.** The "just delete
  `codex-install.ts`" framing no longer maps. Needs a fresh scoping pass
  before anything in `src/operator/codex-install.ts`,
  `bootstrap.ts`, `claude-install.ts`, `global-runtime.ts`, or
  `install-source.ts` gets touched. Unfreeze when: the scoping pass
  lands as a plan doc.
- **State integrity hardening batch.** Atomic `writeJsonFile`
  project-wide, probe-state HMAC signing, URL fingerprint for
  config-rotation detection, concurrent `--probe` / `--fix` lock,
  `PIPELANE_DOCTOR_PROBE_TIMEOUT_MS` clamp. Unfreeze when: Batch 2
  starts (`docs/TODO.md`).
- **Rollback discovery / `capDeployHistory` / `findLatestRecord`
  dedup.** Deferred from PR #37 review. Unfreeze when: Batch 3 starts.
- **Stack playbooks.** Permanently dropped per
  `docs/FIX_COMMAND_PLAN.md`. Do not add a
  `templates/extensions/<stack>.md` layer. Unfreeze when: copy-paste
  pain emerges across 3+ real consumer repos (evidence bar).
- **Staleness-check extraction to `pipelane:guidance-status` script.**
  Phase 2 of `/fix` plan. Stays inline in the prompt for Phase 1.
  Unfreeze when: Phase 1 lands and metrics dashboard work begins.

## PR and review strategy

- One task per branch. Prefix `task/<slug>` (human-authored) or
  `codex/<slug>` (agent-authored). `DEFAULT_BRANCH_PREFIX = 'codex/'`
  in `state.ts`.
- One PR per task, merged to `main`. No batch PRs mixing unrelated
  scope.
- Pre-PR checks: `npm test`, `npm run typecheck`, `npm run build`.
  Configured in `templates/project-pipelane.json` `prePrChecks`.
- PR path deny list enforced in `pipelane run pr` before the silent
  `git add -A`: `CLAUDE.md`, `.env`, `.env.*`, `*.pem`, `*.p12`,
  `id_rsa*`, `*.key`. See `DEFAULT_PR_PATH_DENY_LIST` in `state.ts`.
- CI blocks merges on failed PR checks (PR #46).
- Commits are signed (GPG); never skip signing. Never use `--no-verify`
  or `--amend` unless the user explicitly asks.

## Ask-first additions

Beyond the universal `/fix` sensitive-area list. Changes to any of these
surfaces affect every downstream consumer on the next `pipelane:setup`, so
`/fix` emits `[fix] Proposed action — <category>: <line>` before mutating
and proceeds. The heads-up ensures the intended change is visible in the
transcript; no consent gate (section name is legacy).

- **`MANAGED_EXTRA_COMMANDS` or `WORKFLOW_COMMANDS` arrays** in
  `src/operator/state.ts`. Adds/removes/renames ripple through
  collision detection, prune logic, alias resolution, and the Codex
  skill sync. Touching these also requires a matching
  `LEGACY_CLAUDE_SIGNATURES` entry and a template file with the
  `<!-- pipelane:command:<name> -->` marker.
- **`renderTemplate` replacements map** in `src/operator/docs.ts`.
  Adding a new `{{VAR}}` to any template without updating the map ships
  literal `{{VAR}}` to every consumer repo.
- **Consumer-extension marker format.** Changing
  `CONSUMER_EXTENSION_MARKER_START` / `_END` strips consumer hand-edits
  on the next re-sync.
- **`syncConsumerDocs` loop ordering** in `docs.ts:419`. Idempotency
  and marker preservation depend on the capture → prune → render →
  inject sequence. Re-ordering silently breaks consumer edit survival.
- **Probe freshness window / release-gate fail-closed thresholds.**
  Affects every consumer's ability to ship.
- **CI workflow files** (`.github/workflows/*.yml`). Consumer CI
  depends on the template file shapes published through pipelane.

## Drift-hint ignore

Glob patterns for files that naturally churn and should not trigger
post-fix drift hints.

- `package-lock.json`
- `dist/**`
- `.pipelane/state/**`
- `docs/TODO.md`
- `CHANGELOG.md`
- `*.generated.*`
- `test/fixtures/**`
