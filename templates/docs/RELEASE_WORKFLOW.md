# Release Workflow

Last updated: April 13, 2026
Status: canonical maintainer workflow for {{DISPLAY_NAME}}

This document is the full operator guide for this repo's workflow-kit setup.

## Who this is for

`{{DISPLAY_NAME}}` uses `workflow-kit` as its repo-specific workflow layer for AI-first
builders and small teams. The goal is a workflow that Claude, Codex, and human operators can
follow safely without improvising repo behavior.

## Current Status

`{{DISPLAY_NAME}}` uses `workflow-kit` as its shared release-management and task-workspace layer.

- repo-native scripts are the source of truth
- slash wrappers are thin adapters only
- `{{ALIAS_NEW}}` is the canonical task-start command
- `{{ALIAS_RESUME}}` is the recovery command
- `repo-guard` is internal-only

## Supported Operator Surfaces

### Repo-native CLI Surface

- `npm run workflow:setup`
- `npm run workflow:devmode -- ...`
- `npm run workflow:new -- --task "<task-name>"`
- `npm run workflow:resume -- --task "<task-name>"`
- `npm run workflow:pr -- ...`
- `npm run workflow:merge`
- `npm run workflow:release-check`
- `npm run workflow:task-lock -- verify --task "<task-name>"`
- `npm run workflow:deploy -- staging|prod ...`
- `npm run workflow:clean`

### AI-client Slash Surface

This repo exposes the following user-facing slash commands through Claude/Codex adapters:

- `{{ALIAS_DEVMODE}}`
- `{{ALIAS_NEW}}`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_PR}}`
- `{{ALIAS_MERGE}}`
- `{{ALIAS_DEPLOY}}`
- `{{ALIAS_CLEAN}}`

If aliases change in `.project-workflow.json`, rerun `npm run workflow:setup` and reopen Claude/Codex so the new command names are picked up.
Aliases must be unique, and setup fails closed if an alias would overwrite an unrelated command or skill.
Codex resolves aliases per repo at runtime, so the same alias name can map to different workflow commands in different workflow-kit repos on one machine.

## workflow-kit and gstack

Use both.

`workflow-kit` owns the repo-specific workflow contract:

- `{{ALIAS_DEVMODE}}`
- `{{ALIAS_NEW}}`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_PR}}`
- `{{ALIAS_MERGE}}`
- `{{ALIAS_DEPLOY}}`
- `{{ALIAS_CLEAN}}`

gstack is still recommended for:

- `review`
- `qa`
- `plan-eng-review`
- `setup-deploy`
- docs and release follow-up
- investigation and debugging
- standalone Codex flows

This repo should prefer the workflow-kit release flow over generic gstack `/ship`.

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
npm run workflow:resume -- --task "My Task"
```

Fallback listing:

```bash
npm run workflow:resume
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

1. `npm run workflow:devmode -- build`
2. `npm run workflow:new -- --task "<task-name>"`
3. `npm run workflow:pr -- --title "<pr title>"`
4. `npm run workflow:merge`
5. `npm run workflow:clean`

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

1. `npm run workflow:devmode -- release`
2. `npm run workflow:new -- --task "<task-name>"`
3. `npm run workflow:pr -- --title "<pr title>"`
4. `npm run workflow:merge`
5. `npm run workflow:deploy -- staging`
6. `npm run workflow:deploy -- prod`
7. `npm run workflow:clean`

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

## Environment and Surface Names

Environment names:

- `staging`
- `prod`
- `production`

Surfaces:

- `{{SURFACES_CSV}}`

## Cleanup

`workflow:clean` is report-first. Use `--apply` only when you want to prune stale task locks.

## Supporting Files

Tracked:

- `.project-workflow.json`
- `AGENTS.md`
- `.claude/commands/*`
- `workflow/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`

Local-only:

- `CLAUDE.md`

## Required `.project-workflow.json`

This repo tracks `.project-workflow.json` as the workflow contract.

### Optional `syncDocs` opt-outs

By default, `pipelane setup` and `pipelane sync-docs` write every surface:
regenerate `.claude/commands/*.md`, inject marker sections into
`README.md` / `CONTRIBUTING.md` / `AGENTS.md`, create or refresh
`docs/RELEASE_WORKFLOW.md` and `workflow/CLAUDE.template.md`, and ensure
the `workflow:*` / `pipelane:*` scripts in `package.json`.

Consumers that want partial regeneration can opt out per surface by
adding a `syncDocs` block. Every flag defaults to `true`; absent or
`true` = sync that surface, `false` = leave it alone.

```json
{
  "syncDocs": {
    "claudeCommands": true,
    "readmeSection": false,
    "contributingSection": false,
    "agentsSection": false,
    "docsReleaseWorkflow": false,
    "workflowClaudeTemplate": false,
    "packageScripts": true
  }
}
```

| Flag | Controls |
| --- | --- |
| `claudeCommands` | `.claude/commands/*.md` regeneration, including `pipelane.md` and the managed manifest. |
| `readmeSection` | Marker-wrapped `README.md` section. |
| `contributingSection` | Marker-wrapped `CONTRIBUTING.md` section. |
| `agentsSection` | Marker-wrapped `AGENTS.md` section. |
| `docsReleaseWorkflow` | `docs/RELEASE_WORKFLOW.md` file write. |
| `workflowClaudeTemplate` | `workflow/CLAUDE.template.md` file write. |
| `packageScripts` | `workflow:*` + `pipelane:*` script entries in `package.json`. |

Opting out never removes content that a previous sync already wrote; it
just stops future syncs from touching the surface.

## Required `AGENTS.md`

This repo tracks `AGENTS.md` as the repo policy surface for workflow-kit.

## Required local `CLAUDE.md`

`CLAUDE.md` is machine-local and git-ignored. `npm run workflow:setup` creates it if missing.

## What each user must do

### One repo maintainer

1. install `workflow-kit`
2. run `workflow-kit init`
3. review `.project-workflow.json`, especially `aliases`
4. commit the tracked workflow files

### Each Claude user

1. pull the committed workflow files
2. open the repo in Claude
3. reopen or restart Claude if aliases changed or the command files were added while it was already open

### Each Codex user

1. pull the committed workflow files
2. run `npm run workflow:setup`
3. reopen or restart Codex if the new command names do not appear immediately

Codex wrappers are machine-global, so every Codex user must run setup on their own machine. If aliases change later, rerun setup again.

### Each release operator

1. run `npm run workflow:setup`
2. fill local deploy config in `CLAUDE.md`
3. verify with `npm run workflow:release-check`

## Install In A New Repo

```bash
npm install -D /Users/josephkim/dev/workflow-kit
npx workflow-kit init --project "{{DISPLAY_NAME}}"
npm run workflow:setup
```

For first-time adoption in an existing remote-backed repo, commit the tracked workflow files
before using `workflow:new`. New task worktrees are created from `{{BASE_BRANCH}}`, so the
workflow contract needs to exist there first.

## Day-One Operator Journey

1. `npm run workflow:setup`
2. `npm run workflow:devmode -- status`
3. `npm run workflow:new -- --task "<task-name>"`
4. implement and verify
5. `npm run workflow:pr -- --title "<pr title>"`

## Troubleshooting and Common Failures

- missing `.project-workflow.json`
  - run `workflow-kit init`
- task already active
  - use `workflow:resume -- --task "<task-name>"`
- release mode blocked
  - complete local `CLAUDE.md`
