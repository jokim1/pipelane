<!-- workflow-kit:command:devmode -->
Switch or check the repo's development mode (build or release).

Run:

```bash
npm run workflow:devmode -- $ARGUMENTS
```

If no arguments are provided, default to `status`.

Display the output directly. The key line is:

- `Dev Mode: [build]`
- `Dev Mode: [release]`

If release mode is blocked, show the blocked surfaces and tell the user to run `npm run workflow:configure`.

Bypassing the release gate is possible but must be auditable:

```bash
npm run workflow:devmode -- release --override --reason "shipping hotfix TICKET-42"
```

`--override` without `--reason` is rejected. The reason is recorded as `lastOverride` in mode state and surfaced by `/status` as a persistent `OVERRIDE ACTIVE` banner until the next `release` call without override.

<!-- workflow-kit:consumer-extension:start -->
<!-- workflow-kit:consumer-extension:end -->
