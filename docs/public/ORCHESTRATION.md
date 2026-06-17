# Pipelane Orchestration Roadmap

Last updated: June 16, 2026
Status: review gate foundation and setup command shipped; full
orchestration runner not shipped

`/orchestrate` is the planned execution layer above Pipelane's current release
workflow. Its job is to turn an implementation plan into isolated slices,
configure review gates, run the gates in a deterministic order, and record the
evidence needed to trust AI-produced production code.

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

`/orchestrate` should act as a compiler and runner:

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
/pipelane review setup --preset lean
/pipelane review setup --preset standard
/pipelane review setup --preset strict-production
/pipelane review setup --print
/pipelane review setup --list-gates
```

Future extensions:

```text
/pipelane review setup --add-plan-gate plan-eng-review
/pipelane review setup --add-static-gate "npm run lint"
/pipelane review setup --add-ai-gate "/karpathy diff"
```

Setup should detect existing scripts before suggesting new gates. If a repo has
`lint`, `typecheck`, `test`, `build`, or `format:check`, use those commands. If
a script is missing, suggest it as a setup gap instead of silently inventing a
toolchain.

Karpathy gates should use the names humans naturally type:

- `/karpathy diff`, `/karpathy-diff`, and `/karpathy:diff` map to the
  `karpathy-diff` gate. This is a code-diff review gate.
- `/karpathy audit`, `/karpathy-audit`, and `/karpathy:audit` map to the
  `karpathy-audit` gate. This is an instruction and memory-file audit gate.

Do not conflate them. `/karpathy audit` should not run on ordinary product-code
diffs. It should run only when agent instruction files change, such as
`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/**`, or `.codex/skills/**`.

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
- AI diff gates: `/karpathy diff`, gstack `/review`, adversarial review
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

`/pipelane review setup` configures the gate stack. The implementation
supports preset selection, printing the effective config, and listing the gate
catalog with detected or missing scripts. `/pipelane review` runs the
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
/pipelane orchestrate goal-spec --plan-file docs/plan.md
/pipelane orchestrate goal-spec --outcome "Implement review gate enforcement"
/pipelane orchestrate goal-spec --provider codex --json
```

This drafts the provider-neutral `GoalSpec`, compact confirmation prompt, and
provider prompt. It does not create worktrees or run agents yet.

## Presets

`lean`:

- plan gates: engineering plan review
- static gates: detected typecheck/build
- behavioral gates: detected tests
- AI gates: `/karpathy diff`

`standard`:

- everything in `lean`
- design plan review for frontend work
- lint and format check when available
- gstack `/review`
- `/karpathy audit` when agent instruction files change
- browser QA for frontend work

`strict-production`:

- everything in `standard`
- security/data review for auth, billing, SQL, secrets, deploy, and infra
- adversarial review
- docs drift review
- secret scan and dependency audit when available
- human approval gates before merge, prod deploy, and rollback

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
    "preset": "standard",
    "planReview": {
      "gates": [
        { "id": "plan-eng-review", "phase": "plan", "type": "skill", "skill": "plan-eng-review", "blocking": true },
        { "id": "plan-design-review", "phase": "plan", "type": "skill", "skill": "plan-design-review", "when": "surface:frontend", "blocking": true }
      ]
    },
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
      { "id": "gstack-review", "phase": "ai-diff", "type": "skill", "skill": "review", "blocking": true },
      { "id": "adversarial-review", "phase": "ai-diff", "type": "agent", "role": "adversarial-code-reviewer", "blocking": true },
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
      { "id": "human-prod-deploy-approval", "phase": "human", "type": "approval", "when": "before:prod-deploy", "blocking": true }
    ]
  },
  "orchestrate": {
    "maxConcurrentSlices": 3,
    "goalMode": {
      "default": "confirm",
      "maxTurns": 20,
      "maxMinutes": 60,
      "requireConfirmationFor": ["auth", "billing", "schema", "secrets", "deploy", "prod"]
    },
    "hardStops": {
      "maxIterationsPerSlice": 3,
      "maxMinutesPerSlice": 60
    }
  }
}
```

## Review Gate Evidence

Every `/pipelane review` run writes evidence under existing Pipelane state:

```text
<git-common-dir>/<config.stateDir>/review-state.json
```

The bounded ledger records the latest runs with branch, SHA, preset, changed
files, gate order, skipped gates and skip reasons, command or skill result,
timeout status, output tails, and final blocking/advisory verdict.

`/pr` enforces blocking configured review gates before commit, push, or PR
handoff. A failed or pending blocking gate stops `/pr`. Evidence must be for
the current branch, HEAD, and worktree state, and cannot come from a dry-run or
filtered review. A skipped or unavailable optional gate records a warning, not a
crash.

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

Until `/orchestrate` ships, the board remains focused on branch, PR, deploy,
rollback, and cleanup state.

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
8. Next: build full `/orchestrate` slice execution on top of this foundation.

## Acceptance Criteria

- `/pipelane review setup` can print the effective gate config, list available gates, and persist lean/standard/strict-production presets.
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
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | not run | Optional outside voice not run for this pass. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 3 | CLEAR | Slices 1 and 2 reviewed clean; Slice 2 fixed catalog/example drift before handoff. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | Recommended before board UI implementation. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | Optional; useful before shipping setup UX. |

- **UNRESOLVED:** Worktree conflict model, provider adapter execution, human-gate execution, and full gate-runner trusted-baseline semantics still need implementation-level detail before full `/orchestrate`.
- **VERDICT:** ENG CLEARED for earlier slices. Review runner, `/pr` enforcement, and provider-neutral `GoalSpec` generation are implemented; next proceed to full slice execution.
