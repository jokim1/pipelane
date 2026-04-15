Create a fresh task workspace for this repo.

Run:

```bash
npm run workflow:new -- $ARGUMENTS
```

Expected form (with a task label):

```bash
npm run workflow:new -- --task "task name"
```

The task label is optional. You can also run `/new` with no arguments and a
`task-<hex>` slug will be generated automatically.

This command:

1. Creates a fresh isolated sibling worktree.
2. Creates a new `codex/<task>-<4hex>` branch.
3. Inherits the current dev mode.
4. Refuses to start the same task twice, and points to `/resume`.
5. Generates a `task-<hex>` slug when `--task` is omitted.

Display the output directly. Call out that the chat/workspace has not moved automatically yet.
