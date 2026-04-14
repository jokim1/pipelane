import { printResult, resolveWorkflowContext, runGh, runGit, savePrRecord, type ParsedOperatorArgs } from '../state.ts';
import { ensureTaskLockMatchesCurrent, inferActiveTaskLock, loadPrDetails, loadPrForBranch, watchPrChecks } from './helpers.ts';

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

  const details = loadPrDetails(context.repoRoot, pr.number);
  const mergedSha = details.mergeCommit?.oid
    || (runGit(context.repoRoot, ['rev-parse', '--verify', `origin/${context.config.baseBranch}`], true)
      ?? runGit(context.repoRoot, ['rev-parse', '--verify', context.config.baseBranch], true)
      ?? '').trim();

  savePrRecord(context.commonDir, context.config, taskSlug, {
    branchName,
    title: details.title,
    number: details.number,
    url: details.url,
    mergedSha,
    mergedAt: details.mergedAt ?? new Date().toISOString(),
  });

  const lines = [
    'Pull request merged.',
    `Task: ${taskSlug}`,
    `Merged SHA: ${mergedSha || 'unknown'}`,
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
