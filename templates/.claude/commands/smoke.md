<!-- pipelane:command:smoke -->
Plan smoke coverage or run deterministic smoke against staging or prod.

Run:

```bash
npm run pipelane:smoke -- $ARGUMENTS
```

Expected arguments:

- `plan`
- `staging`
- `prod`

Rules:

- `plan` scaffolds or audits `.pipelane/smoke-checks.json` and prints the top actions.
- `staging` runs smoke for the currently deployed staging SHA.
- `prod` runs the prod-safe smoke subset for the currently deployed prod SHA.
- Smoke injects `PIPELANE_SMOKE_ENV`, `PIPELANE_SMOKE_BASE_URL`, `PIPELANE_SMOKE_SHA`, and `PIPELANE_SMOKE_RUN_ID` into the repo-owned smoke command.

Display the output directly and keep the environment explicit.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
