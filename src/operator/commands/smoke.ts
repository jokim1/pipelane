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
  isSmokeWaiverUsable,
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
  formatWorkflowCommand,
  loadSmokeRegistry,
  loadSmokeWaivers,
  listSmokeRunRecords,
  nowIso,
  patchReadableWorkflowConfig,
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
  if (subcommand === 'setup') {
    await handleSmokeSetup(cwd, parsed);
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
  throw new Error('smoke requires one of: plan, setup, staging, prod, waiver, quarantine, unquarantine.');
}

// Pure helper: compute the plan result without printing. Shared by
// `handleSmokePlan` (prints) and `handleSmokeSetup` (prints its own
// envelope once, avoiding double JSON output on --json).
interface SmokePlanResult {
  createdRegistry: boolean;
  smokeTags: ReturnType<typeof buildSmokePlanReport>['smokeTags'];
  candidateTests: ReturnType<typeof buildSmokePlanReport>['candidateTests'];
  findings: ReturnType<typeof buildSmokePlanReport>['findings'];
  summaryPath?: string;
  message: string;
}

function buildSmokePlanResult(context: ReturnType<typeof resolveWorkflowContext>): SmokePlanResult {
  const discoveredTags = discoverSmokeTags(context.repoRoot);
  const candidateTests = discoverCandidateSmokeTests(context.repoRoot);
  let registry = loadSmokeRegistry(context.repoRoot, context.config);
  let createdRegistry = false;

  if (Object.keys(registry.checks).length === 0) {
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
  return {
    createdRegistry,
    smokeTags: report.smokeTags,
    candidateTests: report.candidateTests,
    findings: report.findings,
    summaryPath: report.summaryPath,
    message: formatSmokePlanReport(report),
  };
}

async function handleSmokePlan(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const planResult = buildSmokePlanResult(context);
  printResult(parsed.flags, {
    createdRegistry: planResult.createdRegistry,
    smokeTags: planResult.smokeTags,
    candidateTests: planResult.candidateTests,
    findings: planResult.findings,
    message: planResult.message,
  });
}

// ---------------------------------------------------------------------------
// /smoke setup
// ---------------------------------------------------------------------------
//
// Two-mode contract:
//   auto-wired: exactly one strong candidate OR explicit --staging-command.
//               Setup writes the config, scaffolds the registry, prints the
//               configured summary.
//   needs input: anything else — multiple strong candidates, only weak
//                candidates, no candidates. Setup writes nothing and prints
//                exactly what flag the operator must supply.
//
// Misconfigured:
//   --require-staging-smoke=true with no resolved staging command → throw
//   (exit 1). Setup refuses to silently promote an unreachable release gate.

type CandidateStrength = 'strong' | 'medium' | 'weak';

interface SmokeSetupCandidate {
  name: string;       // package-script name
  command: string;    // the shell command the script runs
  strength: CandidateStrength;
  reason: string;     // why we scored it this strength (for user-facing output)
}

// Score a single package.json script against the /smoke setup heuristic
// table. Returns null if the script is not smoke-adjacent at all.
function scorePackageScript(scriptName: string, scriptCommand: string): SmokeSetupCandidate | null {
  const name = scriptName.toLowerCase();
  const command = scriptCommand.toLowerCase();
  const invokesBrowserE2e = /\b(playwright|cypress|webdriver|puppeteer)\b/.test(command);
  const hasSmokeFilter = /(@smoke\b|--grep[^\n]*smoke)/i.test(scriptCommand);
  const looksLikeCliOnly = (() => {
    // "smoke": "node ./src/cli.ts --help" — the pipelane repo itself — is
    // the canonical weak case. Treat scripts that only run node/CLI help,
    // build, lint, or type-check as weak.
    const weakPatterns = [
      /\bnode\b.*(--help|-h)\b/,
      /\b(npm run )?build\b/,
      /\beslint\b/,
      /\btypecheck\b/,
      /\btsc\b/,
      /\bprettier\b/,
    ];
    return weakPatterns.some((pattern) => pattern.test(command))
      && !invokesBrowserE2e
      && !hasSmokeFilter;
  })();

  if (name.includes('smoke') && invokesBrowserE2e) {
    return {
      name: scriptName,
      command: scriptCommand,
      strength: 'strong',
      reason: 'script name contains "smoke" and runs a browser e2e framework',
    };
  }
  if (name.includes('e2e') && name.includes('smoke')) {
    return {
      name: scriptName,
      command: scriptCommand,
      strength: 'strong',
      reason: 'script name contains both "e2e" and "smoke"',
    };
  }
  if (hasSmokeFilter) {
    return {
      name: scriptName,
      command: scriptCommand,
      strength: 'strong',
      reason: 'command filters to smoke tests via @smoke tag or --grep',
    };
  }
  if (name === 'smoke' && looksLikeCliOnly) {
    return {
      name: scriptName,
      command: scriptCommand,
      strength: 'weak',
      reason: 'script named "smoke" but runs only CLI help / build / lint — not a release smoke test',
    };
  }
  if (name.startsWith('test:e2e') && !name.includes('smoke') && !command.includes('smoke')) {
    return {
      name: scriptName,
      command: scriptCommand,
      strength: 'medium',
      reason: 'runs e2e suite but does not filter to smoke checks',
    };
  }
  return null;
}

interface ScoredCandidates {
  strong: SmokeSetupCandidate[];
  medium: SmokeSetupCandidate[];
  weak: SmokeSetupCandidate[];
}

// Read package.json from repoRoot (if present) and score every script. A
// repo without package.json produces empty arrays; handleSmokeSetup treats
// that case as "no-candidate" and falls through to explicit-flag or
// needs-input.
function detectSmokeCandidates(repoRoot: string): ScoredCandidates {
  const packagePath = path.join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) {
    return { strong: [], medium: [], weak: [] };
  }
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, unknown> };
  } catch {
    return { strong: [], medium: [], weak: [] };
  }
  const scripts = typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : {};
  const result: ScoredCandidates = { strong: [], medium: [], weak: [] };
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    const candidate = scorePackageScript(name, command);
    if (!candidate) continue;
    result[candidate.strength].push(candidate);
  }
  return result;
}

type SmokeSetupMode = 'configured' | 'already configured' | 'needs input';

interface SmokeSetupOutcome {
  mode: SmokeSetupMode;
  repoSignal: string;
  stagingCommand: string | null;
  prodCommand: string | null;
  coverageRegistry: 'created' | 'updated' | 'unchanged';
  releaseGate: 'required' | 'optional' | 'misconfigured';
  nextAction: string;
  warnings: string[];
  candidates: ScoredCandidates;
  configPath: string;
  configPathIsLegacy: boolean;
  planMessage: string;
}

async function handleSmokeSetup(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const smokeBefore = context.config.smoke;
  const stagingConfiguredBefore = typeof smokeBefore?.staging?.command === 'string' && smokeBefore.staging.command.trim().length > 0;
  const prodConfiguredBefore = typeof smokeBefore?.prod?.command === 'string' && smokeBefore.prod.command.trim().length > 0;

  const explicitStagingCommand = parsed.flags.stagingCommand.trim();
  const explicitProdCommand = parsed.flags.prodCommand.trim();
  const explicitRequireStaging = parsed.flags.requireStagingSmoke;
  const explicitGeneratedSummary = parsed.flags.generatedSummaryPath.trim();
  const explicitCriticalCoverage = parsed.flags.criticalPathCoverage;
  const explicitCriticalPaths = parsed.flags.criticalPaths;

  const candidates = detectSmokeCandidates(context.repoRoot);
  const warnings: string[] = [];

  // Decide the staging command. Explicit flag wins. Otherwise auto-wire only
  // on exactly one strong candidate. Multiple strong / only weak / none →
  // needs input.
  let resolvedStagingCommand = stagingConfiguredBefore ? smokeBefore!.staging!.command : '';
  let stagingAutoSource: 'flag' | 'candidate' | 'preserved' | 'none' = stagingConfiguredBefore ? 'preserved' : 'none';
  if (explicitStagingCommand) {
    resolvedStagingCommand = explicitStagingCommand;
    stagingAutoSource = 'flag';
  } else if (!stagingConfiguredBefore && candidates.strong.length === 1) {
    resolvedStagingCommand = `npm run ${candidates.strong[0].name}`;
    stagingAutoSource = 'candidate';
  }

  // Resolve needs-input cases. Precedence: explicit flag > existing config >
  // auto-wire from strong candidate. If none of those produce a command,
  // explain exactly what input is missing.
  const needsInput = !resolvedStagingCommand;

  if (needsInput) {
    // We write nothing. Build a needs-input outcome with repo signal + exact
    // next action.
    const repoSignal = describeRepoSignal(candidates);
    const nextAction = buildNeedsInputNextAction(candidates, context.config);
    const outcome: SmokeSetupOutcome = {
      mode: 'needs input',
      repoSignal,
      stagingCommand: null,
      prodCommand: explicitProdCommand || (prodConfiguredBefore ? smokeBefore!.prod!.command : null),
      coverageRegistry: 'unchanged',
      releaseGate: explicitRequireStaging === 'true' ? 'misconfigured' : (smokeBefore?.requireStagingSmoke ? 'misconfigured' : 'optional'),
      nextAction,
      warnings,
      candidates,
      configPath: '',
      configPathIsLegacy: false,
      planMessage: '',
    };
    if (outcome.releaseGate === 'misconfigured') {
      // require-staging-smoke=true + no command resolved is a release-gate
      // misconfig — throw (exit 1) per the plan's release gate spec.
      throw new Error(
        `smoke setup blocked: --require-staging-smoke=true but no staging command is available. ` +
        `Pass --staging-command="<command>" or pick one from the candidates above.`,
      );
    }
    emitSetupOutcome(parsed, outcome);
    return;
  }

  // Auto-wired path. Deep-merge the smoke subtree, write the config, then
  // rebuild the smoke plan so the registry scaffolds.
  const resolvedProdCommand = explicitProdCommand || (prodConfiguredBefore ? smokeBefore!.prod!.command : '');
  const resolvedRequireStaging = (() => {
    if (explicitRequireStaging === 'true') return true;
    if (explicitRequireStaging === 'false') return false;
    return smokeBefore?.requireStagingSmoke === true;
  })();

  // Release-gate misconfig check BEFORE writing — require-staging-smoke=true
  // without a staging command should never be persisted.
  if (resolvedRequireStaging && !resolvedStagingCommand) {
    throw new Error('smoke setup blocked: --require-staging-smoke=true but no staging command is available. Pass --staging-command="<command>".');
  }

  const { configPath, isLegacy } = patchReadableWorkflowConfig(context.repoRoot, (raw) => {
    const existingSmoke = (raw.smoke && typeof raw.smoke === 'object' && !Array.isArray(raw.smoke)
      ? raw.smoke as Record<string, unknown>
      : {});
    const existingStaging = (existingSmoke.staging && typeof existingSmoke.staging === 'object' && !Array.isArray(existingSmoke.staging)
      ? existingSmoke.staging as Record<string, unknown>
      : {});
    const existingProd = (existingSmoke.prod && typeof existingSmoke.prod === 'object' && !Array.isArray(existingSmoke.prod)
      ? existingSmoke.prod as Record<string, unknown>
      : {});
    const nextStaging = { ...existingStaging, command: resolvedStagingCommand };
    const nextProd = resolvedProdCommand
      ? { ...existingProd, command: resolvedProdCommand }
      : (Object.keys(existingProd).length > 0 ? existingProd : undefined);
    const mergedSmoke: Record<string, unknown> = {
      ...existingSmoke,
      staging: nextStaging,
    };
    if (nextProd) {
      mergedSmoke.prod = nextProd;
    } else if ('prod' in mergedSmoke) {
      delete mergedSmoke.prod;
    }
    if (explicitRequireStaging === 'true') {
      mergedSmoke.requireStagingSmoke = true;
    } else if (explicitRequireStaging === 'false') {
      mergedSmoke.requireStagingSmoke = false;
    }
    if (explicitGeneratedSummary) {
      mergedSmoke.generatedSummaryPath = explicitGeneratedSummary;
    }
    if (explicitCriticalCoverage) {
      mergedSmoke.criticalPathCoverage = explicitCriticalCoverage;
    }
    if (explicitCriticalPaths.length > 0) {
      mergedSmoke.criticalPaths = explicitCriticalPaths;
    }
    return { ...raw, smoke: mergedSmoke };
  });

  // Reload context so buildSmokePlanResult sees the newly-written config.
  const refreshedContext = resolveWorkflowContext(cwd);
  const planResult = buildSmokePlanResult(refreshedContext);

  const sameAsBefore =
    stagingConfiguredBefore
    && smokeBefore!.staging!.command === resolvedStagingCommand
    && ((resolvedProdCommand && prodConfiguredBefore && smokeBefore!.prod!.command === resolvedProdCommand)
        || (!resolvedProdCommand && !prodConfiguredBefore))
    && (smokeBefore?.requireStagingSmoke === true) === resolvedRequireStaging;
  const mode: SmokeSetupMode = sameAsBefore ? 'already configured' : 'configured';

  const repoSignal = (() => {
    if (explicitStagingCommand) return `explicit --staging-command="${explicitStagingCommand}"`;
    if (stagingAutoSource === 'candidate') {
      const candidate = candidates.strong[0];
      return `package script ${candidate.name} (strong: ${candidate.reason})`;
    }
    if (stagingAutoSource === 'preserved') return 'existing .pipelane.json smoke.staging.command';
    return 'unknown';
  })();

  const coverageRegistry: SmokeSetupOutcome['coverageRegistry'] = planResult.createdRegistry
    ? 'created'
    : (sameAsBefore ? 'unchanged' : 'updated');

  const releaseGate: SmokeSetupOutcome['releaseGate'] = resolvedRequireStaging
    ? (resolvedStagingCommand ? 'required' : 'misconfigured')
    : 'optional';

  const nextAction = buildConfiguredNextAction({
    config: refreshedContext.config,
    releaseGate,
    mode,
  });

  emitSetupOutcome(parsed, {
    mode,
    repoSignal,
    stagingCommand: resolvedStagingCommand,
    prodCommand: resolvedProdCommand || null,
    coverageRegistry,
    releaseGate,
    nextAction,
    warnings,
    candidates,
    configPath,
    configPathIsLegacy: isLegacy,
    planMessage: planResult.message,
  });
}

function describeRepoSignal(candidates: ScoredCandidates): string {
  if (candidates.strong.length > 1) {
    return `found multiple strong candidate scripts: ${candidates.strong.map((c) => c.name).join(', ')}`;
  }
  if (candidates.strong.length === 1 && candidates.weak.length === 0 && candidates.medium.length === 0) {
    // Should not reach here — single strong is the auto-wired case.
    return `found one strong candidate: ${candidates.strong[0].name}`;
  }
  if (candidates.medium.length > 0 && candidates.strong.length === 0) {
    return `found medium candidate scripts (not auto-selected — no smoke filter): ${candidates.medium.map((c) => c.name).join(', ')}`;
  }
  if (candidates.weak.length > 0 && candidates.strong.length === 0 && candidates.medium.length === 0) {
    const first = candidates.weak[0];
    return `found one weak candidate "${first.name}" — ${first.reason}`;
  }
  return 'no smoke / e2e package scripts detected';
}

function buildNeedsInputNextAction(candidates: ScoredCandidates, config: Parameters<typeof formatWorkflowCommand>[0]): string {
  const setupCommand = formatWorkflowCommand(config, 'smoke', 'setup');
  if (candidates.strong.length > 1) {
    const options = candidates.strong.map((c) => `npm run ${c.name}`).join(' | ');
    return `rerun ${setupCommand} --staging-command="<one of: ${options}>"`;
  }
  if (candidates.strong.length === 0 && candidates.medium.length > 0) {
    const options = candidates.medium.map((c) => `npm run ${c.name}`).join(' | ');
    return `rerun ${setupCommand} --staging-command="<${options}, filtered to @smoke tests>"`;
  }
  if (candidates.strong.length === 0 && candidates.medium.length === 0 && candidates.weak.length > 0) {
    return `rerun ${setupCommand} --staging-command="<your real smoke command>" (the weak candidate is not a release smoke test)`;
  }
  return `rerun ${setupCommand} --staging-command="<your smoke command>" — add a package script like "test:e2e:smoke" first if none exists`;
}

function buildConfiguredNextAction(options: {
  config: Parameters<typeof formatWorkflowCommand>[0];
  releaseGate: SmokeSetupOutcome['releaseGate'];
  mode: SmokeSetupMode;
}): string {
  const planCommand = formatWorkflowCommand(options.config, 'smoke', 'plan');
  const stagingCommand = formatWorkflowCommand(options.config, 'smoke', 'staging');
  if (options.mode === 'already configured') {
    return `run ${planCommand} to audit coverage, or ${stagingCommand} after the next verified staging deploy`;
  }
  return `run ${stagingCommand} after the next verified staging deploy`;
}

function emitSetupOutcome(parsed: ParsedOperatorArgs, outcome: SmokeSetupOutcome): void {
  const lines = [
    `Smoke setup: ${outcome.mode}`,
    `Repo signal: ${outcome.repoSignal}`,
    `Staging command: ${outcome.stagingCommand ?? 'missing'}`,
    `Production command: ${outcome.prodCommand ?? 'not configured'}`,
    `Coverage registry: ${outcome.coverageRegistry}${outcome.configPath ? ` (via ${path.basename(outcome.configPath)})` : ''}`,
    `Release gate: ${outcome.releaseGate}`,
    `Next: ${outcome.nextAction}`,
  ];
  if (outcome.configPathIsLegacy) {
    lines.push(`Note: wrote updates to legacy .project-workflow.json — consider migrating to .pipelane.json.`);
  }
  for (const warning of outcome.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  printResult(parsed.flags, {
    setupMode: outcome.mode,
    smokeConfigured: Boolean(outcome.stagingCommand),
    smokeRequired: outcome.releaseGate === 'required',
    stagingCommand: outcome.stagingCommand,
    prodCommand: outcome.prodCommand,
    coverageRegistry: outcome.coverageRegistry,
    releaseGate: outcome.releaseGate,
    repoSignal: outcome.repoSignal,
    candidates: {
      strong: outcome.candidates.strong.map((c) => ({ name: c.name, command: c.command, reason: c.reason })),
      medium: outcome.candidates.medium.map((c) => ({ name: c.name, command: c.command, reason: c.reason })),
      weak: outcome.candidates.weak.map((c) => ({ name: c.name, command: c.command, reason: c.reason })),
    },
    warnings: outcome.warnings,
    suggestedNextAction: outcome.nextAction,
    configPath: outcome.configPath || null,
    configPathIsLegacy: outcome.configPathIsLegacy,
    message: lines.join('\n'),
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
    throw new Error(`smoke ${environment} blocked: no smoke checks configured for ${environment}. Run ${formatWorkflowCommand(context.config, 'smoke', 'plan')}.`);
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
    maxExtensions: smokeConfig.waivers.maxExtensions,
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
        config: context.config,
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
  maxExtensions: number;
  tags?: string[];
}): SmokeWaiverRecord[] {
  const activeTags = options.tags ? new Set(options.tags) : null;
  const nowMs = Date.now();
  return options.waivers.filter((waiver) =>
    waiver.environment === options.environment
    && (activeTags ? activeTags.has(waiver.tag) : true)
    && isSmokeWaiverUsable(waiver, options.maxExtensions, nowMs),
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
    throw new Error(`Usage: ${formatWorkflowCommand(context.config, 'smoke', 'waiver <create|extend> <@smoke-tag> <staging|prod>')} --reason "..."`);
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
    planCommand: formatWorkflowCommand(context.config, 'smoke', 'plan'),
  });
  const smokeConfig = resolveSmokeConfig(context.config);
  const waivers = loadSmokeWaivers(context.repoRoot, context.config);
  const existing = waivers.waivers.find((waiver) => waiver.tag === tag && waiver.environment === environment);
  const now = Date.now();
  if (action === 'extend' && !existing) {
    throw new Error(`No existing smoke waiver found for ${tag}:${environment}.`);
  }
  const nextExtensions = action === 'extend' ? (existing?.extensions ?? 0) + 1 : 0;
  if (nextExtensions > smokeConfig.waivers.maxExtensions) {
    throw new Error(
      `Smoke waiver for ${tag}:${environment} already reached maxExtensions=${smokeConfig.waivers.maxExtensions}. ` +
      'Remove the waiver or raise the configured cap before extending again.',
    );
  }
  const next = {
    tag,
    environment,
    reason: parsed.flags.reason.trim(),
    createdAt: existing?.createdAt ?? nowIso(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    extensions: nextExtensions,
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
    throw new Error(`Usage: ${formatWorkflowCommand(context.config, 'smoke', `${quarantine ? 'quarantine' : 'unquarantine'} <@smoke-tag>`)} [--reason "..."]`);
  }
  const registry = loadSmokeRegistry(context.repoRoot, context.config);
  const entry = requireSmokeRegistryEntry({
    registry,
    tag,
    action: 'quarantine',
    planCommand: formatWorkflowCommand(context.config, 'smoke', 'plan'),
  });
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
  planCommand: string;
}) {
  const entry = options.registry.checks[options.tag];
  if (!entry) {
    throw new Error(`No smoke registry entry found for ${options.tag}. Run ${options.planCommand} first.`);
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
