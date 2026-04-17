import {
  printResult,
  resolveWorkflowContext,
  slugifyTaskName,
  type ParsedOperatorArgs,
} from '../state.ts';
import { listActiveTaskLocks, pruneDeadTaskLocks } from '../task-workspaces.ts';

export async function handleClean(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);

  if (parsed.flags.apply) {
    const taskFlag = parsed.flags.task.trim();
    const allStale = parsed.flags.allStale;

    // v0.7: /clean --apply must declare scope. Without --task or --all-stale
    // an operator can nuke every lock in the repo with a single keystroke,
    // including locks still ticking. The differential harness flagged this.
    if (!taskFlag && !allStale) {
      throw new Error([
        '/clean --apply requires scope.',
        'Pass --task <slug> to prune one lock, or --all-stale to prune every dead lock.',
        'Locks younger than 5 minutes are always kept even when scope is set.',
      ].join('\n'));
    }

    if (taskFlag && allStale) {
      throw new Error([
        '/clean --apply cannot combine --task and --all-stale.',
        'Pick one scope so the operator knows what to prune.',
      ].join('\n'));
    }

    const targetSlug = taskFlag ? slugifyTaskName(taskFlag) : undefined;
    if (taskFlag && !targetSlug) {
      throw new Error(`Could not derive a valid task slug from --task "${taskFlag}".`);
    }

    const { removed, skipped } = pruneDeadTaskLocks(context.commonDir, context.config, {
      taskSlug: targetSlug,
      minAgeMs: readMinAgeOverride(),
    });

    const messageLines: string[] = [];
    if (removed.length === 0) {
      messageLines.push(
        taskFlag
          ? `No stale task lock pruned for ${targetSlug}.`
          : 'No stale task locks were pruned.',
      );
    } else {
      messageLines.push('Pruned stale task locks:');
      messageLines.push(
        ...removed.map((entry) => `- ${entry.taskSlug}: ${entry.branchName} @ ${entry.worktreePath}`),
      );
    }
    if (skipped.length > 0) {
      messageLines.push('Kept (too young to prune, <5 min):');
      messageLines.push(...skipped.map((entry) => `- ${entry.taskSlug}: ${entry.reason}`));
    }

    printResult(parsed.flags, {
      removed: removed.map((entry) => entry.taskSlug),
      skipped: skipped.map((entry) => ({ taskSlug: entry.taskSlug, reason: entry.reason })),
      message: messageLines.join('\n'),
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
  lines.push('Run workflow:clean -- --apply --all-stale to prune every stale task lock,');
  lines.push('or workflow:clean -- --apply --task <slug> to prune one.');

  printResult(parsed.flags, { message: lines.join('\n') });
}

// Test hook: override the 5-min prune floor. Production sets no env, callers
// fall through to TASK_LOCK_MIN_PRUNE_AGE_MS. Accepts a non-negative integer
// number of milliseconds; malformed values fall through to the default.
function readMinAgeOverride(): number | undefined {
  const raw = process.env.PIPELANE_CLEAN_MIN_AGE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}
