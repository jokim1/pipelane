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
  listActiveTaskLocks,
  pruneDeadTaskLocks,
  resolveTaskBaseRef,
  resolveTaskCommandIdentity,
  resolveTaskWorktreeRoot,
  saveNewTaskLock,
} from '../task-workspaces.ts';
import { runGit } from '../state.ts';
import { resolveCommandSurfaces } from './helpers.ts';

// v1.5: soft-warn when the operator has 3+ active tasks. Never blocks —
// small teams legitimately juggle several lanes, but 24 half-alive
// worktrees is a scope-explosion smell the operator should see before
// starting yet another one. Uses stderr so `--json` stays clean.
export const WIP_SOFT_WARN_THRESHOLD = 3;

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

  // v1.5: soft warn for WIP explosion. Runs AFTER pruneDeadTaskLocks so
  // the count reflects genuinely-active locks, not zombies a previous
  // session left behind. Message is worded around the POST-save count so
  // the operator sees "about to hit N+1" rather than the pre-save N
  // (undercount by one).
  const activeLocks = listActiveTaskLocks(context.commonDir, context.config);
  if (activeLocks.length >= WIP_SOFT_WARN_THRESHOLD && !parsed.flags.json) {
    const oldestAgeHours = computeOldestLockAgeHours(activeLocks);
    const ageNote = oldestAgeHours !== null ? `, oldest updated ${oldestAgeHours}h ago` : '';
    const after = activeLocks.length + 1;
    process.stderr.write([
      `⚠  You have ${activeLocks.length} tasks in flight${ageNote}; about to start a ${ordinal(after)}.`,
      `   Consider /resume on an existing task instead of piling on another.`,
      `   Continuing (this is a warning, not a block).`,
      '',
    ].join('\n'));
  }

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

function ordinal(n: number): string {
  // Small table for the common cases the WIP warn actually hits (≥ 4th).
  // Fall through to the generic rule for 21st/22nd/23rd etc., which can
  // happen if the warn is raised late in a very-long-running operator
  // session.
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function computeOldestLockAgeHours(locks: Array<{ updatedAt?: string }>): number | null {
  const now = Date.now();
  let oldestMs: number | null = null;
  for (const lock of locks) {
    if (!lock.updatedAt) continue;
    const parsed = Date.parse(lock.updatedAt);
    if (!Number.isFinite(parsed)) continue;
    const ageMs = now - parsed;
    if (oldestMs === null || ageMs > oldestMs) oldestMs = ageMs;
  }
  if (oldestMs === null) return null;
  return Math.max(0, Math.round(oldestMs / (60 * 60 * 1000)));
}
