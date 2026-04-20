<!-- workflow-kit:command:rollback -->
Roll back the last staging or production deploy to the most recent verified-good SHA.

Two modes:

```bash
# Redeploy the last succeeded SHA for the named environment. Dispatches a
# fresh gh workflow run, probes healthchecks, and records a new
# DeployRecord with `rollbackOfSha` pointing at the failing SHA.
npm run workflow:rollback -- staging
npm run workflow:rollback -- prod

# Alternative recovery path: open a `git revert <mergeCommit>` PR via gh
# pr create. Never pushes to main directly. Release-mode only.
npm run workflow:rollback -- prod --revert-pr
```

Rules:

- Target is the most recent `status=succeeded, verification.statusCode < 300`
  DeployRecord for the same environment + surfaces, excluding the current
  (failing) SHA.
- `rollback.prod` joins the risky action set. The CLI prompts for a typed
  4-char prefix of the target SHA before dispatching. API callers consume
  an HMAC confirm-token from preflight instead of the TTY prompt.
- `--revert-pr` requires release mode and an existing merged PR (or a
  resolvable merge commit on the base branch). It creates a fresh
  `<branchPrefix>revert-<short-sha>` branch, runs `git revert --no-edit`,
  pushes, and opens a PR. It does NOT deploy — follow up with a normal merge.
- Specify `--surfaces frontend,edge` to narrow scope; by default rollback
  targets every surface the current task lock covers.

<!-- workflow-kit:consumer-extension:start -->
<!-- workflow-kit:consumer-extension:end -->
