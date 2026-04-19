import { existsSync } from 'node:fs';

import type { DeployRecord, PrRecord, TaskLock, WorkflowConfig } from '../state.ts';
import {
  DEFAULT_MODE,
  loadAllTaskLocks,
  loadDeployState,
  loadPrState,
  nowIso,
  resolveWorkflowContext,
  runGit,
} from '../state.ts';
import {
  buildApiActionState,
  buildApiEnvelope,
  buildApiStatusCell,
  buildFreshness,
  buildSourceHealthEntry,
  type ApiActionState,
  type ApiEnvelope,
  type ApiStatusCell,
  type LaneState,
  type SourceHealthEntry,
} from './envelope.ts';

export interface BranchLanes {
  local: ApiStatusCell;
  pr: ApiStatusCell;
  base: ApiStatusCell;
  staging: ApiStatusCell;
  production: ApiStatusCell;
}

export interface BranchRow {
  name: string;
  status: string;
  current: boolean;
  note: string;
  task: {
    taskSlug: string;
    mode: string;
    worktreePath: string;
    updatedAt: string | null;
    // v1.3: persistent breadcrumb surfaced by /status and /resume. Written
    // by state-mutating commands (pr/merge/deploy). Null when the lock
    // hasn't been touched by a state mutation yet.
    nextAction: string | null;
  } | null;
  surfaces: string[];
  cleanup: { available: boolean; eligible: boolean; reason: string };
  pr: {
    number: number | null;
    state: 'OPEN' | 'MERGED' | 'CLOSED' | null;
    url: string | null;
    title: string | null;
    mergedAt: string | null;
  } | null;
  mergedSha: string | null;
  lanes: BranchLanes;
  availableActions: ApiActionState[];
}

export interface SnapshotData {
  boardContext: {
    mode: string;
    baseBranch: string;
    laneOrder: string[];
    releaseReadiness: {
      state: LaneState;
      reason: string;
      requestedSurfaces: string[];
      blockedSurfaces: string[];
      effectiveOverride: null | { reason: string; timestamp: string };
      // v1.5: durable audit trail of the most recent override. Persists
      // across mode=build flips so the cockpit can keep flagging "this
      // repo has a history of bypassing the gate" long after the active
      // override is switched off. Null when no override has ever been
      // recorded, or after a fresh mode-state.json.
      lastOverride: null | { reason: string; setAt: string; setBy: string };
      localReady: boolean;
      hostedReady: boolean;
      freshness: ReturnType<typeof buildFreshness>;
      message: string;
    };
    activeTask: null | {
      taskSlug: string;
      branchName: string;
      worktreePath: string;
      mode: string;
      surfaces: string[];
      updatedAt: string | null;
    };
    overallFreshness: ReturnType<typeof buildFreshness>;
  };
  sourceHealth: SourceHealthEntry[];
  attention: unknown[];
  availableActions: ApiActionState[];
  branches: BranchRow[];
}

export function buildWorkflowApiSnapshot(cwd: string): ApiEnvelope<SnapshotData> {
  const context = resolveWorkflowContext(cwd);
  const baseBranch = context.config.baseBranch;
  const currentBranch = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const mode = context.modeState.mode ?? DEFAULT_MODE;
  const checkedAt = nowIso();

  const locks = loadAllTaskLocks(context.commonDir, context.config);
  const prState = loadPrState(context.commonDir, context.config);
  const deployState = loadDeployState(context.commonDir, context.config);
  const baseBranchSha = runGit(context.repoRoot, ['rev-parse', '--verify', `origin/${baseBranch}`], true)?.trim() ?? '';

  const branches: BranchRow[] = locks.map((lock) =>
    buildBranchRow({
      lock,
      config: context.config,
      currentBranch,
      baseBranch,
      baseBranchSha,
      prRecord: prState.records[lock.taskSlug] ?? null,
      deployRecords: deployState.records,
      mode,
      checkedAt,
    }),
  );

  const activeLock = locks.find((lock) => lock.branchName === currentBranch) ?? null;

  const sourceHealth: SourceHealthEntry[] = [
    buildSourceHealthEntry({
      name: 'git.local',
      reason: 'local branches and worktrees loaded',
      checkedAt,
    }),
    buildSourceHealthEntry({
      name: 'task-locks',
      reason: locks.length === 0 ? 'no active task locks' : `${locks.length} active task lock(s)`,
      checkedAt,
    }),
  ];

  const boardMessage = mode === 'release'
    ? 'Release mode: promote merged SHA through staging before prod.'
    : 'Build mode: production deploys run automatically after merge.';

  return buildApiEnvelope<SnapshotData>({
    command: 'workflow.api.snapshot',
    ok: true,
    message: 'pipelane workflow snapshot ready',
    data: {
      boardContext: {
        mode,
        baseBranch,
        laneOrder: ['Local', 'PR', `Base: ${baseBranch}`, 'Staging', 'Production'],
        releaseReadiness: {
          state: 'unknown',
          reason: 'release readiness not yet computed in pipelane snapshot',
          requestedSurfaces: context.modeState.requestedSurfaces ?? [],
          blockedSurfaces: [],
          effectiveOverride: context.modeState.override ?? null,
          lastOverride: context.modeState.lastOverride ?? null,
          localReady: false,
          hostedReady: false,
          freshness: buildFreshness({ checkedAt }),
          message: boardMessage,
        },
        activeTask: activeLock
          ? {
            taskSlug: activeLock.taskSlug,
            branchName: activeLock.branchName,
            worktreePath: activeLock.worktreePath,
            mode: activeLock.mode,
            surfaces: activeLock.surfaces ?? [],
            updatedAt: activeLock.updatedAt ?? null,
          }
          : null,
        overallFreshness: buildFreshness({ checkedAt }),
      },
      sourceHealth,
      attention: [],
      availableActions: [],
      branches,
    },
  });
}

function buildBranchRow(options: {
  lock: TaskLock;
  config: WorkflowConfig;
  currentBranch: string;
  baseBranch: string;
  baseBranchSha: string;
  prRecord: PrRecord | null;
  deployRecords: DeployRecord[];
  mode: string;
  checkedAt: string;
}): BranchRow {
  const { lock, currentBranch, baseBranch, baseBranchSha, prRecord, deployRecords, mode, checkedAt } = options;
  const worktreeExists = existsSync(lock.worktreePath);
  const dirty = worktreeExists ? isWorktreeDirty(lock.worktreePath) : false;
  const isMerged = Boolean(prRecord?.mergedSha);

  const localCell: ApiStatusCell = !worktreeExists
    ? buildApiStatusCell({ state: 'unknown', reason: 'worktree no longer exists', detail: lock.worktreePath, checkedAt, stale: true })
    : dirty
      ? buildApiStatusCell({ state: 'blocked', reason: 'dirty worktree', detail: lock.worktreePath, checkedAt, stale: true })
      : buildApiStatusCell({ state: 'healthy', reason: 'clean worktree', detail: lock.worktreePath, checkedAt });

  const prCell: ApiStatusCell = prRecord?.mergedAt
    ? buildApiStatusCell({ state: 'healthy', reason: `PR #${prRecord.number ?? '?'} merged`, checkedAt })
    : prRecord
      ? buildApiStatusCell({ state: 'running', reason: `PR #${prRecord.number ?? '?'} is open against ${baseBranch}`, checkedAt })
      : buildApiStatusCell({ state: 'awaiting_preflight', reason: 'no PR opened yet', checkedAt });

  const baseCell: ApiStatusCell = isMerged
    ? buildApiStatusCell({
      state: prRecord?.mergedSha === baseBranchSha ? 'healthy' : 'running',
      reason: prRecord?.mergedSha === baseBranchSha
        ? `merged SHA is tip of ${baseBranch}`
        : `merged SHA ${shortSha(prRecord?.mergedSha ?? '')} landed; waiting for downstream`,
      detail: `Base: ${baseBranch}`,
      checkedAt,
    })
    : buildApiStatusCell({ state: 'awaiting_preflight', reason: 'branch has not landed on base', detail: `Base: ${baseBranch}`, checkedAt });

  const stagingCell = buildDeployCell({
    environment: 'staging',
    mode,
    mergedSha: prRecord?.mergedSha,
    deployRecords,
    checkedAt,
  });

  const productionCell = buildDeployCell({
    environment: 'prod',
    mode,
    mergedSha: prRecord?.mergedSha,
    deployRecords,
    checkedAt,
  });

  const note = !worktreeExists
    ? `worktree missing at ${lock.worktreePath}`
    : dirty
      ? `dirty worktree at ${lock.worktreePath}`
      : prRecord?.mergedAt
        ? `PR #${prRecord.number ?? '?'} merged`
        : prRecord
          ? `PR #${prRecord.number ?? '?'} is open`
          : 'task in progress';

  const status = !worktreeExists
    ? 'missing-worktree'
    : dirty
      ? 'dirty-local'
      : prRecord?.mergedAt
        ? 'merged'
        : prRecord
          ? 'open-pr'
          : 'local-only';

  return {
    name: lock.branchName,
    status,
    current: lock.branchName === currentBranch,
    note,
    task: {
      taskSlug: lock.taskSlug,
      mode: lock.mode,
      worktreePath: lock.worktreePath,
      updatedAt: lock.updatedAt ?? null,
      nextAction: lock.nextAction ?? null,
    },
    surfaces: lock.surfaces ?? [],
    cleanup: {
      available: !worktreeExists,
      eligible: !worktreeExists && !dirty,
      reason: !worktreeExists ? 'worktree already gone' : dirty ? 'dirty worktree' : 'workspace still active',
    },
    pr: prRecord
      ? {
        number: prRecord.number ?? null,
        state: prRecord.mergedAt ? 'MERGED' : 'OPEN',
        url: prRecord.url ?? null,
        title: prRecord.title,
        mergedAt: prRecord.mergedAt ?? null,
      }
      : null,
    mergedSha: prRecord?.mergedSha ?? null,
    lanes: {
      local: localCell,
      pr: prCell,
      base: baseCell,
      staging: stagingCell,
      production: productionCell,
    },
    availableActions: [],
  };
}

function buildDeployCell(options: {
  environment: 'staging' | 'prod';
  mode: string;
  mergedSha: string | undefined;
  deployRecords: DeployRecord[];
  checkedAt: string;
}): ApiStatusCell {
  const { environment, mode, mergedSha, deployRecords, checkedAt } = options;

  if (environment === 'staging' && mode === 'build') {
    return buildApiStatusCell({
      state: 'bypassed',
      reason: 'build mode skips staging; production deploys on merge',
      checkedAt,
    });
  }

  if (!mergedSha) {
    return buildApiStatusCell({
      state: 'awaiting_preflight',
      reason: `merge the branch before ${environment === 'prod' ? 'production' : 'staging'} deploy`,
      checkedAt,
    });
  }

  const matching = deployRecords
    .filter((record) => record.environment === environment && record.sha === mergedSha)
    .sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));

  if (matching.length === 0) {
    return buildApiStatusCell({
      state: 'awaiting_preflight',
      reason: `no ${environment} deploy recorded for merged SHA ${shortSha(mergedSha)}`,
      checkedAt,
    });
  }

  const latest = matching[0];
  const cellState: LaneState = latest.status === 'succeeded'
    ? 'healthy'
    : latest.status === 'failed'
      ? 'blocked'
      : latest.status === 'requested'
        ? 'running'
        : 'unknown';
  const reason = latest.status === 'succeeded'
    ? `${environment} deploy verified for merged SHA ${shortSha(mergedSha)}`
    : latest.status === 'failed'
      ? `${environment} deploy failed: ${latest.failureReason ?? 'see deploy-state'}`
      : latest.status === 'requested'
        ? `${environment} deploy in flight for merged SHA ${shortSha(mergedSha)}`
        : `${environment} deploy recorded (legacy) for merged SHA ${shortSha(mergedSha)}`;

  return buildApiStatusCell({
    state: cellState,
    reason,
    detail: latest.requestedAt,
    checkedAt,
  });
}

function isWorktreeDirty(worktreePath: string): boolean {
  const output = runGit(worktreePath, ['status', '--porcelain'], true);
  if (output === null) return false;
  return output.trim().length > 0;
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : '';
}
