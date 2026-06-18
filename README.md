# Pipelane

Pipelane is a local release cockpit for AI-assisted coding.

It helps you keep track of branches, worktrees, PRs, review gates, deploys,
rollback, and cleanup when Claude, Codex, or another AI agent is writing code
with you.

AI coding makes it easy to create a lot of work quickly. Pipelane makes that
work easier to find, review, merge, deploy, and clean up without guessing what
state the repo is in.

![Pipelane Board showing branch pipeline state, attention items, and release actions](docs/public/pipelane-board-example.png)

## What Pipelane Does

Pipelane gives a repo:

- slash commands for the normal build and release flow
- isolated task worktrees for new work
- a local web board for seeing branch, PR, deploy, and cleanup state
- review-gate setup and evidence recording
- safe PR, merge, deploy, rollback, and cleanup commands
- an orchestration foundation for running plan slices through worker agents and
  review gates

Pipelane is local-first. Your repo, git history, GitHub, CI, and deploy platform
stay the source of truth.

Pipelane is not:

- an AI model
- a hosted SaaS dashboard
- a replacement for git, GitHub, CI, or your deploy provider
- a project management tool
- a one-command production deploy bot

The simple mental model:

- **Pipelane moves work.** Branch, PR, merge, deploy, rollback, cleanup.
- **Your tests and review tools judge work.** Lint, typecheck, tests, build,
  gstack review, Karpathy diff, Claude/Codex review, human approval.
- **The board shows work.** It makes the next safe action visible.

## Requirements

Hard requirements:

- Node.js `>=22.0.0`
- npm
- git
- a git repo with at least one commit
- a real base branch, usually `main`

Recommended for the full workflow:

- GitHub CLI, `gh`, installed and authenticated
- an `origin` remote with the base branch pushed
- CI checks for your repo
- deploy commands or deploy platform config for staging and production

Optional:

- Claude Code, if you want Claude slash commands
- Codex, if you want Codex skills
- gstack, if you want the review workflows Pipelane is designed to pair with

## Quick Start

From the repo you want to use with Pipelane:

```bash
npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "My App"
```

If `pipelane` is already on your `PATH`, use:

```bash
pipelane bootstrap --yes --project "My App"
```

Then review and commit the generated files.

Use `git status` first:

```bash
git status --short
```

Stage the Pipelane files you accept. A typical repo will include some or all of
these:

```bash
git add .pipelane.json .claude/commands .agents/skills
git add docs/RELEASE_WORKFLOW.md pipelane/CLAUDE.template.md REPO_GUIDANCE.md
git add README.md CONTRIBUTING.md AGENTS.md package.json package-lock.json
git commit -m "Add pipelane workflow"
git push
```

If your repo does not have one of those files, skip that `git add` line or leave
the missing file out.

Commit before using `/new`.

`/new` creates task worktrees from the repo's base branch. If the base branch
does not contain the Pipelane files yet, new worktrees will not inherit the
workflow.

### Machine-Local Install Only

If a repo should not commit Pipelane config or generated adapters, install the
machine-local commands instead:

```bash
pipelane install-codex
pipelane install-claude
```

This writes durable default commands under your local Codex and Claude skill
folders. It does not write Pipelane files into the current repo.

## How to Use It

In a Pipelane-enabled repo, start with:

```text
/pipelane
```

That shows the workflow guide. Most work follows one of two lanes.

## Build Lane

Build mode is the fast lane.

Use it when production already deploys safely after merge, or when you do not
need staging to prove the exact same merged SHA before production moves.

```text
/devmode build
/new
/pipelane review
/pr --title "PR title"
/merge
/clean
```

What each step does:

- `/devmode build` selects the fast lane.
- `/new` creates a fresh task branch and worktree. The task name is optional;
  the AI can infer it from the user's request.
- `/pipelane review` runs configured review gates and records evidence.
- `/pr` enforces fresh review evidence, runs checks, commits, pushes, and opens
  or updates the PR.
- `/merge` merges the PR and records the merged SHA.
- `/clean` removes finished task state after the work is safe to close.

Build mode is good for normal product iteration, small fixes, and repos where
the base branch already has a trusted production deploy path.

## Release Lane

Release mode is the protected lane.

Use it when staging must prove the exact same merged SHA before production is
allowed to move.

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

Release mode adds the staging gate:
1. Merge the PR once.
2. Deploy that merged SHA to staging.
3. Verify staging.
4. Promote that same SHA to production.
5. Verify production.

Release mode is useful for risky changes, database changes, auth, billing,
customer-facing launches, multi-surface deploys, and any moment where "I think
prod has the right thing" is not good enough.

## Helpful Anytime

```text
/pipelane web           Open the local Pipelane Board.
/status                 Show branch, PR, deploy, and release-gate state.
/resume                 Reopen or recover an existing task workspace.
/doctor                 Diagnose deploy config, probes, and release readiness.
/rollback prod          Roll production back to the last verified-good deploy.
/fix                    Fix bugs, review findings, CI failures, and code-quality issues.
/fix rethink            Audit refactor hotspots before changing code.
```

## The Pipelane Board

Open the board with:

```text
/pipelane web
```

Or from a terminal:

```bash
pipelane board
```

The board shows:

- attention items first
- current build or release mode
- branch and worktree state
- PR state
- staging and production deploy state
- cleanup readiness
- branch files and patch previews on demand
- safe actions that map back to Pipelane commands

The board is not a separate source of truth. It reads the repo's public
`pipelane:api` contract and displays what the repo reports.

## Review Gates

Pipelane has a review-gate runner because AI-generated code should not go
straight from "the agent says done" to "merge".

Set up the review stack:

```text
/pipelane review setup
/pipelane review setup --preset lean
/pipelane review setup --preset standard
/pipelane review setup --preset strict-production
/pipelane review setup --print
/pipelane review setup --list-gates
```

Run the review stack:

```text
/pipelane review
```

The gate order is:

1. **Static gates:** lint, typecheck, format check, secret scan, dependency audit.
2. **Behavioral gates:** tests, integration checks, build.
3. **AI diff gates:** `/karpathy diff`, gstack `/review`, adversarial review.
4. **Instruction gates:** `/karpathy audit` when agent instruction files change.
5. **Runtime gates:** browser QA, deploy health checks, staging evidence.
6. **Human gates:** approval for schema, auth, billing, secrets, deploy, rollback,
   and other irreversible work.

Static gates run before AI review. There is no reason to spend model attention
on syntax, type, style, or build errors that deterministic tools can catch.

`/pipelane review` writes evidence for the current branch, HEAD, and worktree
state. `/pr` checks that evidence before it commits, pushes, or opens a PR.

`/pr` blocks when review evidence is:

- missing
- stale
- filtered
- dry-run only
- pending
- failed
- for a different HEAD or worktree state

If `/pr` blocks on review evidence, run:

```text
/pipelane review
/pr
```

## `/fix`

Use `/fix` when a review, test, CI run, QA pass, or user report finds a real
problem.

```text
/fix
```

`/fix` is intentionally strict. It looks for the root cause, checks repo guidance,
scans for sibling bugs, and avoids cheap shims like swallowing errors or adding a
one-off special case without understanding the caller.

Use this when you want the codebase to get healthier, not just quieter.

Use planning-only refactor mode when the code is too tangled to patch safely:

```text
/fix rethink
```

## Orchestration

Pipelane now has an orchestration foundation.

It is not yet a single "do the whole plan for me" button. It is a set of durable
steps for turning a plan into isolated slices, preparing worktrees, dispatching
provider prompts, running workers, and reviewing completed slices.

Current orchestration commands:

```text
/pipelane orchestrate goal-spec --plan-file docs/plan.md
/pipelane orchestrate plan --plan-file docs/plan.md
/pipelane orchestrate prepare --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate dispatch --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate start --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef [--slice-id <id>] [--force]
/pipelane orchestrate review --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef [--slice-id <id>]
```

What those commands do:

- `goal-spec` drafts a provider-neutral goal from a plan or outcome.
- `plan` writes a durable slice ledger.
- `prepare` creates slice worktrees and task locks.
- `dispatch` writes provider handoff prompts for each slice.
- `start` runs configured or native worker commands from each slice worktree.
- `review` runs the run's review-gate snapshot against completed worker slices.

`orchestrate start` can use native defaults when available:

- Codex: `codex exec --full-auto -`
- Claude: `claude --print` plus the best supported non-interactive permission
  mode from `claude --help`

You can override worker launch commands:

```bash
PIPELANE_ORCHESTRATE_WORKER_COMMAND='your-worker-command'
PIPELANE_ORCHESTRATE_CODEX_COMMAND='codex-specific-command'
PIPELANE_ORCHESTRATE_CLAUDE_COMMAND='claude-specific-command'
PIPELANE_ORCHESTRATE_WORKER_TIMEOUT_MS=3600000
```

Orchestration review is conservative:

- slice-filtered review evidence is diagnostic only
- gate-filtered review evidence is diagnostic only
- phase-filtered review evidence is diagnostic only
- dry-run review evidence is diagnostic only
- trusted slice review evidence is bound to the slice worktree HEAD SHA
- the run passes only after every slice has full non-dry-run review evidence

Merge, deploy, rollback, and cleanup still stay outside orchestration. Use the
normal Pipelane release flow after the orchestration run is reviewed.

## What Gets Installed

Pipelane has two command surfaces.

Machine-local commands:

- installed by `pipelane install-codex`
- installed by `pipelane install-claude`
- live under your local Codex and Claude skill directories
- do not require repo changes

Repo-local adapters:

- created by `pipelane bootstrap` or `pipelane setup`
- committed with the repo
- give each repo custom command text, aliases, and workflow docs

Bootstrapping can add or manage:
- `.pipelane.json`
- `.claude/commands/*`
- `.agents/skills/*`
- `pipelane/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`
- Pipelane sections in `README.md`, `CONTRIBUTING.md`, and `AGENTS.md`
- `package.json` scripts named `pipelane:*`
- local `CLAUDE.md` templates for deploy configuration
- `REPO_GUIDANCE.md`

## Configuration and State

Tracked repo policy usually lives in:

- `.pipelane.json`
- `package.json:pipelane`
- generated command adapters
- generated workflow docs
- `REPO_GUIDANCE.md`

Local operator state usually lives in:

- `CLAUDE.md` for local deploy configuration
- the git common-dir, shared across worktrees
- `~/.pipelane/dashboard/*` for board settings

Pipelane tries to fail closed. For example:

- `/new` fails if the repo has no usable base branch unless you intentionally use
  offline mode.
- `/pr` fails if review evidence is missing or stale.
- release-mode `/deploy prod` fails without same-SHA staging evidence.
- `/clean` refuses dirty, too-young, missing-evidence, and unsafe workspaces.

## Terminal Usage

Slash commands are the normal interface inside Claude or Codex.

From a terminal, use `pipelane run`:

```bash
pipelane run status
pipelane run new --task "checkout recovery"
pipelane run review
pipelane run pr --title "Add checkout recovery"
pipelane run merge
pipelane run deploy staging
pipelane run deploy prod
pipelane run clean
```

Open the board from a terminal:

```bash
pipelane board
```

Check for updates:

```bash
pipelane update --check
```

## Command Reference

Common slash commands:

| Command | What it does |
| --- | --- |
| `/pipelane` | Show the workflow guide. |
| `/pipelane web` | Open the local board. |
| `/status` | Show branch, PR, deploy, and release state. |
| `/devmode build` | Use the fast build lane. |
| `/devmode release` | Use the protected release lane. |
| `/new` | Create a task branch and worktree. Task name is optional. |
| `/resume` | Reopen or recover existing task work. |
| `/repo-guard` | Check that the current checkout is safe. |
| `/pipelane review setup` | Configure review-gate presets. |
| `/pipelane review` | Run review gates and record evidence. |
| `/pipelane review pass` | Record a clean manual review gate after running the referenced skill or approval. |
| `/pr` | Run checks, commit, push, and open or update a PR. |
| `/merge` | Merge the PR and record the merged SHA. |
| `/deploy staging` | Deploy the merged SHA to staging. |
| `/deploy prod` | Promote the verified merged SHA to production. |
| `/rollback prod` | Roll production back to the last verified-good deploy. |
| `/clean` | Clean finished or stale task state when safe. |
| `/doctor` | Diagnose deploy config, probes, and release readiness. |
| `/fix` | Fix bugs, failures, and review findings. |
| `/pipelane orchestrate plan` | Compile a plan into a durable slice ledger. |
| `/pipelane orchestrate prepare` | Create slice worktrees. |
| `/pipelane orchestrate dispatch` | Write provider handoff prompts. |
| `/pipelane orchestrate start` | Run or retry slice workers. |
| `/pipelane orchestrate review` | Run review gates over completed slices. |

## Pipelane and gstack

Pipelane and gstack work well together because they have different jobs.

Use gstack to decide whether the plan and code are good:

- product review
- design review
- engineering plan review
- code review
- QA
- investigation
- documentation review

Use Pipelane to move the work:

- task branch
- worktree
- PR
- merge
- deploy
- rollback
- cleanup

The recommended loop is:

```text
/new
plan review with gstack
implement
/pipelane review
/fix if needed
/pr
/merge
/deploy staging and /deploy prod when in release mode
/clean
```

## Troubleshooting

Use `/status` first. It tells you the current lane, active task, branch state,
PR state, release readiness, deploy state, and next safe action.

Common fixes:

| Problem | Command |
| --- | --- |
| Lost task context | `/resume` |
| Unsafe checkout | `/repo-guard` |
| Missing review evidence | `/pipelane review` |
| Review or CI failed | `/fix`, then `/pipelane review`, then `/pr` |
| Release config missing | `/doctor` |
| Staging probe stale | `/doctor --probe` |
| Production regression | `/rollback prod` |
| Old task state | `/clean --status-only`, then scoped cleanup |

## Npm Install Guard

If your task worktrees share `node_modules` through a symlink, raw `npm install`
can damage the shared dependency directory. Pipelane ships an optional guard:

```bash
pipelane install-npm-guard
export PATH="$HOME/.pipelane/bin:$PATH"
pipelane run doctor --check-guard
```

The guard only affects shells where `npm` resolves through
`~/.pipelane/bin/npm`.

## More Detail

- [Full release workflow reference](docs/public/RELEASE_WORKFLOW.md)
- [Orchestration roadmap](docs/public/ORCHESTRATION.md)
- [Pipelane Board reference design](docs/public/PIPELANE_BOARD.md)
- [Pipelane API contract](docs/public/PIPELANE_API.md)
- [Dashboard implementation guide](src/dashboard/README.md)
