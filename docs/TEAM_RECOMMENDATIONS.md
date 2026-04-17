# workflow-kit: Team Recommendations

A cross-functional review of workflow-kit from the perspective of a solo AI vibe
coder (and small AI vibe coding team) shipping with Claude Code / Codex as the
primary operator.

Four specialists analyzed the repo independently, then debated. This document is
the synthesized proposal.

## Team

| Role | Expertise | Focus |
|------|-----------|-------|
| Lead PM, Silicon Valley tech startup | Shipped real-time dashboards and release observability at Linear/Vercel/GitHub class companies | First-run experience, aha moments, product positioning |
| Expert AI vibe coder | Solo builder shipping 3-5 products/yr via Claude + Codex | Day-to-day friction, 11pm trust, what the AI actually does |
| Scrum master / agile coach | 15 years coaching eng teams, studying AI-pair-programming's impact on agile | Flow, WIP, ceremonies, handoffs |
| CI/CD & release management expert | Staff platform engineer, ran release eng at large + small shops | Same-SHA promotion, rollback, blast radius, drift |

## The stated objectives

1. Give vibe coders an easy-to-understand, **visual** understanding of their
   branch release status and pipeline.
2. Make release management in an AI vibe coding world **as easy and error-free
   as possible**.
3. Make actions on the release pipeline workflow **as easy as possible**.

## Consensus verdict (objective scorecard)

Scores are the team's converged view after debate.

| Objective | Score | Why |
|-----------|-------|-----|
| 1. Visual pipeline understanding | **1 / 10** | The data exists in `pr-state.json`, `deploy-state.json`, and `task-locks/*.json`. Nothing renders it. There is no `status` command. The product's #1 stated objective is entirely unimplemented. |
| 2. Error-free release management | **5 / 10** (was 6, downgraded in debate) | Real guardrails exist: fail-closed release mode, same-SHA staging-before-prod check, task-lock verification, forbidden `--sha` on prod in release mode. But several silent-failure paths remain open (see "Critical bugs" below), and the honor-system `ready:true` flag makes the strongest claim the tool makes — *same-SHA promotion* — weaker than it looks. |
| 3. Easy actions | **5 / 10** | The 7-command surface (`/new`, `/resume`, `/pr`, `/merge`, `/deploy`, `/clean`, `/devmode`) is small and memorable. Two things drag it down: the dual install surface (Claude tracked + Codex machine-global) is 30% of cognitive overhead, and the flow breaks between `/merge` and `/deploy` because the CLI exits without verifying the workflow run actually succeeded. |

**Overall:** workflow-kit is a serviceable *correctness library* for release
discipline. It is not yet the *cockpit* its objectives describe. The gap is
recoverable, and most of the fix is one feature.

## What the team strongly agrees on

Every specialist, working independently, converged on the same #1 feature
before seeing each other's analysis: a **`/status` command that renders the
full pipeline state**.

- PM called it the pipeline box view ("turns an invisible discipline layer into a visible product").
- Vibe coder sketched it in ASCII and called it the cockpit.
- Scrum master called it the kanban board the tool is already secretly tracking.
- CI/CD expert called it the precondition for trusting prod deploys.

When four specialists with different priors write the same feature in different
words, you stop debating and ship it.

## Critical bugs (release-engineering findings)

> **Update 2026-04-17: all 5 critical bugs below shipped.** Fixes landed
> across pipelane PRs #16–#22 (step 6 + step 4). This section is kept for
> historical context. See `docs/CHANGE_MANIFEST.md` "Shipped to date" for
> the current status of every bug called out here.

These are correctness issues, not product polish. They block the "error-free"
claim until they're fixed.

### 1. `merge.ts:19-22` — silent SHA mispromotion [✅ SHIPPED pipelane #16]

When `gh pr merge` returns and `loadPrDetails` has a race or
network hiccup, `mergeCommit?.oid` can come back null. The fallback is
`git rev-parse origin/<baseBranch>` — whatever happens to be on `main`
locally. If a second merge lands between `watchPrChecks` and the
`loadPrDetails` call, task A stamps task B's SHA into its `PrRecord`,
and the prod same-SHA gate at `deploy.ts:43-46` happily promotes code the
operator never saw on staging.

**Fix:** after `gh pr merge`, poll `gh pr view` until `mergeCommit.oid` is
present, bounded (30s). Fail closed if it never arrives. Do not invent a SHA.

### 2. `DeployRecord` is global and unkeyed (`state.ts:72-78`) [✅ SHIPPED pipelane #17]

The record carries `environment`, `sha`, `surfaces`, `requestedAt` — no task
identity. Two tasks that touch the same surface set can cross-unlock each
other's prod promotion. The same-SHA gate is checking a stranger's deploy.

**Fix:** add `taskSlug` to `DeployRecord`. Key the gate on
`(taskSlug, env, sha, surfaces)`.

### 3. `deploy.ts:53-74` — fire-and-forget deploy [✅ SHIPPED pipelane #17]

`gh workflow run` is dispatched, the record is written with `requestedAt`,
the CLI exits. There is no polling, no success/failure capture, no healthcheck.
The staging-before-prod gate checks that staging was **requested**, not that
it **succeeded**. This is the central bug in the error-free claim.

**Fix:** see data-model and control-flow proposals below.

### 4. `CLAUDE.md` `ready: true` is honor-system [✅ SHIPPED pipelane #20]

Documented as "set to true only after verified in staging." In practice this
is a boolean in a human-edited markdown file that the AI will flip during
scaffolding, and a stale `ready:true` on a dead endpoint unlocks a prod
deploy at 2am with no probe.

**Fix:** kill `ready:true` as a stored primitive. Derive readiness at deploy
time by probing `healthcheckUrl`. Cache the probe for ~60s in deploy state.

### 5. `/clean --apply` can drop an in-flight task mid-pipeline [✅ SHIPPED pipelane #19]

`pruneDeadTaskLocks` is tamer than feared — it doesn't touch `deployState`
or `prState` — but if an AI fires it with a transiently missing worktree,
the task lock goes and the next `/merge` fails `inferActiveTaskLock`.

**Fix:** require `--task <slug>` or `--all-stale` with `--apply`. Refuse to
prune any lock newer than N minutes.

## Recommended data model delta

The concrete change to make the "error-free" claim real. Proposed new
`DeployRecord` shape (converged from CI/CD expert + vibe coder):

```ts
export type DeployStatus =
  | 'requested'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface DeployRecord {
  id: string;                    // ULID, primary key
  idempotencyKey: string;        // sha256(env|sha|surfaces|taskSlug) — dedupe AI retries
  taskSlug: string;              // kills the cross-task cross-unlock
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  workflowName: string;
  workflowRunId?: number;        // resolved post-dispatch from gh run list
  workflowRunUrl?: string;
  status: DeployStatus;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  verifiedAt?: string;           // healthcheck success timestamp
  verification?: {
    url: string;
    statusCode: number;
    latencyMs: number;
  };
  rollbackOfSha?: string;        // set when this deploy rolls back a prior SHA
  triggeredBy: string;           // git user.email, or 'codex' / 'claude' for AI
  failureReason?: string;
}
```

And one narrow addition to `TaskLock`: `nextAction: string` — a one-liner the
last agent turn writes so the next agent (or a new session) knows what the
operator intended next. `brief` was discussed and dropped: the chat
conversation already carries intent; `nextAction` is the bit that is lost
when a session ends.

## Recommended control-flow delta

`deploy.ts` after `gh workflow run`:

1. Capture `workflowRunId` via `gh run list --workflow=<name> --json databaseId,headSha --limit 5` (match on sha + recency).
2. Persist the record with `status: 'requested'`.
3. `gh run watch <id> --exit-status` in the foreground by default (`--async` opts out).
4. On completion, probe `healthcheckUrl` twice, 10s apart; require 2xx.
5. Stamp `conclusion`, `verification`, `status: 'succeeded' | 'failed'`.
6. The prod gate (`deploy.ts:42-47`) now requires `conclusion === 'success' && verification.statusCode < 300`, not just a request.

`merge.ts`:

1. Run `gh pr merge --squash --delete-branch` only after an explicit confirm
   (`About to merge PR #X: "Y" → main. Confirm? [y/N]`).
2. Poll `gh pr view` until `mergeCommit.oid` resolves. Fail closed if it
   doesn't within the bound.

`/pr`:

1. Print a staged-file summary before commit. Hard-deny `CLAUDE.md`,
   `.env*`, `*.pem` from the stage unless explicitly overridden.
2. Don't use `git add -A` silently.

## Recommended new commands

Collapsed from four proposed commands into one surface with flags. This is
the Scrum master's concession after debate — vibe coders won't remember four
new verbs, but they'll remember one verb with flags.

### `/status` (the cockpit)

Default view, one screen. Reads from existing state plus two `gh` calls.
Sketch:

```
demo-app   mode: release   base: main (fetched 4m ago)

ACTIVE TASKS (2)
  stripe-webhooks   codex/stripe-webhooks-a9f2    3 ahead, 0 behind
    PR #412 open     CI: 4/4 pass    merge ready
    [ branch ]--( PR 412 )--> [ main ]    [ staging ]    [ prod ]
                                              ^ next: /merge

  hotfix-500        codex/hotfix-500-b73d         1 ahead
    no PR yet
    [ branch ]    ( PR )    [ main ]    [ staging ]    [ prod ]

RECENT RELEASES
  feat: email auth      sha 8c21a4f
    [ main OK ]--> [ staging OK  2h ago ]--> [ prod PENDING ]
                                             next: /deploy prod
  chore: dep bump       sha 5f09c11
    [ main OK ]--> [ staging OK  1d ago ]--> [ prod OK  22h ago ]

STALE (run /clean --apply --all-stale to prune)
  old-experiment   worktree missing    3 days old
```

Flags (collapsed ceremonies):
- `/status --week` — shipped-in-last-7-days + throughput (demo equivalent).
- `/status --stuck` — tasks idle >72h, merges without deploys, staging without prod promotion (retro equivalent).
- `/status --blast <sha>` — surfaces changed by this deploy vs. last prod (pre-deploy impact).

### `/rollback`

Build mode: redeploy last-known-good SHA via the existing deploy workflow.

Release mode: same redeploy, plus emit a `git revert <mergeCommit>` PR as
a parallel artifact so `main` stops lying. Never auto-push the revert;
suggest it.

2am prompt is not `y/N`. It's:

```
Rolling back prod:
  current: abc1234 (status: failed 4m ago)
  target:  def5678 (last green, deployed 2h ago, healthcheck passed)
  surfaces: frontend, edge

Type the SHA prefix to confirm: _
```

Audit trail: new `DeployRecord` with `rollbackOfSha` set, rendered by
`/status` as a first-class "ROLLBACK" row.

### `doctor` (the healing surface)

Replaces the current all-or-nothing release-check experience.

- `doctor` — diagnoses deploy config (detects Vercel/Fly/Netlify/GH Actions
  via package.json, `.vercel/`, `fly.toml`; notes mismatches).
- `doctor --fix` — interactive. Asks the 4 questions required to write
  the deploy config JSON block in `CLAUDE.md`. Never writes
  `ready: true` — that field goes away.
- `doctor --probe` — hits configured healthcheck URLs, reports 2xx/5xx
  and latency. Used by `/deploy` to derive readiness.

## Recommended primitives to retire

**Cut the Codex dual-install surface.**

Claude slash commands are already repo-tracked via `.claude/commands/*`. The
existing repo-native `npm run workflow:*` scripts are the deterministic
source of truth. Codex slash wrappers as a machine-global install that
every user must rerun on every machine on every alias change is 30% of the
product's cognitive overhead and it shows up in five places (README,
RELEASE_WORKFLOW.md, AGENTS.md, CLAUDE.md, package.json scripts).

Pick one: either Codex discovers commands the same way Claude does
(repo-tracked), or the repo-native npm scripts are the surface and Codex
calls them. Delete the duplication. This is the single biggest legibility
win available without writing a line of new code.

**Kill `ready: true` as a stored boolean.**

Derive it from a live probe at deploy time. See data-model delta above.

**Do not add: sprint planning, estimation, or any multi-week ceremony.**

The Scrum master's explicit "one ceremony to discourage." AI vibe coding
commitments go stale in hours. Keep pull-based single-piece flow as the
only legible mode.

## V0 shippable scope (one sprint)

All four specialists agreed on what ships first. In priority order:

1. **`/status` V0** — read-only, one screen. Reads existing JSON plus two
   `gh` calls. Demo-able this week. Shows: current tasks, PR state, CI,
   merged SHA, staging SHA, prod SHA, healthcheck last known, staleness.
2. **Deploy polling + failure-aware gate.** `gh run watch` after
   `gh workflow run`. Prod gate requires `status === 'succeeded'`, not
   `requested`.
3. **`DeployRecord` schema delta.** Add `taskSlug`, `workflowRunId`,
   `status`, `verification`, `rollbackOfSha`, `idempotencyKey`.
4. **`merge.ts` SHA resolution hardening.** Poll until `mergeCommit.oid`
   resolves or fail closed.
5. **`/pr` staged-file deny-list + preview.** No more silent `git add -A`
   against `.env` or `CLAUDE.md`.

Defer to V1:

- `/rollback` (depends on V0's status + verification fields being real).
- `doctor --fix` (ergonomics; not a correctness fix).
- `/status --week / --stuck / --blast` (polish on the core view).
- `nextAction` field on `TaskLock` (paid-off only once multi-agent handoff
  is common enough to matter).
- WIP soft warn at 3 (cheap; batch with V1).

## Where the team actually disagreed

Most of the review was convergent. The real disagreements were:

**Scrum master's four separate ceremony commands.**
PM and vibe coder pushed back hard: four new verbs is too many. Scrum
master conceded. Resolution: one `/status` with flags.

**Auto-print `/status` before `/new`.**
Scrum master wanted this as a forced 2-second WIP check. Vibe coder
rejected it: "teaches vibe coders that /new is slow and noisy; at 11pm
they'll route around it with `git worktree add` manually, bypassing
the lock and the mode gate." Resolution: `/status` is a command you
*pull*, not a ceremony you sit through. A soft warn at 3 active tasks
is fine; a pre-`/new` status dump is not.

**Hard WIP limits.**
Scrum master wanted a WIP limit of 2. Vibe coder rejected hard limits
for solo users. Resolution: soft warn at 3, never block.

**`brief` field on TaskLock.**
Scrum master proposed `brief` + `nextAction`. Vibe coder and PM argued
`brief` is redundant because the chat conversation carries it.
Resolution: ship `nextAction` only. Drop `brief`.

## What's secretly good (do not touch)

These came from the vibe coder's defense and should be preserved through
any refactor:

1. **State lives in `git common-dir`, not `cwd`.** A single state dir
   across worktrees is correct for multi-task vibe coding.
2. **`/new` always creates, `/resume` never creates.** The hard split
   prevents the AI from "helpfully" reusing a dirty branch.
3. **`runShell` inherits stdio for `prePrChecks`.** The test output
   streams live instead of disappearing into a JSON blob.
4. **Aliases are per-repo.** Two workflow-kit repos can both use `/ship`
   for different verbs, preserving muscle memory.
5. **Fail-closed release mode.** Strong default. The right anchor point
   for the rest of the release discipline.

## Naming

Four names were on the table after round one. After debate, the vote is
**3 for `pipeline`, 1 for `Runway`**.

| Name | Round 1 Pick | Round 2 Vote | Rationale |
|------|--------------|--------------|-----------|
| `pipeline` | Vibe coder | PM, Vibe coder, Scrum master | Names the thing the user looks at, not the mechanism. Already the shared vocabulary across the four specialists. `npx pipeline deploy staging` reads naturally. Lowercase, zero teaching cost. |
| `Runway` | PM | CI/CD expert | Evocative, brandable, ownable. "Where your AI-built code takes off" is the category pitch. Best *marketing* name. |
| `ReleaseRail` | CI/CD expert | — | Accurate; signals lane and directionality. Compound-noun fatigue; lowercase-ugly. |
| `Flowline` | Scrum master | — | Evokes kanban. Too abstract; "flow" is the most overloaded word in dev tooling. |

**Dissent worth recording.** The CI/CD expert's objection to `pipeline`
is real: it is unsearchable and collides with every CI product (Azure
Pipelines, GitLab Pipelines, CircleCI's pipelines, GitHub's new
"pipelines"). For a product that wants Google traffic, `pipeline` is a
liability. `Runway` is ownable.

**Team recommendation: `pipeline` as the user-facing term, with one of
two escape hatches depending on intent.**

- If the goal is an internal correctness tool that a maintainer hands
  another vibe coder in Slack ("just use pipeline") — keep `pipeline`.
- If the goal is a brand that supports a docs site, a GitHub org, and
  eventual marketing — rename to `Runway` and use "pipeline" only as
  the name of the command (`runway pipeline` or `runway status`).

Joseph's call. Both choices are defensible. The team split as follows:

- **PM:** shifted `Runway → pipeline`. Evidence-driven: three other
  specialists already use "pipeline" as a noun.
- **Vibe coder:** stayed `pipeline`. Would accept `Runway` only if
  adoption-by-brand became the goal.
- **Scrum master:** shifted `Flowline → pipeline`. User language wins.
- **CI/CD expert:** shifted `ReleaseRail → Runway`. "Ship to Runway
  beats Ship on ReleaseRail on every dimension that matters for
  adoption."

## One-line positioning

If the name lands on `pipeline`:

> **pipeline** — the release cockpit for AI vibe coders. One screen. Your
> branch, your PR, your staging, your prod. No guessing.

If the name lands on `Runway`:

> **Runway** — where your AI-built code takes off. Release discipline
> for solo vibe coders and small AI teams.

## The single highest-leverage change

If only one thing is built from this document: **ship `/status` V0 this
week and make `/deploy` wait for the workflow run to actually finish
before recording success.**

That one pair of changes converts workflow-kit from a correctness library
into a legible product, addresses the #1 stated objective (visual
pipeline understanding), and closes the central "error-free" bug
(same-SHA promotion that checks requests instead of outcomes).

Everything else in this document is supporting detail.
