<!-- pipelane:command:resume -->
Resume an existing task workspace for this repo.

Run:

```bash
npm run pipelane:resume -- $ARGUMENTS
```

Common forms:

- `{{ALIAS_RESUME}} --task "task name"`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_RESUME}} --spin-off "<review-run/gate/Fxxx>" --spinoff-task "<follow-up-label>" --reason "<why this remedy is new scope>"`

Behavior:

1. With `--task`, restores the saved task workspace if it still exists.
2. With no args, lists active tasks or resumes the only active task.
3. With `--spin-off`, records one exact review finding as a durable follow-up
   and keeps it out of later Karpathy reports unless the code invalidates the
   disposition. The original review remains failed; rerun the paused route, not
   the unchanged review. All severities remain eligible. For a critical finding,
   the command records explicit informed consent that it will not block release
   or deploy at that exact HEAD. Use this only for genuinely new scope, not a
   live shipping defect; `--reason` is mandatory.
4. If the saved workspace is gone, directs the user back to `{{ALIAS_NEW}}`.

Display the output directly. Call out that the chat/workspace has not moved automatically yet.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
