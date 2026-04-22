import readline from 'node:readline';

import { acquireSmokeEnvironmentLock, evaluateSmokeCoverage, findLatestSmokeRun, findQualifyingSmokeRun, isSmokeSuccessStatus, releaseSmokeEnvironmentLock, resolveSmokeConfig } from '../smoke-gate.ts';
import {
  buildReleaseCheckMessage,
  computeDeployConfigFingerprint,
  emptyDeployConfig,
  evaluateReleaseReadiness,
  loadDeployConfig,
  normalizeDeployEnvironment,
  resolveDeployStateKey,
  signDeployRecord,
  verifyDeployRecord,
} from '../release-gate.ts';
import {
  loadDeployState,
  loadSmokeRegistry,
  loadPrRecord,
  loadProbeState,
  nowIso,
  printResult,
  resolveWorkflowContext,
  runCommandCapture,
  runGh,
  saveDeployState,
  type DeployRecord,
  type DeployStatus,
  type DeployVerification,
  type ParsedOperatorArgs,
  type WorkflowConfig,
} from '../state.ts';
import {
  inferActiveTaskLock,
  makeIdempotencyKey,
  resolveSurfaceHealthcheckUrl,
  resolveCommandSurfaces,
  resolveDeployTargetForTask,
  setNextAction,
} from './helpers.ts';
import { observeFrontendRuntime, toDeployRuntimeObservation } from '../runtime-observation.ts';

function surfacesKey(surfaces: string[]): string {
  return [...surfaces].sort().join(',');
}

function findMatchingSucceededDeploy(options: {
  records: DeployRecord[];
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  taskSlug: string;
}): DeployRecord | null {
  const key = surfacesKey(options.surfaces);
  // Only succeeded records count. Records missing `status` (written by
  // pre-v0.1 Pipelane) are treated as `unknown` — fail-closed, never match.
  return [...options.records].reverse().find((record) =>
    record.status === 'succeeded'
    && record.environment === options.environment
    && record.sha === options.sha
    && surfacesKey(record.surfaces) === key
    && (!record.taskSlug || record.taskSlug === options.taskSlug)
  ) ?? null;
}

// v1.2: per-surface verification + fingerprint + signature check for the
// prod-gate record. Returns the first reason the record fails to qualify, or
// null when everything checks out. Keeps the prod gate as tight as the
// staging-readiness gate.
function disqualifyStagingRecord(options: {
  record: DeployRecord;
  surfaces: string[];
  expectedFingerprint: string;
  stateKey: string | undefined;
}): string | null {
  const { record, surfaces, expectedFingerprint, stateKey } = options;
  if (!record.verifiedAt) {
    return `record lacks verifiedAt timestamp (status "${record.status ?? 'unknown'}" without verified probe)`;
  }
  if (record.configFingerprint && record.configFingerprint !== expectedFingerprint) {
    return 'deploy config has drifted since this record was written; re-run staging to re-register';
  }
  if (!record.configFingerprint) {
    return 'record lacks configFingerprint (legacy pre-v1.2 record, cannot prove config parity)';
  }
  if (stateKey && !verifyDeployRecord(record, stateKey)) {
    return 'HMAC signature missing or invalid under PIPELANE_DEPLOY_STATE_KEY';
  }
  for (const surface of surfaces) {
    const probe = record.verificationBySurface?.[surface];
    if (!probe) {
      if (surface === 'frontend' && record.verification) {
        // Legacy aggregate-only verification (pre-per-surface). Only accepts
        // frontend, matching hasObservedStagingSuccess's legacy fallback.
        const code = record.verification.statusCode;
        if (typeof code !== 'number' || code < 200 || code >= 300) {
          return `frontend: legacy verification is non-2xx (${code ?? 'missing'})`;
        }
        continue;
      }
      return `${surface}: no per-surface verification recorded`;
    }
    const code = probe.statusCode;
    if (typeof code !== 'number' || code < 200 || code >= 300) {
      return `${surface}: healthcheck returned ${code ?? 'no status'}`;
    }
  }
  return null;
}

function deployEnvironmentLabel(environment: 'staging' | 'prod'): 'staging' | 'production' {
  return environment === 'prod' ? 'production' : 'staging';
}

function listMissingDeployConfiguration(options: {
  config: ReturnType<typeof emptyDeployConfig>;
  environment: 'staging' | 'prod';
  surfaces: string[];
  defaultWorkflowName: string;
}): string[] {
  const missing = new Set<string>();
  const label = deployEnvironmentLabel(options.environment);
  const frontend = options.environment === 'staging'
    ? options.config.frontend.staging
    : options.config.frontend.production;

  if (!frontend.deployWorkflow && !options.defaultWorkflowName) {
    missing.add(`frontend ${label} deploy workflow`);
  }

  for (const surface of options.surfaces) {
    if (surface === 'frontend') {
      if (!frontend.url && !frontend.deployWorkflow && !options.defaultWorkflowName) {
        missing.add(`frontend ${label} URL or deploy workflow`);
      }
      if (!resolveSurfaceHealthcheckUrl(options.config, options.environment, surface)) {
        missing.add(`frontend ${label} health check`);
      }
      continue;
    }

    if (!resolveSurfaceHealthcheckUrl(options.config, options.environment, surface)) {
      missing.add(`${surface} ${label} health check`);
    }
  }

  return [...missing];
}

function buildDeployConfigurationError(options: {
  environment: 'staging' | 'prod';
  surfaces: string[];
  missing: string[];
}): string {
  return [
    `Deploy blocked: ${options.environment}`,
    `Requested surfaces: ${options.surfaces.join(', ')}`,
    'Missing deploy configuration:',
    ...options.missing.map((entry) => `- ${entry}`),
    'Fix the Deploy Configuration block in CLAUDE.md before running pipelane:deploy again.',
  ].join('\n');
}

export interface DispatchDeployOptions {
  environment?: 'staging' | 'prod';
  explicitSurfaces?: string[];
  explicitTask?: string;
  async?: boolean;
}

export type DispatchDeployResult = DeployRecord & {
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  workflowName: string;
  taskSlug: string;
  message: string;
};

export async function dispatchDeploy(
  cwd: string,
  parsed: ParsedOperatorArgs,
  options: DispatchDeployOptions = {},
): Promise<DispatchDeployResult> {
  const context = resolveWorkflowContext(cwd);
  const environment = options.environment ?? normalizeDeployEnvironment(parsed.positional[0] ?? '');
  const explicitSurfaces = options.explicitSurfaces ?? [...parsed.flags.surfaces, ...parsed.positional.slice(1)];
  const { taskSlug, lock } = inferActiveTaskLock(context, options.explicitTask ?? parsed.flags.task);
  const surfaces = resolveCommandSurfaces(context, explicitSurfaces, lock.surfaces);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const allowHealthcheckStubBypass = process.env.NODE_ENV === 'test'
    && Boolean(process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS);
  const missingConfig = listMissingDeployConfiguration({
    config: deployConfig,
    environment,
    surfaces,
    defaultWorkflowName: context.config.deployWorkflowName,
  }).filter((entry) => !allowHealthcheckStubBypass || !entry.endsWith('health check'));
  if (missingConfig.length > 0) {
    throw new Error(buildDeployConfigurationError({ environment, surfaces, missing: missingConfig }));
  }
  const prRecord = loadPrRecord(context.commonDir, context.config, taskSlug);
  const target = resolveDeployTargetForTask({
    repoRoot: context.repoRoot,
    baseBranch: context.config.baseBranch,
    explicitSha: parsed.flags.sha,
    prRecord,
    mode: context.modeState.mode,
  });
  const asyncRequested = options.async ?? parsed.flags.async;
  const smokeConfig = resolveSmokeConfig(context.config);
  const requestedSmokeCoverageOverrideReason = parsed.flags.skipSmokeCoverage
    ? parsed.flags.reason.trim()
    : '';
  if (parsed.flags.skipSmokeCoverage && !requestedSmokeCoverageOverrideReason) {
    throw new Error([
      'Smoke coverage override requires --reason.',
      'Example: pipelane:deploy -- prod --skip-smoke-coverage --reason "critical hotfix while smoke coverage catches up"',
    ].join('\n'));
  }

  const deployState = loadDeployState(context.commonDir, context.config);
  // v1.2: when signing is configured, attacker-planted records (unsigned or
  // bad-sig) are filtered out of every gate consult. They remain on disk and
  // get naturally displaced by persistRecord's slice(-100), but they can't
  // become "latest" for a surface or short-circuit an idempotency check.
  const stateKey = resolveDeployStateKey();
  const trustedRecords = stateKey
    ? deployState.records.filter((record) => verifyDeployRecord(record, stateKey))
    : deployState.records;
  let smokeCoverageOverrideReason: string | undefined;

  if (context.modeState.mode === 'release') {
    // v1.2 readiness is now observed, not asserted. Callers to prod are also
    // allowed to promote the same SHA they just verified in staging, so
    // release-readiness for prod deploys counts the current deployState.
    const probeState = loadProbeState(context.commonDir, context.config);
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      deployRecords: trustedRecords,
      probeState,
      surfaces,
    });
    if (!readiness.ready && !context.modeState.override) {
      throw new Error(buildReleaseCheckMessage(readiness, surfaces));
    }
  }

  // Prod gate (v0.2): staging must have a verified-succeeded deploy for
  // the same (sha, surfaces, taskSlug). Records missing `status` don't
  // qualify — legacy records fail closed.
  if (context.modeState.mode === 'release' && environment === 'prod') {
    const staging = findMatchingSucceededDeploy({
      records: trustedRecords,
      environment: 'staging',
      sha: target.sha,
      surfaces,
      taskSlug,
    });
    if (!staging) {
      throw new Error([
        `deploy prod blocked: no succeeded staging deploy found for SHA ${target.sha.slice(0, 7)}`,
        `with surfaces ${surfaces.join(',')} and task ${taskSlug}.`,
        'Run pipelane:deploy -- staging first, wait for it to report status=succeeded.',
      ].join('\n'));
    }
    // v1.2: tighten the prod gate with the same per-surface + fingerprint +
    // signature invariants as the staging-readiness gate.
    const disqualification = disqualifyStagingRecord({
      record: staging,
      surfaces,
      // The record being checked is a STAGING record, so compare its stored
      // fingerprint against the current STAGING config slice, not prod.
      expectedFingerprint: computeDeployConfigFingerprint(deployConfig, 'staging'),
      stateKey,
    });
    if (disqualification) {
      throw new Error([
        `deploy prod blocked: matching staging record is not promotable — ${disqualification}.`,
        'Re-run pipelane:deploy -- staging and let it verify before promoting.',
      ].join('\n'));
    }

    if (smokeConfig.requireStagingSmoke) {
      const qualifyingSmoke = findQualifyingSmokeRun({
        commonDir: context.commonDir,
        config: context.config,
        environment: 'staging',
        sha: target.sha,
      });
      if (!qualifyingSmoke) {
        const latestSmoke = findLatestSmokeRun({
          commonDir: context.commonDir,
          config: context.config,
          environment: 'staging',
          sha: target.sha,
        });
        if (latestSmoke && !isSmokeSuccessStatus(latestSmoke.status)) {
          throw new Error([
            `deploy prod blocked: staging smoke failed for SHA ${target.sha.slice(0, 7)}.`,
            'Run pipelane:smoke -- staging after fixing the failing smoke checks.',
          ].join('\n'));
        }
        throw new Error([
          `deploy prod blocked: no qualifying staging smoke found for SHA ${target.sha.slice(0, 7)}.`,
          'Run pipelane:smoke -- staging.',
        ].join('\n'));
      }

      const coverage = evaluateSmokeCoverage({
        registry: loadSmokeRegistry(context.repoRoot, context.config),
        environment: 'staging',
        config: context.config,
      });
      if (coverage.uncoveredCriticalPaths.length > 0) {
        const coverageMessage = `critical-path smoke gaps: ${coverage.uncoveredCriticalPaths.join(', ')}`;
        if (coverage.mode === 'block') {
          if (!requestedSmokeCoverageOverrideReason) {
            throw new Error([
              `deploy prod blocked: ${coverageMessage}.`,
              'Run pipelane:smoke -- plan or add smoke coverage before promoting.',
              'If you must ship anyway, re-run with `--skip-smoke-coverage --reason "<why>"`.',
            ].join('\n'));
          }
          smokeCoverageOverrideReason = requestedSmokeCoverageOverrideReason;
          process.stderr.write(`[pipelane] WARNING: bypassing smoke coverage block: ${coverageMessage}\n`);
          process.stderr.write(`[pipelane] WARNING: smoke coverage override reason: ${smokeCoverageOverrideReason}\n`);
        } else {
          process.stderr.write(`[pipelane] WARNING: ${coverageMessage}\n`);
        }
      }
    }
  }

  const deployRunId = `deploy-${environment}-${target.sha.slice(0, 7)}-${Date.now()}`;
  acquireSmokeEnvironmentLock({
    commonDir: context.commonDir,
    repoRoot: context.repoRoot,
    environment,
    operation: 'deploy',
    runId: deployRunId,
    sha: target.sha,
  });

  try {
    const idempotencyKey = makeIdempotencyKey({
      environment,
      sha: target.sha,
      surfaces,
      taskSlug,
      configFingerprint: computeDeployConfigFingerprint(deployConfig, environment),
    });

    // Short-circuit: if we already have a succeeded deploy with this key,
    // don't re-dispatch. Return the existing record. Uses trusted records so
    // an attacker can't plant a sig-invalid success to DoS legitimate deploys.
    const existingSucceeded = findMatchingSucceededDeploy({
      records: trustedRecords,
      environment,
      sha: target.sha,
      surfaces,
      taskSlug,
    });
    if (existingSucceeded && existingSucceeded.idempotencyKey === idempotencyKey) {
      return {
        ...existingSucceeded,
        environment,
        sha: target.sha,
        surfaces,
        workflowName: existingSucceeded.workflowName,
        taskSlug,
        message: [
          `Deploy already succeeded: ${environment}`,
          `Task: ${taskSlug}`,
          `SHA: ${target.sha}`,
          `Workflow run: ${existingSucceeded.workflowRunId ?? 'unknown'}`,
          'Idempotent short-circuit — no new dispatch.',
        ].join('\n'),
      };
    }

    // v0.5: prod deploys require typed-SHA confirmation so an AI can't one-char
    // approve production. Runs AFTER the staging + idempotency gates so a human
    // isn't asked to confirm a deploy that would be rejected or short-circuited.
    // The API path bypasses via PIPELANE_DEPLOY_PROD_API_CONFIRMED — it's already
    // consumed an HMAC confirm token. --override bypasses the release-readiness
    // gate but NOT this check: an AI can set --override too.
    if (environment === 'prod' && context.modeState.mode === 'release') {
      await requireProdConfirmation(target.sha);
    }

    const workflowName = environment === 'staging'
      ? (deployConfig.frontend.staging.deployWorkflow || context.config.deployWorkflowName)
      : (deployConfig.frontend.production.deployWorkflow || context.config.deployWorkflowName);

    const requestedAt = nowIso();
    const triggeredBy = resolveTriggeredBy();
    const dispatchStart = Date.now();

    const dispatchArgs = [
      'workflow',
      'run',
      workflowName,
      '-f',
      `environment=${environment === 'prod' ? 'production' : 'staging'}`,
      '-f',
      `sha=${target.sha}`,
      '-f',
      `surfaces=${surfaces.join(',')}`,
    ];
    if (environment === 'prod' && context.modeState.mode === 'build') {
      dispatchArgs.push('-f', 'bypass_staging_guard=true');
    }
    runGh(context.repoRoot, dispatchArgs);

    const run = findRecentRun(context.repoRoot, workflowName, target.sha, dispatchStart);

    let record: DeployRecord = {
      environment,
      sha: target.sha,
      surfaces,
      workflowName,
      requestedAt,
      taskSlug,
      status: 'requested',
      workflowRunId: run?.id,
      workflowRunUrl: run?.url,
      idempotencyKey,
      triggeredBy,
      smokeCoverageOverrideReason,
    };

    // Persist the 'requested' record immediately so an interrupted run
    // still leaves a breadcrumb in deploy-state.json. Sign it if signing
    // is enabled — otherwise an async deploy's initial record would be
    // invisible to verifyDeployRecord filters and rollback would miss
    // in-flight deploys on signed repos (Codex r6 P2).
    if (stateKey) {
      record = { ...record, signature: signDeployRecord(record, stateKey) };
    }
    persistRecord(context.commonDir, context.config, deployState.records, record);

    if (asyncRequested) {
      const shortSha = target.sha.slice(0, 7);
      const nextStage = environment === 'staging'
        ? `staging deploy requested at ${shortSha}, wait for verification`
        : `prod deploy requested at ${shortSha}, verify production`;
      setNextAction(context.commonDir, context.config, taskSlug, nextStage);
      return {
        ...record,
        taskSlug,
        message: [
          `Deploy dispatched (async): ${environment}`,
          `Task: ${taskSlug}`,
          `SHA: ${target.sha}`,
          `Surfaces: ${surfaces.join(', ')}`,
          record.smokeCoverageOverrideReason ? `Smoke coverage override: ${record.smokeCoverageOverrideReason}` : '',
          `Workflow: ${workflowName}`,
          run?.id ? `Workflow run: ${run.url ?? run.id}` : 'Workflow run: not yet resolvable',
          'Exit without watching per --async.',
        ].join('\n'),
      };
    }

  // Watch the run and stamp the final outcome.
  const watched = watchWorkflowRun(context.repoRoot, run?.id);
  const finishedAt = nowIso();
  const durationMs = Date.now() - dispatchStart;
  let status: DeployStatus = watched.ok ? 'succeeded' : 'failed';
  let failureReason = watched.ok ? undefined : (watched.reason || 'workflow run reported non-zero exit');

  let verification: DeployVerification | undefined;
  let verificationBySurface: Record<string, DeployVerification> | undefined;
  let runtimeObservation: DeployRecord['runtimeObservation'];
  if (watched.ok) {
    // v1.2: per-surface probing. A multi-surface deploy produces one probe
    // entry per surface so a frontend healthcheck can't credit edge or sql.
    // If any surface returns non-2xx (or lacks a probe URL entirely), the
    // whole deploy flips to failed.
    verificationBySurface = {};
    const perSurfaceFailures: string[] = [];
    const stubStatus = process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS;

    for (const surface of surfaces) {
      const surfaceUrl = resolveSurfaceHealthcheckUrl(deployConfig, environment, surface);
      if (!surfaceUrl && !stubStatus) {
        const empty: DeployVerification = { healthcheckUrl: '', probes: 0 };
        verificationBySurface[surface] = empty;
        perSurfaceFailures.push(`${surface}: no healthcheck URL configured`);
        continue;
      }
      const probe = await probeHealthcheck(surfaceUrl);
      verificationBySurface[surface] = probe;
      const code = probe.statusCode;
      if (typeof code !== 'number' || code < 200 || code >= 300) {
        perSurfaceFailures.push(
          probe.error
            ?? (code
              ? `${surface}: healthcheck returned HTTP ${code}`
              : `${surface}: healthcheck did not return a 2xx`),
        );
      }
    }

    // Aggregate block kept for compatibility with pre-v1.2 consumers of the
    // DeployRecord shape (dashboard, API readers). Picks frontend when
    // present, otherwise the first surface probed.
    verification = verificationBySurface['frontend']
      ?? verificationBySurface[surfaces[0]]
      ?? { healthcheckUrl: '', probes: 0 };

    if (perSurfaceFailures.length > 0) {
      status = 'failed';
      failureReason = perSurfaceFailures.join('; ');
    }

    if (surfaces.includes('frontend')) {
      runtimeObservation = toDeployRuntimeObservation(await observeFrontendRuntime({
        deployConfig,
        environment,
      }));
    }
  }

  const verifiedAt = status === 'succeeded' ? nowIso() : undefined;
  const configFingerprint = computeDeployConfigFingerprint(deployConfig, environment);

  record = {
    ...record,
    status,
    finishedAt,
    durationMs,
    verification,
    verificationBySurface,
    runtimeObservation,
    verifiedAt,
    configFingerprint,
    failureReason,
  };

  // v1.2: sign the record if the consumer has opted in via the state-key
  // env var. Unsigned records still ship; they're accepted by the gate only
  // when no key is configured. Reuses the `stateKey` resolved at the top of
  // this function.
  if (stateKey) {
    record = { ...record, signature: signDeployRecord(record, stateKey) };
  }

  const latestState = loadDeployState(context.commonDir, context.config);
  persistRecord(context.commonDir, context.config, latestState.records, record);

  if (status !== 'succeeded') {
    throw new Error([
      `Deploy did not verify: ${environment}`,
      failureReason ?? 'unknown failure',
      run?.url ? `Workflow: ${run.url}` : '',
    ].filter(Boolean).join('\n'));
  }

  const shortSha = target.sha.slice(0, 7);
  const nextStage = environment === 'staging'
    ? `staging verified at ${shortSha}, deploy to prod`
    : `prod verified at ${shortSha}, run pipelane:clean`;
  setNextAction(context.commonDir, context.config, taskSlug, nextStage);

    return {
      ...record,
      taskSlug,
      message: [
        `Deploy verified: ${environment}`,
        `Task: ${taskSlug}`,
        `SHA: ${target.sha}`,
        `Surfaces: ${surfaces.join(', ')}`,
        record.smokeCoverageOverrideReason ? `Smoke coverage override: ${record.smokeCoverageOverrideReason}` : '',
        `Workflow: ${workflowName}`,
        run?.url ? `Workflow run: ${run.url}` : '',
        verification?.healthcheckUrl
          ? `Healthcheck: ${verification.healthcheckUrl} → HTTP ${verification.statusCode} in ${verification.latencyMs}ms (${verification.probes} probe(s))`
          : 'Healthcheck: skipped (no URL configured)',
        environment === 'staging'
          ? 'Next: run pipelane:deploy -- prod.'
          : 'Next: run pipelane:clean.',
      ].filter(Boolean).join('\n'),
    };
  } finally {
    releaseSmokeEnvironmentLock(context.commonDir, environment);
  }
}

export async function handleDeploy(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const result = await dispatchDeploy(cwd, parsed);
  printResult(parsed.flags, result);
}

export function persistRecord(
  commonDir: string,
  config: WorkflowConfig,
  records: DeployRecord[],
  record: DeployRecord,
): void {
  const deduped = [
    ...records.filter((existing) => existing.idempotencyKey !== record.idempotencyKey
      || existing.status === 'failed'),
    record,
  ];
  saveDeployState(commonDir, config, { records: capDeployHistory(deduped) });
}

// v1.1 R10 fix: the simple `.slice(-100)` tail-cap used to silently
// evict the last-known-good DeployRecord on a long-lived repo, which
// breaks /rollback (findLastGoodDeploy sees an empty post-slice
// window). Preserve the most recent succeeded + verified record for
// every (environment, surfaces-key) as a pinned checkpoint beyond the
// recency cap. Keep the tail-100 window for everything else so state
// files still stay bounded.
const DEPLOY_HISTORY_TAIL = 100;
const DEPLOY_HISTORY_PINNED_PER_TARGET = 3;
export function capDeployHistory(records: DeployRecord[]): DeployRecord[] {
  if (records.length <= DEPLOY_HISTORY_TAIL) return records;
  const tail = records.slice(-DEPLOY_HISTORY_TAIL);
  const tailSet = new Set(tail);
  const isPinnedCandidate = (record: DeployRecord): boolean =>
    record.status === 'succeeded' && Boolean(record.verifiedAt) && Boolean(record.sha);
  const keyFor = (record: DeployRecord): string =>
    `${record.environment}:${[...(record.surfaces ?? [])].sort().join(',')}`;

  // Preserve a few verified checkpoints per (environment, surfaces), not just
  // one. That keeps rollback viable for more than a single step-back on a
  // busy long-lived repo where multiple good deploys can age out of the tail.
  // Only pin what the tail window does NOT already retain, so the total
  // history stays bounded while still carrying a small rollback ladder.
  const tailPinnedCounts = new Map<string, number>();
  for (const record of tail) {
    if (!isPinnedCandidate(record)) continue;
    const key = keyFor(record);
    tailPinnedCounts.set(key, (tailPinnedCounts.get(key) ?? 0) + 1);
  }

  const pinned = new Map<string, DeployRecord[]>();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (tailSet.has(record)) continue;
    if (!isPinnedCandidate(record)) continue;
    const key = keyFor(record);
    const needed = Math.max(0, DEPLOY_HISTORY_PINNED_PER_TARGET - (tailPinnedCounts.get(key) ?? 0));
    if (needed === 0) continue;
    const bucket = pinned.get(key) ?? [];
    if (bucket.length >= needed) continue;
    bucket.push(record);
    pinned.set(key, bucket);
  }

  const pinnedSet = new Set<DeployRecord>();
  for (const bucket of pinned.values()) {
    for (const record of bucket) pinnedSet.add(record);
  }
  if (pinnedSet.size === 0) return tail;
  // Preserve the original insertion order across pinned + tail so the
  // newest-last invariant that findLastGoodDeploy relies on still
  // holds. Pinned records come first (they're older than the tail).
  const pinnedOrdered = records.filter((record) => pinnedSet.has(record));
  return [...pinnedOrdered, ...tail];
}

export function resolveTriggeredBy(): string {
  return (
    process.env.PIPELANE_DEPLOY_TRIGGERED_BY
    || process.env.GITHUB_ACTOR
    || process.env.USER
    || 'pipelane'
  );
}

export function findRecentRun(
  repoRoot: string,
  workflowName: string,
  sha: string,
  dispatchedAfter: number,
  options: { strict?: boolean } = {},
): { id: string; url?: string } | null {
  const recentRunLimit = 50;
  const output = runCommandCapture('gh', [
    'run',
    'list',
    '--workflow',
    workflowName,
    '--limit',
    String(recentRunLimit),
    '--json',
    'databaseId,headSha,createdAt,url,status,conclusion',
  ], { cwd: repoRoot });
  if (!output.ok || !output.stdout) return null;
  try {
    const runs = JSON.parse(output.stdout) as Array<{
      databaseId: number;
      headSha: string;
      createdAt: string;
      url?: string;
    }>;
    // strict=true requires BOTH sha match AND recency-after-dispatch.
    // Rollback always re-dispatches a known sha, so the default
    // "match on sha OR recency" filter can attach to an older
    // successful run of the same sha (Codex r5 P1). Dropping the sha
    // clause entirely goes the other way — an unrelated run of the
    // same workflow dispatched in the same 5s window would match
    // (Codex r6 P1). Both clauses required keeps the match unique
    // to our dispatch. Deploy keeps the permissive default because
    // its idempotency short-circuit prevents same-sha re-dispatch.
    const minCreated = dispatchedAfter - 5_000;
    const candidate = runs
      .filter((run) => {
        if (options.strict) {
          return run.headSha === sha && Date.parse(run.createdAt) >= minCreated;
        }
        return run.headSha === sha || Date.parse(run.createdAt) >= minCreated;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!candidate) return null;
    return { id: String(candidate.databaseId), url: candidate.url };
  } catch {
    return null;
  }
}

export function watchWorkflowRun(
  repoRoot: string,
  runId: string | undefined,
): { ok: boolean; reason?: string } {
  // Test hook: stub wins over missing runId so tests don't need to mock
  // `gh run list` just to exercise the verify path.
  if (process.env.PIPELANE_DEPLOY_WATCH_STUB === 'succeeded') return { ok: true };
  if (process.env.PIPELANE_DEPLOY_WATCH_STUB === 'failed') return { ok: false, reason: 'stubbed failure' };

  if (!runId) {
    return { ok: false, reason: 'could not resolve workflow run id from gh run list' };
  }

  const result = runCommandCapture('gh', [
    'run',
    'watch',
    runId,
    '--exit-status',
  ], { cwd: repoRoot });
  return {
    ok: result.ok,
    reason: result.ok ? undefined : (result.stderr || result.stdout || undefined),
  };
}

export const PROD_CONFIRM_PREFIX_LENGTH = 4;

// v0.5: interactive typed-SHA prefix prompt. Callers must land here only
// when a human-in-the-loop confirmation is actually required — the API
// execute path sets PIPELANE_DEPLOY_PROD_API_CONFIRMED=1 to skip.
export async function requireProdConfirmation(sha: string): Promise<void> {
  if (process.env.PIPELANE_DEPLOY_PROD_API_CONFIRMED === '1') {
    // Consume and scrub so any post-confirmation subprocess this deploy
    // spawns (healthcheck scripts, retries, nested CLI re-entry) does not
    // inherit an open prod-confirm flag.
    delete process.env.PIPELANE_DEPLOY_PROD_API_CONFIRMED;
    return;
  }

  const expected = sha.slice(0, PROD_CONFIRM_PREFIX_LENGTH).toLowerCase();
  if (!expected || expected.length < PROD_CONFIRM_PREFIX_LENGTH) {
    throw new Error(`deploy prod blocked: resolved SHA "${sha}" is too short to derive a confirmation prefix.`);
  }

  // Test hook: lets the integration suite simulate the prompt without a TTY.
  // The stub value is the characters the operator would have typed. Gated to
  // NODE_ENV==='test' so a stray env var in a shared production shell cannot
  // defeat the gate. A fire still emits a loud stderr warning.
  const stub = process.env.PIPELANE_DEPLOY_PROD_CONFIRM_STUB;
  if (typeof stub === 'string') {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error([
        'deploy prod blocked: PIPELANE_DEPLOY_PROD_CONFIRM_STUB is set but NODE_ENV is not "test".',
        'This is a test hook. Unset PIPELANE_DEPLOY_PROD_CONFIRM_STUB in this shell and re-run.',
      ].join('\n'));
    }
    process.stderr.write(
      '[pipelane] WARNING: PIPELANE_DEPLOY_PROD_CONFIRM_STUB is active (NODE_ENV=test).\n',
    );
    if (!matchesShaPrefix(stub, expected)) {
      throw new Error([
        'deploy prod blocked: typed SHA prefix did not match.',
        `Expected the first ${PROD_CONFIRM_PREFIX_LENGTH} characters of ${sha}.`,
      ].join('\n'));
    }
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error([
      'deploy prod blocked: typed SHA prefix confirmation is required.',
      `Re-run from a TTY and type the first ${PROD_CONFIRM_PREFIX_LENGTH} characters of ${sha}`,
      'when prompted, or drive this deploy through `pipelane run api action deploy.prod`',
      'which uses the HMAC confirm-token flow.',
    ].join('\n'));
  }

  const typed = await promptForProdConfirmPrefix(sha, expected);
  if (!matchesShaPrefix(typed, expected)) {
    throw new Error([
      'deploy prod blocked: typed SHA prefix did not match.',
      `Expected the first ${PROD_CONFIRM_PREFIX_LENGTH} characters of ${sha}.`,
    ].join('\n'));
  }
}

// Compare against the first PROD_CONFIRM_PREFIX_LENGTH chars of the typed
// input so operators can paste the full SHA and the 4-char prefix check still
// succeeds. Also absorbs trailing whitespace, CR, and pasted newlines.
function matchesShaPrefix(typed: string, expected: string): boolean {
  const cleaned = typed.trim().toLowerCase();
  if (cleaned.length < expected.length) return false;
  return cleaned.slice(0, expected.length) === expected;
}

function promptForProdConfirmPrefix(fullSha: string, expected: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const prompt = [
    '',
    `You are about to deploy ${fullSha} to PRODUCTION.`,
    `To confirm, type the first ${expected.length} characters of that SHA:`,
    '> ',
  ].join('\n');
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function probeHealthcheck(url: string): Promise<DeployVerification> {
  if (process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS) {
    const statusCode = Number(process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS);
    return {
      healthcheckUrl: url,
      statusCode: Number.isFinite(statusCode) ? statusCode : 599,
      latencyMs: 0,
      probes: 2,
    };
  }

  const intervalMs = Number(process.env.PIPELANE_DEPLOY_HEALTHCHECK_INTERVAL_MS ?? '10000');
  let lastStatus = 0;
  let lastLatency = 0;
  let lastError: string | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const started = Date.now();
    try {
      const response = await fetch(url, { method: 'GET' });
      lastStatus = response.status;
      lastLatency = Date.now() - started;
      if (response.status < 200 || response.status >= 300) {
        lastError = `HTTP ${response.status}`;
      } else {
        lastError = undefined;
      }
    } catch (error) {
      lastStatus = 0;
      lastLatency = Date.now() - started;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    healthcheckUrl: url,
    statusCode: lastStatus,
    latencyMs: lastLatency,
    probes: 2,
    error: lastError,
  };
}
