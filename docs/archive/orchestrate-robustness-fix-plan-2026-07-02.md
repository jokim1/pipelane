# Orchestrate Robustness Fix Plan

Date: 2026-07-02
Status: Draft, aligned with the eng-review test-plan artifact

Primary reviewed artifact:
`/Users/josephkim/.gstack/projects/jokim1-pipelane/josephkim-codex-orchestrate-delivery-worktree-routing-eng-review-test-plan-20260702-114015.md`

## Current Authority

This implementation plan covers v1a and v1a2 only.

- v1a unblocks the traced docs-only baseline failure with clean-source preflight metadata, run-level baseline profile inference, strict docs-only rules, profile-aware gate skipping, analyzer write-scope emission, and operator-visible skip reasons.
- v1a2 adds the implementation-baseline audit path: baseline command execution, dependency provisioning, manual `baseline accept`, targeted replacement gates, per-slice `bypass-baseline-red`, docs-only escape reruns, and interrupted-baseline recovery.
- v1b dirty-source snapshots, source refs, worker leases, orphan-ref cleanup, schema markers, rollback drains, ignored-output telemetry, watched-output cleanup, and command isolation are deferred to a separate accepted plan.
- Until v1b exists, dirty parent worktrees hard-block before planning or dispatch with a commit/stash message. `/orchestrate` must not advertise `--acknowledge-dirty-source`.

The eng-review test plan is the acceptance artifact. This file is implementation guidance and must not contradict that artifact.

## Problem

The run `orchestrate-20260701230712-c0eeeb0f` exposed brittle behavior in `/orchestrate`:

1. A docs-only Phase 0 baseline artifact was treated like an implementation slice.
2. The review gate then ran unscoped full-suite gates against a docs-only artifact.
3. The repository full `npm test` suite was already red, and build output could change later test behavior.
4. The resulting failure looked like a slice failure even though the real issue was orchestration semantics.

The fix is to make source state, baseline evidence, docs-only classification, and baseline-red handling explicit. It is not to hide the red suite.

## What Already Exists

- Reuse the existing orchestration ledger and slice records.
- Reuse `buildReviewRunRecord`, `collectChangedFiles`, `skipReasonForGate`, `whenChanged`, and the shared review-gate catalog/order plumbing.
- Reuse current worktree creation, status/analyze output, finalize/cleanup flows, and run mutation locking.
- Reuse `slices[].requestedFiles` only as a conservative fallback input. Add persisted `slices[].plannedPathScope` because the current ledger has no canonical pre-dispatch write-scope field.
- Current ledger reader behavior is already additive-field tolerant: `isOrchestrationRunRecordShape` validates required run fields and slice shape but does not reject unknown run/slice keys. Add read and read-mutate-write regression coverage before relying on new fields.
- Reuse the existing `gstack-review` gate for docs-only AI review by annotating it with docs-safe profile/path metadata. Do not add a new reviewer role, prompt, model behavior, or worker.

## Not In Scope

- Fixing the already-red full `npm test` suite.
- Changing standalone `/pipelane review` behavior.
- Changing AI review model behavior.
- Reordering implementation command gates in v1a. Test-before-build, `requiresBuildOutput`, and command-worktree isolation belong to a dist-output compatibility follow-up.
- Ignored-output telemetry, watched-output cleanup, automatic resets, or sandboxing command outputs.
- Dirty-source acknowledgement, source bundle materialization, source snapshot refs, orphan-ref cleanup, worker leases, and rollback drains.
- Durable/config-level known-red waivers, automatic known-red failure matching, or failure-signature normalization.
- Leaving analyzer write-scope separation to a later milestone. Analyzer `plannedPathScope[]` emission is in v1a scope and must land before docs-only baseline inference.

## Runtime Lifecycle

Authoritative sequence:

```text
create run
-> source/dirty preflight before planning
-> outline/plan
-> operator approve scope
-> capture frozen reviewGateSnapshot from the shared command-gate catalog before profile filtering
-> baseline preflight from approved plannedPathScope
-> prepare worktrees
-> dispatch workers
-> review lock computes all slice reviewProfile values
-> gate selection/execution
-> finalize/cleanup
```

Lock scope:

- Run creation/source preflight holds the run mutation lock while writing `sourceSnapshot`.
- Approval writes approved slices and `plannedPathScope`.
- Gate snapshot capture writes `reviewGateSnapshot`.
- Baseline preflight holds the run mutation lock only while mutating baseline state. V1a2 command execution releases the lock while the command runs and reacquires it to append evidence.
- Review holds the run mutation lock while computing profiles and appending gate evidence.
- Finalize holds the run mutation lock while changing terminal state.

## v1a Rules

- Dirty predicate: dirty when any tracked staged diff, tracked unstaged diff, or untracked non-ignored file exists. Ignored files do not count.
- Clean parent source records `sourceSnapshot.status='clean'`, `sourceSnapshot.headSha=HEAD`, `sourceSnapshot.reviewBaseRef=sourceSnapshot.headSha`, `sourceSnapshot.changedFiles=[]`, and no dirty-source snapshot fields.
- Dirty parent source hard-blocks before planning/dispatch with an actionable commit/stash message. No snapshot ref, source bundle, or worker worktree is created.
- Legacy or in-flight runs without `sourceSnapshot.reviewBaseRef` use the shared base resolver and `implementation` profile. Prefer `origin/<baseBranch>`, fall back to local `<baseBranch>` with a warning when a merge-base exists, and block when neither ref resolves.
- `baseBranch` is persisted at run creation. Resolution order is explicit CLI `--base-branch`, `orchestrate.baseBranch`, `review.baseBranch`, successful `gh pr view --json baseRefName`, `origin/HEAD`, `main`, then `master`. Later review/baseline steps use only the persisted value.
- Slice `reviewProfile` inference computes the slice worktree diff relative to `sourceSnapshot.reviewBaseRef`.
- Baseline profile source/base delta does not use `sourceSnapshot.reviewBaseRef`; it computes paths changed from `merge-base(sourceSnapshot.headSha, resolvedBaseRef)` to `sourceSnapshot.headSha`. Base refs are used as-is without implicit fetch.
- `slices[].plannedPathScope` means paths the slice intends to create, modify, delete, or rename. Read-only context files are excluded.
- Analyzer-provided `slices[].plannedPathScope[]` is authoritative when valid and non-empty. Existing `slices[].requestedFiles[]` is only a conservative fallback. Because `requestedFiles[]` has no write/read signal, every requested file is treated as a write target; a requested code path forces `implementation`.
- Analyzer write-scope separation lands before docs-only baseline inference. The analyzer must either emit valid `plannedPathScope[]` for write targets or omit it and accept conservative `requestedFiles[]` fallback behavior; it must not mix read-only context paths into `plannedPathScope[]`.
- If any approved slice has missing, empty, invalid, or unknown `plannedPathScope`, baseline preflight uses `implementation`.

## Docs-Only Classification

Classification uses path records, not just final filenames.

- Added/modified paths classify by their path.
- Deleted paths classify by the deleted path.
- Renamed/copied paths classify by both old and new paths.
- Empty diffs and inherited-only diffs default to `implementation`.

A path set is `docs-only` only when at least one classification path exists and every path is docs-safe:

- Under `docs/` with extension `.md`, `.mdx`, `.txt`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, or `.pdf`.
- Exactly `README.md`.
- Exactly `CHANGELOG.md`.
- A root-level `*.md` or `*.mdx`.

Any changed path under `src/`, `bin/`, `scripts/`, `templates/`, `test/`, package manifests or lockfiles, TypeScript config, orchestration/review config, CI config, or mixed docs/code paths is `implementation`.

Code/config files under `docs/`, including `*.js`, `*.ts`, `*.tsx`, `*.mjs`, `*.cjs`, `*.py`, `package.json`, lockfiles, and executable scripts, also force `implementation`.

The same `classifyDocsSafePathRecords()` helper must feed both `baselinePreflight.profile` from approved planned path scope and `slices[].reviewProfile` from actual slice diffs.

## Gate Behavior

- `baselinePreflight.profile='docs-only'` only when every approved slice's `plannedPathScope` and every source/base delta path satisfy the strict docs-safe rule.
- For docs-only baseline preflight, v1a records unscoped full-suite baseline commands as skipped with explicit docs-only reasons. It does not execute baseline commands or dependency provisioning.
- A slice may skip unscoped full-suite gates only when both profiles are docs-safe: run-level `baselinePreflight.profile='docs-only'` and slice-level `reviewProfile='docs-only'`.
- When both profiles are docs-only, skip unscoped full-suite gates such as `npm test`, `npm run build`, and `npm run typecheck` with reason `docs-only profile, gate has no matching whenChanged path`.
- Gates whose `whenChanged` matches docs paths still run.
- Non-command AI/code gates run for docs-only only when they declare `profiles: ['docs-only']` or have matching docs `whenChanged`; otherwise skip with reason `docs-only profile, AI/code gate not scoped to docs`.
- Gate `profiles` are additive, not an allowlist. Adding docs-only metadata to `gstack-review` must not narrow or disable its existing implementation-slice behavior.
- Status/analyze output and the finalize summary must list skipped full-suite gate ids/commands with their skip reasons for docs-only runs.
- If `baselinePreflight.profile='implementation'` from the start, v1a preserves the existing implementation dispatch/review path. It does not apply docs-only skips and does not block just because implementation baseline execution is v1a2.
- If a run starts docs-only and later a slice diff escapes docs-safe paths, v1a hard-blocks review before per-slice gates with `implementation-baseline-required`.
- A run blocked at review with `implementation-baseline-required` is considered inactive for `finalize --abandon` once no slice worker is running. Default abandon/finalize preserves escaped slice worktrees and prints their paths.
- Escaped worktree reclamation is explicit opt-in after paths are visible. `finalize --abandon --purge-worktrees --reason <text>` may remove listed escaped slice worktrees only after the abandon report includes their paths and records the purge reason/result.

## v1a2 Rules

- Implementation baseline commands run in a dedicated baseline temp worktree checked out at `sourceSnapshot.reviewBaseRef` (`headSha` for clean source), never in the parent checkout.
- Baseline command execution must not hold the run mutation lock across the whole command. The coordinator acquires the lock to mark command/run state, releases it while the command runs, then reacquires it to append evidence and choose the next command.
- Interrupted baseline preflight is recoverable. If re-invocation sees `baselinePreflight.status='running'` with no active run mutation lock and no completed evidence for the running command, it records an interrupted-attempt note and reruns the incomplete command idempotently from the same `sourceSnapshot.reviewBaseRef` and `reviewGateSnapshot`.
- Baseline dependency provisioning reuses the existing shared `node_modules` link path. If dependencies are unavailable, baseline preflight records `dependency_provisioning_failed` rather than a fake test failure.
- Baseline command failures block dispatch by default.
- `orchestrate baseline accept --run-id <id> --command-id <id> --reason <text>` requires a nonblank reason and records `acceptedFailure`. Accepted baseline failures set status `accepted_failed`, not `passed`; original exit code, timing, timeout flag, and summary path remain unchanged.
- Baseline acceptance is per-run/per-command only. A new run must accept or fix the failure again.
- A review command gate matches an accepted baseline command only when `(reviewGateSnapshot.gates[].baselineCommandId ?? reviewGateSnapshot.gates[].id)` exactly equals `baselinePreflight.commands[].id`.
- Matching implementation-slice command gates become baseline-red `pending` unless a targeted replacement gate passes or the operator records an audited per-slice baseline-red bypass.
- V1a2 is retained as a separate implementation-slice workflow, not as a prerequisite for the traced docs-only unblock. Decision: keep it because implementation-profile orchestration otherwise has no auditable way to proceed while the suite is known-red without falsely marking matching full-suite gates as passed.
- Replacement and bypass are mutually exclusive resolution modes under one `baselineRedResolution` schema: `replacementGateId` is preferred when alternate passing evidence exists; `bypass` is the explicit human risk-acceptance fallback when no targeted replacement can prove the slice clean.
- Docs-only to implementation baseline reruns are owned by `/pipelane orchestrate review` under the run mutation lock. The coordinator appends one idempotent `baselinePreflight.profileHistory[]` transition and reuses the frozen `reviewGateSnapshot`.

## Persisted Evidence

| Record | Required fields | Milestone |
|---|---|---|
| Clean source snapshot | `status`, `headSha`, `reviewBaseRef`, `changedFiles=[]` | v1a |
| Baseline preflight | `profile`, `status`, `baseResolution`, `skippedCommands[]` for docs-only skips | v1a |
| Planned path scope | `slices[].plannedPathScope[]` | v1a |
| Slice review profile | `slices[].reviewProfile` | v1a |
| Gate snapshot | `reviewGateSnapshot.gates[]`, `profiles[]`, `baselineCommandId`, `replacesBaselineCommandId` | v1a/v1a2 |
| Baseline command evidence | `id`, `command`, `exitCode`, `timedOut`, `durationMs`, `summaryPath`, interrupted-attempt notes | v1a2 |
| Accepted baseline failure | `reason`, `acceptedBy`, `acceptedAt` | v1a2 |
| Baseline-red resolution | one of `replacementGateId` or `bypass.reason`, plus audit fields for bypass | v1a2 |

## Fail-Closed Outcomes

- New v1a/v1a2 additive fields rely on the current reader's unknown-key tolerance; regression coverage must lock read and read-mutate-write preservation before consumers depend on the new fields.
- Malformed `sourceSnapshot` blocks dispatch/review and reports the run ledger as corrupt.
- Malformed `baselinePreflight` or command evidence blocks dispatch.
- Malformed accepted-failure evidence is not treated as accepted; the command remains failed and dispatch remains blocked.
- Missing or malformed `reviewProfile` resolves to `implementation` for gate selection, so docs-only skipping cannot happen from invalid evidence.
- Malformed `reviewGateSnapshot.gates[].replacesBaselineCommandId` or malformed replacement evidence leaves the accepted baseline command pending.

## Observable Assertions

| Scenario | Expected result | Required evidence |
|---|---|---|
| [v1a] Dirty parent | Nonzero result; actionable dirty-source commit/stash message; no dispatch. | No snapshot ref, no source bundle, no prepared worktree. |
| [v1a] Ignored parent file only | Source preflight can be clean. | Ignored paths do not count in the dirty predicate. |
| [v1a] Clean parent source | Source preflight succeeds. | `sourceSnapshot.status='clean'`, `headSha=HEAD`, `reviewBaseRef=headSha`, `changedFiles=[]`. |
| [v1a] Analyzer planned path scope emission | Read-only context can be excluded from docs-only classification. | Analysis/slices-file ingestion emits write-target `plannedPathScope[]`; read-only context fields do not populate it. |
| [v1a] Docs-only baseline preflight | Dispatch is not blocked by unrelated full-suite gates. | `baselinePreflight.profile='docs-only'`; unscoped `npm test`, `npm run build`, and `npm run typecheck` are skipped with docs-only reasons. |
| [v1a] Operator skipped-gate visibility | A green docs-only review is auditable from normal CLI surfaces. | Status/analyze output and finalize summary list skipped full-suite gate ids/commands and the docs-only skip reasons. |
| [v1a] Base delta merge-base semantics | Docs-only classification is stable when base diverges. | Source/base delta uses `git diff --name-status <merge-base>..sourceSnapshot.headSha` equivalent paths; no implicit fetch refreshes origin refs during classification. |
| [v1a] Traced regression | The `docs/ARCHITECTURE_REFACTOR_PLAN.md` run shape no longer runs unrelated full-suite gates. | Baseline and slice profiles are docs-only; full-suite gates are skipped with explicit reasons. |
| [v1a] Docs slice with code context | Read-only code context does not defeat docs-only classification. | Analyzer `plannedPathScope` contains only docs write paths; context paths are excluded. |
| [v1a] RequestedFiles-only code fallback | Missing analyzer write-scope stays conservative. | Any code path in `requestedFiles[]` forces `baselinePreflight.profile='implementation'`. |
| [v1a] Code path in write scope | Code write target forces implementation. | No docs-only skip is recorded. |
| [v1a] Docs-only run escapes to code | Review hard-blocks before per-slice gates. | `implementation-baseline-required` block and remediation guidance. |
| [v1a] Escape abandon preserves worker output | Review-hard-blocked escaped runs are abandonable without silent data loss. | `finalize --abandon` lists escaped slice worktree paths and preserves contents by default. |
| [v1a] Escape worktree purge is opt-in | Abandoned escaped worktrees do not leak forever. | `finalize --abandon --purge-worktrees --reason <text>` removes only listed escaped worktrees after paths are reported and records purge results. |
| [v1a2] Baseline command fails | Dispatch blocked. | Baseline status `failed`; original exit code, timeout flag, duration, and summary path retained. |
| [v1a2] Interrupted baseline running state | Stale running baseline does not block forever. | Re-invocation records interrupted-attempt evidence and reruns the incomplete command from the same source/gate snapshots. |
| [v1a2] Baseline failure accepted | Dispatch may proceed, but baseline is not passed. | Status `accepted_failed`; reason/user/time stored; original failure evidence unchanged. |
| [v1a2] Known-red implementation review | Matching full-suite gate is not greenwashed. | Gate is baseline-red `pending` until linked replacement evidence or audited bypass exists. |
| [v1a2] Baseline-red resolution mode exclusivity | Known-red resolution has one schema and one active mode. | A gate may record either `replacementGateId` or `bypass`, not both. |
| [v1a/v1a2] Frozen gate snapshot | Baseline accept and review use stable ids. | `reviewGateSnapshot` captured before baseline preflight; live catalog changes do not alter matching. |
| [v1a/v1a2] Legacy reader tolerance | Rollback compatibility claim is tested before relying on additive fields. | Current reader behavior ignores additive v1a/v1a2 fields without corrupting the run. |
| [v1a/v1a2] Legacy read-mutate-write preservation | Rollback does not silently erase additive evidence. | Current reader behavior performs a normal legacy mutation/save and reloads with additive fields still present. |

## Deferred v1b Plan Requirements

A future v1b plan must make these decisions and tests explicit before dirty-source snapshot work ships:

- Dirty source with acknowledgement records a source bundle path, digest, immutable `snapshotSha`, namespaced `refs/pipelane/orchestrate/<run-id>/source` ref, review base ref, and acknowledgement reason.
- Partial snapshot creation rolls back the namespaced ref when later setup fails.
- Finalize/cleanup failure records a visible warning in the ledger, not silent success.
- Orphan snapshot refs are recoverable only when the run is inactive and the ref namespace exactly matches the run id.
- Concurrent runs use isolated refs and never delete another run's source ref.
- Worker lease cleanup is fail-closed and does not delete refs for active, unknown, or fresh workers.
- V1b schema/capability markers and rollback drain rules are required because v1b introduces refs, leases, and destructive cleanup obligations.

## Validation

- Rerun `/claude-review plan` against the primary eng-review test-plan artifact.
- Acceptance criterion: the same verified findings do not repeat.
- Sanity-check both plan files agree on docs-only inference, gate skipping, baseline-red semantics, interrupted baseline recovery, no v1a command reorder, and v1b deferral.
