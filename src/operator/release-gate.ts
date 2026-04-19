import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { DeployRecord, ProbeEnvironment, ProbeRecord, ProbeState, WorkflowConfig } from './state.ts';
import { PROBE_STALE_MS } from './state.ts';

// v1.2 env var: opaque HMAC-SHA256 signing key. Accepts any non-empty string;
// we recommend ≥32 bytes of cryptographic-random (e.g. `openssl rand -hex 32`)
// but don't enforce a format — that's the operator's call. When set,
// handleDeploy signs every new DeployRecord and the observed-success gate
// drops any record that fails signature verification (it becomes invisible
// to the gate, not authoritative). When unset, records ship unsigned and the
// signature step is skipped for backwards compat.
export const DEPLOY_STATE_KEY_ENV = 'PIPELANE_DEPLOY_STATE_KEY';

export interface DeployConfig {
  platform: string;
  frontend: {
    production: {
      url: string;
      deployWorkflow: string;
      autoDeployOnMain: boolean;
      healthcheckUrl: string;
    };
    staging: {
      url: string;
      deployWorkflow: string;
      healthcheckUrl: string;
    };
  };
  edge: {
    staging: {
      deployCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
    };
    production: {
      deployCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
    };
  };
  sql: {
    staging: {
      applyCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
    };
    production: {
      applyCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
    };
  };
  supabase: {
    staging: {
      projectRef: string;
    };
    production: {
      projectRef: string;
    };
  };
}

export function emptyDeployConfig(): DeployConfig {
  return {
    platform: '',
    frontend: {
      production: {
        url: '',
        deployWorkflow: '',
        autoDeployOnMain: false,
        healthcheckUrl: '',
      },
      staging: {
        url: '',
        deployWorkflow: '',
        healthcheckUrl: '',
      },
    },
    edge: {
      staging: {
        deployCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
      },
      production: {
        deployCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
      },
    },
    sql: {
      staging: {
        applyCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
      },
      production: {
        applyCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
      },
    },
    supabase: {
      staging: {
        projectRef: '',
      },
      production: {
        projectRef: '',
      },
    },
  };
}

function isLocalUrl(value: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value);
}

function findDeployConfigSectionRange(markdown: string): { start: number; end: number } | null {
  // Require end-of-line after the heading text so consumer-authored sections
  // like `## Deploy Configuration Notes` or `## Deploy Configuration v2` don't
  // collide with the machine-managed block and get silently overwritten.
  const start = markdown.search(/^## Deploy Configuration\s*$/m);
  if (start === -1) {
    return null;
  }

  const remainder = markdown.slice(start);
  const nextHeading = remainder.slice(1).search(/\n##\s/m);
  const end = nextHeading === -1 ? markdown.length : start + 1 + nextHeading;
  return { start, end };
}

export function extractDeployConfigSection(markdown: string): string | null {
  const range = findDeployConfigSectionRange(markdown);
  return range ? markdown.slice(range.start, range.end).trimEnd() : null;
}

export function parseDeployConfigMarkdown(markdown: string): DeployConfig | null {
  const section = extractDeployConfigSection(markdown);

  if (!section) {
    return null;
  }

  // Anchor both fences to newlines. JSON.stringify never emits a literal
  // newline inside a string (they're escaped as \n), so a command value with
  // embedded backticks — e.g. `deployCommand: "echo \`\`\` hi"` — can't trick
  // the regex into terminating early and truncating the JSON body. Use
  // `\r?\n` so CRLF-checked-out CLAUDE.md (Windows, core.autocrlf=true)
  // still parses.
  const jsonMatch = section.match(/```json\r?\n([\s\S]*?)\r?\n```/i);
  if (!jsonMatch) {
    return null;
  }

  const parsed = JSON.parse(jsonMatch[1]) as Partial<DeployConfig>;
  const config = emptyDeployConfig();

  config.platform = parsed.platform ?? '';
  config.frontend.production.url = parsed.frontend?.production?.url ?? '';
  config.frontend.production.deployWorkflow = parsed.frontend?.production?.deployWorkflow ?? '';
  config.frontend.production.autoDeployOnMain = Boolean(parsed.frontend?.production?.autoDeployOnMain);
  config.frontend.production.healthcheckUrl = parsed.frontend?.production?.healthcheckUrl ?? '';
  config.frontend.staging.url = parsed.frontend?.staging?.url ?? '';
  config.frontend.staging.deployWorkflow = parsed.frontend?.staging?.deployWorkflow ?? '';
  config.frontend.staging.healthcheckUrl = parsed.frontend?.staging?.healthcheckUrl ?? '';

  config.edge.staging.deployCommand = parsed.edge?.staging?.deployCommand ?? '';
  config.edge.staging.verificationCommand = parsed.edge?.staging?.verificationCommand ?? '';
  config.edge.staging.healthcheckUrl = parsed.edge?.staging?.healthcheckUrl ?? '';
  config.edge.production.deployCommand = parsed.edge?.production?.deployCommand ?? '';
  config.edge.production.verificationCommand = parsed.edge?.production?.verificationCommand ?? '';
  config.edge.production.healthcheckUrl = parsed.edge?.production?.healthcheckUrl ?? '';

  config.sql.staging.applyCommand = parsed.sql?.staging?.applyCommand ?? '';
  config.sql.staging.verificationCommand = parsed.sql?.staging?.verificationCommand ?? '';
  config.sql.staging.healthcheckUrl = parsed.sql?.staging?.healthcheckUrl ?? '';
  config.sql.production.applyCommand = parsed.sql?.production?.applyCommand ?? '';
  config.sql.production.verificationCommand = parsed.sql?.production?.verificationCommand ?? '';
  config.sql.production.healthcheckUrl = parsed.sql?.production?.healthcheckUrl ?? '';

  config.supabase.staging.projectRef = parsed.supabase?.staging?.projectRef ?? '';
  config.supabase.production.projectRef = parsed.supabase?.production?.projectRef ?? '';
  return config;
}

export function loadDeployConfig(repoRoot: string): DeployConfig | null {
  const claudePath = path.join(repoRoot, 'CLAUDE.md');

  if (!existsSync(claudePath)) {
    return null;
  }

  return parseDeployConfigMarkdown(readFileSync(claudePath, 'utf8'));
}

export function renderDeployConfigSection(config: DeployConfig): string {
  return `## Deploy Configuration

This section is machine-readable. Keep the JSON valid.
Release readiness is derived from (a) observed staging deploy records and (b) a
fresh \`/doctor --probe\` that healthchecks the configured staging URLs. Run
\`workflow:deploy -- staging <surface>\` once per surface to register a succeeded
deploy, then \`workflow:doctor --probe\` to register liveness. Probes older than
24h flip the release lane fail-closed.

\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`
`;
}

// Swap only the `## Deploy Configuration` block inside a CLAUDE.md body,
// preserving everything before and after. When the block is missing, append
// it at the end separated by a blank line. `configure` uses this to target
// exactly the deploy block without disturbing operator notes or skill routing
// rules the consumer has hand-edited above/below it.
export function replaceDeployConfigSection(markdown: string, config: DeployConfig): string {
  const rendered = renderDeployConfigSection(config);
  const range = findDeployConfigSectionRange(markdown);
  if (range) {
    return `${markdown.slice(0, range.start)}${rendered}${markdown.slice(range.end)}`;
  }
  const trimmed = markdown.replace(/\s+$/u, '');
  const separator = trimmed ? '\n\n' : '';
  return `${trimmed}${separator}${rendered}`;
}

// v1.2: canonicalize then hash. Any semantic change to the environment-scoped
// slice of deployConfig (staging URL, healthcheck path, workflow name
// rotation) produces a new fingerprint, which invalidates prior DeployRecords
// for that environment's readiness gate. Environments are fingerprinted
// separately so rotating a prod-only field does NOT invalidate staging
// readiness (and vice versa).
export function computeDeployConfigFingerprint(
  deployConfig: DeployConfig,
  environment: 'staging' | 'prod',
): string {
  const scoped = environment === 'staging'
    ? {
      platform: deployConfig.platform,
      frontend: deployConfig.frontend.staging,
      edge: deployConfig.edge.staging,
      sql: deployConfig.sql.staging,
      supabase: deployConfig.supabase.staging,
    }
    : {
      platform: deployConfig.platform,
      frontend: deployConfig.frontend.production,
      edge: deployConfig.edge.production,
      sql: deployConfig.sql.production,
      supabase: deployConfig.supabase.production,
    };
  return crypto.createHash('sha256').update(canonicalize(scoped)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === undefined) {
    // JSON.stringify drops undefined properties when writing to disk; the
    // canonical form must match so sign-time and verify-time produce the
    // same string after an on-disk round-trip.
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Arrays: JSON.stringify turns undefined entries into null, keeping the
    // slot. Mirror that so the canonical form survives JSON round-trip.
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalize(entry))).join(',')}]`;
  }
  // Object: skip keys whose value is undefined, same as JSON.stringify. Sort
  // remaining keys for determinism.
  const entries: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
  }
  return `{${entries.join(',')}}`;
}

// Sign every field of the record except `signature` itself. Using the
// compiler-enforced destructure (instead of a hand-maintained allowlist)
// means any future DeployRecord field is signed by default; forgetting to
// update an allowlist can't silently leave a field unsigned.
function canonicalRecordPayload(record: DeployRecord): string {
  const { signature: _signature, ...rest } = record;
  return canonicalize(rest);
}

export function signDeployRecord(record: DeployRecord, key: string): string {
  return crypto.createHmac('sha256', key).update(canonicalRecordPayload(record)).digest('hex');
}

export function verifyDeployRecord(record: DeployRecord, key: string): boolean {
  if (typeof record.signature !== 'string' || record.signature.length !== 64) return false;
  const expected = signDeployRecord(record, key);
  // Length-aware compare. Not strictly constant-time — the length check
  // above leaks whether the hex was 64 chars — but signatures are a fixed
  // size so length is public anyway. timingSafeEqual guards the byte-wise
  // compare once both buffers are 32 bytes.
  const a = Buffer.from(record.signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function resolveDeployStateKey(): string | undefined {
  const raw = process.env[DEPLOY_STATE_KEY_ENV];
  if (!raw || raw.trim().length === 0) return undefined;
  return raw.trim();
}

function resolveSurfaceVerification(record: DeployRecord, surface: string): DeployVerificationResult {
  const perSurface = record.verificationBySurface?.[surface];
  if (perSurface) return { kind: 'per-surface', verification: perSurface };
  // Legacy records (pre-v1.2) only have the aggregate `verification` block,
  // which in practice probed only the frontend. We only accept it as a
  // fallback for the frontend surface; edge/sql under legacy records are
  // treated as unverified so they don't inherit a probe that didn't happen.
  if (surface === 'frontend' && record.verification) {
    return { kind: 'aggregate', verification: record.verification };
  }
  return { kind: 'missing', verification: undefined };
}

type DeployVerification = NonNullable<DeployRecord['verification']>;
type DeployVerificationResult =
  | { kind: 'per-surface' | 'aggregate'; verification: DeployVerification }
  | { kind: 'missing'; verification: undefined };

function verificationPassed(verification: DeployVerification): boolean {
  // A DeployVerification with no statusCode is a deploy where no
  // healthcheckUrl was configured. Treat that as unverified (fail closed)
  // under the v1.2 gate even though status==='succeeded' was written.
  const code = verification.statusCode;
  if (typeof code !== 'number') return false;
  return code >= 200 && code < 300;
}

export type ObservedStagingResult =
  | { ok: true; reason?: undefined }
  | { ok: false; reason: string };

// v1.2: readiness is observed, not asserted. Walks records newest-first and
// the *most recent* VALID staging deploy touching the surface is
// authoritative. When a signing key is configured, unsigned/invalid-sig
// records are treated as invisible (not as "latest"), so an attacker with
// fs-write access can't plant a record to DoS the gate.
//
// A record only counts when: valid HMAC signature (when key set),
// status==='succeeded', verifiedAt is present, per-surface verification has a
// 2xx probe, configFingerprint matches the current staging-scoped config.
// Each closes one class of forged-record attack on deploy-state.json.
export function explainObservedStagingSuccess(
  records: DeployRecord[],
  surface: string,
  options: { deployConfig?: DeployConfig; key?: string } = {},
): ObservedStagingResult {
  const expectedFingerprint = options.deployConfig
    ? computeDeployConfigFingerprint(options.deployConfig, 'staging')
    : undefined;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.environment !== 'staging') continue;
    if (!Array.isArray(record.surfaces) || !record.surfaces.includes(surface)) continue;
    // Signing gate: invalid records don't participate at all, so they can't
    // be "latest" for a surface and can't DoS the gate with a fake failure.
    if (options.key && !verifyDeployRecord(record, options.key)) continue;

    if (record.status !== 'succeeded') {
      return { ok: false, reason: `latest record has status "${record.status ?? 'unknown'}"` };
    }
    if (!record.verifiedAt) {
      return { ok: false, reason: 'latest record lacks verifiedAt (unverified deploy)' };
    }
    if (expectedFingerprint && record.configFingerprint !== expectedFingerprint) {
      return { ok: false, reason: 'deploy config drift since record (fingerprint mismatch); re-run staging' };
    }
    const probe = resolveSurfaceVerification(record, surface);
    if (probe.kind === 'missing') {
      return { ok: false, reason: 'no per-surface verification recorded for this surface' };
    }
    if (!verificationPassed(probe.verification)) {
      return { ok: false, reason: `healthcheck did not return 2xx (HTTP ${probe.verification.statusCode ?? 'none'})` };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'no succeeded deploy observed' };
}

export function hasObservedStagingSuccess(
  records: DeployRecord[],
  surface: string,
  options: { deployConfig?: DeployConfig; key?: string } = {},
): boolean {
  return explainObservedStagingSuccess(records, surface, options).ok;
}

// Tolerate up to 5 minutes of clock skew between the probing machine and
// the consumer of probe-state. Records more than this in the future are
// treated as stale (either broken clock or a forged record).
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export type ProbeFreshnessState = 'healthy' | 'stale' | 'degraded' | 'unknown';

export interface ProbeSurfaceFreshness {
  state: ProbeFreshnessState;
  reason: string;
  probe: ProbeRecord | null;
  ageMs: number | null;
}

// v1.2: reconciles a probeState snapshot against the current clock + staling
// threshold. Returns a per-surface classification the release gate, /status
// cockpit, and dashboard share. Called from one place so the vocabulary is
// identical everywhere: `healthy` = probe succeeded within the window;
// `degraded` = probe present + fresh but non-2xx; `stale` = probe present
// but older than PROBE_STALE_MS; `unknown` = no probe on record.
export function explainSurfaceProbe(options: {
  probeState: ProbeState;
  surface: string;
  environment: ProbeEnvironment;
  now?: number;
  staleMs?: number;
}): ProbeSurfaceFreshness {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? PROBE_STALE_MS;
  const match = [...options.probeState.records]
    .reverse()
    .find((record) => record.environment === options.environment && record.surface === options.surface);

  if (!match) {
    return { state: 'unknown', reason: 'no probe recorded yet', probe: null, ageMs: null };
  }

  const probedAt = Date.parse(match.probedAt);
  const ageMs = Number.isFinite(probedAt) ? Math.max(0, now - probedAt) : null;

  if (ageMs === null) {
    return { state: 'stale', reason: `probe record has an unparseable probedAt "${match.probedAt}"`, probe: match, ageMs: null };
  }
  // Future-dated probedAt is either clock skew (harmless) or a forged
  // record (malicious). A record more than FUTURE_SKEW_MS in the future
  // can't have been produced by a real probe on this machine; treat it as
  // stale so the release gate falls closed.
  if (probedAt > now + FUTURE_SKEW_MS) {
    return { state: 'stale', reason: `probe record probedAt "${match.probedAt}" is in the future`, probe: match, ageMs: null };
  }
  if (ageMs > staleMs) {
    const ageHours = Math.round(ageMs / (60 * 60 * 1000));
    return { state: 'stale', reason: `probe is ${ageHours}h old (>24h threshold)`, probe: match, ageMs };
  }
  if (!match.ok) {
    const detail = match.statusCode ? `HTTP ${match.statusCode}` : (match.error || 'no response');
    return { state: 'degraded', reason: `probe failed: ${detail}`, probe: match, ageMs };
  }
  return { state: 'healthy', reason: '', probe: match, ageMs };
}

export function evaluateReleaseReadiness(options: {
  config: WorkflowConfig;
  deployConfig: DeployConfig;
  // v1.2: passed explicitly so readiness is derived from observed deploy
  // history rather than a stored flag. Callers load via loadDeployState().
  deployRecords: DeployRecord[];
  // v1.2: probe freshness is a second liveness gate alongside the observed
  // staging success. An empty `{ records: [] }` is allowed — it maps to
  // "probeState unknown", which still blocks until /doctor --probe runs.
  probeState?: ProbeState;
  surfaces: string[];
}): {
  ready: boolean;
  blockedSurfaces: string[];
  results: Record<string, { ready: boolean; missing: string[] }>;
} {
  const results: Record<string, { ready: boolean; missing: string[] }> = {};
  const gateOptions = { deployConfig: options.deployConfig, key: resolveDeployStateKey() };
  const observedStagingSuccess = (surface: string): string | null => {
    const result = explainObservedStagingSuccess(options.deployRecords, surface, gateOptions);
    if (result.ok) return null;
    return `${surface} staging: ${result.reason}. Run \`workflow:deploy -- staging ${surface}\` first.`;
  };
  const probeState = options.probeState ?? { records: [], updatedAt: '' };
  const probeFreshness = (surface: string): string | null => {
    const probe = explainSurfaceProbe({ probeState, surface, environment: 'staging' });
    if (probe.state === 'healthy') return null;
    if (probe.state === 'unknown') {
      return `${surface} staging: no probe recorded. Run \`workflow:doctor --probe\`.`;
    }
    return `${surface} staging probe is ${probe.state}: ${probe.reason}. Re-run \`workflow:doctor --probe\`.`;
  };

  for (const surface of options.surfaces) {
    const missing: string[] = [];

    if (surface === 'frontend') {
      const productionUrl = options.deployConfig.frontend.production.url;
      const productionWorkflow = options.deployConfig.frontend.production.deployWorkflow;
      const productionHealthcheck = options.deployConfig.frontend.production.healthcheckUrl || productionUrl;
      const stagingUrl = options.deployConfig.frontend.staging.url;
      const stagingWorkflow = options.deployConfig.frontend.staging.deployWorkflow;
      const stagingHealthcheck = options.deployConfig.frontend.staging.healthcheckUrl || stagingUrl;

      if (!productionUrl && !productionWorkflow) {
        missing.push('frontend production URL or workflow');
      }
      if (!productionHealthcheck) {
        missing.push('frontend production health check');
      }
      if (!stagingUrl && !stagingWorkflow) {
        missing.push('frontend staging URL or workflow');
      }
      if (!stagingHealthcheck) {
        missing.push('frontend staging health check');
      }
      if (productionUrl && stagingUrl && productionUrl === stagingUrl) {
        missing.push('frontend staging URL must differ from production URL');
      }
      if (stagingUrl && isLocalUrl(stagingUrl)) {
        missing.push('frontend staging URL must not be localhost');
      }
      if (stagingHealthcheck && isLocalUrl(stagingHealthcheck)) {
        missing.push('frontend staging health check must not be localhost');
      }
      const observed = observedStagingSuccess('frontend');
      if (observed) missing.push(observed);
      const probe = probeFreshness('frontend');
      if (probe) missing.push(probe);
    } else if (surface === 'edge') {
      if (!options.deployConfig.edge.staging.deployCommand) {
        missing.push('edge staging deploy command');
      }
      if (!options.deployConfig.edge.production.deployCommand) {
        missing.push('edge production deploy command');
      }
      if (!options.deployConfig.edge.staging.verificationCommand && !options.deployConfig.edge.production.verificationCommand && !options.deployConfig.edge.staging.healthcheckUrl && !options.deployConfig.edge.production.healthcheckUrl) {
        missing.push('edge verification command or health check');
      }
      const observed = observedStagingSuccess('edge');
      if (observed) missing.push(observed);
      // Edge + sql probes only run when an explicit healthcheckUrl is
      // configured for them — many consumers don't have one. When unset,
      // fall back to the observed-staging-success gate alone.
      if (options.deployConfig.edge.staging.healthcheckUrl) {
        const probe = probeFreshness('edge');
        if (probe) missing.push(probe);
      }
    } else if (surface === 'sql') {
      if (!options.deployConfig.sql.staging.applyCommand) {
        missing.push('sql staging apply/reset path');
      }
      if (!options.deployConfig.sql.production.applyCommand) {
        missing.push('sql production apply path');
      }
      if (!options.deployConfig.sql.staging.verificationCommand && !options.deployConfig.sql.production.verificationCommand && !options.deployConfig.sql.staging.healthcheckUrl && !options.deployConfig.sql.production.healthcheckUrl) {
        missing.push('sql verification step');
      }
      const observed = observedStagingSuccess('sql');
      if (observed) missing.push(observed);
      if (options.deployConfig.sql.staging.healthcheckUrl) {
        const probe = probeFreshness('sql');
        if (probe) missing.push(probe);
      }
    }

    results[surface] = {
      ready: missing.length === 0,
      missing,
    };
  }

  const blockedSurfaces = options.surfaces.filter((surface) => !results[surface]?.ready);
  return {
    ready: blockedSurfaces.length === 0,
    blockedSurfaces,
    results,
  };
}

export function buildReleaseCheckMessage(readiness: ReturnType<typeof evaluateReleaseReadiness>, surfaces: string[]): string {
  const lines = [
    readiness.ready ? 'Release readiness: PASS.' : 'Release readiness: FAIL.',
    `Requested surfaces: ${surfaces.join(', ')}`,
  ];

  if (!readiness.ready) {
    lines.push(`Blocked surfaces: ${readiness.blockedSurfaces.join(', ')}`);
    lines.push('Missing requirements:');
    for (const surface of readiness.blockedSurfaces) {
      lines.push(`- ${surface}:`);
      for (const missing of readiness.results[surface].missing) {
        lines.push(`  - ${missing}`);
      }
    }
    // v1.2: split remediation. If every blocker is "no succeeded deploy
    // observed" (a bootstrap state), point the operator at the deploy-first
    // path; otherwise the CLAUDE.md config still needs completing.
    const allObserveBlockers = readiness.blockedSurfaces.every((surface) =>
      readiness.results[surface].missing.length > 0
      && readiness.results[surface].missing.every((reason) => reason.includes('no succeeded deploy observed')),
    );
    if (allObserveBlockers) {
      lines.push('Next: run `npm run workflow:devmode -- build`, then `npm run workflow:deploy -- staging` once per surface,');
      lines.push('then `npm run workflow:devmode -- release`. The readiness gate is observed, not asserted.');
    } else {
      lines.push('Next: run `npm run workflow:configure` to fill in the Deploy Configuration block in CLAUDE.md, then');
      lines.push('`npm run workflow:devmode -- build` and `npm run workflow:deploy -- staging` to register a staging success.');
    }
  }

  return lines.join('\n');
}

export function normalizeDeployEnvironment(value: string): 'staging' | 'prod' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'staging') return 'staging';
  if (normalized === 'prod' || normalized === 'production') return 'prod';
  throw new Error('deploy requires an environment: staging or prod.');
}
