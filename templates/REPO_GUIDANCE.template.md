# Repo Guidance

Last reviewed: 2026-04-23
Refresh cadence: 30 days or 50 commits
Drift-hint threshold: 20 commits / 30 days
Owners: <your name or team>

This file captures repo-specific invariants that `/fix` reads before applying
review findings. Everything below is a starting scaffold — fill in the
sections that apply to your project, delete the ones that don't. Run
`/fix refresh-guidance` to update over time.

## What this project is

Describe the product, stage, and anything that changes how findings should
be evaluated. Example framings that matter: "pre-launch," "regulated,"
"prototype," "internal tool only," "has real users."

## Project invariants

Rules true for this repo only. `/fix` follows these even when a "cleaner"
approach seems available — invariants exist because past attempts at the
cleaner approach failed. Each entry: the rule, why it exists, where it is
enforced.

- **<Rule>** — <why it exists> — enforced by: <CI / code comment / lint / human review>

## Tech-stack rules

Stack-specific gotchas. Inlined here; there is no separate stack-playbook
layer. Organize by stack as makes sense (Supabase, React, TanStack,
PostHog, etc.).

### <Stack>

- <Rule + one-line reason>

## Deferred / don't-touch list

Refactors, cleanups, or modules explicitly postponed. `/fix` will avoid
opportunistic changes in these areas and will not surface drift hints on
files listed here. Each entry includes the trigger for when it becomes
fair game.

- **<Deferred thing>** — unfreeze when: <trigger>

## PR and review strategy

How findings should be packaged and delivered. One-PR vs many. Retro-review
triggers. Review cadence. Anything that affects the shape of
fix-application.

## Ask-first additions

Anything beyond the universal ask-first list in the `/fix` prompt. These
additions are repo-specific "stop and surface" triggers. You cannot remove
items from the universal list; this section only adds to it.

- <Surface or pattern the agent should stop at>

## Drift-hint ignore

Glob patterns for files that naturally churn a lot and should not trigger
post-fix drift hints. Config files, generated files, lock files, etc.

- `package-lock.json`
- `*.generated.*`
- `CHANGELOG.md`
- `.pipelane/state/**`
