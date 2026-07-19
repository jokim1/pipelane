import { existsSync } from 'node:fs';

import type { AutoCleanupBlockerCode, DeliveryRecord, DeployRecord, PrRecord, ProbeState, ReviewOverrideRecord, ReviewRunRecord, TaskLock, WorkflowConfig } from '../state.ts';
import { summarizeTaskBudgetForCheckout } from '../task-budget.ts';
import {
  automaticWorktreeCleanupEnabled,
  DEFAULT_MODE,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadDeployState,
  loadPrRecord,
  loadReviewState,
  loadPrState,
  prRecordMatchesTaskLock,
  loadProbeState,
  nowIso,
  reviewArtifactRoot,
  resolveWorkflowContext,
  runCommandCapture,
  runGit,
  TASK_LOCK_STALE_MS,
} from '../state.ts';
import {
  computeDeployConfigFingerprint,
  disqualifyDeployRecord,
  emptyDeployConfig,
  evaluateReleaseReadiness,
  explainSurfaceProbe,
  getAdditionalDeploySurfaceConfig,
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
import {
  assessTaskCleanup,
  inspectCleanupStatus,
  resolveSharedRepoRoot,
  type CleanupEvidenceRevision,
  type DeliveryProof,
} from '../task-workspaces.ts';
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
import {
  evaluateReviewEvidenceForPr,
  selectCurrentReviewEvidenceRecord,
  type ReviewEvidenceCheckResult,
} from '../review-enforcement.ts';
import { projectReviewRun, type ReviewRunPresentation } from '../review-output.ts';

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
    nextActionUpdatedAt: string | null;
    nextActionAgeMs: number | null;
    nextActionStale: boolean;
  } | null;
  surfaces: string[];
  cleanup: {
    status: 'not-applicable' | 'pending' | 'eligible' | 'kept' | 'blocked';
    blockerCode: AutoCleanupBlockerCode | null;
    available: boolean;
    eligible: boolean;
    reason: string;
    stale: boolean;
    tag: string;
    evidence: string[];
    evidenceRevision: CleanupEvidenceRevision | null;
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
  nextActionUpdatedAt: string | null;
  nextActionAgeMs: number | null;
  nextActionStale: boolean;
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
    schemaVersion: 2;
    enforcementMode: 'legacy-v2' | 'strict-v3';
    policyVersion: number;
    blockingGateIds: string[];
    current: ReviewSnapshotRecord | null;
    recent: ReviewSnapshotRecord | null;
    /** @deprecated Use current. Removed in 0.3.0. */
    latest: ReviewSnapshotRecord | null;
    latestOverride: ReviewOverrideRecord | null;
  };
  // Advisory budget meters for the current checkout.
  taskBudget: {
    current: null | {
      taskSlug: string;
      branchName: string;
      lineageKey: string;
      used: { fixReviewLoops: number; aiRunLaunches: number; activeMinutes: number };
      limits: { fixReviewLoops: number; aiRuns: number; activeMinutes: number };
    };
  };
  sourceHealth: SourceHealthEntry[];
  attention: unknown[];
  availableActions: ApiActionState[];
  branches: BranchRow[];
  cleanupSummary: {
    automaticEnabled: boolean;
    pending: number;
    eligible: number;
    kept: number;
    blocked: number;
    blockedByCode: Record<string, number>;
  };
}

export type ReviewSnapshotRecord = ReviewRunRecord & {
  presentation: ReviewRunPresentation;
};

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
  const currentReview = selectCurrentReviewEvidenceRecord(context, reviewState.records);
  const recentReview = reviewState.records.find((record) => record.id !== currentReview?.id) ?? null;
  const artifactRoot = reviewArtifactRoot(context.commonDir, context.config);
  const currentReviewSnapshot = currentReview
    ? attachReviewPresentation(currentReview, artifactRoot, 'current')
    : null;
  const recentReviewSnapshot = recentReview
    ? attachReviewPresentation(recentReview, artifactRoot, 'recent')
    : null;
  const reviewHealth = summarizeReviewEvidenceHealth(reviewEvidence);
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
  const currentPrRecord = activeLock && prRecordMatchesTaskLock(prState.records[activeLock.taskSlug], activeLock)
    ? prState.records[activeLock.taskSlug]
    : null;
  const branches = buildBranchRows({
    locks,
    config: context.config,
    repoRoot: context.repoRoot,
    commonDir: context.commonDir,
    callerCwd: context.repoRoot,
    currentBranch,
    baseBranch,
    baseBranchSha,
    prRecords: prState.records,
    deliveries: Object.values(prState.deliveriesByPr ?? {}),
    deployRecords: deployState.records,
    mode,
    checkedAt,
  });
  const cleanupSummary = buildCleanupSummary(branches, context.config);

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
      name: 'review.current',
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
  const boardMessage = mode === 'release'
    ? 'Release mode: promote merged SHA through staging before prod.'
    : 'Build mode: the live environment updates automatically after merge.';
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
        schemaVersion: 2,
        enforcementMode: context.config.reviewGates?.enforcementMode ?? 'legacy-v2',
        policyVersion: context.config.reviewGates?.policyVersion ?? 2,
        blockingGateIds: (context.config.reviewGates?.gates ?? []).filter((gate) => gate.blocking !== false).map((gate) => gate.id),
        current: currentReviewSnapshot,
        recent: recentReviewSnapshot,
        latest: currentReviewSnapshot,
        latestOverride: reviewState.overrides[0] ?? null,
      },
      taskBudget: buildTaskBudgetSnapshot(context),
      sourceHealth,
      attention,
      availableActions: buildBoardActions({ mode, releaseReadiness, branches, checkedAt }),
      branches,
      cleanupSummary,
    },
  });
}

function buildTaskBudgetSnapshot(context: ReturnType<typeof resolveWorkflowContext>): SnapshotData['taskBudget'] {
  let current: SnapshotData['taskBudget']['current'] = null;
  try {
    current = summarizeTaskBudgetForCheckout(context);
  } catch {
    // Budget meters are display state; an unreadable ledger must not take
    // down the snapshot.
  }
  return { current };
}

function attachReviewPresentation(
  record: ReviewRunRecord,
  artifactRoot: string,
  relation: ReviewRunPresentation['relation'],
): ReviewSnapshotRecord {
  return {
    ...record,
    presentation: projectReviewRun(record, { artifactRoot, relation }),
  };
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
    const additional = getAdditionalDeploySurfaceConfig(deployConfig, surface);
    if (!isReleaseManagedSurface(surface) && !additional) {
      entries.push({
        surface,
        result: {
          state: 'unknown',
          reason: unsupportedSurfaceReason(surface, deployConfig),
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
    } else if (additional?.staging.healthcheckUrl) {
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
  commonDir?: string;
  callerCwd?: string;
  currentBranch: string;
  baseBranch: string;
  baseBranchSha: string;
  prRecords: Record<string, PrRecord>;
  deliveries?: DeliveryRecord[];
  deployRecords: DeployRecord[];
  mode: string;
  checkedAt: string;
}): BranchRow[] {
  const deliveries = options.deliveries ?? [];
  const lockedRows = options.locks.map((lock) => {
    const matchingDeliveries = deliveries.filter((delivery) =>
      delivery.ownership === 'managed-task'
      && delivery.taskSlug === lock.taskSlug
      && Boolean(lock.taskBindingId)
      && delivery.taskBindingId === lock.taskBindingId
    );
    const storedPr = prRecordMatchesTaskLock(options.prRecords[lock.taskSlug], lock)
      ? options.prRecords[lock.taskSlug]
      : null;
    const prRecord = storedPr ?? (matchingDeliveries.length === 1
      ? prRecordFromDelivery(matchingDeliveries[0])
      : null);
    return buildBranchRow({
      lock,
      config: options.config,
      repoRoot: options.repoRoot,
      commonDir: options.commonDir,
      callerCwd: options.callerCwd,
      currentBranch: options.currentBranch,
      baseBranch: options.baseBranch,
      baseBranchSha: options.baseBranchSha,
      prRecord,
      deliveries,
      deployRecords: options.deployRecords,
      mode: options.mode,
      checkedAt: options.checkedAt,
    });
  });
  const representedPrs = new Set(lockedRows.flatMap((row) => row.pr?.number ? [row.pr.number] : []));
  const deliveryRows = deliveries
    .filter((delivery) => !representedPrs.has(delivery.prNumber))
    .map((delivery) => buildDeliveryBranchRow({
      delivery,
      repoRoot: options.repoRoot,
      currentBranch: options.currentBranch,
      baseBranch: options.baseBranch,
      baseBranchSha: options.baseBranchSha,
      deployRecords: options.deployRecords,
      checkedAt: options.checkedAt,
    }))
    .filter((row) => row.availableActions.length > 0
      || row.lanes.staging.state === 'running'
      || row.lanes.production.state === 'running');
  return [...lockedRows, ...deliveryRows];
}

function prRecordFromDelivery(delivery: DeliveryRecord): PrRecord {
  return {
    taskSlug: delivery.taskSlug,
    ...(delivery.taskBindingId ? { taskBindingId: delivery.taskBindingId } : {}),
    branchName: delivery.branchName,
    title: delivery.title,
    number: delivery.prNumber,
    url: delivery.url,
    mergedSha: delivery.mergedSha,
    mergedAt: delivery.mergedAt,
    updatedAt: delivery.mergedAt,
  };
}

function buildDeliveryBranchRow(options: {
  delivery: DeliveryRecord;
  repoRoot: string;
  currentBranch: string;
  baseBranch: string;
  baseBranchSha: string;
  deployRecords: DeployRecord[];
  checkedAt: string;
}): BranchRow {
  const { delivery, checkedAt } = options;
  const prRecord = prRecordFromDelivery(delivery);
  const localCell = buildApiStatusCell({
    state: 'healthy',
    reason: 'edit workspace closed after immutable delivery was recorded',
    checkedAt,
  });
  const prCell = buildApiStatusCell({
    state: 'healthy',
    reason: `PR #${delivery.prNumber} merged`,
    checkedAt,
  });
  const baseContained = Boolean(options.baseBranchSha)
    && gitIsAncestor(options.repoRoot, delivery.mergedSha, options.baseBranchSha);
  const baseCell = buildApiStatusCell({
    state: baseContained ? 'healthy' : 'running',
    reason: baseContained
      ? `merged SHA is contained by ${options.baseBranch}`
      : `merged SHA ${shortSha(delivery.mergedSha)} landed; waiting for origin/${options.baseBranch}`,
    detail: `Base: ${options.baseBranch}`,
    checkedAt,
  });
  const stagingCell = buildDeployCell({
    environment: 'staging',
    mode: delivery.mode,
    mergedSha: delivery.mergedSha,
    deployRecords: options.deployRecords,
    checkedAt,
  });
  const productionCell = buildDeployCell({
    environment: 'prod',
    mode: delivery.mode,
    mergedSha: delivery.mergedSha,
    deployRecords: options.deployRecords,
    checkedAt,
  });
  const cleanup: BranchRow['cleanup'] = {
    status: 'not-applicable',
    blockerCode: null,
    available: false,
    eligible: false,
    reason: 'edit workspace already closed; immutable delivery history retained',
    stale: false,
    tag: 'closed',
    evidence: [`PR #${delivery.prNumber} immutable delivery`],
    evidenceRevision: null,
  };
  return {
    name: delivery.branchName,
    status: 'delivered',
    current: delivery.branchName === options.currentBranch,
    note: `PR #${delivery.prNumber} delivered; edit workspace closed`,
    task: null,
    surfaces: delivery.surfaces,
    cleanup,
    pr: {
      number: delivery.prNumber,
      state: 'MERGED',
      url: delivery.url,
      title: delivery.title,
      mergedAt: delivery.mergedAt,
    },
    mergedSha: delivery.mergedSha,
    lanes: {
      local: localCell,
      pr: prCell,
      base: baseCell,
      staging: stagingCell,
      production: productionCell,
    },
    availableActions: buildBranchActions({
      worktreeExists: false,
      dirty: false,
      prRecord,
      mode: delivery.mode,
      localCell,
      prCell,
      stagingCell,
      productionCell,
      cleanup,
      taskSlug: delivery.taskSlug,
      prNumber: delivery.prNumber,
      checkedAt,
    }),
  };
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
  const nextActionTiming = buildNextActionTiming(
    options.activeLock?.nextAction,
    options.activeLock?.nextActionUpdatedAt,
    options.activeLock?.updatedAt,
    options.checkedAt,
  );
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
    ...nextActionTiming,
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
  commonDir?: string;
  callerCwd?: string;
  currentBranch: string;
  baseBranch: string;
  baseBranchSha: string;
  prRecord: PrRecord | null;
  deliveries: DeliveryRecord[];
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
    config: options.config,
    repoRoot: options.repoRoot,
    commonDir: options.commonDir,
    callerCwd: options.callerCwd ?? options.repoRoot,
    baseBranch,
    baseBranchSha,
    deliveries: options.deliveries,
    prRecord,
    worktreeExists,
    branchExists,
    checkedAt,
  });
  const nextActionTiming = buildNextActionTiming(
    lock.nextAction,
    lock.nextActionUpdatedAt,
    lock.updatedAt,
    checkedAt,
  );

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
      ...nextActionTiming,
    },
    surfaces: lock.surfaces ?? [],
    cleanup: {
      status: cleanup.status,
      blockerCode: cleanup.blockerCode,
      available: cleanup.available,
      eligible: cleanup.eligible,
      reason: cleanup.reason,
      stale: cleanup.stale,
      tag: cleanup.tag,
      evidence: cleanup.evidence,
      evidenceRevision: cleanup.evidenceRevision,
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

export function buildNextActionTiming(
  nextAction: string | undefined,
  nextActionUpdatedAt: string | undefined,
  lockUpdatedAt: string | undefined,
  checkedAt: string,
): { nextActionUpdatedAt: string | null; nextActionAgeMs: number | null; nextActionStale: boolean } {
  if (!nextAction?.trim()) {
    return { nextActionUpdatedAt: null, nextActionAgeMs: null, nextActionStale: false };
  }
  const effectiveUpdatedAt = nextActionUpdatedAt ?? lockUpdatedAt;
  const checkedAtMs = Date.parse(checkedAt);
  const effectiveUpdatedAtMs = effectiveUpdatedAt ? Date.parse(effectiveUpdatedAt) : Number.NaN;
  if (Number.isFinite(checkedAtMs) && Number.isFinite(effectiveUpdatedAtMs) && effectiveUpdatedAtMs > checkedAtMs) {
    return { nextActionUpdatedAt: effectiveUpdatedAt ?? null, nextActionAgeMs: null, nextActionStale: false };
  }
  const nextActionAgeMs = lockAgeMs(effectiveUpdatedAt, checkedAtMs);
  return {
    nextActionUpdatedAt: effectiveUpdatedAt ?? null,
    nextActionAgeMs,
    nextActionStale: nextActionAgeMs !== null && nextActionAgeMs > TASK_LOCK_STALE_MS,
  };
}

function buildBranchCleanup(options: {
  lock: TaskLock;
  config: WorkflowConfig;
  repoRoot: string;
  commonDir?: string;
  callerCwd: string;
  baseBranch: string;
  baseBranchSha: string;
  deliveries: DeliveryRecord[];
  prRecord: PrRecord | null;
  worktreeExists: boolean;
  branchExists: boolean;
  checkedAt: string;
}): BranchRow['cleanup'] {
  const { lock, worktreeExists, branchExists, checkedAt } = options;
  const matchingDeliveries = options.deliveries.filter((delivery) =>
    delivery.ownership === 'managed-task'
    && delivery.taskSlug === lock.taskSlug
    && Boolean(lock.taskBindingId)
    && delivery.taskBindingId === lock.taskBindingId
  );
  const cleanupCandidate = Boolean(lock.cleanup || options.prRecord?.mergedSha || matchingDeliveries.length > 0);
  if (!cleanupCandidate) {
    const missingArtifacts = [
      ...(!worktreeExists ? [`saved worktree ${lock.worktreePath} no longer exists`] : []),
      ...(!branchExists ? [`saved branch ${lock.branchName} no longer exists`] : []),
    ];
    if (missingArtifacts.length > 0) {
      return {
        status: 'not-applicable',
        blockerCode: null,
        available: true,
        eligible: true,
        reason: missingArtifacts.join('; '),
        stale: true,
        tag: 'stale',
        evidence: missingArtifacts,
        evidenceRevision: null,
      };
    }
    return {
      status: 'not-applicable',
      blockerCode: null,
      available: false,
      eligible: false,
      reason: 'workspace still active',
      stale: false,
      tag: 'active',
      evidence: [],
      evidenceRevision: null,
    };
  }
  if (matchingDeliveries.length > 1) {
    return blockedCleanupProjection(
      'delivery-ambiguous',
      `Multiple immutable deliveries match this task binding: ${matchingDeliveries.map((entry) => `#${entry.prNumber}`).join(', ')}.`,
      lock,
      worktreeExists,
      branchExists,
    );
  }

  const branchHeadSha = branchExists
    ? runGit(options.repoRoot, ['rev-parse', '--verify', `refs/heads/${lock.branchName}`], true)?.trim() ?? ''
    : '';
  const remoteBaseRef = `origin/${options.baseBranch}`;
  const evidenceRevision: CleanupEvidenceRevision | null = options.baseBranchSha
    ? { remoteBaseSha: options.baseBranchSha, observedAt: checkedAt, source: 'snapshot-local' }
    : null;
  const delivery = matchingDeliveries[0] ?? null;
  let proof: DeliveryProof | null = null;
  let proofContained = false;
  if (delivery && branchHeadSha === delivery.prHeadSha && evidenceRevision) {
    proof = {
      kind: 'merged-pr-head',
      prNumber: delivery.prNumber,
      prHeadSha: delivery.prHeadSha,
      mergedSha: delivery.mergedSha,
      remoteBaseRef,
      remoteBaseSha: evidenceRevision.remoteBaseSha,
    };
    proofContained = gitIsAncestor(options.repoRoot, delivery.mergedSha, evidenceRevision.remoteBaseSha);
  } else if (branchHeadSha && evidenceRevision && gitIsAncestor(options.repoRoot, branchHeadSha, evidenceRevision.remoteBaseSha)) {
    proof = {
      kind: 'remote-ancestor',
      branchHeadSha,
      remoteBaseRef,
      remoteBaseSha: evidenceRevision.remoteBaseSha,
    };
    proofContained = true;
  }

  const sharedRepoRoot = options.commonDir ? resolveSharedRepoRoot(options.commonDir) : null;
  const status = worktreeExists && sharedRepoRoot
    ? inspectCleanupStatus({
      worktreePath: lock.worktreePath,
      sharedRepoRoot,
      disposableIgnoredPaths: options.config.cleanup?.disposableIgnoredPaths,
    })
    : {
      ok: true,
      trackedChanges: 0,
      untrackedEntries: [],
      ignoredEntries: [],
      protectedIgnoredEntries: [],
    };
  const assessment = assessTaskCleanup({
    automatic: true,
    automaticEnabled: automaticWorktreeCleanupEnabled(options.config),
    lock,
    taskBindingId: lock.taskBindingId ?? '',
    sharedRepoRoot,
    callerCwd: options.callerCwd,
    worktreeExists,
    observedBranchName: worktreeExists
      ? runGit(lock.worktreePath, ['branch', '--show-current'], true)?.trim() ?? ''
      : '',
    branchHeadSha,
    branchExists,
    status,
    proof,
    proofContained,
    evidence: evidenceRevision,
  });
  const artifactEvidence = [
    ...(!worktreeExists ? [`saved worktree ${lock.worktreePath} no longer exists`] : []),
    ...(!branchExists ? [`saved branch ${lock.branchName} no longer exists`] : []),
  ];
  if (assessment.status === 'eligible') {
    return {
      status: 'eligible',
      blockerCode: null,
      available: true,
      eligible: true,
      reason: 'typed delivery proof and local workspace safety checks allow cleanup',
      stale: artifactEvidence.length > 0,
      tag: 'ready',
      evidence: artifactEvidence,
      evidenceRevision: assessment.evidence,
    };
  }
  if (assessment.status === 'kept') {
    const disabled = assessment.reason === 'automatic-cleanup-disabled';
    return {
      status: 'kept',
      blockerCode: disabled ? 'automatic-cleanup-disabled' : null,
      available: false,
      eligible: false,
      reason: disabled
        ? 'automatic cleanup is disabled by machine-local repository policy'
        : 'workspace retained by --keep-worktree until explicit scoped cleanup',
      stale: false,
      tag: 'kept',
      evidence: artifactEvidence,
      evidenceRevision,
    };
  }
  return {
    status: 'blocked',
    blockerCode: assessment.code,
    available: true,
    eligible: false,
    reason: assessment.reason,
    stale: artifactEvidence.length > 0,
    tag: 'blocked',
    evidence: artifactEvidence,
    evidenceRevision,
  };
}

function blockedCleanupProjection(
  code: AutoCleanupBlockerCode,
  reason: string,
  lock: TaskLock,
  worktreeExists: boolean,
  branchExists: boolean,
): BranchRow['cleanup'] {
  return {
    status: 'blocked',
    blockerCode: code,
    available: true,
    eligible: false,
    reason,
    stale: !worktreeExists || !branchExists,
    tag: 'blocked',
    evidence: [
      ...(!worktreeExists ? [`saved worktree ${lock.worktreePath} no longer exists`] : []),
      ...(!branchExists ? [`saved branch ${lock.branchName} no longer exists`] : []),
    ],
    evidenceRevision: null,
  };
}

function gitIsAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  if (!ancestor || !descendant) return false;
  return runCommandCapture('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoRoot }).ok;
}

function buildCleanupSummary(branches: BranchRow[], config: WorkflowConfig): SnapshotData['cleanupSummary'] {
  const summary: SnapshotData['cleanupSummary'] = {
    automaticEnabled: automaticWorktreeCleanupEnabled(config),
    pending: 0,
    eligible: 0,
    kept: 0,
    blocked: 0,
    blockedByCode: {},
  };
  for (const branch of branches) {
    if (branch.cleanup.status === 'pending') summary.pending += 1;
    if (branch.cleanup.status === 'eligible') summary.eligible += 1;
    if (branch.cleanup.status === 'kept') summary.kept += 1;
    if (branch.cleanup.status === 'blocked') {
      summary.blocked += 1;
      if (branch.cleanup.blockerCode) {
        summary.blockedByCode[branch.cleanup.blockerCode] = (summary.blockedByCode[branch.cleanup.blockerCode] ?? 0) + 1;
      }
    }
  }
  return summary;
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
  prNumber?: number;
  checkedAt: string;
}): ApiActionState[] {
  const actions: ApiActionState[] = [];
  const { worktreeExists, dirty, prRecord, mode, localCell, prCell, stagingCell, productionCell, cleanup, taskSlug, prNumber, checkedAt } = options;

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
        ...(prNumber ? { defaultParams: { pr: String(prNumber) } } : {}),
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
        ...(prNumber ? { defaultParams: { pr: String(prNumber) } } : {}),
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
