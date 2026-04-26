# Smoke Hot Paths: AI-Customized Blocking Smoke Tests

## Summary

`/smoke setup` now treats smoke coverage as a repo-aware hot-path planning problem instead of only wiring an existing runner. The command analyzes the repository, proposes product-specific primary journeys, accepts plain-language feedback, persists scenario metadata in the existing smoke registry, and only promotes checks to blocking after a clean check-level verification run.

Templates are internal planner knowledge. Users see scenario recommendations, not template names or template selection prompts.

## Implemented CLI Contracts

- `/smoke setup`
  - Analyzes repo structure, routes, tests, package scripts, dependencies, env var names, and feature signals.
  - Adds proposed hot-path scenarios to `.pipelane/smoke-checks.json`.
  - Accepts `--feedback <text>` for product-specific coverage, such as AI flows in boards/wiki/auth.
  - Accepts `--scenario-file <path>` for AI/skill-produced structured scenario intent.
  - Accepts `--base-url <url>` to verify the configured staging smoke command during setup.
  - Accepts `--make-blocking` to promote only cleanly verified check-level results.

- `/smoke plan --refresh`
  - Re-analyzes repo drift and proposed hot-path additions.
  - Report-only: writes no registry, generated tests, or config changes.
  - Supports `--feedback <text>` and `--scenario-file <path>` for previewing customized coverage.

## Registry Model

The existing smoke registry remains the source of truth. Entries may now include:

- `lifecycle`: `suggested`, `accepted`, `generated`, `verified`, `blocking`, or `quarantined`.
- `safetyFlags`: `readonly`, `stagingOnly`, `requiresSyntheticData`, `externalDependency`, `unsafeForAutomation`.
- `requiredEnv`: env var names only, never secret values.
- `provenance`: source, confidence, repo evidence, and update time.
- `generated`: generated-test marker and verification metadata.

Existing `blocking`, `quarantine`, `sourceTests`, `environments`, and smoke gate behavior remain compatible.

## Verification Rules

- Setup verification runs only when a base URL is available through `--base-url` or staging deploy config.
- Check-level runner output is required before any scenario can become `verified` or `blocking`.
- Clean `passed` results may become blocking when `--make-blocking` is present.
- `passed_with_retries`, failed checks, and runner output without check-level results stay non-blocking.
- Missing credentials or unsupported runners leave scenarios as stubs/recommendations instead of inventing fake passing tests.

## Failure UX

Smoke failures now include an AI-fix prompt bundle with:

- Scenario/check identity.
- Command and target URL.
- Log/results paths.
- Failing check statuses.
- A reminder not to weaken/delete the smoke check unless the hot path is obsolete.

Credential-looking material in commands and URLs is redacted before it appears in the prompt.

## Generator Safety

Generated test ownership uses marker-delimited regions:

```ts
/* pipelane:smoke:start <marker> */
/* generated body */
/* pipelane:smoke:end <marker> */
```

Updates preserve user edits outside the generated region and refuse malformed, missing, or duplicate marker pairs.

## Out Of Scope For This Slice

- Installing Playwright, Cypress, or other test frameworks automatically.
- Generating broad runnable test suites for every app/game/mobile framework.
- Making unsupported or low-confidence scenario stubs blocking.
- Storing secret values in config, registry, logs, or prompts.

## Verification

- `npm run typecheck`
- `node --test test/pipelane.test.mjs --test-name-pattern='smoke setup|smoke plan --refresh|generated smoke marker|smoke failure AI fix prompt'`

The filtered command currently loads the full repository test file; the observed run passed the full suite.
