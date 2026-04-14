Report workflow cleanup status and prune stale task locks when requested.

Run:

```bash
npm run workflow:clean
```

If the user wants to prune stale workflow state:

```bash
npm run workflow:clean -- --apply
```

Rules:

- Always show the status report first.
- Do not assume worktrees should be deleted automatically.
- Treat `--apply` as stale task-lock pruning, not aggressive repo cleanup.
