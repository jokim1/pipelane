# {{DISPLAY_NAME}} Local Operator Context

This file is local-only operator state. Keep it git-ignored.

## Local Operator Defaults

- Treat `release` as the standard shipping mode.
- Use `build` only for fallback, recovery, or an explicit user request.
- Use `{{ALIAS_NEW}}`, not manual branch creation, for normal task starts.
- Preferred operator path:
  1. `npm run pipelane:devmode -- release`
  2. `npm run pipelane:new -- --task "<task-name>"`
  3. `npm run pipelane:pr -- --title "<pr title>"`
  4. `npm run pipelane:merge`
  5. `npm run pipelane:deploy -- staging`
  6. `npm run pipelane:smoke -- staging`
  7. `npm run pipelane:deploy -- prod`
  8. `npm run pipelane:clean`
- Use `npm run pipelane:resume -- --task "<task-name>"` only when returning to an existing task workspace.
- Use `npm run pipelane:status` (or `{{ALIAS_STATUS}}`) to see the cockpit before acting.
- Use `npm run pipelane:doctor` (or `{{ALIAS_DOCTOR}}`) to diagnose deploy config and probe staging health. Run `npm run pipelane:doctor -- --probe` after a staging deploy to refresh the release gate's freshness check.
- If `.pipelane.json` aliases change, rerun `npm run pipelane:setup` and reopen Claude/Codex so the new command names appear.
- `{{DEPLOY_WORKFLOW_NAME}}` is the canonical deploy workflow label for this repo.

## Skill Routing

When the user's request matches an available skill, invoke it first.

Key routing rules:

- Start a new task workspace -> `{{ALIAS_NEW}}`
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
- Rethink architecture (plan first) -> `/fix rethink`
- Refresh repo guidance -> `/fix refresh-guidance`

{{DEPLOY_CONFIG_SECTION}}
