# Release Workflow

Last updated: July 16, 2026
Status: canonical maintainer workflow for {{DISPLAY_NAME}}

This document is the full operator guide for this repo's pipelane setup.

## Who this is for

`{{DISPLAY_NAME}}` uses `pipelane` as its repo-specific workflow layer for AI-first
builders and small teams. The goal is a workflow that Claude, Codex, and human operators can
follow safely without improvising repo behavior.

## Current Status

`{{DISPLAY_NAME}}` uses `pipelane` as its shared release-management and task-workspace layer.

- slash aliases are the operator-facing command surface
- repo-native scripts are implementation plumbing behind those aliases
- `{{ALIAS_NEW}}` is the canonical task-start command
- `{{ALIAS_ADOPT}}` binds external task branches/worktrees without duplicating them
- `{{ALIAS_RESUME}}` is the recovery command
- `{{ALIAS_MERGE}}` normally closes the clean task worktree after confirmed delivery; `--keep-worktree` retains it durably
- `{{ALIAS_RELEASE}}` is the release-module setup and status command
- `/fix` is the durable repair loop for bugs, review findings, CI failures, and code-quality repairs
- `repo-guard` is internal-only

## Supported Operator Surfaces

This repo exposes the following user-facing slash commands through Claude/Codex adapters:

- `/pipelane` (journey overview)
- `/pipelane web` (local web board)
- `{{ALIAS_DEVMODE}}`
- `{{ALIAS_NEW}}`
- `{{ALIAS_ADOPT}}`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_PR}}`
- `{{ALIAS_MERGE}}`
- `{{ALIAS_RELEASE}}`
- `{{ALIAS_DEPLOY}}`
- `{{ALIAS_CLEAN}}`
- `{{ALIAS_STATUS}}`
- `{{ALIAS_DOCTOR}}`
- `{{ALIAS_ROLLBACK}}`
- `/fix`
- `/fix rethink`

If aliases change, rerun setup and reopen Claude/Codex so the new command names are picked up.
Aliases must be unique, and setup fails closed if an alias would overwrite an unrelated command or skill.
Codex resolves aliases per repo at runtime, so the same alias name can map to different workflow commands in different pipelane repos on one machine.

## Machine-local tool state

Tool runtime files that belong in the checkout but must never become repository
content are registered explicitly through Pipelane's fixed CLI:

```text
pipelane run local-state list
pipelane run local-state add --path <repo-relative-root> --reason <why> [--yes]
pipelane run local-state remove --path <repo-relative-root> [--yes]
```

Setup initializes one persistent empty v1 block in the Git common-dir
`info/exclude`. Linked worktrees share it. Declarations are exact roots rather
than globs, tracked content always wins, and a later tracked or kind conflict
blocks source-changing commands. Non-interactive add requires `--path`,
`--reason`, and `--yes`; no skill or tool can register itself implicitly.
Removing a declaration only changes Git visibility, never disk content, and the
empty block remains after the final removal.

## pipelane and gstack

Use both.

`pipelane` owns the repo-specific workflow contract:

- `{{ALIAS_DEVMODE}}`
- `{{ALIAS_NEW}}`
- `{{ALIAS_ADOPT}}`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_PR}}`
- `{{ALIAS_MERGE}}`
- `{{ALIAS_RELEASE}}`
- `{{ALIAS_DEPLOY}}`
- `{{ALIAS_CLEAN}}`
- `{{ALIAS_STATUS}}`
- `{{ALIAS_DOCTOR}}`
- `{{ALIAS_ROLLBACK}}`
- `/fix`

gstack is still recommended for:

- `review`
- `qa`
- `plan-eng-review`
- `setup-deploy`
- docs and release follow-up
- investigation and debugging
- standalone Codex flows

This repo should prefer the pipelane release flow over generic gstack `/ship`.

## Review and Repair Stack

Run deterministic checks before AI review whenever this repo has them:

1. lint, typecheck, format check, and secret scan when configured
2. tests and build
3. fix-first structural review such as gstack `/review`
4. read-only traceability review such as `karpathy-diff`
5. specialist review when needed: security, design, QA, docs drift

For a substantive branch, run a broad multi-angle review before entering the
lane, fold its findings in batches, then record the clean external review at
the final HEAD:

```bash
pipelane run review record --gate code-review-high --task <task> \
  --tool "<reviewer name>" --summary "<one-line result>" \
  --findings-count <n> --artifact <review-report>
```

The record is evidence, not a waiver. A new commit after the reviewed one is
displayed as staleness ("N files changed since the reviewed commit"), never a
wall. `karpathy-diff` still runs at each shipping HEAD as a clean-pass check,
not a discovery engine. Use `review pass` only for human approval gates.
Missing, failed, or pending review evidence asks for one informed consent at
`/pr` or `/merge` — `--override --reason "<why>"` — which is recorded; failed
or pending evidence is never relabeled as passed.

Use `/fix` to repair bugs, review findings, CI failures, and code-quality
issues. Use `/fix rethink` for planning-only architecture review before large
refactors.

## Task Workspace Flow

`{{ALIAS_NEW}}` is the canonical task-start command.

Properties:

- creates a fresh `codex/<task>-<4hex>` branch
- creates a sibling worktree under `../{{TASK_WORKTREE_DIR_NAME}}/`
- refreshes `origin/{{BASE_BRANCH}}` first
- inherits the current dev mode
- fails closed if the task already exists and points to `{{ALIAS_RESUME}}`
- fails closed if the current checkout has uncommitted changes or is already bound to a task, unless `--force` is explicit
- fails closed when a matching orphan worktree exists without a task lock, so finished manual work is not accidentally abandoned
- agents should infer `--task "<task-name>"` from the described work when the user invokes bare `{{ALIAS_NEW}}`; if the user provides a task name, use it
- a generated `task-<hex>` slug requires explicit `--unnamed`
- agents must not edit in the starting checkout while planning to run `{{ALIAS_NEW}}` later; the task workspace must exist first
- if `{{ALIAS_NEW}}` fails, agents must stop instead of continuing implementation in the current checkout

`{{ALIAS_ADOPT}}` is the external-worktree handoff command.

Use it when another model, tool, or human already created a branch/worktree that
should become the Pipelane task workspace.

Properties:

- does not create a new branch or worktree
- refuses detached checkouts
- refuses base branches unless `--force` is explicit
- infers the task slug from the branch when `--task` is omitted
- records binding history when `--force` intentionally rebinds a task
- links shared `node_modules` into the adopted worktree when safe

`{{ALIAS_RESUME}}` is the recovery path, not the normal happy path.

Properties:

- resolves by task slug, not branch id
- returns the saved workspace and mode
- does not create a workspace
- redirects back to `{{ALIAS_NEW}}` if the saved workspace is gone
- lists active tasks when called without `--task`

The chat/workspace does not move automatically. Switch into the reported path before reading or editing task files. If the tool cannot switch workspaces, stop and report the path instead of continuing in the shared checkout.

## `{{ALIAS_NEW}}` behavior

Typical result:

```text
Continue this task in: ../{{TASK_WORKTREE_DIR_NAME}}/my-task-ab12
Task: My Task
Slug: my-task
Branch: codex/my-task-ab12
Mode: build
Chat has not moved. Switch this chat/workspace to that path before editing.
```

## `{{ALIAS_RESUME}}` behavior

Normal use:

```text
{{ALIAS_RESUME}} --task "My Task"
```

Fallback listing:

```text
{{ALIAS_RESUME}}
```

## Build vs Release user journeys

### Build mode user journey

Build mode is the fast lane.

Use it when:

- production deploy is expected to happen after merge
- no staging promotion step is required
- this repo wants the shortest path from merge to production

User-facing journey:

1. `{{ALIAS_DEVMODE}} build`
2. `{{ALIAS_NEW}}`
3. `{{ALIAS_PR}} --title "<pr title>"`
4. `{{ALIAS_MERGE}}`

After merge, continue from the primary shared checkout printed in the receipt.

### Release mode user journey

Release mode is the protected lane.

Use it when:

- staging must validate the release before prod
- this repo needs same-SHA staged promotion
- backend or multi-surface work needs stricter discipline

User-facing journey:

1. `{{ALIAS_DEVMODE}} release`
2. `{{ALIAS_RELEASE}} status`
3. `{{ALIAS_NEW}}`
4. `{{ALIAS_PR}} --title "<pr title>"`
5. `{{ALIAS_MERGE}}`
6. from the reported shared checkout, `{{ALIAS_DEPLOY}} staging --pr <merged-pr-number>`
7. `{{ALIAS_DEPLOY}} prod --pr <merged-pr-number>`

The explicit PR number lets deploy resolve the exact merged SHA, mode, and
surfaces from immutable delivery history; it does not need the removed edit
worktree.

## Automatic task-workspace closeout

Successful `{{ALIAS_MERGE}}` removes the clean task worktree, its exact local
branch, and the task lock after the remote base is proven to contain the merge.
Dirty, untracked, detached, mismatched, unknown ignored, or actively leased
workspaces survive with a stable blocker code. A merge remains successful when
local cleanup is blocked.

- retain intentionally: `{{ALIAS_MERGE}} --keep-worktree`
- explicitly clear retention/retry: `{{ALIAS_CLEAN}} --apply --task <slug>`
- retry delivered backlog: `{{ALIAS_CLEAN}} --apply --delivered`
- preview only: bare `{{ALIAS_CLEAN}}` or `{{ALIAS_CLEAN}} --status-only`
- disable globally for this machine/repository:
  `pipelane configure --automatic-worktree-cleanup=false`
- re-enable: `pipelane configure --automatic-worktree-cleanup=true`
- replace validated disposable ignored roots with repeatable
  `pipelane configure --disposable-ignored-path=<root>`

Disposable declarations are exact repository-relative roots. Symlink escapes,
tracked paths, and unknown ignored content remain protected. `{{ALIAS_STATUS}}`
shows policy state plus pending, eligible, kept, and blocked counts by code.

## Build Mode

Build mode is the fast lane.

- production deploy is expected to happen after merge
- no staging promotion step is required

## Release Mode

Release mode is the protected lane.

- it is fail-closed
- staging must be configured before the repo switches to release mode
- production promotion should use the same merged SHA that passed staging
- `{{ALIAS_RELEASE}} enable` initializes machine-local deploy config state
- `{{ALIAS_RELEASE}} status` is read-only and explains readiness without exiting non-zero
- `{{ALIAS_RELEASE}} doctor --probe` delegates to the deploy-config/probe diagnostics
- `pipelane run release-check` remains the automation gate for CI or scripts that need a non-zero blocked-readiness exit

## Release Readiness Gate

The gate reads machine-local deploy configuration and validates the configured surfaces:

- `{{SURFACES_CSV}}`
- the latest `{{ALIAS_RELEASE}} doctor --probe` result for each configured surface must be green and fresh
- cached probe results are tied to the exact configured `healthcheckUrl`, so any staging URL or healthcheck-path change requires rerunning `{{ALIAS_RELEASE}} doctor --probe`
- if `PIPELANE_PROBE_STATE_KEY` is set, only signed probe records count toward release readiness

## Environment and Surface Names

Environment names:

- `staging`
- `prod`
- `production`

Surfaces:

- `{{SURFACES_CSV}}`

## Cleanup

`{{ALIAS_CLEAN}}` is a non-mutating preview of delivered-workspace cleanup readiness. Use `--apply --delivered` to retry delivered workspaces in bulk, `--apply --all-stale` for metadata-only stale-lock pruning, or `--apply --task <slug>` to close a specific task explicitly. Production verification is not required when typed remote-base delivery proof is available.

## Supporting Files

Pipelane no longer supports tracked repo-local adapter opt-in. The supported
command surface is installed once per machine with `pipelane install-claude`
and/or `pipelane install-codex`.

Runtime configuration lives outside the repo at
`$PIPELANE_HOME/repos/<repo-key>/config.json` (default home:
`~/.pipelane`). Deploy and review setup mutations write there. Pipelane
does not use `.pipelane.json`, `.project-workflow.json`, or
`package.json:pipelane` as active config inputs.

## Workflow contract: machine-local only

Pipelane resolves the workflow contract from:

1. Built-in defaults (from `defaultWorkflowConfig`).
2. Machine-local repo config at `$PIPELANE_HOME/repos/<repo-key>/config.json`.

If no machine-local config exists, Pipelane self-heals by synthesizing a config
from the repo name plus defaults. Runtime mutations materialize the
machine-local file at write time.

## What each user must do

### Each Claude user

1. once per machine: run `pipelane install-claude` for durable default personal skills under `~/.claude/skills`
2. open the repo in Claude
3. reopen or restart Claude if newly installed commands are not visible

### Each Codex user

1. once per machine: run `pipelane install-codex` for durable default skills under `~/.codex/skills`
2. open the repo in Codex
3. reopen or restart Codex if newly installed commands are not visible

### Each repo

1. run `pipelane setup`
2. run `pipelane review setup`
3. optionally run `pipelane install-npm-guard`, put `~/.pipelane/bin` first in
   `PATH`, and verify with `pipelane run doctor --check-guard`

### Each release operator

1. run `{{ALIAS_RELEASE}} enable`
2. run `pipelane configure`
3. run `{{ALIAS_RELEASE}} doctor --probe`
4. inspect with `{{ALIAS_RELEASE}} status`
5. switch with `{{ALIAS_DEVMODE}} release`

## Day-One Operator Journey

1. Run setup
2. `{{ALIAS_DEVMODE}} status`
3. describe the task, then run `{{ALIAS_NEW}}`
4. if another tool already created the branch/worktree, run `{{ALIAS_ADOPT}} --task "<task-name>"` instead
5. implement and verify
6. `{{ALIAS_PR}} --title "<pr title>"`

## Troubleshooting and Common Failures

- missing local config
  - run `pipelane setup`; commands that need persisted config will materialize machine-local config
- task already active
  - use `{{ALIAS_RESUME}} --task "<task-name>"`
- branch/worktree already exists outside Pipelane
  - run `{{ALIAS_ADOPT}} --task "<task-name>"`
- release mode blocked
  - run `{{ALIAS_RELEASE}} enable`, then `pipelane configure` to complete Deploy Configuration
  - rerun `{{ALIAS_RELEASE}} doctor --probe` after any staging URL or healthcheck-path change because cached probe results are URL-bound
  - if probe-state signing is enabled, make sure `PIPELANE_PROBE_STATE_KEY` is set on the machine running the probe and then rerun it
