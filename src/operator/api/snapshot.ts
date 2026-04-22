import { existsSync } from 'node:fs';

import type { DeployRecord, PrRecord, ProbeState, SmokeEnvironmentLock, SmokeRunRecord, TaskLock, WorkflowConfig } from '../state.ts';
import {
  DEFAULT_MODE,
  loadAllTaskLocks,
  loadDeployState,
  loadSmokeEnvironmentLock,
  loadSmokeLatestState,
  loadSmokeRegistry,
  loadPrState,
  loadProbeState,
  nowIso,
  resolveWorkflowContext,
  runGit,
} from '../state.ts';
import {
  emptyDeployConfig,
  evaluateReleaseReadiness,
  explainSurfaceProbe,
  isReleaseManagedSurface,
  loadDeployConfig,
  resolveSurfaceProbeUrl,
  unsupportedSurfaceReason,
  type DeployConfig,
  type ReleaseReadinessBlocker,
  type ProbeFreshnessState,
  type ProbeSurfaceFreshness,
} from '../release-gate.ts';
import { evaluateSmokeCoverage, resolveSmokeConfig } from '../smoke-gate.ts';
import {
  observeFrontendRuntime,
  type FrontendRuntimeObservation,
} from '../runtime-observation.ts';
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
  smoke: {
    staging: SmokeRunRecord | null;
    prod: SmokeRunRecord | null;
    locks: SmokeEnvironmentLock[];
  };
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
  const smokeLatest = loadSmokeLatestState(context.commonDir, context.config);
  const smokeConfig = resolveSmokeConfig(context.config);
  const smokeRegistry = loadSmokeRegistry(context.repoRoot, context.config);
  const smokeLocks = (['staging', 'prod'] as const)
    .map((environment) => loadSmokeEnvironmentLock(context.commonDir, environment))
    .filter((entry): entry is SmokeEnvironmentLock => entry !== null);
  const probeState = loadProbeState(context.commonDir, context.config);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const requestedSurfaces = context.modeState.requestedSurfaces ?? context.config.surfaces;
  const smokeCoverage = evaluateSmokeCoverage({
    registry: smokeRegistry,
    environment: 'staging',
    config: context.config,
  });
  const smokeCoverageBlocking = mode === 'release'
    && smokeConfig.requireStagingSmoke
    && smokeCoverage.mode === 'block'
    && smokeCoverage.uncoveredCriticalPaths.length > 0;
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

  const branches = buildBranchRows({
    locks,
    config: context.config,
    currentBranch,
    baseBranch,
    baseBranchSha,
    prRecords: prState.records,
    deployRecords: deployState.records,
    mode,
    checkedAt,
  });

  const activeLock = locks.find((lock) => lock.branchName === currentBranch) ?? null;
  const currentCheckout = buildCurrentCheckoutTruth({
    checkedAt,
    currentBranch,
    currentHeadSha,
    baseBranch,
    baseBranchSha,
    activeLock,
    currentPrRecord: activeLock ? prState.records[activeLock.taskSlug] ?? null : null,
    deployRecords: deployState.records,
    deployConfig,
    runtimeObservation,
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
      name: 'smoke.staging',
      state: smokeLaneState(smokeLatest.staging),
      blocking: context.modeState.mode === 'release' && smokeConfig.requireStagingSmoke,
      reason: describeSmokeSummary(smokeLatest.staging, 'staging'),
      checkedAt,
      observedAt: smokeLatest.staging?.finishedAt,
    }),
    buildSourceHealthEntry({
      name: 'smoke.prod',
      state: smokeLaneState(smokeLatest.prod),
      blocking: false,
      reason: describeSmokeSummary(smokeLatest.prod, 'prod'),
      checkedAt,
      observedAt: smokeLatest.prod?.finishedAt,
    }),
    ...(smokeConfig.criticalPaths.length > 0
      ? [
          buildSourceHealthEntry({
            name: 'smoke.coverage',
            state: smokeCoverage.uncoveredCriticalPaths.length === 0
              ? 'healthy'
              : smokeCoverageBlocking
                ? 'blocked'
                : 'degraded',
            blocking: smokeCoverageBlocking,
            reason: smokeCoverage.uncoveredCriticalPaths.length === 0
              ? 'critical paths covered by the smoke registry'
              : `critical path smoke gaps: ${smokeCoverage.uncoveredCriticalPaths.join(', ')}`,
            checkedAt,
          }),
        ]
      : []),
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
      message: `staging ${entry.surface} probe ${entry.result.state}: ${entry.result.reason}. Run \`pipelane:doctor --probe\`.`,
      source: 'probeState',
      blocking: true,
      lane: 'staging',
      action: 'doctor.probe',
    }));
  }
  for (const lock of smokeLocks) {
    attention.push(buildApiIssue({
      code: 'smoke.locked',
      severity: 'warning',
      message: `${lock.environment} ${lock.operation} in progress: ${lock.runId}.`,
      source: 'smokeLock',
      blocking: false,
      lane: lock.environment,
    }));
  }
  if (!smokeLatest.staging) {
    attention.push(buildApiIssue({
      code: 'smoke.staging.missing',
      severity: context.modeState.mode === 'release' && smokeConfig.requireStagingSmoke ? 'error' : 'warning',
      message: 'No staging smoke history yet. Run `pipelane:smoke -- staging` before promoting.',
      source: 'smokeLatest',
      blocking: context.modeState.mode === 'release' && smokeConfig.requireStagingSmoke,
      lane: 'staging',
      action: 'smoke.staging',
    }));
  } else if (smokeLatest.staging?.status === 'failed') {
    attention.push(buildApiIssue({
      code: 'smoke.staging.failed',
      severity: context.modeState.mode === 'release' && smokeConfig.requireStagingSmoke ? 'error' : 'warning',
      message: `Latest staging smoke failed for ${smokeLatest.staging.sha.slice(0, 7)}.`,
      source: 'smokeLatest',
      blocking: context.modeState.mode === 'release' && smokeConfig.requireStagingSmoke,
      lane: 'staging',
      action: 'smoke.staging',
    }));
  }
  if (smokeLatest.prod?.status === 'failed') {
    attention.push(buildApiIssue({
      code: 'smoke.prod.failed',
      severity: 'warning',
      message: `Latest prod smoke failed for ${smokeLatest.prod.sha.slice(0, 7)}.`,
      source: 'smokeLatest',
      blocking: false,
      lane: 'production',
      action: 'smoke.prod',
    }));
  }
  if (smokeCoverage.uncoveredCriticalPaths.length > 0) {
    attention.push(buildApiIssue({
      code: 'smoke.coverage.missing',
      severity: smokeCoverageBlocking ? 'error' : 'warning',
      message: `Staging smoke coverage gaps: ${smokeCoverage.uncoveredCriticalPaths.join(', ')}. Run \`pipelane:smoke -- plan\`.`,
      source: 'smokeRegistry',
      blocking: smokeCoverageBlocking,
      lane: 'staging',
      action: 'smoke.plan',
    }));
  }
  const staleBaseIssue = buildStaleBaseIssue({
    currentBranch,
    baseBranch,
    currentHeadSha,
    baseBranchSha,
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

  const boardMessage = mode === 'release'
    ? 'Release mode: promote merged SHA through staging before prod.'
    : 'Build mode: production deploys run automatically after merge.';

  return buildApiEnvelope<SnapshotData>({
    command: 'pipelane.api.snapshot',
    ok: true,
    message: 'pipelane API snapshot ready',
    data: {
      boardContext: {
        mode,
        baseBranch,
        laneOrder: ['Local', 'PR', `Base: ${baseBranch}`, 'Staging', 'Production'],
        releaseReadiness: buildBoardReleaseReadiness({
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
        }),
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
      smoke: {
        staging: smokeLatest.staging,
        prod: smokeLatest.prod,
        locks: smokeLocks,
      },
      sourceHealth,
      attention,
      availableActions: [],
      branches,
    },
  });
}

function smokeLaneState(record: SmokeRunRecord | null): LaneState {
  if (!record) return 'unknown';
  if (record.status === 'passed' || record.status === 'passed_with_retries') return 'healthy';
  return 'degraded';
}

function describeSmokeSummary(record: SmokeRunRecord | null, environment: 'staging' | 'prod'): string {
  if (!record) {
    return `no ${environment} smoke history`;
  }
  return `${record.status} @ ${record.sha.slice(0, 7)} (${record.finishedAt})`;
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

export function buildBranchRows(options: {
  locks: TaskLock[];
  config: WorkflowConfig;
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

  const worktreeToOrigin = compareWorktreeToOrigin({
    currentBranch: options.currentBranch,
    baseBranch: options.baseBranch,
    worktreeSha: worktreeLayer.sha,
    originSha: originLayer.sha,
  });
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
  currentBranch: string;
  baseBranch: string;
  worktreeSha: string | null;
  originSha: string | null;
}): CheckoutTruthRelationship {
  if (!options.worktreeSha || !options.originSha) {
    return {
      state: 'not-comparable',
      reason: 'worktree or remote base SHA is unavailable',
    };
  }
  if (options.worktreeSha === options.originSha) {
    return {
      state: 'match',
      reason: `this checkout matches origin/${options.baseBranch}`,
    };
  }
  if (options.currentBranch === options.baseBranch) {
    return {
      state: 'drift',
      reason: `this checkout's ${options.baseBranch} is behind origin/${options.baseBranch}`,
    };
  }
  return {
    state: 'drift',
    reason: `current worktree remains on ${options.currentBranch}; origin/${options.baseBranch} moved independently`,
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
    return `this checkout's ${options.baseBranch} is behind origin/${options.baseBranch}`;
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
  currentBranch: string;
  baseBranch: string;
  currentHeadSha: string;
  baseBranchSha: string;
}): ApiIssue | null {
  if (!options.currentHeadSha || !options.baseBranchSha) return null;
  if (options.currentBranch !== options.baseBranch) return null;
  if (options.currentHeadSha === options.baseBranchSha) return null;
  return buildApiIssue({
    code: 'git.base.stale',
    severity: 'warning',
    message: `local ${options.baseBranch} in this checkout is behind origin/${options.baseBranch}. Refresh this checkout if you want merged code locally.`,
    source: 'git',
    blocking: false,
    lane: 'base',
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
