import { mkdirSync } from 'node:fs';

import { computeRepoGuardUnsafeReasons } from '../repo-guard.ts';
import {
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadTaskLock,
  legacyTaskBindingId,
  newTaskBindingId,
  printResult,
  resolveWorkflowContext,
  runGit,
  saveTaskLock,
  type ParsedOperatorArgs,
  type TaskLock,
} from '../state.ts';
import {
  ensureSharedNodeModulesLink,
  generateUniqueTaskWorkspace,
  isSharedNodeModulesSetupNote,
  readWorktreeStatus,
  resolveTaskBaseRef,
  resolveTaskCommandIdentity,
  resolveTaskWorktreeRoot,
} from '../task-workspaces.ts';
import { resolveCommandSurfaces } from './helpers.ts';

export async function handleRepoGuard(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  if (!parsed.flags.task.trim()) {
    throw new Error('repo-guard requires --task <task-name>.');
  }

  const context = resolveWorkflowContext(cwd);
  const requestedMode = parsed.flags.mode.trim();
  if (requestedMode && requestedMode !== context.modeState.mode) {
    throw new Error([
      `repo-guard --mode ${requestedMode} would create a task lock that disagrees with current mode ${context.modeState.mode}.`,
      `Run ${formatWorkflowCommand(context.config, 'devmode', requestedMode)} first so release readiness is checked, then rerun repo-guard.`,
    ].join('\n'));
  }
  const { taskName, taskSlug } = resolveTaskCommandIdentity(parsed.flags.task);
  const { branchName, statusLines } = readWorktreeStatus(context.repoRoot);
  const existingLock = loadTaskLock(context.commonDir, context.config, taskSlug);
  const reasons = computeRepoGuardUnsafeReasons({
    config: context.config,
    branchName,
    baseBranch: context.config.baseBranch,
    statusLines,
    repoRoot: context.repoRoot,
    taskSlug,
    existingTaskBranch: existingLock?.branchName ?? null,
    existingTaskWorktree: existingLock?.worktreePath ?? null,
    allLocks: loadAllTaskLocks(context.commonDir, context.config),
  });
  const mode = context.modeState.mode;
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces, existingLock?.surfaces ?? []);
  if (existingLock && existingLock.mode !== mode) {
    throw new Error([
      `repo-guard cannot change task ${taskSlug} from ${existingLock.mode} mode to ${mode} mode.`,
      `Run ${formatWorkflowCommand(context.config, 'devmode', `${mode} --task "${taskSlug}"`)} first so the normal readiness checks update the task lock, then rerun repo-guard.`,
    ].join('\n'));
  }
  if (mode === 'release') {
    const releaseReadySurfaces = new Set(context.modeState.requestedSurfaces);
    const uncheckedSurfaces = surfaces.filter((surface) => !releaseReadySurfaces.has(surface));
    if (uncheckedSurfaces.length > 0) {
      const requiredSurfaces = context.config.surfaces.filter((surface) =>
        releaseReadySurfaces.has(surface) || surfaces.includes(surface)
      );
      throw new Error([
        `repo-guard cannot create a release-mode task lock for unchecked surfaces: ${uncheckedSurfaces.join(', ')}.`,
        `Run ${formatWorkflowCommand(context.config, 'devmode', 'release')} --surfaces "${requiredSurfaces.join(',')}" first so release readiness covers them, then rerun repo-guard.`,
      ].join('\n'));
    }
  }

  if (reasons.length === 0) {
    const lock = saveTaskLock(context.commonDir, context.config, taskSlug, {
      ...(existingLock ?? {}),
      taskSlug,
      taskName,
      taskBindingId: existingLock?.taskBindingId ?? (existingLock ? legacyTaskBindingId(context.config, existingLock) : newTaskBindingId()),
      taskBrief: existingLock?.taskBrief,
      branchName,
      worktreePath: context.repoRoot,
      mode,
      surfaces,
      updatedAt: new Date().toISOString(),
    });
    printResult(parsed.flags, {
      createdWorktree: false,
      lock,
      message: [
        'Repo Guard: using current worktree.',
        `Task: ${taskName}`,
        `Branch: ${branchName}`,
        `Worktree: ${context.repoRoot}`,
      ].join('\n'),
    });
    return;
  }

  const baseRef = resolveTaskBaseRef(context.repoRoot, context.config.baseBranch, parsed.flags.offline);
  const workspace = generateUniqueTaskWorkspace(context.repoRoot, context.commonDir, context.config, taskSlug);
  mkdirSync(resolveTaskWorktreeRoot(context.commonDir, context.config), { recursive: true });
  runGit(context.repoRoot, ['worktree', 'add', workspace.worktreePath, '-b', workspace.branchName, baseRef.sourceRef]);
  const nodeModulesWarning = ensureSharedNodeModulesLink(context.commonDir, workspace.worktreePath, {
    replaceExistingDirectory: true,
  });

  const lock = saveTaskLock(context.commonDir, context.config, taskSlug, {
    ...preserveTaskLockAuditTrail(existingLock),
    taskSlug,
    taskName,
    taskBindingId: newTaskBindingId(),
    branchName: workspace.branchName,
    worktreePath: workspace.worktreePath,
    mode,
    surfaces,
    updatedAt: new Date().toISOString(),
  });

  printResult(parsed.flags, {
    createdWorktree: true,
    lock,
    reasons,
    warnings: [...baseRef.warnings, ...(nodeModulesWarning ? [nodeModulesWarning] : [])],
    message: [
      'Repo Guard: created a new isolated worktree.',
      `Task: ${taskName}`,
      `Branch: ${workspace.branchName}`,
      `Worktree: ${workspace.worktreePath}`,
      ...baseRef.warnings.map((warning) => `Warning: ${warning}`),
      ...(nodeModulesWarning
        ? [`${isSharedNodeModulesSetupNote(nodeModulesWarning) ? 'Dependency setup note' : 'Warning'}: ${nodeModulesWarning}`]
        : []),
      'Why:',
      ...reasons.map((reason) => `- ${reason}`),
    ].join('\n'),
  });
}

function preserveTaskLockAuditTrail(lock: TaskLock | null): Pick<TaskLock, 'bindingHistory'> {
  return Array.isArray(lock?.bindingHistory) && lock.bindingHistory.length > 0
    ? { bindingHistory: lock.bindingHistory }
    : {};
}
