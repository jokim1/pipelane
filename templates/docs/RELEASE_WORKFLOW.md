# Release Workflow

Last updated: April 13, 2026
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
- `{{ALIAS_SMOKE}}`
- `{{ALIAS_CLEAN}}`
- `{{ALIAS_STATUS}}`
- `{{ALIAS_DOCTOR}}`
- `{{ALIAS_ROLLBACK}}`

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
- `{{ALIAS_SMOKE}}`
- `{{ALIAS_CLEAN}}`
- `{{ALIAS_STATUS}}`
- `{{ALIAS_DOCTOR}}`
- `{{ALIAS_ROLLBACK}}`

gstack is still recommended for:

- `review`
- `qa`
- `plan-eng-review`
- `setup-deploy`
- docs and release follow-up
- investigation and debugging
- standalone Codex flows

This repo should prefer the pipelane release flow over generic gstack `/ship`.

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
- agents should infer `--task "<task-name>"` from the described work when the user invokes bare `{{ALIAS_NEW}}`
- a generated `task-<hex>` slug requires explicit `--unnamed`

`{{ALIAS_RESUME}}` is the recovery path, not the normal happy path.

Properties:

- resolves by task slug, not branch id
- returns the saved workspace and mode
- does not create a workspace
- redirects back to `{{ALIAS_NEW}}` if the saved workspace is gone
- lists active tasks when called without `--task`

The chat/workspace does not move automatically. Switch into the reported path before editing.

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
6. `{{ALIAS_SMOKE}} staging`
7. `{{ALIAS_DEPLOY}} prod`
8. `{{ALIAS_CLEAN}}`

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

Tracked (choose one shape for the workflow contract):

- `.pipelane.json` — the default. Full workflow contract in one file.
- `package.json` `"pipelane"` overlay — for consumers that gitignore
  `.pipelane.json` and want customizations (aliases, smoke commands,
  `syncDocs`) to survive fresh checkouts without a re-bootstrap.

Always tracked:

- `AGENTS.md`
- `.claude/commands/*`
- `.agents/skills/*`
- `pipelane/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`

Local-only:

- `CLAUDE.md`

## Workflow contract: `.pipelane.json` or `package.json:pipelane`

Pipelane resolves the workflow contract by layering:

1. Built-in defaults (from `defaultWorkflowConfig`).
2. `package.json:pipelane` overlay (tracked, optional).
3. `.pipelane.json` (tracked or gitignored, optional).

The file wins field-by-field over the overlay, which wins over defaults. If
neither file nor overlay is present, `pipelane setup` self-heals by
synthesizing a config from the repo name plus defaults — no `pipelane
bootstrap` re-run required on fresh worktrees.

Runtime mutations (`{{ALIAS_SMOKE}} setup`, `pipelane configure`) write
to `.pipelane.json`. If it doesn't exist yet, the mutator materializes
it from the synthesized config at write time.

### Optional `syncDocs` opt-outs

By default, `pipelane setup` and `pipelane sync-docs` write every surface:
regenerate `.claude/commands/*.md` and `.agents/skills/*`, inject marker sections into
`README.md` / `CONTRIBUTING.md` / `AGENTS.md`, create or refresh
`docs/RELEASE_WORKFLOW.md` and `pipelane/CLAUDE.template.md`, and ensure
the `pipelane:*` scripts in `package.json`.

Consumers that want partial regeneration can opt out per surface by
adding a `syncDocs` block. Every flag defaults to `true`; absent or
`true` = sync that surface, `false` = leave it alone.

```json
{
  "syncDocs": {
    "claudeCommands": true,
    "codexSkills": true,
    "readmeSection": false,
    "contributingSection": false,
    "agentsSection": false,
    "docsReleaseWorkflow": false,
    "pipelaneClaudeTemplate": false,
    "packageScripts": true
  }
}
```

| Flag | Controls |
| --- | --- |
| `claudeCommands` | `.claude/commands/*.md` regeneration, including `pipelane.md` and the managed manifest. |
| `codexSkills` | `.agents/skills/*` regeneration, including the managed manifest for tracked Codex skills. |
| `readmeSection` | Marker-wrapped `README.md` section. |
| `contributingSection` | Marker-wrapped `CONTRIBUTING.md` section. |
| `agentsSection` | Marker-wrapped `AGENTS.md` section. |
| `docsReleaseWorkflow` | `docs/RELEASE_WORKFLOW.md` file write. |
| `pipelaneClaudeTemplate` | `pipelane/CLAUDE.template.md` file write. |
| `packageScripts` | `pipelane:*` script entries in `package.json`. Setting this to `false` while `claudeCommands` or `codexSkills` is `true` requires the consumer's `package.json` to already define the full managed `pipelane:*` workflow script set for that Pipelane version, plus `pipelane:configure`. Setup fails fast with guidance if any are missing. |

Opting out never removes content that a previous sync already wrote; it
just stops future syncs from touching the surface.

## Required `AGENTS.md`

This repo tracks `AGENTS.md` as the repo policy surface for pipelane.

## Required local `CLAUDE.md`

`CLAUDE.md` is machine-local and git-ignored. Setup creates it if missing.

## What each user must do

### One repo maintainer

1. run `pipelane bootstrap --yes --project "{{DISPLAY_NAME}}"` or `npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "{{DISPLAY_NAME}}"`
2. review `.pipelane.json`, especially `aliases` (or the `pipelane` block in
   `package.json` if using the gitignored-config flow)
3. commit the tracked Pipelane files

### Each Claude user

1. optional once per machine: run `pipelane install-claude` for durable default personal skills under `~/.claude/skills`
2. pull the committed workflow files
3. open the repo in Claude
4. reopen or restart Claude if aliases changed or the command files were added while it was already open

### Each Codex user

1. optional once per machine: run `pipelane install-codex` for durable default skills under `~/.codex/skills`
2. pull the committed workflow files
3. if this machine previously used pipelane's machine-local Codex wrappers, rerun setup once to prune them
4. open the repo in Codex
5. reopen or restart Codex if tracked skills or aliases changed while it was already open

### Repos that do not commit Pipelane adapters

Use the machine-local commands from `pipelane install-claude` and
`pipelane install-codex` only. Do not run `bootstrap` or `/init-pipelane` unless
you intentionally want generated repo config/adapters/docs. To protect raw npm
in symlinked worktrees, run `pipelane install-npm-guard`, put `~/.pipelane/bin`
first in `PATH`, and verify with `pipelane run doctor --check-guard`.

### Each release operator

1. run setup
2. fill local deploy config in `CLAUDE.md`
3. run `{{ALIAS_DOCTOR}} --probe`
4. verify with `{{ALIAS_DEVMODE}} release`

## Install In A New Repo

```bash
npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "{{DISPLAY_NAME}}"
# or, if pipelane is already on PATH:
pipelane bootstrap --project "{{DISPLAY_NAME}}"
```

For first-time adoption in an existing remote-backed repo, commit the tracked Pipelane files
before using `{{ALIAS_NEW}}`. New task worktrees are created from `{{BASE_BRANCH}}`, so the
workflow contract needs to exist there first.

## Day-One Operator Journey

1. Run setup
2. `{{ALIAS_DEVMODE}} status`
3. describe the task, then run `{{ALIAS_NEW}}`
4. implement and verify
5. `{{ALIAS_PR}} --title "<pr title>"`

## Troubleshooting and Common Failures

- missing `.pipelane.json`
  - run `pipelane bootstrap --project "{{DISPLAY_NAME}}"` or `pipelane init`
- task already active
  - use `{{ALIAS_RESUME}} --task "<task-name>"`
- release mode blocked
  - complete local `CLAUDE.md`
  - rerun `{{ALIAS_DOCTOR}} --probe` after any staging URL or healthcheck-path change because cached probe results are URL-bound
  - if probe-state signing is enabled, make sure `PIPELANE_PROBE_STATE_KEY` is set on the machine running the probe and then rerun it
