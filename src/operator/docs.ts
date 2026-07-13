import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import type { SyncDocsConfig, WorkflowCommand, WorkflowConfig } from './state.ts';
import {
  aliasCommandName,
  importLegacyWorkflowConfigIfNeeded,
  loadWorkflowConfig,
  MANAGED_COMMANDS,
  MANAGED_EXTRA_COMMANDS,
  MANAGED_WORKFLOW_COMMANDS,
  type ManagedCommand,
  readJsonFile,
  resolveConfigPath,
  resolveReadableConfigPath,
  resolveRepoRoot,
  resolveSyncDocs,
  resolveWorkflowAliases,
  runGit,
  writeWorkflowConfig,
  writeJsonFile,
} from './state.ts';
import { loadDeployConfig } from './release-gate.ts';

const README_MARKER_START = '<!-- pipelane:readme:start -->';
const README_MARKER_END = '<!-- pipelane:readme:end -->';
const CONTRIBUTING_MARKER_START = '<!-- pipelane:contributing:start -->';
const CONTRIBUTING_MARKER_END = '<!-- pipelane:contributing:end -->';
const AGENTS_MARKER_START = '<!-- pipelane:agents:start -->';
const AGENTS_MARKER_END = '<!-- pipelane:agents:end -->';
const CLAUDE_WORKSPACE_POLICY_MARKER_START = '<!-- pipelane:claude-workspace-policy:start -->';
const CLAUDE_WORKSPACE_POLICY_MARKER_END = '<!-- pipelane:claude-workspace-policy:end -->';
const CLAUDE_COMMAND_MARKER = '<!-- pipelane:command:';
const CONSUMER_EXTENSION_MARKER_START = '<!-- pipelane:consumer-extension:start -->';
const CONSUMER_EXTENSION_MARKER_END = '<!-- pipelane:consumer-extension:end -->';
const LESSONS_MARKER_START = '<!-- pipelane:lessons:start -->';
const LESSONS_MARKER_END = '<!-- pipelane:lessons:end -->';
const LESSONS_ENTRIES_MARKER_START = '<!-- pipelane:lessons:entries:start -->';
const LESSONS_ENTRIES_MARKER_END = '<!-- pipelane:lessons:entries:end -->';
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
  devmode: [
    "Switch or check the repo's development mode (build or release).",
    'npm run pipelane:devmode',
  ],
  adopt: [
    'Adopt an existing branch or worktree as a Pipelane task.',
    'npm run pipelane:adopt',
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
  release: [
    'Enable or inspect the optional release module for this repo.',
    'npm run pipelane:release',
  ],
  status: [
    'Render a one-screen terminal cockpit of the Pipelane API snapshot.',
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

function renderLocalClaudeWorkspacePolicy(config: WorkflowConfig): string {
  const aliases = resolveWorkflowAliases(config.aliases);
  return [
    CLAUDE_WORKSPACE_POLICY_MARKER_START,
    '## Task Workspace Policy',
    '',
    `- For any code-changing task, start in a Pipelane task workspace. If the current checkout is not already the matching task workspace, run \`${aliases.new}\` with an inferred \`--task\` label before editing. Do not edit in the starting checkout while planning to create the workspace later.`,
    `- If another model or tool already created the task branch/worktree, run \`${aliases.adopt} --task "<task-name>"\` from that worktree or \`${aliases.adopt} --branch <branch> --task "<task-name>"\` from the shared repo.`,
    `- If \`${aliases.new}\`, \`${aliases.adopt}\`, or \`${aliases.resume}\` reports \`Chat has not moved\`, switch the shell/workspace to the reported path before reading or editing task files. If you cannot switch the workspace, stop and report the path instead of continuing in the shared checkout.`,
    `- If \`${aliases.new}\` fails, do not continue implementation in the current checkout. Fix the task-start failure, run \`${aliases.adopt}\` for existing external work, run \`${aliases.resume}\` for existing Pipelane-tracked work, or ask the operator how to proceed.`,
    `- Use \`${aliases.resume} --task "<task-name>"\` to continue existing work. Use \`${aliases['repo-guard']} --task "<task-name>"\` when a checkout may be shared, dirty, or bound to another task.`,
    `- Do not edit, commit, run \`${aliases.pr}\`, \`${aliases.merge}\`, or \`${aliases.deploy}\` from a shared checkout, base branch checkout, dirty unrelated worktree, or another task's worktree unless the user explicitly asks for that checkout.`,
    '- Exceptions are read-only review, answering questions without file edits, and continuing inside an already-created matching task workspace.',
    CLAUDE_WORKSPACE_POLICY_MARKER_END,
  ].join('\n');
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
    ALIAS_ADOPT: aliases.adopt,
    ALIAS_RESUME: aliases.resume,
    ALIAS_REPO_GUARD: aliases['repo-guard'],
    ALIAS_PR: aliases.pr,
    ALIAS_MERGE: aliases.merge,
    ALIAS_RELEASE: aliases.release,
    ALIAS_DEPLOY: aliases.deploy,
    ALIAS_CLEAN: aliases.clean,
    ALIAS_STATUS: aliases.status,
    ALIAS_DOCTOR: aliases.doctor,
    ALIAS_ROLLBACK: aliases.rollback,
    LOCAL_CLAUDE_WORKSPACE_POLICY: renderLocalClaudeWorkspacePolicy(config),
  };

  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    template,
  );
}

// The pipelane-owned instruction prose for the managed Lessons block. Refreshed
// on every re-sync; the entries region below it is append-only and preserved.
const LESSONS_INSTRUCTION = `## Lessons

When the user corrects a mistake you made in this repo, append a one-line, dated
lesson to the entries region below (newest last), e.g. \`- <YYYY-MM-DD>: <lesson>\`.
Keep one line per lesson; do not delete or rewrite existing entries (dedup and
pruning are \`/karpathy audit\`'s job).`;

// Single source of truth for the managed Lessons block written into CLAUDE.md
// (Change A seeds it via the template placeholder; Change B inserts/refreshes it
// in existing files). `entriesInner` carries any preserved lesson lines on
// re-sync; empty for a fresh block.
function renderLessonsBlock(entriesInner = ''): string {
  const entriesBody = entriesInner.length > 0 ? `\n${entriesInner}\n` : '\n';
  return [
    LESSONS_MARKER_START,
    LESSONS_INSTRUCTION,
    '',
    `${LESSONS_ENTRIES_MARKER_START}${entriesBody}${LESSONS_ENTRIES_MARKER_END}`,
    LESSONS_MARKER_END,
  ].join('\n');
}

// Legacy template renderer retained for compatibility helpers and tests.
// `pipelane setup` and `pipelane configure` must not create repo-local
// CLAUDE.md files.
export function renderClaudeMdFromTemplate(config: WorkflowConfig): string {
  const rendered = renderTemplate(readTemplate('pipelane/CLAUDE.template.md'), config);
  return rendered
    .replace('{{LESSONS_SECTION}}', renderLessonsBlock());
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
        `Claude command alias collision: ${targetPath} already exists and is not managed by pipelane. Choose a different alias in machine-local Pipelane config or rename the conflicting command.`,
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

// Extract the inner text between a start/end marker pair, or null if the pair is
// absent or malformed. `lastIndexOf` on the end marker so pasted content that
// itself contains the literal `:end -->` doesn't truncate on the next re-sync.
// Strips the one newline immediately after the start marker and before the end
// marker (they terminate the marker lines themselves); any blank lines placed
// inside are preserved verbatim. `\r?\n` handles CRLF-saved Windows files.
function extractMarkedRegionInner(content: string, startMarker: string, endMarker: string): string | null {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.lastIndexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return null;
  }
  const inner = content.slice(startIndex + startMarker.length, endIndex);
  return inner.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function extractConsumerExtension(content: string): string | null {
  return extractMarkedRegionInner(content, CONSUMER_EXTENSION_MARKER_START, CONSUMER_EXTENSION_MARKER_END);
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

// Compute the legacy on-disk filename for a managed command. Extras
// (pipelane.md, fix.md) keep fixed filenames; workflow commands follow the
// consumer's alias map. Active setup no longer writes these files into consumer
// repos.
function managedClaudeCommandFilename(
  name: ManagedCommand,
  aliases: Record<WorkflowCommand, string>,
): string {
  if ((MANAGED_EXTRA_COMMANDS as readonly string[]).includes(name)) {
    return `${name}.md`;
  }
  return `${aliasCommandName(aliases[name as WorkflowCommand])}.md`;
}

// Render legacy managed-command content, including any preserved
// consumer-extension block.
function renderManagedClaudeCommand(
  name: ManagedCommand,
  config: WorkflowConfig,
  capturedExtension: string | null,
): string {
  const rendered = renderTemplate(readTemplate(`.claude/commands/${name}.md`), config);
  return injectConsumerExtension(rendered, capturedExtension);
}

function resolveEffectiveSyncDocs(_repoRoot: string, config: WorkflowConfig): Required<SyncDocsConfig> {
  return resolveSyncDocs(config.syncDocs);
}

function shouldScaffoldClaudeMd(syncDocs: Required<SyncDocsConfig>): boolean {
  void syncDocs;
  return false;
}

function shouldScaffoldRepoGuidance(syncDocs: Required<SyncDocsConfig>): boolean {
  void syncDocs;
  return false;
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

// Legacy package-script consistency check. Repo-local command generation is no
// longer supported, so there is no package-script fallback to enforce.
function assertPackageScriptConsistency(repoRoot: string, syncDocs: Required<SyncDocsConfig>): void {
  void repoRoot;
  void syncDocs;
}

export function syncConsumerDocs(repoRoot: string, config: WorkflowConfig): void {
  const syncDocs = resolveEffectiveSyncDocs(repoRoot, config);
  assertPackageScriptConsistency(repoRoot, syncDocs);
}

export function initConsumerRepo(cwd: string, projectName: string): { repoRoot: string; configPath: string } {
  void cwd;
  void projectName;
  throw new Error(
    'pipelane init is no longer supported. Use `pipelane install-codex` or `pipelane install-claude` once per machine, then run `pipelane setup` in the repo.',
  );
}

export interface SetupConsumerRepoResult {
  repoRoot: string;
  workflowConfigPath: string;
  workflowConfigCreated: boolean;
  workflowConfigSource: 'existing-machine' | 'legacy-pipelane-json' | 'legacy-project-workflow-json' | 'legacy-package-json' | 'synthesized';
  createdClaude: boolean;
  createdRepoGuidance: boolean;
  skippedClaudeScaffold: boolean;
  skippedRepoGuidanceScaffold: boolean;
  codexSkillsDir: string;
  installedCodexSkills: string[];
  removedLegacyCodexSkills: string[];
  agentsGuidanceMigrations: AgentsGuidanceMigration[];
  appliedAgentsGuidanceMigrations: AgentsGuidanceMigration[];
  claudeGuidanceMigrations: ClaudeGuidanceMigration[];
  appliedClaudeGuidanceMigrations: ClaudeGuidanceMigration[];
  lessonsMigration: LessonsMigration | null;
  appliedLessonsMigration: LessonsMigration | null;
  warnings: string[];
  taskStartCommand: string;
}

export interface CodexSkillDrift {
  skillsDir: string;
  addedSkills: string[];
  updatedSkills: string[];
  removedLegacySkills: string[];
  runnerDrift: boolean;
}

export interface SetupConsumerRepoOptions {
  applyAgentsGuidanceMigrations?: boolean;
  applyClaudeGuidanceMigrations?: boolean;
  applyLessonsMigration?: boolean;
}

interface SetupWorkflowConfig {
  config: WorkflowConfig;
  configPath: string;
  created: boolean;
  source: SetupConsumerRepoResult['workflowConfigSource'];
}

function setupWorkflowConfig(repoRoot: string): SetupWorkflowConfig {
  const readableConfigPath = resolveReadableConfigPath(repoRoot);
  if (readableConfigPath) {
    return {
      config: loadWorkflowConfig(repoRoot),
      configPath: readableConfigPath,
      created: false,
      source: 'existing-machine',
    };
  }

  const imported = importLegacyWorkflowConfigIfNeeded(repoRoot);
  if (!imported) {
    const config = loadWorkflowConfig(repoRoot);
    writeWorkflowConfig(repoRoot, config);
    return {
      config,
      configPath: resolveConfigPath(repoRoot),
      created: true,
      source: 'synthesized',
    };
  }
  return {
    config: imported.config,
    configPath: imported.configPath,
    created: true,
    source: imported.source,
  };
}

export interface AgentsGuidanceReplacement {
  line: number;
  before: string;
  after: string;
}

export interface AgentsGuidanceMigration {
  file: 'AGENTS.md';
  path: string;
  sectionAction?: 'insert' | 'replace';
  insertAfterLine?: number;
  anchor?: string;
  replaceStartLine?: number;
  replaceEndLine?: number;
  block?: string;
  replacements: AgentsGuidanceReplacement[];
}

export interface ClaudeGuidanceMigration {
  file: 'CLAUDE.md';
  path: string;
  action: 'insert' | 'replace';
  insertAfterLine: number;
  anchor: string;
  replaceStartLine?: number;
  replaceEndLine?: number;
  block: string;
}

const AGENTS_GUIDANCE_EXTRA_COMMANDS: Record<string, string> = {
  board: '/pipelane web',
  update: '/pipelane update',
};

function replacementForAgentsWorkflowCommand(command: string, aliases: Record<WorkflowCommand, string>): string | null {
  if ((MANAGED_WORKFLOW_COMMANDS as readonly string[]).includes(command)) {
    return aliases[command as WorkflowCommand];
  }
  return AGENTS_GUIDANCE_EXTRA_COMMANDS[command] ?? null;
}

function migrateAgentsGuidanceLine(line: string, aliases: Record<WorkflowCommand, string>): string {
  const staleScriptPattern = /\bnpm\s+run\s+(?:workflow|pipelane):([a-z0-9-]+)(?:\s+--(?=\s|$))?/gi;
  const migrated = line.replace(staleScriptPattern, (match, rawCommand: string) => {
    const replacement = replacementForAgentsWorkflowCommand(rawCommand.toLowerCase(), aliases);
    return replacement ?? match;
  });

  return [
    `${aliases.new} --task "task name"`,
    `${aliases.new} --task 'task name'`,
    `${aliases.new} --task "<task-name>"`,
    `${aliases.new} --task '<task-name>'`,
    `${aliases.new} --task <task-name>`,
  ].reduce((next, placeholder) => next.replaceAll(placeholder, aliases.new), migrated);
}

function renderAgentsGuidanceBlock(config: WorkflowConfig): string {
  return renderTemplate(readTemplate('AGENTS.md'), config).trimEnd();
}

function renderAgentsMarkedSection(block: string): string {
  return `${AGENTS_MARKER_START}\n${block.trimEnd()}\n${AGENTS_MARKER_END}`;
}

function findAgentsGuidanceBlock(lines: string[]): { startIndex: number; endIndex: number } | null {
  const startIndex = lines.findIndex((line) => line.includes(AGENTS_MARKER_START));
  if (startIndex < 0) {
    return null;
  }
  const relativeEndIndex = lines
    .slice(startIndex + 1)
    .findIndex((line) => line.includes(AGENTS_MARKER_END));
  if (relativeEndIndex < 0) {
    return null;
  }
  return {
    startIndex,
    endIndex: startIndex + 1 + relativeEndIndex,
  };
}

function hasAgentsWorkspacePolicy(content: string, config: WorkflowConfig): boolean {
  const aliases = resolveWorkflowAliases(config.aliases);
  return content.includes('For any code-changing task')
    && content.includes('Pipelane task workspace')
    && content.includes('dirty unrelated worktree')
    && content.includes(aliases.new)
    && content.includes(aliases.adopt)
    && content.includes(aliases.resume)
    && content.includes(aliases['repo-guard']);
}

function findAgentsPolicyInsertionPoint(lines: string[]): { insertAfterLine: number; anchor: string } {
  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (firstHeadingIndex >= 0) {
    return { insertAfterLine: firstHeadingIndex + 1, anchor: lines[firstHeadingIndex] ?? '' };
  }

  return { insertAfterLine: 0, anchor: '' };
}

function detectAgentsSectionMigration(
  content: string,
  lines: string[],
  config: WorkflowConfig,
): Pick<AgentsGuidanceMigration, 'sectionAction' | 'insertAfterLine' | 'anchor' | 'replaceStartLine' | 'replaceEndLine' | 'block'> | null {
  const desiredBlock = renderAgentsGuidanceBlock(config);
  const existingBlock = findAgentsGuidanceBlock(lines);
  if (existingBlock) {
    const existingInner = extractMarkedRegionInner(content, AGENTS_MARKER_START, AGENTS_MARKER_END);
    if (existingInner !== null && existingInner.trimEnd() === desiredBlock) {
      return null;
    }
    return {
      sectionAction: 'replace',
      replaceStartLine: existingBlock.startIndex + 1,
      replaceEndLine: existingBlock.endIndex + 1,
      block: desiredBlock,
    };
  }

  if (hasAgentsWorkspacePolicy(content, config)) {
    return null;
  }

  const insertion = findAgentsPolicyInsertionPoint(lines);
  return {
    sectionAction: 'insert',
    insertAfterLine: insertion.insertAfterLine,
    anchor: insertion.anchor,
    block: desiredBlock,
  };
}

function detectAgentsGuidanceMigrationsForConfig(repoRoot: string, config: WorkflowConfig): AgentsGuidanceMigration[] {
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (!existsSync(agentsPath)) {
    return [];
  }

  const aliases = resolveWorkflowAliases(config.aliases);
  const replacements: AgentsGuidanceReplacement[] = [];
  const content = readFileSync(agentsPath, 'utf8');
  let insideManagedSection = false;
  const lines = content.split('\n');

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

  const sectionMigration = detectAgentsSectionMigration(content, lines, config);
  if (replacements.length === 0 && !sectionMigration) {
    return [];
  }

  return [{ file: 'AGENTS.md', path: agentsPath, replacements, ...sectionMigration }];
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
    if (migration.sectionAction === 'replace') {
      const existingBlock = findAgentsGuidanceBlock(lines);
      if (!existingBlock) {
        throw new Error(
          `${migration.file} changed while preparing the AGENTS.md guidance migration. Re-run setup to recompute the proposed edits.`,
        );
      }
      lines.splice(existingBlock.startIndex, existingBlock.endIndex - existingBlock.startIndex + 1, ...renderAgentsMarkedSection(migration.block ?? '').split('\n'));
    } else if (migration.sectionAction === 'insert') {
      if (content.includes(AGENTS_MARKER_START)) {
        continue;
      }
      if (migration.insertAfterLine && migration.insertAfterLine > 0 && lines[migration.insertAfterLine - 1] !== migration.anchor) {
        throw new Error(
          `${migration.file}:${migration.insertAfterLine} changed while preparing the AGENTS.md guidance migration. Re-run setup to recompute the proposed edits.`,
        );
      }
      const insertAt = Math.max(0, migration.insertAfterLine ?? 0);
      lines.splice(insertAt, 0, '', renderAgentsMarkedSection(migration.block ?? ''), '');
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
    const answer = (await rl.question('Apply these AGENTS.md changes? Enter 1 or Y to proceed. [Y/n] ')).trim().toLowerCase();
    if (answer !== '' && answer !== '1' && answer !== 'y' && answer !== 'yes') {
      return [];
    }
  } finally {
    rl.close();
  }
  return applyAgentsGuidanceMigrations(migrations);
}

export interface LessonsMigration {
  file: 'CLAUDE.md';
  path: string;
  action: 'insert' | 'resync';
}

// Returns CLAUDE.md content with the managed Lessons block inserted (when the
// block is absent) or its instruction prose refreshed while the entries region
// is preserved verbatim (when present). Returns null when no change is needed,
// or when the block is malformed (left for a human to resolve).
function computeLessonsBlockUpdate(content: string): string | null {
  const startIndex = content.indexOf(LESSONS_MARKER_START);
  if (startIndex === -1) {
    const base = content.replace(/\s*$/, '');
    const next = `${base}\n\n${renderLessonsBlock()}\n`;
    return next === content ? null : next;
  }
  // First end marker AT/AFTER the start (indexOf, NOT lastIndexOf): the block
  // sits mid-file, so consumer prose below it may legitimately quote the literal
  // end marker (e.g. docs about these markers). lastIndexOf would latch onto that
  // quote, and the rebuild below would delete everything between the real
  // terminator and the quote. The inner entries:end still uses lastIndexOf (those
  // entries are genuinely terminal within the block). The outer end marker is not
  // a substring of the entries:end marker, so this never mis-binds to the latter.
  const endIndex = content.indexOf(LESSONS_MARKER_END, startIndex);
  if (endIndex === -1) {
    return null;
  }
  // Extract entries strictly from inside the outer block, and bail if the
  // entries markers are missing or malformed: rebuilding with empty entries
  // would silently discard accreted lessons, the one thing this must never do.
  const blockInner = content.slice(startIndex + LESSONS_MARKER_START.length, endIndex);
  const entriesInner = extractMarkedRegionInner(blockInner, LESSONS_ENTRIES_MARKER_START, LESSONS_ENTRIES_MARKER_END);
  if (entriesInner === null) {
    return null;
  }
  const rebuilt = renderLessonsBlock(entriesInner);
  const next = `${content.slice(0, startIndex)}${rebuilt}${content.slice(endIndex + LESSONS_MARKER_END.length)}`;
  return next === content ? null : next;
}

// Detect whether an existing CLAUDE.md needs the Lessons block inserted or
// refreshed. Returns null when there is no CLAUDE.md (the create-from-template
// path already seeds the block) or the block is already current.
function detectLessonsMigrationForRepo(repoRoot: string): LessonsMigration | null {
  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  if (!existsSync(claudePath)) {
    return null;
  }
  const content = readFileSync(claudePath, 'utf8');
  if (computeLessonsBlockUpdate(content) === null) {
    return null;
  }
  return {
    file: 'CLAUDE.md',
    path: claudePath,
    action: content.includes(LESSONS_MARKER_START) ? 'resync' : 'insert',
  };
}

export function applyLessonsMigration(migration: LessonsMigration | null): LessonsMigration | null {
  if (!migration) {
    return null;
  }
  const content = readFileSync(migration.path, 'utf8');
  const next = computeLessonsBlockUpdate(content);
  if (next === null) {
    return null;
  }
  writeFileSync(migration.path, next, 'utf8');
  return migration;
}

export function formatLessonsMigration(migration: LessonsMigration): string[] {
  return [
    migration.action === 'insert'
      ? `- Add the managed \`## Lessons\` block to ${migration.file} (capture instruction + empty entries region).`
      : `- Refresh the \`## Lessons\` instruction prose in ${migration.file}; existing lesson entries are preserved verbatim.`,
  ];
}

export async function applyLessonsMigrationWithApproval(
  migration: LessonsMigration | null,
  options: { yes?: boolean } = {},
): Promise<LessonsMigration | null> {
  if (!migration) {
    return null;
  }
  if (options.yes) {
    return applyLessonsMigration(migration);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }
  process.stdout.write(`${formatLessonsMigration(migration).join('\n')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Apply this CLAUDE.md Lessons block change? Enter 1 or Y to proceed. [Y/n] ')).trim().toLowerCase();
    if (answer !== '' && answer !== '1' && answer !== 'y' && answer !== 'yes') {
      return null;
    }
  } finally {
    rl.close();
  }
  return applyLessonsMigration(migration);
}

export function formatAgentsGuidanceMigrations(migrations: AgentsGuidanceMigration[]): string[] {
  const lines: string[] = [];
  for (const migration of migrations) {
    if (migration.sectionAction === 'replace') {
      lines.push(`${migration.file} has stale Pipelane task workspace policy guidance:`);
      lines.push(`- replace ${migration.file}:${migration.replaceStartLine}-${migration.replaceEndLine}`);
    } else if (migration.sectionAction === 'insert') {
      lines.push(`${migration.file} is missing the Pipelane task workspace policy:`);
      lines.push(
        migration.insertAfterLine && migration.insertAfterLine > 0
          ? `- insert after ${migration.file}:${migration.insertAfterLine}`
          : `- insert at the top of ${migration.file}`,
      );
    }
    if (migration.replacements.length > 0) {
      lines.push(`${migration.file} contains stale Pipelane command guidance that should be migrated:`);
      for (const replacement of migration.replacements) {
        lines.push(`- ${migration.file}:${replacement.line}`);
        lines.push(`  current: ${replacement.before}`);
        lines.push(`  proposed: ${replacement.after}`);
      }
    }
  }
  return [
    ...lines,
    'These updates keep task starts on the managed slash-command path, avoid npm-script PATH failures before node_modules is linked, and prevent agents from editing shared or dirty unrelated worktrees.',
  ];
}

function hasLocalClaudeWorkspacePolicy(content: string, config: WorkflowConfig): boolean {
  const aliases = resolveWorkflowAliases(config.aliases);
  return content.includes('For any code-changing task')
    && content.includes('Pipelane task workspace')
    && content.includes('before editing')
    && content.includes('Chat has not moved')
    && content.includes('shared checkout')
    && content.includes(aliases.new)
    && content.includes(aliases.resume)
    && content.includes(aliases['repo-guard']);
}

function findClaudePolicyInsertionPoint(lines: string[]): { insertAfterLine: number; anchor: string } {
  const localDefaultsIndex = lines.findIndex((line) => line.trim() === '## Local Operator Defaults');
  if (localDefaultsIndex >= 0) {
    return { insertAfterLine: localDefaultsIndex + 1, anchor: lines[localDefaultsIndex] ?? '' };
  }

  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (firstHeadingIndex >= 0) {
    return { insertAfterLine: firstHeadingIndex + 1, anchor: lines[firstHeadingIndex] ?? '' };
  }

  return { insertAfterLine: 0, anchor: '' };
}

function findClaudeWorkspacePolicyBlock(lines: string[]): { startIndex: number; endIndex: number } | null {
  const startIndex = lines.findIndex((line) => line.includes(CLAUDE_WORKSPACE_POLICY_MARKER_START));
  if (startIndex < 0) {
    return null;
  }
  const relativeEndIndex = lines
    .slice(startIndex + 1)
    .findIndex((line) => line.includes(CLAUDE_WORKSPACE_POLICY_MARKER_END));
  if (relativeEndIndex < 0) {
    return null;
  }
  return {
    startIndex,
    endIndex: startIndex + 1 + relativeEndIndex,
  };
}

function detectClaudeGuidanceMigrationsForConfig(repoRoot: string, config: WorkflowConfig): ClaudeGuidanceMigration[] {
  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  if (!existsSync(claudePath)) {
    return [];
  }

  const content = readFileSync(claudePath, 'utf8');
  if (hasLocalClaudeWorkspacePolicy(content, config)) {
    return [];
  }

  const lines = content.split('\n');
  const existingBlock = findClaudeWorkspacePolicyBlock(lines);
  if (existingBlock) {
    return [{
      file: 'CLAUDE.md',
      path: claudePath,
      action: 'replace',
      insertAfterLine: 0,
      anchor: '',
      replaceStartLine: existingBlock.startIndex + 1,
      replaceEndLine: existingBlock.endIndex + 1,
      block: renderLocalClaudeWorkspacePolicy(config),
    }];
  }

  const insertion = findClaudePolicyInsertionPoint(lines);
  return [{
    file: 'CLAUDE.md',
    path: claudePath,
    action: 'insert',
    insertAfterLine: insertion.insertAfterLine,
    anchor: insertion.anchor,
    block: renderLocalClaudeWorkspacePolicy(config),
  }];
}

export function applyClaudeGuidanceMigrations(migrations: ClaudeGuidanceMigration[]): ClaudeGuidanceMigration[] {
  const applied: ClaudeGuidanceMigration[] = [];
  for (const migration of migrations) {
    const content = readFileSync(migration.path, 'utf8');
    const lines = content.split('\n');
    if (migration.action === 'replace') {
      const existingBlock = findClaudeWorkspacePolicyBlock(lines);
      if (!existingBlock) {
        throw new Error(
          `${migration.file} changed while preparing the CLAUDE.md guidance migration. Re-run setup to recompute the proposed edits.`,
        );
      }
      lines.splice(existingBlock.startIndex, existingBlock.endIndex - existingBlock.startIndex + 1, ...migration.block.split('\n'));
      writeFileSync(migration.path, lines.join('\n'), 'utf8');
      applied.push(migration);
      continue;
    }
    if (content.includes(CLAUDE_WORKSPACE_POLICY_MARKER_START)) {
      continue;
    }
    if (migration.insertAfterLine > 0 && lines[migration.insertAfterLine - 1] !== migration.anchor) {
      throw new Error(
        `${migration.file}:${migration.insertAfterLine} changed while preparing the CLAUDE.md guidance migration. Re-run setup to recompute the proposed edits.`,
      );
    }
    const insertAt = Math.max(0, migration.insertAfterLine);
    const blockLines = ['', migration.block, ''];
    lines.splice(insertAt, 0, ...blockLines);
    writeFileSync(migration.path, lines.join('\n'), 'utf8');
    applied.push(migration);
  }
  return applied;
}

export async function applyClaudeGuidanceMigrationsWithApproval(
  migrations: ClaudeGuidanceMigration[],
  options: { yes?: boolean } = {},
): Promise<ClaudeGuidanceMigration[]> {
  if (migrations.length === 0) {
    return [];
  }
  if (options.yes) {
    return applyClaudeGuidanceMigrations(migrations);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return [];
  }

  process.stdout.write(`${formatClaudeGuidanceMigrations(migrations).join('\n')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Apply these CLAUDE.md changes? Enter 1 or Y to proceed. [Y/n] ')).trim().toLowerCase();
    if (answer !== '' && answer !== '1' && answer !== 'y' && answer !== 'yes') {
      return [];
    }
  } finally {
    rl.close();
  }
  return applyClaudeGuidanceMigrations(migrations);
}

export function formatClaudeGuidanceMigrations(migrations: ClaudeGuidanceMigration[]): string[] {
  const lines: string[] = [];
  for (const migration of migrations) {
    if (migration.action === 'replace') {
      lines.push(`${migration.file} has stale Pipelane task workspace policy guidance:`);
      lines.push(`- replace ${migration.file}:${migration.replaceStartLine}-${migration.replaceEndLine}`);
    } else {
      lines.push(`${migration.file} is missing the Pipelane task workspace policy:`);
      lines.push(
        migration.insertAfterLine > 0
          ? `- insert after ${migration.file}:${migration.insertAfterLine}`
          : `- insert at the top of ${migration.file}`,
      );
    }
  }
  return [
    ...lines,
    'This local guidance tells Claude to start code-changing work with /new, resume existing task worktrees with /resume, and avoid editing from shared or unrelated checkouts.',
  ];
}

export function setupConsumerRepo(cwd: string, options: SetupConsumerRepoOptions = {}): SetupConsumerRepoResult {
  const repoRoot = resolveRepoRoot(cwd, true);
  const workflowConfig = setupWorkflowConfig(repoRoot);
  const config = workflowConfig.config;
  syncConsumerDocs(repoRoot, config);
  const scaffoldClaudeMd = false;
  const scaffoldRepoGuidance = false;

  const claudePath = path.join(repoRoot, 'CLAUDE.md');
  let createdClaude = false;
  let skippedClaudeScaffold = false;
  if (!existsSync(claudePath) && scaffoldClaudeMd) {
    writeFileSync(claudePath, renderClaudeMdFromTemplate(config), 'utf8');
    createdClaude = true;
  } else if (!existsSync(claudePath)) {
    skippedClaudeScaffold = true;
  }

  // REPO_GUIDANCE.md is consumer-owned forever. Active setup does not create or
  // re-sync it; if the file exists, preserve whatever the consumer customized.
  const repoGuidancePath = path.join(repoRoot, 'REPO_GUIDANCE.md');
  let createdRepoGuidance = false;
  let skippedRepoGuidanceScaffold = false;
  if (!existsSync(repoGuidancePath) && scaffoldRepoGuidance) {
    writeFileSync(repoGuidancePath, readTemplate('REPO_GUIDANCE.template.md'), 'utf8');
    createdRepoGuidance = true;
  } else if (!existsSync(repoGuidancePath)) {
    skippedRepoGuidanceScaffold = true;
  }

  const removedLegacyCodexSkills: string[] = [];
  let agentsGuidanceMigrations = detectAgentsGuidanceMigrationsForConfig(repoRoot, config);
  const appliedAgentsGuidanceMigrations = options.applyAgentsGuidanceMigrations
    ? applyAgentsGuidanceMigrations(agentsGuidanceMigrations)
    : [];
  if (appliedAgentsGuidanceMigrations.length > 0) {
    agentsGuidanceMigrations = detectAgentsGuidanceMigrationsForConfig(repoRoot, config);
  }
  let claudeGuidanceMigrations = detectClaudeGuidanceMigrationsForConfig(repoRoot, config);
  const appliedClaudeGuidanceMigrations = options.applyClaudeGuidanceMigrations
    ? applyClaudeGuidanceMigrations(claudeGuidanceMigrations)
    : [];
  if (appliedClaudeGuidanceMigrations.length > 0) {
    claudeGuidanceMigrations = detectClaudeGuidanceMigrationsForConfig(repoRoot, config);
  }
  const lessonsMigration: LessonsMigration | null = null;
  const appliedLessonsMigration: LessonsMigration | null = null;

  return {
    repoRoot,
    workflowConfigPath: workflowConfig.configPath,
    workflowConfigCreated: workflowConfig.created,
    workflowConfigSource: workflowConfig.source,
    createdClaude,
    createdRepoGuidance,
    skippedClaudeScaffold,
    skippedRepoGuidanceScaffold,
    codexSkillsDir: path.join(repoRoot, '.agents', 'skills'),
    installedCodexSkills: [],
    removedLegacyCodexSkills,
    agentsGuidanceMigrations,
    appliedAgentsGuidanceMigrations,
    claudeGuidanceMigrations,
    appliedClaudeGuidanceMigrations,
    lessonsMigration,
    appliedLessonsMigration,
    warnings: [],
    taskStartCommand: resolveWorkflowAliases(config.aliases).new,
  };
}

export function syncDocsOnly(cwd: string): { repoRoot: string } {
  void cwd;
  throw new Error(
    'pipelane sync-docs is no longer supported. Use durable machine-local commands with `pipelane install-codex` or `pipelane install-claude`, then run `pipelane setup` in the repo.',
  );
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
  claudeGuidance: { willScaffold: boolean };
  repoGuidance: { willScaffold: boolean };
  // Legacy sync surfaces setup would have re-rendered. Active setup forces
  // these off via resolveSyncDocs(), so this should stay empty for normal
  // consumers.
  otherSurfaces: string[];
  agentsGuidanceMigrations: AgentsGuidanceMigration[];
  claudeGuidanceMigrations: ClaudeGuidanceMigration[];
  lessonsMigration: LessonsMigration | null;
  warnings: string[];
}

// Pure-detection mirror of legacy syncConsumerDocs/setup writes. Active setup is
// machine-local only, so repo-local adapter/doc/script drift should not become a
// setup trigger. Used by /pipelane update for compatibility reporting and
// machine-local host refresh hints.
export function detectSetupDrift(cwd: string): SetupDrift {
  const repoRoot = resolveRepoRoot(cwd, true);
  const config = loadWorkflowConfig(repoRoot);
  const syncDocs = resolveEffectiveSyncDocs(repoRoot, config);
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

  const codex = {
    skillsDir: path.join(repoRoot, '.agents', 'skills'),
    addedSkills: [],
    updatedSkills: [],
    removedLegacySkills: [],
    runnerDrift: false,
    enabled: false,
  };

  // Local guidance scaffolds are no longer created by setup.
  const claudeGuidance = {
    willScaffold: shouldScaffoldClaudeMd(syncDocs) && !existsSync(path.join(repoRoot, 'CLAUDE.md')),
  };
  const repoGuidance = {
    willScaffold: shouldScaffoldRepoGuidance(syncDocs) && !existsSync(path.join(repoRoot, 'REPO_GUIDANCE.md')),
  };

  // Other legacy re-rendered surfaces — each conditional block in the old
  // syncConsumerDocs path.
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
  const agentsGuidanceMigrations = detectAgentsGuidanceMigrationsForConfig(repoRoot, config);
  const claudeGuidanceMigrations = detectClaudeGuidanceMigrationsForConfig(repoRoot, config);
  const lessonsMigration = shouldScaffoldClaudeMd(syncDocs)
    ? detectLessonsMigrationForRepo(repoRoot)
    : null;

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
    // Approval-gated guidance migrations (AGENTS.md guidance lines, the CLAUDE.md
    // Lessons block) are intentionally NOT needsSetup triggers: they cannot
    // auto-apply in a non-TTY run without --yes, so gating needsSetup on them
    // would force perpetual setup re-runs. They are surfaced via the follow-up
    // message and applied opportunistically with approval (see runUpdate's
    // up-to-date / behind-main paths and emitDriftHint).
    needsSetup:
      claudeDirty ||
      codexDirty ||
      claudeGuidance.willScaffold ||
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
    claudeGuidance,
    repoGuidance,
    otherSurfaces,
    agentsGuidanceMigrations,
    claudeGuidanceMigrations,
    lessonsMigration,
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
    return 'Release mode can use saved machine-local deploy configuration.';
  }
  return 'Release mode still requires deploy configuration. Run `/pipelane configure` in Claude/Codex, or `pipelane configure --json ...` for scripted setup; no repo files are written.';
}

// Canonical setup-complete output. Used by `pipelane setup` (cli.ts) and by
// `pipelane update`'s inline-setup path (update.ts) so both entry points
// emit the same lines in the same order.
export function formatSetupResult(result: SetupConsumerRepoResult): string[] {
  const lines: string[] = [
    `Pipelane setup complete in ${result.repoRoot}`,
    formatWorkflowConfigSetupLine(result),
    result.createdClaude
      ? 'Created local CLAUDE.md from a legacy scaffold.'
      : result.skippedClaudeScaffold
        ? 'No local CLAUDE.md scaffold written; Pipelane guidance comes from durable machine-local commands.'
        : 'Left existing local CLAUDE.md untouched.',
    result.createdRepoGuidance
      ? 'Created REPO_GUIDANCE.md from a legacy scaffold — run `/fix refresh-guidance` to fill it in.'
      : result.skippedRepoGuidanceScaffold
        ? 'No REPO_GUIDANCE.md scaffold written; Pipelane no longer creates repo-local adapter surfaces.'
        : 'Left existing REPO_GUIDANCE.md untouched.',
    `Task start rule: for new code-changing work, run \`${result.taskStartCommand}\` with an inferred task label, then switch to the reported worktree before editing.`,
    setupDeployConfigMessage(result.repoRoot),
  ];
  lines.push('Using durable machine-local commands; no tracked .agents skills were written.');
  if (result.removedLegacyCodexSkills.length > 0) {
    lines.push(`Removed legacy machine-local wrapper skills: ${result.removedLegacyCodexSkills.join(', ')}`);
  }
  if (result.appliedAgentsGuidanceMigrations.length > 0) {
    const count = result.appliedAgentsGuidanceMigrations
      .reduce((sum, migration) => sum + migration.replacements.length, 0);
    const updatedSection = result.appliedAgentsGuidanceMigrations
      .some((migration) => Boolean(migration.sectionAction));
    if (updatedSection) {
      lines.push('Legacy setup updated AGENTS.md with the Pipelane task workspace policy.');
    }
    if (count > 0) {
      lines.push(`Legacy setup updated AGENTS.md stale workflow guidance (${count} line${count === 1 ? '' : 's'}).`);
    }
  }
  if (result.appliedClaudeGuidanceMigrations.length > 0) {
    lines.push('Legacy setup updated CLAUDE.md with the Pipelane task workspace policy.');
  }
  if (result.agentsGuidanceMigrations.length > 0) {
    lines.push('AGENTS.md consumer-owned guidance note:');
    lines.push(...formatAgentsGuidanceMigrations(result.agentsGuidanceMigrations));
    lines.push('Pipelane setup will not rewrite AGENTS.md. Apply any wanted guidance edits manually in the application repo.');
  }
  if (result.claudeGuidanceMigrations.length > 0) {
    lines.push('CLAUDE.md consumer-owned guidance note:');
    lines.push(...formatClaudeGuidanceMigrations(result.claudeGuidanceMigrations));
    lines.push('Pipelane setup will not rewrite CLAUDE.md. Apply any wanted guidance edits manually in the application repo.');
  }
  if (result.appliedLessonsMigration) {
    lines.push(result.appliedLessonsMigration.action === 'insert'
      ? 'Legacy setup added the managed CLAUDE.md Lessons block.'
      : 'Legacy setup refreshed the CLAUDE.md Lessons block (existing entries preserved).');
  }
  if (result.lessonsMigration) {
    lines.push('CLAUDE.md Lessons block guidance note:');
    lines.push(...formatLessonsMigration(result.lessonsMigration));
    lines.push('Pipelane setup will not rewrite CLAUDE.md. Add the Lessons block manually if this repo wants it.');
  }
  if (result.warnings.length > 0) {
    lines.push('Readiness warnings:');
    lines.push(...result.warnings.map((warning) => `- ${warning}`));
  }
  lines.push('If Claude or Codex was already open, reopen the repo or restart the client to refresh commands and skills.');
  return lines;
}

function formatWorkflowConfigSetupLine(result: SetupConsumerRepoResult): string {
  if (!result.workflowConfigCreated) {
    return `Using existing machine-local Pipelane config at ${result.workflowConfigPath}.`;
  }
  if (result.workflowConfigSource === 'legacy-pipelane-json') {
    return `Migrated legacy repo-local .pipelane.json into machine-local config at ${result.workflowConfigPath}.`;
  }
  if (result.workflowConfigSource === 'legacy-project-workflow-json') {
    return `Migrated legacy repo-local .project-workflow.json into machine-local config at ${result.workflowConfigPath}.`;
  }
  if (result.workflowConfigSource === 'legacy-package-json') {
    return `Migrated legacy package.json:pipelane config into machine-local config at ${result.workflowConfigPath}.`;
  }
  return `Created machine-local Pipelane config from repo defaults at ${result.workflowConfigPath}.`;
}

export function maybeInitGitRepo(repoRoot: string): void {
  if (!existsSync(path.join(repoRoot, '.git'))) {
    runGit(repoRoot, ['init', '-b', 'main']);
  }
}
