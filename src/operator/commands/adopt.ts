import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadTaskLock,
  legacyTaskBindingId,
  normalizeExistingPath,
  normalizePath,
  nowIso,
  newTaskBindingId,
  printResult,
  removeTaskLock,
  resolveWorkflowContext,
  runCommandCapture,
  runGit,
  saveTaskLock,
  type ParsedOperatorArgs,
  type TaskLock,
  type WorkflowConfig,
} from '../state.ts';
import {
  buildTaskWorkspaceOutput,
  ensureSharedNodeModulesLink,
  pruneDeadTaskLocks,
  readWorktreeStatus,
  resolveSharedRepoRoot,
  resolveTaskCommandIdentity,
} from '../task-workspaces.ts';
import { inferTaskSlugsFromBranchName, resolveCommandSurfaces } from './helpers.ts';

interface WorktreeEntry {
  path: string;
  branchName: string | null;
  detached: boolean;
}

export async function handleAdopt(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const target = resolveAdoptTarget(context.repoRoot, context.commonDir, parsed.flags.branch);
  const command = formatWorkflowCommand(context.config, 'adopt');

  if (target.detached) {
    throw new Error(`${command} cannot adopt a detached checkout. Check out a named task branch first.`);
  }
  if (!target.branchName) {
    throw new Error(`${command} could not resolve a branch name for this checkout.`);
  }
  if (isBaseBranch(context.config, target.branchName) && !parsed.flags.force) {
    throw new Error([
      `${command} blocked because ${target.branchName} is a base branch.`,
      'Adopt a task branch/worktree, or rerun with --force only if this base-branch binding is intentional.',
    ].join('\n'));
  }

  const inferredTaskName = inferTaskNameFromBranch(context.config, target.branchName);
  const { taskName, taskSlug } = resolveTaskCommandIdentity(parsed.flags.task.trim() || inferredTaskName);
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);
  const { removed: removedLocks } = pruneDeadTaskLocks(context.commonDir, context.config, { minAgeMs: 0 });
  const existingLock = loadTaskLock(context.commonDir, context.config, taskSlug);
  const activeLocks = loadAllTaskLocks(context.commonDir, context.config);
  const normalizedTargetPath = normalizeExistingPath(target.path);
  const conflictingLocks = activeLocks.filter((lock) =>
    lock.taskSlug !== taskSlug
    && (lock.branchName === target.branchName || normalizeExistingPath(lock.worktreePath) === normalizedTargetPath)
  );

  if (conflictingLocks.length > 0 && !parsed.flags.force) {
    const firstConflict = conflictingLocks[0];
    throw new Error([
      `${command} blocked because this branch/worktree is already bound to another task.`,
      `Existing task: ${firstConflict.taskName || firstConflict.taskSlug}`,
      `Branch: ${firstConflict.branchName}`,
      `Worktree: ${firstConflict.worktreePath}`,
      conflictingLocks.length > 1 ? `Additional conflicts: ${conflictingLocks.length - 1}` : '',
      `Rerun with --force only if you intentionally want ${taskName} to take over this binding.`,
    ].filter(Boolean).join('\n'));
  }

  const sameBinding = existingLock
    && existingLock.branchName === target.branchName
    && normalizeExistingPath(existingLock.worktreePath) === normalizedTargetPath;
  if (existingLock && !sameBinding && !parsed.flags.force) {
    throw new Error([
      `Task ${taskName} is already active with a different branch/worktree.`,
      `Existing branch: ${existingLock.branchName}`,
      `Existing worktree: ${existingLock.worktreePath}`,
      `Requested branch: ${target.branchName}`,
      `Requested worktree: ${target.path}`,
      `Next: run ${formatWorkflowCommand(context.config, 'resume', `--task "${taskName}"`)}, or rerun ${formatWorkflowCommand(context.config, 'adopt', `--task "${taskName}" --force`)} to rebind.`,
    ].join('\n'));
  }

  const targetCommonDir = resolveTargetCommonDir(target.path);
  if (targetCommonDir && normalizeExistingPath(targetCommonDir) !== normalizeExistingPath(context.commonDir)) {
    throw new Error([
      `${command} can only adopt worktrees from this repository.`,
      `Current git common dir: ${context.commonDir}`,
      `Target git common dir: ${targetCommonDir}`,
    ].join('\n'));
  }

  if (parsed.flags.force) {
    for (const lock of conflictingLocks) {
      removeTaskLock(context.commonDir, context.config, lock.taskSlug);
    }
  }

  const status = readWorktreeStatus(target.path);
  const warnings = [
    ...removedLocks
      .filter((lock) => lock.taskSlug === taskSlug)
      .flatMap((lock) => [`Removed stale task lock for ${taskSlug}.`, ...lock.reasons]),
    ...(parsed.flags.force
      ? conflictingLocks.map((lock) =>
          `Removed existing task lock ${lock.taskSlug}; ${taskSlug} now owns this branch/worktree binding.`
        )
      : []),
    ...(status.dirty
      ? [`Adopted worktree has ${status.statusLines.length} uncommitted change${status.statusLines.length === 1 ? '' : 's'}; ${formatWorkflowCommand(context.config, 'pr')} will include them when you prepare the PR.`]
      : []),
  ];
  const nodeModulesWarning = ensureSharedNodeModulesLink(context.commonDir, target.path);
  if (nodeModulesWarning) {
    warnings.push(nodeModulesWarning);
  }

  const lock = saveAdoptedTaskLock({
    existingLock,
    commonDir: context.commonDir,
    config: context.config,
    taskSlug,
    taskName,
    branchName: target.branchName,
    worktreePath: target.path,
    mode: context.modeState.mode,
    surfaces,
    force: parsed.flags.force,
  });

  const output = buildTaskWorkspaceOutput({
    repoRoot: context.repoRoot,
    taskName,
    taskSlug,
    branchName: lock.branchName,
    worktreePath: lock.worktreePath,
    mode: lock.mode,
    createdWorktree: false,
    resumed: false,
    warnings,
    reasons: [
      'adopted an existing branch/worktree; no new worktree was created',
      parsed.flags.task.trim() ? 'task identity came from --task' : `task identity was inferred from branch ${target.branchName}`,
    ],
    lockNextAction: lock.nextAction ?? null,
  });

  printResult(parsed.flags, { ...output, adopted: true });
}

function resolveAdoptTarget(repoRoot: string, commonDir: string, branchArg: string): WorktreeEntry {
  const requestedBranch = normalizeBranchName(branchArg.trim());
  const sharedRepoRoot = resolveSharedRepoRoot(commonDir);
  const worktrees = listGitWorktrees(sharedRepoRoot);
  const currentPath = normalizeExistingPath(repoRoot);
  const current = worktrees.find((entry) => normalizeExistingPath(entry.path) === currentPath);

  if (!requestedBranch) {
    if (current) return current;
    const branchName = runGit(repoRoot, ['branch', '--show-current'], true)?.trim() || null;
    return { path: repoRoot, branchName, detached: !branchName };
  }

  const matchingWorktree = worktrees.find((entry) => entry.branchName === requestedBranch);
  if (matchingWorktree) return matchingWorktree;

  if (current?.branchName === requestedBranch) return current;

  const branchExists = runGit(sharedRepoRoot, ['rev-parse', '--verify', `refs/heads/${requestedBranch}`], true);
  if (branchExists) {
    throw new Error(`Branch ${requestedBranch} exists but is not checked out as a worktree. Check it out first, then rerun /adopt.`);
  }
  throw new Error(`Could not find branch ${requestedBranch} in this repo.`);
}

function listGitWorktrees(repoRoot: string): WorktreeEntry[] {
  const result = runCommandCapture('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (!result.ok) return [];
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; branchName?: string | null; detached?: boolean } = {};
  const flush = (): void => {
    if (!current.path) {
      current = {};
      return;
    }
    entries.push({
      path: current.path,
      branchName: current.branchName ?? null,
      detached: current.detached === true,
    });
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
      current.branchName = normalizeBranchName(line.slice('branch '.length));
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

function normalizeBranchName(raw: string): string {
  return raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
}

function inferTaskNameFromBranch(config: WorkflowConfig, branchName: string): string {
  const [slug] = inferTaskSlugsFromBranchName(config, branchName);
  if (slug) return slug.replace(/-/g, ' ');
  const basename = path.basename(branchName).replace(/-[a-f0-9]{4}$/i, '');
  return basename.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim() || branchName;
}

function isBaseBranch(config: WorkflowConfig, branchName: string): boolean {
  return branchName === config.baseBranch || branchName === 'main' || branchName === 'master';
}

function resolveTargetCommonDir(worktreePath: string): string | null {
  const commonDirRaw = runGit(worktreePath, ['rev-parse', '--git-common-dir'], true)?.trim();
  if (!commonDirRaw) return null;
  return path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(worktreePath, commonDirRaw);
}

function saveAdoptedTaskLock(options: {
  existingLock: TaskLock | null;
  commonDir: string;
  config: WorkflowConfig;
  taskSlug: string;
  taskName: string;
  branchName: string;
  worktreePath: string;
  mode: TaskLock['mode'];
  surfaces: string[];
  force: boolean;
}): TaskLock {
  const updatedAt = nowIso();
  const history = buildAdoptBindingHistory(options, updatedAt);
  const sameBinding = Boolean(options.existingLock
    && options.existingLock.branchName === options.branchName
    && normalizeExistingPath(options.existingLock.worktreePath) === normalizeExistingPath(options.worktreePath));
  return saveTaskLock(options.commonDir, options.config, options.taskSlug, {
    taskSlug: options.taskSlug,
    taskName: options.taskName,
    taskBindingId: sameBinding
      ? options.existingLock?.taskBindingId ?? legacyTaskBindingId(options.config, options.existingLock!)
      : newTaskBindingId(),
    taskBrief: sameBinding ? options.existingLock?.taskBrief : undefined,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
    mode: options.existingLock?.mode ?? options.mode,
    surfaces: options.surfaces,
    nextAction: options.existingLock?.nextAction,
    nextActionUpdatedAt: options.existingLock?.nextActionUpdatedAt,
    bindingHistory: history,
    updatedAt,
  });
}

function buildAdoptBindingHistory(
  options: Parameters<typeof saveAdoptedTaskLock>[0],
  reboundAt: string,
): TaskLock['bindingHistory'] {
  const existing = options.existingLock;
  if (!existing) return undefined;
  const sameBinding = existing.branchName === options.branchName
    && normalizeExistingPath(existing.worktreePath) === normalizeExistingPath(options.worktreePath);
  const existingHistory = Array.isArray(existing.bindingHistory) ? existing.bindingHistory : [];
  if (sameBinding) return existingHistory;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      taskSlug: options.taskSlug,
      fromBranchName: existing.branchName,
      fromWorktreePath: normalizePath(existing.worktreePath),
      toBranchName: options.branchName,
      toWorktreePath: normalizePath(options.worktreePath),
      force: options.force,
    }))
    .digest('hex');
  return [
    ...existingHistory,
    {
      reboundAt,
      reason: options.force ? 'adopt --force' : 'adopt',
      fromBranchName: existing.branchName,
      fromWorktreePath: existing.worktreePath,
      toBranchName: options.branchName,
      toWorktreePath: options.worktreePath,
      fingerprint,
    },
  ].slice(-20);
}
