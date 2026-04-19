import {
  buildPrBody,
  collectChangedPaths,
  ensureTaskLockMatchesCurrent,
  findDenyListHits,
  hasStagedChanges,
  latestCommitSubject,
  loadPrForBranch,
  resolveCommandSurfaces,
  setNextAction,
} from './helpers.ts';
import { emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig } from '../release-gate.ts';
import {
  loadDeployState,
  loadPrRecord,
  loadProbeState,
  printResult,
  resolveWorkflowContext,
  runGh,
  runGit,
  runShell,
  savePrRecord,
  type ParsedOperatorArgs,
} from '../state.ts';
import { inferActiveTaskLock } from './helpers.ts';

export async function handlePr(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
  ensureTaskLockMatchesCurrent(context, lock);

  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces, lock.surfaces);
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
      throw new Error('Release mode is not ready. Run workflow:release-check first.');
    }
  }

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const statusText = runGit(context.repoRoot, ['status', '--short'], true) ?? '';
  const dirty = statusText.trim().length > 0;
  const existingPr = loadPrForBranch(context.repoRoot, branchName);
  let prTitle = parsed.flags.title.trim();

  if (!existingPr && !prTitle && dirty) {
    throw new Error('workflow:pr requires --title for a new PR when the worktree is dirty.');
  }

  if (!prTitle) {
    prTitle = existingPr?.title || latestCommitSubject(context.repoRoot);
  }

  for (const check of context.config.prePrChecks) {
    runShell(context.repoRoot, check, parsed.flags.json);
  }

  if (dirty) {
    const changedPaths = collectChangedPaths(context.repoRoot);
    const denyHits = findDenyListHits(
      changedPaths,
      context.config.prPathDenyList,
      parsed.flags.forceInclude,
    );
    if (denyHits.length > 0) {
      throw new Error([
        `Refusing to include ${denyHits.length} file(s) that match prPathDenyList:`,
        ...denyHits.map(({ path: denyPath, pattern }) => `- ${denyPath} (matched ${pattern})`),
        'These look like secrets or agent-local config. Either gitignore them,',
        'or override on a per-path basis with --force-include <path>.',
        'Edit .project-workflow.json:prPathDenyList to adjust globally.',
      ].join('\n'));
    }

    runGit(context.repoRoot, ['add', '-A']);
    if (!hasStagedChanges(context.repoRoot)) {
      throw new Error('No staged changes were found after git add -A.');
    }
    runGit(context.repoRoot, ['commit', '-m', parsed.flags.message.trim() || prTitle]);
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

  const refreshedPr = loadPrForBranch(context.repoRoot, branchName);
  prNumber = refreshedPr?.number ?? prNumber;
  prUrl = refreshedPr?.url ?? prUrl;

  savePrRecord(context.commonDir, context.config, taskSlug, {
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
      'Next: run workflow:merge.',
    ].join('\n'),
  });
}
