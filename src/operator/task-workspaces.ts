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
}): {
  taskName: string;
  taskSlug: string;
  branch: string;
  worktreePath: string;
  worktreeDisplayPath: string;
  mode: Mode;
  nextAction: string;
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
  const lines = [
    `Continue this task in: ${worktreeDisplayPath}`,
    `Task: ${options.taskName}`,
    `Slug: ${options.taskSlug}`,
    `Branch: ${options.branchName}`,
    `Mode: ${options.mode}`,
  ];

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

export function pruneDeadTaskLocks(commonDir: string, config: WorkflowConfig): RemovedTaskLock[] {
  const removed: RemovedTaskLock[] = [];

  for (const lock of loadAllTaskLocks(commonDir, config)) {
    const reasons: string[] = [];

    if (!existsSync(lock.worktreePath)) {
      reasons.push(`saved worktree ${lock.worktreePath} no longer exists`);
    }

    const branchExists = runGit(resolveSharedRepoRoot(commonDir), ['rev-parse', '--verify', lock.branchName], true);
    if (!branchExists) {
      reasons.push(`saved branch ${lock.branchName} no longer exists`);
    }

    if (reasons.length === 0) {
      continue;
    }

    const targetPath = taskLockPath(commonDir, config, lock.taskSlug);
    if (existsSync(targetPath)) {
      unlinkSync(targetPath);
    }
    removed.push({
      taskSlug: lock.taskSlug,
      branchName: lock.branchName,
      worktreePath: lock.worktreePath,
      reasons,
    });
  }

  return removed;
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
