import { createHash } from 'node:crypto';

import type { DeployConfig } from '../release-gate.ts';
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

export function collectChangedPaths(repoRoot: string): string[] {
  // -z disables C-quoting and uses NUL separators, so tabs, newlines,
  // non-ASCII, and literal ` -> ` in filenames round-trip cleanly.
  const raw = runGit(repoRoot, ['status', '--porcelain', '-z'], true) ?? '';
  const entries = raw.split('\0').filter((entry) => entry.length > 0);
  const paths: string[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    // Each record is `XY<space>path`. For renames/copies (-z emits the NEW
    // name first, then the OLD name as a separate NUL-delimited entry),
    // we record the new name and skip the old one.
    const xy = entry.slice(0, 2);
    const payload = entry.length > 3 ? entry.slice(3) : '';
    if (!payload) continue;
    paths.push(payload);
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1; // consume the "from" entry that follows
    }
  }

  return paths;
}

export function findDenyListHits(
  paths: string[],
  patterns: string[],
  forceInclude: string[],
): Array<{ path: string; pattern: string }> {
  const forced = new Set(forceInclude.map((entry) => entry.trim()).filter(Boolean));
  const hits: Array<{ path: string; pattern: string }> = [];
  for (const entry of paths) {
    if (forced.has(entry)) continue;
    const basename = entry.includes('/') ? entry.slice(entry.lastIndexOf('/') + 1) : entry;
    for (const pattern of patterns) {
      if (matchesDenyPattern(pattern, basename) || matchesDenyPattern(pattern, entry)) {
        hits.push({ path: entry, pattern });
        break;
      }
    }
  }
  return hits;
}

function matchesDenyPattern(pattern: string, candidate: string): boolean {
  const regex = new RegExp(`^${escapeForDenyRegex(pattern)}$`);
  return regex.test(candidate);
}

function escapeForDenyRegex(pattern: string): string {
  return pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}

export function hasStagedChanges(repoRoot: string): boolean {
  return Boolean(runGit(repoRoot, ['diff', '--cached', '--name-only'], true)?.trim());
}

export function makeIdempotencyKey(options: {
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  taskSlug: string;
  // v1.2: rolling the deploy config (healthcheck URL, deploy workflow,
  // staging URL) should force a re-dispatch rather than short-circuit on a
  // stale succeeded record. Include it in the key so different configs
  // produce different keys naturally.
  configFingerprint?: string;
}): string {
  const canonical = JSON.stringify({
    environment: options.environment,
    sha: options.sha,
    surfaces: [...options.surfaces].sort(),
    taskSlug: options.taskSlug,
    configFingerprint: options.configFingerprint ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

export function resolveHealthcheckUrl(
  deployConfig: DeployConfig,
  environment: 'staging' | 'prod',
): string {
  // Kept for legacy call sites. Prefer `resolveSurfaceHealthcheckUrl` so
  // each surface gets its own probe.
  return resolveSurfaceHealthcheckUrl(deployConfig, environment, 'frontend');
}

// v1.2: per-surface probe URL. Multi-surface staging deploys now probe each
// surface separately so edge/sql can't inherit readiness from a frontend-only
// healthcheck. Returns '' when the surface has no probe configured; the
// caller decides whether to treat that as unverified.
export function resolveSurfaceHealthcheckUrl(
  deployConfig: DeployConfig,
  environment: 'staging' | 'prod',
  surface: string,
): string {
  const staging = environment === 'staging';
  if (surface === 'frontend') {
    const fe = staging ? deployConfig.frontend.staging : deployConfig.frontend.production;
    return fe.healthcheckUrl || fe.url || '';
  }
  if (surface === 'edge') {
    const edge = staging ? deployConfig.edge.staging : deployConfig.edge.production;
    return edge.healthcheckUrl || '';
  }
  if (surface === 'sql') {
    const sql = staging ? deployConfig.sql.staging : deployConfig.sql.production;
    return sql.healthcheckUrl || '';
  }
  return '';
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
  state?: string | null;
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
} {
  const output = runGh(repoRoot, [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,url,state,mergeCommit,mergedAt',
  ]);
  return parseJsonOrThrow(output, `Could not parse PR details for #${prNumber}.`);
}

export interface PollForMergedShaOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function pollForMergedSha(
  repoRoot: string,
  prNumber: number,
  options: PollForMergedShaOptions = {},
): Promise<{ sha: string; mergedAt: string | null; title: string; url: string; number: number }> {
  const timeoutMs = options.timeoutMs ?? envNumber('PIPELANE_MERGE_POLL_TIMEOUT_MS', 30_000);
  const intervalMs = options.intervalMs ?? envNumber('PIPELANE_MERGE_POLL_INTERVAL_MS', 1_000);
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  let lastState: string | null = null;
  let lastDetails: ReturnType<typeof loadPrDetails> | null = null;

  while (Date.now() <= deadline) {
    const details = loadPrDetails(repoRoot, prNumber);
    lastDetails = details;
    lastState = details.state ?? null;
    const sha = details.mergeCommit?.oid?.trim();
    if (sha && details.state === 'MERGED') {
      return {
        sha,
        mergedAt: details.mergedAt ?? null,
        title: details.title,
        url: details.url,
        number: details.number,
      };
    }
    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }

  const suffix = lastDetails
    ? ` Last state: ${lastState ?? 'unknown'}, mergeCommit.oid: ${lastDetails.mergeCommit?.oid ?? 'none'}.`
    : '';
  throw new Error(
    `Timed out waiting for GitHub to report PR #${prNumber} as MERGED with a merge commit within ${timeoutMs}ms.${suffix}`,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
