## Pipelane Workflow

This repo uses `pipelane`, the release pipeline management and safety layer for
AI-first builders.

Pipelane is here to make parallel AI-coded work legible. It tracks task
worktrees, branches, PRs, staging deploys, production deploys, and
cleanup state so the repo does not depend on memory or chat history.

Start with:

```text
/pipelane
```

That prints the build and release journeys for this repo.

For code-changing work, start with `{{ALIAS_NEW}}` before editing and switch to
the reported task worktree. If another tool already created the branch or
worktree, run `{{ALIAS_ADOPT}}` instead so Pipelane can track it. If task
workspace setup fails, do not continue in the shared checkout.

### Build Journey

Build mode is the fast lane. Use it when you want the shortest route from merge
to production and do not need required staging validation for the same SHA.

```text
{{ALIAS_DEVMODE}} build          Use the fast lane.
{{ALIAS_NEW}}                    Let the AI infer the task name, or provide one if you want.
{{ALIAS_ADOPT}}                  Track an existing branch/worktree instead of creating another one.
{{ALIAS_PR}} --title "PR title"  Run pre-PR checks, commit, push, and open or update the PR.
{{ALIAS_MERGE}}                  Merge the PR, record delivery, and close the clean task workspace.
```

Continue from the primary shared checkout printed by merge. Pass
`{{ALIAS_MERGE}} --keep-worktree` only when durable retention is intentional.

### Release Journey

Release mode is the protected lane. Use it when staging must prove the exact
same merged SHA before production can move.

```text
{{ALIAS_DEVMODE}} release        Use the protected lane.
{{ALIAS_RELEASE}} status         Inspect release module setup and readiness.
{{ALIAS_NEW}}                    Let the AI infer the task name, or provide one if you want.
{{ALIAS_ADOPT}}                  Track an existing branch/worktree instead of creating another one.
{{ALIAS_PR}} --title "PR title"  Run pre-PR checks, commit, push, and open or update the PR.
{{ALIAS_MERGE}}                  Merge the PR, record delivery, and close the clean task workspace.
{{ALIAS_DEPLOY}} staging --pr <merged-pr-number>  From the shared checkout, deploy the immutable merged SHA.
{{ALIAS_DEPLOY}} prod --pr <merged-pr-number>     Promote that same SHA to production.
```

The explicit PR number lets deploy reconstruct the exact task mode and surfaces
from immutable delivery history; the removed edit worktree is not needed.

### Helpful Anytime

```text
/pipelane web                    Open the local Pipelane Board.
{{ALIAS_STATUS}}                 Render the terminal cockpit.
{{ALIAS_RELEASE}} enable         Scaffold the optional release module.
{{ALIAS_RELEASE}} doctor --probe Refresh staging healthcheck evidence.
{{ALIAS_RESUME}}                 Reopen or recover an existing task workspace.
{{ALIAS_DOCTOR}}                 Diagnose deploy config, probes, and release readiness.
{{ALIAS_ROLLBACK}} prod          Roll production back to the last verified-good deploy.
/fix                             Fix bugs, review findings, CI failures, and code-quality issues.
/fix rethink                     Audit refactor hotspots and plan a restructure before changing code.
```

### What Each Command Is For

- `/pipelane`: build/release overview and web/status/update subcommands
- `/pipelane web`: local visual board for branch pipeline state
- `{{ALIAS_STATUS}}`: terminal cockpit from the same API as the board
- `{{ALIAS_DEVMODE}}`: switch between `build` and `release`
- `{{ALIAS_NEW}}`: create an isolated task worktree and branch
- `{{ALIAS_ADOPT}}`: bind an existing branch/worktree to a Pipelane task
- `{{ALIAS_RESUME}}`: recover an existing task worktree
- `{{ALIAS_PR}}`: run checks, commit, push, and open or update a PR
- `{{ALIAS_MERGE}}`: merge the PR, record immutable delivery history, and normally close the task workspace
- `{{ALIAS_RELEASE}}`: enable or inspect the optional release module
- `{{ALIAS_DEPLOY}}`: deploy to `staging` or `prod`
- `/fix`: make durable root-cause fixes from findings
- `{{ALIAS_CLEAN}}`: preview cleanup or explicitly retry retained, blocked, delivered, or stale task state
- `{{ALIAS_DOCTOR}}`: diagnose deploy config and live probes
- `{{ALIAS_ROLLBACK}}`: roll back to the last verified-good deploy

### Slash Aliases

Slash commands are the normal Claude/Codex interface. Repo-native scripts exist
under the hood, but workflow guidance should point operators at the slash
aliases above.

The default alias set can be changed in machine-local Pipelane config. If
aliases change, rerun setup and reopen Claude/Codex so the new names are picked
up. Aliases must be unique, and setup fails closed if an alias would overwrite
an unrelated command.

Automatic closeout is machine-local and enabled by default. Disable it with
`pipelane configure --automatic-worktree-cleanup=false` and re-enable it with
`true`. Bare `{{ALIAS_CLEAN}}` is non-destructive;
`{{ALIAS_CLEAN}} --apply --delivered` retries delivered backlogs, while
`--apply --task <slug>` is the only command that clears durable
`--keep-worktree` retention. Unknown ignored content is protected unless it is
inside an exact validated root configured with
`pipelane configure --disposable-ignored-path=<root>`.

### What Each User Still Needs To Do

- Each Claude user can run `pipelane install-claude` once per machine for durable
  default personal skills under `~/.claude/skills`, then reopens Claude if newly
  installed skills are not visible.
- Each Codex user can run `pipelane install-codex` once per machine for durable
  default skills under `~/.codex/skills`, then reopens Codex if newly installed
  commands are not visible.
- In each repo, run `pipelane setup`. Pipelane no longer supports tracked
  repo-local adapter opt-in, so setup does not write `.claude/commands`,
  `.agents/skills`, package scripts, or docs.
- Optional raw-npm protection: run `pipelane install-npm-guard`, put
  `~/.pipelane/bin` first in `PATH`, and verify with
  `pipelane run doctor --check-guard`. The guard does not edit shell profiles.
- Each release operator runs `{{ALIAS_RELEASE}} enable`, fills values with
  `pipelane configure`, refreshes probes with `{{ALIAS_RELEASE}} doctor --probe`,
  and verifies readiness with `{{ALIAS_RELEASE}} status` before switching with
  `{{ALIAS_DEVMODE}} release`.

Use [docs/RELEASE_WORKFLOW.md](./docs/RELEASE_WORKFLOW.md) for the full operator workflow.
