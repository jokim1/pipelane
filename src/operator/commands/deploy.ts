import readline from 'node:readline';

import { buildReleaseCheckMessage, emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig, normalizeDeployEnvironment } from '../release-gate.ts';
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

  if (context.modeState.mode === 'release') {
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      surfaces,
    });
    if (!readiness.ready && !context.modeState.override) {
      throw new Error(buildReleaseCheckMessage(readiness, surfaces));
    }
  }

  const deployState = loadDeployState(context.commonDir, context.config);

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
    if (staging.verification && typeof staging.verification.statusCode === 'number' && staging.verification.statusCode >= 300) {
      throw new Error([
        `deploy prod blocked: the matching staging deploy verified as HTTP ${staging.verification.statusCode}.`,
        'Staging needs a clean 2xx healthcheck before prod promotion.',
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
  if (watched.ok) {
    const healthcheckUrl = resolveHealthcheckUrl(deployConfig, environment);
    const stubStatus = process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS;
    if (healthcheckUrl || stubStatus) {
      verification = await probeHealthcheck(healthcheckUrl);
      if (typeof verification.statusCode !== 'number' || verification.statusCode < 200 || verification.statusCode >= 300) {
        status = 'failed';
        failureReason = verification.error
          ?? (verification.statusCode
            ? `healthcheck returned HTTP ${verification.statusCode}`
            : 'healthcheck did not return a 2xx');
      }
    } else {
      verification = { healthcheckUrl: '', probes: 0 };
    }
  }

  record = {
    ...record,
    status,
    finishedAt,
    durationMs,
    verification,
    verifiedAt: status === 'succeeded' ? nowIso() : undefined,
    failureReason,
  };

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
  if (process.env.PIPELANE_DEPLOY_PROD_API_CONFIRMED === '1') return;

  const expected = sha.slice(0, PROD_CONFIRM_PREFIX_LENGTH).toLowerCase();
  if (!expected || expected.length < PROD_CONFIRM_PREFIX_LENGTH) {
    throw new Error(`deploy prod blocked: resolved SHA "${sha}" is too short to derive a confirmation prefix.`);
  }

  // Test hook: lets the integration suite simulate the prompt without a TTY.
  // The stub value is the characters the operator would have typed.
  const stub = process.env.PIPELANE_DEPLOY_PROD_CONFIRM_STUB;
  if (typeof stub === 'string') {
    if (stub.trim().toLowerCase() !== expected) {
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
  if (typed.trim().toLowerCase() !== expected) {
    throw new Error([
      'deploy prod blocked: typed SHA prefix did not match.',
      `Expected the first ${PROD_CONFIRM_PREFIX_LENGTH} characters of ${sha}.`,
    ].join('\n'));
  }
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
