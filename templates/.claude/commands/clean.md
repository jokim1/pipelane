<!-- pipelane:command:clean -->
Report workflow cleanup status and prune stale task locks when requested.

Run:

```bash
npm run pipelane:clean
```

Default behavior:

- Close completed task workspaces automatically when Pipelane can prove the cleanup is safe: prod verified, older than the prune floor, clean worktree, called from outside the target worktree, and branch content matches the verified prod SHA.
- Classify orphan worktrees by tree state (clean, ignored-only, untracked, dirty-source) and check whether each branch has a merged PR via `gh pr list`.
- Surface a numbered action menu with the runnable bulk-cleanup commands for each category that has candidates.
- Keep active, dirty-without-merged-PR, too-young, externally owned, or ambiguous workspaces for manual review.

To force a specific cleanup scope:

```text
{{ALIAS_CLEAN}} --status-only
{{ALIAS_CLEAN}} --apply --task "<task name or slug>"
{{ALIAS_CLEAN}} --apply --all-stale                  # prune every stale lock
{{ALIAS_CLEAN}} --apply --completed-with-ignored     # close prod-verified locks blocked only on ignored build output
{{ALIAS_CLEAN}} --apply --safe-orphans               # remove orphan worktrees with clean trees
{{ALIAS_CLEAN}} --apply --merged-orphans             # force-remove orphans whose branches have merged PRs
```

Rules:

- Always show what was cleaned, then the remaining status report.
- Use `--status-only` when a dashboard/API caller needs a non-mutating preview.
- `--apply` without a scope flag is rejected — the operator refuses to guess scope. Exactly one scope is allowed per invocation.
- Locks updated in the last 5 minutes are preserved even when scope is set; they may belong to an in-progress task.
- `--merged-orphans` requires the `gh` CLI; without it, the action is reported as unavailable and no orphans are removed.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
