import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { runCommandCapture } from '../state.ts';
import type { Check, CheckContext, CheckFinding, CheckOutcome } from './types.ts';

export const SECRET_MANIFEST_PLUGIN = 'secret-manifest';

// Test hook: a JSON map of projectRef -> string[] of secret names. When set,
// replaces the real `supabase secrets list` call so tests don't need the
// CLI. Example: PIPELANE_CHECKS_SUPABASE_SECRETS_STUB='{"staging-ref":["FOO","BAR"]}'.
const SUPABASE_SECRETS_STUB_ENV = 'PIPELANE_CHECKS_SUPABASE_SECRETS_STUB';

interface SecretManifest {
  required: string[];
  optional: string[];
}

function normalizeNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))].sort();
}

function loadManifest(manifestPath: string): { manifest: SecretManifest | null; error?: string } {
  if (!existsSync(manifestPath)) {
    return { manifest: null, error: `secret manifest not found at ${manifestPath}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { manifest: null, error: `failed to parse ${manifestPath}: ${message}` };
  }
  // Require an object with an explicitly-present `required` array. Accepting
  // bare {} or [] would let any unrelated JSON file pass as "empty manifest"
  // and silently defeat the gate.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, error: `${manifestPath}: manifest must be a JSON object with a "required" field` };
  }
  const parsed = raw as Record<string, unknown>;
  if (parsed.required === undefined) {
    return { manifest: null, error: `${manifestPath}: manifest is missing required "required" field` };
  }
  if (!Array.isArray(parsed.required)) {
    return { manifest: null, error: `${manifestPath}: "required" must be an array of strings` };
  }
  return {
    manifest: {
      required: normalizeNames(parsed.required),
      optional: normalizeNames(parsed.optional),
    },
  };
}

function readSupabaseStub(): Record<string, string[]> | null {
  // Gated to NODE_ENV==='test' so a stray env var in a shared production
  // shell cannot silently short-circuit the secrets check. Same rationale
  // as PIPELANE_DEPLOY_PROD_CONFIRM_STUB in v0.5.
  if (process.env.NODE_ENV !== 'test') return null;
  const raw = process.env[SUPABASE_SECRETS_STUB_ENV];
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

function listSupabaseSecrets(cwd: string, projectRef: string): { ok: true; names: string[] } | { ok: false; error: string } {
  const stub = readSupabaseStub();
  if (stub) {
    const names = stub[projectRef];
    if (names) return { ok: true, names };
    return { ok: false, error: `stub missing entries for project-ref ${projectRef}` };
  }
  const result = runCommandCapture('supabase', [
    'secrets', 'list', '--project-ref', projectRef, '--output', 'json',
  ], { cwd });
  if (!result.ok) {
    return { ok: false, error: result.stderr || result.stdout || `supabase secrets list exited ${result.exitCode}` };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error: `supabase secrets list returned unexpected shape for ${projectRef}: expected array, got ${typeof parsed}`,
      };
    }
    return {
      ok: true,
      names: normalizeNames((parsed as Array<{ name?: unknown }>).map((entry) => entry?.name)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not parse supabase secrets list output for ${projectRef}: ${message}` };
  }
}

export const secretManifestCheck: Check = {
  name: SECRET_MANIFEST_PLUGIN,
  async run(context: CheckContext): Promise<CheckOutcome | null> {
    const cfg = context.config.checks;
    if (!cfg?.requireSecretManifest) return null;

    const manifestPath = cfg.secretManifestPath?.trim();
    if (!manifestPath) {
      return {
        plugin: SECRET_MANIFEST_PLUGIN,
        ok: false,
        findings: [{ plugin: SECRET_MANIFEST_PLUGIN, reason: 'requireSecretManifest is true but secretManifestPath is not set' }],
      };
    }

    // Defense-in-depth: keep the manifest read inside the repo root.
    // `path.resolve` catches `../` path traversal; `realpathSync` catches
    // symlink escapes (e.g. the manifest file is a symlink to /etc/passwd).
    // Attacker would need repo write access to plant either form, but we
    // still refuse to read outside the tree regardless.
    const absolutePath = path.resolve(context.repoRoot, manifestPath);
    const repoRootResolved = path.resolve(context.repoRoot);
    const isInsideRepo = (candidate: string): boolean =>
      candidate === repoRootResolved || candidate.startsWith(repoRootResolved + path.sep);
    if (!isInsideRepo(absolutePath)) {
      return {
        plugin: SECRET_MANIFEST_PLUGIN,
        ok: false,
        findings: [{
          plugin: SECRET_MANIFEST_PLUGIN,
          reason: `secretManifestPath resolves outside the repo (${manifestPath}); refusing to read`,
        }],
      };
    }
    if (existsSync(absolutePath)) {
      // Follow symlinks and verify the canonical path is still inside the
      // repo. If realpathSync throws (broken symlink, permission), surface
      // as a finding rather than letting it bubble up.
      try {
        const canonical = realpathSync(absolutePath);
        const canonicalRepo = realpathSync(repoRootResolved);
        if (!(canonical === canonicalRepo || canonical.startsWith(canonicalRepo + path.sep))) {
          return {
            plugin: SECRET_MANIFEST_PLUGIN,
            ok: false,
            findings: [{
              plugin: SECRET_MANIFEST_PLUGIN,
              reason: `secretManifestPath symlinks outside the repo (${manifestPath}); refusing to read`,
            }],
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          plugin: SECRET_MANIFEST_PLUGIN,
          ok: false,
          findings: [{
            plugin: SECRET_MANIFEST_PLUGIN,
            reason: `failed to canonicalize secretManifestPath (${manifestPath}): ${message}`,
          }],
        };
      }
    }
    const loaded = loadManifest(absolutePath);
    if (!loaded.manifest) {
      return {
        plugin: SECRET_MANIFEST_PLUGIN,
        ok: false,
        findings: [{ plugin: SECRET_MANIFEST_PLUGIN, reason: loaded.error ?? 'manifest unreadable' }],
      };
    }
    if (loaded.manifest.required.length === 0) {
      // Empty manifest is legal (e.g. a team removing a function). Pass.
      return { plugin: SECRET_MANIFEST_PLUGIN, ok: true, findings: [] };
    }

    const findings: CheckFinding[] = [];
    const envs: Array<{ environment: 'staging' | 'production'; projectRef: string | undefined }> = [
      { environment: 'staging', projectRef: context.deployConfig.supabase.staging.projectRef?.trim() || undefined },
      { environment: 'production', projectRef: context.deployConfig.supabase.production.projectRef?.trim() || undefined },
    ];

    for (const env of envs) {
      if (!env.projectRef) {
        findings.push({ plugin: SECRET_MANIFEST_PLUGIN, reason: `supabase.${env.environment}.projectRef is not set in CLAUDE.md` });
        continue;
      }
      const listed = listSupabaseSecrets(context.repoRoot, env.projectRef);
      if (listed.ok === false) {
        findings.push({ plugin: SECRET_MANIFEST_PLUGIN, reason: `supabase ${env.environment} (${env.projectRef}): ${listed.error}` });
        continue;
      }
      const present = new Set(listed.names);
      for (const name of loaded.manifest.required) {
        if (!present.has(name)) {
          findings.push({ plugin: SECRET_MANIFEST_PLUGIN, reason: `supabase ${env.environment} (${env.projectRef}) missing required secret ${name}` });
        }
      }
    }

    return {
      plugin: SECRET_MANIFEST_PLUGIN,
      ok: findings.length === 0,
      findings,
    };
  },
};
