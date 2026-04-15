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
- `/new` is the canonical task-start command
- `/resume` is the recovery command
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

- `/devmode`
- `/new`
- `/resume`
- `/pr`
- `/merge`
- `/deploy`
- `/clean`

## workflow-kit and gstack

Use both.

`workflow-kit` owns the repo-specific workflow contract:

- `/devmode`
- `/new`
- `/resume`
- `/pr`
- `/merge`
- `/deploy`
- `/clean`

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

`/new` is the canonical task-start command.

Properties:

- creates a fresh `codex/<task>-<4hex>` branch
- creates a sibling worktree under `../{{TASK_WORKTREE_DIR_NAME}}/`
- refreshes `origin/{{BASE_BRANCH}}` first
- inherits the current dev mode
- fails closed if the task already exists and points to `/resume`
- `--task "<task-name>"` is optional; when omitted, `/new` generates a `task-<hex>` slug automatically

`/resume` is the recovery path, not the normal happy path.

Properties:

- resolves by task slug, not branch id
- returns the saved workspace and mode
- does not create a workspace
- redirects back to `/new` if the saved workspace is gone
- lists active tasks when called without `--task`

The chat/workspace does not move automatically. Switch into the reported path before editing.

## `/new` behavior

Typical result:

```text
Continue this task in: ../{{TASK_WORKTREE_DIR_NAME}}/my-task-ab12
Task: My Task
Slug: my-task
Branch: codex/my-task-ab12
Mode: build
Chat has not moved. Switch this chat/workspace to that path before editing.
```

## `/resume` behavior

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

1. `/devmode build`
2. `/new <task-name>`
3. `/pr`
4. `/merge`
5. `/clean`

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

1. `/devmode release`
2. `/new <task-name>`
3. `/pr`
4. `/merge`
5. `/deploy staging`
6. `/deploy prod`
7. `/clean`

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

## Required `AGENTS.md`

This repo tracks `AGENTS.md` as the repo policy surface for workflow-kit.

## Required local `CLAUDE.md`

`CLAUDE.md` is machine-local and git-ignored. `npm run workflow:setup` creates it if missing.

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
