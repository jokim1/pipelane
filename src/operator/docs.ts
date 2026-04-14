import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkflowConfig } from './state.ts';
import { CONFIG_FILENAME, defaultWorkflowConfig, inferProjectKey, resolveRepoRoot, runGit, writeWorkflowConfig } from './state.ts';
import { emptyDeployConfig, renderDeployConfigSection } from './release-gate.ts';
import { installCodexWrappers } from './codex-install.ts';

const README_MARKER_START = '<!-- workflow-kit:readme:start -->';
const README_MARKER_END = '<!-- workflow-kit:readme:end -->';
const CONTRIBUTING_MARKER_START = '<!-- workflow-kit:contributing:start -->';
const CONTRIBUTING_MARKER_END = '<!-- workflow-kit:contributing:end -->';
const AGENTS_MARKER_START = '<!-- workflow-kit:agents:start -->';
const AGENTS_MARKER_END = '<!-- workflow-kit:agents:end -->';

function kitRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function templatePath(relativePath: string): string {
  return path.join(kitRoot(), 'templates', relativePath);
}

function readTemplate(relativePath: string): string {
  return readFileSync(templatePath(relativePath), 'utf8');
}

function renderTemplate(template: string, config: WorkflowConfig): string {
  const replacements: Record<string, string> = {
    PROJECT_KEY: config.projectKey,
    DISPLAY_NAME: config.displayName,
    BASE_BRANCH: config.baseBranch,
    STATE_DIR: config.stateDir,
    TASK_WORKTREE_DIR_NAME: config.taskWorktreeDirName,
    DEPLOY_WORKFLOW_NAME: config.deployWorkflowName,
    SURFACES_CSV: config.surfaces.join(', '),
    PREPR_CHECKS_BULLETS: config.prePrChecks.map((entry) => `- \`${entry}\``).join('\n'),
  };

  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    template,
  );
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

  const scripts = {
    ...(typeof current.scripts === 'object' && current.scripts ? current.scripts as Record<string, string> : {}),
    'workflow:setup': 'workflow-kit setup',
    'workflow:devmode': 'workflow-kit run devmode',
    'workflow:new': 'workflow-kit run new',
    'workflow:resume': 'workflow-kit run resume',
    'workflow:pr': 'workflow-kit run pr',
    'workflow:merge': 'workflow-kit run merge',
    'workflow:release-check': 'workflow-kit run release-check',
    'workflow:task-lock': 'workflow-kit run task-lock',
    'workflow:deploy': 'workflow-kit run deploy',
    'workflow:clean': 'workflow-kit run clean',
  };

  const next = {
    ...current,
    scripts,
  };

  writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export function syncConsumerDocs(repoRoot: string, config: WorkflowConfig): void {
  mkdirSync(path.join(repoRoot, '.claude', 'commands'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'workflow'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

  const commandTemplates = ['devmode', 'new', 'resume', 'pr', 'merge', 'deploy', 'clean'];
  for (const name of commandTemplates) {
    const rendered = renderTemplate(readTemplate(`.claude/commands/${name}.md`), config);
    writeFileSync(path.join(repoRoot, '.claude', 'commands', `${name}.md`), rendered, 'utf8');
  }

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

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as WorkflowConfig;
  syncConsumerDocs(repoRoot, config);

  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  let createdClaude = false;
  if (!existsSync(claudePath)) {
    const rendered = renderTemplate(readTemplate('workflow/CLAUDE.template.md'), config);
    writeFileSync(claudePath, rendered.replace('{{DEPLOY_CONFIG_SECTION}}', renderDeployConfigSection(emptyDeployConfig()).trimEnd()), 'utf8');
    createdClaude = true;
  }

  const codex = installCodexWrappers();

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
