# Release Workflow

Last updated: June 15, 2026
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
- `{{ALIAS_RESUME}}` is the recovery command
- `/fix` is the durable repair loop for bugs, review findings, CI failures, and code-quality repairs
- `repo-guard` is internal-only

## Supported Operator Surfaces

This repo exposes the following user-facing slash commands through Claude/Codex adapters:

- `/pipelane` (journey overview)
- `/pipelane web` (local web board)
- `{{ALIAS_DEVMODE}}`
- `{{ALIAS_NEW}}`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_PR}}`
- `{{ALIAS_MERGE}}`
- `{{ALIAS_DEPLOY}}`
- `{{ALIAS_CLEAN}}`
- `{{ALIAS_STATUS}}`
- `{{ALIAS_DOCTOR}}`
- `{{ALIAS_ROLLBACK}}`
- `/fix`
- `/fix rethink`

If aliases change in `.pipelane.json`, rerun setup and reopen Claude/Codex so the new command names are picked up.
Aliases must be unique, and setup fails closed if an alias would overwrite an unrelated command or skill.
Codex resolves aliases per repo at runtime, so the same alias name can map to different workflow commands in different pipelane repos on one machine.

## pipelane and gstack

Use both.

`pipelane` owns the repo-specific workflow contract:

- `{{ALIAS_DEVMODE}}`
- `{{ALIAS_NEW}}`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_PR}}`
- `{{ALIAS_MERGE}}`
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
3. traceability review such as `karpathy-diff`
4. structural review such as gstack `/review`
5. specialist review when needed: security, design, QA, docs drift

For manual review gates, run the referenced skill, fix any findings, then
record the clean gate with Pipelane, for example
`pipelane run review pass --gate gstack-review --message "Ran /review clean"`.

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
5. `{{ALIAS_CLEAN}}`

### Release mode user journey

Release mode is the protected lane.

Use it when:

- staging must validate the release before prod
- this repo needs same-SHA staged promotion
- backend or multi-surface work needs stricter discipline

User-facing journey:

1. `{{ALIAS_DEVMODE}} release`
2. `{{ALIAS_NEW}}`
3. `{{ALIAS_PR}} --title "<pr title>"`
4. `{{ALIAS_MERGE}}`
5. `{{ALIAS_DEPLOY}} staging`
6. `{{ALIAS_DEPLOY}} prod`
7. `{{ALIAS_CLEAN}}`

## Build Mode

Build mode is the fast lane.

- production deploy is expected to happen after merge
- no staging promotion step is required

## Release Mode

Release mode is the protected lane.

- it is fail-closed
- staging must be configured before the repo switches to release mode
- production promotion should use the same merged SHA that passed staging

## Release Readiness Gate

The gate reads local `CLAUDE.md` and validates the configured surfaces:

- `{{SURFACES_CSV}}`
- the latest `/doctor --probe` result for each configured surface must be green and fresh
- cached probe results are tied to the exact configured `healthcheckUrl`, so any staging URL or healthcheck-path change requires rerunning `{{ALIAS_DOCTOR}} --probe`
- if `PIPELANE_PROBE_STATE_KEY` is set, only signed probe records count toward release readiness

## Environment and Surface Names

Environment names:

- `staging`
- `prod`
- `production`

Surfaces:

- `{{SURFACES_CSV}}`

## Cleanup

`{{ALIAS_CLEAN}}` closes completed, prod-verified task workspaces automatically when the local safety checks pass, then reports anything left. Use `--status-only` for a non-mutating preview, `--apply --all-stale` to prune stale task locks in bulk, or `--apply --task <slug>` to close a specific task explicitly.

## Supporting Files

Pipelane no longer supports tracked repo-local adapter opt-in. The supported
command surface is installed once per machine with `pipelane install-claude`
and/or `pipelane install-codex`.

Runtime configuration may still live in `.pipelane.json` when a command needs
to persist deploy, smoke, or review settings. Repos that do not want Pipelane
config committed should gitignore `.pipelane.json`.

## Workflow contract: `.pipelane.json` or `package.json:pipelane`

Pipelane resolves the workflow contract by layering:

1. Built-in defaults (from `defaultWorkflowConfig`).
2. `package.json:pipelane` overlay (tracked, optional).
3. `.pipelane.json` (tracked or gitignored, optional).

The file wins field-by-field over the overlay, which wins over defaults. If
neither file nor overlay is present, `pipelane setup` self-heals by
synthesizing a config from the repo name plus defaults.

Runtime mutations from `pipelane configure` write to `.pipelane.json`. If it
doesn't exist yet, the mutator materializes it from the synthesized config at
write time.

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

1. run `pipelane configure`
2. run `{{ALIAS_DOCTOR}} --probe`
3. verify with `{{ALIAS_DEVMODE}} release`

## Day-One Operator Journey

1. Run setup
2. `{{ALIAS_DEVMODE}} status`
3. describe the task, then run `{{ALIAS_NEW}}`
4. implement and verify
5. `{{ALIAS_PR}} --title "<pr title>"`

## Troubleshooting and Common Failures

- missing `.pipelane.json`
  - run `pipelane setup`; commands that need persisted config will materialize `.pipelane.json`
- task already active
  - use `{{ALIAS_RESUME}} --task "<task-name>"`
- release mode blocked
  - run `pipelane configure` to complete Deploy Configuration
  - rerun `{{ALIAS_DOCTOR}} --probe` after any staging URL or healthcheck-path change because cached probe results are URL-bound
  - if probe-state signing is enabled, make sure `PIPELANE_PROBE_STATE_KEY` is set on the machine running the probe and then rerun it
