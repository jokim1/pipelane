import { printResult, resolveWorkflowContext, loadTaskLock, type ParsedOperatorArgs } from '../state.ts';
import { resolveTaskCommandIdentity } from '../task-workspaces.ts';
import { verifyTaskLockState } from '../repo-guard.ts';
import { runGit } from '../state.ts';

export async function handleTaskLock(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const action = parsed.positional[0];
  if (action !== 'verify') {
    throw new Error('task-lock requires the "verify" action.');
  }

  if (!parsed.flags.task.trim()) {
    throw new Error('task-lock verify requires --task <task-name>.');
  }

  const context = resolveWorkflowContext(cwd);
  const { taskSlug } = resolveTaskCommandIdentity(parsed.flags.task);
  const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
  if (!lock) {
    throw new Error(`No task lock found for ${taskSlug}.`);
  }

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const mismatches = verifyTaskLockState({
    branchName,
    repoRoot: context.repoRoot,
    requestedMode: parsed.flags.mode,
    currentMode: context.modeState.mode,
    lock,
  });

  printResult(parsed.flags, {
    ok: mismatches.length === 0,
    lock,
    mismatches,
    message: mismatches.length === 0
      ? [
        'Task lock verified.',
        `Task: ${taskSlug}`,
        `Branch: ${branchName}`,
        `Worktree: ${context.repoRoot}`,
      ].join('\n')
      : [
        'Task lock mismatch.',
        `Task: ${taskSlug}`,
        ...mismatches.map((mismatch) => `- ${mismatch}`),
      ].join('\n'),
  });

  if (mismatches.length > 0) {
    process.exitCode = 1;
  }
}
