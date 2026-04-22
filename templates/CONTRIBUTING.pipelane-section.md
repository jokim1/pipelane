## Workflow Guardrails

This repo uses `pipelane` for task workspaces and release flow.

It pairs well with gstack:

- use `pipelane` for `{{ALIAS_NEW}}`, `{{ALIAS_RESUME}}`, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, `{{ALIAS_DEPLOY}}`, `{{ALIAS_SMOKE}}`, and `{{ALIAS_ROLLBACK}}`
- use gstack for review, QA, planning, docs, and investigation

Before work that may lead to a commit:

1. Check mode with `npm run pipelane:devmode -- status`
2. Start a task workspace with `npm run pipelane:new -- --task "<task-name>"`
3. Move into the reported worktree before editing
4. Use `npm run pipelane:resume -- --task "<task-name>"` only when returning to existing work
5. Prepare the PR with `npm run pipelane:pr -- --title "<pr title>"`

If the repo changes slash aliases, rerun `npm run pipelane:setup` locally and reopen Claude/Codex so the updated command names appear.

Use `docs/RELEASE_WORKFLOW.md` for the full operator contract.
