# Pipelane Orchestration Hardening Plan

Last updated: June 19, 2026
Status: reviewed and ready to implement

## Summary

The four planned orchestration UX slices have landed:

1. Interactive `/pipelane review setup`
2. Bare `/pipelane orchestrate` setup/open flow
3. `/pipelane status` orchestration and next-action cockpit
4. Reviewer independence enforcement

This next slice closes the hardening gaps left by the original
`ORCHESTRATION_UX_PLAN.md` failure-mode matrix. The goal is not to add new UX.
The goal is to make the existing orchestration UX fail loud, recover cleanly,
and keep tests aligned with the contract promised in the plan.

## Source Plan

Primary source: `docs/public/ORCHESTRATION_UX_PLAN.md`

Relevant promised behavior:

- Corrupt orchestration ledgers fail closed with repair guidance.
- Deleted slice worktrees surface clear recovery guidance.
- Status action prompts never leave orphaned pending decisions.
- Instruction audit gates stay scoped to repo-owned instruction files.
- Recovery tests exercise the actual recovery surface, not just rendering.

## What Already Exists

| Existing code | What it already solves | Reuse decision |
| --- | --- | --- |
| `src/operator/orchestration-ledger.ts` | Builds, saves, loads, and lists orchestration ledgers through versioned state helpers | Reuse and add diagnostics around malformed records |
| `src/operator/state.ts` | Owns versioned JSON state migration and missing-state warnings across multiple consumers | Extract normalization carefully and regression-test non-orchestration readers |
| `src/operator/commands/orchestrate.ts` | Bare command entry point, active-run detection, preview, prepare, dispatch, start, review | Reuse command flow; add fail-closed guards before new run setup |
| `src/operator/api/snapshot.ts` | Exposes active orchestration run summaries to `/status` and board consumers | Reuse snapshot shape; add missing-worktree/corrupt-ledger attention where needed |
| `src/operator/commands/status.ts` | Interactive next-action prompt with durable decision records | Reuse decision recording; add recovery-path tests rather than new prompt machinery |
| `src/operator/review-gates.ts` | Canonical review gate catalog, including `karpathy-audit` instruction gate | Reuse catalog; test and tighten repo-owned path scope |
| `test/pipelane.test.mjs` | Existing integration-style CLI tests and state fixtures | Reuse colocated test style; avoid new test framework |

## Slice Goal

Make orchestration recovery boring.

When a human runs `/pipelane orchestrate` or `/pipelane status`, Pipelane should
not silently ignore corrupt orchestration state, missing slice worktrees, stale
action inputs, or instruction-audit scope drift. It should report exactly what
is wrong, show the safest next command, and avoid mutation unless the existing
preflight/execute path approves it.

## Scope

### 1. Corrupt Ledger Diagnostics

Current behavior: `loadOrchestrationRunRecord()` returns `null` for malformed
or unreadable run JSON. User-facing callers then report "No orchestration run
ledger found", which conflates absence with corruption.

Planned behavior:

- Add a small diagnostic read path that distinguishes:
  - missing ledger
  - malformed JSON / schema-normalized null
  - invalid run id
  - valid ledger
- Reuse the existing versioned state-file policy in `src/operator/state.ts`.
  Do not introduce a second migration or repair framework for orchestration.
- The diagnostic helper should read the raw JSON once, catch parse failures,
  then pass valid objects through the existing versioned normalization path.
  Implement this by extracting a small normalization helper from
  `readVersionedJsonFile()` and keeping the public reader behavior unchanged.
- Bare `/pipelane orchestrate` should fail closed before starting new work when
  a malformed run ledger is active-looking or when Pipelane cannot prove it is
  abandoned. This avoids silently ignoring a current run, without letting
  ancient broken state brick the entry point forever.
- Active-looking policy:
  - explicit `--run-id` always reports corruption for that run
  - bare `/pipelane orchestrate` blocks starting a new run when corrupt run
    files were touched inside the last 14 days and no valid active run can be
    opened instead
  - if valid active runs coexist with recent corrupt ledgers, keep the valid
    runs openable and surface the corrupt ledger as a blocking attention item in
    chooser/status output rather than hiding it
  - older corrupt run files are reported as non-blocking cleanup warnings, not
    hidden
  - invalid run-id directories under
    `.pipelane/state/orchestrate/runs/` are non-blocking cleanup warnings,
    because they are not addressable Pipelane run records; explicit invalid
    `--run-id` input still fails validation before file access
  - tests should set ledger mtimes deterministically with `utimesSync` and use a
    named threshold constant instead of relying on wall-clock file creation time
  - mtime is only a conservative freshness heuristic. If a restored backup is
    still malformed and gets a fresh mtime, Pipelane should keep reporting it
    until the user repairs the JSON or moves the abandoned run directory aside.
- Move-aside recovery must name a destination outside the active scan root, for
  example `.pipelane/state/orchestrate/abandoned/<run-id>`. Do not instruct users
  to rename the directory in-place under `runs/`, because that can turn a corrupt
  run into an invalid run-id directory without proving the recovery path works.
- `/pipelane orchestrate --run-id <id>` should report the exact ledger path and
  manual repair choices when that specific ledger is corrupt.
- Listing valid active runs should keep working when unrelated stale/malformed
  directories are absent or safely ignored.

Diagnostic exit/output contract:

- Explicit corrupt `--run-id`: exit 1, print `Orchestration ledger is
  unreadable`, the exact ledger path, `No state was changed.`, and the repair
  choices.
- Bare `/pipelane orchestrate` with only recent corrupt active-looking ledgers:
  exit 1, print the same unreadable-ledger block, and do not enter setup.
- Bare `/pipelane orchestrate` with at least one valid active run plus recent
  corrupt ledgers: exit 0 when the operator opens/cancels a valid run path, keep
  valid runs selectable, and include a blocking attention line naming each
  corrupt ledger path. Do not start a new run while hiding the corrupt state.
- Bare `/pipelane orchestrate` with only older corrupt ledgers or invalid
  run-id directories under `runs/`: exit 0 when normal setup/open flow succeeds
  or is cancelled, print cleanup warnings naming the ignored paths, and do not
  treat those paths as addressable run records.
- Explicit invalid `--run-id`: exit 1 before file access with the existing run
  id validation error.

User-facing guidance should be concrete:

```text
Orchestration ledger is unreadable:
  path: .pipelane/state/orchestrate/runs/orchestrate-.../orchestration.json

No state was changed.

Next:
1. Restore the ledger from a known-good backup/local copy if this run matters.
2. Move the corrupt run directory outside .pipelane/state/orchestrate/runs/
   if the run is abandoned, for example to:
   .pipelane/state/orchestrate/abandoned/orchestrate-...
3. Re-run /pipelane orchestrate after repair.
```

### 2. Missing Slice Worktree Guidance

Current behavior: orchestration review satisfaction checks know when a slice
worktree is gone, but command output and status guidance are uneven.

Planned behavior:

- For slices with a ledger-assigned worktree that should be usable
  (prepared/dispatched/running, or planned with a stale assignment),
  `/pipelane orchestrate --run-id <id>` should show a blocked slice row when
  the assigned path is missing.
- Define the "missing and relevant worktree" predicate once in the orchestration
  snapshot/summarization layer: assigned path is present, path does not exist,
  and slice status is prepared/dispatched/running or planned with a stale
  assignment. `/pipelane orchestrate`, `/status --json`, terminal `/status`, and
  board consumers must render that same computed result instead of duplicating
  predicate logic.
- `buildWorkflowApiSnapshot()` should surface an attention item for the missing
  slice worktree when the run is active, so `/status --json`, the board, and
  terminal `/status` all see the same truth.
- Recovery guidance should prefer existing primitives:
  - verified CLI surface today: `orchestrate start` accepts `--slice-id` and
    `--force`; `orchestrate prepare` does not accept `--slice-id`
  - `orchestrate prepare --run-id <id>` only for unassigned planned slices; do
    not show an unsupported `prepare --slice-id` command
  - restore the missing assigned worktree path, or manually repair/move aside
    the stale ledger/task-lock assignment, before retrying prepare
  - `orchestrate start --run-id <id> --slice-id <slice> --force` only when the
    worktree exists and a stale worker record needs retry
- Do not auto-recreate or auto-start from status.

### 3. Status Decision Failure Coverage

Current behavior: status now records prompt/preflight exceptions as failed
decisions. The happy path, cancel path, and one required-input error path are
covered.

Planned behavior:

- Add coverage for exhausted scripted input.
- Add coverage for preflight returning `blocked` after collected input.
- Add coverage for execute failure after preflight succeeds and the operator
  approves the action.
- Assert every terminal interactive status outcome updates the durable decision
  away from `pending`.
- Use concrete fixtures:
  - exhausted input: dirty task worktree asks for PR title, receives a title,
    then exhausts before the approval prompt
  - blocked preflight: dirty task worktree asks for PR title, receives one,
    then `/pr` preflight blocks on missing review evidence
  - execute failure: preflight succeeds, the operator approves, the execute path
    returns failure or throws, and the saved decision becomes `failed`

State diagram:

```text
candidate selected
      |
      v
pending decision saved
      |
      +--> preflight blocked -----------> blocked decision + exit 1
      |
      +--> prompt/input error ----------> failed decision + exit 1
      |
      +--> user declines ---------------> cancelled decision + exit 0
      |
      +--> execute ok ------------------> executed decision + exit 0
      |
      +--> execute fails ---------------> failed decision + exit 1
```

### 4. Instruction Audit Scope Tests

Current behavior: `karpathy-audit` is cataloged for repo-owned instruction
paths such as `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/**`, and
`.codex/skills/**`.

Planned behavior:

- Add tests that prove the default instruction gate does not include foreign or
  global skill directories such as:
  - `~/.claude/**`
  - `~/.codex/skills/**`
  - `.claude/skills/**`
  - plugin caches
- Preserve explicit repo-owned `.codex/skills/**` support.
- Matching rule: default instruction-audit paths are the explicit catalog paths
  only. `.codex/skills/**` stays included because it is already treated as a
  repo-owned Codex skill surface; `.claude/skills/**` stays excluded in this
  repo because `.claude/` is local operator state and gitignored, not
  distributable project source. If repo-owned Claude skill support is desired
  later, add it as a separate explicit product change with its own tests.
- Do not add provider-specific audit execution. This remains deterministic gate
  configuration and changed-file matching.

## NOT In Scope

- New orchestration UX flows.
- Provider authentication setup.
- Cross-provider implementation dispatch.
- Automatic ledger repair.
- Automatic worktree recreation from `/status`.
- Replacing the existing versioned JSON state helpers.
- Moving review/audit AI execution into the Pipelane CLI.

## Architecture

The hardening slice should be a thin diagnostic layer around existing state and
command flows.

```text
/pipelane orchestrate
        |
        v
resolve workflow context
        |
        v
scan orchestration run directory
        |
        +--> invalid/corrupt ledger?
        |       |
        |       +--> valid active run openable? ---- yes ---> open valid run + show repair attention
        |       |
        |       `--> no ----------------------------> fail closed with path + repair guidance
        |
        no
        |
        v
existing active-run / setup / preview flow
```

For status:

```text
/pipelane status
        |
        v
buildWorkflowApiSnapshot()
        |
        +--> valid orchestration run summaries
        +--> shared missing-and-relevant worktree diagnostics
        +--> attention[] for missing active slice worktrees
        |
        v
render cockpit
        |
        v
optional interactive next action via API preflight/execute
```

No new long-lived service, watcher, background worker, or provider adapter is
needed.

## Implementation Steps

1. Extract a shared versioned-state normalization helper in
   `src/operator/state.ts`, then add ledger diagnostic helpers in
   `src/operator/orchestration-ledger.ts`.
2. Use diagnostics in `src/operator/commands/orchestrate.ts` before active-run
   selection or interactive setup.
3. Add missing-worktree attention/guidance in `buildWorkflowApiSnapshot()`;
   renderers only display the shared snapshot truth.
4. Tighten or assert instruction-audit gate path scope in
   `src/operator/review-gates.ts`.
5. Add focused tests in `test/pipelane.test.mjs`.
6. Update public docs if user-facing output or recovery commands change.

## Test Plan

Use the existing Node test runner:

```bash
node --test --test-name-pattern "orchestration hardening|status interactive action|instruction audit" test/pipelane.test.mjs
npm test
npm run typecheck
npm run build
```

The targeted command keeps the slice feedback loop tight, but the final gate
must also run `npm test` because extracting normalization from
`readVersionedJsonFile()` touches shared state loading for deploy, PR, review,
action, task-lock, mode, and orchestration consumers.

### Code Path Coverage

```text
CODE PATH COVERAGE
==================
[+] src/operator/orchestration-ledger.ts
    |
    +-- load valid ledger
    |   `-- [existing] orchestration plan/start/review tests
    |
    +-- missing ledger
    |   `-- [existing] explicit --run-id missing test
    |
    +-- malformed ledger
        `-- [GAP] corrupt JSON or schema-null record returns repair guidance

[+] src/operator/commands/orchestrate.ts
    |
    +-- no active run, no corruption
    |   `-- [existing] interactive/non-TTY setup tests
    |
    +-- active run exists
    |   `-- [existing] single/multiple active run tests
    |
    +-- corrupt active-looking run directory exists
    |   `-- [GAP] blocks new setup but keeps valid active runs openable
    |
    +-- corrupt abandoned run directory exists
    |   `-- [GAP] bare command warns or ignores according to documented stale-run policy
    |
    +-- corrupt run moved outside the active scan root
    |   `-- [GAP] following printed move-aside guidance unblocks bare command
    |
    +-- invalid run-id directory under runs/
        `-- [GAP] non-blocking cleanup warning; explicit invalid --run-id still errors

[+] src/operator/commands/status.ts
    |
    +-- approve/cancel/no-op
    |   `-- [existing] status interactive action tests
    |
    +-- prompt/preflight exception
        `-- [PARTIAL] required-title error covered; add exhausted-input,
            blocked-preflight, and execute-failure cases

[+] src/operator/review-gates.ts
    |
    +-- default instruction audit paths
        `-- [GAP] explicit exclusion test for global/vendor skill paths

[+] src/operator/state.ts
    |
    +-- versioned state normalization
        `-- [GAP] shared-reader regression through full npm test or direct
            parity fixture for non-orchestration state consumers
```

### User Flow Coverage

```text
USER FLOW COVERAGE
==================
[+] Operator opens existing orchestration
    |
    +-- [existing] one active run opens status
    +-- [existing] multiple active runs asks which one
    +-- [GAP] corrupt run blocks unsafe new setup with repair guidance

[+] Operator monitors active run in status
    |
    +-- [existing] running orchestration summary
    +-- [GAP] missing slice worktree shows actionable blocker

[+] Operator approves status action
    |
    +-- [existing] cancel and approve clean plan
    +-- [GAP] scripted input exhaustion records failed decision
    +-- [GAP] preflight blocked records blocked decision
    +-- [GAP] execute failure records failed decision
```

Coverage target for this slice: every listed GAP gets a focused regression test.

## Failure Modes

| Codepath | Realistic failure | Handling required | Test required |
| --- | --- | --- | --- |
| Ledger load | JSON is truncated after crash | Fail closed, show path, no mutation, exit 1 | Corrupt ledger blocks bare orchestrate |
| Active run scan | One run is corrupt and active-looking while another is valid | Keep valid runs openable; surface corrupt run as blocking attention; do not start new work while hiding it; valid open/cancel paths exit 0 | Mixed valid/corrupt active-run directory test |
| Stale run scan | Ancient abandoned run JSON is corrupt | Do not permanently block new work; warn or ignore by documented age/status policy; normal open/setup/cancel paths keep exit 0 | Corrupt abandoned-run policy test |
| Move-aside recovery | User follows printed corrupt-ledger move-aside guidance | Scanner ignores the moved directory and bare orchestrate can proceed | Move-aside unblocks bare-orchestrate test |
| Invalid run directory | User renamed a corrupt run under `runs/` to an invalid id | Non-blocking cleanup warning; explicit invalid `--run-id` still errors before file access with exit 1 | Invalid run-id directory scan test |
| Missing worktree | User deletes slice worktree manually | Show blocked slice and accurate recovery guidance; never show unsupported commands | Deleted worktree status/orchestrate test |
| Status prompt | Scripted input ends mid-prompt | Failed decision, no pending orphan | Exhausted `PIPELANE_STATUS_INPUT` test |
| Status preflight | Collected input still cannot satisfy preflight | Blocked decision, exit 1 | Blocked preflight decision test |
| Status execute | Preflight succeeds but execute fails after approval | Failed decision, exit 1, no pending orphan | Execute-failure decision test |
| Instruction audit | Global skill cache change is treated as repo change | Do not include global/vendor paths by default | Gate catalog scope test |
| Shared state reader | Extracted normalization changes fallback or migration semantics for other state files | Keep `readVersionedJsonFile()` public behavior unchanged | Full `npm test` or direct parity fixture for non-orchestration consumers |

Critical silent gaps after this slice should be zero.

## Worktree Parallelization

Sequential implementation, no parallelization opportunity.

Reason: the slice touches the same command/state/test modules and is small
enough that parallel worktrees would create more merge coordination than speed.

## Rollout

- Land behind existing command behavior, no config migration.
- Keep all new output additive and plain-text.
- Direct low-level commands remain available.
- No distribution changes are needed because this is CLI code inside the
  existing package.

## Plan Engineering Review

Generated by `/plan-eng-review` on June 19, 2026.

### Step 0: Scope Challenge

- Existing code already solves most of this slice. The plan reuses
  `orchestration-ledger.ts`, `orchestrate.ts`, `api/snapshot.ts`, `status.ts`,
  `review-gates.ts`, and the existing Node integration test style.
- Minimum change set is acceptable: no new service, no new provider adapter, no
  new test framework, and no new state backend.
- Complexity check passes: expected implementation touches fewer than 8 files
  and introduces no new long-lived classes/services.
- Search check: no new external architecture or runtime dependency is
  introduced. This is a Layer 1 reuse of existing in-repo versioned state
  helpers and API snapshot/action patterns.
- TODO cross-reference: no repo `TODOS.md` exists in this worktree, and this
  plan captures the deferred work directly.
- Completeness check: the plan chooses the complete hardening version, including
  edge-case tests, rather than only fixing the current happy path.
- Distribution check: no new artifact type is introduced.

### Architecture Review

1. `[P2] (confidence: 8/10) docs/public/ORCHESTRATION_HARDENING_PLAN.md —`
   Initial corrupt-ledger behavior was too broad: any old malformed run could
   block bare `/pipelane orchestrate` forever. Fixed in this plan by adding an
   active-looking policy: explicit `--run-id` always reports corruption, recent
   corrupt ledgers block unsafe new setup while keeping valid active runs
   openable, and older corrupt ledgers become non-blocking cleanup warnings.

2. `[P2] (confidence: 9/10) docs/public/ORCHESTRATION_HARDENING_PLAN.md —`
   Missing-worktree attention was originally assigned to "snapshot or status
   rendering." Fixed in this plan: `buildWorkflowApiSnapshot()` owns the truth,
   while terminal status and board renderers only display it.

Architecture verdict: clear after plan edits.

### Code Quality Review

1. `[P2] (confidence: 9/10) docs/public/ORCHESTRATION_HARDENING_PLAN.md —`
   Ledger diagnostics could have grown a second migration/repair framework.
   Fixed in this plan by requiring reuse of the existing `state.ts` versioned
   state-file policy.

Code quality verdict: clear after plan edits.

### Test Review

Test framework: Node's built-in test runner via `npm test` /
`node --test test/pipelane.test.mjs`.

```text
CODE PATH COVERAGE
==================
[+] src/operator/orchestration-ledger.ts
    +-- [existing] valid ledger load
    +-- [existing] missing explicit run id
    +-- [GAP] corrupt JSON / schema-null diagnostic

[+] src/operator/commands/orchestrate.ts
    +-- [existing] no-active-run setup
    +-- [existing] one/multiple active runs
    +-- [GAP] corrupt active-looking run blocks new setup but keeps valid active runs openable
    +-- [GAP] corrupt abandoned run follows stale-run policy
    +-- [GAP] documented move-aside recovery unblocks bare orchestrate
    +-- [GAP] invalid run-id directories warn without blocking scan

[+] src/operator/api/snapshot.ts
    +-- [existing] active orchestration summary
    +-- [GAP] active run with missing slice worktree attention

[+] src/operator/commands/status.ts
    +-- [existing] no-op/cancel/approve/required-input failure
    +-- [GAP] scripted input exhaustion records failed decision
    +-- [GAP] blocked preflight records blocked decision
    +-- [GAP] execute failure records failed decision

[+] src/operator/review-gates.ts
    +-- [existing] karpathy-audit gate exists
    +-- [GAP] default instruction audit excludes global/vendor skill paths

[+] src/operator/state.ts
    +-- [GAP] shared versioned-reader regression for non-orchestration state
        consumers after normalization extraction
```

Distinct test gaps to close in implementation: 11.

The test plan artifact for QA consumers was written to:

```text
~/.gstack/projects/jokim1-pipelane/josephkim-main-eng-review-test-plan-20260619-121221.md
```

Test review verdict: clear because every gap is explicitly captured as required
implementation work.

### Performance Review

No performance issues found. The plan keeps scanning bounded to local
orchestration state and avoids provider invocation, filesystem-wide scans, or
new background processes.

### Failure Modes

Critical silent gaps after implementation should be zero if all listed tests
land with the slice.

### Review Completion Summary

- Step 0: Scope Challenge — scope accepted after two plan edits
- Architecture Review: 2 issues found, both fixed in plan
- Code Quality Review: 1 issue found, fixed in plan
- Test Review: diagram produced, 11 gaps identified and required
- Performance Review: 0 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed; no repo `TODOS.md` present
- Failure modes: 0 critical gaps expected after implementation
- Outside voice: skipped for this slice; original orchestration UX plan already had Codex and Claude plan challenge
- Parallelization: 1 lane, sequential
- Lake Score: 3/3 recommendations chose the complete option

## Triple Review Follow-up

Generated on June 19, 2026 after `/review`, `/karpathy-diff`, and `/claude`
plan review passes.

Verified issues fixed in this document:

- Removed unsupported `orchestrate prepare --run-id <id> --slice-id <slice>`
  recovery guidance; `prepare` is run-scoped today.
- Clarified that missing assigned worktrees need restore/manual ledger or
  task-lock repair before retrying prepare.
- Required extraction of a shared versioned-state normalization helper instead
  of duplicating migration logic or reading ledgers twice.
- Clarified corrupt-ledger behavior when valid active runs coexist with recent
  corrupt run directories.
- Replaced `git/backups` recovery wording with backup/local-copy wording for
  runtime state.
- Closed the corrupt-ledger move-aside loop by naming an ignored destination
  outside the active scan root and requiring a recovery test.
- Defined invalid run-id directories under `runs/` as non-blocking cleanup
  warnings while keeping explicit invalid `--run-id` input as an error.
- Added execute-failure status decision coverage.
- Added full `npm test` / shared-reader regression coverage because
  `readVersionedJsonFile()` is used outside orchestration.
- Stated the instruction-audit ownership rule for `.codex/skills/**` versus
  `.claude/skills/**`.

**UNRESOLVED:** 0

**VERDICT:** TRIPLE REVIEW CLEARED — ready to implement the hardening slice.

## Current Review Follow-up

Generated on June 19, 2026 after `/plan-eng-review` and a Claude adversarial
plan review.

Verified issues addressed in this update:

- Verified that `orchestrate start --run-id <id> --slice-id <slice> --force` is
  supported today; kept that recovery command and documented the verified flag
  surface beside the unsupported `prepare --slice-id` warning.
- Defined missing assigned worktree relevance once in the orchestration
  snapshot/summarization layer so `/pipelane orchestrate`, `/status --json`,
  terminal `/status`, and board consumers cannot drift.
- Added an explicit exit-code and output-line contract for corrupt ledger,
  mixed valid/corrupt run, stale corrupt run, invalid run directory, and explicit
  invalid `--run-id` outcomes.

**UNRESOLVED:** 0

**VERDICT:** REVIEW CLEARED — ready to implement the hardening slice.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `codex exec` | Independent 2nd opinion | 0 | — | Original parent plan had Codex review; current adversarial outside voice used Claude |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | clean | 3 earlier issues fixed plus 2 current plan ambiguities fixed; 11 required test gaps; 0 unresolved; 0 critical gaps |
| Claude Review | `/claude` plan review | Adversarial outside voice | 1 | clean after fixes | 3 findings returned; 2 verified and fixed, 1 verified false against CLI parser but documented |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Not needed for CLI recovery hardening |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not run |

**UNRESOLVED:** 0

**VERDICT:** ENG + ADVERSARIAL REVIEW CLEARED — ready to implement the hardening
slice.
