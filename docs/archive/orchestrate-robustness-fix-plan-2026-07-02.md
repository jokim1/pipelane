# Orchestrate Robustness Fix Plan

Date: 2026-07-02
Status: Draft, under /plan-eng-review

## Problem

The orchestration run `orchestrate-20260701230712-c0eeeb0f` exposed four brittle seams in `/orchestrate`:

1. The source plan expected dirty parent worktree state, but worker worktrees were created from clean `HEAD`.
2. Phase 0 baseline capture was modeled as a normal implementation slice, so a docs-only baseline artifact hit the same full review gates as code changes.
3. Review gates were ordered by canonical phase/id, not by the worker's behavioral command order, so `build` ran before `test` and changed the test environment by writing `dist/`.
4. Ignored build outputs can affect later commands while remaining invisible to the current checkout mutation digest.

The result was not a bad failure. It was worse: a failure that looked like a slice failure, but was actually orchestration infrastructure and gate semantics fighting each other.

## Goals

- Make `/orchestrate` explicit about whether it is running from clean `HEAD` or from dirty source state.
- Move baseline capture out of slice execution and into a run-level preflight artifact.
- Keep review gates strict for implementation slices while allowing docs-only slices to avoid unrelated full-suite gates.
- Make command gate ordering deterministic, visible, and aligned with behavioral intent.
- Defer ignored-output telemetry/cleanup to a follow-up; v1a mitigates the traced `dist/cli.js` CLI fallback seam with explicit gate ordering, while whole-suite dist independence remains follow-up scope.
- Keep the fix incremental and built from existing review/orchestration primitives.
- Milestone v1a is the separately shippable initial unblock: clean-source review-base plumbing, baseline preflight for docs-only skip decisions, strict docs-only inference, profile-aware gate skipping, and deterministic `test` before `build` order for orchestrate-generated gates.
- Milestone v1a2 is the implementation-baseline audit follow-up: manual `baseline accept`, per-slice `bypass-baseline-red`, replacement-gate linking, and implementation-profile baseline-red review completion.
- Milestone v1b is the dirty-source robustness follow-up: acknowledged dirty-source bundle fidelity, namespaced snapshot refs, cleanup/reclaim, rollback drain, and worker-lease abandon safety. It fixes the separate dirty-source silent-loss seam, but it must not block shipping v1a.
- Docs-only routing remains in v1a because the traced blocker was a docs-only baseline artifact forced through implementation full-suite gates. The docs-only escape rerun is the highest-risk v1a docs-only subsystem and lands last within v1a, after clean-source baseline, profile inference, and run-lock serialization tests are green.
- Milestone tags: every deterministic rule and matrix row must declare its owning milestone. v1a rows/rules cover clean parent source only. Dirty-source acknowledgement, `sourceBundle`, `snapshotRef`, source-ref cleanup/reclaim, worker leases, rollback drain, orphan refs, and concurrent snapshot refs are v1b unless the row explicitly describes the v1a fail-closed guard around those unsupported fields.
- v1a dirty-parent behavior is a hard block before planning/dispatch with a message that says to commit or stash local changes; it must not advertise `--acknowledge-dirty-source` until v1b ships that path.
- v1a rollback behavior is schema/capability guard refusal only. It refuses unsupported v1b ledgers safely, but the drain command/report is v1b.
- v1a implementation behavior is a hard block: if run-level `baselinePreflight.profile='implementation'`, any slice is implementation-profile, or a docs-only run escapes to implementation, v1a stops before dispatch/review gates with an implementation-baseline-required message. V1a docs-only skipping requires both run and slice profiles to be docs-only. v1a2 supplies the audited accept/bypass/replacement operator path.
- v1a escape recovery is clean-source fail/abandon only: because v1a computes profiles before per-slice gates and has no dirty-source ref, the operator may mark the run failed/abandoned with an audited reason using existing finalize/cancel state; no worker-lease proof or source-ref cleanup is required. Continuing the run as implementation waits for v1a2.
- v1a docs-only baseline preflight is classification/skip-only. It records skipped unscoped full-suite commands and does not execute baseline commands or dependency provisioning. Baseline temp worktrees, docs-matching baseline command execution, dependency provisioning, manual accept, replacement, and bypass are v1a2.

## Not In Scope

- Fixing the currently red full `npm test` suite. That is a separate quality problem and should not be hidden inside orchestration infrastructure work.
- Rewriting the orchestrator state machine. The ledger and slice records stay intact.
- Adding a new worker runtime, queue, database, or daemon.
- Cleaning ignored outputs automatically with `git clean -fdX`. That is destructive enough to deserve a separate explicit command or opt-in.
- Resetting, deleting, sandboxing, or walking watched ignored outputs between review command gates. This is deferred to a later cleanup/isolation change.
- Changing AI review model behavior. This plan focuses on deterministic local orchestration and command gates.
- Durable/config-level known-red baseline waivers, automatic known-red failure matching, and failure-signature normalization. V1 baseline acceptance is intentionally manual, per-run, and per-command.
- Changing non-orchestrate review flows. The v1a gate-order fix applies only to orchestrate-generated review gates; standalone `/pipelane review` keeps its existing order until a separate compatibility plan proves a global reorder is safe.
- Any standalone `/pipelane review` dist-output pollution risk remains accepted deferred scope until that global compatibility plan lands.

## What Already Exists

| Need | Existing code | Reuse plan |
|---|---|---|
| Review run execution | `buildReviewRunRecord` in `src/operator/commands/review.ts` | Extend with profile-aware gate filtering and explicit ordering. |
| Changed-file detection | `collectChangedFiles` in `src/operator/commands/review.ts` | Reuse for docs-only profile selection. |
| Path-scoped gate skipping | `skipReasonForGate` and `whenChanged` in `src/operator/commands/review.ts` | Reuse and make orchestration gate snapshots declare profile/path intent. |
| Checkout mutation evidence | `reviewGateCheckoutMutationSummary` in `src/operator/commands/review.ts` | Leave unchanged in v1; ignored-output telemetry is follow-up scope. |
| Orchestration ledger | `src/operator/orchestration-ledger.ts` | Add run-level preflight/baseline fields without replacing slice records. |
| Git/source snapshot plumbing | New `src/operator/orchestration-source-snapshot.ts` helper | Keep bundle capture, snapshot-ref creation, review-base resolution, and cleanup out of the command handler. |
| Worker status inspection | `src/operator/worktree-status.ts` | No v1 change for ignored-output watching. |
| Run analysis | `orchestrate analyze` in `src/operator/commands/orchestrate.ts` | Surface dirty-source and baseline preflight evidence there. |
| Public docs | `docs/public/ORCHESTRATION.md` | Document new preflight, profile, and ordering semantics after implementation. |

New metadata:

- Add `slices[].plannedPathScope[]`, derived before dispatch as a normalized union of existing `slices[].requestedFiles[]` and optional analyzer-provided `--slices-file.slices[].plannedPathScope[]`. The current ledger does not have a canonical pre-dispatch path-scope field.
- v1b adds `slices[].workerLease` for abandon safety: `workerId`, `pid`, `startedAt`, `heartbeatAt`, and `status`. V1a dispatch does not persist `workerLease`.

## Proposed Model

Baseline is not a slice.

It is run-level evidence captured before real slices start.

```text
/orchestrate docs/ARCHITECTURE_REFACTOR_PLAN.md
  |
  v
Source preflight
  |
  +-- clean HEAD? --------------------------------+
  |                                               |
  +-- dirty source?                               v
        |                             record sourceSnapshot
        +-- no acknowledgement -> block
        +-- explicit acknowledgement -> create sourceBundle
                                            |
                                            +-- create local source snapshot ref
                                            +-- baseline worktree from reviewBaseRef
                                            +-- slice worktrees from reviewBaseRef
  |
  v
Baseline preflight artifact
  |
  +-- run configured baseline commands
  +-- record exit codes, durations, summaries
  +-- do not create an implementation slice
  +-- do not run slice review gates
  |
  v
Plan review gate
  |
  v
Dispatch implementation/doc slices
  |
  v
Slice review profile
  |
  +-- implementation -> strict command gates + AI review
  +-- docs-only      -> path-scoped docs gate + AI/doc review as configured
```

## Run-Level Source Preflight

Add a run-level source snapshot to the orchestration ledger:

```ts
interface OrchestrationSourceSnapshot {
  baseRef: string;
  headSha: string;
  parentWorktree: string;
  reviewBaseRef: string;
  status: 'clean' | 'dirty';
  changedFiles: string[];
  dirtySummary?: string;
  sourceBundle?: {
    // Retained audit manifest, not the transient payload.
    artifactPath: string;
    sha256: string;
    snapshotRef: string;
    snapshotSha: string;
    verifiedAt?: string;
    payloadDeletedAt?: string;
    ignoredExcludedManifestPath?: string;
  };
  cleanup?: {
    status: 'not_started' | 'deleted' | 'warning';
    attemptedAt?: string;
    refDeletedAt?: string;
    warning?: string;
  };
  acknowledgedDirtySource?: {
    acceptedAt: string;
    acceptedBy: string;
    reason: string;
  };
}
```

Default policy:

- Clean parent worktree: continue.
- Clean parent worktree records `sourceSnapshot.status = 'clean'`, `sourceSnapshot.headSha = HEAD`, `sourceSnapshot.reviewBaseRef = sourceSnapshot.headSha`, and no `sourceSnapshot.sourceBundle`.
- v1a dirty parent worktree: hard-block before planning or dispatch with a commit/stash message. Do not advertise `--acknowledge-dirty-source` until v1b ships source bundles.
- v1b dirty parent worktree: block before planning or dispatch unless the operator explicitly acknowledges that `/orchestrate` will run from a captured dirty source bundle.
- The source bundle must include tracked unstaged diff, staged diff, and untracked non-ignored files from `git ls-files --others --exclude-standard`.
- The source bundle must exclude ignored files by default. Non-ignored files, including paths explicitly unignored by `.gitignore`, are included.
- Source bundle fidelity is all-or-block. V1 must faithfully represent regular text/binary files, additions, modifications, deletions, renames, executable file mode, and symlinks.
- The source snapshot target is the parent checkout's on-disk working-tree content relative to `HEAD`, plus untracked non-ignored files. When index and worktree differ for the same path, worktree content wins; the snapshot is not an index-only commit. This makes staged-only changes included when the worktree still contains them, and partially staged files resolve to exactly what the operator would see on disk.
- Unsupported source entries are submodule gitlinks, device/FIFO/socket/special files, unreadable files, and paths that cannot be represented as normal git tree entries. Any unsupported entry blocks source preflight before dispatch with an actionable unsupported-entry message; no partial snapshot ref remains unless failure happens after ref creation, in which case the partial snapshot rollback/warning rule applies.
- The source bundle must be materialized into a local source snapshot commit/ref named `refs/pipelane/orchestrate/<run-id>/source`. The parent worktree must not be committed, reset, checked out, or otherwise mutated.
- The source snapshot commit parent must be the recorded `headSha`, so later diffs show only slice changes on top of the acknowledged starting point.
- Snapshot creation should use an isolated temporary index/worktree or equivalent `git commit-tree` flow, not the operator's parent checkout.
- Concrete snapshot construction: create the source bundle from tracked staged diff, tracked unstaged diff, and `git ls-files --others --exclude-standard`; materialize that bundle in an isolated temporary worktree/index created from `sourceSnapshot.headSha`; create the snapshot commit with `git write-tree`/`git commit-tree -p <headSha>`; update only `refs/pipelane/orchestrate/<run-id>/source`; then remove the temp worktree/index. The parent checkout's HEAD, index, and worktree must never be written.
- The source bundle payload is transient. After `snapshotSha` is created and verified, delete the payload immediately before dispatch and retain only a small audit manifest at `sourceSnapshot.sourceBundle.artifactPath`.
- `orchestrate finalize` and cleanup flows should delete the namespaced source snapshot ref after the run no longer needs it. The ledger keeps the digest and snapshot SHA as durable evidence.
- If snapshot setup fails after creating the namespaced ref, orchestration must best-effort delete that ref before returning failure. If rollback deletion fails, record a cleanup warning in the ledger and block dispatch.
- If finalize/cleanup cannot delete the source snapshot ref, finalization records a visible cleanup warning in the ledger instead of reporting silent success and leaves the ref in place. V1 does not run an automatic orphan-ref sweep.
- Cleanup/retry may re-point the current run's `sourceSnapshot.sourceBundle.snapshotRef` only when `git cat-file -e <sourceSnapshot.sourceBundle.snapshotSha>` proves the commit object still exists. V1 does not rebuild snapshot commits from bundle payloads.
- Concurrent runs must use isolated refs under their own run ids. Cleanup for one run must never delete another run's `refs/pipelane/orchestrate/<other-run-id>/source` ref.
- Terminal cleanup for current v1 statuses applies to `completed` and `failed`. `planned`, `prepared`, `dispatched`, `running`, `blocked`, and `paused` are non-terminal and keep the source ref because they may still resume.
- Abandoned non-terminal runs are reclaimed only by an explicit manual finalize/abandon flow with a reason, after acquiring the run mutation lock, proving no running worker through persisted worker leases, and verifying the ref namespace matches the run id.
- [v1b] Worker lease ownership stays in existing orchestration coordinator paths. Dispatch writes `slices[].workerLease` when it starts or observes a worker process, and resume/review/finalize update `status` and `heartbeatAt` only at existing lifecycle observation points; v1b does not add a worker daemon, queue, runtime, or periodic heartbeat service.
- [v1a] Dispatch does not persist `slices[].workerLease`, does not stamp the schema/capability marker because of `workerLease`, and does not require worker-lease proof for clean-source fail/abandon recovery.
- [v1b] Worker liveness proof is fail-closed for ref deletion: every slice must have `worker.status !== 'running'`, or a matching `workerLease` with `heartbeatAt` older than `orchestrate.cleanup.staleWorkerLeaseMs` and a recorded PID that is absent. The default stale threshold is 7,200,000 ms / 2 hours and may only be overridden by explicit repo config; values below 300,000 ms / 5 minutes are rejected. If a running worker has no lease, a fresh heartbeat, an unknown PID, or a live PID, source-ref reclaim is refused.
- [v1b] A no-lease legacy or partially-upgraded slice is not unrecoverable. If its slice status is not running, abandon/finalize may mark the run failed/abandoned and proceed with normal cleanup checks. If its slice status is running or unknown with no lease, abandon/finalize may mark the run abandoned only with an explicit no-lease warning and must leave the source ref in place for manual inspection; it must not delete the ref.
- The run must set `sourceSnapshot.reviewBaseRef` to `sourceSnapshot.sourceBundle.snapshotSha` when dirty source is acknowledged, or to `sourceSnapshot.headSha` for clean source. `sourceSnapshot.sourceBundle.snapshotRef` remains the mutable local ref name; `snapshotSha` is the immutable review base. Slice review must compare against this review base, not always `origin/<baseBranch>`.
- Legacy or in-flight runs without `sourceSnapshot.reviewBaseRef` use the shared base resolver and `implementation` profile: prefer `origin/<baseBranch>`, fall back to local `<baseBranch>` with a warning when resolvable, and block with an unresolved-base message when neither ref can form a merge-base.
- `sourceSnapshot.sourceBundle.sha256` must be stored in the ledger, shown in CLI outline/status/analyze, and included in run artifacts.
- Baseline and slice worktrees must be created from `sourceSnapshot.reviewBaseRef`. For dirty source this is the immutable `sourceSnapshot.sourceBundle.snapshotSha`; `snapshotRef` is the mutable local ref used for lifecycle and cleanup. If the snapshot cannot be created cleanly, orchestration blocks before dispatch/review.
- Ledger validation must allow legacy absence of `sourceSnapshot`, but malformed present source snapshot fields make the ledger unreadable/corrupt.

This makes the invisible contract visible. Either the run is from clean `HEAD`, or it is from a named dirty snapshot with a recorded reason.

## Ledger Concurrency Model

Orchestration state is per-run, not a shared mutable run ledger.

- V1 adds `orchestrationSchemaVersion` and `orchestrationCapabilities[]` before any writer emits source snapshot, baseline preflight, review profile, planned path scope, worker lease, or frozen gate snapshot fields.
- Stamp the schema/capability marker only when the run first persists a substantive field owned by the active milestone: v1a fields include `sourceSnapshot` clean-source metadata, `baselinePreflight`, `reviewProfile`, `plannedPathScope`, and `reviewGateSnapshot`; v1a2 fields include accepted baseline/replacement/bypass evidence; v1b fields include dirty-source `sourceBundle`, `snapshotRef`, `sourceSnapshot.cleanup`, and `workerLease`. Legacy runs that contain none of those fields remain rollback-compatible and must not be marked as requiring v1.
- New v1 keys are additive. V1 readers ignore unknown future keys unless an explicit future schema marker says the run requires a newer coordinator.
- A rolled-back or compatibility-mode coordinator whose supported schema/capability set does not include v1 source snapshots, baseline preflight, review profiles, planned path scope, worker leases, or frozen review gate snapshots must refuse resume/dispatch/review/cleanup for a run containing those fields.
- The refusal message must require a v1-capable coordinator or explicit v1 abandon/finalize. It must not silently fall back to `origin/<baseBranch>` and must not delete source refs from a run it cannot understand.
- The run ledger lives at `.git/pipelane-state/orchestrate/runs/<run-id>/orchestration.json`.
- Each run uses its own `.git/pipelane-state/orchestrate/runs/<run-id>/mutation.lock`.
- Each signed integrity head is per run id under `.git/pipelane-state/orchestrate/integrity/<run-id>.json`.
- Source snapshot cleanup/finalize may write only the current run's ledger and may delete only the current run's namespaced source ref.
- Interleaved operations across two different run ids must preserve both ledgers. Concurrent mutation of the same run must be serialized by the mutation lock or rejected by the integrity-head mutation check.

Rollback runbook:

- The minimum safe rollback floor is the guard-introducing release from v1a step 1. That guard release must be deployed and baked before any v1 writer is enabled. Coordinator rollback below that floor forfeits the fail-closed guarantee and is unsupported once any v1 writer has run.
- Coordinator rollback below v1 is safe only after all active v1-marked runs are drained to `completed`, `failed`, or explicitly abandoned/finalized by a v1-capable coordinator.
- A rollback drain check must report non-terminal v1-marked run ids and block rollback until those runs are resolved.
- Emergency recovery for stranded v1 runs is to redeploy a v1-capable coordinator, finalize/abandon or complete those runs under the v1 cleanup rules, then roll back.
- A rolled-back coordinator must still refuse v1-marked ledgers if it encounters them; the runbook prevents that refusal from becoming an operational surprise.

## Baseline Preflight Artifact

Add a run-level baseline record:

```ts
interface OrchestrationBaselinePreflight {
  status: 'not_started' | 'running' | 'passed' | 'failed' | 'accepted_failed';
  profile: 'implementation' | 'docs-only';
  startedAt?: string;
  completedAt?: string;
  worktreePath?: string;
  artifactPath?: string;
  profileHistory?: Array<{
    from: 'implementation' | 'docs-only';
    to: 'implementation' | 'docs-only';
    reason: string;
  }>;
  baseResolution?: {
    status: 'origin' | 'local' | 'unresolved';
    ref: string | null;
    warning?: string;
  };
  dependencyProvisioning?: {
    status: 'present' | 'linked' | 'failed';
    warning?: string;
  };
  commands: Array<{
    id: string;
    command: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    summaryPath?: string;
    acceptedFailure?: {
      acceptedAt: string;
      acceptedBy: string;
      reason: string;
    };
  }>;
  skippedCommands?: Array<{
    id: string;
    command: string;
    skipReason: string;
  }>;
}
```

Behavior:

- Baseline capture runs before slice dispatch.
- Baseline artifacts are attached to the run, not to a slice.
- Baseline commands run in a dedicated baseline temp worktree checked out at `sourceSnapshot.reviewBaseRef`, not in the parent checkout. For dirty source this is `sourceSnapshot.sourceBundle.snapshotSha`; for clean source this is `sourceSnapshot.headSha`.
- Baseline command worktrees must reuse existing slice-worktree dependency provisioning by calling `ensureSharedNodeModulesLink(commonDir, baselineWorktreePath, { replaceExistingDirectory: true })` before running command gates. The source-snapshot construction temp worktree does not run project commands and does not need dependency provisioning.
- V1 does not run `npm install` or `npm ci` inside baseline temp worktrees. If a dependency-requiring baseline command is selected and neither a real nor symlinked `node_modules` is available after provisioning, baseline preflight blocks with `dependency_provisioning_failed`, records an actionable warning, and does not report that command as a real test failure.
- Baseline preflight and review both use one frozen per-run `reviewGateSnapshot` captured before baseline preflight. Baseline accept and review matching never re-read the live gate catalog for ids.
- `baselinePreflight.profile` is `docs-only` only when every approved slice's planned path scope and every source/base delta path satisfy the strict docs-safe rule. Unknown, mixed, or code/config scope is `implementation`.
- Planned path scope is persisted as new `slices[].plannedPathScope`. Derivation is a union, not an intersection: normalize and de-duplicate the existing `slices[].requestedFiles[]` plus optional analyzer-provided `--slices-file.slices[].plannedPathScope[]`. No other analyzer field is accepted as path scope in v1.
- Planned path scope entries must be repo-relative POSIX paths after stripping a leading `./`. Absolute paths, URLs, parent traversal, empty strings, shell globs without a concrete path prefix, and invalid types make that slice's planned scope `unknown`.
- If any approved slice has missing, empty, invalid, or unknown `plannedPathScope`, baseline preflight uses `implementation`; only a non-empty valid union for every approved slice can participate in docs-only baseline inference.
- `baseBranch` is persisted on the run at creation as `run.baseBranch` and is the only input to origin/local base resolution. Precedence is explicit CLI `--base-branch`, then `orchestrate.baseBranch` config, then `review.baseBranch` config, then successful `gh pr view --json baseRefName` when in a PR checkout, then remote `origin/HEAD`, then `main`, then `master`. If `gh` is absent, unauthenticated, unavailable, or returns no PR/base, treat it as no PR base and fall through; only a successful lookup contributes a base. Once persisted, review/baseline never re-detect it from live repo state.
- Source/base delta paths are `sourceSnapshot.changedFiles` for acknowledged dirty source plus the clean/local `sourceSnapshot.headSha` versus the resolved base ref diff. Resolve that base as `origin/<baseBranch>` first, then local `<baseBranch>` if origin is unavailable and a merge-base exists; record which ref was used.
- If neither `origin/<baseBranch>` nor local `<baseBranch>` resolves to a merge-base, clean-source baseline classification fails closed to `implementation` and records `baselinePreflight.baseResolution.status = 'unresolved'` with an actionable fetch/base-branch message.
- Legacy or absent-source-snapshot review uses the same base resolver. If origin is unavailable but local `<baseBranch>` resolves, review proceeds with an explicit warning; if neither resolves, review blocks with an actionable unresolved-base message and no docs-only skipping is allowed.
- For `baselinePreflight.profile = 'docs-only'`, v1a records unscoped full-suite baseline commands in `baselinePreflight.skippedCommands[]` with docs-only skip reasons and does not need acceptance. Matching docs `whenChanged` baseline commands run only in v1a2, when baseline command execution infrastructure is in scope.
- In v1a, if `baselinePreflight.profile='implementation'` for any reason, or if a run starts as `docs-only` and any later slice diff escapes docs-safe paths, dispatch/review hard-blocks before per-slice gates with an implementation-baseline-required message. In v1a2, review cannot complete until baseline preflight is rerun under `implementation` from the same source snapshot and previously skipped full-suite baseline commands pass or receive audited acceptance.
- Slice review profile inference is an up-front run-level phase. `/pipelane orchestrate review` acquires the run mutation lock, computes or refreshes `slices[].reviewProfile` for every approved slice, decides whether any slice escaped docs-only, and in v1a blocks before any gate if implementation baseline support is required.
- The docs-only to implementation baseline rerun is v1a2 and is owned only by the `/pipelane orchestrate review` coordinator, not by slice workers. It runs once per run under the run mutation lock before per-slice gate execution, appends a single idempotent `baselinePreflight.profileHistory[]` transition, and reuses the frozen `reviewGateSnapshot`.
- If a legacy/interrupted run already has docs-only gate evidence before an implementation escape is detected, v1a review completion is blocked and earlier docs-only gate evidence is marked pre-escape. v1a2 then requires implementation baseline rerun and implementation gates/bypass before completion.
- Concurrent review invocations must re-read the ledger after acquiring the mutation lock. If another invocation already recorded `docs-only -> implementation`, the second invocation must not launch another full-suite rerun.
- Baseline failures stop dispatch by default, because a broken starting point changes the meaning of every downstream result.
- A failed baseline command can be accepted with an audited reason. Accepted baseline failures change the preflight status to `accepted_failed`, not `passed`.
- Slice review must carry accepted baseline failures forward. A matching full-suite gate should not pretend to prove the slice is clean; it should become baseline-red `pending` unless a targeted replacement gate passes or the operator records an audited per-slice baseline-red bypass.
- The baseline-red bypass is not a pass for the failed command. It is an explicit operator statement that the slice was reviewed with alternate evidence despite the known-red baseline.
- Decision for v1: do not implement automatic known-red failure matching or a `failureSignature` normalizer. This repo's known-red baseline command id is `test` (`npm test`), but v1 unblocks it through the existing audited `orchestrate baseline accept` path.
- The manual accept path is intentionally not a pass. Every implementation slice remains baseline-red pending until an audited per-slice bypass is recorded, or until a future linked replacement gate with real passing evidence is added.
- Durable replacement gates remain supported by the data model for accepted baseline commands. If a failed baseline command has no accepted failure, baseline still blocks.
- A failed baseline should produce an actionable summary, not a fake failed slice.
- Baseline output may live under ignored docs/archive or `.git/pipelane-state/orchestrate/runs/.../baseline/`, but the ledger must point at it.
- Ledger validation must allow legacy absence of `baselinePreflight`, but malformed present baseline records, command records, or accepted-failure records make the ledger unreadable/corrupt.

Source bundle artifact lifecycle:

- The source bundle payload is load-bearing only until the initial snapshot commit is created and verified. After verification, delete the payload immediately; do not retain a second copy of the source tree for the life of the run.
- The retained `sourceSnapshot.sourceBundle.artifactPath` is a small audit manifest, not the bundle payload. It records the payload digest, included path count, ignored-exclusion manifest path, `snapshotSha`, and payload deletion time.
- If immediate payload deletion fails after snapshot creation, source preflight fails before dispatch, best-effort deletes the namespaced ref, and records the failure under the single `sourceSnapshot.cleanup` owner.
- Local audit identity for `acceptedFailure.acceptedBy` and `baselineRedResolution.bypass.acceptedBy` resolves from explicit CLI/operator identity first, then git user identity, then OS username. It is local audit metadata, not cryptographic identity proof.
- Known-red baseline acceptance is v1 per-run/per-command only. A new orchestration run must record a fresh `baselinePreflight.commands[].acceptedFailure` if the operator manually accepts; no durable config-level acceptance carries forward.

## Slice Review Profiles

Add an explicit slice review profile:

```ts
type OrchestrationReviewProfile = 'implementation' | 'docs-only';

interface OrchestrationSliceRecord {
  reviewProfile?: OrchestrationReviewProfile;
}
```

Ledger validation:

- Legacy slices with missing `reviewProfile` default to `implementation`.
- Present `reviewProfile` must be either `implementation` or `docs-only`.
- Malformed profile values fail closed to `implementation` for gate selection and must not trigger docs-only skipping.

Profile assignment must be deterministic and must use only the slice diff relative to `sourceSnapshot.reviewBaseRef`. Classification uses path records, not just final filenames:

- Added/modified paths classify by their path.
- Deleted paths classify by the deleted path.
- Renamed/copied paths classify by both old and new paths.
- Empty diffs and inherited-source-snapshot-only diffs default to `implementation`.

```text
changed files
  |
  +-- at least one classification path exists, and every path is
  |   under docs/ with extension .md, .mdx, .txt, .png, .jpg,
  |   .jpeg, .gif, .svg, .webp, or .pdf,
  |   exactly README.md, exactly CHANGELOG.md,
  |   or a root-level *.md/*.mdx file -> docs-only
  |
  +-- otherwise -> implementation
```

Any changed path under `src/`, `bin/`, `scripts/`, `templates/`, `test/`, package manifests or lockfiles, TypeScript config, orchestration/review config, CI config, or any mixed docs/code diff is `implementation`. Code/config files under `docs/`, including `*.js`, `*.ts`, `*.tsx`, `*.mjs`, `*.cjs`, `*.py`, `package.json`, lockfiles, and executable scripts, also force `implementation`.

The same `classifyDocsSafePathRecords()` helper must feed both `baselinePreflight.profile` from analyzer-approved path scope and `slices[].reviewProfile` from actual slice diffs. Duplicate classifier logic is out of scope.

Profile behavior:

| Profile | Gate behavior | AI review behavior |
|---|---|---|
| `implementation` | Run strict command gates from the orchestration gate snapshot. | Run normal independent AI/code review gates. |
| `docs-only` | Skip unscoped full-suite gates only when the run-level `baselinePreflight.profile` is also `docs-only`. Run gates whose `whenChanged` matches docs paths. | Run existing `gstack-review` annotated with `profiles: ['docs-only']` plus other non-command gates that declare `profiles: ['docs-only']` or have matching docs `whenChanged`. Skip unscoped AI/code gates with an explicit reason only when both profiles are docs-only. |

The profile must be stored in the ledger and shown in CLI review output. A skipped gate should say why:

```text
skipped: docs-only profile, gate has no matching whenChanged path
skipped: docs-only profile, AI/code gate not scoped to docs
```

## Gate Ordering

Current orchestrate-generated review gate sorting by phase/id is too indirect for command gates with side effects.

Add explicit gate ordering:

1. `order` field on the gate, if present.
2. Known default catalog order for generated gates.
3. Existing config array order.
4. Stable id fallback only for unknown or legacy gates.

Implementation rule:

- Add one resolver, `resolveOrchestrateReviewGateExecutionOrder(gates, catalogOrder)`, and use it from orchestrate review execution and generated/default orchestrate gate setup. Do not change standalone `/pipelane review` ordering in v1a.

Default behavioral order for orchestrate-generated review command gates:

```text
typecheck -> test -> build
```

Rationale:

- Orchestrate-generated command order must encode build-output safety, not just stable sorting. Gates that produce watched ignored outputs must run after gates known to observe those outputs unless they run in isolated worktrees.
- V1 encodes that order declaratively in the review gate catalog with explicit order weights or `runAfter` metadata. It is not derived from ignored-output telemetry, which is deferred.
- `typecheck` is cheap and should fail early.
- `test` should run before `build` in this repo because `build` writes `dist/cli.js`, and the test suite can observe built state.
- The `test` before `build` order is justified in v1a only for the traced CLI fallback seam: `bin/pipelane` must run from source when `dist/cli.js` is absent, so a stale `dist/cli.js` cannot influence the selected proof. The single-test no-`dist` proof does not establish whole-suite dist independence, and v1a must not claim that it does while the full suite is known red.
- Full-suite dist-dependency auditing is follow-up scope. If the full `npm test` gate later fails specifically because `dist/cli.js` is missing, the gate-order change blocks and the fix moves to scoped build-for-test or per-gate isolation follow-up.
- `build` still runs, but it no longer pollutes the test environment unless explicitly requested.

The resolved orchestrate order should be printed in orchestrate review output and recorded in the orchestrate review run record.

## Ignored Output Follow-Up

Ignored-output telemetry, watched-path cleanup, and command-worktree isolation are not v1 deliverables.

The known `dist/cli.js` CLI fallback seam is mitigated by the v1a build-output ordering invariant: `test` must run before `build` unless `build` runs isolated. This does not prove whole-suite dist independence. A later cleanup/isolation plan can decide whether to add warn-only telemetry, reset watched ignored paths between gates, or run side-effecting command gates in isolated worktrees.

## CLI And UX Changes

Operator command surfaces:

- `/pipelane orchestrate <plan> --acknowledge-dirty-source --reason <text>` records dirty-source acknowledgement during initial run creation.
- `/pipelane orchestrate baseline accept --run-id <id> --command-id <id> --reason <text>` records an accepted failed baseline command.
- `/pipelane orchestrate review bypass-baseline-red --run-id <id> --slice-id <id> --gate-id <id> --baseline-command-id <id> --reason <text>` records a per-slice baseline-red bypass.
- `/pipelane orchestrate finalize --run-id <id> --abandon --reason <text>` marks an inactive non-terminal run failed/abandoned and reclaims only that run's source snapshot ref.
- Docs-only to implementation baseline rerun is automatic during `/pipelane orchestrate review` when actual slice diffs escape docs-safe paths. If rerun commands fail, review blocks and the operator uses `orchestrate baseline accept`.

`/orchestrate` outline should show:

```text
Source: clean HEAD abc123
Baseline: failed, npm test exit 1 in 24m24s
Review profiles: implementation 4, docs-only 1
Gate order: typecheck -> test -> build
```

For dirty source:

```text
Source: dirty snapshot acknowledged by josephkim
  reason: include local docs/ARCHITECTURE_REFACTOR_PLAN.md edits
  bundle: sha256:abc123...
  source ref: refs/pipelane/orchestrate/orchestrate-.../source
```

For baseline failure:

```text
Blocked before dispatch.
Baseline preflight failed:
  npm test exit 1, 842 tests, 708 pass, 77 fail, 57 skipped
Next: fix baseline, or run /pipelane orchestrate baseline accept --run-id <id> --command test --reason <text>.
```

For accepted baseline failure:

```text
Baseline: accepted_failed
  npm test: known-red, accepted by josephkim
  reason: existing suite has 77 failures unrelated to this orchestration change
Slice review impact:
  npm test gates remain pending until a targeted replacement gate passes or an audited baseline-red bypass is recorded.
```

## Test Harness Requirements

- Source snapshot, source bundle, namespaced ref, rollback, cleanup, review-base comparison, and concurrent-run tests must use a real temporary git repository fixture, not mocked git.
- The fixture must create actual commits, refs, worktrees, tracked edits, staged edits, untracked non-ignored files, ignored files, deletions, and renames for the cases that assert those behaviors.
- Command execution outcomes and timeouts may use controlled test commands, but the surrounding git/ref/worktree operations must remain real.
- At least one baseline-preflight real-git fixture must create a shared dependency directory linked as `node_modules` and run a dependency-requiring package script from the baseline temp worktree; a second fixture must omit shared dependencies and assert `dependency_provisioning_failed` instead of a fake test failure.
- Ledger concurrency tests must use two run ids with separate run ledger paths, mutation locks, and integrity heads.
- Interleaved snapshot/finalize operations for different run ids must leave each run ledger intact and unmixed; concurrent mutation of the same run must be serialized by the run mutation lock or rejected by the integrity-head mutation check.
- Rollback/drain tests must create both a legacy run with no v1 fields and a v1-marked non-terminal run: the legacy run remains readable in compatibility mode, while rollback is blocked until the v1 run is completed, failed, or abandoned/finalized by a v1-capable coordinator.

## Fail-Closed Outcomes

- New persisted structures are validated by canonical validators before consumers use them: `validateSourceSnapshot`, `validateBaselinePreflight`, `validateAcceptedFailure`, `validateReviewProfile`, and `validateReviewGateLinks`.
- Evidence is malformed when a required canonical key is absent, has the wrong type, has an invalid enum value, has a blank/unsafe id, has a non-ISO timestamp, has an invalid SHA/ref/path shape, references a path outside the run state when a run-state path is required, or references a baseline/gate id that the shared gate snapshot cannot resolve.
- Schema/capability markers are validated before legacy fallbacks run. A coordinator that cannot support the run's required v1 fields blocks resume/dispatch/review/cleanup instead of falling back to origin-base review.
- Malformed `sourceSnapshot` blocks dispatch/review and reports the run ledger as corrupt; no source ref is deleted from malformed evidence.
- Malformed `baselinePreflight` or command evidence blocks dispatch.
- Malformed `baselinePreflight.commands[].acceptedFailure` is not treated as accepted; the command remains failed, `baselinePreflight.status` resolves to `failed`, and dispatch remains blocked.
- Missing or malformed `slices[].reviewProfile` resolves to `implementation` for gate selection, so docs-only skipping cannot happen from invalid profile data.
- Malformed `reviewGateSnapshot.gates[].replacesBaselineCommandId` or malformed replacement evidence leaves the accepted baseline command `pending`.

## Implementation Slices

### Slice 1: Source Preflight Foundations

Landing split: first land clean-source review-base recording and a fail-closed dirty-parent guard. Dirty-source acknowledgement, bundle materialization, snapshot refs, cleanup, and worker-lease abandon safety land later, after the clean-source baseline/profile/gate-order path is tested.

Touch:

- `src/operator/commands/orchestrate.ts`
- `src/operator/orchestration-source-snapshot.ts`
- `src/operator/orchestration-ledger.ts`
- `test/pipelane.test.mjs`

Work:

- Capture parent worktree status before orchestration planning/dispatch.
- v1a blocks dirty parent worktree with a commit/stash message and no acknowledgement escape.
- v1b blocks dirty parent worktree unless explicit acknowledgement is passed.
- Add `orchestration-source-snapshot.ts` to build a source bundle from tracked unstaged diff, staged diff, and untracked non-ignored files.
- Store the source bundle under the run state directory and record its digest in the ledger.
- Use the helper to materialize the source bundle into a local source snapshot commit/ref without mutating the parent worktree.
- Use the helper to resolve the base ref for every prepared slice worktree.
- Store `sourceSnapshot.reviewBaseRef` so slice review compares worker changes against the immutable snapshot SHA instead of `origin/<baseBranch>` when dirty source is acknowledged.
- Use the helper to delete the namespaced source snapshot ref during finalize/cleanup after the run no longer needs it.
- Store source snapshot in the run ledger.
- Add optional ledger validators for `sourceSnapshot`; missing is legacy-compatible, malformed present values fail closed.
- Show source state in outline/status/analyze.

Tests:

- Clean parent worktree proceeds.
- Clean parent worktree records `sourceSnapshot.status = 'clean'`, `sourceSnapshot.headSha`, no `sourceSnapshot.sourceBundle`, and `sourceSnapshot.reviewBaseRef = sourceSnapshot.headSha`.
- v1a dirty parent worktree blocks with actionable commit/stash message and no acknowledgement flag.
- v1b dirty parent worktree with acknowledgement records `sourceSnapshot.acknowledgedDirtySource.reason`, retained audit-manifest `sourceSnapshot.sourceBundle.artifactPath`, `sourceSnapshot.sourceBundle.sha256`, `sourceSnapshot.sourceBundle.snapshotRef`, `sourceSnapshot.sourceBundle.snapshotSha`, `sourceSnapshot.sourceBundle.payloadDeletedAt`, and `sourceSnapshot.reviewBaseRef = sourceSnapshot.sourceBundle.snapshotSha`.
- Source bundle sha256 is verified before initial snapshot creation.
- Dirty source snapshot construction uses an isolated temp worktree/index and leaves the parent checkout's HEAD, index, and worktree unchanged.
- Cleanup/retry can re-point `sourceSnapshot.sourceBundle.snapshotRef` only when `git cat-file -e <sourceSnapshot.sourceBundle.snapshotSha>` proves the snapshot commit still exists; it does not rebuild commits from bundle payloads.
- Source preflight deletes transient source-bundle payload files immediately after snapshot verification and records `sourceSnapshot.sourceBundle.payloadDeletedAt`.
- Source bundle includes tracked unstaged diff, staged diff, and untracked non-ignored files.
- Source bundle exactly reproduces regular text/binary files, additions, modifications, deletions, renames, executable file mode, and symlinks.
- Source bundle fidelity covers partially staged files where index and worktree differ: staged add plus unstaged modify, staged modify plus further unstaged modify, and staged modify plus unstaged revert all produce a snapshot matching on-disk working-tree content.
- Source preflight rejects submodule gitlinks, device/FIFO/socket/special files, unreadable files, and unrepresentable paths with an actionable unsupported-entry message and no dispatch.
- Source bundle does not include ignored files.
- Ignored excluded files are disclosed through `sourceSnapshot.sourceBundle.ignoredExcludedManifestPath` with reason `ignored by git exclude rules`.
- Source snapshot helper unit coverage exercises bundle capture without invoking full orchestrate flow.
- Source snapshot creation does not mutate the parent worktree.
- Source snapshot commit parent is the recorded source `headSha`.
- Slice review changed-file detection uses `sourceSnapshot.reviewBaseRef` as its base when dirty source is acknowledged.
- Legacy or in-flight runs without `sourceSnapshot.reviewBaseRef` use the shared base resolver and `implementation` profile.
- `collectChangedFiles` excludes files that exist only in the source snapshot and includes only worker changes on top.
- Profile inference uses `sourceSnapshot.reviewBaseRef`, so inherited source snapshot files do not force `implementation`.
- Finalize/cleanup deletes the namespaced source snapshot ref while preserving ledger evidence.
- Partial snapshot setup that fails after creating the ref best-effort deletes the namespaced ref before returning failure.
- Snapshot cleanup failure records `sourceSnapshot.cleanup.status = 'warning'` with the failed ref name and does not report silent success.
- Cleanup failure records a warning and leaves the ref in place; v1 does not run automatic orphan-ref sweeps.
- [v1b] Worker lease tests prove existing coordinator dispatch writes `workerLease` without adding a daemon/queue/runtime, lifecycle observations update status/heartbeat, stale absent-PID leases permit ref cleanup, and fresh/live/unknown leases block ref cleanup.
- [v1b] Worker lease threshold tests pin `orchestrate.cleanup.staleWorkerLeaseMs` default 2h, reject configured values below 5m, allow source-ref cleanup only for stale heartbeat plus absent recorded PID, and refuse cleanup for stale heartbeat plus still-live recorded PID.
- [v1b] No-lease abandon tests prove non-running slices can finalize normally, while running/unknown no-lease slices can be marked abandoned only with a warning and without deleting the source ref.
- [v1b] Concurrent orchestrate runs keep isolated snapshot refs, and cleanup for one run does not delete another run's ref.
- Prepared slice worktree is created from `sourceSnapshot.reviewBaseRef`.
- Source snapshot creation failure blocks with message containing `Source snapshot creation failed`.
- Partial source snapshot setup failure blocks with message containing `Partial source snapshot setup failed`.
- Ledger load/save round-trips source snapshot.
- Malformed present `sourceSnapshot` makes the run ledger unreadable/corrupt.
- Malformed source snapshot evidence blocks dispatch/review and does not permit source ref deletion.

### Slice 2: Baseline Preflight Artifact

Touch:

- `src/operator/commands/orchestrate.ts`
- `src/operator/orchestration-ledger.ts`
- `test/pipelane.test.mjs`

Work:

- Move generated baseline work out of the slice list.
- Run baseline commands before slice dispatch.
- Create the baseline worktree from `sourceSnapshot.reviewBaseRef`.
- Write baseline summary artifact under run state.
- Store baseline command results in the ledger.
- Add an audited baseline-accept command that can mark specific failed baseline commands as known-red with a reason.
- Keep accepted failures visible as `accepted_failed`, never `passed`.
- Add optional ledger validators for `baselinePreflight`, command entries, and `acceptedFailure`; missing is legacy-compatible, malformed present values fail closed.
- Show baseline status in outline/status/analyze.

Tests:

- Baseline command success records passed preflight.
- v1a2 baseline dependency provisioning reuses the existing shared `node_modules` link path and records `baselinePreflight.dependencyProvisioning.status = 'linked'` or `'present'` before command evidence.
- Missing shared dependencies block baseline with `dependency_provisioning_failed` and do not record the selected command as a real test failure.
- Docs-only `baselinePreflight.profile` skips unscoped full-suite baseline commands with recorded skip reasons; docs-matching baseline commands run only in v1a2 when baseline command execution exists.
- `slices[].plannedPathScope` equals the normalized de-duplicated union of existing `slices[].requestedFiles[]` and optional analyzer-provided `plannedPathScope[]`.
- Unknown or mixed planned path scope sets `baselinePreflight.profile = 'implementation'`; v1a hard-blocks with `implementation-baseline-required`, and v1a2 runs full implementation baseline commands.
- Missing, empty, invalid, or unknown `slices[].plannedPathScope` on any approved slice sets `baselinePreflight.profile = 'implementation'`; v1a hard-blocks.
- Non-doc paths in acknowledged dirty source force `baselinePreflight.profile = 'implementation'`, even when planned slice paths are docs-only.
- Non-doc paths between `sourceSnapshot.headSha` and the resolved base ref force `baselinePreflight.profile = 'implementation'`, even when planned slice paths are docs-only; v1a hard-blocks and v1a2 runs implementation baseline.
- Unavailable `origin/<baseBranch>` falls back to local `<baseBranch>` only when it resolves and has a merge-base; `baselinePreflight.baseResolution` records the local fallback warning.
- Missing, unauthenticated, unavailable, or erroring `gh pr view` falls through to `origin/HEAD`, `main`, then `master` and only a successful PR lookup contributes `run.baseBranch`.
- Unavailable origin and local base refs force `baselinePreflight.profile = 'implementation'`, record `baselinePreflight.baseResolution.status = 'unresolved'`, and block v1a docs-only skipping.
- Legacy or absent-source-snapshot review blocks with an unresolved-base message when neither origin nor local base can be resolved.
- v1a2 docs-only baseline that later sees a code/config slice diff records one `baselinePreflight.profileHistory[]` transition under the run mutation lock, reruns skipped full-suite baseline commands under `implementation`, and blocks review until they pass or are accepted.
- v1a docs-only baseline that later sees a code/config slice diff hard-blocks before gates with implementation-baseline-required and can be marked failed/abandoned through existing clean-source finalize/cancel state.
- Up-front profile inference computes or refreshes every `slices[].reviewProfile` before any per-slice gate executes, so docs-only escape reruns happen before gate evidence is appended.
- Interrupted reviews that already recorded docs-only gate evidence before an implementation escape mark that evidence as pre-escape and block completion until implementation baseline and gates/bypass complete.
- Concurrent docs-only escape reviews serialize through the run mutation lock and record only one full-suite rerun.
- Baseline command failure blocks dispatch before worker slices start.
- Accepted baseline failure allows dispatch and records accepted failure reason.
- Accepted baseline failure remains visible in outline/status/analyze as `accepted_failed`.
- A new run after a prior baseline acceptance starts unaccepted; accepted failures never carry across runs.
- Known-red implementation-profile run documents the normal day-to-day path for this repo: full baseline runs, `test` blocks dispatch until the operator records audited per-run `baseline accept`, and slice completion requires audited per-slice bypass until passing replacement evidence exists.
- Baseline accept rejects an unknown command id.
- Baseline accept rejects a failed baseline command id that has no matching implementation-profile review gate by `(baselineCommandId ?? id)`.
- Baseline accept rejects a command that already passed.
- Baseline accept rejects a missing or blank reason.
- Baseline accept preserves original exit code, timeout flag, duration, and summary path.
- v1a2 baseline worktree is created from `sourceSnapshot.reviewBaseRef`.
- Baseline artifact path is preserved in ledger.
- Baseline failure is reported as preflight failure, not slice failure.
- Malformed present `baselinePreflight` makes the run ledger unreadable/corrupt.
- Malformed accepted-failure evidence is not treated as accepted and blocks dispatch.

### Slice 3: Slice Review Profiles

Touch:

- `src/operator/commands/orchestrate.ts`
- `src/operator/orchestration-ledger.ts`
- `src/operator/commands/review.ts`
- `test/pipelane.test.mjs`

Work:

- Add `reviewProfile` to slice records.
- Infer `docs-only` from changed paths relative to `sourceSnapshot.reviewBaseRef` using the strict docs-path rule from the Slice Review Profiles section.
- Default all non-doc changes to `implementation`.
- Include profile in review records and CLI output.

Tests:

- `docs/`, `README.md`, `CHANGELOG.md`, and root-level `*.md`/`*.mdx` diffs relative to `sourceSnapshot.reviewBaseRef` get `docs-only`.
- Code/config files under `docs/`, including `docs/build.js`, `docs/conf.py`, `docs/package.json`, and executable docs scripts, get `implementation`.
- Markdown files below `src/`, `test/`, `scripts/`, `templates/`, or config/package paths get `implementation`.
- Empty diffs and inherited-source-snapshot-only diffs get `implementation`.
- Deleted docs paths can get `docs-only`; deleted source/test/config paths get `implementation`.
- Renames classify using both old and new paths; renames crossing docs/code boundaries get `implementation`.
- Mixed docs and source diff relative to `sourceSnapshot.reviewBaseRef` gets `implementation`.
- Inherited source snapshot files do not affect profile inference for slice changes.
- Missing legacy profile defaults to `implementation`.
- Profile persists through ledger load/save.
- Malformed present `reviewProfile` resolves to `implementation` and does not trigger docs-only skipping.

### Slice 4: Profile-Aware Gate Selection

Touch:

- `src/operator/commands/review.ts`
- `src/operator/review-gates.ts`
- `test/pipelane.test.mjs`

Work:

- Teach review gate selection to consider `reviewProfile`.
- Add optional gate metadata `profiles?: OrchestrationReviewProfile[]`; absent preserves current behavior for implementation and non-orchestrate review.
- Annotate the existing `gstack-review` gate with `profiles: ['docs-only']` and docs-safe `whenChanged` patterns. This reuses the existing skill/prompt and does not add a new AI reviewer role, worker, model behavior, or prompt.
- Gate `profiles` are additive, not an allowlist. A gate still runs for implementation-profile slices whenever it would have run before profile-aware filtering; adding `profiles: ['docs-only']` or docs-safe `whenChanged` to `gstack-review` must not narrow or disable `gstack-review` for src-only implementation slices.
- For `docs-only`, skip unrelated full-suite gates only when `baselinePreflight.profile='docs-only'` and `slices[].reviewProfile='docs-only'`, unless `whenChanged` matches.
- For `docs-only`, run non-command AI/code gates only when both profiles are docs-only and `profiles` includes `docs-only` or `whenChanged` matches docs paths; otherwise skip with a docs-only AI/code reason.
- For implementation slices, carry accepted baseline failures into matching command gates as `pending` with a baseline-red reason unless a targeted replacement gate passes.
- A review command gate matches an accepted baseline command only when `(gate.baselineCommandId ?? gate.id)` exactly equals `baselinePreflight.commands[].id`; normalized command text is not a matching key.
- `baselinePreflight.commands[].id` values come from the shared command-gate catalog/snapshot before profile filtering. Accepting a failed baseline command is rejected unless an implementation-profile command gate has `(baselineCommandId ?? id)` equal to that baseline command id.
- Add optional command-gate metadata `baselineCommandId`.
- Add optional command-gate metadata `replacesBaselineCommandId`.
- A targeted replacement gate resolves a baseline-red pending command only when it passes and its `replacesBaselineCommandId` exactly matches the accepted baseline command id.
- Persist replacement evidence with the baseline command id, replacement gate id, and replacement gate result.
- Provide an audited per-slice baseline-red bypass command for cases where a targeted replacement gate cannot prove the slice clean. This must require a reason and must stay visible in the slice review record.
- Record skip reasons in review output.
- Keep implementation profile behavior strict.

Tests:

- Docs-only profile skips unscoped `npm test`, `npm run build`, and `npm run typecheck` only when run-level `baselinePreflight.profile` is also docs-only.
- Docs-only profile runs a gate whose `whenChanged` matches docs paths.
- Docs-only profile records skipped full-suite gates with reason `docs-only profile, gate has no matching whenChanged path`.
- Docs-only profile runs existing `gstack-review` when annotated with `profiles: ['docs-only']`.
- Src-only implementation profile still runs existing `gstack-review`; docs-only metadata does not narrow its implementation execution.
- Docs-only profile runs any other non-command AI/docs gate with `profiles: ['docs-only']`.
- Docs-only profile skips unscoped AI/code gates with reason `docs-only profile, AI/code gate not scoped to docs`.
- Implementation profile still runs full configured gates.
- Standalone `/pipelane review` and legacy reviews with no `reviewProfile` keep the same gate set and execution order as before v1a.
- Implementation profile marks a known-red baseline command gate as pending/blocked instead of pretending it passed.
- A non-matching command gate whose `(baselineCommandId ?? id)` does not equal an accepted baseline command id is evaluated normally and does not become baseline-red pending.
- Targeted replacement gate can satisfy a known-red full-suite command without changing the full-suite command's known-red evidence.
- Passing gates without a matching `replacesBaselineCommandId` do not satisfy a known-red full-suite command.
- Malformed replacement-gate links leave the known-red command pending.
- Audited per-slice baseline-red bypass allows completion while preserving the known-red evidence trail.
- Baseline-red bypass rejects a missing or blank reason.
- Baseline-red bypass is stored as bypass evidence, not as a passing command-gate result.
- Baseline-red bypass evidence records `slices[].review.gates[].baselineRedResolution.bypass.reason`, `.acceptedBy`, and `.acceptedAt`.
- Skip reason includes profile and path-scope explanation.

### Slice 5: Deterministic Gate Order

Touch:

- `src/operator/commands/review.ts`
- `src/operator/review-gates.ts`
- `test/pipelane.test.mjs`

Work:

- Add optional `order` to gate schema.
- Add one shared `resolveReviewGateExecutionOrder(gates, catalogOrder)` resolver.
- Resolve order through explicit order, generated catalog order, config array order, id fallback.
- Use the shared resolver from both default gate generation and `buildReviewRunRecord`.
- Change generated command order to `typecheck -> test -> build`.
- Persist resolved order in review run record.

Tests:

- Explicit orchestrate `order` wins.
- Shared orchestrate resolver is the only place implementing orchestrate ordering policy.
- Orchestrate config array order is preserved for gates without explicit order.
- Orchestrate-generated gates use `typecheck -> test -> build`.
- Fresh no-`dist` source-mode fixture proves the traced CLI fallback path can run before `build`; it does not claim whole-suite dist independence.
- Legacy orchestrate id fallback remains deterministic.
- Orchestrate setup/default gate generation and orchestrate review execution produce the same resolved order for the same gate list.

### Slice 6: Docs And Generated Guidance

Touch:

- `docs/public/ORCHESTRATION.md`
- `src/operator/skill-rendering.ts`
- `test/pipelane.test.mjs`

Work:

- Document source preflight, baseline preflight, review profiles, gate ordering, and ignored-output follow-up scope.
- Update generated `/orchestrate` guidance so future plans produce baseline preflight instead of Phase 0 baseline slices.
- Add a short operator troubleshooting section for baseline failures and the deferred ignored-output cleanup/isolation follow-up.

Tests:

- Generated guidance does not produce baseline implementation slices.
- Public docs include the new preflight and profile semantics.

## Code Path Coverage Plan

```text
CODE PATH COVERAGE
==================
[+] /orchestrate entry
    |
    +-- source preflight
    |   +-- clean parent worktree -> continue                 [test]
    |   +-- dirty parent, no acknowledgement -> block         [test]
    |   +-- dirty parent, acknowledgement -> create bundle     [test]
    |   +-- unsupported bundle entry -> block preflight        [test]
    |   +-- snapshot ref creation succeeds -> continue         [test]
    |   +-- snapshot ref creation fails -> block               [test]
    |   +-- partial snapshot setup -> rollback or warn         [test]
    |   +-- cleanup failure -> ledger warning + retry target   [test]
    |   +-- active matching run -> preserve snapshot ref       [test]
    |   +-- concurrent runs -> isolated namespaced refs         [test]
    |   +-- ignored file in parent -> excluded + disclosed     [test]
    |
    +-- baseline preflight
    |   +-- source bundle applied -> run commands              [test]
    |   +-- all commands pass -> dispatch slices              [test]
    |   +-- command exits non-zero -> block before dispatch    [test]
    |   +-- command exits non-zero + accepted -> dispatch       [test]
    |   +-- invalid acceptance request -> reject                [test]
    |   +-- command times out -> record timeout + block        [test]
    |
    +-- slice dispatch
        +-- worktree created from reviewBaseRef               [test]
        +-- docs-only inferred -> docs profile                [test]
        +-- source/mixed inferred -> implementation profile   [test]

[+] /orchestrate review
    |
    +-- review base
    |   +-- clean source -> compare against local HEAD         [test]
    |   +-- dirty source -> compare against reviewBaseRef     [test]
    |   +-- legacy missing sourceSnapshot -> origin base       [test]
    |   +-- v1 ledger under legacy coordinator -> block        [test]
    |   +-- rollback drain blocks active v1 runs              [test]
    |   +-- rollback below guard floor unsupported             [test]
    |   +-- legacy no-v1 run remains compatible               [test]
    |   +-- inherited snapshot file -> absent from slice diff  [test]
    |
    +-- implementation profile
    |   +-- strict command gates run                          [test]
    |   +-- known-red baseline gate becomes pending            [test]
    |   +-- non-matching command gate runs normally            [test]
    |   +-- linked targeted replacement gate passes            [test]
    |   +-- unlinked replacement-like gate stays pending       [test]
    |   +-- audited baseline-red bypass records reason         [test]
    |   +-- invalid baseline-red bypass -> reject              [test]
    |   +-- AI/code gates run                                 [existing + targeted]
    |
    +-- docs-only profile
    |   +-- empty/inherited-only diff -> implementation        [test]
    |   +-- deletion/rename path classification                [test]
    |   +-- matching whenChanged gate runs                    [test]
    |   +-- docs-scoped AI gate runs                           [test]
    |   +-- unscoped AI/code gate skips with reason            [test]
    |   +-- unscoped full-suite gate skipped with reason       [test]
    |
    +-- no review profile
    |   +-- standalone /pipelane review unchanged              [test]
    |
    +-- orchestrate gate order
    |   +-- explicit order                                    [test]
    |   +-- config order                                      [test]
    |   +-- generated catalog order                           [test]
    |   +-- no-dist CLI fallback proof                       [test]
    |   +-- stable legacy fallback                            [test]
```

## Failure Modes

| Failure mode | Planned handling | Test |
|---|---|---|
| Dirty source silently excluded from worker worktrees | Block or require recorded source bundle, create a local source snapshot commit/ref, and use `sourceSnapshot.reviewBaseRef` as the baseline and slice base. | Dirty parent blocks; snapshot records; worktrees use `reviewBaseRef`; creation failure blocks. |
| Source snapshot pollutes every slice diff | Store `sourceSnapshot.reviewBaseRef` and compare slice review/profile inference against that immutable base. | Dirty source snapshot files excluded from slice changed-files tests. |
| Dirty source review base points at pre-snapshot HEAD | Dirty acknowledged runs set `sourceSnapshot.reviewBaseRef = sourceSnapshot.sourceBundle.snapshotSha`, not `headSha`. | Dirty review-base equality test. |
| Source snapshot misses dirty content | Snapshot tree must equal on-disk working-tree content relative to `HEAD` plus untracked non-ignored files. | Real-git content-fidelity test covering regular text/binary files, modification, addition, deletion, rename, executable mode, and symlink cases. |
| Partially staged file snapshots index state instead of visible source | Worktree content wins when index and worktree differ for a path. | Partially-staged real-git fixtures for staged add plus unstaged modify, staged modify plus further unstaged modify, and staged modify plus unstaged revert. |
| Source bundle cannot represent a dirty entry safely | Fail closed before dispatch for submodule gitlinks, special files, unreadable files, and unrepresentable paths; do not create a partial ref unless the later partial-setup rollback path handles it. | Unsupported-entry fixtures and no-partial-dispatch assertions. |
| Clean source creates unnecessary bundle state | Clean source records no `sourceSnapshot.sourceBundle` and uses local `HEAD` as `sourceSnapshot.reviewBaseRef`. | Clean-source review-base test. |
| Legacy run loses previous review-base behavior | Missing `sourceSnapshot.reviewBaseRef` uses the shared base resolver, then implementation profile; unresolved base blocks with an actionable message. | Legacy absent-snapshot fallback and unresolved-base tests. |
| Planned path scope is ambiguous | Use union of `requestedFiles[]` and optional analyzer `plannedPathScope[]`; missing, empty, invalid, or unknown scope forces implementation. | Planned-scope union and fail-closed tests. |
| `origin/<baseBranch>` is unavailable | Fall back to local `<baseBranch>` only if it resolves and has a merge-base, recording `baseResolution.status = 'local'`. | Origin-missing local-base test. |
| No origin or local base resolves | Clean baseline classification uses implementation profile; legacy review blocks with unresolved-base message and no docs-only skipping. | Unresolved-base baseline and legacy-review tests. |
| Source snapshot refs accumulate forever | Namespace refs under `refs/pipelane/orchestrate/<run-id>/source` and delete them on finalize/cleanup. | Cleanup deletes source snapshot ref and ledger still loads. |
| Source bundle is write-only or grows forever | Bundle sha is verified before initial snapshot creation; the transient payload is deleted immediately after snapshot verification while preserving sha/snapshot metadata in the audit manifest. | Bundle verify and immediate payload deletion tests. |
| Abandoned run leaks refs forever | Non-terminal runs preserve refs by default, but explicit finalize/abandon with reason can mark an inactive run failed/abandoned and reclaim only that run's namespaced ref. | Abandoned inactive run cleanup and active-run preservation tests. |
| Abandon deletes ref under active worker | Ref cleanup requires stale worker lease plus absent recorded PID; fresh/unknown/live worker evidence blocks ref deletion. | Active-worker lease and stale-worker reclaim tests. |
| Running slice has no worker lease | Do not soft-lock the run and do not delete the ref. Mark abandoned only with explicit no-lease warning and leave source ref in place for manual inspection. | No-lease abandon warning test. |
| Stale worker lease, PID absent | Source-ref cleanup is allowed. | `heartbeatAt` is older than `orchestrate.cleanup.staleWorkerLeaseMs` default 2h and recorded PID no longer exists; cleanup deletes only the current run's namespaced ref and records evidence. |
| Stale worker lease, PID present | Source-ref cleanup is refused. | Even with a stale `heartbeatAt`, an existing recorded PID blocks ref deletion and records a warning. |
| Partial snapshot setup leaves a dangling ref | Best-effort delete the namespaced ref before returning failure; if deletion fails, block dispatch and record cleanup warning evidence. | Partial setup rollback and rollback-warning tests. |
| Cleanup fails during finalize | Finalize records `sourceSnapshot.cleanup.status = 'warning'` with the ref name and retry target instead of reporting silent success. | Cleanup failure warning and retry tests. |
| Cleanup deletes another run's source ref | Ref cleanup is namespaced by exact run id and performed only after acquiring the target run mutation lock and re-verifying terminal status plus matching `sourceSnapshot.sourceBundle.snapshotRef`. | Concurrent-run isolation test. |
| Cleanup deletes an active matching run's source ref | V1 cleanup only touches the current run's ref during finalize/cleanup. On doubt or delete failure, it records a warning and leaves the ref in place. | Cleanup warning/leaked-ref test. |
| Concurrent runs corrupt ledger state | Run ledger, mutation lock, and integrity head are per run id; interleaved writes across different runs must stay isolated, and same-run concurrent mutation is serialized or rejected. | Two-run interleaving and same-run lock/integrity tests. |
| Baseline failure looks like implementation slice failure | Baseline is a run preflight with explicit blocked or accepted-failed status. | Failed baseline blocks; accepted failure dispatches but stays visible. |
| Baseline temp worktree lacks dependencies | Reuse shared `node_modules` provisioning before command gates; missing dependencies block as `dependency_provisioning_failed`, not fake test evidence. | Dependency-provisioned baseline and missing-dependency tests. |
| Accepted known-red baseline later looks green | Matching slice command gate becomes pending or requires targeted replacement evidence. | Known-red baseline gate pending test. |
| Known-red suite becomes daily operator friction | Name `test` / `npm test` as the known-red command in docs, but keep v1 unblocking manual through audited per-run `baseline accept`; review completion still needs audited bypass until passing replacement evidence exists. | Known-red steady-state workflow and bypass tests. |
| Automatic known-red matching becomes brittle scope creep | Do not implement failure-signature parsing or hashing in v1; failed baselines block until manually accepted. | No `failureSignature` persisted-key/test requirement; manual accept path tested instead. |
| Wrong command enters baseline-red pending | Only `(baselineCommandId ?? gate.id)` equal to `baselinePreflight.commands[].id` creates baseline-red pending state. | Matching and non-matching command-id tests. |
| Accepted red baseline command has no matching review gate | Baseline accept rejects failed command ids that no implementation-profile review gate links to. | Unmatched baseline-command accept rejection test. |
| Malformed accepted-failure evidence permits dispatch | Malformed accepted-failure evidence is ignored as acceptance; the command remains failed and dispatch stays blocked. | Malformed accepted-failure blocks dispatch test. |
| Accepted known-red baseline deadlocks every slice review | Targeted replacement gate or audited per-slice baseline-red bypass can satisfy review without hiding the known-red command. | Replacement gate and bypass tests. |
| Unlinked replacement gate accidentally clears known-red baseline | Only a passing gate with `replacesBaselineCommandId` equal to the accepted baseline command id can resolve that pending command. | Linked and unlinked replacement gate tests. |
| Source bundle omits intended ignored WIP file | Ignored files are excluded by default and CLI states that clearly. Operator must stage/move the file or use a non-ignored path. | Ignored-file exclusion test and CLI copy test. |
| Ignored file exclusion is invisible | Ignored excluded files are listed in `sourceSnapshot.sourceBundle.ignoredExcludedManifestPath` with reason `ignored by git exclude rules`. | Ignored exclusion manifest test. |
| Docs-only artifact triggers full suite | Only run+slice docs-only profiles skip unscoped full-suite gates; matching `whenChanged` gates still run. | Docs-only skip reason and matching docs-gate tests. |
| Docs-only run is blocked by unrelated red baseline | `baselinePreflight.profile = 'docs-only'` skips unscoped full-suite baseline commands and records skip reasons; unknown/mixed/code scope is implementation, which hard-blocks in v1a and runs implementation baseline in v1a2. | Docs-only baseline skip, v1a implementation hard-block, and v1a2 mixed baseline tests. |
| Docs-only baseline later escapes to code without full baseline | V1a hard-blocks before gates; v1a2 reruns skipped full-suite baseline commands under implementation before review can complete. | Docs-only escape hard-block, profile-history, and rerun tests. |
| Code under docs skips implementation gates | Docs-safe classification excludes code/config files under `docs/`; those force implementation. | `docs/build.js` and `docs/conf.py` profile tests. |
| Docs-only skips the wrong AI review gates | Non-command gates run only when `profiles` includes `docs-only` or `whenChanged` matches docs; unscoped AI/code gates skip with a reason. | Docs-scoped AI gate run and unscoped AI/code skip tests. |
| Docs-only metadata disables implementation AI review | `profiles` is additive, not an allowlist. | Src-only implementation slice still runs existing `gstack-review`. |
| Profile-aware filtering changes standalone review | Missing `reviewProfile` preserves current non-orchestrate gate selection and order. | Standalone `/pipelane review` gate-set and order regression test. |
| Empty diff skips full-suite gates by vacuous docs-only match | Docs-only requires at least one qualifying classification path; empty and inherited-only diffs default to implementation. | Empty diff and inherited-only profile tests. |
| Deletion or rename hides a source change behind docs-only profile | Deleted paths classify by deleted name; renamed/copied paths classify by both old and new names. | Deletion-only and cross-boundary rename tests. |
| `build` changes later test behavior | Orchestrate build-output safety invariant requires `test` before `build` unless build runs isolated. | Orchestrate-generated order and build-before-test rejection tests. |
| Tests actually require build output outside the traced CLI fallback seam | v1a does not claim whole-suite dist independence. Full-suite dist-dependency auditing and any scoped build-for-test/isolation fix are follow-up. | No-`dist` CLI fallback proof plus explicit follow-up scope. |
| Ref lifecycle tests pass against mocks only | Ref, bundle, cleanup, and concurrency tests must use real temporary git repositories. | Harness asserts actual commits, refs, worktrees, deletions, and renames. |
| Legacy runs lack new fields | Defaults keep legacy slices as implementation and missing source/baseline preflight as absent/not started. | Ledger compatibility test. |
| Rolled-back coordinator resumes a v1 run unsafely | Schema/capability guard refuses v1 ledgers when the coordinator does not support the required fields; no origin-base fallback and no source-ref deletion occur. | V1-ledger under compatibility-mode coordinator test. |
| Coordinator rollback strands active v1 runs | Rollback below v1 is allowed only after a drain check shows no non-terminal v1-marked runs; emergency recovery uses a v1-capable coordinator to finalize/abandon before rollback. | Rollback drain check test. |
| Rollback below guard floor resumes v1 ledgers unsafely | The guard-introducing release is the minimum safe rollback floor; v1 writers are not enabled until that guard is deployed and baked. | Rollback floor guard test. |
| V1 marker strands legacy runs unnecessarily | Stamp the v1 schema/capability marker only when a substantive v1 field is first persisted. | Legacy no-v1 marker compatibility test. |
| Malformed new ledger fields silently survive | Fail-closed handling blocks unsafe dispatch/review, resolves malformed profiles to implementation, and keeps malformed replacement evidence pending. | Malformed ledger field tests. |
| Baseline command hangs | Baseline records timeout and blocks dispatch. | Timeout fixture test. |

No critical gap should remain with no test, no error handling, and silent user impact.

## Verification Commands

Focused:

```bash
node --test --test-name-pattern 'orchestrate.*dirty source|orchestrate.*source bundle|orchestrate.*source snapshot|orchestrate.*baseline preflight|orchestrate.*review profile|review.*gate order' test/pipelane.test.mjs
```

No-`dist` CLI fallback proof for the traced gate-order seam, run in a fresh worktree before `npm run build`:

```bash
node --test --test-name-pattern 'orchestrate bare command refuses non-interactive setup without an active run' test/pipelane.test.mjs
```

Verified locally on 2026-07-02 in a detached temp worktree with `dist/cli.js` absent: 1 test passed.

Standard:

```bash
npm run typecheck
npm run build
```

Broader targeted review:

```bash
node --test --test-name-pattern 'orchestrate|review gate|generated /orchestrate' test/pipelane.test.mjs
```

Full `npm test` should be run once the known baseline failures are addressed. This plan should not claim full-suite green until the existing red suite is fixed.

## Incremental Landing Order

1. v1a: Land canonical validators, schema/capability guard, and legacy fallbacks first, preserving existing review behavior when new fields are absent and refusing unsupported v1 ledgers in compatibility mode.
2. v1a: Land clean-source review-base plumbing next: record `sourceSnapshot.status = 'clean'`, `headSha`, `reviewBaseRef = headSha`, and legacy base fallback without source bundles or refs.
3. v1a: Land orchestrate deterministic gate order plus the no-`dist` CLI fallback proof next, so the traced `dist/cli.js` seam is validated without claiming whole-suite dist independence.
4. v1a: Land docs-only baseline preflight next, including profile computation, skipped full-suite baseline commands for docs-only, and hard-block for implementation-profile/escape cases.
5. v1a: Land review profile inference and profile-aware gate filtering next, including existing `gstack-review` docs-only annotation and standalone review regression tests.
6. v1a: Land docs-only escape hard-block and conservative warning behavior last, each behind focused tests and rollback boundaries.
7. v1a2: Land implementation baseline preflight, manual baseline accept, baseline-red replacement/bypass evidence, and docs-only escape rerun.
8. v1b: Land dirty-source bundle/ref lifecycle and worker-lease abandon safety after v1a has shipped or is independently green.

## Worktree Parallelization Strategy

| Step | Modules touched | Depends on |
|---|---|---|
| Clean Source Review Base | `src/operator/commands/`, `src/operator/orchestration-ledger.ts`, `test/` | None |
| Baseline Preflight Artifact | `src/operator/commands/`, `src/operator/orchestration-ledger.ts`, `test/` | Clean Source Review Base |
| Slice Review Profiles | `src/operator/commands/`, `src/operator/orchestration-ledger.ts`, `test/` | Clean Source Review Base |
| Profile-Aware Gate Selection | `src/operator/commands/`, `src/operator/review-gates.ts`, `test/` | Slice Review Profiles, Baseline Preflight Artifact |
| Orchestrate Deterministic Gate Order | `src/operator/commands/`, `src/operator/review-gates.ts`, `test/` | None |
| Dirty Source Bundle/Ref Lifecycle | `src/operator/commands/`, `src/operator/orchestration-ledger.ts`, `src/operator/orchestration-source-snapshot.ts`, `test/` | Clean-source baseline/profile/gate-order path tested |
| Ignored Output Cleanup/Isolation Follow-Up | `src/operator/commands/`, `src/operator/worktree-status.ts`, `test/` | Deferred out of v1; revisit after gate order lands |
| Docs And Generated Guidance | `docs/public/`, `src/operator/skill-rendering.ts`, `test/` | Baseline/Profile semantics stable |

Parallel lanes:

```text
Lane A: Clean Source Review Base -> Baseline Preflight Artifact -> Slice Review Profiles -> Profile-Aware Gate Selection -> Dirty Source Bundle/Ref Lifecycle
Lane B: Orchestrate Deterministic Gate Order
Lane C: Docs And Generated Guidance, after A and B semantics settle
```

Conflict flags:

- Lane A and Lane B both touch `src/operator/commands/review.ts` and `test/pipelane.test.mjs`.
- Parallel worktrees are possible, but merge order should be deliberate: land Lane B first if it stays self-contained, then Lane A, then docs.

## Open Decisions

Resolved:

- Dirty source policy: block by default, allow explicit audited acknowledgement with reason.
- Dirty source mechanics: acknowledgement creates a source bundle, materializes it into a local source snapshot commit/ref, and creates baseline/slice worktrees from `sourceSnapshot.reviewBaseRef`.
- Dirty source review base: slice review and profile inference compare against `sourceSnapshot.reviewBaseRef` when dirty source is acknowledged.
- Baseline handling: run-level preflight artifact, not a slice profile.
- Baseline failure policy: baseline failures block by default, but specific failed commands can be accepted with an audited reason and remain `accepted_failed`.
- Docs-only routing: included in v1 because it is the direct fix for docs-only baseline artifacts triggering unrelated full-suite gates; the docs-only escape rerun lands last after lower-risk profile and lock semantics.
- Ignored-output behavior: deferred. V1a mitigates the known `dist/cli.js` CLI fallback seam through gate ordering; whole-suite dist independence, telemetry, reset, or isolation are follow-up work.
