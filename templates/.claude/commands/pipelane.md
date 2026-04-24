<!-- pipelane:command:pipelane -->
Run a Pipelane subcommand for this repo.

## Mode routing

Parse `$ARGUMENTS` by whitespace. Evaluate only the first token.

- Empty, `help`, `-h`, or `--help` → **JOURNEY OVERVIEW**. Do not run shell commands.
- Exactly equals `web` → **WEB BOARD MODE**. Strip the leading `web` token and pass the rest to `pipelane:board`.
- Exactly equals `board` → **WEB BOARD MODE** compatibility alias. Strip the leading `board` token and pass the rest to `pipelane:board`.
- Exactly equals `status` → **STATUS MODE**. Strip the leading `status` token and pass the rest to `pipelane:status`.
- Exactly equals `update` → **UPDATE MODE**. Strip the leading `update` token and pass the rest to `pipelane:update`.
- Anything else → **UNKNOWN MODE**. Do not run shell commands; show the journey overview plus `Unknown /pipelane subcommand: <token>`.

No prefix matching. `/pipelane update-this-thing` routes to UNKNOWN MODE, not UPDATE MODE.

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
  {{ALIAS_NEW}} "task name"      Create a clean task worktree and branch. The task name is optional.
  {{ALIAS_PR}}                   Run pre-PR checks, commit, push, and open or update the PR.
  {{ALIAS_MERGE}}                Merge the PR. In build mode, this hands off to the prod deploy path.
  {{ALIAS_SMOKE}} prod           Optional: run production-safe smoke checks if configured.
  {{ALIAS_CLEAN}}                Clean up finished task state after the release is complete.

2. Release journey
Protected path. Promote the same merged SHA through staging, smoke, then prod.

  {{ALIAS_STATUS}}               See active tasks, deploy state, and release gates.
  {{ALIAS_DEVMODE}} release      Set the repo to release mode. Usually set once, until you switch lanes.
  {{ALIAS_NEW}} "task name"      Create a clean task worktree and branch. The task name is optional.
  {{ALIAS_PR}}                   Run pre-PR checks, commit, push, and open or update the PR.
  {{ALIAS_MERGE}}                Merge the PR and record the merged SHA.
  {{ALIAS_DEPLOY}} staging       Deploy the merged SHA to staging.
  {{ALIAS_SMOKE}} staging        Run or verify staging smoke checks.
  {{ALIAS_DEPLOY}} prod          Promote the same merged SHA to production.
  {{ALIAS_SMOKE}} prod           Optional: run production-safe smoke checks.
  {{ALIAS_CLEAN}}                Clean up finished task state after production is verified.

Helpful anytime:
  {{ALIAS_STATUS}}               See where tasks, PRs, deploys, and release gates stand.
  {{ALIAS_RESUME}}               Reopen or recover an existing task workspace.
  {{ALIAS_DOCTOR}}               Diagnose deploy config, probes, and release readiness.
  {{ALIAS_ROLLBACK}} prod        Roll back production to the last verified-good deploy.
  /fix                           Fix bugs, review findings, CI failures, and code-quality issues.
  /fix rethink                   Plan a larger codebase restructure before changing code.
  /pipelane web                  Open the local Pipelane Board.
  /pipelane update --check       Check whether Pipelane itself has updates.
```

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

---

## UPDATE MODE

Run:

```bash
npm run pipelane:update -- $REST
```

where `$REST` is `$ARGUMENTS` with the leading `update` token stripped. Use this path to check for and install the latest Pipelane from `jokim1/pipelane#main`.

Common forms:

```bash
npm run pipelane:update              # check, prompt, install, run setup inline
npm run pipelane:update -- --check   # report upstream + local drift; no mutation
npm run pipelane:update -- --yes     # skip all prompts (CI / non-TTY); auto-runs setup
npm run pipelane:update -- --json    # structured output; never prompts
```

This command:

1. Reads the installed Pipelane version from `node_modules/pipelane/package.json` and the resolved commit from `package-lock.json`.
2. Fetches the latest `main` commit from `github:jokim1/pipelane` via `git ls-remote`.
3. If behind, summarizes the commits between (via `gh api repos/jokim1/pipelane/compare`, best effort) and prompts to upgrade.
4. On confirm, runs `npm install pipelane@github:jokim1/pipelane#main` in the consumer repo.
5. Runs template-drift detection against the consumer repo. Surfaces the minimum follow-up needed — new/renamed slash commands, scaffold writes, Codex skill changes, other template re-renders — and offers to run `npm run pipelane:setup` inline. Prints reopen-Claude / reopen-Codex hints only when the affected surface actually changed. In `--check` mode this same detection runs without installing, so you can answer "is this consumer in sync?" any time.

Use `--yes` in CI / non-TTY contexts to accept both the upgrade and the inline setup without prompts. Use `--json` for structured output; JSON mode never prompts and includes a `followUpSteps` field describing exactly which surfaces would change.

Collisions (existing non-pipelane files where managed files would land) are reported but NOT auto-resolved — setup is skipped and the operator must rename, remove, or adjust aliases before retrying.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
