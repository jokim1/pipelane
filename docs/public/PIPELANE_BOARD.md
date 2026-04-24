# Pipelane Board

The Pipelane Board is the web cockpit of **Pipelane**, the release pipeline
management and safety system for AI vibe coders. It is an opinionated reference
design for a local workflow dashboard.

It is meant to make AI-first developers more effective at running a branch-based release workflow
without forcing product repos to ship a first-party dashboard.

## Positioning

The board is:

- local-first
- developer-facing
- intentionally opinionated
- an adapter over a repo's public `pipelane:api` contract

The board is **not**:

- the workflow source of truth
- a project management board
- a replacement for repo-native `npm run pipelane:*` commands
- a place to re-infer state from git internals, `gh` output, or private files

## Design principles

This reference design deliberately optimizes for operator clarity over generic dashboard tropes.

1. Attention first
   Surface blockers, degraded sources, and release readiness before the branch ledger.

2. One active card per branch
   A branch should appear as a single active card in the lane it is currently working through.
   The board should not render a filled card in every lane.

3. Frozen branch context
   Keep the branch column sticky so the operator can retain branch identity while horizontally
   scanning the release pipeline.

4. Explicit actions
   Actions should be buttons or contextual menu items that map directly to workflow preflight and
   execute calls. Avoid drag-and-drop as the primary model because it hides confirmation and
   preconditions.

5. Truth over guesswork
   If the repo reports `degraded` or `unknown`, render that literally. Do not translate degraded
   remote state into false claims like "no PR" or "merge first."

6. Details on demand
   Branch file lists and patch previews should be lazy. The main snapshot stays lean; details load
   only when the operator clicks into a branch.

7. Contextual help
The `?` guide should stay close to the board and mirror the `/pipelane` overview: build
journey, release journey, helpful anytime commands, `/fix`, and web commands.

## Current information architecture

The reference board is structured in this order:

1. Hero
2. Attention
3. Board Context
4. Branch Ledger
5. Help drawer
6. Branch Detail drawer

### Hero

Shows the board identity, repo health, mode, base branch, freshness, Settings, Refresh, and the
`?` guide.

### Help drawer

Shows the quick Pipelane guide:

- build journey slash commands
- release journey slash commands
- helpful anytime commands
- `/fix` and `/fix rethink`
- `/pipelane web`, `/pipelane status`, and `/pipelane update --check`

The drawer renders configured aliases from the repo when available, falling back to the default
slash command names only when alias config cannot be loaded.

### Attention

Shows the highest-signal blockers and warnings from `snapshot.data.attention`.
The board keeps the API payload intact, but renders related probe alerts as one
plain-language card with a single next command. Attention cards should answer:
what is wrong, why it matters, and what command to run next.

### Board Context

Shows:

- current checkout context
- release readiness
- dev mode switcher
- repository cleanup actions
- most recent action feedback

### Branch Ledger

The ledger behaves like a release kanban:

- columns are the canonical lane order from `boardContext.laneOrder`
- only one active pipeline card is shown for each branch
- the left branch column stays sticky
- right-clicking a card reveals contextual branch actions

### Branch Detail drawer

The drawer opens over the board, not as a permanent side column.

It includes:

- lane reasons
- history
- row actions
- committed branch files
- live workspace files
- lazy patch preview
- cleanup state
- snapshot diagnostics

## State and color language

The board uses workflow states directly, with an opinionated visual language:

- `healthy`: green
- `running`: blue
- `awaiting_preflight`: teal
- `stale`: amber
- `degraded`: orange
- `blocked` / `failed`: red
- `unknown` / `bypassed`: slate
- `ready to clean`: gold
- active action lock: steel/slate with `Executing`

The important rule is consistency:

- use color to reinforce state
- never rely on color alone to convey meaning
- always surface the exact reason text somewhere visible

## Recommended developer workflow

Use the board as an operator cockpit, not as a passive status wall.

Recommended pattern:

1. Leave the board open while you work
2. Watch `Attention` and `Release Readiness` before acting
3. Click a branch card to inspect lane reasons and file changes
4. Use explicit row actions or the card context menu for preflighted workflow actions
5. Watch action feedback after every click
6. Use the execution console for risky actions
7. Clean up live branches once the board marks them `Ready to Clean`

## Local settings

Board settings are stored per target repo in:

```text
~/.pipelane/dashboard/<repo>-<hash>.json
```

The reference implementation exposes a Settings drawer for:

- board name
- board subtitle
- preferred port
- auto-refresh seconds

These settings are intentionally local-only so each developer can tune the board without creating
repo churn.

## Guardrails for future variants

If you build a variant on top of this design, preserve these boundaries:

- consume the repo's public `pipelane:api` contract
- do not re-infer workflow state from private files; display-only alias labels may come from the
  repo config for the help guide
- keep action semantics in the repo contract, not in the UI
- keep the board local and customizable
- prefer better operator comprehension over generic dashboard aesthetics
