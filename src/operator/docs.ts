import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import type { SyncDocsConfig, WorkflowCommand, WorkflowConfig } from './state.ts';
import {
  aliasCommandName,
  CONFIG_FILENAME,
  defaultWorkflowConfig,
  inferProjectKey,
  loadWorkflowConfig,
  MANAGED_COMMANDS,
  MANAGED_EXTRA_COMMANDS,
  type ManagedCommand,
  readJsonFile,
  resolveReadableConfigPath,
  resolveRepoRoot,
  resolveSyncDocs,
  resolveWorkflowAliases,
  runGit,
  WORKFLOW_COMMANDS,
  writeJsonFile,
  writeWorkflowConfig,
} from './state.ts';
import { emptyDeployConfig, loadDeployConfig, renderDeployConfigSection } from './release-gate.ts';
import { pruneLegacyCodexWrapperSkills } from './codex-install.ts';
import { type CodexSkillDrift, detectCodexSkillDrift, syncCodexSkills } from './codex-skills.ts';

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
// Two-signature legacy detection: first-line description + a distinctive body
// string. For workflow commands the body string is usually the npm script
// prefix, truncated to `npm run pipelane:<cmd>` so the match survives any
// `-- $ARGUMENTS` / `-- --apply` / bare-invocation variant current-main
// templates have emitted. Consumers that had these files generated before this
// PR carry no marker, so detection falls back here.
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
  smoke: [
    'Plan smoke coverage or run deterministic smoke against staging or prod.',
    'npm run pipelane:smoke',
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
    'npm run pipelane:repo-guard',
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
  // `pipelane` is a managed extra command with a fixed filename. Keep the
  // current template signatures here so the template/signature invariant stays
  // honest; older template variants live in ADDITIONAL_LEGACY_CLAUDE_SIGNATURES
  // below so already-installed consumers still upgrade in place.
  pipelane: [
    'Run a Pipelane subcommand for this repo.',
    '## JOURNEY OVERVIEW',
    '/pipelane web',
  ],
  // `fix.md` ships marker-first, so legacy detection is mostly a formality —
  // no pre-marker consumer files exist. Two distinctive body strings satisfy
  // the structural >= 2 invariant and keep detection robust if a future
  // non-marker variant ever ships.
  fix: [
    'Produce durable, root-cause fixes. Not shims, not speculative refactors.',
    '### Refuse these shims unconditionally',
  ],
};

const ADDITIONAL_LEGACY_CLAUDE_SIGNATURES: Partial<Record<ManagedCommand, string[][]>> = {
  // Pre-overview `/pipelane` opened the board by default and shipped without
  // the command marker. Keep recognizing that exact old shape without forcing
  // stale "Board (default)" copy to remain in the current template forever.
  pipelane: [[
    'Run a Pipelane subcommand for this repo.',
    'npm run pipelane:board',
    '## Pipelane Board (default)',
  ]],
};

function legacyClaudeSignatureSets(command: ManagedCommand): string[][] {
  return [
    LEGACY_CLAUDE_SIGNATURES[command],
    ...(ADDITIONAL_LEGACY_CLAUDE_SIGNATURES[command] ?? []),
  ];
}

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
    ALIAS_SMOKE: aliases.smoke,
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
    const matchedSignatures = legacyClaudeSignatureSets(command)
      .some((signatures) => signatures.every((signature) => content.includes(signature)));
    if (!matchedSignatures) {
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

// Compute the on-disk filename pipelane:setup will write for a managed command.
// Extras (pipelane.md, fix.md) keep fixed filenames; workflow commands follow
// the consumer's alias map. Shared by the sync loop and by detectSetupDrift so
// both agree on which file represents each command.
function managedClaudeCommandFilename(
  name: ManagedCommand,
  aliases: Record<WorkflowCommand, string>,
): string {
  if ((MANAGED_EXTRA_COMMANDS as readonly string[]).includes(name)) {
    return `${name}.md`;
  }
  return `${aliasCommandName(aliases[name as WorkflowCommand])}.md`;
}

// Render the final content pipelane:setup will write for a managed command,
// including any preserved consumer-extension block. Used by the sync loop to
// emit bytes and by detectSetupDrift to compare against what's already on
// disk — one render path, one answer.
function renderManagedClaudeCommand(
  name: ManagedCommand,
  config: WorkflowConfig,
  capturedExtension: string | null,
): string {
  const rendered = renderTemplate(readTemplate(`.claude/commands/${name}.md`), config);
  return injectConsumerExtension(rendered, capturedExtension);
}

// Pure computation of what replaceMarkedSection would write. Shared by the
// writer below and by detectSetupDrift so both agree on the resulting bytes.
function computeReplaceMarkedSection(
  existing: string,
  startMarker: string,
  endMarker: string,
  rendered: string,
  defaultHeading: string,
): string {
  const section = `${startMarker}\n${rendered.trimEnd()}\n${endMarker}`;
  if (existing.includes(startMarker) && existing.includes(endMarker)) {
    return existing.replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`), section);
  }
  const prefix = existing.trimEnd();
  const heading = prefix ? '\n\n' : defaultHeading;
  return `${prefix}${heading}${section}\n`;
}

function replaceMarkedSection(targetPath: string, startMarker: string, endMarker: string, rendered: string, defaultHeading = ''): void {
  const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const next = computeReplaceMarkedSection(existing, startMarker, endMarker, rendered, defaultHeading);
  writeFileSync(targetPath, next, 'utf8');
}

const REQUIRED_PACKAGE_SCRIPTS: Record<string, string> = {
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
  'pipelane:smoke': 'pipelane run smoke',
  'pipelane:clean': 'pipelane run clean',
  'pipelane:status': 'pipelane run status',
  'pipelane:doctor': 'pipelane run doctor',
  'pipelane:rollback': 'pipelane run rollback',
  'pipelane:board': 'pipelane board',
  'pipelane:update': 'pipelane update',
  'pipelane:api': 'pipelane run api',
};

// Hard block against the npm-wipes-shared-deps footgun. Loads the standalone
// CJS guard from pipelane's own published `scripts/` folder if present.
// Self-no-ops when pipelane isn't installed yet (first-bootstrap), and there
// can't be a worktree symlink to wipe at that point either. The substring
// PREINSTALL_GUARD_FINGERPRINT is what mergePreinstallScript looks for to
// stay idempotent and to recognize an already-chained existing preinstall.
export const PREINSTALL_GUARD_FINGERPRINT = 'pipelane/scripts/preinstall-guard.cjs';
export const PIPELANE_PREINSTALL_GUARD =
  `node -e "const p='./node_modules/${PREINSTALL_GUARD_FINGERPRINT}';require('fs').existsSync(p)&&require(p)"`;

// Special-case merge for the `preinstall` script slot. The default
// REQUIRED_PACKAGE_SCRIPTS merge is last-write-wins; clobbering a consumer's
// existing preinstall would silently break their CI hooks. Instead:
// - no existing preinstall → write ours
// - existing already contains the guard fingerprint → leave alone (idempotent)
// - existing is something else → chain ours first so the worktree-symlink
//   case fails fast before the consumer's hook runs
export function mergePreinstallScript(existing: string | undefined): string {
  const trimmed = (existing ?? '').trim();
  if (!trimmed) return PIPELANE_PREINSTALL_GUARD;
  if (trimmed.includes(PREINSTALL_GUARD_FINGERPRINT)) return existing as string;
  return `${PIPELANE_PREINSTALL_GUARD} && ${existing}`;
}

// Shared builder: returns the exact bytes pipelane would write to package.json
// along with the current on-disk bytes. Used by ensurePackageScripts (to
// write) and by detectSetupDrift (to compare without writing).
function buildEnsuredPackageJson(repoRoot: string): { targetPath: string; currentRaw: string; nextRaw: string } {
  const targetPath = path.join(repoRoot, 'package.json');
  const existed = existsSync(targetPath);
  const currentRaw = existed ? readFileSync(targetPath, 'utf8') : '';
  const current: Record<string, unknown> = existed
    ? JSON.parse(currentRaw) as Record<string, unknown>
    : { name: path.basename(repoRoot), private: true, type: 'module', scripts: {} };
  const existingScripts = typeof current.scripts === 'object' && current.scripts
    ? current.scripts as Record<string, string>
    : {};
  const scripts: Record<string, string> = {
    ...existingScripts,
    ...REQUIRED_PACKAGE_SCRIPTS,
    preinstall: mergePreinstallScript(existingScripts.preinstall),
  };
  const next = { ...current, scripts };
  const nextRaw = `${JSON.stringify(next, null, 2)}\n`;
  return { targetPath, currentRaw, nextRaw };
}

export function ensurePackageScripts(repoRoot: string): void {
  const { targetPath, nextRaw } = buildEnsuredPackageJson(repoRoot);
  writeFileSync(targetPath, nextRaw, 'utf8');
}

// Generated Claude slash-command templates invoke `npm run pipelane:<cmd>`.
// Tracked Codex skills use a repo-managed wrapper instead, so packageScripts
// are only a hard requirement when Claude commands are being generated.
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
      `The generated .claude/commands/*.md templates invoke these via \`npm run pipelane:<cmd>\`. ` +
      `Fix it one of three ways: ` +
      `(a) add the missing scripts to package.json yourself, ` +
      `(b) set syncDocs.packageScripts to true (or drop the flag), or ` +
      `(c) set syncDocs.claudeCommands to false so the command files aren't generated.`,
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
    for (const name of MANAGED_COMMANDS) {
      desiredCommandFiles.add(managedClaudeCommandFilename(name, aliases));
    }
    assertNoClaudeCollisions(commandsDir, desiredCommandFiles, managedCommandFiles);
    pruneManagedClaudeCommands(commandsDir, desiredCommandFiles, managedCommandFiles);
    for (const name of MANAGED_COMMANDS) {
      const filename = managedClaudeCommandFilename(name, aliases);
      const content = renderManagedClaudeCommand(name, config, capturedExtensions.get(name) ?? null);
      writeFileSync(path.join(commandsDir, filename), content, 'utf8');
    }
    saveManagedClaudeCommands(commandsDir, desiredCommandFiles);
  }

  if (syncDocs.codexSkills) {
    syncCodexSkills(repoRoot, config);
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
  const existingConfig = resolveReadableConfigPath(repoRoot);
  if (existingConfig) {
    throw new Error([
      `Pipelane is already initialized in ${repoRoot}.`,
      `Existing config: ${existingConfig}`,
      'Run `pipelane setup` to refresh generated files, or edit the existing config intentionally.',
    ].join('\n'));
  }
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

export interface SetupConsumerRepoResult {
  repoRoot: string;
  createdClaude: boolean;
  createdRepoGuidance: boolean;
  codexSkillsDir: string;
  installedCodexSkills: string[];
  removedLegacyCodexSkills: string[];
  agentsGuidanceMigrations: AgentsGuidanceMigration[];
  appliedAgentsGuidanceMigrations: AgentsGuidanceMigration[];
  warnings: string[];
}

export interface SetupConsumerRepoOptions {
  applyAgentsGuidanceMigrations?: boolean;
}

export interface AgentsGuidanceReplacement {
  line: number;
  before: string;
  after: string;
}

export interface AgentsGuidanceMigration {
  file: 'AGENTS.md';
  path: string;
  replacements: AgentsGuidanceReplacement[];
}

const AGENTS_GUIDANCE_EXTRA_COMMANDS: Record<string, string> = {
  board: '/pipelane web',
  update: '/pipelane update',
};

function replacementForAgentsWorkflowCommand(command: string, aliases: Record<WorkflowCommand, string>): string | null {
  if ((WORKFLOW_COMMANDS as readonly string[]).includes(command)) {
    return aliases[command as WorkflowCommand];
  }
  return AGENTS_GUIDANCE_EXTRA_COMMANDS[command] ?? null;
}

function migrateAgentsGuidanceLine(line: string, aliases: Record<WorkflowCommand, string>): string {
  const staleScriptPattern = /\bnpm\s+run\s+(?:workflow|pipelane):([a-z0-9-]+)(?:\s+--(?=\s|$))?/gi;
  return line.replace(staleScriptPattern, (match, rawCommand: string) => {
    const replacement = replacementForAgentsWorkflowCommand(rawCommand.toLowerCase(), aliases);
    return replacement ?? match;
  });
}

function detectAgentsGuidanceMigrationsForConfig(repoRoot: string, config: WorkflowConfig): AgentsGuidanceMigration[] {
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    return [];
  }

  const aliases = resolveWorkflowAliases(config.aliases);
  const replacements: AgentsGuidanceReplacement[] = [];
  let insideManagedSection = false;
  const lines = readFileSync(agentsPath, 'utf8').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes(AGENTS_MARKER_START)) {
      insideManagedSection = true;
      continue;
    }
    if (line.includes(AGENTS_MARKER_END)) {
      insideManagedSection = false;
      continue;
    }
    if (insideManagedSection) {
      continue;
    }

    const migrated = migrateAgentsGuidanceLine(line, aliases);
    if (migrated === line) {
      continue;
    }
    replacements.push({
      line: index + 1,
      before: line,
      after: migrated,
    });
  }

  if (replacements.length === 0) {
    return [];
  }

  return [{ file: 'AGENTS.md', path: agentsPath, replacements }];
}

export function detectAgentsGuidanceMigrations(cwd: string): AgentsGuidanceMigration[] {
  const repoRoot = resolveRepoRoot(cwd, true);
  const config = loadWorkflowConfig(repoRoot);
  return detectAgentsGuidanceMigrationsForConfig(repoRoot, config);
}

export function applyAgentsGuidanceMigrations(migrations: AgentsGuidanceMigration[]): AgentsGuidanceMigration[] {
  const applied: AgentsGuidanceMigration[] = [];
  for (const migration of migrations) {
    const content = readFileSync(migration.path, 'utf8');
    const lines = content.split('\n');
    for (const replacement of migration.replacements) {
      const current = lines[replacement.line - 1];
      if (current !== replacement.before) {
        throw new Error(
          `${migration.file}:${replacement.line} changed while preparing the AGENTS.md guidance migration. Re-run setup to recompute the proposed edits.`,
        );
      }
      lines[replacement.line - 1] = replacement.after;
    }
    writeFileSync(migration.path, lines.join('\n'), 'utf8');
    applied.push(migration);
  }
  return applied;
}

export async function applyAgentsGuidanceMigrationsWithApproval(
  migrations: AgentsGuidanceMigration[],
  options: { yes?: boolean } = {},
): Promise<AgentsGuidanceMigration[]> {
  if (migrations.length === 0) {
    return [];
  }
  if (options.yes) {
    return applyAgentsGuidanceMigrations(migrations);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return [];
  }

  process.stdout.write(`${formatAgentsGuidanceMigrations(migrations).join('\n')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Apply these AGENTS.md changes? Enter Y to proceed. [Y/n] ')).trim().toLowerCase();
    if (answer !== '' && answer !== 'y' && answer !== 'yes') {
      return [];
    }
  } finally {
    rl.close();
  }
  return applyAgentsGuidanceMigrations(migrations);
}

export function formatAgentsGuidanceMigrations(migrations: AgentsGuidanceMigration[]): string[] {
  const lines: string[] = [];
  for (const migration of migrations) {
    lines.push(`${migration.file} contains stale Pipelane guidance that should be migrated:`);
    for (const replacement of migration.replacements) {
      lines.push(`- ${migration.file}:${replacement.line}`);
      lines.push(`  current: ${replacement.before}`);
      lines.push(`  proposed: ${replacement.after}`);
    }
  }
  return [
    ...lines,
    'These npm script paths require repo-local node_modules/.bin/pipelane and can fail in fresh AI worktrees.',
  ];
}

export function setupConsumerRepo(cwd: string, options: SetupConsumerRepoOptions = {}): SetupConsumerRepoResult {
  const repoRoot = resolveRepoRoot(cwd, true);
  const config = loadWorkflowConfig(repoRoot);
  const syncDocs = resolveSyncDocs(config.syncDocs);
  syncConsumerDocs(repoRoot, config);

  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  let createdClaude = false;
  if (!existsSync(claudePath)) {
    writeFileSync(claudePath, renderClaudeMdFromTemplate(config), 'utf8');
    createdClaude = true;
  }

  // REPO_GUIDANCE.md is consumer-owned forever: pipelane writes the scaffold
  // once on setup, never re-syncs. Idempotent — skip if the file already
  // exists, preserving whatever the consumer has customized.
  const repoGuidancePath = path.join(repoRoot, 'REPO_GUIDANCE.md');
  let createdRepoGuidance = false;
  if (!existsSync(repoGuidancePath)) {
    writeFileSync(repoGuidancePath, readTemplate('REPO_GUIDANCE.template.md'), 'utf8');
    createdRepoGuidance = true;
  }

  const removedLegacyCodexSkills = syncDocs.codexSkills
    ? pruneLegacyCodexWrapperSkills()
    : [];
  let agentsGuidanceMigrations = detectAgentsGuidanceMigrationsForConfig(repoRoot, config);
  const appliedAgentsGuidanceMigrations = options.applyAgentsGuidanceMigrations
    ? applyAgentsGuidanceMigrations(agentsGuidanceMigrations)
    : [];
  if (appliedAgentsGuidanceMigrations.length > 0) {
    agentsGuidanceMigrations = detectAgentsGuidanceMigrationsForConfig(repoRoot, config);
  }

  return {
    repoRoot,
    createdClaude,
    createdRepoGuidance,
    codexSkillsDir: path.join(repoRoot, '.agents', 'skills'),
    installedCodexSkills: syncDocs.codexSkills
      ? WORKFLOW_COMMANDS.map((command) => config.aliases[command])
      : [],
    removedLegacyCodexSkills,
    agentsGuidanceMigrations,
    appliedAgentsGuidanceMigrations,
    warnings: [],
  };
}

export function syncDocsOnly(cwd: string): { repoRoot: string } {
  const repoRoot = resolveRepoRoot(cwd, true);
  const config = loadWorkflowConfig(repoRoot);
  syncConsumerDocs(repoRoot, config);
  return { repoRoot };
}

export interface ClaudeCommandDrift {
  enabled: boolean;
  addedCommands: string[];
  updatedCommands: string[];
  removedLegacyCommands: string[];
  collisions: string[]; // existing non-pipelane files that setup would refuse to overwrite
}

export interface SetupDrift {
  repoRoot: string;
  needsSetup: boolean;
  needsReopenClaude: boolean;
  needsReopenCodex: boolean;
  claude: ClaudeCommandDrift;
  codex: CodexSkillDrift & { enabled: boolean };
  repoGuidance: { willScaffold: boolean };
  // Names of other syncConsumerDocs surfaces setup would re-render. Values
  // come from the SyncDocsConfig keys enabled for this consumer.
  otherSurfaces: string[];
  agentsGuidanceMigrations: AgentsGuidanceMigration[];
  warnings: string[];
}

// Pure-detection mirror of syncConsumerDocs + setupConsumerRepo's file writes.
// Answers "what would pipelane:setup change right now?" without touching disk.
// Used by /pipelane update to surface the minimum follow-up steps when
// templates drift between installed node_modules and the consumer's working
// tree.
export function detectSetupDrift(cwd: string): SetupDrift {
  const repoRoot = resolveRepoRoot(cwd, true);
  const config = loadWorkflowConfig(repoRoot);
  const syncDocs = resolveSyncDocs(config.syncDocs);
  const aliases = resolveWorkflowAliases(config.aliases);

  // Claude surface
  const claude: ClaudeCommandDrift = {
    enabled: syncDocs.claudeCommands,
    addedCommands: [],
    updatedCommands: [],
    removedLegacyCommands: [],
    collisions: [],
  };
  if (syncDocs.claudeCommands) {
    const commandsDir = path.join(repoRoot, '.claude', 'commands');
    const managedFiles = existsSync(commandsDir) ? loadManagedClaudeCommands(commandsDir) : new Set<string>();
    const capturedExtensions = existsSync(commandsDir)
      ? captureManagedExtensionsByCommand(commandsDir, managedFiles)
      : new Map<ManagedCommand, string>();
    const desiredFiles = new Set<string>();
    for (const name of MANAGED_COMMANDS) {
      desiredFiles.add(managedClaudeCommandFilename(name, aliases));
    }
    for (const entry of desiredFiles) {
      const targetPath = path.join(commandsDir, entry);
      if (existsSync(targetPath) && !managedFiles.has(entry)) {
        claude.collisions.push(entry);
      }
    }
    for (const name of MANAGED_COMMANDS) {
      const filename = managedClaudeCommandFilename(name, aliases);
      const targetPath = path.join(commandsDir, filename);
      const desiredContent = renderManagedClaudeCommand(name, config, capturedExtensions.get(name) ?? null);
      if (!existsSync(targetPath)) {
        claude.addedCommands.push(filename);
        continue;
      }
      // Skip update-classification for collisions — the file exists but
      // isn't ours to rewrite.
      if (claude.collisions.includes(filename)) {
        continue;
      }
      const onDisk = readFileSync(targetPath, 'utf8');
      if (onDisk !== desiredContent) {
        claude.updatedCommands.push(filename);
      }
    }
    for (const filename of managedFiles) {
      if (!desiredFiles.has(filename)) {
        claude.removedLegacyCommands.push(filename);
      }
    }
    claude.addedCommands.sort();
    claude.updatedCommands.sort();
    claude.removedLegacyCommands.sort();
    claude.collisions.sort();
  }

  // Codex surface
  const codexDrift = syncDocs.codexSkills
    ? detectCodexSkillDrift(repoRoot, config)
    : {
        skillsDir: path.join(repoRoot, '.agents', 'skills'),
        addedSkills: [],
        updatedSkills: [],
        removedLegacySkills: [],
        runnerDrift: false,
      };
  const codex = { ...codexDrift, enabled: syncDocs.codexSkills };

  // REPO_GUIDANCE.md scaffold — write-once, never re-sync.
  const repoGuidance = {
    willScaffold: !existsSync(path.join(repoRoot, 'REPO_GUIDANCE.md')),
  };

  // Other re-rendered surfaces — each conditional block in syncConsumerDocs.
  const otherSurfaces: string[] = [];
  if (syncDocs.pipelaneClaudeTemplate) {
    const target = path.join(repoRoot, 'pipelane', 'CLAUDE.template.md');
    const rendered = renderTemplate(readTemplate('pipelane/CLAUDE.template.md'), config);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== rendered) {
      otherSurfaces.push('pipelaneClaudeTemplate');
    }
  }
  if (syncDocs.docsReleaseWorkflow) {
    const target = path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md');
    const rendered = renderTemplate(readTemplate('docs/RELEASE_WORKFLOW.md'), config);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== rendered) {
      otherSurfaces.push('docsReleaseWorkflow');
    }
  }
  if (syncDocs.readmeSection && markerSectionWouldDrift(
    path.join(repoRoot, 'README.md'),
    README_MARKER_START,
    README_MARKER_END,
    renderTemplate(readTemplate('README.pipelane-section.md'), config),
    `# ${config.displayName}\n\n`,
  )) {
    otherSurfaces.push('readmeSection');
  }
  if (syncDocs.contributingSection && markerSectionWouldDrift(
    path.join(repoRoot, 'CONTRIBUTING.md'),
    CONTRIBUTING_MARKER_START,
    CONTRIBUTING_MARKER_END,
    renderTemplate(readTemplate('CONTRIBUTING.pipelane-section.md'), config),
    '# Contributing\n\n',
  )) {
    otherSurfaces.push('contributingSection');
  }
  if (syncDocs.agentsSection && markerSectionWouldDrift(
    path.join(repoRoot, 'AGENTS.md'),
    AGENTS_MARKER_START,
    AGENTS_MARKER_END,
    renderTemplate(readTemplate('AGENTS.md'), config),
    `# ${config.displayName} Repo Context\n\n`,
  )) {
    otherSurfaces.push('agentsSection');
  }
  if (syncDocs.packageScripts) {
    const { currentRaw, nextRaw } = buildEnsuredPackageJson(repoRoot);
    if (currentRaw !== nextRaw) {
      otherSurfaces.push('packageScripts');
    }
  }
  const agentsGuidanceMigrations = detectAgentsGuidanceMigrationsForConfig(repoRoot, config);

  const claudeDirty =
    claude.addedCommands.length > 0 ||
    claude.updatedCommands.length > 0 ||
    claude.removedLegacyCommands.length > 0 ||
    claude.collisions.length > 0;
  const codexDirty =
    codex.enabled &&
    (codex.addedSkills.length > 0 ||
      codex.updatedSkills.length > 0 ||
      codex.removedLegacySkills.length > 0 ||
      codex.runnerDrift);

  return {
    repoRoot,
    needsSetup:
      claudeDirty ||
      codexDirty ||
      repoGuidance.willScaffold ||
      otherSurfaces.length > 0,
    // Reopen is only relevant when command files actually change — collisions
    // alone block setup but don't add/change Claude-visible slash commands.
    needsReopenClaude:
      claude.enabled &&
      (claude.addedCommands.length > 0 ||
        claude.updatedCommands.length > 0 ||
        claude.removedLegacyCommands.length > 0),
    needsReopenCodex: codexDirty,
    claude,
    codex,
    repoGuidance,
    otherSurfaces,
    agentsGuidanceMigrations,
    warnings: [],
  };
}

function markerSectionWouldDrift(
  targetPath: string,
  startMarker: string,
  endMarker: string,
  rendered: string,
  defaultHeading: string,
): boolean {
  const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const next = computeReplaceMarkedSection(existing, startMarker, endMarker, rendered, defaultHeading);
  return existing !== next;
}

// Human-readable line describing whether the repo has a usable deploy config
// for release mode. Formerly lived in cli.ts; pulled here so the same
// phrasing flows through both the setup CLI handler and update's inline-setup
// path without divergence.
export function setupDeployConfigMessage(repoRoot: string): string {
  if (loadDeployConfig(repoRoot)) {
    return 'Release mode can use shared deploy configuration when available. Edit local CLAUDE.md only for worktree-local overrides.';
  }
  return 'Release mode still requires deploy configuration. Run `/doctor --fix`.';
}

// Canonical setup-complete output. Used by `pipelane setup` (cli.ts) and by
// `pipelane update`'s inline-setup path (update.ts) so both entry points
// emit the same lines in the same order.
export function formatSetupResult(result: SetupConsumerRepoResult): string[] {
  const lines: string[] = [
    `Pipelane setup complete in ${result.repoRoot}`,
    result.createdClaude
      ? 'Created local CLAUDE.md from the Pipelane template.'
      : 'Preserved existing local CLAUDE.md.',
    result.createdRepoGuidance
      ? 'Created REPO_GUIDANCE.md from the scaffold — run `/fix refresh-guidance` to fill it in.'
      : 'Preserved existing REPO_GUIDANCE.md.',
    setupDeployConfigMessage(result.repoRoot),
  ];
  if (result.installedCodexSkills.length > 0) {
    lines.push(
      `Synced Codex skills in ${result.codexSkillsDir}`,
      `Slash commands: ${result.installedCodexSkills.join(', ')}`,
      'Codex picks up the tracked .agents/skills files from the repo.',
    );
  } else {
    lines.push('Skipped tracked Codex skill sync because syncDocs.codexSkills is false.');
  }
  if (result.removedLegacyCodexSkills.length > 0) {
    lines.push(`Removed legacy machine-local wrapper skills: ${result.removedLegacyCodexSkills.join(', ')}`);
  }
  if (result.appliedAgentsGuidanceMigrations.length > 0) {
    const count = result.appliedAgentsGuidanceMigrations
      .reduce((sum, migration) => sum + migration.replacements.length, 0);
    lines.push(`Updated AGENTS.md stale workflow guidance (${count} line${count === 1 ? '' : 's'}).`);
  }
  if (result.agentsGuidanceMigrations.length > 0) {
    lines.push('AGENTS.md guidance migration requires approval:');
    lines.push(...formatAgentsGuidanceMigrations(result.agentsGuidanceMigrations));
    lines.push('Run `pipelane setup --yes` to apply these AGENTS.md changes non-interactively, or run `pipelane setup` in a TTY and approve the prompt.');
  }
  if (result.warnings.length > 0) {
    lines.push('Readiness warnings:');
    lines.push(...result.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('If Claude or Codex was already open, reopen the repo or restart the client to refresh commands and skills.');
  return lines;
}

export function maybeInitGitRepo(repoRoot: string): void {
  if (!existsSync(path.join(repoRoot, '.git'))) {
    runGit(repoRoot, ['init', '-b', 'main']);
  }
}
