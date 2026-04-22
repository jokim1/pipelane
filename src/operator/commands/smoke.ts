import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildLegacySmokeCheckResults,
  buildSmokePlanReport,
  computeLastKnownGoodSha,
  discoverCandidateSmokeTests,
  discoverSmokeTags,
  evaluateSmokeChecks,
  findQualifyingSmokeRun,
  formatSmokePlanReport,
  isSmokeSuccessStatus,
  lintSmokeSetup,
  pruneSmokeHistory,
  releaseSmokeEnvironmentLock,
  resolveSmokeArtifacts,
  resolveSmokeConfig,
  resolveSmokeTarget,
  scaffoldSmokeRegistry,
  summarizeSmokeRun,
  updateSmokeLatest,
  writeGeneratedSmokeSummary,
  acquireSmokeEnvironmentLock,
} from '../smoke-gate.ts';
import {
  loadSmokeRegistry,
  loadSmokeWaivers,
  listSmokeRunRecords,
  nowIso,
  printResult,
  resolveSmokeLogsDir,
  resolveWorkflowContext,
  runCommandCapture,
  saveSmokeRegistry,
  saveSmokeRunRecord,
  saveSmokeWaivers,
  type ParsedOperatorArgs,
  type SmokeArtifacts,
  type SmokeCheckResult,
  type SmokeCohortResult,
  type SmokeEnvironment,
  type SmokePreflightResult,
  type SmokeRunnerCheckResult,
  type SmokeRunnerResultContract,
  type SmokeRunRecord,
  type SmokeRunStatus,
  type SmokeWaiverRecord,
} from '../state.ts';

export async function handleSmoke(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const subcommand = parsed.positional[0] ?? '';
  if (subcommand === 'plan') {
    await handleSmokePlan(cwd, parsed);
    return;
  }
  if (subcommand === 'waiver') {
    handleSmokeWaiver(cwd, parsed);
    return;
  }
  if (subcommand === 'quarantine') {
    handleSmokeQuarantine(cwd, parsed, true);
    return;
  }
  if (subcommand === 'unquarantine') {
    handleSmokeQuarantine(cwd, parsed, false);
    return;
  }
  if (subcommand === 'staging' || subcommand === 'prod') {
    await handleSmokeRun(cwd, parsed, subcommand);
    return;
  }
  throw new Error('smoke requires one of: plan, staging, prod, waiver, quarantine, unquarantine.');
}

async function handleSmokePlan(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const discoveredTags = discoverSmokeTags(context.repoRoot);
  const candidateTests = discoverCandidateSmokeTests(context.repoRoot);
  let registry = loadSmokeRegistry(context.repoRoot, context.config);
  let createdRegistry = false;

  if (Object.keys(registry.checks).length === 0 && discoveredTags.length > 0) {
    registry = scaffoldSmokeRegistry({
      repoRoot: context.repoRoot,
      config: context.config,
      discoveredTags,
    });
    createdRegistry = true;
  }

  const waivers = loadSmokeWaivers(context.repoRoot, context.config).waivers;
  const summaryPath = writeGeneratedSmokeSummary(context.repoRoot, context.config, registry);
  const lint = lintSmokeSetup({
    repoRoot: context.repoRoot,
    config: context.config,
    registry,
    discoveredTags,
    waivers,
  });
  const report = buildSmokePlanReport({
    repoRoot: context.repoRoot,
    config: context.config,
    registry,
    discoveredTags,
    candidateTests,
    lint,
  });
  report.createdRegistry = createdRegistry;
  if (summaryPath) {
    report.summaryPath = path.relative(context.repoRoot, summaryPath) || summaryPath;
  }
  printResult(parsed.flags, {
    createdRegistry,
    smokeTags: report.smokeTags,
    candidateTests: report.candidateTests,
    findings: report.findings,
    message: formatSmokePlanReport(report),
  });
}

async function handleSmokeRun(
  cwd: string,
  parsed: ParsedOperatorArgs,
  environment: SmokeEnvironment,
): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const smokeConfig = resolveSmokeConfig(context.config);
  const environmentConfig = environment === 'staging' ? smokeConfig.staging : smokeConfig.prod;
  if (!environmentConfig) {
    throw new Error(`smoke ${environment} blocked: no smoke.${environment}.command configured in .pipelane.json.`);
  }

  const registry = loadSmokeRegistry(context.repoRoot, context.config);
  const environmentChecks = Object.entries(registry.checks).filter(([, entry]) =>
    entry.environments?.includes(environment) ?? true,
  );
  if (environmentChecks.length === 0) {
    throw new Error(`smoke ${environment} blocked: no smoke checks configured for ${environment}. Run pipelane:smoke -- plan.`);
  }
  if (
    environment === 'staging'
    && smokeConfig.requireStagingSmoke
    && !environmentConfig.cohorts.some((cohort) => cohort.blocking)
  ) {
    throw new Error('smoke staging blocked: requireStagingSmoke=true but no blocking staging cohorts are configured.');
  }
  if (
    environment === 'staging'
    && smokeConfig.requireStagingSmoke
    && !environmentChecks.some(([, entry]) => entry.blocking === true && entry.quarantine !== true)
  ) {
    throw new Error('smoke staging blocked: requireStagingSmoke=true but no non-quarantined blocking staging checks are configured.');
  }
  const waivers = listActiveWaivers({
    waivers: loadSmokeWaivers(context.repoRoot, context.config).waivers,
    environment,
    tags: environmentChecks.map(([tag]) => tag),
  });
  const requireCheckResults = shouldRequireCheckResults({
    environment,
    requireStagingSmoke: smokeConfig.requireStagingSmoke,
    environmentChecks,
    waivers,
  });

  const target = resolveSmokeTarget({
    repoRoot: context.repoRoot,
    commonDir: context.commonDir,
    config: context.config,
    environment,
  });
  const runId = `${target.environment}-${target.sha.slice(0, 7)}-${Date.now()}`;
  acquireSmokeEnvironmentLock({
    commonDir: context.commonDir,
    repoRoot: context.repoRoot,
    environment,
    operation: 'smoke',
    runId,
    sha: target.sha,
  });

  try {
    const startedAt = nowIso();
    const logsDir = resolveSmokeLogsDir(context.commonDir);
    mkdirSync(logsDir, { recursive: true });
    const baseEnv = {
      ...process.env,
      PIPELANE_SMOKE_ENV: environment,
      PIPELANE_SMOKE_BASE_URL: target.baseUrl,
      PIPELANE_SMOKE_SHA: target.sha,
      PIPELANE_SMOKE_RUN_ID: runId,
    };

    const preflight = runPreflightSteps({
      cwd: context.repoRoot,
      logsDir,
      runId,
      steps: environmentConfig.preflight,
      env: baseEnv,
    });
    const failedCriticalStep = preflight.find((step) => step.critical && step.status === 'failed');

    const cohortResults: SmokeCohortResult[] = failedCriticalStep
      ? []
      : environmentConfig.cohorts.map((cohort) => runSmokeCohort({
          cwd: context.repoRoot,
          logsDir,
          runId,
          cohort,
          command: environmentConfig.command,
          env: {
            ...baseEnv,
            PIPELANE_COHORT: cohort.name,
          },
          requireCheckResults,
        }));

    const refreshedTarget = resolveSmokeTarget({
      repoRoot: context.repoRoot,
      commonDir: context.commonDir,
      config: context.config,
      environment,
    });
    const drifted = refreshedTarget.sha !== target.sha;
    const records = listSmokeRunRecords(context.commonDir, context.config);
    const lastKnownGoodSha = computeLastKnownGoodSha(records, environment);
    const hasCheckResults = cohortResults.some((cohort) => Array.isArray(cohort.checks) && cohort.checks.length > 0);
    const rawBlockingFailure = cohortResults.some((cohort) => cohort.blocking && cohort.status === 'failed');

    let checks: SmokeCheckResult[];
    let contractErrors: string[] = [];
    if (hasCheckResults || requireCheckResults) {
      const evaluated = evaluateSmokeChecks({
        registry,
        environment,
        cohortResults,
        waivers,
        requireCheckResults,
      });
      checks = evaluated.checks;
      contractErrors = evaluated.contractErrors;
    } else {
      const fallbackStatus: SmokeRunStatus = failedCriticalStep || rawBlockingFailure || drifted ? 'failed' : 'passed';
      checks = buildLegacySmokeCheckResults({
        registry,
        environment,
        status: fallbackStatus,
      });
    }

    const blockingCheckFailure = checks.some((check) => check.effectiveBlocking && check.status === 'failed');
    const blockingRetryOnly = checks.some((check) => check.effectiveBlocking && check.status === 'passed_with_retries');
    const status: SmokeRunStatus = failedCriticalStep
      || drifted
      || contractErrors.length > 0
      || blockingCheckFailure
      || (!hasCheckResults && rawBlockingFailure)
      ? 'failed'
      : blockingRetryOnly
        ? 'passed_with_retries'
        : 'passed';
    const waiversApplied = checks
      .filter((check) => check.waived)
      .map((check) => waivers.find((waiver) => waiver.tag === check.tag && waiver.environment === environment))
      .filter((entry): entry is SmokeWaiverRecord => entry !== undefined);
    const record: SmokeRunRecord = {
      runId,
      environment,
      sha: target.sha,
      baseUrl: target.baseUrl,
      status,
      startedAt,
      finishedAt: nowIso(),
      preflight,
      cohortResults,
      checks,
      waiversApplied,
      lastKnownGoodSha,
      drifted,
      retryCount: checks.reduce((count, check) => count + Math.max(0, check.attempts.length - 1), 0),
    };

    saveSmokeRunRecord(context.commonDir, context.config, record);
    updateSmokeLatest({
      commonDir: context.commonDir,
      config: context.config,
      record,
    });
    pruneSmokeHistory(context.commonDir, context.config);
    writeGeneratedSmokeSummary(context.repoRoot, context.config, registry);

    if (!isSmokeSuccessStatus(status)) {
      throw new Error(summarizeSmokeRun(record));
    }

    printResult(parsed.flags, {
      runId,
      environment,
      sha: target.sha,
      status,
      message: summarizeSmokeRun(record),
    });
  } finally {
    releaseSmokeEnvironmentLock(context.commonDir, environment);
  }
}

function runPreflightSteps(options: {
  cwd: string;
  logsDir: string;
  runId: string;
  steps: Array<{ name: string; command: string; critical: boolean }>;
  env: NodeJS.ProcessEnv;
}): SmokePreflightResult[] {
  const results: SmokePreflightResult[] = [];
  let blocked = false;
  for (const step of options.steps) {
    const logPath = path.join(options.logsDir, `${options.runId}-${sanitize(step.name)}.log`);
    if (blocked) {
      writeFileSync(logPath, 'skipped: earlier critical preflight step failed\n', 'utf8');
      results.push({
        name: step.name,
        critical: step.critical,
        status: 'skipped',
        logPath,
      });
      continue;
    }
    const result = runCommandCapture('sh', ['-lc', step.command], {
      cwd: options.cwd,
      env: options.env,
    });
    writeFileSync(logPath, `${result.stdout}\n${result.stderr}`.trim() + '\n', 'utf8');
    const status = result.ok ? 'passed' : 'failed';
    results.push({
      name: step.name,
      critical: step.critical,
      status,
      logPath,
    });
    if (step.critical && !result.ok) {
      blocked = true;
    }
  }
  return results;
}

function runSmokeCohort(options: {
  cwd: string;
  logsDir: string;
  runId: string;
  cohort: { name: string; blocking: boolean };
  command: string;
  env: NodeJS.ProcessEnv;
  requireCheckResults: boolean;
}): SmokeCohortResult {
  const logPath = path.join(options.logsDir, `${options.runId}-${sanitize(options.cohort.name)}.log`);
  const resultsPath = path.join(options.logsDir, `${options.runId}-${sanitize(options.cohort.name)}.results.json`);
  const result = runCommandCapture('sh', ['-lc', options.command], {
    cwd: options.cwd,
    env: {
      ...options.env,
      PIPELANE_SMOKE_RESULTS_PATH: resultsPath,
    },
  });
  writeFileSync(logPath, `${result.stdout}\n${result.stderr}`.trim() + '\n', 'utf8');
  const runnerResults = loadRunnerResultContract(resultsPath, options.cwd);
  const artifacts = chooseCohortArtifacts({
    cwd: options.cwd,
    logPath,
    checks: runnerResults.checks,
  });
  return {
    name: options.cohort.name,
    blocking: options.cohort.blocking,
    status: determineCohortStatus({
      exitCode: result.exitCode,
      checks: runnerResults.checks,
    }),
    exitCode: result.exitCode,
    artifacts,
    checks: runnerResults.checks,
    resultsPath,
    contractError: runnerResults.error ?? (options.requireCheckResults && !runnerResults.checks ? 'runner did not emit check-level results' : undefined),
  };
}

function listActiveWaivers(options: {
  waivers: SmokeWaiverRecord[];
  environment: SmokeEnvironment;
  tags?: string[];
}): SmokeWaiverRecord[] {
  const activeTags = options.tags ? new Set(options.tags) : null;
  return options.waivers.filter((waiver) =>
    waiver.environment === options.environment
    && (activeTags ? activeTags.has(waiver.tag) : true)
    && Date.parse(waiver.expiresAt) >= Date.now(),
  );
}

function shouldRequireCheckResults(options: {
  environment: SmokeEnvironment;
  requireStagingSmoke: boolean;
  environmentChecks: Array<[string, { blocking?: boolean }]>;
  waivers: SmokeWaiverRecord[];
}): boolean {
  return (options.environment === 'staging' && options.requireStagingSmoke)
    || options.environmentChecks.some(([, entry]) => entry.blocking === true)
    || options.waivers.length > 0;
}

function determineCohortStatus(options: {
  exitCode: number;
  checks: SmokeRunnerCheckResult[] | null;
}): SmokeRunStatus {
  if (options.checks && options.checks.some((check) => check.status === 'failed')) {
    return 'failed';
  }
  if (options.checks && options.checks.some((check) => check.status === 'passed_with_retries')) {
    return options.exitCode === 0 ? 'passed_with_retries' : 'failed';
  }
  return options.exitCode === 0 ? 'passed' : 'failed';
}

function chooseCohortArtifacts(options: {
  cwd: string;
  logPath: string;
  checks: SmokeRunnerCheckResult[] | null;
}): SmokeArtifacts {
  const contractArtifacts = options.checks?.find((check) => check.status === 'failed' && check.artifacts)?.artifacts
    ?? options.checks?.find((check) => check.artifacts)?.artifacts;
  if (contractArtifacts) {
    return {
      ...contractArtifacts,
      logPath: options.logPath,
    };
  }
  return {
    ...resolveSmokeArtifacts(options.cwd),
    logPath: options.logPath,
  };
}

function loadRunnerResultContract(resultsPath: string, cwd: string): {
  checks: SmokeRunnerCheckResult[] | null;
  error?: string;
} {
  if (!existsSync(resultsPath)) {
    return { checks: null };
  }

  let parsed: SmokeRunnerResultContract;
  try {
    parsed = JSON.parse(readFileSync(resultsPath, 'utf8')) as SmokeRunnerResultContract;
  } catch (error) {
    return {
      checks: null,
      error: `invalid smoke results JSON at ${resultsPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.checks)) {
    return {
      checks: null,
      error: `invalid smoke results contract at ${resultsPath}: expected {"checks":[...]}`,
    };
  }

  const checks: SmokeRunnerCheckResult[] = [];
  for (const entry of parsed.checks) {
    const normalized = normalizeRunnerCheckResult(entry, cwd);
    if (!normalized) {
      return {
        checks: null,
        error: `invalid smoke check result in ${resultsPath}`,
      };
    }
    checks.push(normalized);
  }

  return { checks };
}

function normalizeRunnerCheckResult(value: unknown, cwd: string): SmokeRunnerCheckResult | null {
  const entry = value as Partial<SmokeRunnerCheckResult> | null;
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (typeof entry.tag !== 'string' || entry.tag.trim().length === 0) {
    return null;
  }
  if (!isValidSmokeStatus(entry.status)) {
    return null;
  }
  const attempts = Array.isArray(entry.attempts)
    ? entry.attempts
        .filter((attempt): attempt is { attempt: number; status: SmokeRunStatus } =>
          Boolean(attempt)
          && typeof attempt.attempt === 'number'
          && Number.isFinite(attempt.attempt)
          && attempt.attempt > 0
          && isValidSmokeStatus(attempt.status),
        )
        .map((attempt) => ({
          attempt: Math.trunc(attempt.attempt),
          status: attempt.status,
        }))
    : undefined;
  const artifacts = normalizeSmokeArtifacts(entry.artifacts, cwd);
  return {
    tag: entry.tag.trim(),
    status: entry.status,
    attempts: attempts && attempts.length > 0 ? attempts : undefined,
    artifacts,
  };
}

function normalizeSmokeArtifacts(value: unknown, cwd: string): SmokeArtifacts | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const entry = value as Partial<SmokeArtifacts>;
  const normalizePathValue = (candidate: string | undefined) =>
    typeof candidate === 'string' && candidate.trim().length > 0
      ? path.resolve(cwd, candidate.trim())
      : undefined;
  const normalized = {
    firstFailureTrace: normalizePathValue(entry.firstFailureTrace),
    htmlReport: normalizePathValue(entry.htmlReport),
    screenshotDir: normalizePathValue(entry.screenshotDir),
    logPath: normalizePathValue(entry.logPath),
  };
  return Object.values(normalized).some((candidate) => candidate !== undefined) ? normalized : undefined;
}

function isValidSmokeStatus(value: unknown): value is SmokeRunStatus {
  return value === 'passed' || value === 'failed' || value === 'passed_with_retries';
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step';
}

function handleSmokeWaiver(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const action = parsed.positional[1] ?? '';
  const tag = parsed.positional[2] ?? '';
  const environment = parsed.positional[3] as SmokeEnvironment | '';
  if ((action !== 'create' && action !== 'extend') || !tag || (environment !== 'staging' && environment !== 'prod')) {
    throw new Error('Usage: pipelane:smoke waiver <create|extend> <@smoke-tag> <staging|prod> --reason "..."');
  }
  if (!parsed.flags.reason.trim()) {
    throw new Error('smoke waiver requires --reason.');
  }
  const registry = loadSmokeRegistry(context.repoRoot, context.config);
  requireSmokeRegistryEntry({
    registry,
    tag,
    environment,
    action: 'waiver',
  });
  const waivers = loadSmokeWaivers(context.repoRoot, context.config);
  const existing = waivers.waivers.find((waiver) => waiver.tag === tag && waiver.environment === environment);
  const now = Date.now();
  if (action === 'extend' && !existing) {
    throw new Error(`No existing smoke waiver found for ${tag}:${environment}.`);
  }
  const next = {
    tag,
    environment,
    reason: parsed.flags.reason.trim(),
    createdAt: existing?.createdAt ?? nowIso(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    extensions: action === 'extend' ? (existing?.extensions ?? 0) + 1 : 0,
  };
  waivers.waivers = waivers.waivers.filter((waiver) => !(waiver.tag === tag && waiver.environment === environment));
  waivers.waivers.push(next);
  saveSmokeWaivers(context.repoRoot, context.config, waivers);
  printResult(parsed.flags, {
    waiver: next,
    message: `Smoke waiver ${action}d for ${tag} (${environment}) until ${next.expiresAt}.`,
  });
}

function handleSmokeQuarantine(cwd: string, parsed: ParsedOperatorArgs, quarantine: boolean): void {
  const context = resolveWorkflowContext(cwd);
  const tag = parsed.positional[1] ?? '';
  if (!tag) {
    throw new Error(`Usage: pipelane:smoke ${quarantine ? 'quarantine' : 'unquarantine'} <@smoke-tag> [--reason "..."]`);
  }
  const registry = loadSmokeRegistry(context.repoRoot, context.config);
  const entry = requireSmokeRegistryEntry({ registry, tag, action: 'quarantine' });
  registry.checks[tag] = {
    ...entry,
    quarantine,
    reason: quarantine ? parsed.flags.reason.trim() : '',
  };
  saveSmokeRegistry(context.repoRoot, context.config, registry);
  printResult(parsed.flags, {
    tag,
    quarantine,
    message: quarantine
      ? `Quarantined ${tag}.`
      : `Unquarantined ${tag}.`,
  });
}

function requireSmokeRegistryEntry(options: {
  registry: ReturnType<typeof loadSmokeRegistry>;
  tag: string;
  environment?: SmokeEnvironment;
  action: 'waiver' | 'quarantine';
}) {
  const entry = options.registry.checks[options.tag];
  if (!entry) {
    throw new Error(`No smoke registry entry found for ${options.tag}. Run pipelane:smoke -- plan first.`);
  }
  if (
    options.environment
    && Array.isArray(entry.environments)
    && !entry.environments.includes(options.environment)
  ) {
    throw new Error(`${options.tag} is not configured for ${options.environment}. Update .pipelane/smoke-checks.json before using ${options.action}.`);
  }
  return entry;
}

export { findQualifyingSmokeRun };
