# Pipelane

> **Pipelane** is the repo-native release cockpit for AI-first builders.

`pipelane` is a standalone npm package for deterministic task workspaces, PR handoff,
merge discipline, deploy flow, and cleanup. It is meant for repos where Claude, Codex,
or both are doing a meaningful amount of the day-to-day operating.

The short version:

- product repos keep a small tracked workflow contract
- humans and AI both use the same repo-native commands
- task work happens in explicit git worktrees
- build mode and release mode are separate, deliberate lanes
- release state stays legible instead of living in tribal knowledge

## What Pipelane Actually Is

Pipelane is not:

- an AI model
- a hosted SaaS control plane
- a project management board
- a replacement for your editor, CI provider, or deployment platform

Pipelane is:

- a shared workflow engine that lives outside any one product repo
- a repo-local contract that gets installed into product repos
- a thin command layer that Claude and Codex can follow without improvising
- a release workflow that is stricter than "just merge and hope"

In a pipelane-enabled repo, the normal source of truth is the repo-native command surface:

```bash
npm run pipelane:devmode -- ...
npm run pipelane:new -- --task "task name"
npm run pipelane:pr -- --title "PR title"
npm run pipelane:merge
npm run pipelane:deploy -- staging
npm run pipelane:deploy -- prod
npm run pipelane:clean
```

Claude and Codex wrappers exist to make those commands easier to invoke, not to replace them.

## Why It Lives Outside Product Repos

Pipelane is intentionally its own repo.

That split keeps the boundary clean:

- product repos own product code, repo defaults, and deploy specifics
- Pipelane owns the reusable workflow engine, templates, and docs

Without that separation, product repos accumulate half-generic workflow logic, stale prompts,
and local setup instructions that are hard to reuse safely.

## What You Get In A Pipelane-Enabled Repo

Bootstrapping Pipelane into a repo adds or manages:

- `.pipelane.json` for tracked workflow config
- `.claude/commands/*` for repo-tracked Claude commands
- `pipelane/CLAUDE.template.md` for machine-local operator config
- `docs/RELEASE_WORKFLOW.md` for the repo's operator guide
- a Pipelane section in `README.md`
- a Pipelane section in `CONTRIBUTING.md`
- canonical `npm run pipelane:*` scripts in `package.json`
- machine-local `CLAUDE.md` when the local operator runs setup
- machine-local Codex wrappers under the user's `CODEX_HOME`

## The Pipelane Website / Board

Pipelane ships a local web UI called the **Pipelane Board**.

This is the "Pipelane website" most users will interact with. It is not a hosted control panel.
It is a local operator cockpit that reads the repo's `pipelane:api` snapshot and gives you a
visual view of the workflow state.

Use it for:

- seeing repo-wide attention items first
- scanning the current branch pipeline at a glance
- inspecting a branch's lane, history, and changed files
- running preflighted workflow actions from a visual interface
- keeping a local branch/release cockpit open while you work

It is not:

- the workflow source of truth
- a replacement for git or GitHub
- a planning board for product tasks
- a hosted dashboard for your whole team

In a pipelane-enabled consumer repo, the normal entry point is:

```bash
npm run pipelane:board
```

When working on the Pipelane package itself, you can point the dashboard at another repo:

```bash
npm run dashboard -- --repo /absolute/path/to/your/repo
```

The board shows:

- `Attention` and repo-wide release context first
- one active pipeline card per branch
- lane reasons and status history
- row actions and board-level actions
- lazy patch previews and execution feedback

Local board settings live at:

```text
~/.pipelane/dashboard/<repo>-<hash>.json
```

More detail:

- [Pipelane Board reference design](docs/public/PIPELANE_BOARD.md)
- [Dashboard implementation guide](src/dashboard/README.md)
- [Pipelane API contract](docs/public/PIPELANE_API.md)

## Requirements

Pipelane does not require a giant platform dependency stack, but it is not literally zero-dependency.
If you want the full workflow to work end to end, you need to understand the prerequisites clearly.

### Hard requirements for installation

- Node.js `>=22.0.0`
- npm
- filesystem access to the target repo

### Hard requirements for normal day-to-day workflow

- git installed
- a target repo on disk
- a real base branch, usually `main`
- at least one commit on that base branch before you start creating task worktrees
- an `origin` remote with the base branch pushed if you want the default safe `/new` flow

Why the remote matters:

- `/new` branches from `origin/<base-branch>` by default, not from a guessed local state
- if `origin/main` cannot be refreshed, `/new` fails closed and tells you to rerun with `--offline`

### Hard requirements for PR, merge, and deploy flow

- GitHub CLI (`gh`) installed and authenticated for the target repo

Why:

- `pipelane:pr` pushes to `origin` and creates or edits a PR through `gh`
- `pipelane:merge` merges the PR through `gh`
- `pipelane:deploy` dispatches and tracks deploy workflow activity through `gh`

### Optional environment integrations

- Claude Code if you want repo-tracked `.claude/commands/*`
- Codex if you want machine-local slash wrappers

### Release-mode-only requirements

- each release operator must have a local `CLAUDE.md`
- that local `CLAUDE.md` must include valid staging and production deploy config
- `npm run pipelane:release-check` must pass before release mode is considered ready

### What "Works Out Of The Box" Means In Practice

`bootstrap` can scaffold an empty directory and install the repo-local dependency. That part works.

What does **not** work automatically unless the repo is actually ready:

- `/new` in a non-git directory
- `/new` in a git repo with no commits
- `/new` in a repo with no `origin` remote unless you intentionally use `--offline`
- `/pr`, `/merge`, or `/deploy` without a working GitHub CLI setup
- release mode without local deploy configuration

That fail-closed behavior is intentional. Pipelane favors explicit requirements over silent guesses.

## Detailed Install Journey

This section is the exact user journey for adopting Pipelane in a repo.

### Step 1: Start From A Repo That Is Actually Ready

If you already have a remote-backed git repo with a base branch and at least one commit, use that.

If you are starting from scratch, do this first:

```bash
mkdir my-app
cd my-app
git init -b main
npm init -y
git add package.json
git commit -m "Initial commit"
git remote add origin git@github.com:you/my-app.git
git push -u origin main
```

Pipelane can scaffold before this point, but the normal task workflow starts making sense only after
the repo has a real git base to branch from.

### Step 2: Bootstrap Pipelane Into The Repo

Inside the target repo:

```bash
npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "My App"
```

If `pipelane` is already on your `PATH`, the equivalent is:

```bash
pipelane bootstrap --project "My App"
```

What `bootstrap` does:

1. installs the repo-local `pipelane` dependency if needed
2. runs `pipelane init`
3. runs `pipelane setup`
4. creates local `CLAUDE.md` if it does not exist yet
5. installs Codex wrappers on the current machine
6. prints readiness warnings if the repo is not actually ready for `/new`

### Step 3: Review What Bootstrap Added

After bootstrap, you should expect to see:

- `.pipelane.json`
- `.claude/commands/*`
- `pipelane/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`
- Pipelane sections in `README.md` and `CONTRIBUTING.md`
- `pipelane:*` scripts in `package.json`
- local `CLAUDE.md`

### Step 4: Commit The Tracked Pipelane Files

Do this before using `/new` in a normal remote-backed repo:

```bash
git add .pipelane.json .claude/commands README.md CONTRIBUTING.md docs/RELEASE_WORKFLOW.md pipelane/CLAUDE.template.md package.json package-lock.json
git commit -m "Add pipelane workflow"
git push
```

Why this matters:

- `/new` creates task worktrees from the repo's base branch
- if the base branch does not contain the tracked Pipelane files yet, new task worktrees will not inherit the workflow contract

### Step 5: Each User Finishes Their Local Setup

#### Every Claude user

1. pull the repo after the tracked files are committed
2. optionally run `pipelane install-claude` once per machine if they want the global `/init-pipelane` bootstrap command
3. open the repo in Claude Code
4. reopen Claude if it was already open before the repo gained Pipelane files or aliases changed

#### Every Codex user

1. pull the repo after the tracked files are committed
2. optionally run `pipelane install-codex` once per machine if they want the global `/init-pipelane` bootstrap command
3. run `npm run pipelane:setup` inside the repo on that machine
4. reopen Codex if it was already open

Why Codex needs a local step:

- Codex wrappers are machine-global
- every Codex user must install or refresh them locally
- if aliases change later, each Codex user must rerun setup

## Detailed User Journey: Build Mode

Build mode is the fast lane. Use it when you want the shortest path from merge to production and you
do not need a required staging promotion step for the same SHA.

### Build mode requirements

Before starting a build-mode task, make sure:

- the repo is already bootstrapped with Pipelane
- the tracked Pipelane files are committed on the base branch
- your local machine has already run `npm run pipelane:setup`
- the repo has a working `origin` remote unless you intentionally plan to use `--offline`
- `gh` is installed and authenticated if you plan to use `/pr` and `/merge`

### Step 1: Confirm Or Switch To Build Mode

Slash command:

```text
/devmode build
```

Repo-native equivalent:

```bash
npm run pipelane:devmode -- build
```

What this does:

- records that the repo is currently operating in the fast lane
- tells later commands that production deploy is the normal post-merge path
- removes the release-lane staging requirement for this task flow

### Step 2: Create A Task Workspace

Slash command:

```text
/new my-task
```

Repo-native equivalent:

```bash
npm run pipelane:new -- --task "my-task"
```

What this does:

- refreshes `origin/<base-branch>` by default
- creates a new `codex/<task>-<hex>` branch
- creates a separate git worktree for the task
- records the task lock so the repo can recover it later with `/resume`

Important:

- if the repo has no `origin` remote, this step fails closed by default
- if you knowingly want to branch from local `main`, rerun with `--offline`

### Step 3: Implement And Verify

Do the actual work inside the task worktree.

Before opening the PR, make sure the repo's configured pre-PR checks are healthy. By default those are:

- `npm run test`
- `npm run typecheck`
- `npm run build`

The exact checks come from `.pipelane.json`.

### Step 4: Open Or Update The PR

Slash command:

```text
/pr
```

Repo-native equivalent:

```bash
npm run pipelane:pr -- --title "Add feature X"
```

What this does:

- runs the configured pre-PR checks
- stages and commits dirty changes if needed
- pushes the branch to `origin`
- creates or updates the pull request through `gh`
- records the PR state for later merge and deploy flow

If the worktree is dirty and this is a brand-new PR, pass `--title`.

### Step 5: Merge The PR

Slash command:

```text
/merge
```

Repo-native equivalent:

```bash
npm run pipelane:merge
```

What this does:

- waits for PR checks
- merges through `gh`
- records the merged SHA
- in build mode, may dispatch production deploy immediately if the repo config has auto-deploy-on-merge enabled

### Step 6: Verify Production

Two cases exist in build mode:

- if the repo auto-deploys on merge, verify that production is healthy
- if the repo does not auto-deploy on merge, deploy manually:

```bash
npm run pipelane:deploy -- prod
```

Then verify the production result.

### Step 7: Clean Up

Slash command:

```text
/clean
```

Repo-native equivalent:

```bash
npm run pipelane:clean
```

Use this after production is verified and the task is truly done.

## Detailed User Journey: Release Mode

Release mode is the protected lane. Use it when you want the merged SHA promoted through staging and
then production in order, with a fail-closed gate around release readiness.

### Release mode requirements

Before starting a release-mode task, make sure:

- everything in the build-mode requirements is already true
- local `CLAUDE.md` has valid staging and production deploy configuration
- `npm run pipelane:release-check` passes

Release mode is intentionally stricter than build mode.

### Step 0: Prepare Release Operator Configuration

If you have not done it on this machine yet:

```bash
npm run pipelane:setup
```

Then open local `CLAUDE.md`, fill in the deploy configuration block, and verify readiness:

```bash
npm run pipelane:release-check
```

Until this is configured correctly, release mode stays fail-closed.

### Step 1: Confirm Or Switch To Release Mode

Slash command:

```text
/devmode release
```

Repo-native equivalent:

```bash
npm run pipelane:devmode -- release
```

What this does:

- records that the repo is now using the protected lane
- enforces release readiness instead of assuming it
- makes staging promotion part of the normal path

### Step 2: Create A Task Workspace

Use the same task-start flow as build mode:

```bash
npm run pipelane:new -- --task "my-task"
```

This still expects a valid git base and usually an `origin` remote.

### Step 3: Implement And Verify

Do the work in the task worktree and make sure the configured checks pass before PR creation.

### Step 4: Open Or Update The PR

```bash
npm run pipelane:pr -- --title "Add feature X"
```

In release mode, PR creation also checks that release readiness is satisfied unless an explicit
override has been recorded.

### Step 5: Merge The PR

```bash
npm run pipelane:merge
```

After merge, Pipelane records the merged SHA and expects the next step to be staging promotion.

### Step 6: Deploy That Merged SHA To Staging

Slash command:

```text
/deploy staging
```

Repo-native equivalent:

```bash
npm run pipelane:deploy -- staging
```

What this does:

- resolves the merged SHA for the task
- dispatches the deploy workflow
- records staging deploy state
- expects the staging verification to succeed before prod is allowed

### Step 7: Verify Staging

Do not skip this. In release mode, the entire point is that staging validates the same merged SHA
before production.

### Step 8: Promote The Same SHA To Production

Slash command:

```text
/deploy prod
```

Repo-native equivalent:

```bash
npm run pipelane:deploy -- prod
```

Prod deploy is blocked unless Pipelane can prove there is a qualifying staging success for the same
task, same SHA, and same surfaces.

### Step 9: Verify Production

Confirm that the production deployment is healthy and complete.

### Step 10: Clean Up

```bash
npm run pipelane:clean
```

Run cleanup only after the release is truly complete.

## Alias Configuration

The default slash aliases are:

- `/devmode`
- `/new`
- `/resume`
- `/pr`
- `/merge`
- `/deploy`
- `/clean`
- `/status`
- `/doctor`
- `/rollback`

Those names come from `.pipelane.json` under `aliases`.

If you change aliases:

- rerun `npm run pipelane:setup`
- every Codex user must rerun setup on their own machine
- reopen Claude or Codex if it was already open
- keep aliases unique

Pipelane fails closed if an alias would overwrite an unrelated Claude command or Codex skill.

## Command Reference

- `/devmode`: inspect or switch between `build` and `release`
- `/new`: create a fresh isolated task workspace
- `/resume`: recover an existing task workspace
- `/repo-guard`: verify the checkout is safe for task work
- `/pr`: run checks, push, and create or update a PR
- `/merge`: merge the PR and record the merged SHA
- `/deploy`: deploy the merged SHA to `staging` or `prod`
- `/clean`: inspect cleanup status and prune stale task locks
- `/status`: render a terminal cockpit of repo workflow state
- `/doctor`: inspect deploy configuration and live probes
- `/rollback`: roll back the most recent verified-good deploy

Canonical repo-native commands:

- `npm run pipelane:setup`
- `npm run pipelane:configure`
- `npm run pipelane:devmode -- ...`
- `npm run pipelane:new -- --task "<task-name>"`
- `npm run pipelane:resume -- --task "<task-name>"`
- `npm run pipelane:repo-guard`
- `npm run pipelane:pr -- ...`
- `npm run pipelane:merge`
- `npm run pipelane:release-check`
- `npm run pipelane:deploy -- staging|prod`
- `npm run pipelane:clean`
- `npm run pipelane:status`
- `npm run pipelane:doctor`
- `npm run pipelane:rollback`
- `npm run pipelane:board`

## Use Pipelane With Gstack

You should generally use both.

The boundary is:

- `pipelane` owns repo-specific task workspaces, PR/merge/deploy flow, and release discipline
- gstack remains useful for generic planning, review, QA, investigation, documentation, and broader AI workflows

If a repo uses Pipelane, prefer the Pipelane release flow over generic gstack `/ship`.

## More Detail

If you want the deeper operator contract, read:

- [Full release workflow reference](docs/public/RELEASE_WORKFLOW.md)
- [Pipelane Board reference design](docs/public/PIPELANE_BOARD.md)
- [Pipelane API contract](docs/public/PIPELANE_API.md)
