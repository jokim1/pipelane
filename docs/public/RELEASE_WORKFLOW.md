# Pipelane Release Workflow

Last updated: June 15, 2026
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
| `/resume` | Recover an existing task worktree. |
| `/repo-guard` | Verify that the checkout is safe for task work. |
| `/pipelane review` | Run configured review gates and write evidence for the current diff. |
| `/pr` | Enforce review evidence, run pre-PR checks, commit, push, and open or update a PR. |
| `/merge` | Merge the PR and record the merged SHA. |
| `/deploy` | Deploy the merged SHA to `staging` or `prod`. |
| `/clean` | Inspect and prune finished or stale task state. |
| `/doctor` | Diagnose deploy config, probes, and release readiness. |
| `/rollback` | Roll back staging or production to the last verified-good deploy. |
| `/fix` | Apply durable root-cause fixes from failures and findings. |

Repo-native `npm run pipelane:*` scripts are the implementation layer behind
these commands. Operator docs should point people and agents at slash commands.

## Build Lane

Build mode is the fast lane. Use it when production deploys already happen
safely after merge and same-SHA staging validation is not required.

```text
/devmode build
/new
/pipelane review
/pr --title "PR title"
/merge
/clean
```

Build mode still expects verification before merge. The default pre-PR checks
come from `.pipelane.json` `prePrChecks`, usually:

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
/new
/pipelane review
/pr --title "PR title"
/merge
/deploy staging
/deploy prod
/clean
```

Release mode fails closed when deploy config, staging evidence, or probe health
is missing. `/doctor` explains what is missing, `/doctor --fix` guides local
configuration, and `/doctor --probe` refreshes live healthcheck evidence.

## Verification Order

For current Pipelane flows, verification happens in this order:

1. local implementation checks, run by the agent or developer
2. `/pipelane review` static gates, behavioral gates, AI review gates, runtime gates, and human gates
3. `/pr` review-evidence enforcement plus pre-PR checks from `.pipelane.json`
4. CI checks on the PR
5. `/merge` SHA recording
6. `/deploy staging` in release mode
7. `/deploy prod`
8. `/clean` only after task state is safe to close

The orchestration foundation makes this ordering explicit by separating
deterministic gates, autonomous AI gates, and human approval gates before PR
handoff.
See [Orchestration Roadmap](./ORCHESTRATION.md).

## Safe Defaults

Pipelane is intentionally conservative:

- `/new` creates isolated task worktrees instead of editing the main checkout.
- `/pr` runs configured checks before pushing.
- `/pr` denies common secret/config paths unless explicitly forced.
- `/merge` records the merged SHA instead of guessing from `origin/main`.
- release-mode `/deploy prod` requires same-SHA staging evidence.
- production deploys and rollback require explicit confirmation.
- `/clean` refuses dirty, too-young, missing-evidence, and unsafe workspaces.

## Configuration

Tracked repo policy:

- `.pipelane.json` or `package.json:pipelane`
- `.claude/commands/*`
- `.agents/skills/*`
- `AGENTS.md`
- `docs/RELEASE_WORKFLOW.md` in consumer repos
- `REPO_GUIDANCE.md`

Local operator state:

- `CLAUDE.md` for local deploy configuration
- Pipelane state files in the git common-dir, shared across worktrees

## Review Stack

Pipelane and gstack have separate jobs:

- Pipelane moves work through worktree, PR, merge, deploy, rollback, and
  cleanup.
- gstack reviews whether the plan and code are good enough to move.

Recommended review order before merge:

1. static checks: lint, typecheck, format check, secret scan when configured
2. behavioral checks: tests and build
3. fix-first structural review: gstack `/review`
4. read-only traceability/adversarial review: `karpathy-diff`, adversarial review
5. specialist review when needed: security, design, browser QA, docs drift

`/pipelane review` runs configured AI review gates autonomously through
`PIPELANE_REVIEW_AI_COMMAND` or an installed native `codex`/`claude` adapter.
AI runners must end with `PIPELANE_REVIEW_STATUS: passed`, `failed`, or
`pending`. If any review gate changes `HEAD` or the tracked/non-ignored
worktree, Pipelane restarts the review and records evidence only after the tree
settles. Deterministic gates should not write non-ignored outputs during review.

The static gates should run before AI review. Do not spend review-model tokens
on issues ESLint, TypeScript, tests, or the build can reject deterministically.

## Recovery

Use `/status` first. It tells you the current lane, active task, branch state,
PR state, release readiness, deploy state, and next safe action.

Common recovery paths:

- lost task context: `/resume`
- unsafe checkout: `/repo-guard`
- release blocked: `/doctor`
- stale probe: `/doctor --probe`
- failed review or CI: `/fix`, then `/pr`
- failed production deploy or regression: `/rollback prod`
- stale local task metadata: `/clean --status-only`, then scoped cleanup

## Archived Specs

Older target-state docs that no longer describe the active command surface live
under `docs/archive/`. They are kept for historical context only.
