import { printResult, resolveWorkflowContext, runCommandCapture, runGh, runGit, savePrRecord, type ParsedOperatorArgs } from '../state.ts';
import { ensureTaskLockMatchesCurrent, inferActiveTaskLock, loadPrForBranch, pollForMergedSha, setNextAction, watchPrChecks } from './helpers.ts';
import { dispatchDeploy } from './deploy.ts';

export async function handleMerge(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
  ensureTaskLockMatchesCurrent(context, lock);

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const currentHeadSha = runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '';
  const pr = loadPrForBranch(context.repoRoot, branchName);
  if (!pr) {
    throw new Error(`No pull request found for branch ${branchName}. Run pipelane:pr first.`);
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
    branchName,
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
    `Current worktree branch remains ${branchName}.`,
    currentHeadSha
      ? `Current worktree HEAD remains ${currentHeadSha}.`
      : 'Current worktree HEAD could not be resolved.',
    'Local base checkouts were not changed.',
  ];

  const autoDeployOnMerge = context.modeState.mode === 'build' && context.config.buildMode.autoDeployOnMerge;

  if (autoDeployOnMerge) {
    const deploy = await dispatchDeploy(cwd, parsed, {
      environment: 'prod',
      explicitTask: taskSlug,
      explicitSurfaces: lock.surfaces,
      async: true,
    });
    lines.push(`Production deploy dispatched via ${deploy.workflowName}.`);
    if (deploy.workflowRunUrl) {
      lines.push(`Workflow run: ${deploy.workflowRunUrl}`);
    } else if (deploy.workflowRunId) {
      lines.push(`Workflow run: ${deploy.workflowRunId}`);
    }
    lines.push('Stay in this task worktree until production verification is clear.');
    lines.push('Next: verify production, then run pipelane:clean.');
  } else if (context.modeState.mode === 'build') {
    setNextAction(context.commonDir, context.config, taskSlug, `merged at ${shortSha}, deploy to prod`);
    lines.push('Build mode auto-deploy is disabled for this repo.');
    lines.push('Stay in this task worktree and dispatch production from here.');
    lines.push('Next: run pipelane:deploy -- prod.');
  } else {
    setNextAction(context.commonDir, context.config, taskSlug, `merged at ${shortSha}, deploy to staging`);
    lines.push('Stay in this task worktree and deploy staging from here.');
    lines.push('Next: run pipelane:deploy -- staging.');
  }

  printResult(parsed.flags, {
    taskSlug,
    mergedSha,
    message: lines.join('\n'),
  });
}
