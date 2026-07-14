# `pipelane run api` — Pipelane operator contract

This is the machine-readable surface every Pipelane consumer (CLI `/status`,
the Pipelane Board, editor integrations, dashboards) reads from. It is the
**single source of truth** for workflow state — slash commands, the web
board, and the terminal cockpit all derive from the same envelope.

Four commands:

```bash
pipelane run api snapshot [--json]
pipelane run api branch --branch <branch> [--json]
pipelane run api branch --branch <branch> --patch --file <path> [--scope branch|workspace] [--json]
pipelane run api action <actionId> [--execute] [--confirm-token <t>] [--json]
```

`--json` is assumed by programmatic callers; human-facing renderers also
accept `--text`. Every response is an `ApiEnvelope` (see below).

## Envelope shape

```jsonc
{
  "schemaVersion": "2026-04-25",
  // command is "pipelane.api.snapshot" or "pipelane.api.action"
  "command": "pipelane.api.snapshot",
  "ok": true,
  "message": "",
  "warnings": [],
  "issues": [],
  "data": { /* command-specific */ }
}
```

The `schemaVersion` is bumped only on additive-breaking changes — readers
that ignore unknown fields parse every revision transparently. See
`src/operator/api/envelope.ts` for the current canonical types.

### Lane states

`LaneState` is the shared vocabulary every status cell + action report uses:

| State | Meaning |
|-------|---------|
| `healthy` | Lane is live and current. |
| `running` | Work in flight (PR open, deploy pending, etc.). |
| `blocked` | Something failed and blocks downstream work. |
| `degraded` | Signal observed but unhealthy (e.g. probe returned 5xx). |
| `stale` | Data exists but past its freshness window. |
| `unknown` | No observation on record. |
| `bypassed` | Intentionally skipped (e.g. staging in `build` mode). |
| `awaiting_preflight` | Lane is waiting on upstream work. |

## `snapshot` data

`data` carries the full board state:

- `boardContext.mode` — `build` | `release`.
- `boardContext.baseBranch` — default branch (typically `main`).
- `boardContext.laneOrder` — column order for UI rendering.
- `boardContext.releaseReadiness` — release-gate rollup. Notable fields:
  - `state`, `reason`, `message`
  - `requestedSurfaces` / `blockedSurfaces`
  - `effectiveOverride` — currently-active gate override (`null` when none).
  - `lastOverride` — durable audit of the most-recent override.
  - `probeState` — rollup of per-surface staging probes: one of
    `healthy | degraded | stale | unknown`. See `doctor.probe` below.
- `boardContext.activeTask` / `overallFreshness`.
- `review.current` is evidence for the current checkout only; `review.recent`
  is branch history and must not be treated as current. `review.latest` remains
  a compatibility alias for `review.current` through the 0.2.x line and is
  removed in 0.3.0.
- `review.current.presentation` and `review.recent.presentation` are derived,
  control-safe display data. They include the relation (`current` or `recent`),
  checkout identity, gate and finding counts, every structured finding,
  protocol errors, bounded report/diagnostic text when applicable, and a next
  action only for actionable current evidence. Recent history never supplies a
  current-checkout action, and the projection never changes evidence status.
- `review.enforcementMode`, `review.policyVersion`, and
  `review.blockingGateIds` describe the current configured contract so clients
  can distinguish an upgrade mismatch from current evidence without guessing.
- Strict review records may add `taskBindingId`, `intent`, `target`, per-gate
  `capability`, `result`, `findings`, and `reportArtifact`. These fields are
  additive. Consumers must not infer a clean result when `findingsKnown` is
  false, and must preserve `bypassed` separately from `passed`.
- `sourceHealth[]` — per-source liveness cells. Always includes
  `git.local` and `task-locks`; v1.2 adds one entry per configured staging
  probe surface (e.g. `deployProbe.frontend`, `deployProbe.edge`,
  `deployProbe.sql`).
- `attention[]` — `ApiIssue` list. Each entry carries `action` pointing at
  the action ID the operator should invoke to resolve it (e.g.
  `doctor.probe` when a staging surface is stale or degraded).
- `availableActions[]` — unblocked actions for the active branch.
- `branches[]` — per-branch rows with `lanes.{local,pr,base,staging,production}`.
- `branches[].cleanup` — cleanup assessment for the branch task lock. `tag:
  "stale"` means `/clean --apply --all-stale` has objective evidence to prune
  the lock, such as a missing worktree or missing branch.

## `branch` data

`branch --branch <name>` returns the selected `BranchRow` plus lazy-loaded file
lists for the committed branch diff and the live workspace diff:

- `data.branch` — the same branch row shape returned in `snapshot`.
- `data.branchFiles[]` — committed diff against the configured base branch.
- `data.workspaceFiles[]` — working tree diff against `HEAD`, plus untracked files.
- `data.counts` — file list counts for both scopes.

`branch --patch` returns a single patch preview:

- `data.branch` — branch name
- `data.path` — requested file path
- `data.scope` — `branch` or `workspace`
- `data.patch` — unified diff text when available
- `data.truncated` — whether the preview hit the size cap
- `data.reason` — explanation when the patch is unavailable

## `action` data — the action registry

Every mutating workflow step is exposed as a stable action ID. Callers
`action <id>` with no flags to get the **preflight** (state, reason,
whether a confirm token is required); `action <id> --execute` with the
returned token to actually run it.

Risky actions (`merge`, `deploy.prod`, `route.merge`,
`route.deploy.staging`, `route.deploy.prod`,
`clean.apply`, `rollback.prod`) always require a fresh confirmation token.
`pr` remains non-risky in the normal path, but a task-binding recovery choice
returns a confirmation token so the selected checkout and fingerprint are
consumed atomically. Other non-risky actions complete in one call.

| Action ID | Risky? | Purpose |
|-----------|--------|---------|
| `new` | no | Create a task workspace (branch + worktree). |
| `resume` | no | Reopen an existing task workspace. |
| `devmode.build` | no | Switch to build mode. |
| `devmode.release` | no | Switch to release mode. |
| `taskLock.verify` | no | Revalidate the current branch's task lock. |
| `pr` | no | Prepare or refresh the PR. |
| `merge` | **yes** | Squash-merge the PR and delete the branch. |
| `deploy.staging` | no | Deploy the merged SHA to staging. |
| `deploy.prod` | **yes** | Deploy the merged SHA to production. |
| `route.merge` | **yes** | Run the remaining destination route steps through merge. |
| `route.deploy.staging` | **yes** | Run the remaining destination route steps through staging deploy. |
| `route.deploy.prod` | **yes** | Run the remaining destination route steps through production deploy. |
| `clean.plan` | no | Preview workspace cleanup. |
| `clean.apply` | **yes** | Apply stale workspace cleanup with an explicit scope such as `allStale`. |
| `doctor.diagnose` | no | Read machine-local deploy config, detect platform, list missing config + probe status. |
| `doctor.probe` | no | Hit every configured staging healthcheck URL and persist the result to `probe-state.json`. |
| `rollback.staging` | no | Redeploy the last verified-good SHA to staging (Pipelane-only). |
| `rollback.prod` | **yes** | Redeploy the last verified-good SHA to production (Pipelane-only). |

Preflight may return `needsInput: true` with `inputs[]`. Inputs have
`type: "text" | "boolean" | "choice"`. Choice inputs include `options[]`
with `{ value, label, description, params? }`; clients should merge `params`
into the next preflight request after the user selects that option. This is
how `/pr` presents safe task-binding recovery choices such as "use current
checkout" (only from a task-owned branch) or "continue the attached task
workspace" without showing hidden recovery flags.

Preflight for `pr`, task-branch `merge`, and route actions that would run
`/pr` or `/merge` refreshes `origin/<base>` and returns `allowed:false` when
the checkout is behind the configured base branch. Clients should surface the
reason and have the operator rebase before retrying, rather than confirming
or executing a stale route.

When review evidence blocks one of those actions, `preflight.review` contains
the same typed presentation used by `/status` and the board. Clients should
render all relevant findings and protocol errors before the recovery and
exact-scope bypass choices in `preflight.reason`. A bypass remains consent for
that scope; it does not change a failed or pending gate to passed.

`doctor.fix` is intentionally **not** exposed as an API action — it is
interactive (TTY prompts for platform + URLs) and lives behind
`pipelane run doctor --fix`. Scripted config goes through
`pipelane configure --json=...` instead.

`rollback.*` are **Pipelane-only** extensions above the base action set.
Both actions take `{ task, surfaces }` as
`normalizedInputs`. Target SHA resolves server-side from the deploy
state: the most recent `status=succeeded, verification.statusCode<300`
record for the (environment, surfaces) pair, excluding the currently
failing SHA. `--revert-pr` (CLI-only, release mode only) is an
orthogonal path that opens a `git revert <mergeCommit>` PR via gh —
it's not exposed as an API action because PR-open from a long-lived
board/CI shell needs conflict handling that lives behind the TTY today.

## `probe-state.json` (v1.2)

Location: `$PIPELANE_HOME/repos/<repo-key>/state/probe-state.json`.

Written by `doctor.probe` and `doctor.fix` (which runs a probe after
updating the deploy-config block). Read by the release gate as a
freshness check alongside observed-staging-success: a surface must have a
successful probe newer than `PROBE_STALE_MS` (24 hours) before the gate
green-lights production promotion for that surface.

```jsonc
{
  "records": [
    {
      // "staging" or "production"
      "environment": "staging",
      // "frontend", "edge", or "sql"
      "surface": "frontend",
      "url": "https://staging.example.com/healthz",
      "ok": true,
      // number on reach, null on network-level failure (DNS, refused, timeout)
      "statusCode": 200,
      "latencyMs": 42,
      // absent on success; populated with "HTTP 5xx" or the network error message on failure
      "error": "HTTP 502",
      "probedAt": "2026-04-19T18:00:00.000Z"
    }
  ],
  "updatedAt": "2026-04-19T18:00:00.000Z"
}
```

Records are keyed on `(environment, surface)`. Partial re-probes (one
surface at a time) merge on top of the previous snapshot — previously
probed surfaces are preserved until `doctor.probe` replaces them.

Probe freshness rollup (`boardContext.releaseReadiness.probeState`):

- `healthy` — every configured staging surface has an OK probe within
  `PROBE_STALE_MS`.
- `degraded` — at least one surface's most recent probe failed.
- `stale` — at least one surface has a probe older than 24 hours.
- `unknown` — no probes recorded yet, or no probe targets configured.

`degraded` surfaces show up in `sourceHealth[]` with `state: 'degraded'`
and in `attention[]` with `action: 'doctor.probe'`. `stale` surfaces
emit warnings; `healthy` and `unknown` stay silent — the release gate's
missing-probe messaging handles the "never probed" case directly.

## `/status --week / --stuck / --blast` (v1.4)

`/status` accepts three mutually-exclusive view flags that produce
alternate data views over the same state the cockpit summarizes. Only
one may be passed per call; passing two throws. `--json` is respected
by every view and produces a structured payload (shape described
below).

- `--week` — groups `DeployRecord` entries into the 7 UTC days ending
  at today's UTC date. Every `days[]` entry has `succeeded`, `failed`,
  and `p50CycleMs` (verifiedAt − requestedAt across succeeded + verified
  deploys). `totals` covers the full window plus `distinctShas`. The
  window is UTC-midnight-aligned so wall-clock-`now` invocations emit a
  stable 7-element `days[]` array.
- `--stuck` — surfaces operator-actionable drift: release-mode task
  locks strictly idle >72h, merged PRs (last 14 days) with no
  DeployRecord for their `mergedSha`, and staging DeployRecords
  without a matching `succeeded` prod promotion for the same sha after
  48h.
- `--blast <sha>` — runs `git diff --name-only -z <base>..<sha>` and
  groups files by `surfacePathMap`. The base anchor is the most recent
  succeeded prod DeployRecord sha if one exists (tag `prod-deploy`),
  otherwise the repo's `baseBranch` — first trying local HEAD, then
  `origin/<baseBranch>` — and finally `merge-base(HEAD, sha)` as a
  last resort for fresh clones. Files that don't match any mapped
  prefix fall to `other`. Accepts any rev-parseable ref; passing a
  flag-shaped arg (`--json`, `-x`) errors instead of silently
  swallowing it.

### Repo-owned deploy surface contract (optional)

A GitHub Actions workflow can bind its accepted deployment surfaces to a
tracked JSON manifest with a top-level comment:

```yaml
name: Deploy Hosted
# pipelane-surface-contract: .github/deploy-surfaces.json
```

The versioned manifest is the source of truth for both the deploy surface list
and path attribution:

```json
{
  "version": 1,
  "workflow": "Deploy Hosted",
  "surfaces": {
    "frontend": ["src/", "public/"],
    "sql": ["supabase/migrations/"],
    "mcp": ["packages/mcp-server/"]
  }
}
```

`pipelane configure` discovers custom surfaces from the contract and registers
them in machine-local workflow and deploy configuration. `/doctor`, direct
deploy, and destination planning fail closed if the contract is malformed or a
declared custom surface is not configured. For implicit deploys, the target
commit is classified from this manifest before any stored task-lock surfaces;
the workflow dispatch therefore receives the surfaces affected by the actual
target diff. Deploy and blast views read the contract from the target SHA,
falling back to the configured base branch for an older PR that predates the
manifest. This keeps release planning correct even when the PR worktree itself
has not been rebased. Explicit `--surfaces` remains available for intentionally
manual deployments, but does not bypass an invalid or incompletely configured
contract.

The tracked contract overrides machine-local path entries for surfaces it
declares. Machine-local entries for unrelated surfaces remain available.

### `surfacePathMap` machine-local config (optional, v1.4+)

Opt-in map consumed by `--blast` and by deploy preflight when the
operator does not pass `--surfaces`. Keys are surface names (typically
entries from `surfaces`), values are POSIX directory prefixes or exact
filenames matched against `git diff --name-only` output. It is stored in
`$PIPELANE_HOME/repos/<repo-key>/config.json`, not in repo-local config.
Example:

```json
{
  "surfacePathMap": {
    "frontend": ["src/frontend/", "web/"],
    "edge": ["src/edge/"],
    "sql": ["supabase/", "migrations/"]
  }
}
```

Empty / absent = `--blast` still runs; every file lands in the `other`
bucket and the render adds a one-line hint pointing at this key. Deploy
keeps the pre-v1.4 stored-surface behavior when the map is absent. When
the map is present and a target commit cannot be inspected, or contains
files that do not match it, direct deploys and destination route preflight
block instead of falling back to stale task or mode surfaces; pass
`--surfaces` to opt out for an intentionally manual deployment.
Unknown keys inside the map are accepted by config normalization — the key
string is the surface label. Deploy preflight still requires inferred
surface labels to exist in `surfaces`. Non-string-array values are dropped
by `normalizeWorkflowConfig`; an all-invalid map collapses to `undefined`.
Patterns are normalized to POSIX separators (backslashes are rewritten
to forward slashes) so Windows-authored maps match git's forward-slash
path output.

When two surfaces overlap on the same file, the file is assigned to both.
This makes shared lockfiles, workflow definitions, and deployment metadata
expand the deploy set instead of silently selecting only one affected surface.

## Compatibility

- Envelope schema is additive-only within a `schemaVersion`. New fields may
  appear in any minor bump; readers must ignore unknown fields.
- `STABLE_ACTION_IDS` is append-only. Removing or renaming an ID is a
  breaking change and bumps the schema version.
- Lane states in `CANONICAL_LANE_STATES` are append-only.

### Deploy Configuration schema

Deploy configuration is saved in machine-local Pipelane state by
`pipelane configure`. It is versioned independently of the envelope schema:

- **v1.2 removal:** `frontend.staging.ready`, `edge.staging.ready`, and
  `sql.staging.ready` were dropped. Release readiness derives from
  observed staging deploys + `doctor.probe` freshness now.
  migrated readers silently strip `.ready` from older payloads on load.
- **v1.2 CLI flag removals:** `pipelane configure --frontend-staging-ready`,
  `--edge-staging-ready`, and `--sql-staging-ready` error loudly on
  invocation. Scripts carrying the flags fail fast; there is no
  deprecation window.
- **Additional deploy surfaces:** custom surfaces live under
  `surfaces.<name>.staging` and `surfaces.<name>.production`, each with
  `deployCommand`, `verificationCommand`, and `healthcheckUrl` fields.
  Built-in names (`frontend`, `edge`, `sql`) keep their dedicated schema and
  cannot be shadowed through `surfaces`. `mcp` can be configured with the
  `--mcp-*` aliases; arbitrary surfaces use
  `--surface-staging-*=<surface>:<value>` and
  `--surface-production-*=<surface>:<value>`.

Source: `src/operator/api/envelope.ts`, `src/operator/api/actions.ts`,
`src/operator/api/snapshot.ts`, `src/operator/release-gate.ts`.
