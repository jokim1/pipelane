import {
  buildPrBody,
  buildSharedCheckoutLeaseBlocker,
  buildStaleBaseBlocker,
  collectChangedPaths,
  ensureTaskLockMatchesCurrent,
  findDenyListHits,
  hasStagedChanges,
  inferTaskSlugFromBranchName,
  latestCommitSubject,
  loadOpenPrForBranch,
  resolveCommandSurfaces,
  setNextAction,
  deriveTaskSlugFromPr,
  type LivePr,
} from './helpers.ts';
import { buildReleaseCheckMessage, emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig } from '../release-gate.ts';
import { maybeHandleDestinationCommand } from './destination.ts';
import {
  applyTaskBindingRecovery,
  diagnoseTaskBinding,
  formatTaskBindingRecoveryMessage,
} from '../task-binding.ts';
import {
  ensureTaskBindingId,
  loadDeployState,
  formatWorkflowCommand,
  loadPrRecord,
  loadProbeState,
  printResult,
  resolveWorkflowContext,
  runGh,
  runGit,
  runShell,
  savePrRecord,
  slugifyTaskName,
  type ParsedOperatorArgs,
  type TaskLock,
} from '../state.ts';
import {
  backfillReviewEvidenceMaterialTreeFromCommit,
  evaluateReviewEvidenceForPr,
  formatReviewEvidenceOverrideMessage,
  recordReviewEvidenceOverride,
  recordReviewEvidenceConsents,
  reviewEvidenceOverrideReason,
  type ReviewEvidenceCheckResult,
} from '../review-enforcement.ts';
import {
  evaluateDestinationRouteReviewSafety,
  recordDestinationRouteCompleted,
  routeSafetyAcceptsReviewFindings,
} from '../route-loop-safety.ts';
import { buildDestinationPlanForCommand } from '../destination-planner.ts';
import { assertManagedLocalStateValid } from '../local-state.ts';
import { declaredPrivateSourcePaths } from '../secret-provisioning.ts';
import { readWorktreeStatusSnapshot } from '../worktree-status.ts';

export async function handlePr(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  assertManagedLocalStateValid(context.repoRoot);
  if (await maybeHandleDestinationCommand(cwd, parsed)) return;
  let taskSlug = '';
  let lock: TaskLock | null = null;

  const binding = resolvePrTaskBinding(context, parsed);
  if (binding.status === 'handoff') {
    printResult(parsed.flags, {
      taskSlug: binding.taskSlug,
      branchName: binding.lock.branchName,
      worktreePath: binding.lock.worktreePath,
      handoff: true,
      message: binding.message,
    });
    return;
  }
  if (binding.status === 'needs-recovery') {
    const message = formatTaskBindingRecoveryMessage(binding.diagnosis);
    if (parsed.flags.json) {
      printResult(parsed.flags, {
        taskSlug: binding.diagnosis.taskSlug,
        branchName: binding.diagnosis.current.branchName,
        needsRecoveryChoice: true,
        options: binding.diagnosis.options,
        message,
      });
      process.exitCode = 1;
      return;
    }
    throw new Error(message);
  }
  if (binding.status === 'blocked') {
    throw new Error(binding.reason);
  }

  taskSlug = binding.taskSlug;
  lock = binding.lock;
  if (lock) {
    lock = ensureTaskBindingId(context.commonDir, context.config, lock.taskSlug) ?? lock;
    ensureTaskLockMatchesCurrent(context, lock);
  }

  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces, lock?.surfaces ?? []);
  if (context.modeState.mode === 'release') {
    const deployState = loadDeployState(context.commonDir, context.config);
    const probeState = loadProbeState(context.commonDir, context.config);
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig: loadDeployConfig(context.repoRoot) ?? emptyDeployConfig(),
      deployRecords: deployState.records,
      probeState,
      surfaces,
    });
    if (!readiness.ready && !context.modeState.override) {
      throw new Error([
        `${formatWorkflowCommand(context.config, 'pr')} blocked before staging or committing because release mode is not ready.`,
        buildReleaseCheckMessage(readiness, surfaces, context.config),
      ].join('\n\n'));
    }
  }

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const staleBaseBlocker = buildStaleBaseBlocker(context, 'pr');
  if (staleBaseBlocker) {
    throw new Error(staleBaseBlocker);
  }
  const statusText = runGit(context.repoRoot, ['status', '--short'], true) ?? '';
  const dirty = statusText.trim().length > 0;
  const existingPr = binding.livePr ?? loadOpenPrForBranch(context.repoRoot, branchName);
  let prTitle = parsed.flags.title.trim();

  if (!existingPr && !prTitle && dirty) {
    throw new Error(`${formatWorkflowCommand(context.config, 'pr')} requires --title for a new PR when the worktree is dirty.`);
  }

  if (!prTitle) {
    prTitle = existingPr?.title || latestCommitSubject(context.repoRoot);
  }

  const reviewOverrideReason = reviewEvidenceOverrideReason(parsed.flags);
  let reviewOverrideApplied = false;
  const reviewEvidence = evaluateReviewEvidenceForPr(context);
  if (!reviewEvidence.allowed && reviewOverrideReason) {
    reviewOverrideApplied = true;
  } else if (!reviewEvidence.allowed && !routeSafetyAcceptsReviewFindings(cwd, parsed, reviewEvidence)) {
    let acceptedByPrompt = false;
    if (reviewEvidence.latest) {
      const routePlan = buildDestinationPlanForCommand(cwd, parsed);
      if (routePlan) {
        const pause = await evaluateDestinationRouteReviewSafety(context, routePlan, reviewEvidence);
        if (pause.action === 'stop') {
          throw new Error(pause.message || reviewEvidence.message);
        }
        acceptedByPrompt = true;
      }
    }
    if (!acceptedByPrompt) throw new Error(reviewEvidence.message);
  }

  for (const check of context.config.prePrChecks) {
    runShell(context.repoRoot, check, parsed.flags.json);
  }

  const postCheckReviewEvidence = evaluateReviewEvidenceForPr(context);
  if (!postCheckReviewEvidence.allowed && reviewOverrideReason) {
    reviewOverrideApplied = true;
  } else if (!postCheckReviewEvidence.allowed && !routeSafetyAcceptsReviewFindings(cwd, parsed, postCheckReviewEvidence)) {
    let acceptedByPrompt = false;
    if (postCheckReviewEvidence.latest) {
      const routePlan = buildDestinationPlanForCommand(cwd, parsed);
      if (routePlan) {
        const pause = await evaluateDestinationRouteReviewSafety(context, routePlan, postCheckReviewEvidence);
        if (pause.action === 'stop') {
          throw new Error(pause.message || postCheckReviewEvidence.message);
        }
        acceptedByPrompt = true;
      }
    }
    if (!acceptedByPrompt) throw new Error(postCheckReviewEvidence.message);
  }

  // E1 (merge-channel parity): when the matched record lacks a reliable
  // material identity, capture the reviewed checkout's write-tree BEFORE
  // staging. The backfill below only certifies the commit if its tree equals
  // this snapshot, so content introduced during the commit itself (pre-commit
  // hooks, concurrent writers) can never be blessed as reviewed. The snapshot
  // must also still match the status digest the evidence was evaluated
  // against — any drift means the checkout is no longer the reviewed state.
  const materialBackfillRunId = resolveMaterialBackfillRunId(postCheckReviewEvidence);
  let materialBackfillIntendedTree = '';
  if (materialBackfillRunId) {
    const preCommitSnapshot = readWorktreeStatusSnapshot(context.repoRoot, {
      includeStatusDigest: true,
      includeMaterialTreeHash: true,
    });
    if (
      preCommitSnapshot.statusDigestReliable
      && preCommitSnapshot.statusDigest === postCheckReviewEvidence.target?.worktreeStatusDigest
      && preCommitSnapshot.materialTreeReliable === true
      && preCommitSnapshot.materialTreeHash
    ) {
      materialBackfillIntendedTree = preCommitSnapshot.materialTreeHash;
    }
  }

  if (dirty) {
    const changedPaths = collectChangedPaths(context.repoRoot);
    const denyHits = findDenyListHits(
      changedPaths,
      [...context.config.prPathDenyList, ...declaredPrivateSourcePaths(context.repoRoot)],
      parsed.flags.forceInclude,
    );
    if (denyHits.length > 0) {
      throw new Error([
        `Refusing to include ${denyHits.length} file(s) that match prPathDenyList:`,
        ...denyHits.map(({ path: denyPath, pattern }) => `- ${denyPath} (matched ${pattern})`),
        'These look like secrets or agent-local config. Either gitignore them,',
        'or override on a per-path basis with --force-include <path>.',
        'Edit machine-local Pipelane config prPathDenyList to adjust globally.',
      ].join('\n'));
    }

    runGit(context.repoRoot, ['add', '-A']);
    if (!hasStagedChanges(context.repoRoot)) {
      throw new Error('No staged changes were found after git add -A.');
    }
    runGit(context.repoRoot, ['commit', '-m', parsed.flags.message.trim() || prTitle]);
  }

  if (materialBackfillRunId && materialBackfillIntendedTree) {
    backfillReviewEvidenceMaterialTreeFromCommit(context, materialBackfillRunId, materialBackfillIntendedTree);
  }

  if (reviewOverrideApplied) {
    const finalReviewEvidence = evaluateReviewEvidenceForPr(context, {
      command: formatWorkflowCommand(context.config, 'pr'),
    });
    if (!finalReviewEvidence.allowed) {
      recordReviewEvidenceConsents(
        context,
        finalReviewEvidence,
        formatWorkflowCommand(context.config, 'pr'),
        reviewOverrideReason,
      );
      const consented = evaluateReviewEvidenceForPr(context, {
        command: formatWorkflowCommand(context.config, 'pr'),
      });
      if (!consented.allowed) {
        throw new Error('Exact-scope review consent did not authorize the final PR target; no remote action was attempted.');
      }
    }
    recordReviewEvidenceOverride(context, formatWorkflowCommand(context.config, 'pr'), reviewOverrideReason);
  }

  runGit(context.repoRoot, ['push', '-u', 'origin', branchName]);
  let prNumber = existingPr?.number;
  let prUrl = existingPr?.url;

  if (!existingPr) {
    prUrl = runGh(context.repoRoot, [
      'pr',
      'create',
      '--base',
      context.config.baseBranch,
      '--head',
      branchName,
      '--title',
      prTitle,
      '--body',
      buildPrBody(prTitle, context.config.prePrChecks),
    ]) ?? undefined;
  } else {
    runGh(context.repoRoot, [
      'pr',
      'edit',
      String(existingPr.number),
      '--title',
      prTitle,
      '--body',
      buildPrBody(prTitle, context.config.prePrChecks),
    ]);
  }

  const refreshedPr = loadOpenPrForBranch(context.repoRoot, branchName);
  prNumber = refreshedPr?.number ?? prNumber;
  prUrl = refreshedPr?.url ?? prUrl;

  savePrRecord(context.commonDir, context.config, taskSlug, {
    ...(lock?.taskBindingId ? { taskBindingId: lock.taskBindingId } : {}),
    branchName,
    title: prTitle,
    number: prNumber,
    url: prUrl,
  });

  setNextAction(
    context.commonDir,
    context.config,
    taskSlug,
    prNumber ? `PR #${prNumber} open, awaiting CI` : 'PR created, awaiting CI',
  );
  if (process.env.PIPELANE_DESTINATION_INTERNAL_STEP !== '1') {
    const completedPlan = buildDestinationPlanForCommand(cwd, parsed);
    if (completedPlan) recordDestinationRouteCompleted(context, completedPlan);
  }
  const reviewOverrideMessage = reviewOverrideApplied
    ? formatReviewEvidenceOverrideMessage(formatWorkflowCommand(context.config, 'pr'), reviewOverrideReason)
    : '';
  const reviewOverrideMessages = reviewOverrideMessage ? [reviewOverrideMessage] : [];

  printResult(parsed.flags, {
    taskSlug,
    branchName,
    title: prTitle,
    url: prUrl,
    message: [
      existingPr ? 'Updated pull request.' : 'Created pull request.',
      `Task: ${taskSlug}`,
      `Branch: ${branchName}`,
      `PR: ${prUrl || 'created'}`,
      ...reviewOverrideMessages,
      `Next: run ${formatWorkflowCommand(context.config, 'merge')}.`,
    ].join('\n'),
  });
}

// E1 backfill applies only when the matched record lacks a reliable material
// identity AND the match came through the status-digest channel — that channel
// is what proves the record describes exactly the content /pr just committed.
function resolveMaterialBackfillRunId(evidence: ReviewEvidenceCheckResult): string {
  const latest = evidence.latest;
  const target = evidence.target;
  if (!latest || !target) return '';
  // Backfill is an evidence upgrade, not an override channel. Only a clean,
  // currently-valid pass may acquire the post-commit material identity. In
  // particular, /pr can override stale-SHA evidence that /merge must reject;
  // laundering that record through backfill would erase the distinction.
  if (!evidence.allowed || evidence.bypassedIssues.length > 0) return '';
  if (latest.status !== 'passed') return '';
  if (latest.branchName !== target.branchName || latest.sha !== target.sha) return '';
  if (latest.worktreeMaterialTreeReliable === true && latest.worktreeMaterialTreeHash) return '';
  if (!target.worktreeStatusReliable || latest.worktreeStatusReliable === false) return '';
  if ((latest.worktreeStatusDigest ?? '') !== target.worktreeStatusDigest) return '';
  return latest.id;
}

function resolvePrTaskBinding(
  context: ReturnType<typeof resolveWorkflowContext>,
  parsed: ParsedOperatorArgs,
):
  | { status: 'resolved'; taskSlug: string; lock: TaskLock | null; livePr: LivePr | null }
  | { status: 'handoff'; taskSlug: string; lock: TaskLock; message: string }
  | { status: 'needs-recovery'; diagnosis: Extract<ReturnType<typeof diagnoseTaskBinding>, { status: 'needs-recovery' }> }
  | { status: 'blocked'; reason: string } {
  if (parsed.flags.recover.trim()) {
    const recovered = applyTaskBindingRecovery(
      context,
      parsed.flags.task,
      parsed.flags.recover,
      parsed.flags.bindingFingerprint,
    );
    if ('message' in recovered) {
      return {
        status: 'handoff',
        taskSlug: recovered.taskSlug,
        lock: recovered.lock,
        message: recovered.message,
      };
    }
    return {
      status: 'resolved',
      taskSlug: recovered.taskSlug,
      lock: recovered.lock,
      livePr: null,
    };
  }

  const diagnosis = diagnoseTaskBinding(context, parsed.flags.task);
  if (diagnosis.status === 'resolved') {
    return {
      status: 'resolved',
      taskSlug: diagnosis.taskSlug,
      lock: diagnosis.lock,
      livePr: null,
    };
  }
  if (diagnosis.status === 'needs-recovery') {
    return { status: 'needs-recovery', diagnosis };
  }
  const lockless = resolveLocklessPrFromCurrentBranch(context, parsed.flags.task, diagnosis.reason);
  if (lockless) {
    return lockless;
  }
  return { status: 'blocked', reason: diagnosis.reason };
}

function resolveLocklessPrFromCurrentBranch(
  context: ReturnType<typeof resolveWorkflowContext>,
  explicitTask: string,
  blockedReason: string,
):
  | { status: 'resolved'; taskSlug: string; lock: null; livePr: LivePr | null }
  | { status: 'blocked'; reason: string }
  | null {
  if (!/^No task lock (matches|found)/.test(blockedReason)) {
    return null;
  }

  const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  if (!branchName || isBaseBranch(context, branchName)) {
    return null;
  }
  const livePr = loadOpenPrForBranch(context.repoRoot, branchName);

  const derivedTaskSlug = livePr
    ? deriveTaskSlugFromPr(context.config, livePr, branchName)
    : inferTaskSlugFromBranchName(context.config, branchName) || slugifyTaskName(branchName);
  const explicitSlug = explicitTask.trim() ? slugifyTaskName(explicitTask) : '';
  if (explicitSlug && explicitSlug !== derivedTaskSlug) {
    return null;
  }

  const taskSlug = explicitSlug || derivedTaskSlug;
  const sharedCheckoutBlocker = buildSharedCheckoutLeaseBlocker(context, 'pr', { branchName, taskSlug });
  if (sharedCheckoutBlocker) {
    return { status: 'blocked', reason: sharedCheckoutBlocker };
  }

  return {
    status: 'resolved',
    taskSlug,
    lock: null,
    livePr,
  };
}

function isBaseBranch(context: ReturnType<typeof resolveWorkflowContext>, branchName: string): boolean {
  return branchName === context.config.baseBranch || branchName === 'main' || branchName === 'master';
}
