import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  buildGoalSpecDraft,
  type GoalSpecDraft,
} from '../goal-spec.ts';
import {
  buildOrchestrationRunRecord,
  loadOrchestrationRunRecord,
  orchestrationRunPath,
  saveOrchestrationRunRecord,
  type OrchestrationRunRecord,
  type OrchestrationSliceRecord,
  type OrchestrationSliceWorkerRecord,
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

interface DispatchedSliceReport {
  id: string;
  status: OrchestrationSliceRecord['status'];
  provider: GoalProvider;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  handoffCommand: string;
  action: 'written' | 'existing';
}

interface OrchestrateDispatchReport {
  command: 'orchestrate dispatch';
  status: 'dispatched';
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  writtenCount: number;
  existingCount: number;
  slices: DispatchedSliceReport[];
  run: OrchestrationRunRecord;
  message: string;
}

interface DispatchSlicePreparation {
  slice: OrchestrationSliceRecord;
  taskSlug: string;
  promptPath: string;
  handoffCommand: string;
  alreadyDispatched: boolean;
}

interface StartedSliceReport {
  id: string;
  status: OrchestrationSliceRecord['status'];
  provider: GoalProvider;
  branchName: string;
  worktreePath: string;
  promptPath: string;
  logPath: string | null;
  exitCode: number | null;
  signal: string | null;
  action: 'started' | 'restarted' | 'existing' | 'blocked';
  blocker: string | null;
}

interface OrchestrateStartReport {
  command: 'orchestrate start';
  status: 'completed' | 'running' | 'dispatched' | 'failed' | 'blocked' | 'noop';
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  sliceId: string | null;
  force: boolean;
  startedCount: number;
  restartedCount: number;
  existingCount: number;
  failedCount: number;
  blockedCount: number;
  slices: StartedSliceReport[];
  run: OrchestrationRunRecord;
  message: string;
}

interface StartSlicePreparation {
  slice: OrchestrationSliceRecord;
  taskSlug: string;
  promptPath: string;
  providerCommand: string;
  restarting: boolean;
}

interface WorkerExecutionResult {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
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
  if (subcommand === 'dispatch') {
    handleDispatch(cwd, parsed);
    return;
  }
  if (subcommand === 'start') {
    await handleStart(cwd, parsed);
    return;
  }

  throw new Error('orchestrate requires exactly: pipelane run orchestrate <goal-spec|plan|prepare|dispatch|start> [--slice-id <id>] [--outcome <text>] [--plan-file <path>] [--run-id <id>] [--provider codex|claude|generic]');
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

function handleDispatch(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const runId = parsed.flags.orchestrationRunId.trim();
  const run = loadOrchestrationRunRecord(context.commonDir, context.config, runId);
  if (!run) {
    throw new Error(`No orchestration run ledger found for ${runId}.`);
  }
  if (run.status !== 'prepared' && run.status !== 'dispatched') {
    throw new Error(`orchestrate dispatch requires a prepared run; ${runId} is ${run.status}.`);
  }

  const result = dispatchPreparedSlices(context, run);
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const report: OrchestrateDispatchReport = {
    command: 'orchestrate dispatch',
    status: 'dispatched',
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    writtenCount: result.writtenCount,
    existingCount: result.existingCount,
    slices: result.slices,
    run,
    message: renderDispatchReport(run, ledgerPath, result),
  };

  printResult(parsed.flags, report);
}

async function handleStart(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const runId = parsed.flags.orchestrationRunId.trim();
  const sliceId = parsed.flags.goalSliceId.trim() || null;
  const force = parsed.flags.force;
  const run = loadOrchestrationRunRecord(context.commonDir, context.config, runId);
  if (!run) {
    throw new Error(`No orchestration run ledger found for ${runId}.`);
  }
  if (run.status === 'planned' || run.status === 'prepared') {
    throw new Error(`orchestrate start requires a dispatched run; ${runId} is ${run.status}.`);
  }

  const result = await startDispatchedSlices(context, run, sliceId, force);
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const report: OrchestrateStartReport = {
    command: 'orchestrate start',
    status: result.status,
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    sliceId,
    force,
    startedCount: result.startedCount,
    restartedCount: result.restartedCount,
    existingCount: result.existingCount,
    failedCount: result.failedCount,
    blockedCount: result.blockedCount,
    slices: result.slices,
    run,
    message: renderStartReport(run, ledgerPath, sliceId, force, result),
  };

  printResult(parsed.flags, report);
}

function dispatchPreparedSlices(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
): {
  writtenCount: number;
  existingCount: number;
  slices: DispatchedSliceReport[];
} {
  const dispatchRoot = path.join(path.dirname(orchestrationRunPath(context.commonDir, context.config, run.id)), 'dispatch');
  mkdirSync(dispatchRoot, { recursive: true });
  const dispatchedAt = nowIso();
  const reports: DispatchedSliceReport[] = [];
  let writtenCount = 0;
  let existingCount = 0;
  const preparedSlices = run.slices.map((slice): DispatchSlicePreparation => {
    if (slice.status !== 'prepared' && slice.status !== 'dispatched') {
      throw new Error(`Slice ${slice.id} must be prepared before dispatch; current status is ${slice.status}.`);
    }
    const taskSlug = resolveOrchestrationTaskSlug(run.id, slice);
    if (!slice.branchName || !slice.worktreePath) {
      throw new Error(`Slice ${slice.id} is missing a prepared worktree assignment.`);
    }
    if (!existsSync(slice.worktreePath)) {
      throw new Error(`Slice ${slice.id} assigned worktree is missing: ${slice.worktreePath}`);
    }
    assertPreparedWorktreeSafe(context, slice.id, slice.branchName, slice.worktreePath);

    const promptPath = path.join(dispatchRoot, `${taskSlug}.md`);
    return {
      slice,
      taskSlug,
      promptPath,
      handoffCommand: renderDispatchHandoffCommand(slice.worktreePath, promptPath),
      alreadyDispatched: slice.dispatch?.promptPath === promptPath && existsSync(promptPath),
    };
  });

  for (const { slice, taskSlug, promptPath, handoffCommand, alreadyDispatched } of preparedSlices) {
    if (!alreadyDispatched) {
      writeFileSync(promptPath, renderDispatchPrompt(run, slice, handoffCommand), 'utf8');
    }
    slice.taskSlug = taskSlug;
    slice.dispatch = {
      status: 'ready',
      provider: slice.provider,
      promptPath,
      worktreePath: slice.worktreePath,
      branchName: slice.branchName,
      handoffCommand,
      dispatchedAt: alreadyDispatched && slice.dispatch ? slice.dispatch.dispatchedAt : dispatchedAt,
    };
    slice.status = 'dispatched';
    if (alreadyDispatched) existingCount += 1;
    else writtenCount += 1;
    reports.push({
      id: slice.id,
      status: slice.status,
      provider: slice.provider,
      branchName: slice.branchName,
      worktreePath: slice.worktreePath,
      promptPath,
      handoffCommand,
      action: alreadyDispatched ? 'existing' : 'written',
    });
    persistOrchestrationDispatchProgress(context, run);
  }

  run.status = 'dispatched';
  run.updatedAt = nowIso();
  return { writtenCount, existingCount, slices: reports };
}

async function startDispatchedSlices(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  sliceId: string | null,
  force: boolean,
): Promise<{
  status: OrchestrateStartReport['status'];
  startedCount: number;
  restartedCount: number;
  existingCount: number;
  failedCount: number;
  blockedCount: number;
  slices: StartedSliceReport[];
}> {
  const selectedSlices = resolveStartSlices(run, sliceId);
  const runDir = path.dirname(orchestrationRunPath(context.commonDir, context.config, run.id));
  const workerRoot = path.join(runDir, 'workers');
  mkdirSync(workerRoot, { recursive: true });
  const byId = new Map(run.slices.map((slice) => [slice.id, slice]));
  const reports: StartedSliceReport[] = [];
  let startedCount = 0;
  let restartedCount = 0;
  let existingCount = 0;
  let failedCount = 0;
  let blockedCount = 0;

  const pendingSlices = [...selectedSlices];
  while (pendingSlices.length > 0) {
    let progressed = false;
    for (let index = 0; index < pendingSlices.length;) {
      const slice = pendingSlices[index];
      const existingWorker = slice.worker;
      const recoverableExistingWorker = existingWorker?.status === 'running' || existingWorker?.status === 'failed';
      if (
        existingWorker
        && (
          existingWorker.status === 'succeeded'
          || (recoverableExistingWorker && !force)
        )
      ) {
        existingCount += 1;
        reports.push(buildExistingWorkerReport(slice, existingWorker));
        pendingSlices.splice(index, 1);
        progressed = true;
        continue;
      }

      const blocker = dependencyBlocker(slice, byId);
      if (blocker && dependencyMayCompleteLater(slice, byId, pendingSlices)) {
        index += 1;
        continue;
      }
      if (blocker) {
        blockedCount += 1;
        slice.status = 'blocked';
        reports.push(buildBlockedWorkerReport(slice, blocker));
        persistOrchestrationStartProgress(context, run);
        pendingSlices.splice(index, 1);
        progressed = true;
        continue;
      }

      const restarting = Boolean(existingWorker && recoverableExistingWorker && force);
      if (restarting && existingWorker?.status === 'running') {
        await terminateExistingRunningWorker(existingWorker);
      }
      const prepared = prepareSliceForStart(context, run, workerRoot, slice, restarting);
      const worker = await runProviderWorker(context, run, prepared);
      slice.worker = worker;
      slice.status = worker.status === 'succeeded' ? 'completed' : 'failed';
      if (restarting) restartedCount += 1;
      else startedCount += 1;
      if (worker.status === 'failed') failedCount += 1;
      reports.push({
        id: slice.id,
        status: slice.status,
        provider: slice.provider,
        branchName: slice.branchName ?? '',
        worktreePath: slice.worktreePath ?? '',
        promptPath: worker.promptPath,
        logPath: worker.logPath,
        exitCode: worker.exitCode,
        signal: worker.signal,
        action: restarting ? 'restarted' : 'started',
        blocker: null,
      });
      persistOrchestrationStartProgress(context, run);
      pendingSlices.splice(index, 1);
      progressed = true;
    }

    if (!progressed) {
      for (const slice of pendingSlices.splice(0)) {
        blockedCount += 1;
        slice.status = 'blocked';
        reports.push(buildBlockedWorkerReport(slice, dependencyBlocker(slice, byId) ?? 'dependency cycle or unsatisfied dependency order'));
        persistOrchestrationStartProgress(context, run);
      }
    }
  }

  run.status = summarizeRunWorkerStatus(run);
  run.updatedAt = nowIso();
  return {
    status: reportStatusForStart(run.status, startedCount, restartedCount, existingCount, failedCount, blockedCount),
    startedCount,
    restartedCount,
    existingCount,
    failedCount,
    blockedCount,
    slices: reports,
  };
}

function resolveStartSlices(run: OrchestrationRunRecord, sliceId: string | null): OrchestrationSliceRecord[] {
  if (!sliceId) return run.slices;
  const slice = run.slices.find((candidate) => candidate.id === sliceId);
  if (!slice) {
    throw new Error(`No slice ${sliceId} found in orchestration run ${run.id}.`);
  }
  return [slice];
}

function prepareSliceForStart(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  workerRoot: string,
  slice: OrchestrationSliceRecord,
  restarting: boolean,
): StartSlicePreparation {
  if (slice.status !== 'dispatched' && slice.status !== 'blocked' && !(restarting && (slice.status === 'running' || slice.status === 'failed'))) {
    throw new Error(`Slice ${slice.id} must be dispatched before start; current status is ${slice.status}.`);
  }
  const taskSlug = resolveOrchestrationTaskSlug(run.id, slice);
  if (!slice.branchName || !slice.worktreePath || !slice.dispatch) {
    throw new Error(`Slice ${slice.id} is missing dispatch metadata.`);
  }
  if (!existsSync(slice.worktreePath)) {
    throw new Error(`Slice ${slice.id} assigned worktree is missing: ${slice.worktreePath}`);
  }
  assertPreparedWorktreeSafe(context, slice.id, slice.branchName, slice.worktreePath);
  if (slice.dispatch.branchName !== slice.branchName || slice.dispatch.worktreePath !== slice.worktreePath) {
    throw new Error(`Slice ${slice.id} dispatch metadata does not match its prepared worktree assignment.`);
  }

  const runDir = path.dirname(orchestrationRunPath(context.commonDir, context.config, run.id));
  const promptPath = path.join(runDir, 'dispatch', `${taskSlug}.md`);
  if (slice.dispatch.promptPath !== promptPath) {
    throw new Error(`Slice ${slice.id} dispatch prompt path does not match its expected location.`);
  }
  assertDispatchPromptSafe(runDir, slice.id, promptPath);
  mkdirSync(workerRoot, { recursive: true });

  return {
    slice,
    taskSlug,
    promptPath,
    providerCommand: resolveProviderCommand(slice.provider),
    restarting,
  };
}

function resolveProviderCommand(provider: GoalProvider): string {
  const providerKey = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const providerSpecific = process.env[`PIPELANE_ORCHESTRATE_${providerKey}_COMMAND`]?.trim();
  const fallback = process.env.PIPELANE_ORCHESTRATE_WORKER_COMMAND?.trim();
  const command = providerSpecific || fallback || '';
  if (!command) {
    throw new Error(`orchestrate start requires PIPELANE_ORCHESTRATE_${providerKey}_COMMAND or PIPELANE_ORCHESTRATE_WORKER_COMMAND.`);
  }
  return command;
}

function assertDispatchPromptSafe(runDir: string, sliceId: string, promptPath: string): void {
  const dispatchRoot = path.join(runDir, 'dispatch');
  if (!existsSync(promptPath)) {
    throw new Error(`Slice ${sliceId} dispatch prompt is missing: ${promptPath}`);
  }
  const rootRealpath = normalizePath(realpathSync(dispatchRoot));
  const promptRealpath = normalizePath(realpathSync(promptPath));
  const relative = path.relative(rootRealpath, promptRealpath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Slice ${sliceId} dispatch prompt must stay under ${dispatchRoot}: ${promptPath}`);
  }
}

async function runProviderWorker(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  prepared: StartSlicePreparation,
): Promise<OrchestrationSliceWorkerRecord> {
  const { slice, taskSlug, promptPath, providerCommand } = prepared;
  const startedAt = nowIso();
  const runDir = path.dirname(orchestrationRunPath(context.commonDir, context.config, run.id));
  const logPath = path.join(runDir, 'workers', `${taskSlug}-${Date.now()}.log`);
  const redactedProviderCommand = redactOrchestrationWorkerText(providerCommand);
  const prompt = readFileSync(promptPath, 'utf8');
  const runningWorker: OrchestrationSliceWorkerRecord = {
    status: 'running',
    provider: slice.provider,
    command: redactedProviderCommand,
    pid: null,
    promptPath,
    logPath,
    startedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
  };

  writeWorkerLog(logPath, [
    'Pipelane orchestrate worker',
    '',
    `Run: ${run.id}`,
    `Slice: ${slice.id}`,
    `Provider: ${slice.provider}`,
    `Command: ${redactedProviderCommand}`,
    `Restarting: ${prepared.restarting ? 'yes' : 'no'}`,
    `Worktree: ${slice.worktreePath ?? ''}`,
    `Prompt: ${promptPath}`,
    `Started: ${startedAt}`,
    '',
  ].join('\n'));

  slice.worker = runningWorker;
  slice.status = 'running';
  run.status = 'running';
  persistOrchestrationStartProgress(context, run);

  const result = await executeProviderWorker({
    command: providerCommand,
    cwd: slice.worktreePath ?? context.repoRoot,
    env: {
      ...process.env,
      PIPELANE_ORCHESTRATE_RUN_ID: run.id,
      PIPELANE_ORCHESTRATE_SLICE_ID: slice.id,
      PIPELANE_ORCHESTRATE_SLICE_INDEX: String(slice.index),
      PIPELANE_ORCHESTRATE_PROVIDER: slice.provider,
      PIPELANE_ORCHESTRATE_TASK_SLUG: taskSlug,
      PIPELANE_ORCHESTRATE_BRANCH_NAME: slice.branchName ?? '',
      PIPELANE_ORCHESTRATE_WORKTREE_PATH: slice.worktreePath ?? '',
      PIPELANE_ORCHESTRATE_PROMPT_PATH: promptPath,
      PIPELANE_ORCHESTRATE_LOG_PATH: logPath,
      PIPELANE_ORCHESTRATE_LEDGER_PATH: orchestrationRunPath(context.commonDir, context.config, run.id),
    },
    prompt,
    logPath,
    timeoutMs: resolveWorkerTimeoutMs(slice),
    onSpawn: (pid) => {
      runningWorker.pid = pid;
      slice.worker = { ...runningWorker };
      persistOrchestrationStartProgress(context, run);
    },
  });

  const finishedAt = nowIso();
  const errorMessage = result.error ? redactOrchestrationWorkerText(result.error) : null;
  appendFileSync(logPath, [
    '',
    '--- result ---',
    `Finished: ${finishedAt}`,
    `Exit code: ${result.exitCode ?? ''}`,
    `Signal: ${result.signal ?? ''}`,
    errorMessage ? `Error: ${errorMessage}` : '',
    '',
  ].filter((line) => line !== '').join('\n'), 'utf8');

  return {
    ...runningWorker,
    status: result.exitCode === 0 && !result.error ? 'succeeded' : 'failed',
    pid: result.pid,
    finishedAt,
    exitCode: result.exitCode,
    signal: result.signal,
    error: errorMessage,
  };
}

function executeProviderWorker(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  logPath: string;
  timeoutMs: number;
  onSpawn: (pid: number | null) => void;
}): Promise<WorkerExecutionResult> {
  return new Promise((resolve) => {
    const stdout = createRedactedLogAppender(options.logPath, 'stdout');
    const stderr = createRedactedLogAppender(options.logPath, 'stderr');
    let spawnError: Error | null = null;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn('/bin/sh', ['-lc', options.command], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    options.onSpawn(child.pid ?? null);

    const timeout = setTimeout(() => {
      timedOut = true;
      signalWorkerProcessTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalWorkerProcessTree(child.pid, 'SIGKILL');
      }, 5_000);
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout.write(chunk));
    child.stderr.on('data', (chunk: string) => stderr.write(chunk));
    child.on('error', (error) => {
      spawnError = error;
    });
    // Workers may read PIPELANE_ORCHESTRATE_PROMPT_PATH and close stdin early.
    child.stdin.on('error', () => {});
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      stdout.flush();
      stderr.flush();
      const timeoutError = timedOut ? `Worker timed out after ${options.timeoutMs} ms.` : null;
      resolve({
        pid: child.pid ?? null,
        exitCode,
        signal,
        error: timeoutError ?? spawnError?.message ?? null,
      });
    });
    child.stdin.end(options.prompt);
  });
}

async function terminateExistingRunningWorker(worker: OrchestrationSliceWorkerRecord): Promise<void> {
  const pid = worker.pid ?? null;
  if (pid === null || !isWorkerProcessGroupAlive(pid)) return;
  signalWorkerProcessGroup(pid, 'SIGTERM');
  await waitForWorkerProcessGroupExit(pid, 1_000);
  if (isWorkerProcessGroupAlive(pid)) {
    signalWorkerProcessGroup(pid, 'SIGKILL');
    await waitForWorkerProcessGroupExit(pid, 500);
  }
}

function signalWorkerProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Recovery never falls back to a bare pid because stale ledgers can outlive pid reuse.
  }
}

function signalWorkerProcessTree(pid: number | undefined | null, signal: NodeJS.Signals): void {
  if (pid !== undefined && pid !== null) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the platform or process state does not expose the group.
    }
    try {
      process.kill(pid, signal);
    } catch {
      // The old worker may already have exited.
    }
  }
}

async function waitForWorkerProcessGroupExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isWorkerProcessGroupAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isWorkerProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createRedactedLogAppender(logPath: string, label: string): { write: (chunk: string) => void; flush: () => void } {
  const maxUnterminatedLineChars = 64 * 1024;
  let pending = '';
  let wroteHeader = false;
  const writeSection = (text: string): void => {
    if (!text) return;
    const header = wroteHeader ? '' : `\n--- ${label} ---\n`;
    appendFileSync(logPath, `${header}${redactOrchestrationWorkerText(text)}`, 'utf8');
    wroteHeader = true;
  };

  return {
    write(chunk: string): void {
      pending += chunk;
      const lastNewline = pending.lastIndexOf('\n');
      if (lastNewline >= 0) {
        writeSection(pending.slice(0, lastNewline + 1));
        pending = pending.slice(lastNewline + 1);
      }
      if (pending.length > maxUnterminatedLineChars) {
        const omittedCount = pending.length - maxUnterminatedLineChars;
        writeSection(`${pending.slice(0, maxUnterminatedLineChars)}\n[... ${omittedCount} chars omitted from long unterminated line ...]\n`);
        pending = '';
      }
    },
    flush(): void {
      writeSection(pending);
      pending = '';
    },
  };
}

const CREDENTIAL_FIELD_PATTERN = '(?:token|key|secret|password|pass|auth|session|cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|access[_-]?key)';

function redactOrchestrationWorkerText(value: string): string {
  return value
    .replace(new RegExp(`([?&]${CREDENTIAL_FIELD_PATTERN}=)[^&\\s]+`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`(["'])(${CREDENTIAL_FIELD_PATTERN})\\1\\s*:\\s*("[^"]*"|'[^']*'|[^\\s,}]+)`, 'gi'), '$1$2$1: [REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH_HEADER]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2=[REDACTED]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)\s+("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2 [REDACTED]')
    .replace(new RegExp(`(^|[\\s{,])(${CREDENTIAL_FIELD_PATTERN}\\s*:\\s*)("[^"]*"|'[^']*'|[^\\s,}]+)`, 'gi'), '$1$2[REDACTED]')
    .replace(new RegExp(`(^|\\s)(${CREDENTIAL_FIELD_PATTERN}=)("[^"]*"|'[^']*'|[^\\s]+)`, 'gi'), '$1$2[REDACTED]')
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|SESSION|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s]+)/g, (match) => {
      const key = match.split('=')[0];
      return `${key}=[REDACTED]`;
    });
}

function resolveWorkerTimeoutMs(slice: OrchestrationSliceRecord): number {
  const envValue = process.env.PIPELANE_ORCHESTRATE_WORKER_TIMEOUT_MS?.trim();
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return Math.max(1, slice.goalSpec.budget.maxMinutes) * 60 * 1000;
}

function writeWorkerLog(logPath: string, body: string): void {
  mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileSync(logPath, body, 'utf8');
}

function dependencyBlocker(slice: OrchestrationSliceRecord, byId: Map<string, OrchestrationSliceRecord>): string | null {
  for (const dependencyId of slice.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (!dependency) return `missing dependency ${dependencyId}`;
    if (dependency.worker?.status === 'succeeded' || dependency.status === 'completed') continue;
    if (dependency.worker?.status === 'failed' || dependency.status === 'failed') return `dependency ${dependencyId} failed`;
    return `dependency ${dependencyId} has not completed`;
  }
  return null;
}

function dependencyMayCompleteLater(
  slice: OrchestrationSliceRecord,
  byId: Map<string, OrchestrationSliceRecord>,
  pendingSlices: OrchestrationSliceRecord[],
): boolean {
  const pendingIds = new Set(pendingSlices.map((pendingSlice) => pendingSlice.id));
  for (const dependencyId of slice.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (!dependency) return false;
    if (dependency.worker?.status === 'succeeded' || dependency.status === 'completed') continue;
    if (dependency.worker?.status === 'failed' || dependency.status === 'failed') return false;
    if (pendingIds.has(dependencyId)) return true;
  }
  return false;
}

function buildExistingWorkerReport(
  slice: OrchestrationSliceRecord,
  worker: OrchestrationSliceWorkerRecord,
): StartedSliceReport {
  return {
    id: slice.id,
    status: worker.status === 'succeeded' ? 'completed' : worker.status === 'failed' ? 'failed' : 'running',
    provider: slice.provider,
    branchName: slice.branchName ?? '',
    worktreePath: slice.worktreePath ?? '',
    promptPath: worker.promptPath,
    logPath: worker.logPath,
    exitCode: worker.exitCode,
    signal: worker.signal,
    action: 'existing',
    blocker: null,
  };
}

function buildBlockedWorkerReport(slice: OrchestrationSliceRecord, blocker: string): StartedSliceReport {
  return {
    id: slice.id,
    status: 'blocked',
    provider: slice.provider,
    branchName: slice.branchName ?? '',
    worktreePath: slice.worktreePath ?? '',
    promptPath: slice.dispatch?.promptPath ?? '',
    logPath: null,
    exitCode: null,
    signal: null,
    action: 'blocked',
    blocker,
  };
}

function summarizeRunWorkerStatus(run: OrchestrationRunRecord): OrchestrationRunRecord['status'] {
  if (run.slices.some((slice) => slice.worker?.status === 'failed' || slice.status === 'failed')) return 'failed';
  if (run.slices.every((slice) => slice.worker?.status === 'succeeded' || slice.status === 'completed')) return 'completed';
  if (run.slices.some((slice) => slice.worker?.status === 'running' || slice.status === 'running')) return 'running';
  if (run.slices.some((slice) => slice.status === 'blocked')) return 'blocked';
  return 'dispatched';
}

function reportStatusForStart(
  runStatus: OrchestrationRunRecord['status'],
  startedCount: number,
  restartedCount: number,
  existingCount: number,
  failedCount: number,
  blockedCount: number,
): OrchestrateStartReport['status'] {
  if (failedCount > 0 || runStatus === 'failed') return 'failed';
  if (blockedCount > 0 && startedCount === 0 && restartedCount === 0 && existingCount === 0) return 'blocked';
  if (runStatus === 'running') return 'running';
  if (startedCount === 0 && restartedCount === 0 && existingCount > 0 && blockedCount === 0) return 'noop';
  if (runStatus === 'completed') return 'completed';
  if (runStatus === 'blocked') return 'blocked';
  return 'dispatched';
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

function persistOrchestrationDispatchProgress(context: WorkflowContext, run: OrchestrationRunRecord): void {
  run.updatedAt = nowIso();
  saveOrchestrationRunRecord(context.commonDir, context.config, run);
}

function persistOrchestrationStartProgress(context: WorkflowContext, run: OrchestrationRunRecord): void {
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

function renderDispatchHandoffCommand(worktreePath: string, promptPath: string): string {
  return `cd ${shellQuote(worktreePath)} && cat ${shellQuote(promptPath)}`;
}

function renderDispatchPrompt(
  run: OrchestrationRunRecord,
  slice: OrchestrationSliceRecord,
  handoffCommand: string,
): string {
  return [
    `# Pipelane Orchestration Slice`,
    '',
    `Run: ${run.id}`,
    `Slice: ${slice.id}`,
    `Provider: ${slice.provider}`,
    `Branch: ${slice.branchName ?? '(unassigned)'}`,
    `Worktree: ${slice.worktreePath ?? '(unassigned)'}`,
    '',
    '## Handoff',
    '',
    'Open the provider session in the worktree above and run the GoalSpec prompt below.',
    'Pipelane generated this handoff file only; it did not start a provider process.',
    '',
    'Suggested shell handoff:',
    '',
    '```bash',
    handoffCommand,
    '```',
    '',
    '## Provider Prompt',
    '',
    slice.providerPrompt,
    '',
    '## Required Slice Review',
    '',
    'After implementation, run `/pipelane review` in this worktree and record the output in the final handoff.',
    'Do not merge, deploy, or clean this task workspace from inside the slice worker.',
    '',
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
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
    'Provider agents were not started. Next: run /pipelane orchestrate dispatch --run-id <run-id> to write provider handoff prompts.',
  );

  return lines.join('\n');
}

function renderDispatchReport(
  run: OrchestrationRunRecord,
  ledgerPath: string,
  result: { writtenCount: number; existingCount: number; slices: DispatchedSliceReport[] },
): string {
  const lines = [
    'Pipelane orchestrate dispatch',
    '',
    `Status: dispatched`,
    `Run: ${run.id}`,
    `Ledger: ${ledgerPath}`,
    `Written prompts: ${result.writtenCount}`,
    `Existing prompts: ${result.existingCount}`,
    '',
    'Slice handoffs:',
  ];

  for (const slice of result.slices) {
    lines.push(`- ${slice.id}: ${slice.provider} prompt at ${slice.promptPath} (${slice.action})`);
  }

  lines.push(
    '',
    'Provider agents were not started by this command.',
    'Next: configure PIPELANE_ORCHESTRATE_WORKER_COMMAND or PIPELANE_ORCHESTRATE_<PROVIDER>_COMMAND, then run /pipelane orchestrate start --run-id <run-id>.',
  );

  return lines.join('\n');
}

function renderStartReport(
  run: OrchestrationRunRecord,
  ledgerPath: string,
  sliceId: string | null,
  force: boolean,
  result: {
    status: OrchestrateStartReport['status'];
    startedCount: number;
    restartedCount: number;
    existingCount: number;
    failedCount: number;
    blockedCount: number;
    slices: StartedSliceReport[];
  },
): string {
  const lines = [
    'Pipelane orchestrate start',
    '',
    `Status: ${result.status}`,
    `Run: ${run.id}`,
    `Ledger: ${ledgerPath}`,
    `Slice filter: ${sliceId ?? '(all eligible slices)'}`,
    `Force retry: ${force ? 'yes' : 'no'}`,
    `Started workers: ${result.startedCount}`,
    `Restarted workers: ${result.restartedCount}`,
    `Existing workers: ${result.existingCount}`,
    `Failed workers: ${result.failedCount}`,
    `Blocked slices: ${result.blockedCount}`,
    '',
    'Worker evidence:',
  ];

  for (const slice of result.slices) {
    const suffix = slice.action === 'blocked'
      ? `blocked: ${slice.blocker}`
      : `exit=${slice.exitCode ?? ''}${slice.signal ? ` signal=${slice.signal}` : ''} log=${slice.logPath ?? ''}`;
    lines.push(`- ${slice.id}: ${slice.action} ${suffix}`);
  }

  if (result.slices.some((slice) => slice.action === 'existing' && (slice.status === 'failed' || slice.status === 'running'))) {
    lines.push(
      '',
      'Recovery: rerun /pipelane orchestrate start --run-id <run-id> [--slice-id <id>] --force to retry failed or stale running workers.',
    );
  }

  lines.push(
    '',
    'Worker completion only. Review gates, merge, deploy, and cleanup were not run by this command.',
  );

  return lines.join('\n');
}
