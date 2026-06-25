<!-- pipelane:command:deploy -->
Deploy the merged SHA for this repo.

Run:

```bash
npm run pipelane:deploy -- $ARGUMENTS
```

Expected arguments:

- `staging [surfaces...]`
- `prod [surfaces...]`

If the user writes `PR #625`, `PR 625`, or `#625`, pass it as `--pr 625`.
Do not pass a raw unquoted `#625` token to a shell; `#` starts a shell
comment before Pipelane can parse it.

Release mode requires staging before production for the same merged SHA and surface set.

Production deploys in release mode require typed-SHA-prefix confirmation. The operator
prompts for the first 4 characters of the target SHA before dispatching; surface the
prompt to the human rather than auto-answering. For scripted or CI prod deploys, drive
the deploy through `pipelane run api action deploy.prod --execute --confirm-token <t>`
using the token issued by a prior `api action deploy.prod` preflight.

Display the output directly. If the output prints "Choose the action to take:",
ask the user to pick one of the printed numbered choices and preserve each
number, label, and command in your chat prompt; do not reduce it to "rerun with
--yes", "option 1", or "option 2". In follow-up reminders, restate the action
label, for example `1 (Continue to /deploy staging)` or
`2 (Take one step only)`. When the user picks a runnable choice, run the
matching slash command.
Report the environment, SHA, surfaces, and next step using slash commands only.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
