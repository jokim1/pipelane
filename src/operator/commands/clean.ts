import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { cleanTaskBudgetArtifactsForTask } from '../task-budget.ts';

import {
  acquireOrphanCleanupLock,
  acquireTaskWorkspaceLease,
  automaticWorktreeCleanupEnabled,
  compareAndSetTaskLockWithWorkspaceLease,
  ensureTaskBindingId,
  findDeliveriesByTask,
  formatWorkflowCommand,
  loadPrState,
  prRecordMatchesTaskLock,
  loadTaskLock,
  nowIso,
  normalizeExistingPath,
  normalizePath,
  printResult,
  resolveWorkflowContext,
  removeTaskLockWithWorkspaceLease,
  runCommandCapture,
  runGit,
  saveDeliveryRecord,
  slugifyTaskName,
  type ParsedOperatorArgs,
  type TaskLock,
  type TaskWorkspaceLease,
  type WorkflowConfig,
} from '../state.ts';
import {
  assessTaskCleanup,
  classifyOrphan,
  inspectCleanupStatus,
  listActiveTaskLocks,
  listOrphanWorktrees,
  pruneDeadTaskLocks,
  removeOrphanWorktree,
  removeTaskArtifacts,
  resolveSharedRepoRoot,
  TASK_LOCK_MIN_PRUNE_AGE_MS,
  type CleanupEvidenceRevision,
  type DeliveryProof,
  type OrphanClassification,
  type OrphanWorktree,
} from '../task-workspaces.ts';

export async function handleClean(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const sharedRepoRoot = resolveSharedRepoRoot(context.commonDir);

  if (parsed.flags.apply) {
    if (parsed.flags.delivered) {
      await handleApplyDelivered(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
      return;
    }
    if (parsed.flags.completedWithIgnored) {
      await handleApplyCompletedWithIgnored(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
      return;
    }
    if (parsed.flags.safeOrphans) {
      await handleApplySafeOrphans(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
      return;
    }
    if (parsed.flags.mergedOrphans) {
      await handleApplyMergedOrphans(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
      return;
    }
    await handleApplyTaskOrAllStale(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
    return;
  }

  await handleStatus(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
}

// -----------------------------------------------------------------------------
// Apply branches
// -----------------------------------------------------------------------------

async function handleApplyTaskOrAllStale(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const taskFlag = parsed.flags.task.trim();
  const allStale = parsed.flags.allStale;

  if (!taskFlag && !allStale) {
    throw new Error([
      '/clean --apply requires scope.',
      'Pass --task <slug> to prune one lock, --all-stale to prune every dead lock,',
      'or one of --delivered, --completed-with-ignored, --safe-orphans, --merged-orphans for a bulk category.',
    ].join('\n'));
  }

  const targetSlug = taskFlag ? slugifyTaskName(taskFlag) : undefined;
  if (taskFlag && !targetSlug) {
    throw new Error(`Could not derive a valid task slug from --task "${taskFlag}".`);
  }

  if (allStale) {
    const { removed, skipped } = pruneDeadTaskLocks(commonDir, config, { minAgeMs: readMinAgeOverride() });
    const messageLines = removed.length > 0
      ? ['Pruned stale task locks:', ...removed.map((entry) => `- ${entry.taskSlug}: ${entry.branchName} @ ${entry.worktreePath}`)]
      : ['No stale task locks were pruned.'];
    if (skipped.length > 0) {
      messageLines.push('Kept:');
      messageLines.push(...skipped.map((entry) => `- ${entry.taskSlug}: ${entry.reason}`));
    }
    printResult(parsed.flags, {
      removed: removed.map((entry) => entry.taskSlug),
      skipped: skipped.map((entry) => ({ taskSlug: entry.taskSlug, reason: entry.reason })),
      artifacts: [],
      message: messageLines.join('\n'),
    });
    return;
  }

  const lock = targetSlug ? ensureTaskBindingId(commonDir, config, targetSlug) : null;
  if (!lock?.taskBindingId) {
    printResult(parsed.flags, {
      removed: [],
      skipped: targetSlug ? [{ taskSlug: targetSlug, reason: 'no active task lock found' }] : [],
      artifacts: [],
      message: `No task lock matched --task ${targetSlug}.`,
    });
    return;
  }
  const result = executeTaskWorkspaceCleanup({
    commonDir,
    config,
    sharedRepoRoot,
    callerCwd: enterSharedCheckoutForTerminalCleanup(lock, cwd, sharedRepoRoot, commonDir),
    lock,
    automatic: false,
    trigger: 'manual',
    force: parsed.flags.force,
  });
  const parts = [];
  if (result.status === 'cleaned') {
    if (result.worktreeRemoved) parts.push('worktree');
    if (result.branchRemoved) parts.push('branch');
    parts.push('task lock');
  }
  const message = result.status === 'cleaned'
    ? `Closed out ${result.taskSlug}: removed ${parts.join(' + ')}.`
    : result.status === 'blocked'
      ? `Cleanup blocked for ${result.taskSlug}: ${result.reason}`
      : `Cleanup kept ${result.taskSlug}: ${result.reason}`;
  printResult(parsed.flags, {
    removed: result.status === 'cleaned' ? [result.taskSlug] : [],
    skipped: result.status === 'cleaned' ? [] : [{ taskSlug: result.taskSlug, reason: result.reason }],
    artifacts: [result],
    cleanup: result,
    message,
  });
}

export type CleanupOutcome =
  | {
      status: 'cleaned';
      taskSlug: string;
      worktreeRemoved: boolean;
      branchRemoved: boolean;
      warnings: string[];
    }
  | {
      status: 'kept';
      taskSlug: string;
      reason: 'operator-requested' | 'automatic-cleanup-disabled';
    }
  | {
      status: 'blocked';
      taskSlug: string;
      code: import('../state.ts').AutoCleanupBlockerCode;
      reason: string;
      worktreeRemoved?: boolean;
      branchRemoved?: boolean;
    };

export interface RemoteBaseEvidence {
  ref: string;
  sha: string;
  revision: CleanupEvidenceRevision;
}

function refreshRemoteBaseEvidence(sharedRepoRoot: string, config: WorkflowConfig, source: CleanupEvidenceRevision['source']): RemoteBaseEvidence | null {
  const ref = `origin/${config.baseBranch}`;
  const fetched = runCommandCapture('git', ['fetch', 'origin', config.baseBranch, '--no-tags'], { cwd: sharedRepoRoot });
  if (!fetched.ok) return null;
  const sha = runGit(sharedRepoRoot, ['rev-parse', '--verify', ref], true)?.trim() ?? '';
  if (!sha) return null;
  return { ref, sha, revision: { remoteBaseSha: sha, observedAt: nowIso(), source } };
}

function gitObjectIsAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  if (!ancestor || !descendant) return false;
  return runCommandCapture('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot }).ok;
}

function resolveCleanupProof(
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
  lock: TaskLock,
  taskBindingId: string,
  branchHeadSha: string,
  remote: RemoteBaseEvidence,
): { proof: DeliveryProof | null; contained: boolean } {
  if (branchHeadSha && gitObjectIsAncestor(sharedRepoRoot, branchHeadSha, remote.sha)) {
    return {
      proof: {
        kind: 'remote-ancestor',
        branchHeadSha,
        remoteBaseRef: remote.ref,
        remoteBaseSha: remote.sha,
      },
      contained: true,
    };
  }
  const matches = findDeliveriesByTask(commonDir, config, lock.taskSlug, taskBindingId)
    .filter((delivery) => delivery.branchName === lock.branchName
      && delivery.prHeadSha === branchHeadSha
      && gitObjectIsAncestor(sharedRepoRoot, delivery.mergedSha, remote.sha));
  if (matches.length !== 1) return { proof: null, contained: false };
  const delivery = matches[0];
  return {
    proof: {
      kind: 'merged-pr-head',
      prNumber: delivery.prNumber,
      prHeadSha: delivery.prHeadSha,
      mergedSha: delivery.mergedSha,
      remoteBaseRef: remote.ref,
      remoteBaseSha: remote.sha,
    },
    contained: true,
  };
}

function backfillLegacyDeliveryForCleanup(options: {
  commonDir: string;
  config: WorkflowConfig;
  sharedRepoRoot: string;
  lock: TaskLock;
  taskBindingId: string;
  branchHeadSha: string;
  remote: RemoteBaseEvidence | null;
}): string | null {
  if (findDeliveriesByTask(options.commonDir, options.config, options.lock.taskSlug, options.taskBindingId).length > 0) {
    return null;
  }
  const record = loadPrState(options.commonDir, options.config).records[options.lock.taskSlug];
  if (!record?.number || !record.mergedSha || !record.mergedAt || !record.url || !options.branchHeadSha) return null;
  if (!prRecordMatchesTaskLock(record, options.lock)) return null;
  // Legacy PR state did not persist the PR-head SHA. Never infer that an
  // advanced local branch was the head that produced an older merge: doing so
  // would turn merge evidence into authorization to delete unique commits.
  // Two exact identities qualify: SHA equality (merge-commit lands the branch
  // head itself), or byte-identical trees (a squash merge landed outside
  // /merge mints a new SHA, but an identical tree proves every byte of the
  // branch head is already on the base — S0 lane bug #9). A branch that
  // advanced after the squash has a different tree and stays protected.
  if (record.mergedSha !== options.branchHeadSha) {
    const mergedTree = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', `${record.mergedSha}^{tree}`], true)?.trim() ?? '';
    const branchTree = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', `${options.branchHeadSha}^{tree}`], true)?.trim() ?? '';
    if (!mergedTree || !branchTree || mergedTree !== branchTree) return null;
  }
  if (!options.remote || !gitObjectIsAncestor(options.sharedRepoRoot, record.mergedSha, options.remote.sha)) return null;
  try {
    saveDeliveryRecord(options.commonDir, options.config, {
      prNumber: record.number,
      ownership: 'managed-task',
      taskSlug: options.lock.taskSlug,
      taskBindingId: options.taskBindingId,
      branchName: options.lock.branchName,
      mode: options.lock.mode,
      surfaces: options.lock.surfaces,
      baseBranch: options.config.baseBranch,
      prHeadSha: options.branchHeadSha,
      mergedSha: record.mergedSha,
      mergedAt: record.mergedAt,
      title: record.title,
      url: record.url,
    });
    return null;
  } catch (error) {
    return `Legacy delivery backfill failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function sharedCheckoutMatchesCommonDir(sharedRepoRoot: string, commonDir: string): boolean {
  if (!existsSync(sharedRepoRoot)) return false;
  const raw = runGit(sharedRepoRoot, ['rev-parse', '--git-common-dir'], true)?.trim() ?? '';
  if (!raw) return false;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(sharedRepoRoot, raw);
  return normalizePath(resolved) === normalizePath(commonDir);
}

function enterSharedCheckoutForTerminalCleanup(
  lock: TaskLock,
  callerCwd: string,
  sharedRepoRoot: string,
  commonDir: string,
): string {
  if (!existsSync(lock.worktreePath)) return callerCwd;
  const worktree = normalizeExistingPath(lock.worktreePath);
  const caller = normalizeExistingPath(callerCwd);
  const relative = path.relative(worktree, caller);
  const callerInside = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (!callerInside) return callerCwd;
  if (!sharedCheckoutMatchesCommonDir(sharedRepoRoot, commonDir)) {
    throw new Error('Cannot leave the task worktree because the primary shared checkout could not be verified. The workspace was preserved.');
  }
  process.chdir(sharedRepoRoot);
  return sharedRepoRoot;
}

function persistCleanupBlocker(
  commonDir: string,
  config: WorkflowConfig,
  lock: TaskLock,
  taskBindingId: string,
  leaseToken: string,
  requestId: string,
  code: import('../state.ts').AutoCleanupBlockerCode,
  reason: string,
): void {
  compareAndSetTaskLockWithWorkspaceLease(commonDir, config, {
    taskSlug: lock.taskSlug,
    taskBindingId,
    leaseToken,
    expectedCleanupRequestId: requestId,
    update: (current) => ({
      ...current,
      cleanup: current.cleanup
        ? { ...current.cleanup, status: 'blocked', attemptedAt: nowIso(), blockerCode: code, blockerReason: reason }
        : current.cleanup,
      updatedAt: nowIso(),
    }),
  });
}

export function executeTaskWorkspaceCleanup(options: {
  commonDir: string;
  config: WorkflowConfig;
  sharedRepoRoot: string;
  callerCwd: string;
  lock: TaskLock;
  automatic: boolean;
  trigger: 'merge' | 'remote-base-reconcile' | 'manual';
  force?: boolean;
  allowIgnoredContent?: boolean;
  remoteEvidence?: RemoteBaseEvidence | null;
  workspaceLease?: TaskWorkspaceLease;
}): CleanupOutcome {
  const taskBindingId = options.lock.taskBindingId ?? '';
  if (!taskBindingId) {
    return { status: 'blocked', taskSlug: options.lock.taskSlug, code: 'state-conflict', reason: 'Task binding identity is missing.' };
  }
  if (options.automatic && options.lock.cleanup?.status === 'kept' && options.lock.cleanup.taskBindingId === taskBindingId) {
    return { status: 'kept', taskSlug: options.lock.taskSlug, reason: 'operator-requested' };
  }
  const acquired = options.workspaceLease
    ? { acquired: true as const, lease: options.workspaceLease }
    : acquireTaskWorkspaceLease(options.commonDir, options.config, {
        taskSlug: options.lock.taskSlug,
        taskBindingId,
        kind: 'cleanup',
        command: options.trigger === 'merge' ? 'merge-cleanup' : 'clean',
      });
  if (acquired.acquired === false) {
    return { status: 'blocked', taskSlug: options.lock.taskSlug, code: acquired.code, reason: acquired.reason };
  }
  const lease = acquired.lease;
  if (lease.taskSlug !== options.lock.taskSlug || lease.taskBindingId !== taskBindingId) {
    lease.release();
    return { status: 'blocked', taskSlug: options.lock.taskSlug, code: 'state-conflict', reason: 'Workspace lease identity does not match cleanup task.' };
  }
  let requestId = '';
  try {
    const current = loadTaskLock(options.commonDir, options.config, options.lock.taskSlug);
    if (!current || current.taskBindingId !== taskBindingId) {
      return { status: 'blocked', taskSlug: options.lock.taskSlug, code: 'state-conflict', reason: 'Task lock changed before cleanup acquired ownership.' };
    }
    const branchHeadSha = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', `refs/heads/${current.branchName}`], true)?.trim() ?? '';
    const remote = options.remoteEvidence === undefined
      ? refreshRemoteBaseEvidence(options.sharedRepoRoot, options.config, options.trigger === 'merge' ? 'merge-fetch' : 'reconcile-fetch')
      : options.remoteEvidence;
    const backfillError = backfillLegacyDeliveryForCleanup({
      commonDir: options.commonDir,
      config: options.config,
      sharedRepoRoot: options.sharedRepoRoot,
      lock: current,
      taskBindingId,
      branchHeadSha,
      remote,
    });
    if (backfillError) {
      return { status: 'blocked', taskSlug: current.taskSlug, code: 'state-conflict', reason: backfillError };
    }
    const proof = remote
      ? resolveCleanupProof(options.commonDir, options.config, options.sharedRepoRoot, current, taskBindingId, branchHeadSha, remote)
      : { proof: null, contained: false };
    requestId = current.cleanup?.taskBindingId === taskBindingId && current.cleanup.status !== 'kept'
      ? current.cleanup.requestId
      : `cleanup-${crypto.randomUUID()}`;
    const targetSha = proof.proof?.kind === 'merged-pr-head'
      ? proof.proof.mergedSha
      : proof.proof?.kind === 'remote-ancestor'
        ? proof.proof.branchHeadSha
        : branchHeadSha || remote?.sha || current.cleanup?.targetSha || '';
    const intent = compareAndSetTaskLockWithWorkspaceLease(options.commonDir, options.config, {
      taskSlug: current.taskSlug,
      taskBindingId,
      leaseToken: lease.token,
      update: (latest) => ({
        ...latest,
        cleanup: {
          status: 'pending',
          requestId,
          taskBindingId,
          trigger: options.trigger,
          requestedAt: latest.cleanup?.requestId === requestId ? latest.cleanup.requestedAt : nowIso(),
          targetRef: remote?.ref ?? latest.cleanup?.targetRef ?? `refs/heads/${latest.branchName}`,
          targetSha,
        },
        updatedAt: nowIso(),
      }),
    });
    if (intent.updated === false) {
      return { status: 'blocked', taskSlug: current.taskSlug, code: 'state-conflict', reason: `Could not persist cleanup intent (${intent.reason}).` };
    }

    if (!sharedCheckoutMatchesCommonDir(options.sharedRepoRoot, options.commonDir)) {
      const reason = 'The primary shared checkout could not be verified against this repository.';
      persistCleanupBlocker(options.commonDir, options.config, current, taskBindingId, lease.token, requestId, 'shared-checkout-unavailable', reason);
      return { status: 'blocked', taskSlug: current.taskSlug, code: 'shared-checkout-unavailable', reason };
    }

    if (options.force) {
      const artifacts = removeTaskArtifacts({
        sharedRepoRoot: options.sharedRepoRoot,
        worktreePath: current.worktreePath,
        branchName: current.branchName,
        callerCwd: options.callerCwd,
        force: true,
      });
      if (artifacts.errors.length > 0 || !artifacts.worktreeRemoved || !artifacts.branchRemoved) {
        const reason = artifacts.errors.join('; ') || 'Artifact removal did not complete.';
        persistCleanupBlocker(options.commonDir, options.config, current, taskBindingId, lease.token, requestId, 'artifact-removal-failed', reason);
        return { status: 'blocked', taskSlug: current.taskSlug, code: 'artifact-removal-failed', reason, worktreeRemoved: artifacts.worktreeRemoved, branchRemoved: artifacts.branchRemoved };
      }
      const removed = removeTaskLockWithWorkspaceLease(options.commonDir, options.config, {
        taskSlug: current.taskSlug,
        taskBindingId,
        leaseToken: lease.token,
        expectedCleanupRequestId: requestId,
      });
      if (!removed.removed) {
        return { status: 'blocked', taskSlug: current.taskSlug, code: 'state-conflict', reason: `Artifacts were removed but task-lock CAS failed (${removed.reason}).`, worktreeRemoved: true, branchRemoved: true };
      }
      cleanTaskBudgetArtifactsForTask(options.commonDir, options.config, {
        taskSlug: current.taskSlug,
        branchName: current.branchName,
      });
      return { status: 'cleaned', taskSlug: current.taskSlug, worktreeRemoved: true, branchRemoved: true, warnings: artifacts.warnings };
    }

    const worktreeExists = existsSync(current.worktreePath);
    const status = worktreeExists
      ? inspectCleanupStatus({
          worktreePath: current.worktreePath,
          sharedRepoRoot: options.sharedRepoRoot,
          disposableIgnoredPaths: options.config.cleanup?.disposableIgnoredPaths,
        })
      : { ok: true, trackedChanges: 0, untrackedEntries: [], ignoredEntries: [], protectedIgnoredEntries: [] };
    if (options.allowIgnoredContent) status.protectedIgnoredEntries = [];
    const observedBranchName = worktreeExists
      ? runGit(current.worktreePath, ['branch', '--show-current'], true)?.trim() ?? ''
      : '';
    const assessment = assessTaskCleanup({
      automatic: options.automatic,
      automaticEnabled: automaticWorktreeCleanupEnabled(options.config),
      lock: intent.lock,
      taskBindingId,
      sharedRepoRoot: options.sharedRepoRoot,
      callerCwd: options.callerCwd,
      worktreeExists,
      observedBranchName,
      branchHeadSha,
      branchExists: Boolean(branchHeadSha),
      status,
      proof: proof.proof,
      proofContained: proof.contained,
      evidence: remote?.revision ?? null,
    });
    if (assessment.status === 'kept') return assessment;
    if (assessment.status === 'blocked') {
      persistCleanupBlocker(options.commonDir, options.config, current, taskBindingId, lease.token, requestId, assessment.code, assessment.reason);
      return assessment;
    }

    const artifacts = removeTaskArtifacts({
      sharedRepoRoot: options.sharedRepoRoot,
      worktreePath: current.worktreePath,
      branchName: current.branchName,
      callerCwd: options.callerCwd,
      force: false,
      expectedBranchHeadSha: assessment.expectedBranchHeadSha,
      branchDeletionAuthorized: true,
      disposableIgnoredPaths: options.config.cleanup?.disposableIgnoredPaths,
      requireNoIgnoredContent: !options.allowIgnoredContent,
    });
    if (artifacts.errors.length > 0 || !artifacts.worktreeRemoved || !artifacts.branchRemoved) {
      const reason = artifacts.errors.join('; ') || 'Artifact removal did not complete.';
      persistCleanupBlocker(options.commonDir, options.config, current, taskBindingId, lease.token, requestId, 'artifact-removal-failed', reason);
      return { status: 'blocked', taskSlug: current.taskSlug, code: 'artifact-removal-failed', reason, worktreeRemoved: artifacts.worktreeRemoved, branchRemoved: artifacts.branchRemoved };
    }
    const removed = removeTaskLockWithWorkspaceLease(options.commonDir, options.config, {
      taskSlug: current.taskSlug,
      taskBindingId,
      leaseToken: lease.token,
      expectedCleanupRequestId: requestId,
    });
    if (!removed.removed) {
      return { status: 'blocked', taskSlug: current.taskSlug, code: 'state-conflict', reason: `Artifacts were removed but task-lock CAS failed (${removed.reason}).`, worktreeRemoved: true, branchRemoved: true };
    }
    cleanTaskBudgetArtifactsForTask(options.commonDir, options.config, {
      taskSlug: current.taskSlug,
      branchName: current.branchName,
    });
    return { status: 'cleaned', taskSlug: current.taskSlug, worktreeRemoved: true, branchRemoved: true, warnings: artifacts.warnings };
  } finally {
    lease.release();
  }
}

async function handleApplyDelivered(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const result = reconcileDeliveredTaskWorkspaces({
    commonDir,
    config,
    sharedRepoRoot,
    callerCwd: cwd,
    automatic: false,
    minAgeMs: 0,
  });
  const { closed, skipped } = result;
  const lines = closed.length > 0
    ? [`Closed ${closed.length} delivered task workspace${closed.length === 1 ? '' : 's'}:`, ...closed.map((entry) => `- ${entry.taskSlug}`)]
    : ['No delivered task workspaces were closed.'];
  if (skipped.length > 0) {
    lines.push('Kept:');
    lines.push(...skipped.map((entry) => `- ${entry.taskSlug}: ${entry.status === 'cleaned' ? 'already cleaned' : entry.reason}`));
  }
  printResult(parsed.flags, { closed: closed.map((entry) => entry.taskSlug), skipped, artifacts: closed, message: lines.join('\n') });
}

export function reconcileDeliveredTaskWorkspaces(options: {
  commonDir: string;
  config: WorkflowConfig;
  sharedRepoRoot: string;
  callerCwd: string;
  automatic: boolean;
  taskSlugs?: string[];
  minAgeMs?: number;
  allowIgnoredContent?: boolean;
}): { closed: CleanupOutcome[]; skipped: CleanupOutcome[]; remoteAvailable: boolean } {
  if (options.automatic && !automaticWorktreeCleanupEnabled(options.config)) {
    const requested = options.taskSlugs ? new Set(options.taskSlugs) : null;
    const skipped: CleanupOutcome[] = requested
      ? listActiveTaskLocks(options.commonDir, options.config)
        .filter((lock) => requested.has(lock.taskSlug))
        .map((lock) => ({ status: 'kept', taskSlug: lock.taskSlug, reason: 'automatic-cleanup-disabled' }))
      : [];
    return { closed: [], skipped, remoteAvailable: false };
  }
  const remote = refreshRemoteBaseEvidence(options.sharedRepoRoot, options.config, 'reconcile-fetch');
  const requested = options.taskSlugs ? new Set(options.taskSlugs) : null;
  const closed: CleanupOutcome[] = [];
  const skipped: CleanupOutcome[] = [];
  for (const observed of listActiveTaskLocks(options.commonDir, options.config)) {
    if (requested && !requested.has(observed.taskSlug)) continue;
    const lock = observed.taskBindingId ? observed : ensureTaskBindingId(options.commonDir, options.config, observed.taskSlug);
    if (!lock?.taskBindingId) continue;
    if (lock.cleanup?.status === 'kept') {
      skipped.push({ status: 'kept', taskSlug: lock.taskSlug, reason: 'operator-requested' });
      continue;
    }
    if (!isDeliveredReconciliationCandidate(options.commonDir, options.config, options.sharedRepoRoot, lock, remote) && !requested) {
      continue;
    }
    const age = lockAgeMs(lock.updatedAt, Date.now());
    const minAge = options.minAgeMs ?? readMinAgeOverride() ?? TASK_LOCK_MIN_PRUNE_AGE_MS;
    if (age === null || age < minAge) {
      skipped.push({ status: 'blocked', taskSlug: lock.taskSlug, code: age === null ? 'unparseable-updated-at' : 'lock-too-young', reason: age === null ? 'Task updatedAt is missing or invalid.' : `Task is below the ${Math.round(minAge / 1000)}s reconciliation floor.` });
      continue;
    }
    const result = executeTaskWorkspaceCleanup({
      commonDir: options.commonDir,
      config: options.config,
      sharedRepoRoot: options.sharedRepoRoot,
      callerCwd: options.callerCwd,
      lock,
      automatic: options.automatic,
      trigger: 'remote-base-reconcile',
      remoteEvidence: remote,
      allowIgnoredContent: options.allowIgnoredContent,
    });
    (result.status === 'cleaned' ? closed : skipped).push(result);
  }
  return { closed, skipped, remoteAvailable: remote !== null };
}

function isDeliveredReconciliationCandidate(
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
  lock: TaskLock,
  remote: RemoteBaseEvidence | null,
): boolean {
  if (lock.cleanup) return true;
  if (!remote || !lock.taskBindingId) return false;
  const branchHeadSha = runGit(sharedRepoRoot, ['rev-parse', '--verify', `refs/heads/${lock.branchName}`], true)?.trim() ?? '';
  if (findDeliveriesByTask(commonDir, config, lock.taskSlug, lock.taskBindingId).some((delivery) =>
    delivery.branchName === lock.branchName
    && delivery.prHeadSha === branchHeadSha
    && gitObjectIsAncestor(sharedRepoRoot, delivery.mergedSha, remote.sha)
  )) return true;
  const legacy = loadPrState(commonDir, config).records[lock.taskSlug];
  return Boolean(
    legacy?.number
    && prRecordMatchesTaskLock(legacy, lock)
    && legacy.mergedSha
    && gitObjectIsAncestor(sharedRepoRoot, legacy.mergedSha, remote.sha),
  );
}

async function handleApplyCompletedWithIgnored(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const remote = refreshRemoteBaseEvidence(sharedRepoRoot, config, 'reconcile-fetch');
  const closed: CleanupOutcome[] = [];
  const skipped: CleanupOutcome[] = [];
  for (const observed of listActiveTaskLocks(commonDir, config)) {
    const lock = observed.taskBindingId ? observed : ensureTaskBindingId(commonDir, config, observed.taskSlug);
    if (!lock?.taskBindingId) continue;
    if (lock.cleanup?.status === 'kept') {
      skipped.push({ status: 'kept', taskSlug: lock.taskSlug, reason: 'operator-requested' });
      continue;
    }
    if (!isDeliveredReconciliationCandidate(commonDir, config, sharedRepoRoot, lock, remote)) {
      continue;
    }
    const result = executeTaskWorkspaceCleanup({
      commonDir,
      config,
      sharedRepoRoot,
      callerCwd: cwd,
      lock,
      automatic: false,
      trigger: 'manual',
      allowIgnoredContent: true,
      remoteEvidence: remote,
    });
    (result.status === 'cleaned' ? closed : skipped).push(result);
  }

  const lines: string[] = [];
  if (closed.length === 0) {
    lines.push('No delivered task workspaces were eligible for cleanup with ignored content.');
  } else {
    lines.push(`Closed out ${closed.length} delivered task workspace${closed.length === 1 ? '' : 's'} (allowing ignored build output):`);
    for (const entry of closed) {
      lines.push(`- ${entry.taskSlug}: removed worktree + branch + task lock`);
    }
  }
  if (skipped.length > 0) {
    lines.push('Kept for manual review:');
    for (const entry of skipped) {
      lines.push(`- ${entry.taskSlug}: ${entry.status === 'cleaned' ? 'already cleaned' : entry.reason}`);
    }
  }

  printResult(parsed.flags, {
    closed: closed.map((entry) => entry.taskSlug),
    skipped,
    artifacts: closed,
    message: lines.join('\n'),
  });
}

async function handleApplySafeOrphans(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const orphans = listOrphanWorktrees(commonDir, config);
  const investigated = investigateOrphans(orphans, sharedRepoRoot, { skipPrLookup: true });
  const candidates = investigated.orphans.filter((entry) => entry.classification.treeState === 'clean');

  const removedSummaries: Array<{
    path: string;
    branchName: string | null;
    worktreeRemoved: boolean;
    branchRemoved: boolean;
    warnings: string[];
    errors: string[];
  }> = [];

  for (const candidate of candidates) {
    // Per-orphan cleanup lock: prevents two concurrent /clean --apply
    // --safe-orphans runs from racing on the same `git worktree remove`.
    // Loser of the race surfaces a clean "busy" message instead of a
    // confusing git error.
    const lock = acquireOrphanCleanupLock(commonDir, config, candidate.orphan.path);
    if (lock.acquired === false) {
      removedSummaries.push({
        path: candidate.orphan.path,
        branchName: candidate.orphan.branchName,
        worktreeRemoved: false,
        branchRemoved: false,
        warnings: [],
        errors: [`skipped: ${lock.reason}`],
      });
      continue;
    }
    try {
      const result = removeOrphanWorktree({
        sharedRepoRoot,
        worktreePath: candidate.orphan.path,
        branchName: candidate.orphan.branchName,
        callerCwd: cwd,
        force: false,
      });
      removedSummaries.push({
        path: candidate.orphan.path,
        branchName: candidate.orphan.branchName,
        worktreeRemoved: result.worktreeRemoved,
        branchRemoved: result.branchRemoved,
        warnings: result.warnings,
        errors: result.errors,
      });
    } finally {
      lock.release();
    }
  }

  const lines: string[] = [];
  if (candidates.length === 0) {
    lines.push('No orphan worktrees with clean trees to remove.');
  } else {
    const fullySucceeded = removedSummaries.filter((entry) => entry.errors.length === 0 && entry.worktreeRemoved && entry.branchRemoved);
    lines.push(`Removed ${fullySucceeded.length} of ${candidates.length} clean orphan worktree${candidates.length === 1 ? '' : 's'}:`);
    for (const entry of removedSummaries) {
      const parts = [];
      if (entry.worktreeRemoved) parts.push('worktree');
      if (entry.branchRemoved && entry.branchName) parts.push('branch');
      const status = entry.errors.length === 0 ? `removed ${parts.join(' + ') || '(none)'}` : 'skipped';
      lines.push(`- ${entry.path}: ${status}`);
      for (const warning of entry.warnings) lines.push(`  note: ${warning}`);
      for (const error of entry.errors) lines.push(`  ! ${error}`);
    }
  }

  printResult(parsed.flags, {
    removed: removedSummaries.filter((entry) => entry.errors.length === 0).map((entry) => entry.path),
    artifacts: removedSummaries,
    message: lines.join('\n'),
  });
}

async function handleApplyMergedOrphans(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const orphans = listOrphanWorktrees(commonDir, config);
  const investigated = investigateOrphans(orphans, sharedRepoRoot, { skipPrLookup: false });
  const candidates = investigated.orphans.filter((entry) => entry.mergedPr !== null);

  const removedSummaries: Array<{
    path: string;
    branchName: string | null;
    prNumber: number | null;
    worktreeRemoved: boolean;
    branchRemoved: boolean;
    warnings: string[];
    errors: string[];
  }> = [];

  for (const candidate of candidates) {
    // Per-orphan cleanup lock: prevents two concurrent /clean --apply
    // --merged-orphans runs from racing on the same `git worktree remove`.
    const lock = acquireOrphanCleanupLock(commonDir, config, candidate.orphan.path);
    if (lock.acquired === false) {
      removedSummaries.push({
        path: candidate.orphan.path,
        branchName: candidate.orphan.branchName,
        prNumber: candidate.mergedPr?.number ?? null,
        worktreeRemoved: false,
        branchRemoved: false,
        warnings: [],
        errors: [`skipped: ${lock.reason}`],
      });
      continue;
    }
    try {
      // Force-remove: the branch's PR is merged on main, so any tracked changes
      // here are stale follow-ups. The worktree's tree differs from the
      // squash-merge SHA, so safeDeleteBranchRef won't recognize it; --force
      // is the correct escape.
      const result = removeOrphanWorktree({
        sharedRepoRoot,
        worktreePath: candidate.orphan.path,
        branchName: candidate.orphan.branchName,
        callerCwd: cwd,
        force: true,
      });
      removedSummaries.push({
        path: candidate.orphan.path,
        branchName: candidate.orphan.branchName,
        prNumber: candidate.mergedPr?.number ?? null,
        worktreeRemoved: result.worktreeRemoved,
        branchRemoved: result.branchRemoved,
        warnings: result.warnings,
        errors: result.errors,
      });
    } finally {
      lock.release();
    }
  }

  const lines: string[] = [];
  if (!investigated.prLookupAvailable) {
    lines.push('PR-merge lookup unavailable (gh CLI missing or failed). No merged orphans removed.');
    for (const warning of investigated.warnings) {
      lines.push(`  note: ${warning}`);
    }
  } else if (candidates.length === 0) {
    lines.push('No orphan worktrees with merged PRs to remove.');
  } else {
    const fullySucceeded = removedSummaries.filter((entry) => entry.errors.length === 0 && entry.worktreeRemoved && entry.branchRemoved);
    lines.push(`Force-removed ${fullySucceeded.length} of ${candidates.length} orphan worktree${candidates.length === 1 ? '' : 's'} with merged PRs:`);
    for (const entry of removedSummaries) {
      const prTag = entry.prNumber !== null ? ` (PR #${entry.prNumber})` : '';
      const parts = [];
      if (entry.worktreeRemoved) parts.push('worktree');
      if (entry.branchRemoved && entry.branchName) parts.push('branch');
      const status = entry.errors.length === 0 ? `removed ${parts.join(' + ') || '(none)'}` : 'skipped';
      lines.push(`- ${entry.path}${prTag}: ${status}`);
      for (const warning of entry.warnings) lines.push(`  note: ${warning}`);
      for (const error of entry.errors) lines.push(`  ! ${error}`);
    }
  }

  printResult(parsed.flags, {
    removed: removedSummaries.filter((entry) => entry.errors.length === 0).map((entry) => entry.path),
    artifacts: removedSummaries,
    prLookupAvailable: investigated.prLookupAvailable,
    warnings: investigated.warnings,
    message: lines.join('\n'),
  });
}

// -----------------------------------------------------------------------------
// Status (no --apply)
// -----------------------------------------------------------------------------

async function handleStatus(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const autoCleanup = closeSafeCompletedTaskWorkspaces({
    commonDir,
    config,
    sharedRepoRoot,
    callerCwd: cwd,
    minAgeMs: readMinAgeOverride(),
    // Bare /clean and --status-only are both previews. No task lifecycle state
    // or artifacts change without the explicit --apply boundary.
    dryRun: true,
  });
  const activeLocks = listActiveTaskLocks(commonDir, config);
  const orphans = listOrphanWorktrees(commonDir, config);
  const investigated = investigateOrphans(orphans, sharedRepoRoot, { skipPrLookup: false });

  const ignoredOnlySkips = autoCleanup.skipped.filter((entry) => entry.code === 'ignored-content');
  const cleanOrphans = investigated.orphans.filter((entry) => entry.classification.treeState === 'clean');
  const mergedDirtyOrphans = investigated.orphans.filter(
    (entry) => entry.mergedPr !== null && entry.classification.treeState !== 'clean',
  );
  // Anything left over: not clean, no merged PR. Could be in-progress
  // work an external agent is editing, abandoned dirty branches, or
  // build output without an upstream PR. The action menu calls these out
  // as needing manual inspection rather than offering a bulk delete.
  const suspiciousOrphans = investigated.orphans.filter(
    (entry) => entry.classification.treeState !== 'clean' && entry.mergedPr === null,
  );

  const lines: string[] = [];
  if (autoCleanup.closed.length > 0) {
    lines.push('Would close safe completed task workspaces:');
    for (const result of autoCleanup.closed) {
      lines.push(`- ${result.taskSlug}: would remove lock + worktree + branch`);
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
    for (const entry of investigated.orphans) {
      lines.push(formatOrphanLine(entry));
    }
  }
  for (const warning of investigated.warnings) {
    lines.push(`note: ${warning}`);
  }

  const menu = buildActionMenu({
    ignoredOnlyCandidates: ignoredOnlySkips,
    cleanOrphans,
    mergedDirtyOrphans,
    suspiciousOrphans,
    cleanCommandPrefix: formatWorkflowCommand(config, 'clean'),
    prLookupAvailable: investigated.prLookupAvailable,
  });
  if (menu.lines.length > 0) {
    lines.push('');
    lines.push(...menu.lines);
  } else {
    // No actionable categories — keep the user oriented with the flag list
    // so they can still drive the rare cases (--task <slug>, --all-stale).
    lines.push(`${formatWorkflowCommand(config, 'clean')} previews delivered task workspaces that pass the cleanup safety checks.`);
    lines.push(`Run ${formatWorkflowCommand(config, 'clean')} --status-only to preview cleanup without removing anything,`);
    lines.push(`Run ${formatWorkflowCommand(config, 'clean')} --apply --all-stale to prune every stale task lock,`);
    lines.push(`or ${formatWorkflowCommand(config, 'clean')} --apply --task <slug> to close out one task explicitly.`);
  }

  printResult(parsed.flags, {
    autoCleaned: [],
    autoCleanCandidates: autoCleanup.closed.map((entry) => entry.taskSlug),
    autoCleanSkipped: autoCleanup.skipped,
    artifacts: autoCleanup.closed,
    activeLocks: activeLocks.map((lock) => ({
      taskSlug: lock.taskSlug,
      taskName: lock.taskName ?? null,
      branchName: lock.branchName,
      worktreePath: lock.worktreePath,
    })),
    orphanWorktrees: investigated.orphans.map((entry) => ({
      path: entry.orphan.path,
      branchName: entry.orphan.branchName,
      isDetached: entry.orphan.isDetached,
      source: entry.orphan.source,
      classification: entry.classification,
      mergedPr: entry.mergedPr,
    })),
    suggestedActions: menu.items,
    prLookupAvailable: investigated.prLookupAvailable,
    prLookupWarnings: investigated.warnings,
    message: lines.join('\n'),
  });
}

// -----------------------------------------------------------------------------
// Action menu
// -----------------------------------------------------------------------------

interface ActionMenuItem {
  label: string;
  command: string;
  count: number;
}

function buildActionMenu(state: {
  ignoredOnlyCandidates: AutoCleanupSkip[];
  cleanOrphans: OrphanWithMetadata[];
  mergedDirtyOrphans: OrphanWithMetadata[];
  suspiciousOrphans: OrphanWithMetadata[];
  cleanCommandPrefix: string;
  prLookupAvailable: boolean;
}): { lines: string[]; items: ActionMenuItem[] } {
  const items: ActionMenuItem[] = [];
  if (state.cleanOrphans.length > 0) {
    items.push({
      label: `Remove ${state.cleanOrphans.length} orphan worktree${pluralize(state.cleanOrphans.length)} with clean trees (no uncommitted work)`,
      command: `${state.cleanCommandPrefix} --apply --safe-orphans`,
      count: state.cleanOrphans.length,
    });
  }
  if (state.mergedDirtyOrphans.length > 0) {
    items.push({
      label: `Remove ${state.mergedDirtyOrphans.length} orphan worktree${pluralize(state.mergedDirtyOrphans.length)} whose branches have merged PRs (work is on main; remaining changes are stale follow-ups)`,
      command: `${state.cleanCommandPrefix} --apply --merged-orphans`,
      count: state.mergedDirtyOrphans.length,
    });
  }
  if (state.ignoredOnlyCandidates.length > 0) {
    items.push({
      label: `Close out ${state.ignoredOnlyCandidates.length} delivered task workspace${pluralize(state.ignoredOnlyCandidates.length)} blocked only on ignored build output`,
      command: `${state.cleanCommandPrefix} --apply --completed-with-ignored`,
      count: state.ignoredOnlyCandidates.length,
    });
  }

  if (items.length === 0 && state.suspiciousOrphans.length === 0) {
    return { lines: [], items: [] };
  }

  const lines: string[] = [];
  if (items.length > 0) {
    lines.push('Suggested actions:');
    items.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.label}`);
      lines.push(`     ${item.command}`);
    });
  }
  if (state.suspiciousOrphans.length > 0) {
    if (items.length > 0) lines.push('');
    const tail = state.prLookupAvailable ? ' and no merged PR' : '';
    lines.push(`Inspect manually: ${state.suspiciousOrphans.length} orphan worktree${pluralize(state.suspiciousOrphans.length)} with uncommitted source changes${tail}:`);
    for (const entry of state.suspiciousOrphans.slice(0, 10)) {
      const branchTag = entry.orphan.branchName ?? '(detached)';
      lines.push(`  - ${entry.orphan.path}  [${entry.classification.trackedChanges} tracked, branch: ${branchTag}]`);
    }
    if (state.suspiciousOrphans.length > 10) {
      lines.push(`  + ${state.suspiciousOrphans.length - 10} more…`);
    }
  }

  return { lines, items };
}

function pluralize(count: number): string {
  return count === 1 ? '' : 's';
}

// -----------------------------------------------------------------------------
// Orphan investigation
// -----------------------------------------------------------------------------

interface MergedPrInfo {
  number: number;
  mergedAt: string;
  title: string;
}

interface OrphanWithMetadata {
  orphan: OrphanWorktree;
  classification: OrphanClassification;
  mergedPr: MergedPrInfo | null;
}

interface InvestigationResult {
  orphans: OrphanWithMetadata[];
  warnings: string[];
  prLookupAvailable: boolean;
}

function investigateOrphans(
  orphans: OrphanWorktree[],
  sharedRepoRoot: string,
  options: { skipPrLookup: boolean },
): InvestigationResult {
  if (orphans.length === 0) {
    return { orphans: [], warnings: [], prLookupAvailable: !options.skipPrLookup };
  }
  const branchNames = orphans
    .map((o) => o.branchName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  const lookup = options.skipPrLookup
    ? { byBranch: new Map<string, MergedPrInfo>(), warnings: [] as string[], available: false }
    : lookupMergedPrsByBranch(sharedRepoRoot, branchNames);

  const enriched: OrphanWithMetadata[] = orphans.map((orphan) => ({
    orphan,
    classification: classifyOrphan(orphan.path),
    mergedPr: orphan.branchName ? lookup.byBranch.get(orphan.branchName) ?? null : null,
  }));
  return { orphans: enriched, warnings: lookup.warnings, prLookupAvailable: lookup.available };
}

interface MergedPrLookup {
  byBranch: Map<string, MergedPrInfo>;
  warnings: string[];
  available: boolean;
}

function lookupMergedPrsByBranch(repoRoot: string, branchNames: string[]): MergedPrLookup {
  if (branchNames.length === 0) {
    return { byBranch: new Map(), warnings: [], available: true };
  }
  // Test hook: gated to NODE_ENV==='test' so a stray env var in a shared
  // production shell can't quietly disable the merge-status check.
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_CLEAN_SKIP_PR_LOOKUP === '1') {
    return { byBranch: new Map(), warnings: [], available: false };
  }
  // Cheap probe — `gh --version` exits 0 when installed and on PATH.
  // Any non-zero exit (ENOENT, install error) means we can't drive gh.
  const probe = runCommandCapture('gh', ['--version'], { cwd: repoRoot });
  if (!probe.ok) {
    return {
      byBranch: new Map(),
      warnings: ['gh CLI not available; PR-merge classification skipped (install gh and `gh auth login` to enable).'],
      available: false,
    };
  }
  // Single batched query — cap at 500 so the call stays fast even on
  // long-history repos. Truncation hint emitted below if any of our
  // branches isn't in the result.
  const result = runCommandCapture(
    'gh',
    ['pr', 'list', '--state', 'merged', '--limit', '500', '--json', 'number,headRefName,mergedAt,title'],
    { cwd: repoRoot, timeoutMs: 30_000 },
  );
  if (!result.ok) {
    const message = (result.stderr || result.stdout || 'unknown error').trim().split('\n')[0];
    return {
      byBranch: new Map(),
      warnings: [`gh pr list failed: ${message}`],
      available: false,
    };
  }
  let parsed: Array<{ number: number; headRefName: string; mergedAt: string; title: string }>;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      byBranch: new Map(),
      warnings: ['gh pr list returned malformed JSON; PR-merge classification skipped.'],
      available: false,
    };
  }
  const byBranch = new Map<string, MergedPrInfo>();
  for (const entry of parsed) {
    if (!entry || typeof entry.headRefName !== 'string' || entry.headRefName.length === 0) continue;
    if (byBranch.has(entry.headRefName)) continue;
    byBranch.set(entry.headRefName, {
      number: typeof entry.number === 'number' ? entry.number : 0,
      mergedAt: typeof entry.mergedAt === 'string' ? entry.mergedAt : '',
      title: typeof entry.title === 'string' ? entry.title : '',
    });
  }
  const warnings: string[] = [];
  if (parsed.length >= 500) {
    // Batch hit the cap. Fall back to per-branch search for branches that
    // weren't matched in the batch, capped at PER_BRANCH_FALLBACK_CAP queries
    // to bound latency (~1s each on a healthy gh setup). Without this,
    // long-history repos silently misclassify merged orphans as suspicious.
    const PER_BRANCH_FALLBACK_CAP = 30;
    const missing = branchNames.filter((name) => !byBranch.has(name));
    const lookupTargets = missing.slice(0, PER_BRANCH_FALLBACK_CAP);
    let recovered = 0;
    for (const name of lookupTargets) {
      const single = lookupSingleBranchMergedPr(repoRoot, name);
      if (single) {
        byBranch.set(name, single);
        recovered += 1;
      }
    }
    const stillMissingAfterFallback = missing.length - recovered;
    if (missing.length > PER_BRANCH_FALLBACK_CAP) {
      warnings.push(
        `gh pr list capped at 500 merged PRs and ${missing.length} branches needed fallback (only ${PER_BRANCH_FALLBACK_CAP} checked individually); some older orphans may still be misclassified.`,
      );
    } else if (stillMissingAfterFallback > 0 && recovered > 0) {
      // Partial recovery — surface the assist so operators understand the
      // count when comparing /clean output across runs.
      warnings.push(
        `gh pr list batch was capped; recovered ${recovered} of ${missing.length} missing branches via per-branch fallback.`,
      );
    }
  }
  return { byBranch, warnings, available: true };
}

function lookupSingleBranchMergedPr(repoRoot: string, branchName: string): MergedPrInfo | null {
  const result = runCommandCapture(
    'gh',
    ['pr', 'list', '--state', 'merged', '--head', branchName, '--limit', '1', '--json', 'number,headRefName,mergedAt,title'],
    { cwd: repoRoot, timeoutMs: 15_000 },
  );
  if (!result.ok) return null;
  let parsed: Array<{ number: number; headRefName: string; mergedAt: string; title: string }>;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const entry = parsed[0];
  if (!entry || typeof entry.headRefName !== 'string' || entry.headRefName !== branchName) return null;
  return {
    number: typeof entry.number === 'number' ? entry.number : 0,
    mergedAt: typeof entry.mergedAt === 'string' ? entry.mergedAt : '',
    title: typeof entry.title === 'string' ? entry.title : '',
  };
}

// -----------------------------------------------------------------------------
// Auto-cleanup helpers
// -----------------------------------------------------------------------------

export interface ArtifactRemovalSummary {
  taskSlug: string;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  warnings: string[];
  errors: string[];
}

export type AutoCleanupBlockerCode = import('../state.ts').AutoCleanupBlockerCode;

export interface AutoCleanupSkip {
  taskSlug: string;
  reason: string;
  // Structured blocker code — drives the action-menu categorization. The
  // 'ignored-content' code is what `/clean --apply --completed-with-ignored`
  // targets: Pipelane already proved remote delivery, and the only thing left is
  // the operator's call on whether dist/build output should be discarded.
  code: AutoCleanupBlockerCode;
}

export function closeSafeCompletedTaskWorkspaces(options: {
  commonDir: string;
  config: WorkflowConfig;
  sharedRepoRoot: string;
  callerCwd: string;
  taskSlugs?: string[];
  minAgeMs?: number;
  dryRun?: boolean;
  // When true, the "ignored content" blocker is ignored — the rest of the
  // safety chain still has to pass. Used by --completed-with-ignored.
  allowIgnoredContent?: boolean;
}): { closed: ArtifactRemovalSummary[]; skipped: AutoCleanupSkip[] } {
  const requestedTaskSlugs = options.taskSlugs
    ? [...new Set(options.taskSlugs.map((slug) => slug.trim()).filter(Boolean))]
    : null;
  if (options.dryRun) {
    return previewDeliveredTaskWorkspaces({ ...options, taskSlugs: requestedTaskSlugs ?? undefined });
  }
  const result = reconcileDeliveredTaskWorkspaces({
    commonDir: options.commonDir,
    config: options.config,
    sharedRepoRoot: options.sharedRepoRoot,
    callerCwd: options.callerCwd,
    automatic: true,
    taskSlugs: requestedTaskSlugs ?? undefined,
    minAgeMs: options.minAgeMs,
    allowIgnoredContent: options.allowIgnoredContent,
  });
  const closed = result.closed.flatMap<ArtifactRemovalSummary>((entry) => entry.status === 'cleaned'
    ? [{
        taskSlug: entry.taskSlug,
        worktreeRemoved: entry.worktreeRemoved,
        branchRemoved: entry.branchRemoved,
        warnings: entry.warnings,
        errors: [],
      }]
    : []);
  const skipped = result.skipped.flatMap<AutoCleanupSkip>((entry) => entry.status === 'blocked'
    ? [{ taskSlug: entry.taskSlug, reason: entry.reason, code: entry.code }]
    : entry.status === 'kept'
      ? [{
          taskSlug: entry.taskSlug,
          reason: entry.reason === 'operator-requested' ? 'workspace retained by --keep-worktree' : 'automatic cleanup is disabled',
          code: entry.reason === 'operator-requested' ? 'state-conflict' : 'automatic-cleanup-disabled',
        }]
      : []);
  if (requestedTaskSlugs) {
    const observed = new Set([...closed, ...skipped].map((entry) => entry.taskSlug));
    for (const taskSlug of requestedTaskSlugs) {
      if (!observed.has(taskSlug) && !loadTaskLock(options.commonDir, options.config, taskSlug)) {
        skipped.push({ taskSlug, reason: 'no active task lock found; task may already be cleaned', code: 'lock-missing' });
      }
    }
  }
  return { closed, skipped };
}

function previewDeliveredTaskWorkspaces(options: {
  commonDir: string;
  config: WorkflowConfig;
  sharedRepoRoot: string;
  callerCwd: string;
  taskSlugs?: string[];
  minAgeMs?: number;
  allowIgnoredContent?: boolean;
}): { closed: ArtifactRemovalSummary[]; skipped: AutoCleanupSkip[] } {
  const localRemoteRef = `origin/${options.config.baseBranch}`;
  const localRemoteSha = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', localRemoteRef], true)?.trim() ?? '';
  const remote: RemoteBaseEvidence | null = localRemoteSha
    ? {
        ref: localRemoteRef,
        sha: localRemoteSha,
        revision: { remoteBaseSha: localRemoteSha, observedAt: nowIso(), source: 'snapshot-local' },
      }
    : null;
  const requested = options.taskSlugs ? new Set(options.taskSlugs) : null;
  const observed = new Set<string>();
  const closed: ArtifactRemovalSummary[] = [];
  const skipped: AutoCleanupSkip[] = [];
  const minAge = options.minAgeMs ?? readMinAgeOverride() ?? TASK_LOCK_MIN_PRUNE_AGE_MS;
  for (const lock of listActiveTaskLocks(options.commonDir, options.config)) {
    if (requested && !requested.has(lock.taskSlug)) continue;
    observed.add(lock.taskSlug);
    if (!lock.taskBindingId) {
      skipped.push({ taskSlug: lock.taskSlug, code: 'state-conflict', reason: 'Task binding identity is missing.' });
      continue;
    }
    if (!isDeliveredReconciliationCandidate(options.commonDir, options.config, options.sharedRepoRoot, lock, remote)) continue;
    const age = lockAgeMs(lock.updatedAt, Date.now());
    if (age === null || age < minAge) {
      skipped.push({
        taskSlug: lock.taskSlug,
        code: age === null ? 'unparseable-updated-at' : 'lock-too-young',
        reason: age === null ? 'Task updatedAt is missing or invalid.' : `Task is below the ${Math.round(minAge / 1000)}s reconciliation floor.`,
      });
      continue;
    }
    const branchHeadSha = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', `refs/heads/${lock.branchName}`], true)?.trim() ?? '';
    const proof = remote
      ? resolveCleanupProof(options.commonDir, options.config, options.sharedRepoRoot, lock, lock.taskBindingId, branchHeadSha, remote)
      : { proof: null, contained: false };
    const worktreeExists = existsSync(lock.worktreePath);
    const status = worktreeExists
      ? inspectCleanupStatus({
          worktreePath: lock.worktreePath,
          sharedRepoRoot: options.sharedRepoRoot,
          disposableIgnoredPaths: options.config.cleanup?.disposableIgnoredPaths,
        })
      : { ok: true, trackedChanges: 0, untrackedEntries: [], ignoredEntries: [], protectedIgnoredEntries: [] };
    if (options.allowIgnoredContent) status.protectedIgnoredEntries = [];
    const assessment = assessTaskCleanup({
      automatic: true,
      automaticEnabled: automaticWorktreeCleanupEnabled(options.config),
      lock,
      taskBindingId: lock.taskBindingId,
      sharedRepoRoot: options.sharedRepoRoot,
      callerCwd: options.callerCwd,
      worktreeExists,
      observedBranchName: worktreeExists ? runGit(lock.worktreePath, ['branch', '--show-current'], true)?.trim() ?? '' : '',
      branchHeadSha,
      branchExists: Boolean(branchHeadSha),
      status,
      proof: proof.proof,
      proofContained: proof.contained,
      evidence: remote?.revision ?? null,
    });
    if (assessment.status === 'eligible') {
      closed.push({ taskSlug: lock.taskSlug, worktreeRemoved: false, branchRemoved: false, warnings: [], errors: [] });
    } else if (assessment.status === 'blocked') {
      skipped.push({ taskSlug: lock.taskSlug, code: assessment.code, reason: assessment.reason });
    } else {
      skipped.push({
        taskSlug: lock.taskSlug,
        code: assessment.reason === 'automatic-cleanup-disabled' ? 'automatic-cleanup-disabled' : 'state-conflict',
        reason: assessment.reason === 'automatic-cleanup-disabled' ? 'automatic cleanup is disabled' : 'workspace retained by --keep-worktree',
      });
    }
  }
  for (const taskSlug of requested ?? []) {
    if (!observed.has(taskSlug)) skipped.push({ taskSlug, code: 'lock-missing', reason: 'no active task lock found; task may already be cleaned' });
  }
  return { closed, skipped };
}

function lockAgeMs(updatedAt: string | undefined, now: number): number | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

function formatOrphanLine(entry: OrphanWithMetadata): string {
  const sourceTag = entry.orphan.source === 'pipelane-managed' ? 'pipelane-managed' : 'external';
  const branchTag = entry.orphan.isDetached ? 'detached HEAD' : entry.orphan.branchName ?? '(no branch)';
  const treeTag = entry.classification.treeState;
  const prTag = entry.mergedPr ? `, PR #${entry.mergedPr.number} merged` : '';
  return `- ${entry.orphan.path}  [${sourceTag}, ${branchTag}, ${treeTag}${prTag}]`;
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
