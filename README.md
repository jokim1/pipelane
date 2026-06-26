# Pipelane

**Rocketboard: a vibe coding orchestrator and release manager.**

Pipelane is a local-first command layer and web cockpit for teams building with
AI agents. It turns AI-assisted work into an auditable flow: plan the work,
slice it, run agents in isolated worktrees, review the output, open a PR, merge,
deploy, verify, roll back when needed, and clean up only when it is safe.

The package and command namespace are still `pipelane`. The product direction is
Rocketboard: the operator view for vibe coding at scale.

![Pipelane Board showing branch pipeline state, attention items, and release actions](docs/public/pipelane-board-example.png)

## Why This Exists

AI-assisted coding changes the bottleneck. The hard part is no longer typing the
code. The hard part is defining what "correct" means, checking probabilistic
output, and moving many AI-generated changes through review and release without
losing track of state.

Pipelane is built around a simple progression:

```text
PROMPT -> PLAN -> BUILD -> EVAL -> RELEASE -> LOOP
```

The philosophy:

- Prompting is useful, but it is not enough. Good inputs reduce variance; they
  do not eliminate it.
- A plan defines correctness before the build starts. Pipelane can turn that
  plan into typed `GoalSpec` prompts, slices, worktrees, and review gates.
- An eval is only real when it produces evidence: changed files, test output,
  review results, skipped checks, deploy probes, and blockers.
- Release is a discipline layer, not a button. Production moves only when the
  right SHA, surfaces, probes, and approvals line up.
- Autonomy should be auditable. The goal is not unlimited agent freedom; the
  goal is loops whose actions, evidence, and handoffs survive context loss.

Pipelane lives mainly in Phase 3 and Phase 4 of this model: production-safe
evals, release gates, autonomous loops, and an evidence ledger that makes the
work inspectable. The same structure also prepares the repo for later
self-improvement: captured lessons, reusable skills, and machine-readable
invariants.

## What Pipelane Owns

Pipelane coordinates the repo-native workflow around AI-generated work:

- orchestration with `/pipelane orchestrate`
- review gates with `/pipelane review`
- task branches and isolated worktrees with `/new` and `/resume`
- PR preparation and enforcement with `/pr`
- merge handoff with `/merge`
- safe deploys with `/deploy staging` and `/deploy prod`
- release diagnostics with `/doctor`
- rollback with `/rollback`
- cleanup with `/clean`
- visual operations with `/pipelane web`

Pipelane does **not** replace your model, tests, GitHub, CI, deploy provider, or
human release judgment. It makes those systems visible, ordered, and harder to
skip accidentally.

## The Four Core Workflows

### 1. `/pipelane orchestrate`

`/pipelane orchestrate` is the execution layer above normal AI coding. It reads
an implementation plan, compiles it into slices, gives each slice a worktree and
handoff prompt, runs worker agents, reviews the slices, and records a durable
ledger of evidence.

Bare orchestration runs the main phases in one approved pass:

```text
/pipelane orchestrate --plan-file docs/plan.md --provider codex --yes
```

That command currently performs:

1. `plan`: compile the plan into a durable slice ledger.
2. `prepare`: create task worktrees and locks for slices.
3. `dispatch`: write provider handoff prompts.
4. `start`: run configured or native worker commands.
5. `review`: run the configured review-gate snapshot over completed slices.
6. bounded review-fix attempts for failed executable gates.

The advanced commands are available when you want step-by-step control:

```text
/pipelane orchestrate goal-spec --plan-file docs/plan.md
/pipelane orchestrate plan --plan-file docs/plan.md
/pipelane orchestrate prepare --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate dispatch --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate start --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef [--slice-id <id>] [--force]
/pipelane orchestrate review --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef [--slice-id <id>]
```

The mental model is compiler plus runner:

```text
plan -> slices -> worktrees -> workers -> review gates -> evidence ledger -> PR
```

Important boundaries:

- Orchestration stops before PR creation, merge, deploy, and cleanup.
- Slice review evidence must be full, fresh, non-dry-run evidence for the slice
  worktree HEAD.
- Filtered review evidence is diagnostic only.
- Remaining failed, pending, or blocked slice reviews keep the orchestration
  active and return a non-zero exit code.
- The normal Pipelane release flow still owns `/pr`, `/merge`, `/deploy`, and
  `/clean`.

Native worker defaults are used when available:

- Codex: `codex exec --full-auto -`
- Claude: `claude --print` with the best supported non-interactive permission
  mode

You can override worker launch commands:

```bash
PIPELANE_ORCHESTRATE_WORKER_COMMAND='your-worker-command'
PIPELANE_ORCHESTRATE_CODEX_COMMAND='codex-specific-command'
PIPELANE_ORCHESTRATE_CLAUDE_COMMAND='claude-specific-command'
PIPELANE_ORCHESTRATE_WORKER_TIMEOUT_MS=3600000
```

### 2. `/deploy` and Safe Release

Pipelane supports two development modes.

Build mode is the fast lane. Use it when production deploys safely after merge,
or when you do not need staging to prove the exact merged SHA before production
moves.

```text
/devmode build
/new
/pipelane review
/pr --title "PR title"
/merge
/clean
```

Release mode is the protected lane. Use it when staging must verify the exact
merged SHA before production can move.

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

Safe release means:

- The PR is reviewed before `/pr` can commit, push, or open the PR.
- `/merge` records the merged SHA.
- `/deploy staging` deploys and verifies that SHA in a non-production
  environment.
- `/deploy prod` promotes the same verified SHA to production.
- Deploy records are signed and bound to the expected surfaces.
- Health checks and configured verification commands produce release evidence.
- Production deploys and rollback require explicit confirmation.
- `/rollback prod` provides the recovery path when production regresses.

Release-mode `/deploy prod` fails closed when same-SHA staging evidence is
missing, stale, or for the wrong surface set. Pipelane currently knows managed
surfaces such as `frontend`, `edge`, and `sql`, and it supports additional
configured surfaces.

Useful release commands:

```text
/devmode status
/devmode release
/deploy staging
/deploy prod
/doctor
/doctor --probe
/rollback prod
```

Run `pipelane configure` before the first release-mode deploy in a newly
onboarded repo. Deploy configuration is local by default and normally lives in
the operator's `CLAUDE.md` deploy configuration block.

### 3. `/pipelane review`

`/pipelane review` is the quality gate between "the agent says done" and "this
work is allowed to move." It is based on a core belief from vibe coding:
probabilistic output needs structured, decorrelated review.

The review philosophy:

- Deterministic checks go first. Do not spend model attention on failures that
  lint, typecheck, tests, format checks, secret scans, dependency audits, or the
  build can reject.
- The author should not be the independent reviewer. `/karpathy diff` is useful
  author self-review, but independent AI review must come from a separate
  reviewer context.
- Different blind spots matter more than repeated reviews. Stack machine
  checks, fresh-context review, and cross-model review.
- Review evidence must be bound to the branch, HEAD SHA, and worktree state.
- High-stakes paths need stronger gates: auth, billing, migrations, secrets,
  SQL, deploy, rollback, and production-impacting changes.
- Human approval stays explicit for irreversible decisions.

Set up the review stack:

```text
/pipelane review setup
/pipelane review setup --yes
/pipelane review setup --print
/pipelane review setup --list-gates
```

Run the review stack:

```text
/pipelane review
```

The canonical gate order is:

1. Static gates: lint, typecheck, format check, secret scan, dependency audit.
2. Behavioral gates: tests, integration checks, build.
3. AI diff gates: `/karpathy diff`, fresh-context review, gstack `/review`,
   cross-model review when installed.
4. Instruction gates: `/karpathy audit` when agent instruction files change.
5. Runtime gates: browser QA, deploy health checks, staging evidence.
6. Human gates: approval for schema, auth, billing, secrets, deploy, rollback,
   and other irreversible work.

`/pr` enforces this evidence. It blocks when review evidence is missing, stale,
filtered, dry-run only, pending, failed, or recorded for a different HEAD or
worktree state.

If review or CI finds a real problem, use:

```text
/fix
/pipelane review
/pr
```

`/fix` is intentionally root-cause oriented. It should explain the failure,
check repo guidance, scan for sibling bugs, fix the underlying issue, and rerun
the relevant checks.

### 4. `/pipelane web`

`/pipelane web` opens the local Rocketboard/Pipelane Board. It is the visual
view over the same repo contract used by `/status`.

```text
/pipelane web
```

Or from a terminal:

```bash
pipelane board
```

The web view currently shows:

- attention items first
- current build or release mode
- branch and worktree state
- PR state
- staging and production deploy state
- release readiness
- cleanup readiness
- branch files and patch previews on demand
- preflighted actions that map back to Pipelane commands

The board is not a separate source of truth. It reads the repo's public
`pipelane:api` contract and renders what the repo reports.

The next Rocketboard direction is orchestration visibility: active runs, slices,
worktrees, gate status, blocked reviews, and evidence links from the
orchestration ledger. The ledger and orchestration commands exist today; the
full visual orchestration panel is the coming web layer.

## Quick Start

Install the machine-local commands first:

```bash
npx -y pipelane@github:jokim1/pipelane#main install-codex
npx -y pipelane@github:jokim1/pipelane#main install-claude
```

If `pipelane` is already on your `PATH`, use:

```bash
pipelane install-codex
pipelane install-claude
```

This writes durable commands under your local Codex and Claude skill folders. It
does not write Pipelane files into the current repo.

Then open a repo and run:

```text
/pipelane setup
/pipelane review setup
/status
/pipelane web
```

For a first release-mode deploy:

```bash
pipelane configure
```

If your task worktrees share `node_modules` through a symlink, install the local
npm guard:

```bash
pipelane install-npm-guard
export PATH="$HOME/.pipelane/bin:$PATH"
```

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
- CI checks for the repo
- deploy commands or deploy platform config for staging and production

Optional:

- Claude Code, if you want Claude slash commands
- Codex, if you want Codex skills and worker execution
- gstack, if you want the broader plan, review, QA, and release workflows

## Working in This Repo

Install dependencies:

```bash
npm install
```

Useful development commands:

```bash
npm test
npm run typecheck
npm run build
npm run smoke
npm run board
```

Run the CLI directly while developing:

```bash
node ./src/cli.ts --help
node ./src/cli.ts run status
node ./src/cli.ts board --repo /absolute/path/to/target/repo
```

The package entrypoint is `bin/pipelane`. Source lives under `src/operator` for
workflow commands and `src/dashboard` for the local web board.

## Terminal Usage

Slash commands are the normal interface inside Claude or Codex. From a
terminal, use `pipelane run`:

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

Open the board:

```bash
pipelane board
```

Check for updates:

```bash
pipelane update --check
```

## Command Reference

| Command | What it does |
| --- | --- |
| `/pipelane` | Show the workflow guide. |
| `/pipelane setup` | Set up Pipelane for the current repo. |
| `/pipelane web` | Open the local Rocketboard/Pipelane Board. |
| `/status` | Show branch, PR, deploy, and release state. |
| `/devmode build` | Use the fast build lane. |
| `/devmode release` | Use the protected release lane. |
| `/new` | Create a task branch and isolated worktree. |
| `/resume` | Reopen or recover existing task work. |
| `/repo-guard` | Check that the current checkout is safe. |
| `/pipelane review setup` | Select review gates. |
| `/pipelane review` | Run review gates and record evidence. |
| `/pipelane review pass` | Record a clean manual review gate after running the referenced review or approval. |
| `/pipelane orchestrate --plan-file docs/plan.md --yes` | Run plan, prepare, dispatch, start, review, and bounded review-fix attempts. |
| `/pipelane orchestrate goal-spec` | Draft a provider-neutral `GoalSpec` from a plan or outcome. |
| `/pipelane orchestrate plan` | Compile a plan into a durable slice ledger. |
| `/pipelane orchestrate prepare` | Create slice worktrees. |
| `/pipelane orchestrate dispatch` | Write provider handoff prompts. |
| `/pipelane orchestrate start` | Run or retry slice workers. |
| `/pipelane orchestrate review` | Run review gates over completed slices. |
| `/pr` | Run checks, enforce review evidence, commit, push, and open or update a PR. |
| `/merge` | Merge the PR and record the merged SHA. |
| `/deploy staging` | Deploy the merged SHA to staging. |
| `/deploy prod` | Promote the verified merged SHA to production. |
| `/rollback prod` | Roll production back to the last verified-good deploy. |
| `/clean` | Clean finished or stale task state when safe. |
| `/doctor` | Diagnose deploy config, probes, and release readiness. |
| `/fix` | Fix bugs, failures, and review findings. |

## What Gets Installed

Pipelane has two command surfaces.

Machine-local commands are the default install path:

- installed by `pipelane install-codex`
- installed by `pipelane install-claude`
- live under your local Codex and Claude skill directories
- do not require repo changes

Repo-local adapters are legacy opt-in surfaces:

- created only by repos that explicitly enable generated surfaces
- committed with the repo
- useful when a repo needs custom command text, aliases, or workflow docs

Those legacy repo-local surfaces can add or manage:

- `.pipelane.json`
- `.claude/commands/*`
- `.agents/skills/*`
- `pipelane/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`
- Pipelane sections in `README.md`, `CONTRIBUTING.md`, and `AGENTS.md`
- `package.json` scripts named `pipelane:*`
- local `CLAUDE.md` templates for deploy configuration
- `REPO_GUIDANCE.md`

## State and Safety

Tracked repo policy usually lives in:

- `.pipelane.json`
- `package.json:pipelane`
- generated command adapters
- generated workflow docs
- `REPO_GUIDANCE.md`

Machine-local and operator state usually lives in:

- `CLAUDE.md` for local deploy configuration
- the git common-dir, shared across worktrees
- `~/.pipelane/dashboard/*` for board settings

Pipelane tries to fail closed:

- `/new` fails if the repo has no usable base branch unless offline mode is
  intentional.
- `/pr` fails if review evidence is missing or stale.
- release-mode `/deploy prod` fails without same-SHA staging evidence.
- `/clean` refuses dirty, too-young, missing-evidence, and unsafe workspaces.

## Pipelane and gstack

Pipelane and gstack are designed to work together.

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
- orchestration ledger
- review evidence
- PR
- merge
- deploy
- rollback
- cleanup

The recommended loop:

```text
/new
plan review with gstack
implement or /pipelane orchestrate
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

| Problem | Command |
| --- | --- |
| Lost task context | `/resume` |
| Unsafe checkout | `/repo-guard` |
| Missing review evidence | `/pipelane review` |
| Review or CI failed | `/fix`, then `/pipelane review`, then `/pr` |
| Release config missing | `pipelane configure` |
| Staging probe stale | `/doctor --probe` |
| Production regression | `/rollback prod` |
| Old task state | `/clean --status-only`, then scoped cleanup |

## More Detail

- [Release workflow reference](docs/public/RELEASE_WORKFLOW.md)
- [Orchestration reference](docs/public/ORCHESTRATION.md)
- [Pipelane Board reference](docs/public/PIPELANE_BOARD.md)
- [Pipelane API reference](docs/public/PIPELANE_API.md)
