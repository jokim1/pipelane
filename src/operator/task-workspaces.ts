import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { AutoCleanupBlockerCode, Mode, TaskLock, WorkflowConfig } from './state.ts';
import {
  normalizePath,
  normalizeExistingPath,
  nowIso,
  runGit,
  runCommandCapture,
  loadAllTaskLocks,
  loadTaskLock,
  inspectTaskWorkspaceLease,
  newTaskBindingId,
  saveTaskLock,
  taskLockPath,
  slugifyTaskName,
} from './state.ts';

export interface RemovedTaskLock {
  taskSlug: string;
  branchName: string;
  worktreePath: string;
  surfaces: string[];
  reasons: string[];
}

export interface SkippedTaskLock {
  taskSlug: string;
  branchName: string;
  worktreePath: string;
  reason: string;
}

// v0.7: /clean --apply must not yank a lock out from under a task that was
// just started. Locks refreshed within this window are treated as live.
export const TASK_LOCK_MIN_PRUNE_AGE_MS = 5 * 60 * 1000;

export function readWorktreeStatus(repoRoot: string): { branchName: string; statusLines: string[]; dirty: boolean } {
  const branchName = runGit(repoRoot, ['branch', '--show-current']) ?? '';
  const statusText = runGit(repoRoot, ['status', '--short'], true) ?? '';
  const statusLines = statusText.split('\n').map((item) => item.trimEnd()).filter(Boolean);
  return {
    branchName,
    statusLines,
    dirty: statusLines.length > 0,
  };
}

export function resolveSharedRepoRoot(commonDir: string): string {
  return normalizePath(path.dirname(commonDir));
}

function resolveLinkableSharedRepoRoot(commonDir: string): string | null {
  const normalizedCommonDir = normalizePath(commonDir);
  const modulesSegment = `${path.sep}.git${path.sep}modules${path.sep}`;
  if (normalizedCommonDir.includes(modulesSegment)) {
    return null;
  }
  return resolveSharedRepoRoot(commonDir);
}

export function resolveTaskWorktreeRoot(commonDir: string, config: WorkflowConfig): string {
  const sharedRepoRoot = resolveSharedRepoRoot(commonDir);
  return path.join(path.dirname(sharedRepoRoot), config.taskWorktreeDirName);
}

/**
 * Returned whenever a symlinked node_modules is present in a worktree. Running
 * `npm ci` or `npm install` in a worktree whose node_modules is a symlink
 * can cause npm's reify step to wipe the *shared* node_modules as a side
 * effect (npm treats the symlink as a "non-directory" to remove, and some
 * npm versions follow into the target first). Agents running dep setup
 * autonomously hit this regularly — ship the mitigation in-band so it is
 * impossible to miss.
 */
export const SHARED_NODE_MODULES_NPMCI_WARNING =
  'node_modules in this worktree is a symlink into the shared repo\'s ' +
  'node_modules. Do NOT run `npm ci` or `npm install` in this worktree ' +
  'without breaking the symlink first — npm may wipe the shared ' +
  'node_modules as a side effect. To safely reinstall deps here: ' +
  '`rm node_modules && npm install` (the `rm` only removes the symlink, ' +
  'not its target).';

export function isSharedNodeModulesSetupNote(message: string): boolean {
  return message === SHARED_NODE_MODULES_NPMCI_WARNING;
}

export function ensureSharedNodeModulesLink(
  commonDir: string,
  worktreePath: string,
  options: { replaceExistingDirectory?: boolean } = {},
): string | null {
  const sharedRepoRoot = resolveLinkableSharedRepoRoot(commonDir);
  if (!sharedRepoRoot) {
    return null;
  }
  const normalizedSharedRepoRoot = normalizePath(sharedRepoRoot);
  const normalizedWorktreePath = normalizePath(worktreePath);

  if (normalizedSharedRepoRoot === normalizedWorktreePath) {
    return null;
  }

  const sourceNodeModules = path.join(sharedRepoRoot, 'node_modules');
  if (!existsSync(sourceNodeModules)) {
    return null;
  }

  const targetNodeModules = path.join(worktreePath, 'node_modules');

  try {
    const existing = lstatSync(targetNodeModules);
    if (existing.isSymbolicLink()) {
      if (existsSync(targetNodeModules)) {
        return SHARED_NODE_MODULES_NPMCI_WARNING;
      }
      unlinkSync(targetNodeModules);
    }

    if (existing.isDirectory() && options.replaceExistingDirectory) {
      rmSync(targetNodeModules, { recursive: true, force: true });
    } else {
      return null;
    }
  } catch {
    // Missing target is the normal case for a fresh worktree.
  }

  try {
    symlinkSync(sourceNodeModules, targetNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
    return SHARED_NODE_MODULES_NPMCI_WARNING;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return `Could not link shared node_modules into ${worktreePath}: ${err.message}`;
  }
}

export interface WorktreeBootstrapResult {
  kind: 'symlinked' | 'noop' | 'error';
  message: string | null;
}

/**
 * Auto-bootstrap missing node_modules in an externally-created worktree by
 * symlinking the shared repo's node_modules. `pipelane:new` / `pipelane:resume`
 * / `pipelane:repo-guard` already do this for pipelane-managed worktrees;
 * this function covers the case where a worktree was created by some other
 * tool (Claude Code's worktrees feature, manual `git worktree add`, etc.)
 * and the user runs a pipelane command in it before any pipelane setup.
 *
 * Conservative trigger: only fires when the worktree has no `node_modules`
 * directory at all. If the user installed deps manually, leave it alone.
 */
export function bootstrapWorktreeNodeModulesIfNeeded(cwd: string): WorktreeBootstrapResult {
  const worktreePathRaw = runGit(cwd, ['rev-parse', '--show-toplevel'], true);
  const commonDirRaw = runGit(cwd, ['rev-parse', '--git-common-dir'], true);
  if (!worktreePathRaw || !commonDirRaw) {
    return { kind: 'noop', message: null };
  }
  const worktreePath = worktreePathRaw.trim();
  const commonDirRel = commonDirRaw.trim();
  const commonDir = path.isAbsolute(commonDirRel) ? commonDirRel : path.resolve(worktreePath, commonDirRel);

  const sharedRepoRoot = resolveLinkableSharedRepoRoot(commonDir);
  if (!sharedRepoRoot) {
    return { kind: 'noop', message: null };
  }
  if (normalizePath(sharedRepoRoot) === normalizePath(worktreePath)) {
    return { kind: 'noop', message: null };
  }

  const targetNodeModules = path.join(worktreePath, 'node_modules');
  if (existsSync(targetNodeModules)) {
    return { kind: 'noop', message: null };
  }

  const result = ensureSharedNodeModulesLink(commonDir, worktreePath);
  if (result === null) {
    return { kind: 'noop', message: null };
  }
  if (result === SHARED_NODE_MODULES_NPMCI_WARNING) {
    return {
      kind: 'symlinked',
      message:
        `[pipelane] Linked node_modules into worktree from shared repo at ${sharedRepoRoot}.\n` +
        `[pipelane] Dependency setup note: ${SHARED_NODE_MODULES_NPMCI_WARNING}`,
    };
  }
  return { kind: 'error', message: result };
}

export function generateHex(): string {
  return crypto.randomBytes(2).toString('hex');
}

export function generateUniqueBranch(repoRoot: string, config: WorkflowConfig, taskSlug: string): { branchName: string; hex: string } {
  let hex = generateHex();
  let branchName = `${config.branchPrefix}${taskSlug}-${hex}`;

  while (
    runGit(repoRoot, ['branch', '--list', branchName], true)?.trim()
    || runGit(repoRoot, ['ls-remote', '--heads', 'origin', branchName], true)?.trim()
  ) {
    hex = generateHex();
    branchName = `${config.branchPrefix}${taskSlug}-${hex}`;
  }

  return { branchName, hex };
}

export function generateUniqueTaskWorkspace(repoRoot: string, commonDir: string, config: WorkflowConfig, taskSlug: string): {
  branchName: string;
  hex: string;
  worktreePath: string;
} {
  let unique = generateUniqueBranch(repoRoot, config, taskSlug);
  let worktreePath = normalizePath(path.join(resolveTaskWorktreeRoot(commonDir, config), `${taskSlug}-${unique.hex}`));

  while (existsSync(worktreePath)) {
    unique = generateUniqueBranch(repoRoot, config, taskSlug);
    worktreePath = normalizePath(path.join(resolveTaskWorktreeRoot(commonDir, config), `${taskSlug}-${unique.hex}`));
  }

  return {
    ...unique,
    worktreePath,
  };
}

export function resolveTaskBaseRef(repoRoot: string, baseBranch: string, offline = false): { sourceRef: string; warnings: string[] } {
  const remoteRef = `origin/${baseBranch}`;
  const fetchResult = runCommandCapture('git', ['fetch', 'origin', baseBranch], { cwd: repoRoot });

  if (fetchResult.ok) {
    if (!runGit(repoRoot, ['rev-parse', '--verify', remoteRef], true)) {
      throw new Error(`Could not resolve ${remoteRef} after refreshing it.`);
    }
    return {
      sourceRef: remoteRef,
      warnings: [],
    };
  }

  if (!offline) {
    throw new Error([
      `Could not refresh ${remoteRef}.`,
      fetchResult.stderr || fetchResult.stdout || 'git fetch failed.',
      'Re-run with --offline to branch from the local base if you knowingly want to proceed without a fresh remote fetch.',
    ].join('\n'));
  }

  if (!runGit(repoRoot, ['rev-parse', '--verify', baseBranch], true)) {
    throw new Error(`Could not fall back to local ${baseBranch} because that branch does not exist.`);
  }

  return {
    sourceRef: baseBranch,
    warnings: [`Could not refresh ${remoteRef}. Using local ${baseBranch} because --offline was passed.`],
  };
}

export function resolveTaskCommandIdentity(taskName: string): { taskName: string; taskSlug: string } {
  const normalizedTaskName = taskName.trim();
  const taskSlug = slugifyTaskName(normalizedTaskName);

  if (!normalizedTaskName) {
    throw new Error('Task name is required.');
  }

  if (!taskSlug) {
    throw new Error('Could not derive a valid task slug from --task.');
  }

  return {
    taskName: normalizedTaskName,
    taskSlug,
  };
}

export function formatWorktreeDisplayPath(repoRoot: string, worktreePath: string): string {
  const relative = path.relative(repoRoot, worktreePath);
  return relative && relative !== '' ? relative : worktreePath;
}

export function buildTaskWorkspaceOutput(options: {
  repoRoot: string;
  taskName: string;
  taskSlug: string;
  branchName: string;
  worktreePath: string;
  mode: Mode;
  createdWorktree: boolean;
  resumed: boolean;
  warnings?: string[];
  reasons?: string[];
  // v1.4: persisted TaskLock.nextAction breadcrumb (set by /pr, /merge,
  // /deploy, etc.). Surfaced by /resume so AI↔AI handoff picks up where
  // the prior session left off. Null/blank = no breadcrumb yet.
  lockNextAction?: string | null;
}): {
  taskName: string;
  taskSlug: string;
  branch: string;
  worktreePath: string;
  worktreeDisplayPath: string;
  mode: Mode;
  nextAction: string;
  lockNextAction: string | null;
  chatMoved: boolean;
  createdWorktree: boolean;
  resumed: boolean;
  warnings: string[];
  reasons: string[];
  message: string;
} {
  const warnings = options.warnings ?? [];
  const dependencySetupNotes = warnings.filter(isSharedNodeModulesSetupNote);
  const userWarnings = warnings.filter((warning) => !isSharedNodeModulesSetupNote(warning));
  const reasons = options.reasons ?? [];
  const worktreeDisplayPath = formatWorktreeDisplayPath(options.repoRoot, options.worktreePath);
  const nextAction = `Switch this chat/workspace to ${worktreeDisplayPath}, then continue the task there.`;
  const lockNextAction = options.lockNextAction?.trim() || null;
  const lines = [
    `Continue this task in: ${worktreeDisplayPath}`,
    `Task: ${options.taskName}`,
    `Slug: ${options.taskSlug}`,
    `Branch: ${options.branchName}`,
    `Mode: ${options.mode}`,
  ];

  if (lockNextAction) {
    lines.push(`Last logged step: ${lockNextAction}`);
  }

  if (userWarnings.length > 0) {
    lines.push('Warnings:');
    lines.push(...userWarnings.map((warning) => `- ${warning}`));
  }

  if (dependencySetupNotes.length > 0) {
    lines.push('Dependency setup notes:');
    lines.push(...dependencySetupNotes.map((note) => `- ${note}`));
  }

  if (reasons.length > 0) {
    lines.push('Why this workspace was chosen:');
    lines.push(...reasons.map((reason) => `- ${reason}`));
  }

  lines.push('Chat has not moved. Switch this chat/workspace to that path before editing.');

  return {
    taskName: options.taskName,
    taskSlug: options.taskSlug,
    branch: options.branchName,
    worktreePath: options.worktreePath,
    worktreeDisplayPath,
    mode: options.mode,
    nextAction,
    lockNextAction,
    chatMoved: false,
    createdWorktree: options.createdWorktree,
    resumed: options.resumed,
    warnings,
    reasons,
    message: lines.join('\n'),
  };
}

export function buildCurrentWorkspaceReasons(options: {
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  taskSlug: string;
}): string[] {
  const { branchName, statusLines } = readWorktreeStatus(options.repoRoot);
  const reasons = ['starting a new task always creates a fresh isolated workspace'];

  if (statusLines.length > 0) {
    reasons.push('current worktree has uncommitted changes');
  }

  const repoPath = normalizeExistingPath(options.repoRoot);
  const currentLock = loadAllTaskLocks(options.commonDir, options.config).find((lock) =>
    lock.taskSlug !== options.taskSlug
    && (lock.branchName === branchName || normalizeExistingPath(lock.worktreePath) === repoPath)
  );

  if (currentLock) {
    reasons.push(`current worktree is already locked by task ${currentLock.taskSlug}`);
  }

  return reasons;
}

export interface PruneDeadTaskLocksOptions {
  // Restrict pruning to a single task slug. When set, only that lock is
  // considered; everything else is ignored. Used by `/clean --apply --task`.
  taskSlug?: string;
  // Minimum age (ms) a lock must have before it is eligible for pruning.
  // Defaults to TASK_LOCK_MIN_PRUNE_AGE_MS so an interrupted operator can't
  // sweep a lock that another operator just wrote.
  minAgeMs?: number;
  // Override the clock for tests.
  now?: () => number;
}

export interface PruneDeadTaskLocksResult {
  removed: RemovedTaskLock[];
  skipped: SkippedTaskLock[];
}

export function pruneDeadTaskLocks(
  commonDir: string,
  config: WorkflowConfig,
  options: PruneDeadTaskLocksOptions = {},
): PruneDeadTaskLocksResult {
  const removed: RemovedTaskLock[] = [];
  const skipped: SkippedTaskLock[] = [];
  const minAgeMs = options.minAgeMs ?? TASK_LOCK_MIN_PRUNE_AGE_MS;
  const now = (options.now ?? (() => Date.now()))();

  const isTargetedScope = options.taskSlug !== undefined;

  for (const lock of loadAllTaskLocks(commonDir, config)) {
    if (options.taskSlug && lock.taskSlug !== options.taskSlug) {
      continue;
    }

    const reasons: string[] = [];

    const workspaceLease = inspectTaskWorkspaceLease(commonDir, config, lock.taskSlug);
    if (workspaceLease.status !== 'unlocked') {
      skipped.push({
        taskSlug: lock.taskSlug,
        branchName: lock.branchName,
        worktreePath: lock.worktreePath,
        reason: workspaceLease.status === 'owned'
          ? `workspace is in use by ${workspaceLease.owner.command}`
          : 'workspace lease ownership is malformed; refusing to prune',
      });
      continue;
    }
    if (!isTargetedScope && lock.cleanup) {
      skipped.push({
        taskSlug: lock.taskSlug,
        branchName: lock.branchName,
        worktreePath: lock.worktreePath,
        reason: `cleanup lifecycle state is ${lock.cleanup.status}; stale metadata sweeping does not remove lifecycle intent`,
      });
      continue;
    }

    if (!existsSync(lock.worktreePath)) {
      reasons.push(`saved worktree ${lock.worktreePath} no longer exists`);
    }

    const branchExists = runGit(resolveSharedRepoRoot(commonDir), ['rev-parse', '--verify', lock.branchName], true);
    if (!branchExists) {
      reasons.push(`saved branch ${lock.branchName} no longer exists`);
    }

    // --all-stale mode (no taskSlug): require the worktree or branch to be
    // missing before we'll prune. The operator didn't name a lock, so we
    // need objective evidence the lock is abandoned.
    //
    // --task <slug> mode: the operator explicitly named one lock and said
    // "prune it". Honor that even if the worktree + branch are still
    // intact — the operator's judgment is the authority at this point.
    // The lock is pure metadata; removing it does not touch the worktree
    // or branch, so the blast radius is bounded. (The age floor below
    // still applies.)
    if (reasons.length === 0 && !isTargetedScope) {
      continue;
    }
    if (reasons.length === 0 && isTargetedScope) {
      reasons.push('operator scope: --task targeted this lock for removal');
    }

    if (minAgeMs > 0) {
      const lockAgeMs = lockAge(lock.updatedAt, now);
      if (lockAgeMs === null) {
        // Fail-closed: a corrupt/missing updatedAt is *more* suspicious, not
        // less. We don't know if it's in flight or a legacy artifact, so we
        // refuse to prune under the age floor and let the operator decide.
        skipped.push({
          taskSlug: lock.taskSlug,
          branchName: lock.branchName,
          worktreePath: lock.worktreePath,
          reason: `updatedAt is missing or unparseable ("${lock.updatedAt ?? ''}") — refusing to prune under the ${Math.round(minAgeMs / 1000)}s floor`,
        });
        continue;
      }
      if (lockAgeMs < minAgeMs) {
        skipped.push({
          taskSlug: lock.taskSlug,
          branchName: lock.branchName,
          worktreePath: lock.worktreePath,
          reason: `updatedAt ${lock.updatedAt} is ${Math.round(lockAgeMs / 1000)}s old — below the ${Math.round(minAgeMs / 1000)}s prune floor`,
        });
        continue;
      }
    }

    const targetPath = taskLockPath(commonDir, config, lock.taskSlug);
    try {
      unlinkSync(targetPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // Two parallel `/clean --apply --all-stale` runs will both observe a
      // dead lock and race to delete. Second deleter gets ENOENT; swallow it
      // — the lock is already gone, which is the outcome we wanted.
      if (err.code !== 'ENOENT') throw error;
    }
    removed.push({
      taskSlug: lock.taskSlug,
      branchName: lock.branchName,
      worktreePath: lock.worktreePath,
      surfaces: lock.surfaces,
      reasons,
    });
  }

  return { removed, skipped };
}

function lockAge(updatedAt: string | undefined, now: number): number | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

export function findPrunedTaskLock(removed: RemovedTaskLock[], taskSlug: string): RemovedTaskLock | null {
  return removed.find((entry) => entry.taskSlug === taskSlug) ?? null;
}

export function listActiveTaskLocks(commonDir: string, config: WorkflowConfig): TaskLock[] {
  return loadAllTaskLocks(commonDir, config);
}

export function saveNewTaskLock(options: {
  commonDir: string;
  config: WorkflowConfig;
  taskSlug: string;
  taskName: string;
  taskBrief?: TaskLock['taskBrief'];
  branchName: string;
  worktreePath: string;
  mode: Mode;
  surfaces: string[];
}): TaskLock {
  return saveTaskLock(options.commonDir, options.config, options.taskSlug, {
    taskSlug: options.taskSlug,
    taskName: options.taskName,
    taskBindingId: newTaskBindingId(),
    taskBrief: options.taskBrief,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
    mode: options.mode,
    surfaces: options.surfaces,
    updatedAt: nowIso(),
  });
}

export type DeliveryProof =
  | {
      kind: 'merged-pr-head';
      prNumber: number;
      prHeadSha: string;
      mergedSha: string;
      remoteBaseRef: string;
      remoteBaseSha: string;
    }
  | {
      kind: 'remote-ancestor';
      branchHeadSha: string;
      remoteBaseRef: string;
      remoteBaseSha: string;
    };

export interface CleanupEvidenceRevision {
  remoteBaseSha: string;
  observedAt: string;
  source: 'merge-fetch' | 'reconcile-fetch' | 'snapshot-local';
}

export interface CleanupStatusSnapshot {
  ok: boolean;
  trackedChanges: number;
  untrackedEntries: string[];
  ignoredEntries: string[];
  protectedIgnoredEntries: string[];
  error?: string;
}

export interface TaskCleanupAssessmentInput {
  automatic: boolean;
  automaticEnabled: boolean;
  lock: TaskLock;
  taskBindingId: string;
  sharedRepoRoot: string | null;
  callerCwd: string;
  worktreeExists: boolean;
  observedBranchName: string;
  branchHeadSha: string;
  branchExists: boolean;
  status: CleanupStatusSnapshot;
  proof: DeliveryProof | null;
  proofContained: boolean;
  evidence: CleanupEvidenceRevision | null;
}

export type BranchDeletionAuthorization = {
  kind: DeliveryProof['kind'];
  expectedBranchHeadSha: string;
  remoteBaseSha: string;
};

export type TaskCleanupAssessment =
  | {
      status: 'eligible';
      taskSlug: string;
      expectedBranchHeadSha: string;
      branchDeletion: BranchDeletionAuthorization;
      evidence: CleanupEvidenceRevision;
    }
  | {
      status: 'blocked';
      taskSlug: string;
      code: AutoCleanupBlockerCode;
      reason: string;
    }
  | {
      status: 'kept';
      taskSlug: string;
      reason: 'operator-requested' | 'automatic-cleanup-disabled';
    };

function canonicalPath(value: string): string {
  try {
    return normalizePath(realpathSync(value));
  } catch {
    return normalizePath(path.resolve(value));
  }
}

function pathContainsOrEquals(parent: string, candidate: string): boolean {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function parsePorcelainV1Z(output: string): Array<{ code: string; path: string }> {
  const tokens = output.split('\0');
  const entries: Array<{ code: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 3 || token[2] !== ' ') {
      entries.push({ code: '??', path: token });
      continue;
    }
    const code = token.slice(0, 2);
    entries.push({ code, path: token.slice(3) });
    if ((code[0] === 'R' || code[0] === 'C') && index + 1 < tokens.length) index += 1;
  }
  return entries;
}

function isVerifiedSharedNodeModulesLink(worktreePath: string, sharedRepoRoot: string, ignoredPath: string): boolean {
  const normalized = ignoredPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized !== 'node_modules') return false;
  const candidate = path.join(worktreePath, ignoredPath);
  const expected = path.join(sharedRepoRoot, 'node_modules');
  try {
    return lstatSync(candidate).isSymbolicLink()
      && existsSync(expected)
      && canonicalPath(candidate) === canonicalPath(expected);
  } catch {
    return false;
  }
}

function isConfiguredDisposableIgnoredPath(
  worktreePath: string,
  ignoredPath: string,
  configuredRoots: string[],
): boolean {
  const relativeCandidate = ignoredPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!relativeCandidate || path.isAbsolute(relativeCandidate)) return false;
  const candidate = path.resolve(worktreePath, relativeCandidate);
  if (!pathContainsOrEquals(worktreePath, candidate)) return false;
  for (const root of configuredRoots) {
    const rootPath = path.resolve(worktreePath, root);
    if (!pathContainsOrEquals(worktreePath, rootPath)) continue;
    // A disposable root must not overlap version-controlled content. The
    // ignored entry itself is absent from `git ls-files`, but deleting its
    // enclosing worktree would also delete any tracked files beneath the
    // configured root. Keep the entire root protected in that case.
    const tracked = runCommandCapture('git', ['ls-files', '-z', '--', `:(literal)${root}`], {
      cwd: worktreePath,
      preserveOutput: true,
    });
    if (!tracked.ok || tracked.stdout.length > 0) continue;
    const lexicalRelative = path.relative(rootPath, candidate);
    if (lexicalRelative !== '' && (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative))) continue;
    try {
      if (!pathContainsOrEquals(worktreePath, realpathSync(rootPath))) continue;
      if (!pathContainsOrEquals(realpathSync(rootPath), realpathSync(candidate))) continue;
    } catch {
      return false;
    }
    return true;
  }
  return false;
}

export function inspectCleanupStatus(options: {
  worktreePath: string;
  sharedRepoRoot: string;
  disposableIgnoredPaths?: string[];
}): CleanupStatusSnapshot {
  const result = runCommandCapture(
    'git',
    ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all'],
    { cwd: options.worktreePath, preserveOutput: true },
  );
  if (!result.ok) {
    return {
      ok: false,
      trackedChanges: 0,
      untrackedEntries: [],
      ignoredEntries: [],
      protectedIgnoredEntries: [],
      error: result.stderr.trim() || result.stdout.trim() || 'git status failed',
    };
  }
  let trackedChanges = 0;
  const untrackedEntries: string[] = [];
  const ignoredEntries: string[] = [];
  const protectedIgnoredEntries: string[] = [];
  for (const entry of parsePorcelainV1Z(result.stdout)) {
    if (entry.code === '!!') {
      ignoredEntries.push(entry.path);
      if (!isVerifiedSharedNodeModulesLink(options.worktreePath, options.sharedRepoRoot, entry.path)
        && !isConfiguredDisposableIgnoredPath(options.worktreePath, entry.path, options.disposableIgnoredPaths ?? [])) {
        protectedIgnoredEntries.push(entry.path);
      }
    } else if (entry.code === '??') {
      untrackedEntries.push(entry.path);
    } else {
      trackedChanges += 1;
    }
  }
  return { ok: true, trackedChanges, untrackedEntries, ignoredEntries, protectedIgnoredEntries };
}

export function assessTaskCleanup(input: TaskCleanupAssessmentInput): TaskCleanupAssessment {
  const taskSlug = input.lock.taskSlug;
  if (input.automatic && !input.automaticEnabled) {
    return { status: 'kept', taskSlug, reason: 'automatic-cleanup-disabled' };
  }
  if (input.automatic && input.lock.cleanup?.status === 'kept' && input.lock.cleanup.taskBindingId === input.taskBindingId) {
    return { status: 'kept', taskSlug, reason: 'operator-requested' };
  }
  if (!input.lock.taskBindingId || input.lock.taskBindingId !== input.taskBindingId) {
    return { status: 'blocked', taskSlug, code: 'state-conflict', reason: 'Task binding identity is missing or changed.' };
  }
  if (!input.sharedRepoRoot) {
    return { status: 'blocked', taskSlug, code: 'shared-checkout-unavailable', reason: 'The primary shared checkout could not be resolved.' };
  }
  if (canonicalPath(input.lock.worktreePath) === canonicalPath(input.sharedRepoRoot)) {
    return { status: 'blocked', taskSlug, code: 'shared-checkout', reason: 'The primary shared checkout is never eligible for task cleanup.' };
  }
  if (input.worktreeExists && pathContainsOrEquals(input.lock.worktreePath, input.callerCwd)) {
    return { status: 'blocked', taskSlug, code: 'caller-inside', reason: `The Pipelane process is still inside ${input.lock.worktreePath}.` };
  }
  if (input.worktreeExists) {
    if (!input.status.ok) {
      return { status: 'blocked', taskSlug, code: 'status-failed', reason: input.status.error ?? 'Could not inspect worktree status.' };
    }
    if (!input.observedBranchName) {
      return { status: 'blocked', taskSlug, code: 'detached', reason: 'The task worktree is detached.' };
    }
    if (input.observedBranchName !== input.lock.branchName) {
      return { status: 'blocked', taskSlug, code: 'branch-mismatch', reason: `Expected branch ${input.lock.branchName}, found ${input.observedBranchName}.` };
    }
    if (input.status.trackedChanges > 0 || input.status.untrackedEntries.length > 0) {
      return { status: 'blocked', taskSlug, code: 'uncommitted', reason: 'The task worktree has tracked or untracked changes.' };
    }
    if (input.status.protectedIgnoredEntries.length > 0) {
      return {
        status: 'blocked',
        taskSlug,
        code: 'ignored-content',
        reason: `Protected ignored content remains: ${input.status.protectedIgnoredEntries.join(', ')}`,
      };
    }
  }
  if (!input.branchExists) {
    if (!input.worktreeExists && input.lock.cleanup) {
      const targetSha = input.lock.cleanup.targetSha;
      return {
        status: 'eligible',
        taskSlug,
        expectedBranchHeadSha: targetSha,
        branchDeletion: { kind: input.proof?.kind ?? 'remote-ancestor', expectedBranchHeadSha: targetSha, remoteBaseSha: input.evidence?.remoteBaseSha ?? targetSha },
        evidence: input.evidence ?? { remoteBaseSha: targetSha, observedAt: nowIso(), source: 'snapshot-local' },
      };
    }
    return { status: 'blocked', taskSlug, code: 'branch-missing', reason: `Local branch ${input.lock.branchName} is missing.` };
  }
  if (!input.proof || !input.evidence) {
    return { status: 'blocked', taskSlug, code: 'delivery-proof-insufficient', reason: 'No typed remote-base delivery proof is available.' };
  }
  const proofExpectedHead = input.proof.kind === 'merged-pr-head' ? input.proof.prHeadSha : input.proof.branchHeadSha;
  if (!input.branchHeadSha || input.branchHeadSha !== proofExpectedHead || input.evidence.remoteBaseSha !== input.proof.remoteBaseSha) {
    return { status: 'blocked', taskSlug, code: 'delivery-proof-drift', reason: 'The local branch head or remote evidence revision changed after proof capture.' };
  }
  if (!input.proofContained) {
    return { status: 'blocked', taskSlug, code: 'delivery-proof-insufficient', reason: 'The captured remote base does not contain the delivery proof target.' };
  }
  return {
    status: 'eligible',
    taskSlug,
    expectedBranchHeadSha: input.branchHeadSha,
    branchDeletion: {
      kind: input.proof.kind,
      expectedBranchHeadSha: input.branchHeadSha,
      remoteBaseSha: input.proof.remoteBaseSha,
    },
    evidence: input.evidence,
  };
}

export interface RemoveTaskArtifactsResult {
  // What was actually removed. False entries are either "already gone" or
  // "skipped because the safety check fired without --force"; the `errors`
  // list explains which.
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  // Non-fatal notes (e.g. "worktree directory was already missing").
  warnings: string[];
  // Fatal blockers that prevented removal. Empty when both removals
  // succeeded (or were no-ops because the target was already gone).
  errors: string[];
}

/**
 * Tear down a task's worktree + local branch as the end-of-task close-out.
 * The lock file is the caller's responsibility and must be pruned only after
 * both artifacts are gone, so a blocker or crash retains retry identity.
 *
 * Safety floor (skipped when `force === true`):
 * - Worktree must have no tracked or untracked changes. Protected ignored
 *   content is also rejected when `requireNoIgnoredContent` is enabled.
 * - A forceful branch delete requires typed delivery authorization plus the
 *   exact branch-head SHA captured by the assessor. Tree equality alone never
 *   authorizes deletion.
 *
 * Refuses when the worktree being removed is the caller's current
 * directory — git rejects that and the operator should `cd` out first.
 */
export function removeTaskArtifacts(options: {
  sharedRepoRoot: string;
  worktreePath: string;
  branchName: string;
  callerCwd: string;
  force: boolean;
  expectedBranchHeadSha?: string;
  branchDeletionAuthorized?: boolean;
  disposableIgnoredPaths?: string[];
  requireNoIgnoredContent?: boolean;
  /** @deprecated Tree equality is diagnostic only and is intentionally ignored. */
  safeDeleteBranchRef?: string;
}): RemoveTaskArtifactsResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  let worktreeRemoved = false;
  let branchRemoved = false;

  if (canonicalPath(options.worktreePath) === canonicalPath(options.sharedRepoRoot)) {
    errors.push(`Refusing to remove the primary shared checkout ${options.sharedRepoRoot}.`);
    return { worktreeRemoved, branchRemoved, warnings, errors };
  }

  const callerInsideTarget = pathContainsOrEquals(options.worktreePath, options.callerCwd);
  if (callerInsideTarget && existsSync(options.worktreePath)) {
    errors.push(
      `Cannot remove worktree ${options.worktreePath} while inside it. ` +
      `cd to a different directory (e.g. ${options.sharedRepoRoot}) and retry.`,
    );
    return { worktreeRemoved, branchRemoved, warnings, errors };
  }

  // Step 1: worktree removal.
  if (!existsSync(options.worktreePath)) {
    warnings.push(`Worktree ${options.worktreePath} was already missing.`);
    // Still try `git worktree prune` so git's bookkeeping catches up. Cheap
    // and idempotent; failures are non-fatal.
    runCommandCapture('git', ['worktree', 'prune'], { cwd: options.sharedRepoRoot });
    worktreeRemoved = true;
  } else {
    if (!options.force) {
      const status = inspectCleanupStatus({
        worktreePath: options.worktreePath,
        sharedRepoRoot: options.sharedRepoRoot,
        disposableIgnoredPaths: options.disposableIgnoredPaths,
      });
      if (!status.ok) {
        errors.push(`Could not inspect worktree ${options.worktreePath}: ${status.error ?? 'git status failed'}`);
      } else if (status.trackedChanges > 0 || status.untrackedEntries.length > 0) {
        errors.push(
          `Worktree ${options.worktreePath} has uncommitted or untracked changes. ` +
          `Re-run with --force to remove anyway, or commit/stash first.`,
        );
      } else if (options.requireNoIgnoredContent && status.protectedIgnoredEntries.length > 0) {
        errors.push(`Worktree ${options.worktreePath} has protected ignored content: ${status.protectedIgnoredEntries.join(', ')}`);
      }
    }
    if (errors.length === 0) {
      const removeArgs = ['worktree', 'remove'];
      if (options.force) removeArgs.push('--force');
      removeArgs.push(options.worktreePath);
      const result = runCommandCapture('git', removeArgs, { cwd: options.sharedRepoRoot });
      if (result.ok) {
        worktreeRemoved = true;
      } else {
        errors.push(`git worktree remove failed: ${result.stderr || result.stdout || 'unknown error'}`);
      }
    }
  }

  // Step 2: local branch removal. A failed worktree removal ends the attempt;
  // deleting its still-checked-out branch would turn a recoverable blocker into
  // a partial destructive transition.
  if (!worktreeRemoved) return { worktreeRemoved, branchRemoved, warnings, errors };

  const branchExists = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', `refs/heads/${options.branchName}`], true)?.trim() ?? '';
  if (!branchExists) {
    warnings.push(`Local branch ${options.branchName} was already missing.`);
    branchRemoved = true;
  } else {
    if (!options.force && options.branchDeletionAuthorized) {
      if (!options.expectedBranchHeadSha || branchExists !== options.expectedBranchHeadSha) {
        errors.push(
          `Branch ${options.branchName} moved after cleanup assessment ` +
          `(expected ${shortRef(options.expectedBranchHeadSha ?? '(missing)')}, found ${shortRef(branchExists)}).`,
        );
        return { worktreeRemoved, branchRemoved, warnings, errors };
      }
    }
    const deleteFlag = options.force ? '-D' : '-d';
    // `git branch -D` performs a separate read and delete. A raw git process
    // can move the ref after our assessment even while Pipelane holds the task
    // lease, so use update-ref's expected-old CAS for typed delivery cleanup.
    const result = !options.force && options.branchDeletionAuthorized
      ? runCommandCapture(
          'git',
          ['update-ref', '-d', `refs/heads/${options.branchName}`, options.expectedBranchHeadSha ?? ''],
          { cwd: options.sharedRepoRoot },
        )
      : runCommandCapture('git', ['branch', deleteFlag, options.branchName], { cwd: options.sharedRepoRoot });
    if (result.ok) {
      branchRemoved = true;
      if (!options.force && options.branchDeletionAuthorized) {
        warnings.push(
          `Local branch ${options.branchName} was deleted under typed delivery proof at ${shortRef(options.expectedBranchHeadSha ?? '')}.`,
        );
      }
    } else {
      const stderr = result.stderr || result.stdout || 'unknown error';
      if (!options.force && options.branchDeletionAuthorized) {
        errors.push(
          `Branch ${options.branchName} moved while cleanup was deleting its assessed ref; ` +
          `the branch was preserved. ${stderr}`,
        );
        return { worktreeRemoved, branchRemoved, warnings, errors };
      }
      const isUnmerged = /not fully merged/i.test(stderr);
      errors.push(
        isUnmerged
          ? `Branch ${options.branchName} is not fully merged into the current HEAD. ` +
            `Re-run with --force to delete it anyway, or merge/rebase first.`
          : `git branch ${deleteFlag} ${options.branchName} failed: ${stderr}`,
      );
    }
  }

  return { worktreeRemoved, branchRemoved, warnings, errors };
}

export function branchTreeMatchesRef(repoRoot: string, branchName: string, targetRef: string): boolean {
  const branchTree = runGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${branchName}^{tree}`], true)?.trim() ?? '';
  const targetTree = runGit(repoRoot, ['rev-parse', '--verify', `${targetRef}^{tree}`], true)?.trim() ?? '';
  return branchTree.length > 0 && branchTree === targetTree;
}

function shortRef(ref: string): string {
  return /^[a-f0-9]{7,40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/**
 * Tear down an orphan worktree + its (optional) local branch. Used by
 * `/clean --apply --safe-orphans` and `--merged-orphans`. Same safety
 * shape as removeTaskArtifacts, but the orphan has no task lock and may
 * have a detached HEAD with no branch to delete. No safeDeleteBranchRef
 * path — orphans aren't tracked by the deploy state chain.
 */
export function removeOrphanWorktree(options: {
  sharedRepoRoot: string;
  worktreePath: string;
  branchName: string | null;
  callerCwd: string;
  force: boolean;
}): RemoveTaskArtifactsResult {
  const branchName = options.branchName?.trim() ?? '';
  if (branchName.length > 0) {
    return removeTaskArtifacts({
      sharedRepoRoot: options.sharedRepoRoot,
      worktreePath: options.worktreePath,
      branchName,
      callerCwd: options.callerCwd,
      force: options.force,
    });
  }

  // Detached HEAD: only the worktree to remove. Mirror the worktree-removal
  // half of removeTaskArtifacts so error/warning shapes match. Report
  // branchRemoved: true so the caller's "fully torn down" check passes.
  const warnings: string[] = [];
  const errors: string[] = [];
  let worktreeRemoved = false;

  const callerInsideTarget = pathContainsOrEquals(options.worktreePath, options.callerCwd);
  if (callerInsideTarget && existsSync(options.worktreePath)) {
    errors.push(
      `Cannot remove worktree ${options.worktreePath} while inside it. ` +
      `cd to a different directory (e.g. ${options.sharedRepoRoot}) and retry.`,
    );
    return { worktreeRemoved, branchRemoved: true, warnings, errors };
  }

  if (!existsSync(options.worktreePath)) {
    warnings.push(`Worktree ${options.worktreePath} was already missing.`);
    runCommandCapture('git', ['worktree', 'prune'], { cwd: options.sharedRepoRoot });
    worktreeRemoved = true;
  } else {
    if (!options.force) {
      const status = runCommandCapture('git', ['status', '--porcelain'], { cwd: options.worktreePath });
      if (status.ok && status.stdout.trim().length > 0) {
        errors.push(
          `Worktree ${options.worktreePath} has uncommitted or untracked changes. ` +
          `Re-run with --force to remove anyway, or commit/stash first.`,
        );
      }
    }
    if (errors.length === 0) {
      const removeArgs = ['worktree', 'remove'];
      if (options.force) removeArgs.push('--force');
      removeArgs.push(options.worktreePath);
      const result = runCommandCapture('git', removeArgs, { cwd: options.sharedRepoRoot });
      if (result.ok) {
        worktreeRemoved = true;
      } else {
        errors.push(`git worktree remove failed: ${result.stderr || result.stdout || 'unknown error'}`);
      }
    }
  }

  return { worktreeRemoved, branchRemoved: true, warnings, errors };
}

export interface OrphanClassification {
  // Tracked file changes (modifications, additions, deletions, renames).
  // 0 means the worktree's tracked files all match HEAD.
  trackedChanges: number;
  // Untracked files (status code "??"). Often intentional — operator
  // created files but never staged.
  untrackedFiles: number;
  // Risky ignored files matching .gitignore. Allow-listed paths
  // (node_modules symlinks back to shared deps) are filtered out.
  ignoredEntries: string[];
  // Overall classification, used by /clean to bucket orphans:
  //   - 'clean'         — nothing to lose; safe to delete without --force
  //   - 'ignored-only'  — only ignored content (build outputs, dist/)
  //   - 'untracked'     — untracked files not yet added to git
  //   - 'dirty-source'  — tracked source modifications
  //   - 'unknown'       — git status failed (e.g. broken worktree)
  treeState: 'clean' | 'ignored-only' | 'untracked' | 'dirty-source' | 'unknown';
}

export function classifyOrphan(worktreePath: string): OrphanClassification {
  if (!existsSync(worktreePath)) {
    return { trackedChanges: 0, untrackedFiles: 0, ignoredEntries: [], treeState: 'unknown' };
  }
  const status = runCommandCapture(
    'git',
    ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all'],
    { cwd: worktreePath, preserveOutput: true },
  );
  if (!status.ok) {
    return { trackedChanges: 0, untrackedFiles: 0, ignoredEntries: [], treeState: 'unknown' };
  }
  let tracked = 0;
  let untracked = 0;
  const ignored: string[] = [];
  for (const entry of parsePorcelainV1Z(status.stdout)) {
    if (entry.code === '!!') {
      const candidate = entry.path;
      if (candidate.length > 0 && !isAllowedAutoCleanIgnoredPath(worktreePath, candidate)) {
        ignored.push(candidate);
      }
    } else if (entry.code === '??') {
      untracked += 1;
    } else {
      tracked += 1;
    }
  }
  let treeState: OrphanClassification['treeState'];
  if (tracked > 0) treeState = 'dirty-source';
  else if (untracked > 0) treeState = 'untracked';
  else if (ignored.length > 0) treeState = 'ignored-only';
  else treeState = 'clean';
  return { trackedChanges: tracked, untrackedFiles: untracked, ignoredEntries: ignored, treeState };
}

function isAllowedAutoCleanIgnoredPath(worktreePath: string, ignoredPath: string): boolean {
  const commonDir = runGit(worktreePath, ['rev-parse', '--git-common-dir'], true)?.trim();
  if (!commonDir) return false;
  const absoluteCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktreePath, commonDir);
  return isVerifiedSharedNodeModulesLink(worktreePath, resolveSharedRepoRoot(absoluteCommonDir), ignoredPath);
}

export interface OrphanWorktree {
  path: string;
  branchName: string | null;
  isDetached: boolean;
  // When the worktree path lives inside the configured worktree dir
  // (`pipelane-worktrees/`), pipelane created it but its lock has gone
  // away. Otherwise it's an externally-created worktree pipelane never
  // tracked (Codex, Claude Code's /new, manual `git worktree add`).
  source: 'pipelane-managed' | 'external';
}

/**
 * Worktrees that show up in `git worktree list` but have no matching
 * active task lock. The shared repo's main worktree is excluded — that
 * one is structural, not orphaned. Surfaced by `/clean` (no args) so the
 * operator has a UX cue to clean them up; pipelane never auto-removes
 * orphans because the blast radius (potentially destroying external
 * agents' WIP) is too high.
 */
export function listOrphanWorktrees(commonDir: string, config: WorkflowConfig): OrphanWorktree[] {
  const sharedRepoRoot = resolveSharedRepoRoot(commonDir);
  const result = runCommandCapture('git', ['worktree', 'list', '--porcelain'], { cwd: sharedRepoRoot });
  if (!result.ok) return [];

  const knownLocks = loadAllTaskLocks(commonDir, config);
  const knownByPath = new Set(knownLocks.map((lock) => normalizePath(lock.worktreePath)));
  const knownByBranch = new Set(knownLocks.map((lock) => lock.branchName));

  const taskWorktreeRoot = normalizePath(resolveTaskWorktreeRoot(commonDir, config));
  const orphans: OrphanWorktree[] = [];
  let current: { path?: string; branch?: string; detached?: boolean } = {};

  const flush = (): void => {
    if (!current.path) {
      current = {};
      return;
    }
    const normalizedPath = normalizePath(current.path);
    const isMainWorktree = normalizedPath === normalizePath(sharedRepoRoot);
    if (isMainWorktree) {
      current = {};
      return;
    }
    const branchName = current.branch ?? null;
    const isTracked = knownByPath.has(normalizedPath) || (branchName !== null && knownByBranch.has(branchName));
    if (!isTracked) {
      orphans.push({
        path: current.path,
        branchName,
        isDetached: current.detached === true,
        source: normalizedPath.startsWith(taskWorktreeRoot + '/') || normalizedPath === taskWorktreeRoot
          ? 'pipelane-managed'
          : 'external',
      });
    }
    current = {};
  };

  for (const line of result.stdout.split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  flush();

  return orphans;
}
