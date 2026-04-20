import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SyncDocsConfig, WorkflowConfig } from './state.ts';
import {
  aliasCommandName,
  CONFIG_FILENAME,
  defaultWorkflowConfig,
  inferProjectKey,
  MANAGED_COMMANDS,
  MANAGED_EXTRA_COMMANDS,
  type ManagedCommand,
  readJsonFile,
  resolveRepoRoot,
  resolveSyncDocs,
  resolveWorkflowAliases,
  runGit,
  WORKFLOW_COMMANDS,
  writeJsonFile,
  writeWorkflowConfig,
} from './state.ts';
import { emptyDeployConfig, renderDeployConfigSection } from './release-gate.ts';
import { installCodexWrappers } from './codex-install.ts';

const README_MARKER_START = '<!-- pipelane:readme:start -->';
const README_MARKER_END = '<!-- pipelane:readme:end -->';
const CONTRIBUTING_MARKER_START = '<!-- pipelane:contributing:start -->';
const CONTRIBUTING_MARKER_END = '<!-- pipelane:contributing:end -->';
const AGENTS_MARKER_START = '<!-- pipelane:agents:start -->';
const AGENTS_MARKER_END = '<!-- pipelane:agents:end -->';
const CLAUDE_COMMAND_MARKER = '<!-- pipelane:command:';
const CONSUMER_EXTENSION_MARKER_START = '<!-- pipelane:consumer-extension:start -->';
const CONSUMER_EXTENSION_MARKER_END = '<!-- pipelane:consumer-extension:end -->';
const MANAGED_CLAUDE_COMMANDS_FILENAME = '.pipelane-managed.json';
// Two-signature legacy detection: first-line description + the command's
// npm script prefix. Truncated to `npm run pipelane:<cmd>` so the match
// survives any `-- $ARGUMENTS` / `-- --apply` / bare-invocation variant
// current-main templates have emitted. Consumers that had these files
// generated before this PR carry no marker, so detection falls back here.
// Exported for structural validation in test/pipelane.test.mjs —
// every MANAGED_COMMANDS member must have a non-empty signature array so
// pre-marker consumer files upgrade cleanly on the next setup instead of
// raising a collision error.
export const LEGACY_CLAUDE_SIGNATURES: Record<ManagedCommand, string[]> = {
  clean: [
    'Report workflow cleanup status and prune stale task locks when requested.',
    'npm run pipelane:clean',
  ],
  deploy: [
    'Deploy the merged SHA for this repo.',
    'npm run pipelane:deploy',
  ],
  devmode: [
    "Switch or check the repo's development mode (build or release).",
    'npm run pipelane:devmode',
  ],
  merge: [
    "Merge the current task's pull request.",
    'npm run pipelane:merge',
  ],
  new: [
    'Create a fresh task workspace for this repo.',
    'npm run pipelane:new',
  ],
  pr: [
    'Prepare and open, or update, a pull request for the current task.',
    'npm run pipelane:pr',
  ],
  resume: [
    'Resume an existing task workspace for this repo.',
    'npm run pipelane:resume',
  ],
  'repo-guard': [
    'Verify the current checkout is safe for a task, or create an isolated task worktree when it is not.',
    'npm run workflow:repo-guard',
  ],
  status: [
    'Render a one-screen terminal cockpit of the pipelane:api snapshot.',
    'npm run pipelane:status',
  ],
  doctor: [
    'Diagnose deploy configuration, run live probes, or launch the fix wizard.',
    'npm run pipelane:doctor',
  ],
  rollback: [
    'Roll back the last staging or production deploy to the most recent verified-good SHA.',
    'npm run pipelane:rollback',
  ],
  // `pipelane` shipped without a marker on main before this PR landed, so
  // existing consumers have a `.claude/commands/pipelane.md` we need to
  // upgrade in place on the next setup run. Three distinctive strings
  // (not two) make it vanishingly unlikely a consumer-authored pipelane.md
  // hits every signature by coincidence — each adds a ~1-in-thousands
  // specificity layer, and together they're effectively
  // "this file was generated from the pipelane.md template."
  pipelane: [
    'Run a Pipelane subcommand for this repo.',
    'npm run pipelane:board',
    '## Pipelane Board (default)',
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
    ALIAS_REPO_GUARD: aliases['repo-guard'],
    ALIAS_PR: aliases.pr,
    ALIAS_MERGE: aliases.merge,
    ALIAS_DEPLOY: aliases.deploy,
    ALIAS_CLEAN: aliases.clean,
    ALIAS_STATUS: aliases.status,
    ALIAS_DOCTOR: aliases.doctor,
    ALIAS_ROLLBACK: aliases.rollback,
  };

  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    template,
  );
}

// Single source of truth for seeding a fresh CLAUDE.md from the Pipelane template.
// Used by setupConsumerRepo (creating CLAUDE.md on first init) and handleConfigure
// (seeding when a consumer ran init long ago and has since deleted CLAUDE.md).
// Keeping this in docs.ts means any new {{TEMPLATE_VAR}} added to renderTemplate
// above automatically flows through both callers — no parallel implementation to
// keep in sync.
export function renderClaudeMdFromTemplate(config: WorkflowConfig): string {
  const rendered = renderTemplate(readTemplate('pipelane/CLAUDE.template.md'), config);
  const emptySection = renderDeployConfigSection(emptyDeployConfig()).trimEnd();
  return rendered.replace('{{DEPLOY_CONFIG_SECTION}}', emptySection);
}

function detectLegacyClaudeCommand(content: string, filename?: string): ManagedCommand | null {
  for (const command of MANAGED_COMMANDS) {
    const signatures = LEGACY_CLAUDE_SIGNATURES[command];
    if (!signatures.every((signature) => content.includes(signature))) {
      continue;
    }
    // Extras (pipelane.md) use fixed, non-aliased filenames. Gating
    // legacy detection to the expected filename prevents a consumer-
    // authored .md that happens to quote both signatures (in docs, a
    // cheatsheet, or a fenced code example) from being mis-classified
    // as managed and pruned. Operator commands are aliased, so their
    // filename isn't knowable at detection time — that false-positive
    // risk is pre-existing from PR #25 and out of scope here.
    if ((MANAGED_EXTRA_COMMANDS as readonly string[]).includes(command)) {
      if (filename !== `${command}.md`) {
        continue;
      }
    }
    return command;
  }

  return null;
}

function isManagedClaudeCommand(filename: string, content: string): boolean {
  if (content.includes(CLAUDE_COMMAND_MARKER)) {
    return true;
  }

  return detectLegacyClaudeCommand(content, filename) !== null;
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
        `Claude command alias collision: ${targetPath} already exists and is not managed by pipelane. Choose a different alias in .pipelane.json or rename the conflicting command.`,
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

function identifyManagedCommand(content: string, filename?: string): ManagedCommand | null {
  for (const cmd of MANAGED_COMMANDS) {
    if (content.includes(`${CLAUDE_COMMAND_MARKER}${cmd} -->`)) {
      return cmd;
    }
  }

  return detectLegacyClaudeCommand(content, filename);
}

// Walk every managed file, key its captured extension by command (not by
// filename). This makes preserve survive alias renames: the old file gets
// pruned, but the captured content follows the command to its new aliased
// target below. Extras (pipelane) use their fixed filename as the key but
// flow through the same preserve path so their consumer-extension blocks
// survive re-sync too.
function captureManagedExtensionsByCommand(
  commandsDir: string,
  managedFiles: Set<string>,
): Map<ManagedCommand, string> {
  const extensions = new Map<ManagedCommand, string>();
  for (const filename of managedFiles) {
    const filePath = path.join(commandsDir, filename);
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, 'utf8');
    const command = identifyManagedCommand(content, filename);
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

  const scripts = {
    ...(typeof current.scripts === 'object' && current.scripts ? current.scripts as Record<string, string> : {}),
    'pipelane:setup': 'pipelane setup',
    'pipelane:configure': 'pipelane configure',
    'pipelane:devmode': 'pipelane run devmode',
    'pipelane:new': 'pipelane run new',
    'pipelane:resume': 'pipelane run resume',
    'pipelane:repo-guard': 'pipelane run repo-guard',
    'pipelane:pr': 'pipelane run pr',
    'pipelane:merge': 'pipelane run merge',
    'pipelane:release-check': 'pipelane run release-check',
    'pipelane:task-lock': 'pipelane run task-lock',
    'pipelane:deploy': 'pipelane run deploy',
    'pipelane:clean': 'pipelane run clean',
    'pipelane:status': 'pipelane run status',
    'pipelane:doctor': 'pipelane run doctor',
    'pipelane:rollback': 'pipelane run rollback',
    'pipelane:board': 'pipelane board',
    'pipelane:update': 'pipelane update',
    'pipelane:api': 'pipelane run api',
  };

  const next = {
    ...current,
    scripts,
  };

  writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

// Generated slash-command templates and Codex wrappers invoke
// `npm run pipelane:<cmd>`. If a consumer opts out of packageScripts but
// keeps claudeCommands, the generated command files would point at scripts
// that do not exist. Catch that mismatch here instead of leaving a broken setup.
function assertPackageScriptConsistency(repoRoot: string, syncDocs: Required<SyncDocsConfig>): void {
  if (syncDocs.packageScripts || !syncDocs.claudeCommands) {
    return;
  }

  const packageJsonPath = path.join(repoRoot, 'package.json');
  const pkg = existsSync(packageJsonPath)
    ? (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> })
    : {};
  const scripts = pkg.scripts ?? {};
  // `pipelane:configure` lives outside WORKFLOW_COMMANDS, but `devmode.md`
  // references it as the remediation path when release mode blocks.
  const required = [...WORKFLOW_COMMANDS.map((cmd) => `pipelane:${cmd}`), 'pipelane:configure'];
  const missing = required.filter((script) => typeof scripts[script] !== 'string');
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `syncDocs.packageScripts is false but package.json is missing required npm scripts: ${missing.join(', ')}. ` +
      `The generated .claude/commands/*.md templates and Codex wrappers invoke these via \`npm run pipelane:<cmd>\`. ` +
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
    // Enforce operator/extras filename uniqueness only when claudeCommands
    // is actually syncing. A consumer who opts out entirely can legitimately
    // keep an `aliases.new = '/pipelane'` in their config without triggering
    // the two-writer collision this guard prevents — the collision only
    // materializes when both loops below would write to the same file.
    for (const [command, alias] of Object.entries(aliases)) {
      for (const extra of MANAGED_EXTRA_COMMANDS) {
        if (alias === `/${extra}`) {
          throw new Error(
            `Workflow aliases must be unique. ${extra} and ${command} both resolve to ${alias}.`,
          );
        }
      }
    }
    const managedCommandFiles = loadManagedClaudeCommands(commandsDir);
    // Capture before prune so the extension follows the command through
    // alias renames (old filename gets pruned but its content survives).
    const capturedExtensions = captureManagedExtensionsByCommand(commandsDir, managedCommandFiles);
    const desiredCommandFiles = new Set<string>();
    for (const name of WORKFLOW_COMMANDS) {
      const commandFilename = `${aliasCommandName(aliases[name])}.md`;
      desiredCommandFiles.add(commandFilename);
    }
    // Extras (pipelane.md) use fixed filenames — not aliased — but they
    // still participate in collision detection, prune, and extension
    // preservation so consumer hand-edits inside the marker pair survive.
    for (const name of MANAGED_EXTRA_COMMANDS) {
      desiredCommandFiles.add(`${name}.md`);
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
    for (const name of MANAGED_EXTRA_COMMANDS) {
      const rendered = renderTemplate(readTemplate(`.claude/commands/${name}.md`), config);
      const targetPath = path.join(commandsDir, `${name}.md`);
      const output = injectConsumerExtension(rendered, capturedExtensions.get(name) ?? null);
      writeFileSync(targetPath, output, 'utf8');
    }
    saveManagedClaudeCommands(commandsDir, desiredCommandFiles);
  }

  if (syncDocs.pipelaneClaudeTemplate) {
    mkdirSync(path.join(repoRoot, 'pipelane'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'pipelane', 'CLAUDE.template.md'),
      renderTemplate(readTemplate('pipelane/CLAUDE.template.md'), config),
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
      renderTemplate(readTemplate('README.pipelane-section.md'), config),
      `# ${config.displayName}\n\n`,
    );
  }

  if (syncDocs.contributingSection) {
    replaceMarkedSection(
      path.join(repoRoot, 'CONTRIBUTING.md'),
      CONTRIBUTING_MARKER_START,
      CONTRIBUTING_MARKER_END,
      renderTemplate(readTemplate('CONTRIBUTING.pipelane-section.md'), config),
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
    throw new Error(`No ${CONFIG_FILENAME} found in ${repoRoot}. Run pipelane bootstrap first.`);
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
