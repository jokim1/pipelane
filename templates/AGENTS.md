## Pipelane

This repo uses `pipelane` for task workspaces, PR prep, merge handoff, and deploy flow.

### Command surface

- Default slash aliases are `{{ALIAS_DEVMODE}}`, `{{ALIAS_NEW}}`, `{{ALIAS_RESUME}}`, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, `{{ALIAS_DEPLOY}}`, `{{ALIAS_SMOKE}}`, `{{ALIAS_CLEAN}}`, `{{ALIAS_STATUS}}`, `{{ALIAS_DOCTOR}}`, and `{{ALIAS_ROLLBACK}}`.
- Prefer the slash aliases above. Repo-local `npm run pipelane:*` scripts are a fallback path and require `node_modules/.bin/pipelane` to exist.
- Use `{{ALIAS_NEW}} --task "<task-name>"` to start new work.
- Use `{{ALIAS_RESUME}} --task "<task-name>"` to return to an existing task workspace.
- Use `{{ALIAS_DEVMODE}} status|build|release` to inspect or switch lanes.
- Use `{{ALIAS_PR}} --title "<pr title>"` to prepare or update the PR.
- Use `{{ALIAS_MERGE}}` to merge the PR and record the merged SHA.
- Use `{{ALIAS_DEPLOY}} staging|prod` to deploy the merged SHA.
- Use `{{ALIAS_SMOKE}} plan|staging|prod` to audit smoke coverage or run deployed smoke.
- Use `{{ALIAS_ROLLBACK}} staging|prod` to roll back the last deploy to the last-good SHA.
- Use `{{ALIAS_CLEAN}}` for workflow cleanup status.
- Use `{{ALIAS_STATUS}}` for the one-screen cockpit of task + lane state.
- Use `{{ALIAS_DOCTOR}}` to diagnose deploy config; `{{ALIAS_DOCTOR}} --probe` to refresh staging healthcheck probes; `{{ALIAS_DOCTOR}} --fix` for the guided wizard.

### Repo guard and task locks

- Treat `{{ALIAS_NEW}}` as the canonical task-start command.
- Treat `{{ALIAS_RESUME}}` as the recovery command.
- Treat `{{ALIAS_REPO_GUARD}}` as the checkout guardrail.
- Re-check `{{ALIAS_REPO_GUARD}} --task "<task-name>"` before implementation, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, and `{{ALIAS_DEPLOY}}`.
- `{{ALIAS_PR}}` stages the active task worktree with `git add -A`, so keep the task workspace isolated.
- When backend or multi-surface impact is plausible, use explicit `--surfaces`.

### Worktree deps setup

- `{{ALIAS_NEW}}` and `{{ALIAS_RESUME}}` symlink the task worktree's `node_modules` into the shared repo's `node_modules` so deps are instantly available without re-installing per worktree.
- **A pipelane preinstall guard blocks `npm ci` / `npm install` in any worktree where `node_modules` is a symlink** — the install aborts with a clear error before npm's reify step can wipe the shared deps. The guard is wired into `package.json:scripts.preinstall` by `pipelane setup`.
- Safe pattern for reinstalling deps in a task worktree (the guard accepts this because removing the symlink first turns the path into "no node_modules"):

  ```bash
  [ -L node_modules ] && rm node_modules
  npm install
  ```

  `rm` on a symlink only removes the symlink; it does not touch the symlink's target.
- If only running, not reinstalling (tests, typecheck, dev server), the symlinked `node_modules` works as-is — no action needed.

### Docs

- Use `docs/RELEASE_WORKFLOW.md` for the full operator workflow.
- Use local `CLAUDE.md` for machine-specific deploy configuration only.
