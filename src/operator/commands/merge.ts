import {
  formatWorkflowCommand,
  loadTaskLock,
  printResult,
  resolveWorkflowContext,
  runCommandCapture,
  runGh,
  runGit,
  savePrRecord,
  slugifyTaskName,
  type ParsedOperatorArgs,
  type TaskLock,
  type WorkflowContext,
} from '../state.ts';
import {
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
import { dispatchDeploy } from './deploy.ts';
import { maybeHandleDestinationCommand } from './destination.ts';
import { DESTINATION_INTERNAL_STEP_ENV } from '../destination-executor.ts';

export async function handleMerge(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  if (await maybeHandleDestinationCommand(cwd, parsed)) return;

  const context = resolveWorkflowContext(cwd);
  const mergeContext = resolveMergeCommandContext(context, parsed);
  const { taskSlug, lock, prBranchName, pr } = mergeContext;
  const currentBranchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const currentHeadSha = runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '';
  assertPrIsOpenForMerge(pr);
  if (!parsed.flags.pr.trim() || currentBranchName === prBranchName) {
    const staleBaseBlocker = buildStaleBaseBlocker(context, 'merge');
    if (staleBaseBlocker) {
      throw new Error(staleBaseBlocker);
    }
  }

  watchPrChecks(context.repoRoot, pr.number);
  runGh(context.repoRoot, ['pr', 'merge', String(pr.number), '--squash']);

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
    'Local base checkouts were not changed.',
  ];

  const destinationRouteStep = process.env[DESTINATION_INTERNAL_STEP_ENV] === '1';
  const hasDeploySurfaces = context.config.surfaces.length > 0;
  const autoDeployOnMerge = context.modeState.mode === 'build'
    && hasDeploySurfaces
    && context.config.buildMode.autoDeployOnMerge
    && !destinationRouteStep;

  if (context.modeState.mode === 'build' && !hasDeploySurfaces) {
    const cleanCommand = formatWorkflowCommand(context.config, 'clean', `--apply --task ${taskSlug}`);
    setNextAction(context.commonDir, context.config, taskSlug, `merged at ${shortSha}, no deploy surfaces configured; run ${cleanCommand}`);
    lines.push('No deploy surfaces are configured for this repo.');
    lines.push('Merge to the base branch is the delivery step.');
    lines.push(`Next: run ${cleanCommand} to close out this workspace.`);
  } else if (autoDeployOnMerge) {
    const deploy = await dispatchDeploy(cwd, parsed, {
      environment: 'prod',
      explicitTask: taskSlug,
      async: true,
      allowMissingTaskLock: lock === null,
    });
    lines.push(deploy.dispatchMode === 'push'
      ? `Production deploy is handled by ${deploy.workflowName} on ${context.config.baseBranch} push.`
      : `Production deploy dispatched via ${deploy.workflowName}.`);
    if (deploy.workflowRunUrl) {
      lines.push(`Workflow run: ${deploy.workflowRunUrl}`);
    } else if (deploy.workflowRunId) {
      lines.push(`Workflow run: ${deploy.workflowRunId}`);
    }
    lines.push('Stay in this task worktree until production verification is clear.');
    lines.push(`Next: verify production, then run ${formatWorkflowCommand(context.config, 'clean')}.`);
  } else if (context.modeState.mode === 'build') {
    setNextAction(context.commonDir, context.config, taskSlug, `merged at ${shortSha}, run ${formatWorkflowCommand(context.config, 'deploy', 'prod')}`);
    if (destinationRouteStep && context.config.buildMode.autoDeployOnMerge) {
      lines.push('Build mode auto-deploy is handled by the approved destination route.');
      lines.push('The route will dispatch production from this task worktree.');
    } else {
      lines.push('Build mode auto-deploy is disabled for this repo.');
      lines.push('Stay in this task worktree and dispatch production from here.');
      lines.push(`Next: run ${formatWorkflowCommand(context.config, 'deploy', 'prod')}.`);
    }
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

interface MergeCommandContext {
  taskSlug: string;
  lock: TaskLock | null;
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
    const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
    return { taskSlug, lock: lock ?? null, prBranchName, pr };
  }

  try {
    const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
    ensureTaskLockMatchesCurrent(context, lock);
    const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
    const pr = loadOpenPrForBranch(context.repoRoot, branchName);
    if (!pr) {
      throw new Error(`No open pull request found for branch ${branchName}. Run ${formatWorkflowCommand(context.config, 'pr')} first.`);
    }
    return { taskSlug, lock, prBranchName: branchName, pr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/^No task lock (matches|found)/.test(message) || parsed.flags.task.trim()) {
      throw error;
    }

    const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
    if (!branchName) {
      throw error;
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
    return { taskSlug, lock: null, prBranchName: branchName, pr };
  }
}

function assertPrIsOpenForMerge(pr: LivePr): void {
  if (pr.state && pr.state !== 'OPEN') {
    throw new Error(`Cannot merge PR #${pr.number} because it is ${pr.state}. Only open PRs can be merged.`);
  }
}
