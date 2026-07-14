import { createHash } from 'node:crypto';

import {
  ensureTaskBindingId,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadTaskLock,
  printResult,
  resolveWorkflowContext,
  runCommandCapture,
  runGh,
  runGit,
  savePrRecord,
  slugifyTaskName,
  type ParsedOperatorArgs,
  type WorkflowContext,
} from '../state.ts';
import {
  evaluateReviewEvidenceForPr,
  formatReviewEvidenceOverrideMessage,
  recordReviewEvidenceOverride,
  recordReviewEvidenceConsents,
  reviewEvidenceOverrideReason,
  type ReviewEvidenceTarget,
} from '../review-enforcement.ts';
import { routeSafetyAcceptsReviewFindings } from '../route-loop-safety.ts';
import {
  buildSharedCheckoutLeaseBlocker,
  assertTaskCommandWorktree,
  buildStaleBaseBlocker,
  deriveTaskSlugFromPr,
  ensureTaskLockMatchesCurrent,
  inferActiveTaskLock,
  loadOpenPrForBranch,
  loadPrByNumber,
  parsePrNumberFlag,
  pollForMergedSha,
  setNextAction,
  type LivePr,
  watchPrChecks,
} from './helpers.ts';
import { maybeHandleDestinationCommand } from './destination.ts';

export async function handleMerge(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  assertTaskCommandWorktree(context, 'merge', parsed.flags.task, parsed.flags.pr);
  if (await maybeHandleDestinationCommand(cwd, parsed)) return;
  const mergeContext = resolveMergeCommandContext(context, parsed);
  const { taskSlug, prBranchName, pr } = mergeContext;
  const currentBranchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const currentHeadSha = runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '';
  assertPrIsOpenForMerge(pr);
  if (!parsed.flags.pr.trim() || currentBranchName === prBranchName) {
    const staleBaseBlocker = buildStaleBaseBlocker(context, 'merge', prBranchName);
    if (staleBaseBlocker) {
      throw new Error(staleBaseBlocker);
    }
  }

  const reviewTarget = resolveReviewEvidenceTargetForPr(context, pr);
  const reviewOverrideReason = reviewEvidenceOverrideReason(parsed.flags);
  let reviewOverrideApplied = false;
  reviewOverrideApplied = assertReviewEvidenceReadyForMerge(cwd, parsed, context, reviewTarget) || reviewOverrideApplied;

  watchPrChecks(context.repoRoot, pr.number);
  const checkedPr = loadPrByNumber(context.repoRoot, pr.number);
  assertPrIsOpenForMerge(checkedPr);
  const checkedReviewTarget = resolveReviewEvidenceTargetForPr(context, checkedPr);
  reviewOverrideApplied = assertReviewEvidenceReadyForMerge(cwd, parsed, context, checkedReviewTarget) || reviewOverrideApplied;
  if (reviewOverrideApplied) {
    const finalEvidence = evaluateReviewEvidenceForPr(context, {
      command: formatWorkflowCommand(context.config, 'merge'),
      target: checkedReviewTarget,
    });
    if (!finalEvidence.allowed) {
      recordReviewEvidenceConsents(
        context,
        finalEvidence,
        formatWorkflowCommand(context.config, 'merge'),
        reviewOverrideReason,
        'gate-bypass',
        checkedReviewTarget,
      );
      const consented = evaluateReviewEvidenceForPr(context, {
        command: formatWorkflowCommand(context.config, 'merge'),
        target: checkedReviewTarget,
      });
      if (!consented.allowed) {
        throw new Error('Exact-scope review consent did not authorize the final merge target; no merge was attempted.');
      }
    }
    recordReviewEvidenceOverride(context, formatWorkflowCommand(context.config, 'merge'), reviewOverrideReason);
  }
  const reviewOverrideMessage = reviewOverrideApplied
    ? formatReviewEvidenceOverrideMessage(formatWorkflowCommand(context.config, 'merge'), reviewOverrideReason)
    : '';
  const reviewOverrideMessages = reviewOverrideMessage ? [reviewOverrideMessage] : [];
  runGh(context.repoRoot, [
    'pr',
    'merge',
    String(pr.number),
    '--squash',
    '--match-head-commit',
    checkedReviewTarget.sha,
  ]);

  // Poll gh until the PR reports state === "MERGED" AND mergeCommit.oid
  // is present. Fail closed on timeout. Never fall back to
  // rev-parse origin/<base> — that silently promoted unrelated commits
  // in earlier versions.
  const merged = await pollForMergedSha(context.repoRoot, pr.number);
  const mergedSha = merged.sha;

  savePrRecord(context.commonDir, context.config, taskSlug, {
    branchName: prBranchName,
    title: merged.title,
    number: merged.number,
    url: merged.url,
    mergedSha,
    mergedAt: merged.mergedAt ?? new Date().toISOString(),
  });

  const shortSha = mergedSha.slice(0, 7);
  const fetchResult = runCommandCapture('git', ['fetch', 'origin', context.config.baseBranch, '--no-tags'], {
    cwd: context.repoRoot,
  });
  const refreshedOriginSha = fetchResult.ok
    ? runGit(context.repoRoot, ['rev-parse', '--verify', `origin/${context.config.baseBranch}`], true)?.trim() ?? ''
    : '';
  const lines = [
    'Pull request merged on GitHub.',
    `Task: ${taskSlug}`,
    `Merged SHA: ${mergedSha}`,
    fetchResult.ok
      ? `Refreshed origin/${context.config.baseBranch}: ${refreshedOriginSha || 'unresolved'}`
      : `Remote base refresh failed: ${fetchResult.stderr || `git fetch origin ${context.config.baseBranch} --no-tags exited ${fetchResult.exitCode}`}`,
    refreshedOriginSha
      ? refreshedOriginSha === mergedSha
        ? `Remote base matches the merged SHA.`
        : `Remote base does not match the merged SHA yet: ${refreshedOriginSha}`
      : `Remote base SHA is unavailable after merge.`,
    currentBranchName
      ? `Current worktree branch remains ${currentBranchName}.`
      : 'Current worktree branch could not be resolved.',
    currentHeadSha
      ? `Current worktree HEAD remains ${currentHeadSha}.`
      : 'Current worktree HEAD could not be resolved.',
    ...reviewOverrideMessages,
    'Local base checkouts were not changed.',
  ];

  const hasDeploySurfaces = context.config.surfaces.length > 0;
  const autoDeployOnMerge = context.modeState.mode === 'build'
    && context.config.buildMode.autoDeployOnMerge;

  if (context.modeState.mode === 'build' && (!hasDeploySurfaces || autoDeployOnMerge)) {
    const cleanCommand = formatWorkflowCommand(context.config, 'clean', `--apply --task ${taskSlug}`);
    const deliveryReason = hasDeploySurfaces
      ? `merged at ${shortSha}, live environment updates automatically from ${context.config.baseBranch}; run ${cleanCommand}`
      : `merged at ${shortSha}, no deploy surfaces configured; run ${cleanCommand}`;
    setNextAction(context.commonDir, context.config, taskSlug, deliveryReason);
    if (hasDeploySurfaces) {
      lines.push(`Build mode: the live environment updates automatically from ${context.config.baseBranch} after merge.`);
    } else {
      lines.push('No deploy surfaces are configured for this repo.');
    }
    lines.push('Merge to the base branch is the delivery step.');
    lines.push(`Next: run ${cleanCommand} to close out this workspace.`);
  } else if (context.modeState.mode === 'build') {
    const deployCommand = formatWorkflowCommand(context.config, 'deploy');
    setNextAction(context.commonDir, context.config, taskSlug, `merged at ${shortSha}, run ${deployCommand}`);
    lines.push('Build mode auto-deploy is disabled for this repo.');
    lines.push('Stay in this task worktree and deploy the live environment from here.');
    lines.push(`Next: run ${deployCommand}.`);
  } else {
    const nextAction = `merged at ${shortSha}, run ${formatWorkflowCommand(context.config, 'deploy', 'staging')}`;
    setNextAction(context.commonDir, context.config, taskSlug, nextAction);
    lines.push('Stay in this task worktree and deploy staging from here.');
    lines.push(`Next: ${nextAction}`);
  }

  printResult(parsed.flags, {
    taskSlug,
    mergedSha,
    message: lines.join('\n'),
  });
}

function assertReviewEvidenceReadyForMerge(
  cwd: string,
  parsed: ParsedOperatorArgs,
  context: WorkflowContext,
  target?: ReviewEvidenceTarget,
): boolean {
  const reviewEvidence = evaluateReviewEvidenceForPr(context, {
    command: formatWorkflowCommand(context.config, 'merge'),
    target,
  });
  const overrideReason = reviewEvidenceOverrideReason(parsed.flags);
  if (!reviewEvidence.allowed && overrideReason) {
    return true;
  }
  if (!reviewEvidence.allowed && !routeSafetyAcceptsReviewFindings(cwd, parsed, reviewEvidence)) {
    throw new Error(reviewEvidence.message);
  }
  return false;
}

function resolveReviewEvidenceTargetForPr(context: WorkflowContext, pr: LivePr): ReviewEvidenceTarget {
  const branchName = pr.headRefName?.trim() ?? '';
  fetchPrBranch(context.repoRoot, branchName);
  const sha = resolvePrHeadSha(context.repoRoot, branchName, pr.headRefOid?.trim() ?? '');
  if (!sha) {
    throw new Error([
      `${formatWorkflowCommand(context.config, 'merge')} blocked because PR branch ${branchName} could not be resolved locally.`,
      `Fetch the PR branch or rerun ${formatWorkflowCommand(context.config, 'pr')} from the task worktree, then retry ${formatWorkflowCommand(context.config, 'merge')}.`,
    ].join('\n'));
  }
  const treeHash = runGit(context.repoRoot, ['rev-parse', '--verify', `${sha}^{tree}`], true)?.trim() ?? '';
  if (!treeHash) {
    throw new Error([
      `${formatWorkflowCommand(context.config, 'merge')} blocked because PR branch ${branchName} tree could not be resolved.`,
      `Fetch the PR branch, then retry ${formatWorkflowCommand(context.config, 'merge')}.`,
    ].join('\n'));
  }

  const lock = loadAllTaskLocks(context.commonDir, context.config).find((candidate) => candidate.branchName === branchName);
  const taskBindingId = lock
    ? ensureTaskBindingId(context.commonDir, context.config, lock.taskSlug)?.taskBindingId ?? ''
    : '';
  const reviewTargetDigest = createHash('sha256').update(JSON.stringify({
    version: 2,
    branchName,
    sha,
    worktreeStatusDigest: '',
    worktreeMaterialTreeHash: treeHash,
  })).digest('hex');
  return {
    branchName,
    sha,
    worktreeStatusDigest: '',
    worktreeStatusReliable: false,
    worktreeStatusWarnings: [`review target is PR branch ${branchName}, not the current checkout`],
    worktreeMaterialTreeHash: treeHash,
    worktreeMaterialTreeReliable: true,
    worktreeMaterialTreeWarnings: [],
    taskBindingId,
    reviewTargetDigest,
    headLabel: `PR branch ${branchName} HEAD`,
  };
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
    if (!pr) {
      throw new Error(`No open pull request found for branch ${branchName}. Run ${formatWorkflowCommand(context.config, 'pr')} first.`);
    }
    return { taskSlug, prBranchName: branchName, pr };
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

function ensureMergeLeaseForPr(context: WorkflowContext, taskSlug: string, branchName: string): void {
  const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
  if (lock) {
    ensureTaskLockMatchesCurrent(context, lock);
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
