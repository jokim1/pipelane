import crypto from 'node:crypto';

import {
  ensureTaskBindingId,
  acquireTaskWorkspaceLease,
  borrowDelegatedTaskWorkspaceLeaseFromEnvironment,
  automaticWorktreeCleanupEnabled,
  compareAndSetTaskLockWithWorkspaceLease,
  finalizeDeliveryIntent,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadDeliveryIntentByPr,
  loadPrRecord,
  loadTaskLock,
  normalizeExistingPath,
  nowIso,
  printResult,
  resolveWorkflowContext,
  runCommandCapture,
  runGh,
  runGit,
  saveDeliveryIntent,
  slugifyTaskName,
  WORKSPACE_LEASE_BINDING_ENV,
  WORKSPACE_LEASE_TASK_ENV,
  WORKSPACE_LEASE_TOKEN_ENV,
  type ParsedOperatorArgs,
  type DeliveryIntentRecord,
  type WorkflowContext,
  type TaskLock,
  type TaskWorkspaceLease,
} from '../state.ts';
import { executeTaskWorkspaceCleanup, type CleanupOutcome, type RemoteBaseEvidence } from './clean.ts';
import { bootstrapWorktreeNodeModulesIfNeeded, resolveSharedRepoRoot } from '../task-workspaces.ts';
import {
  evaluateReviewEvidenceForPr,
  formatReviewEvidenceOverrideMessage,
  formatReviewEvidenceStatusLines,
  recordReviewEvidenceOverride,
  reviewEvidenceOverrideReason,
} from '../review-enforcement.ts';
import {
  buildSharedCheckoutLeaseBlocker,
  buildStaleBaseBlocker,
  deriveTaskSlugFromPr,
  ensureTaskLockMatchesCurrent,
  inferActiveTaskLock,
  loadOpenPrForBranch,
  loadPrByNumber,
  parsePrNumberFlag,
  pollForMergedSha,
  type LivePr,
  watchPrChecks,
} from './helpers.ts';
import { maybeHandleDestinationCommand } from './destination.ts';

export async function handleMerge(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  if (await maybeHandleDestinationCommand(cwd, parsed)) return;

  const context = resolveWorkflowContext(cwd);
  let taskSlug = parsed.flags.task.trim() ? slugifyTaskName(parsed.flags.task) : 'unknown';
  let workspaceLease: TaskWorkspaceLease | null = null;
  let managedLock: TaskLock | null = null;
  let mergedReceipt: Awaited<ReturnType<typeof pollForMergedSha>> | null = null;
  let cleanup: CleanupOutcome | { status: 'not-applicable'; reason: string } = {
    status: 'not-applicable',
    reason: 'No managed task binding matched this PR.',
  };
  const lines: string[] = [];

  try {
    if (process.env[WORKSPACE_LEASE_TOKEN_ENV]) {
      const delegatedTaskSlug = process.env[WORKSPACE_LEASE_TASK_ENV]?.trim() ?? '';
      const delegatedBindingId = process.env[WORKSPACE_LEASE_BINDING_ENV]?.trim() ?? '';
      const acquired = borrowDelegatedTaskWorkspaceLeaseFromEnvironment(context.commonDir, context.config, {
        taskSlug: delegatedTaskSlug,
        taskBindingId: delegatedBindingId,
        childCommand: 'merge',
      });
      if (!acquired) throw new Error('Delegated merge workspace lease is missing.');
      if (acquired.acquired === false) throw new Error(acquired.reason);
      workspaceLease = acquired.lease;
      managedLock = loadTaskLock(context.commonDir, context.config, delegatedTaskSlug);
      if (!managedLock || managedLock.taskBindingId !== delegatedBindingId) {
        throw new Error('Delegated merge workspace lease no longer matches an active task binding.');
      }
    }

    const mergeContext = resolveMergeCommandContext(context, parsed);
    taskSlug = mergeContext.taskSlug;
    const { prBranchName, pr } = mergeContext;
    const candidate = loadAllTaskLocks(context.commonDir, context.config)
      .find((lock) => lock.taskSlug === taskSlug && lock.branchName === prBranchName);
    if (candidate) {
      const candidateLock = ensureTaskBindingId(context.commonDir, context.config, candidate.taskSlug);
      if (!candidateLock?.taskBindingId) throw new Error(`Task ${candidate.taskSlug} has no stable binding identity.`);
      if (workspaceLease) {
        if (!managedLock || workspaceLease.taskSlug !== candidateLock.taskSlug || workspaceLease.taskBindingId !== candidateLock.taskBindingId) {
          throw new Error('Delegated merge workspace lease does not match the resolved pull request task.');
        }
      } else {
        const acquired = acquireTaskWorkspaceLease(context.commonDir, context.config, {
          taskSlug: candidateLock.taskSlug,
          taskBindingId: candidateLock.taskBindingId,
          command: 'merge',
        });
        if (acquired.acquired === false) throw new Error(acquired.reason);
        workspaceLease = acquired.lease;
        managedLock = candidateLock;
      }
      const reread = loadTaskLock(context.commonDir, context.config, candidateLock.taskSlug);
      if (!reread || reread.taskBindingId !== candidateLock.taskBindingId || reread.branchName !== prBranchName) {
        throw new Error('Task binding changed while merge acquired the workspace lease. No merge was attempted.');
      }
      managedLock = reread;
    } else if (workspaceLease) {
      throw new Error('Delegated merge workspace lease does not match the resolved pull request.');
    }
    const bootstrap = bootstrapWorktreeNodeModulesIfNeeded(context.repoRoot);
    if (bootstrap.message) process.stderr.write(`${bootstrap.message}\n`);

    const pendingIntent = loadDeliveryIntentByPr(context.commonDir, context.config, pr.number);
    if (pr.state === 'MERGED') {
      if (!pendingIntent) {
        throw new Error(`Cannot reconcile already-merged PR #${pr.number}: no durable pre-merge delivery intent exists.`);
      }
      assertDeliveryIntentMatchesMerge(pendingIntent, {
        taskSlug,
        branchName: prBranchName,
        baseBranch: context.config.baseBranch,
        lock: managedLock,
      });
      mergedReceipt = await pollForMergedSha(context.repoRoot, pr.number);
      lines.push(`Recovered durable delivery intent for already-merged PR #${pr.number}.`);
    } else {
      const currentBranchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
      assertPrIsOpenForMerge(pr);
      if (!parsed.flags.pr.trim() || currentBranchName === prBranchName) {
        const staleBaseBlocker = buildStaleBaseBlocker(context, 'merge');
        if (staleBaseBlocker) throw new Error(staleBaseBlocker);
      }

      // Review evidence is informational: evaluate once against the PR head,
      // display the state, and proceed. Missing, failed, or pending evidence
      // asks for the single --override --reason consent, which is recorded
      // and never re-checked.
      const reviewTarget = resolveMergeHeadTarget(context, pr);
      const reviewEvidence = evaluateReviewEvidenceForPr(context, {
        command: formatWorkflowCommand(context.config, 'merge'),
        target: reviewTarget,
      });
      const reviewOverrideReason = reviewEvidenceOverrideReason(parsed.flags);
      const reviewOverrideApplied = !reviewEvidence.allowed && Boolean(reviewOverrideReason);
      if (!reviewEvidence.allowed && !reviewOverrideReason) {
        throw new Error(reviewEvidence.message);
      }
      lines.push(...formatReviewEvidenceStatusLines(reviewEvidence));
      if (reviewOverrideApplied) {
        recordReviewEvidenceOverride(context, formatWorkflowCommand(context.config, 'merge'), reviewOverrideReason);
        lines.push(formatReviewEvidenceOverrideMessage(formatWorkflowCommand(context.config, 'merge'), reviewOverrideReason));
      }
      watchPrChecks(context.repoRoot, pr.number);
      const checkedPr = loadPrByNumber(context.repoRoot, pr.number);
      assertPrIsOpenForMerge(checkedPr);
      const mergeHeadTarget = resolveMergeHeadTarget(context, checkedPr);
      saveDeliveryIntent(context.commonDir, context.config, {
        prNumber: checkedPr.number,
        ownership: managedLock ? 'managed-task' : 'unmanaged-pr',
        taskSlug,
        ...(managedLock?.taskBindingId ? { taskBindingId: managedLock.taskBindingId } : {}),
        branchName: prBranchName,
        mode: managedLock?.mode ?? context.modeState.mode,
        surfaces: managedLock?.surfaces ?? context.config.surfaces,
        baseBranch: context.config.baseBranch,
        prHeadSha: mergeHeadTarget.sha,
        title: checkedPr.title,
        url: checkedPr.url,
        recordedAt: pendingIntent?.recordedAt ?? nowIso(),
      });
      runGh(context.repoRoot, [
        'pr', 'merge', String(pr.number), '--squash', '--match-head-commit', mergeHeadTarget.sha,
      ]);
      if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_MERGE_CRASH_AFTER_REMOTE_MERGE === '1') {
        throw new Error('Injected crash after remote merge and before delivery finalization.');
      }
      mergedReceipt = await pollForMergedSha(context.repoRoot, pr.number);
    }
    const mergedSha = mergedReceipt.sha;
    const mergedAt = mergedReceipt.mergedAt ?? new Date().toISOString();
    lines.unshift('Pull request merged on GitHub.', `Task: ${taskSlug}`, `Merged SHA: ${mergedSha}`);

    try {
      finalizeDeliveryIntent(context.commonDir, context.config, {
        prNumber: mergedReceipt.number,
        mergedSha,
        mergedAt,
        title: mergedReceipt.title,
        url: mergedReceipt.url,
      });
    } catch (error) {
      const reason = `Delivery history persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      lines.push(reason, 'Delivery succeeded; automatic workspace cleanup was skipped.');
      cleanup = { status: 'blocked', taskSlug, code: 'state-conflict', reason };
      printResult(parsed.flags, { taskSlug, prNumber: mergedReceipt.number, mergedSha, cleanup, message: lines.join('\n') });
      return;
    }

    const fetchResult = runCommandCapture('git', ['fetch', 'origin', context.config.baseBranch, '--no-tags'], { cwd: context.repoRoot });
    const remoteRef = `origin/${context.config.baseBranch}`;
    const remoteSha = fetchResult.ok
      ? runGit(context.repoRoot, ['rev-parse', '--verify', remoteRef], true)?.trim() ?? ''
      : '';
    const remoteContainsMerge = Boolean(remoteSha)
      && runCommandCapture('git', ['merge-base', '--is-ancestor', mergedSha, remoteSha], { cwd: context.repoRoot }).ok;
    lines.push(fetchResult.ok
      ? `Refreshed ${remoteRef}: ${remoteSha || 'unresolved'}`
      : `Remote base refresh failed: ${fetchResult.stderr || fetchResult.stdout || 'git fetch failed'}`);
    lines.push(remoteContainsMerge
      ? `Remote base contains merged SHA: ${remoteRef}`
      : `Remote base containment for ${mergedSha.slice(0, 7)} could not be proved.`);

    if (!managedLock?.taskBindingId || !workspaceLease) {
      lines.push('Workspace cleanup: not applicable (no managed task binding).');
    } else {
      const requestId = managedLock.cleanup?.taskBindingId === managedLock.taskBindingId
        ? managedLock.cleanup.requestId
        : `cleanup-${crypto.randomUUID()}`;
      const intent = compareAndSetTaskLockWithWorkspaceLease(context.commonDir, context.config, {
        taskSlug: managedLock.taskSlug,
        taskBindingId: managedLock.taskBindingId,
        leaseToken: workspaceLease.token,
        update: (current) => ({
          ...current,
          cleanup: {
            status: parsed.flags.keepWorktree ? 'kept' : 'pending',
            requestId,
            taskBindingId: managedLock?.taskBindingId ?? '',
            trigger: 'merge',
            requestedAt: current.cleanup?.requestId === requestId ? current.cleanup.requestedAt : nowIso(),
            targetRef: remoteRef,
            targetSha: mergedSha,
            ...(parsed.flags.keepWorktree ? { retainedAt: nowIso() } : {}),
          },
          updatedAt: nowIso(),
        }),
      });
      if (intent.updated === false) {
        const reason = `Cleanup intent could not be persisted (${intent.reason}).`;
        cleanup = { status: 'blocked', taskSlug, code: 'state-conflict', reason };
      } else if (parsed.flags.keepWorktree) {
        cleanup = { status: 'kept', taskSlug, reason: 'operator-requested' };
      } else if (!automaticWorktreeCleanupEnabled(context.config)) {
        cleanup = { status: 'kept', taskSlug, reason: 'automatic-cleanup-disabled' };
      } else if (!remoteContainsMerge) {
        const reason = `The refreshed ${remoteRef} does not contain the confirmed merge SHA.`;
        compareAndSetTaskLockWithWorkspaceLease(context.commonDir, context.config, {
          taskSlug: managedLock.taskSlug,
          taskBindingId: managedLock.taskBindingId,
          leaseToken: workspaceLease.token,
          expectedCleanupRequestId: requestId,
          update: (current) => ({
            ...current,
            cleanup: current.cleanup ? { ...current.cleanup, status: 'blocked', attemptedAt: nowIso(), blockerCode: 'delivery-proof-insufficient', blockerReason: reason } : current.cleanup,
            updatedAt: nowIso(),
          }),
        });
        cleanup = { status: 'blocked', taskSlug, code: 'delivery-proof-insufficient', reason };
      } else {
        const sharedRepoRoot = resolveSharedRepoRoot(context.commonDir);
        let sharedCheckoutError = '';
        try {
          const sharedContext = resolveWorkflowContext(sharedRepoRoot);
          if (normalizeExistingPath(sharedContext.commonDir) !== normalizeExistingPath(context.commonDir)) {
            sharedCheckoutError = `Shared checkout ${sharedRepoRoot} resolves to a different Git common directory.`;
          } else {
            process.chdir(sharedRepoRoot);
          }
        } catch (error) {
          sharedCheckoutError = `Could not verify and enter the shared checkout ${sharedRepoRoot}: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (sharedCheckoutError) {
          const reason = sharedCheckoutError;
          compareAndSetTaskLockWithWorkspaceLease(context.commonDir, context.config, {
            taskSlug: managedLock.taskSlug,
            taskBindingId: managedLock.taskBindingId,
            leaseToken: workspaceLease.token,
            expectedCleanupRequestId: requestId,
            update: (current) => ({
              ...current,
              cleanup: current.cleanup ? { ...current.cleanup, status: 'blocked', attemptedAt: nowIso(), blockerCode: 'shared-checkout-unavailable', blockerReason: reason } : current.cleanup,
              updatedAt: nowIso(),
            }),
          });
          cleanup = { status: 'blocked', taskSlug, code: 'shared-checkout-unavailable', reason };
        }
        if (cleanup.status === 'not-applicable') {
          if (!workspaceLease.transfer('cleanup', 'merge-cleanup')) {
            cleanup = { status: 'blocked', taskSlug, code: 'workspace-busy', reason: 'Workspace lease transfer to cleanup failed.' };
          } else {
            const remoteEvidence: RemoteBaseEvidence = {
              ref: remoteRef,
              sha: remoteSha,
              revision: { remoteBaseSha: remoteSha, observedAt: nowIso(), source: 'merge-fetch' },
            };
            cleanup = executeTaskWorkspaceCleanup({
              commonDir: context.commonDir,
              config: context.config,
              sharedRepoRoot,
              callerCwd: sharedRepoRoot,
              lock: intent.lock,
              automatic: true,
              trigger: 'merge',
              remoteEvidence,
              workspaceLease,
            });
          }
        }
      }
      if (cleanup.status === 'cleaned') {
        lines.push('Workspace cleanup: removed worktree + local branch + task lock.');
        lines.push(`This task workspace is closed. Continue from: ${resolveSharedRepoRoot(context.commonDir)}`);
      } else if (cleanup.status === 'kept') {
        lines.push(cleanup.reason === 'operator-requested'
          ? 'Workspace cleanup: kept by --keep-worktree until explicit scoped /clean.'
          : 'Workspace cleanup: automatic cleanup is disabled by machine-local policy.');
      } else if (cleanup.status === 'blocked') {
        lines.push(`Workspace cleanup blocked: ${cleanup.reason}`);
        lines.push(`Delivery succeeded; retry with ${formatWorkflowCommand(context.config, 'clean', `--apply --task ${taskSlug}`)}.`);
      }
    }

    if (context.modeState.mode === 'release') {
      lines.push(`Next: ${formatWorkflowCommand(context.config, 'deploy', `staging --pr ${mergedReceipt.number}`)} from the shared checkout.`);
    } else if (context.config.surfaces.length === 0 || context.config.buildMode.autoDeployOnMerge) {
      lines.push(`Build delivery is complete from ${context.config.baseBranch}.`);
    } else {
      lines.push('Build-mode auto-deploy is disabled.');
      lines.push(`Next: ${formatWorkflowCommand(context.config, 'deploy', `--pr ${mergedReceipt.number}`)} from the shared checkout.`);
    }
    lines.push('Local base checkouts were not changed.');
    printResult(parsed.flags, { taskSlug, prNumber: mergedReceipt.number, mergedSha, cleanup, message: lines.join('\n') });
  } catch (error) {
    if (!mergedReceipt) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    cleanup = { status: 'blocked', taskSlug, code: 'artifact-removal-failed', reason };
    lines.push(`Post-merge local closeout failed: ${reason}`, 'The GitHub merge remains successful; the workspace was preserved when possible.');
    printResult(parsed.flags, { taskSlug, prNumber: mergedReceipt.number, mergedSha: mergedReceipt.sha, cleanup, message: lines.join('\n') });
  } finally {
    workspaceLease?.release();
  }
}

// Resolves the PR head branch and sha. Merge still needs a pinnable sha for
// `--match-head-commit` (merging exactly the head whose checks were watched);
// review evidence itself is informational and evaluated against the branch.
function resolveMergeHeadTarget(context: WorkflowContext, pr: LivePr): { branchName: string; sha: string } {
  const branchName = pr.headRefName?.trim() ?? '';
  fetchPrBranch(context.repoRoot, branchName);
  const sha = resolvePrHeadSha(context.repoRoot, branchName, pr.headRefOid?.trim() ?? '');
  if (!sha) {
    throw new Error([
      `${formatWorkflowCommand(context.config, 'merge')} blocked because PR branch ${branchName} could not be resolved locally.`,
      `Fetch the PR branch or rerun ${formatWorkflowCommand(context.config, 'pr')} from the task worktree, then retry ${formatWorkflowCommand(context.config, 'merge')}.`,
    ].join('\n'));
  }
  return { branchName, sha };
}

function fetchPrBranch(repoRoot: string, branchName: string): void {
  if (!branchName) return;
  runCommandCapture('git', ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`, '--no-tags'], {
    cwd: repoRoot,
  });
}

function resolvePrHeadSha(repoRoot: string, branchName: string, expectedSha: string): string {
  const remoteSha = runGit(repoRoot, ['rev-parse', '--verify', `refs/remotes/origin/${branchName}`], true)?.trim() ?? '';
  const localSha = runGit(repoRoot, ['rev-parse', '--verify', `refs/heads/${branchName}`], true)?.trim() ?? '';

  if (isGitSha(expectedSha)) {
    if (isGitSha(remoteSha) && remoteSha !== expectedSha) {
      return '';
    }
    return expectedSha;
  }

  return isGitSha(remoteSha) ? remoteSha : isGitSha(localSha) ? localSha : '';
}

function isGitSha(value: string): boolean {
  return /^[a-f0-9]{40,64}$/i.test(value);
}

interface MergeCommandContext {
  taskSlug: string;
  prBranchName: string;
  pr: LivePr;
}

function resolveMergeCommandContext(
  context: WorkflowContext,
  parsed: ParsedOperatorArgs,
): MergeCommandContext {
  const explicitPr = parsed.flags.pr.trim();
  if (explicitPr) {
    const pr = loadPrByNumber(context.repoRoot, parsePrNumberFlag(explicitPr));
    const prBranchName = pr.headRefName?.trim()
      || runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim()
      || '';
    const taskSlug = parsed.flags.task.trim()
      ? slugifyTaskName(parsed.flags.task)
      : deriveTaskSlugFromPr(context.config, pr, prBranchName);
    ensureMergeLeaseForPr(context, taskSlug, prBranchName);
    return { taskSlug, prBranchName, pr };
  }

  try {
    const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
    ensureTaskLockMatchesCurrent(context, lock);
    const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
    const pr = loadOpenPrForBranch(context.repoRoot, branchName);
    if (pr) {
      return { taskSlug, prBranchName: branchName, pr };
    }
    const stored = loadPrRecord(context.commonDir, context.config, taskSlug);
    if (
      stored?.number
      && stored.branchName === branchName
      && loadDeliveryIntentByPr(context.commonDir, context.config, stored.number)
    ) {
      return { taskSlug, prBranchName: branchName, pr: loadPrByNumber(context.repoRoot, stored.number) };
    }
    throw new Error(`No open pull request found for branch ${branchName}. Run ${formatWorkflowCommand(context.config, 'pr')} first.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/^No task lock (matches|found)/.test(message) || parsed.flags.task.trim()) {
      throw error;
    }

    const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
    if (!branchName) {
      throw error;
    }
    const sharedCheckoutBlocker = buildSharedCheckoutLeaseBlocker(context, 'merge', { branchName });
    if (sharedCheckoutBlocker) {
      throw new Error(sharedCheckoutBlocker);
    }
    const pr = loadOpenPrForBranch(context.repoRoot, branchName);
    if (!pr) {
      throw new Error([
        message,
        `No open pull request found for branch ${branchName}.`,
        `Pass --pr <number> to merge a known PR without a task lock.`,
      ].join('\n'));
    }
    const taskSlug = deriveTaskSlugFromPr(context.config, pr, branchName);
    return { taskSlug, prBranchName: branchName, pr };
  }
}

function assertDeliveryIntentMatchesMerge(
  intent: DeliveryIntentRecord,
  expected: { taskSlug: string; branchName: string; baseBranch: string; lock: TaskLock | null },
): void {
  const expectedOwnership = expected.lock ? 'managed-task' : 'unmanaged-pr';
  const matches = intent.ownership === expectedOwnership
    && intent.taskSlug === expected.taskSlug
    && intent.branchName === expected.branchName
    && intent.baseBranch === expected.baseBranch
    && (expected.lock
      ? intent.taskBindingId === expected.lock.taskBindingId
        && intent.mode === expected.lock.mode
        && JSON.stringify(intent.surfaces) === JSON.stringify(expected.lock.surfaces)
      : intent.taskBindingId === undefined);
  if (!matches) {
    throw new Error(`Durable delivery intent for PR #${intent.prNumber} does not match the current task binding and merge target.`);
  }
}

function ensureMergeLeaseForPr(context: WorkflowContext, taskSlug: string, branchName: string): void {
  const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
  if (lock) {
    if (lock.branchName === branchName) ensureTaskLockMatchesCurrent(context, lock);
    return;
  }

  const sharedCheckoutBlocker = buildSharedCheckoutLeaseBlocker(context, 'merge', { branchName, taskSlug });
  if (sharedCheckoutBlocker) {
    throw new Error(sharedCheckoutBlocker);
  }
}

function assertPrIsOpenForMerge(pr: LivePr): void {
  if (pr.state && pr.state !== 'OPEN') {
    throw new Error(`Cannot merge PR #${pr.number} because it is ${pr.state}. Only open PRs can be merged.`);
  }
}
