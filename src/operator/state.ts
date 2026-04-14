import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Mode = 'build' | 'release';
export type KnownSurface = 'frontend' | 'edge' | 'sql';

export interface WorkflowConfig {
  version: number;
  projectKey: string;
  displayName: string;
  baseBranch: string;
  stateDir: string;
  taskWorktreeDirName: string;
  surfaces: string[];
  aliases: Record<string, string>;
  prePrChecks: string[];
  deployWorkflowName: string;
  buildMode: {
    description: string;
    autoDeployOnMerge: boolean;
  };
  releaseMode: {
    description: string;
    requireStagingPromotion: boolean;
  };
}

export interface ModeState {
  mode: Mode;
  requestedSurfaces: string[];
  override: null | {
    reason: string;
    timestamp: string;
  };
  updatedAt: string | null;
}

export interface TaskLock {
  taskSlug: string;
  taskName?: string;
  branchName: string;
  worktreePath: string;
  mode: Mode;
  surfaces: string[];
  updatedAt: string;
}

export interface PrRecord {
  taskSlug: string;
  branchName: string;
  title: string;
  number?: number;
  url?: string;
  mergedSha?: string;
  mergedAt?: string;
  updatedAt: string;
}

export interface DeployRecord {
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  workflowName: string;
  requestedAt: string;
}

export interface OperatorFlags {
  apply: boolean;
  json: boolean;
  offline: boolean;
  override: boolean;
  reason: string;
  sha: string;
  task: string;
  title: string;
  message: string;
  mode: string;
  surfaces: string[];
}

export interface ParsedOperatorArgs {
  command: string;
  positional: string[];
  flags: OperatorFlags;
}

export interface WorkflowContext {
  cwd: string;
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  modeState: ModeState;
}

export const DEFAULT_MODE: Mode = 'build';
export const DEFAULT_SURFACES = ['frontend', 'edge', 'sql'];
export const CONFIG_FILENAME = '.project-workflow.json';
const MODE_STATE_FILENAME = 'mode-state.json';
const PR_STATE_FILENAME = 'pr-state.json';
const DEPLOY_STATE_FILENAME = 'deploy-state.json';
const TASK_LOCKS_DIRNAME = 'task-locks';

export function defaultWorkflowConfig(projectKey: string, displayName: string): WorkflowConfig {
  return {
    version: 1,
    projectKey,
    displayName,
    baseBranch: 'main',
    stateDir: 'workflow-kit-state',
    taskWorktreeDirName: `${projectKey}-worktrees`,
    surfaces: [...DEFAULT_SURFACES],
    aliases: {
      devmode: '/devmode',
      new: '/new',
      resume: '/resume',
      pr: '/pr',
      merge: '/merge',
      deploy: '/deploy',
      clean: '/clean',
    },
    prePrChecks: [
      'npm run test',
      'npm run typecheck',
      'npm run build',
    ],
    deployWorkflowName: 'Deploy Hosted',
    buildMode: {
      description: 'Fast lane. Production deploy is expected to happen after merge.',
      autoDeployOnMerge: true,
    },
    releaseMode: {
      description: 'Protected lane. Promote the same merged SHA through staging before prod.',
      requireStagingPromotion: true,
    },
  };
}

export function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugifyTaskName(taskName: string): string {
  return taskName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): string | null {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (error) {
    if (options.allowFailure) {
      return null;
    }

    const err = error as { stderr?: Buffer | string; message: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : err.stderr?.toString().trim();
    throw new Error(stderr || err.message);
  }
}

export function runCommandCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { ok: boolean; exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return {
      ok: false,
      exitCode: result.status ?? 1,
      stdout: '',
      stderr: result.error.message,
    };
  }

  return {
    ok: result.status === 0,
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

export function runGit(cwd: string, args: string[], allowFailure = false): string | null {
  return runCommand('git', args, { cwd, allowFailure });
}

export function runGh(cwd: string, args: string[], allowFailure = false): string | null {
  return runCommand('gh', args, { cwd, allowFailure });
}

export function runShell(cwd: string, command: string, quiet = false): void {
  execFileSync('sh', ['-lc', command], {
    cwd,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

export function resolveRepoRoot(cwd: string, allowNoGit = false): string {
  const repoRoot = runGit(cwd, ['rev-parse', '--show-toplevel'], allowNoGit);

  if (repoRoot) {
    return normalizePath(repoRoot);
  }

  if (allowNoGit) {
    return normalizePath(cwd);
  }

  throw new Error('Not inside a git repository.');
}

export function resolveGitCommonDir(repoRoot: string): string {
  const commonDir = runGit(repoRoot, ['rev-parse', '--git-common-dir']);

  if (!commonDir) {
    throw new Error('Could not resolve the git common dir.');
  }

  return normalizePath(path.resolve(repoRoot, commonDir));
}

export function resolveConfigPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILENAME);
}

export function loadWorkflowConfig(repoRoot: string): WorkflowConfig {
  const configPath = resolveConfigPath(repoRoot);

  if (!existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${repoRoot}. Run workflow-kit init first.`);
  }

  return JSON.parse(readFileSync(configPath, 'utf8')) as WorkflowConfig;
}

export function writeWorkflowConfig(repoRoot: string, config: WorkflowConfig): void {
  writeJsonFile(resolveConfigPath(repoRoot), config);
}

export function resolveStateDir(commonDir: string, config: WorkflowConfig): string {
  return path.join(commonDir, config.stateDir);
}

export function ensureStateDir(commonDir: string, config: WorkflowConfig): string {
  const stateDir = resolveStateDir(commonDir, config);
  mkdirSync(path.join(stateDir, TASK_LOCKS_DIRNAME), { recursive: true });
  return stateDir;
}

export function modeStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), MODE_STATE_FILENAME);
}

export function deployStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), DEPLOY_STATE_FILENAME);
}

export function prStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), PR_STATE_FILENAME);
}

export function taskLockPath(commonDir: string, config: WorkflowConfig, taskSlug: string): string {
  return path.join(resolveStateDir(commonDir, config), TASK_LOCKS_DIRNAME, `${taskSlug}.json`);
}

export function readJsonFile<T>(targetPath: string, fallback: T): T {
  if (!existsSync(targetPath)) {
    return fallback;
  }

  return JSON.parse(readFileSync(targetPath, 'utf8')) as T;
}

export function writeJsonFile(targetPath: string, value: unknown): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function loadModeState(commonDir: string, config: WorkflowConfig): ModeState {
  return readJsonFile(modeStatePath(commonDir, config), {
    mode: DEFAULT_MODE,
    requestedSurfaces: [...config.surfaces],
    override: null,
    updatedAt: null,
  } satisfies ModeState);
}

export function saveModeState(commonDir: string, config: WorkflowConfig, value: ModeState): void {
  ensureStateDir(commonDir, config);
  writeJsonFile(modeStatePath(commonDir, config), value);
}

export function loadDeployState(commonDir: string, config: WorkflowConfig): { records: DeployRecord[] } {
  return readJsonFile(deployStatePath(commonDir, config), { records: [] as DeployRecord[] });
}

export function saveDeployState(commonDir: string, config: WorkflowConfig, value: { records: DeployRecord[] }): void {
  ensureStateDir(commonDir, config);
  writeJsonFile(deployStatePath(commonDir, config), value);
}

export function loadPrState(commonDir: string, config: WorkflowConfig): { records: Record<string, PrRecord> } {
  return readJsonFile(prStatePath(commonDir, config), { records: {} as Record<string, PrRecord> });
}

export function savePrState(commonDir: string, config: WorkflowConfig, value: { records: Record<string, PrRecord> }): void {
  ensureStateDir(commonDir, config);
  writeJsonFile(prStatePath(commonDir, config), value);
}

export function loadPrRecord(commonDir: string, config: WorkflowConfig, taskSlug: string): PrRecord | null {
  return loadPrState(commonDir, config).records[taskSlug] ?? null;
}

export function savePrRecord(commonDir: string, config: WorkflowConfig, taskSlug: string, record: Omit<PrRecord, 'taskSlug' | 'updatedAt'> & { updatedAt?: string }): PrRecord {
  const state = loadPrState(commonDir, config);
  const next: PrRecord = {
    ...(state.records[taskSlug] ?? {
      taskSlug,
      branchName: record.branchName,
      title: record.title,
      updatedAt: nowIso(),
    }),
    ...record,
    taskSlug,
    updatedAt: record.updatedAt ?? nowIso(),
  };
  state.records[taskSlug] = next;
  savePrState(commonDir, config, state);
  return next;
}

export function loadTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string): TaskLock | null {
  return readJsonFile(taskLockPath(commonDir, config, taskSlug), null);
}

export function saveTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string, value: TaskLock): TaskLock {
  ensureStateDir(commonDir, config);
  writeJsonFile(taskLockPath(commonDir, config, taskSlug), value);
  return value;
}

export function removeTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string): void {
  const targetPath = taskLockPath(commonDir, config, taskSlug);
  if (existsSync(targetPath)) {
    unlinkSync(targetPath);
  }
}

export function loadAllTaskLocks(commonDir: string, config: WorkflowConfig): TaskLock[] {
  const lockDir = path.join(resolveStateDir(commonDir, config), TASK_LOCKS_DIRNAME);

  if (!existsSync(lockDir)) {
    return [];
  }

  return readdirSync(lockDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const targetPath = path.join(lockDir, entry);
      return JSON.parse(readFileSync(targetPath, 'utf8')) as TaskLock;
    })
    .sort((left, right) => left.taskSlug.localeCompare(right.taskSlug));
}

export function surfaceSetKey(values: string[]): string {
  return [...new Set(values.filter(Boolean))].sort().join(',');
}

export function resolveWorkflowContext(cwd: string): WorkflowContext {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadWorkflowConfig(repoRoot);
  const commonDir = resolveGitCommonDir(repoRoot);
  const modeState = loadModeState(commonDir, config);
  return {
    cwd,
    repoRoot,
    commonDir,
    config,
    modeState,
  };
}

export function printResult(flags: OperatorFlags | { json?: boolean }, output: unknown): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (typeof output === 'object' && output !== null && 'message' in output) {
    process.stdout.write(`${String((output as { message: string }).message)}\n`);
    return;
  }

  process.stdout.write(`${String(output)}\n`);
}

export function inferProjectKey(projectName: string): string {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

export function parseOperatorArgs(argv: string[]): ParsedOperatorArgs {
  const positional: string[] = [];
  const flags: OperatorFlags = {
    apply: false,
    json: false,
    offline: false,
    override: false,
    reason: '',
    sha: '',
    task: '',
    title: '',
    message: '',
    mode: '',
    surfaces: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--apply') {
      flags.apply = true;
      continue;
    }

    if (token === '--json') {
      flags.json = true;
      continue;
    }

    if (token === '--offline') {
      flags.offline = true;
      continue;
    }

    if (token === '--override') {
      flags.override = true;
      continue;
    }

    if (token === '--reason') {
      flags.reason = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--task') {
      flags.task = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--title') {
      flags.title = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--message') {
      flags.message = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--sha') {
      flags.sha = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--mode') {
      flags.mode = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--surfaces') {
      const raw = argv[index + 1] ?? '';
      flags.surfaces.push(...raw.split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }

    positional.push(token);
  }

  return {
    command: positional[0] ?? '',
    positional: positional.slice(1),
    flags,
  };
}

export function parseSurfaceList(config: WorkflowConfig, values: string[]): string[] {
  const requested = [...new Set(values.flatMap((value) => value.split(',').map((item) => item.trim()).filter(Boolean)))];

  for (const surface of requested) {
    if (!config.surfaces.includes(surface)) {
      throw new Error(`Unsupported surface "${surface}". Supported surfaces: ${config.surfaces.join(', ')}`);
    }
  }

  return requested.length > 0 ? requested : [...config.surfaces];
}

export function homeCodexDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
