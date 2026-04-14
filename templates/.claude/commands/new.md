Create a fresh task workspace for this repo.

Run:

```bash
npm run workflow:new -- $ARGUMENTS
```

Expected form:

```bash
npm run workflow:new -- --task "task name"
```

This command:

1. Creates a fresh isolated sibling worktree.
2. Creates a new `codex/<task>-<4hex>` branch.
3. Inherits the current dev mode.
4. Refuses to start the same task twice, and points to `/resume`.

Display the output directly. Call out that the chat/workspace has not moved automatically yet.
