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
  setNextAction,
  deriveTaskSlugFromPr,
  type LivePr,
} from './helpers.ts';
import { maybeHandleDestinationCommand } from './destination.ts';
import {
  applyTaskBindingRecovery,
  diagnoseTaskBinding,
  formatTaskBindingRecoveryMessage,
} from '../task-binding.ts';
import {
  ensureTaskBindingId,
  formatWorkflowCommand,
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
  evaluateReviewEvidenceForPr,
  formatReviewEvidenceOverrideMessage,
  formatReviewEvidenceStatusLines,
  recordReviewEvidenceOverride,
  reviewEvidenceOverrideReason,
} from '../review-enforcement.ts';
import { assertManagedLocalStateValid } from '../local-state.ts';
import { declaredPrivateSourcePaths } from '../secret-provisioning.ts';

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

  // Review evidence is informational: evaluate once, display the state, and
  // proceed. Missing, failed, or pending evidence asks for the single
  // --override --reason consent, which is recorded and never re-checked.
  const reviewEvidence = evaluateReviewEvidenceForPr(context);
  const reviewOverrideReason = reviewEvidenceOverrideReason(parsed.flags);
  const reviewOverrideApplied = !reviewEvidence.allowed && Boolean(reviewOverrideReason);
  if (!reviewEvidence.allowed && !reviewOverrideReason) {
    throw new Error(reviewEvidence.message);
  }
  const reviewStatusLines = formatReviewEvidenceStatusLines(reviewEvidence);

  for (const check of context.config.prePrChecks) {
    runShell(context.repoRoot, check, parsed.flags.json);
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

  if (reviewOverrideApplied) {
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
  const reviewOverrideMessages = reviewOverrideApplied
    ? [formatReviewEvidenceOverrideMessage(formatWorkflowCommand(context.config, 'pr'), reviewOverrideReason)]
    : [];

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
      ...reviewStatusLines,
      ...reviewOverrideMessages,
      `Next: run ${formatWorkflowCommand(context.config, 'merge')}.`,
    ].join('\n'),
  });
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
