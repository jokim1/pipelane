# Pipelane Change Manifest

Last updated: April 16, 2026 (revised after `workflow:api` + dashboard discovery)
Status: **execution plan** for reaching the target-state spec in
`docs/RELEASE_WORKFLOW.md`

This is the concrete file-by-file change list to convert today's
`workflow-kit` repo into **Pipelane** — the release cockpit described
in the target spec.

Phases are ordered by priority. A solo operator can ship v0 in one
focused sprint, v1 the week after, and v2 as a positioning follow-up.

- **v0 — Contract + correctness + visibility.** Ports `workflow:api`
  from Rocketboard, closes the silent-failure bugs, and ships `/status`
  (as an envelope renderer) plus the dashboard pointed at workflow-kit
  itself. After v0 the tool earns its "error-free" claim, its "visual"
  claim, and has one canonical read+write surface for every client.
- **v1 — Trust + recovery.** Ships `rollback.*`, `doctor.*`, and the
  narrow TaskLock + `/status` enrichments.
- **v2 — Positioning + cuts.** Finish the Pipelane rename, cut the
  Codex dual-install surface.

Every change below lists: **goal**, **files touched**, **acceptance
criteria**, **rough effort**, and **dependencies**.

## Architectural anchor: `workflow:api`

After v0.0 lands, **every mutating command in Pipelane is an action
exposed over `workflow:api`**, and every read surface (`/status`, the
Branch Pipeline Board dashboard, third-party clients) consumes the same
envelope grammar. The target is Rocketboard-compatible so any client
that speaks Rocketboard's contract speaks Pipelane's.

The contract, summarized from
`/Users/josephkim/dev/rocketboard/docs/public/WORKFLOW_OPERATOR_API.md`:

**Envelope** (all responses):
```json
{
  "schemaVersion": "2026-04-14",
  "command": "workflow.api.snapshot" | "workflow.api.action",
  "ok": true,
  "message": "...",
  "warnings": [],
  "issues": [],
  "data": {}
}
```

**Snapshot `data`:** `boardContext`, `sourceHealth[]`, `attention[]`,
`availableActions[]`, `branches[]`.

**Canonical lane order:** `Local → PR → Base: <base> → Staging →
Production`. Staging renders as `bypassed` in build mode; never hidden.

**Canonical state vocabulary:** `healthy`, `running`, `blocked`,
`degraded`, `stale`, `unknown`, `bypassed`, `awaiting_preflight`.

**Stable action IDs:** `new`, `resume`, `devmode.build`,
`devmode.release`, `taskLock.verify`, `pr`, `merge`, `deploy.staging`,
`deploy.prod`, `clean.plan`, `clean.apply`. Pipelane adds
`rollback.staging`, `rollback.prod`, `doctor.probe`, `doctor.fix` in v1.

**Risky actions** (require confirm-token): `clean.apply`, `merge`,
`deploy.prod`, `rollback.prod`.

**Preflight / execute split.** Every action is callable twice:

- `action <id> --json` → returns `data.preflight` (`allowed`, `state`,
  `reason`, `warnings`, `issues`, `normalizedInputs`,
  `requiresConfirmation`, `confirmation` (opaque token),
  `freshness`) and `data.action` (`id`, `label`, `risky`)
- `action <id> --execute --confirm-token <t> --json` → runs the
  underlying subcommand; returns `data.execution.result`.

Preflight is safe to call from any AI or UI at any time. Execute
rejects requests where the confirm-token doesn't match what preflight
returned for the same normalized inputs.

This is the single most important architectural commitment in this
manifest. Everything else composes on top of it.

---

## Phase v0 — Contract + correctness + visibility (one sprint+)

### v0.0 — Port `workflow:api` into workflow-kit

**Goal.** Give workflow-kit its own `api snapshot` + `api action`
command so the dashboard, the CLI `/status`, and every future client
consume the same envelope. Target is Rocketboard-wire-compatible so
clients written for Rocketboard just work.

**Files touched.**
- `src/operator/commands/api.ts` — new. Entry points
  `handleApiSnapshot(cwd)` and `handleApiAction(cwd, positional, flags)`.
  Mirrors `/Users/josephkim/dev/rocketboard/scripts/workflow-operator.mjs:5012-5120`.
- `src/operator/api/envelope.ts` — new. `buildApiEnvelope`,
  `buildApiIssue`, `buildFreshness`, `nowIso`, shared schema version
  constant.
- `src/operator/api/snapshot.ts` — new. `buildWorkflowApiSnapshot(cwd)`
  pulls from existing state (`state.ts`), `gh pr view`, `gh run list`,
  branch enumeration. Produces:
  - `data.boardContext` — `mode`, `baseBranch`, `laneOrder` (fixed
    array), `releaseReadiness`, `activeTask`, `overallFreshness`
  - `data.sourceHealth[]` — one entry per source (git, gh, deploy
    state, pr state, probe state)
  - `data.attention[]` — ordered blockers / warnings
  - `data.availableActions[]` — board-level actions
  - `data.branches[]` — one row per active task + stale branches, with
    `lanes` (status per `Local | PR | Base | Staging | Production`),
    `cleanup`, `surfaces`, row-scoped `availableActions`
- `src/operator/api/actions.ts` — new. Action registry mapping stable
  action IDs to `{ preflight(cwd, flags), execute(cwd, flags, preflight) }`.
  Start with the 11 Rocketboard-compatible IDs that map to existing
  handlers (`handleNew`, `handleResume`, `handleDevmode`,
  `handleTaskLock`, `handlePr`, `handleMerge`, `handleDeploy`,
  `handleClean`).
- `src/operator/commands/helpers.ts` — add
  `generateConfirmToken(inputs)` and `verifyConfirmToken(token, inputs)`.
  HMAC over normalized inputs with a per-state-dir secret stored in
  `workflow-kit-state/api-secret`.
- `src/operator/index.ts` — wire `runOperator` to dispatch `api`
  commands to `api.ts`.
- `src/cli.ts` — no change (dispatch via `run api ...`).
- `package.json` (repo-level template in
  `templates/project-workflow.json` and the generated consumer
  `package.json`) — add `"workflow:api": "workflow-kit run api"`.
- `docs/WORKFLOW_API.md` — new. Pipelane's public contract doc,
  cross-linked from `docs/RELEASE_WORKFLOW.md`. Keep wire-compatible
  with Rocketboard's `docs/public/WORKFLOW_OPERATOR_API.md` and add a
  `Compatibility` section that pins to schemaVersion `2026-04-14`.
- `test/` — envelope schema tests, action-registry coverage,
  preflight/execute happy-path tests with a fake gh shim.

**Acceptance criteria.**
- `npm run workflow:api -- snapshot --json` in a consumer repo
  returns a wire-compatible envelope matching
  `WORKFLOW_OPERATOR_API.md`.
- `npm run workflow:api -- action merge --json` returns a preflight
  envelope with `data.preflight.requiresConfirmation = true` and a
  non-empty `confirmation.token`.
- `npm run workflow:api -- action merge --execute --confirm-token <t>
  --json` executes the merge only if the token matches preflight.
- The existing dashboard at `src/dashboard/server.ts` runs against
  workflow-kit itself (not just Rocketboard) with no dashboard-side
  changes.

**Effort.** 4–5 days. Largest chunk is snapshot.ts (lane computation).
**Depends on.** Nothing (but everything below depends on this).

---

### v0.1 — `DeployRecord` schema + state migration

**Goal.** Make deploy records per-task, verified-outcome-aware, and
idempotent. All other v0 work depends on this.

**Files touched.**
- `src/operator/state.ts:72-78` — extend `DeployRecord` interface
- `src/operator/state.ts` — bump stored schema version, add migration
  from v1 record shape; `saveDeployState` retains the historical array
  but filters out records missing `taskSlug` when used by the gate
- `src/operator/commands/deploy.ts:5-12` — update `findMatchingDeployRecord`
  to key on `(taskSlug, environment, sha, surfaces)` and require
  `status === 'succeeded'`
- `src/operator/commands/helpers.ts` — add `makeIdempotencyKey(env, sha, surfaces, taskSlug)`
- `test/` — add schema migration test

**Acceptance criteria.**
- `DeployRecord` adds `taskSlug`, `status`, `workflowRunId`,
  `verifiedAt`, `verification`, `rollbackOfSha`, `idempotencyKey`,
  `triggeredBy`, `failureReason` (see spec).
- Existing records on disk are readable and treated as
  `status: 'unknown'` by the gate (fail-closed).
- `findMatchingDeployRecord` only returns records with
  `status === 'succeeded'`.

**Effort.** 1 day.
**Depends on.** Nothing.

---

### v0.2 — `deploy.ts` polling + healthcheck verification

**Goal.** Stop firing-and-forgetting deploys. Watch the workflow run,
probe the healthcheck, stamp the record with verified outcome.

**Files touched.**
- `src/operator/commands/deploy.ts:53-74` — rewrite post-dispatch flow:
  1. Parse `workflowRunId` from `gh workflow run --json` output (or
     resolve via `gh run list --workflow=<name> --limit 5` matching on
     sha).
  2. Persist `status: 'requested'`.
  3. `gh run watch <id> --exit-status`.
  4. On success, probe `healthcheckUrl` twice, 10s apart, 2xx required.
  5. Stamp `status`, `verification`, `finishedAt`, `durationMs`,
     `verifiedAt`.
  6. Non-zero exit if `status !== 'succeeded'`.
- `src/operator/commands/deploy.ts` — add `--async` flag to opt out of
  watching (advanced use).
- `src/operator/release-gate.ts` — read `healthcheckUrl` from config.
- `test/` — integration test with mocked `gh` calls.

**Acceptance criteria.**
- Running `/deploy staging` blocks until the GH Actions run either
  succeeds (and healthcheck passes) or fails.
- `/deploy prod` hard-fails if the matching staging record's
  `status !== 'succeeded'` or `verification.statusCode >= 300`.
- Failures are recorded with `failureReason`.

**Effort.** 2–3 days.
**Depends on.** v0.1.

---

### v0.3 — `merge` action: SHA hardening + preflight/execute

**Goal.** Eliminate the silent mispromotion risk at `merge.ts:19-22`
and move confirmation to the token-bound preflight/execute pattern.

**Files touched.**
- `src/operator/commands/merge.ts:7-22` — after `gh pr merge`, poll
  `gh pr view --json mergeCommit,state` until `mergeCommit.oid` is
  present and `state === 'MERGED'`. Bound 30s, 1s interval. Fail
  closed if unresolved. Do not fall back to `git rev-parse origin/main`.
- `src/operator/api/actions.ts` — register `merge` action:
  - `preflight`: computes normalized inputs (PR number, title,
    mergedSha-to-be if resolvable, mode), returns
    `requiresConfirmation: true`, non-empty `confirmation.token`
    (HMAC of normalized inputs), and human-readable `summary`.
    In build mode, preflight's `summary` includes the implicit
    prod-deploy clause ("this will also deploy to production").
  - `execute`: verifies the confirm token matches, then runs
    `gh pr merge --squash --delete-branch` and the SHA-polling loop.
- `src/operator/commands/merge.ts:15` — direct interactive prompt
  remains as a terminal-friendly shim that calls preflight, prints
  `summary`, prompts `[y/N]`, and on confirm calls execute with the
  preflight's token. CI uses `--confirm-token <t>` to bypass TTY.
- `test/` — mock `gh` responses, assert fail-closed on missing
  `mergeCommit.oid`; token mismatch test; build-vs-release preflight
  text difference.

**Acceptance criteria.**
- No code path in `merge.ts` writes a `mergedSha` derived from
  `rev-parse origin/main`.
- `workflow:api action merge --execute` without a valid confirm-token
  rejects with `state: 'blocked'`.
- Direct `workflow:merge` CLI still works interactively.
- SHA poll timeout yields a clear error, not a silent wrong SHA.

**Effort.** 1 day.
**Depends on.** v0.0 (action registry, confirm-token helpers).

---

### v0.4 — `pr` action: staged-file preview + deny-list + preflight

**Goal.** Stop silent `git add -A`. Protect against committing
`.env`, `CLAUDE.md`, `*.pem`. Expose the preview as preflight data.

**Files touched.**
- `src/operator/commands/pr.ts:46-60` — before committing:
  - Run `git status --porcelain` and `git diff --stat`.
  - Build staged file list.
  - Hard-deny: `CLAUDE.md`, `.env`, `.env.*`, `*.pem`, `*.p12`,
    `id_rsa*`, `*.key`. Print blocked paths and instruct
    `--force-include <path>` to override.
- `src/operator/api/actions.ts` — register `pr` action:
  - `preflight`: returns `data.preflight.normalizedInputs` with
    `stagedFiles`, `blockedFiles`, `prePrCheckNames`, `prTitle`,
    `branchName`. Sets `requiresConfirmation: false` unless
    `blockedFiles.length > 0` (which requires a typed
    `--force-include <path>`, not a confirm-token).
  - `execute`: commits, pushes, and creates/updates the PR via
    `gh pr create`.
- `.project-workflow.json` — add `prPathDenyList` (extendable).
- `test/` — preflight deny-list detection; execute blocks commit when
  deny-list is non-empty without `--force-include`; `prePrChecks`
  continue to run with live stdio.

**Acceptance criteria.**
- A repo containing `CLAUDE.md` uncommitted does not silently commit
  it during `/pr`.
- The dashboard preflight endpoint returns `blockedFiles` to the UI
  so the operator sees the deny hit before clicking execute.
- CLI usage prints staged files and blockers and requires
  `--force-include` to override.

**Effort.** 1 day.
**Depends on.** v0.0.

---

### v0.5 — `deploy.prod` / `deploy.staging` actions: preflight/execute

**Goal.** Move deploy confirmation to the token-bound preflight/execute
pattern. Prod deploys require an explicit confirm-token that binds to
the exact sha/surfaces/env triple from preflight.

**Files touched.**
- `src/operator/api/actions.ts` — register `deploy.staging` and
  `deploy.prod`:
  - `preflight`: computes `normalizedInputs` (`sha`, `surfaces`,
    `environment`, `workflowName`, `lastStagingVerification` age for
    prod). Returns `requiresConfirmation: true` for `deploy.prod`
    (and hence a `confirmation.token`); `requiresConfirmation: false`
    for `deploy.staging`.
  - For `deploy.prod`, preflight enforces the same-SHA-from-staging
    gate (see v0.2). `allowed: false` + `state: 'blocked'` when the
    matching staging record's `status !== 'succeeded'`.
  - `execute`: verifies the confirm token, runs the v0.2 polling +
    healthcheck flow.
- `src/operator/commands/deploy.ts` — the terminal CLI shim: calls
  preflight, prints the summary (sha, surfaces, staging verification
  age), and for `prod` requires the operator to type the 4-char SHA
  prefix. The typed prefix is converted into the `--confirm-token`
  call to execute.
- `test/` — preflight blocked-state for stale staging; token mismatch
  rejection; typed-prefix shim end-to-end.

**Acceptance criteria.**
- An AI cannot deploy to prod by emitting a single `y`; it must either
  (a) issue preflight + echo the returned token on execute, or (b) type
  the 4-char SHA prefix interactively.
- `workflow:api action deploy.prod --execute` without a valid
  confirm-token rejects.
- Dashboard preflight returns rich `normalizedInputs` enough for the
  UI to render the confirm modal.

**Effort.** 1 day.
**Depends on.** v0.0, v0.2.

---

### v0.6 — `/status` cockpit V0 (envelope renderer)

**Goal.** Ship the stated #1 objective: one-screen terminal cockpit
that renders the `workflow:api snapshot` envelope. Same data as the
Branch Pipeline Board dashboard, zero derivation drift.

**Files touched.**
- `src/operator/commands/status.ts` — new command. **Does not** read
  `pr-state.json` / `deploy-state.json` / `gh` directly. Instead:
  1. Shells out to `workflow:api snapshot --json` in the current repo.
  2. Parses the envelope.
  3. Renders `data.attention[]` first, then `data.boardContext`
     (mode, base, overallFreshness), then `data.branches[]` grouped
     into active / recent / stale, then `data.sourceHealth[]`.
  - Color-maps the canonical 8-state vocabulary to terminal colors
    (same mapping documented in `docs/BRANCH_PIPELINE_BOARD.md` →
    now `docs/PIPELANE_BOARD.md`).
  - Renders the fixed 5-lane line per branch:
    `[Local] [PR] [Base: main] [Staging] [Production]` with state
    glyphs.
- `src/operator/commands/helpers.ts` — `renderLaneLine(laneRow)` and
  `renderStateGlyph(state)`.
- `src/cli.ts` — wire `status` subcommand.
- `package.json` — add `pipelane:status` / `workflow:status` script.
- `.project-workflow.json` — alias `status` default.
- `.claude/commands/status.md` — Claude slash.
- `templates/.claude/commands/status.md` — template for consumer repos.
- `src/operator/commands/new.ts:39` — soft warn when active-task count ≥ 3
  (reads `data.branches[].lanes.Local` from snapshot).
- `test/` — snapshot test against a fixture envelope.

**Acceptance criteria.**
- `npm run workflow:status` renders a single screen; 100% of its data
  comes from `workflow:api snapshot --json`.
- If the snapshot call fails, `/status` prints the envelope error
  message literally (no silent fallback to raw file reads).
- The same rendering is reproducible from a fixture JSON, enabling
  golden-file tests.
- `/status` runs in < 2s on a warm snapshot cache, < 5s cold.
- Colors degrade cleanly on non-TTY.
- Matches the state vocabulary and 5-lane order from the contract —
  same color/state language as the web dashboard.

**Effort.** 1.5 days (down from 2; envelope does the heavy lifting).
**Depends on.** v0.0 (this is a pure renderer of v0.0's output).

---

### v0.7 — `/clean` hardening

**Goal.** `/clean --apply` must never accidentally drop an in-flight
task.

**Files touched.**
- `src/operator/commands/clean.ts` — require `--task <slug>` or
  `--all-stale` when `--apply` is passed. Refuse to prune any lock
  with `updatedAt` within the last 5 minutes. Print exactly what is
  about to be removed before pruning.
- `test/` — refusal cases covered.

**Acceptance criteria.**
- `workflow:clean --apply` without a scope argument errors with a
  clear message.
- Locks newer than 5 minutes are never pruned.

**Effort.** 0.5 day.
**Depends on.** Nothing.

---

### v0.8 — Branch Pipeline Board: merge into Pipelane

**Goal.** Bring the dashboard implementation (currently on sibling
branches `codex/alias-dashboard-integration` /
`codex/pipeline-dashboard-v1` / `codex/dashboard-reference-design`)
into the same branch as the v0.0 `workflow:api` implementation so the
two ship together.

**Files touched.**
- Merge `src/dashboard/` (server.ts + public/index.html +
  src/dashboard/README.md) from the latest dashboard branch
  (currently `codex/alias-dashboard-integration` — commit `2e588c4`).
- `docs/BRANCH_PIPELINE_BOARD.md` → rename to `docs/PIPELANE_BOARD.md`
  and rewrite references from "Branch Pipeline Board" to "Pipelane
  Board" (the web cockpit of Pipelane).
- `src/dashboard/server.ts` — change default titles and subtitles
  (see v0.9 rename pass).
- Test wiring from the dashboard branch: `test/workflow-kit.test.mjs`
  gets the dashboard integration test block.
- `package.json` — keep the existing `"dashboard": "node ./src/cli.ts
  dashboard"` script.

**Acceptance criteria.**
- `npm run dashboard -- --repo .` (pointed at workflow-kit itself)
  connects and renders because v0.0 gives workflow-kit a
  `workflow:api` of its own.
- `npm run dashboard -- --repo /path/to/rocketboard` still works
  unchanged.
- The dashboard integration test passes in CI.

**Effort.** 0.5 day (merge + rename strings).
**Depends on.** v0.0 (no sense merging the adapter until workflow-kit
produces an envelope), v0.9 (rename pass catches the title strings).

---

### v0.9 — String-level Pipelane Board rename pass

**Goal.** Because pipelane.dev is registered and Pipelane is
committed, rename every instance of "Branch Pipeline Board" →
"Pipelane Board" and every default board-title string to use
"Pipelane" directly. This is a string-only pass; no package rename
yet (that's v2.1).

**Files touched.**
- `src/dashboard/server.ts` — `defaultDashboardSettings`:
  - `boardTitle`: `${repoName} Pipelane` (was `${repoName} Branch
    Pipeline Board`)
  - `boardSubtitle`: "Release cockpit for AI vibe coders. Branch
    pipeline triage, action preflight, execution follow-through, and
    cleanup discipline." (concise rewrite)
  - `DEFAULT_BOARD_SUBTITLE` constant updated.
- `src/dashboard/public/index.html` — rewrite hero copy and every
  literal "Branch Pipeline Board" reference. Update the landing copy
  about "Rocketboard's workflow:api" to "your repo's workflow:api
  contract" (it's repo-agnostic).
- `docs/BRANCH_PIPELINE_BOARD.md` → `docs/PIPELANE_BOARD.md`. Rewrite
  all references; redirect internal links in `README.md` and
  `docs/RELEASE_WORKFLOW.md`.
- `src/dashboard/README.md` — Pipelane Board references.
- `README.md` — one-liner intro swap.

**Acceptance criteria.**
- `grep -r "Branch Pipeline Board"` returns zero matches in the repo.
- Default dashboard title is `${repoName} Pipelane`.
- Existing user-written `~/.workflow-kit/dashboard/<slug>-<hash>.json`
  settings files still work (boardTitle is a user-overridable field).

**Effort.** 0.5 day.
**Depends on.** Nothing. Safe to do first if the dashboard branch
lands before v0.0.

---

### v0 summary

Total v0 effort: ~10–11 days (up from ~7–8 due to v0.0, v0.8, v0.9).

After v0 ships:

- Workflow-kit has its own `workflow:api` — wire-compatible with
  Rocketboard, consumable by the dashboard and every future client.
- The cockpit objective is delivered in two forms: CLI `/status` and
  web Pipelane Board, both reading the same envelope.
- Every mutating command is exposed through preflight/execute with
  confirm-token binding.
- Every deploy is verified end-to-end.
- Silent SHA mispromotion is closed.
- The product brand is "Pipelane" everywhere the operator sees a
  title.

---

## Phase v1 — Trust + recovery (following sprint)

### v1.1 — `rollback.*` actions

**Goal.** One command to recover from a bad deploy. Pipelane adds two
new action IDs to the contract: `rollback.staging` and `rollback.prod`.
`rollback.prod` joins the risky-set and requires a confirm-token.

**Files touched.**
- `src/operator/commands/rollback.ts` — new command:
  - Accept `staging|prod` + optional surfaces filter.
  - Find most recent `DeployRecord` where
    `environment=<env>, status='succeeded', verification.statusCode < 300`
    excluding the current failure.
  - Print the rollback summary (from/to SHAs, healthcheck at target).
  - Dispatch a new deploy with `rollbackOfSha = currentSha`, `sha = targetSha`.
  - Record the new DeployRecord with `rollbackOfSha` populated.
- `src/operator/api/actions.ts` — register `rollback.staging` and
  `rollback.prod`:
  - `preflight`: returns `normalizedInputs` (`fromSha`, `toSha`,
    `environment`, `surfaces`, `healthcheckAtTarget`). Sets
    `requiresConfirmation: true` for `rollback.prod`.
  - `execute`: verifies confirm-token, runs rollback.ts handler.
  - Add both to the documented risky-set alongside `deploy.prod`.
  - `--revert-pr` flag (release lane only): opens a
    `git revert <mergeCommit>` PR via `gh pr create`. Never pushes to
    main directly.
- `src/operator/commands/helpers.ts` — `findLastGoodDeploy(env, surfaces)`.
- `src/cli.ts` — wire `rollback` subcommand as a preflight/execute
  shim that prompts for typed SHA prefix (same pattern as v0.5).
- `package.json` — `pipelane:rollback` script.
- `.claude/commands/rollback.md`.
- `docs/WORKFLOW_API.md` — document the two new action IDs under the
  stable list; explicit note that Rocketboard does not implement them
  (Pipelane-only extension above the shared baseline).
- `test/` — rollback resolution logic, revert-PR generation,
  confirm-token binding.

**Acceptance criteria.**
- `/rollback prod` finds the last `succeeded` prod SHA and redeploys.
- New DeployRecord shows up in `/status` as a first-class ROLLBACK row.
- `--revert-pr` does not touch main; opens a PR only.
- Dashboard's `availableActions` exposes `rollback.prod` as a
  contextual action on any branch where a failed prod DeployRecord is
  the latest.

**Effort.** 2 days.
**Depends on.** v0.0, v0.1, v0.2.

---

### v1.2 — `doctor.*` actions

**Goal.** Replace the all-or-nothing release-check with a guided
config + probe flow. Kill `ready:true` as a stored primitive. Expose
both the diagnose and the probe as first-class actions so the
dashboard can run them from the UI.

**Files touched.**
- `src/operator/commands/doctor.ts` — new command:
  - Default: diagnose (read `CLAUDE.md` deploy config, report missing
    fields, detect platform via `package.json` deps, `.vercel/`,
    `fly.toml`, `netlify.toml`, `.github/workflows/*`).
  - `--fix`: interactive wizard. Ask staging URL, prod URL, workflow
    name, healthcheck path. Write the `## Deploy Configuration` block.
    Auto-run `--probe` after writing.
  - `--probe`: hit each `healthcheckUrl`, record HTTP status + latency
    in a `probeState.json`. Log failures.
- `src/operator/api/actions.ts` — register `doctor.probe` (safe;
  `requiresConfirmation: false`) and `doctor.fix` (safe but requires
  interactive inputs; preflight returns the current config fingerprint
  and the set of missing fields).
- `src/operator/api/snapshot.ts` — `sourceHealth[]` adds a
  `deployProbe` entry sourced from `probeState.json`. `boardContext`
  gains `releaseReadiness.probeState: healthy | stale | degraded`.
  When stale or degraded, `attention[]` gets a blocker row pointing at
  `doctor.probe`.
- `src/operator/release-gate.ts` — remove all `ready: true` checks.
  Replace with `probeState.json` freshness (<24h) + status check.
- `workflow/CLAUDE.template.md` — remove `"ready": false` fields.
- `CLAUDE.md` (template) — remove ready fields; add note that
  readiness is derived.
- `src/operator/commands/devmode.ts:54-74` — release lane now requires
  `probeState` freshness, not `ready:true`.
- `docs/WORKFLOW_API.md` — document the two new action IDs.
- `test/` — doctor diagnose fixtures, probe status cases, snapshot
  attention-row generation.

**Acceptance criteria.**
- `/doctor --fix` writes a valid `CLAUDE.md` deploy block for a fresh
  Vercel / Fly / Netlify / GH Actions repo in < 2 minutes.
- `/devmode release` no longer checks `ready:true`; checks probe state
  instead.
- Stale (>24h) probe state flips release lane to fail-closed **and**
  surfaces as a blocker in the dashboard's Attention column.
- Dashboard can run `doctor.probe` from a button and live-stream the
  output via the existing action-execution pipe.

**Effort.** 2 days.
**Depends on.** v0.0, v0.1.

---

### v1.3 — `TaskLock.nextAction`

**Goal.** Persistent breadcrumb for AI↔AI handoff across sessions.

**Files touched.**
- `src/operator/state.ts` — `TaskLock` interface adds
  `nextAction?: string`.
- `src/operator/commands/helpers.ts` — helper `setNextAction(slug, text)`.
- `src/operator/commands/pr.ts` — on success, set `nextAction =
  "PR #<n> open, awaiting CI"`.
- `src/operator/commands/merge.ts` — set `nextAction = "merged at
  <sha>, <next>"` where `<next>` is "deploy to staging" or "awaiting
  auto-deploy".
- `src/operator/commands/deploy.ts` — set `nextAction` after each
  stage.
- `src/operator/commands/status.ts` — render `nextAction` in the
  active-task row when present.
- `test/` — assertions around nextAction updates.

**Acceptance criteria.**
- Every state-mutating command updates `nextAction`.
- `/status` and `/resume` surface `nextAction` when the lock has one.

**Effort.** 0.5 day.
**Depends on.** v0.6.

---

### v1.4 — `/status --week / --stuck / --blast`

**Goal.** Collapsed ceremonies (shipped / retro / impact) as flags.

**Files touched.**
- `src/operator/commands/status.ts` — add flags:
  - `--week`: group DeployRecords by day for the last 7 days, compute
    throughput, p50 cycle time (`requestedAt → verifiedAt`), count of
    failures.
  - `--stuck`: list task locks with `updatedAt > 72h`, PRs merged
    with no matching DeployRecord, staging DeployRecords with no
    prod promotion after 48h.
  - `--blast <sha>`: compute `git diff --name-only <prev-prod-sha>..<sha>`
    and group changed files by surface (frontend / edge / sql)
    according to `.project-workflow.json` mapping.
- `.project-workflow.json` — add `surfacePathMap` for `--blast`.
- `test/` — flag rendering fixtures.

**Acceptance criteria.**
- Each flag is a clearly different view on the same data.
- No new subcommands added.

**Effort.** 1 day.
**Depends on.** v0.6, v0.1, v0.2.

---

### v1.5 — WIP soft warn + override confirmations

**Goal.** Prevent accidental scope explosion; make overrides auditable.

**Files touched.**
- `src/operator/commands/new.ts` — at start, load active locks. If
  count ≥ 3, print a soft warning ("you have N tasks in flight,
  oldest updated Xh ago; continue or /resume an existing task? [Y/n]").
  Never block.
- `src/operator/commands/devmode.ts` — `--override` now requires
  `--reason <text>` and writes both into `modeState.lastOverride`.
  `/status` surfaces a persistent `OVERRIDE ACTIVE` banner.
- `src/operator/state.ts` — `ModeState` adds
  `lastOverride?: { reason: string; setAt: string; setBy: string }`.
- `test/`.

**Acceptance criteria.**
- `/new` with 3+ active tasks prompts but does not block.
- Mode overrides are always accompanied by a recorded reason.

**Effort.** 0.5 day.
**Depends on.** Nothing.

---

### v1 summary

Total v1 effort: ~6 days.

After v1 ships:

- Rollback is one command.
- Deploy config is guided and truth-is-live, not honor-system.
- `/status` is information-dense enough for a weekly retro or a
  pre-deploy impact check.
- The AI↔AI handoff has a persistent breadcrumb.

---

## Phase v2 — Positioning + cuts

### v2.1 — Package-level rename: `workflow-kit` → `pipelane`

**Goal.** Finish what v0.9 started. Align the package name, bin, and
all generator output with the Pipelane brand. The product identity and
dashboard title are already Pipelane after v0.9; this phase flips the
package itself. `pipelane.dev` is already registered for docs / landing.

**Files touched.**
- `package.json` — `name: "pipelane"`, bin `pipelane`. Publish a
  deprecation-shim package at the old `workflow-kit` name that
  re-exports or execs pipelane for a transition period (2 minor
  versions).
- `bin/workflow-kit` → `bin/pipelane` (keep a 2-line shim at the old
  path that execs the new).
- `src/cli.ts` — help text says `pipelane`; accepts both.
- `src/operator/docs.ts` and template generators — swap
  `workflow:*` scripts to `pipelane:*` when initializing new repos.
  Existing repos keep `workflow:*` for one deprecation window;
  templates emit both names for two versions.
- `templates/project-workflow.json` — default aliases unchanged
  (user-visible `/new`, `/pr`, etc.).
- `README.md` — rename and rewrite the intro; "previously
  `workflow-kit`" callout. Link to `pipelane.dev`.
- `docs/RELEASE_WORKFLOW.md` — already on Pipelane.
- `docs/WORKFLOW_API.md` — keep the command name `workflow:api`
  (stable contract naming even though the package is renamed) and
  document the Rocketboard wire-compatibility commitment.
- `AGENTS.md`, `CONTRIBUTING.md` — rename references.
- `src/operator/state.ts` — state dir stays `workflow-kit-state` on
  disk for one release to avoid re-migrations; add a rename-on-next-write
  migration to `pipelane-state`.

**Acceptance criteria.**
- `npx pipelane init` works in a fresh repo.
- Existing repos using `workflow-kit` continue to work for 2 minor
  versions, with a deprecation notice.
- `npm run pipelane:status` is the primary documented surface.
- `pipelane.dev` resolves to the docs site (or a coming-soon landing
  built from the READMEs for v2.1 itself).

**Effort.** 1–1.5 days.
**Depends on.** v0 and v1 shipped (don't rename something users are
still actively trusting for correctness). v0.9 handles all the
user-visible strings ahead of this; v2.1 is the package/bin flip.

---

### v2.2 — Cut the Codex dual-install surface

**Goal.** Single source of truth for slash commands. Stop requiring
every Codex user to rerun `workflow:setup` on every alias change.

**Design decision.** Two paths; pick one and remove the other.

- **Path A (recommended): Codex loads the same repo-tracked
  `.claude/commands/*` files Claude uses.** Requires a small shim in
  Codex that reads `.claude/commands/` or
  `.codex/commands/` with the same markdown shape. If Codex can
  discover per-repo commands natively, use that. Kill
  `codex-install.ts` and the "every Codex user runs setup" paragraph
  that appears in 5 docs.
- **Path B: Repo-native `npm run pipelane:*` is the only surface;
  neither Claude nor Codex ship per-repo slash commands.** Slash
  commands become optional syntactic sugar; AI agents call the npm
  scripts directly.

**Files touched (path A).**
- `src/operator/codex-install.ts` — delete.
- `src/cli.ts` — remove `install-codex` subcommand.
- `src/operator/docs.ts` — remove Codex-specific install bullets.
- `README.md`, `AGENTS.md`, `CONTRIBUTING.md`,
  `docs/RELEASE_WORKFLOW.md` — cut the "Each Codex user does this"
  section. Replace with one line: "Codex and Claude both read
  `.claude/commands/*`; no per-user install."
- `templates/.claude/commands/*` — unchanged; now canonical for both
  clients.

**Acceptance criteria.**
- `README.md` no longer contains a "Each Codex user does this" section
  that requires machine-global install.
- Installing Pipelane in a new repo and opening it in Codex "just
  works" after `pipelane:setup`.

**Effort.** 1 day + 1 day of validation across Claude + Codex.
**Depends on.** v2.1, confirmation that Codex can read `.claude/commands`
or that a thin equivalent is acceptable (requires a Codex doc check).

---

### v2 summary

Total v2 effort: ~3 days.

After v2 ships:

- The product has a unique, ownable name (Pipelane) that names the
  core metaphor (build lane vs release lane).
- The dual-install story goes away. One install, one surface.

---

## Cross-cutting work

### Documentation updates

After each phase, update:

- `README.md` — command reference, install steps, user journeys.
- `AGENTS.md` — AI operator rules (new: must-run `/status` before
  `/new`; never flip `/devmode` without `--reason`; never bypass
  `/pr` deny-list silently).
- `docs/RELEASE_WORKFLOW.md` — flip `[v0]` / `[v1]` / `[v2]` markers
  to `[shipped]` as features land.
- `templates/*` — keep template files in lock step with source of truth.

### Tests

- Add integration tests that exercise the full lane journeys end to
  end with mocked `gh` output.
- Add a smoke test that verifies `/status` renders without crashing
  against an empty repo, a repo with only active tasks, a repo with
  only deploy history, and a repo with both.
- Add a failure-mode test: `merge.ts` SHA resolution timeout, mocked
  as `gh pr view` returning null `mergeCommit`.

### Rollout (per phase)

1. Ship behind the current name; feature-flag nothing — Pipelane is
   for solo builders, no flagging infrastructure needed.
2. Bump minor version on each phase boundary.
3. Update `CHANGELOG.md` with the user-visible behavior change.

---

## Priority summary (TL;DR)

| Phase | Focus | Days | Outcome |
|-------|-------|------|---------|
| v0 | Contract + correctness + visibility | ~10–11 | `workflow:api` ported from Rocketboard, CLI `/status` + web Pipelane Board both reading the same envelope, preflight/execute for every mutating action, verified deploys, silent-SHA bugs closed, Pipelane brand across all user-visible strings |
| v1 | Trust + recovery | ~6 | `rollback.*`, `doctor.*`, live probe, richer `/status`, action-wired for dashboard |
| v2 | Positioning + package rename | ~3 | Package renamed to `pipelane`, pipelane.dev live, Codex dual-install removed |

**If you only ship one phase**, ship v0. After v0, the tool delivers
on its two strongest objectives (visual pipeline + error-free release)
across both CLI and web surfaces — with one canonical contract — and
earns trust. Everything else is additive.

## First-move checklist

Because v0.9 (string rename to Pipelane) has no code dependencies and
pipelane.dev is already registered, it can land before or alongside
v0.0. Suggested order:

1. **v0.9** — one afternoon, string rename, ship the Pipelane brand.
2. **v0.0** — the load-bearing work; port `workflow:api` into workflow-kit.
3. **v0.8** — merge the dashboard branch in once v0.0 provides an
   envelope source.
4. **v0.1 → v0.7** — correctness fixes, now expressed as actions in
   the v0.0 registry.
5. **v1 phase** — rollback, doctor, nextAction, status flags,
   WIP + override.
6. **v2 phase** — package rename + Codex cut.
