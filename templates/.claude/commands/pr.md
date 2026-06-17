<!-- pipelane:command:pr -->
Prepare and open, or update, a pull request for the current task.

Run:

```bash
npm run pipelane:pr -- $ARGUMENTS
```

This command:

1. Verifies the current task lock.
2. Requires fresh `/pipelane review` evidence for the current branch, HEAD, and worktree state.
3. Runs the configured pre-PR checks.
4. Stages and commits dirty changes.
5. Pushes the branch.
6. Opens or updates the PR.

If the worktree is dirty and no `--title` is provided for a new PR, the command fails.
If review evidence is missing, stale, filtered, pending, or failed, run `/pipelane review` and complete the pending AI/manual gates before retrying.

Display the output directly. Report the PR URL and the next step using slash commands only.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
