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
  applyTaskBindingRecovery,
  diagnoseTaskBinding,
  formatTaskBindingRecoveryMessage,
} from '../task-binding.ts';
import {
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
  type ParsedOperatorArgs,
  type TaskLock,
} from '../state.ts';

export async function handlePr(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
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
      throw new Error(`Release mode is not ready. Run ${formatWorkflowCommand(context.config, 'status')} for blockers, then ${formatWorkflowCommand(context.config, 'devmode', 'release')} after fixing readiness.`);
    }
  }

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const statusText = runGit(context.repoRoot, ['status', '--short'], true) ?? '';
  const dirty = statusText.trim().length > 0;
  const existingPr = loadPrForBranch(context.repoRoot, branchName);
  let prTitle = parsed.flags.title.trim();

  if (!existingPr && !prTitle && dirty) {
    throw new Error(`${formatWorkflowCommand(context.config, 'pr')} requires --title for a new PR when the worktree is dirty.`);
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
        'Edit .pipelane.json:prPathDenyList to adjust globally.',
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
      `Next: run ${formatWorkflowCommand(context.config, 'merge')}.`,
    ].join('\n'),
  });
}

function resolvePrTaskBinding(
  context: ReturnType<typeof resolveWorkflowContext>,
  parsed: ParsedOperatorArgs,
):
  | { status: 'resolved'; taskSlug: string; lock: TaskLock }
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
    };
  }

  const diagnosis = diagnoseTaskBinding(context, parsed.flags.task);
  if (diagnosis.status === 'resolved') {
    return {
      status: 'resolved',
      taskSlug: diagnosis.taskSlug,
      lock: diagnosis.lock,
    };
  }
  if (diagnosis.status === 'needs-recovery') {
    return { status: 'needs-recovery', diagnosis };
  }
  return { status: 'blocked', reason: diagnosis.reason };
}
