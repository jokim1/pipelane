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

- repo-native scripts are the source of truth
- slash wrappers are thin adapters only
- `{{ALIAS_NEW}}` is the canonical task-start command
- `{{ALIAS_RESUME}}` is the recovery command
- `repo-guard` is internal-only

## Supported Operator Surfaces

### Repo-native CLI Surface

- `npm run pipelane:setup`
- `npm run pipelane:devmode -- ...`
- `npm run pipelane:new -- --task "<task-name>"`
- `npm run pipelane:resume -- --task "<task-name>"`
- `npm run pipelane:pr -- ...`
- `npm run pipelane:merge`
- `npm run pipelane:release-check`
- `npm run pipelane:task-lock -- verify --task "<task-name>"`
- `npm run pipelane:deploy -- staging|prod ...`
- `npm run pipelane:smoke -- plan|staging|prod`
- `npm run pipelane:clean`
- `npm run pipelane:status`
- `npm run pipelane:doctor` (add `-- --probe` for staging healthchecks, `-- --fix` for the guided wizard)

### AI-client Slash Surface

This repo exposes the following user-facing slash commands through Claude/Codex adapters:

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

If aliases change in `.pipelane.json`, rerun `npm run pipelane:setup` and reopen Claude/Codex so the new command names are picked up.
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
- `--task "<task-name>"` is optional; when omitted, `{{ALIAS_NEW}}` generates a `task-<hex>` slug automatically

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

```bash
npm run pipelane:resume -- --task "My Task"
```

Fallback listing:

```bash
npm run pipelane:resume
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
2. `{{ALIAS_NEW}} <task-name>`
3. `{{ALIAS_PR}}`
4. `{{ALIAS_MERGE}}`
5. `{{ALIAS_CLEAN}}`

Repo-native journey:

1. `npm run pipelane:devmode -- build`
2. `npm run pipelane:new -- --task "<task-name>"`
3. `npm run pipelane:pr -- --title "<pr title>"`
4. `npm run pipelane:merge`
5. `npm run pipelane:clean`

### Release mode user journey

Release mode is the protected lane.

Use it when:

- staging must validate the release before prod
- this repo needs same-SHA staged promotion
- backend or multi-surface work needs stricter discipline

User-facing journey:

1. `{{ALIAS_DEVMODE}} release`
2. `{{ALIAS_NEW}} <task-name>`
3. `{{ALIAS_PR}}`
4. `{{ALIAS_MERGE}}`
5. `{{ALIAS_DEPLOY}} staging`
6. `{{ALIAS_DEPLOY}} prod`
7. `{{ALIAS_CLEAN}}`

Repo-native journey:

1. `npm run pipelane:devmode -- release`
2. `npm run pipelane:new -- --task "<task-name>"`
3. `npm run pipelane:pr -- --title "<pr title>"`
4. `npm run pipelane:merge`
5. `npm run pipelane:deploy -- staging`
6. `npm run pipelane:deploy -- prod`
7. `npm run pipelane:clean`

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
- cached probe results are tied to the exact configured `healthcheckUrl`, so any staging URL or healthcheck-path change requires rerunning `npm run pipelane:doctor -- --probe`
- if `PIPELANE_PROBE_STATE_KEY` is set, only signed probe records count toward release readiness

## Environment and Surface Names

Environment names:

- `staging`
- `prod`
- `production`

Surfaces:

- `{{SURFACES_CSV}}`

## Cleanup

`pipelane:clean` is report-first. Use `--apply` only when you want to prune stale task locks.

## Supporting Files

Tracked:

- `.pipelane.json`
- `AGENTS.md`
- `.claude/commands/*`
- `.agents/skills/*`
- `pipelane/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`

Local-only:

- `CLAUDE.md`

## Required `.pipelane.json`

This repo tracks `.pipelane.json` as the workflow contract.

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

`CLAUDE.md` is machine-local and git-ignored. `npm run pipelane:setup` creates it if missing.

## What each user must do

### One repo maintainer

1. run `pipelane bootstrap --project "{{DISPLAY_NAME}}"` or `npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "{{DISPLAY_NAME}}"`
2. review `.pipelane.json`, especially `aliases`
3. commit the tracked Pipelane files

### Each Claude user

1. optional once per machine: run `pipelane install-claude` for the global `/init-pipelane` bootstrap command
2. pull the committed workflow files
3. open the repo in Claude
4. reopen or restart Claude if aliases changed or the command files were added while it was already open

### Each Codex user

1. optional once per machine: run `pipelane install-codex` for the global `/init-pipelane` bootstrap command
2. pull the committed workflow files
3. if this machine previously used pipelane's machine-local Codex wrappers, run `npm run pipelane:setup` once to prune them
4. open the repo in Codex
5. reopen or restart Codex if tracked skills or aliases changed while it was already open

### Each release operator

1. run `npm run pipelane:setup`
2. fill local deploy config in `CLAUDE.md`
3. verify with `npm run pipelane:release-check`

## Install In A New Repo

```bash
npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "{{DISPLAY_NAME}}"
# or, if pipelane is already on PATH:
pipelane bootstrap --project "{{DISPLAY_NAME}}"
```

For first-time adoption in an existing remote-backed repo, commit the tracked Pipelane files
before using `pipelane:new`. New task worktrees are created from `{{BASE_BRANCH}}`, so the
workflow contract needs to exist there first.

## Day-One Operator Journey

1. `npm run pipelane:setup`
2. `npm run pipelane:devmode -- status`
3. `npm run pipelane:new -- --task "<task-name>"`
4. implement and verify
5. `npm run pipelane:pr -- --title "<pr title>"`

## Troubleshooting and Common Failures

- missing `.pipelane.json`
  - run `pipelane bootstrap --project "{{DISPLAY_NAME}}"` or `pipelane init`
- task already active
  - use `pipelane:resume -- --task "<task-name>"`
- release mode blocked
  - complete local `CLAUDE.md`
  - rerun `npm run pipelane:doctor -- --probe` after any staging URL or healthcheck-path change because cached probe results are URL-bound
  - if probe-state signing is enabled, make sure `PIPELANE_PROBE_STATE_KEY` is set on the machine running the probe and then rerun it
