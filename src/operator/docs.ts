import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkflowConfig } from './state.ts';
import {
  aliasCommandName,
  CONFIG_FILENAME,
  defaultWorkflowConfig,
  inferProjectKey,
  readJsonFile,
  resolveRepoRoot,
  resolveWorkflowAliases,
  runGit,
  WORKFLOW_COMMANDS,
  type WorkflowCommand,
  writeJsonFile,
  writeWorkflowConfig,
} from './state.ts';
import { emptyDeployConfig, renderDeployConfigSection } from './release-gate.ts';
import { installCodexWrappers } from './codex-install.ts';

const README_MARKER_START = '<!-- workflow-kit:readme:start -->';
const README_MARKER_END = '<!-- workflow-kit:readme:end -->';
const CONTRIBUTING_MARKER_START = '<!-- workflow-kit:contributing:start -->';
const CONTRIBUTING_MARKER_END = '<!-- workflow-kit:contributing:end -->';
const AGENTS_MARKER_START = '<!-- workflow-kit:agents:start -->';
const AGENTS_MARKER_END = '<!-- workflow-kit:agents:end -->';
const CLAUDE_COMMAND_MARKER = '<!-- workflow-kit:command:';
const MANAGED_CLAUDE_COMMANDS_FILENAME = '.workflow-kit-managed.json';
const LEGACY_CLAUDE_SIGNATURES: Record<WorkflowCommand, string[]> = {
  clean: [
    'Report workflow cleanup status and prune stale task locks when requested.',
    'npm run workflow:clean -- <args-from-user>',
  ],
  deploy: [
    'Deploy the merged SHA for this repo.',
    'npm run workflow:deploy -- <args-from-user>',
  ],
  devmode: [
    "Switch or check the repo's development mode (build or release).",
    'npm run workflow:devmode -- <args-from-user>',
  ],
  merge: [
    "Merge the current task's pull request.",
    'npm run workflow:merge -- <args-from-user>',
  ],
  new: [
    'Create a fresh task workspace for this repo.',
    'npm run workflow:new -- <args-from-user>',
  ],
  pr: [
    'Prepare and open, or update, a pull request for the current task.',
    'npm run workflow:pr -- <args-from-user>',
  ],
  resume: [
    'Resume an existing task workspace for this repo.',
    'npm run workflow:resume -- <args-from-user>',
  ],
};

function kitRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function templatePath(relativePath: string): string {
  return path.join(kitRoot(), 'templates', relativePath);
}

function readTemplate(relativePath: string): string {
  return readFileSync(templatePath(relativePath), 'utf8');
}

function managedClaudeCommandsPath(commandsDir: string): string {
  return path.join(commandsDir, MANAGED_CLAUDE_COMMANDS_FILENAME);
}

function renderTemplate(template: string, config: WorkflowConfig): string {
  const aliases = resolveWorkflowAliases(config.aliases);
  const replacements: Record<string, string> = {
    PROJECT_KEY: config.projectKey,
    DISPLAY_NAME: config.displayName,
    BASE_BRANCH: config.baseBranch,
    STATE_DIR: config.stateDir,
    TASK_WORKTREE_DIR_NAME: config.taskWorktreeDirName,
    DEPLOY_WORKFLOW_NAME: config.deployWorkflowName,
    SURFACES_CSV: config.surfaces.join(', '),
    PREPR_CHECKS_BULLETS: config.prePrChecks.map((entry) => `- \`${entry}\``).join('\n'),
    ALIAS_DEVMODE: aliases.devmode,
    ALIAS_NEW: aliases.new,
    ALIAS_RESUME: aliases.resume,
    ALIAS_PR: aliases.pr,
    ALIAS_MERGE: aliases.merge,
    ALIAS_DEPLOY: aliases.deploy,
    ALIAS_CLEAN: aliases.clean,
  };

  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    template,
  );
}

function detectLegacyClaudeCommand(content: string): WorkflowCommand | null {
  for (const command of WORKFLOW_COMMANDS) {
    const signatures = LEGACY_CLAUDE_SIGNATURES[command];
    if (signatures.every((signature) => content.includes(signature))) {
      return command;
    }
  }

  return null;
}

function isManagedClaudeCommand(filename: string, content: string): boolean {
  if (content.includes(CLAUDE_COMMAND_MARKER)) {
    return true;
  }

  return detectLegacyClaudeCommand(content) !== null;
}

function loadManagedClaudeCommands(commandsDir: string): Set<string> {
  const managed = new Set<string>();
  const manifest = readJsonFile(managedClaudeCommandsPath(commandsDir), { files: [] as string[] });

  if (!existsSync(commandsDir)) {
    return managed;
  }

  for (const entry of manifest.files) {
    const targetPath = path.join(commandsDir, entry);
    if (!existsSync(targetPath)) {
      continue;
    }
    if (isManagedClaudeCommand(entry, readFileSync(targetPath, 'utf8'))) {
      managed.add(entry);
    }
  }

  for (const entry of readdirSync(commandsDir)) {
    if (!entry.endsWith('.md')) {
      continue;
    }

    const targetPath = path.join(commandsDir, entry);
    const content = readFileSync(targetPath, 'utf8');
    if (isManagedClaudeCommand(entry, content)) {
      managed.add(entry);
    }
  }

  return managed;
}

function assertNoClaudeCollisions(commandsDir: string, desiredFiles: Set<string>, managedFiles: Set<string>): void {
  for (const entry of desiredFiles) {
    const targetPath = path.join(commandsDir, entry);
    if (existsSync(targetPath) && !managedFiles.has(entry)) {
      throw new Error(
        `Claude command alias collision: ${targetPath} already exists and is not managed by workflow-kit. Choose a different alias in .project-workflow.json or rename the conflicting command.`,
      );
    }
  }
}

function pruneManagedClaudeCommands(commandsDir: string, desiredFiles: Set<string>, managedFiles: Set<string>): void {
  for (const entry of managedFiles) {
    if (!desiredFiles.has(entry)) {
      const targetPath = path.join(commandsDir, entry);
      if (existsSync(targetPath) && isManagedClaudeCommand(entry, readFileSync(targetPath, 'utf8'))) {
        unlinkSync(targetPath);
      }
    }
  }
}

function saveManagedClaudeCommands(commandsDir: string, desiredFiles: Set<string>): void {
  writeJsonFile(managedClaudeCommandsPath(commandsDir), {
    files: [...desiredFiles].sort(),
  });
}

function replaceMarkedSection(targetPath: string, startMarker: string, endMarker: string, rendered: string, defaultHeading = ''): void {
  const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const section = `${startMarker}\n${rendered.trimEnd()}\n${endMarker}`;

  if (existing.includes(startMarker) && existing.includes(endMarker)) {
    const updated = existing.replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`), section);
    writeFileSync(targetPath, updated, 'utf8');
    return;
  }

  const prefix = existing.trimEnd();
  const heading = prefix ? '\n\n' : defaultHeading;
  writeFileSync(targetPath, `${prefix}${heading}${section}\n`, 'utf8');
}

export function ensurePackageScripts(repoRoot: string): void {
  const targetPath = path.join(repoRoot, 'package.json');
  const current = existsSync(targetPath)
    ? JSON.parse(readFileSync(targetPath, 'utf8')) as Record<string, unknown>
    : { name: path.basename(repoRoot), private: true, type: 'module', scripts: {} as Record<string, string> };

  // Dual-name scripts: pipelane:* is canonical, workflow:* kept as a
  // deprecation alias so existing muscle memory + Claude command files keep
  // working through one release window after the rename.
  const scripts = {
    ...(typeof current.scripts === 'object' && current.scripts ? current.scripts as Record<string, string> : {}),
    'pipelane:setup': 'pipelane setup',
    'pipelane:devmode': 'pipelane run devmode',
    'pipelane:new': 'pipelane run new',
    'pipelane:resume': 'pipelane run resume',
    'pipelane:pr': 'pipelane run pr',
    'pipelane:merge': 'pipelane run merge',
    'pipelane:release-check': 'pipelane run release-check',
    'pipelane:task-lock': 'pipelane run task-lock',
    'pipelane:deploy': 'pipelane run deploy',
    'pipelane:clean': 'pipelane run clean',
    'pipelane:board': 'pipelane board',
    'pipelane:update': 'pipelane update',
    'pipelane:api': 'pipelane run api',
    'workflow:api': 'pipelane run api',
    'workflow:setup': 'pipelane setup',
    'workflow:devmode': 'pipelane run devmode',
    'workflow:new': 'pipelane run new',
    'workflow:resume': 'pipelane run resume',
    'workflow:pr': 'pipelane run pr',
    'workflow:merge': 'pipelane run merge',
    'workflow:release-check': 'pipelane run release-check',
    'workflow:task-lock': 'pipelane run task-lock',
    'workflow:deploy': 'pipelane run deploy',
    'workflow:clean': 'pipelane run clean',
    'workflow:pipelane': 'pipelane board',
  };

  const next = {
    ...current,
    scripts,
  };

  writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export function syncConsumerDocs(repoRoot: string, config: WorkflowConfig): void {
  const commandsDir = path.join(repoRoot, '.claude', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  mkdirSync(path.join(repoRoot, 'workflow'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

  const aliases = resolveWorkflowAliases(config.aliases);
  const managedCommandFiles = loadManagedClaudeCommands(commandsDir);
  const desiredCommandFiles = new Set<string>();
  for (const name of WORKFLOW_COMMANDS) {
    const commandFilename = `${aliasCommandName(aliases[name])}.md`;
    desiredCommandFiles.add(commandFilename);
  }
  assertNoClaudeCollisions(commandsDir, desiredCommandFiles, managedCommandFiles);
  pruneManagedClaudeCommands(commandsDir, desiredCommandFiles, managedCommandFiles);
  for (const name of WORKFLOW_COMMANDS) {
    const rendered = renderTemplate(readTemplate(`.claude/commands/${name}.md`), config);
    const commandFilename = `${aliasCommandName(aliases[name])}.md`;
    writeFileSync(path.join(commandsDir, commandFilename), rendered, 'utf8');
  }
  saveManagedClaudeCommands(commandsDir, desiredCommandFiles);

  // pipelane.md is not a workflow command (it opens the board, not a
  // task-flow step), so it is not aliased and sits outside the managed set.
  // Always regenerate it from the template; collision guard ignores it.
  writeFileSync(
    path.join(commandsDir, 'pipelane.md'),
    renderTemplate(readTemplate('.claude/commands/pipelane.md'), config),
    'utf8',
  );

  writeFileSync(
    path.join(repoRoot, 'workflow', 'CLAUDE.template.md'),
    renderTemplate(readTemplate('workflow/CLAUDE.template.md'), config),
    'utf8',
  );

  writeFileSync(
    path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md'),
    renderTemplate(readTemplate('docs/RELEASE_WORKFLOW.md'), config),
    'utf8',
  );

  replaceMarkedSection(
    path.join(repoRoot, 'README.md'),
    README_MARKER_START,
    README_MARKER_END,
    renderTemplate(readTemplate('README.workflow-section.md'), config),
    `# ${config.displayName}\n\n`,
  );

  replaceMarkedSection(
    path.join(repoRoot, 'CONTRIBUTING.md'),
    CONTRIBUTING_MARKER_START,
    CONTRIBUTING_MARKER_END,
    renderTemplate(readTemplate('CONTRIBUTING.workflow-section.md'), config),
    '# Contributing\n\n',
  );

  replaceMarkedSection(
    path.join(repoRoot, 'AGENTS.md'),
    AGENTS_MARKER_START,
    AGENTS_MARKER_END,
    renderTemplate(readTemplate('AGENTS.md'), config),
    `# ${config.displayName} Repo Context\n\n`,
  );

  ensurePackageScripts(repoRoot);
}

export function initConsumerRepo(cwd: string, projectName: string): { repoRoot: string; configPath: string } {
  const repoRoot = resolveRepoRoot(cwd, true);
  const inferredName = projectName.trim() || path.basename(repoRoot);
  const projectKey = inferProjectKey(inferredName);
  const config = defaultWorkflowConfig(projectKey, inferredName);

  writeWorkflowConfig(repoRoot, config);
  syncConsumerDocs(repoRoot, config);

  return {
    repoRoot,
    configPath: path.join(repoRoot, CONFIG_FILENAME),
  };
}

export function setupConsumerRepo(cwd: string): {
  repoRoot: string;
  createdClaude: boolean;
  codexHome: string;
  installedWrappers: string[];
} {
  const repoRoot = resolveRepoRoot(cwd, true);
  const configPath = path.join(repoRoot, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${repoRoot}. Run workflow-kit init first.`);
  }

  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as WorkflowConfig;
  const config = {
    ...parsed,
    aliases: resolveWorkflowAliases(parsed.aliases),
  };
  syncConsumerDocs(repoRoot, config);

  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  let createdClaude = false;
  if (!existsSync(claudePath)) {
    const rendered = renderTemplate(readTemplate('workflow/CLAUDE.template.md'), config);
    writeFileSync(claudePath, rendered.replace('{{DEPLOY_CONFIG_SECTION}}', renderDeployConfigSection(emptyDeployConfig()).trimEnd()), 'utf8');
    createdClaude = true;
  }

  const codex = installCodexWrappers({ repoRoot, aliases: config.aliases });

  return {
    repoRoot,
    createdClaude,
    codexHome: codex.codexHome,
    installedWrappers: codex.installed,
  };
}

export function syncDocsOnly(cwd: string): { repoRoot: string } {
  const repoRoot = resolveRepoRoot(cwd, true);
  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${repoRoot}.`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkflowConfig;
  syncConsumerDocs(repoRoot, config);
  return { repoRoot };
}

export function maybeInitGitRepo(repoRoot: string): void {
  if (!existsSync(path.join(repoRoot, '.git'))) {
    runGit(repoRoot, ['init', '-b', 'main']);
  }
}
