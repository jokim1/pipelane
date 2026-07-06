## Pipelane

This repo uses `pipelane` for task workspaces, PR prep, merge handoff, and deploy flow.

### Command surface

- Default slash aliases are `{{ALIAS_DEVMODE}}`, `{{ALIAS_NEW}}`, `{{ALIAS_ADOPT}}`, `{{ALIAS_RESUME}}`, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, `{{ALIAS_RELEASE}}`, `{{ALIAS_DEPLOY}}`, `{{ALIAS_CLEAN}}`, `{{ALIAS_STATUS}}`, `{{ALIAS_DOCTOR}}`, and `{{ALIAS_ROLLBACK}}`.
- Fixed helper commands include `/fix`, `/fix rethink`, and `/fix refresh-guidance`.
- Prefer the slash aliases above. They use the managed Pipelane runner and work before a fresh checkout has `node_modules`; do not substitute repo-local npm scripts or repo-local binaries.
- Use `{{ALIAS_NEW}}` to start new work after the user describes the task; use an explicit task name if the user provided one, otherwise infer a concise `--task` label instead of making the user repeat it.
- Use `{{ALIAS_ADOPT}}` when another model or tool already created the task branch/worktree and Pipelane needs to track it. Do not create a replacement worktree in that case.
- Use `{{ALIAS_RESUME}} --task "<task-name>"` to return to an existing task workspace.
- Use `{{ALIAS_DEVMODE}} status|build|release` to inspect or switch lanes.
- Use `{{ALIAS_RELEASE}} status|enable|doctor` to inspect or enable the optional release module.
- Use `{{ALIAS_PR}} --title "<pr title>"` to prepare or update the PR.
- Use `{{ALIAS_MERGE}}` to merge the PR and record the merged SHA.
- Use `{{ALIAS_DEPLOY}} staging|prod` to deploy the merged SHA.
- Use `{{ALIAS_ROLLBACK}} staging|prod` to roll back the last deploy to the last-good SHA.
- Use `{{ALIAS_CLEAN}}` for workflow cleanup status.
- Use `{{ALIAS_STATUS}}` for the one-screen cockpit of task + lane state.
- Use `{{ALIAS_RELEASE}} enable` to initialize machine-local release config, `pipelane configure` to fill deploy values, and `{{ALIAS_RELEASE}} status` or `{{ALIAS_RELEASE}} doctor --probe` to inspect release readiness.
- Use `/fix` for review findings, CI failures, bugs, and code-quality repairs.

### Repo guard and task locks

- Treat `{{ALIAS_NEW}}` as the canonical task-start command.
- For any code-changing task, start in a Pipelane task workspace. If the current checkout is not already the matching task workspace, run `{{ALIAS_NEW}}` with an inferred `--task` label before editing.
- If the task branch/worktree already exists because another model or tool created it, run `{{ALIAS_ADOPT}} --task "<task-name>"` from that worktree or `{{ALIAS_ADOPT}} --branch <branch> --task "<task-name>"` from the shared repo.
- If `{{ALIAS_NEW}}`, `{{ALIAS_ADOPT}}`, or `{{ALIAS_RESUME}}` reports `Chat has not moved`, switch the shell/workspace to the reported path before reading or editing task files. If you cannot switch the workspace, stop and report the path instead of continuing in the shared checkout.
- If `{{ALIAS_NEW}}` fails, do not continue implementation in the current checkout. Fix the task-start failure, run `{{ALIAS_ADOPT}}` for existing external work, run `{{ALIAS_RESUME}}` for known Pipelane work, or ask the operator how to proceed.
- Do not edit, commit, run `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, or `{{ALIAS_DEPLOY}}` from a shared checkout, base branch checkout, dirty unrelated worktree, or another task's worktree unless the user explicitly asks for that checkout.
- Exceptions are read-only review, answering questions without file edits, and continuing inside an already-created matching task workspace.
- If the user invokes bare `{{ALIAS_NEW}}` after describing an unstarted task, run it with an inferred `--task "<short-name>"`; if the task was already implemented, continue in the reported worktree and do not create another workspace.
- Only use `{{ALIAS_NEW}} --unnamed` when the operator explicitly wants a generated task slug.
- Treat `{{ALIAS_RESUME}}` as the recovery command.
- Treat `{{ALIAS_REPO_GUARD}}` as the checkout guardrail.
- Re-check `{{ALIAS_REPO_GUARD}} --task "<task-name>"` before implementation, `{{ALIAS_PR}}`, `{{ALIAS_MERGE}}`, and `{{ALIAS_DEPLOY}}`.
- `{{ALIAS_PR}}` stages the active task worktree with `git add -A`, so keep the task workspace isolated.
- When backend or multi-surface impact is plausible, use explicit `--surfaces`.

### Worktree deps setup

- `{{ALIAS_NEW}}`, `{{ALIAS_ADOPT}}`, and `{{ALIAS_RESUME}}` symlink the task worktree's `node_modules` into the shared repo's `node_modules` so deps are instantly available without re-installing per worktree.
- **A pipelane npm guard blocks `npm ci` / `npm install` in any worktree where `node_modules` is a symlink** — the install aborts with a clear error before npm's reify step can wipe the shared deps. Use the machine-local guard from `pipelane install-npm-guard` with `~/.pipelane/bin` first on `PATH`.
- Safe pattern for reinstalling deps in a task worktree (the guard accepts this because removing the symlink first turns the path into "no node_modules"):

  ```bash
  [ -L node_modules ] && rm node_modules
  npm install
  ```

  `rm` on a symlink only removes the symlink; it does not touch the symlink's target.
- If only running, not reinstalling (tests, typecheck, dev server), the symlinked `node_modules` works as-is — no action needed.

### Docs

- Use `docs/RELEASE_WORKFLOW.md` for the full operator workflow.
- Use `pipelane configure` for machine-local deploy configuration.
