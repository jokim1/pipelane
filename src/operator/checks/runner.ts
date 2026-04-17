import { ghRequiredSecretsCheck } from './gh-required-secrets.ts';
import { secretManifestCheck } from './secret-manifest.ts';
import type { Check, CheckContext, CheckOutcome } from './types.ts';

// Registered plugin list. Each decides internally whether it's configured —
// see each plugin's `run()` for the gating logic it applies to
// context.config.checks.
const BUILT_IN_CHECKS: Check[] = [secretManifestCheck, ghRequiredSecretsCheck];

export interface ChecksReport {
  // True iff every dispatched plugin returned ok:true. Absent plugins don't
  // count (they weren't configured).
  ok: boolean;
  outcomes: CheckOutcome[];
}

export async function runChecks(context: CheckContext, plugins: Check[] = BUILT_IN_CHECKS): Promise<ChecksReport> {
  const outcomes: CheckOutcome[] = [];
  for (const plugin of plugins) {
    // Contain plugin throws. A buggy plugin must not crash release-check —
    // treat an uncaught throw as a fail-closed outcome for that plugin and
    // let the others still run.
    try {
      const outcome = await plugin.run(context);
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        plugin: plugin.name,
        ok: false,
        findings: [{ plugin: plugin.name, reason: `plugin threw: ${message}` }],
        error: message,
      });
    }
  }
  return {
    // Don't trust a plugin's self-reported `ok`. A buggy plugin that returns
    // ok:true alongside findings or an error must not clear the gate. Derive
    // effectiveOk from the observable state.
    ok: outcomes.every((outcome) => outcome.ok && !outcome.error && outcome.findings.length === 0),
    outcomes,
  };
}

export function formatChecksReport(report: ChecksReport): string {
  if (report.outcomes.length === 0) {
    return 'Pluggable checks: none configured.';
  }
  const lines: string[] = [];
  lines.push(report.ok ? 'Pluggable checks: PASS.' : 'Pluggable checks: FAIL.');
  for (const outcome of report.outcomes) {
    lines.push(`- ${outcome.plugin}: ${outcome.ok ? 'PASS' : 'FAIL'}`);
    for (const finding of outcome.findings) {
      lines.push(`  - ${finding.reason}`);
    }
  }
  return lines.join('\n');
}
