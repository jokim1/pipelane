import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SyncDocsConfig, WorkflowConfig } from './state.ts';
import {
  aliasCommandName,
  CONFIG_FILENAME,
  defaultWorkflowConfig,
  inferProjectKey,
  readJsonFile,
  resolveRepoRoot,
  resolveSyncDocs,
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
const CONSUMER_EXTENSION_MARKER_START = '<!-- workflow-kit:consumer-extension:start -->';
const CONSUMER_EXTENSION_MARKER_END = '<!-- workflow-kit:consumer-extension:end -->';
const MANAGED_CLAUDE_COMMANDS_FILENAME = '.workflow-kit-managed.json';
// Two-signature legacy detection: first-line description + the command's
// npm script prefix. Truncated to `npm run workflow:<cmd>` so the match
// survives any `-- $ARGUMENTS` / `-- --apply` / bare-invocation variant
// current-main templates have emitted. Consumers that had these files
// generated before this PR carry no marker, so detection falls back here.
const LEGACY_CLAUDE_SIGNATURES: Record<WorkflowCommand, string[]> = {
  clean: [
    'Report workflow cleanup status and prune stale task locks when requested.',
    'npm run workflow:clean',
  ],
  deploy: [
    'Deploy the merged SHA for this repo.',
    'npm run workflow:deploy',
  ],
  devmode: [
    "Switch or check the repo's development mode (build or release).",
    'npm run workflow:devmode',
  ],
  merge: [
    "Merge the current task's pull request.",
    'npm run workflow:merge',
  ],
  new: [
    'Create a fresh task workspace for this repo.',
    'npm run workflow:new',
  ],
  pr: [
    'Prepare and open, or update, a pull request for the current task.',
    'npm run workflow:pr',
  ],
  resume: [
    'Resume an existing task workspace for this repo.',
    'npm run workflow:resume',
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

// Single source of truth for seeding a fresh CLAUDE.md from the workflow template.
// Used by setupConsumerRepo (creating CLAUDE.md on first init) and handleConfigure
// (seeding when a consumer ran init long ago and has since deleted CLAUDE.md).
// Keeping this in docs.ts means any new {{TEMPLATE_VAR}} added to renderTemplate
// above automatically flows through both callers — no parallel implementation to
// keep in sync.
export function renderClaudeMdFromTemplate(config: WorkflowConfig): string {
  const rendered = renderTemplate(readTemplate('workflow/CLAUDE.template.md'), config);
  const emptySection = renderDeployConfigSection(emptyDeployConfig()).trimEnd();
  return rendered.replace('{{DEPLOY_CONFIG_SECTION}}', emptySection);
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

function extractConsumerExtension(content: string): string | null {
  const startIndex = content.indexOf(CONSUMER_EXTENSION_MARKER_START);
  // Use lastIndexOf for the end marker so a consumer who pastes content
  // that itself contains the literal `:end -->` marker doesn't truncate
  // their own extension on the next re-sync.
  const endIndex = content.lastIndexOf(CONSUMER_EXTENSION_MARKER_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }

  const innerStart = startIndex + CONSUMER_EXTENSION_MARKER_START.length;
  const inner = content.slice(innerStart, endIndex);
  // Strip the one newline immediately after the start marker and the one
  // immediately before the end marker (these terminate the marker lines
  // themselves). `\r?\n` handles CRLF-saved files from Windows editors.
  // Any blank lines the consumer intentionally placed inside the extension
  // are preserved verbatim.
  const trimmed = inner.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return trimmed;
}

function injectConsumerExtension(rendered: string, captured: string | null): string {
  if (captured === null || captured.length === 0) {
    return rendered;
  }

  const emptyMarkerPair = `${CONSUMER_EXTENSION_MARKER_START}\n${CONSUMER_EXTENSION_MARKER_END}`;
  if (!rendered.includes(emptyMarkerPair)) {
    return rendered;
  }

  const populated = `${CONSUMER_EXTENSION_MARKER_START}\n${captured}\n${CONSUMER_EXTENSION_MARKER_END}`;
  return rendered.replace(emptyMarkerPair, populated);
}

function identifyManagedCommand(content: string): WorkflowCommand | null {
  for (const cmd of WORKFLOW_COMMANDS) {
    if (content.includes(`${CLAUDE_COMMAND_MARKER}${cmd} -->`)) {
      return cmd;
    }
  }

  return detectLegacyClaudeCommand(content);
}

// Walk every managed file, key its captured extension by command (not by
// filename). This makes preserve survive alias renames: the old file gets
// pruned, but the captured content follows the command to its new aliased
// target below.
function captureManagedExtensionsByCommand(
  commandsDir: string,
  managedFiles: Set<string>,
): Map<WorkflowCommand, string> {
  const extensions = new Map<WorkflowCommand, string>();
  for (const filename of managedFiles) {
    const filePath = path.join(commandsDir, filename);
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, 'utf8');
    const command = identifyManagedCommand(content);
    if (!command) {
      continue;
    }
    const captured = extractConsumerExtension(content);
    if (captured && captured.length > 0) {
      extensions.set(command, captured);
    }
  }
  return extensions;
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
    'pipelane:configure': 'pipelane configure',
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
    'workflow:configure': 'pipelane configure',
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

// Generated slash-command templates and Codex wrappers all invoke
// `npm run workflow:<cmd>`. If a consumer opts out of packageScripts but
// keeps claudeCommands, the commands would reference npm scripts that
// don't exist — slash commands fail silently post-setup. Catch the
// inconsistency here with a clear error + escape hatches instead of
// letting the user debug "why does /clean do nothing" at runtime.
function assertPackageScriptConsistency(repoRoot: string, syncDocs: Required<SyncDocsConfig>): void {
  if (syncDocs.packageScripts || !syncDocs.claudeCommands) {
    return;
  }

  const packageJsonPath = path.join(repoRoot, 'package.json');
  const pkg = existsSync(packageJsonPath)
    ? (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> })
    : {};
  const scripts = pkg.scripts ?? {};
  const required = WORKFLOW_COMMANDS.map((cmd) => `workflow:${cmd}`);
  const missing = required.filter((script) => typeof scripts[script] !== 'string');
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `syncDocs.packageScripts is false but package.json is missing required npm scripts: ${missing.join(', ')}. ` +
      `The generated .claude/commands/*.md templates and Codex wrappers invoke these via \`npm run workflow:<cmd>\`. ` +
      `Fix it one of three ways: ` +
      `(a) add the missing scripts to package.json yourself, ` +
      `(b) set syncDocs.packageScripts to true (or drop the flag), or ` +
      `(c) also set syncDocs.claudeCommands to false so the command files aren't generated.`,
  );
}

export function syncConsumerDocs(repoRoot: string, config: WorkflowConfig): void {
  const syncDocs = resolveSyncDocs(config.syncDocs);
  assertPackageScriptConsistency(repoRoot, syncDocs);

  if (syncDocs.claudeCommands) {
    const commandsDir = path.join(repoRoot, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });

    const aliases = resolveWorkflowAliases(config.aliases);
    const managedCommandFiles = loadManagedClaudeCommands(commandsDir);
    // Capture before prune so the extension follows the command through
    // alias renames (old filename gets pruned but its content survives).
    const capturedExtensions = captureManagedExtensionsByCommand(commandsDir, managedCommandFiles);
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
      const targetPath = path.join(commandsDir, commandFilename);
      const output = injectConsumerExtension(rendered, capturedExtensions.get(name) ?? null);
      writeFileSync(targetPath, output, 'utf8');
    }
    saveManagedClaudeCommands(commandsDir, desiredCommandFiles);

    // pipelane.md is a Claude command file but not a workflow command (it
    // opens the board, not a task-flow step), so it isn't aliased and sits
    // outside the managed set. It regenerates alongside the managed commands
    // whenever `claudeCommands` is enabled; when the surface is opted out,
    // pipelane.md is skipped too (which is why it lives inside this block).
    writeFileSync(
      path.join(commandsDir, 'pipelane.md'),
      renderTemplate(readTemplate('.claude/commands/pipelane.md'), config),
      'utf8',
    );
  }

  if (syncDocs.workflowClaudeTemplate) {
    mkdirSync(path.join(repoRoot, 'workflow'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'workflow', 'CLAUDE.template.md'),
      renderTemplate(readTemplate('workflow/CLAUDE.template.md'), config),
      'utf8',
    );
  }

  if (syncDocs.docsReleaseWorkflow) {
    mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md'),
      renderTemplate(readTemplate('docs/RELEASE_WORKFLOW.md'), config),
      'utf8',
    );
  }

  if (syncDocs.readmeSection) {
    replaceMarkedSection(
      path.join(repoRoot, 'README.md'),
      README_MARKER_START,
      README_MARKER_END,
      renderTemplate(readTemplate('README.workflow-section.md'), config),
      `# ${config.displayName}\n\n`,
    );
  }

  if (syncDocs.contributingSection) {
    replaceMarkedSection(
      path.join(repoRoot, 'CONTRIBUTING.md'),
      CONTRIBUTING_MARKER_START,
      CONTRIBUTING_MARKER_END,
      renderTemplate(readTemplate('CONTRIBUTING.workflow-section.md'), config),
      '# Contributing\n\n',
    );
  }

  if (syncDocs.agentsSection) {
    replaceMarkedSection(
      path.join(repoRoot, 'AGENTS.md'),
      AGENTS_MARKER_START,
      AGENTS_MARKER_END,
      renderTemplate(readTemplate('AGENTS.md'), config),
      `# ${config.displayName} Repo Context\n\n`,
    );
  }

  if (syncDocs.packageScripts) {
    ensurePackageScripts(repoRoot);
  }
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
    writeFileSync(claudePath, renderClaudeMdFromTemplate(config), 'utf8');
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
