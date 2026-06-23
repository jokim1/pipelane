import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { renderClaudeMdFromTemplate } from '../docs.ts';
import {
  emptyDeployConfig,
  parseDeployConfigMarkdown,
  replaceDeployConfigSection,
  saveSharedDeployConfig,
  type DeployConfig,
} from '../release-gate.ts';
import {
  loadWorkflowConfig,
  resolveRepoRoot,
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
    // `loadWorkflowConfig` self-heals from defaults + `package.json:pipelane`
    // overlay when `.pipelane.json` is absent, so `configure` now works on
    // overlay-only consumers without needing `pipelane init` first.
    markdown = renderClaudeMdFromTemplate(loadWorkflowConfig(repoRoot));
    createdClaude = true;
  }

  // parseDeployConfigMarkdown over the in-memory markdown avoids a second
  // readFileSync(CLAUDE.md) inside release-gate.loadDeployConfig.
  const baseConfig = parseDeployConfigMarkdown(markdown) ?? emptyDeployConfig();
  const flagged = applyFlagOverrides(baseConfig, options);
  if (!options.json && !process.stdin.isTTY) {
    process.stdout.write(renderNonInteractiveConfigurePrompt(repoRoot, claudePath, createdClaude, flagged));
    process.exitCode = 64;
    return { repoRoot, claudePath, createdClaude, config: flagged };
  }
  const finalConfig = options.json ? flagged : await promptForValues(flagged);

  // Temp-file-and-rename keeps CLAUDE.md atomic: a crash mid-write can't
  // leave a truncated file that later bricks parseDeployConfigMarkdown for
  // every other command.
  const tmpPath = `${claudePath}.pipelane.tmp`;
  writeFileSync(tmpPath, ensureTrailingNewline(replaceDeployConfigSection(markdown, finalConfig)), 'utf8');
  renameSync(tmpPath, claudePath);
  saveSharedDeployConfig(repoRoot, finalConfig);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(finalConfig, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Wrote Deploy Configuration to ${claudePath}`,
      createdClaude ? 'Created new CLAUDE.md from the Pipelane template.' : 'Updated the Deploy Configuration block in place.',
    ].join('\n') + '\n');
  }

  return { repoRoot, claudePath, createdClaude, config: finalConfig };
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
  return next;
}

interface ConfigurePromptSection {
  heading: string;
  fields: Array<{ label: string; flag: string; value: string | boolean }>;
}

function renderNonInteractiveConfigurePrompt(
  repoRoot: string,
  claudePath: string,
  createdClaude: boolean,
  config: DeployConfig,
): string {
  const sections = configurePromptSections(config);
  const lines = [
    'Pipelane configure needs deploy values, but this shell is non-interactive.',
    `Repo: ${repoRoot}`,
    `CLAUDE.md: ${claudePath}${createdClaude ? ' (will be created when values are saved)' : ''}`,
    '',
    'Current Deploy Configuration:',
  ];

  for (const section of sections) {
    lines.push('', `${section.heading}:`);
    for (const field of section.fields) {
      lines.push(`- ${field.label}: ${formatConfigurePromptValue(field.value)} (${field.flag})`);
    }
  }

  lines.push(
    '',
    'Choose the action to take:',
    '1. Reply with deploy values in chat; I will run /pipelane configure --json with the matching flags.',
    '2. Refresh generated setup files first: /pipelane setup --yes',
    '3. Cancel.',
    '',
    'Command shape for option 1:',
    '/pipelane configure --json \\',
    '  --platform=<value> \\',
    '  --frontend-staging-url=<url> \\',
    '  --frontend-production-url=<url>',
    '',
    'Any omitted field keeps its current value.',
  );

  return `${lines.join('\n')}\n`;
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
    {
      heading: 'Supabase',
      fields: [
        { label: 'staging project ref', flag: '--supabase-staging-project-ref=<ref>', value: config.supabase.staging.projectRef },
        { label: 'production project ref', flag: '--supabase-production-project-ref=<ref>', value: config.supabase.production.projectRef },
      ],
    },
  ];
}

function formatConfigurePromptValue(value: string | boolean): string {
  if (typeof value === 'boolean') {
    return String(value);
  }
  return value.trim() ? value : '<empty>';
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

If CLAUDE.md is missing, pipelane configure seeds it from the Pipelane template
before writing the Deploy Configuration block. Sections outside that block are
left untouched on re-runs.
`);
}
