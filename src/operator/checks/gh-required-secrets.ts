import { runCommandCapture } from '../state.ts';
import type { Check, CheckContext, CheckFinding, CheckOutcome } from './types.ts';

export const GH_REQUIRED_SECRETS_PLUGIN = 'gh-required-secrets';

// Release-mode environments the plugin checks when requiredEnvironmentSecrets
// is set. Matches Rocketboard's RELEASE_ENVIRONMENTS constant.
const RELEASE_ENVIRONMENTS: Array<'staging' | 'production'> = ['staging', 'production'];

// Test hook: a JSON object mapping environment (or '' for repo-level) to
// string[] of secret names. When set, replaces the real `gh secret list`
// call so tests don't need gh. Example:
// PIPELANE_CHECKS_GH_SECRETS_STUB='{"":["FOO"],"staging":["BAR"]}'
const GH_SECRETS_STUB_ENV = 'PIPELANE_CHECKS_GH_SECRETS_STUB';

function normalizeNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))].sort();
}

function readGhStub(): Record<string, string[]> | null {
  const raw = process.env[GH_SECRETS_STUB_ENV];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = normalizeNames(value);
    }
    return out;
  } catch {
    return null;
  }
}

function listGhSecrets(cwd: string, environment: '' | 'staging' | 'production'): { ok: true; names: string[] } | { ok: false; error: string } {
  const stub = readGhStub();
  if (stub) {
    const names = stub[environment];
    if (names) return { ok: true, names };
    if (environment === '') return { ok: false, error: 'stub missing repo-level entry ("")' };
    return { ok: false, error: `stub missing entry for environment "${environment}"` };
  }
  const args = ['secret', 'list'];
  if (environment) args.push('--env', environment);
  args.push('--json', 'name');
  const result = runCommandCapture('gh', args, { cwd });
  if (!result.ok) {
    return { ok: false, error: result.stderr || result.stdout || `gh secret list exited ${result.exitCode}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ name: string }>;
    return { ok: true, names: normalizeNames(parsed.map((entry) => entry.name)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not parse gh secret list output: ${message}` };
  }
}

export const ghRequiredSecretsCheck: Check = {
  name: GH_REQUIRED_SECRETS_PLUGIN,
  async run(context: CheckContext): Promise<CheckOutcome | null> {
    const cfg = context.config.checks;
    const repoRequired = cfg?.requiredRepoSecrets ?? [];
    const envRequired = cfg?.requiredEnvironmentSecrets ?? [];
    if (repoRequired.length === 0 && envRequired.length === 0) return null;

    const findings: CheckFinding[] = [];

    if (repoRequired.length > 0) {
      const listed = listGhSecrets(context.repoRoot, '');
      if (listed.ok === false) {
        findings.push({ plugin: GH_REQUIRED_SECRETS_PLUGIN, reason: `gh repo secret inspection failed: ${listed.error}` });
      } else {
        const present = new Set(listed.names);
        for (const name of repoRequired) {
          if (!present.has(name)) {
            findings.push({ plugin: GH_REQUIRED_SECRETS_PLUGIN, reason: `gh repo secret ${name} missing` });
          }
        }
      }
    }

    if (envRequired.length > 0) {
      for (const environment of RELEASE_ENVIRONMENTS) {
        const listed = listGhSecrets(context.repoRoot, environment);
        if (listed.ok === false) {
          findings.push({ plugin: GH_REQUIRED_SECRETS_PLUGIN, reason: `gh ${environment} environment secret inspection failed: ${listed.error}` });
          continue;
        }
        const present = new Set(listed.names);
        for (const name of envRequired) {
          if (!present.has(name)) {
            findings.push({ plugin: GH_REQUIRED_SECRETS_PLUGIN, reason: `gh ${environment} environment secret ${name} missing` });
          }
        }
      }
    }

    return {
      plugin: GH_REQUIRED_SECRETS_PLUGIN,
      ok: findings.length === 0,
      findings,
    };
  },
};
