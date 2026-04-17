import { mkdirSync } from 'node:fs';

import {
  loadTaskLock,
  printResult,
  resolveWorkflowContext,
  type ParsedOperatorArgs,
} from '../state.ts';
import {
  buildCurrentWorkspaceReasons,
  buildTaskWorkspaceOutput,
  findPrunedTaskLock,
  generateHex,
  generateUniqueTaskWorkspace,
  pruneDeadTaskLocks,
  resolveTaskBaseRef,
  resolveTaskCommandIdentity,
  resolveTaskWorktreeRoot,
  saveNewTaskLock,
} from '../task-workspaces.ts';
import { runGit } from '../state.ts';
import { resolveCommandSurfaces } from './helpers.ts';

export async function handleNew(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const rawTask = parsed.flags.task.trim();
  const effectiveTask = rawTask || `task-${generateHex()}`;

  const context = resolveWorkflowContext(cwd);
  const { taskName, taskSlug } = resolveTaskCommandIdentity(effectiveTask);
  const mode = context.modeState.mode;
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);
  const { removed: removedLocks } = pruneDeadTaskLocks(context.commonDir, context.config, { minAgeMs: 0 });
  const existingLock = loadTaskLock(context.commonDir, context.config, taskSlug);
  const prunedTaskLock = findPrunedTaskLock(removedLocks, taskSlug);
  const warnings = prunedTaskLock
    ? [`Removed stale task lock for ${taskSlug}.`, ...prunedTaskLock.reasons]
    : [];

  if (existingLock) {
    throw new Error([
      `Task ${taskName} is already active.`,
      `Slug: ${taskSlug}`,
      `Branch: ${existingLock.branchName}`,
      `Worktree: ${existingLock.worktreePath}`,
      `Next: run workflow:resume -- --task "${taskName}"`,
    ].join('\n'));
  }

  const baseRef = resolveTaskBaseRef(context.repoRoot, context.config.baseBranch, parsed.flags.offline);
  const workspace = generateUniqueTaskWorkspace(context.repoRoot, context.commonDir, context.config, taskSlug);
  const reasons = buildCurrentWorkspaceReasons({
    repoRoot: context.repoRoot,
    commonDir: context.commonDir,
    config: context.config,
    taskSlug,
  });

  mkdirSync(resolveTaskWorktreeRoot(context.commonDir, context.config), { recursive: true });
  runGit(context.repoRoot, ['worktree', 'add', workspace.worktreePath, '-b', workspace.branchName, baseRef.sourceRef]);
  saveNewTaskLock({
    commonDir: context.commonDir,
    config: context.config,
    taskSlug,
    taskName,
    branchName: workspace.branchName,
    worktreePath: workspace.worktreePath,
    mode,
    surfaces,
  });

  printResult(parsed.flags, buildTaskWorkspaceOutput({
    repoRoot: context.repoRoot,
    taskName,
    taskSlug,
    branchName: workspace.branchName,
    worktreePath: workspace.worktreePath,
    mode,
    createdWorktree: true,
    resumed: false,
    warnings: [...baseRef.warnings, ...warnings],
    reasons,
  }));
}
