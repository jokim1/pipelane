<!-- workflow-kit:command:merge -->
Merge the current task's pull request.

Run:

```bash
npm run workflow:merge -- $ARGUMENTS
```

This command:

1. Verifies the task lock.
2. Waits for required checks.
3. Squash-merges the PR.
4. Records the merged SHA for later deploy flow.

Display the output directly. Report the merged SHA and the next step.
