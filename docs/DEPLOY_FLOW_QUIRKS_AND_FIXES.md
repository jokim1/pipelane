# Deploy-Flow Quirks and Fixes

**Source:** end-to-end ship of rocketboard PR #668 (wiki pin fix) on 2026-07-12 — `/new` → `devmode release` → `review` → `/pr` → `/merge` → `/deploy staging` → `/deploy prod` → `/clean`, driven non-interactively by a coding agent.
**Versions involved:** executing install `~/node_modules/pipelane` (v0.2.0, **stale dist** — see Q0); rocketboard pin `e4b0693`; pipelane HEAD `3b1c5b9` (47 commits ahead of the pin).

Every quirk below was hit live during that ship. Each entry has: what happened (verbatim where useful), root cause (file:line), status at HEAD, and the proposed change. The proposals only cover what is **not already fixed** at HEAD; things HEAD already fixed are marked as release/adoption work.

---

## Q0 (meta-quirk, P0): three pipelanes, zero version identity

**Observed.** The flow executed against `~/node_modules/pipelane`'s `dist/`, which is *older than the repo's own pin*:

| Where | Gate timeout (`DEFAULT_GATE_TIMEOUT_MS`) | Deploy onboarding check |
|---|---|---|
| Executing dist (`~/node_modules/pipelane/dist/operator/commands/review.js:15`) | **10 min** | worktree-root `.pipelane.json` / `package.json:pipelane` |
| Rocketboard pin `e4b0693` (`src/operator/commands/review.ts:58`) | 30 min | (same era) |
| HEAD `3b1c5b9` (`src/operator/commands/review.ts:65`) | 30 min | machine-local `~/.pipelane/repos/<hash>/config.json` |

The worktree resolved pipelane from the home directory because the shared repo `node_modules` had no pipelane installed at all (`npm ls pipelane` → `(empty)`), and `npx` walked up to `~/node_modules`. Nothing in any command output identifies which pipelane ran, from where, at which commit. Result: I spent real time working around bugs (Q3's 10-minute timeouts, Q2's per-worktree onboarding file) that newer pipelane had already fixed.

**Root cause.** No runtime version identity: dist embeds no build SHA; commands never print their resolved package path; there is no comparison against the host repo's `package.json` pin.

**Proposed change.**
1. Embed the build SHA + build timestamp in `dist/` at build time; expose via `pipelane --version` and in the first line of every `pipelane run <cmd>` invocation (`pipelane v0.2.0 (e4b0693) from ~/node_modules/pipelane`).
2. On startup, if the host repo's `package.json` pins `github:...#<sha>` and the running build's SHA differs, print a one-line warning (`running e12f3a9 but repo pins e4b0693 — run npm install / point npx at the repo install`). Warn, don't block.
3. Detect the stale-dist case in the dev repo itself: if `dist/` is older than the newest `src/` mtime at the resolved package, say so.

**Acceptance.** Any transcript of a pipelane run can answer "which code ran?" from its first line; a version-drifted machine warns on every command.

---

## Q1 (P1): task-lock mode snapshot vs. `devmode release` — the documented order breaks `/pr` and `/merge`

**Observed.**

```
Task lock mismatch.
- task is locked to mode build, current mode is release
```

`/new` snapshots the *current* dev mode into the task lock (`Mode: build` printed at creation). The rocketboard operator runbook's documented order is `workflow:new` **then** `workflow:devmode -- release`, which guarantees `lock.mode=build` vs `mode-state=release` for any task started while the machine idles in build mode. `task-lock` is verify-only (`state.ts:3545`: `task-lock requires exactly: pipelane run task-lock verify ...`); no command updates a lock's mode. The historical inverse trap also exists (release-locked task, `devmode release` fail-closed → can't get back → fully stuck; see rocketboard operator notes 2026-06-01).

**Workaround used.** Hand-edited `.git/pipelane-state/task-locks/fix-wiki-page-pinning.json` → `"mode": "release"`. Worked end-to-end, but hand-editing attested state files is exactly what pipelane elsewhere tries to prevent.

**Root cause.** `src/operator/repo-guard.ts:81` enforces `lock.mode === currentMode`, but the lock's mode is written once at `/new` and immutable thereafter, while `mode-state.json` is freely mutable via `devmode`. Two sources of truth with no reconciliation path.

**Status at HEAD.** Unfixed.

**Proposed change (pick one; first is preferred).**
1. **Make `devmode` reconcile active locks.** When `devmode <mode>` succeeds and the cwd (or `--task`) maps to a task lock, update that lock's mode in the same transaction and say so (`task lock fix-wiki-page-pinning: build → release`). Release direction stays gated behind the existing fail-closed readiness check, so this cannot be used to sneak past release gates.
2. Or add `task-lock update --task <slug> --mode <mode>` with the same readiness gating.
3. Or make `/pr`/`/merge` treat the mismatch as a *warning* when the current mode is release and release readiness passes (strictly stronger posture than the locked build mode).

**Acceptance.** The runbook order (`/new` → `devmode release` → `/pr`) works with zero manual state edits; the 2026-06-01 build/release deadlock is impossible to reproduce.

---

## Q2 (P1): deploy onboarding demanded a per-worktree `.pipelane.json`

**Observed.**

```
Pipelane is installed on this machine, but this repo is not onboarded yet: <worktree>
No .pipelane.json, .project-workflow.json, or package.json:pipelane block was found.
No deploy started.
```

`review`, `/pr`, and `/merge` all ran fine from the same worktree; only `/deploy` demanded the marker. The suggested remedy (`/init-pipelane` + `/pipelane configure`) is a guided re-setup for a repo that was already fully configured — deploy config actually lives in git-common state (`.git/pipelane-state/deploy-config.json`) shared by every worktree, plus the CLAUDE.md `## Deploy Configuration` block. Workaround: `echo '{"project": "Rocketboard"}' > <worktree>/.pipelane.json` (gitignored), after which deploy ran perfectly.

**Root cause (executing dist).** `onboarding.js` `buildMissingDeployOnboardingMessage` checks `resolveReadableConfigPath(repoRoot) || readPackageJsonOverlay(repoRoot)` where `repoRoot` = the worktree — a per-worktree file check for machine/repo-level state.

**Status at HEAD: fixed in design, needs verification + release.** Commits `e446364` ("keep pipelane config machine-local") and `ffae08e` ("repair deploy onboarding setup path") moved config to `~/.pipelane/repos/<sha256(commonDir)[:24]>/config.json` (`state.ts:1040-1050`, `resolveMachineRepoDirForCommonDir` at `state.ts:1523`), keyed by the git **common dir**, so all worktrees of a repo share one config and fresh worktrees are born onboarded.

**Remaining work.**
1. Release + install the machine-local-config build on operator machines (this is Q0's adoption path).
2. Migration: on first run, if the legacy `.pipelane.json`/`package.json:pipelane` exists but the machine-local config doesn't, import it automatically instead of reporting "not onboarded" (avoid re-breaking every repo that used the old scheme).
3. The error text should include the one-line non-interactive remedy alongside the guided one (`pipelane configure --json '...'` with a concrete example), since the primary caller is often an agent without a TTY.

**Acceptance.** A fresh `/new` worktree can `/deploy staging` with no extra files created; a repo onboarded under the old scheme is not asked to re-onboard.

---

## Q3 (P2 after Q0): review gate timeout — 10 minutes, one knob, wrong failure label

**Observed.** Three `pipelane run review` runs: `npm test` timed out once at exactly `600000ms` (suite takes 8–22 min on this machine depending on load), `codex exec` AI-diff gates timed out twice. Each timeout reports the gate as `FAILED (blocking)` — indistinguishable from a genuine failing verdict — and each retry re-runs *all* gates (~15+ min per retry).

**Root cause.** Executing dist had `DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000` with no env override and no per-gate `timeoutMs` in the default preset (`gate.timeoutMs ?? DEFAULT` at dist `review.js:1745`).

**Status at HEAD.** Default already raised to 30 min (`review.ts:65`) — adopting the current build (Q0) resolves the headline number.

**Remaining work.**
1. **Distinct `TIMEOUT` outcome** (vs `FAILED`) in the gate result + summary line, with remedy text ("re-run `pipelane run review --gate <id>`"), since the operator response differs completely (retry vs fix code).
2. **Per-gate `timeoutMs` in the default preset** (e.g. `test: 45m`, ai-diff: `30m`) plus an env escape hatch (`PIPELANE_REVIEW_GATE_TIMEOUT_MS`) consistent with the existing `PIPELANE_*_TIMEOUT_MS` family.
3. **Incremental re-run semantics:** confirm (and document) that `pipelane run review --gate <id>` merges with the latest full run's evidence for attestation purposes, so one timed-out AI gate costs one gate retry, not a full pipeline re-run. If it doesn't merge today, make it.

**Acceptance.** A timed-out gate is visually distinct from a failed verdict, re-runnable alone, and the timeout is configurable per gate without editing pipelane source.

---

## Q4 (P1): non-TTY prod deploy — silent re-preview, and a TTL sized for humans

**Observed.** `pipelane run deploy prod` correctly blocks without a TTY (`deploy.ts:1298-1307`, typed 4-char SHA prefix) and points to the API flow. The API flow then cost three round-trips:

1. `pipelane run api action deploy.prod --confirm-token <t>` (no `--execute`) **silently re-previewed and minted a new token** — no error that the token was ignored.
2. The 10-minute TTL (`api/confirm-tokens.ts:9`, `API_CONFIRMATION_TTL_MS`) expired between mint and execute because the driving agent's background-task round-trips ate the window: `Confirmation token expired. Run the preflight again.`
3. Success required scripting mint+execute in a single shell invocation, regex-extracting the token from undocumented envelope JSON.

**Root cause.** `parseApiActionFlags` (`api/actions.ts:~1349` at HEAD, unchanged) treats `--confirm-token` without `--execute` as a plain preview; nothing validates the combination. TTL is tuned for a human copy-pasting in one sitting, not for agent orchestration latency.

**Status at HEAD.** Unfixed.

**Proposed change.**
1. **Error on `--confirm-token` without `--execute`** (or treat it as implying `--execute`). A supplied token is an unambiguous statement of intent; silently discarding it is the worst of the options.
2. **Raise `API_CONFIRMATION_TTL_MS` to 30 min.** The token is single-use and fingerprint-bound to the exact inputs; the shorter TTL adds no meaningful safety but regularly loses the race against agent round-trips.
3. **Document the envelope + emit a machine line.** Add `--json` (or document the existing envelope schema) and print `PIPELANE_CONFIRM_TOKEN=<t>` on its own line in preflight output so callers don't regex nested JSON.
4. **Optional, explicit single-shot mode:** `--execute --auto-confirm`, gated behind `PIPELANE_ALLOW_AUTOCONFIRM=1`. The two-step is deliberate look-before-leap (preflight surfaces freshness/warnings for review), so auto-confirm must stay opt-in per machine — but for a driver that just ran `/deploy staging` and verified it, the second HMAC round-trip within one process is ceremony, not safety.

**Acceptance.** An agent can promote to prod in one documented command with no regex, no token races, and no silently-ignored flags — while a bare `--execute` (no token, no opt-in env) still refuses.

---

## Q5 (P1): task-scoped commands trust cwd — shared-checkout runs give confidently wrong guidance

**Observed.** After the session's working directory silently reverted from the task worktree to the shared checkout (which was 45 PRs behind with unrelated dirty files), `pipelane run merge` produced:

```
Rebase before creating, updating, or merging the PR so review only includes this task...
  - dirty local changes require --title before creating a PR
```

Both statements were about the *shared checkout*, not the task: the PR branch was zero commits behind `origin/main` and its worktree was clean. An operator following that guidance would have rebased/`--title`'d the wrong thing. Re-running the identical command from the worktree merged cleanly.

**Root cause.** `buildStaleBaseBlockerForRepo` (`src/operator/commands/helpers.ts:220-245`) runs `inspectBaseDrift(options.repoRoot, baseBranch)` where `repoRoot` derives from cwd; the dirty-file check likewise inspects cwd. Task-scoped commands *know* the task (the lock stores `worktreePath` and `branchName`) but never cross-check that they're running in it.

**Status at HEAD.** Unfixed.

**Proposed change.**
1. For `pr`/`merge`/`deploy` with a resolvable task (explicit `--task`, or unique in-flight lock): resolve the lock **first**; if `resolveRepoRoot(cwd) !== lock.worktreePath`, hard-error with the exact path to `cd` to (mirroring `/new`'s "Chat has not moved" guardrail). Do not evaluate drift/dirtiness of a checkout the task doesn't live in.
2. Where drift *is* the right check, compare the task's branch against `origin/<base>` — not the cwd checkout's HEAD.

**Acceptance.** Running `merge` from the wrong checkout names the right directory and takes no measurements there; it can never recommend rebasing a checkout that isn't the task's.

---

## Q6 (P3): `devmode release` fail-closed on stale probes it could just refresh

**Observed.** `devmode release` refused with `edge/sql staging probe is stale: probe is 35h old (>24h threshold). Re-run /doctor --probe.` The remedy is a read-only healthcheck sweep that pipelane itself runs in ~3 s.

**Root cause.** `PROBE_STALE_MS = 24h` (`state.ts:776`) gates release readiness (`release-gate.ts`), but `devmode` only *reports* staleness rather than refreshing it.

**Proposed change.** When the only release blockers are stale probes, `devmode release` should run the probe inline (it is side-effect-free) and proceed on success, printing the refreshed results. Keep the failure mode identical when probes actually fail.

**Acceptance.** `devmode release` on a healthy-but-idle machine succeeds in one command.

---

## Priority and sequencing

| # | Quirk | Fix lives in | Priority | Note |
|---|---|---|---|---|
| Q0 | No version identity / stale global install | build + CLI banner | **P0** | Multiplies every other quirk; also the *adoption vehicle* for Q2/Q3 fixes already at HEAD |
| Q1 | Lock-mode snapshot vs devmode | `devmode` / task-lock | **P1** | Documented runbook order is self-breaking today |
| Q5 | cwd-trusting task commands | `helpers.ts` + command preamble | **P1** | Produces actively wrong guidance; agent drivers hit cwd resets |
| Q4 | Confirm-token ergonomics | `api/actions.ts`, `confirm-tokens.ts` | **P1** | Non-TTY prod deploy is the normal case for agent operators |
| Q2 | Per-worktree onboarding | released at HEAD | **P2** | Ship Q0; add legacy-config auto-import + better error text |
| Q3 | Gate timeout | partially at HEAD | **P2** | Ship Q0; add TIMEOUT status, per-gate config, single-gate re-run |
| Q6 | Probe staleness UX | `devmode` | **P3** | One-command quality-of-life |

Suggested order: **Q0 → Q1 → Q5 → Q4**, then fold Q2/Q3 remainders into the Q0 release, Q6 whenever convenient.

---

*Full session evidence (verbatim gate outputs, review-state records, token expiry timestamps) lives in the rocketboard operator session of 2026-07-12; state file citations: `.git/pipelane-state/{task-locks,review-state.json,mode-state.json,deploy-config.json}`.*
