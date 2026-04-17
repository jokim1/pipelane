import { mkdirSync } from 'node:fs';

import { computeRepoGuardUnsafeReasons } from '../repo-guard.ts';
import {
  loadAllTaskLocks,
  loadTaskLock,
  printResult,
  resolveWorkflowContext,
  runGit,
  saveTaskLock,
  type ParsedOperatorArgs,
} from '../state.ts';
import {
  generateUniqueTaskWorkspace,
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
  const mode = (parsed.flags.mode || context.modeState.mode) as 'build' | 'release';
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces, existingLock?.surfaces ?? []);

  if (reasons.length === 0) {
    const lock = saveTaskLock(context.commonDir, context.config, taskSlug, {
      taskSlug,
      taskName,
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

  const lock = saveTaskLock(context.commonDir, context.config, taskSlug, {
    taskSlug,
    taskName,
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
    warnings: baseRef.warnings,
    message: [
      'Repo Guard: created a new isolated worktree.',
      `Task: ${taskName}`,
      `Branch: ${workspace.branchName}`,
      `Worktree: ${workspace.worktreePath}`,
      ...baseRef.warnings.map((warning) => `Warning: ${warning}`),
      'Why:',
      ...reasons.map((reason) => `- ${reason}`),
    ].join('\n'),
  });
}
