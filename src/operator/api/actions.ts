import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { ParsedOperatorArgs } from '../state.ts';
import {
  appendActionRunRecord,
  loadDeployState,
  loadAllTaskLocks,
  loadProbeState,
  loadTaskLock,
  normalizeExistingPath,
  nowIso,
  reviewArtifactRoot,
  resolveWorkflowContext,
  runGit,
  slugifyTaskName,
  type DeployRecord,
  type TaskLock,
  type WorkflowContext,
} from '../state.ts';
import {
  buildReleaseCheckMessage,
  computeDeployConfigFingerprint,
  emptyDeployConfig,
  evaluateReleaseReadiness,
  loadDeployConfig,
  normalizeDeployEnvironment,
  releaseReadinessHasOnlyStaleProbeAgeBlockers,
  resolveDeployStateKey,
  verifyDeployRecord,
} from '../release-gate.ts';
import {
  assertTaskCommandWorktree,
  buildStaleBaseBlocker,
  findLastGoodDeploy,
  inferActiveTaskLock,
  resolveCommandSurfaces,
  resolveModeSurfaces,
  resolveModeTaskLock,
} from '../commands/helpers.ts';
import {
  diagnoseTaskBinding,
  isTaskBindingRecovery,
  resolveLocalPrTitleRequirement,
  validateTaskBindingRecoverySelection,
} from '../task-binding.ts';
import {
  buildApiEnvelope,
  buildFreshness,
  type ApiEnvelope,
  type ApiActionInput,
  type LaneState,
} from './envelope.ts';
import {
  buildActionFingerprint,
  consumeActionConfirmation,
  createActionConfirmation,
} from './confirm-tokens.ts';
import {
  buildDestinationPlanForCommand,
  destinationPlanFingerprintDigest,
  type DestinationPlan,
} from '../destination-planner.ts';
import { buildMissingDeployOnboardingMessage } from '../onboarding.ts';
import {
  DESTINATION_APPROVED_ROUTE_FINGERPRINT_ENV,
  DESTINATION_ROUTE_PROD_CONFIRMED_ENV,
} from '../destination-executor.ts';
import { evaluateReviewEvidenceForPr, reviewEvidenceOverrideReason, type ReviewEvidenceCheckResult } from '../review-enforcement.ts';
import {
  DEPLOY_PROD_APPROVED_DISPATCH_CONFIG_ENV,
  DEPLOY_PROD_APPROVED_SHA_ENV,
  DEPLOY_PROD_APPROVED_SURFACES_ENV,
  DEPLOY_PROD_DIRECT_API_CONFIRMED_ENV,
  computeDeployApprovalDispatchFingerprint,
  resolveDeployApprovalInputs,
} from '../commands/deploy.ts';
import { projectReviewRun, type ReviewRunPresentation } from '../review-output.ts';
import { assertManagedLocalStateValid, assertManagedLocalStateValidForTree } from '../local-state.ts';
import { CLEAN_APPROVED_LOCKS_ENV } from '../commands/clean.ts';

export type ApiManagedLocalStateSensitivity = 'observe' | 'current-state' | 'target-tree' | 'independent-recovery';

export interface StableActionMetadata {
  readonly label: string;
  readonly risky: boolean;
  readonly managedStateSensitivity: ApiManagedLocalStateSensitivity;
  readonly browserExposed: boolean;
}

type StableActionMetadataInput = Omit<StableActionMetadata, 'risky' | 'browserExposed'>
  & Partial<Pick<StableActionMetadata, 'risky' | 'browserExposed'>>;

function stableAction(metadata: StableActionMetadataInput): StableActionMetadata {
  return Object.freeze({
    risky: false,
    browserExposed: false,
    ...metadata,
  });
}

// This registry is the sole declaration point for stable API actions. The
// Board consumes browserExposed from here instead of treating every API action
// as browser-reachable. Omitted exposure is deliberately fail-closed.
export const STABLE_ACTION_METADATA = Object.freeze({
  new: stableAction({ label: 'Create task workspace', managedStateSensitivity: 'target-tree', browserExposed: true }),
  resume: stableAction({ label: 'Resume task workspace', managedStateSensitivity: 'observe', browserExposed: true }),
  'devmode.build': stableAction({ label: 'Switch to build mode', managedStateSensitivity: 'observe', browserExposed: true }),
  'devmode.release': stableAction({ label: 'Switch to release mode', managedStateSensitivity: 'observe', browserExposed: true }),
  'taskLock.verify': stableAction({ label: 'Verify task lock', managedStateSensitivity: 'observe' }),
  pr: stableAction({ label: 'Prepare PR', managedStateSensitivity: 'current-state', browserExposed: true }),
  merge: stableAction({ label: 'Merge PR', risky: true, managedStateSensitivity: 'independent-recovery', browserExposed: true }),
  'deploy.staging': stableAction({ label: 'Deploy staging', managedStateSensitivity: 'current-state', browserExposed: true }),
  'deploy.prod': stableAction({ label: 'Deploy production', risky: true, managedStateSensitivity: 'current-state', browserExposed: true }),
  'route.merge': stableAction({ label: 'Take task to merge', risky: true, managedStateSensitivity: 'current-state', browserExposed: true }),
  'route.deploy.staging': stableAction({ label: 'Take task to staging', risky: true, managedStateSensitivity: 'current-state', browserExposed: true }),
  'route.deploy.prod': stableAction({ label: 'Take task to production', risky: true, managedStateSensitivity: 'current-state', browserExposed: true }),
  'clean.plan': stableAction({ label: 'Plan cleanup', managedStateSensitivity: 'observe', browserExposed: true }),
  'clean.apply': stableAction({ label: 'Apply cleanup', risky: true, managedStateSensitivity: 'independent-recovery', browserExposed: true }),
  // doctor.diagnose remains available to direct API clients, but the Board has
  // no diagnosis action UI and therefore does not expose it by default.
  'doctor.diagnose': stableAction({ label: 'Diagnose deploy configuration', managedStateSensitivity: 'observe' }),
  // doctor.probe writes probe-state.json but only stores observed liveness.
  // doctor.fix remains interactive and is not a stable API action.
  'doctor.probe': stableAction({ label: 'Run live healthcheck probe', managedStateSensitivity: 'observe', browserExposed: true }),
  'git.catchupBase': stableAction({ label: 'Catch up local base branch', managedStateSensitivity: 'target-tree', browserExposed: true }),
  // --revert-pr remains outside the API because its branch conflict handling
  // is TTY-owned. Production rollback keeps its existing confirmation layer.
  'rollback.staging': stableAction({ label: 'Rollback staging to last-good deploy', managedStateSensitivity: 'independent-recovery', browserExposed: true }),
  'rollback.prod': stableAction({ label: 'Rollback production to last-good deploy', risky: true, managedStateSensitivity: 'independent-recovery', browserExposed: true }),
} as const satisfies Record<string, StableActionMetadata>);

export type StableActionId = keyof typeof STABLE_ACTION_METADATA;

export const STABLE_ACTION_IDS: readonly StableActionId[] = Object.freeze(
  Object.keys(STABLE_ACTION_METADATA) as StableActionId[],
);

export const STABLE_ACTION_MANAGED_STATE_SENSITIVITY: Readonly<Record<StableActionId, ApiManagedLocalStateSensitivity>> = Object.freeze(
  Object.fromEntries(
    STABLE_ACTION_IDS.map((actionId) => [actionId, STABLE_ACTION_METADATA[actionId].managedStateSensitivity]),
  ) as Record<StableActionId, ApiManagedLocalStateSensitivity>,
);

export function classifyStableActionManagedStateSensitivity(actionId: StableActionId): ApiManagedLocalStateSensitivity {
  const sensitivity = STABLE_ACTION_MANAGED_STATE_SENSITIVITY[actionId];
  if (!sensitivity) throw new Error(`Managed local-state sensitivity is not classified for stable API action ${actionId}.`);
  return sensitivity;
}

export const API_RISKY_ACTION_IDS: ReadonlySet<StableActionId> = new Set(
  STABLE_ACTION_IDS.filter((actionId) => STABLE_ACTION_METADATA[actionId].risky),
);

const ACTION_FEEDBACK_MAX_OUTPUT_CHARS = 20_000;

export interface ActionPreflightData {
  action: { id: string; label: string; risky: boolean };
  preflight: {
    allowed: boolean;
    state: LaneState;
    reason: string;
    needsInput: boolean;
    missingInputs: string[];
    inputs: ApiActionInput[];
    defaultParams: Record<string, unknown>;
    warnings: string[];
    issues: unknown[];
    normalizedInputs: Record<string, unknown>;
    requiresConfirmation: boolean;
    confirmation: { token: string; expiresAt: string } | null;
    freshness: ReturnType<typeof buildFreshness>;
    destinationPlan?: DestinationPlan;
    review?: ReviewRunPresentation | null;
  };
}

export interface ActionExecutionData extends ActionPreflightData {
  execution: {
    exitCode: number;
    result: unknown;
    stderr: string;
  };
}

export function isStableActionId(value: string): value is StableActionId {
  return Object.hasOwn(STABLE_ACTION_METADATA, value);
}

export function isStableActionBrowserExposed(value: string): value is StableActionId {
  return isStableActionId(value) && STABLE_ACTION_METADATA[value].browserExposed;
}

export function buildActionPreflightEnvelope(cwd: string, actionId: StableActionId, parsed: ParsedOperatorArgs): ApiEnvelope<ActionPreflightData> {
  const onboardingBlock = buildDeployActionOnboardingBlock(cwd, actionId, parsed);
  if (onboardingBlock) {
    return onboardingBlock;
  }

  const context = resolveWorkflowContext(cwd);
  const worktreeBlock = buildTaskApiActionWorktreeBlock(context, cwd, actionId, parsed);
  if (worktreeBlock) {
    return worktreeBlock;
  }
  assertStableActionManagedState(context.repoRoot, actionId);
  const routePlan = buildRoutePlanForAction(cwd, actionId, parsed);
  const destinationPlan = routePlan.destinationPlan;
  let normalizedInputs: Record<string, unknown>;
  try {
    normalizedInputs = normalizeInputs(actionId, parsed, cwd, destinationPlan, routePlan.error);
  } catch (error) {
    return buildActionResolutionBlock({
      context,
      actionId,
      parsed,
      destinationPlan,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const risky = API_RISKY_ACTION_IDS.has(actionId);
  const requiresConfirmation = actionRequiresConfirmation(actionId, normalizedInputs);
  const checkedAt = nowIso();

  const gate = evaluatePreflightGate(context, actionId, normalizedInputs);
  if (gate.allowed === false) {
    const data: ActionPreflightData = {
      action: { id: actionId, label: STABLE_ACTION_METADATA[actionId].label, risky },
      preflight: {
        allowed: false,
        state: 'blocked',
        reason: gate.reason,
        needsInput: gate.needsInput ?? false,
        missingInputs: gate.missingInputs ?? [],
        inputs: gate.inputs ?? [],
        defaultParams: gate.defaultParams ?? {},
        warnings: [],
        issues: gate.issues ?? [],
        review: gate.review ?? null,
        normalizedInputs,
        requiresConfirmation: false,
        confirmation: null,
        freshness: buildFreshness({ checkedAt, stale: true }),
        ...(destinationPlan ? { destinationPlan } : {}),
      },
    };
    return buildApiEnvelope<ActionPreflightData>({
      command: 'pipelane.api.action',
      ok: false,
      message: gate.reason,
      data,
    });
  }

  let confirmation: { token: string; expiresAt: string } | null = null;
  if (requiresConfirmation) {
    const fingerprint = buildActionFingerprint(actionId, normalizedInputs);
    const record = createActionConfirmation(context.commonDir, context.config, {
      actionId,
      fingerprint,
      normalizedInputs,
    });
    confirmation = { token: record.token, expiresAt: record.expiresAt };
  }

  const data: ActionPreflightData = {
    action: { id: actionId, label: STABLE_ACTION_METADATA[actionId].label, risky },
    preflight: {
      allowed: true,
      state: 'healthy',
      reason: '',
      needsInput: false,
      missingInputs: [],
      inputs: [],
      defaultParams: {},
      warnings: [],
      issues: [],
      normalizedInputs,
      requiresConfirmation,
      confirmation,
      freshness: buildFreshness({ checkedAt }),
      ...(destinationPlan ? { destinationPlan } : {}),
    },
  };

  return buildApiEnvelope<ActionPreflightData>({
    command: 'pipelane.api.action',
    ok: true,
    message: `${actionId} preflight ready`,
    data,
  });
}

// v0.7: scope-aware preflight gating. Actions that need operator scope
// (e.g. clean.apply requires --task or --all-stale) emit
// allowed:false + state:blocked before a confirm token is ever issued.
// The CLI still enforces the same rule at execute time.
type PreflightGateResult =
  | { allowed: true; reason?: undefined }
  | PreflightGateBlocked;

interface PreflightGateBlocked {
  allowed: false;
  reason: string;
  needsInput?: boolean;
  missingInputs?: string[];
  inputs?: ApiActionInput[];
  defaultParams?: Record<string, unknown>;
  issues?: unknown[];
  review?: ReviewRunPresentation | null;
}

function reviewPresentationForEvidence(
  context: WorkflowContext,
  evidence: ReviewEvidenceCheckResult,
): ReviewRunPresentation | null {
  return evidence.latest
      ? projectReviewRun(evidence.latest, {
        artifactRoot: reviewArtifactRoot(context.commonDir, context.config),
        relation: 'current',
        consents: evidence.consents,
      })
    : null;
}

function evaluatePreflightGate(context: WorkflowContext, actionId: StableActionId, inputs: Record<string, unknown>): PreflightGateResult {
  if (reviewOverrideAppliesToAction(actionId) && inputs.override === true) {
    const reason = typeof inputs.reason === 'string' ? inputs.reason.trim() : '';
    if (!reason) {
      return {
        allowed: false,
        reason: 'Review gate override requires a reason.',
        needsInput: true,
        missingInputs: ['reason'],
        inputs: [{
          name: 'reason',
          label: 'Review override reason',
          type: 'text',
          required: true,
          placeholder: 'Why it is acceptable to skip review gate evidence',
        }],
        defaultParams: { override: true },
      };
    }
  }

  if (isRouteActionId(actionId)) {
    const routeSteps = routeStepsFromInputs(inputs);
    const blockers = Array.isArray(inputs.routeBlockers)
      ? inputs.routeBlockers.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (blockers.length > 0) {
      return {
        allowed: false,
        reason: blockers.join('; '),
      };
    }
    const routeBlocker = routeBaseFreshnessBlocker(context, routeSteps, inputs);
    if (routeBlocker) {
      return {
        allowed: false,
        reason: routeBlocker,
      };
    }
    if (routeSteps.includes('pr')) {
      const reviewEvidence = evaluateReviewEvidenceForPr(context);
      const overrideReason = reviewEvidenceOverrideReason({
        override: inputs.override === true,
        reason: typeof inputs.reason === 'string' ? inputs.reason : '',
      });
      if (!reviewEvidence.allowed && !overrideReason) {
        return {
          allowed: false,
          reason: reviewEvidence.message,
          issues: reviewEvidence.issues,
          review: reviewPresentationForEvidence(context, reviewEvidence),
        };
      }
    }
  }
  if (actionId === 'pr') {
    return evaluatePrPreflightGate(context, inputs);
  }
  if (actionId === 'merge' && !(typeof inputs.pr === 'string' && inputs.pr.trim())) {
    const staleBaseBlocker = buildStaleBaseBlocker(context, 'merge');
    if (staleBaseBlocker) {
      return {
        allowed: false,
        reason: staleBaseBlocker,
      };
    }
  }
  if (actionId === 'clean.apply') {
    const taskRaw = inputs.task;
    const task = typeof taskRaw === 'string' ? taskRaw.trim() : '';
    const allStale = inputs.allStale === true;
    if (!task && !allStale) {
      return {
        allowed: false,
        reason: '/clean --apply requires scope: pass --task <slug> or --all-stale.',
      };
    }
    if (task && allStale) {
      return {
        allowed: false,
        reason: '/clean --apply cannot combine --task and --all-stale.',
      };
    }
  }
  let modeTaskLock: ReturnType<typeof resolveModeTaskLock> = null;
  if (actionId === 'devmode.build' || actionId === 'devmode.release') {
    const task = typeof inputs.task === 'string' ? inputs.task : '';
    try {
      modeTaskLock = resolveModeTaskLock(context, task);
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (actionId === 'devmode.release') {
    const override = inputs.override === true;
    const reason = typeof inputs.reason === 'string' ? inputs.reason.trim() : '';
    const surfaces = Array.isArray(inputs.surfaces)
      ? inputs.surfaces.filter((entry): entry is string => typeof entry === 'string')
      : [];

    if (override && !reason) {
      return buildReleaseOverrideInputGate('Release override requires a reason.');
    }

    const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
    const deployState = loadDeployState(context.commonDir, context.config);
    const probeState = loadProbeState(context.commonDir, context.config);
    const requestedSurfaces = resolveModeSurfaces(context, surfaces, modeTaskLock);
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      deployRecords: deployState.records,
      probeState,
      surfaces: requestedSurfaces,
    });

    if (!override && !readiness.ready && !releaseReadinessHasOnlyStaleProbeAgeBlockers(readiness)) {
      const blocked = readiness.blockedSurfaces.join(', ') || requestedSurfaces.join(', ');
      return buildReleaseOverrideInputGate(
        [
          `Release readiness is blocked for ${blocked}. Provide an override reason, or resolve the blockers below and retry.`,
          buildReleaseCheckMessage(readiness, requestedSurfaces, context.config),
        ].join('\n\n'),
      );
    }
  }
  return { allowed: true };
}

function reviewOverrideAppliesToAction(actionId: StableActionId): boolean {
  return actionId === 'pr' || actionId === 'merge' || isRouteActionId(actionId);
}

function routeStepsFromInputs(inputs: Record<string, unknown>): string[] {
  const route = inputs.route && typeof inputs.route === 'object'
    ? inputs.route as { routeSteps?: unknown }
    : {};
  return Array.isArray(route.routeSteps)
    ? route.routeSteps.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function routeBaseFreshnessBlocker(context: WorkflowContext, routeSteps: string[], inputs: Record<string, unknown>): string {
  if (routeSteps.includes('pr')) {
    return buildStaleBaseBlocker(context, 'pr');
  }
  if (routeSteps.includes('merge') && !(typeof inputs.pr === 'string' && inputs.pr.trim())) {
    return buildStaleBaseBlocker(context, 'merge');
  }
  return '';
}

function evaluatePrPreflightGate(context: WorkflowContext, inputs: Record<string, unknown>): PreflightGateResult {
  const task = typeof inputs.task === 'string' ? inputs.task : '';
  const title = typeof inputs.title === 'string' ? inputs.title : '';
  const recover = typeof inputs.recover === 'string' ? inputs.recover.trim() : '';
  const bindingFingerprint = typeof inputs.bindingFingerprint === 'string' ? inputs.bindingFingerprint.trim() : '';
  const overrideReason = reviewEvidenceOverrideReason({
    override: inputs.override === true,
    reason: typeof inputs.reason === 'string' ? inputs.reason : '',
  });

  if (recover) {
    if (!isTaskBindingRecovery(recover)) {
      return {
        allowed: false,
        reason: `Unknown task recovery option "${recover}". Run the preflight again.`,
      };
    }
    let diagnosis: ReturnType<typeof validateTaskBindingRecoverySelection>;
    try {
      diagnosis = validateTaskBindingRecoverySelection(context, task, recover, bindingFingerprint);
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    const staleBaseBlocker = buildStaleBaseBlocker(context, 'pr');
    if (staleBaseBlocker) {
      return {
        allowed: false,
        reason: staleBaseBlocker,
      };
    }
    const titleRequirement = recover === 'use-current-checkout'
      ? resolveLocalPrTitleRequirement(context, diagnosis.taskSlug, diagnosis.current.branchName, title)
      : { required: false, defaultTitle: '' };
    if (titleRequirement.required) {
      return buildPrTitleInputGate(
        'This checkout has local changes and no live PR yet. Provide a PR title before using the current checkout.',
        {
          task: diagnosis.taskSlug,
          recover,
          bindingFingerprint,
          ...(titleRequirement.defaultTitle ? { title: titleRequirement.defaultTitle } : {}),
        },
      );
    }
    if (recover === 'use-current-checkout') {
      const reviewEvidence = evaluateReviewEvidenceForPr(context);
      if (!reviewEvidence.allowed && !overrideReason) {
        return {
          allowed: false,
          reason: reviewEvidence.message,
          issues: reviewEvidence.issues,
          review: reviewPresentationForEvidence(context, reviewEvidence),
        };
      }
    }
    return { allowed: true };
  }

  const diagnosis = diagnoseTaskBinding(context, task);
  if (diagnosis.status === 'resolved') {
    const staleBaseBlocker = buildStaleBaseBlocker(context, 'pr');
    if (staleBaseBlocker) {
      return {
        allowed: false,
        reason: staleBaseBlocker,
      };
    }
    const titleRequirement = resolveLocalPrTitleRequirement(
      context,
      diagnosis.taskSlug,
      diagnosis.current.branchName,
      title,
    );
    if (titleRequirement.required) {
      return buildPrTitleInputGate(
        'This checkout has local changes and no live PR yet. Provide a PR title before opening the PR.',
        {
          task: diagnosis.taskSlug,
          ...(titleRequirement.defaultTitle ? { title: titleRequirement.defaultTitle } : {}),
        },
      );
    }
    const reviewEvidence = evaluateReviewEvidenceForPr(context);
    if (!reviewEvidence.allowed && !overrideReason) {
      return {
        allowed: false,
        reason: reviewEvidence.message,
        issues: reviewEvidence.issues,
        review: reviewPresentationForEvidence(context, reviewEvidence),
      };
    }
    return { allowed: true };
  }
  if (diagnosis.status === 'blocked') {
    return {
      allowed: false,
      reason: diagnosis.reason,
    };
  }

  const inputsToCollect: ApiActionInput[] = [
    {
      name: 'recover',
      label: 'Task workspace',
      type: 'choice',
      required: true,
      placeholder: '',
      options: diagnosis.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        params: option.params,
      })),
    },
  ];
  return {
    allowed: false,
    reason: diagnosis.reason,
    needsInput: true,
    missingInputs: ['recover'],
    inputs: inputsToCollect,
    defaultParams: { task: diagnosis.taskSlug },
  };
}

function buildPrTitleInputGate(reason: string, defaultParams: Record<string, unknown>): PreflightGateResult {
  return {
    allowed: false,
    reason,
    needsInput: true,
    missingInputs: ['title'],
    inputs: [prTitleInput()],
    defaultParams,
  };
}

function prTitleInput(): ApiActionInput {
  return {
    name: 'title',
    label: 'PR title',
    type: 'text',
    required: true,
    placeholder: 'Short PR title',
  };
}

function buildReleaseOverrideInputGate(reason: string): PreflightGateResult {
  return {
    allowed: false,
    reason,
    needsInput: true,
    missingInputs: ['reason'],
    inputs: [
      {
        name: 'reason',
        label: 'Release override reason',
        type: 'text',
        required: true,
        placeholder: 'Why are you overriding release readiness?',
      },
    ],
    defaultParams: { override: true },
  };
}

function deployEnvironmentForAction(actionId: StableActionId): 'staging' | 'prod' | null {
  if (actionId === 'deploy.staging' || actionId === 'route.deploy.staging') {
    return 'staging';
  }
  if (actionId === 'deploy.prod' || actionId === 'route.deploy.prod') {
    return 'prod';
  }
  return null;
}

function buildDeployActionOnboardingBlock(
  cwd: string,
  actionId: StableActionId,
  parsed: ParsedOperatorArgs,
): ApiEnvelope<ActionPreflightData> | null {
  const environment = deployEnvironmentForAction(actionId);
  if (!environment) {
    return null;
  }

  const message = buildMissingDeployOnboardingMessage(cwd, {
    environment,
    pr: parsed.flags.pr,
  });
  if (!message) {
    return null;
  }

  const checkedAt = nowIso();
  // Onboarding is already the authoritative blocker. Keep normalization pure
  // here so effect resolution cannot throw before the structured remedy is
  // returned for an unconfigured repository.
  const normalizedInputs = normalizeInputs(actionId, parsed, undefined, null);
  if (actionId === 'route.deploy.staging' || actionId === 'route.deploy.prod') {
    normalizedInputs.routeBlockers = ['repo not onboarded'];
  }
  const data: ActionPreflightData = {
    action: {
      id: actionId,
      label: STABLE_ACTION_METADATA[actionId].label,
      risky: API_RISKY_ACTION_IDS.has(actionId),
    },
    preflight: {
      allowed: false,
      state: 'blocked',
      reason: message,
      needsInput: false,
      missingInputs: [],
      inputs: [],
      defaultParams: {},
      warnings: [],
      issues: [],
      normalizedInputs,
      requiresConfirmation: false,
      confirmation: null,
      freshness: buildFreshness({ checkedAt, stale: true }),
    },
  };

  return buildApiEnvelope<ActionPreflightData>({
    command: 'pipelane.api.action',
    ok: false,
    message,
    data,
  });
}

function buildTaskApiActionWorktreeBlock(
  context: WorkflowContext,
  cwd: string,
  actionId: StableActionId,
  parsed: ParsedOperatorArgs,
): ApiEnvelope<ActionPreflightData> | null {
  try {
    assertTaskApiActionWorktree(context, actionId, parsed);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const checkedAt = nowIso();
    // Do not build a destination plan here: the cwd guard intentionally runs
    // before route/base/dirty measurements. Basic flag normalization is pure;
    // for route actions the message also becomes the route blocker.
    const normalizedInputs = normalizeInputs(actionId, parsed, undefined, null, message);
    const data: ActionPreflightData = {
      action: {
        id: actionId,
        label: STABLE_ACTION_METADATA[actionId].label,
        risky: API_RISKY_ACTION_IDS.has(actionId),
      },
      preflight: {
        allowed: false,
        state: 'blocked',
        reason: message,
        needsInput: false,
        missingInputs: [],
        inputs: [],
        defaultParams: {},
        warnings: [],
        issues: [],
        normalizedInputs,
        requiresConfirmation: false,
        confirmation: null,
        freshness: buildFreshness({ checkedAt, stale: true }),
      },
    };
    return buildApiEnvelope<ActionPreflightData>({
      command: 'pipelane.api.action',
      ok: false,
      message,
      data,
    });
  }
}

function buildActionResolutionBlock(options: {
  context: WorkflowContext;
  actionId: StableActionId;
  parsed: ParsedOperatorArgs;
  destinationPlan?: DestinationPlan | null;
  message: string;
  persist?: boolean;
}): ApiEnvelope<ActionPreflightData> {
  const checkedAt = nowIso();
  // Resolution already failed, so reconstruct only the raw, side-effect-free
  // inputs. This preserves the JSON contract while the reason carries the
  // exact missing-lock/SHA/merge remedy.
  const normalizedInputs = normalizeInputs(
    options.actionId,
    options.parsed,
    undefined,
    options.destinationPlan,
    options.message,
  );
  if (options.persist) {
    persistActionPreflightBlockIfTaskScoped({
      context: options.context,
      actionId: options.actionId,
      label: STABLE_ACTION_METADATA[options.actionId].label,
      normalizedInputs,
      checkedAt,
      reason: options.message,
    });
  }
  const data: ActionPreflightData = {
    action: {
      id: options.actionId,
      label: STABLE_ACTION_METADATA[options.actionId].label,
      risky: API_RISKY_ACTION_IDS.has(options.actionId),
    },
    preflight: {
      allowed: false,
      state: 'blocked',
      reason: options.message,
      needsInput: false,
      missingInputs: [],
      inputs: [],
      defaultParams: {},
      warnings: [],
      issues: [],
      normalizedInputs,
      requiresConfirmation: false,
      confirmation: null,
      freshness: buildFreshness({ checkedAt, stale: true }),
      ...(options.destinationPlan ? { destinationPlan: options.destinationPlan } : {}),
    },
  };
  return buildApiEnvelope<ActionPreflightData>({
    command: 'pipelane.api.action',
    ok: false,
    message: options.message,
    data,
  });
}

export async function runActionExecute(cwd: string, actionId: StableActionId, parsed: ParsedOperatorArgs, confirmToken: string): Promise<ApiEnvelope<ActionExecutionData | ActionPreflightData>> {
  const onboardingBlock = buildDeployActionOnboardingBlock(cwd, actionId, parsed);
  if (onboardingBlock) {
    return onboardingBlock;
  }

  const context = resolveWorkflowContext(cwd);
  const worktreeBlock = buildTaskApiActionWorktreeBlock(context, cwd, actionId, parsed);
  if (worktreeBlock) {
    return worktreeBlock;
  }
  assertStableActionManagedState(context.repoRoot, actionId);
  const routePlan = buildRoutePlanForAction(cwd, actionId, parsed);
  const destinationPlan = routePlan.destinationPlan;
  let normalizedInputs: Record<string, unknown>;
  try {
    normalizedInputs = normalizeInputs(actionId, parsed, cwd, destinationPlan, routePlan.error);
  } catch (error) {
    return buildActionResolutionBlock({
      context,
      actionId,
      parsed,
      destinationPlan,
      message: error instanceof Error ? error.message : String(error),
      persist: true,
    });
  }
  const risky = API_RISKY_ACTION_IDS.has(actionId);
  const requiresConfirmation = actionRequiresConfirmation(actionId, normalizedInputs);
  const checkedAt = nowIso();
  const gate = evaluatePreflightGate(context, actionId, normalizedInputs);
  if (gate.allowed === false) {
    persistActionPreflightBlockIfTaskScoped({
      context,
      actionId,
      label: STABLE_ACTION_METADATA[actionId].label,
      normalizedInputs,
      checkedAt,
      reason: gate.reason,
    });
    const preflight: ActionPreflightData = {
      action: { id: actionId, label: STABLE_ACTION_METADATA[actionId].label, risky },
      preflight: {
        allowed: false,
        state: 'blocked',
        reason: gate.reason,
        needsInput: gate.needsInput ?? false,
        missingInputs: gate.missingInputs ?? [],
        inputs: gate.inputs ?? [],
        defaultParams: gate.defaultParams ?? {},
        warnings: [],
        issues: gate.issues ?? [],
        review: gate.review ?? null,
        normalizedInputs,
        requiresConfirmation: false,
        confirmation: null,
        freshness: buildFreshness({ checkedAt, stale: true }),
        ...(destinationPlan ? { destinationPlan } : {}),
      },
    };
    return buildApiEnvelope<ActionPreflightData>({
      command: 'pipelane.api.action',
      ok: false,
      message: gate.reason,
      data: preflight,
    });
  }

  if (requiresConfirmation) {
    const fingerprint = buildActionFingerprint(actionId, normalizedInputs);
    try {
      consumeActionConfirmation(context.commonDir, context.config, confirmToken, fingerprint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const preflight: ActionPreflightData = {
        action: { id: actionId, label: STABLE_ACTION_METADATA[actionId].label, risky },
        preflight: {
          allowed: false,
          state: 'blocked',
          reason: message,
          needsInput: false,
          missingInputs: [],
          inputs: [],
          defaultParams: {},
          warnings: [],
          issues: [],
          normalizedInputs,
          requiresConfirmation,
          confirmation: null,
          freshness: buildFreshness({ checkedAt, stale: true }),
          ...(destinationPlan ? { destinationPlan } : {}),
        },
      };
      return buildApiEnvelope<ActionPreflightData>({
        command: 'pipelane.api.action',
        ok: false,
        message,
        data: preflight,
      });
    }
  }

  const startedAt = nowIso();
  const result = actionId === 'git.catchupBase'
    ? runCatchupBase(cwd)
    : runCliWithJson(
        cwd,
        buildUnderlyingArgs(actionId, parsed),
        buildChildEnv(actionId, destinationPlan, normalizedInputs),
      );
  const finishedAt = nowIso();
  const failureReason = result.ok ? '' : describeExecutionFailure(actionId, result);

  const data: ActionExecutionData = {
    action: { id: actionId, label: STABLE_ACTION_METADATA[actionId].label, risky },
    preflight: {
      allowed: true,
      state: result.ok ? 'healthy' : 'blocked',
      reason: failureReason,
      needsInput: false,
      missingInputs: [],
      inputs: [],
      defaultParams: {},
      warnings: [],
      issues: [],
      normalizedInputs,
      requiresConfirmation,
      confirmation: null,
      freshness: buildFreshness({ checkedAt, stale: !result.ok }),
      ...(destinationPlan ? { destinationPlan } : {}),
    },
    execution: {
      exitCode: result.exitCode,
      result: result.parsed,
      stderr: result.stderr,
    },
  };

  persistActionRunIfTaskScoped({
    context,
    actionId,
    label: STABLE_ACTION_METADATA[actionId].label,
    normalizedInputs,
    startedAt,
    finishedAt,
    result,
    reason: result.ok ? `${actionId} executed` : failureReason,
  });

  return buildApiEnvelope<ActionExecutionData>({
    command: 'pipelane.api.action',
    ok: result.ok,
    message: result.ok ? `${actionId} executed` : `${actionId} failed: ${failureReason}`,
    data,
  });
}

function persistActionPreflightBlockIfTaskScoped(options: {
  context: ReturnType<typeof resolveWorkflowContext>;
  actionId: StableActionId;
  label: string;
  normalizedInputs: Record<string, unknown>;
  checkedAt: string;
  reason: string;
}): void {
  const task = typeof options.normalizedInputs.task === 'string'
    ? options.normalizedInputs.task.trim()
    : '';
  if (!task) return;
  const taskSlug = slugifyTaskName(task);
  const lock = loadTaskLock(options.context.commonDir, options.context.config, taskSlug);
  const branchName = lock?.branchName || runGit(options.context.repoRoot, ['branch', '--show-current'], true)?.trim() || taskSlug;
  appendActionRunRecord(options.context.commonDir, options.context.config, {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    taskSlug,
    branchName,
    actionId: options.actionId,
    label: options.label,
    status: 'failed',
    exitCode: 1,
    startedAt: options.checkedAt,
    finishedAt: nowIso(),
    reason: options.reason,
    stdout: '',
    stderr: '',
  });
}

function persistActionRunIfTaskScoped(options: {
  context: ReturnType<typeof resolveWorkflowContext>;
  actionId: StableActionId;
  label: string;
  normalizedInputs: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  result: ReturnType<typeof runCliWithJson>;
  reason: string;
}): void {
  const task = typeof options.normalizedInputs.task === 'string'
    ? options.normalizedInputs.task.trim()
    : '';
  if (!task) return;
  const taskSlug = slugifyTaskName(task);
  const lock = loadTaskLock(options.context.commonDir, options.context.config, taskSlug);
  const branchName = lock?.branchName || runGit(options.context.repoRoot, ['branch', '--show-current'], true)?.trim() || taskSlug;
  appendActionRunRecord(options.context.commonDir, options.context.config, {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    taskSlug,
    branchName,
    actionId: options.actionId,
    label: options.label,
    status: options.result.ok ? 'succeeded' : 'failed',
    exitCode: options.result.exitCode,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    reason: options.reason,
    stdout: truncateActionOutput(options.result.stdout),
    stderr: truncateActionOutput(options.result.stderr),
  });
}

function truncateActionOutput(value: string): string {
  if (value.length <= ACTION_FEEDBACK_MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, ACTION_FEEDBACK_MAX_OUTPUT_CHARS)}\n[truncated by Pipelane action feedback]`;
}

function describeExecutionFailure(
  actionId: StableActionId,
  result: ReturnType<typeof runCliWithJson>,
): string {
  if (result.stderr) {
    return result.stderr;
  }
  if (result.parsed && typeof result.parsed === 'object') {
    const message = (result.parsed as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }
  if (typeof result.parsed === 'string' && result.parsed.trim()) {
    return result.parsed.trim();
  }
  return `${actionId} exited ${result.exitCode}`;
}

function actionRequiresConfirmation(actionId: StableActionId, normalizedInputs: Record<string, unknown>): boolean {
  if (API_RISKY_ACTION_IDS.has(actionId)) {
    return true;
  }
  return actionId === 'pr'
    && typeof normalizedInputs.recover === 'string'
    && normalizedInputs.recover.trim().length > 0;
}

function assertTaskApiActionWorktree(
  context: WorkflowContext,
  actionId: StableActionId,
  parsed: ParsedOperatorArgs,
): void {
  if (actionId === 'pr') {
    assertTaskCommandWorktree(context, 'pr', parsed.flags.task);
    return;
  }
  if (actionId === 'merge' || actionId === 'route.merge') {
    assertTaskCommandWorktree(context, 'merge', parsed.flags.task, parsed.flags.pr);
    return;
  }
  if (
    actionId === 'deploy.staging'
    || actionId === 'deploy.prod'
    || actionId === 'route.deploy.staging'
    || actionId === 'route.deploy.prod'
  ) {
    assertTaskCommandWorktree(context, 'deploy', parsed.flags.task, parsed.flags.pr);
  }
}

function isRouteActionId(actionId: StableActionId): boolean {
  return actionId === 'route.merge'
    || actionId === 'route.deploy.staging'
    || actionId === 'route.deploy.prod';
}

function buildRoutePlanForAction(
  cwd: string,
  actionId: StableActionId,
  parsed: ParsedOperatorArgs,
): { destinationPlan: DestinationPlan | null; error: string } {
  if (!isRouteActionId(actionId)) return { destinationPlan: null, error: '' };
  try {
    return {
      destinationPlan: buildDestinationPlanForCommand(cwd, parsedForRouteAction(actionId, parsed)),
      error: '',
    };
  } catch (error) {
    return {
      destinationPlan: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parsedForRouteAction(actionId: StableActionId, parsed: ParsedOperatorArgs): ParsedOperatorArgs {
  if (actionId === 'route.merge') {
    return { command: 'merge', positional: [], flags: parsed.flags };
  }
  if (actionId === 'route.deploy.staging') {
    return { command: 'deploy', positional: ['staging'], flags: parsed.flags };
  }
  return { command: 'deploy', positional: ['prod'], flags: parsed.flags };
}

function normalizeInputs(
  actionId: StableActionId,
  parsed: ParsedOperatorArgs,
  cwd?: string,
  destinationPlan?: DestinationPlan | null,
  routePlanError = '',
): Record<string, unknown> {
  const { flags } = parsed;
  switch (actionId) {
    case 'new':
      return { task: flags.task, offline: flags.offline };
    case 'resume':
      return { task: flags.task };
    case 'devmode.build':
      return { task: flags.task };
    case 'devmode.release':
      return { task: flags.task, surfaces: flags.surfaces, override: flags.override, reason: flags.reason };
    case 'taskLock.verify':
      return { task: flags.task, mode: flags.mode };
    case 'pr':
      return {
        task: flags.task,
        title: flags.title,
        message: flags.message,
        recover: flags.recover,
        bindingFingerprint: flags.bindingFingerprint,
        override: flags.override,
        reason: flags.reason,
      };
    case 'merge':
      return { task: flags.task, pr: flags.pr, override: flags.override, reason: flags.reason };
    case 'deploy.staging':
      return { task: flags.task, pr: flags.pr, sha: flags.sha, surfaces: flags.surfaces };
    case 'deploy.prod': {
      const resolved = cwd ? resolveDeployApprovalInputs(cwd, parsed) : undefined;
      return {
        task: flags.task,
        pr: flags.pr,
        sha: flags.sha,
        surfaces: flags.surfaces,
        targetSha: resolved?.targetSha,
        resolvedSurfaces: resolved?.resolvedSurfaces,
        dispatchConfigFingerprint: resolved?.dispatchConfigFingerprint,
      };
    }
    case 'route.merge':
    case 'route.deploy.staging':
    case 'route.deploy.prod':
      return {
        task: flags.task,
        pr: flags.pr,
        sha: flags.sha,
        surfaces: flags.surfaces,
        title: flags.title,
        message: flags.message,
        override: flags.override,
        reason: flags.reason,
        route: destinationPlan?.fingerprintInputs,
        routeBlockers: destinationPlan?.blockers ?? [routePlanError || 'route could not be planned'],
      };
    case 'clean.plan':
      return {};
    case 'clean.apply':
      return {
        task: flags.task,
        allStale: flags.allStale,
        cleanupLocks: cwd ? resolveCleanupApprovalLocks(cwd, flags.task, flags.allStale) : undefined,
      };
    case 'doctor.diagnose':
      return {};
    case 'doctor.probe':
      return {};
    case 'git.catchupBase':
      return {};
    case 'rollback.staging': {
      const resolved = resolveRollbackInputs(cwd, 'staging', flags.surfaces, flags.task);
      return { task: flags.task, surfaces: flags.surfaces, resolvedSurfaces: resolved?.surfaces, targetSha: resolved?.targetSha };
    }
    case 'rollback.prod': {
      const resolved = resolveRollbackInputs(cwd, 'prod', flags.surfaces, flags.task);
      return {
        task: flags.task,
        surfaces: flags.surfaces,
        resolvedSurfaces: resolved?.surfaces,
        targetSha: resolved?.targetSha,
        dispatchConfigFingerprint: resolved?.dispatchConfigFingerprint,
      };
    }
  }
}

function resolveCleanupApprovalLocks(cwd: string, task: string, allStale: boolean): TaskLock[] {
  const context = resolveWorkflowContext(cwd);
  const taskSlug = task.trim() ? slugifyTaskName(task) : '';
  return loadAllTaskLocks(context.commonDir, context.config)
    .filter((lock) => allStale || lock.taskSlug === taskSlug)
    .map((lock) => ({
      taskSlug: lock.taskSlug,
      taskBindingId: lock.taskBindingId,
      branchName: lock.branchName,
      worktreePath: normalizeExistingPath(lock.worktreePath),
      mode: lock.mode,
      surfaces: [...lock.surfaces],
      updatedAt: lock.updatedAt,
    }));
}

// v1.1 R7 fix: bind the rollback target sha to the confirm-token
// fingerprint. Preflight resolves the target against the current deploy
// state; execute re-resolves. If the state shifted (another deploy
// succeeded or failed between preflight and execute), the target sha
// will be different, the fingerprint won't match, and the token
// consume rejects. This closes the TOCTOU window where a human-
// approved "roll back to X" could become "roll back to Y" invisibly.
//
// The surface fallback chain MUST mirror handleRollback's exactly
// (flags → lock.surfaces → config.surfaces) or preflight and execute
// compute different targetSha values on the same repo state. Codex
// caught an earlier version that used config.surfaces directly when
// flags were empty, diverging from execute's lock-first fallback.
//
// Returns undefined (not null) when resolution fails so the resulting
// fingerprint value is stable across failed-resolution calls. Failed
// resolution still lets preflight hand out a token, but the subsequent
// handleRollback invocation will throw a clear error anyway.
function resolveRollbackInputs(
  cwd: string | undefined,
  environment: 'staging' | 'prod',
  surfaceFlags: string[],
  taskFlag: string,
): { surfaces: string[]; targetSha: string; dispatchConfigFingerprint: string } | undefined {
  if (!cwd) return undefined;
  try {
    const context = resolveWorkflowContext(cwd);
    const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
    const deployState = loadDeployState(context.commonDir, context.config);
    const stateKey = resolveDeployStateKey();
    const trustedRecords = stateKey
      ? deployState.records.filter((record) => verifyDeployRecord(record, stateKey))
      : deployState.records;
    // Use the same resolveCommandSurfaces helper handleRollback uses at
    // execute time. Codex caught an earlier manual reconstruction that
    // missed modeState.requestedSurfaces + the parseSurfaceList
    // validation step — those differences could make preflight and
    // execute compute different targetSha values for the same inputs.
    // Task-lock lookup is best-effort (operator may preflight without
    // an active lock, e.g. from a dashboard UI).
    let lockSurfaces: string[] = [];
    try {
      const { lock } = inferActiveTaskLock(context, taskFlag);
      lockSurfaces = lock.surfaces ?? [];
    } catch {
      // No active task lock — resolveCommandSurfaces will fall through
      // to modeState.requestedSurfaces and then config.surfaces.
    }
    const surfaces = [...resolveCommandSurfaces(context, surfaceFlags, lockSurfaces)].sort();
    // Current record = latest record for this (env, surfaces). We need
    // the whole record (not just sha) so we can mirror handleRollback's
    // excludeSha logic: prefer rollbackOfSha (the original broken sha)
    // when the latest record is itself a failed/pending rollback. Codex
    // round 4 P1: preflight used record.sha unconditionally, which
    // drifted from execute on retry scenarios.
    let currentRecord: DeployRecord | null = null;
    const sortedKey = surfaces.join(',');
    for (let i = trustedRecords.length - 1; i >= 0; i -= 1) {
      const record = trustedRecords[i];
      if (record.environment !== environment) continue;
      if (!record.sha) continue;
      const recordKey = [...(record.surfaces ?? [])].sort().join(',');
      if (recordKey !== sortedKey) continue;
      currentRecord = record;
      break;
    }
    if (!currentRecord) return undefined;
    // Mirror handleRollback's cascade guard + in-flight guard +
    // excludeSha selection. Both guards return undefined so the
    // preflight token is still issued (handleRollback will throw the
    // clear error at execute time), but the fingerprint targetSha is
    // blank so the token doesn't lock in a stale/duplicate target.
    if (currentRecord.status === 'succeeded' && currentRecord.rollbackOfSha) {
      return undefined;
    }
    if (currentRecord.status === 'requested') {
      // Mirror handleRollback's widened in-flight guard (Codex r8 P1):
      // block on any 'requested' record, not just rollback ones. An
      // async deploy in flight also disqualifies preflight from
      // minting a valid target. Staleness threshold matches execute
      // so preflight and execute agree on when a stale record
      // bypasses the guard.
      const requestedMs = Date.parse(currentRecord.requestedAt);
      const timeoutMs = Number.parseInt(process.env.PIPELANE_ROLLBACK_INFLIGHT_TIMEOUT_MS ?? '', 10);
      const threshold = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30 * 60 * 1000;
      const age = Number.isFinite(requestedMs) ? Date.now() - requestedMs : 0;
      if (age < threshold) {
        return undefined;
      }
      // Stale → fall through.
    }
    const excludeSha = currentRecord.rollbackOfSha ?? currentRecord.sha;
    const target = findLastGoodDeploy({
      records: trustedRecords,
      environment,
      surfaces,
      excludeSha,
      configFingerprint: computeDeployConfigFingerprint(deployConfig, environment),
    });
    if (!target?.sha) return undefined;
    return {
      surfaces,
      targetSha: target.sha,
      dispatchConfigFingerprint: computeDeployApprovalDispatchFingerprint(context, deployConfig),
    };
  } catch {
    return undefined;
  }
}

function buildUnderlyingArgs(actionId: StableActionId, parsed: ParsedOperatorArgs): string[] {
  const { flags } = parsed;
  const args: string[] = ['run'];
  const pushOpt = (flag: string, value: string) => {
    if (value && value.trim()) args.push(flag, value);
  };
  const pushSurfaces = () => {
    if (flags.surfaces.length > 0) args.push('--surfaces', flags.surfaces.join(','));
  };
  const pushRouteTaskOrPr = () => {
    if (flags.pr.trim()) {
      pushOpt('--pr', flags.pr);
      return;
    }
    pushOpt('--task', flags.task);
  };
  const pushRoutePrMetadata = () => {
    pushOpt('--title', flags.title);
    pushOpt('--message', flags.message);
  };

  switch (actionId) {
    case 'new':
      args.push('new');
      pushOpt('--task', flags.task);
      if (flags.offline) args.push('--offline');
      break;
    case 'resume':
      args.push('resume');
      pushOpt('--task', flags.task);
      break;
    case 'devmode.build':
      args.push('devmode', 'build');
      pushOpt('--task', flags.task);
      break;
    case 'devmode.release':
      args.push('devmode', 'release');
      pushOpt('--task', flags.task);
      pushSurfaces();
      if (flags.override) args.push('--override');
      pushOpt('--reason', flags.reason);
      break;
    case 'taskLock.verify':
      args.push('task-lock', 'verify');
      pushOpt('--task', flags.task);
      pushOpt('--mode', flags.mode);
      break;
    case 'pr':
      args.push('pr');
      pushOpt('--task', flags.task);
      pushOpt('--title', flags.title);
      pushOpt('--message', flags.message);
      pushOpt('--recover', flags.recover);
      pushOpt('--binding-fingerprint', flags.bindingFingerprint);
      if (flags.override) args.push('--override');
      pushOpt('--reason', flags.reason);
      break;
    case 'merge':
      args.push('merge');
      pushOpt('--task', flags.task);
      pushOpt('--pr', flags.pr);
      if (flags.override) args.push('--override');
      pushOpt('--reason', flags.reason);
      break;
    case 'deploy.staging':
      args.push('deploy', 'staging');
      pushOpt('--task', flags.task);
      pushOpt('--pr', flags.pr);
      pushOpt('--sha', flags.sha);
      pushSurfaces();
      break;
    case 'deploy.prod':
      args.push('deploy', 'prod');
      pushOpt('--task', flags.task);
      pushOpt('--pr', flags.pr);
      pushOpt('--sha', flags.sha);
      pushSurfaces();
      break;
    case 'route.merge':
      args.push('merge', '--yes');
      pushRouteTaskOrPr();
      pushRoutePrMetadata();
      if (flags.override) args.push('--override');
      pushOpt('--reason', flags.reason);
      break;
    case 'route.deploy.staging':
      args.push('deploy', 'staging', '--yes');
      pushRouteTaskOrPr();
      pushRoutePrMetadata();
      pushOpt('--sha', flags.sha);
      pushSurfaces();
      break;
    case 'route.deploy.prod':
      args.push('deploy', 'prod', '--yes');
      pushRouteTaskOrPr();
      pushRoutePrMetadata();
      pushOpt('--sha', flags.sha);
      pushSurfaces();
      break;
    case 'clean.plan':
      args.push('clean', '--status-only');
      break;
    case 'clean.apply':
      args.push('clean', '--apply');
      pushOpt('--task', flags.task);
      if (flags.allStale) args.push('--all-stale');
      break;
    case 'doctor.diagnose':
      args.push('doctor');
      break;
    case 'doctor.probe':
      args.push('doctor', 'probe');
      break;
    case 'git.catchupBase':
      throw new Error('git.catchupBase is handled directly by the API action executor.');
    case 'rollback.staging':
      args.push('rollback', 'staging');
      pushOpt('--task', flags.task);
      pushSurfaces();
      break;
    case 'rollback.prod':
      args.push('rollback', 'prod');
      pushOpt('--task', flags.task);
      pushSurfaces();
      break;
  }

  args.push('--json');
  return args;
}

// Env vars that exist only as test hooks for the CLI. The API action executor
// is a long-lived parent (board, dashboard, CI dispatcher) — if any of these
// happen to be exported in its shell, we don't want them leaking into every
// CLI child and silently bypassing a gate.
const TEST_HOOK_ENV_KEYS = [
  'PIPELANE_DEPLOY_PROD_CONFIRM_STUB',
  'PIPELANE_CLEAN_MIN_AGE_MS',
  'PIPELANE_CHECKS_SUPABASE_SECRETS_STUB',
  'PIPELANE_CHECKS_GH_SECRETS_STUB',
  // v1.2: doctor.probe/fix stubs are unit-test hooks for API-only lanes.
  // Deploy verification stubs remain NODE_ENV=test-gated in deploy.ts and
  // must flow through API action tests so those children exercise the same
  // deploy path without a real GitHub Actions run.
  'PIPELANE_DOCTOR_PROBE_STUB_STATUS',
  'PIPELANE_DOCTOR_FIX_STUB',
];

function buildChildEnv(
  actionId: StableActionId,
  destinationPlan?: DestinationPlan | null,
  normalizedInputs: Record<string, unknown> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of TEST_HOOK_ENV_KEYS) {
    delete env[key];
  }
  delete env[DESTINATION_APPROVED_ROUTE_FINGERPRINT_ENV];
  delete env[DESTINATION_ROUTE_PROD_CONFIRMED_ENV];
  delete env[DEPLOY_PROD_APPROVED_SHA_ENV];
  delete env[DEPLOY_PROD_APPROVED_SURFACES_ENV];
  delete env[DEPLOY_PROD_APPROVED_DISPATCH_CONFIG_ENV];
  delete env[CLEAN_APPROVED_LOCKS_ENV];
  if (isRouteActionId(actionId) && destinationPlan) {
    env[DESTINATION_APPROVED_ROUTE_FINGERPRINT_ENV] = destinationPlanFingerprintDigest(destinationPlan);
  }
  if (actionId === 'clean.apply') {
    env[CLEAN_APPROVED_LOCKS_ENV] = JSON.stringify(normalizedInputs.cleanupLocks ?? []);
  }
  if (actionId === 'route.deploy.prod') {
    env[DESTINATION_ROUTE_PROD_CONFIRMED_ENV] = '1';
    delete env.PIPELANE_DEPLOY_PROD_API_CONFIRMED;
    delete env[DEPLOY_PROD_DIRECT_API_CONFIRMED_ENV];
  } else if (actionId === 'deploy.prod' || actionId === 'rollback.prod') {
    // Both deploy.prod and rollback.prod's CLI shims require human
    // confirmation via requireProdConfirmation. The API path has already
    // proved humanness via the HMAC confirm-token consume above, so tell
    // the child CLI it can skip the typed-SHA TTY prompt. The child
    // scrubs this flag the moment it reads it so grandchild subprocesses
    // don't inherit an open prod-confirm bit.
    env.PIPELANE_DEPLOY_PROD_API_CONFIRMED = '1';
    if (actionId === 'deploy.prod' || actionId === 'rollback.prod') {
      env[DEPLOY_PROD_DIRECT_API_CONFIRMED_ENV] = '1';
      env[DEPLOY_PROD_APPROVED_SHA_ENV] = typeof normalizedInputs.targetSha === 'string'
        ? normalizedInputs.targetSha
        : '';
      env[DEPLOY_PROD_APPROVED_SURFACES_ENV] = Array.isArray(normalizedInputs.resolvedSurfaces)
        ? normalizedInputs.resolvedSurfaces.join(',')
        : '';
      env[DEPLOY_PROD_APPROVED_DISPATCH_CONFIG_ENV] = typeof normalizedInputs.dispatchConfigFingerprint === 'string'
        ? normalizedInputs.dispatchConfigFingerprint
        : '';
    }
  } else {
    // Never let a stray bypass leak into other actions' execution.
    delete env.PIPELANE_DEPLOY_PROD_API_CONFIRMED;
    delete env[DEPLOY_PROD_DIRECT_API_CONFIRMED_ENV];
  }
  return env;
}

function runCliWithJson(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; exitCode: number; stdout: string; stderr: string; parsed: unknown } {
  const cliPath = resolveCliEntry();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  let parsed: unknown = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = stdout;
    }
  }
  return {
    ok: result.status === 0,
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    parsed,
  };
}

function runCatchupBase(cwd: string): { ok: boolean; exitCode: number; stdout: string; stderr: string; parsed: unknown } {
  const context = resolveWorkflowContext(cwd);
  const baseBranch = context.config.baseBranch;
  const currentBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const current = currentBranch.stdout?.trim() ?? '';
  if (currentBranch.status !== 0) {
    return gitActionResult(false, currentBranch.status ?? 1, '', currentBranch.stderr?.trim() || 'Could not read the current branch.', null);
  }
  if (current !== baseBranch) {
    return gitActionResult(
      false,
      1,
      '',
      `Refusing to catch up ${baseBranch} while this checkout is on ${current || 'an unknown branch'}.`,
      { baseBranch, currentBranch: current },
    );
  }

  const fetch = spawnSync('git', ['fetch', 'origin', baseBranch], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (fetch.status !== 0) {
    return gitActionResult(false, fetch.status ?? 1, fetch.stdout?.trim() ?? '', fetch.stderr?.trim() || `git fetch origin ${baseBranch} failed.`, null);
  }

  try {
    assertManagedLocalStateValid(context.repoRoot);
    assertManagedLocalStateValidForTree(context.repoRoot, `origin/${baseBranch}`);
  } catch (error) {
    return gitActionResult(
      false,
      1,
      fetch.stdout?.trim() ?? '',
      error instanceof Error ? error.message : String(error),
      { baseBranch, currentBranch: current },
    );
  }

  const merge = spawnSync('git', ['merge', '--ff-only', `origin/${baseBranch}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = {
    baseBranch,
    currentBranch: current,
    head: head.status === 0 ? head.stdout.trim() : '',
    fetch: fetch.stdout.trim(),
    merge: merge.stdout.trim(),
  };
  return gitActionResult(
    merge.status === 0,
    merge.status ?? 1,
    JSON.stringify(parsed),
    merge.stderr?.trim() ?? '',
    parsed,
  );
}

function assertStableActionManagedState(repoRoot: string, actionId: StableActionId): void {
  const sensitivity = classifyStableActionManagedStateSensitivity(actionId);
  if (sensitivity === 'current-state' || sensitivity === 'target-tree') {
    assertManagedLocalStateValid(repoRoot);
  }
}

function gitActionResult(ok: boolean, exitCode: number, stdout: string, stderr: string, parsed: unknown): { ok: boolean; exitCode: number; stdout: string; stderr: string; parsed: unknown } {
  return { ok, exitCode, stdout, stderr, parsed };
}

function resolveCliEntry(): string {
  // In dev the module loads as src/operator/api/actions.ts; in a packed
  // build it's dist/operator/api/actions.js. Either way, cli.(ts|js)
  // lives at the kit root. Source-mode parents must spawn source-mode
  // children, otherwise stale dist output can execute different route logic.
  const here = fileURLToPath(import.meta.url);
  const kitRoot = path.resolve(path.dirname(here), '..', '..', '..');
  const srcCli = path.join(kitRoot, 'src', 'cli.ts');
  if (here.includes(`${path.sep}src${path.sep}`)) return srcCli;
  const distCli = path.join(kitRoot, 'dist', 'cli.js');
  if (existsSync(distCli)) return distCli;
  return srcCli;
}

export function parseApiActionFlags(argv: string[]): { execute: boolean; confirmToken: string; autoConfirm: boolean; rest: string[] } {
  const rest: string[] = [];
  let execute = false;
  let confirmToken = '';
  let autoConfirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--execute') {
      execute = true;
      continue;
    }
    if (token === '--confirm-token') {
      confirmToken = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (token === '--auto-confirm') {
      autoConfirm = true;
      continue;
    }
    rest.push(token);
  }
  if (confirmToken && !execute) {
    throw new Error('api action --confirm-token requires --execute; tokens are never ignored.');
  }
  if (autoConfirm && !execute) {
    throw new Error('api action --auto-confirm requires --execute.');
  }
  if (autoConfirm && confirmToken) {
    throw new Error('api action cannot combine --auto-confirm and --confirm-token.');
  }
  return { execute, confirmToken, autoConfirm, rest };
}
