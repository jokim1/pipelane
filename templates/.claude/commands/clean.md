<!-- pipelane:command:clean -->
Report workflow cleanup status and prune stale task locks when requested.

Run:

```bash
npm run pipelane:clean
```

Default behavior:

- Close completed task workspaces automatically when Pipelane can prove the cleanup is safe: prod verified, older than the prune floor, clean worktree, called from outside the target worktree, and branch content matches the verified prod SHA.
- Show the remaining cleanup status after any automatic close-out.
- Keep active, dirty, too-young, externally owned, or ambiguous workspaces for manual review.

To force a specific cleanup scope:

```text
{{ALIAS_CLEAN}} --status-only
{{ALIAS_CLEAN}} --apply --task "<task name or slug>"
# or, to prune every stale lock in one shot:
{{ALIAS_CLEAN}} --apply --all-stale
```

Rules:

- Always show what was cleaned, then the remaining status report.
- Use `--status-only` when a dashboard/API caller needs a non-mutating preview.
- `--apply` without `--task` or `--all-stale` is rejected — the operator refuses to guess scope.
- Locks updated in the last 5 minutes are preserved even when scope is set; they may belong to an in-progress task.
- Do not auto-remove orphan worktrees; they may belong to another agent.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
