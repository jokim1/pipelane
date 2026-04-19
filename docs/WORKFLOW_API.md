# `workflow:api` — Pipelane operator contract

This is the machine-readable surface every Pipelane consumer (CLI `/status`,
the Pipelane Board, editor integrations, dashboards) reads from. It is the
**single source of truth** for workflow state — slash commands, the web
board, and the terminal cockpit all derive from the same envelope.

Two commands:

```bash
npm run workflow:api -- snapshot [--json]
npm run workflow:api -- action <actionId> [--execute] [--confirm-token <t>] [--json]
```

`--json` is assumed by programmatic callers; human-facing renderers also
accept `--text`. Every response is an `ApiEnvelope` (see below).

## Envelope shape

```jsonc
{
  "schemaVersion": "2026-04-18",
  // command is "workflow.api.snapshot" or "workflow.api.action"
  "command": "workflow.api.snapshot",
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
- `sourceHealth[]` — per-source liveness cells. Always includes
  `git.local` and `task-locks`; v1.2 adds one entry per configured staging
  probe surface (e.g. `deployProbe.frontend`, `deployProbe.edge`,
  `deployProbe.sql`).
- `attention[]` — `ApiIssue` list. Each entry carries `action` pointing at
  the action ID the operator should invoke to resolve it (e.g.
  `doctor.probe` when a staging surface is stale or degraded).
- `availableActions[]` — unblocked actions for the active branch.
- `branches[]` — per-branch rows with `lanes.{local,pr,base,staging,production}`.

## `action` data — the action registry

Every mutating workflow step is exposed as a stable action ID. Callers
`action <id>` with no flags to get the **preflight** (state, reason,
whether a confirm token is required); `action <id> --execute` with the
returned token to actually run it.

Risky actions (`merge`, `deploy.prod`, `clean.apply`) always require a
fresh confirmation token. Non-risky actions complete in one call.

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
| `clean.plan` | no | Preview workspace cleanup. |
| `clean.apply` | **yes** | Apply workspace cleanup (delete branches/worktrees). |
| `doctor.diagnose` | no | Read CLAUDE.md, detect platform, list missing config + probe status. |
| `doctor.probe` | no | Hit every configured staging healthcheck URL and persist the result to `probe-state.json`. |

`doctor.fix` is intentionally **not** exposed as an API action — it is
interactive (TTY prompts for platform + URLs) and lives behind
`npm run workflow:doctor -- --fix`. Scripted config goes through
`pipelane configure --json=...` instead.

## `probe-state.json` (v1.2)

Location: `<commonDir>/workflow-kit-state/probe-state.json`.

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

### `.project-workflow.json:surfacePathMap` (optional, v1.4+)

Opt-in map consumed by `--blast`. Keys are surface names (typically
entries from `surfaces`), values are POSIX directory prefixes or exact
filenames matched against `git diff --name-only` output. Example:

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
bucket and the render adds a one-line hint pointing at this key.
Unknown keys inside the map are accepted — the key string is the
surface label. Non-string-array values are dropped by
`normalizeWorkflowConfig`; an all-invalid map collapses to `undefined`.
Patterns are normalized to POSIX separators (backslashes are rewritten
to forward slashes) so Windows-authored maps match git's forward-slash
path output.

When two surfaces overlap on the same file, the alphabetically-earlier
surface name wins. Design your map so patterns don't overlap if that
matters for your use case.

## Compatibility

- Envelope schema is additive-only within a `schemaVersion`. New fields may
  appear in any minor bump; readers must ignore unknown fields.
- `STABLE_ACTION_IDS` is append-only. Removing or renaming an ID is a
  breaking change and bumps the schema version.
- Lane states in `CANONICAL_LANE_STATES` are append-only.

### Deploy Configuration schema (CLAUDE.md)

The `## Deploy Configuration` JSON block in each consumer's local
`CLAUDE.md` is a separate machine-readable surface. It is versioned
independently of the envelope schema:

- **v1.2 removal:** `frontend.staging.ready`, `edge.staging.ready`, and
  `sql.staging.ready` were dropped. Release readiness derives from
  observed staging deploys + `doctor.probe` freshness now.
  `parseDeployConfigMarkdown` silently strips `.ready` from older blocks
  on load; `renderDeployConfigSection` never emits it.
- **v1.2 CLI flag removals:** `pipelane configure --frontend-staging-ready`,
  `--edge-staging-ready`, and `--sql-staging-ready` error loudly on
  invocation. Scripts carrying the flags fail fast; there is no
  deprecation window.

Source: `src/operator/api/envelope.ts`, `src/operator/api/actions.ts`,
`src/operator/api/snapshot.ts`, `src/operator/release-gate.ts`.
