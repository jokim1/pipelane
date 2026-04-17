Run a Pipelane subcommand for this repo.

## Subcommand routing

**If `$ARGUMENTS` starts with `update`** (e.g. `/pipelane update`, `/pipelane update --check`), run:

```bash
npm run pipelane:update -- $REST
```

where `$REST` is `$ARGUMENTS` with the leading `update` token stripped. Use this path to check for and install the latest Pipelane from `jokim1/pipelane#main`. See the "pipelane update" section below.

**Otherwise** (the default, including bare `/pipelane`), run:

```bash
npm run pipelane:board -- $ARGUMENTS
```

to open the Pipelane Board — the visual release-pipeline dashboard for this repo.

## `pipelane update`

Common forms:

```bash
npm run pipelane:update              # check, prompt, install if newer
npm run pipelane:update -- --check   # report status without mutating
npm run pipelane:update -- --yes     # skip the prompt (CI / non-TTY)
npm run pipelane:update -- --json    # emit JSON
```

This command:

1. Reads the installed Pipelane version from `node_modules/pipelane/package.json` and the resolved commit from `package-lock.json`.
2. Fetches the latest `main` commit from `github:jokim1/pipelane` via `git ls-remote`.
3. If behind, summarizes the commits between (via `gh api repos/jokim1/pipelane/compare`, best effort) and prompts to upgrade.
4. On confirm, runs `npm install pipelane@github:jokim1/pipelane#main` in the consumer repo.
5. Reports the new installed commit.

After an upgrade, remember that `.project-workflow.json` alias changes require rerunning `npm run pipelane:setup` so Claude/Codex pick up renamed commands.

## Pipelane Board (default)

Common forms:

```bash
npm run pipelane:board            # start (if not already running) and open the browser
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

State lives under `~/.workflow-kit/dashboard/` (path retained across the workflow-kit → pipelane rename; a `~/.pipelane/dashboard/` migration ships in a follow-up release):

- `pids/<slug>-<hash>.pid` — PID of the background dashboard
- `logs/<slug>-<hash>.log` — dashboard stdout/stderr
- `<slug>-<hash>.json` — per-repo board settings (title, subtitle, preferred port, auto-refresh)

Display the command output directly. If the dashboard failed to become healthy within 8s, surface the log path so the operator can inspect what went wrong.
