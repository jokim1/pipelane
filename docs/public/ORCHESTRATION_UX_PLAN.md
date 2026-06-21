# Pipelane Orchestration UX Plan

Last updated: June 18, 2026
Status: product and implementation plan for review

## Summary

This plan defines the next human-facing orchestration UX for Pipelane.

The goal is to maximize autonomous AI implementation while preserving code
quality. Humans should configure quality once, start orchestration with one
plain command, and then use a single status cockpit to approve real decisions.
They should not need to memorize orchestration internals such as plan,
prepare, dispatch, start, review, run IDs, or slice IDs during the happy path.

The core flow is:

```text
/pipelane review setup
/pipelane orchestrate
/pipelane status
```

Existing low-level commands remain available for scripts, debugging, and
recovery:

```text
/pipelane orchestrate goal-spec
/pipelane orchestrate plan
/pipelane orchestrate prepare
/pipelane orchestrate dispatch
/pipelane orchestrate start
/pipelane orchestrate review
/pr
/merge
/deploy
/clean
```

## Design Principles

- Humans manage decisions. Pipelane manages phases.
- Show gates directly. Do not make users learn review profiles.
- Prefer explicit approvals over silent irreversible actions.
- Present the next safe action, not a menu of internal commands.
- Static and deterministic checks run before AI review.
- AI reviewers must be independent from the agents that produced the work.
- Evidence must survive context loss and bind to the exact worktree/HEAD that
  was reviewed.

## Command Model

### Primary Human Commands

```text
/pipelane review setup
/pipelane orchestrate
/pipelane status
```

`/pipelane review setup` configures quality gates interactively.

`/pipelane orchestrate` starts or opens orchestration-specific flow:

- no active run: start orchestration setup
- one active run: show orchestration status and next action
- multiple active runs: ask which run to open
- explicit subcommands/flags: use advanced mode

`/pipelane status` becomes the universal cockpit:

- active orchestration state
- human decision inbox
- PR state
- merge readiness
- staging and production deploy state
- rollback warnings
- cleanup readiness
- next safe action prompt

Status actions must go through the existing API action preflight/execute path
and destination-route guards. The status renderer should not directly call
PR, merge, deploy, cleanup, or orchestration mutation handlers.

Boundary:

- `src/operator/api/snapshot.ts` builds the state snapshot.
- `/pipelane status --json` prints the snapshot and performs no mutations.
- Interactive `/pipelane status` renders the snapshot, then a separate
  selection handler invokes API action preflight/execute.
- Each action selection must bind to the preflight token and route fingerprint
  that was shown to the user.

### Advanced Commands

The current orchestration primitives stay available and keep their current
responsibility boundaries. They are not the normal user journey.

```text
/pipelane orchestrate plan --plan-file docs/plan.md
/pipelane orchestrate prepare --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate dispatch --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate start --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate review --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
```

## Interactive Review Setup

The default setup command should not ask users to choose a named review
profile. The primary UX is a short gate checklist.

```text
User:
/pipelane review setup
```

```text
Pipelane:
Review setup

I found these repo checks:
- npm run typecheck
- npm run format:check
- npm run test
- npm run build

Recommended gates are preselected below.
Type a gate number to toggle it. Type s to save, or c to cancel.

Static gates:
1.  [on]  Typecheck                  npm run typecheck
2.  [on]  Format check               npm run format:check
3.  [off] Lint                       no lint script found
4.  [off] Secret scan                no secret scan script found
5.  [off] Dependency audit           no audit script found

Behavioral gates:
6.  [on]  Tests                      npm run test
7.  [on]  Build                      npm run build

AI review gates:
8.  [on]  Karpathy diff review        /karpathy-diff        installed
9.  [on]  gstack /review              /review               installed
10. [off] Adversarial review          /claude review code (Codex /claude review bridge) not installed

Conditional gates:
11. [on]  Browser QA                  when frontend files change
12. [on]  Instruction audit           when AGENTS.md / CLAUDE.md / skills change

Human approval gates:
13. [on]  Merge approval
14. [on]  Production deploy approval

Actions:
s. Save and continue
c. Cancel
```

Gate status labels:

- `installed`: local skill/tool exists and can be invoked
- `not installed`: Pipelane knows how to install it
- `unavailable`: Pipelane cannot install or detect it
- `no script found`: package-script gate has no matching script

If a user toggles on a missing AI gate, Pipelane enters an explicit install
subflow before enabling the gate:

```text
User:
10
```

```text
Pipelane:
Adversarial review is not installed.

Install the Codex /claude review bridge now?

Target: https://github.com/jokim1/codexskill-claude-review.git -> ~/.codex/skills/claude

1. Install and enable
2. Leave disabled
```

Install is never implicit. The install subflow shows the tool/skill to be
installed, the source, whether auth is required, and the resulting gate command.
Adversarial review can be satisfied by Codex `/claude review code`,
or Claude-side gstack `/codex challenge`. Missing Karpathy review skills can be
installed from `https://github.com/jokim1/karpathy-skills.git` after approval.
If install fails or auth is missing, the gate remains disabled.

After save:

```text
Pipelane:
Review gates saved.

Enabled:
- static: typecheck, format-check
- behavioral: test, build
- ai-diff: karpathy-diff, gstack /review, adversarial review
  (/claude review code or /codex challenge)
- runtime: browser QA for frontend changes
- instruction: audit when agent instruction files change
- human: merge approval, production deploy approval

Next:
Run /pipelane orchestrate
```

The saved config should persist the selected gate arrays. This keeps the result
visible and avoids making users remember named bundles. Only materialize
advanced custom command gates when the user uses advanced setup. This
keeps the default checklist small while still making user edits
durable.

Every orchestration run must still snapshot the resolved gate list into the
ledger. Compact repo config is for maintainability; resolved run snapshots are
for auditability.

Custom command gates are advanced-only. Do not include "add custom command
gate" in the primary wizard. Keep advanced surfaces such as:

```text
/pipelane review setup --advanced
/pipelane review setup --add-command "npm run integration"
```

## Orchestration Start UX

`/pipelane orchestrate` is the main human command. Do not require
`/pipelane orchestrate run` in the happy path, though `run` may remain as an
alias for scripting and explicit invocation.

```text
User:
/pipelane orchestrate
```

```text
Pipelane:
Orchestration setup

What should I implement?

Likely plan files:
1. docs/project-talk-model-implementation.md
   Modified today. Mentions Project/Talk context, inheritance, sources, agents, jobs.

2. docs/talk-improvement-plan.md
   Modified yesterday. Mentions Talk UX and context improvements.

Other options:
3. Choose a different existing plan file
4. Describe the goal now
5. Cancel
```

Likely plan files should be ranked by:

- recently modified Markdown files under `docs/`, `plans/`, `.pipelane/`, or
  known planning directories
- files changed on the current branch
- filenames containing `plan`, `implementation`, `migration`, `proposal`, or
  `roadmap`
- content containing implementation language such as `slices`, `acceptance
  criteria`, `backend`, `frontend`, `tests`, or `migration`
- optional conversation/project terms supplied by the current orchestration
  context. Do not hardcode Clawtalk-specific terms into the generic ranking
  algorithm.

If the user chooses `Describe the goal now`, Pipelane should create a temporary
plan draft, preview the inferred slices and decisions, and persist the draft
text/hash into the ledger before any worker starts. This option must not bypass
the same preview, approval, non-TTY, and audit requirements as a plan file.

Active-run detection should consider:

- repo root and git common-dir
- current branch and worktree path
- run status and updated timestamp
- stale or crashed worker records
- PR/task association when available
- whether the run source plan still exists

If more than one run matches, or if the best match is stale/ambiguous, ask the
user which run to open instead of guessing.

After selection, Pipelane compiles and previews the plan:

```text
Pipelane:
Selected:
docs/project-talk-model-implementation.md

Proposed slices:
1. docs-and-gates
2. effective-context-resolver
3. project-sources-backend
4. context-ui
5. agents-inheritance
6. tools-connectors-inheritance
7. project-jobs
8. cleanup

Human decisions needed before start:
1. Use "Project context" and "Talk-local context" vocabulary.
2. Talks include Project sources by default; Talk exclusions win.
3. Project jobs write only into explicitly selected Talks.
4. Use the saved review gates.

Provider plan:
- implementation: Codex, because this orchestration was started from Codex
- AI review: `/claude review code` or `/codex challenge` when available
- note: Pipelane selected this plan automatically to prefer independent review

Actions:
1. Approve and start
2. Edit decisions
3. Pick another plan
4. Cancel
```

When approved, Pipelane internally runs the equivalent of the current
`plan`, `prepare`, `dispatch`, and `start` steps.

```text
Pipelane:
Orchestration started.

Run:
orchestrate-20260618120944-a81f3c10

Created:
- 8 slice worktrees
- 8 slice prompts
- review-gate snapshot
- orchestration ledger

Current:
- docs-and-gates: running
- effective-context-resolver: waiting
- remaining slices: queued

Next:
Run /pipelane status
```

## Universal Status Cockpit

After orchestration starts, the user should mostly use `/pipelane status`.

```text
User:
/pipelane status
```

```text
Pipelane status

Active orchestration:
Clawtalk Project/Talk implementation
Status: running

Progress:
- docs-and-gates: passed review
- effective-context-resolver: running
- project-sources-backend: queued
- context-ui: queued
- agents-inheritance: queued
- tools-connectors-inheritance: queued
- project-jobs: queued
- cleanup: queued

Human inbox:
- empty

Next:
No input needed. Workers are still running.
```

When there are multiple plausible next actions, status should show the
recommended action first and include a `Show all actions/blockers` choice. The
cockpit should not hide blockers just to preserve a single linear happy path.

If a real product decision is needed, it appears as an inbox item:

```text
Pipelane status

Human decision required

Slice:
project-sources-backend

Question:
When a Talk excludes a Project source, should that exclusion apply only to that Talk?

Recommended:
Yes. Talk exclusions should be Talk-local overrides.

Choices:
1. Approve recommended behavior
2. Apply exclusion across the whole Project
3. Pause run
```

Quality failures should first go through an auto-fix loop. Humans should not be
interrupted for deterministic test, typecheck, build, or formatting failures
unless retries fail or the fix requires product intent.

Auto-fix loop contract:

- deterministic gate failure: return to the same implementation worker once
  with the failing command output and exact diff/HEAD it produced
- repeated deterministic failure: spawn a fresh fixer worker with the failed
  slice context
- maximum retries: two automatic attempts per gate per slice
- product-semantic change, destructive migration, auth/security change, or
  public API behavior change: stop and create a human decision record
- test changes must be reviewed as code changes, not accepted as a way to make
  red tests green
- retry exhaustion: mark the slice `blocked` and add a mechanical blocker inbox
  entry, not a product decision record. The entry should include the failing
  command, output tail, slice worktree path, reviewed base/head SHA, diff
  fingerprint, retry count, and available recovery action.

## Merge, Deploy, And Cleanup UX

Users should not need to manually type `/pr`, `/merge`, `/deploy`, or `/clean`
in the happy path. `/pipelane status` should present the next safe action and
run the underlying API action route only after explicit approval.

When orchestration is ready:

```text
Pipelane status

Active orchestration:
Clawtalk Project/Talk implementation
Status: ready-for-merge

Evidence:
- all slices passed review
- typecheck passed
- format check passed
- tests passed
- build passed
- Karpathy diff review passed
- gstack /review passed
- adversarial review passed
- browser QA passed where frontend changed

Summary:
- Project context is resolved live instead of copied into each Talk.
- Talks can include or exclude Project sources.
- Talk-local context is visible separately from inherited Project context.
- Agents and tools inherit Project defaults with Talk overrides.
- Project jobs target selected Talks.
- stale copied-default paths were removed.

Next action:
1. Create PR
2. Show evidence
3. Pause
```

Choosing `Create PR` internally runs the current `/pr` flow.
Implementation detail: the selection should call the same API action preflight
and execute route used by UI clients, including confirmation tokens and drift
guards. It should not bypass those guards by invoking command handlers directly.

After PR checks pass:

```text
Pipelane status

PR:
#123 ready to merge

Next action:
1. Merge PR
2. Show PR checks
3. Cancel
```

Choosing `Merge PR` internally runs the current `/merge` flow.

After merge:

```text
Pipelane status

Merged SHA:
abc1234

Next action:
1. Deploy staging
2. Cancel
```

After staging verifies:

```text
Pipelane status

Staging verified.

Production deploy requires approval.

Evidence:
- review gates passed
- PR checks passed
- staging deploy passed
- staging verification passed

Next action:
1. Deploy production
2. Cancel
```

After production verifies:

```text
Pipelane status

Production verified.

Cleanup candidates:
- orchestration worktrees
- merged task branch
- dispatch prompts and worker logs that are not required audit evidence

Next action:
1. Clean safe completed work
2. Show cleanup details
3. Cancel
```

Pipelane must never silently merge, deploy, roll back, or clean irreversible
state just because a phase completed.

Cleanup must preserve audit evidence by default. Worker logs, dispatch prompts,
review evidence, and human decisions should be retained unless the user chooses
an explicit evidence-pruning action with a clear list of what will be removed.

## Provider And Reviewer Model

### Worker Providers

The default implementation provider is the current host provider.

- If the user is running from Codex, use Codex workers by default.
- If the user is running from Claude, use Claude/Opus workers by default.
- Cross-provider orchestration is available only when the other provider has a
  locally installed, authenticated, non-interactive adapter.
- Humans should not assign providers slice-by-slice in the primary UX.
  Pipelane should choose a provider plan automatically and show it for review.
- V1 implementation should default all implementation slices to the host
  provider. Cross-provider review is preferred when available. Mixed-provider
  implementation remains an advanced/future capability.

Example provider detection:

```text
Worker providers detected:
- Codex: installed
- Claude: installed
- Opus: available through Claude
```

If more than one provider is available, Pipelane should show the automatically
selected provider plan instead of asking the human to assign providers:

```text
Provider plan:

Implementation:
- Codex workers

Review:
- `/claude review code` for Codex-side Claude review when available
- `/codex challenge` for Claude-side gstack Codex review when available

Reason:
Started from Codex, with independent cross-provider review preferred.

Actions:
1. Use recommended provider plan
2. Use host provider only
```

Do not assume cross-model orchestration works unless the local provider adapter
exists and can run non-interactively.

## What Already Exists

The plan should reuse these existing Pipelane pieces instead of rebuilding
parallel systems:

| Existing code/flow | What it already solves | Plan use |
| --- | --- | --- |
| `src/operator/commands/review.ts` | Review gate catalog, package-script detection, selected gate persistence, review evidence writing | Extend for the interactive setup wizard and AI gate install-state labels |
| `src/operator/commands/orchestrate.ts` | Goal spec, plan, prepare, dispatch, start, and review primitives | Wrap with bare `/pipelane orchestrate`; keep primitives as advanced commands |
| `src/operator/orchestration-ledger.ts` | Durable run, slice, worktree, worker, gate snapshot, and review records | Add human decision records and reviewer identity fields |
| `src/operator/api/snapshot.ts` | Single API snapshot consumed by `/pipelane status` | Add orchestration summary and human inbox fields here |
| `src/operator/api/actions.ts` | Confirmation tokens, action preflight/execute, route fingerprints, drift guards. Verified existing action IDs include `pr`, `merge`, `deploy.staging`, `deploy.prod`, `route.merge`, `route.deploy.staging`, `route.deploy.prod`, `clean.plan`, and `clean.apply` | Use for PR, merge, deploy, cleanup, and future orchestration actions from status |
| `src/operator/destination-executor.ts` | Multi-step route execution with progress and guardrails | Reuse for status-triggered destination actions |
| `test/pipelane.test.mjs` | End-to-end CLI and state tests for review, status, actions, and orchestration primitives | Add focused tests alongside each slice |

### Independent AI Review

AI review must not be satisfied by the same agent session that produced the
work.

Minimum invariant:

```text
No slice can pass AI review using the same agent session that implemented it.
```

Preferred review setup:

- Codex implements, Claude/Opus reviews when available.
- Claude/Opus implements, Codex reviews when available.
- If only one provider is installed, use a separate fresh session with a
  reviewer role and record that the review was same-provider but independent.
- If Pipelane cannot prove reviewer independence, the AI review gate remains
  pending or failed. Do not pass the gate with only softer wording.

Reviewer evidence should record:

- gate ID
- reviewer provider
- reviewer command
- reviewer session ID or other stable run identity
- reviewer model
- implementation worker provider/session
- reviewed worktree path
- reviewed base SHA
- reviewed HEAD SHA
- reviewed diff fingerprint
- timestamp

Same-provider review only counts as independent when all are true:

- fresh process/session identity
- no shared mutable conversation context
- review prompt excludes implementation scratchpad/context except the diff,
  plan, tests, and repository files needed for review
- reviewed HEAD and diff fingerprint match the evidence record

Review setup should expose independence:

```text
AI review gates:
8.  [on]  Karpathy diff review        /karpathy-diff        installed, independent session
9.  [on]  gstack /review              /review               installed, independent session
10. [on]  Adversarial review          /claude review code   installed, cross-model
```

If no independent reviewer is available:

```text
10. [off] Adversarial review          /claude review code   not installed
```

## State Machine

The primary UX compresses the existing primitives into a smaller user-facing
state machine:

```text
                         +---------------------+
                         | /pipelane review    |
                         | setup saves gates   |
                         +----------+----------+
                                    |
                                    v
                         +---------------------+
                         | /pipelane           |
                         | orchestrate         |
                         +----------+----------+
                                    |
                                    v
       +-------------+    +---------------------+    +----------------+
       | choose plan | -> | approve decisions   | -> | workers run    |
       +-------------+    +---------------------+    +-------+--------+
                                                               |
                                                               v
                         +---------------------+    +----------------+
                         | human inbox         | <- | gates/reviews  |
                         +----------+----------+    +-------+--------+
                                    |                       |
                                    v                       v
                         +---------------------+    +----------------+
                         | ready for PR        | <- | auto-fix loop  |
                         +----------+----------+    +----------------+
                                    |
                                    v
                         +---------------------+
                         | /pipelane status    |
                         | prompts PR/merge/   |
                         | deploy/cleanup      |
                         +---------------------+
```

The underlying ledger remains the source of truth for plan source, slices,
worktrees, provider prompts, workers, review evidence, human decisions, and
approval history.

Human decisions should be durable ledger records, not transient prompt text.
Each record should include:

- `id`
- `sliceId` when applicable
- `question`
- `options`
- `recommendation`
- `selectedOption`
- `status`
- `createdAt`
- `answeredAt`
- `actor`
- `baseSha`
- `runHeadSha`
- `sliceHeadSha` when applicable
- `diffFingerprint`
- `mergedSha` when applicable

This allows `/pipelane status` to survive context loss, show pending decisions,
and prove which human approval unlocked a later action.

External truth reconciliation:

- Local ledger state is the durable local memory.
- Git worktree/branch state wins for local file truth.
- GitHub PR/CI state wins for PR readiness when configured.
- Deploy provider state wins for deploy/runtime truth when configured.
- If two truth sources disagree, `/pipelane status` should show a reconciliation
  warning and avoid irreversible actions until the user chooses one of the
  listed recovery actions or manually repairs the state.

## Recovery And Repair Surface

V1 should not add a generic `/pipelane repair` command. Recovery should reuse
existing low-level commands and API actions, then surface those actions from
`/pipelane status` when applicable.

Recovery actions:

| Problem | Recovery surface | Slice |
| --- | --- | --- |
| Failed or stale running orchestration worker | `/pipelane orchestrate start --run-id <run-id> [--slice-id <id>] --force` | Orchestration entry point |
| Failed or pending slice review | `/pipelane orchestrate review --run-id <run-id> [--slice-id <id>]` after fixing evidence | Reviewer independence |
| Retry-exhausted deterministic gate failure | blocked-slice inbox entry with retry action and failing command evidence | Status cockpit |
| PR/task binding drift | existing `pr` API action with `--recover` options | Status cockpit |
| Base branch drift | existing `git.catchupBase` API action | Status cockpit |
| Deploy configuration/runtime uncertainty | existing `doctor.diagnose`, `doctor.probe`, and `rollback.*` API actions | Status cockpit |
| Deleted slice worktree | show blocker with recreate guidance; V1 recovery is rerun prepare/start only when the ledger state makes that safe | Orchestration entry point |
| Corrupt orchestration ledger | fail closed with ledger path and manual restore/remove guidance; do not mutate the run | Orchestration entry point |

Tests should exercise the recovery path when an existing recovery surface exists,
not merely assert that status displays a blocker. For corrupt ledgers and unsafe
deleted-worktree states, the correct V1 behavior is fail-closed guidance without
mutation.

## Implementation Diagram Notes

Keep the plan-level state machine in this document. Add inline ASCII diagrams
only where implementation introduces non-obvious branching, and keep them close
to the state transition they explain.

| File/module | Diagram to add when implementation starts |
| --- | --- |
| `src/operator/orchestration-ledger.ts` | Run, slice, human-decision, and review-evidence state transitions |
| `src/operator/commands/orchestrate.ts` | Bare command dispatcher flow: active-run detection to plan choice to preview to existing primitives |
| `src/operator/api/snapshot.ts` | Snapshot data flow from ledger, PR, deploy, and review state to orchestration summary, human inbox, and actions |
| `src/operator/api/actions.ts` | Status action flow: selection to preflight to confirmation token to execute |
| `test/pipelane.test.mjs` | Short setup diagram only for multi-stage orchestration/status tests |

Do not add decorative comments for simple helpers.

## Implementation Plan

Implement this plan in four sequenced slices:

1. Interactive `/pipelane review setup`.
2. Bare `/pipelane orchestrate` setup/open flow, including human decision and
   reviewer identity ledger schema.
3. Orchestration state and actions in `/pipelane status`.
4. Reviewer independence enforcement and evidence rendering.

Each slice should land with focused tests before the next slice starts.

### Review Setup

- Convert bare `/pipelane review setup` from report-only to an interactive
  wizard when stdout is a TTY.
- Keep existing flags for automation: `--yes`, `--print`, `--list-gates`,
  and future advanced/custom-gate flags.
- Detect package scripts and known skills/tools before rendering the gate list.
- Add install-state detection for AI gates.
- Add install approval flow for known missing AI gates.
- Keep package-script installers conservative: use npm only when the repo looks
  npm-managed, and return manual recipes for pnpm, Yarn, Bun, mixed lockfiles,
  or framework-specific ESLint setup.
- Save explicit selected gate config.
- In non-TTY mode, do not hang and do not silently accept defaults. Either
  require explicit flags such as `--yes` or `--print`, or print the available
  choices with exact follow-up commands and exit without writing config.
- Automation examples:
  - `/pipelane review setup --yes`
  - `/pipelane review setup --enable adversarial-review`
  - `/pipelane review setup --disable gstack-review`
  - `/pipelane review setup --install lint`
  - `/pipelane review setup --print --json`
  - `/pipelane review setup --list-gates --json`

### Orchestration Entry Point

- Make bare `/pipelane orchestrate` a high-level dispatcher.
- Add active-run detection.
- Add likely-plan-file detection and ranking.
- Add a preview step that shows slices, human decisions, provider plan, and
  review-gate snapshot.
- Internally compose current `plan`, `prepare`, `dispatch`, and `start`
  primitives after approval.
- In non-TTY mode, do not launch the wizard. Require explicit flags such as
  `--plan-file` and `--yes`, or print the available choices and exit non-zero.
- Keep low-level subcommands unchanged for advanced use.
- Automation examples:
  - `/pipelane orchestrate --plan-file docs/plan.md --yes`
  - `/pipelane orchestrate --plan-file docs/plan.md --preview --json`
  - `/pipelane orchestrate run --plan-file docs/plan.md --yes` as a scripting
    alias if retained

Bare `/pipelane orchestrate` must not break existing advanced usage. Existing
subcommands keep their current parser behavior. The only behavior change is for
the no-subcommand entry point.

### Status Cockpit

- Extend `SnapshotData` in `src/operator/api/snapshot.ts` to include
  orchestration runs, active run summary, human inbox items, review evidence,
  and available orchestration actions.
- Keep snapshot rendering pure. Interactive `/pipelane status` may collect a
  selection, but mutation must happen only through a separate API
  preflight/execute handler.
- Render one next safe action when possible.
- Allow prompt choices to dispatch existing `/pr`, `/merge`, `/deploy`, and
  `/clean` flows through verified existing API actions and destination routes.
- Require explicit approval for irreversible actions.
- Preserve current direct commands for power users and automation.

### Reviewer Independence

- Add worker/reviewer identity fields to review evidence where available.
- Block AI review evidence if it comes from the same implementation session.
- Prefer cross-provider review when available.
- Allow same-provider review only when it is a separate fresh session.
- Show cross-provider, same-provider-independent, pending, failed, and legacy
  evidence labels in status/evidence summaries.

### Migration And Compatibility

- Existing `.pipelane.json` review-gate configs remain valid.
- Existing orchestration ledgers without human decision or reviewer identity
  fields load with empty/default fields and a `legacy` evidence label.
- Existing low-level orchestration commands keep their CLI contracts.
- New non-TTY behavior applies only to newly interactive bare commands.
- `/pipelane status --json` should remain machine-readable and backward
  compatible by adding fields rather than renaming existing ones.

## Performance And Failure Modes

The main performance risk is local filesystem scanning and ledger loading. These
commands run in the user's terminal, so latency should stay low and failures
should be explicit.

Performance constraints:

- Plan-file detection should cap scanned files and bytes per file. Prefer
  modified Markdown files and branch-changed files before broad content scans.
- `/pipelane status` should load orchestration summaries, not full worker logs or
  full review output bodies.
- Review gate install-state detection should use cheap filesystem and command
  checks. Avoid spawning expensive provider commands during initial rendering.
- API action preflight should compute route fingerprints once and bind execute
  to the preflight result. Execute must re-check state before mutation.
- Ledger writes should remain versioned JSON writes through the existing state
  helpers.

Failure-mode matrix:

| Codepath | Realistic failure | Required handling | Required test |
| --- | --- | --- | --- |
| Interactive review setup | Missing TTY in CI or scripted usage | Print explicit flags/options and exit without writing config | Non-TTY bare setup test |
| AI gate enablement | Skill install unavailable or auth missing | Leave gate disabled with clear guidance | Missing AI gate decline/failure test |
| Compact review config save | Existing custom config accidentally overwritten | Preserve compatible custom keys; only remove generated defaults | Existing config preservation test |
| Likely plan scan | Huge docs directory or binary-like Markdown file | Cap scan count and bytes; continue with ranked partial results | Large/ignored file ranking test |
| Bare orchestrate in non-TTY | Automation accidentally starts workers | Require `--plan-file` plus explicit approval flag | Non-TTY bare orchestrate test |
| Human decision prompt | Context loss after prompt is shown | Persist pending decision before showing it | Ledger reload human inbox test |
| Status action selection | HEAD, branch, PR, or deploy route changes after approval | Reject stale confirmation and return new preflight | Destination drift guard test |
| Reviewer independence | Implementing session tries to satisfy its own AI review gate | Block evidence and explain independent reviewer requirement | Same-session review rejection test |
| Cross-provider review | Other provider installed but not authenticated | Fall back to fresh same-provider reviewer and mark evidence weaker | Provider fallback evidence test |
| Cleanup prompt | Worktree or task state changes between preview and apply | Re-run cleanup preflight and block stale route | Cleanup stale token test |
| Worker process | Worker killed or shell exits mid-slice | Mark stale/running worker as interrupted and surface `/pipelane orchestrate start --force` retry action | Killed worker recovery test exercises retry |
| Ledger load | Corrupt or partially written orchestration JSON | Fail closed with repair guidance; do not mutate run | Corrupt ledger test |
| Worktree state | Slice worktree deleted outside Pipelane | Show missing-worktree blocker and recreate/recover option when safe, otherwise fail closed | Deleted worktree recovery/guidance test |
| Git history | Branch rebased or force-pushed after preflight | Invalidate action token and require fresh review/preflight | Rebased branch guard test |
| Auto-fix loop | Deterministic gate still fails after two attempts | Create blocked-slice inbox entry with command output and retry action | Retry exhaustion terminal-state test |

No critical silent-failure gap should remain after these tests. Any new silent
failure discovered during implementation should be fixed in the same slice, not
deferred.

## Worktree Parallelization Strategy

The implementation should be mostly sequential because later slices depend on
the data model and command contracts from earlier slices. There is still room to
parallelize tests and reviewer-independence work after the ledger shape is set.

| Step | Modules touched | Depends on |
| --- | --- | --- |
| Review setup wizard | `src/operator/commands/`, `src/operator/state.ts`, `test/` | none |
| Orchestration entry point | `src/operator/commands/`, `src/operator/orchestration-ledger.ts`, `test/` | review setup config contract |
| Status orchestration snapshot and actions | `src/operator/api/`, `src/operator/commands/status.ts`, `src/operator/orchestration-ledger.ts`, `test/` | orchestration entry point and human decision records |
| Reviewer independence | `src/operator/commands/review.ts`, `src/operator/commands/orchestrate.ts`, `src/operator/orchestration-ledger.ts`, `test/` | ledger identity fields |

Parallel lanes:

- Lane A: review setup wizard -> orchestration entry point.
- Lane B: reviewer identity/evidence design can start after ledger identity
  fields are agreed, then merge before status evidence rendering.
- Lane C: status snapshot/actions starts after human decision records exist.

Execution order:

1. Land review setup wizard.
2. Land orchestration entry point plus human decision record schema.
3. Land reviewer identity ledger schema before status evidence rendering.
4. Run Lane B reviewer independence and Lane C status snapshot/actions in
   parallel worktrees if desired.
5. Merge and run full `npm run typecheck`, `npm run test`, and
   `npm run build`.

Conflict flags:

- Lanes B and C both touch `src/operator/orchestration-ledger.ts`; coordinate
  the ledger schema first.
- Status and review setup both touch `test/pipelane.test.mjs`; keep tests grouped
  by command to reduce merge conflicts.

## Test Plan

### Review Setup

- Bare `/pipelane review setup` renders the interactive gate list.
- Bare `/pipelane review setup` exits without writing config in non-TTY mode
  unless explicit automation flags are provided.
- Accepting unchanged recommendations writes the explicit selected gate list.
- Customizing any gate writes explicit selected gate config.
- Saving writes selected gates and preserves existing compatible config.
- Toggling an installed AI gate updates selection without install prompt.
- Toggling a known missing AI gate prompts install approval.
- Declining install leaves the gate disabled.
- Missing package-script gates show `no script found`.
- Custom command gates do not appear in the primary wizard.
- Existing `--yes`, `--print`, and `--list-gates` behavior remains scriptable.

### Orchestration

- Bare `/pipelane orchestrate` starts setup when no active run exists.
- Bare `/pipelane orchestrate` opens status when one active run exists.
- Bare `/pipelane orchestrate` asks which run to open when multiple active runs
  exist.
- Bare `/pipelane orchestrate` exits non-zero in non-TTY mode unless explicit
  automation flags are provided.
- Plan-file ranking includes recently modified and branch-changed Markdown
  files.
- Describe-goal flow creates a draft, previews inferred slices/decisions, and
  persists draft text/hash before any dispatch.
- Describe-goal flow refuses non-TTY usage unless explicit automation flags are
  provided.
- Preview shows Pipelane's recommended provider plan, not a human slice-provider
  assignment UI.
- Approving the preview writes durable human decision records for accepted
  pre-start decisions.
- Approving the preview creates a ledger, worktrees, prompts, and worker start
  records through existing primitives.
- Cancelling during setup does not create or mutate orchestration state.

### Status

- `src/operator/api/snapshot.ts` exposes orchestration status in `SnapshotData`.
- `/pipelane status` shows running orchestration progress.
- `/pipelane status` shows human decision inbox items.
- Ready-for-merge status offers Create PR and dispatches `/pr` only after
  approval through API action preflight/execute.
- Ready-to-merge PR status offers Merge PR and dispatches `/merge` only after
  approval through API action preflight/execute.
- Deploy prompts require explicit approval and use destination-route drift
  guards.
- Cleanup prompt requires explicit approval and uses destination-route drift
  guards.
- A stale confirmation token, changed HEAD, changed branch, or changed action
  route blocks execution and returns a new preflight.
- Direct `/pr`, `/merge`, `/deploy`, and `/clean` still work.
- Interrupted approval, killed worker, partial worktree creation, corrupt ledger,
  deleted worktree, rebased branch, and force-pushed PR branch paths are covered.

### Instruction Audit

- Agent-instruction audit includes repo-owned `AGENTS.md`, `CLAUDE.md`, and
  configured skill/instruction paths.
- Agent-instruction audit excludes foreign/vendor/global skill directories such
  as `~/.claude/`, `~/.codex/skills/`, `.claude/skills/`, and plugin caches
  unless explicitly configured by the repo.

### Reviewer Independence

- A review run from the same implementation session cannot satisfy an AI
  review gate.
- A fresh same-provider reviewer session can satisfy the gate, but evidence is
  marked same-provider independent.
- A cross-provider reviewer session is preferred and marked cross-model.
- Review evidence binds to the reviewed worktree base SHA, HEAD SHA, and diff
  fingerprint.

## Clawtalk Example Journey

```text
User:
/pipelane review setup
```

User reviews the gate list, enables adversarial review if desired, and saves.

```text
User:
/pipelane orchestrate
```

Pipelane suggests:

```text
1. docs/project-talk-model-implementation.md
2. docs/talk-improvement-plan.md
3. Choose a different existing plan file
4. Describe the goal now
5. Cancel
```

User selects `docs/project-talk-model-implementation.md`.

Pipelane previews:

```text
Proposed slices:
1. docs-and-gates
2. effective-context-resolver
3. project-sources-backend
4. context-ui
5. agents-inheritance
6. tools-connectors-inheritance
7. project-jobs
8. cleanup

Human decisions needed before start:
1. Use "Project context" and "Talk-local context" vocabulary.
2. Talks include Project sources by default; Talk exclusions win.
3. Project jobs write only into explicitly selected Talks.
4. Use the saved review gates.
```

User approves.

Pipelane creates the run, worktrees, dispatch prompts, and worker records.

From then on:

```text
User:
/pipelane status
```

Pipelane shows progress, asks for product decisions only when needed, auto-fixes
mechanical quality failures, and eventually offers:

```text
Next action:
1. Create PR
2. Show evidence
3. Pause
```

The user approves PR, merge, staging deploy, production deploy, and cleanup from
status prompts. The user does not need to type the underlying commands unless
they want the advanced/manual path.

## NOT In Scope

- Replacing the existing low-level orchestration commands.
- Automatically merging, deploying, rolling back, or cleaning without explicit
  user approval.
- Building a hosted orchestration service.
- Assuming cross-provider orchestration without a local provider adapter.
- Making custom command gate authoring part of the primary setup wizard.
- Solving provider authentication or account setup beyond detection and clear
  install/auth guidance.

## Assumptions

- `.pipelane.json` remains the durable repo config for review gates.
- The existing orchestration ledger remains the durable run memory.
- The current host provider is the default implementation provider.
- Cross-provider implementation and review are optional enhancements, not a
  baseline requirement.
- `/pipelane status` uses API action preflight/execute routes after user
  approval rather than duplicating PR, merge, deploy, and cleanup logic.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Eng Review | `/plan-eng-review` | Architecture, implementation slices, test coverage, failure modes | 2 | clean | 7 issues accepted into this plan; latest pass added inline diagram placement guidance and stricter review-evidence binding; 0 unresolved; 0 critical gaps |
| Codex Plan Review | `codex exec` | Independent read-only challenge of the reviewed plan | 1 | issues found, incorporated | Added stricter status/action boundary, active-run detection, resolved gate snapshots, reviewer identity proof, auto-fix loop, external-truth reconciliation, compatibility rules, and crash-recovery tests |
| Claude Plan Review | `/claude` | Native Claude review of the plan artifact | 1 | verified, addressed | Verified API action routes already exist; added recovery surface, describe-goal tests, and retry-exhaustion terminal state |
| Design Review | `/plan-design-review` | UI/UX review | 0 | not run | Not needed for this CLI-first UX plan yet |
| DX Review | `/plan-devex-review` | Developer experience review | 0 | not run | Non-TTY and automation contracts added during eng review |

**VERDICT:** Ready for implementation as four slices: review setup, orchestrate entry point, status cockpit, reviewer independence enforcement.
