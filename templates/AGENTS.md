## Workflow Kit

This repo uses `workflow-kit` for task workspaces, PR prep, merge handoff, and deploy flow.

### Command surface

- Default slash aliases are `{{ALIAS_DEVMODE}}`, `{{ALIAS_NEW}}`, `{{ALIAS_RESUME}}`, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, `{{ALIAS_DEPLOY}}`, and `{{ALIAS_CLEAN}}`.
- Use `npm run workflow:new -- --task "<task-name>"` to start new work.
- Use `npm run workflow:resume -- --task "<task-name>"` to return to an existing task workspace.
- Use `npm run workflow:devmode -- status|build|release` to inspect or switch lanes.
- Use `npm run workflow:pr -- --title "<pr title>"` to prepare or update the PR.
- Use `npm run workflow:merge` to merge the PR and record the merged SHA.
- Use `npm run workflow:deploy -- staging|prod` to deploy the merged SHA.
- Use `npm run workflow:clean` for workflow cleanup status.

### Repo guard and task locks

- Treat `workflow:new` as the canonical task-start command.
- Treat `workflow:resume` as the recovery command.
- Treat `workflow-kit run repo-guard` as an internal guardrail, not the default human entrypoint.
- Re-check `npm run workflow:task-lock -- verify --task "<task-name>"` before implementation, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, and `{{ALIAS_DEPLOY}}`.
- `workflow:pr` stages the active task worktree with `git add -A`, so keep the task workspace isolated.
- When backend or multi-surface impact is plausible, use explicit `--surfaces`.

### Docs

- Use `docs/RELEASE_WORKFLOW.md` for the full operator workflow.
- Use local `CLAUDE.md` for machine-specific deploy configuration only.
