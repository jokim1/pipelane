<!-- pipelane:command:new -->
Create a fresh task workspace for this repo.

Run:

```bash
npm run pipelane:new -- $ARGUMENTS
```

If recent conversation says the task was already implemented, do not create a
new workspace. Point the user at the reported task worktree and run `{{ALIAS_PR}}`
there instead.

If `$ARGUMENTS` is empty and the recent conversation clearly describes an
unstarted coding task, infer a concise task label and append it to the shell
command:

```bash
npm run pipelane:new -- --task "task name"
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

Display the output directly. Call out that the chat/workspace has not moved automatically yet.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
