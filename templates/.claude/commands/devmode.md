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

`--override` without `--reason` is rejected. The reason is recorded as `lastOverride` in mode state with an attribution stamp (`setAt`, `setBy`). Two surfaces expose it:

- `/status` renders a red `OVERRIDE ACTIVE` banner while the override is in effect, and a yellow `RELEASE GATE PREVIOUSLY BYPASSED` banner after the gate is re-armed — the durable audit trail never goes fully silent.
- `npm run workflow:devmode` (no args) prints the active override alongside `Last override: ...` so a fresh session reviewer sees the history without reading the state file.

<!-- workflow-kit:consumer-extension:start -->
<!-- workflow-kit:consumer-extension:end -->
