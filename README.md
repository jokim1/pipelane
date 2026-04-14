# workflow-kit

`workflow-kit` is a standalone workflow package for repo-native release management.

It is the repo-specific workflow layer that sits underneath your AI tools. Product repos keep a
small tracked workflow contract, local prompts, and thin slash-command adapters. The operator
logic itself lives here, versioned once.

## Why workflow-kit exists

AI-assisted coding is fast. That is the good news and the problem.

If you are a solo builder or a small team using Claude, Codex, or both as your primary operator
layer, you need a workflow that is easy for an AI to follow without improvising unsafe repo
behavior. You want deterministic commands, explicit task workspaces, recoverable state, and a
release flow that is more disciplined than "just ship it."

That is what `workflow-kit` is for.

It gives every repo the same reliable shape:

- repo-native commands as the source of truth
- thin slash adapters for Claude and Codex
- explicit task workspace creation and recovery
- machine-local operator state in `CLAUDE.md`
- a documented split between fast build-mode shipping and protected release-mode promotion

## Why it lives outside product repos

`workflow-kit` is intentionally a separate repo.

That keeps a clean boundary:

- product repos own product code and repo-specific defaults
- `workflow-kit` owns the shared workflow engine, templates, and docs

Without that split, product repos get muddy fast. It becomes unclear which logic is generic,
which is project-specific, and which instructions are safe to carry forward into the next repo.

## Optimized for AI-first builders

This package is designed for AI-first solo builders and small teams. If you are "vibe coding"
with a strong AI operator in the loop, the workflow needs to reduce ambiguity instead of adding
more.

The design choices are deliberate:

- Repo-native commands are the source of truth. The AI can always fall back to `npm run workflow:*`.
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

## Two dev modes

`workflow-kit` has two lanes.

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
npm run workflow:devmode -- build
npm run workflow:new -- --task "task name"
npm run workflow:pr -- --title "PR title"
npm run workflow:merge
npm run workflow:clean
```

Choose build mode when you want the repo to optimize for speed and a short handoff from merge to
production.

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
npm run workflow:devmode -- release
npm run workflow:new -- --task "task name"
npm run workflow:pr -- --title "PR title"
npm run workflow:merge
npm run workflow:deploy -- staging
npm run workflow:deploy -- prod
npm run workflow:clean
```

Choose release mode when the repo needs explicit same-SHA staged promotion and a stricter release
gate.

## Command reference

- `/devmode`: inspect or switch between `build` and `release`.
- `/new`: create a fresh isolated task workspace on a new `codex/<task>-<4hex>` branch.
- `/resume`: recover an existing task workspace by task name when you come back later.
- `/pr`: verify, stage, commit, push, and create or update the current task PR.
- `/merge`: merge the task PR and record the merged SHA for later deploy flow.
- `/deploy`: deploy the merged SHA to `staging` or `prod`.
- `/clean`: inspect workflow state and prune stale task locks when requested.

Canonical repo-native commands:

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

## Use workflow-kit with gstack

You should use both.

`workflow-kit` is not a replacement for gstack. It is the repo-specific workflow layer that works
well alongside gstack.

The boundary is:

- `workflow-kit` owns repo-specific release discipline, task workspaces, and deterministic repo-native commands
- gstack remains recommended for generic higher-level workflows like `review`, `qa`, `plan-eng-review`, `setup-deploy`, documentation, investigation, and standalone Codex workflows

If a repo uses `workflow-kit`, prefer the workflow-kit release flow over generic gstack `/ship`.
That is the key distinction. `/ship` is strong generic automation. `workflow-kit` is the
repo-specific release contract.

The "best of both worlds" loop looks like this:

1. use gstack to plan, review, test, or investigate
2. use `workflow-kit` to start the task workspace with `/new`
3. use `workflow-kit` to prep the PR, merge, and deploy
4. go back to gstack for QA, docs, or follow-up review

That pairing is the recommended setup.

## Install into a new repo

Inside a target repo:

```bash
npm install -D /Users/josephkim/dev/workflow-kit
npx workflow-kit init --project "Next Project"
npm run workflow:setup
```

That adds:

- `.project-workflow.json`
- `.claude/commands/*`
- `workflow/CLAUDE.template.md`
- `docs/RELEASE_WORKFLOW.md`
- workflow sections in `README.md` and `CONTRIBUTING.md`
- canonical `package.json` workflow scripts

## First adoption caveat

Important for first adoption in an existing remote-backed repo:

- run `workflow-kit init`
- review the tracked files
- commit them before using `workflow:new`

`workflow:new` creates new task worktrees from the repo's base branch. The tracked workflow
contract needs to exist there first.

## Repo layout

See [docs/RELEASE_WORKFLOW.md](./docs/RELEASE_WORKFLOW.md) for the full operator contract,
build vs. release user journeys, required tracked files, local-only state, gstack guidance,
troubleshooting, and the exact task workspace flow.
