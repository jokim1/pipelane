<!-- pipelane:command:pipelane -->
Run a Pipelane subcommand for this repo.

## Subcommand routing

**If `$ARGUMENTS` starts with `update`** (e.g. `/pipelane update`, `/pipelane update --check`), run:

```bash
npm run pipelane:update -- $REST
```

where `$REST` is `$ARGUMENTS` with the leading `update` token stripped. Use this path to check for and install the latest Pipelane from `jokim1/pipelane#main`. See the "pipelane update" section below.

**If `$ARGUMENTS` is empty**, run:

```bash
npm run pipelane:board
```

to open the Pipelane Board — the visual release-pipeline dashboard for this repo.

**If `$ARGUMENTS` starts with `board`, `start`, `stop`, or `status`**, route to the board:

```bash
npm run pipelane:board -- $BOARD_ARGS
```

where `$BOARD_ARGS` is `$ARGUMENTS` with the leading `board` stripped when present.

**If `$ARGUMENTS` starts with `fix`**, do not route through `/pipelane`; tell the user to run the managed `/fix` command instead so findings and root-cause checks are applied.

For any other leading token, stop and report the supported `/pipelane` subcommands (`update`, `board`, `start`, `stop`, `status`). Do not silently open the board for an unknown subcommand.

## `pipelane update`

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

## Pipelane Board (default)

Common forms:

```bash
npm run pipelane:board            # start (if not already running) and open the browser
npm run pipelane:board -- start   # explicit start
npm run pipelane:board -- stop    # stop the Pipelane Board for this repo
npm run pipelane:board -- status  # show URL, port, PID, log path
```

The board:

1. Checks whether the dashboard is already responding on the configured port (`/api/health`). If it is, just opens the browser to that URL.
2. Otherwise spawns the dashboard detached in the background, waits up to 8 seconds for it to become healthy, writes a PID file, and opens the browser.
3. Is safe to run repeatedly. No orphan servers, no port thrash.

Options:

- `--no-open` — start the server but do not open the browser.
- `--port <n>` — override the port for this invocation.
- `--repo <path>` — point at a different repo (default: cwd).

State lives under `~/.pipelane/dashboard/`:

- `pids/<slug>-<hash>.pid` — PID of the background dashboard
- `logs/<slug>-<hash>.log` — dashboard stdout/stderr
- `<slug>-<hash>.json` — per-repo board settings (title, subtitle, preferred port, auto-refresh)

Display the command output directly. If the dashboard failed to become healthy within 8s, surface the log path so the operator can inspect what went wrong.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
