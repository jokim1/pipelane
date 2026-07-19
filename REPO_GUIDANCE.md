# Repo Guidance

Last reviewed: 2026-07-13
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
same slash commands (`/pr`, `/merge`, `/deploy`, `/fix`, etc.)
plus a rendered `CLAUDE.md` operator contract. Consumers are live
production repos; regressions in the kit propagate everywhere on the next
`pipelane:setup`. Backwards compatibility for already-installed consumers
is load-bearing. "Has real users" applies — assume downstream pain on
every breaking change.

## Current roadmap memory

Review gates are shipped command behavior. Treat
`docs/public/RELEASE_WORKFLOW.md` as the current operator contract, not a future
design note.

Decisions captured through 2026-07-13:

- `/pipelane review setup`, `/pipelane review`, machine-local evidence, and
  `/pr` review display form the shipped review-gate foundation. Superseded
  2026-07 by consent relief: review evidence is informational at `/pr` and
  `/merge` — see "PR and review strategy" below.
- Review gates remain ordered by phase: static, behavioral, AI diff,
  instruction, runtime, then human gates. Cheap deterministic checks run before
  AI review, and fix-first gstack `/review` runs before read-only confirmations.
- Pipelane is a local review/refactor/release runner, not an agent
  orchestrator. Multi-agent fan-out was removed 2026-07; operators bring their
  own orchestration tooling and it must not bypass `/pr`, `/merge`, `/deploy`,
  `/rollback`, or `/clean`.
- Deploy surfaces are consumer-defined. Configured custom names and repo-owned,
  workflow-bound surface contracts must flow through planning, execution,
  readiness, status, and deploy verification without hard-coded allowlists.
- Release-mode delivery infers surfaces from the exact target SHA, fails closed
  on unmapped target files, deploys the merged SHA to staging, and promotes that
  same SHA to production.
- Setup detects existing scripts first (`lint`, `typecheck`, `format:check`,
  `test`, `build`) and warns about missing optional gates instead of inventing
  a toolchain silently.

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
  leave consumer repos with corrupt state on crash. Track any remaining
  state-hardening follow-up in active docs or an issue, not an absent local
  TODO file.
- **State paths and schemas are compatibility contracts.** The default
  state dir and persisted state file shapes are public to installed
  consumers. Renaming a state dir requires a `LEGACY_STATE_DIRS` migration;
  changing persisted state shape requires `STATE_SCHEMA_VERSIONS` /
  `STATE_MIGRATIONS` coverage and versioned reads/writes. Silent fallback
  to default state can bypass release-mode gates on upgraded repos.
- **Symlinked `node_modules` warns on every setup.** Prevents `npm ci`
  wipe when working in a worktree that symlinks back to the main repo's
  `node_modules`. Added in 9d71d66; do not weaken the warning.
- **Preinstall guard hard-blocks `npm ci`/`install` in symlinked
  worktrees.** `scripts/preinstall-guard.cjs` runs from the consumer's
  `package.json:scripts.preinstall` (wired by `pipelane setup`). Aborts
  before npm's reify step touches the symlink. The standalone CJS file
  must stay zero-import so it works when pipelane itself isn't yet
  loadable; the consumer-side wiring uses `existsSync` so it self-no-ops
  on first install. Do not weaken either side.
- **`renderTemplate` substitutes `{{PLACEHOLDER}}` only from a closed
  replacements map.** Every new template variable must land in the
  replacements object in `docs.ts:135`. Missing substitutions ship to
  consumer repos as literal `{{VAR}}`.
- **Probe freshness is load-bearing for the release gate.** Staging
  probes older than 24h flip the release lane fail-closed. Do not extend
  the freshness window without re-reading `docs/RELEASE_WORKFLOW.md`.
- **Target deploy-surface inference is commit-scoped.** A workflow-bound
  contract is resolved from the target SHA, with the configured base as the
  compatibility fallback. Before merge, diff the target against the remote
  base merge-base. Once the remote base equals the merged target, diff the
  target against its first parent; never fall through to a stale local base
  ref. Unmapped target files and unsupported surfaces remain blockers.

## State-resilience invariants

Pipelane state lives at `<commonDir>/<config.stateDir>/`. Three
invariants protect already-installed consumers from silent state loss
when pipelane upgrades. All three are anchored in `src/operator/state.ts`
constants — touching any of them is a contract change.

- **Defaults that govern on-disk paths are public contract.** The
  shipping value of `defaultWorkflowConfig().stateDir`, every
  `*_FILENAME` constant, every `*_DIRNAME` constant, and the migration
  registry are part of the API surface. Renaming any of them is a
  breaking change for every existing consumer — their state still lives
  at the old path, and a silent rename re-initializes them. The 2026-04
  rocketboard incident (mode-state orphaned, mode silently fell back to
  'build') was this class of bug.
- **Renames require a `LEGACY_STATE_DIRS` entry.** When the default
  `stateDir` value changes, the previous value gets prepended to
  `LEGACY_STATE_DIRS` in `state.ts`. `migrateLegacyStateDir` then walks
  the chain on first run and copies orphaned files into the canonical
  dir non-destructively. New `*_FILENAME` renames need a parallel
  migration in the same function. Removing a legacy entry stranded
  consumers — entries are forever, even years after the rename.
- **Every state file carries a `schemaVersion` envelope.** Reads go
  through `readVersionedJsonFile`, which strips the envelope; writes go
  through `writeVersionedJsonFile`, which injects the current version
  from `STATE_SCHEMA_VERSIONS`. A breaking shape change bumps the
  version and registers a migration step at
  `STATE_MIGRATIONS.<kind>[fromVersion]` — never an inline normalizer
  in the loader. The registry is the only place migrations should live.
- **Install-marker semantics distinguish fresh-install from
  regression.** `installed.json` is planted by `ensureStateDir` on
  first save and by `migrateLegacyStateDir` on a successful copy. Its
  presence proves "pipelane has written state at this canonical dir."
  Loaders fall back silently when the marker is absent (true fresh
  install) and warn loudly via stderr when the marker is present but an
  expected file is missing. Don't suppress that warning — it's the
  signal that catches future migration drift before the operator's
  release gate flips silently.

## Tech-stack rules

### Node / TypeScript

- Node version pinned at `>=22.0.0` in `package.json`. Don't use APIs
  that require newer.
- Zero runtime dependencies. `package.json` has no `dependencies`, only
  `devDependencies`. New deps need explicit review — the value
  proposition of pipelane is "one tiny install."
- Tests use `node --test` (not jest, not vitest). `npm test` must go through
  `scripts/run-tests.mjs`, which owns process cleanup and full-suite runner
  safety. Main coverage lives in `test/pipelane.test.mjs`; use `.mjs` ESM and
  `node:assert` for assertions.
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

Tracked here and in active docs under `docs/public/`. Historical target-state
specs live under `docs/archive/` and are not authoritative. `/fix` should avoid
opportunistic changes in these areas and will not surface drift hints on files
listed here.

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
  gets a fresh plan in active docs or an issue.
- **Rollback discovery / `capDeployHistory` / `findLatestRecord`
  dedup.** Deferred from PR #37 review. Unfreeze when: Batch 3 starts.
- **Stack playbooks.** Permanently dropped per prior planning. Do not
  add a `templates/extensions/<stack>.md` layer. Unfreeze when:
  copy-paste pain emerges across 3+ real consumer repos (evidence bar).
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
- Review evidence is informational at `/pr` and `/merge` (2026-07 consent
  relief): the commands show what ran, what's open, and what's stale, and
  proceed. Missing, failed, or pending evidence asks for one recorded
  `--override --reason` consent. Staleness never voids evidence.
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
- **Deploy target and surface resolution.** Changes to
  `deploy-surface-contract.ts`, `target-surface-map.ts`, destination
  planning/execution, target-SHA selection, or workflow dispatch affect which
  consumer code reaches staging and production. Require target-SHA regression
  coverage for both open-PR and post-merge states.
- **CI workflow files** (`.github/workflows/*.yml`). Consumer CI
  depends on the template file shapes published through pipelane.
- **Review gate catalog, gate config schema, or review command adapters.**
  These affect how AI agents review and move production code.
  Changes require matching docs, tests, template updates, and explicit
  static-gates-before-AI-review behavior.

## Drift-hint ignore

Glob patterns for files that naturally churn and should not trigger
post-fix drift hints.

- `package-lock.json`
- `dist/**`
- `.pipelane/state/**`
- `CHANGELOG.md`
- `*.generated.*`
- `test/fixtures/**`
