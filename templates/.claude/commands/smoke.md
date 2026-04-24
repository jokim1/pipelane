<!-- pipelane:command:smoke -->
Plan smoke coverage, configure the smoke runner, or run deterministic smoke against staging or prod.

Run:

```bash
npm run pipelane:smoke -- $ARGUMENTS
```

Expected subcommands:

- `plan` — scaffolds or audits `.pipelane/smoke-checks.json` and prints the top actions.
- `setup` — wires a smoke runner command into `.pipelane.json`. See "Setup quoting" below for passing commands with spaces / metacharacters.
- `staging` — runs smoke for the currently deployed staging SHA.
- `prod` — runs the prod-safe smoke subset for the currently deployed prod SHA.
- `waiver` / `quarantine` / `unquarantine` — coverage-registry management.

Rules:

- `staging` / `prod` inject `PIPELANE_SMOKE_ENV`, `PIPELANE_SMOKE_BASE_URL`, `PIPELANE_SMOKE_SHA`, and `PIPELANE_SMOKE_RUN_ID` into the repo-owned smoke command.
- `setup` is two-mode: either **auto-wired** (exactly one strong candidate package script, or explicit `--staging-command`) or **needs input** (multiple candidates, weak-only, or no candidates — setup writes nothing and tells you which flag to pass).
- `setup` refuses to promote a release gate it cannot run: `--require-staging-smoke=true` plus no staging command is treated as misconfigured and exits 1.
- `setup` exit codes: 0 for `configured` / `already configured` / `needs input`; 1 for `misconfigured` or write failures.

## Setup quoting

`--staging-command` values routinely contain spaces and shell metacharacters. Quote them carefully:

- **Claude slash command:** `/smoke setup --staging-command="npm run test:e2e:smoke"` (single quotes also work).
- **Codex skill:** same double-quoted form.
- **npm script:** `npm run pipelane:smoke -- setup --staging-command="npm run test:e2e:smoke"` (note the `--` separator).
- **Bare CLI:** `pipelane run smoke setup --staging-command='npm run test:e2e:smoke --grep="smoke-auth"'` (single quotes when the value contains double quotes; avoid literal `@smoke-*` tag syntax in docs or smoke tag discovery will treat the doc itself as a test source).

Setup flags (accepted only on `smoke setup`):

- `--staging-command=<cmd>` — required unless auto-wired or already configured.
- `--prod-command=<cmd>` — optional; omitted prod commands stay unconfigured.
- `--require-staging-smoke=true|false` — release-gate switch; must pair with a staging command when true.
- `--generated-summary-path=<path>` — override the smoke summary output path.
- `--critical-path=<surface-or-path>` — repeatable; deduped, first-seen order preserved.
- `--critical-path-coverage=warn|block` — how /deploy prod treats uncovered critical paths.

Display the output directly and keep the environment explicit.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
