## Workflow Guardrails

This repo uses `pipelane` for task workspaces and release flow.

It pairs well with gstack:

- use `pipelane` for `{{ALIAS_NEW}}`, `{{ALIAS_ADOPT}}`, `{{ALIAS_RESUME}}`, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, `{{ALIAS_RELEASE}}`, `{{ALIAS_DEPLOY}}`, and `{{ALIAS_ROLLBACK}}`
- use `/fix` for bugs, review findings, CI failures, and code-quality repairs
- use gstack for review, QA, planning, docs, and investigation

Before work that may lead to a commit:

1. Check mode with `{{ALIAS_DEVMODE}} status`
2. Start a task workspace with `{{ALIAS_NEW}}`; provide a task name only when you want to choose it, otherwise let the AI infer one
3. If a task branch/worktree already exists from another tool, use `{{ALIAS_ADOPT}} --task "<task-name>"` instead of creating another worktree
4. Move into the reported worktree before editing
5. Use `{{ALIAS_RESUME}} --task "<task-name>"` only when returning to existing Pipelane-tracked work
6. Prepare the PR with `{{ALIAS_PR}} --title "<pr title>"`

If task workspace setup fails, stop instead of editing in the shared checkout.

If the repo changes slash aliases, rerun setup locally and reopen Claude/Codex so the updated command names appear.

Use `docs/RELEASE_WORKFLOW.md` for the full operator contract.
