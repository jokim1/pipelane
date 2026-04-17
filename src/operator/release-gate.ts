import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { DeployRecord, WorkflowConfig } from './state.ts';

// v1.2 env var: hex-encoded HMAC-SHA256 key. When set, handleDeploy signs
// every new DeployRecord; the observed-success gate rejects any record
// missing or failing signature verification. When unset, records ship
// unsigned and the gate skips the signature check for backwards compat.
export const DEPLOY_STATE_KEY_ENV = 'PIPELANE_DEPLOY_STATE_KEY';

const SIGNATURE_FIELDS: Array<keyof DeployRecord> = [
  'environment', 'sha', 'surfaces', 'workflowName', 'requestedAt',
  'taskSlug', 'status', 'workflowRunId', 'finishedAt', 'verifiedAt',
  'verification', 'verificationBySurface', 'configFingerprint',
  'idempotencyKey', 'triggeredBy',
];

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
      ready: boolean;
    };
  };
  edge: {
    staging: {
      deployCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
      ready: boolean;
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
      ready: boolean;
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
        ready: false,
      },
    },
    edge: {
      staging: {
        deployCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
        ready: false,
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
        ready: false,
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
  const start = markdown.search(/^## Deploy Configuration\b/m);
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

  const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i);
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
  config.frontend.staging.ready = Boolean(parsed.frontend?.staging?.ready);

  config.edge.staging.deployCommand = parsed.edge?.staging?.deployCommand ?? '';
  config.edge.staging.verificationCommand = parsed.edge?.staging?.verificationCommand ?? '';
  config.edge.staging.healthcheckUrl = parsed.edge?.staging?.healthcheckUrl ?? '';
  config.edge.staging.ready = Boolean(parsed.edge?.staging?.ready);
  config.edge.production.deployCommand = parsed.edge?.production?.deployCommand ?? '';
  config.edge.production.verificationCommand = parsed.edge?.production?.verificationCommand ?? '';
  config.edge.production.healthcheckUrl = parsed.edge?.production?.healthcheckUrl ?? '';

  config.sql.staging.applyCommand = parsed.sql?.staging?.applyCommand ?? '';
  config.sql.staging.verificationCommand = parsed.sql?.staging?.verificationCommand ?? '';
  config.sql.staging.healthcheckUrl = parsed.sql?.staging?.healthcheckUrl ?? '';
  config.sql.staging.ready = Boolean(parsed.sql?.staging?.ready);
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
Release readiness is derived from observed staging deploy records (v1.2); the legacy
\`.staging.ready\` boolean is ignored. Run \`workflow:deploy -- staging <surface>\` once
to register a succeeded deploy for each surface you plan to ship.

\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`
`;
}

// v1.2: canonicalize then hash. Any semantic change to deployConfig (staging
// URL, healthcheck path, workflow name rotation) produces a new fingerprint,
// which invalidates prior DeployRecords for the readiness gate until a fresh
// staging deploy re-registers under the new shape.
export function computeDeployConfigFingerprint(deployConfig: DeployConfig): string {
  return crypto.createHash('sha256').update(canonicalize(deployConfig)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(',');
  return `{${body}}`;
}

function canonicalRecordPayload(record: DeployRecord): string {
  const subset: Record<string, unknown> = {};
  for (const field of SIGNATURE_FIELDS) {
    if (record[field] !== undefined) {
      subset[field] = record[field];
    }
  }
  return canonicalize(subset);
}

export function signDeployRecord(record: DeployRecord, key: string): string {
  return crypto.createHmac('sha256', key).update(canonicalRecordPayload(record)).digest('hex');
}

export function verifyDeployRecord(record: DeployRecord, key: string): boolean {
  if (typeof record.signature !== 'string' || record.signature.length !== 64) return false;
  const expected = signDeployRecord(record, key);
  // Constant-time compare to avoid a timing oracle on the state-key.
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

// v1.2: readiness is observed, not asserted. Walks records newest-first and
// the *most recent* staging deploy touching the surface is authoritative. A
// later `status: 'failed'` record re-blocks the surface even if an older
// deploy succeeded; an older success does NOT rescue a newer failure.
//
// A record only counts when: status==='succeeded', verifiedAt is present,
// per-surface verification has a 2xx probe, configFingerprint matches the
// current deployConfig (drift re-blocks), and the HMAC signature verifies
// when PIPELANE_DEPLOY_STATE_KEY is set. Each of these closes one class of
// forged-record attack on the local deploy-state.json file.
export function hasObservedStagingSuccess(
  records: DeployRecord[],
  surface: string,
  options: { deployConfig?: DeployConfig; key?: string } = {},
): boolean {
  const expectedFingerprint = options.deployConfig
    ? computeDeployConfigFingerprint(options.deployConfig)
    : undefined;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.environment !== 'staging') continue;
    if (!Array.isArray(record.surfaces) || !record.surfaces.includes(surface)) continue;

    if (record.status !== 'succeeded') return false;
    if (!record.verifiedAt) return false;
    if (expectedFingerprint && record.configFingerprint !== expectedFingerprint) return false;
    if (options.key && !verifyDeployRecord(record, options.key)) return false;

    const probe = resolveSurfaceVerification(record, surface);
    if (probe.kind === 'missing') return false;
    return verificationPassed(probe.verification);
  }
  return false;
}

export function evaluateReleaseReadiness(options: {
  config: WorkflowConfig;
  deployConfig: DeployConfig;
  // v1.2: passed explicitly so readiness is derived from observed deploy
  // history rather than a stored flag. Callers load via loadDeployState().
  deployRecords: DeployRecord[];
  surfaces: string[];
}): {
  ready: boolean;
  blockedSurfaces: string[];
  results: Record<string, { ready: boolean; missing: string[] }>;
} {
  const results: Record<string, { ready: boolean; missing: string[] }> = {};
  const gateOptions = { deployConfig: options.deployConfig, key: resolveDeployStateKey() };
  const observedStagingSuccess = (surface: string): string | null =>
    hasObservedStagingSuccess(options.deployRecords, surface, gateOptions)
      ? null
      : `${surface} staging: no succeeded deploy observed. Run \`workflow:deploy -- staging ${surface}\` first.`;

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
      lines.push('Next: run npm run workflow:setup and complete local CLAUDE.md, then');
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
