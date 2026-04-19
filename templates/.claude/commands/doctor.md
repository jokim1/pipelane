<!-- workflow-kit:command:doctor -->
Diagnose deploy configuration, run live probes, or launch the fix wizard.

Three modes:

```bash
# Read CLAUDE.md, list missing deploy fields, detect platform.
npm run workflow:doctor

# Hit each configured staging/production healthcheck URL and record
# liveness to probe-state.json. Required for release-mode readiness.
npm run workflow:doctor -- --probe

# Interactive wizard: asks platform + URLs, writes the Deploy
# Configuration block in CLAUDE.md, then auto-runs --probe.
npm run workflow:doctor -- --fix
```

Rules:

- `/doctor --probe` writes `probe-state.json`. The release gate blocks when
  any probe is older than 24h or non-2xx.
- `/doctor --fix` requires a TTY. Use `pipelane configure` for scripted setup.
- Diagnose is a pure read — no side effects, safe to run anytime.

<!-- workflow-kit:consumer-extension:start -->
<!-- workflow-kit:consumer-extension:end -->
