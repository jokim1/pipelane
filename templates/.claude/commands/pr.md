<!-- pipelane:command:pr -->
Prepare and open, or update, a pull request for the current task.

Run:

```bash
npm run pipelane:pr -- $ARGUMENTS
```

This command:

1. Verifies the current task lock.
2. Shows the review state for this branch (what ran, what's open, what's stale) — informational, not a wall.
3. Runs the configured pre-PR checks.
4. Stages and commits dirty changes.
5. Pushes the branch.
6. Opens or updates the PR.

If the worktree is dirty and no `--title` is provided for a new PR, the command fails.
If review evidence is missing, failed, or pending, either run `/pipelane review` first, or proceed with informed consent: `--override --reason "<why>"` (the reason is recorded; evidence is never relabeled as passed). Staleness — commits made after the last review — is displayed but never blocks.

Display the output directly. Report the PR URL and the next step using slash commands only.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
