## Pipelane

This repo uses `pipelane` for task workspaces, PR prep, merge handoff, and deploy flow.

### Command surface

- Default slash aliases are `{{ALIAS_DEVMODE}}`, `{{ALIAS_NEW}}`, `{{ALIAS_RESUME}}`, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, `{{ALIAS_DEPLOY}}`, `{{ALIAS_SMOKE}}`, `{{ALIAS_CLEAN}}`, `{{ALIAS_STATUS}}`, `{{ALIAS_DOCTOR}}`, and `{{ALIAS_ROLLBACK}}`.
- Use `npm run pipelane:new -- --task "<task-name>"` to start new work.
- Use `npm run pipelane:resume -- --task "<task-name>"` to return to an existing task workspace.
- Use `npm run pipelane:devmode -- status|build|release` to inspect or switch lanes.
- Use `npm run pipelane:pr -- --title "<pr title>"` to prepare or update the PR.
- Use `npm run pipelane:merge` to merge the PR and record the merged SHA.
- Use `npm run pipelane:deploy -- staging|prod` to deploy the merged SHA.
- Use `npm run pipelane:smoke -- plan|staging|prod` to audit smoke coverage or run deployed smoke.
- Use `npm run pipelane:rollback -- staging|prod` to roll back the last deploy to the last-good SHA.
- Use `npm run pipelane:clean` for workflow cleanup status.
- Use `npm run pipelane:status` for the one-screen cockpit of task + lane state.
- Use `npm run pipelane:doctor` to diagnose deploy config; `npm run pipelane:doctor -- --probe` to refresh staging healthcheck probes; `npm run pipelane:doctor -- --fix` for the guided wizard.

### Repo guard and task locks

- Treat `pipelane:new` as the canonical task-start command.
- Treat `pipelane:resume` as the recovery command.
- Treat `pipelane run repo-guard` as an internal guardrail, not the default human entrypoint.
- Re-check `npm run pipelane:task-lock -- verify --task "<task-name>"` before implementation, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, and `{{ALIAS_DEPLOY}}`.
- `pipelane:pr` stages the active task worktree with `git add -A`, so keep the task workspace isolated.
- When backend or multi-surface impact is plausible, use explicit `--surfaces`.

### Docs

- Use `docs/RELEASE_WORKFLOW.md` for the full operator workflow.
- Use local `CLAUDE.md` for machine-specific deploy configuration only.
