import { printResult, resolveWorkflowContext, type ParsedOperatorArgs } from '../state.ts';
import {
  buildTaskWorkspaceOutput,
  ensureSharedNodeModulesLink,
  findPrunedTaskLock,
  listActiveTaskLocks,
  pruneDeadTaskLocks,
  resolveTaskCommandIdentity,
} from '../task-workspaces.ts';
import { loadTaskLock } from '../state.ts';

export async function handleResume(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  // Implicit prune on resume keeps the no-arg flow working even if a prior
  // session left half-written locks. The 5-min floor is /clean --apply's job.
  const { removed: removedLocks } = pruneDeadTaskLocks(context.commonDir, context.config, { minAgeMs: 0 });

  if (!parsed.flags.task.trim()) {
    const activeLocks = listActiveTaskLocks(context.commonDir, context.config);

    if (activeLocks.length === 0) {
      throw new Error('No active task locks exist.\nNext: run pipelane:new -- --task "<task-name>"');
    }

    if (activeLocks.length === 1) {
      const lock = activeLocks[0];
      const nodeModulesWarning = ensureSharedNodeModulesLink(context.commonDir, lock.worktreePath);
      printResult(parsed.flags, buildTaskWorkspaceOutput({
        repoRoot: context.repoRoot,
        taskName: lock.taskName || lock.taskSlug,
        taskSlug: lock.taskSlug,
        branchName: lock.branchName,
        worktreePath: lock.worktreePath,
        mode: lock.mode,
        createdWorktree: false,
        resumed: true,
        warnings: [
          ...(context.modeState.mode !== lock.mode
            ? [`Current Dev Mode is ${context.modeState.mode}, but this task is locked to ${lock.mode}. Switch back before /pr or /merge.`]
            : []),
          ...(nodeModulesWarning ? [nodeModulesWarning] : []),
        ],
        reasons: ['resuming the only active task workspace'],
        lockNextAction: lock.nextAction ?? null,
      }));
      return;
    }

    const renderedLocks = activeLocks.map((lock) => {
      const breadcrumb = lock.nextAction?.trim() || null;
      return {
        taskSlug: lock.taskSlug,
        taskName: lock.taskName ?? null,
        branchName: lock.branchName,
        worktreePath: lock.worktreePath,
        mode: lock.mode,
        lockNextAction: breadcrumb,
      };
    });
    const lines = [
      'Active task workspaces:',
      ...activeLocks.map((lock) => {
        const breadcrumb = lock.nextAction?.trim();
        const base = `- ${lock.taskName || lock.taskSlug}: ${lock.branchName} @ ${lock.worktreePath}`;
        return breadcrumb ? `${base}\n  last logged step: ${breadcrumb}` : base;
      }),
      'Next: run pipelane:resume -- --task "<task-name>"',
    ];
    // `activeLocks` gives JSON consumers structured per-lock data
    // (including the v1.4 `lockNextAction` breadcrumb) so the multi-lock
    // --json shape exposes the same breadcrumb field as the single-lock
    // and single-task branches. Additive — existing consumers that only
    // read `message` keep working.
    printResult(parsed.flags, { message: lines.join('\n'), activeLocks: renderedLocks });
    return;
  }

  const { taskName, taskSlug } = resolveTaskCommandIdentity(parsed.flags.task);
  const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
  const prunedTaskLock = findPrunedTaskLock(removedLocks, taskSlug);

  if (!lock) {
    throw new Error([
      prunedTaskLock ? `Removed stale task lock for ${taskName}.` : `No active task lock exists for ${taskName}.`,
      ...(prunedTaskLock ? prunedTaskLock.reasons.map((reason) => `- ${reason}`) : []),
      `Next: run pipelane:new -- --task "${taskName}"`,
    ].join('\n'));
  }

  const nodeModulesWarning = ensureSharedNodeModulesLink(context.commonDir, lock.worktreePath);
  printResult(parsed.flags, buildTaskWorkspaceOutput({
    repoRoot: context.repoRoot,
    taskName,
    taskSlug,
    branchName: lock.branchName,
    worktreePath: lock.worktreePath,
    mode: lock.mode,
    createdWorktree: false,
    resumed: true,
    warnings: [
      ...(context.modeState.mode !== lock.mode
        ? [`Current Dev Mode is ${context.modeState.mode}, but this task is locked to ${lock.mode}. Switch back before /pr or /merge.`]
        : []),
      ...(nodeModulesWarning ? [nodeModulesWarning] : []),
    ],
    reasons: ['resuming the existing task workspace for this task'],
    lockNextAction: lock.nextAction ?? null,
  }));
}
