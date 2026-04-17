import readline from 'node:readline';

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
  loadPrRecord,
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
  resolveCommandSurfaces,
  resolveDeployTargetForTask,
  resolveHealthcheckUrl,
  resolveSurfaceHealthcheckUrl,
} from './helpers.ts';

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

export async function handleDeploy(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const environment = normalizeDeployEnvironment(parsed.positional[0] ?? '');
  const explicitSurfaces = [...parsed.flags.surfaces, ...parsed.positional.slice(1)];
  const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
  const surfaces = resolveCommandSurfaces(context, explicitSurfaces, lock.surfaces);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const prRecord = loadPrRecord(context.commonDir, context.config, taskSlug);
  const target = resolveDeployTargetForTask({
    repoRoot: context.repoRoot,
    baseBranch: context.config.baseBranch,
    explicitSha: parsed.flags.sha,
    prRecord,
    mode: context.modeState.mode,
  });

  const deployState = loadDeployState(context.commonDir, context.config);

  if (context.modeState.mode === 'release') {
    // v1.2 readiness is now observed, not asserted. Callers to prod are also
    // allowed to promote the same SHA they just verified in staging, so
    // release-readiness for prod deploys counts the current deployState.
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      deployRecords: deployState.records,
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
      records: deployState.records,
      environment: 'staging',
      sha: target.sha,
      surfaces,
      taskSlug,
    });
    if (!staging) {
      throw new Error([
        `deploy prod blocked: no succeeded staging deploy found for SHA ${target.sha.slice(0, 7)}`,
        `with surfaces ${surfaces.join(',')} and task ${taskSlug}.`,
        'Run workflow:deploy -- staging first, wait for it to report status=succeeded.',
      ].join('\n'));
    }
    // v1.2: tighten the prod gate with the same per-surface + fingerprint +
    // signature invariants as the staging-readiness gate.
    const disqualification = disqualifyStagingRecord({
      record: staging,
      surfaces,
      expectedFingerprint: computeDeployConfigFingerprint(deployConfig),
      stateKey: resolveDeployStateKey(),
    });
    if (disqualification) {
      throw new Error([
        `deploy prod blocked: matching staging record is not promotable — ${disqualification}.`,
        'Re-run workflow:deploy -- staging and let it verify before promoting.',
      ].join('\n'));
    }
  }

  const idempotencyKey = makeIdempotencyKey({
    environment,
    sha: target.sha,
    surfaces,
    taskSlug,
  });

  // Short-circuit: if we already have a succeeded deploy with this key,
  // don't re-dispatch. Return the existing record.
  const existingSucceeded = findMatchingSucceededDeploy({
    records: deployState.records,
    environment,
    sha: target.sha,
    surfaces,
    taskSlug,
  });
  if (existingSucceeded && existingSucceeded.idempotencyKey === idempotencyKey) {
    printResult(parsed.flags, {
      ...existingSucceeded,
      message: [
        `Deploy already succeeded: ${environment}`,
        `Task: ${taskSlug}`,
        `SHA: ${target.sha}`,
        `Workflow run: ${existingSucceeded.workflowRunId ?? 'unknown'}`,
        'Idempotent short-circuit — no new dispatch.',
      ].join('\n'),
    });
    return;
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

  runGh(context.repoRoot, [
    'workflow',
    'run',
    workflowName,
    '-f',
    `environment=${environment === 'prod' ? 'production' : 'staging'}`,
    '-f',
    `sha=${target.sha}`,
    '-f',
    `surfaces=${surfaces.join(',')}`,
  ]);

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
  };

  // Persist the 'requested' record immediately so an interrupted run
  // still leaves a breadcrumb in deploy-state.json.
  persistRecord(context.commonDir, context.config, deployState.records, record);

  if (parsed.flags.async) {
    printResult(parsed.flags, {
      ...record,
      message: [
        `Deploy dispatched (async): ${environment}`,
        `Task: ${taskSlug}`,
        `SHA: ${target.sha}`,
        `Surfaces: ${surfaces.join(', ')}`,
        `Workflow: ${workflowName}`,
        run?.id ? `Workflow run: ${run.url ?? run.id}` : 'Workflow run: not yet resolvable',
        'Exit without watching per --async.',
      ].join('\n'),
    });
    return;
  }

  // Watch the run and stamp the final outcome.
  const watched = watchWorkflowRun(context.repoRoot, run?.id);
  const finishedAt = nowIso();
  const durationMs = Date.now() - dispatchStart;
  let status: DeployStatus = watched.ok ? 'succeeded' : 'failed';
  let failureReason = watched.ok ? undefined : (watched.reason || 'workflow run reported non-zero exit');

  let verification: DeployVerification | undefined;
  let verificationBySurface: Record<string, DeployVerification> | undefined;
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

    // Aggregate block kept for back-compat with pre-v1.2 consumers of the
    // DeployRecord shape (dashboard, Rocketboard). Picks frontend when
    // present, otherwise the first surface probed.
    verification = verificationBySurface['frontend']
      ?? verificationBySurface[surfaces[0]]
      ?? { healthcheckUrl: '', probes: 0 };

    if (perSurfaceFailures.length > 0) {
      status = 'failed';
      failureReason = perSurfaceFailures.join('; ');
    }
  }

  const verifiedAt = status === 'succeeded' ? nowIso() : undefined;
  const configFingerprint = computeDeployConfigFingerprint(deployConfig);

  record = {
    ...record,
    status,
    finishedAt,
    durationMs,
    verification,
    verificationBySurface,
    verifiedAt,
    configFingerprint,
    failureReason,
  };

  // v1.2: sign the record if the consumer has opted in via the state-key
  // env var. Unsigned records still ship; they're accepted by the gate only
  // when no key is configured.
  const stateKey = resolveDeployStateKey();
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

  printResult(parsed.flags, {
    ...record,
    message: [
      `Deploy verified: ${environment}`,
      `Task: ${taskSlug}`,
      `SHA: ${target.sha}`,
      `Surfaces: ${surfaces.join(', ')}`,
      `Workflow: ${workflowName}`,
      run?.url ? `Workflow run: ${run.url}` : '',
      verification?.healthcheckUrl
        ? `Healthcheck: ${verification.healthcheckUrl} → HTTP ${verification.statusCode} in ${verification.latencyMs}ms (${verification.probes} probe(s))`
        : 'Healthcheck: skipped (no URL configured)',
      environment === 'staging'
        ? 'Next: run workflow:deploy -- prod.'
        : 'Next: run workflow:clean.',
    ].filter(Boolean).join('\n'),
  });
}

function persistRecord(
  commonDir: string,
  config: WorkflowConfig,
  records: DeployRecord[],
  record: DeployRecord,
): void {
  const next = [
    ...records.filter((existing) => existing.idempotencyKey !== record.idempotencyKey
      || existing.status === 'failed'),
    record,
  ].slice(-100);
  saveDeployState(commonDir, config, { records: next });
}

function resolveTriggeredBy(): string {
  return (
    process.env.PIPELANE_DEPLOY_TRIGGERED_BY
    || process.env.GITHUB_ACTOR
    || process.env.USER
    || 'pipelane'
  );
}

function findRecentRun(
  repoRoot: string,
  workflowName: string,
  sha: string,
  dispatchedAfter: number,
): { id: string; url?: string } | null {
  const output = runCommandCapture('gh', [
    'run',
    'list',
    '--workflow',
    workflowName,
    '--limit',
    '10',
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
    const candidate = runs
      .filter((run) => run.headSha === sha || Date.parse(run.createdAt) >= dispatchedAfter - 5_000)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!candidate) return null;
    return { id: String(candidate.databaseId), url: candidate.url };
  } catch {
    return null;
  }
}

function watchWorkflowRun(
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

async function probeHealthcheck(url: string): Promise<DeployVerification> {
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
