Prepare and open, or update, a pull request for the current task.

Run:

```bash
npm run workflow:pr -- $ARGUMENTS
```

This command:

1. Verifies the current task lock.
2. Runs the configured pre-PR checks.
3. Stages and commits dirty changes.
4. Pushes the branch.
5. Opens or updates the PR.

If the worktree is dirty and no `--title` is provided for a new PR, the command fails.

Display the output directly. Report the PR URL and the next step.
