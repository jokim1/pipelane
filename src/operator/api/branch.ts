import { existsSync } from 'node:fs';

import {
  loadActionState,
  loadAllTaskLocks,
  loadDeployState,
  loadPrState,
  nowIso,
  resolveWorkflowContext,
  runGit,
  type ActionRunRecord,
} from '../state.ts';
import { buildApiEnvelope, buildFreshness, type ApiEnvelope } from './envelope.ts';
import { buildBranchRows, type BranchRow } from './snapshot.ts';

export type BranchFileScope = 'branch' | 'workspace';

export interface BranchFileEntry {
  path: string;
  changeType: string;
  oldPath: string;
  scope: BranchFileScope;
  patchAvailable: boolean;
  reason: string;
}

export interface BranchDetailsData {
  branch: BranchRow;
  branchFiles: BranchFileEntry[];
  workspaceFiles: BranchFileEntry[];
  actionHistory: ActionRunRecord[];
  counts: {
    branchFiles: number;
    workspaceFiles: number;
  };
  baseBranch: string;
  freshness: ReturnType<typeof buildFreshness>;
}

export interface BranchPatchData {
  branch: string;
  path: string;
  scope: BranchFileScope;
  patch: string;
  truncated: boolean;
  reason: string;
}

const MAX_PATCH_CHARS = 50_000;

export function buildBranchDetailsEnvelope(cwd: string, branchName: string): ApiEnvelope<BranchDetailsData> {
  const checkedAt = nowIso();
  const context = resolveWorkflowContext(cwd);
  const branch = resolveBranchRow(cwd, branchName);
  const worktreePath = branch.task?.worktreePath ?? '';
  const baseRef = resolveBaseRef(context.repoRoot, context.config.baseBranch);

  const branchFiles = listBranchFiles(context.repoRoot, `${baseRef}...${branchName}`);
  const workspaceFiles = worktreePath && existsSync(worktreePath)
    ? listWorkspaceFiles(worktreePath)
    : [];
  const actionHistory = branch.task?.taskSlug
    ? loadActionState(context.commonDir, context.config).records[branch.task.taskSlug] ?? []
    : [];

  return buildApiEnvelope<BranchDetailsData>({
    command: 'pipelane.api.branch',
    ok: true,
    message: `branch details ready for ${branchName}`,
    data: {
      branch,
      branchFiles,
      workspaceFiles,
      actionHistory,
      counts: {
        branchFiles: branchFiles.length,
        workspaceFiles: workspaceFiles.length,
      },
      baseBranch: context.config.baseBranch,
      freshness: buildFreshness({ checkedAt }),
    },
  });
}

export function buildBranchPatchEnvelope(
  cwd: string,
  branchName: string,
  filePath: string,
  scope: BranchFileScope,
): ApiEnvelope<BranchPatchData> {
  const context = resolveWorkflowContext(cwd);
  const branch = resolveBranchRow(cwd, branchName);
  const worktreePath = branch.task?.worktreePath ?? '';
  const baseRef = resolveBaseRef(context.repoRoot, context.config.baseBranch);
  const checkedAt = nowIso();

  const { patch, truncated, reason } = scope === 'branch'
    ? readBranchPatch(context.repoRoot, `${baseRef}...${branchName}`, filePath)
    : readWorkspacePatch(worktreePath, filePath);

  return buildApiEnvelope<BranchPatchData>({
    command: 'pipelane.api.branch.patch',
    ok: true,
    message: reason
      ? `patch preview unavailable for ${filePath}`
      : `patch preview ready for ${filePath}`,
    data: {
      branch: branchName,
      path: filePath,
      scope,
      patch,
      truncated,
      reason,
    },
    warnings: reason ? [reason] : [],
  });
}

function resolveBranchRow(cwd: string, branchName: string): BranchRow {
  const context = resolveWorkflowContext(cwd);
  const currentBranch = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const baseBranchSha = runGit(context.repoRoot, ['rev-parse', '--verify', `origin/${context.config.baseBranch}`], true)?.trim() ?? '';
  const checkedAt = nowIso();
  const rows = buildBranchRows({
    locks: loadAllTaskLocks(context.commonDir, context.config),
    config: context.config,
    currentBranch,
    baseBranch: context.config.baseBranch,
    baseBranchSha,
    prRecords: loadPrState(context.commonDir, context.config).records,
    deployRecords: loadDeployState(context.commonDir, context.config).records,
    mode: context.modeState.mode,
    checkedAt,
  });
  const branch = rows.find((entry) => entry.name === branchName);
  if (!branch) {
    throw new Error(`No active pipelane branch named "${branchName}" found.`);
  }
  return branch;
}

function resolveBaseRef(repoRoot: string, baseBranch: string): string {
  const remoteRef = `origin/${baseBranch}`;
  const resolvedRemote = runGit(repoRoot, ['rev-parse', '--verify', remoteRef], true)?.trim();
  return resolvedRemote ? remoteRef : baseBranch;
}

function listBranchFiles(repoRoot: string, diffRef: string): BranchFileEntry[] {
  const raw = runGit(repoRoot, ['diff', '--name-status', '-z', '--find-renames', diffRef], true) ?? '';
  return parseNameStatusEntries(raw, 'branch');
}

function listWorkspaceFiles(worktreePath: string): BranchFileEntry[] {
  const trackedRaw = runGit(worktreePath, ['diff', '--name-status', '-z', '--find-renames', 'HEAD'], true) ?? '';
  const tracked = parseNameStatusEntries(trackedRaw, 'workspace');
  const untrackedRaw = runGit(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], true) ?? '';
  const untracked = untrackedRaw
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({
      path: entry,
      changeType: 'untracked',
      oldPath: '',
      scope: 'workspace' as const,
      patchAvailable: false,
      reason: 'patch preview is unavailable for untracked files',
    }));
  return [...tracked, ...untracked];
}

function parseNameStatusEntries(raw: string, scope: BranchFileScope): BranchFileEntry[] {
  if (!raw) {
    return [];
  }

  const tokens = raw.split('\0').filter((entry) => entry.length > 0);
  const entries: BranchFileEntry[] = [];

  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index] ?? '';
    index += 1;
    const statusCode = statusToken[0] ?? '';
    if (!statusCode) {
      continue;
    }

    if (statusCode === 'R' || statusCode === 'C') {
      const oldPath = tokens[index] ?? '';
      const newPath = tokens[index + 1] ?? '';
      index += 2;
      if (!newPath) continue;
      entries.push({
        path: newPath,
        changeType: statusCode === 'R' ? 'renamed' : 'copied',
        oldPath,
        scope,
        patchAvailable: true,
        reason: '',
      });
      continue;
    }

    const filePath = tokens[index] ?? '';
    index += 1;
    if (!filePath) {
      continue;
    }

    entries.push({
      path: filePath,
      changeType: mapChangeType(statusCode),
      oldPath: '',
      scope,
      patchAvailable: statusCode !== '?',
      reason: statusCode === '?' ? 'patch preview is unavailable for untracked files' : '',
    });
  }

  return entries;
}

function mapChangeType(statusCode: string): string {
  switch (statusCode) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'T':
      return 'typechange';
    case 'U':
      return 'conflicted';
    case 'M':
      return 'modified';
    default:
      return 'modified';
  }
}

function readBranchPatch(repoRoot: string, diffRef: string, filePath: string): {
  patch: string;
  truncated: boolean;
  reason: string;
} {
  const raw = runGit(
    repoRoot,
    ['diff', '--no-ext-diff', '--binary', '--unified=3', '--find-renames', diffRef, '--', filePath],
    true,
  ) ?? '';
  return normalizePatch(raw);
}

function readWorkspacePatch(worktreePath: string, filePath: string): {
  patch: string;
  truncated: boolean;
  reason: string;
} {
  if (!worktreePath || !existsSync(worktreePath)) {
    return {
      patch: '',
      truncated: false,
      reason: 'worktree no longer exists',
    };
  }

  const patch = runGit(
    worktreePath,
    ['diff', '--no-ext-diff', '--binary', '--unified=3', '--find-renames', 'HEAD', '--', filePath],
    true,
  ) ?? '';
  if (patch) {
    return normalizePatch(patch);
  }

  const tracked = runGit(worktreePath, ['ls-files', '--error-unmatch', '--', filePath], true);
  return {
    patch: '',
    truncated: false,
    reason: tracked ? 'patch preview is unavailable for this file' : 'patch preview is unavailable for untracked files',
  };
}

function normalizePatch(raw: string): {
  patch: string;
  truncated: boolean;
  reason: string;
} {
  if (!raw) {
    return {
      patch: '',
      truncated: false,
      reason: 'patch preview is unavailable for this file',
    };
  }

  if (raw.length <= MAX_PATCH_CHARS) {
    return {
      patch: raw,
      truncated: false,
      reason: '',
    };
  }

  return {
    patch: `${raw.slice(0, MAX_PATCH_CHARS)}\n…`,
    truncated: true,
    reason: '',
  };
}
