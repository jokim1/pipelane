Report workflow cleanup status and prune stale task locks when requested.

Run:

```bash
npm run workflow:clean
```

To prune stale task locks, scope the prune explicitly:

```bash
npm run workflow:clean -- --apply --task "<task name or slug>"
# or, to prune every stale lock in one shot:
npm run workflow:clean -- --apply --all-stale
```

Rules:

- Always show the status report first.
- `--apply` without `--task` or `--all-stale` is rejected — the operator refuses to guess scope.
- Locks updated in the last 5 minutes are preserved even when scope is set; they may belong to an in-progress task.
- Do not assume worktrees should be deleted automatically.
