## Pipelane Workflow

This repo uses `pipelane`, the release pipeline management and safety layer for
AI-first builders.

Pipelane is here to make parallel AI-coded work legible. It tracks task
worktrees, branches, PRs, staging deploys, production deploys, smoke checks, and
cleanup state so the repo does not depend on memory or chat history.

Start with:

```text
/pipelane
```

That prints the build and release journeys for this repo.

### Build Journey

Build mode is the fast lane. Use it when you want the shortest route from merge
to production and do not need required staging validation for the same SHA.

```text
{{ALIAS_STATUS}}                 See what is already in flight.
{{ALIAS_DEVMODE}} build          Use the fast lane.
{{ALIAS_NEW}} "task name"        Create a clean task worktree and branch.
{{ALIAS_PR}}                     Run pre-PR checks, commit, push, and open or update the PR.
{{ALIAS_MERGE}}                  Merge the PR and record the merged SHA.
{{ALIAS_SMOKE}} prod             Optional: run production-safe smoke checks if configured.
{{ALIAS_CLEAN}}                  Clean up finished task state after production is verified.
```

### Release Journey

Release mode is the protected lane. Use it when staging must prove the exact
same merged SHA before production can move.

```text
{{ALIAS_STATUS}}                 See active tasks, deploy state, and release gates.
{{ALIAS_DEVMODE}} release        Use the protected lane.
{{ALIAS_NEW}} "task name"        Create a clean task worktree and branch.
{{ALIAS_PR}}                     Run pre-PR checks, commit, push, and open or update the PR.
{{ALIAS_MERGE}}                  Merge the PR and record the merged SHA.
{{ALIAS_DEPLOY}} staging         Deploy the merged SHA to staging.
{{ALIAS_SMOKE}} staging          Run or verify staging smoke checks.
{{ALIAS_DEPLOY}} prod            Promote that same SHA to production.
{{ALIAS_SMOKE}} prod             Optional: run production-safe smoke checks.
{{ALIAS_CLEAN}}                  Clean up finished task state after production is verified.
```

### Helpful Anytime

```text
/pipelane web                    Open the local Pipelane Board.
{{ALIAS_STATUS}}                 Render the terminal cockpit.
{{ALIAS_RESUME}}                 Reopen or recover an existing task workspace.
{{ALIAS_DOCTOR}}                 Diagnose deploy config, probes, and release readiness.
{{ALIAS_ROLLBACK}} prod          Roll production back to the last verified-good deploy.
/fix                             Fix bugs, review findings, CI failures, and code-quality issues.
/fix rethink                     Plan a larger codebase restructure before changing code.
```

### What Each Command Is For

- `/pipelane`: build/release overview and web/status/update subcommands
- `/pipelane web`: local visual board for branch pipeline state
- `{{ALIAS_STATUS}}`: terminal cockpit from the same API as the board
- `{{ALIAS_DEVMODE}}`: switch between `build` and `release`
- `{{ALIAS_NEW}}`: create an isolated task worktree and branch
- `{{ALIAS_RESUME}}`: recover an existing task worktree
- `{{ALIAS_PR}}`: run checks, commit, push, and open or update a PR
- `{{ALIAS_MERGE}}`: merge the PR and record the merged SHA
- `{{ALIAS_DEPLOY}}`: deploy to `staging` or `prod`
- `{{ALIAS_SMOKE}}`: plan or run smoke checks for `staging` or `prod`
- `/fix`: make durable root-cause fixes from findings
- `{{ALIAS_CLEAN}}`: inspect and prune finished or stale task state
- `{{ALIAS_DOCTOR}}`: diagnose deploy config and live probes
- `{{ALIAS_ROLLBACK}}`: roll back to the last verified-good deploy

### Repo-Native Layer

Slash commands are the normal Claude/Codex interface. Under the hood, they call
repo-native scripts:

```bash
npm run pipelane:setup
npm run pipelane:devmode -- build|release
npm run pipelane:new -- --task "<task-name>"
npm run pipelane:resume -- --task "<task-name>"
npm run pipelane:pr -- --title "PR title"
npm run pipelane:merge
npm run pipelane:release-check
npm run pipelane:task-lock -- verify --task "<task-name>"
npm run pipelane:deploy -- staging|prod
npm run pipelane:smoke -- plan|staging|prod
npm run pipelane:clean
npm run pipelane:status
npm run pipelane:doctor -- --probe
npm run pipelane:board
npm run pipelane:update
```

The default alias set can be changed in `.pipelane.json`. If aliases change,
rerun `npm run pipelane:setup` and reopen Claude/Codex so the new names are
picked up. Aliases must be unique, and setup fails closed if an alias would
overwrite an unrelated command.

### What Each User Still Needs To Do

- One repo maintainer runs `pipelane bootstrap --project "<name>"`, reviews
  `.pipelane.json`, and commits the tracked Pipelane files.
- Each Claude user can run `pipelane install-claude` once per machine for the
  global `/init-pipelane` bootstrap command, then pulls the repo and reopens
  Claude if command files or aliases changed.
- Each Codex user can run `pipelane install-codex` once per machine for the
  global `/init-pipelane` bootstrap command, then pulls the repo and reopens
  Codex if tracked skills or aliases changed.
- Each release operator fills local deploy config in `CLAUDE.md` and verifies
  readiness with `npm run pipelane:release-check`.

Use [docs/RELEASE_WORKFLOW.md](./docs/RELEASE_WORKFLOW.md) for the full operator workflow.
