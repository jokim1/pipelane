import { existsSync } from 'node:fs';

import type { DeployRecord, PrRecord, ProbeState, ReviewRunRecord, TaskLock, WorkflowConfig } from '../state.ts';
import {
  DEFAULT_MODE,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadDeployState,
  loadReviewState,
  loadPrState,
  loadProbeState,
  nowIso,
  resolveWorkflowContext,
  runGit,
} from '../state.ts';
import {
  computeDeployConfigFingerprint,
  disqualifyDeployRecord,
  emptyDeployConfig,
  evaluateReleaseReadiness,
  explainSurfaceProbe,
  isReleaseManagedSurface,
  loadDeployConfig,
  resolveDeployStateKey,
  resolveSurfaceProbeUrl,
  unsupportedSurfaceReason,
  type DeployConfig,
  type ReleaseReadinessBlocker,
  type ProbeFreshnessState,
  type ProbeSurfaceFreshness,
} from '../release-gate.ts';
import {
  observeFrontendRuntime,
  type FrontendRuntimeObservation,
} from '../runtime-observation.ts';
import { TASK_LOCK_MIN_PRUNE_AGE_MS } from '../task-workspaces.ts';
import {
  isActiveOrchestrationRun,
  missingRelevantSliceWorktreeDiagnostic,
  ORCHESTRATION_CORRUPT_LEDGER_BLOCK_AGE_MS,
  scanOrchestrationRunDiagnostics,
  sliceReviewFullySatisfied,
  type OrchestrationMissingWorktreeDiagnostic,
  type OrchestrationReviewSatisfactionOptions,
  type OrchestrationRunRecord,
  type OrchestrationRunScanDiagnostics,
  type OrchestrationRunStatus,
  type OrchestrationSliceRecord,
} from '../orchestration-ledger.ts';
import {
  blockingAiReviewEvidenceBlocker,
  type ReviewIndependenceLabel,
} from '../review-identity.ts';
import {
  buildApiActionState,
  buildApiEnvelope,
  buildApiIssue,
  buildApiStatusCell,
  buildFreshness,
  buildSourceHealthEntry,
  type ApiActionState,
  type ApiEnvelope,
  type ApiIssue,
  type ApiStatusCell,
  type LaneState,
  type ShellLayerHealth,
  type ShellRelationshipState,
  type SourceHealthEntry,
} from './envelope.ts';
import { evaluateReviewEvidenceForPr, type ReviewEvidenceCheckResult } from '../review-enforcement.ts';

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
  cleanup: {
    available: boolean;
    eligible: boolean;
    reason: string;
    stale: boolean;
    tag: string;
    evidence: string[];
  };
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

export interface CheckoutTruthLayer {
  label: string;
  health: ShellLayerHealth;
  sha: string | null;
  reason: string;
  detail: string;
  freshness: ReturnType<typeof buildFreshness>;
}

export interface CheckoutTruthRelationship {
  state: ShellRelationshipState;
  reason: string;
}

export interface CurrentCheckoutTruth {
  branchName: string;
  baseBranch: string;
  taskSlug: string | null;
  nextAction: string | null;
  summary: string;
  layers: {
    worktree: CheckoutTruthLayer;
    origin: CheckoutTruthLayer;
    deploy: CheckoutTruthLayer;
    runtime: CheckoutTruthLayer;
  };
  relationships: {
    worktreeToOrigin: CheckoutTruthRelationship;
    deployToOrigin: CheckoutTruthRelationship;
    runtimeToDeploy: CheckoutTruthRelationship;
    runtimeToOrigin: CheckoutTruthRelationship;
  };
}

export interface OrchestrationSliceSummary {
  id: string;
  status: OrchestrationSliceRecord['status'];
  provider: OrchestrationSliceRecord['provider'];
  outcome: string;
  branchName: string | null;
  worktreePath: string | null;
  workerStatus: NonNullable<OrchestrationSliceRecord['worker']>['status'] | null;
  reviewStatus: NonNullable<OrchestrationSliceRecord['review']>['run']['status'] | null;
  reviewIndependence: ReviewIndependenceLabel | null;
  reviewEvidenceLabel: string;
  trustedReviewComplete: boolean;
  missingWorktree: OrchestrationMissingWorktreeDiagnostic | null;
}

export type OrchestrationMissingWorktreeSummary = OrchestrationMissingWorktreeDiagnostic;

export interface OrchestrationActionSummary {
  id: string;
  label: string;
  state: LaneState;
  reason: string;
  command: string;
  risky: boolean;
  requiresConfirmation: boolean;
}

export interface OrchestrationInboxItem {
  id: string;
  runId: string;
  sliceId: string | null;
  severity: ApiIssue['severity'];
  title: string;
  message: string;
  action: OrchestrationActionSummary | null;
}

export interface OrchestrationRunSummary {
  id: string;
  status: OrchestrationRunStatus;
  state: LaneState;
  title: string;
  planPath: string | null;
  createdAt: string;
  updatedAt: string;
  sliceCount: number;
  counts: {
    planned: number;
    prepared: number;
    dispatched: number;
    running: number;
    blocked: number;
    completed: number;
    failed: number;
    workerSucceeded: number;
    reviewPassed: number;
    trustedReviewComplete: number;
  };
  providerCounts: Record<string, number>;
  nextAction: OrchestrationActionSummary | null;
  missingWorktrees: OrchestrationMissingWorktreeSummary[];
  slices: OrchestrationSliceSummary[];
}

export interface OrchestrationSnapshot {
  activeRun: OrchestrationRunSummary | null;
  runs: OrchestrationRunSummary[];
  humanInbox: OrchestrationInboxItem[];
  availableActions: OrchestrationActionSummary[];
  corruptLedgers: {
    runId: string;
    ledgerPath: string;
    reason: string;
    mtimeMs: number | null;
    recent: boolean;
  }[];
  invalidRunDirectories: {
    runId: string;
    directoryPath: string;
    ledgerPath: string | null;
    reason: string;
    mtimeMs: number | null;
  }[];
}

export interface SnapshotData {
  boardContext: {
    mode: string;
    baseBranch: string;
    aliases?: WorkflowConfig['aliases'];
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
      // v1.2: rollup of per-surface staging probes. `healthy` = every
      // configured staging probe succeeded within PROBE_STALE_MS;
      // `degraded` = at least one probe's most recent record failed;
      // `stale` = at least one probe is past the 24h threshold; `unknown`
      // = no probes recorded yet, or no probe targets configured. Drives
      // the cockpit probe banner and the attention[] blocker rows.
      probeState: ProbeFreshnessState;
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
    currentCheckout: CurrentCheckoutTruth;
    overallFreshness: ReturnType<typeof buildFreshness>;
  };
  review: {
    latest: ReviewRunRecord | null;
  };
  orchestration: OrchestrationSnapshot;
  sourceHealth: SourceHealthEntry[];
  attention: unknown[];
  availableActions: ApiActionState[];
  branches: BranchRow[];
}

export async function buildWorkflowApiSnapshot(cwd: string): Promise<ApiEnvelope<SnapshotData>> {
  const context = resolveWorkflowContext(cwd);
  const baseBranch = context.config.baseBranch;
  const currentBranch = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const currentHeadSha = runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '';
  const mode = context.modeState.mode ?? DEFAULT_MODE;
  const checkedAt = nowIso();

  const locks = loadAllTaskLocks(context.commonDir, context.config);
  const prState = loadPrState(context.commonDir, context.config);
  const deployState = loadDeployState(context.commonDir, context.config);
  const reviewState = loadReviewState(context.commonDir, context.config);
  const reviewEvidence = evaluateReviewEvidenceForPr(context);
  const reviewHealth = summarizeReviewEvidenceHealth(reviewEvidence);
  const orchestrationScan = scanOrchestrationRunDiagnostics(context.commonDir, context.config);
  const orchestration = buildOrchestrationSnapshot(context.commonDir, context.config, currentBranch, orchestrationScan);
  const orchestrationHealth = summarizeOrchestrationHealth(orchestration);
  const probeState = loadProbeState(context.commonDir, context.config);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const requestedSurfaces = context.modeState.requestedSurfaces ?? context.config.surfaces;
  const surfaceProbes = collectSurfaceProbes({
    deployConfig,
    probeState,
    surfaces: requestedSurfaces,
  });
  const probeRollup = rollupProbeState(surfaceProbes);
  const baseBranchSha = runGit(context.repoRoot, ['rev-parse', '--verify', `origin/${baseBranch}`], true)?.trim() ?? '';
  const runtimeObservation = await observeFrontendRuntime({
    deployConfig,
    environment: 'prod',
  });
  const activeLock = locks.find((lock) => lock.branchName === currentBranch) ?? null;
  const currentPrRecord = activeLock ? prState.records[activeLock.taskSlug] ?? null : null;
  const branches = buildBranchRows({
    locks,
    config: context.config,
    repoRoot: context.repoRoot,
    currentBranch,
    baseBranch,
    baseBranchSha,
    prRecords: prState.records,
    deployRecords: deployState.records,
    mode,
    checkedAt,
  });

  const worktreeToOriginAnalysis = analyzeWorktreeToOrigin({
    repoRoot: context.repoRoot,
    currentBranch,
    baseBranch,
    worktreeSha: currentHeadSha || null,
    originSha: baseBranchSha || null,
  });
  const currentCheckout = buildCurrentCheckoutTruth({
    checkedAt,
    currentBranch,
    currentHeadSha,
    baseBranch,
    baseBranchSha,
    activeLock,
    currentPrRecord,
    deployRecords: deployState.records,
    deployConfig,
    runtimeObservation,
    worktreeToOrigin: worktreeToOriginAnalysis.relationship,
  });

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
    buildSourceHealthEntry({
      name: 'orchestration.runs',
      state: orchestrationHealth.state,
      blocking: orchestrationHealth.blocking,
      reason: orchestrationHealth.reason,
      checkedAt,
      observedAt: orchestrationHealth.observedAt,
    }),
    ...surfaceProbes.map((entry) => buildSourceHealthEntry({
      name: `deployProbe.${entry.surface}`,
      state: mapProbeStateToLaneState(entry.result.state),
      blocking:
        entry.result.state === 'stale'
        || entry.result.state === 'degraded'
        || isUnsupportedSurfaceProbe(entry),
      reason: describeSurfaceProbe(entry),
      checkedAt,
      observedAt: entry.result.probe?.probedAt,
      stale: entry.result.state === 'stale',
    })),
    buildSourceHealthEntry({
      name: 'runtime.frontend.production',
      state: mapShellHealthToLaneState(runtimeObservation.health),
      // Runtime provenance is advisory: it helps explain what is live in
      // production, but it is not itself a promotion gate.
      blocking: false,
      reason: runtimeObservation.reason,
      checkedAt,
      observedAt: runtimeObservation.observedAt,
    }),
    buildSourceHealthEntry({
      name: 'review.latest',
      state: reviewHealth.state,
      blocking: reviewHealth.blocking,
      reason: reviewHealth.reason,
      checkedAt,
      observedAt: reviewHealth.observedAt,
    }),
  ];

  const attention: ApiIssue[] = [];
  for (const entry of surfaceProbes) {
    if (isUnsupportedSurfaceProbe(entry)) {
      attention.push(buildApiIssue({
        code: 'surface.unsupported',
        severity: 'error',
        message: `staging ${entry.surface}: ${entry.result.reason}`,
        source: 'deployConfig',
        blocking: true,
        lane: 'staging',
        action: 'doctor.diagnose',
      }));
      continue;
    }
    if (entry.result.state !== 'stale' && entry.result.state !== 'degraded') continue;
    attention.push(buildApiIssue({
      code: entry.result.state === 'degraded' ? 'probe.degraded' : 'probe.stale',
      severity: entry.result.state === 'degraded' ? 'error' : 'warning',
      message: `staging ${entry.surface} probe ${entry.result.state}: ${entry.result.reason}. Run \`${formatWorkflowCommand(context.config, 'doctor', '--probe')}\`.`,
      source: 'probeState',
      blocking: true,
      lane: 'staging',
      action: 'doctor.probe',
    }));
  }
  const staleBaseIssue = buildStaleBaseIssue({
    baseBranch,
    analysis: worktreeToOriginAnalysis,
  });
  if (staleBaseIssue) {
    attention.push(staleBaseIssue);
  }
  const runtimeDriftIssue = buildRuntimeDriftIssue({
    deployConfig,
    currentCheckout,
  });
  if (runtimeDriftIssue) {
    attention.push(runtimeDriftIssue);
  }
  if (reviewHealth.state !== 'healthy') {
    attention.push(buildApiIssue({
      code: reviewHealth.issueCode,
      severity: reviewHealth.severity,
      message: `${reviewHealth.reason}. Run /pipelane review before PR handoff.`,
      source: 'reviewState',
      blocking: reviewHealth.blocking,
      action: 'review',
    }));
  }
  if (orchestrationHealth.issue) {
    attention.push(orchestrationHealth.issue);
  }
  for (const corruptLedger of orchestration.corruptLedgers) {
    attention.push(buildApiIssue({
      code: corruptLedger.recent ? 'orchestration.ledger_corrupt' : 'orchestration.ledger_corrupt_stale',
      severity: corruptLedger.recent ? 'error' : 'warning',
      message: corruptLedger.recent
        ? `Orchestration ledger is unreadable at ${corruptLedger.ledgerPath}. Restore it or move the run directory outside .pipelane/state/orchestrate/runs/.`
        : `Older corrupt orchestration ledger ignored at ${corruptLedger.ledgerPath}. Move it outside .pipelane/state/orchestrate/runs/ if abandoned.`,
      source: 'orchestration',
      blocking: corruptLedger.recent,
      action: 'orchestrate',
    }));
  }
  for (const invalidDirectory of orchestration.invalidRunDirectories) {
    attention.push(buildApiIssue({
      code: 'orchestration.invalid_run_directory',
      severity: 'warning',
      message: `Invalid orchestration run directory ignored at ${invalidDirectory.directoryPath}. Move abandoned state outside .pipelane/state/orchestrate/runs/.`,
      source: 'orchestration',
      blocking: false,
      action: 'orchestrate',
    }));
  }

  const boardMessage = mode === 'release'
    ? 'Release mode: promote merged SHA through staging before prod.'
    : 'Build mode: production deploys run automatically after merge.';
  const releaseReadiness = buildBoardReleaseReadiness({
    checkedAt,
    mode,
    config: context.config,
    deployConfig,
    deployRecords: deployState.records,
    probeState,
    requestedSurfaces,
    probeRollup,
    boardMessage,
    effectiveOverride: context.modeState.override ?? null,
    lastOverride: context.modeState.lastOverride ?? null,
  });

  return buildApiEnvelope<SnapshotData>({
    command: 'pipelane.api.snapshot',
    ok: true,
    message: 'pipelane API snapshot ready',
    data: {
      boardContext: {
        mode,
        baseBranch,
        aliases: context.config.aliases,
        laneOrder: ['Local', 'PR', `Base: ${baseBranch}`, 'Staging', 'Production'],
        releaseReadiness,
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
        currentCheckout,
        overallFreshness: buildFreshness({ checkedAt }),
      },
      review: {
        latest: reviewEvidence.latest ?? reviewState.records[0] ?? null,
      },
      orchestration,
      sourceHealth,
      attention,
      availableActions: buildBoardActions({ mode, releaseReadiness, branches, checkedAt }),
      branches,
    },
  });
}

function summarizeReviewEvidenceHealth(evidence: ReviewEvidenceCheckResult): {
  state: LaneState;
  blocking: boolean;
  reason: string;
  observedAt?: string;
  issueCode: string;
  severity: ApiIssue['severity'];
} {
  const latestReview = evidence.latest;
  if (!latestReview) {
    const missingReason = evidence.issues[0]?.message ?? 'no review runs recorded';
    return {
      state: evidence.allowed ? 'healthy' : 'blocked',
      blocking: !evidence.allowed,
      reason: missingReason,
      issueCode: 'review.missing',
      severity: evidence.allowed ? 'info' : 'error',
    };
  }

  const base = {
    observedAt: latestReview.finishedAt,
    issueCode: 'review.incomplete',
    severity: 'warning' as const,
  };
  if (!evidence.allowed) {
    const firstIssue = evidence.issues[0];
    const failed = evidence.issues.some((issue) => issue.status === 'failed');
    const pending = evidence.issues.some((issue) => issue.status === 'pending');
    return {
      ...base,
      state: 'blocked',
      blocking: true,
      issueCode: failed ? 'review.failed' : pending ? 'review.pending' : base.issueCode,
      severity: 'error',
      reason: firstIssue?.message ? `${firstIssue.message}: ${latestReview.id}` : `latest review is not ready: ${latestReview.id}`,
    };
  }

  return {
    ...base,
    state: 'healthy',
    blocking: false,
    issueCode: 'review.passed',
    severity: 'info',
    reason: `latest review passed: ${latestReview.id}`,
  };
}

function buildBoardActions(options: {
  mode: string;
  releaseReadiness: SnapshotData['boardContext']['releaseReadiness'];
  branches: BranchRow[];
  checkedAt: string;
}): ApiActionState[] {
  const staleCount = options.branches.filter((branch) => branch.cleanup?.stale && branch.cleanup?.eligible).length;
  const cleanupActions = [
    buildApiActionState({
      id: 'clean.plan',
      label: 'Clean',
      state: 'awaiting_preflight',
      reason: staleCount > 0
        ? `preview cleanup status; ${staleCount} stale task lock${staleCount === 1 ? '' : 's'} can be pruned`
        : 'preview cleanup status and stale task lock assessment',
      checkedAt: options.checkedAt,
    }),
    ...(staleCount > 0
      ? [
          buildApiActionState({
            id: 'clean.apply',
            label: 'Apply stale cleanup',
            state: 'awaiting_preflight',
            reason: `prune ${staleCount} stale task lock${staleCount === 1 ? '' : 's'} with /clean --apply --all-stale`,
            risky: true,
            requiresConfirmation: true,
            defaultParams: { allStale: true },
            checkedAt: options.checkedAt,
          }),
        ]
      : []),
  ];

  if (options.mode === 'release') {
    return [
      ...cleanupActions,
      buildApiActionState({
        id: 'devmode.build',
        label: 'Switch to build mode',
        state: 'awaiting_preflight',
        reason: 'leave the protected release lane and use the fast build lane',
        checkedAt: options.checkedAt,
      }),
    ];
  }

  const releaseReady = options.releaseReadiness.state === 'healthy';
  return [
    ...cleanupActions,
    buildApiActionState({
      id: 'devmode.release',
      label: 'Switch to release mode',
      state: releaseReady ? 'awaiting_preflight' : 'blocked',
      reason: releaseReady
        ? 'enter the protected release lane'
        : options.releaseReadiness.reason || 'release readiness must pass, or the switch needs an override reason',
      inputs: releaseReady
        ? []
        : [
            {
              name: 'reason',
              label: 'Release override reason',
              type: 'text',
              required: true,
              placeholder: options.releaseReadiness.reason || 'Why are you overriding release readiness?',
            },
          ],
      defaultParams: releaseReady ? {} : { override: true },
      checkedAt: options.checkedAt,
    }),
  ];
}

function buildOrchestrationSnapshot(
  commonDir: string,
  config: WorkflowConfig,
  currentBranch: string,
  scan: OrchestrationRunScanDiagnostics = scanOrchestrationRunDiagnostics(commonDir, config),
): OrchestrationSnapshot {
  const records = scan.records;
  const reviewOptions: OrchestrationReviewSatisfactionOptions = {
    headCache: new Map(),
    statusDigestCache: new Map(),
    worktreeExistsCache: new Map(),
  };
  const recentRecords = records.slice(0, 10);
  const currentBranchRecords = currentBranch
    ? records.filter((run) => run.branchName === currentBranch)
    : records;
  const activeRecord = currentBranchRecords.find((run, index) =>
    run.status !== 'completed'
    || (index < 10 && (isActiveOrchestrationRun(run, reviewOptions) || isPrReadyOrchestrationRun(run, reviewOptions))),
  )
    ?? null;
  const summaryRecords = activeRecord
    ? [activeRecord, ...recentRecords.filter((run) => run.id !== activeRecord.id)].slice(0, 10)
    : recentRecords;
  const summaries = summaryRecords.map((run) => summarizeOrchestrationRun(run, config, reviewOptions));
  const activeRun = activeRecord ? summaries.find((run) => run.id === activeRecord.id) ?? null : null;
  const humanInbox = activeRun ? buildOrchestrationInbox(activeRun) : [];
  return {
    activeRun,
    runs: summaries.slice(0, 10),
    humanInbox,
    availableActions: activeRun?.nextAction ? [activeRun.nextAction] : [],
    corruptLedgers: scan.corrupt.map((diagnostic) => ({
      runId: diagnostic.runId,
      ledgerPath: diagnostic.ledgerPath,
      reason: diagnostic.reason,
      mtimeMs: diagnostic.mtimeMs,
      recent: isRecentOrchestrationCorruptLedger(diagnostic.mtimeMs),
    })),
    invalidRunDirectories: scan.invalidDirectories.map((diagnostic) => ({
      runId: diagnostic.runId,
      directoryPath: diagnostic.directoryPath,
      ledgerPath: diagnostic.ledgerPath,
      reason: diagnostic.reason,
      mtimeMs: diagnostic.mtimeMs,
    })),
  };
}

function isRecentOrchestrationCorruptLedger(mtimeMs: number | null): boolean {
  if (mtimeMs === null) return true;
  return mtimeMs >= Date.now() - ORCHESTRATION_CORRUPT_LEDGER_BLOCK_AGE_MS;
}

function isPrReadyOrchestrationRun(
  run: OrchestrationRunRecord,
  reviewOptions: OrchestrationReviewSatisfactionOptions,
): boolean {
  return run.status === 'completed'
    && run.slices.length > 0
    && run.slices.every((slice) => sliceReviewFullySatisfied(slice, reviewOptions));
}

function summarizeOrchestrationRun(
  run: OrchestrationRunRecord,
  config: WorkflowConfig,
  reviewOptions: OrchestrationReviewSatisfactionOptions,
): OrchestrationRunSummary {
  const counts = {
    planned: 0,
    prepared: 0,
    dispatched: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    workerSucceeded: 0,
    reviewPassed: 0,
    trustedReviewComplete: 0,
  };
  const providerCounts: Record<string, number> = {};
  const trustedReviewBySlice = new Map<string, boolean>();
  const missingWorktrees: OrchestrationMissingWorktreeSummary[] = [];
  const slices = run.slices.map((slice) => {
    counts[slice.status] += 1;
    if (slice.worker?.status === 'succeeded') counts.workerSucceeded += 1;
    if (slice.review?.run.status === 'passed') counts.reviewPassed += 1;
    const trustedReviewComplete = sliceReviewFullySatisfied(slice, reviewOptions);
    trustedReviewBySlice.set(slice.id, trustedReviewComplete);
    if (trustedReviewComplete) counts.trustedReviewComplete += 1;
    providerCounts[slice.provider] = (providerCounts[slice.provider] ?? 0) + 1;
    const missingWorktree = missingRelevantSliceWorktreeDiagnostic(slice, reviewOptions);
    if (missingWorktree) missingWorktrees.push(missingWorktree);
    return {
      id: slice.id,
      status: slice.status,
      provider: slice.provider,
      outcome: slice.outcome,
      branchName: slice.branchName,
      worktreePath: slice.worktreePath,
      workerStatus: slice.worker?.status ?? null,
      reviewStatus: slice.review?.status ?? null,
      reviewIndependence: slice.review?.independence ?? null,
      reviewEvidenceLabel: orchestrationReviewEvidenceLabel(slice, trustedReviewComplete),
      trustedReviewComplete,
      missingWorktree,
    };
  });

  const nextAction = buildOrchestrationNextAction(run, config, trustedReviewBySlice, missingWorktrees);
  return {
    id: run.id,
    status: run.status,
    state: missingWorktrees.length > 0 ? 'blocked' : orchestrationLaneStateFromCounts(run.slices.length, counts),
    title: run.plan.title,
    planPath: run.source.planPath,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    sliceCount: run.slices.length,
    counts,
    providerCounts,
    nextAction,
    missingWorktrees,
    slices,
  };
}

function orchestrationReviewEvidenceLabel(slice: OrchestrationSliceRecord, trustedReviewComplete: boolean): string {
  const rejected = latestRejectedReviewEvidenceLabel(slice);
  if (rejected) return rejected;
  if (!slice.review) {
    return slice.worker?.status === 'succeeded' ? 'pending' : 'none';
  }
  if (slice.review.status === 'failed') return 'failed';
  if (slice.review.status === 'pending') return 'pending';
  if (!trustedReviewComplete) return `untrusted:${slice.review.independence ?? 'legacy'}`;
  return slice.review.independence ?? 'legacy';
}

function latestRejectedReviewEvidenceLabel(slice: OrchestrationSliceRecord): string | null {
  const diagnostics = slice.reviewDiagnostics ?? [];
  const activeReviewTime = slice.review?.reviewedAt ?? '';
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = diagnostics[index];
    if (activeReviewTime && diagnostic.reviewedAt <= activeReviewTime) continue;
    if (
      diagnostic.run.status === 'passed'
      && blockingAiReviewEvidenceBlocker({
        reviewRun: diagnostic.run,
        worker: slice.worker?.identity ?? null,
      })
    ) {
      return `rejected:${diagnostic.independence ?? 'unknown'}`;
    }
  }
  return null;
}

function buildOrchestrationNextAction(
  run: OrchestrationRunRecord,
  config: WorkflowConfig,
  trustedReviewBySlice: Map<string, boolean>,
  missingWorktrees: OrchestrationMissingWorktreeSummary[] = [],
): OrchestrationActionSummary | null {
  const orchestrateCommand = '/pipelane orchestrate';
  const prCommand = formatWorkflowCommand(config, 'pr');
  const runIdArg = `--run-id ${run.id}`;
  const hasFailedWorker = run.slices.some((slice) => slice.worker?.status === 'failed' || slice.status === 'failed');
  const hasRunningWorker = run.slices.some((slice) => slice.worker?.status === 'running' || slice.status === 'running');
  const hasBlockedSlice = run.slices.some((slice) => slice.status === 'blocked');
  const needsPrepare = run.status === 'planned' || run.slices.some((slice) => slice.status === 'planned');
  const needsDispatch = !needsPrepare && (run.status === 'prepared' || run.slices.some((slice) => slice.status === 'prepared'));
  const needsStart = !needsPrepare && !needsDispatch && run.slices.some((slice) =>
    slice.status === 'dispatched' || (slice.status === 'blocked' && !slice.worker),
  );
  const needsReview = run.slices.some((slice) =>
    slice.worker?.status === 'succeeded' && !trustedReviewBySlice.get(slice.id),
  );
  const fullyReviewed = run.slices.length > 0 && run.slices.every((slice) => trustedReviewBySlice.get(slice.id));

  if (missingWorktrees.length > 0) {
    return buildOrchestrationAction({
      id: 'orchestrate.recover-worktree',
      label: 'Recover missing orchestration worktree',
      state: 'blocked',
      reason: `assigned worktree is missing for ${missingWorktrees[0].sliceId}`,
      command: `${orchestrateCommand} ${runIdArg}`,
    });
  }
  if (hasFailedWorker) {
    return buildOrchestrationAction({
      id: 'orchestrate.retry-workers',
      label: 'Retry failed orchestration workers',
      state: 'blocked',
      reason: 'one or more slice workers failed',
      command: `${orchestrateCommand} start ${runIdArg} --force`,
    });
  }
  if (hasRunningWorker) {
    return buildOrchestrationAction({
      id: 'orchestrate.wait-workers',
      label: 'Wait for running workers',
      state: 'running',
      reason: 'one or more slice workers are still running',
      command: formatWorkflowCommand(config, 'status'),
    });
  }
  if (needsPrepare) {
    return buildOrchestrationAction({
      id: 'orchestrate.prepare',
      label: 'Prepare orchestration worktrees',
      state: 'awaiting_preflight',
      reason: 'slice worktrees have not been prepared',
      command: `${orchestrateCommand} prepare ${runIdArg}`,
    });
  }
  if (needsDispatch) {
    return buildOrchestrationAction({
      id: 'orchestrate.dispatch',
      label: 'Write orchestration handoff prompts',
      state: 'awaiting_preflight',
      reason: 'slice prompts have not been dispatched',
      command: `${orchestrateCommand} dispatch ${runIdArg}`,
    });
  }
  if (needsStart) {
    return buildOrchestrationAction({
      id: 'orchestrate.start',
      label: 'Start orchestration workers',
      state: hasBlockedSlice ? 'blocked' : 'awaiting_preflight',
      reason: hasBlockedSlice ? 'blocked slices need recovery before more workers can start' : 'workers have not started',
      command: `${orchestrateCommand} start ${runIdArg}`,
    });
  }
  if (needsReview) {
    return buildOrchestrationAction({
      id: 'orchestrate.review',
      label: 'Review completed orchestration slices',
      state: 'awaiting_preflight',
      reason: 'worker output exists, but trusted full-slice review evidence is incomplete',
      command: `${orchestrateCommand} review ${runIdArg}`,
    });
  }
  if (fullyReviewed) {
    return buildOrchestrationAction({
      id: 'pr',
      label: 'Open PR for reviewed orchestration work',
      state: 'awaiting_preflight',
      reason: 'all slices have trusted review evidence',
      command: prCommand,
    });
  }
  return null;
}

function buildOrchestrationAction(options: {
  id: string;
  label: string;
  state: LaneState;
  reason: string;
  command: string;
}): OrchestrationActionSummary {
  return {
    id: options.id,
    label: options.label,
    state: options.state,
    reason: options.reason,
    command: options.command,
    risky: false,
    requiresConfirmation: false,
  };
}

function buildOrchestrationInbox(activeRun: OrchestrationRunSummary): OrchestrationInboxItem[] {
  const items: OrchestrationInboxItem[] = [];
  for (const missing of activeRun.missingWorktrees) {
    items.push({
      id: `${activeRun.id}:${missing.sliceId}:missing-worktree`,
      runId: activeRun.id,
      sliceId: missing.sliceId,
      severity: 'error',
      title: 'Slice worktree missing',
      message: `${missing.sliceId} assigned worktree is missing at ${missing.worktreePath}. Restore that path, or manually repair/move aside the stale ledger/task-lock assignment before retrying prepare.`,
      action: activeRun.nextAction,
    });
  }
  for (const slice of activeRun.slices) {
    if (slice.status !== 'failed' && slice.status !== 'blocked') continue;
    items.push({
      id: `${activeRun.id}:${slice.id}:${slice.status}`,
      runId: activeRun.id,
      sliceId: slice.id,
      severity: slice.status === 'failed' ? 'error' : 'warning',
      title: slice.status === 'failed' ? 'Slice worker failed' : 'Slice is blocked',
      message: `${slice.id} is ${slice.status}. ${activeRun.nextAction?.reason ?? 'Inspect the orchestration run for recovery details.'}`,
      action: activeRun.nextAction,
    });
  }
  return items;
}

function summarizeOrchestrationHealth(orchestration: OrchestrationSnapshot): {
  state: LaneState;
  blocking: boolean;
  reason: string;
  observedAt?: string;
  issue: ApiIssue | null;
} {
  if (!orchestration.activeRun) {
    return {
      state: 'healthy',
      blocking: false,
      reason: orchestration.runs.length === 0 ? 'no orchestration runs recorded' : 'no active orchestration runs',
      observedAt: orchestration.runs[0]?.updatedAt,
      issue: null,
    };
  }

  const run = orchestration.activeRun;
  const state = run.state;
  const blocking = state === 'blocked';
  const reason = run.nextAction
    ? `${run.title}: ${run.nextAction.reason}`
    : `${run.title}: ${run.status}`;
  const missingWorktree = run.missingWorktrees[0] ?? null;
  return {
    state,
    blocking,
    reason,
    observedAt: run.updatedAt,
    issue: blocking
      ? buildApiIssue({
          code: missingWorktree ? 'orchestration.slice_worktree_missing' : 'orchestration.blocked',
          severity: 'error',
          message: missingWorktree
            ? `Orchestration ${run.id} slice ${missingWorktree.sliceId} assigned worktree is missing at ${missingWorktree.worktreePath}. Restore the path or repair the stale assignment, then run ${run.nextAction?.command ?? `/pipelane orchestrate --run-id ${run.id}`}.`
            : `Orchestration ${run.id} is blocked. ${run.nextAction ? `Next: ${run.nextAction.command}.` : 'Inspect the run for recovery guidance.'}`,
          source: 'orchestration',
          blocking: true,
          action: run.nextAction?.id ?? 'orchestrate',
        })
      : null,
  };
}

function orchestrationLaneStateFromCounts(sliceCount: number, counts: OrchestrationRunSummary['counts']): LaneState {
  if (counts.failed > 0 || counts.blocked > 0) return 'blocked';
  if (counts.running > 0) return 'running';
  if (sliceCount > 0 && counts.trustedReviewComplete === sliceCount) return 'healthy';
  return 'awaiting_preflight';
}

interface SurfaceProbeEntry {
  surface: string;
  result: ProbeSurfaceFreshness;
}

function isUnsupportedSurfaceProbe(entry: SurfaceProbeEntry): boolean {
  return entry.result.state === 'unknown' && entry.result.reason.startsWith('unsupported surface "');
}

// Only the surfaces the release-gate would probe end up here. `frontend`
// is always probed (the URL or healthcheckUrl is the target); `edge`/`sql`
// probe only when an explicit healthcheckUrl is wired — many consumers
// keep those unset and gate on observed-staging-success alone.
function collectSurfaceProbes(options: {
  deployConfig: DeployConfig;
  probeState: ProbeState;
  surfaces: string[];
}): SurfaceProbeEntry[] {
  const { deployConfig, probeState, surfaces } = options;
  const entries: SurfaceProbeEntry[] = [];
  for (const surface of surfaces) {
    if (!isReleaseManagedSurface(surface)) {
      entries.push({
        surface,
        result: {
          state: 'unknown',
          reason: unsupportedSurfaceReason(surface),
          probe: null,
          ageMs: null,
        },
      });
    } else if (surface === 'frontend') {
      entries.push({
        surface,
        result: explainSurfaceProbe({
          probeState,
          surface,
          environment: 'staging',
          expectedUrl: resolveSurfaceProbeUrl(deployConfig, 'staging', surface),
        }),
      });
    } else if (surface === 'edge' && deployConfig.edge.staging.healthcheckUrl) {
      entries.push({
        surface,
        result: explainSurfaceProbe({
          probeState,
          surface,
          environment: 'staging',
          expectedUrl: resolveSurfaceProbeUrl(deployConfig, 'staging', surface),
        }),
      });
    } else if (surface === 'sql' && deployConfig.sql.staging.healthcheckUrl) {
      entries.push({
        surface,
        result: explainSurfaceProbe({
          probeState,
          surface,
          environment: 'staging',
          expectedUrl: resolveSurfaceProbeUrl(deployConfig, 'staging', surface),
        }),
      });
    }
  }
  return entries;
}

function rollupProbeState(entries: SurfaceProbeEntry[]): ProbeFreshnessState {
  if (entries.length === 0) return 'unknown';
  const states = entries.map((entry) => entry.result.state);
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('stale')) return 'stale';
  if (states.includes('unknown')) return 'unknown';
  return 'healthy';
}

function mapProbeStateToLaneState(state: ProbeFreshnessState): LaneState {
  switch (state) {
    case 'healthy': return 'healthy';
    case 'stale': return 'stale';
    case 'degraded': return 'degraded';
    case 'unknown':
    default: return 'unknown';
  }
}

function describeSurfaceProbe(entry: SurfaceProbeEntry): string {
  const { surface, result } = entry;
  if (result.reason) return `staging ${surface}: ${result.reason}`;
  if (result.state === 'healthy') return `staging ${surface} probe healthy`;
  return `staging ${surface} probe ${result.state}`;
}

function buildBoardReleaseReadiness(options: {
  checkedAt: string;
  mode: string;
  config: WorkflowConfig;
  deployConfig: DeployConfig;
  deployRecords: DeployRecord[];
  probeState: ProbeState;
  requestedSurfaces: string[];
  probeRollup: ProbeFreshnessState;
  boardMessage: string;
  effectiveOverride: SnapshotData['boardContext']['releaseReadiness']['effectiveOverride'];
  lastOverride: SnapshotData['boardContext']['releaseReadiness']['lastOverride'];
}): SnapshotData['boardContext']['releaseReadiness'] {
  const readiness = evaluateReleaseReadiness({
    config: options.config,
    deployConfig: options.deployConfig,
    deployRecords: options.deployRecords,
    probeState: options.probeState,
    surfaces: options.requestedSurfaces,
  });
  const blockers = options.requestedSurfaces.flatMap((surface) => readiness.results[surface]?.blockers ?? []);
  const hasHostedBlocker = blockers.some(isHostedReadinessBlocker);
  const hasConfigBlocker = blockers.some((blocker) => !isHostedReadinessBlocker(blocker));
  const state: LaneState = readiness.ready
    ? 'healthy'
    : !hasConfigBlocker && (options.probeRollup === 'degraded' || options.probeRollup === 'stale')
      ? 'degraded'
      : 'blocked';

  const detail = summarizeReleaseBlockers(readiness);
  const modeLead = readiness.ready
    ? options.mode === 'release'
      ? 'Release mode is active and requested surfaces passed observed staging + probe checks.'
      : 'Requested surfaces passed observed staging + probe checks and are ready for release mode.'
    : options.mode === 'release'
      ? 'Release mode is active, but the release gate is failing.'
      : 'Requested surfaces are not ready for release mode.';
  const overrideNote = options.effectiveOverride
    ? ` Release override active: ${options.effectiveOverride.reason}.`
    : '';

  return {
    state,
    reason: readiness.ready ? 'requested surfaces passed observed staging + probe checks' : detail,
    requestedSurfaces: options.requestedSurfaces,
    blockedSurfaces: readiness.blockedSurfaces,
    effectiveOverride: options.effectiveOverride,
    lastOverride: options.lastOverride,
    probeState: options.probeRollup,
    localReady: !hasConfigBlocker,
    hostedReady: !hasHostedBlocker,
    freshness: buildFreshness({
      checkedAt: options.checkedAt,
      observedAt: options.probeState.updatedAt || options.checkedAt,
      stale: options.probeRollup === 'stale',
    }),
    message: readiness.ready
      ? `${modeLead}${overrideNote}`
      : `${modeLead} ${detail} ${options.boardMessage}${overrideNote}`.trim(),
  };
}

function isHostedReadinessBlocker(blocker: ReleaseReadinessBlocker): boolean {
  return blocker.kind === 'observed' || blocker.kind === 'probe';
}

function summarizeReleaseBlockers(
  readiness: ReturnType<typeof evaluateReleaseReadiness>,
): string {
  if (readiness.blockedSurfaces.length === 0) {
    return 'requested surfaces passed release checks';
  }

  const surfaceDetails = readiness.blockedSurfaces.map((surface) => {
    const firstMissing = readiness.results[surface]?.missing?.[0];
    return firstMissing ? `${surface}: ${firstMissing}` : surface;
  });
  const preview = surfaceDetails.slice(0, 2).join(' ');
  const remaining = surfaceDetails.length - 2;
  const extra = remaining > 0 ? ` (+${remaining} more surface${remaining === 1 ? '' : 's'}.)` : '';
  return `Blocked surfaces: ${readiness.blockedSurfaces.join(', ')}. ${preview}${extra}`;
}

const RUNTIME_PROPAGATION_WINDOW_MS = 5 * 60 * 1000;

interface WorktreeOriginAnalysis {
  kind: 'unavailable' | 'match' | 'behind' | 'ahead' | 'diverged' | 'independent' | 'drift';
  relationship: CheckoutTruthRelationship;
}

export function buildBranchRows(options: {
  locks: TaskLock[];
  config: WorkflowConfig;
  repoRoot: string;
  currentBranch: string;
  baseBranch: string;
  baseBranchSha: string;
  prRecords: Record<string, PrRecord>;
  deployRecords: DeployRecord[];
  mode: string;
  checkedAt: string;
}): BranchRow[] {
  return options.locks.map((lock) =>
    buildBranchRow({
      lock,
      config: options.config,
      repoRoot: options.repoRoot,
      currentBranch: options.currentBranch,
      baseBranch: options.baseBranch,
      baseBranchSha: options.baseBranchSha,
      prRecord: options.prRecords[lock.taskSlug] ?? null,
      deployRecords: options.deployRecords,
      mode: options.mode,
      checkedAt: options.checkedAt,
    }),
  );
}

function buildCurrentCheckoutTruth(options: {
  checkedAt: string;
  currentBranch: string;
  currentHeadSha: string;
  baseBranch: string;
  baseBranchSha: string;
  activeLock: TaskLock | null;
  currentPrRecord: PrRecord | null;
  deployRecords: DeployRecord[];
  deployConfig: DeployConfig;
  runtimeObservation: FrontendRuntimeObservation;
  worktreeToOrigin: CheckoutTruthRelationship;
}): CurrentCheckoutTruth {
  const latestProdFrontendDeploy = findLatestFrontendDeployRecord(options.deployRecords, 'prod');
  const latestSuccessfulProdFrontendDeploy = latestProdFrontendDeploy?.status === 'succeeded'
    ? latestProdFrontendDeploy
    : findLatestFrontendDeployRecord(
      options.deployRecords.filter((record) => record.status === 'succeeded'),
      'prod',
    );
  const worktreeLayer = buildCheckoutTruthLayer({
    label: 'Worktree',
    health: options.currentHeadSha ? 'healthy' : 'unknown',
    sha: options.currentHeadSha || null,
    reason: options.currentHeadSha
      ? `current checkout is on ${options.currentBranch}`
      : 'current checkout SHA could not be resolved',
    detail: options.currentBranch || '(detached)',
    checkedAt: options.checkedAt,
  });
  const originLayer = buildCheckoutTruthLayer({
    label: 'Origin',
    health: options.baseBranchSha ? 'healthy' : 'unknown',
    sha: options.baseBranchSha || null,
    reason: options.baseBranchSha
      ? `remote base tip is origin/${options.baseBranch}`
      : `origin/${options.baseBranch} is not available locally`,
    detail: `origin/${options.baseBranch}`,
    checkedAt: options.checkedAt,
  });
  const deployLayer = buildDeployTruthLayer({
    checkedAt: options.checkedAt,
    deploy: latestProdFrontendDeploy,
  });
  const runtimeLayer = buildRuntimeTruthLayer({
    checkedAt: options.checkedAt,
    observation: options.runtimeObservation,
  });

  const worktreeToOrigin = options.worktreeToOrigin;
  const deployToOrigin = compareLayerShas({
    leftLabel: 'recorded production deploy',
    leftSha: latestSuccessfulProdFrontendDeploy?.sha ?? null,
    rightLabel: `origin/${options.baseBranch}`,
    rightSha: options.baseBranchSha || null,
    matchReason: `latest recorded production deploy matches origin/${options.baseBranch}`,
    driftReason: latestSuccessfulProdFrontendDeploy?.sha
      ? `latest recorded production deploy is ${shortSha(latestSuccessfulProdFrontendDeploy.sha)}, but origin/${options.baseBranch} is ${shortSha(options.baseBranchSha)}`
      : `no comparable production deploy record exists for origin/${options.baseBranch}`,
  });
  const runtimeToDeploy = compareRuntimeToDeploy({
    runtimeObservation: options.runtimeObservation,
    deploy: latestSuccessfulProdFrontendDeploy,
    checkedAt: options.checkedAt,
  });
  const runtimeToOrigin = compareRuntimeToOrigin({
    runtimeObservation: options.runtimeObservation,
    originSha: options.baseBranchSha || null,
    baseBranch: options.baseBranch,
  });

  return {
    branchName: options.currentBranch,
    baseBranch: options.baseBranch,
    taskSlug: options.activeLock?.taskSlug ?? null,
    nextAction: options.activeLock?.nextAction?.trim() || null,
    summary: summarizeCurrentCheckoutTruth({
      currentBranch: options.currentBranch,
      baseBranch: options.baseBranch,
      currentPrRecord: options.currentPrRecord,
      worktreeToOrigin,
      runtimeToDeploy,
      runtimeLayer,
    }),
    layers: {
      worktree: worktreeLayer,
      origin: originLayer,
      deploy: deployLayer,
      runtime: runtimeLayer,
    },
    relationships: {
      worktreeToOrigin,
      deployToOrigin,
      runtimeToDeploy,
      runtimeToOrigin,
    },
  };
}

function buildCheckoutTruthLayer(options: {
  label: string;
  health: ShellLayerHealth;
  sha: string | null;
  reason: string;
  detail: string;
  checkedAt: string;
  observedAt?: string | null;
}): CheckoutTruthLayer {
  return {
    label: options.label,
    health: options.health,
    sha: options.sha,
    reason: options.reason,
    detail: options.detail,
    freshness: buildFreshness({
      checkedAt: options.checkedAt,
      observedAt: options.observedAt ?? options.checkedAt,
    }),
  };
}

function buildDeployTruthLayer(options: {
  checkedAt: string;
  deploy: DeployRecord | null;
}): CheckoutTruthLayer {
  const deploy = options.deploy;
  if (!deploy) {
    return buildCheckoutTruthLayer({
      label: 'Deploy',
      health: 'unknown',
      sha: null,
      reason: 'no production frontend deploy recorded by Pipelane',
      detail: 'production/frontend',
      checkedAt: options.checkedAt,
    });
  }

  if (deploy.status === 'succeeded') {
    return buildCheckoutTruthLayer({
      label: 'Deploy',
      health: 'healthy',
      sha: deploy.sha,
      reason: `latest recorded production frontend deploy verified at ${deploy.verifiedAt ?? deploy.finishedAt ?? deploy.requestedAt}`,
      detail: deploy.workflowRunUrl ?? deploy.workflowRunId ?? deploy.workflowName,
      checkedAt: options.checkedAt,
      observedAt: deploy.verifiedAt ?? deploy.finishedAt ?? deploy.requestedAt,
    });
  }

  if (deploy.status === 'failed') {
    return buildCheckoutTruthLayer({
      label: 'Deploy',
      health: 'degraded',
      sha: deploy.sha,
      reason: `latest recorded production frontend deploy failed: ${deploy.failureReason ?? 'see deploy-state.json'}`,
      detail: deploy.workflowRunUrl ?? deploy.workflowRunId ?? deploy.workflowName,
      checkedAt: options.checkedAt,
      observedAt: deploy.finishedAt ?? deploy.requestedAt,
    });
  }

  return buildCheckoutTruthLayer({
    label: 'Deploy',
    health: 'unknown',
    sha: deploy.sha,
    reason: deploy.status === 'requested'
      ? 'latest recorded production frontend deploy is still in flight'
      : 'latest recorded production frontend deploy is legacy or unverifiable',
    detail: deploy.workflowRunUrl ?? deploy.workflowRunId ?? deploy.workflowName,
    checkedAt: options.checkedAt,
    observedAt: deploy.requestedAt,
  });
}

function buildRuntimeTruthLayer(options: {
  checkedAt: string;
  observation: FrontendRuntimeObservation;
}): CheckoutTruthLayer {
  return buildCheckoutTruthLayer({
    label: 'Runtime',
    health: options.observation.health,
    sha: options.observation.observedSha,
    reason: options.observation.reason,
    detail: options.observation.markerUrl ?? options.observation.frontendUrl ?? 'runtime marker unavailable',
    checkedAt: options.checkedAt,
    observedAt: options.observation.observedAt,
  });
}

function compareWorktreeToOrigin(options: {
  repoRoot: string;
  currentBranch: string;
  baseBranch: string;
  worktreeSha: string | null;
  originSha: string | null;
}): CheckoutTruthRelationship {
  return analyzeWorktreeToOrigin(options).relationship;
}

function analyzeWorktreeToOrigin(options: {
  repoRoot: string;
  currentBranch: string;
  baseBranch: string;
  worktreeSha: string | null;
  originSha: string | null;
}): WorktreeOriginAnalysis {
  if (!options.worktreeSha || !options.originSha) {
    return {
      kind: 'unavailable',
      relationship: {
        state: 'not-comparable',
        reason: 'worktree or remote base SHA is unavailable',
      },
    };
  }
  if (options.worktreeSha === options.originSha) {
    return {
      kind: 'match',
      relationship: {
        state: 'match',
        reason: `this checkout matches origin/${options.baseBranch}`,
      },
    };
  }
  if (options.currentBranch === options.baseBranch) {
    const distance = readRevisionDistance(options.repoRoot, options.worktreeSha, options.originSha);
    if (distance) {
      if (distance.ahead === 0 && distance.behind > 0) {
        return {
          kind: 'behind',
          relationship: {
            state: 'drift',
            reason: `this checkout's ${options.baseBranch} is behind origin/${options.baseBranch} by ${formatCommitDistance(distance.behind)}`,
          },
        };
      }
      if (distance.ahead > 0 && distance.behind === 0) {
        return {
          kind: 'ahead',
          relationship: {
            state: 'drift',
            reason: `this checkout's ${options.baseBranch} is ahead of origin/${options.baseBranch} by ${formatCommitDistance(distance.ahead)}`,
          },
        };
      }
      if (distance.ahead > 0 && distance.behind > 0) {
        return {
          kind: 'diverged',
          relationship: {
            state: 'drift',
            reason: `this checkout's ${options.baseBranch} has diverged from origin/${options.baseBranch} (${formatAheadBehind(distance.ahead, distance.behind)})`,
          },
        };
      }
    }
    return {
      kind: 'drift',
      relationship: {
        state: 'drift',
        reason: `this checkout's ${options.baseBranch} differs from origin/${options.baseBranch}`,
      },
    };
  }
  return {
    kind: 'independent',
    relationship: {
      state: 'drift',
      reason: `current worktree remains on ${options.currentBranch}; origin/${options.baseBranch} moved independently`,
    },
  };
}

function compareRuntimeToDeploy(options: {
  runtimeObservation: FrontendRuntimeObservation;
  deploy: DeployRecord | null;
  checkedAt: string;
}): CheckoutTruthRelationship {
  if (options.runtimeObservation.health !== 'healthy' || !options.runtimeObservation.observedSha) {
    return {
      state: 'not-comparable',
      reason: options.runtimeObservation.reason,
    };
  }
  if (!options.deploy || options.deploy.status !== 'succeeded') {
    return {
      state: 'not-comparable',
      reason: 'no verified production deploy record exists for comparison',
    };
  }
  if (isWithinRuntimePropagationWindow(options.deploy, options.checkedAt)
    && options.runtimeObservation.observedSha !== options.deploy.sha) {
    return {
      state: 'not-comparable',
      reason: 'waiting for the runtime marker to converge after the latest production deploy',
    };
  }
  if (options.runtimeObservation.observedSha === options.deploy.sha) {
    return {
      state: 'match',
      reason: `runtime marker matches the recorded production deploy ${shortSha(options.deploy.sha)}`,
    };
  }
  return {
    state: 'drift',
    reason: `runtime marker reports ${shortSha(options.runtimeObservation.observedSha)}, but the latest recorded production deploy is ${shortSha(options.deploy.sha)}`,
  };
}

function compareRuntimeToOrigin(options: {
  runtimeObservation: FrontendRuntimeObservation;
  originSha: string | null;
  baseBranch: string;
}): CheckoutTruthRelationship {
  return compareLayerShas({
    leftLabel: 'runtime marker',
    leftSha: options.runtimeObservation.health === 'healthy'
      ? options.runtimeObservation.observedSha
      : null,
    rightLabel: `origin/${options.baseBranch}`,
    rightSha: options.originSha,
    matchReason: `runtime marker matches origin/${options.baseBranch}`,
    driftReason: options.runtimeObservation.observedSha && options.originSha
      ? `runtime marker reports ${shortSha(options.runtimeObservation.observedSha)}, but origin/${options.baseBranch} is ${shortSha(options.originSha)}`
      : `runtime marker cannot yet be compared to origin/${options.baseBranch}`,
    unavailableReason: options.runtimeObservation.reason,
  });
}

function compareLayerShas(options: {
  leftLabel: string;
  leftSha: string | null;
  rightLabel: string;
  rightSha: string | null;
  matchReason: string;
  driftReason: string;
  unavailableReason?: string;
}): CheckoutTruthRelationship {
  if (!options.leftSha || !options.rightSha) {
    return {
      state: 'not-comparable',
      reason: options.unavailableReason ?? `${options.leftLabel} or ${options.rightLabel} is unavailable`,
    };
  }
  if (options.leftSha === options.rightSha) {
    return {
      state: 'match',
      reason: options.matchReason,
    };
  }
  return {
    state: 'drift',
    reason: options.driftReason,
  };
}

function summarizeCurrentCheckoutTruth(options: {
  currentBranch: string;
  baseBranch: string;
  currentPrRecord: PrRecord | null;
  worktreeToOrigin: CheckoutTruthRelationship;
  runtimeToDeploy: CheckoutTruthRelationship;
  runtimeLayer: CheckoutTruthLayer;
}): string {
  if (options.runtimeToDeploy.state === 'drift') {
    return 'production frontend live SHA differs from recorded deploy history';
  }
  if (options.worktreeToOrigin.state === 'drift' && options.currentBranch === options.baseBranch) {
    return options.worktreeToOrigin.reason;
  }
  if (options.worktreeToOrigin.state === 'drift') {
    return options.currentPrRecord?.mergedAt
      ? 'merged on GitHub, current worktree unchanged'
      : `current worktree differs from origin/${options.baseBranch}`;
  }
  if (options.runtimeLayer.health === 'unknown' || options.runtimeLayer.health === 'degraded') {
    return options.runtimeLayer.reason;
  }
  return 'current checkout truth loaded';
}

function buildStaleBaseIssue(options: {
  baseBranch: string;
  analysis: WorktreeOriginAnalysis;
}): ApiIssue | null {
  if (options.analysis.kind !== 'behind') return null;
  return buildApiIssue({
    code: 'git.base.stale',
    severity: 'warning',
    message: `${options.analysis.relationship.reason}. Refresh this checkout if you want merged code locally.`,
    source: 'git',
    blocking: false,
    lane: 'base',
    action: 'git.catchupBase',
  });
}

function buildRuntimeDriftIssue(options: {
  deployConfig: DeployConfig;
  currentCheckout: CurrentCheckoutTruth;
}): ApiIssue | null {
  if (options.deployConfig.frontend.production.autoDeployOnMain !== false) {
    return null;
  }
  if (options.currentCheckout.layers.runtime.health !== 'healthy') {
    return null;
  }
  if (options.currentCheckout.relationships.runtimeToDeploy.state !== 'drift') {
    return null;
  }
  return buildApiIssue({
    code: 'runtime.provenance.drift',
    severity: 'warning',
    message: `production frontend live SHA differs from the latest recorded Pipelane deploy: ${options.currentCheckout.relationships.runtimeToDeploy.reason}.`,
    source: 'runtimeMarker',
    blocking: false,
    lane: 'production',
  });
}

function findLatestFrontendDeployRecord(
  records: DeployRecord[],
  environment: 'staging' | 'prod',
): DeployRecord | null {
  return [...records]
    .filter((record) => record.environment === environment && record.surfaces.includes('frontend'))
    .sort((left, right) => latestDeploySortKey(right).localeCompare(latestDeploySortKey(left)))[0] ?? null;
}

function latestDeploySortKey(record: DeployRecord): string {
  return record.verifiedAt ?? record.finishedAt ?? record.requestedAt ?? '';
}

function isWithinRuntimePropagationWindow(record: DeployRecord, checkedAt: string): boolean {
  const observedAt = Date.parse(record.finishedAt ?? record.requestedAt ?? '');
  const checkedAtMs = Date.parse(checkedAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(checkedAtMs)) {
    return false;
  }
  return checkedAtMs - observedAt < RUNTIME_PROPAGATION_WINDOW_MS;
}

function mapShellHealthToLaneState(health: ShellLayerHealth): LaneState {
  switch (health) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'unavailable':
      return 'bypassed';
    case 'unknown':
    default:
      return 'unknown';
  }
}

function readRevisionDistance(
  repoRoot: string,
  worktreeSha: string,
  originSha: string,
): { ahead: number; behind: number } | null {
  const raw = runGit(repoRoot, ['rev-list', '--left-right', '--count', `${worktreeSha}...${originSha}`], true)?.trim();
  if (!raw) {
    return null;
  }
  const [aheadRaw, behindRaw] = raw.split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? '', 10);
  const behind = Number.parseInt(behindRaw ?? '', 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return null;
  }
  return { ahead, behind };
}

function formatCommitDistance(count: number): string {
  return `${count} commit${count === 1 ? '' : 's'}`;
}

function formatAheadBehind(ahead: number, behind: number): string {
  return `ahead ${formatCommitDistance(ahead)}, behind ${formatCommitDistance(behind)}`;
}

function buildBranchRow(options: {
  lock: TaskLock;
  config: WorkflowConfig;
  repoRoot: string;
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
  const branchExists = Boolean(runGit(options.repoRoot, ['rev-parse', '--verify', lock.branchName], true));
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
  const cleanup = buildBranchCleanup({
    lock,
    worktreeExists,
    branchExists,
    dirty,
    prodVerified: Boolean(prRecord?.mergedSha) && productionCell.state === 'healthy',
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
      available: cleanup.available,
      eligible: cleanup.eligible,
      reason: cleanup.reason,
      stale: cleanup.stale,
      tag: cleanup.tag,
      evidence: cleanup.evidence,
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
    availableActions: buildBranchActions({
      worktreeExists,
      dirty,
      prRecord,
      mode,
      localCell,
      prCell,
      stagingCell,
      productionCell,
      cleanup,
      taskSlug: lock.taskSlug,
      checkedAt,
    }),
  };
}

function buildBranchCleanup(options: {
  lock: TaskLock;
  worktreeExists: boolean;
  branchExists: boolean;
  dirty: boolean;
  prodVerified: boolean;
  checkedAt: string;
}): BranchRow['cleanup'] {
  const { lock, worktreeExists, branchExists, dirty, prodVerified, checkedAt } = options;
  const evidence = [
    ...(!worktreeExists ? [`saved worktree ${lock.worktreePath} no longer exists`] : []),
    ...(!branchExists ? [`saved branch ${lock.branchName} no longer exists`] : []),
  ];

  if (evidence.length > 0) {
    return {
      available: true,
      eligible: true,
      reason: evidence.join('; '),
      stale: true,
      tag: 'stale',
      evidence,
    };
  }

  if (dirty) {
    return {
      available: false,
      eligible: false,
      reason: 'dirty worktree',
      stale: false,
      tag: 'dirty',
      evidence: [],
    };
  }

  if (!prodVerified) {
    return {
      available: false,
      eligible: false,
      reason: 'workspace still active',
      stale: false,
      tag: 'active',
      evidence: [],
    };
  }

  const ageMs = lockAgeMs(lock.updatedAt, Date.parse(checkedAt));
  if (ageMs === null) {
    return {
      available: true,
      eligible: false,
      reason: `prod is verified, but cleanup is blocked because updatedAt is missing or unparseable ("${lock.updatedAt ?? ''}")`,
      stale: false,
      tag: 'blocked',
      evidence: [],
    };
  }

  if (ageMs < TASK_LOCK_MIN_PRUNE_AGE_MS) {
    const waitSeconds = Math.ceil((TASK_LOCK_MIN_PRUNE_AGE_MS - ageMs) / 1000);
    return {
      available: true,
      eligible: false,
      reason: `prod is verified; cleanup unlocks after the 5-minute prune floor in about ${waitSeconds}s`,
      stale: false,
      tag: 'pending',
      evidence: [],
    };
  }

  return {
    available: true,
    eligible: true,
    reason: 'prod is verified; this task lock can be cleaned with /clean --apply --task',
    stale: false,
    tag: 'ready',
    evidence: [],
  };
}

function lockAgeMs(updatedAt: string | undefined, now: number): number | null {
  if (!updatedAt || !Number.isFinite(now)) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

function buildBranchActions(options: {
  worktreeExists: boolean;
  dirty: boolean;
  prRecord: PrRecord | null;
  mode: string;
  localCell: ApiStatusCell;
  prCell: ApiStatusCell;
  stagingCell: ApiStatusCell;
  productionCell: ApiStatusCell;
  cleanup: BranchRow['cleanup'];
  taskSlug: string;
  checkedAt: string;
}): ApiActionState[] {
  const actions: ApiActionState[] = [];
  const { worktreeExists, dirty, prRecord, mode, localCell, prCell, stagingCell, productionCell, cleanup, taskSlug, checkedAt } = options;

  if (!prRecord) {
    actions.push(buildApiActionState({
      id: 'pr',
      label: 'Open PR',
      state: worktreeExists ? 'awaiting_preflight' : 'blocked',
      reason: worktreeExists
        ? dirty
          ? 'commit local work, push the branch, and open a PR'
          : 'push the branch and open a PR'
        : localCell.reason,
      inputs: dirty
        ? [{
          name: 'title',
          label: 'PR title',
          type: 'text',
          required: true,
          placeholder: 'Short PR title',
        }]
        : [],
      checkedAt,
    }));
  } else if (!prRecord.mergedAt) {
    if (dirty && worktreeExists) {
      actions.push(buildApiActionState({
        id: 'pr',
        label: 'Update PR',
        state: 'awaiting_preflight',
        reason: 'commit local work, push the branch, and update the PR',
        checkedAt,
      }));
    }
    actions.push(buildApiActionState({
      id: 'merge',
      label: 'Merge PR',
      state: prCell.state === 'running' ? 'awaiting_preflight' : prCell.state,
      reason: prCell.reason || 'merge this branch PR',
      risky: true,
      requiresConfirmation: true,
      checkedAt,
    }));
  }

  if (prRecord?.mergedSha) {
    if (mode === 'release' && stagingCell.state !== 'healthy' && stagingCell.state !== 'running') {
      actions.push(buildApiActionState({
        id: 'deploy.staging',
        label: 'Deploy staging',
        state: stagingCell.state,
        reason: stagingCell.reason || 'deploy the merged SHA to staging',
        checkedAt,
      }));
    }
    if (productionCell.state !== 'healthy' && productionCell.state !== 'running') {
      actions.push(buildApiActionState({
        id: 'deploy.prod',
        label: 'Deploy production',
        state: productionCell.state,
        reason: productionCell.reason || 'deploy the merged SHA to production',
        risky: true,
        requiresConfirmation: true,
        checkedAt,
      }));
    }
  }

  if (cleanup.available) {
    actions.push(buildApiActionState({
      id: 'clean.apply',
      label: cleanup.eligible ? 'Clean task record' : 'Clean task record pending',
      state: cleanup.eligible ? 'awaiting_preflight' : 'blocked',
      reason: cleanup.reason || 'prune the Pipelane task lock for this branch',
      risky: true,
      requiresConfirmation: true,
      defaultParams: { task: taskSlug },
      checkedAt,
    }));
  }

  return actions;
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
