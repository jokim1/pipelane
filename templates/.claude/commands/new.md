<!-- pipelane:command:new -->
Create a fresh task workspace for this repo.

Run:

```bash
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
repo_runner="$repo_root/.agents/skills/.pipelane/bin/run-pipelane.sh"
repo_bin="$repo_root/node_modules/.bin/pipelane"
claude_runner="$claude_home/skills/pipelane/bin/run-pipelane.sh"
claude_bin="$claude_home/skills/pipelane/bin/pipelane"
codex_runner="$codex_home/skills/.pipelane/bin/run-pipelane.sh"
codex_bin="$codex_home/skills/.pipelane/bin/pipelane"
if [ -x "$claude_runner" ] && [ -x "$claude_bin" ]; then
  "$claude_runner" new $ARGUMENTS
elif [ -x "$codex_runner" ] && [ -x "$codex_bin" ]; then
  "$codex_runner" new $ARGUMENTS
elif [ -x "$repo_runner" ] && { [ -x "$repo_bin" ] || [ -x "$codex_bin" ]; }; then
  "$repo_runner" new $ARGUMENTS
else
  npm run pipelane:new -- $ARGUMENTS
fi
```

Use the host managed runner path first. The npm script is only a fallback because a
fresh checkout may not have `node_modules/.bin/pipelane` yet.

If recent conversation says the task was already implemented, do not create a
new workspace. Point the user at the reported task worktree and run `{{ALIAS_PR}}`
there instead.

If `$ARGUMENTS` is empty and the recent conversation clearly describes an
unstarted coding task, infer a concise task label and append it to the shell
command:

```bash
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
claude_home="${CLAUDE_HOME:-$HOME/.claude}"
codex_home="${CODEX_HOME:-$HOME/.codex}"
repo_runner="$repo_root/.agents/skills/.pipelane/bin/run-pipelane.sh"
repo_bin="$repo_root/node_modules/.bin/pipelane"
claude_runner="$claude_home/skills/pipelane/bin/run-pipelane.sh"
claude_bin="$claude_home/skills/pipelane/bin/pipelane"
codex_runner="$codex_home/skills/.pipelane/bin/run-pipelane.sh"
codex_bin="$codex_home/skills/.pipelane/bin/pipelane"
if [ -x "$claude_runner" ] && [ -x "$claude_bin" ]; then
  "$claude_runner" new --task "task name"
elif [ -x "$codex_runner" ] && [ -x "$codex_bin" ]; then
  "$codex_runner" new --task "task name"
elif [ -x "$repo_runner" ] && { [ -x "$repo_bin" ] || [ -x "$codex_bin" ]; }; then
  "$repo_runner" new --task "task name"
else
  npm run pipelane:new -- --task "task name"
fi
```

Do not ask the user to repeat a task name when the request is already clear. If
there is no clear task context, ask one short question for the task description.
Only use `--unnamed` when the operator intentionally wants a generated
`task-<hex>` slug.

This command:

1. Creates a fresh isolated sibling worktree.
2. Creates a new `codex/<task>-<4hex>` branch.
3. Inherits the current dev mode.
4. Refuses to start the same task twice, and points to `{{ALIAS_RESUME}}`.
5. Refuses no-context task starts unless `--unnamed` is explicit.

Display the output directly. If it fails, stop instead of editing in the current
checkout. If it succeeds, call out that the chat/workspace has not moved
automatically yet and switch to the reported worktree before editing.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
