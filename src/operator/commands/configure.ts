import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { renderClaudeMdFromTemplate } from '../docs.ts';
import {
  emptyDeployConfig,
  parseDeployConfigMarkdown,
  replaceDeployConfigSection,
  type DeployConfig,
} from '../release-gate.ts';
import {
  CONFIG_FILENAME,
  resolveRepoRoot,
  resolveWorkflowAliases,
  type WorkflowConfig,
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
  frontendStagingReady?: boolean;
  edgeStagingDeployCommand?: string;
  edgeStagingVerificationCommand?: string;
  edgeStagingHealthcheck?: string;
  edgeStagingReady?: boolean;
  edgeProductionDeployCommand?: string;
  edgeProductionVerificationCommand?: string;
  edgeProductionHealthcheck?: string;
  sqlStagingApplyCommand?: string;
  sqlStagingVerificationCommand?: string;
  sqlStagingHealthcheck?: string;
  sqlStagingReady?: boolean;
  sqlProductionApplyCommand?: string;
  sqlProductionVerificationCommand?: string;
  sqlProductionHealthcheck?: string;
  supabaseStagingProjectRef?: string;
  supabaseProductionProjectRef?: string;
}

export interface ConfigureResult {
  repoRoot: string;
  claudePath: string;
  createdClaude: boolean;
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
];

const BOOLEAN_FLAGS: Array<[string, keyof ConfigureOptions]> = [
  ['--frontend-production-auto-deploy-on-main', 'frontendProductionAutoDeployOnMain'],
  ['--frontend-staging-ready', 'frontendStagingReady'],
  ['--edge-staging-ready', 'edgeStagingReady'],
  ['--sql-staging-ready', 'sqlStagingReady'],
];

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

    const matchedBool = BOOLEAN_FLAGS.find(([flag]) => token === flag || token.startsWith(`${flag}=`));
    if (matchedBool) {
      const [flag, key] = matchedBool;
      bag[key] = token === flag ? true : parseBool(token.slice(flag.length + 1), flag);
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
      claudePath: '',
      createdClaude: false,
      config: emptyDeployConfig(),
    };
  }

  const repoRoot = resolveRepoRoot(cwd, true);
  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  let markdown = '';
  let createdClaude = false;
  if (existsSync(claudePath)) {
    markdown = readFileSync(claudePath, 'utf8');
  } else {
    markdown = renderClaudeMdFromTemplate(loadWorkflowConfigOrThrow(repoRoot));
    createdClaude = true;
  }

  // parseDeployConfigMarkdown over the in-memory markdown avoids a second
  // readFileSync(CLAUDE.md) inside release-gate.loadDeployConfig.
  const baseConfig = parseDeployConfigMarkdown(markdown) ?? emptyDeployConfig();
  const flagged = applyFlagOverrides(baseConfig, options);
  const finalConfig = options.json ? flagged : await promptForValues(flagged);

  const nextMarkdown = replaceDeployConfigSection(markdown, finalConfig);
  writeFileSync(claudePath, ensureTrailingNewline(nextMarkdown), 'utf8');

  if (options.json) {
    process.stdout.write(`${JSON.stringify(finalConfig, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Wrote Deploy Configuration to ${claudePath}`,
      createdClaude ? 'Created new CLAUDE.md from workflow template.' : 'Updated the Deploy Configuration block in place.',
    ].join('\n') + '\n');
  }

  return { repoRoot, claudePath, createdClaude, config: finalConfig };
}

// Matches setupConsumerRepo's strict invariant: configure cannot seed a fresh
// CLAUDE.md without a .project-workflow.json to render template variables
// (DISPLAY_NAME, ALIAS_*, DEPLOY_WORKFLOW_NAME) against. An operator who hits
// this error ran configure before init; the fix is to run `pipelane init` first.
function loadWorkflowConfigOrThrow(repoRoot: string): WorkflowConfig {
  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${repoRoot}. Run \`pipelane init\` first to seed CLAUDE.md.`);
  }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as WorkflowConfig;
  return { ...parsed, aliases: resolveWorkflowAliases(parsed.aliases) };
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
  if (options.frontendStagingReady !== undefined) next.frontend.staging.ready = options.frontendStagingReady;
  if (options.edgeStagingDeployCommand !== undefined) next.edge.staging.deployCommand = options.edgeStagingDeployCommand;
  if (options.edgeStagingVerificationCommand !== undefined) next.edge.staging.verificationCommand = options.edgeStagingVerificationCommand;
  if (options.edgeStagingHealthcheck !== undefined) next.edge.staging.healthcheckUrl = options.edgeStagingHealthcheck;
  if (options.edgeStagingReady !== undefined) next.edge.staging.ready = options.edgeStagingReady;
  if (options.edgeProductionDeployCommand !== undefined) next.edge.production.deployCommand = options.edgeProductionDeployCommand;
  if (options.edgeProductionVerificationCommand !== undefined) next.edge.production.verificationCommand = options.edgeProductionVerificationCommand;
  if (options.edgeProductionHealthcheck !== undefined) next.edge.production.healthcheckUrl = options.edgeProductionHealthcheck;
  if (options.sqlStagingApplyCommand !== undefined) next.sql.staging.applyCommand = options.sqlStagingApplyCommand;
  if (options.sqlStagingVerificationCommand !== undefined) next.sql.staging.verificationCommand = options.sqlStagingVerificationCommand;
  if (options.sqlStagingHealthcheck !== undefined) next.sql.staging.healthcheckUrl = options.sqlStagingHealthcheck;
  if (options.sqlStagingReady !== undefined) next.sql.staging.ready = options.sqlStagingReady;
  if (options.sqlProductionApplyCommand !== undefined) next.sql.production.applyCommand = options.sqlProductionApplyCommand;
  if (options.sqlProductionVerificationCommand !== undefined) next.sql.production.verificationCommand = options.sqlProductionVerificationCommand;
  if (options.sqlProductionHealthcheck !== undefined) next.sql.production.healthcheckUrl = options.sqlProductionHealthcheck;
  if (options.supabaseStagingProjectRef !== undefined) next.supabase.staging.projectRef = options.supabaseStagingProjectRef;
  if (options.supabaseProductionProjectRef !== undefined) next.supabase.production.projectRef = options.supabaseProductionProjectRef;
  return next;
}

async function promptForValues(base: DeployConfig): Promise<DeployConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      'Configuring Deploy Configuration block in CLAUDE.md. Press Enter to keep the current value shown in [brackets].\n\n',
    );
    const next: DeployConfig = JSON.parse(JSON.stringify(base));
    next.platform = await promptString(rl, 'Deploy platform (fly.io, vercel, render, ...):', next.platform);

    process.stdout.write('\nFrontend (staging):\n');
    next.frontend.staging.url = await promptString(rl, '  URL:', next.frontend.staging.url);
    next.frontend.staging.deployWorkflow = await promptString(rl, '  Deploy workflow name:', next.frontend.staging.deployWorkflow);
    next.frontend.staging.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.frontend.staging.healthcheckUrl);
    next.frontend.staging.ready = await promptBool(rl, '  Ready flag (legacy):', next.frontend.staging.ready);

    process.stdout.write('\nFrontend (production):\n');
    next.frontend.production.url = await promptString(rl, '  URL:', next.frontend.production.url);
    next.frontend.production.deployWorkflow = await promptString(rl, '  Deploy workflow name:', next.frontend.production.deployWorkflow);
    next.frontend.production.autoDeployOnMain = await promptBool(rl, '  Auto-deploy on main:', next.frontend.production.autoDeployOnMain);
    next.frontend.production.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.frontend.production.healthcheckUrl);

    process.stdout.write('\nEdge (staging):\n');
    next.edge.staging.deployCommand = await promptString(rl, '  Deploy command:', next.edge.staging.deployCommand);
    next.edge.staging.verificationCommand = await promptString(rl, '  Verification command:', next.edge.staging.verificationCommand);
    next.edge.staging.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.edge.staging.healthcheckUrl);
    next.edge.staging.ready = await promptBool(rl, '  Ready flag (legacy):', next.edge.staging.ready);

    process.stdout.write('\nEdge (production):\n');
    next.edge.production.deployCommand = await promptString(rl, '  Deploy command:', next.edge.production.deployCommand);
    next.edge.production.verificationCommand = await promptString(rl, '  Verification command:', next.edge.production.verificationCommand);
    next.edge.production.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.edge.production.healthcheckUrl);

    process.stdout.write('\nSQL (staging):\n');
    next.sql.staging.applyCommand = await promptString(rl, '  Apply command:', next.sql.staging.applyCommand);
    next.sql.staging.verificationCommand = await promptString(rl, '  Verification command:', next.sql.staging.verificationCommand);
    next.sql.staging.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.sql.staging.healthcheckUrl);
    next.sql.staging.ready = await promptBool(rl, '  Ready flag (legacy):', next.sql.staging.ready);

    process.stdout.write('\nSQL (production):\n');
    next.sql.production.applyCommand = await promptString(rl, '  Apply command:', next.sql.production.applyCommand);
    next.sql.production.verificationCommand = await promptString(rl, '  Verification command:', next.sql.production.verificationCommand);
    next.sql.production.healthcheckUrl = await promptString(rl, '  Healthcheck URL:', next.sql.production.healthcheckUrl);

    process.stdout.write('\nSupabase project refs:\n');
    next.supabase.staging.projectRef = await promptString(rl, '  Staging projectRef:', next.supabase.staging.projectRef);
    next.supabase.production.projectRef = await promptString(rl, '  Production projectRef:', next.supabase.production.projectRef);

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

function ensureTrailingNewline(markdown: string): string {
  return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
}

function printUsage(): void {
  process.stdout.write(`pipelane configure — populate the Deploy Configuration block in CLAUDE.md

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
  --frontend-staging-ready[=true|false]
  --edge-staging-deploy-command=<cmd>
  --edge-staging-verification-command=<cmd>
  --edge-staging-healthcheck=<url>
  --edge-staging-ready[=true|false]
  --edge-production-deploy-command=<cmd>
  --edge-production-verification-command=<cmd>
  --edge-production-healthcheck=<url>
  --sql-staging-apply-command=<cmd>
  --sql-staging-verification-command=<cmd>
  --sql-staging-healthcheck=<url>
  --sql-staging-ready[=true|false]
  --sql-production-apply-command=<cmd>
  --sql-production-verification-command=<cmd>
  --sql-production-healthcheck=<url>
  --supabase-staging-project-ref=<ref>
  --supabase-production-project-ref=<ref>

If CLAUDE.md is missing, pipelane configure seeds it from the workflow template
before writing the Deploy Configuration block. Sections outside that block are
left untouched on re-runs.
`);
}
