# Pipelane Release Workflow

Last updated: July 16, 2026
Status: active operator reference

This document describes the workflow Pipelane supports today. Historical target-state
specs live in `docs/archive/`.

## What Pipelane Owns

Pipelane is the local release cockpit for AI-assisted coding work. It owns the
repo-native command layer for:

- task workspaces and recovery
- branch and PR preparation
- merge handoff
- build and release lanes
- staging and production deploy flow
- rollback
- cleanup
- the terminal and web cockpit

Pipelane does not replace review tools, test suites, CI, GitHub, deploy
providers, or human release judgment. It makes those steps visible and hard to
skip accidentally.

## Command Surface

User-facing slash commands:

| Command | Purpose |
| --- | --- |
| `/pipelane` | Show the build/release journey overview. |
| `/pipelane web` | Open the local Pipelane Board. |
| `/status` | Render the terminal cockpit from the same API as the board. |
| `/devmode` | Inspect or switch between `build` and `release`. |
| `/new` | Create a fresh task branch and worktree. The AI can infer the task name, or you can provide one. |
| `/adopt` | Track an existing task branch/worktree without creating a replacement workspace. |
| `/resume` | Recover an existing task worktree. |
| `/repo-guard` | Verify that the checkout is safe for task work. |
| `/pipelane review` | Run configured review gates and write evidence for the current diff. |
| `/pr` | Show review state, run pre-PR checks, commit, push, and open or update a PR. |
| `/merge` | Merge the PR, record immutable delivery history, and close the clean task workspace. Pass `--keep-worktree` to retain it. |
| `/release` | Enable or inspect the optional release module. |
| `/deploy` | Deploy the merged SHA to `staging` or `prod`. |
| `/clean` | Preview cleanup status or explicitly retry blocked/delivered cleanup. Bare `/clean` is non-destructive. |
| `/doctor` | Diagnose deploy config, probes, and release readiness. |
| `/rollback` | Roll back staging or production to the last verified-good deploy. |
| `/fix` | Apply durable root-cause fixes from failures and findings. |

Durable machine-local commands are the implementation layer behind these
commands. Operator docs should point people and agents at slash commands.

Exact tool runtime roots that must stay machine-local use the explicit CLI
surface below. Registration never happens from discovery alone:

```text
pipelane run local-state list
pipelane run local-state add --path <repo-relative-root> --reason <why> [--yes]
pipelane run local-state remove --path <repo-relative-root> [--yes]
```

Pipelane stores these declarations in one canonical block in the repository's
Git common-dir `info/exclude`. Linked worktrees share the policy. Git continues
to show tracked files, while normal status and `git add -A` omit exact declared
untracked roots. Removing a declaration never deletes its content, and removing
the final declaration leaves the initialized empty block in place.

## Build Lane

Build mode is the fast lane. Use it when production deploys already happen
safely after merge and same-SHA staging validation is not required.

```text
/devmode build
/new
# or: /adopt --task "existing work"
/pipelane review
/pr --title "PR title"
/merge
```

Successful merge closes the task worktree, local branch, and task lock. Continue
from the primary shared checkout shown in the merge receipt.

Build mode still expects verification before merge. The default pre-PR checks
come from machine-local Pipelane config, usually:

```text
npm run test
npm run typecheck
npm run build
```

## Release Lane

Release mode is the protected lane. Use it when staging must prove the exact
merged SHA before production moves.

```text
/devmode release
/release status
/new
# or: /adopt --task "existing work"
/pipelane review
/pr --title "PR title"
/merge
# continue from the shared checkout and identify the immutable delivery
/deploy staging --pr <merged-pr-number>
/deploy prod --pr <merged-pr-number>
```

Release mode fails closed when deploy config, staging evidence, or probe health
is missing. Staging-parity and release-readiness run at `/deploy` and can be
overridden with informed consent — `--override --reason "<why>"`, recorded on
the deploy record — while the typed-SHA production confirmation is never
overridable. `/release enable` initializes machine-local release module state,
`/release status` explains readiness without failing non-zero, and
`/release doctor --probe` refreshes live healthcheck evidence. Automation
should keep using `pipelane run release-check` when blocked readiness must fail
a script or CI step.

Repositories with multiple deploy surfaces should bind their deploy workflow
to a tracked surface contract. Add
`# pipelane-surface-contract: .github/deploy-surfaces.json` to the workflow and
declare each surface's affected paths in that versioned manifest. Pipelane uses
the contract to discover custom surfaces during configuration and to infer the
surface set from the target commit during deploy. A malformed contract or an
unconfigured declared surface blocks planning and dispatch rather than falling
back to stale task metadata.

## Verification Order

For current Pipelane flows, verification happens in this order:

1. local implementation checks, run by the agent or developer
2. `/pipelane review` static gates, behavioral gates, AI review gates, runtime gates, and human gates
3. `/pr` review-evidence display plus pre-PR checks from machine-local Pipelane config
4. CI checks on the PR
5. `/merge` SHA recording
6. `/deploy staging --pr <merged-pr-number>` in release mode
7. `/deploy prod --pr <merged-pr-number>`
8. automatic terminal workspace closeout after delivery proof; `/clean` is the retry/recovery surface

The orchestration foundation makes this ordering explicit by separating
deterministic gates from AI/manual gates before PR handoff.
See [Orchestration Roadmap](./ORCHESTRATION.md).

## Safe Defaults

Pipelane is intentionally conservative:

- `/new` creates isolated task worktrees instead of editing the main checkout.
- `/adopt` claims externally-created worktrees instead of duplicating them.
- `/pr` runs configured checks before pushing.
- `/pr` denies common secret/config paths unless explicitly forced.
- local-state declarations require an exact existing root, a reason, and
  interactive confirmation or explicit `--yes`; tracked conflicts fail closed.
- `/merge` records immutable delivery history, proves `origin/<base>` contains the merge, and closes only a clean, exact-bound task workspace.
- `--keep-worktree` is durable until explicit `/clean --apply --task <slug>`.
- release-mode `/deploy prod` requires same-SHA staging evidence unless
  overridden with a recorded `--override --reason`.
- production deploys and rollback require explicit confirmation.
- `/clean` refuses dirty, too-young, missing-evidence, protected ignored content, and unsafe workspaces; bare/status-only use is non-destructive.

## Configuration

Supported setup surface:

- durable machine-local commands from `pipelane install-claude` and/or `pipelane install-codex`
- runtime config from `$PIPELANE_HOME/repos/<repo-key>/config.json`; `.pipelane.json`, `.project-workflow.json`, and `package.json:pipelane` are not active config inputs
- Pipelane state files in the git common-dir, shared across worktrees
- one Pipelane-managed local-state v1 block in the Git common-dir
  `info/exclude`; user-owned lines outside the block remain byte-for-byte owned
  by the operator

Local operator state:

- deploy configuration saved through `pipelane configure` in machine-local Pipelane state
- automatic closeout policy is machine-local. Disable immediately with
  `pipelane configure --automatic-worktree-cleanup=false` and re-enable with
  `pipelane configure --automatic-worktree-cleanup=true`
- known disposable ignored output may be declared only as validated exact roots
  with repeatable `pipelane configure --disposable-ignored-path=<root>`; unknown
  ignored content remains protected
- deploy surface topology and path attribution can be tracked in a workflow-bound `.github/deploy-surfaces.json` contract
- no tracked `.claude/commands`, `.agents/skills`, package scripts, or consumer docs are generated by setup
- `pipelane setup` initializes the persistent empty local-state block; this
  one-time identity migration requires review evidence to be refreshed

## Review Stack

Pipelane and gstack have separate jobs:

- Pipelane moves work through worktree, PR, merge, deploy, rollback, and
  cleanup.
- gstack reviews whether the plan and code are good enough to move.

Recommended review order before merge:

1. static checks: lint, typecheck, format check, secret scan when configured
2. behavioral checks: tests and build
3. fix-first structural review: gstack `/review`
4. read-only traceability review: `karpathy-diff`
5. specialist review when needed: security, design, browser QA, docs drift

For a substantive branch, treat that list as a pre-lane convergence step:
run a broad multi-angle review, fold its findings in batches, record the clean
external review at the final HEAD, and only then enter the release lane.
`karpathy-diff` remains a per-HEAD clean-pass check, not the branch's discovery
engine.

An external review may satisfy the `code-review-high` gate without becoming a
waiver:

```bash
pipelane run review record --gate code-review-high --task <task> \
  --tool "<reviewer name>" --summary "<one-line result>" \
  --findings-count <n> --artifact <review-report> [--sha <reviewed-head>]
```

The signed record stores the recorder, review tool, timestamp, findings count,
and the artifact's path, digest, and size in the branch-keyed shared review
state. Fold findings before recording. `karpathy-diff` deliberately does not
consume this record and still runs at every shipping HEAD.

Use `review pass` only for a human approval gate. A specialized skill or agent
run performed outside Pipelane needs bounded structured evidence:

```bash
pipelane run review attest --gate karpathy-diff --status passed \
  --report-file <report.txt> --findings-file <findings.json> \
  --provenance-file <provenance.json> --message "Ran the named review"
```

Review evidence is informational at `/pr` and `/merge`: both commands show the
review state for the branch (what ran, what's open, what's stale) and proceed.
Missing, failed, or pending evidence asks for one informed consent —
`--override --reason "<why>"` on the command itself — which is recorded in the
shared review state. Staleness (commits made after the reviewed one) is a
displayed fact, never a wall. Failed or pending evidence is never relabeled as
passed.

When a full review fails, Pipelane shows all findings. The recommended flow is
to invoke `/fix` with the displayed findings as untrusted context, verify the
intended changes, and rerun `/pipelane review`; or proceed with the recorded
`--override --reason` consent when shipping is the right call anyway.

`reviewGates.enforcementMode` can be `legacy-v2` or `strict-v3`. Strict review
requires an authoritative task objective (`/new --brief`, `/adopt --brief`, an
approved orchestration slice outcome, or `/review --intent`), captures an
immutable machine-local Git target, and records the exact supplied capability,
adapter, structured findings, and result protocol. An override never changes a
failed or pending gate to passed.

The static gates should run before AI review. Do not spend review-model tokens
on issues ESLint, TypeScript, tests, or the build can reject deterministically.

## Recovery

Use `/status` first. It tells you the current lane, active task, branch state,
PR state, release readiness, deploy state, and next safe action.

Common recovery paths:

- lost task context: `/resume`
- external branch/worktree already exists: `/adopt`
- unsafe checkout: `/repo-guard`
- release module not enabled: `/release enable`
- release blocked: `/release status` or `/release doctor`
- stale probe: `/release doctor --probe`
- failed review or CI: `/fix`, then `/pr`
- failed production deploy or regression: `/rollback prod`
- stale local task metadata: `/clean --status-only`, then scoped cleanup
- retained workspace: `/clean --apply --task <slug>` explicitly clears retention and retries safety-checked closeout
- delivered backlog: `/clean --apply --delivered`; use `/status` for blocker counts and codes
- merge cleanup blocker: continue from the shared checkout printed by `/merge`; the delivery remains successful and the workspace remains available for inspection

## Archived Specs

Older target-state docs that no longer describe the active command surface live
under `docs/archive/`. They are kept for historical context only.
