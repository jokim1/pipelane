import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
  buildGoalSpecDraft,
  type GoalSpecDraft,
} from '../goal-spec.ts';
import { sanitizeForTerminal } from '../text-output.ts';
import {
  buildOrchestrationRunRecord,
  diagnoseOrchestrationRunRecord,
  isActiveOrchestrationRun,
  listOrchestrationRunRecords,
  loadOrchestrationRunRecord,
  missingRelevantSliceWorktreeDiagnostic,
  ORCHESTRATION_CORRUPT_LEDGER_BLOCK_AGE_MS,
  orchestrationRunPath,
  renderSliceWorkerPrompt,
  saveOrchestrationRunRecord,
  scanOrchestrationRunDiagnostics,
  selectActiveSlices,
  hasResumableDeferredSlices,
  sliceReviewFullySatisfied,
  type BuildOrchestrationSliceInput,
  type OrchestrationCoverageEntry,
  type OrchestrationLedgerDiagnostic,
  type OrchestrationReviewFixRecord,
  type OrchestrationRunRecord,
  type OrchestrationRunScanDiagnostics,
  type OrchestrationRunDirectoryDiagnostic,
  type OrchestrationSliceReviewRecord,
  type OrchestrationSliceRecord,
  type OrchestrationSliceWorkerRecord,
} from '../orchestration-ledger.ts';
import { resolveReviewStateKey } from '../integrity.ts';
import {
  blockingAiReviewEvidenceBlocker,
  classifyReviewEvidenceIndependence,
  createReviewActorIdentity,
  resolveReviewActorIdentity,
} from '../review-identity.ts';
import { buildReviewRunRecord, collectChangedFiles } from './review.ts';
import {
  DEFAULT_GOAL_PROVIDER,
  TASK_SLUG_MAX_LENGTH,
  loadTaskLock,
  normalizePath,
  nowIso,
  type GoalProvider,
  printResult,
  resolveGitCommonDir,
  resolveWorkflowContext,
  runGit,
  loadReviewState,
  type ParsedOperatorArgs,
  type ReviewGateConfig,
  type ReviewGateRunRecord,
  type ReviewGatePhase,
  type ReviewRunRecord,
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
const MAX_LIKELY_PLAN_FILES = 5;
const MAX_PLAN_SCAN_FILES = 200;
const ORCHESTRATION_REVIEW_DIAGNOSTIC_MAX = 10;
const NATIVE_COMMAND_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_REVIEW_LOOP_LIMIT = 2;
// B2: a slice's review auto-fix stops once its canonical no-progress signature
// repeats this many consecutive times. Configurable via
// orchestrate.hardStops.maxStalledIterations.
const DEFAULT_MAX_STALLED_ITERATIONS = 2;
const INHERITED_AGENT_SESSION_ENV_KEYS = [
  'CODEX_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'OPENAI_SESSION_ID',
  'ANTHROPIC_SESSION_ID',
  'OPENCLAW_SESSION',
] as const;
const WORKER_SECRET_ENV_KEYS = [
  'PIPELANE_REVIEW_STATE_KEY',
  'PIPELANE_DEPLOY_STATE_KEY',
  'PIPELANE_PROBE_STATE_KEY',
] as const;
const WORKER_CREDENTIAL_ENV_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|COOKIE|SESSION|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH)(?:_|$)/i;
const WORKER_CREDENTIAL_ENV_PREFIXES = [
  'AWS_',
  'CLOUDFLARE_',
  'GCP_',
  'GOOGLE_',
  'SUPABASE_',
  'STRIPE_',
] as const;
const WORKER_CREDENTIAL_ENV_EXACT_KEYS = [
  'SSH_AUTH_SOCK',
  'AUTHORIZATION',
  'HTTP_AUTHORIZATION',
  'PROXY_AUTHORIZATION',
  'NPM_AUTH_TOKEN',
  'NODE_AUTH_TOKEN',
  'DATABASE_URL',
  'DATABASE_URI',
  'DB_URL',
  'DB_URI',
  'POSTGRES_URL',
  'POSTGRES_URI',
  'POSTGRESQL_URL',
  'POSTGRESQL_URI',
  'MYSQL_URL',
  'MYSQL_URI',
  'REDIS_URL',
  'REDIS_URI',
  'MONGO_URL',
  'MONGO_URI',
  'MONGODB_URL',
  'MONGODB_URI',
] as const;
const WORKER_ENV_ALLOWLIST_ENV = 'PIPELANE_ORCHESTRATE_WORKER_ENV_ALLOW';

type OrchestrateEntryStatus = 'needs-input' | 'preview' | 'active' | 'multiple-active' | 'cancelled' | 'blocked' | 'pending' | OrchestrateStartReport['status'];

interface OrchestrateEntryRunSummary {
  id: string;
  status: OrchestrationRunRecord['status'];
  updatedAt: string;
  title: string;
  sliceCount: number;
  completedSlices: number;
  failedSlices: number;
  pendingSlices: number;
  deferredSlices: number;
  planPath: string | null;
}

interface LikelyPlanFile {
  path: string;
  score: number;
  reason: string;
}

interface OrchestrateEntryReport {
  command: 'orchestrate';
  status: OrchestrateEntryStatus;
  repoRoot: string;
  runId: string | null;
  ledgerPath: string | null;
  planPath: string | null;
  activeRuns: OrchestrateEntryRunSummary[];
  likelyPlanFiles: LikelyPlanFile[];
  warnings?: string[];
  attention?: string[];
  corruptLedgers?: OrchestrationCorruptLedgerSummary[];
  invalidRunDirectories?: OrchestrationInvalidRunDirectorySummary[];
  run?: OrchestrationRunRecord;
  review?: OrchestrateEntryReviewSummary | null;
  autoFix?: OrchestrateEntryAutoFixSummary | null;
  message: string;
}

interface OrchestrationCorruptLedgerSummary {
  runId: string;
  ledgerPath: string;
  reason: string;
  mtimeMs: number | null;
  recent: boolean;
}

interface OrchestrationInvalidRunDirectorySummary {
  runId: string;
  directoryPath: string;
  ledgerPath: string | null;
  reason: string;
  mtimeMs: number | null;
}

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

interface ReviewedSliceReport {
  id: string;
  status: OrchestrationSliceRecord['status'];
  reviewStatus: ReviewRunRecord['status'] | null;
  branchName: string;
  worktreePath: string;
  runId: string | null;
  gateCount: number;
  action: 'reviewed' | 'blocked';
  blocker: string | null;
}

interface OrchestrateReviewReport {
  command: 'orchestrate review';
  status: 'passed' | 'pending' | 'failed' | 'blocked' | 'noop';
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  sliceId: string | null;
  dryRun: boolean;
  gateFilter: string | null;
  phaseFilter: ReviewGatePhase | null;
  reviewedCount: number;
  failedCount: number;
  pendingCount: number;
  blockedCount: number;
  slices: ReviewedSliceReport[];
  run: OrchestrationRunRecord;
  message: string;
}

interface OrchestrateEntryReviewSummary {
  status: OrchestrateReviewReport['status'];
  reviewedCount: number;
  failedCount: number;
  pendingCount: number;
  blockedCount: number;
}

interface OrchestrateEntryAutoFixSummary {
  // B2: `fixed` is reported ONLY when the re-review actually passed. `stalled` is
  // an in-memory terminal (not a persisted slice status) meaning a slice's
  // canonical no-progress signature repeated, so auto-fix stopped re-running it.
  status: 'fixed' | 'failed' | 'exhausted' | 'stalled' | 'skipped' | 'noop';
  attemptedCount: number;
  fixedCount: number;
  failedCount: number;
  attempts: ReviewAutoFixAttemptReport[];
  reason?: string;
}

interface ReviewAutoFixAttemptReport {
  id: string;
  status: OrchestrationSliceRecord['status'];
  workerStatus: OrchestrationSliceWorkerRecord['status'];
  attempt: number;
  failedGateIds: string[];
  promptPath: string;
  logPath: string | null;
  exitCode: number | null;
}

type ReviewCompletedSlicesResult = {
  status: OrchestrateReviewReport['status'];
  reviewedCount: number;
  failedCount: number;
  pendingCount: number;
  blockedCount: number;
  slices: ReviewedSliceReport[];
};

type ReviewAutoFixResult = OrchestrateEntryAutoFixSummary & {
  finalReview: ReviewCompletedSlicesResult | null;
};

interface StartSlicePreparation {
  slice: OrchestrationSliceRecord;
  taskSlug: string;
  // The human artifact on disk (dispatch handoff `.md` or review-fix `.md`).
  promptPath: string;
  // A3: the EXACT prompt piped to the worker. The initial run supplies the
  // derived worker prompt (no handoff boilerplate); the auto-fix run supplies
  // the review-fix prompt. The worker never re-reads promptPath.
  prompt: string;
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
  if (subcommand === '' || subcommand === 'run') {
    await handleOrchestrateEntry(cwd, parsed);
    return;
  }
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
  if (subcommand === 'review') {
    handleOrchestrationReview(cwd, parsed);
    return;
  }
  if (subcommand === 'scope') {
    handleScope(cwd, parsed);
    return;
  }
  if (subcommand === 'outline') {
    handleOutline(cwd, parsed);
    return;
  }
  if (subcommand === 'finalize') {
    handleFinalize(cwd, parsed);
    return;
  }

  throw new Error('orchestrate requires exactly: pipelane run orchestrate [--plan-file <path> | --outcome <text>] [--preview|--plan|--yes], or pipelane run orchestrate <goal-spec|plan|prepare|dispatch|start|review|scope|outline|finalize> [--slice-id <id>] [--outcome <text>] [--plan-file <path>] [--slices-file <path>] [--run-id <id>] [--through <slice-id>] [--provider codex|claude|generic]');
}

async function handleOrchestrateEntry(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const planPath = resolvePlanPath(context.repoRoot, parsed.flags.goalPlanFile);
  const outcome = parsed.flags.goalOutcome.trim();
  const explicitRunId = parsed.flags.orchestrationRunId.trim();
  const likelyPlanFiles = collectLikelyPlanFiles(context.repoRoot);
  const scan = scanOrchestrationRunDiagnostics(context.commonDir, context.config);
  const activeRuns = listActiveOrchestrationRuns(context, scan.records);
  const ledgerWarnings = buildOrchestrationScanWarnings(scan);
  const recentCorruptLedgers = recentCorruptDiagnostics(scan);

  if (explicitRunId) {
    const diagnostic = diagnoseOrchestrationRunRecord(context.commonDir, context.config, explicitRunId);
    if (diagnostic.status === 'invalid-run-id') {
      throw new Error(diagnostic.reason);
    }
    if (diagnostic.status === 'corrupt') {
      printResult(parsed.flags, buildCorruptLedgerBlockReport(context, diagnostic, activeRuns, likelyPlanFiles));
      process.exitCode = 1;
      return;
    }
    const run = diagnostic.status === 'valid'
      ? diagnostic.record
      : loadOrchestrationRunRecord(context.commonDir, context.config, explicitRunId);
    if (!run) throw new Error(`No orchestration run ledger found for ${explicitRunId}.`);
    printResult(parsed.flags, buildOrchestrateEntryStatusReport(context, run, activeRuns, likelyPlanFiles, ledgerWarnings, scan));
    return;
  }

  if (planPath || outcome) {
    if (recentCorruptLedgers.length > 0 && (parsed.flags.yes || (!parsed.flags.preview && !parsed.flags.plan && canRunInteractiveOrchestrate()))) {
      printResult(parsed.flags, buildCorruptLedgerBlockReport(context, recentCorruptLedgers[0], activeRuns, likelyPlanFiles, ledgerWarnings, scan));
      process.exitCode = 1;
      return;
    }
    const run = buildEntryRunRecord(context, parsed, planPath, outcome);
    if (parsed.flags.yes) {
      const report = await runApprovedOrchestration(context, run, planPath, activeRuns, likelyPlanFiles, parsed.flags.offline, ledgerWarnings, scan, !parsed.flags.json);
      printResult(parsed.flags, report);
      if (approvedOrchestrationStatusRequiresAttention(report.status)) process.exitCode = 1;
      return;
    }
    if (!parsed.flags.preview && !parsed.flags.plan && canRunInteractiveOrchestrate()) {
      await confirmAndMaybeRunOrchestration(context, parsed, run, planPath, activeRuns, likelyPlanFiles, undefined, ledgerWarnings, scan);
      return;
    }
    printResult(parsed.flags, buildOrchestratePreviewReport(context, run, planPath, activeRuns, likelyPlanFiles, ledgerWarnings, scan));
    return;
  }

  if (activeRuns.length === 1) {
    const run = loadOrchestrationRunRecord(context.commonDir, context.config, activeRuns[0].id);
    if (!run) throw new Error(`No orchestration run ledger found for ${activeRuns[0].id}.`);
    printResult(parsed.flags, buildOrchestrateEntryStatusReport(context, run, activeRuns, likelyPlanFiles, ledgerWarnings, scan));
    return;
  }

  if (activeRuns.length > 1) {
    if (canRunInteractiveOrchestrate() && !parsed.flags.json) {
      await chooseActiveOrchestrationRun(context, parsed, activeRuns, likelyPlanFiles, ledgerWarnings, scan);
      return;
    }
    printResult(parsed.flags, buildMultipleActiveRunsReport(context, activeRuns, likelyPlanFiles, ledgerWarnings, scan));
    return;
  }

  if (recentCorruptLedgers.length > 0) {
    printResult(parsed.flags, buildCorruptLedgerBlockReport(context, recentCorruptLedgers[0], activeRuns, likelyPlanFiles, ledgerWarnings, scan));
    process.exitCode = 1;
    return;
  }

  if (!canRunInteractiveOrchestrate()) {
    throw new Error('orchestrate requires a TTY for interactive setup. Use --plan-file <path> --preview to inspect, --plan-file <path> --yes to start, or --outcome <text> --preview for automation.');
  }

  await runInteractiveOrchestrateSetup(context, parsed, likelyPlanFiles, ledgerWarnings, scan);
}

function buildEntryRunRecord(
  context: WorkflowContext,
  parsed: ParsedOperatorArgs,
  planPath: string | null,
  outcome: string,
): OrchestrationRunRecord {
  const planText = planPath ? readPlanFile(planPath) : '';
  if (!planText.trim() && !outcome) {
    throw new Error('orchestrate requires --plan-file <path> or --outcome <text> to preview or start a new run.');
  }
  return buildOrchestrationRunRecord({
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
}

async function runApprovedOrchestration(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  planPath: string | null,
  previousActiveRuns: OrchestrateEntryRunSummary[],
  likelyPlanFiles: LikelyPlanFile[],
  offline: boolean,
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
  reprint = false,
): Promise<OrchestrateEntryReport> {
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  prepareSliceWorktrees(context, run, offline);
  dispatchPreparedSlices(context, run);
  // No silent autopilot: even --yes reprints the outline after each slice (text
  // mode only — JSON output stays a single clean document).
  const onSliceSettled = reprint
    ? (settledRun: OrchestrationRunRecord, settledSlice: OrchestrationSliceRecord): void => {
        process.stdout.write(`\n${renderSliceHeadline(settledRun, settledSlice)}\n\n${renderOrchestrationOutline(settledRun)}\n`);
      }
    : undefined;
  const startResult = await startDispatchedSlices(context, run, null, false, onSliceSettled);
  let reviewResult = shouldRunApprovedOrchestrationReview(startResult, run)
    ? reviewCompletedSlices(context, run, {
        sliceId: null,
        dryRun: false,
        gateFilter: '',
        phaseFilter: '',
        requireGates: true,
      })
    : null;
  const autoFixResult = reviewResult?.status === 'failed'
    ? await autoFixFailedReviewSlices(context, run, reviewResult)
    : null;
  if (autoFixResult?.finalReview) {
    reviewResult = autoFixResult.finalReview;
  }
  const finalLedgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const report: OrchestrateEntryReport = {
    command: 'orchestrate',
    status: approvedOrchestrationEntryStatus(startResult.status, reviewResult),
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath: finalLedgerPath || ledgerPath,
    planPath,
    activeRuns: [summarizeEntryRun(run), ...previousActiveRuns.filter((entry) => entry.id !== run.id)],
    likelyPlanFiles,
    warnings,
    attention: scan ? buildOrchestrationScanAttention(scan) : [],
    corruptLedgers: scan ? summarizeCorruptLedgers(scan.corrupt) : [],
    invalidRunDirectories: scan ? summarizeInvalidRunDirectories(scan.invalidDirectories) : [],
    run,
    review: reviewResult ? summarizeEntryReview(reviewResult) : null,
    autoFix: autoFixResult ? summarizeEntryAutoFix(autoFixResult) : null,
    message: appendOrchestrationDiagnostics(renderApprovedOrchestrationReport(run, finalLedgerPath || ledgerPath, planPath, startResult, reviewResult, autoFixResult), warnings, scan),
  };
  return report;
}

function shouldRunApprovedOrchestrationReview(
  startResult: {
    failedCount: number;
    blockedCount: number;
  },
  run: OrchestrationRunRecord,
): boolean {
  if (startResult.failedCount > 0 || startResult.blockedCount > 0) return false;
  if (run.slices.some((slice) => slice.worker?.status === 'running' || slice.status === 'running')) return false;
  return run.slices.some((slice) => slice.worker?.status === 'succeeded');
}

function approvedOrchestrationEntryStatus(
  startStatus: OrchestrateStartReport['status'],
  reviewResult: ReviewCompletedSlicesResult | null,
): OrchestrateEntryStatus {
  if (!reviewResult) return startStatus;
  if (reviewResult.status === 'passed') return 'completed';
  if (reviewResult.status === 'noop') return startStatus;
  return reviewResult.status;
}

function summarizeEntryReview(result: ReviewCompletedSlicesResult): OrchestrateEntryReviewSummary {
  return {
    status: result.status,
    reviewedCount: result.reviewedCount,
    failedCount: result.failedCount,
    pendingCount: result.pendingCount,
    blockedCount: result.blockedCount,
  };
}

function summarizeEntryAutoFix(result: ReviewAutoFixResult): OrchestrateEntryAutoFixSummary {
  return {
    status: result.status,
    attemptedCount: result.attemptedCount,
    fixedCount: result.fixedCount,
    failedCount: result.failedCount,
    attempts: result.attempts,
    reason: result.reason,
  };
}

function approvedOrchestrationStatusRequiresAttention(status: OrchestrateEntryStatus): boolean {
  return status === 'failed' || status === 'blocked' || status === 'pending';
}

async function autoFixFailedReviewSlices(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  initialReview: ReviewCompletedSlicesResult,
): Promise<ReviewAutoFixResult> {
  const budget = resolveReviewAutoFixBudget(run);
  const maxFixAttempts = budget.maxFixAttempts;
  const maxStalledIterations = budget.maxStalledIterations;
  if (maxFixAttempts <= 0) {
    return {
      status: 'skipped',
      attemptedCount: 0,
      fixedCount: 0,
      failedCount: initialReview.failedCount,
      attempts: [],
      finalReview: null,
      reason: `${budget.source}=${budget.reviewLoops} leaves no review-fix attempt budget`,
    };
  }

  const attempts: ReviewAutoFixAttemptReport[] = [];
  const attemptedSliceIds = new Set<string>();
  // B2 (#13): per-slice canonical signature history + the set of slices whose
  // signature repeated maxStalledIterations times (no progress) and are stopped.
  const stalledSliceIds = new Set<string>();
  const signatureHistory = new Map<string, string[]>();
  let latestReview = initialReview;
  let workerFailureCount = 0;
  for (let attempt = 1; attempt <= maxFixAttempts; attempt += 1) {
    const candidates = run.slices
      .map((slice) => ({ slice, failedGates: failedBlockingReviewGates(slice) }))
      .filter((entry) => entry.failedGates.length > 0 && !stalledSliceIds.has(entry.slice.id));
    if (candidates.length === 0) {
      // B2: nothing actionable remains. If some slices stalled, report `stalled`
      // (no-progress) so the operator intervenes rather than the loop silently
      // declaring noop/fixed.
      if (stalledSliceIds.size > 0) {
        return buildStalledAutoFixResult(run, attempts, attemptedSliceIds, stalledSliceIds, latestReview);
      }
      // Honesty: blocking failures cleared, but the re-review did not pass either
      // (a passed re-review returns `fixed` at the bottom of the prior attempt).
      // This is the "failures cleared but not passed" case (e.g. a now-pending
      // gate) — report noop, never fixed.
      return {
        status: 'noop',
        attemptedCount: attempts.length,
        fixedCount: countFixedSlices(run, attemptedSliceIds),
        failedCount: latestReview.failedCount,
        attempts,
        finalReview: latestReview,
        reason: `no failed blocking review gates remained to auto-fix (review status: ${latestReview.status})`,
      };
    }

    // B2 (#13): detect no-progress BEFORE spending another fix worker. Record each
    // slice's canonical signature; once it repeats maxStalledIterations times in a
    // row the slice is stalled and skipped now and on every later attempt.
    const toRun: { slice: OrchestrationSliceRecord; failedGates: ReviewGateRunRecord[]; signature: string }[] = [];
    for (const entry of candidates) {
      const signature = computeSliceFailureSignature(context, entry.slice, entry.failedGates);
      const history = [...(signatureHistory.get(entry.slice.id) ?? []), signature];
      signatureHistory.set(entry.slice.id, history);
      const repeats = countTrailingRepeats(history);
      if (repeats >= maxStalledIterations) {
        stalledSliceIds.add(entry.slice.id);
        writeOrchestrationReviewProgress(
          { dryRun: false },
          `slice ${entry.slice.id}: no-progress signature repeated ${repeats}x (>= ${maxStalledIterations}); marking stalled and stopping its auto-fix`,
        );
      } else {
        toRun.push({ ...entry, signature });
      }
    }

    if (toRun.length === 0) {
      // Every actionable slice just became stalled this pass.
      return buildStalledAutoFixResult(run, attempts, attemptedSliceIds, stalledSliceIds, latestReview);
    }

    writeOrchestrationReviewProgress(
      { dryRun: false },
      `review auto-fix attempt ${attempt}/${maxFixAttempts}: ${toRun.length} ${toRun.length === 1 ? 'slice' : 'slices'} with failed blocking gates`,
    );

    for (const { slice, failedGates, signature } of toRun) {
      const failedGateIds = failedGates.map((gate) => gate.gateId);
      const prepared = prepareSliceForReviewAutoFix(context, run, slice, failedGates, attempt);
      if (slice.review) {
        appendSliceReviewDiagnostic(slice, slice.review);
        slice.review = null;
      }
      writeOrchestrationReviewProgress(
        { dryRun: false },
        `slice ${slice.id}: starting review auto-fix attempt ${attempt}/${maxFixAttempts} for gates ${failedGateIds.join(', ')}`,
      );
      const worker = await runProviderWorker(context, run, prepared);
      writeOrchestrationReviewProgress(
        { dryRun: false },
        `slice ${slice.id}: review auto-fix attempt ${attempt}/${maxFixAttempts} worker ${worker.status}; log ${worker.logPath}`,
      );
      slice.worker = worker;
      // B2 (line 704 reconcile): unlike the initial start path, this is NOT an
      // `empty` check. A fix worker operates on a slice that already carries the
      // original material change, so `collectChangedFiles` is non-empty and B1's
      // `empty` never applies. A fix that changes nothing is the no-progress case,
      // caught by the canonical signature (stall detection), not by reclassifying
      // to `empty`. This status is transient for a succeeded worker — the
      // re-review below recomputes it; it only sticks when the worker failed.
      slice.status = worker.status === 'succeeded' ? 'completed' : 'failed';
      attemptedSliceIds.add(slice.id);
      attempts.push({
        id: slice.id,
        status: slice.status,
        workerStatus: worker.status,
        attempt,
        failedGateIds,
        promptPath: prepared.promptPath,
        logPath: worker.logPath,
        exitCode: worker.exitCode,
      });
      appendRunReviewFixRecord(run, {
        sliceId: slice.id,
        status: slice.status,
        workerStatus: worker.status,
        attempt,
        failedGateIds,
        promptPath: prepared.promptPath,
        logPath: worker.logPath,
        exitCode: worker.exitCode,
        recordedAt: nowIso(),
        // B2 (#15): the failure signature this attempt addressed. reviewStatus +
        // lesson are filled in by the enrichment loop over `toRun` below, once the
        // re-review verdict is known.
        signature,
      });
      if (worker.status === 'failed') workerFailureCount += 1;
      run.status = summarizeRunWorkerStatus(run);
      persistOrchestrationStartProgress(context, run);
    }

    if (workerFailureCount > 0) {
      return {
        status: 'failed',
        attemptedCount: attempts.length,
        fixedCount: 0,
        failedCount: workerFailureCount,
        attempts,
        finalReview: null,
        reason: 'one or more review-fix workers failed before review could be retried',
      };
    }

    writeOrchestrationReviewProgress(
      { dryRun: false },
      `review auto-fix attempt ${attempt}/${maxFixAttempts}: rerunning review gates`,
    );
    latestReview = reviewCompletedSlices(context, run, {
      sliceId: null,
      dryRun: false,
      gateFilter: '',
      phaseFilter: '',
      requireGates: true,
    });
    writeOrchestrationReviewProgress(
      { dryRun: false },
      `review auto-fix attempt ${attempt}/${maxFixAttempts}: review ${latestReview.status} (${latestReview.failedCount} failed, ${latestReview.pendingCount} pending, ${latestReview.blockedCount} blocked)`,
    );
    // B2 (#15): author each attempt's journal entry from the REAL re-review
    // outcome (Result = re-review verdict, Lesson keyed by the canonical
    // signature) so the next attempt's fix prompt feeds it forward.
    for (const { slice, failedGates, signature } of toRun) {
      const record = findReviewFixRecord(run, slice.id, attempt);
      if (!record) continue;
      record.reviewStatus = slice.review?.status ?? null;
      record.lesson = deriveReviewFixLesson(failedGates.map((gate) => gate.gateId), record.reviewStatus, signature);
    }
    if (latestReview.status === 'passed') {
      // B2 (honesty): report `fixed` ONLY when the re-review actually passed — a
      // `pending`/`blocked` re-review is not a fix. fixedCount counts the slices
      // whose review now passes, not the slices we attempted.
      return {
        status: 'fixed',
        attemptedCount: attempts.length,
        fixedCount: countFixedSlices(run, attemptedSliceIds),
        failedCount: latestReview.failedCount,
        attempts,
        finalReview: latestReview,
      };
    }
  }

  // B2: if a slice stalled along the way, report it as the more actionable
  // terminal even when attempts also ran out.
  if (stalledSliceIds.size > 0) {
    return buildStalledAutoFixResult(run, attempts, attemptedSliceIds, stalledSliceIds, latestReview);
  }
  return {
    status: 'exhausted',
    attemptedCount: attempts.length,
    fixedCount: countFixedSlices(run, attemptedSliceIds),
    failedCount: latestReview.failedCount,
    attempts,
    finalReview: latestReview,
    reason: `review did not pass (final status: ${latestReview.status}) after all configured review-fix attempts`,
  };
}

function resolveReviewAutoFixBudget(run: OrchestrationRunRecord): {
  reviewLoops: number;
  maxFixAttempts: number;
  maxStalledIterations: number;
  source: string;
} {
  const hardStops = run.configSnapshot.hardStops ?? {};
  // Clamp to >= 2: a stall means a fix ran and left the SAME signature, so the
  // first observation (count 1, the pre-fix baseline) can never be a stall. A
  // configured 1 — or a hand-edited 0 in the ledger — would otherwise trip the
  // stall check on the first observation and disable auto-fix without ever
  // attempting a single fix.
  const maxStalledIterations = Math.max(2, hardStops.maxStalledIterations ?? DEFAULT_MAX_STALLED_ITERATIONS);
  const configuredReviewLoops = hardStops.maxReviewLoops;
  if (configuredReviewLoops !== undefined) {
    return {
      reviewLoops: configuredReviewLoops,
      maxFixAttempts: Math.max(0, configuredReviewLoops - 1),
      maxStalledIterations,
      source: 'orchestrate.hardStops.maxReviewLoops',
    };
  }
  const legacyIterations = hardStops.maxIterationsPerSlice;
  if (legacyIterations !== undefined) {
    return {
      reviewLoops: legacyIterations,
      maxFixAttempts: Math.max(0, legacyIterations - 1),
      maxStalledIterations,
      source: 'orchestrate.hardStops.maxIterationsPerSlice',
    };
  }
  return {
    reviewLoops: DEFAULT_REVIEW_LOOP_LIMIT,
    maxFixAttempts: Math.max(0, DEFAULT_REVIEW_LOOP_LIMIT - 1),
    maxStalledIterations,
    source: 'default review loop limit',
  };
}

function failedBlockingReviewGates(slice: OrchestrationSliceRecord): ReviewGateRunRecord[] {
  return slice.review?.run.gates.filter((gate) => gate.blocking && gate.status === 'failed') ?? [];
}

// B2 (honesty): a slice counts as fixed only when its re-review actually passed,
// so the auto-fix summary reports genuine fixes rather than merely attempted
// slices. A slice left pending/blocked/failed is not counted.
function countFixedSlices(run: OrchestrationRunRecord, attemptedSliceIds: Set<string>): number {
  let fixed = 0;
  for (const slice of run.slices) {
    if (attemptedSliceIds.has(slice.id) && slice.review?.status === 'passed') fixed += 1;
  }
  return fixed;
}

// B2 (#13): the canonical no-progress signature for a slice's current failure.
// It hashes {gateId, status, error-class, changed-files-digest} where:
//   - the changed-files-digest is over `collectChangedFiles` output (committed +
//     staged + unstaged + untracked) — NOT worktreeStatusDigest. A committing fix
//     loop leaves a clean tree, so a dirty-tree-only digest would change between a
//     dirty iteration and a committed one and miss the stall; collectChangedFiles
//     still reflects what the loop actually changed.
//   - the error-class is the stable {type, exitCode} pair, deliberately excluding
//     volatile gate text (summary/stdout/stderr) and timing (durationMs/
//     startedAt/finishedAt) so reruns that differ only in noise hash identically.
// Two consecutive identical signatures mean the intervening fix made no progress.
// Tradeoff: the digest is the changed-file SET, not file contents, so a fix that
// keeps editing the same file(s) while the gate keeps the same exitCode hashes
// identically and is treated as no-progress. This is deliberate (content hashing
// would reintroduce the instability the stable error-class avoids); the escape
// hatch is raising orchestrate.hardStops.maxStalledIterations, and the
// fed-forward journal nudges the worker toward a genuinely different approach.
function computeSliceFailureSignature(
  context: WorkflowContext,
  slice: OrchestrationSliceRecord,
  failedGates: ReviewGateRunRecord[],
): string {
  const worktree = slice.worktreePath ?? context.repoRoot;
  // collectChangedFiles returns a fresh array, so sorting in place is safe.
  const changedFiles = collectChangedFiles(worktree, context.config.baseBranch).sort();
  const changedFilesDigest = hashOrchestrationSignature(changedFiles.join('\n'));
  const gateParts = failedGates
    .map((gate) => `${gate.gateId}|${gate.status}|${gate.type}|${gate.exitCode ?? 'na'}`)
    .sort();
  return hashOrchestrationSignature(JSON.stringify({ gates: gateParts, changedFilesDigest }));
}

function hashOrchestrationSignature(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// B2: count of identical entries at the tail of the list (>= 1 when non-empty,
// reset to 1 whenever the most recent signature differs from the prior one).
function countTrailingRepeats(signatures: string[]): number {
  if (signatures.length === 0) return 0;
  const last = signatures[signatures.length - 1];
  let count = 0;
  for (let index = signatures.length - 1; index >= 0 && signatures[index] === last; index -= 1) {
    count += 1;
  }
  return count;
}

function buildStalledAutoFixResult(
  run: OrchestrationRunRecord,
  attempts: ReviewAutoFixAttemptReport[],
  attemptedSliceIds: Set<string>,
  stalledSliceIds: Set<string>,
  latestReview: ReviewCompletedSlicesResult,
): ReviewAutoFixResult {
  const stalled = [...stalledSliceIds];
  return {
    status: 'stalled',
    attemptedCount: attempts.length,
    fixedCount: countFixedSlices(run, attemptedSliceIds),
    failedCount: latestReview.failedCount,
    attempts,
    finalReview: latestReview,
    reason: `no-progress detected: ${stalled.length === 1 ? 'slice' : 'slices'} ${stalled.join(', ')} repeated the same failure signature without progress`,
  };
}

function appendRunReviewFixRecord(run: OrchestrationRunRecord, record: OrchestrationReviewFixRecord): void {
  run.reviewFixes = [...(run.reviewFixes ?? []), record];
}

// B2 (#15): the most recent review-fix record for a slice+attempt, so the
// orchestrator can enrich it with the re-review verdict + lesson after review.
function findReviewFixRecord(
  run: OrchestrationRunRecord,
  sliceId: string,
  attempt: number,
): OrchestrationReviewFixRecord | undefined {
  const records = run.reviewFixes ?? [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].sliceId === sliceId && records[index].attempt === attempt) return records[index];
  }
  return undefined;
}

// B2 (#15): a derived one-liner whose symptom key IS the canonical no-progress
// signature, authored from the real re-review verdict — fed forward so a later
// attempt must try something the journal does not already show failing.
function deriveReviewFixLesson(
  failedGateIds: string[],
  reviewStatus: ReviewRunRecord['status'] | null,
  signature: string,
): string {
  const symptom = signature.slice(0, 12);
  const gates = failedGateIds.length > 0 ? failedGateIds.join(', ') : 'the failing gate(s)';
  if (reviewStatus === 'passed') {
    return `symptom ${symptom}: this fix resolved gate(s) ${gates}.`;
  }
  const verdict = reviewStatus === 'failed'
    ? 'still failed'
    : reviewStatus === 'pending'
      ? 'left the gate(s) pending'
      : `left the review ${reviewStatus ?? 'unresolved'}`;
  return `symptom ${symptom}: the attempted fix for gate(s) ${gates} ${verdict}; repeating this approach will not work — try a structurally different fix.`;
}

function formatReviewFixResult(reviewStatus: ReviewRunRecord['status'] | null | undefined): string {
  if (reviewStatus === 'passed') return 'review passed';
  if (reviewStatus === 'failed') return 'review still failed';
  if (reviewStatus === 'pending') return 'review left pending gates';
  return 'review outcome not recorded';
}

function buildOrchestratePreviewReport(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  planPath: string | null,
  activeRuns: OrchestrateEntryRunSummary[],
  likelyPlanFiles: LikelyPlanFile[],
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
): OrchestrateEntryReport {
  return {
    command: 'orchestrate',
    status: 'preview',
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath: null,
    planPath,
    activeRuns,
    likelyPlanFiles,
    warnings,
    attention: scan ? buildOrchestrationScanAttention(scan) : [],
    corruptLedgers: scan ? summarizeCorruptLedgers(scan.corrupt) : [],
    invalidRunDirectories: scan ? summarizeInvalidRunDirectories(scan.invalidDirectories) : [],
    run,
    message: appendOrchestrationDiagnostics(renderOrchestrationPreview(context.repoRoot, run, planPath), warnings, scan),
  };
}

function buildOrchestrateEntryStatusReport(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  activeRuns: OrchestrateEntryRunSummary[],
  likelyPlanFiles: LikelyPlanFile[],
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
): OrchestrateEntryReport {
  return {
    command: 'orchestrate',
    status: 'active',
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath: orchestrationRunPath(context.commonDir, context.config, run.id),
    planPath: run.source.planPath ? path.join(context.repoRoot, run.source.planPath) : null,
    activeRuns,
    likelyPlanFiles,
    warnings,
    attention: scan ? buildOrchestrationScanAttention(scan) : [],
    corruptLedgers: scan ? summarizeCorruptLedgers(scan.corrupt) : [],
    invalidRunDirectories: scan ? summarizeInvalidRunDirectories(scan.invalidDirectories) : [],
    run,
    message: appendOrchestrationDiagnostics(renderActiveRunReport(context, run), warnings, scan),
  };
}

function buildMultipleActiveRunsReport(
  context: WorkflowContext,
  activeRuns: OrchestrateEntryRunSummary[],
  likelyPlanFiles: LikelyPlanFile[],
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
): OrchestrateEntryReport {
  return {
    command: 'orchestrate',
    status: 'multiple-active',
    repoRoot: context.repoRoot,
    runId: null,
    ledgerPath: null,
    planPath: null,
    activeRuns,
    likelyPlanFiles,
    warnings,
    attention: scan ? buildOrchestrationScanAttention(scan) : [],
    corruptLedgers: scan ? summarizeCorruptLedgers(scan.corrupt) : [],
    invalidRunDirectories: scan ? summarizeInvalidRunDirectories(scan.invalidDirectories) : [],
    message: appendOrchestrationDiagnostics(renderMultipleActiveRunsReport(activeRuns), warnings, scan),
  };
}

function buildCorruptLedgerBlockReport(
  context: WorkflowContext,
  diagnostic: Extract<OrchestrationLedgerDiagnostic, { status: 'corrupt' }>,
  activeRuns: OrchestrateEntryRunSummary[],
  likelyPlanFiles: LikelyPlanFile[],
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
): OrchestrateEntryReport {
  const corruptLedgers = scan ? summarizeCorruptLedgers(scan.corrupt) : [summarizeCorruptLedger(diagnostic)];
  return {
    command: 'orchestrate',
    status: 'blocked',
    repoRoot: context.repoRoot,
    runId: diagnostic.runId,
    ledgerPath: diagnostic.ledgerPath,
    planPath: null,
    activeRuns,
    likelyPlanFiles,
    warnings,
    attention: [
      `Orchestration ledger is unreadable: ${diagnostic.ledgerPath}`,
      ...(scan ? buildOrchestrationScanAttention(scan) : []),
    ],
    corruptLedgers,
    invalidRunDirectories: scan ? summarizeInvalidRunDirectories(scan.invalidDirectories) : [],
    message: appendOrchestrationDiagnostics(renderCorruptLedgerBlock(diagnostic), warnings, scan),
  };
}

function recentCorruptDiagnostics(
  scan: OrchestrationRunScanDiagnostics,
): Extract<OrchestrationLedgerDiagnostic, { status: 'corrupt' }>[] {
  return scan.corrupt.filter(isRecentCorruptLedger);
}

function isRecentCorruptLedger(diagnostic: Pick<OrchestrationCorruptLedgerSummary, 'mtimeMs'>): boolean {
  if (diagnostic.mtimeMs === null) return true;
  return diagnostic.mtimeMs >= Date.now() - ORCHESTRATION_CORRUPT_LEDGER_BLOCK_AGE_MS;
}

function buildOrchestrationScanWarnings(scan: OrchestrationRunScanDiagnostics): string[] {
  const warnings: string[] = [];
  for (const diagnostic of scan.corrupt) {
    if (isRecentCorruptLedger(diagnostic)) continue;
    warnings.push(`Ignored older corrupt orchestration ledger ${diagnostic.ledgerPath}: ${diagnostic.reason}`);
  }
  for (const diagnostic of scan.invalidDirectories) {
    warnings.push(`Ignored invalid orchestration run directory ${diagnostic.directoryPath}: ${diagnostic.reason}`);
  }
  return warnings;
}

function buildOrchestrationScanAttention(scan: OrchestrationRunScanDiagnostics): string[] {
  return scan.corrupt
    .filter(isRecentCorruptLedger)
    .map((diagnostic) => `Repair or move aside unreadable orchestration ledger ${diagnostic.ledgerPath}`);
}

function summarizeCorruptLedgers(
  diagnostics: Extract<OrchestrationLedgerDiagnostic, { status: 'corrupt' }>[],
): OrchestrationCorruptLedgerSummary[] {
  return diagnostics.map(summarizeCorruptLedger);
}

function summarizeCorruptLedger(
  diagnostic: Extract<OrchestrationLedgerDiagnostic, { status: 'corrupt' }>,
): OrchestrationCorruptLedgerSummary {
  return {
    runId: diagnostic.runId,
    ledgerPath: diagnostic.ledgerPath,
    reason: diagnostic.reason,
    mtimeMs: diagnostic.mtimeMs,
    recent: isRecentCorruptLedger(diagnostic),
  };
}

function summarizeInvalidRunDirectories(
  diagnostics: OrchestrationRunDirectoryDiagnostic[],
): OrchestrationInvalidRunDirectorySummary[] {
  return diagnostics.map((diagnostic) => ({
    runId: diagnostic.runId,
    directoryPath: diagnostic.directoryPath,
    ledgerPath: diagnostic.ledgerPath,
    reason: diagnostic.reason,
    mtimeMs: diagnostic.mtimeMs,
  }));
}

function appendOrchestrationDiagnostics(
  base: string,
  warnings: string[],
  scan?: OrchestrationRunScanDiagnostics,
): string {
  const attention = scan ? buildOrchestrationScanAttention(scan) : [];
  if (warnings.length === 0 && attention.length === 0) return base;
  const lines = [base];
  if (attention.length > 0) {
    lines.push('', 'Attention:');
    for (const item of attention) lines.push(`- ${item}`);
  }
  if (warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}

function renderCorruptLedgerBlock(
  diagnostic: Extract<OrchestrationLedgerDiagnostic, { status: 'corrupt' }>,
): string {
  const abandonedPath = path.join(path.dirname(path.dirname(path.dirname(diagnostic.ledgerPath))), 'abandoned', diagnostic.runId);
  return [
    'Pipelane orchestrate',
    '',
    'Status: blocked',
    '',
    'Orchestration ledger is unreadable:',
    `  path: ${diagnostic.ledgerPath}`,
    `  reason: ${diagnostic.reason}`,
    '',
    'No state was changed.',
    '',
    'Next:',
    '1. Restore the ledger from a known-good backup/local copy if this run matters.',
    '2. Move the corrupt run directory outside .pipelane/state/orchestrate/runs/ if the run is abandoned, for example to:',
    `   ${abandonedPath}`,
    '3. Re-run /pipelane orchestrate after repair.',
  ].join('\n');
}

async function confirmAndMaybeRunOrchestration(
  context: WorkflowContext,
  parsed: ParsedOperatorArgs,
  run: OrchestrationRunRecord,
  planPath: string | null,
  activeRuns: OrchestrateEntryRunSummary[],
  likelyPlanFiles: LikelyPlanFile[],
  existingPrompter?: {
    question(prompt: string): Promise<string>;
    close(): void;
  },
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
): Promise<void> {
  const prompter = existingPrompter ?? createOrchestratePrompter();
  try {
    process.stdout.write(`${appendOrchestrationDiagnostics(renderOrchestrationPreview(context.repoRoot, run, planPath), warnings, scan)}\n\nStart orchestration now?\n1. Start now\n2. Cancel\n`);
    const answer = (await prompter.question('> ')).trim().toLowerCase();
    if (answer !== '1' && answer !== 'y' && answer !== 'yes' && answer !== 'start') {
      printResult(parsed.flags, buildCancelledOrchestrationReport(context, likelyPlanFiles));
      return;
    }
    const report = await runApprovedOrchestration(context, run, planPath, activeRuns, likelyPlanFiles, parsed.flags.offline, warnings, scan, !parsed.flags.json);
    printResult(parsed.flags, report);
    if (approvedOrchestrationStatusRequiresAttention(report.status)) process.exitCode = 1;
  } finally {
    if (!existingPrompter) prompter.close();
  }
}

async function runInteractiveOrchestrateSetup(
  context: WorkflowContext,
  parsed: ParsedOperatorArgs,
  likelyPlanFiles: LikelyPlanFile[],
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
): Promise<void> {
  const prompter = createOrchestratePrompter();
  try {
    process.stdout.write(`${appendOrchestrationDiagnostics(renderInteractiveOrchestrationSetup(likelyPlanFiles), warnings, scan)}\n`);
    const answer = (await prompter.question('> ')).trim().toLowerCase();
    if (answer === 'c' || answer === 'cancel') {
      printResult(parsed.flags, buildCancelledOrchestrationReport(context, likelyPlanFiles));
      return;
    }

    let planPath: string | null = null;
    let outcome = '';
    const planIndex = Number.parseInt(answer, 10);
    if (Number.isSafeInteger(planIndex) && planIndex >= 1 && planIndex <= likelyPlanFiles.length) {
      planPath = resolvePlanPath(context.repoRoot, likelyPlanFiles[planIndex - 1].path);
    } else if (answer === 'd' || answer === 'different') {
      const rawPath = await prompter.question('Plan file path: ');
      planPath = resolvePlanPath(context.repoRoot, rawPath);
    } else if (answer === 'g' || answer === 'goal') {
      outcome = (await prompter.question('Goal: ')).trim();
      if (!outcome) throw new Error('orchestrate goal description cannot be empty.');
    } else {
      throw new Error('Choose a plan number, d for a different plan file, g to describe the goal, or c to cancel.');
    }

    const run = buildOrchestrationRunRecord({
      repoRoot: context.repoRoot,
      config: context.config,
      planPath: planPath ?? undefined,
      planText: planPath ? readPlanFile(planPath) : '',
      outcome,
      provider: DEFAULT_GOAL_PROVIDER,
    });
    await confirmAndMaybeRunOrchestration(context, parsed, run, planPath, [], likelyPlanFiles, prompter, warnings, scan);
  } finally {
    prompter.close();
  }
}

async function chooseActiveOrchestrationRun(
  context: WorkflowContext,
  parsed: ParsedOperatorArgs,
  activeRuns: OrchestrateEntryRunSummary[],
  likelyPlanFiles: LikelyPlanFile[],
  warnings: string[] = [],
  scan?: OrchestrationRunScanDiagnostics,
): Promise<void> {
  const prompter = createOrchestratePrompter();
  try {
    process.stdout.write(`${appendOrchestrationDiagnostics(renderMultipleActiveRunsReport(activeRuns), warnings, scan)}\n`);
    const answer = (await prompter.question('> ')).trim().toLowerCase();
    if (answer === 'c' || answer === 'cancel') {
      printResult(parsed.flags, buildCancelledOrchestrationReport(context, likelyPlanFiles));
      return;
    }
    const index = Number.parseInt(answer, 10);
    if (!Number.isSafeInteger(index) || index < 1 || index > activeRuns.length) {
      throw new Error('Choose an active run number or c to cancel.');
    }
    const run = loadOrchestrationRunRecord(context.commonDir, context.config, activeRuns[index - 1].id);
    if (!run) throw new Error(`No orchestration run ledger found for ${activeRuns[index - 1].id}.`);
    printResult(parsed.flags, buildOrchestrateEntryStatusReport(context, run, activeRuns, likelyPlanFiles, warnings, scan));
  } finally {
    prompter.close();
  }
}

function buildCancelledOrchestrationReport(
  context: WorkflowContext,
  likelyPlanFiles: LikelyPlanFile[],
): OrchestrateEntryReport {
  return {
    command: 'orchestrate',
    status: 'cancelled',
    repoRoot: context.repoRoot,
    runId: null,
    ledgerPath: null,
    planPath: null,
    activeRuns: [],
    likelyPlanFiles,
    message: 'Orchestration cancelled. No changes written.',
  };
}

function canRunInteractiveOrchestrate(): boolean {
  return (process.stdin.isTTY === true && process.stdout.isTTY === true)
    || (process.env.NODE_ENV === 'test' && process.env.PIPELANE_ORCHESTRATE_INPUT !== undefined);
}

function createOrchestratePrompter(): {
  question(prompt: string): Promise<string>;
  close(): void;
} {
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_ORCHESTRATE_INPUT !== undefined) {
    const answers = process.env.PIPELANE_ORCHESTRATE_INPUT.split(/\r?\n/);
    let index = 0;
    return {
      question(prompt: string): Promise<string> {
        process.stdout.write(prompt);
        if (index >= answers.length) {
          throw new Error('PIPELANE_ORCHESTRATE_INPUT exhausted before orchestration setup completed.');
        }
        return Promise.resolve(answers[index++]);
      },
      close(): void {},
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    question(prompt: string): Promise<string> {
      return rl.question(prompt);
    },
    close(): void {
      rl.close();
    },
  };
}

function listActiveOrchestrationRuns(context: WorkflowContext, records?: OrchestrationRunRecord[]): OrchestrateEntryRunSummary[] {
  return (records ?? listOrchestrationRunRecords(context.commonDir, context.config))
    .filter((run) => isActiveOrchestrationRun(run))
    .map(summarizeEntryRun);
}

function summarizeEntryRun(run: OrchestrationRunRecord): OrchestrateEntryRunSummary {
  const completedSlices = run.slices.filter((slice) => slice.status === 'completed' || slice.worker?.status === 'succeeded').length;
  const failedSlices = run.slices.filter((slice) => slice.status === 'failed' || slice.worker?.status === 'failed').length;
  const deferredSlices = run.slices.filter((slice) => slice.deferred === true && !slice.excludedReason).length;
  return {
    id: run.id,
    status: run.status,
    updatedAt: run.updatedAt,
    title: run.plan.title,
    sliceCount: run.slices.length,
    completedSlices,
    failedSlices,
    deferredSlices,
    // Deferred slices are resumable, not pending work, so they must not inflate the
    // "pending" count on a paused run.
    pendingSlices: Math.max(0, run.slices.length - completedSlices - failedSlices - deferredSlices),
    planPath: run.source.planPath,
  };
}

function collectLikelyPlanFiles(repoRoot: string): LikelyPlanFile[] {
  const candidates = new Map<string, { score: number; reasons: Set<string> }>();
  const add = (repoPath: string, score: number, reason: string): void => {
    const normalized = normalizeRepoPath(repoPath);
    if (!normalized.endsWith('.md')) return;
    const absolute = path.join(repoRoot, normalized);
    if (!existsSync(absolute)) return;
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size > MAX_PLAN_FILE_BYTES) return;
    const current = candidates.get(normalized) ?? { score: 0, reasons: new Set<string>() };
    current.score += score;
    current.reasons.add(reason);
    const nameScore = scorePlanFileName(normalized);
    if (nameScore > 0) {
      current.score += nameScore;
      current.reasons.add('plan-like name');
    }
    candidates.set(normalized, current);
  };

  for (const changed of collectChangedMarkdownFiles(repoRoot)) {
    add(changed, 100, 'changed on this branch');
  }
  for (const scanned of scanMarkdownFiles(repoRoot)) {
    add(scanned, scanned.startsWith('docs/') ? 20 : 5, scanned.startsWith('docs/') ? 'docs file' : 'markdown file');
  }

  return [...candidates.entries()]
    .map(([repoPath, entry]) => ({
      path: repoPath,
      score: entry.score,
      reason: [...entry.reasons].join(', '),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_LIKELY_PLAN_FILES);
}

function collectChangedMarkdownFiles(repoRoot: string): string[] {
  const compareRef = runGit(repoRoot, ['rev-parse', '--verify', 'origin/HEAD'], true)?.trim() ? 'origin/HEAD' : 'HEAD';
  const mergeBase = runGit(repoRoot, ['merge-base', 'HEAD', compareRef], true)?.trim() ?? '';
  const outputs = [
    mergeBase ? runGit(repoRoot, ['diff', '--name-only', `${mergeBase}...HEAD`], true) ?? '' : '',
    runGit(repoRoot, ['diff', '--cached', '--name-only'], true) ?? '',
    runGit(repoRoot, ['diff', '--name-only'], true) ?? '',
    runGit(repoRoot, ['ls-files', '--others', '--exclude-standard'], true) ?? '',
  ];
  return uniqueRepoPaths(outputs.flatMap((output) => output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith('.md'))));
}

function scanMarkdownFiles(repoRoot: string): string[] {
  const results: string[] = [];
  const visit = (relativeDir: string): void => {
    if (results.length >= MAX_PLAN_SCAN_FILES) return;
    const absoluteDir = path.join(repoRoot, relativeDir);
    if (!existsSync(absoluteDir)) return;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (results.length >= MAX_PLAN_SCAN_FILES) return;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue;
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (relativeDir === '' && entry.name !== 'docs') continue;
        visit(relativePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) results.push(normalizeRepoPath(relativePath));
    }
  };
  visit('docs');
  visit('');
  return uniqueRepoPaths(results);
}

function uniqueRepoPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const normalized = normalizeRepoPath(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function scorePlanFileName(repoPath: string): number {
  const lower = repoPath.toLowerCase();
  let score = 0;
  if (/(^|[-_/])(plan|implementation|roadmap|migration)([-_.\/]|$)/.test(lower)) score += 40;
  if (lower.includes('orchestrat')) score += 30;
  if (lower.startsWith('docs/')) score += 10;
  return score;
}

function renderInteractiveOrchestrationSetup(likelyPlanFiles: LikelyPlanFile[]): string {
  const lines = [
    'Orchestration setup',
    '',
    'What should I implement?',
  ];
  if (likelyPlanFiles.length === 0) {
    lines.push('No likely plan files found.');
  } else {
    for (const [index, file] of likelyPlanFiles.entries()) {
      lines.push(`${index + 1}. ${file.path}`);
    }
  }
  lines.push(
    'd. A different existing plan file',
    'g. Describe the goal now',
    'c. Cancel',
  );
  return lines.join('\n');
}

function renderOrchestrationPreview(repoRoot: string, run: OrchestrationRunRecord, planPath: string | null): string {
  const lines = [
    'Pipelane orchestrate',
    '',
    'Status: preview',
    `Run: ${run.id}`,
    `Plan: ${planPath ? displayRepoPath(repoRoot, planPath) : run.source.prompt ?? '(outcome only)'}`,
    `Provider recommendation: ${summarizeProviders(run)}`,
    `Review gates: ${run.gateSnapshot.gates.length}`,
    `Slices: ${run.slices.length}`,
    '',
    'Slice preview:',
  ];
  for (const slice of run.slices) {
    const flags = [
      slice.requiresConfirmation ? 'human decision' : '',
      slice.critique.length > 0 ? 'critique' : '',
    ].filter(Boolean);
    lines.push(`- ${slice.id}: ${slice.outcome}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`);
  }
  lines.push('', `Next: run /pipelane orchestrate ${planPath ? `--plan-file ${displayRepoPath(repoRoot, planPath)}` : `--outcome "${run.plan.title}"`} --yes`);
  return lines.join('\n');
}

function renderApprovedOrchestrationReport(
  run: OrchestrationRunRecord,
  ledgerPath: string,
  planPath: string | null,
  startResult: {
    status: OrchestrateStartReport['status'];
    startedCount: number;
    restartedCount: number;
    existingCount: number;
    failedCount: number;
    blockedCount: number;
    slices: StartedSliceReport[];
  },
  reviewResult: ReviewCompletedSlicesResult | null,
  autoFixResult: ReviewAutoFixResult | null,
): string {
  const lines = [
    'Pipelane orchestrate',
    '',
    `Status: ${approvedOrchestrationEntryStatus(startResult.status, reviewResult)}`,
    `Run: ${run.id}`,
    `Ledger: ${ledgerPath}`,
    `Plan: ${planPath ?? run.source.prompt ?? '(outcome only)'}`,
    `Started workers: ${startResult.startedCount}`,
    `Existing workers: ${startResult.existingCount}`,
    `Failed workers: ${startResult.failedCount}`,
    `Blocked slices: ${startResult.blockedCount}`,
    `Review status: ${reviewResult?.status ?? 'not-run'}`,
    `Reviewed slices: ${reviewResult?.reviewedCount ?? 0}`,
    `Pending review slices: ${reviewResult?.pendingCount ?? 0}`,
    `Failed review slices: ${reviewResult?.failedCount ?? 0}`,
    `Auto-fix status: ${autoFixResult?.status ?? 'not-run'}`,
    `Auto-fix attempts: ${autoFixResult?.attemptedCount ?? 0}`,
    '',
    'Slices:',
  ];
  for (const slice of run.slices) {
    lines.push(`- ${slice.id}: ${slice.status}${slice.worker ? ` worker=${slice.worker.status}` : ''} review=${slice.review?.status ?? 'none'}`);
  }
  const pendingGateLines = reviewResult?.pendingCount ? formatPendingReviewGateInstructions(run) : [];
  if (pendingGateLines.length > 0) {
    lines.push('', 'Pending gates:', ...pendingGateLines);
  }
  if (!reviewResult) {
    lines.push('', 'Next: resolve worker failures or blocked slices, then rerun /pipelane orchestrate start or /pipelane orchestrate review.');
  } else if (reviewResult.failedCount > 0) {
    if (autoFixResult?.status === 'stalled') {
      lines.push('', 'Next: auto-fix stalled (no-progress detected) — the same failure signature repeated without progress; inspect the stalled slice worktrees, take a different approach to the failing blocking gates, then rerun /pipelane orchestrate review.');
    } else if (autoFixResult?.status === 'exhausted') {
      lines.push('', 'Next: inspect exhausted auto-fix attempts, fix remaining failed blocking gates in each slice worktree, then rerun /pipelane orchestrate review.');
    } else {
      lines.push('', 'Next: fix failed blocking gates in each slice worktree, then rerun /pipelane orchestrate review.');
    }
  } else if (reviewResult.pendingCount > 0) {
    lines.push('', 'Next: complete pending AI/manual gates for each slice, then rerun or attach trusted evidence before merge/deploy automation.');
  } else if (reviewResult.blockedCount > 0 || reviewResult.status === 'blocked') {
    lines.push('', 'Next: resolve blocked slice review conditions, such as missing review gates, then rerun /pipelane orchestrate review.');
  } else {
    lines.push('', 'Next: run /pipelane status to inspect the reviewed run and continue to PR handoff.');
  }
  return lines.join('\n');
}

function renderActiveRunReport(context: WorkflowContext, run: OrchestrationRunRecord): string {
  const summary = summarizeEntryRun(run);
  const lines = [
    'Pipelane orchestrate',
    '',
    `Status: ${run.status}`,
    `Run: ${run.id}`,
    `Ledger: ${orchestrationRunPath(context.commonDir, context.config, run.id)}`,
    `Plan: ${run.source.planPath ?? run.source.prompt ?? '(outcome only)'}`,
    `Slices: ${summary.completedSlices}/${summary.sliceCount} complete, ${summary.failedSlices} failed, ${summary.pendingSlices} pending${summary.deferredSlices > 0 ? `, ${summary.deferredSlices} deferred` : ''}`,
    '',
    'Slice status:',
  ];
  const reviewOptions = { worktreeExistsCache: new Map<string, boolean>() };
  const missingWorktrees = run.slices
    .map((slice) => missingRelevantSliceWorktreeDiagnostic(slice, reviewOptions))
    .filter((diagnostic): diagnostic is NonNullable<ReturnType<typeof missingRelevantSliceWorktreeDiagnostic>> => Boolean(diagnostic));
  if (missingWorktrees.length > 0) {
    lines.push('', 'Blocked worktrees:');
    for (const diagnostic of missingWorktrees) {
      lines.push(`- ${diagnostic.sliceId}: assigned worktree is missing at ${diagnostic.worktreePath}`);
    }
  }
  for (const slice of run.slices) {
    const missing = missingWorktrees.find((diagnostic) => diagnostic.sliceId === slice.id);
    const worktree = missing ? ` worktree=missing:${missing.worktreePath}` : '';
    lines.push(`- ${slice.id}: ${slice.status}${slice.worker ? ` worker=${slice.worker.status}` : ''} review=${slice.review?.status ?? 'none'}${worktree}`);
  }
  if (missingWorktrees.length > 0) {
    lines.push(
      '',
      'Recovery:',
      '- Restore the missing assigned worktree path, or manually repair/move aside the stale ledger/task-lock assignment before retrying prepare.',
      '- Use /pipelane orchestrate prepare --run-id <run-id> only for unassigned planned slices.',
      '- Use /pipelane orchestrate start --run-id <run-id> --slice-id <slice> --force only when the worktree exists and a stale worker record needs retry.',
    );
  }
  lines.push('', 'Next: run /pipelane status for the full cockpit, or use advanced orchestrate commands for recovery.');
  return lines.join('\n');
}

function renderMultipleActiveRunsReport(activeRuns: OrchestrateEntryRunSummary[]): string {
  const lines = [
    'Pipelane orchestrate',
    '',
    'Multiple active orchestration runs:',
  ];
  for (const [index, run] of activeRuns.entries()) {
    lines.push(`${index + 1}. ${run.id} [${run.status}] ${run.title} (${run.completedSlices}/${run.sliceCount} complete)`);
  }
  lines.push('', 'Choose a run number, or use /pipelane orchestrate --run-id <id>.');
  return lines.join('\n');
}

function summarizeProviders(run: OrchestrationRunRecord): string {
  const counts = new Map<GoalProvider, number>();
  for (const slice of run.slices) counts.set(slice.provider, (counts.get(slice.provider) ?? 0) + 1);
  return [...counts.entries()].map(([provider, count]) => `${provider} x${count}`).join(', ');
}

function displayRepoPath(repoRoot: string, absolutePath: string): string {
  const relative = normalizeRepoPath(path.relative(repoRoot, absolutePath));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolutePath;
}

function normalizeRepoPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
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

function handleOrchestrationReview(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const runId = parsed.flags.orchestrationRunId.trim();
  const sliceId = parsed.flags.goalSliceId.trim() || null;
  const phaseFilter = parsed.flags.reviewPhase.trim() as ReviewGatePhase | '';
  const gateFilter = parsed.flags.reviewGate.trim();
  const run = loadOrchestrationRunRecord(context.commonDir, context.config, runId);
  if (!run) {
    throw new Error(`No orchestration run ledger found for ${runId}.`);
  }

  const result = reviewCompletedSlices(context, run, {
    sliceId,
    dryRun: parsed.flags.reviewDryRun,
    gateFilter,
    phaseFilter,
    requireGates: true,
  });
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const report: OrchestrateReviewReport = {
    command: 'orchestrate review',
    status: result.status,
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    sliceId,
    dryRun: parsed.flags.reviewDryRun,
    gateFilter: gateFilter || null,
    phaseFilter: phaseFilter || null,
    reviewedCount: result.reviewedCount,
    failedCount: result.failedCount,
    pendingCount: result.pendingCount,
    blockedCount: result.blockedCount,
    slices: result.slices,
    run,
    message: renderOrchestrationReviewReport(run, ledgerPath, sliceId, result, {
      dryRun: parsed.flags.reviewDryRun,
      gateFilter,
      phaseFilter,
    }),
  };

  printResult(parsed.flags, report);

  if (result.status === 'failed') {
    process.exitCode = 1;
  }
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
  const preparedSlices = selectActiveSlices(run)
    .filter((slice) => {
      if (slice.status === 'planned') {
        throw new Error(`Slice ${slice.id} must be prepared before dispatch; current status is ${slice.status}.`);
      }
      // Resume: active slices already completed/failed/running in a prior pass are
      // past dispatch and skipped (start re-skips succeeded workers).
      return slice.status === 'prepared' || slice.status === 'dispatched';
    })
    .map((slice): DispatchSlicePreparation => {
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
  onSliceSettled?: (run: OrchestrationRunRecord, slice: OrchestrationSliceRecord) => void,
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
      // B1 (B-3 recovery): an `empty` slice (succeeded worker, no material change)
      // is NOT done — it is recoverable so `start --force` re-runs it, clearing the
      // strand instead of skipping it as an existing/completed worker.
      const recoverableExistingWorker = existingWorker?.status === 'running' || existingWorker?.status === 'failed' || slice.status === 'empty';
      if (
        existingWorker
        && (
          (existingWorker.status === 'succeeded' && slice.status !== 'empty')
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
      slice.status = worker.status === 'succeeded'
        ? (sliceProducedMaterialChange(context, slice) ? 'completed' : 'empty')
        : 'failed';
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
      onSliceSettled?.(run, slice);
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

function reviewCompletedSlices(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  options: {
    sliceId: string | null;
    dryRun: boolean;
    gateFilter: string;
    phaseFilter: ReviewGatePhase | '';
    requireGates: boolean;
  },
): ReviewCompletedSlicesResult {
  const selectedSlices = resolveReviewSlices(run, options.sliceId);
  const reports: ReviewedSliceReport[] = [];
  let reviewedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let blockedCount = 0;

  for (const [sliceIndex, slice] of selectedSlices.entries()) {
    const blocker = reviewBlocker(context, slice);
    if (blocker) {
      writeOrchestrationReviewProgress(options, `slice ${slice.id} (${sliceIndex + 1}/${selectedSlices.length}) blocked - ${blocker}`);
      blockedCount += 1;
      reports.push(buildBlockedReviewReport(slice, blocker));
      continue;
    }

    assertPreparedWorktreeSafe(context, slice.id, slice.branchName ?? '', slice.worktreePath ?? '');
    const sliceRepoRoot = slice.worktreePath ?? context.repoRoot;
    writeOrchestrationReviewProgress(options, `reviewing slice ${slice.id} (${sliceIndex + 1}/${selectedSlices.length}) in ${sliceRepoRoot}`);
    const sliceContext = buildSliceReviewContext(context, sliceRepoRoot);
    const reviewRun = attachAttestedManualGateEvidence(sliceContext, buildReviewRunRecord({
      repoRoot: sliceRepoRoot,
      baseBranch: context.config.baseBranch,
      gates: run.gateSnapshot.gates,
      dryRun: options.dryRun,
      gateFilter: options.gateFilter,
      phaseFilter: options.phaseFilter,
      activeSurfaces: resolveSliceActiveSurfaces(context, run, slice),
      onGateStart: (gate) => {
        writeOrchestrationReviewProgress(options, `slice ${slice.id}: starting gate ${gate.id} [${gate.phase}] ${formatReviewGateProgressTarget(gate)}`);
      },
      onGateFinish: (gate) => {
        writeOrchestrationReviewProgress(options, `slice ${slice.id}: gate ${gate.gateId} ${gate.status} after ${gate.durationMs}ms - ${gate.summary}`);
      },
    }));
    const reviewRecord = buildSliceReviewRecord(context, run, slice, reviewRun);
    if (options.requireGates && reviewRun.gates.length === 0) {
      appendSliceReviewDiagnostic(slice, reviewRecord);
      slice.review = null;
      slice.status = 'blocked';
      blockedCount += 1;
      reports.push({
        id: slice.id,
        status: slice.status,
        reviewStatus: null,
        branchName: slice.branchName ?? '',
        worktreePath: slice.worktreePath ?? '',
        runId: reviewRun.id,
        gateCount: 0,
        action: 'blocked',
        blocker: 'no effective review gates configured for automatic orchestration; run /pipelane review setup, then rerun /pipelane orchestrate review',
      });
      persistOrchestrationReviewProgress(context, run);
      continue;
    }
    const independenceBlocker = sliceReviewIndependenceBlocker(slice, reviewRecord);
    if (independenceBlocker) {
      appendSliceReviewDiagnostic(slice, reviewRecord);
      slice.review = null;
      slice.status = 'blocked';
      blockedCount += 1;
      reports.push({
        id: slice.id,
        status: slice.status,
        reviewStatus: reviewRun.status,
        branchName: slice.branchName ?? '',
        worktreePath: slice.worktreePath ?? '',
        runId: reviewRun.id,
        gateCount: reviewRun.gates.length,
        action: 'blocked',
        blocker: independenceBlocker,
      });
      persistOrchestrationReviewProgress(context, run);
      continue;
    }
    if (reviewRunCoversFullGateSet(reviewRun)) {
      slice.review = reviewRecord;
      slice.reviewDiagnostics = [];
    } else {
      appendSliceReviewDiagnostic(slice, reviewRecord);
    }
    slice.status = summarizeSliceReviewStatus(slice);
    reviewedCount += 1;
    if (reviewRun.status === 'failed') failedCount += 1;
    if (reviewRun.status === 'pending') pendingCount += 1;
    reports.push({
      id: slice.id,
      status: slice.status,
      reviewStatus: reviewRun.status,
      branchName: slice.branchName ?? '',
      worktreePath: slice.worktreePath ?? '',
      runId: reviewRun.id,
      gateCount: reviewRun.gates.length,
      action: 'reviewed',
      blocker: null,
    });
    persistOrchestrationReviewProgress(context, run);
  }

  run.status = summarizeRunReviewStatus(run);
  run.updatedAt = nowIso();
  return {
    status: reportStatusForOrchestrationReview(run.status, reviewedCount, failedCount, pendingCount, blockedCount, {
      incompleteEvidence: options.dryRun || Boolean(options.gateFilter) || Boolean(options.phaseFilter),
    }),
    reviewedCount,
    failedCount,
    pendingCount,
    blockedCount,
    slices: reports,
  };
}

function writeOrchestrationReviewProgress(
  options: { dryRun: boolean },
  message: string,
): void {
  if (options.dryRun) return;
  process.stderr.write(`[pipelane] orchestrate review: ${oneLineForProgress(message)}\n`);
}

function formatReviewGateProgressTarget(gate: {
  type: ReviewGateConfig['type'];
  command?: string;
  skill?: string;
  role?: string;
  userCommands?: string[];
}): string {
  if (gate.command) return oneLineForProgress(gate.command);
  if (gate.userCommands?.[0]) return oneLineForProgress(gate.userCommands[0]);
  if (gate.skill) return oneLineForProgress(`skill:${gate.skill}`);
  if (gate.role) return oneLineForProgress(gate.role);
  return oneLineForProgress(gate.type);
}

function oneLineForProgress(value: string): string {
  const collapsed = redactOrchestrationWorkerText(value).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 240) return collapsed;
  return `${collapsed.slice(0, 237)}...`;
}

function buildSliceReviewContext(parentContext: WorkflowContext, sliceRepoRoot: string): WorkflowContext {
  return {
    ...parentContext,
    cwd: sliceRepoRoot,
    repoRoot: sliceRepoRoot,
    commonDir: resolveGitCommonDir(sliceRepoRoot),
  };
}

function resolveReviewSlices(run: OrchestrationRunRecord, sliceId: string | null): OrchestrationSliceRecord[] {
  if (!sliceId) return selectActiveSlices(run);
  const slice = run.slices.find((candidate) => candidate.id === sliceId);
  if (!slice) {
    throw new Error(`No slice ${sliceId} found in orchestration run ${run.id}.`);
  }
  return [slice];
}

function reviewBlocker(context: WorkflowContext, slice: OrchestrationSliceRecord): string | null {
  if (slice.worker?.status !== 'succeeded') return 'worker has not completed successfully';
  if (!slice.branchName || !slice.worktreePath) return 'slice is missing a prepared worktree assignment';
  if (!existsSync(slice.worktreePath)) return `assigned worktree is missing: ${slice.worktreePath}`;
  try {
    assertPreparedWorktreeSafe(context, slice.id, slice.branchName, slice.worktreePath);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function buildSliceReviewRecord(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  slice: OrchestrationSliceRecord,
  reviewRun: ReviewRunRecord,
): OrchestrationSliceReviewRecord {
  const reviewer = reviewRun.reviewer ?? resolveReviewActorIdentity();
  const runWithReviewer = reviewRun.reviewer ? reviewRun : { ...reviewRun, reviewer };
  const independence = classifyReviewEvidenceIndependence({
    worker: slice.worker?.identity ?? null,
    reviewRun: runWithReviewer,
  });
  return {
    status: reviewRun.status,
    evidencePath: orchestrationRunPath(context.commonDir, context.config, run.id),
    reviewedAt: nowIso(),
    reviewer,
    independence: independence.label,
    independenceReason: independence.reason,
    run: runWithReviewer,
  };
}

function reviewRunCoversFullGateSet(reviewRun: ReviewRunRecord): boolean {
  return reviewRun.dryRun === false && !reviewRun.gateFilter && !reviewRun.phaseFilter;
}

function attachAttestedManualGateEvidence(
  sliceContext: WorkflowContext,
  reviewRun: ReviewRunRecord,
): ReviewRunRecord {
  if (!reviewRunCoversFullGateSet(reviewRun)) return reviewRun;
  if (!resolveReviewStateKey()) return reviewRun;
  const evidenceRecords = selectMatchingAttestedManualGateEvidenceRecords(sliceContext, reviewRun);
  if (evidenceRecords.length === 0) return reviewRun;

  const passedManualGates = new Map<string, ReviewGateRunRecord>();
  for (const evidence of evidenceRecords) {
    for (const gate of evidence.gates) {
      if (!isPassedManualReviewGate(gate)) continue;
      if (!passedManualGates.has(gate.gateId)) {
        passedManualGates.set(gate.gateId, gate);
      }
    }
  }
  if (passedManualGates.size === 0) return reviewRun;

  let attached = false;
  const gates = reviewRun.gates.map((gate): ReviewGateRunRecord => {
    const passedGate = passedManualGates.get(gate.gateId);
    if (!passedGate || gate.status !== 'pending' || !manualReviewGateEvidenceMatches(gate, passedGate)) {
      return gate;
    }
    attached = true;
    return {
      ...gate,
      status: 'passed',
      attester: passedGate.attester,
      summary: passedGate.summary,
      startedAt: passedGate.startedAt,
      finishedAt: passedGate.finishedAt,
      durationMs: passedGate.durationMs,
    };
  });

  if (!attached) return reviewRun;
  return {
    ...reviewRun,
    status: summarizeReviewRunStatus(gates),
    gates,
  };
}

function selectMatchingAttestedManualGateEvidenceRecords(
  sliceContext: WorkflowContext,
  reviewRun: ReviewRunRecord,
): ReviewRunRecord[] {
  if (!reviewRun.worktreeStatusDigest || reviewRun.worktreeStatusReliable !== true) return [];
  const state = loadReviewState(sliceContext.commonDir, sliceContext.config);
  return state.records.filter((record) =>
    !record.dryRun
    && !record.gateFilter
    && !record.phaseFilter
    && record.branchName === reviewRun.branchName
    && record.sha === reviewRun.sha
    && record.worktreeStatusDigest === reviewRun.worktreeStatusDigest
    && record.worktreeStatusReliable === true
    && record.gates.some(isPassedManualReviewGate)
  );
}

function isPassedManualReviewGate(gate: ReviewGateRunRecord): boolean {
  return gate.status === 'passed' && isManualReviewGateRun(gate) && gate.attester !== undefined;
}

function manualReviewGateEvidenceMatches(expected: ReviewGateRunRecord, evidence: ReviewGateRunRecord): boolean {
  return isManualReviewGateRun(expected)
    && isManualReviewGateRun(evidence)
    && expected.gateId === evidence.gateId
    && expected.type === evidence.type
    && expected.phase === evidence.phase
    && expected.blocking === evidence.blocking
    && normalizeOptionalGateField(expected.skill) === normalizeOptionalGateField(evidence.skill)
    && normalizeOptionalGateField(expected.role) === normalizeOptionalGateField(evidence.role)
    && normalizeOptionalGateField(expected.command) === normalizeOptionalGateField(evidence.command)
    && normalizeOptionalGateList(expected.userCommands) === normalizeOptionalGateList(evidence.userCommands);
}

function isManualReviewGateRun(gate: Pick<ReviewGateRunRecord, 'type'>): boolean {
  return gate.type === 'skill' || gate.type === 'agent' || gate.type === 'approval';
}

function normalizeOptionalGateField(value: string | undefined): string {
  return value ?? '';
}

function normalizeOptionalGateList(value: string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

function summarizeReviewRunStatus(gates: ReviewGateRunRecord[]): ReviewRunRecord['status'] {
  if (gates.some((gate) => gate.blocking && gate.status === 'failed')) return 'failed';
  if (gates.some((gate) => gate.blocking && gate.status === 'pending')) return 'pending';
  return 'passed';
}

function sliceReviewIndependenceBlocker(
  slice: OrchestrationSliceRecord,
  reviewRecord: OrchestrationSliceReviewRecord,
): string | null {
  if (reviewRecord.run.status !== 'passed') return null;
  if (!reviewRunCoversFullGateSet(reviewRecord.run)) return null;
  return blockingAiReviewEvidenceBlocker({
    reviewRun: reviewRecord.run,
    worker: slice.worker?.identity ?? null,
  });
}

function appendSliceReviewDiagnostic(slice: OrchestrationSliceRecord, reviewRecord: OrchestrationSliceReviewRecord): void {
  const diagnostics = slice.reviewDiagnostics ?? [];
  diagnostics.push(reviewRecord);
  slice.reviewDiagnostics = diagnostics.slice(-ORCHESTRATION_REVIEW_DIAGNOSTIC_MAX);
}

function resolveSliceActiveSurfaces(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  slice: OrchestrationSliceRecord,
): string[] {
  const taskSlug = slice.taskSlug || buildOrchestrationTaskSlug(run.id, slice);
  const taskLock = loadTaskLock(context.commonDir, context.config, taskSlug);
  if (taskLock?.surfaces && taskLock.surfaces.length > 0) return taskLock.surfaces;
  if (context.modeState.requestedSurfaces.length > 0) return context.modeState.requestedSurfaces;
  return context.config.surfaces;
}

function buildBlockedReviewReport(slice: OrchestrationSliceRecord, blocker: string): ReviewedSliceReport {
  return {
    id: slice.id,
    status: slice.status,
    reviewStatus: slice.review?.status ?? null,
    branchName: slice.branchName ?? '',
    worktreePath: slice.worktreePath ?? '',
    runId: slice.review?.run.id ?? null,
    gateCount: slice.review?.run.gates.length ?? 0,
    action: 'blocked',
    blocker,
  };
}

function summarizeRunReviewStatus(run: OrchestrationRunRecord): OrchestrationRunRecord['status'] {
  const active = selectActiveSlices(run);
  if (active.some((slice) => slice.worker?.status === 'failed' || slice.status === 'failed' || slice.review?.run.status === 'failed')) return 'failed';
  if (active.some((slice) => slice.worker?.status === 'running' || slice.status === 'running')) return 'running';
  // B1: an `empty` slice can never be review-satisfied (the guard in
  // `sliceReviewFullySatisfied`); the explicit exclusion here mirrors
  // `summarizeRunWorkerStatus` so the completion gate is robust even if that
  // guard is ever weakened.
  if (active.length > 0 && active.every((slice) => slice.status !== 'empty' && sliceReviewFullySatisfied(slice))) {
    return hasResumableDeferredSlices(run) ? 'paused' : 'completed';
  }
  if (active.some((slice) => slice.worker?.status === 'succeeded' && !sliceReviewFullySatisfied(slice))) return 'blocked';
  if (active.some((slice) => slice.status === 'blocked')) return 'blocked';
  return run.status;
}

function summarizeSliceReviewStatus(slice: OrchestrationSliceRecord): OrchestrationSliceRecord['status'] {
  // B1: `empty` is durable through review. Review cannot "un-empty" a no-change
  // slice, and without this the empty marker would be overwritten (empty→blocked)
  // here, defeating the empty guard in `sliceReviewFullySatisfied` on the next
  // pass and letting a no-change slice reach `completed`.
  if (slice.status === 'empty') return 'empty';
  if (sliceReviewFullySatisfied(slice)) return 'completed';
  if (slice.review?.run.status === 'failed') return 'failed';
  return 'blocked';
}

function reportStatusForOrchestrationReview(
  runStatus: OrchestrationRunRecord['status'],
  reviewedCount: number,
  failedCount: number,
  pendingCount: number,
  blockedCount: number,
  options: {
    incompleteEvidence: boolean;
  },
): OrchestrateReviewReport['status'] {
  if (failedCount > 0 || runStatus === 'failed') return 'failed';
  if (pendingCount > 0) return 'pending';
  if (blockedCount > 0) return 'blocked';
  if (reviewedCount === 0) return 'noop';
  if (options.incompleteEvidence) return 'blocked';
  // A paused run (in-scope slices all reviewed, deferred remainder pending) is not
  // blocked — its in-scope review passed. Only a genuinely incomplete run is blocked.
  if (runStatus !== 'completed' && runStatus !== 'paused') return 'blocked';
  return 'passed';
}

function resolveStartSlices(run: OrchestrationRunRecord, sliceId: string | null): OrchestrationSliceRecord[] {
  if (!sliceId) return selectActiveSlices(run);
  const slice = run.slices.find((candidate) => candidate.id === sliceId);
  if (!slice) {
    throw new Error(`No slice ${sliceId} found in orchestration run ${run.id}.`);
  }
  if (slice.deferred === true) {
    throw new Error(`Slice ${sliceId} is deferred; bring it into scope before starting it.`);
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
  if (slice.status !== 'dispatched' && slice.status !== 'blocked' && !(restarting && (slice.status === 'running' || slice.status === 'failed' || slice.status === 'empty'))) {
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
    prompt: renderSliceWorkerPrompt(slice),
    providerCommand: resolveProviderCommand(slice.provider),
    restarting,
  };
}

function prepareSliceForReviewAutoFix(
  context: WorkflowContext,
  run: OrchestrationRunRecord,
  slice: OrchestrationSliceRecord,
  failedGates: ReviewGateRunRecord[],
  attempt: number,
): StartSlicePreparation {
  if (!slice.branchName || !slice.worktreePath || !slice.dispatch) {
    throw new Error(`Slice ${slice.id} is missing dispatch metadata for review auto-fix.`);
  }
  if (!existsSync(slice.worktreePath)) {
    throw new Error(`Slice ${slice.id} assigned worktree is missing: ${slice.worktreePath}`);
  }
  assertPreparedWorktreeSafe(context, slice.id, slice.branchName, slice.worktreePath);
  const runDir = path.dirname(orchestrationRunPath(context.commonDir, context.config, run.id));
  const fixRoot = path.join(runDir, 'review-fixes');
  const workerRoot = path.join(runDir, 'workers');
  mkdirSync(fixRoot, { recursive: true });
  mkdirSync(workerRoot, { recursive: true });
  const taskSlug = reviewFixTaskSlug(run.id, slice, attempt);
  const promptPath = path.join(fixRoot, `${taskSlug}.md`);
  const prompt = renderReviewAutoFixPrompt(run, slice, failedGates, attempt);
  writeFileSync(promptPath, prompt, 'utf8');
  return {
    slice,
    taskSlug,
    promptPath,
    prompt,
    providerCommand: resolveProviderCommand(slice.provider),
    restarting: true,
  };
}

function reviewFixTaskSlug(runId: string, slice: OrchestrationSliceRecord, attempt: number): string {
  const base = resolveOrchestrationTaskSlug(runId, slice);
  const suffix = `-review-fix-${attempt}`;
  const prefix = base.slice(0, Math.max(1, TASK_SLUG_MAX_LENGTH - suffix.length)).replace(/-+$/g, '') || 'slice';
  return `${prefix}${suffix}`;
}

function resolveProviderCommand(provider: GoalProvider): string {
  const providerKey = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const providerSpecific = process.env[`PIPELANE_ORCHESTRATE_${providerKey}_COMMAND`]?.trim();
  const fallback = process.env.PIPELANE_ORCHESTRATE_WORKER_COMMAND?.trim();
  const command = providerSpecific || fallback || defaultProviderCommand(provider);
  if (!command) {
    throw new Error(`orchestrate start requires PIPELANE_ORCHESTRATE_${providerKey}_COMMAND, PIPELANE_ORCHESTRATE_WORKER_COMMAND, or an installed native ${provider} adapter on PATH.`);
  }
  return command;
}

function defaultProviderCommand(provider: GoalProvider): string {
  if (provider === 'codex' && commandExists('codex')) return 'codex exec --full-auto -';
  if (provider === 'claude' && commandExists('claude')) return defaultClaudeProviderCommand();
  return '';
}

function defaultClaudeProviderCommand(): string {
  const help = commandHelp('claude');
  if (/\bdontAsk\b/.test(help)) return 'claude --print --permission-mode dontAsk';
  if (/\bbypassPermissions\b/.test(help)) return 'claude --print --permission-mode bypassPermissions';
  if (help.includes('--dangerously-skip-permissions')) return 'claude --print --dangerously-skip-permissions';
  return 'claude --print';
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NATIVE_COMMAND_PROBE_TIMEOUT_MS,
  });
  return !result.error;
}

function commandHelp(command: string): string {
  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NATIVE_COMMAND_PROBE_TIMEOUT_MS,
  });
  return `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`;
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
  // A3 (problem #10): the worker receives the prompt the preparation step chose
  // (derived worker prompt on the initial run; review-fix prompt on auto-fix),
  // NOT the raw human-handoff `.md` at promptPath. promptPath stays the durable
  // human artifact and is still recorded on the worker record below.
  const prompt = prepared.prompt;
  const workerSessionId = `orchestrate-worker:${run.id}:${slice.id}:${crypto.randomUUID()}`;
  const workerIdentity = createReviewActorIdentity({
    provider: slice.provider,
    sessionId: workerSessionId,
    source: 'PIPELANE_ORCHESTRATE_WORKER_SESSION_ID',
  });
  const runningWorker: OrchestrationSliceWorkerRecord = {
    status: 'running',
    provider: slice.provider,
    identity: workerIdentity,
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
    env: buildProviderWorkerEnv({
      run,
      slice,
      taskSlug,
      promptPath,
      logPath,
      workerSessionId,
      ledgerPath: orchestrationRunPath(context.commonDir, context.config, run.id),
    }),
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

function buildProviderWorkerEnv(options: {
  run: OrchestrationRunRecord;
  slice: OrchestrationSliceRecord;
  taskSlug: string;
  promptPath: string;
  logPath: string;
  workerSessionId: string;
  ledgerPath: string;
}): NodeJS.ProcessEnv {
  const env = scrubProviderWorkerEnv(process.env);
  return {
    ...env,
    PIPELANE_ORCHESTRATE_RUN_ID: options.run.id,
    PIPELANE_ORCHESTRATE_SLICE_ID: options.slice.id,
    PIPELANE_ORCHESTRATE_SLICE_INDEX: String(options.slice.index),
    PIPELANE_ORCHESTRATE_PROVIDER: options.slice.provider,
    PIPELANE_AGENT_PROVIDER: options.slice.provider,
    PIPELANE_AGENT_SESSION_ID: options.workerSessionId,
    PIPELANE_ORCHESTRATE_WORKER_SESSION_ID: options.workerSessionId,
    PIPELANE_ORCHESTRATE_TASK_SLUG: options.taskSlug,
    PIPELANE_ORCHESTRATE_BRANCH_NAME: options.slice.branchName ?? '',
    PIPELANE_ORCHESTRATE_WORKTREE_PATH: options.slice.worktreePath ?? '',
    PIPELANE_ORCHESTRATE_PROMPT_PATH: options.promptPath,
    PIPELANE_ORCHESTRATE_LOG_PATH: options.logPath,
    PIPELANE_ORCHESTRATE_LEDGER_PATH: options.ledgerPath,
  };
}

function scrubProviderWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  const allowlist = parseWorkerEnvAllowlist(source[WORKER_ENV_ALLOWLIST_ENV]);
  for (const key of INHERITED_AGENT_SESSION_ENV_KEYS) {
    delete env[key];
  }
  for (const key of WORKER_SECRET_ENV_KEYS) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (!allowlist.has(key) && isSensitiveWorkerEnvKey(key)) {
      delete env[key];
    }
  }
  return env;
}

function parseWorkerEnvAllowlist(raw: string | undefined): Set<string> {
  return new Set((raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)));
}

function isSensitiveWorkerEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  if ((INHERITED_AGENT_SESSION_ENV_KEYS as readonly string[]).includes(key)) return true;
  if ((WORKER_SECRET_ENV_KEYS as readonly string[]).includes(key)) return true;
  if ((WORKER_CREDENTIAL_ENV_EXACT_KEYS as readonly string[]).includes(upperKey)) return true;
  if (WORKER_CREDENTIAL_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) return true;
  if (WORKER_CREDENTIAL_ENV_PATTERN.test(key)) return true;
  const compact = upperKey.replace(/[^A-Z0-9]/g, '');
  if ([
    'TOKEN',
    'SECRET',
    'PASSWORD',
    'COOKIE',
    'APIKEY',
    'ACCESSKEY',
    'PRIVATEKEY',
    'CREDENTIAL',
    'JWT',
    'DATABASEURL',
    'DATABASEURI',
    'DBURL',
    'DBURI',
    'POSTGRESURL',
    'POSTGRESURI',
    'POSTGRESQLURL',
    'POSTGRESQLURI',
    'MYSQLURL',
    'MYSQLURI',
    'REDISURL',
    'REDISURI',
    'MONGOURL',
    'MONGOURI',
    'MONGODBURL',
    'MONGODBURI',
    'DSN',
  ].some((term) => compact.includes(term))) return true;
  return false;
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

const CREDENTIAL_FIELD_PATTERN = '(?:token|key|secret|password|pass|auth|session|cookie|jwt|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|access[_-]?key|database[_-]?(?:url|uri)|db[_-]?(?:url|uri)|postgres(?:ql)?[_-]?(?:url|uri)|mysql[_-]?(?:url|uri)|redis[_-]?(?:url|uri)|mongo(?:db)?[_-]?(?:url|uri)|dsn)';

function redactOrchestrationWorkerText(value: string): string {
  return value
    .replace(new RegExp(`([?&]${CREDENTIAL_FIELD_PATTERN}=)[^&\\s]+`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`(["'])(${CREDENTIAL_FIELD_PATTERN})\\1\\s*:\\s*("[^"]*"|'[^']*'|[^\\s,}]+)`, 'gi'), '$1$2$1: [REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH_HEADER]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|jwt|api-key|access-key)(?:[-_][a-z0-9]+)?)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2=[REDACTED]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|jwt|api-key|access-key)(?:[-_][a-z0-9]+)?)\s+("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2 [REDACTED]')
    .replace(new RegExp(`(^|[\\s{,"'])(${CREDENTIAL_FIELD_PATTERN}\\s*:\\s*)("[^"]*"|'[^']*'|[^\\s,}"'\\\\)]+)`, 'gi'), '$1$2[REDACTED]')
    .replace(new RegExp(`(^|[\\s{,"'])(${CREDENTIAL_FIELD_PATTERN}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s,}"'\\\\)]+)`, 'gi'), '$1$2[REDACTED]')
    .replace(new RegExp(`(^|\\s)(${CREDENTIAL_FIELD_PATTERN}=)("[^"]*"|'[^']*'|[^\\s]+)`, 'gi'), '$1$2[REDACTED]')
    .replace(/\b(?:postgres(?:ql)?|mysql|rediss?|mongo(?:db)?(?:\+srv)?):\/\/[^\s"'\\)]+/gi, '[REDACTED_DSN]')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|SESSION|API_KEY|ACCESS_KEY|JWT|DATABASE_URL|DATABASE_URI|DB_URL|DB_URI|POSTGRES_URL|POSTGRES_URI|POSTGRESQL_URL|POSTGRESQL_URI|MYSQL_URL|MYSQL_URI|REDIS_URL|REDIS_URI|MONGO_URL|MONGO_URI|MONGODB_URL|MONGODB_URI|DSN)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s"',})]+)/gi, '$1[REDACTED]');
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

// B1: a slice is `empty` when its worker exited 0 but produced no material
// change (committed+staged+unstaged+untracked, via the shared review detector)
// measured against the slice's base. Pre-E1a every slice branches from
// `config.baseBranch`, so that is the base here; E1a will thread the dependency
// branch in.
function sliceProducedMaterialChange(context: WorkflowContext, slice: OrchestrationSliceRecord): boolean {
  const worktree = slice.worktreePath ?? context.repoRoot;
  return collectChangedFiles(worktree, context.config.baseBranch).length > 0;
}

function dependencyBlocker(slice: OrchestrationSliceRecord, byId: Map<string, OrchestrationSliceRecord>): string | null {
  for (const dependencyId of slice.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (!dependency) return `missing dependency ${dependencyId}`;
    // B1 (#10): an `empty` dependency does not satisfy dependents even though its
    // worker.status is `succeeded`; check it before the succeeded short-circuit.
    if (dependency.status === 'empty') return `dependency ${dependencyId} produced no changes`;
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
    // B1: an `empty` dependency will not progress on its own (it needs a
    // re-dispatch), so it cannot "complete later" within this pass.
    if (dependency.status === 'empty') return false;
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
    status: slice.status === 'empty'
      ? 'empty'
      : worker.status === 'succeeded' ? 'completed' : worker.status === 'failed' ? 'failed' : 'running',
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
  const active = selectActiveSlices(run);
  if (active.some((slice) => slice.worker?.status === 'failed' || slice.status === 'failed')) return 'failed';
  // B1: an `empty` slice has worker.status === 'succeeded' but must NOT count as
  // done — the run cannot complete while any in-scope slice is empty.
  if (active.length > 0 && active.every((slice) => (slice.worker?.status === 'succeeded' || slice.status === 'completed') && slice.status !== 'empty')) {
    return hasResumableDeferredSlices(run) ? 'paused' : 'completed';
  }
  if (active.some((slice) => slice.worker?.status === 'running' || slice.status === 'running')) return 'running';
  if (active.some((slice) => slice.status === 'blocked' || slice.status === 'empty')) return 'blocked';
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

  for (const slice of selectActiveSlices(run)) {
    const taskSlug = resolveOrchestrationTaskSlug(run.id, slice);
    // Resume: a slice already completed in a prior pass is past prepare; skip it so a
    // worktree cleaned between passes does not abort the resume. Dispatch/start skip it too.
    if (slice.worker?.status === 'succeeded' || slice.status === 'completed') {
      existingCount += 1;
      reports.push({
        id: slice.id,
        status: slice.status,
        taskSlug,
        branchName: slice.branchName ?? '',
        worktreePath: slice.worktreePath ?? '',
        action: 'existing',
      });
      continue;
    }
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

function persistOrchestrationReviewProgress(context: WorkflowContext, run: OrchestrationRunRecord): void {
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
    renderSliceWorkerPrompt(slice),
    '',
    '## Required Slice Review',
    '',
    'After implementation, run `/pipelane review` in this worktree and record the output in the final handoff.',
    'Do not merge, deploy, or clean this task workspace from inside the slice worker.',
    '',
  ].join('\n');
}

function renderReviewAutoFixPrompt(
  run: OrchestrationRunRecord,
  slice: OrchestrationSliceRecord,
  failedGates: ReviewGateRunRecord[],
  attempt: number,
): string {
  const lines = [
    '# Pipelane Orchestration Review Fix',
    '',
    `Run: ${run.id}`,
    `Slice: ${slice.id}`,
    `Provider: ${slice.provider}`,
    `Branch: ${slice.branchName ?? '(unassigned)'}`,
    `Worktree: ${slice.worktreePath ?? '(unassigned)'}`,
    `Review fix attempt: ${attempt}`,
    '',
    '## Task',
    '',
    'Fix only the verified blocking review failures listed below in this slice worktree.',
    'Do not merge, deploy, clean worktrees, change unrelated files, or rerun release automation.',
    'After fixing, leave the worktree ready for Pipelane to rerun `/pipelane orchestrate review`.',
    '',
    '## Failed Review Gates',
    '',
  ];
  for (const gate of failedGates) {
    lines.push(`### ${gate.gateId}`);
    lines.push(`- Phase: ${gate.phase}`);
    lines.push(`- Type: ${gate.type}`);
    lines.push(`- Summary: ${gate.summary}`);
    if (gate.command) lines.push(`- Command: ${gate.command}`);
    if (gate.exitCode !== undefined) lines.push(`- Exit code: ${gate.exitCode ?? 'unknown'}`);
    if (gate.stdoutTail) {
      lines.push('- Stdout tail:', '', '```text', gate.stdoutTail, '```');
    }
    if (gate.stderrTail) {
      lines.push('- Stderr tail:', '', '```text', gate.stderrTail, '```');
    }
    lines.push('');
  }
  appendReviewAutoFixJournal(lines, run, slice, attempt);
  lines.push(
    '## Original Slice Goal',
    '',
    renderSliceWorkerPrompt(slice),
    '',
  );
  return lines.join('\n');
}

// B2 (#15): the fed-forward attempt journal. Reuses this run's existing
// `reviewFixes` records (no new memory store) to show what prior attempts tried
// and how the re-review responded, so attempt N+1 must form a hypothesis the
// journal does not already rule out.
function appendReviewAutoFixJournal(
  lines: string[],
  run: OrchestrationRunRecord,
  slice: OrchestrationSliceRecord,
  attempt: number,
): void {
  const priorAttempts = (run.reviewFixes ?? [])
    .filter((record) => record.sliceId === slice.id && record.attempt < attempt)
    .sort((a, b) => a.attempt - b.attempt);
  if (priorAttempts.length === 0) return;
  lines.push(
    '## Prior Fix Attempts (form a new hypothesis — do not repeat what already failed)',
    '',
  );
  for (const record of priorAttempts) {
    const tried = record.failedGateIds.length > 0
      ? `targeted gate(s) ${record.failedGateIds.join(', ')}`
      : 'targeted the failing gate(s)';
    lines.push(`### Attempt ${record.attempt}`);
    lines.push(`- Tried: ${tried} (worker ${record.workerStatus})`);
    lines.push(`- Result: ${formatReviewFixResult(record.reviewStatus)}`);
    if (record.lesson) lines.push(`- Lesson: ${record.lesson}`);
    lines.push('');
  }
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

  const slicesFile = parseSlicesFile(parsed.flags.goalSlicesFile, cwd);
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
    slices: slicesFile?.slices,
    coverage: slicesFile?.coverage,
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

interface OrchestrateScopeReport {
  command: 'orchestrate scope';
  status: 'scoped';
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  throughSliceId: string;
  activeCount: number;
  deferredCount: number;
  run: OrchestrationRunRecord;
  message: string;
}

interface OrchestrateFinalizeReport {
  command: 'orchestrate finalize';
  status: OrchestrationRunRecord['status'];
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  excludedCount: number;
  run: OrchestrationRunRecord;
  message: string;
}

interface OrchestrateOutlineSliceSnapshot {
  id: string;
  index: number;
  phase: string | null;
  state: string;
  glyph: string;
  deferred: boolean;
  excluded: boolean;
  reviewSatisfied: boolean;
  sensitive: boolean;
}

interface OrchestrateOutlineReport {
  command: 'orchestrate outline';
  status: OrchestrationRunRecord['status'];
  repoRoot: string;
  runId: string;
  title: string;
  total: number;
  done: number;
  deferred: number;
  excluded: number;
  phaseCount: number;
  slices: OrchestrateOutlineSliceSnapshot[];
  run: OrchestrationRunRecord;
  message: string;
}

function handleScope(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const runId = parsed.flags.orchestrationRunId.trim();
  const through = parsed.flags.scopeThrough.trim();
  const run = loadOrchestrationRunRecord(context.commonDir, context.config, runId);
  if (!run) {
    throw new Error(`No orchestration run ledger found for ${runId}.`);
  }
  const targetIndex = run.slices.findIndex((slice) => slice.id === through);
  if (targetIndex < 0) {
    throw new Error(`No slice ${through} found in orchestration run ${runId}.`);
  }
  // Resume extends scope forward freely, but deferring a slice whose worker
  // already started would orphan in-flight or finished work.
  if (run.slices.some((slice, index) => index > targetIndex && slice.worker)) {
    throw new Error(`orchestrate scope cannot defer a slice in ${runId} whose worker has already started.`);
  }
  let activeCount = 0;
  let deferredCount = 0;
  run.slices.forEach((slice, index) => {
    if (index <= targetIndex) {
      slice.deferred = false;
      activeCount += 1;
    } else {
      slice.deferred = true;
      deferredCount += 1;
    }
  });
  run.status = summarizeScopeRunStatus(run);
  run.updatedAt = nowIso();
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const report: OrchestrateScopeReport = {
    command: 'orchestrate scope',
    status: 'scoped',
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    throughSliceId: through,
    activeCount,
    deferredCount,
    run,
    message: [
      'Pipelane orchestrate scope',
      '',
      `Run: ${run.id}`,
      `Through: ${through}`,
      `In scope: ${activeCount} slice(s)`,
      `Deferred: ${deferredCount} slice(s)`,
      '',
      renderOrchestrationOutline(run),
    ].join('\n'),
  };
  printResult(parsed.flags, report);
}

function handleFinalize(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const runId = parsed.flags.orchestrationRunId.trim();
  const run = loadOrchestrationRunRecord(context.commonDir, context.config, runId);
  if (!run) {
    throw new Error(`No orchestration run ledger found for ${runId}.`);
  }
  const at = nowIso();
  let excludedCount = 0;
  for (const slice of run.slices) {
    if (slice.deferred === true && !slice.excludedReason) {
      slice.excludedReason = 'abandoned via orchestrate finalize';
      slice.excludedAt = at;
      excludedCount += 1;
    }
  }
  run.status = summarizeRunReviewStatus(run);
  run.updatedAt = at;
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const report: OrchestrateFinalizeReport = {
    command: 'orchestrate finalize',
    status: run.status,
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    excludedCount,
    run,
    message: [
      'Pipelane orchestrate finalize',
      '',
      `Run: ${run.id}`,
      `Status: ${run.status}`,
      `Excluded (abandoned) slices: ${excludedCount}`,
      'The excluded slices are kept in the ledger with a reason and timestamp for audit.',
      '',
      renderOrchestrationOutline(run),
    ].join('\n'),
  };
  printResult(parsed.flags, report);
}

function handleOutline(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const runId = parsed.flags.orchestrationRunId.trim();
  const run = loadOrchestrationRunRecord(context.commonDir, context.config, runId);
  if (!run) {
    throw new Error(`No orchestration run ledger found for ${runId}.`);
  }
  const snapshot = buildOrchestrationOutlineSnapshot(run);
  const report: OrchestrateOutlineReport = {
    command: 'orchestrate outline',
    status: run.status,
    repoRoot: context.repoRoot,
    runId: run.id,
    title: run.plan.title,
    ...snapshot,
    run,
    message: renderOrchestrationOutline(run),
  };
  printResult(parsed.flags, report);
}

function summarizeScopeRunStatus(run: OrchestrationRunRecord): OrchestrationRunRecord['status'] {
  const active = selectActiveSlices(run);
  if (active.some((slice) => slice.status === 'planned')) return 'planned';
  if (active.some((slice) => slice.status === 'prepared')) return 'prepared';
  if (active.some((slice) => slice.status === 'dispatched')) return 'dispatched';
  return summarizeRunWorkerStatus(run);
}

function groupSlicesByPhase(
  slices: OrchestrationSliceRecord[],
): Array<{ name: string | null; slices: OrchestrationSliceRecord[] }> {
  const groups: Array<{ name: string | null; slices: OrchestrationSliceRecord[] }> = [];
  for (const slice of slices) {
    const name = slice.phase ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.slices.push(slice);
    else groups.push({ name, slices: [slice] });
  }
  return groups;
}

function sliceOutlineState(slice: OrchestrationSliceRecord): { glyph: string; label: string; state: string; done: boolean } {
  if (slice.excludedReason) return { glyph: '◻', label: `excluded (${slice.excludedReason})`, state: 'excluded', done: false };
  if (slice.deferred === true) return { glyph: '◻', label: 'deferred (resume later)', state: 'deferred', done: false };
  if (slice.worker?.status === 'failed' || slice.status === 'failed') return { glyph: '✗', label: 'failed', state: 'failed', done: false };
  if (slice.review?.run.status === 'failed') return { glyph: '✗', label: 'review failed', state: 'review-failed', done: false };
  if (slice.worker?.status === 'running' || slice.status === 'running') return { glyph: '▸', label: 'running', state: 'running', done: false };
  if (slice.status === 'blocked') return { glyph: '⚠', label: 'blocked', state: 'blocked', done: false };
  // B1: an `empty` slice has a succeeded worker but produced no change — it is not
  // done; it needs re-dispatch (sharper goal) or defer. Check before the
  // succeeded/done branch so the glyph does not contradict the cockpit.
  if (slice.status === 'empty') return { glyph: '⚠', label: 'empty (no changes — re-dispatch or defer)', state: 'empty', done: false };
  if (slice.worker?.status === 'succeeded' || slice.status === 'completed') {
    const reviewed = sliceReviewFullySatisfied(slice);
    return { glyph: '✓', label: reviewed ? 'done · review ✓' : 'done · review pending', state: reviewed ? 'done' : 'awaiting-review', done: true };
  }
  return { glyph: '◻', label: 'queued', state: 'queued', done: false };
}

function buildOrchestrationOutlineSnapshot(run: OrchestrationRunRecord): {
  total: number;
  done: number;
  deferred: number;
  excluded: number;
  phaseCount: number;
  slices: OrchestrateOutlineSliceSnapshot[];
} {
  const phases = groupSlicesByPhase(run.slices);
  const active = selectActiveSlices(run);
  const slices = run.slices.map((slice): OrchestrateOutlineSliceSnapshot => {
    const state = sliceOutlineState(slice);
    return {
      id: slice.id,
      index: slice.index,
      phase: slice.phase ?? null,
      state: state.state,
      glyph: state.glyph,
      deferred: slice.deferred === true && !slice.excludedReason,
      excluded: Boolean(slice.excludedReason),
      reviewSatisfied: sliceReviewFullySatisfied(slice),
      sensitive: slice.requiresConfirmation,
    };
  });
  return {
    total: run.slices.length,
    done: active.filter((slice) => sliceOutlineState(slice).done).length,
    deferred: run.slices.filter((slice) => slice.deferred === true && !slice.excludedReason).length,
    excluded: run.slices.filter((slice) => Boolean(slice.excludedReason)).length,
    phaseCount: phases.filter((phase) => phase.name).length,
    slices,
  };
}

function renderSliceHeadline(run: OrchestrationRunRecord, slice: OrchestrationSliceRecord): string {
  const state = sliceOutlineState(slice);
  return `${state.glyph} slice ${slice.index}/${run.slices.length} · ${slice.id} — ${state.label}`;
}

// PR1 terminal output spec: full phase -> slice -> status outline. Deterministic
// and typed so the agent (and `--yes`) relay identical output across hosts.
function renderOrchestrationOutline(run: OrchestrationRunRecord): string {
  const snapshot = buildOrchestrationOutlineSnapshot(run);
  const active = selectActiveSlices(run);
  const phases = groupSlicesByPhase(run.slices);
  const lines: string[] = [];
  const phasePrefix = snapshot.phaseCount > 1 ? `${snapshot.phaseCount} phases, ` : '';
  lines.push(`Plan — ${phasePrefix}${snapshot.total} slice${snapshot.total === 1 ? '' : 's'}`);
  const progress = [`${snapshot.done}/${active.length} done`];
  if (snapshot.deferred > 0) progress.push(`${snapshot.deferred} deferred`);
  if (snapshot.excluded > 0) progress.push(`${snapshot.excluded} excluded`);
  progress.push(`status ${run.status}`);
  lines.push(`Progress: ${progress.join(' · ')}`);
  lines.push('');
  for (const phase of phases) {
    if (phase.name) lines.push(`  Phase · ${sanitizeForTerminal(phase.name)}`);
    for (const slice of phase.slices) {
      const state = sliceOutlineState(slice);
      const sensitive = slice.requiresConfirmation ? '  ⚠ sensitive' : '';
      lines.push(`    ${state.glyph} ${slice.index}. ${sanitizeForTerminal(slice.id)} — ${state.label}${sensitive}`);
    }
  }

  // Edge states (pinned, not improvised).
  if (snapshot.total === 1 && !run.slices[0]?.phase) {
    lines.push('', 'Heads up: single slice (no phase split). Consider adding structure to the plan.');
  }
  if (active.length === 0 || active.every((slice) => Boolean(slice.excludedReason))) {
    lines.push('', 'No implementation work in scope.');
  }
  const failed = active.find((slice) => {
    const state = sliceOutlineState(slice).state;
    return state === 'failed' || state === 'review-failed';
  });
  if (failed) {
    lines.push('', `Stopped at ${sanitizeForTerminal(failed.id)}. Fix in ${sanitizeForTerminal(failed.worktreePath ?? '<worktree>')}, then /pipelane orchestrate resumes here.`);
  } else if (snapshot.deferred > 0 && active.length > 0 && snapshot.done >= active.length) {
    lines.push('', `Paused — ${snapshot.deferred} slice(s) deferred. Resume with /pipelane orchestrate.`);
  }
  return lines.join('\n');
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

// The agent's proposed decomposition. It is agent OUTPUT, not the audit source,
// so it may live outside the repo and is intentionally NOT routed through
// resolvePlanPath's in-repo containment check. The ledger still binds its source
// to the real --plan-file.
function parseSlicesFile(
  rawPath: string,
  baseDir: string,
): { slices: BuildOrchestrationSliceInput[]; coverage?: OrchestrationCoverageEntry[] } | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
  if (!existsSync(resolved)) {
    throw new Error(`--slices-file not found: ${trimmed}`);
  }
  const stat = statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`--slices-file must point to a regular file: ${trimmed}`);
  }
  if (stat.size > MAX_PLAN_FILE_BYTES) {
    throw new Error(`--slices-file is too large: ${stat.size} bytes, max ${MAX_PLAN_FILE_BYTES}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`--slices-file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--slices-file must be a JSON object with a "slices" array.');
  }
  const rawSlices = (parsed as { slices?: unknown }).slices;
  if (!Array.isArray(rawSlices) || rawSlices.length === 0) {
    throw new Error('--slices-file "slices" must be a non-empty array.');
  }
  const slices = rawSlices.map((entry, index) => parseSliceEntry(entry, index));
  const coverage = parseCoverageEntries((parsed as { coverage?: unknown }).coverage);
  return coverage ? { slices, coverage } : { slices };
}

function parseSliceEntry(entry: unknown, index: number): BuildOrchestrationSliceInput {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`--slices-file slice ${index + 1} must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) {
    throw new Error(`--slices-file slice ${index + 1} requires a non-empty "title".`);
  }
  const result: BuildOrchestrationSliceInput = { title };
  if (record.id !== undefined) {
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(id)) {
      throw new Error(`--slices-file slice ${index + 1} has an unsafe "id".`);
    }
    result.id = id;
  }
  if (record.phase !== undefined) {
    if (typeof record.phase !== 'string') {
      throw new Error(`--slices-file slice ${index + 1} "phase" must be a string.`);
    }
    const phase = record.phase.trim();
    if (phase) result.phase = phase;
  }
  if (record.text !== undefined) {
    if (typeof record.text !== 'string') {
      throw new Error(`--slices-file slice ${index + 1} "text" must be a string.`);
    }
    result.text = record.text;
  }
  return result;
}

function parseCoverageEntries(raw: unknown): OrchestrationCoverageEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('--slices-file "coverage" must be an array.');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`--slices-file coverage ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const section = typeof record.section === 'string' ? record.section.trim() : '';
    if (!section) {
      throw new Error(`--slices-file coverage ${index + 1} requires a non-empty "section".`);
    }
    const disposition = record.disposition;
    if (disposition !== 'slice' && disposition !== 'deferred' && disposition !== 'excluded') {
      throw new Error(`--slices-file coverage ${index + 1} "disposition" must be slice|deferred|excluded.`);
    }
    const out: OrchestrationCoverageEntry = { section, disposition };
    if (typeof record.sliceId === 'string' && record.sliceId.trim()) out.sliceId = record.sliceId.trim();
    if (typeof record.reason === 'string' && record.reason.trim()) out.reason = record.reason.trim();
    return out;
  });
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

function renderOrchestrationReviewReport(
  run: OrchestrationRunRecord,
  ledgerPath: string,
  sliceId: string | null,
  result: {
    status: OrchestrateReviewReport['status'];
    reviewedCount: number;
    failedCount: number;
    pendingCount: number;
    blockedCount: number;
    slices: ReviewedSliceReport[];
  },
  options: {
    dryRun: boolean;
    gateFilter: string;
    phaseFilter: ReviewGatePhase | '';
  },
): string {
  const lines = [
    'Pipelane orchestrate review',
    '',
    `Status: ${result.status}`,
    `Run: ${run.id}`,
    `Ledger: ${ledgerPath}`,
    `Slice filter: ${sliceId ?? '(all slices)'}`,
    `Gate filter: ${options.gateFilter || '(none)'}`,
    `Phase filter: ${options.phaseFilter || '(none)'}`,
    `Dry run: ${options.dryRun ? 'yes' : 'no'}`,
    `Reviewed slices: ${result.reviewedCount}`,
    `Pending slices: ${result.pendingCount}`,
    `Failed slices: ${result.failedCount}`,
    `Blocked slices: ${result.blockedCount}`,
    `Run status: ${run.status}`,
    '',
    'Slice review evidence:',
  ];
  const pendingGateLines = formatPendingReviewGateInstructions(run);

  if (result.slices.length === 0) {
    lines.push('- none');
  } else {
    for (const slice of result.slices) {
      if (slice.action === 'blocked') {
        lines.push(`- ${slice.id}: blocked - ${slice.blocker}`);
      } else {
        lines.push(`- ${slice.id}: ${slice.reviewStatus ?? 'unknown'} ${slice.runId ?? ''} (${slice.gateCount} gates)`);
      }
    }
  }

  if (pendingGateLines.length > 0) {
    lines.push('', 'Pending gates:', ...pendingGateLines);
  }

  if (sliceId || options.dryRun || options.gateFilter || options.phaseFilter) {
    lines.push(
      '',
      'Slice-filtered, gate-filtered, phase-filtered, or dry-run review evidence is recorded for diagnosis, but every slice needs a full non-dry-run review before merge/deploy automation can trust the orchestration run.',
    );
  }

  if (result.failedCount > 0) {
    lines.push('', 'Next: fix failed blocking gates in the slice worktree, then rerun /pipelane orchestrate review.');
  } else if (result.pendingCount > 0) {
    lines.push('', 'Next: complete pending AI/manual gates for each slice, then rerun or attach trusted evidence before merge/deploy automation.');
  } else if (result.blockedCount > 0 && result.slices.some(isBlockedReviewEvidenceReport)) {
    lines.push('', 'Next: record independent attested AI/manual gate evidence for blocked slices, then rerun /pipelane orchestrate review.');
  } else if (result.blockedCount > 0) {
    lines.push('', 'Next: finish or recover blocked workers, then rerun /pipelane orchestrate review.');
  } else if (result.status === 'blocked') {
    lines.push('', 'Next: complete and review the remaining slices, then rerun /pipelane orchestrate review without filters.');
  } else {
    lines.push('', 'Review gate execution complete. Merge, deploy, and cleanup were not run by this command.');
  }

  return lines.join('\n');
}

function formatPendingReviewGateInstructions(run: OrchestrationRunRecord): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const slice of run.slices) {
    const review = latestSliceReviewRecord(slice);
    if (!review) continue;

    for (const gate of review.run.gates) {
      if (gate.status !== 'pending') continue;
      const key = `${slice.id}:${review.run.id}:${gate.gateId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const worktree = slice.worktreePath ? ` (worktree: ${slice.worktreePath})` : '';
      lines.push(`- ${slice.id}/${gate.gateId}: ${formatPendingReviewGateAction(gate)}${worktree}`);
    }
  }

  return lines;
}

function latestSliceReviewRecord(slice: OrchestrationSliceRecord): OrchestrationSliceReviewRecord | null {
  const records = [
    ...(slice.review ? [slice.review] : []),
    ...(slice.reviewDiagnostics ?? []),
  ];
  return records.reduce<OrchestrationSliceReviewRecord | null>((latest, record) =>
    latest === null || record.reviewedAt > latest.reviewedAt ? record : latest
  , null);
}

function formatPendingReviewGateAction(gate: ReviewGateRunRecord): string {
  const summary = oneLineForProgress(gate.summary || 'pending review gate');
  const target = formatReviewGateProgressTarget(gate);
  if (!target || summary.includes(target)) return summary;
  return `${summary}; ${target}`;
}

function isBlockedReviewEvidenceReport(slice: ReviewedSliceReport): boolean {
  return slice.action === 'blocked' && slice.reviewStatus === 'passed';
}
