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
    const outcome = await plugin.run(context);
    if (outcome) outcomes.push(outcome);
  }
  return {
    ok: outcomes.every((outcome) => outcome.ok),
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
