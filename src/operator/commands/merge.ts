import { printResult, resolveWorkflowContext, runGh, runGit, savePrRecord, type ParsedOperatorArgs } from '../state.ts';
import { ensureTaskLockMatchesCurrent, inferActiveTaskLock, loadPrForBranch, pollForMergedSha, setNextAction, watchPrChecks } from './helpers.ts';
import { dispatchDeploy } from './deploy.ts';

export async function handleMerge(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
  ensureTaskLockMatchesCurrent(context, lock);

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const pr = loadPrForBranch(context.repoRoot, branchName);
  if (!pr) {
    throw new Error(`No pull request found for branch ${branchName}. Run workflow:pr first.`);
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
  const lines = [
    'Pull request merged.',
    `Task: ${taskSlug}`,
    `Merged SHA: ${mergedSha}`,
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
    lines.push('Next: verify production, then run workflow:clean.');
  } else if (context.modeState.mode === 'build') {
    setNextAction(context.commonDir, context.config, taskSlug, `merged at ${shortSha}, deploy to prod`);
    lines.push('Build mode auto-deploy is disabled for this repo.');
    lines.push('Next: run workflow:deploy -- prod.');
  } else {
    setNextAction(context.commonDir, context.config, taskSlug, `merged at ${shortSha}, deploy to staging`);
    lines.push('Next: run workflow:deploy -- staging.');
  }

  printResult(parsed.flags, {
    taskSlug,
    mergedSha,
    message: lines.join('\n'),
  });
}
