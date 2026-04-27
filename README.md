# Pipelane

> Release pipeline management and safety for AI vibe coders.

AI coding makes it easy to create five branches, three worktrees, two half-open PRs,
and one deployment that nobody is fully sure about.

Pipelane gives a repo a visible release pipeline and a small set of safe actions for
moving work through it. It is built for solo builders and small teams using Claude,
Codex, or both to ship real product code quickly.

Use it when you want:

- every active branch and worktree to be easy to find again
- a clear difference between fast build flow and protected release flow
- staging and production deploys tied to the same merged SHA when safety matters
- smoke checks, release gates, rollback, and cleanup built into the workflow
- a durable `/fix` loop for bugs, review findings, and code-quality repairs

![Pipelane Board showing branch pipeline state, attention items, and release actions](docs/public/pipelane-board-example.png)

## What Pipelane Is

Pipelane is a local, repo-native release workflow layer.

It installs a small workflow contract into your repo, adds slash commands for Claude
and Codex, and ships a local web board for seeing branch, PR, smoke, deploy, and
cleanup state in one place.

Pipelane is not:

- an AI model
- a hosted SaaS dashboard
- a project management board
- a replacement for git, GitHub, CI, or your deploy platform

Pipelane is closer to a release cockpit:

- **Pipeline management:** see what is in flight, recover worktrees, open PRs,
  merge, deploy, and clean up finished work.
- **Release safety:** choose build mode for speed or release mode for staging-first
  promotion of the same merged SHA.
- **Repair discipline:** use `/fix` to turn bugs, CI failures, review comments,
  and code-quality findings into root-cause fixes.

## Start With `/pipelane`

In a Pipelane-enabled repo, run:

```text
/pipelane
```

That prints the workflow guide. The important part is choosing the right lane.

### Build Journey

Build mode is the fast path. Use it when you want the shortest route from branch
to production and do not need required staging validation for the same SHA.

```text
/status                 See what is already in flight.
/devmode build          Use the fast lane.
/new --task "task name" Create a clean task worktree and branch.
/pr --title "PR title"  Run pre-PR checks, commit, push, and open or update the PR.
/merge                  Merge the PR and record the merged SHA.
/smoke prod             Optional: run production-safe smoke checks if configured.
/clean                  Clean up finished task state after production is verified.
```

Build mode is for normal product iteration, small fixes, and repos where production
deploys already happen safely after merge.

### Release Journey

Release mode is the protected path. Use it when staging must prove the exact same
merged SHA before production can move.

```text
/status                 See active tasks, deploy state, and release gates.
/devmode release        Use the protected lane.
/new --task "task name" Create a clean task worktree and branch.
/pr --title "PR title"  Run pre-PR checks, commit, push, and open or update the PR.
/merge                  Merge the PR and record the merged SHA.
/deploy staging         Deploy the merged SHA to staging.
/smoke staging          Run or verify staging smoke checks.
/deploy prod            Promote that same SHA to production.
/smoke prod             Optional: run production-safe smoke checks.
/clean                  Clean up finished task state after production is verified.
```

Release mode is for risky changes, multi-surface deploys, customer-facing launches,
database or edge changes, or any moment where "I think prod has the right thing"
is not good enough.

### Helpful Anytime

```text
/pipelane web           Open the local Pipelane Board.
/status                 Render a terminal cockpit from the same API as the board.
/resume                 Reopen or recover an existing task workspace.
/doctor                 Diagnose deploy config, probes, and release readiness.
/rollback prod          Roll production back to the last verified-good deploy.
/fix                    Fix bugs, review findings, CI failures, and code-quality issues.
/fix rethink            Audit refactor hotspots and plan a restructure before changing code.
```

## The Pipelane Board

`/pipelane web` opens a local web board for the current repo.

The board is useful when AI-generated work is happening in parallel and the state
is hard to hold in your head. It shows:

- attention items first
- current dev mode and release gate status
- staging and production smoke state
- one active pipeline card per branch
- branch files, workspace files, and patch previews on demand
- preflighted actions for deploy, cleanup, and other workflow steps

The board is local-first. It reads the repo's public `pipelane:api` contract and
does not become the source of truth. Git, GitHub, CI, and Pipelane state remain the
source of truth.

## Why Build Mode And Release Mode Both Exist

Fast development and safe release are different jobs.

Build mode keeps the loop short:

- make a branch
- open a PR
- merge
- let the normal production path take over
- clean up

Release mode adds a gate:

- merge once
- deploy that merged SHA to staging
- run smoke checks
- promote that same SHA to production
- verify production

The point is not ceremony. The point is knowing exactly which code is in which
environment, especially when AI operators are producing many branches at once.

## Where `/fix` Fits

Pipelane also installs `/fix`, because release safety is not only deploy order.
It is also bug quality and code quality.

`/fix` is for findings from:

- human review
- PR comments
- CI failures
- `/smoke`
- `/qa` or other test runs
- pasted errors
- code-quality reviews

The command is deliberately strict. It asks for the root cause, checks
`REPO_GUIDANCE.md` for repo-specific invariants, scans for sibling bugs, and refuses
cheap shims like swallowing errors or adding one-off special cases without explaining
the caller that produced the bad state.

`/fix rethink` is the planning-only audit mode for code that has accumulated
features faster than its original boundaries can hold. It ranks refactor
hotspots using repo evidence such as recent churn, large or over-broad modules,
duplicated sibling patterns, and stressed API/schema/CLI/UI boundaries before it
proposes a migration path.

Use `/fix` when you want the codebase to get healthier, not just quieter.

## What Gets Installed

Pipelane has two command surfaces:

- machine-local durable defaults installed by `pipelane install-codex` and
  `pipelane install-claude`
- repo-local generated adapters from `pipelane bootstrap`/`pipelane setup` for
  custom aliases and rich per-repo command text

The machine-local surface installs default `/new`, `/status`, `/pipelane`,
`/pipelane-fix`, and related commands under `~/.codex/skills` and
`~/.claude/skills`. It is the no-commit path for repos that intentionally ignore
generated Pipelane adapters.

Bootstrapping Pipelane into a repo adds or manages:

- `.pipelane.json`, or `.project-workflow.json` if you want a tool-neutral name
- `.claude/commands/*` for repo-tracked Claude slash commands
- `.agents/skills/*` for repo-tracked Codex skills
- `pipelane/CLAUDE.template.md` for machine-local operator config
- `docs/RELEASE_WORKFLOW.md` for the repo's operator guide
- Pipelane sections in `README.md`, `CONTRIBUTING.md`, and `AGENTS.md`
- canonical repo-native scripts in `package.json` behind the slash commands
- local `CLAUDE.md` for each release operator's private deploy config
- `REPO_GUIDANCE.md`, used by `/fix` to preserve repo-specific rules

## Install

Start from a repo that already has git, a base branch, and at least one commit.
The default safe `/new` flow branches from `origin/<base>`, so a pushed `origin`
remote is recommended.

```bash
npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "My App"
```

If `pipelane` is already on your `PATH`, use:

```bash
pipelane bootstrap --yes --project "My App"
```

Then review and commit the tracked files:

```bash
git add .pipelane.json .claude/commands .agents/skills README.md CONTRIBUTING.md AGENTS.md docs/RELEASE_WORKFLOW.md pipelane/CLAUDE.template.md REPO_GUIDANCE.md package.json package-lock.json
git commit -m "Add pipelane workflow"
git push
```

Why commit before using `/new`?

`/new` creates task worktrees from the repo's base branch. If the base branch does
not contain the Pipelane files yet, new worktrees will not inherit the workflow.

For a repo that must not commit Pipelane adapters or config, do not run
`bootstrap`/`init-pipelane`. Install the machine-local defaults instead:

```bash
pipelane install-codex
pipelane install-claude
```

Those commands install durable default slash commands without writing to the
current repo. `/init-pipelane` is still available when you intentionally want to
attach a repo; it prompts before writing `.pipelane.json`, `.claude/`,
`.agents/`, package scripts, docs, or other generated files.

To guard raw npm installs in worktrees whose `node_modules` is a symlink:

```bash
pipelane install-npm-guard
export PATH="$HOME/.pipelane/bin:$PATH"
pipelane run doctor --check-guard
```

The npm guard is opt-in, does not edit shell profiles, and only protects shells
where `npm` resolves through `~/.pipelane/bin/npm`.

## Requirements

Hard requirements:

- Node.js `>=22.0.0`
- npm
- git
- a target repo on disk
- a real base branch, usually `main`

For PR, merge, deploy, and release flow:

- GitHub CLI (`gh`) installed and authenticated
- an `origin` remote with the base branch pushed
- deploy workflow config for staging and production
- release readiness passing before release mode is considered ready

Optional:

- Claude Code, if you want `.claude/commands/*`
- Codex, if you want `.agents/skills/*`

Pipelane fails closed when the repo is not ready. For example, `/new` fails in a
repo with no commits or no usable remote unless you intentionally choose offline
mode. `/deploy prod` in release mode is blocked until staging evidence exists for
the same SHA and surface set.

## Command Reference

User-facing slash commands:

- `/pipelane`: show the build/release journey overview
- `/pipelane web`: open the local Pipelane Board
- `/status`: show branch, PR, deploy, smoke, and release-gate state
- `/devmode`: inspect or switch between `build` and `release`
- `/new`: create a fresh isolated task workspace
- `/resume`: recover an existing task workspace
- `/repo-guard`: verify the checkout is safe for task work
- `/pr`: run checks, push, and create or update a PR
- `/merge`: merge the PR and record the merged SHA
- `/deploy`: deploy the merged SHA to `staging` or `prod`
- `/smoke`: plan smoke coverage or run smoke against `staging` or `prod`
- `/fix`: apply durable root-cause fixes from findings
- `/clean`: close verified task workspaces when safe and prune stale task locks
- `/doctor`: inspect deploy configuration and live probes
- `/rollback`: roll back the most recent verified-good deploy

Slash commands are the normal human/AI interface. Repo-native scripts are the
stable implementation layer underneath them, but workflow guidance should point
operators at `/status`, `/new`, `/pr`, `/merge`, `/deploy`, `/smoke`, and the
other slash commands above.

## Use Pipelane With Gstack

Pipelane and gstack are complementary. Use gstack as the review stack. Use Pipelane
as the release stack.

That split keeps the workflow easy to reason about:

- **gstack reviews the work:** planning, architecture, implementation risk, code
  review, QA, investigation, design review, and documentation review.
- **Pipelane moves the work:** task branches, worktrees, PR prep, merge, deploy
  flow, smoke checks, rollback, cleanup, and release gates.

In other words, gstack helps you answer "is this the right change, and is it good
enough?" Pipelane helps you answer "where is this change, what environment has it,
and what action is safe next?"

If a repo uses Pipelane, prefer Pipelane for branch, PR, merge, deploy, smoke,
rollback, and cleanup flow. Use gstack around that flow to make the plan and code
better before Pipelane moves it forward.

### Full Build Journey With Gstack Reviews

This is the normal fast path for a solo builder or small team using AI to ship
product changes quickly. The important idea is that the user, the AI agent,
gstack, and Pipelane each have a clear job.

```text
User: Add checkout recovery emails for abandoned carts.
```

The user starts with a task description in plain English. It does not need to be
a perfect spec. The AI agent can turn it into an implementation plan.

```text
/status
/devmode build
/new --task "add checkout recovery emails"
```

Pipelane creates the task workspace. `/status` shows what is already in flight,
`/devmode build` selects the fast lane, and `/new` creates a clean task branch and
worktree so the AI agent is not mixing unrelated work.

```text
AI: Proposed plan:
- add recovery-email settings
- create abandoned-cart query
- add email copy and unsubscribe handling
- add tests for timing, opt-out, and duplicate-send prevention
```

The AI returns a plan before implementation. That is where gstack starts helping.
For user-facing changes, review the UX and product shape first:

```text
/plan-design-review
```

gstack's design plan review checks whether the user experience, copy, hierarchy,
states, and interaction model make sense before code exists. If you think of this
as "design-plan-review", the actual command name is `/plan-design-review`.

Then review the engineering plan:

```text
/plan-eng-review
```

gstack's engineering plan review checks architecture, data flow, edge cases, test
coverage, performance, and operational risk before the AI agent starts coding.
This catches bad structure while it is still cheap to change.

```text
User: Looks good. Implement the revised plan.
```

Now the AI builds inside the Pipelane task worktree.

```text
AI: Implementation complete.
Changed:
- checkout recovery settings
- abandoned-cart detection
- email scheduling
- tests

Checks:
- unit tests pass
- typecheck passes

Open risk:
- email provider sandbox credentials need staging verification
```

After the AI implementation returns, use Pipelane's repair loop for any failures,
bugs, review findings, or code-quality issues:

```text
/fix
```

`/fix` is part of Pipelane because release safety includes code health. It turns
failures and findings into root-cause fixes instead of hiding symptoms.

When the branch is ready for a PR, let Pipelane prepare it:

```text
/pr
```

`/pr` runs the repo's configured pre-PR checks, commits, pushes, and opens or
updates the PR. Then use the review stack again:

```text
/review
```

gstack `/review` is the pre-landing review pass. It looks at the diff before merge
and tries to catch structural issues, safety problems, and code-quality regressions.
If it finds something real, keep the loop simple:

```text
/fix
/pr
/review
```

Fix the finding, update the PR, and review again until the code is clean enough to
land.

For Codex users who want a Claude review pass from inside Codex, you can also add
the standalone [`/claude review` skill](https://github.com/jokim1/codexskill-claude-review):

```text
git clone https://github.com/jokim1/codexskill-claude-review.git ~/.codex/skills/claude
chmod +x ~/.codex/skills/claude/scripts/*.sh
```

After restarting Codex, use:

```text
/claude review
/claude review code
/claude review plan
/claude review iterate
/claude review pr <number>
```

This is useful when `/review` is not available or is blocked in your current
Codex/gstack setup, or when you want a second model to review the plan or code.
The recommended role split is simple: Claude reviews, Codex fixes, and Pipelane
moves the release forward.

Once review is clean, return to Pipelane:

```text
/merge
/smoke prod
/clean
```

In build mode, `/merge` lands the PR and records the merged SHA. If production
deploys automatically from the base branch, `/smoke prod` verifies the live app
after deploy. `/clean` removes finished task state so the next AI session starts
from a clean cockpit.

The full build journey looks long when written out, but the responsibilities are
simple: the user describes the work, gstack improves the plan and reviews the
diff, the AI implements and fixes, and Pipelane moves the change through branch,
PR, merge, smoke, and cleanup.

### Release Journey With Gstack Reviews

Use the same review stack in release mode, but let Pipelane enforce the staging
gate before production:

```text
User: Replace the billing webhook handler.
/status
/devmode release
/new --task "replace billing webhook handler"
/plan-design-review
/plan-eng-review
AI: Implementation returns.
/pr
/review
/fix
/pr
/merge
/deploy staging
/smoke staging
/deploy prod
/smoke prod
/clean
```

The review stack still asks whether the plan and code are good. The release stack
now adds the operational guarantee: staging and production are tied to the same
merged SHA, with smoke evidence before promotion.

## More Detail

- [Full release workflow reference](docs/public/RELEASE_WORKFLOW.md)
- [Pipelane Board reference design](docs/public/PIPELANE_BOARD.md)
- [Pipelane API contract](docs/public/PIPELANE_API.md)
- [Dashboard implementation guide](src/dashboard/README.md)
