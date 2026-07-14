import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { loadConfiguredDeploySurfaceContracts } from '../deploy-surface-contract.ts';
import {
  additionalDeploySurfaceNames,
  emptyAdditionalDeploySurfaceConfig,
  emptyDeployConfig,
  isReleaseManagedSurface,
  loadDeployConfig,
  resolveSharedDeployConfigPath,
  saveSharedDeployConfig,
  type DeployConfig,
} from '../release-gate.ts';
import {
  loadWorkflowConfig,
  normalizeRouteSafetyConfig,
  patchReadableWorkflowConfig,
  resolveRepoRoot,
  type RouteSafetyConfig,
} from '../state.ts';

export interface ConfigureOptions {
  json: boolean;
  help: boolean;
  platform?: string;
  frontendProductionUrl?: string;
  frontendProductionWorkflow?: string;
  frontendProductionAutoDeployOnMain?: boolean;
  frontendProductionHealthcheck?: string;
  frontendStagingUrl?: string;
  frontendStagingWorkflow?: string;
  frontendStagingHealthcheck?: string;
  edgeStagingDeployCommand?: string;
  edgeStagingVerificationCommand?: string;
  edgeStagingHealthcheck?: string;
  edgeProductionDeployCommand?: string;
  edgeProductionVerificationCommand?: string;
  edgeProductionHealthcheck?: string;
  sqlStagingApplyCommand?: string;
  sqlStagingVerificationCommand?: string;
  sqlStagingHealthcheck?: string;
  sqlProductionApplyCommand?: string;
  sqlProductionVerificationCommand?: string;
  sqlProductionHealthcheck?: string;
  supabaseStagingProjectRef?: string;
  supabaseProductionProjectRef?: string;
  mcpStagingDeployCommand?: string;
  mcpStagingVerificationCommand?: string;
  mcpStagingHealthcheck?: string;
  mcpProductionDeployCommand?: string;
  mcpProductionVerificationCommand?: string;
  mcpProductionHealthcheck?: string;
  surfaceStagingDeployCommands?: Record<string, string>;
  surfaceStagingVerificationCommands?: Record<string, string>;
  surfaceStagingHealthchecks?: Record<string, string>;
  surfaceProductionDeployCommands?: Record<string, string>;
  surfaceProductionVerificationCommands?: Record<string, string>;
  surfaceProductionHealthchecks?: Record<string, string>;
}

export interface ConfigureResult {
  repoRoot: string;
  configPath: string;
  config: DeployConfig;
}

const STRING_FLAGS: Array<[string, keyof ConfigureOptions]> = [
  ['--platform', 'platform'],
  ['--frontend-production-url', 'frontendProductionUrl'],
  ['--frontend-production-workflow', 'frontendProductionWorkflow'],
  ['--frontend-production-healthcheck', 'frontendProductionHealthcheck'],
  ['--frontend-staging-url', 'frontendStagingUrl'],
  ['--frontend-staging-workflow', 'frontendStagingWorkflow'],
  ['--frontend-staging-healthcheck', 'frontendStagingHealthcheck'],
  ['--edge-staging-deploy-command', 'edgeStagingDeployCommand'],
  ['--edge-staging-verification-command', 'edgeStagingVerificationCommand'],
  ['--edge-staging-healthcheck', 'edgeStagingHealthcheck'],
  ['--edge-production-deploy-command', 'edgeProductionDeployCommand'],
  ['--edge-production-verification-command', 'edgeProductionVerificationCommand'],
  ['--edge-production-healthcheck', 'edgeProductionHealthcheck'],
  ['--sql-staging-apply-command', 'sqlStagingApplyCommand'],
  ['--sql-staging-verification-command', 'sqlStagingVerificationCommand'],
  ['--sql-staging-healthcheck', 'sqlStagingHealthcheck'],
  ['--sql-production-apply-command', 'sqlProductionApplyCommand'],
  ['--sql-production-verification-command', 'sqlProductionVerificationCommand'],
  ['--sql-production-healthcheck', 'sqlProductionHealthcheck'],
  ['--supabase-staging-project-ref', 'supabaseStagingProjectRef'],
  ['--supabase-production-project-ref', 'supabaseProductionProjectRef'],
  ['--mcp-staging-deploy-command', 'mcpStagingDeployCommand'],
  ['--mcp-staging-verification-command', 'mcpStagingVerificationCommand'],
  ['--mcp-staging-healthcheck', 'mcpStagingHealthcheck'],
  ['--mcp-production-deploy-command', 'mcpProductionDeployCommand'],
  ['--mcp-production-verification-command', 'mcpProductionVerificationCommand'],
  ['--mcp-production-healthcheck', 'mcpProductionHealthcheck'],
];

type SurfaceOverrideKey =
  | 'surfaceStagingDeployCommands'
  | 'surfaceStagingVerificationCommands'
  | 'surfaceStagingHealthchecks'
  | 'surfaceProductionDeployCommands'
  | 'surfaceProductionVerificationCommands'
  | 'surfaceProductionHealthchecks';

const SURFACE_STRING_FLAGS: Array<[string, SurfaceOverrideKey]> = [
  ['--surface-staging-deploy-command', 'surfaceStagingDeployCommands'],
  ['--surface-staging-verification-command', 'surfaceStagingVerificationCommands'],
  ['--surface-staging-healthcheck', 'surfaceStagingHealthchecks'],
  ['--surface-production-deploy-command', 'surfaceProductionDeployCommands'],
  ['--surface-production-verification-command', 'surfaceProductionVerificationCommands'],
  ['--surface-production-healthcheck', 'surfaceProductionHealthchecks'],
];

const BOOLEAN_FLAGS: Array<[string, keyof ConfigureOptions]> = [
  ['--frontend-production-auto-deploy-on-main', 'frontendProductionAutoDeployOnMain'],
];

// v1.2: --frontend-staging-ready / --edge-staging-ready / --sql-staging-ready
// were removed when release readiness stopped reading the `.ready` boolean.
// Scripts that still pass the flags get a clear error instead of a silently
// ignored value.
const REMOVED_BOOLEAN_FLAGS = new Set<string>([
  '--frontend-staging-ready',
  '--edge-staging-ready',
  '--sql-staging-ready',
]);

export function parseConfigureArgs(argv: string[]): ConfigureOptions {
  const options: ConfigureOptions = { json: false, help: false };

  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }

    const bag = options as unknown as Record<string, unknown>;

    const removedMatch = [...REMOVED_BOOLEAN_FLAGS].find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (removedMatch) {
      throw new Error([
        `Flag ${removedMatch} was removed in v1.2.`,
        'Release readiness now derives from observed staging deploys + a fresh /doctor --probe.',
        'Drop the flag from your script; no replacement needed.',
      ].join('\n'));
    }

    const matchedBool = BOOLEAN_FLAGS.find(([flag]) => token === flag || token.startsWith(`${flag}=`));
    if (matchedBool) {
      const [flag, key] = matchedBool;
      bag[key] = token === flag ? true : parseBool(token.slice(flag.length + 1), flag);
      continue;
    }

    const matchedSurfaceStr = SURFACE_STRING_FLAGS.find(([flag]) => token === flag || token.startsWith(`${flag}=`));
    if (matchedSurfaceStr) {
      const [flag, key] = matchedSurfaceStr;
      if (token === flag) {
        throw new Error(`Flag ${flag} requires a value (use ${flag}=surface:value).`);
      }
      setSurfaceOverride(options, key, token.slice(flag.length + 1), flag);
      continue;
    }

    const matchedStr = STRING_FLAGS.find(([flag]) => token === flag || token.startsWith(`${flag}=`));
    if (matchedStr) {
      const [flag, key] = matchedStr;
      if (token === flag) {
        throw new Error(`Flag ${flag} requires a value (use ${flag}=value).`);
      }
      bag[key] = token.slice(flag.length + 1);
      continue;
    }

    throw new Error(`Unknown flag for pipelane configure: ${token}`);
  }

  return options;
}

function setSurfaceOverride(
  options: ConfigureOptions,
  key: SurfaceOverrideKey,
  raw: string,
  flag: string,
): void {
  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new Error(`Flag ${flag} expects surface:value, got: ${raw}`);
  }
  const surface = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1);
  if (!surface) {
    throw new Error(`Flag ${flag} expects a non-empty surface name.`);
  }
  if (isReleaseManagedSurface(surface)) {
    throw new Error(`Flag ${flag} is for custom surfaces. Use the dedicated ${surface} flags instead.`);
  }
  const bucket = options[key] ?? {};
  options[key] = bucket;
  bucket[surface] = value;
}

function parseBool(value: string, flag: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Flag ${flag} expects true/false, got: ${value}`);
}

export async function handleConfigure(cwd: string, argv: string[]): Promise<ConfigureResult> {
  const options = parseConfigureArgs(argv);
  if (options.help) {
    printUsage();
    return {
      repoRoot: '',
      configPath: '',
      config: emptyDeployConfig(),
    };
  }

  const repoRoot = resolveRepoRoot(cwd, true);
  const workflowConfig = loadWorkflowConfig(repoRoot);
  const configPath = resolveSharedDeployConfigPath(repoRoot);
  const loadedConfig = loadDeployConfig(repoRoot) ?? emptyDeployConfig();
  const surfaceContracts = loadConfiguredDeploySurfaceContracts(repoRoot, workflowConfig, loadedConfig);
  const contractIssues = surfaceContracts.flatMap((contract) => contract.issues);
  if (contractIssues.length) {
    throw new Error([
      'Configure blocked: a deploy surface contract is invalid.',
      ...contractIssues.map((issue) => `- ${issue}`),
      'Repair the repo-owned deploy surface contract before configuring deployment.',
    ].join('\n'));
  }
  const baseConfig = registerContractCustomSurfaces(
    loadedConfig,
    [...new Set(surfaceContracts.flatMap((contract) => contract.surfaces))],
  );
  const flagged = applyFlagOverrides(baseConfig, options);
  const detection = options.json
    ? { signals: [], values: [], questions: [] }
    : detectConfigureHints(repoRoot, flagged);
  if (!options.json && !process.stdin.isTTY) {
    process.stdout.write(renderNonInteractiveConfigurePrompt(repoRoot, configPath, flagged, workflowConfig.routeSafety, detection));
    process.exitCode = 64;
    return { repoRoot, configPath, config: flagged };
  }
  const finalConfig = options.json ? flagged : await promptForValues(applyDetectedConfigureValues(flagged, detection), workflowConfig.routeSafety);

  saveSharedDeployConfig(repoRoot, finalConfig);
  syncAdditionalWorkflowSurfaces(repoRoot, finalConfig);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(finalConfig, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Wrote machine-local Deploy Configuration to ${configPath}`,
      'No application repo files were created or modified.',
      ...routeSafetyDefaultLines(workflowConfig.routeSafety),
    ].join('\n') + '\n');
  }

  return { repoRoot, configPath, config: finalConfig };
}

function registerContractCustomSurfaces(base: DeployConfig, surfaces: string[]): DeployConfig {
  const next: DeployConfig = JSON.parse(JSON.stringify(base));
  for (const surface of surfaces) {
    if (!isReleaseManagedSurface(surface)) ensureAdditionalDeploySurface(next, surface);
  }
  return next;
}

function syncAdditionalWorkflowSurfaces(repoRoot: string, deployConfig: DeployConfig): void {
  const additionalSurfaces = additionalDeploySurfaceNames(deployConfig);
  if (additionalSurfaces.length === 0) return;
  patchReadableWorkflowConfig(repoRoot, (raw) => {
    const configured = Array.isArray(raw.surfaces)
      ? raw.surfaces.filter((surface): surface is string => typeof surface === 'string' && surface.trim().length > 0)
      : [];
    return {
      ...raw,
      surfaces: [...new Set([...configured, ...additionalSurfaces])],
    };
  });
}

function applyFlagOverrides(base: DeployConfig, options: ConfigureOptions): DeployConfig {
  const next: DeployConfig = JSON.parse(JSON.stringify(base));
  if (options.platform !== undefined) next.platform = options.platform;
  if (options.frontendProductionUrl !== undefined) next.frontend.production.url = options.frontendProductionUrl;
  if (options.frontendProductionWorkflow !== undefined) next.frontend.production.deployWorkflow = options.frontendProductionWorkflow;
  if (options.frontendProductionAutoDeployOnMain !== undefined) next.frontend.production.autoDeployOnMain = options.frontendProductionAutoDeployOnMain;
  if (options.frontendProductionHealthcheck !== undefined) next.frontend.production.healthcheckUrl = options.frontendProductionHealthcheck;
  if (options.frontendStagingUrl !== undefined) next.frontend.staging.url = options.frontendStagingUrl;
  if (options.frontendStagingWorkflow !== undefined) next.frontend.staging.deployWorkflow = options.frontendStagingWorkflow;
  if (options.frontendStagingHealthcheck !== undefined) next.frontend.staging.healthcheckUrl = options.frontendStagingHealthcheck;
  if (options.edgeStagingDeployCommand !== undefined) next.edge.staging.deployCommand = options.edgeStagingDeployCommand;
  if (options.edgeStagingVerificationCommand !== undefined) next.edge.staging.verificationCommand = options.edgeStagingVerificationCommand;
  if (options.edgeStagingHealthcheck !== undefined) next.edge.staging.healthcheckUrl = options.edgeStagingHealthcheck;
  if (options.edgeProductionDeployCommand !== undefined) next.edge.production.deployCommand = options.edgeProductionDeployCommand;
  if (options.edgeProductionVerificationCommand !== undefined) next.edge.production.verificationCommand = options.edgeProductionVerificationCommand;
  if (options.edgeProductionHealthcheck !== undefined) next.edge.production.healthcheckUrl = options.edgeProductionHealthcheck;
  if (options.sqlStagingApplyCommand !== undefined) next.sql.staging.applyCommand = options.sqlStagingApplyCommand;
  if (options.sqlStagingVerificationCommand !== undefined) next.sql.staging.verificationCommand = options.sqlStagingVerificationCommand;
  if (options.sqlStagingHealthcheck !== undefined) next.sql.staging.healthcheckUrl = options.sqlStagingHealthcheck;
  if (options.sqlProductionApplyCommand !== undefined) next.sql.production.applyCommand = options.sqlProductionApplyCommand;
  if (options.sqlProductionVerificationCommand !== undefined) next.sql.production.verificationCommand = options.sqlProductionVerificationCommand;
  if (options.sqlProductionHealthcheck !== undefined) next.sql.production.healthcheckUrl = options.sqlProductionHealthcheck;
  if (options.supabaseStagingProjectRef !== undefined) next.supabase.staging.projectRef = options.supabaseStagingProjectRef;
  if (options.supabaseProductionProjectRef !== undefined) next.supabase.production.projectRef = options.supabaseProductionProjectRef;
  const mcp = hasMcpOverrides(options) ? ensureAdditionalDeploySurface(next, 'mcp') : null;
  if (mcp) {
    if (options.mcpStagingDeployCommand !== undefined) mcp.staging.deployCommand = options.mcpStagingDeployCommand;
    if (options.mcpStagingVerificationCommand !== undefined) mcp.staging.verificationCommand = options.mcpStagingVerificationCommand;
    if (options.mcpStagingHealthcheck !== undefined) mcp.staging.healthcheckUrl = options.mcpStagingHealthcheck;
    if (options.mcpProductionDeployCommand !== undefined) mcp.production.deployCommand = options.mcpProductionDeployCommand;
    if (options.mcpProductionVerificationCommand !== undefined) mcp.production.verificationCommand = options.mcpProductionVerificationCommand;
    if (options.mcpProductionHealthcheck !== undefined) mcp.production.healthcheckUrl = options.mcpProductionHealthcheck;
  }
  applySurfaceOverrides(next, options);
  return next;
}

function hasMcpOverrides(options: ConfigureOptions): boolean {
  return options.mcpStagingDeployCommand !== undefined
    || options.mcpStagingVerificationCommand !== undefined
    || options.mcpStagingHealthcheck !== undefined
    || options.mcpProductionDeployCommand !== undefined
    || options.mcpProductionVerificationCommand !== undefined
    || options.mcpProductionHealthcheck !== undefined;
}

function ensureAdditionalDeploySurface(config: DeployConfig, surface: string) {
  config.surfaces ??= {};
  config.surfaces[surface] ??= emptyAdditionalDeploySurfaceConfig();
  return config.surfaces[surface];
}

function applySurfaceOverrides(config: DeployConfig, options: ConfigureOptions): void {
  for (const [surface, value] of Object.entries(options.surfaceStagingDeployCommands ?? {})) {
    ensureAdditionalDeploySurface(config, surface).staging.deployCommand = value;
  }
  for (const [surface, value] of Object.entries(options.surfaceStagingVerificationCommands ?? {})) {
    ensureAdditionalDeploySurface(config, surface).staging.verificationCommand = value;
  }
  for (const [surface, value] of Object.entries(options.surfaceStagingHealthchecks ?? {})) {
    ensureAdditionalDeploySurface(config, surface).staging.healthcheckUrl = value;
  }
  for (const [surface, value] of Object.entries(options.surfaceProductionDeployCommands ?? {})) {
    ensureAdditionalDeploySurface(config, surface).production.deployCommand = value;
  }
  for (const [surface, value] of Object.entries(options.surfaceProductionVerificationCommands ?? {})) {
    ensureAdditionalDeploySurface(config, surface).production.verificationCommand = value;
  }
  for (const [surface, value] of Object.entries(options.surfaceProductionHealthchecks ?? {})) {
    ensureAdditionalDeploySurface(config, surface).production.healthcheckUrl = value;
  }
}

interface ConfigurePromptSection {
  heading: string;
  fields: Array<{ label: string; flag: string; value: string | boolean }>;
}

interface DetectedConfigureValue {
  label: string;
  flag: string;
  value: string;
  reason: string;
}

interface ConfigureDetection {
  signals: string[];
  values: DetectedConfigureValue[];
  questions: string[];
}

function renderNonInteractiveConfigurePrompt(
  repoRoot: string,
  configPath: string,
  config: DeployConfig,
  routeSafety: RouteSafetyConfig,
  detection: ConfigureDetection,
): string {
  const sections = configurePromptSections(config);
  const lines = [
    'Pipelane configure needs deploy values, but this shell is non-interactive.',
    `Repo: ${repoRoot}`,
    `Machine-local deploy config: ${configPath}`,
    '',
    'Current Deploy Configuration:',
  ];

  for (const section of sections) {
    lines.push('', `${section.heading}:`);
    for (const field of section.fields) {
      lines.push(`- ${field.label}: ${formatConfigurePromptValue(field.value)} (${field.flag})`);
    }
  }

  if (detection.signals.length > 0) {
    lines.push('', 'Detected repo signals:');
    for (const signal of detection.signals) {
      lines.push(`- ${signal}`);
    }
  }

  if (detection.values.length > 0) {
    lines.push('', 'Detected values Pipelane can save now:');
    for (const value of detection.values) {
      lines.push(`- ${value.label}: ${formatConfigurePromptValue(value.value)} (${formatFlagAssignment(value.flag, value.value)}; ${value.reason})`);
    }
  }

  if (detection.questions.length > 0) {
    lines.push('', 'Release-mode questions still needing an operator answer:');
    for (const question of detection.questions) {
      lines.push(`- ${question}`);
    }
  }

  lines.push('', 'Delivery loop safety defaults:', ...routeSafetyDefaultLines(routeSafety).map((line) => `- ${line}`));

  lines.push(
    '',
    'Choose the action to take:',
    detection.values.length > 0
      ? '1. Save the detected values now with /pipelane configure --json and the flags shown below.'
      : '1. Reply with only the deploy values you have; I will run /pipelane configure --json with matching flags.',
    '2. Add release-mode values such as staging/prod URLs, deploy workflows, or project refs.',
    '3. Stay in build mode for now; staging and production values can be added later.',
    '4. Inspect current setup separately: /pipelane setup',
    '5. Cancel.',
    '',
    ...formatSuggestedConfigureCommand(detection.values),
    detection.values.length > 0 ? '' : 'Example command shape:',
    detection.values.length > 0 ? '' : '/pipelane configure --json \\',
    detection.values.length > 0 ? '' : '  --platform=<value> \\',
    detection.values.length > 0 ? '' : '  --frontend-production-url=<url>',
    'Any omitted field keeps its current value.',
  );

  return `${lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')}\n`;
}

function detectConfigureHints(repoRoot: string, config: DeployConfig): ConfigureDetection {
  const packages = readPackageInfos(repoRoot);
  const signals: string[] = [];
  const values: DetectedConfigureValue[] = [];
  const questions: string[] = [];

  const addValue = (label: string, flag: string, value: string, current: string, reason: string) => {
    if (!value.trim() || current.trim()) return;
    if (values.some((entry) => entry.flag === flag)) return;
    values.push({ label, flag, value, reason });
  };

  const cloudflare = detectCloudflare(repoRoot, packages);
  if (cloudflare.detected) {
    if (cloudflare.workerDetected) {
      signals.push(`Cloudflare Workers: ${summarizeSources(cloudflare.sources)}`);
      addValue('platform', '--platform', 'cloudflare-workers', config.platform, 'Cloudflare Worker config or tooling detected');
      const productionUrl = choosePrimaryDetectedUrl(cloudflare.productionUrls);
      const stagingUrl = choosePrimaryDetectedUrl(cloudflare.stagingUrls);
      if (productionUrl) {
        addValue('frontend production URL', '--frontend-production-url', productionUrl.url, config.frontend.production.url, `from ${productionUrl.source}`);
      }
      if (stagingUrl) {
        addValue('frontend staging URL', '--frontend-staging-url', stagingUrl.url, config.frontend.staging.url, `from ${stagingUrl.source}`);
      }
      if (productionUrl && !config.edge.production.healthcheckUrl.trim()) {
        addValue('edge production healthcheck', '--edge-production-healthcheck', productionUrl.url, config.edge.production.healthcheckUrl, 'Cloudflare Worker serves the public route');
      }
      if (stagingUrl && !config.edge.staging.healthcheckUrl.trim()) {
        addValue('edge staging healthcheck', '--edge-staging-healthcheck', stagingUrl.url, config.edge.staging.healthcheckUrl, 'Cloudflare Worker serves the staging route');
      }
      const productionDeploy = findPackageScriptCommand(packages, cloudflare.packageDirs, ['deploy:production', 'deploy:prod', 'deploy'], /wrangler\s+deploy/);
      const stagingDeploy = findPackageScriptCommand(packages, cloudflare.packageDirs, ['deploy:staging', 'deploy:stage', 'deploy:preview'], /wrangler\s+deploy/);
      if (productionDeploy) {
        addValue('edge production deploy command', '--edge-production-deploy-command', productionDeploy, config.edge.production.deployCommand, 'wrangler deploy script detected');
      }
      if (stagingDeploy) {
        addValue('edge staging deploy command', '--edge-staging-deploy-command', stagingDeploy, config.edge.staging.deployCommand, 'staging wrangler deploy script detected');
      }

      if (!config.frontend.staging.url.trim() && !stagingUrl) {
        questions.push('Cloudflare staging: do you already have a staging Worker route or preview URL? If not, stay in build mode and add it when release mode starts.');
      }
      if (!config.frontend.production.url.trim() && !productionUrl) {
        questions.push('Cloudflare production: which custom domain or workers.dev URL should Pipelane probe after deploy?');
      }
      if (!config.edge.staging.deployCommand.trim() && !stagingDeploy) {
        questions.push('Cloudflare staging deploy: which workflow or wrangler command deploys the staging Worker, once staging exists?');
      }
    } else {
      signals.push(`Cloudflare account keys: ${summarizeSources(cloudflare.sources)}`);
      questions.push('Cloudflare account keys: env keys were found, but no Worker config or wrangler deploy script was detected. If release mode uses Cloudflare, provide the deploy platform and URLs when ready.');
    }
  }

  const supabase = detectSupabase(repoRoot, packages);
  if (supabase.detected) {
    signals.push(`Supabase: ${summarizeSources(supabase.sources)}`);
    if (!config.supabase.staging.projectRef.trim() || !config.supabase.production.projectRef.trim()) {
      questions.push('Supabase project refs: which project ref is staging, and which is production?');
    }
    if (supabase.hasFunctions && (!config.edge.staging.deployCommand.trim() || !config.edge.production.deployCommand.trim())) {
      questions.push('Supabase edge functions: which CLI commands deploy staging and production functions?');
    }
    if (supabase.hasMigrations && (!config.sql.staging.applyCommand.trim() || !config.sql.production.applyCommand.trim())) {
      questions.push('Supabase database migrations: which commands apply staging and production schema changes?');
    }
  }

  const neon = detectNeon(repoRoot, packages);
  if (neon.detected) {
    signals.push(`Neon/Postgres: ${summarizeSources(neon.sources)}`);
    if (neon.hasMigrations && (!config.sql.staging.applyCommand.trim() || !config.sql.production.applyCommand.trim())) {
      questions.push('Neon/Postgres migrations: if SQL is a release-managed surface, what commands apply staging and production migrations?');
    }
  }

  if (signals.length === 0) {
    questions.push('No deploy platform was detected from common config files. Provide the platform and URLs/workflows when you are ready to configure release mode.');
  }

  return {
    signals: dedupeStrings(signals),
    values,
    questions: dedupeStrings(questions),
  };
}

function applyDetectedConfigureValues(base: DeployConfig, detection: ConfigureDetection): DeployConfig {
  const next: DeployConfig = JSON.parse(JSON.stringify(base));
  for (const value of detection.values) {
    if (value.flag === '--platform') next.platform = value.value;
    else if (value.flag === '--frontend-production-url') next.frontend.production.url = value.value;
    else if (value.flag === '--frontend-staging-url') next.frontend.staging.url = value.value;
    else if (value.flag === '--edge-production-healthcheck') next.edge.production.healthcheckUrl = value.value;
    else if (value.flag === '--edge-staging-healthcheck') next.edge.staging.healthcheckUrl = value.value;
    else if (value.flag === '--edge-production-deploy-command') next.edge.production.deployCommand = value.value;
    else if (value.flag === '--edge-staging-deploy-command') next.edge.staging.deployCommand = value.value;
  }
  return next;
}

interface PackageInfo {
  dir: string;
  relativeDir: string;
  relativePath: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

interface DetectedUrl {
  url: string;
  source: string;
}

interface CloudflareDetection {
  detected: boolean;
  workerDetected: boolean;
  sources: string[];
  packageDirs: string[];
  productionUrls: DetectedUrl[];
  stagingUrls: DetectedUrl[];
}

function detectCloudflare(repoRoot: string, packages: PackageInfo[]): CloudflareDetection {
  const wranglerFiles = findRepoFiles(repoRoot, (name) =>
    name === 'wrangler.toml' || name === 'wrangler.json' || name === 'wrangler.jsonc'
  );
  const envSignals = findEnvKeySignals(repoRoot, /^CLOUDFLARE_/);
  const packageSignals = packages.flatMap((info) => {
    const hasCloudflareDep = Object.keys(info.dependencies).some((name) =>
      name === 'wrangler' || name.startsWith('@cloudflare/')
    );
    const hasWranglerScript = Object.values(info.scripts).some((script) => /\bwrangler\b/.test(script));
    return hasCloudflareDep || hasWranglerScript ? [info.relativePath] : [];
  });
  const productionUrls: DetectedUrl[] = [];
  const stagingUrls: DetectedUrl[] = [];
  const packageDirs = new Set<string>();

  for (const file of wranglerFiles) {
    const relativePath = displayPath(repoRoot, file);
    packageDirs.add(path.dirname(file));
    const routes = readWranglerRoutes(repoRoot, file);
    for (const route of routes) {
      if (route.environment === 'staging') {
        stagingUrls.push({ url: route.url, source: relativePath });
      } else {
        productionUrls.push({ url: route.url, source: relativePath });
      }
    }
  }

  const workerSources = [
    ...wranglerFiles.map((file) => displayPath(repoRoot, file)),
    ...packageSignals,
  ];
  const sources = [
    ...workerSources,
    ...envSignals,
  ];
  return {
    detected: sources.length > 0,
    workerDetected: workerSources.length > 0,
    sources: dedupeStrings(sources),
    packageDirs: [...packageDirs],
    productionUrls,
    stagingUrls,
  };
}

interface ProviderDetection {
  detected: boolean;
  sources: string[];
  hasFunctions?: boolean;
  hasMigrations?: boolean;
}

function detectSupabase(repoRoot: string, packages: PackageInfo[]): ProviderDetection {
  const supabaseFiles = findRepoFiles(repoRoot, (_name, file) => file.split(path.sep).includes('supabase'));
  const envSignals = findEnvKeySignals(repoRoot, /^SUPABASE_/);
  const packageSignals = packages.flatMap((info) => {
    const hasSupabaseDep = Object.keys(info.dependencies).some((name) => name.startsWith('@supabase/'));
    const hasSupabaseScript = Object.values(info.scripts).some((script) => /\bsupabase\b/.test(script));
    return hasSupabaseDep || hasSupabaseScript ? [info.relativePath] : [];
  });
  const hasFunctions = existsSync(path.join(repoRoot, 'supabase', 'functions'))
    || supabaseFiles.some((file) => file.includes(`${path.sep}supabase${path.sep}functions${path.sep}`));
  const hasMigrations = existsSync(path.join(repoRoot, 'supabase', 'migrations'))
    || supabaseFiles.some((file) => file.includes(`${path.sep}supabase${path.sep}migrations${path.sep}`));
  const sources = [
    ...supabaseFiles.slice(0, 4).map((file) => displayPath(repoRoot, file)),
    ...packageSignals,
    ...envSignals,
  ];
  return {
    detected: sources.length > 0,
    sources: dedupeStrings(sources),
    hasFunctions,
    hasMigrations,
  };
}

function detectNeon(repoRoot: string, packages: PackageInfo[]): ProviderDetection {
  const envSignals = findEnvKeySignals(repoRoot, /^(DATABASE_URL|NEON_)/);
  const packageSignals = packages.flatMap((info) =>
    Object.keys(info.dependencies).some((name) => name === '@neondatabase/serverless')
      ? [info.relativePath]
      : []
  );
  const migrationFiles = findRepoFiles(repoRoot, (_name, file) =>
    file.includes(`${path.sep}db${path.sep}migrations${path.sep}`)
  );
  const providerSources = [
    ...packageSignals,
    ...envSignals,
  ];
  const migrationSources = migrationFiles.slice(0, 3).map((file) => displayPath(repoRoot, file));
  const sources = [
    ...providerSources,
    ...(providerSources.length > 0 ? migrationSources : []),
  ];
  return {
    detected: providerSources.length > 0,
    sources: dedupeStrings(sources),
    hasMigrations: migrationFiles.length > 0,
  };
}

function readPackageInfos(repoRoot: string): PackageInfo[] {
  return findRepoFiles(repoRoot, (name) => name === 'package.json')
    .map((file): PackageInfo | null => {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        const scripts = stringRecord(parsed.scripts);
        const dependencies = {
          ...stringRecord(parsed.dependencies),
          ...stringRecord(parsed.devDependencies),
          ...stringRecord(parsed.optionalDependencies),
        };
        return {
          dir: path.dirname(file),
          relativeDir: displayPath(repoRoot, path.dirname(file)),
          relativePath: displayPath(repoRoot, file),
          scripts,
          dependencies,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is PackageInfo => Boolean(entry));
}

function findPackageScriptCommand(
  packages: PackageInfo[],
  preferredDirs: string[],
  scriptNames: string[],
  commandPattern: RegExp,
): string {
  const preferred = new Set(preferredDirs.map((entry) => path.resolve(entry)));
  const ordered = [...packages].sort((a, b) => {
    const aPreferred = preferred.has(path.resolve(a.dir)) ? 0 : 1;
    const bPreferred = preferred.has(path.resolve(b.dir)) ? 0 : 1;
    return aPreferred - bPreferred || a.relativePath.localeCompare(b.relativePath);
  });
  for (const scriptName of scriptNames) {
    for (const info of ordered) {
      const script = info.scripts[scriptName];
      if (!script || !commandPattern.test(script)) continue;
      const prefix = info.relativeDir === '.' ? '' : `cd ${quoteShellWord(info.relativeDir)} && `;
      return `${prefix}npm run ${scriptName}`;
    }
  }
  return '';
}

function readWranglerRoutes(repoRoot: string, file: string): Array<{ url: string; environment: 'production' | 'staging' }> {
  try {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.json') || file.endsWith('.jsonc')) {
      const parsed = parseJsonLike(text);
      if (isRecord(parsed)) return collectWranglerRoutesFromObject(parsed);
    }
    return collectWranglerRoutesFromText(repoRoot, file, text);
  } catch {
    return [];
  }
}

function collectWranglerRoutesFromObject(
  raw: Record<string, unknown>,
  envName = '',
): Array<{ url: string; environment: 'production' | 'staging' }> {
  const routes: Array<{ url: string; environment: 'production' | 'staging' }> = [];
  const addRoute = (pattern: string) => {
    const url = normalizeRoutePatternToUrl(pattern);
    if (!url) return;
    routes.push({
      url,
      environment: isStagingName(envName) || isStagingName(pattern) ? 'staging' : 'production',
    });
  };

  if (typeof raw.route === 'string') addRoute(raw.route);
  if (typeof raw.routes === 'string') addRoute(raw.routes);
  if (Array.isArray(raw.routes)) {
    for (const entry of raw.routes) {
      if (typeof entry === 'string') addRoute(entry);
      else if (isRecord(entry) && typeof entry.pattern === 'string') addRoute(entry.pattern);
    }
  }

  if (isRecord(raw.env)) {
    for (const [name, envConfig] of Object.entries(raw.env)) {
      if (isRecord(envConfig)) {
        routes.push(...collectWranglerRoutesFromObject(envConfig, name));
      }
    }
  }
  return routes;
}

function collectWranglerRoutesFromText(
  repoRoot: string,
  file: string,
  text: string,
): Array<{ url: string; environment: 'production' | 'staging' }> {
  const routes: Array<{ url: string; environment: 'production' | 'staging' }> = [];
  const routePattern = /^\s*(?:route|pattern)\s*=\s*["']([^"']+)["']/gm;
  for (const match of text.matchAll(routePattern)) {
    const url = normalizeRoutePatternToUrl(match[1]);
    if (!url) continue;
    routes.push({
      url,
      environment: isStagingName(match[1]) || isStagingName(displayPath(repoRoot, file)) ? 'staging' : 'production',
    });
  }
  return routes;
}

function parseJsonLike(text: string): unknown {
  const withoutComments = stripJsonComments(text);
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

function stripJsonComments(text: string): string {
  let output = '';
  let inString = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] ?? '';

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function normalizeRoutePatternToUrl(pattern: string): string {
  let cleaned = pattern.trim();
  if (!cleaned) return '';
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  cleaned = cleaned.replace(/\/.*$/, '');
  cleaned = cleaned.replace(/^\*\./, '');
  cleaned = cleaned.replace(/\*.*$/, '');
  cleaned = cleaned.replace(/\.$/, '');
  if (!cleaned || cleaned.includes('*') || cleaned.includes('{')) return '';
  return `https://${cleaned}`;
}

function choosePrimaryDetectedUrl(values: DetectedUrl[]): DetectedUrl | null {
  const unique = new Map<string, DetectedUrl>();
  for (const value of values) {
    if (!unique.has(value.url)) unique.set(value.url, value);
  }
  return [...unique.values()].sort((a, b) => {
    const aWww = a.url.includes('://www.') ? 1 : 0;
    const bWww = b.url.includes('://www.') ? 1 : 0;
    return aWww - bWww || a.url.length - b.url.length || a.url.localeCompare(b.url);
  })[0] ?? null;
}

function findEnvKeySignals(repoRoot: string, pattern: RegExp): string[] {
  return findRepoFiles(repoRoot, (name) => name === '.env' || name.startsWith('.env.'))
    .flatMap((file) => {
      try {
        const keys = readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] ?? '')
          .filter((key) => key && pattern.test(key))
          .sort();
        return keys.length > 0 ? [`${displayPath(repoRoot, file)} keys ${keys.join(', ')}`] : [];
      } catch {
        return [];
      }
    });
}

function findRepoFiles(
  repoRoot: string,
  predicate: (name: string, file: string) => boolean,
  maxDepth = 4,
): string[] {
  const results: string[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', 'build', '.turbo']);
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (predicate(entry.name, full)) results.push(full);
    }
  };
  walk(repoRoot, 0);
  return results.sort();
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStagingName(value: string): boolean {
  return /(^|[.\-_/])(staging|stage|preview|dev)([.\-_/]|$)/i.test(value);
}

function displayPath(repoRoot: string, targetPath: string): string {
  const relative = path.relative(repoRoot, targetPath) || '.';
  return relative.split(path.sep).join('/');
}

function summarizeSources(sources: string[]): string {
  const unique = dedupeStrings(sources);
  if (unique.length <= 4) return unique.join(', ');
  return `${unique.slice(0, 4).join(', ')}, +${unique.length - 4} more`;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function formatSuggestedConfigureCommand(values: DetectedConfigureValue[]): string[] {
  if (values.length === 0) return [];
  const lines = ['Suggested command for option 1:', '/pipelane configure --json \\'];
  values.forEach((value, index) => {
    const suffix = index === values.length - 1 ? '' : ' \\';
    lines.push(`  ${formatFlagAssignment(value.flag, value.value)}${suffix}`);
  });
  return lines;
}

function formatFlagAssignment(flag: string, value: string): string {
  return `${flag}=${quoteConfigureFlagValue(value)}`;
}

function quoteConfigureFlagValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : JSON.stringify(value);
}

function quoteShellWord(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function configurePromptSections(config: DeployConfig): ConfigurePromptSection[] {
  return [
    {
      heading: 'Platform',
      fields: [
        { label: 'platform', flag: '--platform=<value>', value: config.platform },
      ],
    },
    {
      heading: 'Frontend staging',
      fields: [
        { label: 'url', flag: '--frontend-staging-url=<url>', value: config.frontend.staging.url },
        { label: 'deploy workflow', flag: '--frontend-staging-workflow=<name>', value: config.frontend.staging.deployWorkflow },
        { label: 'healthcheck', flag: '--frontend-staging-healthcheck=<url>', value: config.frontend.staging.healthcheckUrl },
      ],
    },
    {
      heading: 'Frontend production',
      fields: [
        { label: 'url', flag: '--frontend-production-url=<url>', value: config.frontend.production.url },
        { label: 'deploy workflow', flag: '--frontend-production-workflow=<name>', value: config.frontend.production.deployWorkflow },
        { label: 'auto-deploy on main', flag: '--frontend-production-auto-deploy-on-main=<true|false>', value: config.frontend.production.autoDeployOnMain },
        { label: 'healthcheck', flag: '--frontend-production-healthcheck=<url>', value: config.frontend.production.healthcheckUrl },
      ],
    },
    {
      heading: 'Edge staging',
      fields: [
        { label: 'deploy command', flag: '--edge-staging-deploy-command=<cmd>', value: config.edge.staging.deployCommand },
        { label: 'verification command', flag: '--edge-staging-verification-command=<cmd>', value: config.edge.staging.verificationCommand },
        { label: 'healthcheck', flag: '--edge-staging-healthcheck=<url>', value: config.edge.staging.healthcheckUrl },
      ],
    },
    {
      heading: 'Edge production',
      fields: [
        { label: 'deploy command', flag: '--edge-production-deploy-command=<cmd>', value: config.edge.production.deployCommand },
        { label: 'verification command', flag: '--edge-production-verification-command=<cmd>', value: config.edge.production.verificationCommand },
        { label: 'healthcheck', flag: '--edge-production-healthcheck=<url>', value: config.edge.production.healthcheckUrl },
      ],
    },
    {
      heading: 'SQL staging',
      fields: [
        { label: 'apply command', flag: '--sql-staging-apply-command=<cmd>', value: config.sql.staging.applyCommand },
        { label: 'verification command', flag: '--sql-staging-verification-command=<cmd>', value: config.sql.staging.verificationCommand },
        { label: 'healthcheck', flag: '--sql-staging-healthcheck=<url>', value: config.sql.staging.healthcheckUrl },
      ],
    },
    {
      heading: 'SQL production',
      fields: [
        { label: 'apply command', flag: '--sql-production-apply-command=<cmd>', value: config.sql.production.applyCommand },
        { label: 'verification command', flag: '--sql-production-verification-command=<cmd>', value: config.sql.production.verificationCommand },
        { label: 'healthcheck', flag: '--sql-production-healthcheck=<url>', value: config.sql.production.healthcheckUrl },
      ],
    },
    ...additionalSurfacePromptSections(config),
    {
      heading: 'Supabase',
      fields: [
        { label: 'staging project ref', flag: '--supabase-staging-project-ref=<ref>', value: config.supabase.staging.projectRef },
        { label: 'production project ref', flag: '--supabase-production-project-ref=<ref>', value: config.supabase.production.projectRef },
      ],
    },
  ];
}

function additionalSurfacePromptSections(config: DeployConfig): ConfigurePromptSection[] {
  return additionalDeploySurfaceNames(config).flatMap((surface) => {
    const entry = config.surfaces[surface];
    return [
      {
        heading: `${surface} staging`,
        fields: [
          { label: 'deploy command', flag: additionalSurfaceFlag(surface, 'staging', 'deploy-command', '<cmd>'), value: entry.staging.deployCommand },
          { label: 'verification command', flag: additionalSurfaceFlag(surface, 'staging', 'verification-command', '<cmd>'), value: entry.staging.verificationCommand },
          { label: 'healthcheck', flag: additionalSurfaceFlag(surface, 'staging', 'healthcheck', '<url>'), value: entry.staging.healthcheckUrl },
        ],
      },
      {
        heading: `${surface} production`,
        fields: [
          { label: 'deploy command', flag: additionalSurfaceFlag(surface, 'production', 'deploy-command', '<cmd>'), value: entry.production.deployCommand },
          { label: 'verification command', flag: additionalSurfaceFlag(surface, 'production', 'verification-command', '<cmd>'), value: entry.production.verificationCommand },
          { label: 'healthcheck', flag: additionalSurfaceFlag(surface, 'production', 'healthcheck', '<url>'), value: entry.production.healthcheckUrl },
        ],
      },
    ];
  });
}

function additionalSurfaceFlag(
  surface: string,
  environment: 'staging' | 'production',
  field: 'deploy-command' | 'verification-command' | 'healthcheck',
  placeholder: string,
): string {
  if (surface === 'mcp') {
    return `--mcp-${environment}-${field}=${placeholder}`;
  }
  return `--surface-${environment}-${field}=${surface}:${placeholder}`;
}

function formatConfigurePromptValue(value: string | boolean): string {
  if (typeof value === 'boolean') {
    return String(value);
  }
  return value.trim() ? value : '<empty>';
}

async function promptForValues(base: DeployConfig, routeSafety: RouteSafetyConfig): Promise<DeployConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      'Configuring machine-local deploy settings. Press Enter to keep the current value shown in [brackets].\n\n',
    );
    process.stdout.write(['Delivery loop safety defaults:', ...routeSafetyDefaultLines(routeSafety).map((line) => `- ${line}`), ''].join('\n') + '\n');
    const next: DeployConfig = JSON.parse(JSON.stringify(base));
    next.platform = await promptString(rl, 'Deploy platform (fly.io, vercel, render, ...):', next.platform);

    process.stdout.write('\nFrontend (staging):\n');
    next.frontend.staging.url = await promptString(rl, '  URL:', next.frontend.staging.url);
    next.frontend.staging.deployWorkflow = await promptString(rl, '  Deploy workflow name:', next.frontend.staging.deployWorkflow);
    next.frontend.staging.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.frontend.staging.healthcheckUrl);

    process.stdout.write('\nFrontend (production):\n');
    next.frontend.production.url = await promptString(rl, '  URL:', next.frontend.production.url);
    next.frontend.production.deployWorkflow = await promptString(rl, '  Deploy workflow name:', next.frontend.production.deployWorkflow);
    next.frontend.production.autoDeployOnMain = await promptBool(rl, '  Auto-deploy on main:', next.frontend.production.autoDeployOnMain);
    next.frontend.production.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.frontend.production.healthcheckUrl);

    process.stdout.write('\nEdge (staging):\n');
    next.edge.staging.deployCommand = await promptString(rl, '  Deploy command:', next.edge.staging.deployCommand);
    next.edge.staging.verificationCommand = await promptString(rl, '  Verification command:', next.edge.staging.verificationCommand);
    next.edge.staging.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.edge.staging.healthcheckUrl);

    process.stdout.write('\nEdge (production):\n');
    next.edge.production.deployCommand = await promptString(rl, '  Deploy command:', next.edge.production.deployCommand);
    next.edge.production.verificationCommand = await promptString(rl, '  Verification command:', next.edge.production.verificationCommand);
    next.edge.production.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.edge.production.healthcheckUrl);

    process.stdout.write('\nSQL (staging):\n');
    next.sql.staging.applyCommand = await promptString(rl, '  Apply command:', next.sql.staging.applyCommand);
    next.sql.staging.verificationCommand = await promptString(rl, '  Verification command:', next.sql.staging.verificationCommand);
    next.sql.staging.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.sql.staging.healthcheckUrl);

    process.stdout.write('\nSQL (production):\n');
    next.sql.production.applyCommand = await promptString(rl, '  Apply command:', next.sql.production.applyCommand);
    next.sql.production.verificationCommand = await promptString(rl, '  Verification command:', next.sql.production.verificationCommand);
    next.sql.production.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.sql.production.healthcheckUrl);

    process.stdout.write('\nSupabase project refs:\n');
    next.supabase.staging.projectRef = await promptString(rl, '  Staging projectRef:', next.supabase.staging.projectRef);
    next.supabase.production.projectRef = await promptString(rl, '  Production projectRef:', next.supabase.production.projectRef);

    for (const surface of additionalDeploySurfaceNames(next)) {
      const entry = next.surfaces[surface];
      process.stdout.write(`\n${surface} (staging):\n`);
      entry.staging.deployCommand = await promptString(rl, '  Deploy command:', entry.staging.deployCommand);
      entry.staging.verificationCommand = await promptString(rl, '  Verification command:', entry.staging.verificationCommand);
      entry.staging.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', entry.staging.healthcheckUrl);

      process.stdout.write(`\n${surface} (production):\n`);
      entry.production.deployCommand = await promptString(rl, '  Deploy command:', entry.production.deployCommand);
      entry.production.verificationCommand = await promptString(rl, '  Verification command:', entry.production.verificationCommand);
      entry.production.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', entry.production.healthcheckUrl);
    }

    return next;
  } finally {
    rl.close();
  }
}

async function promptString(rl: readline.Interface, prompt: string, current: string): Promise<string> {
  const display = current ? ` [${current}]` : '';
  const answer = (await rl.question(`${prompt}${display} `)).trim();
  return answer === '' ? current : answer;
}

async function promptBool(rl: readline.Interface, prompt: string, current: boolean): Promise<boolean> {
  const display = current ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${prompt} [${display}] `)).trim().toLowerCase();
  if (answer === '') return current;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  return current;
}

function routeSafetyDefaultLines(routeSafety: RouteSafetyConfig): string[] {
  const resolved = normalizeRouteSafetyConfig(routeSafety);
  return [
    `Default fix/review loops: ${resolved.defaultFixReviewLoops}`,
    `Default time limit: ${resolved.defaultMinutes} minutes`,
    `Default AI review runs: ${resolved.defaultAiReviewRuns}`,
    `Stop on major findings: ${resolved.stopOnMajorFindings ? 'yes' : 'no'}`,
  ];
}

function printUsage(): void {
  process.stdout.write(`pipelane configure — save machine-local deploy configuration

Usage:
  pipelane configure                 Interactive prompts for every field
  pipelane configure --json [flags]  Non-interactive; emits the final DeployConfig JSON

Flags (all optional; any omitted field keeps its current value):
  --platform=<value>
  --frontend-production-url=<url>
  --frontend-production-workflow=<name>
  --frontend-production-auto-deploy-on-main[=true|false]
  --frontend-production-healthcheck=<url>
  --frontend-staging-url=<url>
  --frontend-staging-workflow=<name>
  --frontend-staging-healthcheck=<url>
  --edge-staging-deploy-command=<cmd>
  --edge-staging-verification-command=<cmd>
  --edge-staging-healthcheck=<url>
  --edge-production-deploy-command=<cmd>
  --edge-production-verification-command=<cmd>
  --edge-production-healthcheck=<url>
  --sql-staging-apply-command=<cmd>
  --sql-staging-verification-command=<cmd>
  --sql-staging-healthcheck=<url>
  --sql-production-apply-command=<cmd>
  --sql-production-verification-command=<cmd>
  --sql-production-healthcheck=<url>
  --supabase-staging-project-ref=<ref>
  --supabase-production-project-ref=<ref>
  --mcp-staging-deploy-command=<cmd>
  --mcp-staging-verification-command=<cmd>
  --mcp-staging-healthcheck=<url>
  --mcp-production-deploy-command=<cmd>
  --mcp-production-verification-command=<cmd>
  --mcp-production-healthcheck=<url>
  --surface-staging-deploy-command=<surface>:<cmd>
  --surface-staging-verification-command=<surface>:<cmd>
  --surface-staging-healthcheck=<surface>:<url>
  --surface-production-deploy-command=<surface>:<cmd>
  --surface-production-verification-command=<surface>:<cmd>
  --surface-production-healthcheck=<surface>:<url>

Delivery loop safety defaults:
  Default fix/review loops: 1
  Default time limit: 90 minutes
  Default AI review runs: 1
  Stop on major findings: yes

Pipelane stores deploy configuration in machine-local Pipelane state and does
not create or modify application repo files.
`);
}
