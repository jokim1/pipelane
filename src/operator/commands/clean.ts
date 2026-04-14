import { printResult, resolveWorkflowContext, type ParsedOperatorArgs } from '../state.ts';
import { listActiveTaskLocks, pruneDeadTaskLocks } from '../task-workspaces.ts';

export async function handleClean(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);

  if (parsed.flags.apply) {
    const removed = pruneDeadTaskLocks(context.commonDir, context.config);
    printResult(parsed.flags, {
      removed: removed.map((entry) => entry.taskSlug),
      message: removed.length === 0
        ? 'No stale task locks were pruned.'
        : [
          'Pruned stale task locks:',
          ...removed.map((entry) => `- ${entry.taskSlug}: ${entry.branchName} @ ${entry.worktreePath}`),
        ].join('\n'),
    });
    return;
  }

  const activeLocks = listActiveTaskLocks(context.commonDir, context.config);
  const lines = [
    'Workflow clean status:',
    `Active task locks: ${activeLocks.length}`,
  ];
  if (activeLocks.length > 0) {
    lines.push(...activeLocks.map((lock) => `- ${lock.taskName || lock.taskSlug}: ${lock.branchName} @ ${lock.worktreePath}`));
  }
  lines.push('Run workflow:clean -- --apply to prune stale task locks.');

  printResult(parsed.flags, { message: lines.join('\n') });
}
