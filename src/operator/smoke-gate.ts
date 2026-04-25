import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadDeployConfig } from './release-gate.ts';
import {
  loadDeployState,
  loadSmokeEnvironmentLock,
  loadSmokeLatestState,
  loadSmokeRegistry,
  listSmokeRunRecords,
  nowIso,
  removeSmokeEnvironmentLock,
  resolveSmokeHistoryDir,
  resolveSmokeLatestPath,
  resolveSmokeRuntimeRoot,
  saveSmokeEnvironmentLock,
  saveSmokeLatestState,
  saveSmokeRegistry,
  type DeployRecord,
  type SmokeArtifacts,
  type SmokeCheckResult,
  type SmokeConfig,
  type SmokeCohortConfig,
  type SmokeEnvironment,
  type SmokeEnvironmentConfig,
  type SmokeEnvironmentLock,
  type SmokeLatestState,
  type SmokePreflightResult,
  type SmokeRegistryEntry,
  type SmokeRegistryState,
  type SmokeRunnerCheckResult,
  type SmokeRunRecord,
  type SmokeRunStatus,
  type SmokeWaiverRecord,
  type WorkflowConfig,
} from './state.ts';

export interface ResolvedSmokeEnvironmentConfig {
  command: string;
  preflight: Array<{ name: string; command: string; critical: boolean }>;
  cohorts: Array<{ name: string; blocking: boolean }>;
}

export interface ResolvedSmokeConfig {
  registryPath: string;
  generatedSummaryPath: string | null;
  criticalPathCoverage: 'warn' | 'block';
  criticalPaths: string[];
  requireStagingSmoke: boolean;
  staging: ResolvedSmokeEnvironmentConfig | null;
  prod: ResolvedSmokeEnvironmentConfig | null;
  waivers: {
    path: string;
    maxExtensions: number;
  };
  history: {
    retentionDays: number;
    maxEntries: number;
  };
  concurrency: {
    mode: 'single-flight';
  };
}

export interface SmokeTagDiscovery {
  tag: string;
  files: string[];
}

export interface SmokePlanFinding {
  priority: number;
  code: string;
  message: string;
}

export interface SmokePlanReport {
  createdRegistry: boolean;
  smokeTags: SmokeTagDiscovery[];
  candidateTests: string[];
  findings: SmokePlanFinding[];
  summaryPath: string | null;
}

export interface SmokeLintReport {
  missingRegistryEntries: string[];
  orphanRegistryEntries: string[];
  missingBlockingMetadata: string[];
  expiredWaivers: string[];
  excessiveWaivers: string[];
  generatedSummaryDrift: boolean;
  findings: SmokePlanFinding[];
}

export interface SmokeCoverageSignal {
  mode: 'warn' | 'block';
  uncoveredCriticalPaths: string[];
}

export interface ResolvedSmokeTarget {
  environment: SmokeEnvironment;
  sha: string;
  baseUrl: string;
  deployRecord: DeployRecord;
}

export function resolveSmokeConfig(config: WorkflowConfig): ResolvedSmokeConfig {
  const smoke = config.smoke ?? {};
  return {
    registryPath: smoke.registryPath?.trim() || '.pipelane/smoke-checks.json',
    generatedSummaryPath: smoke.generatedSummaryPath?.trim() || null,
    criticalPathCoverage: smoke.criticalPathCoverage === 'block' ? 'block' : 'warn',
    criticalPaths: (smoke.criticalPaths ?? []).map((entry) => entry.trim()).filter(Boolean),
    requireStagingSmoke: smoke.requireStagingSmoke === true,
    staging: resolveSmokeEnvironmentConfig(smoke.staging),
    prod: resolveSmokeEnvironmentConfig(smoke.prod),
    waivers: {
      path: smoke.waivers?.path?.trim() || '.pipelane/waivers.json',
      maxExtensions: smoke.waivers?.maxExtensions ?? 2,
    },
    history: {
      retentionDays: smoke.history?.retentionDays ?? 90,
      maxEntries: smoke.history?.maxEntries ?? 1000,
    },
    concurrency: {
      mode: 'single-flight',
    },
  };
}

export function isSmokeWaiverExpired(waiver: SmokeWaiverRecord, nowMs = Date.now()): boolean {
  return Date.parse(waiver.expiresAt) < nowMs;
}

export function isSmokeWaiverOverExtended(waiver: SmokeWaiverRecord, maxExtensions: number): boolean {
  return (waiver.extensions ?? 0) > maxExtensions;
}

export function isSmokeWaiverUsable(
  waiver: SmokeWaiverRecord,
  maxExtensions: number,
  nowMs = Date.now(),
): boolean {
  return !isSmokeWaiverExpired(waiver, nowMs) && !isSmokeWaiverOverExtended(waiver, maxExtensions);
}

export function isSmokeSuccessStatus(status: SmokeRunStatus): boolean {
  return status === 'passed' || status === 'passed_with_retries';
}

function resolveSmokeEnvironmentConfig(value: SmokeEnvironmentConfig | undefined): ResolvedSmokeEnvironmentConfig | null {
  if (!value?.command?.trim()) {
    return null;
  }
  const preflight = (value.preflight ?? []).map((step) => ({
    name: step.name.trim(),
    command: step.command.trim(),
    critical: step.critical === true,
  }));
  const configuredCohorts = (value.cohorts ?? [])
    .map((cohort) => ({
      name: cohort.name.trim(),
      blocking: cohort.blocking !== false,
    }))
    .filter((cohort) => cohort.name.length > 0);
  const cohorts = configuredCohorts.length > 0
    ? configuredCohorts
    : [{ name: 'default', blocking: true }];
  return {
    command: value.command.trim(),
    preflight,
    cohorts,
  };
}

// Tag/file discovery runs during `pipelane smoke plan` on consumer repos and
// inside tests. Shelling out to ripgrep was faster on huge repos but failed
// closed when `rg` was shadowed (Claude Code's shell wrapper) or missing on
// the host: discoverSmokeTags returned [] and every downstream smoke test
// silently scaffolded an empty registry. Pure-Node walk is fast enough for
// the sizes pipelane actually sees and has no external dependency.
const SMOKE_TAG_PATTERN = /@smoke-[a-z0-9-]+/g;
const WALK_DIRS_EXCLUDED = new Set(['.git', 'node_modules']);
const MAX_SMOKE_SCAN_BYTES = 5 * 1024 * 1024;

function* walkRepoFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (WALK_DIRS_EXCLUDED.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        yield entryPath;
      }
    }
  }
}

export function discoverSmokeTags(repoRoot: string): SmokeTagDiscovery[] {
  const discovered = new Map<string, Set<string>>();
  for (const filePath of walkRepoFiles(repoRoot)) {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      continue;
    }
    if (size === 0 || size > MAX_SMOKE_SCAN_BYTES) continue;
    let contents: string;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const matches = contents.match(SMOKE_TAG_PATTERN);
    if (!matches) continue;
    const relative = path.relative(repoRoot, filePath) || filePath;
    for (const tag of matches) {
      const bucket = discovered.get(tag) ?? new Set<string>();
      bucket.add(relative);
      discovered.set(tag, bucket);
    }
  }
  return [...discovered.entries()]
    .map(([tag, files]) => ({ tag, files: [...files].sort() }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

export function discoverCandidateSmokeTests(repoRoot: string): string[] {
  const results = new Set<string>();
  for (const filePath of walkRepoFiles(repoRoot)) {
    const relative = path.relative(repoRoot, filePath) || filePath;
    if (
      /playwright/i.test(relative)
      || /e2e/i.test(relative)
      || /\.spec\./i.test(relative)
    ) {
      results.add(relative);
    }
  }
  return [...results].sort();
}

export function scaffoldSmokeRegistry(options: {
  repoRoot: string;
  config: WorkflowConfig;
  discoveredTags: SmokeTagDiscovery[];
}): SmokeRegistryState {
  const checks: Record<string, SmokeRegistryEntry> = {};
  for (const entry of options.discoveredTags) {
    checks[entry.tag] = {
      description: entry.tag.slice(1).replaceAll('-', ' '),
      blocking: false,
      quarantine: true,
      owner: '',
      escalation: '',
      runbook: '',
      environments: ['staging'],
      surfaces: inferRegistrySurfaces(entry.tag),
      sourceTests: entry.files,
    };
  }
  const registry = { checks };
  saveSmokeRegistry(options.repoRoot, options.config, registry);
  return registry;
}

function inferRegistrySurfaces(tag: string): string[] {
  const normalized = tag.replace(/^@smoke-/, '');
  if (!normalized) return ['frontend'];
  if (normalized.includes('auth')) return ['auth'];
  if (normalized.includes('billing')) return ['billing'];
  if (normalized.includes('settings')) return ['settings'];
  if (normalized.includes('workspace')) return ['workspace'];
  return [normalized];
}

export function generateSmokeSummary(registry: SmokeRegistryState): string {
  const lines = [
    '# Smoke Summary',
    '',
    'Generated from `.pipelane/smoke-checks.json`.',
    '',
  ];
  const entries = Object.entries(registry.checks).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    lines.push('No smoke checks registered yet.');
    return `${lines.join('\n')}\n`;
  }
  for (const [tag, entry] of entries) {
    lines.push(`- \`${tag}\`${entry.description ? ` ${entry.description}` : ''}`);
    if (entry.owner) lines.push(`  Owner: \`${entry.owner}\``);
    if (entry.runbook) lines.push(`  Runbook: \`${entry.runbook}\``);
    if (entry.sourceTests?.length) lines.push(`  Source tests: ${entry.sourceTests.map((file) => `\`${file}\``).join(', ')}`);
    if (entry.quarantine) lines.push('  Status: quarantined');
  }
  return `${lines.join('\n')}\n`;
}

export function lintSmokeSetup(options: {
  repoRoot: string;
  config: WorkflowConfig;
  registry: SmokeRegistryState;
  discoveredTags: SmokeTagDiscovery[];
  waivers: SmokeWaiverRecord[];
}): SmokeLintReport {
  const smokeConfig = resolveSmokeConfig(options.config);
  const nowMs = Date.now();
  const registryTags = new Set(Object.keys(options.registry.checks));
  const discoveredTags = new Set(options.discoveredTags.map((entry) => entry.tag));
  const missingRegistryEntries = [...discoveredTags].filter((tag) => !registryTags.has(tag)).sort();
  const orphanRegistryEntries = [...registryTags].filter((tag) => !discoveredTags.has(tag)).sort();
  const missingBlockingMetadata = Object.entries(options.registry.checks)
    .filter(([, entry]) => entry.blocking === true && (!entry.owner || !entry.escalation || !entry.runbook))
    .map(([tag]) => tag)
    .sort();
  const expiredWaivers = options.waivers
    .filter((waiver) => isSmokeWaiverExpired(waiver, nowMs))
    .map((waiver) => `${waiver.tag}:${waiver.environment}`)
    .sort();
  const excessiveWaivers = options.waivers
    .filter((waiver) => isSmokeWaiverOverExtended(waiver, smokeConfig.waivers.maxExtensions))
    .map((waiver) => `${waiver.tag}:${waiver.environment}`)
    .sort();
  let generatedSummaryDrift = false;
  if (smokeConfig.generatedSummaryPath) {
    const targetPath = path.join(options.repoRoot, smokeConfig.generatedSummaryPath);
    const expected = generateSmokeSummary(options.registry);
    const actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
    generatedSummaryDrift = actual !== expected;
  }

  const findings: SmokePlanFinding[] = [];
  if (missingRegistryEntries.length > 0) {
    findings.push({
      priority: 1,
      code: 'registry.missing',
      message: `Add registry entries for ${missingRegistryEntries.join(', ')}.`,
    });
  }
  if (orphanRegistryEntries.length > 0) {
    findings.push({
      priority: 2,
      code: 'registry.orphan',
      message: `Remove or retag orphan registry entries ${orphanRegistryEntries.join(', ')}.`,
    });
  }
  if (missingBlockingMetadata.length > 0) {
    findings.push({
      priority: 2,
      code: 'registry.metadata',
      message: `Blocking checks need owner/escalation/runbook: ${missingBlockingMetadata.join(', ')}.`,
    });
  }
  if (expiredWaivers.length > 0) {
    findings.push({
      priority: 1,
      code: 'waiver.expired',
      message: `Expired smoke waivers: ${expiredWaivers.join(', ')}.`,
    });
  }
  if (excessiveWaivers.length > 0) {
    findings.push({
      priority: 1,
      code: 'waiver.max_extensions',
      message: `Waivers exceed maxExtensions: ${excessiveWaivers.join(', ')}.`,
    });
  }
  if (generatedSummaryDrift) {
    findings.push({
      priority: 3,
      code: 'summary.drift',
      message: 'Generated smoke summary is out of date.',
    });
  }

  return {
    missingRegistryEntries,
    orphanRegistryEntries,
    missingBlockingMetadata,
    expiredWaivers,
    excessiveWaivers,
    generatedSummaryDrift,
    findings,
  };
}

export function buildSmokePlanReport(options: {
  repoRoot: string;
  config: WorkflowConfig;
  registry: SmokeRegistryState;
  discoveredTags: SmokeTagDiscovery[];
  candidateTests: string[];
  lint: SmokeLintReport;
}): SmokePlanReport {
  const smokeConfig = resolveSmokeConfig(options.config);
  const findings = [...options.lint.findings];
  const promotedCandidates = options.candidateTests.filter((file) =>
    !options.discoveredTags.some((entry) => entry.files.includes(file)),
  );
  if (promotedCandidates.length > 0) {
    findings.push({
      priority: 3,
      code: 'promote.candidate',
      message: `Promote existing browser/e2e tests into smoke: ${promotedCandidates.slice(0, 3).join(', ')}${promotedCandidates.length > 3 ? ', …' : ''}.`,
    });
  }
  const coverage = evaluateSmokeCoverage({
    registry: options.registry,
    environment: 'staging',
    config: options.config,
  });
  if (coverage.uncoveredCriticalPaths.length > 0) {
    findings.push({
      priority: 1,
      code: 'coverage.critical',
      message: `Critical paths missing smoke coverage: ${coverage.uncoveredCriticalPaths.join(', ')}.`,
    });
  }
  if (findings.length === 0) {
    findings.push({
      priority: 5,
      code: 'plan.clean',
      message: 'No smoke action needed right now.',
    });
  }
  return {
    createdRegistry: false,
    smokeTags: options.discoveredTags,
    candidateTests: promotedCandidates,
    findings: findings.sort((left, right) => left.priority - right.priority).slice(0, 5),
    summaryPath: smokeConfig.generatedSummaryPath,
  };
}

export function writeGeneratedSmokeSummary(repoRoot: string, config: WorkflowConfig, registry: SmokeRegistryState): string | null {
  const smokeConfig = resolveSmokeConfig(config);
  if (!smokeConfig.generatedSummaryPath) {
    return null;
  }
  const targetPath = path.join(repoRoot, smokeConfig.generatedSummaryPath);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, generateSmokeSummary(registry), 'utf8');
  return targetPath;
}

export function evaluateSmokeCoverage(options: {
  registry: SmokeRegistryState;
  environment: SmokeEnvironment;
  config: WorkflowConfig;
}): SmokeCoverageSignal {
  const smokeConfig = resolveSmokeConfig(options.config);
  const uncoveredCriticalPaths = smokeConfig.criticalPaths.filter((criticalPath) =>
    !Object.values(options.registry.checks).some((entry) =>
      entry.quarantine !== true
      && (entry.environments?.includes(options.environment) ?? true)
      && (entry.surfaces ?? []).includes(criticalPath),
    ),
  );
  return {
    mode: smokeConfig.criticalPathCoverage,
    uncoveredCriticalPaths,
  };
}

export function resolveSmokeTarget(options: {
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  environment: SmokeEnvironment;
}): ResolvedSmokeTarget {
  const deployConfig = loadDeployConfig(options.repoRoot);
  const deployState = loadDeployState(options.commonDir, options.config).records;
  const deployRecord = [...deployState]
    .reverse()
    .find((record) => record.environment === options.environment && record.status === 'succeeded' && Boolean(record.verifiedAt));
  if (!deployRecord) {
    throw new Error(`smoke ${options.environment} blocked: no verified deploy record found for ${options.environment}.`);
  }
  const frontend = options.environment === 'staging'
    ? deployConfig?.frontend.staging
    : deployConfig?.frontend.production;
  const baseUrl = frontend?.url?.trim() || frontend?.healthcheckUrl?.trim() || '';
  if (!baseUrl) {
    throw new Error(`smoke ${options.environment} blocked: missing frontend ${options.environment} URL in deploy configuration.`);
  }
  return {
    environment: options.environment,
    sha: deployRecord.sha,
    baseUrl,
    deployRecord,
  };
}

export function acquireSmokeEnvironmentLock(options: {
  commonDir: string;
  repoRoot: string;
  environment: SmokeEnvironment;
  operation: 'smoke' | 'deploy';
  runId: string;
  sha: string;
}): SmokeEnvironmentLock {
  const existing = loadSmokeEnvironmentLock(options.commonDir, options.environment);
  if (existing) {
    if (!isEnvironmentLockStale(existing)) {
      throw new Error(
        existing.operation === 'smoke'
          ? `Smoke already running for ${options.environment}: runId=${existing.runId}`
          : `${capitalize(existing.operation)} already running for ${options.environment}: runId=${existing.runId}`,
      );
    }
    removeSmokeEnvironmentLock(options.commonDir, options.environment);
  }
  const lock: SmokeEnvironmentLock = {
    environment: options.environment,
    operation: options.operation,
    runId: options.runId,
    sha: options.sha,
    createdAt: nowIso(),
    pid: process.pid,
    repoRoot: options.repoRoot,
  };
  saveSmokeEnvironmentLock(options.commonDir, lock);
  return lock;
}

export function releaseSmokeEnvironmentLock(commonDir: string, environment: SmokeEnvironment): void {
  removeSmokeEnvironmentLock(commonDir, environment);
}

function isEnvironmentLockStale(lock: SmokeEnvironmentLock): boolean {
  const createdAt = Date.parse(lock.createdAt);
  if (Number.isFinite(createdAt) && Date.now() - createdAt > 4 * 60 * 60 * 1000) {
    return true;
  }
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch {
    return true;
  }
}

export function resolveSmokeArtifacts(repoRoot: string): { firstFailureTrace?: string; htmlReport?: string; screenshotDir?: string } {
  const testResultsDir = path.join(repoRoot, 'test-results');
  const playwrightReportDir = path.join(repoRoot, 'playwright-report');
  const firstFailureTrace = findNewestMatchingFile(testResultsDir, '.zip');
  const screenshotDir = existsSync(testResultsDir) ? testResultsDir : undefined;
  const htmlReport = existsSync(playwrightReportDir) ? path.join(playwrightReportDir, 'index.html') : undefined;
  return {
    firstFailureTrace,
    htmlReport,
    screenshotDir,
  };
}

function findNewestMatchingFile(root: string, suffix: string): string | undefined {
  if (!existsSync(root)) {
    return undefined;
  }
  const candidates: Array<{ targetPath: string; mtimeMs: number }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const targetPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(targetPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        const stats = statSync(targetPath);
        candidates.push({ targetPath, mtimeMs: stats.mtimeMs });
      }
    }
  };
  walk(root);
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.targetPath;
}

export function updateSmokeLatest(options: {
  commonDir: string;
  config: WorkflowConfig;
  record: SmokeRunRecord;
}): SmokeLatestState {
  const latest = loadSmokeLatestState(options.commonDir, options.config);
  const next: SmokeLatestState = {
    staging: options.record.environment === 'staging' ? options.record : latest.staging,
    prod: options.record.environment === 'prod' ? options.record : latest.prod,
    updatedAt: nowIso(),
  };
  saveSmokeLatestState(options.commonDir, options.config, next);
  return next;
}

export function computeLastKnownGoodSha(records: SmokeRunRecord[], environment: SmokeEnvironment): string | null {
  const thresholdMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const match = [...records]
    .reverse()
    .find((record) =>
      record.environment === environment
      && isSmokeSuccessStatus(record.status)
      && !record.drifted
      && Date.parse(record.finishedAt) >= thresholdMs,
    );
  return match?.sha ?? null;
}

export function pruneSmokeHistory(commonDir: string, config: WorkflowConfig): void {
  const smokeConfig = resolveSmokeConfig(config);
  const historyDir = resolveSmokeHistoryDir(commonDir, config);
  if (!existsSync(historyDir)) {
    return;
  }
  const entries = readdirSync(historyDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const targetPath = path.join(historyDir, entry);
      const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as SmokeRunRecord;
      return { entry, targetPath, record: parsed };
    })
    .sort((left, right) => left.record.startedAt.localeCompare(right.record.startedAt));
  const thresholdMs = Date.now() - smokeConfig.history.retentionDays * 24 * 60 * 60 * 1000;
  const overflow = Math.max(0, entries.length - smokeConfig.history.maxEntries);
  let removed = 0;
  for (const item of entries) {
    const stale = Date.parse(item.record.finishedAt || item.record.startedAt) < thresholdMs;
    const overCap = removed < overflow;
    if (!stale && !overCap) continue;
    rmSync(item.targetPath, { force: true });
    removed += 1;
  }
}

export function findQualifyingSmokeRun(options: {
  commonDir: string;
  config: WorkflowConfig;
  environment: SmokeEnvironment;
  sha: string;
}): SmokeRunRecord | null {
  const latest = findLatestSmokeRun(options);
  if (!latest) {
    return null;
  }
  return isSmokeSuccessStatus(latest.status) && !latest.drifted ? latest : null;
}

export function findLatestSmokeRun(options: {
  commonDir: string;
  config: WorkflowConfig;
  environment: SmokeEnvironment;
  sha: string;
}): SmokeRunRecord | null {
  return [...listSmokeRunRecords(options.commonDir, options.config)]
    .reverse()
    .find((record) =>
      record.environment === options.environment
      && record.sha === options.sha,
    ) ?? null;
}

export function summarizeSmokeRun(record: SmokeRunRecord, registry?: SmokeRegistryState): string {
  const primaryFailure = record.checks.find((check) => check.status === 'failed' && check.effectiveBlocking)
    ?? record.checks.find((check) => check.status === 'failed');
  const trace = primaryFailure?.artifacts?.firstFailureTrace
    ?? record.cohortResults.find((cohort) => cohort.artifacts?.firstFailureTrace)?.artifacts?.firstFailureTrace;
  const successLabel = record.status === 'passed_with_retries' ? 'Smoke PASSED WITH RETRIES' : 'Smoke PASSED';
  const lines = [
    isSmokeSuccessStatus(record.status)
      ? `${successLabel}: ${record.environment}`
      : `Smoke FAILED: ${trace ? `trace=${trace}` : record.preflight.find((step) => step.status === 'failed')?.logPath ?? 'see logs'}`,
  ];
  if (record.checks.length > 0) {
    lines.push('', 'Tested:');
    for (const check of record.checks) {
      const label = registry?.checks[check.tag]?.description?.trim() || check.tag;
      lines.push(`- ${label} (${formatCheckOutcome(check)})`);
    }
    lines.push('');
  }
  lines.push(
    `Environment: ${record.environment}`,
    `SHA: ${record.sha}`,
    `Result: ${record.status}`,
  );
  if (record.lastKnownGoodSha) {
    lines.push(`Last known good: ${record.lastKnownGoodSha}`);
  }
  const contractErrors = record.cohortResults
    .filter((cohort) => cohort.contractError)
    .map((cohort) => `${cohort.name}: ${cohort.contractError}`);
  if (contractErrors.length > 0) {
    lines.push('', 'Runner contract errors:');
    for (const error of contractErrors) {
      lines.push(`- ${error}`);
    }
  }
  const blockingFailures = record.checks.filter((check) => check.status === 'failed' && check.effectiveBlocking);
  if (blockingFailures.length > 0) {
    lines.push('', 'Blocking failures:');
    for (const check of blockingFailures) {
      lines.push(`- ${check.tag}`);
    }
  }
  const waivedFailures = record.checks.filter((check) => check.status === 'failed' && check.waived);
  if (waivedFailures.length > 0) {
    lines.push('', 'Waived failures:');
    for (const check of waivedFailures) {
      lines.push(`- ${check.tag}${check.waiverReason ? ` (${check.waiverReason})` : ''}`);
    }
  }
  const quarantinedFailures = record.checks.filter((check) => check.status === 'failed' && check.quarantine && !check.waived);
  if (quarantinedFailures.length > 0) {
    lines.push('', 'Quarantined failures:');
    for (const check of quarantinedFailures) {
      lines.push(`- ${check.tag}`);
    }
  }
  const nonBlockingFailures = record.checks.filter((check) =>
    check.status === 'failed'
    && !check.effectiveBlocking
    && !check.quarantine
    && !check.waived,
  );
  if (nonBlockingFailures.length > 0) {
    lines.push('', 'Non-blocking failures:');
    for (const check of nonBlockingFailures) {
      lines.push(`- ${check.tag}`);
    }
  }
  const nonBlockingCohortFailures = record.cohortResults.filter((cohort) => !cohort.blocking && cohort.status === 'failed');
  if (nonBlockingCohortFailures.length > 0) {
    lines.push('', 'Non-blocking cohort failures:');
    for (const cohort of nonBlockingCohortFailures) {
      const trace = cohort.artifacts?.firstFailureTrace;
      lines.push(`- ${cohort.name}${trace ? ` (trace=${trace})` : ''}`);
    }
  }
  const artifacts = primaryFailure?.artifacts
    ?? record.cohortResults
      .map((cohort) => cohort.artifacts)
      .find(Boolean);
  if (artifacts?.htmlReport || artifacts?.screenshotDir) {
    lines.push('', 'Artifacts:');
    if (artifacts.htmlReport) lines.push(`- HTML report: ${artifacts.htmlReport}`);
    if (artifacts.screenshotDir) lines.push(`- Screenshot dir: ${artifacts.screenshotDir}`);
  }
  return lines.join('\n');
}

export function formatSmokePlanReport(report: SmokePlanReport): string {
  const lines = ['Smoke plan:', `- smoke-tagged tests discovered: ${report.smokeTags.length}`];
  if (report.createdRegistry) {
    lines.push('- scaffolded .pipelane/smoke-checks.json');
  }
  if (report.summaryPath) {
    lines.push(`- generated summary: ${report.summaryPath}`);
  }
  lines.push('Top actions:');
  for (const finding of report.findings) {
    lines.push(`- ${finding.message}`);
  }
  return lines.join('\n');
}

export function buildLegacySmokeCheckResults(options: {
  registry: SmokeRegistryState;
  environment: SmokeEnvironment;
  status: SmokeRunStatus;
}): SmokeCheckResult[] {
  return Object.entries(options.registry.checks)
    .filter(([, entry]) => entry.environments?.includes(options.environment) ?? true)
    .map(([tag, entry]) => ({
      tag,
      status: options.status,
      quarantine: entry.quarantine === true,
      blocking: entry.blocking === true,
      effectiveBlocking: entry.blocking === true && entry.quarantine !== true,
      owner: entry.owner,
      attempts: [{ attempt: 1, status: options.status }],
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

export function evaluateSmokeChecks(options: {
  registry: SmokeRegistryState;
  environment: SmokeEnvironment;
  config: WorkflowConfig;
  cohortResults: Array<{
    name: string;
    blocking: boolean;
    checks?: SmokeRunnerCheckResult[];
    contractError?: string;
  }>;
  waivers: SmokeWaiverRecord[];
  requireCheckResults: boolean;
}): { checks: SmokeCheckResult[]; contractErrors: string[] } {
  const smokeConfig = resolveSmokeConfig(options.config);
  const nowMs = Date.now();
  const contractErrors = options.cohortResults
    .filter((cohort) => cohort.blocking && cohort.contractError)
    .map((cohort) => `${cohort.name}: ${cohort.contractError}`);
  const activeWaivers = new Map(
    options.waivers
      .filter((waiver) =>
        waiver.environment === options.environment
        && isSmokeWaiverUsable(waiver, smokeConfig.waivers.maxExtensions, nowMs),
      )
      .map((waiver) => [`${waiver.tag}:${waiver.environment}`, waiver] as const),
  );

  const checks = Object.entries(options.registry.checks)
    .filter(([, entry]) => entry.environments?.includes(options.environment) ?? true)
    .map(([tag, entry]) => {
      const matches = options.cohortResults.flatMap((cohort) =>
        (cohort.checks ?? [])
          .filter((check) => check.tag === tag)
          .map((check) => ({ check, cohort })),
      );
      const blockingMatches = matches.filter(({ cohort }) => cohort.blocking);
      const statusMatches = blockingMatches.length > 0 ? blockingMatches : matches;
      const attempts: Array<{ attempt: number; status: SmokeRunStatus }> = [];
      const cohorts: string[] = [];
      let nextAttempt = 1;
      for (const { check, cohort } of statusMatches) {
        cohorts.push(cohort.name);
        const resultAttempts = (check.attempts && check.attempts.length > 0)
          ? check.attempts
          : [{ attempt: 1, status: check.status }];
        for (const attempt of resultAttempts) {
          attempts.push({
            attempt: nextAttempt,
            status: attempt.status,
          });
          nextAttempt += 1;
        }
      }

      if (options.requireCheckResults && entry.blocking === true && blockingMatches.length === 0) {
        contractErrors.push(`missing check-level smoke result for blocking tag ${tag} in a blocking cohort`);
      }

      const status = aggregateRunnerCheckStatus(statusMatches.map(({ check }) => check));
      const waiver = activeWaivers.get(`${tag}:${options.environment}`);
      const effectiveBlocking = entry.blocking === true && entry.quarantine !== true && !waiver;
      const artifacts = chooseCheckArtifacts(statusMatches.map(({ check }) => check));
      const tests = aggregateRunnerCheckTests(statusMatches.map(({ check }) => check));
      return {
        tag,
        status,
        quarantine: entry.quarantine === true,
        blocking: entry.blocking === true,
        effectiveBlocking,
        waived: Boolean(waiver),
        waiverReason: waiver?.reason,
        owner: entry.owner,
        attempts: attempts.length > 0 ? attempts : [{ attempt: 1, status }],
        artifacts,
        cohorts: cohorts.length > 0 ? [...new Set(cohorts)].sort() : undefined,
        tests,
      } satisfies SmokeCheckResult;
    })
    .sort((left, right) => left.tag.localeCompare(right.tag));

  return { checks, contractErrors };
}

function aggregateRunnerCheckStatus(results: SmokeRunnerCheckResult[]): SmokeRunStatus {
  if (results.some((result) => result.status === 'failed')) {
    return 'failed';
  }
  if (results.some((result) => result.status === 'passed_with_retries')) {
    return 'passed_with_retries';
  }
  return 'passed';
}

function chooseCheckArtifacts(results: SmokeRunnerCheckResult[]): SmokeArtifacts | undefined {
  return results.find((result) => result.status === 'failed' && result.artifacts)?.artifacts
    ?? results.find((result) => result.artifacts)?.artifacts;
}

function aggregateRunnerCheckTests(
  results: SmokeRunnerCheckResult[],
): { passed: number; total: number } | undefined {
  let passed = 0;
  let total = 0;
  let seen = false;
  for (const result of results) {
    if (result.tests) {
      passed += result.tests.passed;
      total += result.tests.total;
      seen = true;
    }
  }
  return seen ? { passed, total } : undefined;
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatCheckOutcome(check: SmokeCheckResult): string {
  const base = check.tests
    ? `${check.tests.passed}/${check.tests.total} tests passed`
    : formatCheckStatus(check.status);
  const modifiers: string[] = [];
  if (check.waived) modifiers.push('waived');
  if (check.quarantine && !check.waived) modifiers.push('quarantined');
  return modifiers.length > 0 ? `${base}, ${modifiers.join(', ')}` : base;
}

function formatCheckStatus(status: SmokeRunStatus): string {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'passed with retries';
}
