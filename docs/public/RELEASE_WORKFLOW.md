# Pipelane: Release Workflow (Target Spec)

Last updated: April 17, 2026
Status: **target-state spec**. The [v0] correctness wave has shipped (PRs
#16–#22); the [v1] recovery surface (`/rollback`, `/doctor`, `/status`)
is described here for direction but is **not yet implemented**. See
`docs/CHANGE_MANIFEST.md` for the authoritative shipped-vs-planned status.

This document describes how Pipelane *should* work for the AI vibe coder
journey — as synthesized by a cross-functional review team (Lead PM, expert
vibe coder, Scrum master, CI/CD release manager).

Every section below is tagged with an implementation marker:

- **[shipped]** already works (verify against CHANGE_MANIFEST before relying)
- **[v0]** correctness wave — **all shipped** via step 6 (pipelane #16–#22)
- **[v1]** second wave, trust + recovery — **not yet shipped**; descriptions
  of `/rollback`, `/doctor`, `/status` are aspirational
- **[v2]** polish, product positioning — deferred

## What Pipelane is

**Pipelane** is the release cockpit for AI vibe coders and small AI
vibe-coding teams.

It gives every repo one screen where you can see:

- which tasks are in flight
- where each task's code is on the pipeline (branch → PR → CI → main →
  staging → prod)
- what the next safe action is

And one command surface that the AI can execute without improvising
dangerous repo behavior:

- isolated task workspaces (`/new`, `/resume`)
- a reviewed PR + merge flow (`/pr`, `/merge`)
- same-SHA staged deploys with verification (`/deploy`)
- one-command rollback (`/rollback`)
- guided configuration (`/doctor`)
- a single visual pipeline view (`/status`)

The two dev modes are lanes:

- **Build lane** — fast path, short handoff from merge to production
- **Release lane** — protected path, same merged SHA moves staging → prod
  in order with verification

Tasks move through lanes. The `/status` cockpit shows where every task
is right now.

## Who this is for

Pipelane is designed for AI-first builders: solo maintainers and small
teams using Claude Code, Codex, or both as their primary operator.

The core assumptions:

- The AI should follow explicit repo-native commands without improvising
- Branch, PR, and deploy state should be **visible**, not implicit
- Release actions should require confirmation proportional to their
  blast radius
- Every mutating step should be **error-aware**, not fire-and-forget
- Local machine-specific deploy state should not leak into tracked repo
  policy, but also should not be a silent trust boundary the AI can
  flip at 2am

## The cockpit: `/status`

**[v0]** `/status` is the primary surface of Pipelane.

It is a single-screen terminal view rendered from existing state (task
locks, PR records, deploy records) plus two `gh` calls. It is read-only.
It is safe to run at any time.

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
    [ main OK ]--> [ staging OK 2h ago (healthcheck 200) ]--> [ prod PENDING ]
                                             next: /deploy prod
  chore: dep bump       sha 5f09c11
    [ main OK ]--> [ staging OK 1d ago ]--> [ prod OK 22h ago ]

STALE (run /clean --apply --all-stale to prune)
  old-experiment   worktree missing    3 days old
```

Flags:

- `/status` — now view (default).
- `/status --week` — shipped in the last 7 days, throughput, cycle time.
- `/status --stuck` — tasks idle >72h, merges without deploys, staging
  deploys with no prod promotion.
- `/status --blast <sha>` — surfaces changed by this SHA vs. the last
  one on the target env.

Run it before you start a task. Run it when you come back on Monday.
Run it before `/deploy prod`. One screen, every time.

## Build lane user journey

**Build lane** is the fast path. Use it when you want the shortest
possible route from merge to production and you do not need same-SHA
staging validation.

### Happy path

```
/status                    # orient yourself (v0)
/devmode build             # confirm or switch lane (shipped)
/new billing-cleanup       # fresh branch + worktree (shipped)
                           # cd into the printed worktree path
                           # implement, verify locally
/pr                        # preview + stage + commit + push + open PR (hardened v0)
/merge                     # confirm + squash-merge + poll mergeCommit.oid (hardened v0)
                           # CI runs; if auto-deploy is wired, prod picks it up
/status                    # confirm prod deploy succeeded and healthcheck is green (v0)
/clean                     # prune the local workspace (shipped)
```

### What each step guarantees

**`/status`** — [v0] You see where every task is before you start a
new one. Soft warns at 3+ active tasks.

**`/devmode build`** — [shipped] Records build lane in state. Every
subsequent command inherits this lane.

**`/new <task-name>`** — [shipped] Creates a fresh worktree and a
`codex/<task-name>-<4hex>` branch from the refreshed base branch. Fails
closed if the base branch is stale and `--offline` was not passed.
Refuses to start the same task slug twice and points you at `/resume`.

**`/pr`** — [v0-hardened] Before committing it:

- Prints the list of files about to be staged
- Denies `CLAUDE.md`, `.env*`, `*.pem`, and anything matching `.gitignore`
  patterns unless `--force-include <path>` is passed
- Shows a 10-line summary of staged diff
- Prompts `Commit and open PR? [y/N]`
- Runs `prePrChecks` with live stdio (`npm test`, etc.) before pushing
- Opens or updates the PR via `gh pr create`

**`/merge`** — [v0-hardened]:

- Prompts `Merge PR #<n>: "<title>" → main? [y/N]`
- Runs `gh pr merge --squash --delete-branch`
- **Polls** `gh pr view` until `mergeCommit.oid` resolves (bounded 30s)
- Fails closed if the SHA does not resolve (never falls back to
  `rev-parse origin/main`)
- Stamps `PrRecord.mergedSha` with the verified SHA

**`/status`** — [v0] After build lane merge, the auto-deploy workflow
(if configured) fires on main. `/status` shows whether prod deploy
succeeded and healthcheck passed. You watch the cockpit, not the GH
Actions tab.

**`/clean`** — [shipped + hardened v0] Report-first. `--apply` requires
`--task <slug>` or `--all-stale`; refuses to prune any lock newer
than 5 minutes.

The two scope flags have different authority models:
- `--all-stale` is evidence-based: it only prunes locks whose worktree
  or branch is already missing. Safe blanket sweep after a cleanup pass.
- `--task <slug>` is an operator override: it prunes the named lock
  even if its worktree and branch are still intact. Reach for this when
  a lock got orphaned (wrong task name, stuck deploy state) but the
  underlying worktree is still fine. Lock removal is metadata-only;
  the worktree and branch are untouched.

Both modes respect the 5-minute age floor — `--task` will still skip a
lock that's actively ticking.

### When build lane breaks

- **CI failed on main after merge.** Run `/rollback` (v1) to redeploy
  last-known-good SHA immediately; open a revert PR manually or via
  `/rollback --revert-pr`.
- **Auto-deploy workflow failed.** `/status` shows red. Run
  `/deploy prod` manually to retry, or `/rollback` to go back.
- **You committed to the wrong branch.** `/status --stuck` surfaces it;
  `/resume` points you back at the right worktree.

## Release lane user journey

**Release lane** is the protected path. Use it when the same merged
SHA must move staging → prod in order with verification, when
multi-surface coordination matters, or when a stricter gate makes
sense for the repo.

### Setup (once per machine, per repo)

```
npx -y pipelane@github:jokim1/pipelane#main bootstrap --project "My App"  # one-shot bootstrap
# or, if pipelane is already on PATH:
pipelane bootstrap --yes --project "My App"
/doctor --fix                            # interactive config wizard (v1)
/doctor --probe                          # verify healthcheck URLs respond (v1)
```

Release lane is **fail-closed until ****`/doctor --probe`**** returns all green**.

### Bootstrapping release lane (v1.2+)

On a fresh repo, or when upgrading an older pipelane consumer to v1.2+,
`/devmode release` will fail closed with `no succeeded deploy observed`
for every surface you plan to ship. That is the gate doing its job:
release readiness is no longer a boolean you flip, it is earned by
running one verified staging deploy per surface.

One-time bootstrap:

```
/devmode build                            # build lane skips the readiness gate
/deploy staging [frontend,edge,sql]       # watches gh run + 2xx healthcheck, writes DeployRecord
/devmode release                          # now sees the succeeded record and clears
```

You only need to do this once per surface per repo. After the first
verified staging deploy, subsequent `/devmode release` is a no-op.
The bootstrap is the same whether the repo is brand-new or migrating
from pre-v1.2 (where `.staging.ready: true` used to be the honor-system
escape hatch).

### Pluggable release checks (v4)

`release-check` runs the built-in observed-deploys gate, then dispatches
any consumer-configured plugin checks. Plugins are opt-in via the
`checks` block in `.pipelane.json`:

```json
{
  "checks": {
    "requireSecretManifest": true,
    "secretManifestPath": "supabase/functions/secrets.manifest.json",
    "requiredRepoSecrets": ["SUPABASE_ACCESS_TOKEN", "CLOUDFLARE_API_TOKEN"],
    "requiredEnvironmentSecrets": ["SUPABASE_PROJECT_REF", "APP_URL"]
  }
}
```

Built-in plugins:

- **`secret-manifest`** (gate: `requireSecretManifest: true`). Reads
  the manifest at `secretManifestPath` and checks that every `required`
  name exists in each configured Supabase project's secrets
  (`supabase.staging.projectRef`, `supabase.production.projectRef`).
- **`gh-required-secrets`** (gate: `requiredRepoSecrets` or
  `requiredEnvironmentSecrets` non-empty). Calls `gh secret list` to
  verify the named secrets exist at the repo level, and
  `gh secret list --env {staging,production}` for each named
  environment secret.

A failing plugin flips overall readiness to `FAIL` even when the
observed-deploys gate is clean. Absent config = no plugins dispatched;
consumers stay on a clean default.

### Happy path

```
/status                    # orient
/devmode release           # switch lane (shipped); fails closed if config is incomplete
/new stripe-webhooks       # fresh workspace (shipped)
                           # implement, verify
/pr                        # preview + stage + commit + push + open PR (hardened v0)
/merge                     # confirm + squash-merge + poll SHA (hardened v0)
/deploy staging            # deploy to staging, watch the run, probe healthcheck (v0)
/status                    # verify staging shows green with healthcheck timestamp (v0)
/deploy prod               # confirm + deploy prod, watch the run, probe healthcheck (v0)
/status                    # verify prod shows green (v0)
/clean                     # prune (shipped)
```

### What each step guarantees beyond build lane

**`/devmode release`** — [shipped + v1 hardened] Fails closed if any
required deploy-config field is missing in `CLAUDE.md` OR if the most
recent `/doctor --probe` result is stale (>24h) or red. Accepts
`--override --reason <text>` only when a human is explicitly opting out,
with an audit record.

**`/deploy staging`** — [v0-hardened]:

1. Reads `deployConfig.frontend.staging.deployWorkflow` (no stored
   `ready:true` flag — readiness is derived live)
2. Prompts `Deploy sha abc1234 (surfaces: frontend, edge) to staging? [y/N]`
3. Fires `gh workflow run`
4. Resolves `workflowRunId` from `gh run list`
5. Writes a `DeployRecord` with `status: 'requested'`, `taskSlug`,
   `idempotencyKey`
6. **Watches the workflow run** via `gh run watch --exit-status`
7. On success, probes `healthcheckUrl` (2xx required, twice, 10s apart)
8. Stamps the record `status: 'succeeded'` + `verification` block
9. On failure, stamps `status: 'failed'` + `failureReason` and exits
   non-zero

**`/deploy prod`** — [v0-hardened] Same as staging, plus the
same-SHA-from-staging gate:

1. Looks up the most recent `DeployRecord` where `environment='staging'`
   AND `sha = mergedSha` AND `surfaces ⊇ requestedSurfaces` AND
   `status='succeeded'` AND `verification.statusCode < 300` AND
   `verifiedAt < 24h ago`
2. If missing or any condition fails, **hard-fails with a specific
   reason** ("staging for this SHA never succeeded", "staging verification
   is 27h stale", "surface `edge` was never verified on staging")
3. Prompts `Deploy abc1234 (staging verified 2h ago) to PROD? Type SHA prefix to confirm:`
4. Requires typing the 4-char SHA prefix, not `y`
5. Runs the same polling + healthcheck flow as staging
6. Records outcome

The same-SHA gate is now based on **verified outcomes**, not requests.

### Release lane failure paths

- **Staging deploy failed.** `/deploy staging` exits non-zero, `/status`
  shows the failure row red. Fix the code, `/pr`, `/merge`, retry.
- **Staging green but prod deploy failed.** `/rollback` (v1) redeploys
  the last-known-good prod SHA. Staging result is preserved for retry.
- **Prod regression discovered post-deploy.** `/rollback` redeploys
  the previous `status='succeeded'` prod SHA. Optionally auto-emits a
  `git revert <mergeCommit>` PR via `/rollback --revert-pr` so `main`
  stops lying.
- **Prod deploy succeeded but healthcheck failed.** Hard fail. Record
  marks `status='failed'` with `failureReason='healthcheck 500'`.
  `/rollback` is the next action.
- **Release mode suddenly blocks after a staging URL or healthcheck-path
  change.** The cached probe result is tied to the old `healthcheckUrl`.
  Rerun `/doctor --probe` to record a fresh green result for the new
  target.
- **Release mode blocks after enabling probe-state signing.** Make sure
  `PIPELANE_PROBE_STATE_KEY` is set consistently on the machine that
  runs `/doctor --probe`, then rerun the probe so readiness is backed by
  signed records instead of legacy unsigned cache entries.
- **You need a hotfix that skips staging.** Use `/devmode build
  --override --reason "hotfix: <incident>"`. One-shot; the override is
  recorded and the next command resets to release.

## `/rollback` [v1]

One command. Safe at 2am.

```
/rollback prod

Rolling back prod:
  current: abc1234 (status: failed 4m ago, healthcheck: 500)
  target:  def5678 (last green, deployed 2h ago, healthcheck: 200 @ 12ms)
  surfaces: frontend, edge

Type the SHA prefix to confirm: _
```

Behavior:

- **Build lane ****`/rollback prod`** redeploys the last `DeployRecord`
  where `environment='prod'`, `status='succeeded'`,
  `verification.statusCode < 300`, excluding the current failure.
  Writes a new `DeployRecord` with `rollbackOfSha = currentSha`.
- **Release lane ****`/rollback prod`** same behavior, plus optional
  `--revert-pr` flag that opens a `git revert <mergeCommit>` PR so
  `main` reflects the rolled-back state.
- Never auto-pushes the revert. Never deletes history. Audit trail is
  a first-class "ROLLBACK" row in `/status`.

## `/doctor` [v1]

Replaces the current all-or-nothing `release-check`.

```
/doctor                    # diagnose (read-only)
/doctor --fix              # interactive config wizard
/doctor --probe            # probe healthcheck URLs, report statuses
```

`/doctor --fix` detects the platform from the repo (Vercel, Fly,
Netlify, Render, GH Actions), asks 4 questions (staging URL, prod
URL, deploy workflow name, healthcheck path), writes the
`## Deploy Configuration` JSON block to local `CLAUDE.md`, and runs
`--probe` automatically to validate. It does **not** set any
`ready: true` flag — readiness is derived live at deploy time.

`/doctor --probe` hits each configured `healthcheckUrl` and reports
HTTP status + latency. Release lane consults the most recent probe
result (cached 24h) as the freshness check.

Probe cache entries are bound to the exact configured `healthcheckUrl`.
If a staging URL, prod URL, or healthcheck path changes, the previous
green probe result is ignored until `/doctor --probe` is rerun against
the new target.

If `PIPELANE_PROBE_STATE_KEY` is set, probe cache entries are HMAC-signed
before they are written to local state. In that mode, unsigned or
tampered probe records do not count toward release readiness.

## State model

### What `/status` reads

- `task-locks/<slug>.json` — active task workspaces
- `pr-state.json` — PR metadata per task, including `mergedSha`
- `deploy-state.json` — `DeployRecord[]` with verified outcomes
- `gh pr view <n>` — live PR state + CI check summary
- `gh run list` — live workflow run statuses

### `DeployRecord` schema [v0]

```ts
export type DeployStatus =
  | 'requested'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface DeployRecord {
  id: string;                     // ULID
  idempotencyKey: string;         // sha256(env|sha|surfaces|taskSlug)
  taskSlug: string;               // per-task identity, kills cross-task unlock
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  workflowName: string;
  workflowRunId?: number;
  workflowRunUrl?: string;
  status: DeployStatus;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  verifiedAt?: string;            // healthcheck success timestamp
  verification?: {
    url: string;
    statusCode: number;
    latencyMs: number;
  };
  rollbackOfSha?: string;         // set when this deploy rolls back another
  triggeredBy: string;            // git user.email or 'claude' / 'codex'
  failureReason?: string;
}
```

### `TaskLock.nextAction` [v1]

A narrow addition. The last agent turn writes a one-liner describing
what the operator intended next, so a new session or another agent
can pick up coherently.

```ts
export interface TaskLock {
  // ... existing fields
  nextAction?: string;   // e.g. "merged, waiting on staging deploy"
}
```

## AI operator conventions

Pipelane is designed for AI operators. These conventions exist because
AI operators amend commits, run commands speculatively, and don't feel
the weight of a prod deploy the way a human does.

**Things the AI must do:**

- Run `/status` before `/new`
- Confirm all merges and prod deploys by showing the prompt to the human
- Never bypass `/pr`'s staged-file deny-list silently; surface `--force-include`
  decisions explicitly
- Never flip a `ready:` boolean (there should be none in v1)
- Write `nextAction` on the task lock before ending a turn mid-task

**Things the AI must not do:**

- Call `git commit --amend` on a merged commit
- Call `git push --force` to any tracked branch
- Call `/clean --apply` without `--task <slug>` or `--all-stale`
- Flip `/devmode build` in the middle of a release-lane task without
  `--override --reason`
- Run `/deploy prod` with `--sha <other>` (hard-blocked in release lane;
  soft-warned in build lane)

These are enforced by the command layer where possible, and documented
in `AGENTS.md` where enforcement is social.

## Command reference

### Operator commands

| Slash | Purpose | Status |
| --- | --- | --- |
| `/status` | Cockpit view; tasks + pipeline state | v0 |
| `/devmode` | Inspect / switch build ↔ release lane | shipped |
| `/new` | Fresh isolated task workspace | shipped |
| `/resume` | Recover an existing workspace | shipped |
| `/pr` | Preview + stage + commit + push + open PR | v0-hardened |
| `/merge` | Confirm + squash-merge + poll SHA | v0-hardened |
| `/deploy` | Deploy + watch + verify | v0-hardened |
| `/rollback` | Redeploy last-known-good | v1 |
| `/doctor` | Diagnose / configure / probe | v1 |
| `/clean` | Prune stale task locks | shipped + v0-hardened |

### Setup commands

| Command | Purpose | Status |
| --- | --- | --- |
| `pipelane bootstrap --yes --project "<name>"` | Install pipelane into the repo, scaffold tracked files, and run setup after explicit confirmation | shipped |
| `npx pipelane init --project "<name>"` | Scaffold tracked files in a repo that already has pipelane installed locally | rename-pending |
| setup | Install templates, Claude commands, and tracked Codex skills | rename-pending |
| `pipelane install-claude` | Install durable default Claude personal skills under `~/.claude/skills` | shipped |
| `pipelane install-codex` | Install durable default Codex skills under `~/.codex/skills` | shipped |
| `pipelane install-npm-guard` | Install the opt-in `~/.pipelane/bin/npm` guard for symlinked worktree `node_modules` | shipped |

## Configuration

### Tracked in git (repo policy)

- `.pipelane.json` or `.project-workflow.json` — baseBranch, surfaces, aliases,
  prePrChecks, deploy workflow names. `bootstrap` writes `.pipelane.json` by
  default; rename it to `.project-workflow.json` before commit if you want a
  tool-neutral filename.
- `AGENTS.md` — policy for AI operators
- `.claude/commands/*` — thin slash adapters
- `.agents/skills/*` — tracked Codex skills
- `pipelane/CLAUDE.template.md` — template used to bootstrap local operator state
- `docs/RELEASE_WORKFLOW.md` — rendered from the pipelane template; pipelane's own copy of this reference lives at `docs/public/RELEASE_WORKFLOW.md`

### Local-only (operator state, git-ignored)

- `CLAUDE.md` — local deploy config and operator defaults

Note: the `ready: true` boolean previously carried in this file is
**ignored** as of v1.2 (pipelane #20). The field is still accepted in the
JSON shape for backwards compatibility, but it is never consulted. Release
readiness is derived live from observed staging `DeployRecord` history —
no flag can substitute for a succeeded, verified staging deploy. Do not rely on it.

### Internal state (git common-dir, shared across worktrees)

- `pipelane-state/task-locks/<slug>.json` — active task identities
- `pipelane-state/pr-state.json` — per-task PR records
- `pipelane-state/deploy-state.json` — deploy records (new schema in v0)

State lives in `git common-dir` intentionally so multiple worktrees for
the same repo share one state view. Do not move this.

## Modes are lanes

Pipelane's dev-mode concept is a lane:

| Lane | Path | Verification | Use when |
| --- | --- | --- | --- |
| Build | merge → prod (auto or manual) | post-deploy healthcheck | speed matters, no staging gate required |
| Release | merge → staging (verified) → prod (verified) | pre-deploy same-SHA gate + post-deploy healthcheck on both envs | multi-surface coordination, stricter gate, same-SHA promotion required |

A repo picks one as its default. Individual tasks can override via
`/devmode build|release`, but release-lane tasks require the deploy
config to be healthy.

The `/status` cockpit shows the active lane top-right. You should
always know which lane you're in.

## Failure modes that are now closed

These are bugs in the current (pre-v0) implementation that the target
spec fixes. The change manifest tracks which PR closes each one.

- [v0] **Silent SHA mispromotion at merge.** `merge.ts` used to fall back
  to `git rev-parse origin/main` when `mergeCommit.oid` didn't resolve.
  v0 polls until resolution or fails closed.
- [v0] **Cross-task deploy collision.** `DeployRecord` was global + unkeyed.
  v0 keys by `taskSlug` and requires `status='succeeded'` for the gate.
- [v0] **Fire-and-forget ****`gh workflow run`****.** v0 watches the run,
  probes the healthcheck, and records the verified outcome.
- [v1.2] **Honor-system ****`ready:true`****.** Shipped in pipelane #20.
  The flag is retained in the JSON schema but ignored; release readiness
  is derived from observed staging `DeployRecord.status === 'succeeded'`
  history via the same `verification` block the post-deploy healthcheck
  writes. No flag can substitute for a verified deploy.
- [v0] **Silent ****`/pr`**** with ****`git add -A`****.** v0 previews staged files,
  enforces a deny-list, and prompts before commit.
- [v0] **Zero-confirmation ****`/merge`**** and ****`/deploy prod`****.** v0 requires
  explicit confirmation (`y/N` for merge; typed SHA prefix for prod).
- [v0] **No visibility.** `/status` renders the full pipeline state
  from existing + v0 data.
- [v1] **No rollback.** `/rollback` ships.
- [v0] **`/clean --apply`**** too aggressive.** Requires `--task` or
  `--all-stale`; refuses recent locks.

## Troubleshooting

- **Missing tracked workflow config** → `pipelane bootstrap --project "<name>"` or
  `npx pipelane init`. A repo may track either `.pipelane.json` or
  `.project-workflow.json`.
- **Repo tracks `.project-workflow.json` but local pipelane still errors on missing `.pipelane.json`** →
  upgrade to a pipelane build that includes PR #44 / merge commit `4111230`
  from April 21, 2026. Older local installs need a temporary local shim.
- **Task already active** → `/resume --task "<slug>"`
- **Release lane blocked** → `/doctor` (diagnose), `/doctor --fix`
  (configure), `/doctor --probe` (verify)
- **`/deploy prod`**** says "staging never succeeded for this SHA"** →
  `/deploy staging`, wait for it to verify, then retry prod
- **`/deploy prod`**** says "staging verification is stale (>24h)"** →
  re-run `/deploy staging` to refresh the verified-at timestamp
- **Prod healthcheck failed post-deploy** → `/rollback prod`
- **You want to skip staging for a hotfix** →
  `/devmode build --override --reason "hotfix: <incident>"` then
  `/deploy prod` directly

## Implementation status at a glance

| Feature | Status |
| --- | --- |
| `/new`, `/resume` task workspaces | shipped |
| `/devmode` with build + release lanes | shipped |
| `/pr`, `/merge`, basic `/deploy`, `/clean` | shipped (unhardened) |
| Fail-closed release mode | shipped |
| Same-SHA staging-before-prod gate (by *request*) | shipped (gaps in v0) |
| `/status` cockpit | **v0** |
| `DeployRecord` v2 schema + polling + verification | **v0** |
| `/pr` preview + deny-list + confirm | **v0** |
| `/merge` confirm + SHA poll + fail-closed | **v0** |
| `/deploy` confirm + watch + verify | **v0** |
| `/clean` hardening | **v0** |
| `/rollback` | **v1** |
| `/doctor` + `/doctor --fix` + `/doctor --probe` | **v1** |
| `TaskLock.nextAction` | **v1** |
| `/status --week / --stuck / --blast` | **v1** |
| WIP soft warn at 3 | **v1** |
| `pipelane` → `pipelane` rename | **v2** |
| Cut Codex dual-install surface | **v2** |

See `docs/CHANGE_MANIFEST.md` for the concrete file-by-file change list.
