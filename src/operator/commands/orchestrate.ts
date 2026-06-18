import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  buildGoalSpecDraft,
  type GoalSpecDraft,
} from '../goal-spec.ts';
import {
  buildOrchestrationRunRecord,
  loadOrchestrationRunRecord,
  saveOrchestrationRunRecord,
  type OrchestrationRunRecord,
  type OrchestrationSliceRecord,
} from '../orchestration-ledger.ts';
import {
  DEFAULT_GOAL_PROVIDER,
  TASK_SLUG_MAX_LENGTH,
  loadTaskLock,
  normalizePath,
  nowIso,
  type GoalProvider,
  printResult,
  resolveWorkflowContext,
  runGit,
  type ParsedOperatorArgs,
  type WorkflowContext,
} from '../state.ts';
import {
  ensureSharedNodeModulesLink,
  generateUniqueTaskWorkspace,
  removeTaskArtifacts,
  resolveTaskBaseRef,
  resolveTaskWorktreeRoot,
  saveNewTaskLock,
} from '../task-workspaces.ts';

const MAX_PLAN_FILE_BYTES = 256 * 1024;

interface OrchestrateGoalSpecReport {
  command: 'orchestrate goal-spec';
  status: 'drafted';
  repoRoot: string;
  planPath: string | null;
  spec: GoalSpecDraft['spec'];
  provider: GoalProvider;
  providerPrompt: string;
  confirmationPrompt: string;
  requiresConfirmation: boolean;
  critique: string[];
  source: GoalSpecDraft['source'];
  message: string;
}

interface OrchestratePlanReport {
  command: 'orchestrate plan';
  status: 'planned';
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  planPath: string | null;
  sliceCount: number;
  confirmationRecommended: boolean;
  run: OrchestrationRunRecord;
  message: string;
}

interface PreparedSliceReport {
  id: string;
  status: OrchestrationSliceRecord['status'];
  taskSlug: string;
  branchName: string;
  worktreePath: string;
  action: 'created' | 'existing';
}

interface OrchestratePrepareReport {
  command: 'orchestrate prepare';
  status: 'prepared';
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  createdCount: number;
  existingCount: number;
  slices: PreparedSliceReport[];
  warnings: string[];
  run: OrchestrationRunRecord;
  message: string;
}

export async function handleOrchestrate(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const subcommand = parsed.positional[0] ?? '';
  if (subcommand === 'goal-spec') {
    handleGoalSpec(cwd, parsed);
    return;
  }
  if (subcommand === 'plan') {
    handlePlan(cwd, parsed);
    return;
  }
  if (subcommand === 'prepare') {
    handlePrepare(cwd, parsed);
    return;
  }

  throw new Error('orchestrate requires exactly: pipelane run orchestrate <goal-spec|plan|prepare> [--slice-id <id>] [--outcome <text>] [--plan-file <path>] [--run-id <id>] [--provider codex|claude|generic]');
}

function handleGoalSpec(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const planPath = resolvePlanPath(context.repoRoot, parsed.flags.goalPlanFile);
  const draft = buildGoalSpecDraft({
    config: context.config,
    sliceId: parsed.flags.goalSliceId,
    outcome: parsed.flags.goalOutcome,
    planPath: planPath ?? undefined,
    planText: planPath ? readPlanFile(planPath) : undefined,
    provider: (parsed.flags.goalProvider.trim() as GoalProvider) || DEFAULT_GOAL_PROVIDER,
    maxTurns: parsePositiveInteger(parsed.flags.goalMaxTurns),
    maxMinutes: parsePositiveInteger(parsed.flags.goalMaxMinutes),
  });

  const report: OrchestrateGoalSpecReport = {
    command: 'orchestrate goal-spec',
    status: 'drafted',
    repoRoot: context.repoRoot,
    planPath,
    spec: draft.spec,
    provider: draft.provider,
    providerPrompt: draft.providerPrompt,
    confirmationPrompt: draft.confirmationPrompt,
    requiresConfirmation: draft.requiresConfirmation,
    critique: draft.critique,
    source: draft.source,
    message: renderGoalSpecReport(draft, planPath),
  };

  printResult(parsed.flags, report);
}

function handlePrepare(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const runId = parsed.flags.orchestrationRunId.trim();
  const run = loadOrchestrationRunRecord(context.commonDir, context.config, runId);
  if (!run) {
    throw new Error(`No orchestration run ledger found for ${runId}.`);
  }
  if (run.status !== 'planned' && run.status !== 'prepared') {
    throw new Error(`orchestrate prepare cannot modify ${run.status} run ${runId}.`);
  }

  const result = prepareSliceWorktrees(context, run, parsed.flags.offline);
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const report: OrchestratePrepareReport = {
    command: 'orchestrate prepare',
    status: 'prepared',
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    createdCount: result.createdCount,
    existingCount: result.existingCount,
    slices: result.slices,
    warnings: result.warnings,
    run,
    message: renderPrepareReport(run, ledgerPath, result),
  };

  printResult(parsed.flags, report);
}

function prepareSliceWorktrees(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  offline: boolean,
): {
  createdCount: number;
  existingCount: number;
  slices: PreparedSliceReport[];
  warnings: string[];
} {
  let baseRef: ReturnType<typeof resolveTaskBaseRef> | null = null;
  const warnings: string[] = [];
  const reports: PreparedSliceReport[] = [];
  let createdCount = 0;
  let existingCount = 0;

  mkdirSync(resolveTaskWorktreeRoot(context.commonDir, context.config), { recursive: true });

  for (const slice of run.slices) {
    const taskSlug = resolveOrchestrationTaskSlug(run.id, slice);
    const existingLock = loadTaskLock(context.commonDir, context.config, taskSlug);

    if (slice.worktreePath || slice.branchName) {
      if (!slice.worktreePath || !slice.branchName) {
        throw new Error(`Slice ${slice.id} has a partial workspace assignment in run ${run.id}.`);
      }
      if (!existsSync(slice.worktreePath)) {
        throw new Error(`Slice ${slice.id} assigned worktree is missing: ${slice.worktreePath}`);
      }
      assertPreparedWorktreeSafe(context, slice.id, slice.branchName, slice.worktreePath);
      if (existingLock) {
        if (existingLock.branchName !== slice.branchName || existingLock.worktreePath !== slice.worktreePath) {
          throw new Error(`Existing task lock for slice ${slice.id} does not match its ledger assignment.`);
        }
      } else {
        saveNewTaskLock({
          commonDir: context.commonDir,
          config: context.config,
          taskSlug,
          taskName: buildOrchestrationTaskName(run, slice),
          branchName: slice.branchName,
          worktreePath: slice.worktreePath,
          mode: context.modeState.mode,
          surfaces: context.modeState.requestedSurfaces.length > 0 ? context.modeState.requestedSurfaces : context.config.surfaces,
        });
      }
      slice.taskSlug = taskSlug;
      if (slice.status === 'planned') slice.status = 'prepared';
      existingCount += 1;
      reports.push({
        id: slice.id,
        status: slice.status,
        taskSlug,
        branchName: slice.branchName,
        worktreePath: slice.worktreePath,
        action: 'existing',
      });
      persistOrchestrationPrepareProgress(context, run);
      continue;
    }

    if (existingLock) {
      if (!existsSync(existingLock.worktreePath)) {
        throw new Error(`Existing task lock for slice ${slice.id} points at a missing worktree: ${existingLock.worktreePath}`);
      }
      assertPreparedWorktreeSafe(context, slice.id, existingLock.branchName, existingLock.worktreePath);
      slice.taskSlug = taskSlug;
      slice.branchName = existingLock.branchName;
      slice.worktreePath = existingLock.worktreePath;
      slice.status = 'prepared';
      existingCount += 1;
      reports.push({
        id: slice.id,
        status: slice.status,
        taskSlug,
        branchName: slice.branchName,
        worktreePath: slice.worktreePath,
        action: 'existing',
      });
      persistOrchestrationPrepareProgress(context, run);
      continue;
    }

    baseRef ??= resolveTaskBaseRef(context.repoRoot, context.config.baseBranch, offline);
    if (baseRef.warnings.length > 0 && warnings.length === 0) {
      warnings.push(...baseRef.warnings);
    }
    const workspace = generateUniqueTaskWorkspace(context.repoRoot, context.commonDir, context.config, taskSlug);
    runGit(context.repoRoot, ['worktree', 'add', workspace.worktreePath, '-b', workspace.branchName, baseRef.sourceRef]);

    try {
      saveNewTaskLock({
        commonDir: context.commonDir,
        config: context.config,
        taskSlug,
        taskName: buildOrchestrationTaskName(run, slice),
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
        mode: context.modeState.mode,
        surfaces: context.modeState.requestedSurfaces.length > 0 ? context.modeState.requestedSurfaces : context.config.surfaces,
      });
    } catch (error) {
      throw cleanupFailedSliceWorkspace(context, workspace, error);
    }

    const nodeModulesWarning = ensureSharedNodeModulesLink(context.commonDir, workspace.worktreePath, {
      replaceExistingDirectory: true,
    });
    if (nodeModulesWarning) warnings.push(nodeModulesWarning);

    slice.taskSlug = taskSlug;
    slice.branchName = workspace.branchName;
    slice.worktreePath = workspace.worktreePath;
    slice.status = 'prepared';
    createdCount += 1;
    reports.push({
      id: slice.id,
      status: slice.status,
      taskSlug,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      action: 'created',
    });
    persistOrchestrationPrepareProgress(context, run);
  }

  run.status = 'prepared';
  run.updatedAt = nowIso();
  return { createdCount, existingCount, slices: reports, warnings };
}

function persistOrchestrationPrepareProgress(context: WorkflowContext, run: OrchestrationRunRecord): void {
  run.updatedAt = nowIso();
  saveOrchestrationRunRecord(context.commonDir, context.config, run);
}

function buildOrchestrationTaskSlug(runId: string, slice: OrchestrationSliceRecord): string {
  const runPrefix = runId.replace(/^orchestrate-/, 'orch-');
  const prefix = `${runPrefix}-s${slice.index}-`;
  const suffixMax = Math.max(1, TASK_SLUG_MAX_LENGTH - prefix.length);
  const suffix = slice.id.slice(0, suffixMax).replace(/-+$/g, '') || 'slice';
  return `${prefix}${suffix}`;
}

function resolveOrchestrationTaskSlug(runId: string, slice: OrchestrationSliceRecord): string {
  const taskSlug = slice.taskSlug || buildOrchestrationTaskSlug(runId, slice);
  assertSafeOrchestrationTaskSlug(taskSlug, slice.id);
  return taskSlug;
}

function assertSafeOrchestrationTaskSlug(taskSlug: string, sliceId: string): void {
  if (
    taskSlug.length === 0
    || taskSlug.length > TASK_SLUG_MAX_LENGTH
    || !/^[a-z0-9][a-z0-9-]*$/.test(taskSlug)
  ) {
    throw new Error(`Slice ${sliceId} has an unsafe orchestration task slug: ${taskSlug}`);
  }
}

function buildOrchestrationTaskName(run: OrchestrationRunRecord, slice: OrchestrationSliceRecord): string {
  return `Orchestrate ${run.id} slice ${slice.index}: ${slice.outcome}`;
}

function cleanupFailedSliceWorkspace(
  context: WorkflowContext,
  workspace: { branchName: string; worktreePath: string },
  error: unknown,
): Error {
  const cleanup = removeTaskArtifacts({
    sharedRepoRoot: context.repoRoot,
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
    callerCwd: context.repoRoot,
    force: true,
  });
  const message = error instanceof Error ? error.message : String(error);
  if (cleanup.errors.length > 0) {
    return new Error(`${message}\nCleanup after failed orchestration worktree prepare also failed:\n${cleanup.errors.join('\n')}`);
  }
  return new Error(message);
}

function assertPreparedWorktreeSafe(
  context: WorkflowContext,
  sliceId: string,
  branchName: string,
  worktreePath: string,
): void {
  const worktreeRoot = resolveTaskWorktreeRoot(context.commonDir, context.config);
  const rootRealpath = normalizePath(realpathSync(worktreeRoot));
  const worktreeRealpath = normalizePath(realpathSync(worktreePath));
  const relative = path.relative(rootRealpath, worktreeRealpath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Slice ${sliceId} assigned worktree must stay under ${worktreeRoot}: ${worktreePath}`);
  }

  const reportedTopLevel = runGit(worktreePath, ['rev-parse', '--show-toplevel'], true)?.trim();
  if (!reportedTopLevel || normalizePath(realpathSync(reportedTopLevel)) !== worktreeRealpath) {
    throw new Error(`Slice ${sliceId} assigned worktree is not a git worktree: ${worktreePath}`);
  }

  const actualBranch = runGit(worktreePath, ['branch', '--show-current'], true)?.trim();
  if (actualBranch !== branchName) {
    throw new Error(`Slice ${sliceId} assigned worktree branch mismatch: expected ${branchName}, got ${actualBranch || '(detached)'}.`);
  }
}

function handlePlan(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const planPath = resolvePlanPath(context.repoRoot, parsed.flags.goalPlanFile);
  const planText = planPath ? readPlanFile(planPath) : '';
  const outcome = parsed.flags.goalOutcome.trim();
  if (!planText.trim() && !outcome) {
    throw new Error('orchestrate plan requires --plan-file <path> or --outcome <text>.');
  }

  const run = buildOrchestrationRunRecord({
    repoRoot: context.repoRoot,
    config: context.config,
    planPath: planPath ?? undefined,
    planText,
    outcome,
    sliceId: parsed.flags.goalSliceId,
    provider: (parsed.flags.goalProvider.trim() as GoalProvider) || DEFAULT_GOAL_PROVIDER,
    maxTurns: parsePositiveInteger(parsed.flags.goalMaxTurns),
    maxMinutes: parsePositiveInteger(parsed.flags.goalMaxMinutes),
  });
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const confirmationRecommended = run.slices.some((slice) => slice.requiresConfirmation || slice.critique.length > 0);
  const report: OrchestratePlanReport = {
    command: 'orchestrate plan',
    status: 'planned',
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    planPath,
    sliceCount: run.slices.length,
    confirmationRecommended,
    run,
    message: renderPlanReport(run, ledgerPath, planPath, confirmationRecommended),
  };

  printResult(parsed.flags, report);
}

function resolvePlanPath(repoRoot: string, rawPlanPath: string): string | null {
  const trimmed = rawPlanPath.trim();
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
  if (!existsSync(resolved)) {
    throw new Error(`--plan-file not found: ${trimmed}`);
  }
  const repoRealpath = realpathSync(repoRoot);
  const planRealpath = realpathSync(resolved);
  const relative = path.relative(repoRealpath, planRealpath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--plan-file must stay inside the repo: ${trimmed}`);
  }
  return planRealpath;
}

function readPlanFile(planPath: string): string {
  const stat = statSync(planPath);
  if (!stat.isFile()) {
    throw new Error(`--plan-file must point to a regular file: ${planPath}`);
  }
  if (stat.size > MAX_PLAN_FILE_BYTES) {
    throw new Error(`--plan-file is too large: ${stat.size} bytes, max ${MAX_PLAN_FILE_BYTES}.`);
  }
  return readFileSync(planPath, 'utf8');
}

function parsePositiveInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return Number.parseInt(trimmed, 10);
}

function renderGoalSpecReport(draft: GoalSpecDraft, planPath: string | null): string {
  const lines = [
    'Pipelane orchestrate goal-spec',
    '',
    `Status: drafted`,
    `Slice: ${draft.spec.sliceId}`,
    `Outcome: ${draft.spec.outcome}`,
    `Provider: ${draft.provider}`,
  ];

  if (planPath) lines.push(`Plan file: ${planPath}`);
  lines.push(
    `Confirmation: ${draft.requiresConfirmation ? 'recommended before execution' : 'not required by current policy'}`,
  );

  if (draft.critique.length > 0) {
    lines.push('', 'Critique:');
    for (const item of draft.critique) lines.push(`- ${item}`);
  }

  lines.push('', draft.confirmationPrompt);
  lines.push('', 'Provider prompt:', draft.providerPrompt);

  return lines.join('\n');
}

function renderPlanReport(
  run: OrchestrationRunRecord,
  ledgerPath: string,
  planPath: string | null,
  confirmationRecommended: boolean,
): string {
  const lines = [
    'Pipelane orchestrate plan',
    '',
    `Status: planned`,
    `Run: ${run.id}`,
    `Ledger: ${ledgerPath}`,
    `Plan: ${planPath ?? run.source.prompt ?? '(outcome only)'}`,
    `Slices: ${run.slices.length}`,
  ];

  if (confirmationRecommended) {
    lines.push('Confirmation: recommended before execution');
  }

  lines.push('', 'Slice ledger:');
  for (const slice of run.slices) {
    const flags = [
      slice.requiresConfirmation ? 'confirm' : '',
      slice.critique.length > 0 ? 'critique' : '',
    ].filter(Boolean);
    lines.push(`- ${slice.id}: ${slice.outcome}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`);
  }

  lines.push(
    '',
    'Next: run /pipelane orchestrate prepare --run-id <run-id> to create slice worktrees.',
  );

  return lines.join('\n');
}

function renderPrepareReport(
  run: OrchestrationRunRecord,
  ledgerPath: string,
  result: { createdCount: number; existingCount: number; slices: PreparedSliceReport[]; warnings: string[] },
): string {
  const lines = [
    'Pipelane orchestrate prepare',
    '',
    `Status: prepared`,
    `Run: ${run.id}`,
    `Ledger: ${ledgerPath}`,
    `Created worktrees: ${result.createdCount}`,
    `Existing worktrees: ${result.existingCount}`,
  ];

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push('', 'Slice worktrees:');
  for (const slice of result.slices) {
    lines.push(`- ${slice.id}: ${slice.branchName} @ ${slice.worktreePath} (${slice.action})`);
  }

  lines.push(
    '',
    'Provider agents were not started. Next: run the generated GoalSpec prompt in each prepared worktree, then run review gates per slice.',
  );

  return lines.join('\n');
}
