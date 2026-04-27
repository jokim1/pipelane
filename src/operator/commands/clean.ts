import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

import {
  acquireTaskCleanupLock,
  formatWorkflowCommand,
  loadDeployState,
  loadPrState,
  loadTaskLock,
  normalizePath,
  printResult,
  resolveWorkflowContext,
  runCommandCapture,
  runGit,
  slugifyTaskName,
  type DeployRecord,
  type ParsedOperatorArgs,
  type PrRecord,
  type TaskLock,
  type WorkflowConfig,
} from '../state.ts';
import { resolveDeployStateKey } from '../integrity.ts';
import { verifyDeployRecord } from '../release-gate.ts';
import {
  branchTreeMatchesRef,
  listActiveTaskLocks,
  listOrphanWorktrees,
  pruneDeadTaskLocks,
  removeTaskArtifacts,
  resolveSharedRepoRoot,
  TASK_LOCK_MIN_PRUNE_AGE_MS,
  type OrphanWorktree,
  type RemovedTaskLock,
} from '../task-workspaces.ts';

export async function handleClean(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const sharedRepoRoot = resolveSharedRepoRoot(context.commonDir);

  if (parsed.flags.apply) {
    const taskFlag = parsed.flags.task.trim();
    const allStale = parsed.flags.allStale;
    const prRecords = loadPrState(context.commonDir, context.config).records;
    const deployRecords = loadTrustedDeployRecords(context.commonDir, context.config);

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
          sharedRepoRoot,
          callerCwd: cwd,
          force: parsed.flags.force,
          safeDeleteBranchRefs: buildSafeDeleteBranchRefs(removed, prRecords, deployRecords),
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

  const autoCleanup = closeSafeCompletedTaskWorkspaces({
    commonDir: context.commonDir,
    config: context.config,
    sharedRepoRoot,
    callerCwd: cwd,
    minAgeMs: readMinAgeOverride(),
    dryRun: parsed.flags.statusOnly,
  });
  const activeLocks = listActiveTaskLocks(context.commonDir, context.config);
  const orphans = listOrphanWorktrees(context.commonDir, context.config);
  const lines: string[] = [];
  if (autoCleanup.closed.length > 0) {
    lines.push(parsed.flags.statusOnly ? 'Would close safe completed task workspaces:' : 'Closed out safe completed task workspaces:');
    for (const result of autoCleanup.closed) {
      if (parsed.flags.statusOnly) {
        lines.push(`- ${result.taskSlug}: would remove lock + worktree + branch`);
        continue;
      }
      const parts = ['lock'];
      if (result.worktreeRemoved) parts.push('worktree');
      if (result.branchRemoved) parts.push('branch');
      lines.push(`- ${result.taskSlug}: removed ${parts.join(' + ')}`);
      for (const warning of result.warnings) lines.push(`  note: ${warning}`);
      for (const error of result.errors) lines.push(`  ! ${error}`);
    }
    lines.push('');
  }
  if (autoCleanup.skipped.length > 0) {
    lines.push('Completed task workspaces kept for manual cleanup:');
    lines.push(...autoCleanup.skipped.map((entry) => `- ${entry.taskSlug}: ${entry.reason}`));
    lines.push('');
  }
  lines.push(
    'Workflow clean status:',
    `Active task locks: ${activeLocks.length}`,
  );
  if (activeLocks.length > 0) {
    lines.push(...activeLocks.map((lock) => `- ${lock.taskName || lock.taskSlug}: ${lock.branchName} @ ${lock.worktreePath}`));
  }
  if (orphans.length > 0) {
    lines.push(`Orphan worktrees (no matching task lock): ${orphans.length}`);
    lines.push(...orphans.map((entry) => formatOrphanLine(entry)));
    lines.push('Pipelane does not auto-remove orphans (they may belong to another agent).');
    lines.push('Inspect with `git -C <path> status`, then `git worktree remove <path>` when safe.');
  }
  lines.push(`${formatWorkflowCommand(context.config, 'clean')} closes completed, prod-verified task workspaces automatically when safety checks pass.`);
  lines.push(`Run ${formatWorkflowCommand(context.config, 'clean')} --status-only to preview cleanup without removing anything,`);
  lines.push(`Run ${formatWorkflowCommand(context.config, 'clean')} --apply --all-stale to prune every stale task lock,`);
  lines.push(`or ${formatWorkflowCommand(context.config, 'clean')} --apply --task <slug> to close out one task explicitly.`);

  printResult(parsed.flags, {
    autoCleaned: parsed.flags.statusOnly ? [] : autoCleanup.closed.map((entry) => entry.taskSlug),
    autoCleanCandidates: autoCleanup.closed.map((entry) => entry.taskSlug),
    autoCleanSkipped: autoCleanup.skipped,
    artifacts: autoCleanup.closed,
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
  safeDeleteBranchRefs?: Map<string, string>;
}): ArtifactRemovalSummary[] {
  return options.removed.map((lock) => {
    const result = removeTaskArtifacts({
      sharedRepoRoot: options.sharedRepoRoot,
      worktreePath: lock.worktreePath,
      branchName: lock.branchName,
      callerCwd: options.callerCwd,
      force: options.force,
      safeDeleteBranchRef: options.safeDeleteBranchRefs?.get(lock.taskSlug),
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

interface AutoCleanupSkip {
  taskSlug: string;
  reason: string;
}

function closeSafeCompletedTaskWorkspaces(options: {
  commonDir: string;
  config: WorkflowConfig;
  sharedRepoRoot: string;
  callerCwd: string;
  minAgeMs?: number;
  dryRun?: boolean;
}): { closed: ArtifactRemovalSummary[]; skipped: AutoCleanupSkip[] } {
  const prRecords = loadPrState(options.commonDir, options.config).records;
  const deployRecords = loadTrustedDeployRecords(options.commonDir, options.config);
  const minAgeMs = options.minAgeMs ?? TASK_LOCK_MIN_PRUNE_AGE_MS;
  const closed: ArtifactRemovalSummary[] = [];
  const skipped: AutoCleanupSkip[] = [];

  for (const observedLock of listActiveTaskLocks(options.commonDir, options.config)) {
    let releaseCleanupLock: (() => void) | null = null;
    if (!options.dryRun) {
      const cleanupLock = acquireTaskCleanupLock(options.commonDir, options.config, observedLock.taskSlug);
      if (cleanupLock.acquired === false) {
        skipped.push({ taskSlug: observedLock.taskSlug, reason: cleanupLock.reason });
        continue;
      }
      releaseCleanupLock = cleanupLock.release;
    }

    try {
      const lock = options.dryRun
        ? observedLock
        : loadTaskLock(options.commonDir, options.config, observedLock.taskSlug);
      if (!lock) {
        skipped.push({ taskSlug: observedLock.taskSlug, reason: 'task lock disappeared before auto-clean could inspect it' });
        continue;
      }

      const safeDeleteBranchRef = resolveVerifiedProdCleanupRef(lock, prRecords, deployRecords);
      if (!safeDeleteBranchRef) continue;

      const blocker = explainAutoCleanupBlocker({
        lock,
        safeDeleteBranchRef,
        sharedRepoRoot: options.sharedRepoRoot,
        callerCwd: options.callerCwd,
        minAgeMs,
      });
      if (blocker) {
        skipped.push({ taskSlug: lock.taskSlug, reason: blocker });
        continue;
      }

      if (options.dryRun) {
        closed.push({
          taskSlug: lock.taskSlug,
          worktreeRemoved: false,
          branchRemoved: false,
          warnings: [],
          errors: [],
        });
        continue;
      }

      const result = removeTaskArtifacts({
        sharedRepoRoot: options.sharedRepoRoot,
        worktreePath: lock.worktreePath,
        branchName: lock.branchName,
        callerCwd: options.callerCwd,
        force: false,
        safeDeleteBranchRef,
      });
      if (result.errors.length > 0 || !result.worktreeRemoved || !result.branchRemoved) {
        skipped.push({
          taskSlug: lock.taskSlug,
          reason: result.errors.join('; ') || 'artifact removal did not complete',
        });
        continue;
      }

      const pruned = pruneDeadTaskLocks(options.commonDir, options.config, {
        taskSlug: lock.taskSlug,
        minAgeMs,
      });
      if (pruned.removed.length === 0) {
        skipped.push({
          taskSlug: lock.taskSlug,
          reason: pruned.skipped[0]?.reason ?? 'lock was already removed before auto-clean could prune it',
        });
        continue;
      }

      closed.push({
        taskSlug: lock.taskSlug,
        worktreeRemoved: result.worktreeRemoved,
        branchRemoved: result.branchRemoved,
        warnings: result.warnings,
        errors: result.errors,
      });
    } finally {
      releaseCleanupLock?.();
    }
  }

  return { closed, skipped };
}

function loadTrustedDeployRecords(commonDir: string, config: WorkflowConfig): DeployRecord[] {
  const records = loadDeployState(commonDir, config).records.filter(isDeployRecordObject);
  const stateKey = resolveDeployStateKey();
  return stateKey ? records.filter((record) => verifyDeployRecord(record, stateKey)) : records;
}

function buildSafeDeleteBranchRefs(
  removed: RemovedTaskLock[],
  prRecords: Record<string, PrRecord>,
  deployRecords: DeployRecord[],
): Map<string, string> {
  const refs = new Map<string, string>();
  for (const lock of removed) {
    const ref = resolveVerifiedProdCleanupRef(lock, prRecords, deployRecords);
    if (ref) refs.set(lock.taskSlug, ref);
  }
  return refs;
}

function resolveVerifiedProdCleanupRef(
  lock: Pick<TaskLock, 'taskSlug' | 'surfaces'>,
  prRecords: Record<string, PrRecord>,
  deployRecords: DeployRecord[],
): string | null {
  const mergedSha = normalizeGitSha(prRecords[lock.taskSlug]?.mergedSha);
  if (!mergedSha) return null;

  for (let index = deployRecords.length - 1; index >= 0; index -= 1) {
    const record = deployRecords[index] as unknown;
    if (!isDeployRecordObject(record)) continue;
    if (deployRecordQualifiesForCleanup(record, lock.taskSlug, mergedSha, lock.surfaces)) {
      return mergedSha;
    }
  }

  return null;
}

function deployRecordQualifiesForCleanup(record: DeployRecord, taskSlug: string, mergedSha: string, requiredSurfaces: string[]): boolean {
  if (record.environment !== 'prod') return false;
  if (record.taskSlug !== taskSlug) return false;
  if (normalizeGitSha(record.sha) !== mergedSha) return false;
  if (record.status !== 'succeeded') return false;
  if (!isValidIsoTimestamp(record.verifiedAt)) return false;
  if (typeof record.configFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(record.configFingerprint)) return false;
  if (!Array.isArray(record.surfaces) || record.surfaces.length === 0) return false;
  const surfacesRequired = Array.isArray(requiredSurfaces) ? requiredSurfaces : [];
  if (!surfacesRequired.every((surface) => record.surfaces.includes(surface))) return false;
  return record.surfaces.every((surface) => deployRecordSurfaceVerified(record, surface));
}

function deployRecordSurfaceVerified(record: DeployRecord, surface: string): boolean {
  const perSurface = record.verificationBySurface?.[surface];
  if (perSurface) return verificationStatusCodeIs2xx(perSurface.statusCode);
  if (surface === 'frontend' && record.verification) return verificationStatusCodeIs2xx(record.verification.statusCode);
  return false;
}

function verificationStatusCodeIs2xx(value: unknown): boolean {
  return typeof value === 'number' && value >= 200 && value < 300;
}

function explainAutoCleanupBlocker(options: {
  lock: TaskLock;
  safeDeleteBranchRef: string;
  sharedRepoRoot: string;
  callerCwd: string;
  minAgeMs: number;
}): string | null {
  const ageMs = lockAgeMs(options.lock.updatedAt, Date.now());
  if (ageMs === null) {
    return `updatedAt is missing or unparseable ("${options.lock.updatedAt ?? ''}")`;
  }
  if (ageMs < options.minAgeMs) {
    return `updatedAt ${options.lock.updatedAt} is ${Math.round(ageMs / 1000)}s old — below the ${Math.round(options.minAgeMs / 1000)}s prune floor`;
  }

  if (!existsSync(options.lock.worktreePath)) {
    return 'saved worktree is missing; use --apply --all-stale for stale lock pruning';
  }
  if (isSameOrInside(options.lock.worktreePath, options.callerCwd)) {
    return `cannot remove worktree ${options.lock.worktreePath} while running inside it`;
  }

  const branchExists = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', `refs/heads/${options.lock.branchName}`], true);
  if (!branchExists) {
    return 'saved branch is missing; use --apply --all-stale for stale lock pruning';
  }

  const worktreeBranch = runGit(options.lock.worktreePath, ['branch', '--show-current'], true)?.trim() ?? '';
  if (!worktreeBranch) {
    return `saved worktree ${options.lock.worktreePath} is detached or has no current branch`;
  }
  if (worktreeBranch !== options.lock.branchName) {
    return `saved worktree branch ${worktreeBranch} does not match saved branch ${options.lock.branchName}`;
  }

  const status = runCommandCapture('git', ['status', '--porcelain'], { cwd: options.lock.worktreePath });
  if (!status.ok) {
    return `could not inspect worktree status: ${status.stderr || status.stdout || 'git status failed'}`;
  }
  if (status.stdout.trim().length > 0) {
    return 'worktree has uncommitted or untracked changes';
  }
  const ignoredBlocker = explainIgnoredContentBlocker(options.lock.worktreePath);
  if (ignoredBlocker) {
    return ignoredBlocker;
  }

  if (!branchTreeMatchesRef(options.sharedRepoRoot, options.lock.branchName, options.safeDeleteBranchRef)) {
    return `branch tree differs from verified prod SHA ${options.safeDeleteBranchRef.slice(0, 7)}`;
  }

  return null;
}

function lockAgeMs(updatedAt: string | undefined, now: number): number | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

function normalizeGitSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-f0-9]{7,40}$/i.test(trimmed) ? trimmed : null;
}

function isValidIsoTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isDeployRecordObject(value: unknown): value is DeployRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function explainIgnoredContentBlocker(worktreePath: string): string | null {
  const status = runCommandCapture('git', ['status', '--porcelain', '--ignored=matching'], { cwd: worktreePath });
  if (!status.ok) {
    return `could not inspect ignored worktree content: ${status.stderr || status.stdout || 'git status --ignored failed'}`;
  }

  const ignoredPaths = status.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3).trim())
    .filter((entry) => entry.length > 0);
  const unsafeIgnoredPaths = ignoredPaths.filter((entry) => !isAllowedAutoCleanIgnoredPath(worktreePath, entry));
  if (unsafeIgnoredPaths.length === 0) return null;

  const sample = unsafeIgnoredPaths.slice(0, 3).join(', ');
  const suffix = unsafeIgnoredPaths.length > 3 ? `, +${unsafeIgnoredPaths.length - 3} more` : '';
  return `worktree has ignored local files (${sample}${suffix}); use --apply --task <slug> when deleting ignored content is intentional`;
}

function isAllowedAutoCleanIgnoredPath(worktreePath: string, ignoredPath: string): boolean {
  const normalized = ignoredPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized !== 'node_modules') return false;
  try {
    return lstatSync(path.join(worktreePath, ignoredPath)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSameOrInside(parentPath: string, childPath: string): boolean {
  const parent = normalizePath(parentPath);
  const child = normalizePath(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
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
