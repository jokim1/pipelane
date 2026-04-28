import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  formatWorkflowCommand,
  normalizePath,
  loadTaskLock,
  printResult,
  resolveWorkflowContext,
  type ParsedOperatorArgs,
  type WorkflowConfig,
} from '../state.ts';
import {
  buildCurrentWorkspaceReasons,
  buildTaskWorkspaceOutput,
  ensureSharedNodeModulesLink,
  findPrunedTaskLock,
  generateHex,
  generateUniqueTaskWorkspace,
  listOrphanWorktrees,
  listActiveTaskLocks,
  readWorktreeStatus,
  pruneDeadTaskLocks,
  resolveTaskBaseRef,
  resolveTaskCommandIdentity,
  resolveTaskWorktreeRoot,
  saveNewTaskLock,
  type OrphanWorktree,
} from '../task-workspaces.ts';
import { runGit } from '../state.ts';
import { inferTaskSlugsFromBranchName, resolveCommandSurfaces } from './helpers.ts';

// v1.5: soft-warn when the operator has 3+ active tasks. Never blocks —
// small teams legitimately juggle several lanes, but 24 half-alive
// worktrees is a scope-explosion smell the operator should see before
// starting yet another one. Uses stderr so `--json` stays clean.
export const WIP_SOFT_WARN_THRESHOLD = 3;

export async function handleNew(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const rawTask = parsed.flags.task.trim();
  const context = resolveWorkflowContext(cwd);

  if (!rawTask && !parsed.flags.unnamed) {
    throw new Error(formatMissingTaskError(context.config, listOrphanWorktrees(context.commonDir, context.config)));
  }

  const effectiveTask = rawTask || `task-${generateHex()}`;
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
  assertNewTaskStartIsSafe({
    config: context.config,
    repoRoot: context.repoRoot,
    activeLocks,
    taskSlug,
    force: parsed.flags.force,
    matchingOrphans: matchingOrphanWorktrees(context.commonDir, context.config, taskSlug),
  });

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
      `Next: run ${formatWorkflowCommand(context.config, 'resume')} --task "${taskName}"`,
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
  const nodeModulesWarning = ensureSharedNodeModulesLink(context.commonDir, workspace.worktreePath, {
    replaceExistingDirectory: true,
  });
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
    warnings: [...baseRef.warnings, ...warnings, ...(nodeModulesWarning ? [nodeModulesWarning] : [])],
    reasons,
  }));
}

function formatMissingTaskError(config: WorkflowConfig, orphans: OrphanWorktree[]): string {
  const lines = [
    `${formatWorkflowCommand(config, 'new')} needs a task name before it creates a workspace.`,
    `Describe the task, then run ${formatWorkflowCommand(config, 'new')} so the agent can infer the task name.`,
    `Or pass ${formatWorkflowCommand(config, 'new', '--task "<task-name>"')} directly.`,
    `To intentionally create a generated task slug, run ${formatWorkflowCommand(config, 'new', '--unnamed')}.`,
  ];

  if (orphans.length > 0) {
    lines.push(
      '',
      'Existing worktrees without task locks were found. If one is your task, continue there instead of starting another workspace:',
      ...orphans.slice(0, 5).map((orphan) => `- ${formatOrphanWorktree(orphan)}`),
    );
    if (orphans.length > 5) {
      lines.push(`- ... ${orphans.length - 5} more`);
    }
  }

  return lines.join('\n');
}

function assertNewTaskStartIsSafe(options: {
  config: WorkflowConfig;
  repoRoot: string;
  activeLocks: Array<{ taskSlug: string; taskName?: string; branchName: string; worktreePath: string }>;
  taskSlug: string;
  force: boolean;
  matchingOrphans: OrphanWorktree[];
}): void {
  if (options.force) {
    return;
  }

  const status = readWorktreeStatus(options.repoRoot);
  const repoPath = normalizePath(options.repoRoot);
  const currentLock = options.activeLocks.find((lock) =>
    lock.branchName === status.branchName || normalizePath(lock.worktreePath) === repoPath
  );

  if (currentLock) {
    throw new Error([
      `${formatWorkflowCommand(options.config, 'new')} blocked because this checkout is already bound to an active task.`,
      `Task: ${currentLock.taskName || currentLock.taskSlug}`,
      `Branch: ${currentLock.branchName}`,
      `Worktree: ${currentLock.worktreePath}`,
      `Next: continue in that worktree, or run ${formatWorkflowCommand(options.config, 'resume', `--task "${currentLock.taskName || currentLock.taskSlug}"`)}.`,
      `If you intentionally want another workspace anyway, rerun ${formatWorkflowCommand(options.config, 'new', `--task "${options.taskSlug}" --force`)}.`,
    ].join('\n'));
  }

  if (status.statusLines.length > 0) {
    throw new Error([
      `${formatWorkflowCommand(options.config, 'new')} blocked because the current checkout has uncommitted changes.`,
      ...status.statusLines.slice(0, 10).map((line) => `- ${line}`),
      status.statusLines.length > 10 ? `- ... ${status.statusLines.length - 10} more` : '',
      'Commit, stash, or move this work into a task before starting another workspace.',
      `If this is intentional, rerun ${formatWorkflowCommand(options.config, 'new', `--task "${options.taskSlug}" --force`)}.`,
    ].filter(Boolean).join('\n'));
  }

  if (options.matchingOrphans.length > 0) {
    throw new Error([
      `${formatWorkflowCommand(options.config, 'new')} blocked because an existing worktree looks like this task but has no task lock.`,
      ...options.matchingOrphans.map((orphan) => `- ${formatOrphanWorktree(orphan)}`),
      'Continue in that worktree, or inspect with git status before starting a replacement.',
      `If this is unrelated, rerun ${formatWorkflowCommand(options.config, 'new', `--task "${options.taskSlug}" --force`)}.`,
    ].join('\n'));
  }
}

function matchingOrphanWorktrees(commonDir: string, config: WorkflowConfig, taskSlug: string): OrphanWorktree[] {
  const orphans = listOrphanWorktrees(commonDir, config);
  return orphans.filter((orphan) => orphanMatchesTaskSlug(orphan, config, taskSlug));
}

function orphanMatchesTaskSlug(orphan: OrphanWorktree, config: WorkflowConfig, taskSlug: string): boolean {
  if (orphan.branchName) {
    const branchSlugs = inferTaskSlugsFromBranchName(config, orphan.branchName);
    if (branchSlugs.includes(taskSlug) || basenameMatchesTaskSlug(path.basename(orphan.branchName), taskSlug)) {
      return true;
    }
  }

  return basenameMatchesTaskSlug(path.basename(orphan.path), taskSlug);
}

function basenameMatchesTaskSlug(basename: string, taskSlug: string): boolean {
  const candidates = new Set([basename, basename.replace(/-[a-f0-9]{4}$/i, '')]);
  for (const candidate of candidates) {
    if (normalizeTaskNameCandidate(candidate) === taskSlug) {
      return true;
    }
  }
  return false;
}

function normalizeTaskNameCandidate(candidate: string): string {
  return candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatOrphanWorktree(orphan: OrphanWorktree): string {
  const branch = orphan.branchName ?? (orphan.isDetached ? '(detached)' : '(unknown branch)');
  return `${branch} @ ${orphan.path} (${orphan.source})`;
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
