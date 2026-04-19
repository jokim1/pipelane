<!-- workflow-kit:command:status -->
Render a one-screen terminal cockpit of the workflow:api snapshot.

Run:

```bash
npm run workflow:status
```

For machine-readable output (same envelope the Pipelane Board consumes):

```bash
npm run workflow:status -- --json
```

Rules:

- `/status` is a pure renderer of `workflow:api snapshot --json` — zero
  derivation drift with the Pipelane Board.
- If the snapshot call fails, `/status` prints the envelope error verbatim.
  It never silently falls back to raw state files.
- Lane glyphs match the canonical 8-state vocabulary (`healthy`, `running`,
  `awaiting_preflight`, `stale`, `degraded`, `blocked`, `unknown`,
  `bypassed`). Colors degrade cleanly on non-TTY output.

<!-- workflow-kit:consumer-extension:start -->
<!-- workflow-kit:consumer-extension:end -->
