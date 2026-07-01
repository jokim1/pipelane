# Pipelane

**Pipelane is a vibe coding orchestrator and release manager.**

AI agents can now produce code faster than teams can review, merge, deploy, and
recover from it. Pipelane is the operating layer around that work: it turns a
plan into agent-executed slices, forces evidence-producing review, moves the
approved change through release, and gives you a cockpit for seeing what is safe
to do next.

Pipelane is local-first. Your repo, GitHub, CI, and deploy provider stay the
source of truth. Pipelane coordinates them so AI-generated work does not become
a pile of branches, half-reviewed diffs, uncertain deploys, and forgotten
cleanup.

![Pipelane Board showing branch pipeline state, attention items, and release actions](docs/public/pipelane-board-example.png)

## The Big Idea

Vibe coding is not just "ask an AI to write code." That is the first step. The
real leverage comes when the whole development loop becomes structured:

```text
PLAN -> BUILD -> EVAL -> RELEASE -> LOOP
```

Pipelane exists because AI output is probabilistic. A better prompt helps, but
it does not make the result deterministic. The durable answer is a system:

- define the goal before building
- break the work into reviewable slices
- run agents in isolated workspaces
- evaluate their output with evidence, not vibes
- require independent review before PR handoff
- promote only verified changes through release
- make status, blockers, and rollback visible

The goal is **auditable autonomy**: let agents do more of the inner loop, while
Pipelane records what happened and keeps release safety intact.

## What Pipelane Does

Pipelane gives an AI-assisted codebase four things:

1. **Orchestration**: turn a plan into agent work, slice by slice.
2. **Review gates**: convert "looks good" into evidence that can block a PR.
3. **Safe release**: move verified changes through build or release mode.
4. **Operator visibility**: show branches, PRs, deploys, blockers, and cleanup
   in one local web view.

Pipelane is not an AI model, a hosted project-management app, or a replacement
for your existing CI and deploy systems. It is the release-management layer that
makes AI coding operational.

## Core Workflows

### 1. `/orchestrate`

`/orchestrate` is the main vibe-coding workflow.

You give Pipelane a plan. Pipelane turns it into implementation slices, assigns
safe workspaces, runs agent loops, records evidence, and returns reviewed work
ready for the normal PR and release path.

Use it when a task is bigger than one obvious edit:

- multi-file features
- refactors with clear acceptance criteria
- migrations across repeated patterns
- work that benefits from parallel agent slices
- anything where you want an audit trail of what each agent did

The important product behavior is simple:

```text
/orchestrate
```

Pipelane handles the lower-level slice planning, worker handoff, review loop,
and ledger details. Those internals exist for recovery and debugging, but they
are not the user journey.

### 2. `/deploy` and Safe Release

AI coding increases throughput, so release discipline matters more, not less.
Pipelane separates day-to-day build flow from protected release flow.

Build mode is for repos where production already deploys safely after merge:

```text
/orchestrate
/pipelane review
/pr
/merge
```

Release mode is for changes that must prove the exact merged SHA in staging
before production moves:

```text
/orchestrate
/pipelane review
/pr
/merge
/deploy staging
/deploy prod
```

Safe release means:

- review evidence exists before PR handoff
- the merged SHA is recorded
- staging verifies the same SHA that production will receive
- deploys are tied to the expected surfaces
- health checks and verification commands produce evidence
- production promotion is explicit
- rollback remains a first-class path

Use release mode for auth, billing, migrations, data access, customer-visible
launches, multi-surface changes, and anything where "probably deployed" is not
good enough.

### 3. `/pipelane review`

`/pipelane review` is Pipelane's answer to the biggest risk in AI coding:
untrusted output moving too far because it looked plausible.

The philosophy is decorrelated review:

- deterministic checks first: lint, typecheck, tests, build, secret checks
- behavioral evidence next: does the app or workflow actually behave correctly
- independent AI review after that: not the same context that wrote the code
- cross-model or specialist review when the risk is high
- human approval for irreversible decisions

This is the key difference between an eyeball pass and a real eval: a real eval
emits evidence that another tool can enforce later.

Inspect the review model, then persist any intentional changes:

```text
/pipelane review setup
/pipelane review setup --toggle C3
```

Then run it before PR handoff:

```text
/pipelane review
```

`/pr` checks that the evidence is fresh, complete, and bound to the current
branch and HEAD. If review fails, fix the root cause and run review again.

### 4. `/pipelane web`

`/pipelane web` opens the local Pipelane Board.

The board is the visual cockpit for orchestration and release management. It
shows the state Pipelane already knows:

- what needs attention
- which mode the repo is in
- active branches and worktrees
- PR state
- review and release readiness
- staging and production deploy state
- cleanup readiness
- safe next actions

```text
/pipelane web
```

The board is not a second source of truth. It reads the repo's Pipelane API and
shows what the repo reports. The direction is to make orchestration status
visible here too: active runs, slices, blockers, review state, and evidence.

## Why This Matters

Without a system, AI coding fails in predictable ways:

- success feels random because "correct" was never defined
- review happens only when someone remembers to do it
- branches accumulate faster than they can be reconciled
- deploys happen without confidence about what SHA reached which environment
- rollback is improvised under pressure
- context disappears when the agent session ends

Pipelane turns those failure modes into explicit workflow state. It does not
make the AI deterministic. It wraps the AI in a process that can be checked,
replayed, blocked, resumed, and released.

## Quick Start

Install the local command surface:

```bash
npx -y pipelane@github:jokim1/pipelane#main install-codex
npx -y pipelane@github:jokim1/pipelane#main install-claude
```

Set up a repo:

```text
/pipelane setup
/pipelane review setup
/pipelane review setup --reset
/pipelane web
```

For release-mode deploys, configure deploy targets and health checks:

```bash
pipelane configure
```

Then move work through the normal handoff. In build mode, stop after `/merge`
when production deploys from the base branch automatically; in release mode,
continue through staging and production:

```text
/orchestrate
/pipelane review
/pr
/merge
/deploy staging
/deploy prod
/pipelane web
```

## Requirements

- Node.js `>=22.0.0`
- npm
- git
- a repo with a real base branch
- GitHub CLI authenticated for the full PR workflow
- CI and deploy commands for the release workflow

Optional but recommended:

- Codex or Claude Code for agent execution
- gstack for deeper plan, review, QA, and release review workflows

## For Contributors

Install dependencies:

```bash
npm install
```

Run the main checks:

```bash
npm test
npm run typecheck
npm run build
```

Run the local board while developing:

```bash
npm run board
```

Source layout:

- `src/operator`: workflow commands and release logic
- `src/dashboard`: local Pipelane Board
- `docs/public`: deeper workflow references
- `templates`: generated repo guidance and command surfaces

## More Detail

- [Release workflow reference](docs/public/RELEASE_WORKFLOW.md)
- [Orchestration reference](docs/public/ORCHESTRATION.md)
- [Pipelane Board reference](docs/public/PIPELANE_BOARD.md)
- [Pipelane API reference](docs/public/PIPELANE_API.md)
