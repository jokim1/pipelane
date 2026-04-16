# Release Workflow

Last updated: April 13, 2026
Status: canonical shared workflow spec

This document is the full maintainer and operator guide for repositories that use
`workflow-kit`.

It is intentionally more detailed than the README. The README answers "what is this, who is it
for, and how do the two lanes work?" This document answers "how does this workflow actually work,
end to end, and what should the operator do in each case?"

## Who this is for

`workflow-kit` is designed for AI-first builders: solo maintainers and small teams using Claude,
Codex, or both as their primary operator layer.

The workflow assumes:

- the AI should be able to follow explicit repo-native commands without guessing
- the repo should distinguish fast shipping from protected release promotion
- task work should be isolated, recoverable, and easy to resume later
- local machine-specific deploy state should not be mixed into tracked repo policy

If that is how you work, this package is for you.

## Current Status

`workflow-kit` provides a standalone, versioned workflow package that product repos consume.

- Product repos keep the tracked workflow contract and prompts.
- `workflow-kit` owns the operator logic and bootstrap behavior.
- The canonical task flow is `/new` -> `/resume` -> `/pr` -> `/merge` -> `/deploy` -> `/clean`.
- `repo-guard` remains an internal guardrail rather than the main human entrypoint.

## Supported Operator Surfaces

`workflow-kit` supports two operator surfaces.

### Repo-native CLI surface

This is the source of truth:

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

### AI-client slash surface

The slash surface is intentionally thin.

- Claude uses tracked `.claude/commands/*`.
- Codex uses generic machine-global wrapper skills installed by `workflow-kit install-codex`.
- Both adapter layers dispatch back to the repo-native `npm run workflow:*` scripts.

There is no workflow logic inside the slash wrappers.

### Local Branch Pipeline Board

`workflow-kit` also ships a local dashboard reference design:

```bash
npm run dashboard -- --repo /absolute/path/to/your/repo
```

This is intentionally an adapter over the repo's public `workflow:api` contract, not a second
workflow source of truth.

Use it when you want:

- an operator view of every branch moving through `Local -> PR -> Base -> Staging -> Production`
- contextual action preflight and execution feedback without memorizing every command
- branch detail with lane reasons, history, file lists, and lazy patch previews
- a stronger, opinionated development cockpit for AI-first release operations

The dashboard stays local-only. Its settings live in a per-repo JSON file under
`~/.workflow-kit/dashboard/`, and the board can be customized from its Settings drawer.

## workflow-kit and gstack

Use both.

`workflow-kit` is the repo-specific workflow layer. gstack remains the generic higher-level
workflow layer.

`workflow-kit` owns:

- `/devmode`
- `/new`
- `/resume`
- `/pr`
- `/merge`
- `/deploy`
- `/clean`
- task workspace state
- release discipline and same-SHA promotion rules

gstack is still recommended for:

- `review`
- `qa`
- `plan-eng-review`
- `setup-deploy`
- documentation flows
- investigations and debugging
- standalone Codex workflows

The important line is that `workflow-kit` intentionally does not rely on generic gstack `/ship`
for release management. If a repo uses `workflow-kit`, prefer the workflow-kit PR, merge, and
deploy flow over `/ship`.

## Task Workspace Flow

`/new` is the canonical task-start command.

Properties:

- `/new` always creates a fresh isolated sibling worktree
- `/new` always creates a new `codex/<task>-<4hex>` branch
- `/new` refreshes `origin/<base>` first and fails closed unless `--offline` is explicitly passed
- `/new` inherits the current dev mode and requested surfaces
- `/new` refuses to start the same task twice and redirects to `/resume`
- `/new` accepts an optional `--task "<task-name>"`; when omitted, it generates a `task-<hex>` slug so an isolated worktree can be spun up without naming the task up front

`/resume` is the recovery path, not the normal happy path.

Properties:

- `/resume --task "<task-name>"` resolves by task name slug, not branch id
- `/resume` never creates a workspace
- `/resume` returns the saved branch, worktree path, mode, and next action
- `/resume` heals stale locks and redirects back to `/new` if the saved workspace is gone
- `/resume` with no args lists active task workspaces and tells the operator what to resume

The chat or IDE workspace does not move automatically. Command output must say that clearly.

## `/new` behavior

Typical result:

```text
Continue this task in: ../my-project-worktrees/my-task-ab12
Task: My Task
Slug: my-task
Branch: codex/my-task-ab12
Mode: build
Chat has not moved. Switch this chat/workspace to that path before editing.
```

`/new` is the happy path. Use it unless you are explicitly returning to existing work.

## `/resume` behavior

If one task is active, `/resume` may return that task directly. If several are active,
`/resume` without `--task` lists them:

```text
Active task workspaces:
- project-api: codex/project-api-4fd2 @ ../my-project-worktrees/project-api-4fd2
- billing-cleanup: codex/billing-cleanup-a912 @ ../my-project-worktrees/billing-cleanup-a912
Next: run workflow:resume -- --task "<task-name>"
```

This keeps `/resume` rare in the happy path while still making recovery simple.

## Build vs Release user journeys

Both dev modes use the same command surface, but they mean different things.

### Build mode user journey

Build mode is the fast lane.

Use it when:

- you want the shortest path from merge to production
- no staging promotion step is required
- the repo is optimized for speed over staged rollout discipline

User-facing slash journey:

1. `/devmode build`
2. `/new <task-name>`
3. implement and verify
4. `/pr`
5. `/merge`
6. verify production
7. `/clean`

Repo-native journey:

1. `npm run workflow:devmode -- build`
2. `npm run workflow:new -- --task "<task-name>"`
3. implement and verify
4. `npm run workflow:pr -- --title "<pr title>"`
5. `npm run workflow:merge`
6. verify production
7. `npm run workflow:clean`

### Release mode user journey

Release mode is the protected lane.

Use it when:

- staging must validate the release before prod
- backend or multi-surface work needs stricter discipline
- the same merged SHA should move through staging and then production in order

User-facing slash journey:

1. `/devmode release`
2. `/new <task-name>`
3. implement and verify
4. `/pr`
5. `/merge`
6. `/deploy staging`
7. verify staging
8. `/deploy prod`
9. verify production
10. `/clean`

Repo-native journey:

1. `npm run workflow:devmode -- release`
2. `npm run workflow:new -- --task "<task-name>"`
3. implement and verify
4. `npm run workflow:pr -- --title "<pr title>"`
5. `npm run workflow:merge`
6. `npm run workflow:deploy -- staging`
7. verify staging
8. `npm run workflow:deploy -- prod`
9. verify production
10. `npm run workflow:clean`

## Build Mode

Build mode is the fast lane.

- use it when the repo wants the shortest path from PR merge to production
- no staging promotion step is required
- production deploy is expected to happen automatically after merge if the repo is configured that way

Advanced build-mode deploy usage still exists:

- `npm run workflow:deploy -- prod`
- `npm run workflow:deploy -- prod edge`
- `npm run workflow:deploy -- prod sql`

Those are manual or recovery paths, not the normal happy path.

## Release Mode

Release mode is the protected lane.

- it is fail-closed
- staging must be configured before the repo switches to release mode
- the same merged SHA must go through staging before production promotion

Release mode keeps staging and production tied to the same merged SHA. That is the whole point.

## Release Readiness Gate

Release mode is gated by local `CLAUDE.md`.

`workflow-kit` expects a machine-readable `## Deploy Configuration` block in local
`CLAUDE.md`. It does not track this file in git.

The gate checks:

- configured production and staging deploy info for relevant surfaces
- staging readiness flags
- distinct staging and production frontend URLs
- deploy orchestration metadata needed to make release mode safe

If the gate fails:

- mode stays `build`
- blocked surfaces are reported explicitly
- the operator is pointed at `npm run workflow:setup`

## Environment and Surface Names

Environment names:

- `staging`
- `prod`
- `production` as an alias for `prod`

Surface names in v1:

- `frontend`
- `edge`
- `sql`

Consumer repos can choose which subset they actually use.

## Cleanup

`workflow:clean` is report-first.

It shows:

- current active task locks
- stale task locks
- the next safe cleanup action

With `--apply`, it prunes stale task locks. It does not blindly delete dirty worktrees.

## Supporting Files

Tracked files:

- `.project-workflow.json`
- `AGENTS.md`
- `.claude/commands/*`
- `workflow/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`

Local-only file:

- `CLAUDE.md`

## Required `.project-workflow.json`

Each consumer repo must track `.project-workflow.json`.

Required fields:

- `projectKey`
- `displayName`
- `baseBranch`
- `stateDir`
- `taskWorktreeDirName`
- `surfaces`
- `aliases`
- `prePrChecks`
- `deployWorkflowName`
- `buildMode`
- `releaseMode`

## Required `AGENTS.md`

`AGENTS.md` carries the tracked repo policy.

At minimum it should define:

- `/new` as the task-start command
- `/resume` as the recovery command
- `repo-guard` as an internal guardrail
- task-lock verification before mutating release steps
- the supported slash and repo-native command surfaces

## Required local `CLAUDE.md`

`CLAUDE.md` is local-only operator state.

It should contain:

- local operator defaults
- skill routing rules
- deploy configuration JSON

`workflow-kit setup` creates it from `workflow/CLAUDE.template.md` if it does not already exist.

## Install In A New Repo

Inside the target repo:

```bash
npm install -D /Users/josephkim/dev/workflow-kit
npx workflow-kit init --project "Next Project"
npm run workflow:setup
```

That creates the tracked workflow contract and local machine-specific operator file.

For first-time adoption in an existing remote-backed repo, commit the tracked workflow files
before using `workflow:new`. New task worktrees are created from the repo base branch, so the
workflow contract needs to be present there first.

## Day-One Operator Journey

For a new workflow-kit repo consumer:

1. install the package
2. run `workflow-kit init`
3. review `.project-workflow.json`
4. run `npm run workflow:setup`
5. check `npm run workflow:devmode -- status`
6. start work with `npm run workflow:new -- --task "<task-name>"`

## Troubleshooting

Common failures:

- `No .project-workflow.json found`
  - run `workflow-kit init` in the repo root
- `/new` generated a `task-<hex>` slug you did not expect
  - you ran `/new` without `--task`; pass `--task "<label>"` explicitly to choose a human-readable slug
- `Task X is already active`
  - use `workflow:resume -- --task "X"`
- `Release mode blocked`
  - run `npm run workflow:setup` and fill in local `CLAUDE.md`
- `No active task lock matches this branch/worktree`
  - you are not in the saved task workspace, or the task should be resumed by name
