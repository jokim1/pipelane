import { printResult, resolveWorkflowContext, runGh, runGit, savePrRecord, type ParsedOperatorArgs } from '../state.ts';
import { ensureTaskLockMatchesCurrent, inferActiveTaskLock, loadPrForBranch, pollForMergedSha, setNextAction, watchPrChecks } from './helpers.ts';

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
  runGh(context.repoRoot, ['pr', 'merge', String(pr.number), '--squash', '--delete-branch']);

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
  const nextActionText = context.modeState.mode === 'build'
    ? `merged at ${shortSha}, awaiting auto-deploy`
    : `merged at ${shortSha}, deploy to staging`;
  setNextAction(context.commonDir, context.config, taskSlug, nextActionText);

  const lines = [
    'Pull request merged.',
    `Task: ${taskSlug}`,
    `Merged SHA: ${mergedSha}`,
  ];

  if (context.modeState.mode === 'build') {
    lines.push(`Build mode expects production deploy to happen via ${context.config.deployWorkflowName}.`);
    lines.push('Next: verify production, then run workflow:clean.');
  } else {
    lines.push('Next: run workflow:deploy -- staging.');
  }

  printResult(parsed.flags, {
    taskSlug,
    mergedSha,
    message: lines.join('\n'),
  });
}
