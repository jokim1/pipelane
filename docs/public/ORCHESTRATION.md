# Pipelane Orchestration Reference

Last updated: June 26, 2026
Status: orchestration ledger, slice worktrees, provider handoff prompts,
worker launch, per-slice review, and bounded review-fix attempts are shipped.
PR creation, merge, deploy, cleanup, and full web orchestration visibility stay
outside orchestration.

`/orchestrate` is the execution layer above Pipelane's current release
workflow. Its job is to turn an implementation plan into isolated slices,
configure review gates, run worker and review loops in a deterministic order,
and record the evidence needed to trust AI-produced production code.

## Product Goal

Make AI coding faster without lowering the quality bar:

- smaller implementation slices
- fewer file conflicts
- deterministic checks before AI review
- independent reviewers for work the maker produced
- clear human gates for irreversible decisions
- evidence that survives context loss

The goal is not unlimited autonomy. The goal is auditable autonomy.

## Mental Model

`/orchestrate` acts as a compiler and runner:

1. read a plan
2. compile it into slices
3. assign file ownership and risks
4. attach configured gates
5. run implementation and review loops in isolated worktrees
6. produce a ledger of evidence
7. hand the branch back to existing Pipelane commands

Pipelane still owns `/new`, `/pr`, `/merge`, `/deploy`, `/rollback`, and
`/clean`.

## `/pipelane review setup`

`/pipelane review setup` configures what belongs in plan review and what
belongs in review gates. It is the user-facing gate setup command. It should
not be named `/pipelane setup review-gates`; that is longer than the concept.

Keep plain `/pipelane setup` for broader repo setup and onboarding. If
`/orchestrate setup` exists later, it should delegate gate configuration to the
same review-gate config rather than inventing a second setup path.

Current commands:

```text
/pipelane review setup
/pipelane review setup --toggle C3
/pipelane review setup --enable gstack-review
/pipelane review setup --disable typecheck
/pipelane review setup --install secret-scan
/pipelane review setup --reset
/pipelane review setup --print
/pipelane review setup --list-gates
```

Custom extensions:

```text
/pipelane review setup --add-plan-gate plan-eng-review
/pipelane review setup --add-static-gate "npm run lint"
/pipelane review setup --add-ai-gate "/karpathy diff"
```

Setup should detect existing scripts before suggesting new gates. If a repo has
`lint`, `typecheck`, `test`, `build`, or `format:check`, use those commands. If
a script is missing, suggest it as a setup gap instead of silently inventing a
toolchain.

The setup flow is opinionated by default. It should recommend deterministic
checks first, `/karpathy diff` as build-time author self-review, `/code-review high`
in a fresh reviewer context when Claude review support is available, gstack
`/review` as the independent fallback, and cross-model review when installed.
High-stakes paths add `/code-review ultra` and human approval. Users may opt out
of gates, but the UI should make the consequence explicit: less review coverage.
The authoring session must never attest its own independent AI review.

Known package-script installers are allowed to help, but only conservatively:
npm projects can install standard dev dependencies for lint and format-check;
pnpm, Yarn, Bun, mixed lockfiles, and framework-specific ESLint setups should
receive a concrete manual recipe rather than a generic generated config or an
unexpected package-manager mutation.

`--print` and `--list-gates` are read-only inspection modes. Do not combine
them with `--enable`, `--disable`, or `--install`; run the modifying command
first, then inspect the saved config.

Karpathy gates should use the names humans naturally type:

- `/karpathy diff`, `/karpathy-diff`, and `/karpathy:diff` map to the
  `karpathy-diff` gate. This is a code-diff review gate.
- `/karpathy audit`, `/karpathy-audit`, and `/karpathy:audit` map to the
  `karpathy-audit` gate. This is an instruction and memory-file audit gate.

Do not conflate them. `/karpathy audit` should not run on ordinary product-code
diffs. It should run only when agent instruction files change, such as
`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/**`, or `.codex/skills/**`.
If either Karpathy skill is missing, interactive setup can install it from
`https://github.com/jokim1/karpathy-skills.git` after explicit user approval.

## Gate Taxonomy

Plan review gates run before implementation:

- product or CEO review
- design plan review
- engineering plan review
- security/data-risk plan review
- developer experience review
- docs/release-impact review

Review gates run after implementation:

- static gates: lint, typecheck, format check, secret scan, dependency audit
- behavioral gates: tests, integration checks, build
- AI diff gates: `/karpathy diff`, gstack `/review`, adversarial review via
  Codex `/claude review code` or Claude-side gstack `/codex challenge`
- instruction gates: `/karpathy audit` when agent instruction files change
- runtime gates: browser QA, deploy health checks, staging evidence
- human gates: approval for schema, auth, billing, secrets, deploy, rollback

Static gates must run before AI gates. AI review should spend attention on
logic, architecture, traceability, edge cases, and risk, not syntax or style
problems a compiler or linter can catch.

## Implementation Amendment v1: Review Gates First

Before building full multi-agent `/orchestrate`, ship the shared review-gate
layer that both `/pr` and future `/orchestrate` will use.

User-facing commands:

```text
/pipelane review setup
/pipelane review
/pr
```

`/pipelane review setup` configures the gate stack. Bare setup is read-only:
it shows the saved grouped gate state or inferred recommended defaults without
rewriting config. Mutating flags such as `--toggle`, `--enable`, `--disable`,
`--install`, and `--reset` write immediately and reprint the grouped state.
`/pipelane review` runs the
configured gates against the current diff and writes evidence. `/pr` enforces
fresh, unfiltered evidence for the current branch, HEAD, and worktree state
before commit, push, or PR handoff.

Plain `/pipelane setup` remains repo/bootstrap setup. Do not use
`/pipelane setup review-gates`.

Gate order is canonical:

```text
static -> behavioral -> ai-diff -> instruction -> runtime -> human
```

Static and behavioral gates must run before AI review. Instruction gates are
separate from AI diff gates because they audit the files the agent reads, not
the product-code diff itself.

## Goal Mode Contract

Use goal mode for long, bounded slices where the finish line can be verified
without repeated human nudges. Do not require the user to fill out goal fields
manually. The compiler should draft a `GoalSpec`, critique it for vagueness or
impossible checks, then ask the user to approve, edit, split, or run without
goal mode.

Goal mode is an execution helper, not a gate. It helps a worker keep moving
toward a checkable finish line. Pipelane still owns file boundaries, review
gates, ledgers, `/pr` enforcement, and human approvals.

`GoalSpec` should be provider-neutral:

```jsonc
{
  "sliceId": "review-gates-schema",
  "outcome": "Implement reviewGates config schema and normalization",
  "finishLine": [
    "WorkflowConfig supports top-level reviewGates",
    "normalizeWorkflowConfig validates gate phase, type, and blocking fields",
    "Tests cover defaults, malformed gates, and missing optional scripts"
  ],
  "proveIt": [
    "Print changed files",
    "Print relevant test output",
    "Print git diff --stat",
    "Print skipped checks and reasons"
  ],
  "showMe": [
    "Summarize what changed",
    "List verification commands run",
    "List remaining blockers or follow-up risks"
  ],
  "blockedPolicy": [
    "Do not guess",
    "Stop after the turn or time budget",
    "Record the blocker, attempted paths, and what would unblock progress"
  ],
  "budget": {
    "maxTurns": 20,
    "maxMinutes": 60
  }
}
```

The confirmation prompt should be compact and outcome-oriented:

```text
Goal for slice: review-gates-schema

Finish line:
- Top-level reviewGates config exists and normalizes correctly.
- Invalid gate phase/type/blocking values fail with clear errors.
- Tests cover defaults, malformed gates, and missing optional scripts.

Proof to print:
- Changed files
- Test command output
- git diff --stat
- Any skipped checks and reasons

Budget:
- Stop after 20 turns or 60 minutes.

If blocked:
- Do not guess. Record blocker, attempted paths, and what would unblock it.

Approve, edit, split, or run without goal?
```

Ask the user before goal execution when the finish line is ambiguous, the slice
is too broad, proof depends on external systems or credentials, the run has a
meaningful time/token budget, or the slice touches auth, billing, schema,
secrets, deploy, or production. Do not ask when the plan already has clear
acceptance criteria, the slice maps cleanly to tests/build/typecheck, and the
work is low-risk.

Provider adapters render `GoalSpec` into native `/goal` prompts when available:

- Codex: prefer native `/goal`; ensure goals are enabled; use `/plan` first if
  the goal needs shaping; require evidence in the final handoff.
- Claude/Opus: prefer native `/goal` when available; use Opus for high
  complexity implementation or review slices; require the same finish-line,
  proof, handoff, and blocked-policy fields.
- Fallback: if native `/goal` is unavailable, use a normal prompt-loop with the
  same `GoalSpec`, but let Pipelane gates decide whether the slice is acceptable.

Current implementation surface:

```text
/pipelane orchestrate --plan-file docs/plan.md --analysis-file /tmp/analysis.json --provider codex --yes
/pipelane orchestrate plan --plan-file docs/plan.md
/pipelane orchestrate analyze --plan-file docs/plan.md --analysis-file /tmp/analysis.json
/pipelane orchestrate plan-review pass --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef --gate plan-eng-review --message "reviewed"
/pipelane orchestrate plan-review bypass --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef --gate plan-eng-review --reason "manual override"
/pipelane orchestrate prepare --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate dispatch --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate start --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef [--slice-id <id>] [--force]
/pipelane orchestrate review --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef [--slice-id <id>]
/pipelane orchestrate upgrade-ledger --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef
/pipelane orchestrate upgrade-ledger --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef --reseal-unsigned --reason "why this local ledger is trusted" --i-understand-this-trusts-local-state
/pipelane orchestrate goal-spec --plan-file docs/plan.md
/pipelane orchestrate goal-spec --outcome "Implement review gate enforcement"
/pipelane orchestrate goal-spec --provider codex --json
```

## Signed Run Ledgers

Every command that creates or mutates an orchestration run signs the run ledger
with `PIPELANE_ORCHESTRATION_STATE_KEY`. If the environment variable is unset,
Pipelane creates and reuses a machine-local key at
`~/.pipelane/keys/orchestration-state.key` (or
`$PIPELANE_HOME/keys/orchestration-state.key`) so fresh Codex/Claude chats can
continue without re-exporting a key. The file is written with `0600`
permissions where the platform supports POSIX modes.

Set `PIPELANE_ORCHESTRATION_STATE_KEY` explicitly when you want to supply or
rotate the operator key yourself. Explicit values must have at least 32
characters. `PIPELANE_ORCHESTRATION_STATE_KEY_FILE` may point at an alternate
machine-local key file.

```bash
export PIPELANE_ORCHESTRATION_STATE_KEY='use-a-random-32+-character-local-secret'
```

Each persisted `orchestration.json` is sealed with HMAC-SHA256 over the exact
disk envelope, including `schemaVersion`; only the `signature` field is
excluded from the HMAC. The ledger stores `integrity.version`,
`integrity.runId`, `integrity.mutationIndex`, and a non-secret key
fingerprint. Pipelane also writes a signed per-run integrity head outside the
run directory under orchestration state. The head records the latest mutation
index and latest ledger signature, so restoring only an older
`orchestration.json` fails closed as a rollback.

Unsigned pre-hardening ledgers are a clean break. Pipelane does not silently
migrate or trust them, and signed ledgers are verified before any legacy
migration/normalization runs. Default diagnostics distinguish blank and
too-short keys; wrong keys; malformed JSON; missing ledgers; invalid run ids;
legacy unsigned ledgers; signature tampering; and ledger-only rollback.
Wrong-key errors mention the key fingerprint mismatch, never the key value.
Key-mismatched prior ledgers are shown as warnings during new-run discovery and
still fail closed when opened by explicit run id.

The only recovery path for an old unsigned run is explicit resealing:

```bash
pipelane run orchestrate upgrade-ledger \
  --run-id orchestrate-YYYYMMDDHHMMSS-deadbeef \
  --reseal-unsigned \
  --reason "reviewed local backup from before signing shipped" \
  --i-understand-this-trusts-local-state
```

That command intentionally trusts the local unsigned JSON at reseal time, adds
the reseal reason to the signed ledger, and writes a fresh signed integrity
head. It is not a tamper repair tool for signed ledgers whose signature fails.

Local threat model: the guard detects accidental edits, wrong-key reads,
ledger transplants, malformed/torn writes, and restoring an older ledger
without also restoring Pipelane's integrity head. It does not protect against an
attacker who can read the operator signing key or its machine-local key file,
replace both the ledger and all integrity state with a consistent older
snapshot, or modify the Pipelane executable before it verifies state. Pipelane
does not pass workers `PIPELANE_ORCHESTRATION_STATE_KEY`,
`PIPELANE_ORCHESTRATION_STATE_KEY_FILE`, or `PIPELANE_HOME`; the deny-list
strips them even if `PIPELANE_ORCHESTRATE_WORKER_ENV_ALLOW` names them. This
prevents accidental env disclosure, but it is not a same-user filesystem
sandbox.

The approved bare command requires a host-authored `--analysis-file` and records
plan analysis before creating any worktree. It then runs `prepare`, `dispatch`,
`start`, full slice review, and bounded review-fix attempts in one durable pass.
It does not create an integrated PR, merge, deploy, or clean worktrees. Failed
executable review gates are handed back to the slice worker before Pipelane
reruns review; remaining failed, pending, or blocked review leaves the run
active and returns a non-zero exit code. Automatic completion requires at least
one effective review gate; orchestration review blocks zero-gate evidence and
asks the operator to run `/pipelane review setup`.

The analysis artifact is JSON and must describe the same plan or prompt hash
that the ledger records:

```json
{
  "sourceSha256": "64-character lowercase sha256 of the plan text or outcome prompt",
  "analyzer": {
    "provider": "codex",
    "sessionId": "raw-session-id-or-null",
    "source": "CODEX_SESSION_ID"
  },
  "identityReliable": true,
  "strengths": ["clear slice boundaries"],
  "risks": ["review gate setup affects PR readiness"],
  "ambiguities": [],
  "sensitiveAreas": ["src/operator/commands/orchestrate.ts"],
  "recommendedScope": {
    "throughSliceId": null,
    "reason": null
  }
}
```

`sourceSha256` must be a 64-character SHA-256 hex string. `analyzer.provider`
and `analyzer.source` must be non-empty strings; `analyzer.sessionId` must be a
string or `null`. Set `identityReliable` to `true` only when the host can bind
the analyzer to a real session identity. Skill or agent plan-review gates can
only be marked `pass` when analyzer and attester sessions are both reliable and
different; otherwise use the visible `plan-review bypass --reason <text>` path.
The four analysis lists must be arrays of strings. `recommendedScope` is
optional; when present, `throughSliceId` and `reason` must each be a string or
`null`.

`orchestrate plan` compiles an implementation plan into a durable orchestration
ledger with slice records, provider-neutral `GoalSpec` prompts, a review-gate
snapshot, and the source plan fingerprint. New ledgers must pass
`orchestrate analyze` before `prepare`; existing ledgers without the
`planAnalysisRequired` marker remain legacy-compatible. `orchestrate analyze`
validates a host-authored analysis artifact against the current source hash,
records configured plan-review gates as skipped or pending, and stores
structured observations in versioned run state. `orchestrate prepare` consumes
that ledger, creates missing slice worktrees using the same task-lock machinery
as `/new`, and records each task slug, branch, and worktree path. `orchestrate
dispatch` consumes prepared ledgers and writes durable provider handoff prompts
under the run state directory. It records which prompt belongs to which prepared
worktree. `orchestrate start` consumes dispatch records, runs a configured
worker command from each eligible worktree, feeds the handoff prompt on stdin,
streams redacted per-slice log/exit evidence, and supports `--force` to retry
failed or stale running worker records. Codex and Claude providers use native
CLI defaults when their CLIs are available on `PATH`; explicit
`PIPELANE_ORCHESTRATE_*_COMMAND` values still override those defaults.
`orchestrate review` consumes completed worker slices, runs the run's
review-gate snapshot from each slice worktree, records per-slice gate evidence
in the orchestration ledger, and blocks the run on failed, pending,
slice-filtered, gate-filtered, phase-filtered, or dry-run evidence. Merge,
deploy, and cleanup remain outside orchestration.
While command gates run, `orchestrate review` and the bare `orchestrate --yes`
review phase print slice and gate progress on stderr. Review-fix attempts also
announce the failed gates they are fixing and when review is rerun. If AI,
agent, or approval gates remain pending, the final report lists the pending
slice/gate pairs, the command to run, and the slice worktree.
`orchestrate start` mints a per-worker run identity, exports it to the worker
as `PIPELANE_AGENT_SESSION_ID`, and stores only its hashed fingerprint in the
ledger. Review evidence also stores hashed reviewer or attester fingerprints
when the host exposes one. The ledger trust check evaluates passed blocking AI
review evidence only when such passed evidence is recorded: the recorded
reviewer must be from a different session than the recorded worker.
Cross-provider review is preferred and labeled as such; same-provider review
can satisfy the gate only when it records a separate known-provider session.
Manual AI gates stay pending until an attested evidence flow records a pass,
rather than being treated as rejected review evidence. When an operator runs a
full `/pipelane review` inside the slice worktree and records a manual pass
there, the next `orchestrate review` attaches matching passed manual gates by
branch, HEAD, worktree digest, and gate definition. These fingerprints are
provenance evidence for Pipelane's quality gates, not cryptographic
authentication. Pre-identity review records remain legacy-compatible, but new
review evidence that records a reviewer identity must also record attesters for
passed blocking AI gates. Live slice worktrees reviewed before worktree-status
digests were recorded may need a fresh full review after upgrade; completed
slices whose worktrees have already been removed keep their terminal review
state.
`goal-spec` remains the single-slice draft-only command.

`orchestrate start` launcher configuration is explicit:

```bash
PIPELANE_ORCHESTRATE_WORKER_COMMAND='your-worker-command'
# Optional overrides. Without these, Codex defaults to `codex exec --full-auto -`
# when `codex` is installed. Claude defaults to `claude --print` plus the
# best supported non-interactive permission mode from `claude --help`.
PIPELANE_ORCHESTRATE_CODEX_COMMAND='codex-specific-command'
PIPELANE_ORCHESTRATE_CLAUDE_COMMAND='claude-specific-command'
PIPELANE_ORCHESTRATE_WORKER_TIMEOUT_MS=3600000
```

The worker command runs with the slice worktree as `cwd`. The prompt is passed
on stdin, stdout/stderr are streamed to redacted evidence logs, and Pipelane
also sets `PIPELANE_AGENT_PROVIDER`, `PIPELANE_AGENT_SESSION_ID`,
`PIPELANE_ORCHESTRATE_WORKER_SESSION_ID`, `PIPELANE_ORCHESTRATE_RUN_ID`,
`PIPELANE_ORCHESTRATE_SLICE_ID`, `PIPELANE_ORCHESTRATE_PROVIDER`,
`PIPELANE_ORCHESTRATE_PROMPT_PATH`, `PIPELANE_ORCHESTRATE_WORKTREE_PATH`,
`PIPELANE_ORCHESTRATE_LOG_PATH`, and `PIPELANE_ORCHESTRATE_LEDGER_PATH`.
Native parent session variables such as `CODEX_SESSION_ID` and
`CLAUDE_SESSION_ID` are not inherited by worker children; worker-context
identity resolves through `PIPELANE_ORCHESTRATE_WORKER_SESSION_ID`. State
signing keys such as `PIPELANE_REVIEW_STATE_KEY` are also stripped from worker
children so autonomous implementation workers cannot accidentally mint trusted
review evidence. Credential-shaped environment variables such as tokens,
secrets, API keys, passwords, cookies, cloud provider credentials, and
`SSH_AUTH_SOCK` are stripped by default. If a worker truly needs a credential,
pass it explicitly with `PIPELANE_ORCHESTRATE_WORKER_ENV_ALLOW=NAME,OTHER_NAME`;
Pipelane still strips native agent session ids and state signing keys. This
default includes provider-style API keys such as `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY`; allowlist them only when the worker CLI genuinely uses
environment-based auth instead of local subscription/config auth.

Manual AI review evidence from a slice worktree is only promoted into
orchestration review when review state signing is enabled. Set the same
`PIPELANE_REVIEW_STATE_KEY` for the standalone slice `/pipelane review`,
`/pipelane review pass`, and parent `/pipelane orchestrate review` commands.
Unsigned manual evidence stays visible in the slice worktree but does not
complete orchestration review gates.

## Config Contract

Review gates live in `.pipelane.json` under top-level `reviewGates`. They are
not nested inside `orchestrate`; `/orchestrate` consumes the same review-gate
config later.

Each gate has:

- `id`
- `phase`
- `type`
- `command` or `skill`
- `blocking`
- optional `whenChanged`
- optional `timeoutMs`
- optional `userCommands`

```jsonc
{
  "reviewGates": {
    "planReview": {
      "gates": [
        { "id": "plan-eng-review", "phase": "plan", "type": "skill", "skill": "plan-eng-review", "blocking": true },
        { "id": "plan-design-review", "phase": "plan", "type": "skill", "skill": "plan-design-review", "when": "surface:frontend", "blocking": true }
      ]
    },
    "policyVersion": 2,
    "gates": [
      { "id": "typecheck", "phase": "static", "type": "command", "command": "npm run typecheck", "blocking": true },
      { "id": "lint", "phase": "static", "type": "command", "command": "npm run lint", "blocking": true },
      { "id": "format-check", "phase": "static", "type": "command", "command": "npm run format:check", "blocking": true },
      { "id": "test", "phase": "behavioral", "type": "command", "command": "npm run test", "blocking": true },
      { "id": "build", "phase": "behavioral", "type": "command", "command": "npm run build", "blocking": true },
      {
        "id": "karpathy-diff",
        "phase": "ai-diff",
        "type": "skill",
        "skill": "karpathy-diff",
        "userCommands": ["/karpathy diff", "/karpathy-diff", "/karpathy:diff"],
        "blocking": true
      },
      {
        "id": "code-review-high",
        "phase": "ai-diff",
        "type": "agent",
        "role": "claude-code-review-high",
        "userCommands": ["/code-review high"],
        "blocking": true
      },
      { "id": "gstack-review", "phase": "ai-diff", "type": "skill", "skill": "review", "blocking": true },
      {
        "id": "adversarial-review",
        "phase": "ai-diff",
        "type": "agent",
        "role": "adversarial-code-reviewer",
        "userCommands": ["/claude review code", "/codex challenge"],
        "blocking": true
      },
      {
        "id": "code-review-ultra",
        "phase": "ai-diff",
        "type": "agent",
        "role": "claude-code-review-ultra",
        "when": "risk:auth|billing|migrations|sql|secrets|deploy|infra|concurrency|api|rollback",
        "userCommands": ["/code-review ultra", "claude ultrareview --json"],
        "blocking": true
      },
      {
        "id": "karpathy-audit",
        "phase": "instruction",
        "type": "skill",
        "skill": "karpathy-audit",
        "userCommands": ["/karpathy audit", "/karpathy-audit", "/karpathy:audit"],
        "whenChanged": ["CLAUDE.md", "AGENTS.md", ".cursor/rules/**", ".codex/skills/**"],
        "blocking": true
      },
      { "id": "browser-qa", "phase": "runtime", "type": "skill", "skill": "qa-only", "when": "surface:frontend", "blocking": true },
      { "id": "high-stakes-human-approval", "phase": "human", "type": "approval", "when": "risk:auth|billing|migrations|sql|secrets|deploy|infra|concurrency|api|rollback", "blocking": true },
      { "id": "human-prod-deploy-approval", "phase": "human", "type": "approval", "when": "before:prod-deploy", "blocking": true }
    ]
  },
  "orchestrate": {
    "maxConcurrentSlices": 1,
    "goalMode": {
      "default": "confirm",
      "maxTurns": 20,
      "maxMinutes": 60,
      "requireConfirmationFor": ["auth", "billing", "schema", "secrets", "deploy", "prod"]
    },
    "hardStops": {
      "maxIterationsPerSlice": 3,
      "maxReviewLoops": 2,
      "maxMinutesPerSlice": 60
    }
  }
}
```

`maxConcurrentSlices` is snapshotted for future dependency-aware concurrency.
Current orchestration still runs slices sequentially; examples use `1` to avoid
implying active worker fanout.

`maxReviewLoops` caps review/fix cycles per slice during approved orchestration.
`1` runs only the initial review and stops on failure; `2` permits one
review-fix worker attempt followed by one rerun of the review gates. If omitted,
Pipelane falls back to `maxIterationsPerSlice` for older configs, then to `2`.

## Review Gate Evidence

Every `/pipelane review` run writes evidence under existing Pipelane state:

```text
<git-common-dir>/<config.stateDir>/review-state.json
```

The bounded ledger records the latest runs with branch, SHA, changed
files, gate order, skipped gates and skip reasons, command or skill result,
timeout status, output tails, and final blocking/advisory verdict.

`/pr` enforces blocking configured review gates before commit, push, or PR
handoff. A failed or pending blocking gate stops `/pr`. Evidence must be for
the current branch, HEAD, and worktree state, and cannot come from a dry-run or
filtered review. A skipped or unavailable optional gate records a warning, not a
crash. When review evidence records a reviewer session, any passed blocking AI
gate must also record an attester from a separate trusted session.

Skill and agent gates run automatically when Pipelane can resolve an AI review
command. Resolution order is gate `command`, gate-specific environment
override (`PIPELANE_REVIEW_<GATE_ID>_COMMAND` or
`PIPELANE_REVIEW_GATE_<GATE_ID>_COMMAND`), shared environment override
(`PIPELANE_REVIEW_AI_COMMAND` or `PIPELANE_REVIEW_GATE_COMMAND`), then the
installed native Codex/Claude CLI default. The command receives a review prompt
on stdin and must print `PIPELANE_REVIEW_GATE_RESULT=passed` or
`PIPELANE_REVIEW_GATE_RESULT=failed` on its own line. Missing result markers
fail closed.

AI review commands must not modify files. Pipelane snapshots the worktree
before and after each AI review command; if the digest changes or cannot be
verified, the gate fails and the operator must revert reviewer changes before
rerunning review.

If no AI command resolves, skill, agent, and approval gates remain manual. After
the operator runs the referenced command, fixes any findings, and determines
the gate is clean, record the pass explicitly:

```bash
pipelane run review pass --gate gstack-review --message "Ran /review clean"
```

The pass command only applies to a full, non-dry-run review for the current
branch, HEAD, and worktree state. If the worktree changes, rerun
`/pipelane review` before recording manual passes again.

For orchestration slices, run those two commands from the slice worktree. The
parent `orchestrate review` command will attach matching passed manual gates on
the next run while still rerunning command gates from the slice worktree.

## Orchestration Ledger

Every orchestration run should write an evidence ledger under Pipelane state:

```text
<git-common-dir>/<config.stateDir>/orchestrate/runs/<run-id>/orchestration.json
```

The ledger should record:

- source plan path or prompt
- slice graph
- worktree/branch for each slice
- allowed and forbidden file sets
- gate configuration snapshot
- gate results and command output paths
- retries and failures
- human approvals
- final recommendation

The ledger is the memory layer. A later agent should be able to resume the run
without relying on chat history.

## Board Integration

The board should eventually show:

- active orchestration runs
- slices and assigned worktrees
- static/behavioral/AI/runtime gate status
- blocked gates and next action
- evidence links
- human approval requests

Until full board orchestration visibility ships, the board remains focused on
branch, PR, deploy, rollback, and cleanup state.

## Non-Goals

Do not add:

- auto-merge to main
- auto-deploy to production
- unlimited agent fanout
- a single all-powerful coordinator agent
- provider-specific assumptions as the only path
- review gates that run after production deploy
- open-ended goal loops without a checkable finish line and blocked stop policy

## First Implementation Slices

1. Done: add config schema, defaults, normalization, and validation.
2. Done: add canonical gate catalog and script detection.
3. Done: implement `/pipelane review setup`.
4. Done: implement `/pipelane review` runner and review-gate evidence ledger.
5. Done: add board/API read-only visibility for review-gate runs.
6. Done: wire blocking review gates into `/pr`.
7. Done: add provider-neutral `GoalSpec` generation for future slice execution.
8. Done: add durable `/pipelane orchestrate plan` ledger compilation.
9. Done: add `/pipelane orchestrate prepare` worktree assignment on top of the ledger.
10. Done: add `/pipelane orchestrate dispatch` provider handoff prompts for prepared slice worktrees.
11. Done: add `/pipelane orchestrate start` configured worker launch and completion evidence.
12. Done: add native Codex/Claude adapter defaults and review-gate execution over completed worker slices.
13. Done: make approved bare `/pipelane orchestrate --yes` run slice review, make bounded review-fix attempts for failed executable gates, and fail closed on remaining pending, blocked, failed, or missing-gate review.

## Acceptance Criteria

- `/pipelane review setup` can print the effective gate config, list available gates, inspect grouped rows without writing, and persist explicit gate mutations immediately.
- Later setup extensions can add or remove individual plan-review gates independently from implementation review gates.
- Static gates run before AI gates.
- Missing optional scripts or skills produce warnings, not crashes.
- Generated `GoalSpec` objects require checkable finish lines, visible proof,
  handoff output, blocked policy, and a turn/time budget.
- `/pipelane review` writes evidence under the existing Pipelane state root.
- `/pr` runs blocking configured review gates before PR handoff.
- Blocking gate failures stop the orchestration run before merge/deploy.
- Existing Pipelane release commands remain unchanged.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | Optional for product scope. |
| Codex Review | `/codex challenge` | Adversarial Codex review | 0 | not run | Optional outside voice not run for this pass. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 3 | CLEAR | Slices 1 and 2 reviewed clean; Slice 2 fixed catalog/example drift before handoff. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | Recommended before board UI implementation. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | Optional; useful before shipping setup UX. |

- **UNRESOLVED:** Board/API visibility for orchestration runs still needs implementation-level detail before full autonomous `/orchestrate`.
- **VERDICT:** ENG CLEARED for earlier slices. Review runner, `/pr` enforcement, provider-neutral `GoalSpec` generation, durable ledger compilation, worktree preparation, dispatch prompt generation, configured worker launch evidence, native provider defaults, per-slice review gate execution, and matching manual evidence attachment are implemented.
