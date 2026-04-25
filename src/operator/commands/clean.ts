import {
  formatWorkflowCommand,
  printResult,
  resolveWorkflowContext,
  slugifyTaskName,
  type ParsedOperatorArgs,
} from '../state.ts';
import {
  listActiveTaskLocks,
  listOrphanWorktrees,
  pruneDeadTaskLocks,
  removeTaskArtifacts,
  type OrphanWorktree,
  type RemovedTaskLock,
} from '../task-workspaces.ts';

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

    // --task is the end-of-task closer: prune the lock, then tear down the
    // worktree + local branch the lock pointed at. --all-stale stays
    // metadata-only — it sweeps abandoned locks across many tasks and the
    // blast radius of bulk worktree removal would be too high (e.g. an
    // operator restarting the daemon would briefly orphan locks for live
    // worktrees the operator wanted to keep).
    const artifactResults = taskFlag
      ? performArtifactRemoval({
          removed,
          sharedRepoRoot: context.repoRoot,
          callerCwd: cwd,
          force: parsed.flags.force,
        })
      : [];

    const messageLines: string[] = [];
    if (removed.length === 0) {
      messageLines.push(
        taskFlag
          ? `No task lock matched --task ${targetSlug}.`
          : 'No stale task locks were pruned.',
      );
    } else if (taskFlag) {
      // Single-task closer header. Show what was actually torn down so the
      // operator sees the difference between "lock + worktree + branch all
      // gone" and "lock gone, but the worktree/branch refused to remove
      // (re-run with --force)".
      messageLines.push('Closed out task workspaces:');
      for (const lock of removed) {
        const result = artifactResults.find((entry) => entry.taskSlug === lock.taskSlug);
        const parts = ['lock'];
        if (result?.worktreeRemoved) parts.push('worktree');
        if (result?.branchRemoved) parts.push('branch');
        messageLines.push(`- ${lock.taskSlug}: removed ${parts.join(' + ')}`);
        if (result) {
          for (const warning of result.warnings) messageLines.push(`  note: ${warning}`);
          for (const error of result.errors) messageLines.push(`  ! ${error}`);
        }
      }
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
      // v1.6: per-artifact teardown summary so JSON consumers can tell
      // "lock pruned but worktree/branch refused" apart from full success.
      // Empty for --all-stale (metadata-only mode).
      artifacts: artifactResults,
      message: messageLines.join('\n'),
    });
    return;
  }

  const activeLocks = listActiveTaskLocks(context.commonDir, context.config);
  const orphans = listOrphanWorktrees(context.commonDir, context.config);
  const lines = [
    'Workflow clean status:',
    `Active task locks: ${activeLocks.length}`,
  ];
  if (activeLocks.length > 0) {
    lines.push(...activeLocks.map((lock) => `- ${lock.taskName || lock.taskSlug}: ${lock.branchName} @ ${lock.worktreePath}`));
  }
  if (orphans.length > 0) {
    lines.push(`Orphan worktrees (no matching task lock): ${orphans.length}`);
    lines.push(...orphans.map((entry) => formatOrphanLine(entry)));
    lines.push('Pipelane does not auto-remove orphans (they may belong to another agent).');
    lines.push('Inspect with `git -C <path> status`, then `git worktree remove <path>` when safe.');
  }
  lines.push(`Run ${formatWorkflowCommand(context.config, 'clean')} --apply --all-stale to prune every stale task lock,`);
  lines.push(`or ${formatWorkflowCommand(context.config, 'clean')} --apply --task <slug> to close out one task (removes lock + worktree + branch).`);

  printResult(parsed.flags, {
    activeLocks: activeLocks.map((lock) => ({
      taskSlug: lock.taskSlug,
      taskName: lock.taskName ?? null,
      branchName: lock.branchName,
      worktreePath: lock.worktreePath,
    })),
    orphanWorktrees: orphans,
    message: lines.join('\n'),
  });
}

interface ArtifactRemovalSummary {
  taskSlug: string;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  warnings: string[];
  errors: string[];
}

function performArtifactRemoval(options: {
  removed: RemovedTaskLock[];
  sharedRepoRoot: string;
  callerCwd: string;
  force: boolean;
}): ArtifactRemovalSummary[] {
  return options.removed.map((lock) => {
    const result = removeTaskArtifacts({
      sharedRepoRoot: options.sharedRepoRoot,
      worktreePath: lock.worktreePath,
      branchName: lock.branchName,
      callerCwd: options.callerCwd,
      force: options.force,
    });
    return {
      taskSlug: lock.taskSlug,
      worktreeRemoved: result.worktreeRemoved,
      branchRemoved: result.branchRemoved,
      warnings: result.warnings,
      errors: result.errors,
    };
  });
}

function formatOrphanLine(entry: OrphanWorktree): string {
  const sourceTag = entry.source === 'pipelane-managed' ? 'pipelane-managed' : 'external';
  const branchTag = entry.isDetached ? 'detached HEAD' : entry.branchName ?? '(no branch)';
  return `- ${entry.path}  [${sourceTag}, ${branchTag}]`;
}

// Test hook: override the 5-min prune floor. Gated to NODE_ENV==='test' so a
// stray env var in a shared production shell cannot quietly disable the
// safety gate. Accepts a non-negative integer number of milliseconds;
// malformed values fall through to the default.
function readMinAgeOverride(): number | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined;
  const raw = process.env.PIPELANE_CLEAN_MIN_AGE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}
