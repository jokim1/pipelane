<!-- pipelane:command:adopt -->
Adopt an existing branch or worktree as a Pipelane task.

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
  "$claude_runner" adopt $ARGUMENTS
elif [ -x "$codex_runner" ] && [ -x "$codex_bin" ]; then
  "$codex_runner" adopt $ARGUMENTS
elif [ -x "$repo_runner" ] && { [ -x "$repo_bin" ] || [ -x "$codex_bin" ]; }; then
  "$repo_runner" adopt $ARGUMENTS
else
  npm run pipelane:adopt -- $ARGUMENTS
fi
```

Use this when another tool or model already created a worktree or branch and
Pipelane should track it instead of starting a replacement workspace.

Common forms:

- `{{ALIAS_ADOPT}}`
- `{{ALIAS_ADOPT}} --task "task name"`
- `{{ALIAS_ADOPT}} --branch codex/task-name-abcd --task "task name"`

This command:

1. Refuses detached checkouts.
2. Refuses base branches unless `--force` is explicit.
3. Records the current or named worktree as the task workspace.
4. Warns if the adopted worktree is dirty.
5. Links shared `node_modules` when safe.

Display the output directly. If it succeeds, switch to the reported worktree
before editing.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
