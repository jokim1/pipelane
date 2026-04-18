## Workflow Guardrails

This repo uses `workflow-kit` for task workspaces and release flow.

It pairs well with gstack:

- use `workflow-kit` for `{{ALIAS_NEW}}`, `{{ALIAS_RESUME}}`, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, and `{{ALIAS_DEPLOY}}`
- use gstack for review, QA, planning, docs, and investigation

Before work that may lead to a commit:

1. Check mode with `npm run workflow:devmode -- status`
2. Start a task workspace with `npm run workflow:new -- --task "<task-name>"`
3. Move into the reported worktree before editing
4. Use `npm run workflow:resume -- --task "<task-name>"` only when returning to existing work
5. Prepare the PR with `npm run workflow:pr -- --title "<pr title>"`

If the repo changes slash aliases, rerun `npm run workflow:setup` locally and reopen Claude/Codex so the updated command names appear.

Use `docs/RELEASE_WORKFLOW.md` for the full operator contract.
