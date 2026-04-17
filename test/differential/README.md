# Differential test harness

Side-by-side behavioral comparison between Pipelane's `pipelane run <cmd>`
and Rocketboard's `node scripts/workflow-operator.mjs <cmd>`.

**Purpose.** Phase 3 gate. Rocketboard is scheduled to swap its in-tree
operator for Pipelane in one atomic PR; the swap is only safe if Pipelane
emits the same wire-level behavior for the surfaces Rocketboard actually
depends on. This harness surfaces the deltas so they can be closed (in
step 6 correctness fixes) before the swap lands.

## Running

```bash
npm run test:differential
```

The harness skips cleanly if Rocketboard's operator is not available on
the local filesystem (default path:
`/Users/josephkim/dev/rocketboard/scripts/workflow-operator.mjs`). Override
with:

```bash
ROCKETBOARD_OPERATOR=/path/to/workflow-operator.mjs npm run test:differential
```

## What's covered today

- `api snapshot` — envelope shape, `schemaVersion`, `command`, `laneOrder`,
  canonical 8-state vocabulary usage; key-set divergence report.
- `api action` preflight for all 11 stable IDs — `action.id`,
  `action.risky`, `requiresConfirmation` match; risky actions issue a
  token in both implementations.

## What's NOT covered today (step 6 backlog)

Intentional divergences, expected to be closed by step 6 correctness
fixes:

- **`data.sourceHealth` entry set.** Rocketboard emits
  `git.local`, `github.prs`, `github.deploys`, `task-locks`,
  `release-readiness`. Pipelane today emits only `git.local` +
  `task-locks`. The `github.*` entries depend on a gh-sourced PR /
  deploy reader that Pipelane hasn't ported yet; `release-readiness`
  depends on the probe work in v0.2 / v1.2.
- **`releaseReadiness.state`.** Pipelane always reports `unknown`;
  Rocketboard computes based on local + hosted readiness. Closes when
  the probe-state work in v1.2 lands.
- **`attention[]`.** Pipelane emits `[]`. Rocketboard emits ordered
  blocker + info items (waiting for production deploy, dirty worktrees,
  stale locks, etc.). Closes incrementally as individual attention
  rules port over.
- **`availableActions[]` (board-level).** Pipelane emits `[]`.
  Rocketboard emits a ranked list (typically `devmode.*`, `clean.*`).
  Closes when the per-action `state` reasoning ports over.
- **Per-branch `availableActions`.** Same pattern — empty in Pipelane
  today.
- **Preflight normalizedInputs.** Pipelane's inputs are thin
  (operator-supplied flags). Rocketboard's include resolved values
  (merged-SHA-to-be, staging verification age, staged file list).
  Closes with step 6's merge SHA hardening, /pr deny-list preview,
  and deploy.prod same-SHA-from-staging gate.

## Adding a new differential

1. Drop a new `*.test.mjs` file into this directory.
2. Use `harness.mjs` helpers to set up a fixture and run both binaries.
3. Gate the test with `{ skip: !hasRocketboard && 'Rocketboard operator not available' }`.
4. Prefer **informational reports** (console log divergences) over hard
   asserts for anything outside the schema contract — step 6 closes
   real divergences; the harness only records them.

## Policy

- **Schema contract asserts (hard failures):** `schemaVersion`,
  `command`, `ok`, canonical lane-state vocab, `laneOrder`, per-action
  `risky` flag, token issuance for risky actions.
- **Informational (console log only):** missing/extra keys,
  state-value differences on individual cells, `label` differences,
  richness gaps in `sourceHealth` / `attention` / `availableActions`.

When Pipelane's behavior diverges **by design** from Rocketboard's
buggy behavior (e.g., the merge SHA hardening in v0.3), update the
harness's expectations in the same PR that ships the fix.
