# {{DISPLAY_NAME}} Local Operator Context

This file is local-only operator state. Keep it git-ignored.

## Local Operator Defaults

- Treat `release` as the standard shipping mode.
- Use `build` only for fallback, recovery, or an explicit user request.
- Use `{{ALIAS_NEW}}`, not manual branch creation, for normal task starts.
- When the user describes a task and then invokes `{{ALIAS_NEW}}`, infer a concise task label and pass it as `--task`.
- If recent context says the task is already implemented in a worktree, do not run `{{ALIAS_NEW}}`; continue there and use `{{ALIAS_PR}}`.
- Preferred operator path:
  1. `{{ALIAS_DEVMODE}} release`
  2. `{{ALIAS_NEW}}`
  3. `{{ALIAS_PR}} --title "<pr title>"`
  4. `{{ALIAS_MERGE}}`
  5. `{{ALIAS_DEPLOY}} staging`
  6. `{{ALIAS_SMOKE}} staging`
  7. `{{ALIAS_DEPLOY}} prod`
  8. `{{ALIAS_CLEAN}}`
- Use `{{ALIAS_RESUME}} --task "<task-name>"` only when returning to an existing task workspace.
- Use `{{ALIAS_STATUS}}` to see the cockpit before acting.
- Use `{{ALIAS_DOCTOR}}` to diagnose deploy config and probe staging health. Run `{{ALIAS_DOCTOR}} --probe` after a staging deploy to refresh the release gate's freshness check.
- If `.pipelane.json` aliases change, rerun setup and reopen Claude/Codex so the new command names appear.
- `{{DEPLOY_WORKFLOW_NAME}}` is the canonical deploy workflow label for this repo.

## Skill Routing

When the user's request matches an available skill, invoke it first.

Key routing rules:

- Start a new task workspace -> `{{ALIAS_NEW}}` with an inferred `--task` label when recent context names unstarted work
- Resume an existing task workspace -> `{{ALIAS_RESUME}}`
- Prepare or update a PR -> `{{ALIAS_PR}}`
- Merge the current PR -> `{{ALIAS_MERGE}}`
- Deploy the merged SHA -> `{{ALIAS_DEPLOY}}`
- Plan smoke coverage or run smoke -> `{{ALIAS_SMOKE}}`
- Cleanup or stale workspace inspection -> `{{ALIAS_CLEAN}}`
- One-screen cockpit of task + lane state -> `{{ALIAS_STATUS}}`
- Diagnose deploy config or refresh staging probes -> `{{ALIAS_DOCTOR}}`
- Roll back the last deploy to the last-good SHA -> `{{ALIAS_ROLLBACK}}`
- Architecture review -> `plan-eng-review`
- QA, test the site, find bugs -> `qa`
- Code review, check my diff -> `review`
- Save progress or checkpoint -> `checkpoint`
- Fix review findings (auto-suggests /fix rethink when churn is high) -> `/fix`
- Audit refactor hotspots and rethink architecture (plan first) -> `/fix rethink`
- Refresh repo guidance -> `/fix refresh-guidance`

{{DEPLOY_CONFIG_SECTION}}
