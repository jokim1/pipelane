import type { WorkflowContext } from '../state.ts';
import {
  DEFAULT_MODE,
  loadAllTaskLocks,
  loadTaskLock,
  normalizePath,
  parseSurfaceList,
  runCommandCapture,
  runGh,
  runGit,
  slugifyTaskName,
  type PrRecord,
  type TaskLock,
} from '../state.ts';
import { verifyTaskLockState } from '../repo-guard.ts';

export function resolveCommandSurfaces(
  context: WorkflowContext,
  explicit: string[] = [],
  fallback: string[] = [],
): string[] {
  if (explicit.length > 0) {
    return parseSurfaceList(context.config, explicit);
  }

  if (fallback.length > 0) {
    return fallback.filter((surface) => context.config.surfaces.includes(surface));
  }

  if (context.modeState.requestedSurfaces.length > 0) {
    return context.modeState.requestedSurfaces.filter((surface) => context.config.surfaces.includes(surface));
  }

  return [...context.config.surfaces];
}

export function inferActiveTaskLock(context: WorkflowContext, explicitTask = ''): { taskSlug: string; lock: TaskLock } {
  if (explicitTask.trim()) {
    const taskSlug = slugifyTaskName(explicitTask);
    const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
    if (!lock) {
      throw new Error(`No task lock found for ${taskSlug}.`);
    }
    return { taskSlug, lock };
  }

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const repoPath = normalizePath(context.repoRoot);
  const matches = loadAllTaskLocks(context.commonDir, context.config).filter((lock) =>
    lock.branchName === branchName && normalizePath(lock.worktreePath) === repoPath
  );

  if (matches.length === 1) {
    return {
      taskSlug: matches[0].taskSlug,
      lock: matches[0],
    };
  }

  if (matches.length > 1) {
    throw new Error(`Multiple task locks match ${branchName} at ${context.repoRoot}. Pass --task explicitly.`);
  }

  throw new Error(`No task lock matches branch ${branchName} at ${context.repoRoot}. Run workflow:new or pass --task.`);
}

export function ensureTaskLockMatchesCurrent(context: WorkflowContext, lock: TaskLock, requestedMode = ''): void {
  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const mismatches = verifyTaskLockState({
    branchName,
    repoRoot: context.repoRoot,
    requestedMode,
    currentMode: context.modeState.mode ?? DEFAULT_MODE,
    lock,
  });

  if (mismatches.length > 0) {
    throw new Error([
      'Task lock mismatch.',
      ...mismatches.map((mismatch) => `- ${mismatch}`),
    ].join('\n'));
  }
}

export function latestCommitSubject(repoRoot: string): string {
  return runGit(repoRoot, ['log', '-1', '--pretty=%s']) ?? 'Update workflow task';
}

export function hasStagedChanges(repoRoot: string): boolean {
  return Boolean(runGit(repoRoot, ['diff', '--cached', '--name-only'], true)?.trim());
}

export function buildPrBody(title: string, checks: string[]): string {
  return [
    '## Summary',
    `- ${title}`,
    '',
    '## Testing',
    ...checks.map((entry) => `- ${entry}`),
  ].join('\n');
}

function parseJsonOrThrow<T>(text: string | null, fallback: string): T {
  if (!text) {
    throw new Error(fallback);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(fallback);
  }
}

export function loadPrForBranch(repoRoot: string, branchName: string): { number: number; title: string; url: string } | null {
  const output = runGh(repoRoot, [
    'pr',
    'list',
    '--state',
    'all',
    '--head',
    branchName,
    '--json',
    'number,title,url,state,baseRefName,headRefName',
  ], true);

  if (!output) {
    return null;
  }

  const prs = parseJsonOrThrow<Array<{ number: number; title: string; url: string }>>(output, `Could not parse PR list for ${branchName}.`);
  return prs[0] ?? null;
}

export function loadPrDetails(repoRoot: string, prNumber: number): {
  number: number;
  title: string;
  url: string;
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
} {
  const output = runGh(repoRoot, [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,url,mergeCommit,mergedAt',
  ]);
  return parseJsonOrThrow(output, `Could not parse PR details for #${prNumber}.`);
}

export function watchPrChecks(repoRoot: string, prNumber: number): void {
  const probe = runCommandCapture('gh', ['pr', 'checks', String(prNumber), '--required'], {
    cwd: repoRoot,
  });

  if (!probe.ok && /no required checks reported/i.test(probe.stderr)) {
    runCommandCapture('gh', ['pr', 'checks', String(prNumber), '--watch', '--fail-fast'], {
      cwd: repoRoot,
    });
    return;
  }

  runCommandCapture('gh', ['pr', 'checks', String(prNumber), '--required', '--watch', '--fail-fast'], {
    cwd: repoRoot,
  });
}

export function resolveDeployTargetForTask(options: {
  repoRoot: string;
  baseBranch: string;
  explicitSha: string;
  prRecord: PrRecord | null;
  mode: string;
}): { sha: string; ref: string } {
  if (options.mode === 'release') {
    if (options.explicitSha.trim()) {
      throw new Error('Release mode deploys cannot use --sha. Use the recorded merged SHA from workflow:merge.');
    }

    if (!options.prRecord?.mergedSha) {
      throw new Error('No merged SHA recorded for this task. Run workflow:merge first.');
    }

    return {
      sha: options.prRecord.mergedSha,
      ref: 'pr-state',
    };
  }

  if (options.explicitSha.trim()) {
    const resolved = runGit(options.repoRoot, ['rev-parse', '--verify', options.explicitSha.trim()], true);
    if (!resolved) {
      throw new Error(`Could not resolve ${options.explicitSha.trim()}.`);
    }
    return {
      sha: resolved.trim(),
      ref: '--sha',
    };
  }

  if (options.prRecord?.mergedSha) {
    return {
      sha: options.prRecord.mergedSha,
      ref: 'pr-state',
    };
  }

  const originRef = `origin/${options.baseBranch}`;
  const originSha = runGit(options.repoRoot, ['rev-parse', '--verify', originRef], true);
  if (originSha) {
    return {
      sha: originSha.trim(),
      ref: originRef,
    };
  }

  const localSha = runGit(options.repoRoot, ['rev-parse', '--verify', options.baseBranch], true);
  if (localSha) {
    return {
      sha: localSha.trim(),
      ref: options.baseBranch,
    };
  }

  throw new Error(`Could not resolve a deploy target from ${options.baseBranch}.`);
}
