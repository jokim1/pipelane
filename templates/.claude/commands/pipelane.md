<!-- pipelane:command:pipelane -->
Run a Pipelane subcommand for this repo.

## Mode routing

Parse `$ARGUMENTS` by whitespace. Evaluate only the first token.

- Empty, `help`, `-h`, or `--help` → **JOURNEY OVERVIEW**. Do not run shell commands.
- Exactly equals `setup` → **SETUP MODE**. Strip the leading `setup` token and pass the rest to `pipelane:setup`.
- Exactly equals `configure` → **CONFIGURE MODE**. Strip the leading `configure` token and pass the rest to `pipelane:configure`.
- Exactly equals `web` → **WEB BOARD MODE**. Strip the leading `web` token and pass the rest to `pipelane:board`.
- Exactly equals `board` → **WEB BOARD MODE** compatibility alias. Strip the leading `board` token and pass the rest to `pipelane:board`.
- Exactly equals `status` → **STATUS MODE**. Strip the leading `status` token and pass the rest to `pipelane:status`.
- Exactly equals `review` → **REVIEW MODE**. Strip the leading `review` token and pass the rest to `pipelane:review`.
- Exactly equals `orchestrate` → **ORCHESTRATION MODE**. Strip the leading `orchestrate` token and pass the rest to `pipelane:orchestrate`.
- Exactly equals `update` → **UPDATE MODE**. Strip the leading `update` token and pass the rest to `pipelane:update`.
- Anything else → **UNKNOWN MODE**. Do not run shell commands; show the journey overview plus `Unknown /pipelane subcommand: <token>`.

No prefix matching. `/pipelane update-this-thing` routes to UNKNOWN MODE, not UPDATE MODE.

## Runner Selection

For setup, configure, update, and task-start flows, prefer the managed runner
before any repo-local npm script:

```bash
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_runner="$claude_home/skills/pipelane/bin/run-pipelane.sh"
claude_bin="$claude_home/skills/pipelane/bin/pipelane"
codex_runner="$codex_home/skills/.pipelane/bin/run-pipelane.sh"
codex_bin="$codex_home/skills/.pipelane/bin/pipelane"
```

Use `"$claude_runner" pipelane <subcommand> ...` when both the runner and its
managed `pipelane` binary exist, then use the Codex runner with the same check.
Use `npm run pipelane:*` only as a fallback after managed runners are missing or
incomplete.

---

## JOURNEY OVERVIEW

Print this overview directly. Keep the commands aligned in a code block so the user can scan the path.

```text
Pipelane

Pick a lane:

1. Build journey
Fast path. Merge hands off to production deploy.

  {{ALIAS_STATUS}}               See what is already in flight.
  {{ALIAS_DEVMODE}} build        Set the repo to build mode. Usually set once, until you switch lanes.
  {{ALIAS_NEW}}                  Create a named task worktree from the described task.
  /pipelane review              Run review gates and write evidence for the current diff.
  {{ALIAS_PR}} --title "PR title"  Enforce review evidence, run checks, commit, push, and open or update the PR.
  {{ALIAS_MERGE}}                Merge the PR. In build mode, this hands off to the prod deploy path.
  {{ALIAS_CLEAN}}                Clean up finished task state after the release is complete.

2. Release journey
Protected path. Promote the same merged SHA through staging, healthcheck verification, then prod.

  {{ALIAS_STATUS}}               See active tasks, deploy state, and release gates.
  {{ALIAS_DEVMODE}} release      Set the repo to release mode. Usually set once, until you switch lanes.
  {{ALIAS_NEW}}                  Create a named task worktree from the described task.
  /pipelane review              Run review gates and write evidence for the current diff.
  {{ALIAS_PR}} --title "PR title"  Enforce review evidence, run checks, commit, push, and open or update the PR.
  {{ALIAS_MERGE}}                Merge the PR and record the merged SHA.
  {{ALIAS_DEPLOY}} staging       Deploy the merged SHA to staging.
  {{ALIAS_DEPLOY}} prod          Promote the same merged SHA to production.
  {{ALIAS_CLEAN}}                Clean up finished task state after production is verified.

Helpful anytime:
  /pipelane setup                Sync or repair generated Pipelane repo files.
  /pipelane configure            Fill or update deploy targets and healthchecks.
  {{ALIAS_STATUS}}               See where tasks, PRs, deploys, and release gates stand.
  {{ALIAS_RESUME}}               Reopen or recover an existing task workspace.
  {{ALIAS_DOCTOR}}               Diagnose deploy config, probes, and release readiness.
  {{ALIAS_ROLLBACK}} prod        Roll back production to the last verified-good deploy.
  /fix                           Fix bugs, review findings, CI failures, and code-quality issues.
  /fix rethink                   Plan a larger codebase restructure before changing code.
  /pipelane orchestrate analyze --plan-file <path> --analysis-file <path>
                                  Record plan analysis before any worktree is created.
  /pipelane orchestrate plan --plan-file <path>
                                  Compile a plan into a durable slice ledger; analyze before prepare.
  /pipelane orchestrate prepare --run-id <id>
                                  Create slice worktrees from a run ledger.
  /pipelane orchestrate dispatch --run-id <id>
                                  Write provider handoff prompts for prepared slices.
  /pipelane orchestrate start --run-id <id> [--slice-id <id>] [--force]
                                  Start or retry configured workers and record per-slice evidence.
  /pipelane orchestrate review --run-id <id> [--slice-id <id>]
                                  Run review gates over completed worker slices.
  /pipelane orchestrate goal-spec --plan-file <path>
                                  Draft one provider-neutral GoalSpec without writing a run ledger.
  /pipelane web                  Open the local Pipelane Board.
  /pipelane update --check       Check whether Pipelane itself has updates.
```

---

## SETUP MODE

Run:

```bash
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_runner="$claude_home/skills/pipelane/bin/run-pipelane.sh"
claude_bin="$claude_home/skills/pipelane/bin/pipelane"
codex_runner="$codex_home/skills/.pipelane/bin/run-pipelane.sh"
codex_bin="$codex_home/skills/.pipelane/bin/pipelane"
if [ -x "$claude_runner" ] && [ -x "$claude_bin" ]; then
  "$claude_runner" pipelane setup $REST
elif [ -x "$codex_runner" ] && [ -x "$codex_bin" ]; then
  "$codex_runner" pipelane setup $REST
else
  npm run pipelane:setup -- $REST
fi
```

where `$REST` is `$ARGUMENTS` with the leading `setup` token stripped.

Use this path for `/pipelane setup` and `/pipelane setup --yes`. Display the output directly.

If setup offers to configure deploy targets, ask the user for the deploy values in chat, then run the matching `/pipelane configure --json ...` command.

---

## CONFIGURE MODE

Run:

```bash
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_runner="$claude_home/skills/pipelane/bin/run-pipelane.sh"
claude_bin="$claude_home/skills/pipelane/bin/pipelane"
codex_runner="$codex_home/skills/.pipelane/bin/run-pipelane.sh"
codex_bin="$codex_home/skills/.pipelane/bin/pipelane"
if [ -x "$claude_runner" ] && [ -x "$claude_bin" ]; then
  "$claude_runner" pipelane configure $REST
elif [ -x "$codex_runner" ] && [ -x "$codex_bin" ]; then
  "$codex_runner" pipelane configure $REST
else
  npm run pipelane:configure -- $REST
fi
```

where `$REST` is `$ARGUMENTS` with the leading `configure` token stripped.

Use this path for `/pipelane configure`, `/pipelane configure --json ...`, and deploy-config updates. Display the output directly.

When configure prints "Choose the action to take:", ask the user for deploy
values in chat, then run the matching `/pipelane configure --json ...` command
with the provided flags through the managed runner when available.

---

## WEB BOARD MODE

Run:

```bash
npm run pipelane:board -- $REST
```

where `$REST` is `$ARGUMENTS` with the leading `web` or `board` token stripped.

Common forms:

```bash
npm run pipelane:board             # start (if not already running) and open the browser
npm run pipelane:board -- status   # show URL, port, PID, log path
npm run pipelane:board -- stop     # stop the Pipelane Board for this repo
```

The board checks whether the dashboard is already responding on the configured port (`/api/health`). If it is, it just opens the browser to that URL. Otherwise it spawns the dashboard detached in the background, waits up to 8 seconds for it to become healthy, writes a PID file, and opens the browser.

Options:

- `--no-open` — start the server but do not open the browser.
- `--port <n>` — override the port for this invocation.
- `--repo <path>` — point at a different repo (default: cwd).

State lives under `~/.pipelane/dashboard/`:

- `pids/<slug>-<hash>.pid` — PID of the background dashboard
- `logs/<slug>-<hash>.log` — dashboard stdout/stderr
- `<slug>-<hash>.json` — per-repo board settings (title, subtitle, preferred port, auto-refresh)

Display the command output directly. If the dashboard failed to become healthy within 8s, surface the log path so the operator can inspect what went wrong.

---

## STATUS MODE

Run:

```bash
npm run pipelane:status -- $REST
```

where `$REST` is `$ARGUMENTS` with the leading `status` token stripped.

Use this path for `/pipelane status`, `/pipelane status --json`, `/pipelane status --week`, `/pipelane status --stuck`, and `/pipelane status --blast <sha>`. Display the output directly.

If `/pipelane update`, setup, status, or any other dispatcher flow runs after a
prior command printed a numbered selector, do not refer back to only "option 1"
or "option 2". Restate the number with its action label and command, for
example `1 (Continue to /deploy staging: run /merge, then /deploy staging)` or
`2 (Take one step only: run /merge)`.

---

## REVIEW MODE

Run:

```bash
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_runner="$claude_home/skills/pipelane/bin/run-pipelane.sh"
claude_bin="$claude_home/skills/pipelane/bin/pipelane"
codex_runner="$codex_home/skills/.pipelane/bin/run-pipelane.sh"
codex_bin="$codex_home/skills/.pipelane/bin/pipelane"
if [ -x "$claude_runner" ] && [ -x "$claude_bin" ]; then
  "$claude_runner" pipelane review $REST
elif [ -x "$codex_runner" ] && [ -x "$codex_bin" ]; then
  "$codex_runner" pipelane review $REST
else
  npm run pipelane:review -- $REST
fi
```

where `$REST` is `$ARGUMENTS` with the leading `review` token stripped.

Use this path for `/pipelane review`, `/pipelane review --json`, `/pipelane review --dry-run`, `/pipelane review --gate <id>`, `/pipelane review --phase <phase>`, and `/pipelane review setup ...`. Display the output directly.

Special case: when `$REST` is exactly `setup`, do not run the interactive setup command first. Agent Bash tools commonly run without an interactive TTY, and shell pipes make stdout non-TTY.

1. Run `/pipelane review setup --print` through the managed runner when available to inspect the current effective gate config.
2. If the user needs the available gate catalog, run `/pipelane review setup --list-gates` through the managed runner when available.
3. Present deterministic choices in chat:
   - `1. Save recommended gates: /pipelane review setup --yes`
   - `2. Cancel`
4. After the user chooses, run the matching command exactly.

If `$REST` starts with `setup --yes`, `setup --print`, `setup --list-gates`, or `setup --json`, run the command directly. Do not add shell pipes to setup commands that may need interactivity.

---

## ORCHESTRATION MODE

Run advanced subcommands directly:

```bash
npm run pipelane:orchestrate -- $REST
```

where `$REST` is `$ARGUMENTS` with the leading `orchestrate` token stripped. Use this
direct path for the low-level subcommands: `plan`, `analyze`, `plan-review`,
`prepare`, `dispatch`, `start`, `review`, `scope`, `outline`, `finalize`, and
`goal-spec`. Display the output directly.

### `/pipelane orchestrate <plan-file>` — communicative driven flow

When the operator points orchestrate at a plan file (or a goal to implement), do NOT
just run `--yes` and wait silently. Drive a slice-by-slice flow that keeps them
oriented:

1. **Read the plan yourself.** Print **Plan read** in bullets (strengths, then
   risks/gaps) plus a **coverage map** that accounts for every plan section as
   in-scope (→ a slice), deferred, or excluded (one-line reason). Nothing silently
   dropped.
2. **Decompose** into phases and slices. Write a scratch JSON
   `{ "slices": [{ "id", "title", "phase", "text" }], "coverage": [{ "section", "disposition", "sliceId", "reason" }] }`
   plus an analysis JSON with the real plan SHA-256, analyzer identity, strengths,
   risks, ambiguities, sensitiveAreas, and recommendedScope. Record analysis WITHOUT
   starting workers and capture the run id:
   `/pipelane orchestrate analyze --plan-file <real-plan> --analysis-file <analysis.json> --slices-file <scratch.json> --json`.
   The ledger's audit source stays bound to the real plan, not either scratch file.
3. **Relay the CLI outline verbatim** (`/pipelane orchestrate outline --run-id <id>`),
   then print the **review model** in bullets (static checks, tests, independent AI
   review of each slice diff, human confirm on sensitive slices).
4. **Recommend a scope** — full, or a justified partial boundary (sensitive phase
   first). Offer approve / edit scope / cancel; for partial run
   `/pipelane orchestrate scope --run-id <id> --through <last-slice-id-in-scope>`.
5. Before prepare, complete every pending plan-review gate: run the configured
   reviewer, then record `/pipelane orchestrate plan-review pass --run-id <id> --gate <gate-id> --message <summary>`
   or consciously bypass with `/pipelane orchestrate plan-review bypass --run-id <id> --gate <gate-id> --reason <reason>`.
   Then drive in order: `prepare`, `dispatch`, then per in-scope slice
   `start --run-id <id> --slice-id <id>` then `review --run-id <id> --slice-id <id>`,
   and after **each** slice relay `/pipelane orchestrate outline --run-id <id>` so the
   updated outline shows where the run is. Never use `--yes` here.
6. When the in-scope slices pass: if the outline lists deferred slices, the run is
   `paused` — tell the operator a later `/pipelane orchestrate` resumes it (re-scope
   `--through <next>`, continue). Use `/pipelane orchestrate finalize --run-id <id>`
   only to deliberately abandon the deferred remainder (kept in the ledger for audit).

If the plan compiles to a single unstructured slice, say so and propose a phase/slice
breakdown before running one long opaque slice.

---

## UPDATE MODE

Run:

```bash
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
claude_runner="$claude_home/skills/pipelane/bin/run-pipelane.sh"
claude_bin="$claude_home/skills/pipelane/bin/pipelane"
codex_runner="$codex_home/skills/.pipelane/bin/run-pipelane.sh"
codex_bin="$codex_home/skills/.pipelane/bin/pipelane"
if [ -x "$claude_runner" ] && [ -x "$claude_bin" ]; then
  "$claude_runner" pipelane update $REST
elif [ -x "$codex_runner" ] && [ -x "$codex_bin" ]; then
  "$codex_runner" pipelane update $REST
else
  npm run pipelane:update -- $REST
fi
```

where `$REST` is `$ARGUMENTS` with the leading `update` token stripped. Use this path to check for and install the latest Pipelane from `jokim1/pipelane#main`.

Common forms:

```bash
/pipelane update          # check, install if behind, auto-run setup
/pipelane update --check  # report upstream + local drift; no mutation
/pipelane update --json   # structured output; installs but never auto-runs setup
/pipelane update --yes    # apply setup guidance migrations without prompting
```

This command:

1. Reads the installed Pipelane version from `node_modules/pipelane/package.json` and the resolved commit from `package-lock.json`.
2. Fetches the latest `main` commit from `github:jokim1/pipelane` via `git ls-remote`.
3. If behind, summarizes the commits between (via `gh api repos/jokim1/pipelane/compare`, best effort) and runs `npm install pipelane@github:jokim1/pipelane#main` in the consumer repo. The user invoked `update` — that is the consent; no confirmation prompt.
4. Runs template-drift detection against the consumer repo. Surfaces the minimum follow-up needed — new/renamed slash commands, scaffold writes, Codex skill changes, other template re-renders — and runs setup inline automatically when there are no collisions. Prints reopen-Claude / reopen-Codex hints only when the affected surface actually changed. In `--check` mode this same detection runs without installing, so you can answer "is this consumer in sync?" any time.

Use `--check` to inspect without mutating. Use `--json` for structured output; JSON mode installs but does not auto-run setup — the caller decides via the `followUpSteps` field, which describes exactly which surfaces would change.

Collisions (existing non-pipelane files where managed files would land) are reported but NOT auto-resolved — setup is skipped and the operator must rename, remove, or adjust aliases before retrying.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
