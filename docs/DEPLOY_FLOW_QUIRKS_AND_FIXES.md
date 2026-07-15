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

## Audit round 2

Audit date: 2026-07-12. The sweep covered the task lifecycle commands, API
actions and confirmation tokens, onboarding, release readiness, and shared
state resolution. It specifically checked cwd trust, snapshot/live-state
reconciliation, flag consumption, agent-latency timeouts, remediation text,
and non-TTY execution paths.

### Fixed in this PR

1. **API task actions could bypass the cwd guard (P1).**
   **Location:** `src/operator/api/actions.ts:173` and
   `src/operator/api/actions.ts:646`. **Repro:** preflight or execute
   `api action merge`/`deploy.prod` from the shared checkout while the
   resolvable task lock points at another worktree; the API used to plan and
   measure the caller checkout even though the direct command was guarded.
   **Proposed fix (implemented):** resolve and validate the task worktree
   before route planning, freshness checks, token minting, or execution.

2. **API actions accepted flags that were ignored or failed only after a
   successful preflight (P2).** **Location:**
   `src/operator/commands/api.ts:52` and `src/operator/commands/api.ts:92`.
   **Repro:** `api action doctor.diagnose --title x` silently discarded the
   title; `api action deploy.prod --reason x` could preview successfully but
   the underlying `deploy` rejects `--reason`. **Proposed fix (implemented):**
   use an action-specific allowlist and reject unsupported inputs before
   preflight. This new hard error is a compatibility-safe bugfix because the
   rejected values could never affect a successful action.

3. **Route preflight swallowed destination-planner errors (P2).**
   **Location:** `src/operator/api/actions.ts:908`. **Repro:** request
   `route.deploy.staging --surfaces worker` when `worker` is unsupported; the
   envelope said only `route could not be planned`. **Proposed fix
   (implemented):** retain the sanitized caught error and expose it through
   `routeBlockers`, while keeping the preflight fail-closed.

4. **`repo-guard --mode` could create an invalid or divergent lock snapshot
   (P1).** **Location:** `src/operator/commands/repo-guard.ts:32` and
   `src/operator/state.ts:3635`. **Repro:** in build mode, run
   `repo-guard --task x --mode release`; this could write a release lock
   without running release readiness. Arbitrary strings were also accepted.
   **Proposed fix (implemented):** validate the enum and reject divergence
   with the minimal `devmode <mode>` remedy, so the release transition still
   goes through its fail-closed check.

5. **PR binding recovery told headless callers to “type” a choice even though
   no prompt was reading input (P2).** **Location:**
   `src/operator/task-binding.ts:385`. **Repro:** create a lock/current-branch
   binding conflict and run `pr` without `--recover`; an agent can wait for a
   prompt that does not exist. **Proposed fix (implemented):** print complete,
   fingerprint-bound recovery commands and explicitly state that no
   interactive prompt is waiting.

6. **A malformed confirmation expiry became non-expiring (P1).**
   **Location:** `src/operator/api/confirm-tokens.ts:158`. **Repro:** replace a
   stored token's `expiresAt` with `not-a-date`; `NaN < Date.now()` is false,
   so the old check accepted it. **Proposed fix (implemented):** reject every
   non-finite parsed expiry as expired before checking the fingerprint.

7. **Probe-only release blockers suggested a heavier setup/deploy loop (P3).**
   **Location:** `src/operator/release-gate.ts:930`. **Repro:** retain a valid
   staging success but remove or stale only the probe evidence; the generic
   fallback suggested configure plus redeploy. **Proposed fix (implemented):**
   classify the blocker set and print the read-only `doctor --probe` remedy
   when every real blocker is a probe.

8. **Review retry hardening had three secondary gaps (P2).** **Location:**
   `src/operator/commands/review.ts:1956`,
   `src/operator/commands/review.ts:3328`, and
   `src/operator/review-enforcement.ts:410`. **Repro:** `review setup` could
   rewrite a configured gate without its `timeoutMs`; waiting for another
   process's command-gate lock timed out as generic `FAILED`; same-millisecond
   filtered retries could be ordered ambiguously. **Proposed fix
   (implemented):** preserve the configured timeout, mark lock-wait timeout as
   `TIMEOUT` with a single-gate remedy, and use append-only record precedence
   when composing retry evidence.

9. **The test harness inherited a live outer review-gate context (P1).**
   **Location:** `test/pipelane.test.mjs:89`. **Repro:** run the repository's
   configured `npm test` gate through `pipelane run review`; fixture CLIs and
   direct in-process review fixtures inherited the real gate's depth and
   parent PID, then failed closed as recursive production review invocations
   even though the same 814-test suite passed standalone. **Proposed fix
   (implemented):** scrub ambient recursion markers once at the suite boundary
   and scrub ambient review identity from every fixture CLI unless the
   individual test explicitly supplies it. Production recursion protection is
   unchanged, and its dedicated tests continue to inject the markers
   explicitly.

10. **A task-shaped branch in the shared checkout could bypass the cwd guard
    for PR recovery (P1).** **Location:**
    `src/operator/commands/helpers.ts:114`. **Repro:** rename the shared/base
    checkout branch so it parses to the attached task slug, then run
    `pr --task <task>` there; the branch-name recovery exception could run
    before the hard error even though the lock named another worktree.
    **Proposed fix (implemented):** allow the fingerprint-bound recovery
    exception only in non-shared worktrees. Shared checkouts always print the
    exact task path and take no dirty-tree or base-drift measurements.

11. **Delayed release readiness could overwrite or resurrect a task lock
    (P0).** **Location:** `src/operator/commands/devmode.ts:197` and
    `src/operator/state.ts:2854`. **Repro:** begin `devmode release` with stale
    probes, then rebind or clean the task while the inline probe is pending;
    the command retained the pre-probe snapshot and could write it after the
    concurrent mutation. **Proposed fix (implemented):** serialize task-lock
    writes through a per-task mutation lease, reload after readiness, abort on
    missing/changed bindings, and patch only `mode` into the latest record.
    PR recovery, next-action updates, and cleanup pruning now use the same
    atomic update path; delayed-probe tests cover both rebind and removal.

12. **Dirty builds claimed the clean commit SHA (P0).** **Location:**
    `scripts/write-build-info.mjs:23` and `src/runtime-identity.ts:35`.
    **Repro:** change tracked or untracked source, build or run the source CLI,
    and observe a banner indistinguishable from clean `HEAD`. This defeated
    Q0's diagnostic purpose. **Proposed fix (implemented):** record a build
    dirty bit, detect source-tree dirtiness, render `<sha>-dirty` in banners
    and `--version`, and treat a dirty build as different from an otherwise
    matching host pin. Tests cover tracked and untracked changes plus explicit
    build metadata.

13. **Inline probe refresh reused a stale deploy-state snapshot (P1).**
    **Location:** `src/operator/commands/devmode.ts:96`. **Repro:** begin
    `devmode release` when stale probe evidence is the only blocker, then
    record a new staging request or failure while the read-only probe is
    running; the post-probe readiness check used to retain the older staging
    success. **Proposed fix (implemented):** re-read deploy state after the
    asynchronous probe before evaluating release readiness, so concurrent
    deploy activity remains fail-closed.

14. **Filtered review retries could leave stale evidence attestable (P1).**
    **Location:** `src/operator/review-enforcement.ts:403`. **Repro:** run a
    failing full review, retry one gate successfully, then retry it again and
    fail; the composer used to attach only successful retry records. A
    command-backed `type: skill` retry was also ignored as manual, and manual
    acceptance could win without comparing its time to executable evidence.
    **Proposed fix (implemented):** let the latest matching filtered pass or
    failure supersede earlier evidence, preserve append order for timestamp
    ties, compose executable retries for every command-backed gate, and use
    the shared `recordedAt` chronology for manual acceptance versus retries.

15. **API action flags could be syntactically accepted but semantically
    orphaned (P2).** **Location:** `src/operator/commands/api.ts:52` and
    `src/operator/commands/api.ts:115`. **Repro:** pass `--reason` without
    `--override`, or pass `taskLock.verify --mode banana`; the first value had
    no effect and the second flowed into later/default behavior. **Proposed
    fix (implemented):** reject both invalid contracts before preflight or
    confirmation-token issuance.

16. **Untrusted runtime identity fields could break the first-line banner
    contract (P1).** **Location:** `src/runtime-identity.ts:44` and
    `src/runtime-identity.ts:190`. **Repro:** place a malformed SHA in build
    metadata or control/newline characters in package identity/path fields;
    output could gain a forged line before a command's real result, including
    text resembling a review marker. **Proposed fix (implemented):** validate
    build SHAs, normalize timestamps, and terminal-sanitize every rendered
    banner field onto one line.

17. **An explicit PR number could bypass the task cwd guard (P1).**
    **Location:** `src/operator/commands/helpers.ts:92` and the merge, deploy,
    and API action call sites. **Repro:** from the shared checkout, run
    `merge --pr <n>` or `deploy --pr <n>` without `--task` while that PR maps
    to a lock in another worktree; the early guard could not identify the task
    and later code measured the caller checkout. **Proposed fix (implemented):**
    resolve PR-to-task identity before any cwd measurement and apply the same
    guard during API preflight, which now mints no token on mismatch.

18. **Task surfaces were another snapshot/live-state pair without complete
    reconciliation (P1).** **Location:** `src/operator/commands/devmode.ts:56`
    and `src/operator/commands/devmode.ts:197`. **Repro:** request disjoint
    surfaces explicitly or through global mode while a task lock already
    covers more surfaces, or change that lock during an inline probe; release
    readiness could omit persisted task scope or persist against changed
    scope. **Proposed fix (implemented):** union persisted task surfaces into
    readiness, allow explicit/global inputs only to widen that set, and verify
    the live lock surfaces under the task mutation lease before writing mode.

19. **`repo-guard` could mint a release lock outside the checked mode or
    surface set (P1).** **Location:**
    `src/operator/commands/repo-guard.ts:53`. **Repro:** retain a build-mode
    task lock while global mode is release, or create a release task for
    `worker` after readiness covered only `frontend`; `repo-guard` could copy
    global mode into the task snapshot. **Proposed fix (implemented):** reject
    existing mode divergence and reject unchecked release surfaces, pointing
    to `devmode release` with the required surface union so the readiness gate
    remains authoritative.

20. **Legacy config import was not on the first general-command path (P2).**
    **Location:** `src/operator/state.ts:1148`. **Repro:** run `status` or
    `new` in a repo with only `.pipelane.json`, `.project-workflow.json`, or
    `package.json:pipelane`; the general loader synthesized defaults before a
    later setup/configure path performed migration. **Proposed fix
    (implemented):** make `loadWorkflowConfig` the migration boundary: retain
    the legacy source and write its normalized machine-local copy before any
    operator command consumes config.

21. **API devmode preflight and execution resolved different task scope
    (P1).** **Location:** `src/operator/api/actions.ts:359` and
    `src/operator/commands/helpers.ts:62`. **Repro:** preflight
    `devmode.build --task missing-task`, or preflight `devmode.release` with an
    explicit surface disjoint from the named task lock; preflight could allow
    the action even though execution rejected the missing lock or widened
    readiness to the task's persisted surfaces. **Proposed fix (implemented):**
    share task-lock and surface resolution between direct devmode execution
    and API preflight; invalid task identity now blocks before execution, and
    release preflight evaluates the full persisted task scope.

22. **`review setup` re-hydration could overwrite saved gate policy (P1).**
    **Location:** `src/operator/commands/review.ts:821` and
    `src/operator/commands/review.ts:1956`. **Repro:** save a `test` gate with
    `timeoutMs: 123456` and `blocking: false`, then run
    `review setup --enable test`; the catalog entry replaced those fields with
    its defaults. **Proposed fix (implemented):** carry `timeoutMs` and
    `blocking` through both catalog and custom-gate hydration paths and
    serialize the hydrated policy unchanged.

23. **Self-hosted review timeout overrides leaked into fixture CLIs (P1).**
    **Location:** `test/pipelane.test.mjs:112`. **Repro:** run `npm test` as a
    review gate with `PIPELANE_REVIEW_GATE_TIMEOUT_MS=2700000`; fixture review
    commands inherited that outer value, replacing their deliberately short
    timeout and making timeout assertions fail. **Proposed fix (implemented):**
    scrub the outer review control-plane timeout from fixture environments
    unless the individual test explicitly supplies it. A regression test runs
    under the ambient override and proves explicit fixture overrides still
    work.

24. **Legacy auto-import could promote checkout-controlled safety policy into
    machine-local trust (P1).** **Location:** `src/operator/state.ts:1508`.
    **Repro:** commit `.pipelane.json` with `reviewGates.gates: []`, remove the
    machine-local config, and run any operator command; the first-command
    migration persisted the empty gate set, allowing the checkout to disable
    `/pr` attestation. Other executable and route/release policy fields had the
    same trust-boundary problem. **Proposed fix (implemented):** migrate through
    an explicit project-metadata allowlist (identity, branch/worktree shape,
    surfaces, aliases, deploy workflow, and legacy docs settings), derive all
    safety policy from machine defaults, and warn once with the ignored field
    names so an operator can configure trusted overrides explicitly.

25. **The API cwd guard threw before producing its promised JSON envelope
    (P1).** **Location:** `src/operator/api/actions.ts:181` and
    `src/operator/api/actions.ts:663`. **Repro:** preflight task-scoped
    `merge --pr <n>` or `deploy --pr <n>` from the shared checkout while the PR
    task is leased to another worktree; the command exited nonzero with empty
    stdout, forcing a headless caller to parse stderr and violating the
    `ApiEnvelope` contract. **Proposed fix (implemented):** convert only the API
    guard failure into `ok:false`, `preflight.allowed:false` structured output
    before route/base/dirty measurement, with the exact `cd` remedy and no
    confirmation token. Direct `/merge` and `/deploy` retain Q5's hard error.

26. **Build-identity tests bypassed production dirty-state detection (P1).**
    **Location:** `test/pipelane.test.mjs:288` and
    `scripts/write-build-info.mjs:23`. **Repro:** break the script's real
    `git status --porcelain --untracked-files=normal` path; the test still
    passed because it always set `PIPELANE_BUILD_DIRTY=1`. **Proposed fix
    (implemented):** retain the deterministic override contract test and add
    clean, tracked-dirty, and untracked-dirty temporary Git repositories with
    the dirty override explicitly unset.

27. **Malformed unrelated `package.json` blocked synthesized config fallback
    (P2).** **Location:** `src/operator/state.ts:1572`. **Repro:** use a repo
    with malformed `package.json` but no known legacy config file; the legacy
    overlay probe parsed the whole file with a throwing helper even though no
    `package.json:pipelane` block could be established. **Proposed fix
    (implemented):** use the existing warning-and-fallback JSON reader for the
   optional package overlay probe, preserving synthesized defaults and leaving
   machine-local state unmaterialized.

28. **Legacy auto-import trusted checkout-controlled filesystem paths (P0).**
    **Location:** `src/operator/state.ts:1509` and the legacy state migration
    path. **Repro:** commit `.pipelane.json` with `stateDir` pointing outside
    the Git common directory, remove machine-local config, and run any command;
    migration could recursively copy attacker-selected files into trusted
    machine state. `taskWorktreeDirName` exposed the same path-trust class for
    future workspace creation. **Proposed fix (implemented):** remove both path
    fields from the legacy metadata allowlist, derive safe machine defaults,
    warn that the fields were ignored, and cover an external-directory payload
    with a regression test.

29. **Task cleanup and task-lock mutation used independent leases (P1).**
    **Location:** `src/operator/state.ts:1922`,
    `src/operator/state.ts:2940`, and
    `src/operator/task-workspaces.ts:497`. **Repro:** begin `/clean` after its
    one-time cleanup-lock check while another process begins `updateTaskLock`;
    cleanup could remove the worktree/branch and then fail to prune the lock,
    while the writer persisted state for the deleted workspace. **Proposed fix
    (implemented):** acquire one composite lease in the canonical order
    task-mutation then cleanup, retain it across destructive cleanup and lock
    pruning, and let the cleanup-held prune reuse rather than reacquire the
    mutation lease. A two-process regression proves writers are excluded for
    the entire cleanup window.

30. **Review timeouts consumed route loop and AI budgets and could be waived as
    findings (P1).** **Location:** `src/operator/route-loop-safety.ts:104`,
    `src/operator/route-loop-safety.ts:142`, and
    `src/operator/route-loop-safety.ts:487`. **Repro:** let the first blocking
    AI gate time out under the default one-loop/one-AI-run limits; the targeted
    retry was rejected as exhausted, while `resume --accept-findings` could
    bless a run that contained no verdict. **Proposed fix (implemented):**
    record timed-out gate IDs separately, exclude timeout-only gates from fix
    and AI counters, always admit the matching targeted retry even after the
    wall-clock limit, reject accept-findings in both headless and TTY paths,
    and print only exact `review --gate <id>` retry commands.

31. **Orchestration launched code-changing auto-fix workers for review
    timeouts (P1).** **Location:** `src/operator/commands/orchestrate.ts:850`
    and `src/operator/commands/orchestrate.ts:1171`. **Repro:** let a blocking
    slice review gate time out; orchestration treated its generic failed status
    as a finding and sent an agent a fix prompt despite having no reviewer
    verdict. **Proposed fix (implemented):** make actionable failed gates
    explicitly exclude `outcome: timeout` and skip auto-fix entirely when no
    actionable gate remains. A worker-invocation regression proves only the
    original implementation worker runs.

32. **Global mode surfaces did not widen persisted task scope (P1).**
    **Location:** `src/operator/commands/helpers.ts:79`. **Repro:** persist
    global requested surface `frontend`, retain task surface `sql`, and run a
    task-scoped mode transition without explicit `--surfaces`; the task-lock
    fallback replaced the global selection and readiness checked only `sql`.
    **Proposed fix (implemented):** choose explicit surfaces first, otherwise
    honor non-empty persisted global requested surfaces, and union that
    selection with the durable task scope. Preserve the historical task-only
    fallback when no persisted global or explicit selection exists; a fresh
    synthesized all-surfaces default is not treated as operator intent.

33. **`deploy.prod` confirmation tokens were bound to raw flags rather than the
    resolved production effect (P0).** **Location:**
    `src/operator/api/actions.ts:1046`,
    `src/operator/commands/deploy.ts:281`, and
    `src/operator/commands/deploy.ts:1303`. **Repro:** preflight with no
    explicit SHA/surfaces, change the recorded merged SHA or inferred surface
    set, then execute the old token; the parent consumed it and gave the child
    a prompt bypass for a target the operator never saw. **Proposed fix
    (implemented):** resolve and fingerprint the exact target SHA plus sorted
    surface set during preflight, re-resolve before token consumption, and pass
    those approved values to the child, which compares them again immediately
    before honoring the API confirmation bypass. Drift fails closed with a new
    preflight remedy.

34. **Direct production effect binding accidentally rejected confirmed route
    deploys (P0).** **Location:** `src/operator/commands/deploy.ts:1303` and
    `src/operator/destination-executor.ts:292`. **Repro:** preflight and execute
    `api action route.deploy.prod` when production is the remaining route step;
    the route child carried the established route-confirmed marker but not the
    direct action's approved SHA/surface variables, so the new assertion read
    missing approval data and blocked before dispatch. **Proposed fix
    (implemented):** give direct `deploy.prod` confirmation a distinct internal
    marker, apply exact SHA/surface comparison only to that marker, preserve the
    existing route fingerprint confirmation path, and scrub the direct marker
    from destination children. A full route preflight/token/execute regression
    now reaches successful production dispatch.

35. **Production effect-resolution errors escaped the API envelope (P1).**
    **Location:** `src/operator/api/actions.ts:193`,
    `src/operator/api/actions.ts:731`, and
    `src/operator/api/actions.ts:1050`. **Repro:** preflight `deploy.prod` with a
    missing task lock, missing merged SHA, or invalid ref, or delete a named ref
    between valid preflight and execute; normalization threw directly and left
    JSON callers with empty stdout. **Proposed fix (implemented):** catch exact
    effect-resolution failures in both preview and execute, rebuild only raw
    side-effect-free inputs, return `ok:false` / `preflight.allowed:false` with
    no token, and persist task-scoped execute blockers through the existing
    action feedback path.

36. **Legacy `projectKey` could indirectly escape the task-worktree sibling
    root (P0).** **Location:** `src/operator/state.ts:1543` and
    `src/operator/task-workspaces.ts:62`. **Repro:** commit a legacy config
    with `projectKey: "../../escape"` but omit the already-filtered
    `taskWorktreeDirName`; import derived `../../escape-worktrees`, and `/new`
    resolved that path outside the repository's sibling directory. **Proposed
    fix (implemented):** slug-normalize imported legacy project keys with a
    visible warning, then independently canonicalize and containment-check
    every resolved task-worktree root before any caller creates or scans it.
    The new hard error is a safety bugfix: an unsafe machine-local directory
    value is rejected instead of authorizing writes outside the managed
    sibling root.

37. **Targeted cleanup released the composite lease before artifact deletion
    (P0).** **Location:** `src/operator/commands/clean.ts:94` and
    `src/operator/commands/clean.ts:115`. **Repro:** start
    `/clean --apply --task <slug>`, pause after its lock prune, then let
    `devmode build --task <slug>` recreate or mutate task state before cleanup
    removes the worktree and branch; durable state could point at deleted
    artifacts. **Proposed fix (implemented):** acquire the canonical
    task-mutation then cleanup lease before targeted inspection, let the prune
    reuse that lease, and release only after worktree/branch deletion. A real
    two-process CLI regression pauses the targeted clean while a concurrent
    task-scoped `devmode` command proves it cannot enter the mutation window.

38. **Direct production confirmation did not bind dispatch configuration
    (P0).** **Location:** `src/operator/commands/deploy.ts:283`,
    `src/operator/api/actions.ts:1134`, and
    `src/operator/commands/deploy.ts:1332`. **Repro:** preflight
    `deploy.prod`, then change the machine-local production deploy command or
    the workflow-config fallback `deployWorkflowName` during the token's
    30-minute lifetime; SHA and surfaces were unchanged, so the old approval
    could dispatch a different production effect. **Proposed fix
    (implemented):** bind a canonical fingerprint of the production config
    slice plus resolved workflow name, base branch, and mode into normalized
    token inputs; re-resolve before token consumption; pass the exact value to
    the child, which recomputes and compares it before honoring the one-shot
    non-TTY bypass. Regressions cover fallback-workflow drift, production
    command drift, and a deliberately mismatched child approval environment.

39. **Legacy-import warnings allowed terminal and transcript injection
    (P0).** **Location:** `src/operator/state.ts:1544`. **Repro:** place
    newline, ANSI CSI, or OSC sequences in a checkout-controlled legacy
    `projectKey` or ignored JSON property name; the import warning wrote those
    bytes directly to stderr, allowing forged log lines or review markers.
    **Proposed fix (implemented):** strip terminal controls, collapse all
    whitespace to a single line, and only then render or slug-normalize the
    dynamic value. A hostile-config regression proves newline, ANSI, and OSC
    bytes cannot create a second output line while the safe text remains
    actionable.

40. **Strict route lineage could make a paused lockless review impossible to
    resume (P1).** **Location:** `src/operator/route-loop-safety.ts:959` after
    integrating strict review lineage from current `origin/main`. **Repro:**
    run a targeted review from a lockless branch and let a gate time out; the
    destination-derived review plan inferred a task slug for its unbound
    lineage, while a later bare `resume` derived an empty-slug binding ID and
    reported that no paused route existed. **Proposed fix (implemented):**
    rediscover each candidate with the task slug captured in that route
    record, preserving the same repository/worktree/branch-bound hash. The
    timeout regression now reaches—and enforces—the non-waivable timeout guard
    under upstream's mandatory informed-consent `--reason` contract.

41. **Route acceptance could race newer review/route state and persist before
    signed consent existed (P1).** **Location:**
    `src/operator/route-loop-safety.ts:266` and
    `src/operator/route-loop-safety.ts:402`. **Repro:** pause a route on failed
    evidence, start `resume --accept-findings` (or wait at TTY option 4), then
    let a concurrent review or resume update the route before the prompt
    returns; the old path saved a stale route snapshot and, in headless mode,
    recorded acceptance before re-evaluating/signing the exact evidence.
    **Proposed fix (implemented):** capture the route lineage, attempt, review
    run, and target command; reload and compare them under the route lock;
    re-evaluate the same review under the review lock; persist the complete
    signed-consent batch; and only then commit route acceptance. Consent save
    failure leaves the route untouched, route save failure removes only the
    newly written consent IDs, and every TTY mutation now reloads current state
    instead of overwriting it with the pre-prompt snapshot.

42. **Targeted review retries matched an underspecified evidence identity
    (P1).** **Location:** `src/operator/review-enforcement.ts:846`. **Repro:**
    retain branch, SHA, and dirty-tree digest while changing task binding,
    authoritative intent, review target digest, policy version, or enforcement
    mode; a later `review --gate <id>` could be composed into the older full
    run. **Proposed fix (implemented):** require exact equality for all five
    fields in addition to the existing branch/SHA/worktree identity. A matrix
    regression proves each mismatch independently prevents composition.

43. **Strict-v3 reviewers bypassed the shared timeout contract (P1).**
    **Location:** `src/operator/commands/review.ts:4125`. **Repro:** configure a
    strict skill gate and set `PIPELANE_REVIEW_GATE_TIMEOUT_MS`; legacy command
    and AI gates used the override, while the strict provider read only its
    configured `timeoutMs`, then reported the timeout as generic execution
    failure. **Proposed fix (implemented):** use the common strict duration
    resolver for provider and command-lock waits, persist additive
    `outcome: "timeout"` / `errorCode: "ETIMEDOUT"`, and print the exact
    `pipelane run review --gate <id>` remedy.

44. **A successful targeted retry erased unrelated unresolved timeouts (P1).**
    **Location:** `src/operator/route-loop-safety.ts:867`. **Repro:** let gates
    A and B time out, then pass only `review --gate A`; assigning the filtered
    run's empty timeout list replaced `[A, B]`, so accept-findings no longer
    saw B. **Proposed fix (implemented):** treat the route timeout list as an
    unresolved set: full reviews replace it, a filtered timeout adds its gate,
    and a definitive filtered pass/failure removes only that gate. The route
    remains fail-closed until every timed-out gate receives a real verdict.

45. **Production API preflight and execution resolved surfaces from different
    contracts (P1).** **Location:** `src/operator/commands/deploy.ts:304`.
    **Repro:** add a target-SHA deploy contract containing a custom surface,
    leave stale lock surfaces, preflight `api action deploy.prod`, then execute
    its token; preflight used the default machine map while execution loaded
    the target contract, so a legitimate token was guaranteed to drift.
    **Proposed fix (implemented):** load and validate the exact target's
    workflow surface contract during approval resolution and pass its resolved
    path map into the same inference routine used by execution. A custom-MCP
    production regression now preflights and executes the same surface set.

46. **Multiple task locks reopened shared-checkout PR recovery (P1).**
    **Location:** `src/operator/commands/helpers.ts:150`. **Repro:** keep two
    task locks, check out a task-shaped branch in the shared checkout, and run
    `/pr` without `--task`; no path matched and the old single-lock fallback
    returned null, allowing downstream branch inference to offer recovery from
    the wrong checkout. **Proposed fix (implemented):** in the shared checkout,
    resolve a unique branch-derived lock before any measurements so the error
    names its exact worktree; otherwise hard-error with an explicit `--task`
    remedy. The non-shared recovery exception remains available.

47. **A symlinked worktree-root ancestor escaped containment when the final
    directory did not exist (P0).** **Location:** `src/operator/state.ts:1023`.
    **Repro:** configure `taskWorktreeDirName` as `link/missing`, where `link`
    is a sibling symlink outside the allowed root; `realpathSync` failed on the
    missing leaf and the old fallback compared the harmless lexical path.
    **Proposed fix (implemented):** walk upward to the nearest existing
    ancestor, canonicalize that ancestor, append the missing segments, and use
    the resulting path for every containment/equality check. `/new` now rejects
    the escape before creating anything.

48. **Non-JSON API preflight is a two-record stdout protocol, not a single JSON
    document (P3, reviewed; no code change).** **Location:**
    `src/operator/commands/api.ts:77`. **Repro:** invoke a risky preflight
    without `--json` and feed all stdout directly to `JSON.parse`; the required
    `PIPELANE_CONFIRM_TOKEN=<token>` machine line precedes the envelope.
    **Proposed fix:** programmatic callers that want a single JSON document
    must pass `--json` and read
    `data.preflight.confirmation.{token,expiresAt}`. This is the deliberate Q4
    plan-of-record contract (the standalone line exists for shell callers), so
    removing it would regress the accepted token ergonomics rather than fix a
    deploy-flow bug.

49. **Legacy custom state directories were sanitized before migration and
    silently abandoned release state (P0).** **Location:**
    `src/operator/state.ts:1736` and `src/operator/state.ts:2441`.
    **Repro:** put `mode-state.json` in `.git/custom-state`, set
    `stateDir: "custom-state"` in a legacy `.pipelane.json`, and run the first
    machine-local import; the policy allowlist correctly removed `stateDir`,
    but migration then searched only the default names and mode fell back to
    `build`. **Proposed fix (implemented):** capture the raw legacy value only
    as a one-shot migration hint, require a relative traversal-free path whose
    canonical target stays inside the Git common directory, migrate it before
    writing sanitized machine config, and reject absolute/traversal/symlink
    escapes. The legacy directory remains unchanged.

50. **Non-blocking review-gate timeouts entered the route's fail-closed timeout
    ledger (P1).** **Location:** `src/operator/route-loop-safety.ts:891` and
    `src/operator/route-loop-safety.ts:915`. **Repro:** configure a command
    gate with `blocking:false` and force it to time out; review correctly
    reports `passed`, but `lastTimedOutGateIds` retained the gate and later
    route actions stopped as if a required verdict were missing. **Proposed fix
    (implemented):** full and targeted reconciliation now records timeout IDs
    only for blocking gates; a targeted non-blocking verdict also removes any
    stale historical ledger entry. Blocking timeout behavior remains
    fail-closed.

51. **A repo-controlled legacy `baseBranch` could become a Git option (P0).**
    **Location:** `src/operator/state.ts:1381` and
    `src/operator/task-workspaces.ts:244`. **Repro:** import a legacy config
    whose base branch begins with `--upload-pack=` and let `/new` refresh the
    base ref; the value crossed the config boundary without Git ref validation
    and was passed to `git fetch` without an option terminator. **Proposed fix
    (implemented):** legacy auto-import no longer promotes a
    checkout-controlled base branch into machine trust; direct machine-local
    configuration still validates every normalized base branch with
    `git check-ref-format`, rejects dash-prefixed values with an actionable
    error, and places `--` before fetch positionals as defense in depth.

52. **A failed custom-state migration could permanently discard release-mode
    safeguards (P0).** **Location:** `src/operator/state.ts:1876` and
    `src/operator/state.ts:2529`. **Repro:** point a safe legacy `stateDir` at
    existing release state, then make enumeration or any copy fail during the
    first auto-import; the old best-effort helper still wrote sanitized
    machine config, and a partial success could write migration/install
    markers. Future loads stopped consulting the legacy directory and could
    default to build mode. **Proposed fix (implemented):** auto-imported custom
    state uses a strict migration mode: enumeration or copy failure throws
    before machine config or markers are written, existing destinations must
    be recursively byte-equivalent, and a retry verifies earlier copied
    entries before completing the remaining copy. Failure-injection coverage
    exercises enumeration failure, zero-copy failure, partial copy, and a
    successful retry. Historical default-directory migration keeps its
    backwards-compatible best-effort behavior.

53. **Legacy auto-import promoted checkout-controlled deploy routing into
    machine trust (P0).** **Location:** `src/operator/state.ts:1798`.
    **Repro:** place `baseBranch`, `surfaces`, `deployWorkflowName`, or
    `surfacePathMap` in `.pipelane.json` or `package.json:pipelane`, then run
    the first command; those values were persisted in the shared machine-local
    config and controlled later review/deploy routing. **Proposed fix
    (implemented):** auto-import now limits itself to non-routing project
    identity/ergonomic fields and prints the existing ignored-policy warning
    for all four routing fields. Operators must configure routing explicitly
    through the machine-local path.

54. **Delayed release reconciliation did not bind the immutable task identity
    (P1).** **Location:** `src/operator/commands/devmode.ts:204`. **Repro:**
    start `devmode release` while a stale probe runs, rebind the same slug to a
    new `taskBindingId` without changing branch, path, or surfaces, then let
    the probe finish; the old lease check wrote release mode into the new
    binding. **Proposed fix (implemented):** compare `taskBindingId` alongside
    branch and canonical worktree path under the task mutation lease. The
    identity-only race now fails closed and leaves both task and global mode
    in build.

55. **A targeted review retry replaced the route's full evidence ID and broke
    `resume --accept-findings` (P1).** **Location:**
    `src/operator/route-loop-safety.ts:1216`. **Repro:** pause a route on a
    failed full review, run `review --gate <id>`, then accept the remaining
    findings; evidence composition correctly retained the full run as its
    envelope, while route safety stored the filtered run ID, so the exact-ID
    consent check always rejected. **Proposed fix (implemented):** filtered,
    phase-filtered, and dry-run reviews can update timeout and AI-budget
    accounting but cannot replace `lastReviewRunId`, `lastReviewStatus`, or
    the attempt's existing full-review binding. A filtered run may initialize
    those fields only when no prior review exists so timeout-only routes retain
    their non-waivable remedy. A failed targeted retry now remains composable
    and accept-findings operates on the matching full envelope.

56. **Wrong-worktree remediation printed unquoted `cd` paths (P3).**
    **Location:** `src/operator/commands/helpers.ts:30` and
    `src/operator/commands/helpers.ts:214`. **Repro:** put a task worktree
    under a path containing spaces or an apostrophe and copy the printed
    remedy; the shell split or misparsed the exact destination. **Proposed fix
    (implemented):** render safe path tokens unchanged and POSIX single-quote
    every other path, including embedded-apostrophe escaping. The same helper
    is used by delayed devmode binding remediation.

57. **Legacy custom-state migration preserved descendant symlinks in trusted
    machine state (P0).** **Location:** `src/operator/state.ts`. **Repro:** put
    a `task-locks` directory symlink inside an otherwise-contained legacy
    custom state directory; recursive copy preserved the link, so later
    machine-trusted writes could escape `PIPELANE_HOME`. **Proposed fix
    (implemented):** strict legacy import rejects symlinks anywhere in the
    source or existing destination tree, removes a partially copied entry on
    failure, and writes no config or migration markers.

58. **An existing canonical install marker skipped required custom-state
    migration (P0).** **Location:** `src/operator/state.ts`. **Repro:** let an
    earlier command create `installed.json`, then auto-import a legacy config
    whose custom state contains release mode; migration returned early and
    permanently persisted sanitized machine config without the release state.
    **Proposed fix (implemented):** strict repo-config import treats generic
    install/migration markers as insufficient and copies or byte-verifies the
    selected legacy entries before committing machine config.

59. **Checkout-controlled `stateDir` could select `.git/objects` for recursive
    migration (P0).** **Location:** `src/operator/state.ts`. **Repro:** set
    `stateDir: "objects"` in legacy repo config; containment checks accepted
    the Git object database and copied it into machine state, enabling disk
    amplification and startup denial of service. **Proposed fix (implemented):**
    strict import accepts only known Pipelane state filenames and directories;
    Git internals or any other unexpected top-level entry fail closed before
    the destination or machine config is created.

60. **Production rollback could dispatch a different SHA than its confirmation
    token approved (P0).** **Location:** `src/operator/api/actions.ts` and
    `src/operator/commands/rollback.ts`. **Repro:** change deploy history after
    token consumption but before the rollback child resolves its target; the
    generic production bypass skipped typed confirmation for the new SHA.
    **Proposed fix (implemented):** bind target SHA, sorted surfaces, and the
    production dispatch-configuration fingerprint into token normalization,
    pass them to the child, and recompute/compare immediately before consuming
    the bypass. Drift blocks before any workflow dispatch.

61. **A cleanup confirmation token did not bind the task-lock revision it could
    delete (P0).** **Location:** `src/operator/api/actions.ts:1222`,
    `src/operator/commands/clean.ts:105`, and
    `src/operator/task-workspaces.ts:443`. **Repro:** preflight
    `clean.apply --task X`, rebind X to a new worktree before execution, then
    consume the old token; the child could prune the replacement lock and its
    artifacts. **Proposed fix (implemented):** include canonical lock snapshots
    in token normalization, pass the approved set through a scrubbed one-shot
    child environment value, and skip any lock whose immutable binding or
    mutable revision changed before deletion.

62. **Route confirmation omitted deploy-routing defaults from its fingerprint
    (P0).** **Location:** `src/operator/destination-planner.ts:372` and
    `src/operator/destination-executor.ts:428`. **Repro:** preflight a route to
    production, change `baseBranch` or the default deploy workflow before
    consuming the token, and retain the same task/SHA/surfaces; the old route
    fingerprint still matched a differently routed effect. **Proposed fix
    (implemented):** include both routing defaults in static and live route
    fingerprints so execution rejects drift and requires a new preflight.

63. **Production workflow dispatch could discard the approved SHA (P0).**
    **Location:** `src/operator/commands/deploy.ts:1076`. **Repro:** configure a
    production `workflow_dispatch` workflow without a `sha` input and approve a
    deploy whose target equals the current base; input filtering silently
    omitted the SHA and dispatched a mutable workflow ref. **Proposed fix
    (implemented):** production now fails closed whenever the selected workflow
    cannot accept the approved SHA. Staging retains the compatibility path only
    when its target is already the current base.

64. **Task-binding updates bypassed the shared task-mutation lease (P1).**
    **Location:** `src/operator/state.ts:3818`. **Repro:** pause inside
    `updateTaskBinding` while a concurrent `updateTaskLock` writes the same
    task; the independent binding lock allowed a lost update and could race
    cleanup/reconciliation. **Proposed fix (implemented):** keep the binding
    lock for binding-specific serialization, but perform the read-modify-write
    through `updateTaskLock` so the canonical mutation lease covers the entire
    callback.

65. **Route and API consumers ignored composed targeted-review evidence (P1).**
    **Location:** `src/operator/route-loop-safety.ts:219` and
    `src/operator/api/snapshot.ts:333`. **Repro:** let a full review contain one
    actionable failure and one timeout, then pass only the timed-out gate; `/pr`
    correctly retained the failed full envelope, but route safety could clear
    its pause from the raw passing retry, the snapshot displayed that partial
    run, and fix eligibility inspected the uncomposed full record. The inverse
    case—a passing full run followed by a failed targeted retry—also remained
    invisible to those consumers. **Proposed fix (implemented):** route status,
    pause rendering, fix issuance, finding disposition, and API snapshot
    projection now use the same current-checkout composed full-review envelope
    as enforcement, while the timeout ledger still reconciles only gates
    actually retried.

66. **Concurrent stale task-mutation reclaimers could delete a successor's
    live lease (P0).** **Location:** `src/operator/state.ts:4094`. **Repro:**
    seed an abandoned task-mutation lock and let two processes both observe
    the dead owner before either removes the directory; the former check-then-
    delete path allowed the losing reclaimer to remove the winner's newly
    created lease, so both task-lock mutations could proceed concurrently.
    **Proposed fix (implemented):** publish atomic, identity-bound reclaim
    claims inside the abandoned directory, elect the lowest live ticket,
    recheck the exact directory generation and owner immediately before
    deletion, and bind normal release to an owner nonce so it cannot remove a
    successor lease.

67. **Route safety treated a timed-out review gate as an acceptable finding
    (P0).** **Location:** `src/operator/route-loop-safety.ts:1684`. **Repro:**
    let the only blocking review issue be a gate with `status: "failed"` and
    `outcome: "timeout"`, then disable `routeSafety.stopOnMajorFindings`; the
    old generic failed-gate predicate returned true and could advance the
    route as though a reviewer had produced an actionable finding. **Proposed
    fix (implemented):** acceptable findings must be real failed verdicts;
    timeout outcomes remain fail-closed and require executable gate retry
    evidence.

68. **Clearing a route pause left a stale pointer that `/resume` could target
    (P1).** **Location:** `src/operator/route-loop-safety.ts:250`,
    `src/operator/route-loop-safety.ts:1676`, and
    `src/operator/route-loop-safety.ts:1703`. **Repro:** pause a route, record a
    passing review that clears `pausedAt`, then run `resume --one-more-loop`;
    `latestPausedRouteFingerprintDigest` still named the unpaused record and
    the fast path returned it without checking `pausedAt`. **Proposed fix
    (implemented):** synchronize the latest-paused pointer whenever pause
    state changes, clear it only when it still names that record, and require
    the fast-path record to remain paused. Tests also replace fixed sleep
    windows in the affected concurrency cases with explicit release markers.

### Filed for follow-up

1. **`repo-guard` can silently rebind a live task and orphan its original
   worktree (P1).** **Location:** `src/operator/commands/repo-guard.ts:41` and
   `src/operator/commands/repo-guard.ts:80`. **Repro:** create task `x`, then
   run `repo-guard --task x` from an unsafe shared checkout; the command can
   create a second worktree and overwrite the only lock for the first one.
   **Proposed fix:** if the existing lock points at a live worktree, hand off
   to its exact path. Require an explicit, fingerprint-bound `--rebind` to
   replace it and retain the former binding in audit history.

2. **A successful GitHub merge has no local reconciliation path after the
   post-merge poll times out (P1).** **Location:**
   `src/operator/commands/merge.ts:72` and
   `src/operator/commands/merge.ts:85`. **Repro:** let `gh pr merge` succeed
   but delay `mergeCommit.oid` beyond the 30-second poll; no PR record is
   saved, and a rerun rejects the now-`MERGED` PR before repairing state.
   **Proposed fix:** recognize an already-merged PR on entry, poll/reconcile
   its exact merge commit without issuing another merge, persist the missing
   record, and print a distinct timeout remedy.

3. **Required-check watching is unbounded for agent drivers (P2).**
   **Location:** `src/operator/commands/helpers.ts:663`. **Repro:** leave a
   required GitHub check permanently pending; `gh pr checks --watch` has no
   Pipelane timeout and the `/merge` process can wait forever. **Proposed fix:**
   add a strict `PIPELANE_PR_CHECKS_TIMEOUT_MS`, execute the child with that
   bound, and report `TIMEOUT` plus a safe `/merge` rerun remedy.

4. **Rollback preflight can mint a production confirmation token for an
   impossible rollback (P1).** **Location:**
   `src/operator/api/actions.ts:1027` and
   `src/operator/api/actions.ts:1079`. **Repro:** preflight `rollback.prod`
   with no matching last-good deploy, with an in-flight deploy, or immediately
   after a successful rollback; resolution returns `undefined`, but preflight
   can still report ready and issue a token before execute fails. **Proposed
   fix:** return a typed resolution result with an actionable blocker, make
   preflight `allowed:false` and mint no token, then retain the current
   execute-time re-resolution/fingerprint check for TOCTOU safety.

5. **The deploy environment lock's age can override a demonstrably live owner
   (P1).** **Location:** `src/operator/commands/deploy.ts:104`. **Repro:** let a
   synchronous deploy legitimately run longer than four hours; a second
   deploy treats the lock as stale before checking that its PID is alive and
   can start concurrently. **Proposed fix:** never reclaim a live matching
   owner solely because of age; add a nonce/heartbeat or process-start
   identity so PID reuse remains detectable.

6. **Timeout environment variables parse inconsistently and often default
   silently (P2).** **Location:** `src/operator/commands/helpers.ts:656`,
   `src/operator/commands/review.ts:1687`,
   `src/operator/release-gate.ts:496`,
   `src/operator/api/actions.ts:1095`, and
   `src/operator/commands/deploy.ts:1363`. **Repro:** values such as `12junk`
   are partially accepted by `parseInt`, while an invalid healthcheck interval
   becomes `NaN` and effectively removes the wait. **Proposed fix:** introduce
   one strict positive-integer duration parser with explicit errors and
   per-setting minimum/maximum bounds, then use it across the command surface.

7. **Route deploy advertises review-override handling but has no executable
   override path (P2).** **Location:** `src/operator/api/actions.ts:275`,
   `src/operator/commands/api.ts:102`, and
   `src/operator/state.ts:3714`. **Repro:** a route-to-staging/prod plan that
   includes PR creation is blocked on review evidence; its evaluator knows
   about `override`/`reason`, but route deploy actions cannot carry those
   inputs through the underlying `deploy` command. **Proposed fix:** either add
   destination-only `--override --reason` support and thread it through route
   execution, or remove the dead evaluator branch and document that operators
   must complete review evidence first. Until then, unsupported values fail
   early instead of producing a successful preview followed by failed
   execution.

---

## Priority and sequencing

### API confirmation contract implemented by Q4

Risky API actions keep the default two-step flow. A preflight without
`--json` prints `PIPELANE_CONFIRM_TOKEN=<token>` as its first stdout line,
followed by the documented `ApiEnvelope`; strict `--json` output remains one
valid JSON document and exposes the token at
`data.preflight.confirmation.{token,expiresAt}`. Tokens are single-use,
fingerprint-bound, and live for 30 minutes. `--confirm-token` without
`--execute` is a hard error.

An agent driver may opt into the single-shot equivalent with:

```bash
PIPELANE_ALLOW_AUTOCONFIRM=1 pipelane run api action deploy.prod \
  --task <task> --execute --auto-confirm --json
```

Without `PIPELANE_ALLOW_AUTOCONFIRM=1`, `--auto-confirm` is rejected. A bare
`--execute` still refuses risky actions without a valid token.

### Review timeout and retry contract implemented by Q3

The default preset gives the `test` gate 45 minutes and every `ai-diff` gate
30 minutes. An explicit gate `timeoutMs` remains authoritative unless
`PIPELANE_REVIEW_GATE_TIMEOUT_MS=<milliseconds>` is set, which overrides all
gates for the current process. Invalid override values are hard errors instead
of silently falling back.

Timeouts remain fail-closed through the backwards-compatible gate
`status: "failed"`, with the additive `outcome: "timeout"` field and a visible
`TIMEOUT` marker. The result points directly to
`pipelane run review --gate <id>`.

Executable-gate retries are append-only evidence. For `/pr` attestation,
pipelane selects the latest matching full, non-filtered review run and
virtually composes the latest subsequent `--gate <id>` result with it when
branch, SHA, worktree identity, and gate definition all match. A newer failed
retry invalidates an older pass; command-backed skill gates participate, and
manual acceptance versus executable retry evidence follows `recordedAt`
chronology with exact ties failing closed. The stored full run is never
rewritten; unrelated or stale filtered runs cannot replace the full-run
envelope.

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
