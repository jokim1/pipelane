import type { WorkflowConfig } from './state.ts';
import { normalizePath } from './state.ts';

export function taskBranchMatches(config: WorkflowConfig, taskSlug: string, branchName: string): boolean {
  const prefixes = [config.branchPrefix, ...config.legacyBranchPrefixes];
  return prefixes.some((prefix) => branchName.startsWith(`${prefix}${taskSlug}`));
}

export function computeRepoGuardUnsafeReasons(options: {
  config: WorkflowConfig;
  branchName: string;
  baseBranch: string;
  statusLines: string[];
  repoRoot: string;
  taskSlug: string;
  existingTaskBranch?: string | null;
  existingTaskWorktree?: string | null;
  allLocks: Array<{ taskSlug: string; branchName: string; worktreePath: string }>;
}): string[] {
  const reasons: string[] = [];

  if (options.branchName === options.baseBranch || options.branchName === 'main' || options.branchName === 'master') {
    reasons.push(`current branch is ${options.branchName}`);
  }

  if (options.statusLines.length > 0) {
    reasons.push('worktree has uncommitted changes');
  }

  if (!taskBranchMatches(options.config, options.taskSlug, options.branchName)) {
    reasons.push(`branch ${options.branchName} does not belong to task ${options.taskSlug}`);
  }

  if (options.existingTaskBranch && options.existingTaskBranch !== options.branchName) {
    reasons.push(`task ${options.taskSlug} is locked to branch ${options.existingTaskBranch}`);
  }

  if (options.existingTaskWorktree && normalizePath(options.existingTaskWorktree) !== normalizePath(options.repoRoot)) {
    reasons.push(`task ${options.taskSlug} is locked to worktree ${options.existingTaskWorktree}`);
  }

  for (const lock of options.allLocks) {
    if (lock.taskSlug === options.taskSlug) {
      continue;
    }
    if (lock.branchName === options.branchName) {
      reasons.push(`branch ${options.branchName} is already locked by task ${lock.taskSlug}`);
    }
    if (normalizePath(lock.worktreePath) === normalizePath(options.repoRoot)) {
      reasons.push(`worktree ${options.repoRoot} is already locked by task ${lock.taskSlug}`);
    }
  }

  return reasons;
}

export function verifyTaskLockState(options: {
  branchName: string;
  repoRoot: string;
  requestedMode: string;
  currentMode: string;
  lock: {
    branchName: string;
    worktreePath: string;
    mode: string;
  };
}): string[] {
  const mismatches: string[] = [];

  if (options.lock.branchName !== options.branchName) {
    mismatches.push(`expected branch ${options.lock.branchName}, found ${options.branchName}`);
  }

  if (normalizePath(options.lock.worktreePath) !== normalizePath(options.repoRoot)) {
    mismatches.push(`expected worktree ${options.lock.worktreePath}, found ${options.repoRoot}`);
  }

  if (options.requestedMode && options.requestedMode !== options.lock.mode) {
    mismatches.push(`expected mode ${options.lock.mode}, found ${options.requestedMode}`);
  } else if (!options.requestedMode && options.currentMode !== options.lock.mode) {
    mismatches.push(`task is locked to mode ${options.lock.mode}, current mode is ${options.currentMode}`);
  }

  return mismatches;
}

export function resolveRequestedDeploySurfaces(config: WorkflowConfig, candidates: string[][]): string[] {
  for (const candidate of candidates) {
    if (candidate.length > 0) {
      return candidate.filter((surface) => config.surfaces.includes(surface));
    }
  }

  return [...config.surfaces];
}
