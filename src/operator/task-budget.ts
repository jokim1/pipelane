import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildDestinationPlanForCommand,
  canonicalizeDestinationFingerprint,
  type DestinationPlan,
} from './destination-planner.ts';
import {
  ensureTaskBindingId,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadTaskBudgetState,
  normalizePath,
  normalizeRouteSafetyConfig,
  normalizeTaskBudgetConfig,
  nowIso,
  resolveWorkflowContext,
  runGit,
  saveTaskBudgetState,
  sizeTaskBudget,
  taskBudgetStatePath,
  withTaskBudgetStateLock,
  type ParsedOperatorArgs,
  type ReviewRunRecord,
  type ReviewGateRunRecord,
  type TaskBudgetRecord,
  type TaskBudgetState,
  type WorkflowContext,
} from './state.ts';
import {
  appendReviewCompletionRecord,
  markReviewCompletionApplied,
  migrateCompletionJournalLineage,
  pruneAppliedCompletionJournal,
  readUnappliedCompletionRecords,
  withTaskCompletionLock,
  type ReviewCompletionDebits,
  type ReviewCompletionRecord,
} from './completion-journal.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';

// ---------------------------------------------------------------------------
// Task budgets are an advisory stop-loss. The ledger records what each task
// lineage has spent (AI run launches and active execution minutes) and how
// big the sized budget was, and surfaces a "round N, ~cost so far" line after
// each review run. Nothing here pauses, parks, or gates a flow.
// ---------------------------------------------------------------------------

const TASK_BUDGET_LINEAGE_SERIALIZATION_VERSION = 2;

interface TaskBudgetIdentity {
  lineageKey: string;
  lineageFingerprint: string;
  attemptDigest: string;
  attemptFingerprint: string;
  worktreeStatusDigest: string;
  targetCommand: string;
  taskSlug: string;
  taskBindingId: string;
  branchName: string;
  headSha: string;
}

// ---------------------------------------------------------------------------
// Lineage identity: taskSlug + branchName, falling back to branch alone.
// Explicitly NOT the destination-plan fingerprint and NOT the task binding
// id: PR-opening, rebinding, fingerprint churn, worktree moves, and
// state-root divergence do not mint fresh budgets. The binding id is
// recorded for audit only.
// ---------------------------------------------------------------------------

function taskBudgetLineage(context: WorkflowContext, taskSlug: string, branchName: string): { lineageKey: string; lineageFingerprint: string } {
  const lineageFingerprint = canonicalizeDestinationFingerprint({
    serializationVersion: TASK_BUDGET_LINEAGE_SERIALIZATION_VERSION,
    projectKey: context.config.projectKey,
    taskSlug,
    branchName,
  });
  return {
    lineageKey: createHash('sha256').update(lineageFingerprint).digest('hex'),
    lineageFingerprint,
  };
}

function resolveTaskSlugForBranch(context: WorkflowContext, requestedTaskSlug: string, branchName: string): { taskSlug: string; taskBindingId: string } {
  if (requestedTaskSlug) {
    const lock = ensureTaskBindingId(context.commonDir, context.config, requestedTaskSlug);
    if (lock) return { taskSlug: lock.taskSlug, taskBindingId: lock.taskBindingId ?? '' };
  }
  const locks = loadAllTaskLocks(context.commonDir, context.config);
  const worktreeMatches = locks.filter((lock) =>
    lock.branchName === branchName && normalizePath(lock.worktreePath) === normalizePath(context.repoRoot));
  const branchMatches = locks.filter((lock) => lock.branchName === branchName);
  // Prefer the exact worktree lock; fall back to a unique branch match so a
  // moved worktree or a lock created under the other state root still
  // resolves the slug instead of forking the lineage.
  const chosen = worktreeMatches[0] ?? (branchMatches.length === 1 ? branchMatches[0] : undefined);
  if (chosen) {
    const lock = ensureTaskBindingId(context.commonDir, context.config, chosen.taskSlug);
    if (lock) return { taskSlug: lock.taskSlug, taskBindingId: lock.taskBindingId ?? '' };
    return { taskSlug: chosen.taskSlug, taskBindingId: chosen.taskBindingId ?? '' };
  }
  return { taskSlug: requestedTaskSlug, taskBindingId: '' };
}

function budgetIdentityForPlan(context: WorkflowContext, plan: DestinationPlan): TaskBudgetIdentity {
  const fp = plan.fingerprintInputs as { headSha?: unknown };
  const branchName = typeof (plan.fingerprintInputs as { branchName?: unknown }).branchName === 'string'
    ? String((plan.fingerprintInputs as { branchName?: unknown }).branchName)
    : '';
  const binding = resolveTaskSlugForBranch(context, plan.taskSlug, branchName);
  const attemptFingerprint = canonicalizeDestinationFingerprint(plan.fingerprintInputs);
  const lineage = taskBudgetLineage(context, binding.taskSlug, branchName);
  return {
    ...lineage,
    attemptDigest: createHash('sha256').update(attemptFingerprint).digest('hex'),
    attemptFingerprint,
    worktreeStatusDigest: typeof plan.fingerprintInputs.worktreeStatusDigest === 'string'
      ? plan.fingerprintInputs.worktreeStatusDigest
      : '',
    targetCommand: plan.targetCommand,
    taskSlug: binding.taskSlug,
    taskBindingId: binding.taskBindingId,
    branchName,
    headSha: typeof fp.headSha === 'string' ? fp.headSha : '',
  };
}

function budgetIdentityForCurrentReview(context: WorkflowContext): TaskBudgetIdentity {
  const status = readWorktreeStatusSnapshot(context.repoRoot, { includeStatusDigest: true });
  const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const fingerprintInput = {
    kind: 'review',
    projectKey: context.config.projectKey,
    branchName,
    headSha: status.head,
    worktreeStatusDigest: status.statusDigest,
    reviewGates: context.config.reviewGates?.gates ?? [],
  };
  const fingerprint = canonicalizeDestinationFingerprint(fingerprintInput);
  const binding = resolveTaskSlugForBranch(context, '', branchName);
  const lineage = taskBudgetLineage(context, binding.taskSlug, branchName);
  return {
    ...lineage,
    attemptDigest: createHash('sha256').update(fingerprint).digest('hex'),
    attemptFingerprint: fingerprint,
    worktreeStatusDigest: status.statusDigest,
    targetCommand: formatWorkflowCommand(context.config, 'pr'),
    taskSlug: binding.taskSlug,
    taskBindingId: binding.taskBindingId,
    branchName,
    headSha: status.head,
  };
}

function budgetIdentityForCurrentCheckout(context: WorkflowContext): { lineageKey: string; taskSlug: string; branchName: string; taskBindingId: string } {
  const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const binding = resolveTaskSlugForBranch(context, '', branchName);
  return { ...taskBudgetLineage(context, binding.taskSlug, branchName), taskSlug: binding.taskSlug, branchName, taskBindingId: binding.taskBindingId };
}

// ---------------------------------------------------------------------------
// Entry lifecycle: ensure/transfer + sizing.
// ---------------------------------------------------------------------------

function shortstatChangedLines(raw: string | null | undefined): number {
  if (!raw) return 0;
  const insertions = /(\d+) insertion/.exec(raw)?.[1] ?? '0';
  const deletions = /(\d+) deletion/.exec(raw)?.[1] ?? '0';
  return Number.parseInt(insertions, 10) + Number.parseInt(deletions, 10);
}

function estimateChangedLines(context: WorkflowContext): number {
  const base = context.config.baseBranch;
  if (!base) return 0;
  // Review runs BEFORE the PR commit, so budget sizing must include the
  // uncommitted work being reviewed, not just merge-base...HEAD. Committed
  // range (three-dot) and the worktree diff vs HEAD are disjoint, so summing
  // them never double-counts; untracked additions are added on top. Sizing
  // against the full reviewed material keeps a large dirty change from
  // getting the minimum budget.
  const committed = shortstatChangedLines(
    runGit(context.repoRoot, ['diff', '--shortstat', `${base}...HEAD`], true)
    ?? runGit(context.repoRoot, ['diff', '--shortstat', `origin/${base}...HEAD`], true),
  );
  const worktree = shortstatChangedLines(runGit(context.repoRoot, ['diff', '--shortstat', 'HEAD'], true));
  // `git diff HEAD` covers tracked (staged + unstaged) changes but not
  // untracked files; add each untracked file's line count so a big new file
  // under review is sized in too. Bounded to keep pathological trees cheap.
  const untrackedFiles = (runGit(context.repoRoot, ['ls-files', '--others', '--exclude-standard'], true) ?? '')
    .split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 500);
  let untrackedLines = 0;
  for (const file of untrackedFiles) {
    untrackedLines += shortstatChangedLines(runGit(context.repoRoot, ['diff', '--shortstat', '--no-index', '--', '/dev/null', file], true));
  }
  return committed + worktree + untrackedLines;
}

function recordObservedBinding(record: TaskBudgetRecord, taskBindingId: string): void {
  if (!taskBindingId) return;
  const ids = new Set(record.observedTaskBindingIds ?? []);
  if (ids.has(taskBindingId)) return;
  ids.add(taskBindingId);
  record.observedTaskBindingIds = [...ids].slice(0, 20);
}

function ensureTaskBudgetRecord(
  context: WorkflowContext,
  state: TaskBudgetState,
  identity: TaskBudgetIdentity,
): TaskBudgetRecord {
  const timestamp = nowIso();
  const existing = state.entries[identity.lineageKey];
  if (existing) {
    existing.updatedAt = timestamp;
    existing.targetCommand = identity.targetCommand;
    existing.headSha = identity.headSha;
    existing.taskBindingId = identity.taskBindingId || existing.taskBindingId;
    recordObservedBinding(existing, identity.taskBindingId);
    recordExactAttempt(existing, identity);
    return existing;
  }

  // Slug/branch identity flaps (dual state roots, moved worktrees, late lock
  // discovery) transfer the existing entry instead of minting a fresh budget.
  const sameBranch = Object.values(state.entries).filter((entry) => entry.branchName === identity.branchName);
  if (identity.taskSlug) {
    const slugless = sameBranch.filter((entry) => !entry.taskSlug);
    const conflicting = sameBranch.filter((entry) => entry.taskSlug && entry.taskSlug !== identity.taskSlug);
    if (conflicting.length === 0 && slugless.length === 1) {
      return rekeyTaskBudgetRecord(context, state, slugless[0]!, identity, timestamp);
    }
  } else if (sameBranch.length === 1) {
    // A branch-alone caller (slug not resolvable from this state root) binds
    // to the unique existing lineage for the branch rather than forking it.
    const entry = sameBranch[0]!;
    entry.updatedAt = timestamp;
    entry.targetCommand = identity.targetCommand;
    entry.headSha = identity.headSha;
    recordObservedBinding(entry, identity.taskBindingId);
    recordExactAttempt(entry, identity);
    return entry;
  }

  const record = buildFreshTaskBudgetRecord(context, identity, timestamp);
  recordExactAttempt(record, identity);
  state.entries[identity.lineageKey] = record;
  return record;
}

function buildFreshTaskBudgetRecord(
  context: WorkflowContext,
  identity: TaskBudgetIdentity,
  timestamp: string,
): TaskBudgetRecord {
  const config = normalizeTaskBudgetConfig(context.config.taskBudget);
  const routeSafety = normalizeRouteSafetyConfig(context.config.routeSafety);
  const changedLinesEstimate = estimateChangedLines(context);
  const sized = sizeTaskBudget(config, routeSafety, changedLinesEstimate);
  const record: TaskBudgetRecord = {
    budgetVersion: 1,
    lineageKey: identity.lineageKey,
    lineageVersion: 1,
    lineageDigest: identity.lineageKey,
    lineageFingerprint: identity.lineageFingerprint,
    taskBindingId: identity.taskBindingId,
    routeFingerprintDigest: identity.lineageKey,
    routeFingerprint: identity.lineageFingerprint,
    targetCommand: identity.targetCommand,
    taskSlug: identity.taskSlug,
    branchName: identity.branchName,
    headSha: identity.headSha,
    firstStartedAt: timestamp,
    updatedAt: timestamp,
    fixReviewLoops: 0,
    aiReviewRuns: 0,
    countedReviewRunIds: [],
    aiRunsBudget: sized.aiRunsBudget,
    activeMinutesBudget: sized.activeMinutesBudget,
    fixReviewLoopsBudget: sized.fixReviewLoopsBudget,
    changedLinesEstimate,
    budgetSizedAt: timestamp,
    aiRunLaunches: 0,
    activeMillisUsed: 0,
    lifetimeExtensions: 0,
  };
  recordObservedBinding(record, identity.taskBindingId);
  return record;
}

function rekeyTaskBudgetRecord(
  context: WorkflowContext,
  state: TaskBudgetState,
  entry: TaskBudgetRecord,
  identity: TaskBudgetIdentity,
  timestamp: string,
): TaskBudgetRecord {
  const previousLineageKey = entry.lineageKey;
  delete state.entries[entry.lineageKey];
  // The identity transfer carries the completion journal so an unapplied
  // crash record is not stranded under the retired lineage key.
  migrateCompletionJournalLineage(context.commonDir, context.config, previousLineageKey, identity.lineageKey);
  entry.lineageKey = identity.lineageKey;
  entry.lineageDigest = identity.lineageKey;
  entry.lineageFingerprint = identity.lineageFingerprint;
  entry.routeFingerprintDigest = identity.lineageKey;
  entry.routeFingerprint = identity.lineageFingerprint;
  entry.taskSlug = identity.taskSlug;
  entry.updatedAt = timestamp;
  entry.targetCommand = identity.targetCommand;
  entry.headSha = identity.headSha;
  entry.taskBindingId = identity.taskBindingId || entry.taskBindingId;
  recordObservedBinding(entry, identity.taskBindingId);
  recordExactAttempt(entry, identity);
  state.entries[identity.lineageKey] = entry;
  return entry;
}

function recordExactAttempt(record: TaskBudgetRecord, identity: TaskBudgetIdentity): void {
  record.currentAttemptDigest = identity.attemptDigest;
  const existing = (record.attempts ?? []).find((attempt) => attempt.digest === identity.attemptDigest);
  const attempt = {
    digest: identity.attemptDigest,
    fingerprint: identity.attemptFingerprint,
    headSha: identity.headSha,
    worktreeStatusDigest: identity.worktreeStatusDigest,
    observedAt: nowIso(),
    ...(existing?.reviewRunId ? { reviewRunId: existing.reviewRunId } : {}),
  };
  record.attempts = [attempt, ...(record.attempts ?? []).filter((entry) => entry.digest !== identity.attemptDigest)].slice(0, 50);
}

// ---------------------------------------------------------------------------
// Currency split: classification and debits.
// ---------------------------------------------------------------------------

function gateWasLaunched(gate: ReviewGateRunRecord): boolean {
  return (gate.type === 'skill' || gate.type === 'agent')
    && gate.status !== 'skipped'
    && Boolean(gate.command)
    && !(gate.status === 'pending' && gate.summary.startsWith('deferred:'))
    && gate.skipReason !== 'dry-run'
    && (gate.exitCode !== undefined || Boolean(gate.errorCode) || Boolean(gate.signal) || gate.durationMs > 0);
}

// Infra failure: the provider died without completing a structured review —
// non-zero exit with no parsed result, spawn error, signal, or timeout. A
// completed review that reports blocking findings is a finding-failure.
function gateIsInfraFailure(gate: ReviewGateRunRecord): boolean {
  if (!gateWasLaunched(gate) || gate.status !== 'failed') return false;
  if (gate.result?.findingsKnown) return false;
  return true;
}

export function classifyReviewRunDebits(reviewRun: ReviewRunRecord): ReviewCompletionDebits {
  const launched = reviewRun.gates.filter(gateWasLaunched);
  const failedBlocking = reviewRun.gates.filter((gate) => gate.blocking && gate.status === 'failed');
  const infraFailures = failedBlocking.filter(gateIsInfraFailure);
  const findingFailures = failedBlocking.filter((gate) => !gateIsInfraFailure(gate));
  const infraOnly = reviewRun.status === 'failed' && failedBlocking.length > 0 && findingFailures.length === 0 && infraFailures.length > 0;
  return {
    // Fix-first restarts replace the gate array, so the final record carries
    // the superseded attempts' launch count explicitly — every launched model
    // call debits, restarts included.
    aiRunLaunches: launched.length + Math.max(0, reviewRun.supersededAiLaunches ?? 0),
    activeMillis: Math.max(0, reviewRun.durationMs || 0),
    fixReviewLoops: reviewRun.status === 'failed' && findingFailures.length > 0 ? 1 : 0,
    infraOnly,
  };
}

function applyCompletionDebits(record: TaskBudgetRecord, completion: ReviewCompletionRecord, reviewRun?: ReviewRunRecord): void {
  if (record.countedReviewRunIds.includes(completion.reviewRunId)) {
    record.lastReviewRunId = completion.reviewRunId;
    if (reviewRun) {
      record.lastReviewStatus = reviewRun.status;
    }
    return;
  }
  record.countedReviewRunIds = [completion.reviewRunId, ...record.countedReviewRunIds].slice(0, 50);
  record.lastReviewRunId = completion.reviewRunId;
  record.lastReviewStatus = completion.reviewStatus;
  record.aiRunLaunches += completion.debits.aiRunLaunches;
  record.activeMillisUsed += completion.debits.activeMillis;
  record.fixReviewLoops += completion.debits.fixReviewLoops;
  if (completion.debits.aiRunLaunches > 0) record.aiReviewRuns += 1;
  if (completion.debits.infraOnly) record.infraFailureRuns = (record.infraFailureRuns ?? 0) + 1;
  if (reviewRun) {
    const attempt = record.attempts?.find((entry) => entry.digest === record.currentAttemptDigest);
    if (attempt) attempt.reviewRunId = reviewRun.id;
  }
}

// Re-estimate the budget once, at the first counted review, using the actual
// diff. Runs before the first debit is applied; never runs again.
function reEstimateBudgetAtFirstReview(context: WorkflowContext, record: TaskBudgetRecord): void {
  if (record.budgetReEstimatedAt || record.countedReviewRunIds.length > 0) return;
  const config = normalizeTaskBudgetConfig(context.config.taskBudget);
  const routeSafety = normalizeRouteSafetyConfig(context.config.routeSafety);
  const changedLinesEstimate = estimateChangedLines(context);
  const sized = sizeTaskBudget(config, routeSafety, changedLinesEstimate);
  record.changedLinesEstimate = changedLinesEstimate;
  record.aiRunsBudget = sized.aiRunsBudget;
  record.activeMinutesBudget = sized.activeMinutesBudget;
  record.fixReviewLoopsBudget = sized.fixReviewLoopsBudget;
  record.budgetReEstimatedAt = nowIso();
}

// Replays journal records that were appended but never marked applied — the
// crash-between-debit-and-evidence window — into the in-memory record, and
// returns the replayed run ids. The caller MUST persist the mutated state
// BEFORE marking those ids applied (finalizeAppliedCompletionMarks): marking
// first would let a crash between the marker and the save lose the debits
// permanently. The inverse crash (saved but unmarked) is safe because
// applyCompletionDebits is idempotent via countedReviewRunIds.
function replayUnappliedCompletions(context: Pick<WorkflowContext, 'commonDir' | 'config'>, record: TaskBudgetRecord): string[] {
  const unapplied = readUnappliedCompletionRecords(context.commonDir, context.config, record.lineageKey);
  for (const completion of unapplied) {
    applyCompletionDebits(record, completion);
  }
  return unapplied.map((completion) => completion.reviewRunId);
}

// Appends the applied markers for run ids whose debits are now durably saved.
function finalizeAppliedCompletionMarks(context: Pick<WorkflowContext, 'commonDir' | 'config'>, lineageKey: string, reviewRunIds: string[]): void {
  if (reviewRunIds.length === 0) return;
  withTaskCompletionLock(context.commonDir, context.config, lineageKey, () => {
    for (const reviewRunId of reviewRunIds) {
      markReviewCompletionApplied(context.commonDir, context.config, lineageKey, reviewRunId);
    }
  });
}

function activeMinutesUsed(record: TaskBudgetRecord): number {
  return Math.floor(record.activeMillisUsed / 60000);
}

// The completion transaction for a review run: journal the debits inside the
// task-scoped lock and apply them to the in-memory entry. The caller saves
// the mutated state and only then marks the run applied — the journal-record
// → store-write → marker ordering is what makes every crash window
// replayable exactly-once. Returns the run id to mark, or null when the run
// was already counted.
function recordJournaledReviewRun(
  context: WorkflowContext,
  record: TaskBudgetRecord,
  reviewRun: ReviewRunRecord,
): string | null {
  if (record.countedReviewRunIds.includes(reviewRun.id)) {
    record.lastReviewRunId = reviewRun.id;
    record.lastReviewStatus = reviewRun.status;
    return null;
  }
  const completion = withTaskCompletionLock(context.commonDir, context.config, record.lineageKey, () =>
    appendReviewCompletionRecord(context.commonDir, context.config, {
      lineageKey: record.lineageKey,
      taskSlug: record.taskSlug,
      branchName: record.branchName,
      reviewRunId: reviewRun.id,
      reviewStatus: reviewRun.status,
      debits: classifyReviewRunDebits(reviewRun),
    }));
  applyCompletionDebits(record, completion, reviewRun);
  return reviewRun.id;
}

// The durable-debit half of review completion, run BEFORE review evidence is
// persisted. Evidence-then-debit ordering would let a crash leave chargeable
// AI work recorded as usable evidence with no spend; this journals and saves
// the debits first, so the worst crash outcome is spend without evidence —
// the conservative direction (tokens died; they count).
export function journalReviewRunForTaskBudget(
  cwd: string,
  parsed: ParsedOperatorArgs,
  reviewRun: ReviewRunRecord,
): void {
  const context = resolveWorkflowContext(cwd);
  const plan = buildReviewRoutePlan(cwd, parsed);
  const identity = plan ? budgetIdentityForPlan(context, plan) : budgetIdentityForCurrentReview(context);
  const pendingMarks: string[] = [];
  withTaskBudgetStateLock(context.commonDir, context.config, () => {
    const state = loadTaskBudgetState(context.commonDir, context.config);
    const record = ensureTaskBudgetRecord(context, state, identity);
    pendingMarks.push(...replayUnappliedCompletions(context, record));
    reEstimateBudgetAtFirstReview(context, record);
    const marked = recordJournaledReviewRun(context, record, reviewRun);
    if (marked) pendingMarks.push(marked);
    saveTaskBudgetState(context.commonDir, context.config, state);
    finalizeAppliedCompletionMarks(context, record.lineageKey, pendingMarks);
  });
}

// Records the run's debits (idempotent with journalReviewRunForTaskBudget)
// and returns the advisory "round N, ~cost so far" line. Never stops flow.
export function recordReviewRunForTaskBudget(
  cwd: string,
  parsed: ParsedOperatorArgs,
  reviewRun: ReviewRunRecord,
): string {
  const context = resolveWorkflowContext(cwd);
  const plan = buildReviewRoutePlan(cwd, parsed);
  const identity = plan ? budgetIdentityForPlan(context, plan) : budgetIdentityForCurrentReview(context);
  return withTaskBudgetStateLock(context.commonDir, context.config, () => {
    const state = loadTaskBudgetState(context.commonDir, context.config);
    const record = ensureTaskBudgetRecord(context, state, identity);
    const pendingMarks = replayUnappliedCompletions(context, record);
    reEstimateBudgetAtFirstReview(context, record);
    const marked = recordJournaledReviewRun(context, record, reviewRun);
    if (marked) pendingMarks.push(marked);
    saveTaskBudgetState(context.commonDir, context.config, state);
    finalizeAppliedCompletionMarks(context, record.lineageKey, pendingMarks);
    return renderTaskBudgetAdvisoryLine(record);
  });
}

// The advisory stop-loss line: informs, never gates.
function renderTaskBudgetAdvisoryLine(record: TaskBudgetRecord): string {
  const minutes = activeMinutesUsed(record);
  const round = Math.max(1, record.aiReviewRuns);
  const overs: string[] = [];
  if (record.aiRunLaunches > record.aiRunsBudget) {
    overs.push(`${record.aiRunLaunches} AI runs exceed the sized stop-loss of ${record.aiRunsBudget}`);
  }
  if (minutes > record.activeMinutesBudget) {
    overs.push(`${minutes} active minutes exceed the sized stop-loss of ${record.activeMinutesBudget}`);
  }
  const base = `Task budget (advisory): round ${round} — ${record.aiRunLaunches} AI run(s), ~${minutes} active minute(s) spent.`;
  return overs.length > 0
    ? `${base} Over the advisory stop-loss (${overs.join('; ')}); consider narrowing scope or splitting the task.`
    : base;
}

export interface TaskBudgetSummary {
  taskSlug: string;
  branchName: string;
  lineageKey: string;
  used: { fixReviewLoops: number; aiRunLaunches: number; activeMinutes: number };
  limits: { fixReviewLoops: number; aiRuns: number; activeMinutes: number };
}

// Read-only budget meters for the current checkout — /status cockpit and the
// Board snapshot both render from this.
export function summarizeTaskBudgetForCheckout(context: WorkflowContext): TaskBudgetSummary | null {
  const checkout = budgetIdentityForCurrentCheckout(context);
  const state = loadTaskBudgetState(context.commonDir, context.config);
  const record = findRecordForCheckout(state, checkout);
  if (!record) return null;
  return {
    taskSlug: record.taskSlug,
    branchName: record.branchName,
    lineageKey: record.lineageKey,
    used: {
      fixReviewLoops: record.fixReviewLoops,
      aiRunLaunches: record.aiRunLaunches,
      activeMinutes: activeMinutesUsed(record),
    },
    limits: {
      fixReviewLoops: record.fixReviewLoopsBudget,
      aiRuns: record.aiRunsBudget,
      activeMinutes: record.activeMinutesBudget,
    },
  };
}

// Retention on task /clean: the budget entry archives to a summary line and
// its fully-applied completion journal truncates. Best-effort by design —
// cleanup must never fail because audit stores are unavailable.
export function cleanTaskBudgetArtifactsForTask(
  commonDir: string,
  config: WorkflowContext['config'],
  filter: { taskSlug: string; branchName: string },
): void {
  try {
    withTaskBudgetStateLock(commonDir, config, () => {
      const state = loadTaskBudgetState(commonDir, config);
      const matches = Object.values(state.entries).filter((entry) =>
        (filter.taskSlug && entry.taskSlug === filter.taskSlug && entry.branchName === filter.branchName)
        || (!entry.taskSlug && entry.branchName === filter.branchName));
      if (matches.length === 0) return;
      const context = { commonDir, config };
      const cleanedKeys = new Set<string>();
      const marksByLineage = new Map<string, string[]>();
      for (const entry of matches) {
        // Unapplied journal spend replays into the entry BEFORE the archive
        // line is written, so /clean can never discard completed debits. A
        // journal that cannot be read keeps the entry and its journal in
        // place for repair instead of deleting them.
        try {
          marksByLineage.set(entry.lineageKey, replayUnappliedCompletions(context, entry));
        } catch {
          continue;
        }
        appendTaskBudgetArchiveSummary(commonDir, config, entry);
        delete state.entries[entry.lineageKey];
        cleanedKeys.add(entry.lineageKey);
      }
      if (cleanedKeys.size === 0) return;
      saveTaskBudgetState(commonDir, config, state);
      for (const lineageKey of cleanedKeys) {
        finalizeAppliedCompletionMarks(context, lineageKey, marksByLineage.get(lineageKey) ?? []);
        pruneAppliedCompletionJournal(commonDir, config, lineageKey);
      }
    });
  } catch {
    // Cleanup remains best-effort; leftover entries are display state and the
    // next /clean pass can retry.
  }
}

function appendTaskBudgetArchiveSummary(
  commonDir: string,
  config: WorkflowContext['config'],
  entry: TaskBudgetRecord,
): void {
  try {
    const archivePath = path.join(path.dirname(taskBudgetStatePath(commonDir, config)), 'task-budget-archive.jsonl');
    const summary = {
      archivedAt: nowIso(),
      lineageKey: entry.lineageKey,
      taskSlug: entry.taskSlug,
      branchName: entry.branchName,
      spent: {
        fixReviewLoops: entry.fixReviewLoops,
        aiRunLaunches: entry.aiRunLaunches,
        activeMinutes: activeMinutesUsed(entry),
      },
      limits: {
        fixReviewLoops: entry.fixReviewLoopsBudget,
        aiRuns: entry.aiRunsBudget,
        activeMinutes: entry.activeMinutesBudget,
      },
      lastReviewStatus: entry.lastReviewStatus ?? null,
    };
    appendFileSync(archivePath, `${JSON.stringify(summary)}\n`, 'utf8');
  } catch {
    // Archive lines are convenience history, never authorization state.
  }
}

export function countLaunchedAiGates(gates: ReviewGateRunRecord[]): number {
  return gates.filter(gateWasLaunched).length;
}

function buildReviewRoutePlan(cwd: string, parsed: ParsedOperatorArgs): DestinationPlan | null {
  return buildDestinationPlanForCommand(cwd, {
    ...parsed,
    command: 'pr',
    positional: [],
  });
}

function findRecordForCheckout(
  state: TaskBudgetState,
  checkout: { lineageKey: string; taskSlug: string; branchName: string },
): TaskBudgetRecord | null {
  const exact = state.entries[checkout.lineageKey];
  if (exact) return exact;
  const sameBranch = Object.values(state.entries).filter((entry) => entry.branchName === checkout.branchName);
  if (sameBranch.length === 1) return sameBranch[0]!;
  return null;
}
