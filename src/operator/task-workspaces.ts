import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { Mode, TaskLock, WorkflowConfig } from './state.ts';
import {
  normalizePath,
  nowIso,
  runGit,
  runCommandCapture,
  loadAllTaskLocks,
  loadTaskLock,
  saveTaskLock,
  taskLockPath,
  slugifyTaskName,
} from './state.ts';

export interface RemovedTaskLock {
  taskSlug: string;
  branchName: string;
  worktreePath: string;
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

export function resolveTaskWorktreeRoot(commonDir: string, config: WorkflowConfig): string {
  const sharedRepoRoot = resolveSharedRepoRoot(commonDir);
  return path.join(path.dirname(sharedRepoRoot), config.taskWorktreeDirName);
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

  if (warnings.length > 0) {
    lines.push('Warnings:');
    lines.push(...warnings.map((warning) => `- ${warning}`));
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

  const repoPath = normalizePath(options.repoRoot);
  const currentLock = loadAllTaskLocks(options.commonDir, options.config).find((lock) =>
    lock.taskSlug !== options.taskSlug
    && (lock.branchName === branchName || normalizePath(lock.worktreePath) === repoPath)
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
  branchName: string;
  worktreePath: string;
  mode: Mode;
  surfaces: string[];
}): TaskLock {
  return saveTaskLock(options.commonDir, options.config, options.taskSlug, {
    taskSlug: options.taskSlug,
    taskName: options.taskName,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
    mode: options.mode,
    surfaces: options.surfaces,
    updatedAt: nowIso(),
  });
}
