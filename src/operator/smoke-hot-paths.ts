import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  nowIso,
  runCommandCapture,
  type SmokeRegistryEntry,
  type SmokeRegistryState,
  type SmokeRunStatus,
  type SmokeSafetyFlag,
  type SmokeScenarioLifecycle,
  type SmokeScenarioProvenance,
} from './state.ts';

export type SmokeAppType = 'app' | 'website' | 'game' | 'api' | 'library';
export type SmokeConfidence = 'high' | 'medium' | 'low';

export interface SmokeRepoAnalysis {
  appTypes: SmokeAppType[];
  scripts: Array<{ name: string; command: string }>;
  dependencies: string[];
  devDependencies: string[];
  envNames: string[];
  routes: string[];
  featureSignals: Array<{ name: string; evidence: string[] }>;
  testFiles: string[];
  supportedRunners: Array<'playwright' | 'cypress'>;
  scan: {
    scannedFiles: number;
    skippedLargeFiles: string[];
    skippedDirs: string[];
    maxFileBytes: number;
  };
}

export interface PlannedSmokeScenario {
  id: string;
  title: string;
  surface: string;
  lifecycle: SmokeScenarioLifecycle;
  safetyFlags: SmokeSafetyFlag[];
  sourceTests: string[];
  requiredEnv: string[];
  provenance: SmokeScenarioProvenance;
  generated?: {
    path: string;
    marker: string;
    adapter: string;
    status: 'unverified' | 'passed' | 'failed' | 'passed_with_retries';
    verifiedAt?: string;
  };
}

export interface SmokeHotPathPlan {
  analysis: SmokeRepoAnalysis;
  scenarios: PlannedSmokeScenario[];
  warnings: string[];
}

export interface ApplySmokeHotPathResult {
  changed: boolean;
  added: string[];
  updated: string[];
}

export interface GenerateSmokeHotPathResult {
  changed: boolean;
  generated: string[];
  path?: string;
  adapter?: 'playwright' | 'cypress';
  warnings: string[];
}

export interface SmokeSetupVerificationResult {
  status: 'skipped_missing_base_url' | 'skipped_no_command' | 'passed' | 'failed' | 'passed_with_retries' | 'passed_without_check_results';
  runId?: string;
  baseUrl?: string;
  command?: string;
  logPath?: string;
  resultsPath?: string;
  checks: Array<{ tag: string; status: SmokeRunStatus }>;
  verifiedTags: string[];
  blockingTags: string[];
  message: string;
  aiFixPrompt?: string;
}

interface WalkedTextFile {
  relative: string;
  absolute: string;
  contents: string;
}

interface ScenarioTemplate {
  id: string;
  tag: string;
  title: string;
  surface: string;
  safetyFlags: SmokeSafetyFlag[];
  requiredEnv: (analysis: SmokeRepoAnalysis) => string[];
  match: (analysis: SmokeRepoAnalysis) => { confidence: SmokeConfidence; evidence: string[] } | null;
}

const MAX_HOT_PATH_SCAN_BYTES = 256 * 1024;
const MAX_SCENARIO_FILE_BYTES = 256 * 1024;
const EXCLUDED_SCAN_DIRS = new Set([
  '.agents',
  '.cache',
  '.claude',
  '.codex',
  '.git',
  '.next',
  '.nuxt',
  '.pipelane',
  '.turbo',
  '.cursor',
  '.idea',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'target',
  'test-results',
  'vendor',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.css',
  '.cts',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.rs',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);

const INTERNAL_SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    id: 'app-shell',
    tag: '@smoke-app-shell',
    title: 'Open the app shell and visit primary navigation',
    surface: 'app-shell',
    safetyFlags: ['readonly'],
    requiredEnv: () => [],
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['frontend', 'routes']);
      if (!hasAnyAppType(analysis, ['app', 'website']) || evidence.length === 0) return null;
      return { confidence: 'high', evidence };
    },
  },
  {
    id: 'auth',
    tag: '@smoke-auth-credentials',
    title: 'Authenticate with smoke credentials and reach a protected area',
    surface: 'auth',
    safetyFlags: ['stagingOnly'],
    requiredEnv: (analysis) => pickEnvNames(analysis, /^(PIPELANE_SMOKE_|E2E_|TEST_).*(EMAIL|USER|PASSWORD|PASS)$/i, [
      'PIPELANE_SMOKE_USER_EMAIL',
      'PIPELANE_SMOKE_USER_PASSWORD',
    ]),
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['auth']);
      if (evidence.length === 0) return null;
      return { confidence: 'high', evidence };
    },
  },
  {
    id: 'project-board-crud',
    tag: '@smoke-project-board-crud',
    title: 'Create a synthetic project board, open it, and delete it',
    surface: 'projects',
    safetyFlags: ['stagingOnly', 'requiresSyntheticData'],
    requiredEnv: () => [],
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['projects', 'boards']);
      if (evidence.length === 0) return null;
      return { confidence: evidence.length > 1 ? 'high' : 'medium', evidence };
    },
  },
  {
    id: 'wiki-page-crud',
    tag: '@smoke-wiki-page-crud',
    title: 'Create, rename, and delete a synthetic wiki page',
    surface: 'wiki',
    safetyFlags: ['stagingOnly', 'requiresSyntheticData'],
    requiredEnv: () => [],
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['wiki', 'docs']);
      if (evidence.length === 0) return null;
      return { confidence: 'high', evidence };
    },
  },
  {
    id: 'ai-primary-feature',
    tag: '@smoke-ai-primary-feature',
    title: 'Run the primary AI feature with test credentials and verify a response',
    surface: 'ai',
    safetyFlags: ['stagingOnly', 'externalDependency'],
    requiredEnv: (analysis) => pickEnvNames(analysis, /(OPENAI|ANTHROPIC|AI|LLM|MODEL).*(_KEY|TOKEN|SECRET)?$/i, [
      'OPENAI_API_KEY',
    ]),
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['ai']);
      if (evidence.length === 0) return null;
      return { confidence: 'high', evidence };
    },
  },
  {
    id: 'settings-profile',
    tag: '@smoke-settings-profile',
    title: 'Open account settings and verify profile preferences load',
    surface: 'settings',
    safetyFlags: ['readonly'],
    requiredEnv: () => [],
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['settings']);
      if (evidence.length === 0) return null;
      return { confidence: 'medium', evidence };
    },
  },
  {
    id: 'checkout',
    tag: '@smoke-checkout',
    title: 'Exercise checkout with a test payment path',
    surface: 'checkout',
    safetyFlags: ['stagingOnly', 'requiresSyntheticData', 'externalDependency'],
    requiredEnv: (analysis) => pickEnvNames(analysis, /(STRIPE|PAYMENT|CHECKOUT).*(_KEY|TOKEN|SECRET)?$/i, [
      'STRIPE_SECRET_KEY',
    ]),
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['billing', 'ecommerce']);
      if (evidence.length === 0) return null;
      return { confidence: 'medium', evidence };
    },
  },
  {
    id: 'game-load',
    tag: '@smoke-game-load',
    title: 'Load the game scene and perform the primary interaction',
    surface: 'gameplay',
    safetyFlags: ['readonly'],
    requiredEnv: () => [],
    match: (analysis) => {
      const evidence = collectEvidence(analysis, ['game']);
      if (!hasAnyAppType(analysis, ['game']) && evidence.length === 0) return null;
      return { confidence: evidence.length > 0 ? 'high' : 'medium', evidence: evidence.length > 0 ? evidence : ['game-oriented dependency or source layout'] };
    },
  },
];

export function analyzeSmokeRepo(repoRoot: string): SmokeRepoAnalysis {
  const skippedLargeFiles: string[] = [];
  const skippedDirs = new Set<string>();
  const files: WalkedTextFile[] = [];
  const packageInfo = readPackageInfo(repoRoot);

  walkTextFiles(repoRoot, {
    skippedLargeFiles,
    skippedDirs,
    onFile: (file) => files.push(file),
  });

  const envNames = new Set<string>();
  const routes = new Set<string>();
  const testFiles = new Set<string>();
  const signals = new Map<string, Set<string>>();

  const addSignal = (name: string, evidence: string) => {
    const bucket = signals.get(name) ?? new Set<string>();
    bucket.add(evidence);
    signals.set(name, bucket);
  };

  for (const file of files) {
    collectEnvNames(file, envNames);
    for (const route of inferRoutes(file.relative, file.contents)) routes.add(route);
    if (isTestFile(file.relative)) testFiles.add(file.relative);
    collectFeatureSignals(file, addSignal);
  }

  for (const dep of [...packageInfo.dependencies, ...packageInfo.devDependencies]) {
    const lower = dep.toLowerCase();
    if (/(react|vue|svelte|next|vite|astro|remix|angular)/.test(lower)) addSignal('frontend', `package:${dep}`);
    if (/(phaser|pixi|three|babylon|matter-js|kaboom)/.test(lower)) addSignal('game', `package:${dep}`);
    if (/(express|fastify|hono|koa|elysia)/.test(lower)) addSignal('api', `package:${dep}`);
    if (/(openai|anthropic|langchain|ai$|vercel\/ai)/.test(lower)) addSignal('ai', `package:${dep}`);
    if (/(stripe|paypal|braintree|checkout)/.test(lower)) addSignal('billing', `package:${dep}`);
  }

  const supportedRunners = detectSupportedRunners(packageInfo.scripts, packageInfo.dependencies, packageInfo.devDependencies);
  const appTypes = inferAppTypes(signals, routes, packageInfo, files);

  return {
    appTypes,
    scripts: packageInfo.scripts,
    dependencies: packageInfo.dependencies,
    devDependencies: packageInfo.devDependencies,
    envNames: [...envNames].sort(),
    routes: [...routes].sort(),
    featureSignals: [...signals.entries()]
      .map(([name, evidence]) => ({ name, evidence: [...evidence].sort().slice(0, 8) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    testFiles: [...testFiles].sort(),
    supportedRunners,
    scan: {
      scannedFiles: files.length,
      skippedLargeFiles: skippedLargeFiles.sort(),
      skippedDirs: [...skippedDirs].sort(),
      maxFileBytes: MAX_HOT_PATH_SCAN_BYTES,
    },
  };
}

export function planSmokeHotPaths(options: {
  repoRoot: string;
  discoveredTags: Array<{ tag: string; files: string[] }>;
  candidateTests: string[];
  feedback: string[];
  scenarioFile?: string;
}): SmokeHotPathPlan {
  const analysis = analyzeSmokeRepo(options.repoRoot);
  const scenarios: PlannedSmokeScenario[] = [];
  const warnings: string[] = [];

  for (const entry of options.discoveredTags) {
    scenarios.push({
      id: entry.tag,
      title: entry.tag.slice(1).replaceAll('-', ' '),
      surface: inferSurfaceFromTag(entry.tag),
      lifecycle: 'accepted',
      safetyFlags: ['readonly'],
      sourceTests: entry.files,
      requiredEnv: [],
      provenance: {
        source: 'discovered-tag',
        confidence: 'high',
        evidence: entry.files,
        updatedAt: nowIso(),
      },
    });
  }

  for (const template of INTERNAL_SCENARIO_TEMPLATES) {
    const match = template.match(analysis);
    if (!match) continue;
    scenarios.push({
      id: template.tag,
      title: template.title,
      surface: template.surface,
      lifecycle: 'suggested',
      safetyFlags: template.safetyFlags,
      sourceTests: findSourceTestsForSurface(options.candidateTests, template.surface),
      requiredEnv: template.requiredEnv(analysis),
      provenance: {
        source: 'internal-template',
        confidence: match.confidence,
        evidence: match.evidence,
        updatedAt: nowIso(),
      },
    });
  }

  scenarios.push(...scenariosFromFeedback(options.feedback, analysis));

  if (options.scenarioFile) {
    const loaded = loadScenarioFile(options.repoRoot, options.scenarioFile);
    scenarios.push(...loaded.scenarios);
    warnings.push(...loaded.warnings);
  }

  if (analysis.supportedRunners.length === 0) {
    warnings.push('No supported existing browser runner detected; hot paths remain scenario stubs until a Playwright or Cypress runner exists.');
  }
  if (analysis.scan.skippedLargeFiles.length > 0 || analysis.scan.skippedDirs.length > 0) {
    warnings.push(`Repo scan was bounded: skipped ${analysis.scan.skippedDirs.length} generated/vendor dirs and ${analysis.scan.skippedLargeFiles.length} large files.`);
  }

  return {
    analysis,
    scenarios: dedupeScenarios(scenarios),
    warnings,
  };
}

export function applySmokeHotPathScenarios(
  registry: SmokeRegistryState,
  scenarios: PlannedSmokeScenario[],
): ApplySmokeHotPathResult {
  const added: string[] = [];
  const updated: string[] = [];

  for (const scenario of scenarios) {
    const existing = registry.checks[scenario.id];
    if (!existing) {
      registry.checks[scenario.id] = scenarioToRegistryEntry(scenario);
      added.push(scenario.id);
      continue;
    }
    const next = mergeScenarioIntoEntry(existing, scenario);
    if (JSON.stringify(stableComparable(existing)) !== JSON.stringify(stableComparable(next))) {
      registry.checks[scenario.id] = next;
      updated.push(scenario.id);
    }
  }

  return {
    changed: added.length > 0 || updated.length > 0,
    added,
    updated,
  };
}

export function generateSmokeHotPathTests(options: {
  repoRoot: string;
  analysis: SmokeRepoAnalysis;
  scenarios: PlannedSmokeScenario[];
  registry: SmokeRegistryState;
}): GenerateSmokeHotPathResult {
  const adapter = pickGeneratorAdapter(options.analysis);
  const warnings: string[] = [];
  if (!adapter) {
    return { changed: false, generated: [], warnings };
  }

  const relativePath = resolveGeneratedSmokePath(options.repoRoot, adapter);
  const scenarios = options.scenarios.filter((scenario) => isRunnableGeneratedScenario(scenario, relativePath));
  if (scenarios.length === 0) {
    return { changed: false, generated: [], adapter, warnings };
  }

  const absolutePath = path.join(options.repoRoot, relativePath);
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : generatedSmokeFilePreamble(adapter);
  let contents = upsertGeneratedSmokeRegion(existing, 'support', renderGeneratedSmokeSupport(adapter));
  const generated: string[] = [];
  let registryChanged = false;

  for (const scenario of scenarios) {
    const marker = scenario.id.replace(/^@smoke-/, '').replace(/[^a-z0-9-]+/g, '-');
    contents = upsertGeneratedSmokeRegion(contents.contents, marker, renderGeneratedSmokeScenario(adapter, scenario));
    const entry = options.registry.checks[scenario.id];
    if (!entry) continue;
    const nextLifecycle = lifecycleRank(entry.lifecycle ?? 'suggested') >= lifecycleRank('generated')
      ? entry.lifecycle
      : 'generated';
    const nextEntry: SmokeRegistryEntry = {
      ...entry,
      lifecycle: nextLifecycle,
      sourceTests: mergeSorted(entry.sourceTests ?? [], [relativePath]),
      generated: {
        ...(entry.generated ?? {}),
        path: relativePath,
        marker,
        adapter,
        status: entry.generated?.status === 'passed' ? 'passed' : 'unverified',
      },
    };
    if (JSON.stringify(stableComparable(entry)) !== JSON.stringify(stableComparable(nextEntry))) {
      registryChanged = true;
    }
    options.registry.checks[scenario.id] = nextEntry;
    generated.push(scenario.id);
  }

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const fileChanged = !existsSync(absolutePath) || readFileSync(absolutePath, 'utf8') !== contents.contents;
  if (fileChanged) {
    writeFileSync(absolutePath, contents.contents, 'utf8');
  }
  return { changed: fileChanged || registryChanged, generated, path: relativePath, adapter, warnings };
}

function pickGeneratorAdapter(analysis: SmokeRepoAnalysis): 'playwright' | 'cypress' | null {
  if (analysis.supportedRunners.includes('playwright')) return 'playwright';
  if (analysis.supportedRunners.includes('cypress')) return 'cypress';
  return null;
}

function isRunnableGeneratedScenario(scenario: PlannedSmokeScenario, generatedPath: string): boolean {
  // V1 only generates flows that can be tested without inventing selectors,
  // test data, credentials, or app-specific assertions. Other scenarios remain
  // registry-backed stubs until AI/user feedback provides concrete flows.
  if (scenario.id !== '@smoke-app-shell') return false;
  if (scenario.provenance.source !== 'discovered-tag') return true;
  return scenario.sourceTests.every((sourceTest) => toPosix(sourceTest) === generatedPath);
}

function resolveGeneratedSmokePath(repoRoot: string, adapter: 'playwright' | 'cypress'): string {
  if (adapter === 'cypress') {
    return toPosix(path.join('cypress', 'e2e', 'pipelane-smoke.generated.cy.js'));
  }
  if (existsSync(path.join(repoRoot, 'e2e'))) {
    return toPosix(path.join('e2e', 'pipelane-smoke.generated.spec.ts'));
  }
  return toPosix(path.join('tests', 'pipelane-smoke.generated.spec.ts'));
}

function generatedSmokeFilePreamble(adapter: 'playwright' | 'cypress'): string {
  const label = adapter === 'playwright' ? 'Playwright' : 'Cypress';
  return [
    `/* Pipelane generated ${label} smoke tests.`,
    ' * User edits outside pipelane:smoke marker regions are preserved.',
    ' */',
    '',
  ].join('\n');
}

function renderGeneratedSmokeSupport(adapter: 'playwright' | 'cypress'): string {
  if (adapter === 'cypress') {
    return [
      'const pipelaneSmokeChecks = new Map();',
      '',
      'function pipelaneSmokeBaseUrl() {',
      "  return Cypress.env('PIPELANE_SMOKE_BASE_URL') || 'http://127.0.0.1:4173';",
      '}',
      '',
      'function markPipelaneSmokeCheck(tag, status) {',
      '  pipelaneSmokeChecks.set(tag, status);',
      '}',
      '',
      'after(() => {',
      "  const resultsPath = Cypress.env('PIPELANE_SMOKE_RESULTS_PATH');",
      '  if (!resultsPath) return;',
      '  const checks = Array.from(pipelaneSmokeChecks.entries()).map(([tag, status]) => ({ tag, status }));',
      '  cy.writeFile(resultsPath, JSON.stringify({ schemaVersion: 1, checks }, null, 2));',
      '});',
    ].join('\n');
  }
  return [
    "import { test, expect } from '@playwright/test';",
    "import { writeFileSync } from 'node:fs';",
    '',
    "type SmokeStatus = 'passed' | 'failed';",
    'const pipelaneSmokeChecks = new Map<string, SmokeStatus>();',
    "const pipelaneSmokeBaseUrl = process.env.PIPELANE_SMOKE_BASE_URL || 'http://127.0.0.1:4173';",
    '',
    'async function recordPipelaneSmokeCheck(tag: string, body: () => Promise<void>): Promise<void> {',
    "  pipelaneSmokeChecks.set(tag, 'failed');",
    '  try {',
    '    await body();',
    "    pipelaneSmokeChecks.set(tag, 'passed');",
    '  } catch (error) {',
    "    pipelaneSmokeChecks.set(tag, 'failed');",
    '    throw error;',
    '  }',
    '}',
    '',
    'test.afterAll(() => {',
    '  const resultsPath = process.env.PIPELANE_SMOKE_RESULTS_PATH;',
    '  if (!resultsPath) return;',
    '  const checks = Array.from(pipelaneSmokeChecks.entries()).map(([tag, status]) => ({ tag, status }));',
    '  writeFileSync(resultsPath, JSON.stringify({ schemaVersion: 1, checks }, null, 2));',
    '});',
  ].join('\n');
}

function renderGeneratedSmokeScenario(adapter: 'playwright' | 'cypress', scenario: PlannedSmokeScenario): string {
  const title = `${scenario.id} ${scenario.title}`;
  if (adapter === 'cypress') {
    return [
      `it(${jsString(title)}, () => {`,
      `  markPipelaneSmokeCheck(${jsString(scenario.id)}, 'failed');`,
      '  cy.visit(pipelaneSmokeBaseUrl());',
      "  cy.get('body').should('be.visible');",
      `  cy.then(() => markPipelaneSmokeCheck(${jsString(scenario.id)}, 'passed'));`,
      '});',
    ].join('\n');
  }
  return [
    `test(${jsString(title)}, async ({ page }) => {`,
    `  await recordPipelaneSmokeCheck(${jsString(scenario.id)}, async () => {`,
    '    await page.goto(pipelaneSmokeBaseUrl, { waitUntil: \'domcontentloaded\' });',
    "    await expect(page.locator('body')).toBeVisible();",
    '  });',
    '});',
  ].join('\n');
}

export function verifySmokeSetupCommand(options: {
  repoRoot: string;
  logsDir: string;
  command: string;
  baseUrl: string;
  makeBlocking: boolean;
  registry: SmokeRegistryState;
}): SmokeSetupVerificationResult {
  if (!options.command.trim()) {
    return {
      status: 'skipped_no_command',
      checks: [],
      verifiedTags: [],
      blockingTags: [],
      message: 'Verification skipped: no staging smoke command is configured.',
    };
  }
  if (!options.baseUrl.trim()) {
    return {
      status: 'skipped_missing_base_url',
      checks: [],
      verifiedTags: [],
      blockingTags: [],
      message: 'Verification skipped: pass --base-url or configure a staging URL before making hot paths blocking.',
    };
  }

  mkdirSync(options.logsDir, { recursive: true });
  const runId = `setup-${Date.now()}`;
  const logPath = path.join(options.logsDir, `${runId}-verification.log`);
  const resultsPath = path.join(options.logsDir, `${runId}-verification.results.json`);
  const result = runCommandCapture('sh', ['-lc', options.command], {
    cwd: options.repoRoot,
    env: {
      ...process.env,
      PIPELANE_SMOKE_ENV: 'staging',
      PIPELANE_SMOKE_BASE_URL: options.baseUrl,
      PIPELANE_SMOKE_RUN_ID: runId,
      PIPELANE_SMOKE_RESULTS_PATH: resultsPath,
      CYPRESS_PIPELANE_SMOKE_BASE_URL: options.baseUrl,
      CYPRESS_PIPELANE_SMOKE_RUN_ID: runId,
      CYPRESS_PIPELANE_SMOKE_RESULTS_PATH: resultsPath,
    },
  });
  writeFileSync(logPath, `${result.stdout}\n${result.stderr}`.trim() + '\n', 'utf8');

  const checks = readSetupRunnerChecks(resultsPath);
  const hasFailedCheck = checks.some((check) => check.status === 'failed');
  const hasRetryCheck = checks.some((check) => check.status === 'passed_with_retries');
  const cleanPass = result.ok && checks.length > 0 && !hasFailedCheck && !hasRetryCheck;
  const retryPass = result.ok && checks.length > 0 && !hasFailedCheck && hasRetryCheck;
  const verifiedTags = cleanPass ? checks.map((check) => check.tag).filter((tag) => options.registry.checks[tag]) : [];
  const blockingTags = options.makeBlocking ? verifiedTags : [];

  for (const tag of verifiedTags) {
    const entry = options.registry.checks[tag];
    entry.lifecycle = options.makeBlocking ? 'blocking' : 'verified';
    entry.quarantine = options.makeBlocking ? false : entry.quarantine;
    entry.blocking = options.makeBlocking ? true : entry.blocking;
    entry.generated = {
      ...(entry.generated ?? {}),
      status: 'passed',
      verifiedAt: nowIso(),
    };
  }

  const status: SmokeSetupVerificationResult['status'] = cleanPass
    ? 'passed'
    : retryPass
      ? 'passed_with_retries'
      : result.ok && checks.length === 0
        ? 'passed_without_check_results'
        : 'failed';
  const message = formatVerificationMessage({
    status,
    baseUrl: options.baseUrl,
    command: options.command,
    logPath,
    resultsPath,
    checks,
    verifiedTags,
    blockingTags,
  });

  return {
    status,
    runId,
    baseUrl: options.baseUrl,
    command: options.command,
    logPath,
    resultsPath,
    checks,
    verifiedTags,
    blockingTags,
    message,
    aiFixPrompt: status === 'failed'
      ? buildSmokeFailureFixPrompt({
          scenario: 'setup verification',
          command: options.command,
          baseUrl: options.baseUrl,
          logPath,
          resultsPath,
          checks,
        })
      : undefined,
  };
}

export function upsertGeneratedSmokeRegion(source: string, marker: string, body: string): { contents: string; action: 'created' | 'updated' | 'unchanged' } {
  const start = `/* pipelane:smoke:start ${marker} */`;
  const end = `/* pipelane:smoke:end ${marker} */`;
  const startCount = countOccurrences(source, start);
  const endCount = countOccurrences(source, end);
  if (startCount !== endCount || startCount > 1) {
    throw new Error(`Refusing to update generated smoke region "${marker}": missing, duplicate, or malformed markers.`);
  }
  const block = `${start}\n${body.trimEnd()}\n${end}`;
  if (startCount === 0) {
    const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n';
    return { contents: `${source}${separator}${block}\n`, action: 'created' };
  }
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  const afterEnd = endIndex + end.length;
  const next = `${source.slice(0, startIndex)}${block}${source.slice(afterEnd)}`;
  return {
    contents: next,
    action: next === source ? 'unchanged' : 'updated',
  };
}

export function buildSmokeFailureFixPrompt(options: {
  scenario: string;
  command: string;
  baseUrl?: string;
  logPath?: string;
  resultsPath?: string;
  checks?: Array<{ tag: string; status: SmokeRunStatus }>;
}): string {
  const failingChecks = (options.checks ?? [])
    .filter((check) => check.status === 'failed' || check.status === 'passed_with_retries')
    .map((check) => `${check.tag}:${check.status}`)
    .join(', ') || 'unknown';
  return [
    'AI fix prompt:',
    'The smoke hot-path check failed. Please debug and fix the product or test root cause.',
    `Scenario: ${redactSmokeText(options.scenario)}`,
    `Command: ${redactSmokeText(options.command)}`,
    `Target URL: ${redactSmokeText(options.baseUrl ?? 'not provided')}`,
    `Failing checks: ${redactSmokeText(failingChecks)}`,
    `Log path: ${redactSmokeText(options.logPath ?? 'not available')}`,
    `Results path: ${redactSmokeText(options.resultsPath ?? 'not available')}`,
    'Do not weaken or delete the smoke check unless the scenario is no longer a primary user path.',
  ].join('\n');
}

export function redactSmokeText(value: string): string {
  return value
    .replace(/([?&](?:token|key|secret|password|pass|auth|session|cookie)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH_HEADER]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2=[REDACTED]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)\s+("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2 [REDACTED]')
    .replace(/\b((?:token|key|secret|password|pass|session|cookie|api[_-]?key|access[_-]?key)\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|SESSION|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s]+)/g, (match) => {
      const key = match.split('=')[0];
      return `${key}=[REDACTED]`;
    });
}

export function summarizeHotPathPlan(plan: SmokeHotPathPlan): string[] {
  const lines: string[] = [];
  lines.push(`Hot path scenarios: ${plan.scenarios.length}`);
  for (const scenario of plan.scenarios.slice(0, 8)) {
    const env = scenario.requiredEnv.length > 0 ? `; env: ${scenario.requiredEnv.join(', ')}` : '';
    lines.push(`  - ${scenario.title} (${scenario.id}; ${scenario.lifecycle}; ${scenario.provenance.confidence}${env})`);
  }
  if (plan.scenarios.length > 8) {
    lines.push(`  - … ${plan.scenarios.length - 8} more`);
  }
  for (const warning of plan.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines;
}

function scenarioToRegistryEntry(scenario: PlannedSmokeScenario): SmokeRegistryEntry {
  return {
    description: scenario.title,
    blocking: false,
    quarantine: true,
    owner: '',
    escalation: '',
    runbook: '',
    environments: ['staging'],
    surfaces: [scenario.surface],
    sourceTests: scenario.sourceTests,
    lifecycle: scenario.lifecycle,
    safetyFlags: scenario.safetyFlags,
    requiredEnv: scenario.requiredEnv,
    provenance: scenario.provenance,
    generated: scenario.generated,
  };
}

function mergeScenarioIntoEntry(existing: SmokeRegistryEntry, scenario: PlannedSmokeScenario): SmokeRegistryEntry {
  const existingLifecycle = existing.blocking === true && existing.quarantine !== true
    ? 'blocking'
    : existing.quarantine === true && existing.lifecycle === 'blocking'
      ? 'quarantined'
      : existing.lifecycle;
  const nextLifecycle = existingLifecycle && lifecycleRank(existingLifecycle) >= lifecycleRank(scenario.lifecycle)
    ? existingLifecycle
    : scenario.lifecycle;
  return {
    ...existing,
    description: existing.description?.trim() ? existing.description : scenario.title,
    environments: existing.environments?.length ? existing.environments : ['staging'],
    surfaces: mergeSorted(existing.surfaces ?? [], [scenario.surface]),
    sourceTests: mergeSorted(existing.sourceTests ?? [], scenario.sourceTests),
    lifecycle: nextLifecycle,
    safetyFlags: mergeSorted(existing.safetyFlags ?? [], scenario.safetyFlags) as SmokeSafetyFlag[],
    requiredEnv: mergeSorted(existing.requiredEnv ?? [], scenario.requiredEnv),
    provenance: lifecycleRank(scenario.lifecycle) > lifecycleRank(existingLifecycle ?? 'suggested')
      ? scenario.provenance
      : existing.provenance ?? scenario.provenance,
    generated: existing.generated ?? scenario.generated,
  };
}

function stableComparable(entry: SmokeRegistryEntry): SmokeRegistryEntry {
  return {
    ...entry,
    environments: entry.environments?.slice().sort(),
    surfaces: entry.surfaces?.slice().sort(),
    sourceTests: entry.sourceTests?.slice().sort(),
    safetyFlags: entry.safetyFlags?.slice().sort(),
    requiredEnv: entry.requiredEnv?.slice().sort(),
  };
}

function walkTextFiles(
  repoRoot: string,
  options: {
    skippedLargeFiles: string[];
    skippedDirs: Set<string>;
    onFile: (file: WalkedTextFile) => void;
  },
): void {
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(repoRoot, absolute));
      if (entry.isDirectory()) {
        if (EXCLUDED_SCAN_DIRS.has(entry.name)) {
          options.skippedDirs.add(relative || entry.name);
          continue;
        }
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretEnvFile(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      let size = 0;
      try {
        size = statSync(absolute).size;
      } catch {
        continue;
      }
      if (size > MAX_HOT_PATH_SCAN_BYTES) {
        options.skippedLargeFiles.push(relative);
        continue;
      }
      try {
        options.onFile({ relative, absolute, contents: readFileSync(absolute, 'utf8') });
      } catch {
        continue;
      }
    }
  };
  visit(repoRoot);
}

function readPackageInfo(repoRoot: string): {
  scripts: Array<{ name: string; command: string }>;
  dependencies: string[];
  devDependencies: string[];
} {
  const packagePath = path.join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return { scripts: [], dependencies: [], devDependencies: [] };
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return {
      scripts: Object.entries(parsed.scripts ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, command]) => ({ name, command }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      dependencies: Object.keys(parsed.dependencies ?? {}).sort(),
      devDependencies: Object.keys(parsed.devDependencies ?? {}).sort(),
    };
  } catch {
    return { scripts: [], dependencies: [], devDependencies: [] };
  }
}

function collectEnvNames(file: WalkedTextFile, envNames: Set<string>): void {
  if (/\.env(\.example|\.sample|\.template)?$/i.test(file.relative)) {
    for (const match of file.contents.matchAll(/^\s*([A-Z][A-Z0-9_]{1,})\s*=/gm)) {
      envNames.add(match[1]);
    }
  }
  for (const match of file.contents.matchAll(/\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{1,})\b/g)) {
    envNames.add(match[1]);
  }
}

function collectFeatureSignals(file: WalkedTextFile, addSignal: (name: string, evidence: string) => void): void {
  const target = `${file.relative}\n${file.contents.slice(0, MAX_HOT_PATH_SCAN_BYTES)}`.toLowerCase();
  const evidence = file.relative;
  if (/(login|logout|signup|sign-in|sign-up|auth|session|password)/.test(target)) addSignal('auth', evidence);
  if (/(project|workspace)/.test(target)) addSignal('projects', evidence);
  if (/(board|kanban|task card|column)/.test(target)) addSignal('boards', evidence);
  if (/(wiki|knowledge base|knowledge-base|docs page|markdown editor)/.test(target)) addSignal('wiki', evidence);
  if (/(docs|documentation)/.test(target)) addSignal('docs', evidence);
  if (/(openai|anthropic|llm|ai assistant|chat completion|generate text|model:)/.test(target)) addSignal('ai', evidence);
  if (/(settings|preferences|profile|account)/.test(target)) addSignal('settings', evidence);
  if (/(stripe|billing|subscription|checkout|invoice|payment)/.test(target)) addSignal('billing', evidence);
  if (/(cart|product|order|sku|checkout)/.test(target)) addSignal('ecommerce', evidence);
  if (/(canvas|game loop|phaser|three\.|requestanimationframe|score|level)/.test(target)) addSignal('game', evidence);
  if (/(app\/.*page\.tsx|pages\/.*\.(tsx|jsx|vue|svelte)|react|vue|svelte|next)/.test(target)) addSignal('frontend', evidence);
  if (/((app|pages)\/|href=["']\/|to=["']\/|path:\s*["']\/)/.test(target)) addSignal('routes', evidence);
}

function inferRoutes(relative: string, contents: string): string[] {
  const routes = new Set<string>();
  const normalized = toPosix(relative);
  const nextAppMatch = normalized.match(/^(?:src\/)?app\/(.+)\/page\.(tsx|jsx|ts|js)$/);
  if (nextAppMatch) routes.add(routeFromSegments(nextAppMatch[1].split('/')));
  const nextRootAppMatch = normalized.match(/^(?:src\/)?app\/page\.(tsx|jsx|ts|js)$/);
  if (nextRootAppMatch) routes.add('/');
  const pagesMatch = normalized.match(/^(?:src\/)?pages\/(.+)\.(tsx|jsx|ts|js|vue|svelte)$/);
  if (pagesMatch && !pagesMatch[1].startsWith('api/')) {
    routes.add(routeFromSegments(pagesMatch[1].split('/').filter((segment) => segment !== 'index')));
  }
  for (const match of contents.matchAll(/\b(?:href|to|path)\s*[:=]\s*["'](\/[a-zA-Z0-9_./:[\]-]*)["']/g)) {
    routes.add(match[1]);
  }
  return [...routes].filter((route) => route.length > 0).sort();
}

function routeFromSegments(segments: string[]): string {
  const cleaned = segments
    .filter((segment) => segment && !segment.startsWith('(') && !segment.startsWith('@'))
    .map((segment) => segment.replace(/^\[(.+)]$/, ':$1'));
  return cleaned.length === 0 ? '/' : `/${cleaned.join('/')}`;
}

function isTestFile(relative: string): boolean {
  return /(^|\/)(e2e|tests?|spec|cypress|playwright)(\/|$)/i.test(relative)
    || /\.(spec|test)\.[cm]?[jt]sx?$/i.test(relative);
}

function inferAppTypes(
  signals: Map<string, Set<string>>,
  routes: Set<string>,
  packageInfo: ReturnType<typeof readPackageInfo>,
  files: WalkedTextFile[],
): SmokeAppType[] {
  const types = new Set<SmokeAppType>();
  if (signals.has('game')) types.add('game');
  if (signals.has('frontend') || routes.size > 0) {
    types.add(signals.has('auth') || signals.has('projects') || signals.has('settings') ? 'app' : 'website');
  }
  if (signals.has('api') || files.some((file) => /(^|\/)(api|routes|controllers)\//i.test(file.relative))) types.add('api');
  if (types.size === 0 && packageInfo.scripts.length > 0) types.add('library');
  if (types.size === 0) types.add('website');
  return [...types].sort();
}

function detectSupportedRunners(
  scripts: Array<{ name: string; command: string }>,
  dependencies: string[],
  devDependencies: string[],
): Array<'playwright' | 'cypress'> {
  const haystack = [
    ...scripts.flatMap((script) => [script.name, script.command]),
    ...dependencies,
    ...devDependencies,
  ].join('\n').toLowerCase();
  const runners: Array<'playwright' | 'cypress'> = [];
  if (haystack.includes('playwright')) runners.push('playwright');
  if (haystack.includes('cypress')) runners.push('cypress');
  return runners;
}

function hasAnyAppType(analysis: SmokeRepoAnalysis, types: SmokeAppType[]): boolean {
  return types.some((type) => analysis.appTypes.includes(type));
}

function collectEvidence(analysis: SmokeRepoAnalysis, names: string[]): string[] {
  const wanted = new Set(names);
  return analysis.featureSignals
    .filter((signal) => wanted.has(signal.name))
    .flatMap((signal) => signal.evidence.map((entry) => `${signal.name}:${entry}`))
    .slice(0, 6);
}

function pickEnvNames(analysis: SmokeRepoAnalysis, pattern: RegExp, fallback: string[]): string[] {
  const matched = analysis.envNames.filter((name) => pattern.test(name));
  return (matched.length > 0 ? matched : fallback).sort();
}

function inferSurfaceFromTag(tag: string): string {
  const normalized = tag.replace(/^@smoke-/, '');
  if (normalized.includes('auth')) return 'auth';
  if (normalized.includes('wiki')) return 'wiki';
  if (normalized.includes('board') || normalized.includes('project')) return 'projects';
  if (normalized.includes('ai')) return 'ai';
  if (normalized.includes('billing') || normalized.includes('checkout')) return 'checkout';
  if (normalized.includes('game')) return 'gameplay';
  if (normalized.includes('settings')) return 'settings';
  return normalized || 'frontend';
}

function findSourceTestsForSurface(candidateTests: string[], surface: string): string[] {
  const normalized = surface.toLowerCase();
  return candidateTests
    .filter((file) => file.toLowerCase().includes(normalized) || (normalized === 'projects' && /project|board/i.test(file)))
    .slice(0, 3);
}

function scenariosFromFeedback(feedback: string[], analysis: SmokeRepoAnalysis): PlannedSmokeScenario[] {
  const text = feedback.join('\n').trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  const scenarios: PlannedSmokeScenario[] = [];
  const base = {
    lifecycle: 'accepted' as SmokeScenarioLifecycle,
    provenance: {
      source: 'user-feedback' as const,
      confidence: 'high' as SmokeConfidence,
      evidence: ['user feedback supplied during smoke setup'],
      updatedAt: nowIso(),
    },
  };
  const aiEnv = pickEnvNames(analysis, /(OPENAI|ANTHROPIC|AI|LLM|MODEL).*(_KEY|TOKEN|SECRET)?$/i, ['OPENAI_API_KEY']);
  if (/\bai\b|assistant|llm|openai|anthropic/.test(lower)) {
    if (/project|board/.test(lower)) {
      scenarios.push({
        ...base,
        id: '@smoke-ai-project-board',
        title: 'Use AI assistance inside a project board',
        surface: 'ai',
        safetyFlags: ['stagingOnly', 'externalDependency'],
        sourceTests: [],
        requiredEnv: aiEnv,
      });
    }
    if (/wiki|page|docs|document/.test(lower)) {
      scenarios.push({
        ...base,
        id: '@smoke-ai-wiki-page',
        title: 'Use AI assistance inside a wiki page',
        surface: 'ai',
        safetyFlags: ['stagingOnly', 'externalDependency'],
        sourceTests: [],
        requiredEnv: aiEnv,
      });
    }
    if (!/project|board|wiki|page|docs|document/.test(lower)) {
      scenarios.push({
        ...base,
        id: '@smoke-ai-custom-flow',
        title: 'Exercise the requested AI flow',
        surface: 'ai',
        safetyFlags: ['stagingOnly', 'externalDependency'],
        sourceTests: [],
        requiredEnv: aiEnv,
      });
    }
  }
  if (/credential|auth|login|sign in|signin/.test(lower)) {
    scenarios.push({
      ...base,
      id: '@smoke-auth-credentials',
      title: 'Authenticate with smoke credentials and reach a protected area',
      surface: 'auth',
      safetyFlags: ['stagingOnly'],
      sourceTests: [],
      requiredEnv: pickEnvNames(analysis, /^(PIPELANE_SMOKE_|E2E_|TEST_).*(EMAIL|USER|PASSWORD|PASS)$/i, [
        'PIPELANE_SMOKE_USER_EMAIL',
        'PIPELANE_SMOKE_USER_PASSWORD',
      ]),
    });
  }
  if (/create|rename|delete|crud/.test(lower) && /wiki|page/.test(lower)) {
    scenarios.push({
      ...base,
      id: '@smoke-wiki-page-crud',
      title: 'Create, rename, and delete a synthetic wiki page',
      surface: 'wiki',
      safetyFlags: ['stagingOnly', 'requiresSyntheticData'],
      sourceTests: [],
      requiredEnv: [],
    });
  }
  if (/create|delete|crud/.test(lower) && /project|board/.test(lower)) {
    scenarios.push({
      ...base,
      id: '@smoke-project-board-crud',
      title: 'Create a synthetic project board, open it, and delete it',
      surface: 'projects',
      safetyFlags: ['stagingOnly', 'requiresSyntheticData'],
      sourceTests: [],
      requiredEnv: [],
    });
  }
  if (scenarios.length === 0) {
    scenarios.push({
      ...base,
      id: `@smoke-custom-${hashText(lower).slice(0, 8)}`,
      title: 'Exercise the user-requested hot path',
      surface: 'custom',
      safetyFlags: ['stagingOnly'],
      sourceTests: [],
      requiredEnv: [],
    });
  }
  return scenarios;
}

function loadScenarioFile(repoRoot: string, rawPath: string): { scenarios: PlannedSmokeScenario[]; warnings: string[] } {
  const root = path.resolve(repoRoot);
  const targetPath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(repoRoot, rawPath));
  const warnings: string[] = [];
  if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
    return { scenarios: [], warnings: [`Scenario file must live inside the repo: ${rawPath}`] };
  }
  if (!existsSync(targetPath)) {
    return { scenarios: [], warnings: [`Scenario file not found: ${rawPath}`] };
  }
  try {
    const size = statSync(targetPath).size;
    if (size > MAX_SCENARIO_FILE_BYTES) {
      return { scenarios: [], warnings: [`Scenario file is too large: ${rawPath} (${size} bytes > ${MAX_SCENARIO_FILE_BYTES})`] };
    }
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as { scenarios?: unknown } | unknown[];
    const rawScenarios = Array.isArray(parsed) ? parsed : Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
    const scenarios = rawScenarios
      .map((entry) => normalizeScenarioFileEntry(entry))
      .filter((entry): entry is PlannedSmokeScenario => entry !== null);
    return { scenarios, warnings };
  } catch (error) {
    return {
      scenarios: [],
      warnings: [`Scenario file could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function normalizeScenarioFileEntry(entry: unknown): PlannedSmokeScenario | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? normalizeSmokeTag(raw.id)
    : '';
  const title = typeof raw.title === 'string' && raw.title.trim()
    ? raw.title.trim()
    : '';
  if (!id || !title) return null;
  return {
    id,
    title,
    surface: typeof raw.surface === 'string' && raw.surface.trim() ? raw.surface.trim() : inferSurfaceFromTag(id),
    lifecycle: 'accepted',
    safetyFlags: normalizeStringArray(raw.safetyFlags).filter(isSmokeSafetyFlag),
    sourceTests: normalizeStringArray(raw.sourceTests),
    requiredEnv: normalizeEnvNames(raw.requiredEnv),
    provenance: {
      source: 'scenario-file',
      confidence: 'high',
      evidence: ['scenario-file'],
      updatedAt: nowIso(),
    },
  };
}

function normalizeSmokeTag(value: string): string {
  const slug = value
    .trim()
    .replace(/^@?smoke-?/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `@smoke-${slug}` : '';
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()).sort()
    : [];
}

function normalizeEnvNames(value: unknown): string[] {
  return normalizeStringArray(value).filter((entry) => /^[A-Z][A-Z0-9_]*$/.test(entry));
}

function isSmokeSafetyFlag(value: string): value is SmokeSafetyFlag {
  return value === 'readonly'
    || value === 'stagingOnly'
    || value === 'requiresSyntheticData'
    || value === 'externalDependency'
    || value === 'unsafeForAutomation';
}

function dedupeScenarios(scenarios: PlannedSmokeScenario[]): PlannedSmokeScenario[] {
  const merged = new Map<string, PlannedSmokeScenario>();
  for (const scenario of scenarios) {
    const existing = merged.get(scenario.id);
    if (!existing) {
      merged.set(scenario.id, {
        ...scenario,
        safetyFlags: mergeSorted([], scenario.safetyFlags) as SmokeSafetyFlag[],
        sourceTests: mergeSorted([], scenario.sourceTests),
        requiredEnv: mergeSorted([], scenario.requiredEnv),
      });
      continue;
    }
    merged.set(scenario.id, {
      ...existing,
      title: existing.provenance.source === 'user-feedback' ? existing.title : scenario.title,
      lifecycle: lifecycleRank(scenario.lifecycle) > lifecycleRank(existing.lifecycle) ? scenario.lifecycle : existing.lifecycle,
      safetyFlags: mergeSorted(existing.safetyFlags, scenario.safetyFlags) as SmokeSafetyFlag[],
      sourceTests: mergeSorted(existing.sourceTests, scenario.sourceTests),
      requiredEnv: mergeSorted(existing.requiredEnv, scenario.requiredEnv),
      provenance: lifecycleRank(scenario.lifecycle) > lifecycleRank(existing.lifecycle) ? scenario.provenance : existing.provenance,
    });
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function lifecycleRank(lifecycle: SmokeScenarioLifecycle): number {
  return {
    suggested: 1,
    accepted: 2,
    generated: 3,
    verified: 4,
    blocking: 5,
    quarantined: 6,
  }[lifecycle] ?? 0;
}

function mergeSorted<T extends string>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right].filter(Boolean))].sort();
}

function readSetupRunnerChecks(resultsPath: string): Array<{ tag: string; status: SmokeRunStatus }> {
  if (!existsSync(resultsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
      checks?: Array<{ tag?: unknown; status?: unknown }>;
    };
    return (parsed.checks ?? [])
      .filter((entry): entry is { tag: string; status: SmokeRunStatus } =>
        typeof entry.tag === 'string'
        && (entry.status === 'passed' || entry.status === 'failed' || entry.status === 'passed_with_retries'),
      )
      .map((entry) => ({ tag: entry.tag, status: entry.status }));
  } catch {
    return [];
  }
}

function formatVerificationMessage(options: {
  status: SmokeSetupVerificationResult['status'];
  baseUrl: string;
  command: string;
  logPath: string;
  resultsPath: string;
  checks: Array<{ tag: string; status: SmokeRunStatus }>;
  verifiedTags: string[];
  blockingTags: string[];
}): string {
  if (options.status === 'passed') {
    const blocking = options.blockingTags.length > 0 ? ` Blocking enabled: ${options.blockingTags.join(', ')}.` : '';
    return `Verification passed against ${options.baseUrl}. Verified: ${options.verifiedTags.join(', ') || 'check-level results not mapped'}.${blocking}`;
  }
  if (options.status === 'passed_with_retries') {
    return `Verification passed only with retries against ${options.baseUrl}; checks stay non-blocking until they pass cleanly.`;
  }
  if (options.status === 'passed_without_check_results') {
    return `Command passed against ${options.baseUrl}, but no check-level smoke results were emitted at ${options.resultsPath}; no scenario was marked verified or blocking.`;
  }
  return `Verification failed against ${options.baseUrl}; checks stay non-blocking. Log: ${options.logPath}`;
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = source.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function isSecretEnvFile(name: string): boolean {
  return /^\.env($|\.)/i.test(name) && !/(\.example|\.sample|\.template)$/i.test(name);
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}
