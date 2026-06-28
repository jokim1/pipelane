import { createHash } from 'node:crypto';

import { listMissingDeployConfiguration } from './deploy-config-validation.ts';
import {
  computeDeployConfigFingerprint,
  describeRequestedDeployRecord,
  disqualifyDeployRecord,
  emptyDeployConfig,
  loadDeployConfig,
  resolveDeployStateKey,
  type DeployConfig,
  verifyDeployRecord,
} from './release-gate.ts';
import { bucketPathsBySurface } from './surface-map.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';
import { inferTargetSurfacesFromSurfacePathMap, targetSurfaceInferenceBlockers } from './target-surface-map.ts';
import {
  loadDeployState,
  loadTaskLock,
  loadPrRecord,
  formatWorkflowCommand,
  printResult,
  resolveWorkflowContext,
  runGit,
  slugifyTaskName,
  type DeployRecord,
  type ParsedOperatorArgs,
  type PrRecord,
  type TaskLock,
  type WorkflowConfig,
  type WorkflowContext,
} from './state.ts';
import { observeCompletedDeployWorkflowRun } from './deploy-workflow-runs.ts';
import {
  buildStaleBaseBlockerForRepo,
  deriveTaskSlugFromPr,
  inferActiveTaskLock,
  inferTaskSlugFromBranchName,
  loadOpenPrForBranch,
  loadPrByNumber,
  resolveCommandSurfaces,
  sanitizeForTerminal,
  type LivePr,
} from './commands/helpers.ts';

export type DestinationMilestone =
  | 'local_dirty'
  | 'pr_open'
  | 'merged'
  | 'staging_deployed'
  | 'prod_deployed';

export type DestinationStepId =
  | 'pr'
  | 'review_gate'
  | 'merge'
  | 'deploy_staging'
  | 'deploy_prod';

export interface DestinationStep {
  id: DestinationStepId;
  command: string;
  label: string;
  milestone: DestinationMilestone;
}

export interface SurfaceSummary {
  surface: string;
  requested: boolean;
  state: 'included' | 'skipped';
  reason: string;
  changedPaths: string[];
  stagingDeploy: 'satisfied' | 'missing';
  prodDeploy: 'satisfied' | 'missing';
}

export interface DestinationSnapshot {
  target: DestinationMilestone;
  targetCommand: string;
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  mode: 'build' | 'release';
  branchName: string;
  headSha: string;
  targetSha: string;
  explicitPr: string;
  explicitDeploySha: string;
  explicitDeployShaError: string;
  asyncRequested: boolean;
  dirty: boolean;
  worktreeStatusDigest: string;
  worktreeStatusEntryCount: number;
  worktreeStatusReliable: boolean;
  worktreeStatusWarnings: string[];
  changedPaths: string[];
  changedBySurface: Record<string, string[]>;
  changedOther: string[];
  taskSlug: string;
  taskName: string;
  lock: TaskLock | null;
  livePr: LivePr | null;
  livePrError: string;
  prRecord: PrRecord | null;
  deployRecords: DeployRecord[];
  deployConfig: DeployConfig;
  deployConfigFingerprints: { staging: string; prod: string };
  defaultDeployWorkflowName: string;
  requestedSurfaces: string[];
  configuredSurfaces: string[];
  explicitSurfaces: boolean;
  surfacePathMapBlockers: string[];
  titleProvided: boolean;
}

export interface DestinationPlan {
  taskSlug: string;
  mode: 'build' | 'release';
  target: DestinationMilestone;
  targetCommand: string;
  currentMilestone: DestinationMilestone;
  currentStatus: string;
  taskName: string;
  requestedSurfaces: string[];
  surfaces: SurfaceSummary[];
  remainingSteps: DestinationStep[];
  satisfiedSteps: DestinationStep[];
  blockers: string[];
  warnings: string[];
  confirmationRequired: boolean;
  fingerprintInputs: Record<string, unknown>;
  message: string;
}

export function destinationTargetForParsed(parsed: ParsedOperatorArgs): DestinationMilestone | null {
  if (parsed.command === 'pr') return 'pr_open';
  if (parsed.command === 'merge') return 'merged';
  if (parsed.command === 'deploy') {
    const env = parsed.positional[0] === 'production' ? 'prod' : parsed.positional[0];
    if (env === 'staging') return 'staging_deployed';
    if (env === 'prod') return 'prod_deployed';
  }
  return null;
}

export function buildDestinationPlanForCommand(cwd: string, parsed: ParsedOperatorArgs): DestinationPlan | null {
  const target = destinationTargetForParsed(parsed);
  if (!target) return null;
  const context = resolveWorkflowContext(cwd);
  const snapshot = resolveDestinationSnapshot(context, parsed, target);
  return planDestination(snapshot, target);
}

export function resolveDestinationSnapshot(
  context: WorkflowContext,
  parsed: ParsedOperatorArgs,
  target: DestinationMilestone,
): DestinationSnapshot {
  const targetCommand = formatDestinationCommand(context, parsed, target);
  const worktree = readWorktreeStatusSnapshot(context.repoRoot, { includeStatusDigest: true });
  const branchName = worktree.branchName || runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() || '';
  const headSha = worktree.head || runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() || '';
  const rawChangedPaths = worktree.dirty ? worktree.changedPaths : [];
  const changedPaths = rawChangedPaths.filter(isDestinationRelevantChangedPath);
  const dirty = worktree.dirty && (changedPaths.length > 0 || !worktree.statusDigestReliable);
  const { surfaces: changedBySurface, other: changedOther } = bucketPathsBySurface(changedPaths, context.config.surfacePathMap ?? {});

  let livePr: LivePr | null = null;
  let livePrError = '';
  let taskSlug = '';
  let taskName = '';
  let lock: TaskLock | null = null;

  const explicitPr = parsed.flags.pr.trim();
  if (explicitPr) {
    try {
      livePr = loadPrByNumber(context.repoRoot, Number.parseInt(explicitPr, 10));
      taskSlug = parsed.flags.task.trim()
        ? slugifyTaskName(parsed.flags.task)
        : deriveTaskSlugFromPr(context.config, livePr, livePr.headRefName ?? branchName);
      lock = taskSlug ? loadTaskLock(context.commonDir, context.config, taskSlug) : null;
      taskName = lock?.taskName ?? taskSlug;
    } catch (error) {
      livePrError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!taskSlug) {
    try {
      const inferred = inferActiveTaskLock(context, parsed.flags.task);
      taskSlug = inferred.taskSlug;
      lock = inferred.lock;
      taskName = inferred.lock.taskName ?? inferred.taskSlug;
    } catch (error) {
      taskSlug = parsed.flags.task.trim() ? slugifyTaskName(parsed.flags.task) : '';
      if (!livePrError) livePrError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!livePr && branchName) {
    try {
      livePr = loadOpenPrForBranch(context.repoRoot, branchName);
    } catch (error) {
      if (!livePrError) livePrError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!taskSlug && livePr) {
    taskSlug = deriveTaskSlugFromPr(context.config, livePr, livePr.headRefName ?? branchName);
  }

  const explicitTaskSlug = parsed.flags.task.trim() ? slugifyTaskName(parsed.flags.task) : '';
  const locklessBranchSlug = branchName && !isBaseBranchName(context.config, branchName)
    ? inferTaskSlugFromBranchName(context.config, branchName) || slugifyTaskName(branchName)
    : '';
  let taskSlugInferredFromLocklessBranch = false;
  if (
    locklessBranchSlug
    && (!explicitTaskSlug || explicitTaskSlug === locklessBranchSlug)
    && (!lock || !taskSlug)
  ) {
    taskSlug = explicitTaskSlug || taskSlug || locklessBranchSlug;
    taskSlugInferredFromLocklessBranch = true;
    if (/^No task lock (matches|found)/.test(livePrError)) {
      livePrError = '';
    }
  }
  if (!taskName && !taskSlugInferredFromLocklessBranch) taskName = taskSlug;

  const prRecord = taskSlug ? loadPrRecord(context.commonDir, context.config, taskSlug) : null;
  const deployState = loadDeployState(context.commonDir, context.config);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const explicitDeploySha = parsed.command === 'deploy'
    ? parsed.flags.sha.trim()
    : '';
  const resolvedExplicitDeploySha = explicitDeploySha
    ? runGit(context.repoRoot, ['rev-parse', '--verify', explicitDeploySha], true)?.trim() ?? ''
    : '';
  const explicitDeployShaError = explicitDeploySha && !resolvedExplicitDeploySha
    ? `Could not resolve ${explicitDeploySha}.`
    : '';
  const targetSha = resolvedExplicitDeploySha || (explicitDeploySha ? explicitDeploySha : resolveReleaseSha(livePr, prRecord, headSha));
  const explicitSurfaces = [...parsed.flags.surfaces, ...deploySurfacePositionals(parsed)];
  const baseRequestedSurfaces = resolveCommandSurfaces(context, explicitSurfaces, lock?.surfaces ?? []);
  const surfaceInference = explicitSurfaces.length === 0
    ? inferTargetSurfacesFromSurfacePathMap({
      repoRoot: context.repoRoot,
      config: context.config,
      targetSha,
    })
    : null;
  const surfacePathMapBlockers = targetSurfaceInferenceBlockers(surfaceInference);
  const requestedSurfaces = surfaceInference
    && surfacePathMapBlockers.length === 0
    && surfaceInference.surfaces.length > 0
    ? surfaceInference.surfaces
    : baseRequestedSurfaces;

  return {
    target,
    targetCommand,
    repoRoot: context.repoRoot,
    commonDir: context.commonDir,
    config: context.config,
    mode: context.modeState.mode,
    branchName,
    headSha,
    targetSha,
    explicitPr,
    explicitDeploySha,
    explicitDeployShaError,
    asyncRequested: parsed.command === 'deploy' && parsed.flags.async,
    dirty,
    worktreeStatusDigest: worktree.statusDigest,
    worktreeStatusEntryCount: worktree.statusEntryCount,
    worktreeStatusReliable: worktree.statusDigestReliable,
    worktreeStatusWarnings: worktree.statusDigestWarnings,
    changedPaths,
    changedBySurface,
    changedOther,
    taskSlug,
    taskName,
    lock,
    livePr,
    livePrError,
    prRecord,
    deployRecords: deployState.records,
    deployConfig,
    deployConfigFingerprints: {
      staging: computeDeployConfigFingerprint(deployConfig, 'staging'),
      prod: computeDeployConfigFingerprint(deployConfig, 'prod'),
    },
    defaultDeployWorkflowName: context.config.deployWorkflowName,
    requestedSurfaces,
    configuredSurfaces: [...context.config.surfaces],
    explicitSurfaces: explicitSurfaces.length > 0,
    surfacePathMapBlockers,
    titleProvided: parsed.flags.title.trim().length > 0,
  };
}

export function planDestination(snapshot: DestinationSnapshot, target: DestinationMilestone): DestinationPlan {
  const releaseSha = snapshot.targetSha;
  const stagingDeploy = findQualifiedDeploy(snapshot, 'staging', snapshot.requestedSurfaces);
  const prodDeploy = findQualifiedDeploy(snapshot, 'prod', snapshot.requestedSurfaces);
  const route = buildRouteForSnapshot(snapshot, target);
  const currentMilestone = resolveCurrentMilestone(snapshot, target, stagingDeploy, prodDeploy);
  const currentIndex = resolveRouteCurrentIndex(route, currentMilestone, target);
  const targetIndex = route.findIndex((step) => step.milestone === target);
  const remainingSteps = route.filter((_, index) => index > currentIndex && (targetIndex === -1 || index <= targetIndex));
  const satisfiedSteps = route.filter((_, index) => index <= currentIndex);
  const blockers = buildDestinationBlockers(snapshot, target, remainingSteps);
  const warnings = buildDestinationWarnings(snapshot, remainingSteps);
  const surfaces = snapshot.configuredSurfaces.map<SurfaceSummary>((surface) => {
    const requested = snapshot.requestedSurfaces.includes(surface);
    return {
      surface,
      requested,
      state: requested ? 'included' : 'skipped',
      reason: surfaceReason(snapshot, surface, requested),
      changedPaths: snapshot.changedBySurface[surface] ?? [],
      stagingDeploy: findQualifiedDeploy(snapshot, 'staging', [surface]) ? 'satisfied' : 'missing',
      prodDeploy: findQualifiedDeploy(snapshot, 'prod', [surface]) ? 'satisfied' : 'missing',
    };
  });
  const fingerprintInputs = {
    taskSlug: snapshot.taskSlug,
    mode: snapshot.mode,
    target,
    prNumber: snapshot.livePr?.number ?? snapshot.prRecord?.number ?? null,
    headSha: snapshot.headSha,
    targetSha: snapshot.targetSha,
    explicitDeploySha: snapshot.explicitDeploySha || null,
    worktree: {
      dirty: snapshot.dirty,
      statusDigest: snapshot.worktreeStatusDigest,
      statusEntryCount: snapshot.worktreeStatusEntryCount,
      reliable: snapshot.worktreeStatusReliable,
      warnings: snapshot.worktreeStatusWarnings,
    },
    mergedSha: snapshot.prRecord?.mergedSha ?? snapshot.livePr?.mergeCommit?.oid ?? null,
    routeSteps: remainingSteps.map((step) => step.id),
    surfaces: [...snapshot.requestedSurfaces].sort(),
    deployConfigFingerprints: snapshot.deployConfigFingerprints,
  };
  const plan: DestinationPlan = {
    taskSlug: snapshot.taskSlug || 'unknown',
    mode: snapshot.mode,
    target,
    targetCommand: snapshot.targetCommand,
    currentMilestone,
    currentStatus: currentStatusLine(snapshot, currentMilestone, releaseSha),
    taskName: snapshot.taskName,
    requestedSurfaces: snapshot.requestedSurfaces,
    surfaces,
    remainingSteps,
    satisfiedSteps,
    blockers,
    warnings,
    confirmationRequired: remainingSteps.length > 0,
    fingerprintInputs,
    message: '',
  };
  plan.message = renderDestinationPlan(plan);
  return plan;
}

export function renderDestinationPlan(plan: DestinationPlan): string {
  const lines: string[] = [
    `Task: ${sanitizeForTerminal(plan.taskSlug)}`,
    `Mode: ${plan.mode}`,
    `Target: ${plan.targetCommand}`,
    `Status: ${sanitizeForTerminal(plan.currentStatus)}`,
    '',
    'Surfaces:',
  ];
  for (const surface of plan.surfaces) {
    const changed = surface.changedPaths.length > 0
      ? `changed: ${surface.changedPaths.slice(0, 2).map(sanitizeForTerminal).join(', ')}${surface.changedPaths.length > 2 ? `, +${surface.changedPaths.length - 2} more` : ''}`
      : surface.reason;
    lines.push(`  ${surface.surface.padEnd(8)}  ${surface.state.padEnd(8)}  ${changed}`);
  }
  lines.push('');
  if (plan.remainingSteps.length === 0) {
    lines.push(`No remaining steps to ${plan.targetCommand}.`);
  } else {
    lines.push(`Remaining steps to ${plan.targetCommand}:`);
    lines.push(`  ${plan.remainingSteps.map((step) => step.command).join(' -> ')}`);
  }
  lines.push('');
  lines.push('Surface gates:');
  for (const surface of plan.surfaces.filter((entry) => entry.requested)) {
    const gates: string[] = [];
    if (plan.remainingSteps.some((step) => step.id === 'deploy_staging')) gates.push('staging deploy workflow');
    if (plan.remainingSteps.some((step) => step.id === 'deploy_prod')) gates.push('prod deploy workflow');
    lines.push(`  ${surface.surface.padEnd(8)}  ${gates.length > 0 ? `needs ${gates.join(' + ')}` : 'no pending gate'}`);
  }
  if (plan.blockers.length > 0) {
    lines.push('');
    lines.push('Blockers:');
    for (const blocker of plan.blockers) lines.push(`  - ${sanitizeForTerminal(blocker)}`);
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of plan.warnings) lines.push(`  - ${sanitizeForTerminal(warning)}`);
  }
  if (plan.remainingSteps.length > 0 && plan.blockers.length === 0) {
    lines.push('');
    lines.push(`Ready to run ${plan.remainingSteps.length} step${plan.remainingSteps.length === 1 ? '' : 's'} through ${plan.targetCommand} for ${plan.requestedSurfaces.join(', ')}.`);
  }
  return lines.join('\n');
}

export function printDestinationPlan(flags: ParsedOperatorArgs['flags'], plan: DestinationPlan): void {
  printResult(flags, plan);
}

export function destinationPlanFingerprintDigest(plan: DestinationPlan): string {
  return createHash('sha256')
    .update(canonicalizeDestinationFingerprint(plan.fingerprintInputs))
    .digest('hex');
}

export function canonicalizeDestinationFingerprint(value: unknown): string {
  return JSON.stringify(sortDestinationFingerprintValue(value));
}

function sortDestinationFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDestinationFingerprintValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortDestinationFingerprintValue(entryValue)]),
    );
  }
  return value;
}

export function shouldInterceptDestinationPlan(plan: DestinationPlan, parsed: ParsedOperatorArgs): boolean {
  if (parsed.flags.plan || parsed.flags.yes) return true;
  const executableSteps = plan.remainingSteps.filter((step) => step.id !== 'review_gate');
  if (hasAutomaticDestinationJump(parsed, executableSteps)) return true;
  if (parsed.flags.json) return false;
  return false;
}

function hasAutomaticDestinationJump(parsed: ParsedOperatorArgs, executableSteps: DestinationStep[]): boolean {
  if (executableSteps.length <= 1) return false;

  if (parsed.command === 'deploy') {
    const env = parsed.positional[0] === 'production' ? 'prod' : parsed.positional[0];
    if (env === 'prod') {
      const prereqs = executableSteps.slice(0, -1).map((step) => step.id);
      return prereqs.some((stepId) => stepId === 'pr' || stepId === 'merge' || stepId === 'deploy_staging');
    }
  }

  return true;
}

function deploySurfacePositionals(parsed: ParsedOperatorArgs): string[] {
  if (parsed.command !== 'deploy') return [];
  return parsed.positional.slice(1);
}

function isBaseBranchName(config: WorkflowConfig, branchName: string): boolean {
  return branchName === config.baseBranch || branchName === 'main' || branchName === 'master';
}

function isDestinationRelevantChangedPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\/+/u, '');
  return !normalized.startsWith('.pipelane/state/');
}

function formatDestinationCommand(context: WorkflowContext, parsed: ParsedOperatorArgs, target: DestinationMilestone): string {
  const alias = context.config.aliases[parsed.command as keyof typeof context.config.aliases] ?? `/${parsed.command}`;
  if (target === 'staging_deployed') return `${alias} staging`;
  if (target === 'prod_deployed') return `${alias} prod`;
  return alias;
}

function buildRoute(
  mode: 'build' | 'release',
  target: DestinationMilestone,
  config: WorkflowConfig,
): DestinationStep[] {
  const route: DestinationStep[] = [
    { id: 'pr', command: formatWorkflowCommand(config, 'pr'), label: 'PR opened', milestone: 'pr_open' },
    { id: 'review_gate', command: 'review gate', label: 'Review gate', milestone: 'pr_open' },
    { id: 'merge', command: formatWorkflowCommand(config, 'merge'), label: 'Merged', milestone: 'merged' },
  ];
  const hasDeploySurfaces = config.surfaces.length > 0;
  const needsStagingStep = hasDeploySurfaces
    && (target === 'staging_deployed' || (mode === 'release' && target === 'prod_deployed'));
  if (needsStagingStep) {
    route.push({ id: 'deploy_staging', command: formatWorkflowCommand(config, 'deploy', 'staging'), label: 'Staging deployed', milestone: 'staging_deployed' });
  }
  if (hasDeploySurfaces && target === 'prod_deployed') {
    route.push({ id: 'deploy_prod', command: formatWorkflowCommand(config, 'deploy', 'prod'), label: 'Production deployed', milestone: 'prod_deployed' });
  }
  return route;
}

function buildRouteForSnapshot(snapshot: DestinationSnapshot, target: DestinationMilestone): DestinationStep[] {
  const route = buildRoute(snapshot.mode, target, snapshot.config);
  if (snapshot.explicitDeploySha) {
    return route.filter((step) => step.id !== 'pr' && step.id !== 'review_gate' && step.id !== 'merge');
  }
  if (snapshot.explicitPr) {
    return route.filter((step) => step.id !== 'pr' && step.id !== 'review_gate');
  }
  return route;
}

function resolveRouteCurrentIndex(
  route: DestinationStep[],
  currentMilestone: DestinationMilestone,
  target: DestinationMilestone,
): number {
  const exact = route.findIndex((step) => step.milestone === currentMilestone);
  if (exact !== -1) return exact;
  const targetIndex = route.findIndex((step) => step.milestone === target);
  const currentRank = milestoneRank(currentMilestone);
  if (targetIndex !== -1 && currentRank >= milestoneRank(target)) return targetIndex;
  let index = -1;
  for (let i = 0; i < route.length; i += 1) {
    if (milestoneRank(route[i].milestone) <= currentRank) index = i;
  }
  return index;
}

function milestoneRank(milestone: DestinationMilestone): number {
  switch (milestone) {
    case 'local_dirty': return 0;
    case 'pr_open': return 1;
    case 'merged': return 2;
    case 'staging_deployed': return 3;
    case 'prod_deployed': return 4;
  }
}

function resolveCurrentMilestone(
  snapshot: DestinationSnapshot,
  target: DestinationMilestone,
  stagingDeploy: DeployRecord | null,
  prodDeploy: DeployRecord | null,
): DestinationMilestone {
  const merged = Boolean(snapshot.prRecord?.mergedSha || snapshot.livePr?.state === 'MERGED');
  if (snapshot.dirty && !merged) return 'local_dirty';
  const targetRank = milestoneRank(target);
  if (target === 'prod_deployed' && prodDeploy) return 'prod_deployed';
  if (targetRank >= milestoneRank('staging_deployed') && stagingDeploy) return 'staging_deployed';
  if (merged) return 'merged';
  if (snapshot.livePr || snapshot.prRecord?.number) return 'pr_open';
  return 'local_dirty';
}

function buildDestinationBlockers(snapshot: DestinationSnapshot, target: DestinationMilestone, steps: DestinationStep[]): string[] {
  const blockers: string[] = [];
  const needsStagingDeploy = steps.some((step) => step.id === 'deploy_staging');
  const needsProdDeploy = steps.some((step) => step.id === 'deploy_prod');
  const needsDeploySideEffect = needsStagingDeploy || needsProdDeploy;

  if (!snapshot.taskSlug) blockers.push('no active task could be inferred');
  if (snapshot.livePrError && !snapshot.livePr && !snapshot.prRecord?.number) blockers.push(snapshot.livePrError);
  if (snapshot.explicitDeployShaError) blockers.push(snapshot.explicitDeployShaError);
  const staleBaseBlocker = destinationStaleBaseBlocker(snapshot, steps);
  if (staleBaseBlocker) blockers.push(staleBaseBlocker);
  if (snapshot.mode === 'release' && snapshot.explicitDeploySha) {
    blockers.push('release mode deploy routes cannot use --sha; run /merge and deploy the recorded merged SHA');
  }
  if (snapshot.asyncRequested && steps.some((step) => step.id === 'deploy_staging' || step.id === 'deploy_prod')) {
    blockers.push('destination routes do not support --async because route execution must verify deploy progress before continuing');
  }
  if (snapshot.dirty && !snapshot.worktreeStatusReliable) {
    blockers.push([
      'worktree dirty state is too large or opaque to bind safely to a route confirmation:',
      snapshot.worktreeStatusWarnings.join('; ') || 'status digest is incomplete',
    ].join(' '));
  }
  const includesPrStep = steps.some((step) => step.id === 'pr');
  const dirtyExplicitTargetBlockers: string[] = [];
  if (snapshot.dirty && snapshot.explicitDeploySha) {
    dirtyExplicitTargetBlockers.push([
      'explicit --sha destination routes cannot include dirty local changes because the approved SHA is external to the checkout;',
      'clean the worktree or commit those changes before deploying the approved SHA',
    ].join(' '));
  }
  if (snapshot.dirty && snapshot.explicitPr && !explicitPrMatchesCurrentCheckout(snapshot)) {
    dirtyExplicitTargetBlockers.push([
      `explicit --pr ${snapshot.explicitPr} targets ${snapshot.livePr?.headRefName ?? 'another branch'},`,
      `but the dirty checkout is ${snapshot.branchName || 'detached HEAD'};`,
      'switch to that PR branch or clean the worktree before continuing this route',
    ].join(' '));
  }
  blockers.push(...dirtyExplicitTargetBlockers);
  if (snapshot.dirty && includesPrStep && snapshot.explicitDeploySha) {
    blockers.push([
      'explicit --sha destination routes cannot include dirty local changes because /pr would create a different deploy target;',
      'clean the worktree or run /pr before deploying the approved SHA',
    ].join(' '));
  }
  if (snapshot.dirty && includesPrStep && snapshot.explicitPr && !explicitPrMatchesCurrentCheckout(snapshot)) {
    blockers.push([
      `explicit --pr ${snapshot.explicitPr} targets ${snapshot.livePr?.headRefName ?? 'another branch'},`,
      `but the dirty checkout is ${snapshot.branchName || 'detached HEAD'};`,
      'switch to that PR branch or clean the worktree before continuing this route',
    ].join(' '));
  }
  if (snapshot.dirty && steps.some((step) => step.id === 'pr') && !snapshot.titleProvided && !snapshot.taskName) {
    blockers.push('dirty local changes require --title before creating a PR');
  }
  if (snapshot.dirty && includesPrStep && needsDeploySideEffect) {
    const requested = new Set(snapshot.requestedSurfaces);
    const dirtySurfaces = Object.entries(snapshot.changedBySurface)
      .filter(([, paths]) => paths.length > 0)
      .map(([surface]) => surface);
    const outsideRequested = dirtySurfaces.filter((surface) => !requested.has(surface));
    if (outsideRequested.length > 0) {
      blockers.push([
        `dirty changes touch ${outsideRequested.join(', ')} outside the requested deploy surfaces ${snapshot.requestedSurfaces.join(', ') || '(none)'}.`,
        'Re-run with matching --surfaces, split the change, or clean the worktree before continuing this deployment route',
      ].join(' '));
    }
    if (snapshot.explicitSurfaces && snapshot.changedOther.length > 0) {
      blockers.push([
        `${snapshot.changedOther.length} dirty file(s) do not match surfacePathMap and cannot be tied to the requested deploy surfaces.`,
        'Commit them separately, map them to a surface, or clean the worktree before continuing this deployment route',
      ].join(' '));
    }
  }
  if (needsDeploySideEffect) {
    blockers.push(...snapshot.surfacePathMapBlockers);
  }
  if (snapshot.dirty && !steps.some((step) => step.id === 'pr') && dirtyExplicitTargetBlockers.length === 0) {
    blockers.push('worktree has uncommitted changes; run /pr for those changes or clean the worktree before continuing this route');
  }
  if (needsStagingDeploy) {
    blockers.push(...listMissingDeployConfiguration({
      config: snapshot.deployConfig,
      environment: 'staging',
      surfaces: snapshot.requestedSurfaces,
      defaultWorkflowName: snapshot.defaultDeployWorkflowName,
      allowHealthcheckStubBypass: canBypassDeployHealthcheckConfig(),
    }));
    blockers.push(...listPendingDeployBlockers(snapshot, 'staging', snapshot.requestedSurfaces));
  }
  if (needsProdDeploy) {
    blockers.push(...listMissingDeployConfiguration({
      config: snapshot.deployConfig,
      environment: 'prod',
      surfaces: snapshot.requestedSurfaces,
      defaultWorkflowName: snapshot.defaultDeployWorkflowName,
      allowHealthcheckStubBypass: canBypassDeployHealthcheckConfig(),
    }));
    blockers.push(...listPendingDeployBlockers(snapshot, 'prod', snapshot.requestedSurfaces));
  }
  return [...new Set(blockers)];
}

function destinationStaleBaseBlocker(snapshot: DestinationSnapshot, steps: DestinationStep[]): string {
  if (steps.some((step) => step.id === 'pr')) {
    return buildStaleBaseBlockerForRepo({
      repoRoot: snapshot.repoRoot,
      config: snapshot.config,
      command: 'pr',
    });
  }
  const mergeStepPlanned = steps.some((step) => step.id === 'merge');
  const explicitPrOnAnotherBranch = Boolean(
    snapshot.explicitPr.trim()
    && snapshot.livePr?.headRefName?.trim()
    && snapshot.livePr.headRefName.trim() !== snapshot.branchName,
  );
  if (mergeStepPlanned && !explicitPrOnAnotherBranch) {
    return buildStaleBaseBlockerForRepo({
      repoRoot: snapshot.repoRoot,
      config: snapshot.config,
      command: 'merge',
    });
  }
  return '';
}

function explicitPrMatchesCurrentCheckout(snapshot: DestinationSnapshot): boolean {
  if (!snapshot.explicitPr) return true;
  const prBranch = snapshot.livePr?.headRefName?.trim() ?? '';
  return Boolean(prBranch && snapshot.branchName && prBranch === snapshot.branchName);
}

function canBypassDeployHealthcheckConfig(): boolean {
  return process.env.NODE_ENV === 'test'
    && Boolean(process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS);
}

function buildDestinationWarnings(snapshot: DestinationSnapshot, steps: DestinationStep[]): string[] {
  const warnings: string[] = [];
  if (steps.some((step) => step.id === 'review_gate')) {
    warnings.push('review gate is covered by /merge watching PR checks; no separate /review command is configured');
  }
  if (snapshot.changedOther.length > 0) {
    warnings.push(`${snapshot.changedOther.length} changed file(s) do not match surfacePathMap`);
  }
  for (const warning of snapshot.worktreeStatusWarnings) {
    warnings.push(`worktree status: ${warning}`);
  }
  return warnings;
}

function listPendingDeployBlockers(
  snapshot: DestinationSnapshot,
  environment: 'staging' | 'prod',
  surfaces: string[],
): string[] {
  const pending = findPendingDeployRequest(snapshot, environment, surfaces);
  if (!pending) return [];
  const label = environment === 'prod' ? 'production' : 'staging';
  const shortSha = snapshot.targetSha.slice(0, 7);
  return [`${label} deploy is already in flight for ${shortSha}: ${pending.reason}`];
}

function findPendingDeployRequest(
  snapshot: DestinationSnapshot,
  environment: 'staging' | 'prod',
  surfaces: string[],
): { record: DeployRecord; reason: string } | null {
  const record = findLatestTrustedDeployRecord(snapshot, environment, surfaces);
  if (record?.status === 'requested') {
    if (observeCompletedDeployWorkflowRun(snapshot.repoRoot, record)) return null;
    const requested = describeRequestedDeployRecord(record);
    if (requested?.inFlight) return { record, reason: requested.reason };
  }
  return null;
}

function findQualifiedDeploy(
  snapshot: DestinationSnapshot,
  environment: 'staging' | 'prod',
  surfaces: string[],
): DeployRecord | null {
  const expectedFingerprint = environment === 'staging'
    ? snapshot.deployConfigFingerprints.staging
    : snapshot.deployConfigFingerprints.prod;
  const record = findLatestTrustedDeployRecord(snapshot, environment, surfaces);
  if (!record) return null;
  return disqualifyDeployRecord({
    record,
    surfaces,
    expectedFingerprint,
    stateKey: resolveDeployStateKey(),
  })
    ? null
    : record;
}

function findLatestTrustedDeployRecord(
  snapshot: DestinationSnapshot,
  environment: 'staging' | 'prod',
  surfaces: string[],
): DeployRecord | null {
  const stateKey = resolveDeployStateKey();
  for (let index = snapshot.deployRecords.length - 1; index >= 0; index -= 1) {
    const record = snapshot.deployRecords[index];
    if (!deployRecordMatchesRoute(snapshot, record, environment, surfaces)) continue;
    if (stateKey && !verifyDeployRecord(record, stateKey)) continue;
    return record;
  }
  return null;
}

function deployRecordMatchesRoute(
  snapshot: DestinationSnapshot,
  record: DeployRecord,
  environment: 'staging' | 'prod',
  surfaces: string[],
): boolean {
  if (record.environment !== environment) return false;
  if (snapshot.targetSha && record.sha !== snapshot.targetSha) return false;
  if (snapshot.taskSlug && record.taskSlug !== snapshot.taskSlug) return false;
  const requested = [...surfaces].sort().join(',');
  const recordSurfaces = [...(record.surfaces ?? [])].sort().join(',');
  return recordSurfaces === requested;
}

function resolveReleaseSha(livePr: LivePr | null, prRecord: PrRecord | null, fallback: string): string {
  return prRecord?.mergedSha?.trim()
    || livePr?.mergeCommit?.oid?.trim()
    || fallback;
}

function surfaceReason(snapshot: DestinationSnapshot, surface: string, requested: boolean): string {
  if (!requested) {
    return snapshot.explicitSurfaces ? 'not requested by --surfaces' : 'not in resolved surface set';
  }
  const changed = snapshot.changedBySurface[surface] ?? [];
  if (changed.length > 0) return 'changes detected';
  return 'unchanged, still part of release gate';
}

function currentStatusLine(snapshot: DestinationSnapshot, milestone: DestinationMilestone, releaseSha: string): string {
  if (milestone === 'prod_deployed') return `production deployed and verified at ${releaseSha.slice(0, 7)}`;
  if (milestone === 'staging_deployed') return `staging deployed at ${releaseSha.slice(0, 7)}`;
  if (milestone === 'merged') return `PR merged at ${releaseSha.slice(0, 7)}`;
  if (milestone === 'pr_open') {
    const pr = snapshot.livePr?.number ?? snapshot.prRecord?.number;
    return pr ? `PR #${pr} open` : 'PR open';
  }
  if (snapshot.dirty) return `dirty local changes on ${snapshot.branchName || 'unknown branch'}`;
  return snapshot.branchName ? `clean branch ${snapshot.branchName}` : 'no task state found';
}
