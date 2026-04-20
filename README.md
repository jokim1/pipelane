# Pipelane

> **Pipelane** — the release cockpit for AI vibe coders.

`pipelane` is a standalone workflow package for repo-native release management.

It is the repo-specific workflow layer that sits underneath your AI tools. Product repos keep a
small tracked workflow contract, local prompts, and thin slash-command adapters. The operator
logic itself lives here, versioned once.

## Why Pipelane exists

AI-assisted coding is fast. That is the good news and the problem.

If you are a solo builder or a small team using Claude, Codex, or both as your primary operator
layer, you need a workflow that is easy for an AI to follow without improvising unsafe repo
behavior. You want deterministic commands, explicit task workspaces, recoverable state, and a
release flow that is more disciplined than "just ship it."

That is what Pipelane is for.

It gives every repo the same reliable shape:

- repo-native commands as the source of truth
- thin slash adapters for Claude and Codex
- explicit task workspace creation and recovery
- machine-local operator state in `CLAUDE.md`
- a documented split between fast build-mode shipping and protected release-mode promotion
- a local Pipelane Board dashboard for visual pipeline status (`/pipelane`)

## Why it lives outside product repos

Pipelane is intentionally a separate repo.

That keeps a clean boundary:

- product repos own product code and repo-specific defaults
- Pipelane owns the shared workflow engine, templates, and docs

Without that split, product repos get muddy fast. It becomes unclear which logic is generic,
which is project-specific, and which instructions are safe to carry forward into the next repo.

## Optimized for AI-first builders

This package is designed for AI-first solo builders and small teams. If you are "vibe coding"
with a strong AI operator in the loop, the workflow needs to reduce ambiguity instead of adding
more.

The design choices are deliberate:

- Repo-native commands are the source of truth. The AI can always fall back to `npm run pipelane:*`.
- Slash commands are thin adapters. Claude and Codex do not own the workflow logic.
- Task workspaces are explicit and recoverable. `/new` creates a fresh isolated branch/worktree. `/resume` recovers it later.
- `CLAUDE.md` stays local-only. Machine-specific deploy state does not leak into tracked repo policy.
- Build and release are separate lanes. Fast shipping and protected promotion are both first-class, instead of being mashed together.

This is not about making the workflow fancy. It is about making it legible enough that an AI can
follow it safely and a human can predict what will happen next.

## What it gives you

- repo-native workflow commands
- a canonical task workspace flow with `/new` and `/resume`
- local operator bootstrap via `CLAUDE.md`
- tracked Claude command files
- generic Codex slash wrappers
- a reusable release workflow doc for new maintainers
- a local Pipelane Board reference dashboard for workflow-aware repos

## Pipelane Board

`pipelane` ships a local reference dashboard — the **Pipelane Board** — for repos that expose
a public `pipelane:api` surface.

Run it against a target repo:

```bash
npm run dashboard -- --repo /absolute/path/to/your/repo
```

What it is:

- a development dashboard reference design, not the workflow source of truth
- a thin local adapter over the repo's CLI JSON contract
- an opinionated branch-operations cockpit for triage, deploy handoff, cleanup, and follow-through

What it shows:

- `Attention` and repo-wide release context first
- a kanban-like branch ledger with one active pipeline card per branch
- branch detail with lane reasons, history, row actions, changed files, and lazy patch previews
- action feedback and execution streaming for preflighted workflow actions

Local settings are stored per repo in:

```text
~/.pipelane/dashboard/<repo>-<hash>.json
```

Use the board's Settings button to customize:

- board name
- board subtitle
- preferred port for future launches
- auto-refresh interval

Docs:

- [Pipelane Board reference design](docs/public/PIPELANE_BOARD.md)
- [Dashboard implementation guide](src/dashboard/README.md)

## Alias configuration

The default slash surface is:

- `/devmode`
- `/new`
- `/resume`
- `/pr`
- `/merge`
- `/deploy`
- `/clean`

Those names come from `.pipelane.json` under `aliases`.

If you change them:

- rerun `npm run pipelane:setup`
- each Codex user must rerun setup on their own machine
- if Claude or Codex was already open, reopen the repo or restart the client so the new command names are picked up
- aliases must be unique
- setup fails closed if an alias would overwrite an unrelated Claude command or Codex skill
- Codex resolves aliases per repo at runtime, so different pipelane repos can reuse the same alias name for different commands safely

Repo-native commands do not change. `npm run pipelane:*` stays the fallback and source of truth.

## Two dev modes

`pipelane` has two lanes.

### Build mode

Build mode is the fast lane.

Use it when:

- you want the shortest path from merge to production
- you do not need same-SHA staging promotion
- the repo or project is early enough that speed matters more than staged rollout discipline

In build mode:

- `/merge` is expected to hand off production deploy
- there is no required staging step
- `/deploy prod` is mainly for manual redeploy or recovery

### Release mode

Release mode is the protected lane.

Use it when:

- you need staged validation before prod
- backend or multi-surface coordination matters
- you want the merged SHA promoted through staging and then production in order

In release mode:

- `/devmode release` is fail-closed
- local `CLAUDE.md` must define valid staging and production config
- `/deploy staging` must happen before `/deploy prod` for the same merged SHA

## User journey: build mode

When you want the fastest operator path, the user-facing journey is:

1. `/devmode build`
2. `/new <task-name>`
3. implement and verify
4. `/pr`
5. `/merge`
6. verify production
7. `/clean`

The repo-native equivalents are:

```bash
npm run pipelane:devmode -- build
npm run pipelane:new -- --task "task name"
npm run pipelane:pr -- --title "PR title"
npm run pipelane:merge
npm run pipelane:clean
```

Choose build mode when you want the repo to optimize for speed and a short handoff from merge to
production. 

Once you've set /devmode to build, you don't need to set it again. Once you need production stability,
switch to release mode. Only set devmode back to build if you want to come back later.

## User journey: release mode

When you want a protected staged release path, the user-facing journey is:

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

The repo-native equivalents are:

```bash
npm run pipelane:devmode -- release
npm run pipelane:new -- --task "task name"
npm run pipelane:pr -- --title "PR title"
npm run pipelane:merge
npm run pipelane:deploy -- staging
npm run pipelane:deploy -- prod
npm run pipelane:clean
```

Choose release mode when the repo needs explicit same-SHA staged promotion and a stricter release
gate.

## Command reference

- `/devmode`: inspect or switch between `build` and `release`.
- `/new`: create a fresh isolated task workspace on a new `codex/<task>-<4hex>` branch. The `<task-name>` argument is optional — when omitted, a `task-<hex>` slug is generated automatically so you can spin up an isolated worktree without naming the task up front.
- `/resume`: recover an existing task workspace by task name when you come back later.
- `/pr`: verify, stage, commit, push, and create or update the current task PR.
- `/merge`: merge the task PR and record the merged SHA for later deploy flow.
- `/deploy`: deploy the merged SHA to `staging` or `prod`.
- `/clean`: inspect workflow state and prune stale task locks when requested.

Canonical repo-native commands:

- `npm run pipelane:setup`
- `npm run pipelane:devmode -- ...`
- `npm run pipelane:new -- --task "<task-name>"`
- `npm run pipelane:resume -- --task "<task-name>"`
- `npm run pipelane:pr -- ...`
- `npm run pipelane:merge`
- `npm run pipelane:release-check`
- `npm run pipelane:task-lock -- verify --task "<task-name>"`
- `npm run pipelane:deploy -- staging|prod ...`
- `npm run pipelane:clean`

## Use pipelane with gstack

You should use both.

`pipelane` is not a replacement for gstack. It is the repo-specific workflow layer that works
well alongside gstack.

The boundary is:

- `pipelane` owns repo-specific release discipline, task workspaces, and deterministic repo-native commands
- gstack remains recommended for generic higher-level workflows like `review`, `qa`, `plan-eng-review`, `setup-deploy`, documentation, investigation, and standalone Codex workflows

If a repo uses `pipelane`, prefer the pipelane release flow over generic gstack `/ship`.
That is the key distinction. `/ship` is strong generic automation. `pipelane` is the
repo-specific release contract.

The "best of both worlds" loop looks like this:

1. use gstack to plan, review, test, or investigate
2. use `pipelane` to start the task workspace with `/new`
3. use `pipelane` to prep the PR, merge, and deploy
4. go back to gstack for QA, docs, or follow-up review

That pairing is the recommended setup.

## Install into a new repo

Inside a target repo:

```bash
npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "Next Project"
```

If `pipelane` is already on your `PATH`, the equivalent is:

```bash
pipelane bootstrap --project "Next Project"
```

`bootstrap` installs the repo-local `pipelane` dependency if needed, runs `pipelane init`,
and finishes with `pipelane setup`.

That adds:

- `.pipelane.json`
- `.claude/commands/*`
- `pipelane/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`
- workflow sections in `README.md` and `CONTRIBUTING.md`
- canonical `package.json` workflow scripts

## What users still need to do

There are two setup layers: repo-tracked setup and machine-local setup.

### One repo maintainer does this once

1. Run `pipelane bootstrap --project "Project Name"` or the one-shot `npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "Project Name"` form.
2. Review `.pipelane.json`, especially `aliases`, `prePrChecks`, and deploy defaults.
3. Commit the tracked Pipelane files.

### Every Claude user does this

1. Optional once per machine: run `pipelane install-claude` to install the global `/init-pipelane` bootstrap command.
2. Pull the repo after the tracked Pipelane files are committed.
3. Open the repo in Claude Code.
4. If Claude was already open before the workflow files existed or the aliases changed, reopen the repo or restart the client.

Claude slash commands are still repo-tracked through `.claude/commands/*`. `install-claude` only adds the global `/init-pipelane` bootstrap command for first adoption or repair.

### Every Codex user does this

1. Optional once per machine: run `pipelane install-codex` to install the global `/init-pipelane` bootstrap command.
2. Pull the repo after the tracked Pipelane files are committed.
3. Run `npm run pipelane:setup` inside that repo.
4. If Codex was already open, restart it or reopen the repo.

Codex wrappers are machine-global. Every Codex user must run setup locally on their own machine. If aliases change later, each Codex user must rerun setup.

`/init-pipelane` is only for first adoption or repair in Claude or Codex. Day-to-day workflow commands stay repo-local (`/new`, `/pr`, `/merge`, `/deploy`, and so on).

### Any user who will deploy in release mode does this

1. Run `npm run pipelane:setup` if they have not already.
2. Open local `CLAUDE.md`.
3. Fill in the machine-readable deploy configuration for staging and production.
4. Verify with `npm run pipelane:release-check`.

Without local deploy config, release mode stays fail-closed.

## First adoption caveat

Important for first adoption in an existing remote-backed repo:

- run `pipelane bootstrap` or `pipelane init`
- review the tracked files
- commit them before using `pipelane:new`

`pipelane:new` creates new task worktrees from the repo's base branch. The tracked workflow
contract needs to exist there first.

## Repo layout

See [docs/public/RELEASE_WORKFLOW.md](./docs/public/RELEASE_WORKFLOW.md) for the full operator contract,
build vs. release user journeys, required tracked files, local-only state, gstack guidance,
troubleshooting, and the exact task workspace flow.
