import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  buildGoalSpecDraft,
  renderProviderGoalPrompt,
  type GoalSpec,
} from './goal-spec.ts';
import {
  DEFAULT_GOAL_PROVIDER,
  ensureInstallMarker,
  normalizePath,
  nowIso,
  normalizeVersionedJsonValue,
  readVersionedJsonFile,
  resolveStateDir,
  runGit,
  TASK_SLUG_MAX_LENGTH,
  STATE_SCHEMA_VERSIONS,
  writeJsonFile,
  writeVersionedJsonFile,
  type GoalProvider,
  type OrchestrateConfig,
  type ReviewGateConfig,
  type ReviewActorIdentity,
  type ReviewGateRunStatus,
  type ReviewRunRecord,
  type ReviewPlanGateConfig,
  type WorkflowConfig,
} from './state.ts';
import {
  blockingAiReviewEvidenceBlocker,
  type ReviewIndependenceLabel,
} from './review-identity.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';
import {
  canonicalize,
  ORCHESTRATION_STATE_KEY_ENV,
  resolveOrchestrationStateKey,
  resolveReviewStateKey,
  signSignedPayload,
  stateKeyFingerprint,
  verifySignedPayload,
} from './integrity.ts';

export type OrchestrationRunStatus = 'planned' | 'prepared' | 'dispatched' | 'running' | 'blocked' | 'paused' | 'completed' | 'failed';

export type OrchestrationCoverageDisposition = 'slice' | 'deferred' | 'excluded';

export interface OrchestrationCoverageEntry {
  section: string;
  disposition: OrchestrationCoverageDisposition;
  sliceId?: string;
  reason?: string;
}

export type OrchestrationSourceKind = 'plan-file' | 'prompt';
export type PlanReviewGateRunStatus = ReviewGateRunStatus | 'bypassed';
export const ORCHESTRATION_OBSERVATION_KINDS = [
  'plan_review_skipped',
  'plan_review_pending',
  'plan_review_passed',
  'plan_review_failed',
  'plan_review_bypassed',
  'worker_failed',
  'worker_succeeded',
  'empty_slice',
  'review_gate_failed',
  'review_gate_pending',
  'review_independence_blocked',
  'review_evidence_stale',
  'review_signature_blocked',
  'missing_worktree',
  'dependency_blocked',
  'auto_fix_started',
  'auto_fix_no_progress',
  'auto_fix_exhausted',
  'auto_fix_fixed',
] as const;

export type OrchestrationObservationKind = typeof ORCHESTRATION_OBSERVATION_KINDS[number];

export const ORCHESTRATION_OBSERVATION_REASON_CODES = [
  'no_plan_review_gates',
  'plan_review_not_applicable',
  'plan_review_waiting',
  'plan_review_attested',
  'plan_review_gate_failed',
  'manual_bypass',
  'worker_exit_nonzero',
  'material_change_detected',
  'no_material_change',
  'blocking_gate_failed',
  'manual_gate_pending',
  'same_session_reviewer',
  'stale_review_evidence',
  'invalid_or_missing_signature',
  'assigned_worktree_missing',
  'predecessor_not_ready',
  'review_fix_started',
  'review_fix_no_progress',
  'review_fix_budget_spent',
  'review_fix_passed',
] as const;

export type OrchestrationObservationReasonCode = typeof ORCHESTRATION_OBSERVATION_REASON_CODES[number];

export type OrchestrationStopReason =
  | 'not-started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'empty'
  | 'review-gate-failed'
  | 'review-gate-failed-awaiting-auto-fix'
  | 'review-gate-pending'
  | 'dependency-blocked'
  | 'missing-worktree'
  | 'auto-fix-stalled'
  | 'auto-fix-exhausted'
  | 'legacy-no-observation';

export interface OrchestrationLoopSummary {
  status: 'not-started' | 'running' | 'blocked' | 'failed' | 'stalled' | 'exhausted' | 'completed' | 'legacy';
  stopReason: OrchestrationStopReason;
  latestObservationId: string | null;
  workerAttempts: number;
  reviewAttempts: number;
  autoFixAttempts: number;
  updatedAt: string;
}

export interface PlanReviewEvidenceBinding {
  runId: string;
  gateId: string;
  sourceSha256: string;
  decompositionDigest: string;
  gateSnapshotDigest: string;
  analyzerSessionId: string | null;
  attesterSessionId: string | null;
  createdAt: string;
  action: 'pass' | 'bypass';
  reasonSha256?: string;
  messageSha256?: string;
}

export interface PlanReviewGateRunRecord {
  id: string;
  gateId: string;
  phase: 'plan';
  type: ReviewPlanGateConfig['type'];
  blocking: boolean;
  status: PlanReviewGateRunStatus;
  attester?: ReviewActorIdentity;
  skill?: string;
  role?: string;
  summary: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  skipReason?: string;
  bypassReason?: string;
  gateSnapshotDigest: string;
  binding?: PlanReviewEvidenceBinding;
  signature?: string;
}

export interface OrchestrationPlanAnalysisRecord {
  status: 'passed' | 'pending' | 'failed' | 'bypassed';
  analyzedAt: string;
  analyzer: ReviewActorIdentity;
  analyzerIdentityReliable: boolean;
  source: {
    kind: OrchestrationSourceKind;
    planPath: string | null;
    promptRef: 'run.source.prompt' | null;
    textSha256: string | null;
  };
  strengths: string[];
  risks: string[];
  ambiguities: string[];
  sensitiveAreas: string[];
  recommendedScope: {
    throughSliceId: string | null;
    reason: string | null;
  };
  coverageRef: 'run.coverage';
  coverageDigest: string | null;
  decompositionDigest: string;
  activeSurfaces: string[];
  gateSnapshotDigest: string;
  planReview: {
    status: 'passed' | 'pending' | 'failed' | 'bypassed' | 'skipped';
    gates: PlanReviewGateRunRecord[];
    evidencePath: string | null;
  };
  latestObservationId: string | null;
}

export interface OrchestrationObservationRecord {
  id: string;
  runId: string;
  sliceId: string | null;
  gateId: string | null;
  kind: OrchestrationObservationKind;
  reasonCode: OrchestrationObservationReasonCode;
  summary: string;
  details?: Record<string, unknown>;
  terminal: boolean;
  createdAt: string;
}

export interface OrchestrationObservationsState {
  runId: string;
  observations: OrchestrationObservationRecord[];
  compactedAt: string | null;
  droppedObservationCount: number;
}

export interface OrchestrationObservationIndex {
  observationsPath: string;
  latestObservationId: string | null;
  latestObservationKind: OrchestrationObservationKind | null;
  observationCount: number;
  compactedAt: string | null;
  stale?: boolean;
}
// B1: `empty` = the worker exited 0 but produced no material change
// (`collectChangedFiles` empty). It is conservative — it blocks dependents and
// the run from completing (Decision 2); the remedy is re-dispatch with a sharper
// goal, or defer. When adding a status here, also update the runtime whitelist in
// `isOrchestrationSliceRecord` below.
export type OrchestrationSliceStatus = 'planned' | 'prepared' | 'dispatched' | 'running' | 'blocked' | 'completed' | 'empty' | 'failed';
export type OrchestrationSliceWorkerStatus = 'running' | 'succeeded' | 'failed';

export const ORCHESTRATION_CORRUPT_LEDGER_BLOCK_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface OrchestrationSliceDispatchRecord {
  status: 'ready';
  provider: GoalProvider;
  promptPath: string;
  worktreePath: string;
  branchName: string;
  handoffCommand: string;
  dispatchedAt: string;
}

export interface OrchestrationSliceWorkerRecord {
  status: OrchestrationSliceWorkerStatus;
  provider: GoalProvider;
  identity?: ReviewActorIdentity;
  command: string;
  pid: number | null;
  promptPath: string;
  logPath: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

// C2 (Decision 4/11): the anti-replay binding for embedded review evidence. The
// signed payload binds the verdict to the exact run/slice/worker/branch/worktree/
// commit/tree-state it was produced for, so a legitimately-signed record cannot be
// replayed into a different context (a different slice, run, or worktree). All
// fields are reconstructable from the persisted slice + run + reviewRun, so the
// read path can re-derive and compare them.
export interface OrchestrationSliceReviewBinding {
  runId: string;
  sliceId: string;
  workerSessionId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  sha: string | null;
  worktreeStatusDigest: string | null;
}

export interface OrchestrationSliceReviewRecord {
  status: ReviewRunRecord['status'];
  evidencePath: string;
  reviewedAt: string;
  reviewer?: ReviewActorIdentity;
  independence?: ReviewIndependenceLabel;
  independenceReason?: string;
  run: ReviewRunRecord;
  // C2: HMAC over this record (minus `signature`) using the review-state key the
  // worker does not have, with `binding` carrying the anti-replay context. Both are
  // optional: legacy ledgers predate signing, and signing is off when no key is
  // configured. The completion read path (`sliceReviewFullySatisfied`) verifies
  // them only when a key is present (reject-unsigned-when-active); `orchestrate
  // upgrade-ledger` signs legacy records in place.
  binding?: OrchestrationSliceReviewBinding;
  signature?: string;
}

export interface OrchestrationReviewFixRecord {
  sliceId: string;
  status: OrchestrationSliceStatus;
  workerStatus: OrchestrationSliceWorkerStatus;
  attempt: number;
  failedGateIds: string[];
  promptPath: string;
  logPath: string | null;
  exitCode: number | null;
  recordedAt: string;
  // B2 (#15): the fed-forward attempt journal. `signature` is the canonical
  // no-progress signature of the failure this attempt addressed; `reviewStatus`
  // is the re-review verdict observed after the attempt; `lesson` is a derived
  // one-liner (keyed by `signature`) injected into the next attempt's fix prompt
  // so attempt N+1 forms a hypothesis the prior attempts ruled out. All optional:
  // legacy records lack them and `isOrchestrationRunRecord` does not validate
  // `reviewFixes`, so they are additive and migration-free.
  signature?: string;
  reviewStatus?: ReviewRunRecord['status'] | null;
  lesson?: string;
}

export interface OrchestrationSliceRecord {
  id: string;
  index: number;
  status: OrchestrationSliceStatus;
  outcome: string;
  dependsOn: string[];
  requestedFiles: string[];
  forbiddenFiles: string[];
  taskSlug: string | null;
  worktreePath: string | null;
  branchName: string | null;
  dispatch: OrchestrationSliceDispatchRecord | null;
  worker: OrchestrationSliceWorkerRecord | null;
  review: OrchestrationSliceReviewRecord | null;
  // Advisory, NEGATIVE-only review evidence: prior/auxiliary review verdicts whose
  // PRESENCE can block completion (see `sliceHasRejectedBlockingAiDiagnostic`) but which
  // are never positive completion evidence. Unlike `review`, these are NOT
  // signature-verified on read (FU1), so a same-UID worker that can write the ledger
  // could edit or delete an entry to drop a block. That is acceptable: completion's
  // positive gate is the signed, context-bound `review` (C2) the worker cannot forge,
  // so suppressing a diagnostic only reverts to that already-valid verdict — it can
  // never fabricate a pass. Treat their absence as "not evaluated", never as "clean".
  reviewDiagnostics?: OrchestrationSliceReviewRecord[];
  goalSpec: GoalSpec;
  provider: GoalProvider;
  // G1 / Decision 1: providerPrompt/confirmationPrompt are NOT persisted here.
  // The worker prompt is derived from goalSpec + provider at dispatch time via
  // `renderSliceWorkerPrompt` (single source), so a slice can never carry a
  // stale prompt that drifts from its spec.
  requiresConfirmation: boolean;
  critique: string[];
  // PR1: optional grouping label and deferral flag. Absent (not `false`) on the
  // heading-decomposed path so existing slice-headed plans serialize identically.
  phase?: string;
  deferred?: boolean;
  // Set by `orchestrate finalize` when a deferred slice is abandoned; the record
  // is kept (not deleted) so the audit trail survives.
  excludedReason?: string;
  excludedAt?: string;
  loopSummary?: OrchestrationLoopSummary;
}

export interface OrchestrationRunRecord {
  id: string;
  status: OrchestrationRunStatus;
  createdAt: string;
  updatedAt: string;
  branchName: string;
  sha: string;
  source: {
    planPath: string | null;
    prompt: string | null;
    textSha256: string | null;
  };
  plan: {
    title: string;
    outcome: string | null;
    sliceCount: number;
    dependencyPolicy: 'sequential';
  };
  configSnapshot: {
    maxConcurrentSlices: number | null;
    goalMode: OrchestrateConfig['goalMode'] | null;
    hardStops: OrchestrateConfig['hardStops'] | null;
  };
  gateSnapshot: {
    planReview: {
      gates: ReviewPlanGateConfig[];
    };
    gates: ReviewGateConfig[];
  };
  slices: OrchestrationSliceRecord[];
  reviewFixes?: OrchestrationReviewFixRecord[];
  planAnalysisRequired?: boolean;
  planAnalysis?: OrchestrationPlanAnalysisRecord;
  observationIndex?: OrchestrationObservationIndex;
  loopSummary?: OrchestrationLoopSummary;
  // PR1: agent-authored coverage map, persisted as durable, inspectable evidence
  // of which plan section maps to which slice / deferred / excluded. Absent on the
  // heading-decomposed path.
  coverage?: OrchestrationCoverageEntry[];
  legacyReseal?: {
    resealedAt: string;
    reason: string;
    trustedLocalState: true;
  };
  integrity?: OrchestrationRunIntegrity;
  signature?: string;
}

export interface OrchestrationRunIntegrity {
  version: 1;
  runId: string;
  mutationIndex: number;
  keyFingerprint: string;
}

export interface OrchestrationRunIntegrityHead {
  version: 1;
  runId: string;
  mutationIndex: number;
  ledgerSignature: string;
  keyFingerprint: string;
  signature?: string;
}

type OrchestrationRunDiskEnvelope = OrchestrationRunRecord & {
  schemaVersion: number;
};

export interface BuildOrchestrationSliceInput {
  id?: string;
  title: string;
  phase?: string;
  text?: string;
}

export interface BuildOrchestrationRunInput {
  repoRoot: string;
  config: WorkflowConfig;
  planPath?: string;
  planText?: string;
  outcome?: string;
  sliceId?: string;
  provider?: GoalProvider;
  maxTurns?: number;
  maxMinutes?: number;
  // PR1: agent-proposed decomposition. When present it replaces heading-splitting;
  // the ledger still binds source.planPath/textSha256 to the REAL plan text.
  slices?: BuildOrchestrationSliceInput[];
  coverage?: OrchestrationCoverageEntry[];
}

export type OrchestrationLedgerDiagnostic =
  | {
    status: 'valid';
    runId: string;
    ledgerPath: string;
    mtimeMs: number;
    record: OrchestrationRunRecord;
  }
  | {
    status: 'missing';
    runId: string;
    ledgerPath: string;
    mtimeMs: null;
    reason: string;
  }
  | {
    status: 'corrupt';
    runId: string;
    ledgerPath: string;
    mtimeMs: number | null;
    reason: string;
  }
  | {
    status: 'invalid-run-id';
    runId: string;
    ledgerPath: null;
    mtimeMs: null;
    reason: string;
  };

export interface OrchestrationRunDirectoryDiagnostic {
  status: 'invalid-run-directory';
  runId: string;
  directoryPath: string;
  ledgerPath: string | null;
  mtimeMs: number | null;
  reason: string;
}

export interface OrchestrationRunScanDiagnostics {
  records: OrchestrationRunRecord[];
  valid: Extract<OrchestrationLedgerDiagnostic, { status: 'valid' }>[];
  corrupt: Extract<OrchestrationLedgerDiagnostic, { status: 'corrupt' }>[];
  invalidDirectories: OrchestrationRunDirectoryDiagnostic[];
}

export interface OrchestrationMissingWorktreeDiagnostic {
  sliceId: string;
  status: OrchestrationSliceStatus;
  branchName: string | null;
  worktreePath: string;
  reason: string;
}

interface PlanSliceSource {
  title: string;
  text: string;
}

const CODE_SPAN_PATTERN = /`([^`\n]+)`/g;
const BARE_PATH_PATTERN = /(?:^|[\s(["])((?:(?:\.?[A-Za-z0-9_-]+)\/)+[A-Za-z0-9_.@-]+|(?:README|AGENTS|CLAUDE|CONTRIBUTING|TODOS)\.md|package\.json|tsconfig\.[A-Za-z0-9.]+)(?=$|[\s,.;:)\\\]`])/g;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export function orchestrationRunPath(commonDir: string, config: WorkflowConfig, runId: string): string {
  return path.join(resolveStateDir(commonDir, config), 'orchestrate', 'runs', runId, 'orchestration.json');
}

export function orchestrationIntegrityHeadPath(commonDir: string, config: WorkflowConfig, runId: string): string {
  return path.join(resolveStateDir(commonDir, config), 'orchestrate', 'integrity', `${runId}.json`);
}

export function orchestrationObservationsPath(commonDir: string, config: WorkflowConfig, runId: string): string {
  return path.join(resolveStateDir(commonDir, config), 'orchestrate', 'runs', runId, 'observations.json');
}

export function orchestrationStateRelativePath(commonDir: string, config: WorkflowConfig, targetPath: string): string {
  return path.relative(resolveStateDir(commonDir, config), targetPath).replaceAll('\\', '/');
}

// PR1: the in-scope set for this pass. Deferred slices (set by `orchestrate scope`)
// are excluded from prepare/dispatch/start/review/status so a partial run can
// complete and resume cleanly instead of blocking on work the operator deferred.
export function selectActiveSlices(run: OrchestrationRunRecord): OrchestrationSliceRecord[] {
  return run.slices.filter((slice) => slice.deferred !== true);
}

// A deferred slice that has not been permanently abandoned by `orchestrate finalize`
// keeps the run resumable (status `paused`) rather than letting it report completed.
export function hasResumableDeferredSlices(run: OrchestrationRunRecord): boolean {
  return run.slices.some((slice) => slice.deferred === true && !slice.excludedReason);
}

export function buildOrchestrationRunRecord(input: BuildOrchestrationRunInput): OrchestrationRunRecord {
  const createdAt = nowIso();
  const rawPlanText = input.planText ?? '';
  const planText = rawPlanText.trim();
  const prompt = input.outcome?.trim() || null;
  // Agent-proposed decomposition (PR1) replaces heading-splitting when present.
  // The real plan text still drives source binding, title, and per-slice goal text.
  const structured = input.slices && input.slices.length > 0 ? input.slices : null;
  const planSections = structured
    ? {
        globalText: '',
        slices: structured.map((slice) => ({
          title: slice.title,
          text: slice.text && slice.text.trim() ? slice.text : slice.title,
        })),
      }
    : resolvePlanSections(planText, input.outcome);
  const sliceIdCounts = new Map<string, number>();
  const assignedSliceIds = new Set<string>();
  const slices = planSections.slices.map((slice, index): OrchestrationSliceRecord => {
    const proposed = structured?.[index];
    const draft = buildGoalSpecDraft({
      config: input.config,
      sliceId: proposed?.id?.trim() || (planSections.slices.length === 1 ? input.sliceId : undefined),
      outcome: slice.title,
      planPath: input.planPath,
      planText: planText
        ? buildSliceGoalPlanText(slice.text, buildGlobalPlanContext(planSections.globalText, prompt))
        : undefined,
      provider: input.provider ?? DEFAULT_GOAL_PROVIDER,
      maxTurns: input.maxTurns,
      maxMinutes: input.maxMinutes,
    });
    const sliceId = reserveUniqueSliceId(draft.spec.sliceId, sliceIdCounts, assignedSliceIds);
    const goalSpec = sliceId === draft.spec.sliceId
      ? draft.spec
      : { ...draft.spec, sliceId };

    const record: OrchestrationSliceRecord = {
      id: goalSpec.sliceId,
      index: index + 1,
      status: 'planned',
      outcome: goalSpec.outcome,
      dependsOn: [],
      requestedFiles: extractPathHints(slice.text),
      forbiddenFiles: [...input.config.prPathDenyList],
      taskSlug: null,
      worktreePath: null,
      branchName: null,
      dispatch: null,
      worker: null,
      review: null,
      reviewDiagnostics: [],
      goalSpec,
      provider: draft.provider,
      requiresConfirmation: draft.requiresConfirmation,
      critique: draft.critique,
    };
    const phase = proposed?.phase?.trim();
    if (phase) record.phase = phase;
    return record;
  });

  for (let index = 1; index < slices.length; index += 1) {
    slices[index].dependsOn = [slices[index - 1].id];
  }

  // Compile-time, fail-closed validation of the resolved spec (G1). Cross-refs
  // and the dependency graph must be coherent before any worktree is created or
  // worker spawned: a dangling/cyclic ref is a pre-flight error, not a run that
  // hangs blocked at execution time.
  validateOrchestrationSpec({
    slices: slices.map((slice) => ({ id: slice.id, dependsOn: slice.dependsOn })),
    coverage: input.coverage,
    gates: input.config.reviewGates?.gates ?? [],
    planGates: input.config.reviewGates?.planReview?.gates ?? [],
  });

  const runId = makeRunId(input.repoRoot, slices);
  return {
    id: runId,
    status: 'planned',
    createdAt,
    updatedAt: createdAt,
    branchName: runGit(input.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '',
    sha: runGit(input.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '',
    source: {
      planPath: input.planPath ? repoRelativePath(input.repoRoot, input.planPath) : null,
      prompt,
      textSha256: rawPlanText ? sha256(rawPlanText) : null,
    },
    plan: {
      title: prompt || inferPlanTitle(planText) || 'Orchestration plan',
      outcome: prompt,
      sliceCount: slices.length,
      dependencyPolicy: 'sequential',
    },
    configSnapshot: {
      maxConcurrentSlices: input.config.orchestrate?.maxConcurrentSlices ?? null,
      goalMode: input.config.orchestrate?.goalMode ? cloneJson(input.config.orchestrate.goalMode) : null,
      hardStops: input.config.orchestrate?.hardStops ? cloneJson(input.config.orchestrate.hardStops) : null,
    },
    gateSnapshot: {
      planReview: {
        gates: cloneJson(input.config.reviewGates?.planReview?.gates ?? []),
      },
      gates: cloneJson(input.config.reviewGates?.gates ?? []),
    },
    slices,
    reviewFixes: [],
    planAnalysisRequired: true,
    ...(input.coverage && input.coverage.length > 0 ? { coverage: input.coverage } : {}),
  };
}

export function stableJsonDigest(value: unknown): string {
  return sha256(canonicalize(value));
}

export function planReviewGateSnapshotDigest(run: OrchestrationRunRecord): string {
  return stableJsonDigest(run.gateSnapshot.planReview.gates);
}

export function coverageDigest(run: Pick<OrchestrationRunRecord, 'coverage'>): string | null {
  return run.coverage ? stableJsonDigest(run.coverage) : null;
}

export function analysisSourceSha256(input: {
  planTextSha256?: string | null;
  prompt?: string | null;
}): string | null {
  const planTextSha256 = input.planTextSha256 ?? null;
  const promptSha256 = input.prompt ? sha256(input.prompt) : null;
  if (planTextSha256 && promptSha256) {
    return stableJsonDigest({ planTextSha256, promptSha256 });
  }
  if (planTextSha256) return planTextSha256;
  if (promptSha256) return promptSha256;
  return null;
}

export function sourceSha256ForAnalysis(run: OrchestrationRunRecord): string | null {
  return analysisSourceSha256({
    planTextSha256: run.source.textSha256,
    prompt: run.source.prompt,
  });
}

// G1 / Decision 1 + A3 groundwork: the worker prompt is a function of the
// resolved spec, derived at dispatch time rather than persisted. This is the
// single source for "the prompt a worker runs"; the human handoff (the dispatch
// `.md`) is rendered separately in the orchestrate command and wraps this.
export function renderSliceWorkerPrompt(slice: OrchestrationSliceRecord): string {
  const sections = [renderProviderGoalPrompt(slice.goalSpec, slice.provider)];
  const fileScope = renderAdvisoryFileScope(slice);
  if (fileScope) sections.push(fileScope);
  // A3: the worker now receives this prompt directly (not the human-handoff
  // `.md`), so the execution guardrail that used to live in the handoff file
  // must travel with the worker prompt — otherwise piping the clean prompt would
  // silently drop a safety constraint.
  sections.push([
    '## Worker execution policy',
    'Work only inside this slice worktree. Do not merge, deploy, clean worktrees, change unrelated files, or run release automation; Pipelane runs review and integration after you finish.',
  ].join('\n'));
  return sections.join('\n\n');
}

// A2: requestedFiles/forbiddenFiles are surfaced to the worker EXPLICITLY as
// advisory. Pipelane does not enforce them (forbiddenFiles == prPathDenyList, a
// PR-time path gate, not a worker sandbox), so the label must not imply a
// protection that does not exist.
function renderAdvisoryFileScope(slice: OrchestrationSliceRecord): string {
  const lines: string[] = [];
  if (slice.requestedFiles.length > 0) {
    lines.push('Suggested files (hints parsed from the plan):', ...slice.requestedFiles.map((file) => `- ${file}`));
  }
  if (slice.forbiddenFiles.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Avoid changing (repo deny list):', ...slice.forbiddenFiles.map((file) => `- ${file}`));
  }
  if (lines.length === 0) return '';
  return ['## File scope (advisory only — Pipelane does NOT enforce these)', ...lines].join('\n');
}

export interface OrchestrationSpecValidationSlice {
  id: string;
  dependsOn: string[];
}

export interface OrchestrationSpecValidationInput {
  slices: OrchestrationSpecValidationSlice[];
  coverage?: OrchestrationCoverageEntry[];
  // Gate cross-references in pipelane are id-addressable only: gates do not
  // reference goal/finish-line criteria the way a council rubric does, and gate
  // well-formedness (required type fields, allowed phases/types) is already
  // enforced by `normalizeReviewGatesConfig`. The compile step therefore checks
  // gate-id uniqueness — the one integrity property the agent-proposed /
  // hand-built config path (which bypasses normalization) can still violate.
  // The substantive "a blocking semantic gate is configured" invariant (B3) is
  // a separate, flag-gated check that lands later; it is intentionally not here.
  gates?: { id: string }[];
  planGates?: { id: string }[];
}

// G1 compile step: validate the resolved spec fail-closed. Throws a single,
// actionable `Orchestration compile error: ...` on the first violation so the
// CLI surfaces it as a pre-flight error (handlePlan/buildEntryRunRecord already
// run inside throw-tolerant command handlers). Exported so the dependency-graph
// invariants are unit-testable directly with crafted cyclic/diamond inputs that
// `buildOrchestrationRunRecord` cannot otherwise produce (it always rebuilds
// `dependsOn` as a linear chain).
export function validateOrchestrationSpec(input: OrchestrationSpecValidationInput): void {
  const sliceIds = new Set<string>();
  for (const slice of input.slices) {
    if (sliceIds.has(slice.id)) {
      throw new Error(`Orchestration compile error: duplicate slice id "${slice.id}".`);
    }
    sliceIds.add(slice.id);
  }

  for (const slice of input.slices) {
    for (const dependencyId of slice.dependsOn) {
      if (dependencyId === slice.id) {
        throw new Error(`Orchestration compile error: slice "${slice.id}" depends on itself.`);
      }
      if (!sliceIds.has(dependencyId)) {
        throw new Error(`Orchestration compile error: slice "${slice.id}" depends on unknown slice "${dependencyId}".`);
      }
    }
  }

  assertNoDependencyCycle(input.slices);

  (input.coverage ?? []).forEach((entry, index) => {
    if (entry.disposition === 'slice') {
      if (!entry.sliceId) {
        throw new Error(`Orchestration compile error: coverage ${index + 1} for section "${entry.section}" maps to a slice but has no sliceId.`);
      }
      if (!sliceIds.has(entry.sliceId)) {
        throw new Error(`Orchestration compile error: coverage ${index + 1} references unknown slice "${entry.sliceId}".`);
      }
    } else if (entry.sliceId && !sliceIds.has(entry.sliceId)) {
      throw new Error(`Orchestration compile error: coverage ${index + 1} references unknown slice "${entry.sliceId}".`);
    }
  });

  assertUniqueGateIds(input.gates ?? [], 'gate');
  assertUniqueGateIds(input.planGates ?? [], 'plan-review gate');
}

function assertNoDependencyCycle(slices: OrchestrationSpecValidationSlice[]): void {
  const dependenciesById = new Map(slices.map((slice) => [slice.id, slice.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart >= 0 ? cycleStart : 0), id].join(' -> ');
      throw new Error(`Orchestration compile error: dependency cycle detected: ${cycle}.`);
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependencyId of dependenciesById.get(id) ?? []) {
      if (dependenciesById.has(dependencyId)) visit(dependencyId);
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const slice of slices) visit(slice.id);
}

function assertUniqueGateIds(gates: { id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const gate of gates) {
    if (seen.has(gate.id)) {
      throw new Error(`Orchestration compile error: duplicate ${label} id "${gate.id}".`);
    }
    seen.add(gate.id);
  }
}

export function saveOrchestrationRunRecord(
  commonDir: string,
  config: WorkflowConfig,
  record: OrchestrationRunRecord,
): string {
  const key = resolveOrchestrationStateKey();
  const fingerprint = stateKeyFingerprint(key);
  const targetPath = orchestrationRunPath(commonDir, config, record.id);
  assertSafeOrchestrationRunId(record.id);
  ensureInstallMarker(commonDir, config);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  assertOrchestrationIntegrityHeadAllowsSave(commonDir, config, record, key, fingerprint);
  const priorMutationIndex = Number.isSafeInteger(record.integrity?.mutationIndex)
    ? record.integrity.mutationIndex
    : 0;
  record.integrity = {
    version: 1,
    runId: record.id,
    mutationIndex: priorMutationIndex + 1,
    keyFingerprint: fingerprint,
  };
  delete record.signature;
  const envelope: OrchestrationRunDiskEnvelope = {
    ...record,
    schemaVersion: STATE_SCHEMA_VERSIONS.orchestrationRun,
  };
  record.signature = signSignedPayload(envelope, key);
  writeVersionedJsonFile('orchestrationRun', targetPath, record);
  saveOrchestrationIntegrityHead(commonDir, config, record, key);
  return targetPath;
}

function saveOrchestrationIntegrityHead(
  commonDir: string,
  config: WorkflowConfig,
  record: OrchestrationRunRecord,
  key: string,
): void {
  if (!record.integrity || !record.signature) {
    throw new Error(`Cannot save orchestration integrity head for ${record.id}: signed ledger metadata is missing.`);
  }
  const targetPath = orchestrationIntegrityHeadPath(commonDir, config, record.id);
  const head: OrchestrationRunIntegrityHead = {
    version: 1,
    runId: record.id,
    mutationIndex: record.integrity.mutationIndex,
    ledgerSignature: record.signature,
    keyFingerprint: record.integrity.keyFingerprint,
  };
  head.signature = signSignedPayload(head, key);
  writeJsonFile(targetPath, head);
}

function assertOrchestrationIntegrityHeadAllowsSave(
  commonDir: string,
  config: WorkflowConfig,
  record: OrchestrationRunRecord,
  key: string,
  fingerprint: string,
): void {
  const headPath = orchestrationIntegrityHeadPath(commonDir, config, record.id);
  if (!existsSync(headPath)) {
    if (record.integrity || record.signature) {
      throw new Error(`Cannot save orchestration ledger for ${record.id}: existing signed metadata has no integrity head; reload the run before mutating it.`);
    }
    return;
  }

  const head = loadVerifiedOrchestrationIntegrityHead(headPath, record.id, key, fingerprint);
  if (!record.integrity || !record.signature) {
    throw new Error(`Cannot save orchestration ledger for ${record.id}: existing integrity head cannot be updated from an unsigned record.`);
  }
  if (head.mutationIndex !== record.integrity.mutationIndex) {
    throw new Error(`Cannot save orchestration ledger for ${record.id}: concurrent orchestration mutation detected; integrity head is at mutationIndex ${head.mutationIndex}, record was loaded at ${record.integrity.mutationIndex}.`);
  }
  if (head.ledgerSignature !== record.signature) {
    throw new Error(`Cannot save orchestration ledger for ${record.id}: concurrent orchestration mutation detected; integrity head signature no longer matches the loaded record.`);
  }
}

function loadVerifiedOrchestrationIntegrityHead(
  headPath: string,
  runId: string,
  key: string,
  fingerprint: string,
): OrchestrationRunIntegrityHead {
  let parsed: unknown;
  try {
    parsed = readRawJsonFile(headPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot save orchestration ledger for ${runId}: malformed orchestration integrity head JSON: ${error.message}`);
    }
    throw error;
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Cannot save orchestration ledger for ${runId}: orchestration integrity head JSON does not match the expected schema.`);
  }
  const head = parsed as Record<string, unknown>;
  const signatureReason = malformedSignatureReason(head.signature, 'integrity head signature');
  if (signatureReason) {
    throw new Error(`Cannot save orchestration ledger for ${runId}: ${signatureReason}.`);
  }
  if (!isOrchestrationRunIntegrityHead(head)) {
    throw new Error(`Cannot save orchestration ledger for ${runId}: orchestration integrity head JSON does not match the expected schema.`);
  }
  if (!verifySignedPayload(head as OrchestrationRunIntegrityHead, key)) {
    throw new Error(
      head.keyFingerprint !== fingerprint
        ? `Cannot save orchestration ledger for ${runId}: wrong ${ORCHESTRATION_STATE_KEY_ENV}; integrity head was sealed with a different key fingerprint.`
        : `Cannot save orchestration ledger for ${runId}: orchestration integrity head signature verification failed; reload the run before mutating it.`,
    );
  }
  if (head.runId !== runId) {
    throw new Error(`Cannot save orchestration ledger for ${runId}: orchestration integrity head run id mismatch: expected ${runId}, got ${head.runId}.`);
  }
  if (head.keyFingerprint !== fingerprint) {
    throw new Error(`Cannot save orchestration ledger for ${runId}: wrong ${ORCHESTRATION_STATE_KEY_ENV}; integrity head key fingerprint does not match the configured key.`);
  }
  return head as OrchestrationRunIntegrityHead;
}

const ORCHESTRATION_OBSERVATION_RETAIN_LIMIT = 200;
const ORCHESTRATION_OBSERVATION_SUMMARY_MAX = 500;
const ORCHESTRATION_OBSERVATION_DETAILS_MAX_BYTES = 8 * 1024;

export function loadOrchestrationObservationsState(
  commonDir: string,
  config: WorkflowConfig,
  runId: string,
): OrchestrationObservationsState {
  assertSafeOrchestrationRunId(runId);
  const targetPath = orchestrationObservationsPath(commonDir, config, runId);
  const fallback: OrchestrationObservationsState = {
    runId,
    observations: [],
    compactedAt: null,
    droppedObservationCount: 0,
  };
  const raw = readVersionedJsonFile<OrchestrationObservationsState>('orchestrationObservations', commonDir, config, targetPath, fallback);
  return normalizeOrchestrationObservationsState(raw, runId);
}

export function saveOrchestrationObservationsState(
  commonDir: string,
  config: WorkflowConfig,
  state: OrchestrationObservationsState,
): OrchestrationObservationIndex {
  assertSafeOrchestrationRunId(state.runId);
  const targetPath = orchestrationObservationsPath(commonDir, config, state.runId);
  ensureInstallMarker(commonDir, config);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const compacted = compactOrchestrationObservations(state);
  writeVersionedJsonFile('orchestrationObservations', targetPath, compacted);
  return observationIndexForState(commonDir, config, compacted);
}

export function appendOrchestrationObservation(
  commonDir: string,
  config: WorkflowConfig,
  input: Omit<OrchestrationObservationRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
): { state: OrchestrationObservationsState; index: OrchestrationObservationIndex; observation: OrchestrationObservationRecord } {
  const state = loadOrchestrationObservationsState(commonDir, config, input.runId);
  const observation = sanitizeObservationRecord({
    ...input,
    id: input.id ?? `obs-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    createdAt: input.createdAt ?? nowIso(),
  });
  state.observations = [...state.observations, observation];
  const index = saveOrchestrationObservationsState(commonDir, config, state);
  const saved = loadOrchestrationObservationsState(commonDir, config, input.runId);
  return { state: saved, index, observation };
}

export function observationIndexForState(
  commonDir: string,
  config: WorkflowConfig,
  state: OrchestrationObservationsState,
): OrchestrationObservationIndex {
  const latest = state.observations.at(-1) ?? null;
  return {
    observationsPath: orchestrationStateRelativePath(commonDir, config, orchestrationObservationsPath(commonDir, config, state.runId)),
    latestObservationId: latest?.id ?? null,
    latestObservationKind: latest?.kind ?? null,
    observationCount: state.observations.length,
    compactedAt: state.compactedAt,
  };
}

function normalizeOrchestrationObservationsState(
  raw: OrchestrationObservationsState,
  runId: string,
): OrchestrationObservationsState {
  const observations = Array.isArray(raw?.observations)
    ? raw.observations.filter(isOrchestrationObservationRecord).map(sanitizeObservationRecord)
    : [];
  return {
    runId,
    observations,
    compactedAt: typeof raw?.compactedAt === 'string' ? raw.compactedAt : null,
    droppedObservationCount: typeof raw?.droppedObservationCount === 'number' && raw.droppedObservationCount > 0
      ? raw.droppedObservationCount
      : 0,
  };
}

function compactOrchestrationObservations(state: OrchestrationObservationsState): OrchestrationObservationsState {
  const sanitized = state.observations.filter(isOrchestrationObservationRecord).map(sanitizeObservationRecord);
  if (sanitized.length <= ORCHESTRATION_OBSERVATION_RETAIN_LIMIT) {
    return { ...state, observations: sanitized };
  }

  const selected = new Set<string>();
  const latestByKey = new Set<string>();
  const terminalByKey = new Set<string>();
  const reversed = [...sanitized].reverse();
  for (const observation of reversed) {
    const key = observationRetentionKey(observation);
    if (!latestByKey.has(key)) {
      latestByKey.add(key);
      selected.add(observation.id);
    }
    if (observation.terminal && !terminalByKey.has(key)) {
      terminalByKey.add(key);
      selected.add(observation.id);
    }
  }
  for (const observation of reversed) {
    if (selected.size >= ORCHESTRATION_OBSERVATION_RETAIN_LIMIT) break;
    selected.add(observation.id);
  }

  let retained = sanitized.filter((observation) => selected.has(observation.id));
  if (retained.length > ORCHESTRATION_OBSERVATION_RETAIN_LIMIT) {
    retained = retained.slice(-ORCHESTRATION_OBSERVATION_RETAIN_LIMIT);
  }
  return {
    ...state,
    observations: retained,
    compactedAt: nowIso(),
    droppedObservationCount: state.droppedObservationCount + (sanitized.length - retained.length),
  };
}

function observationRetentionKey(observation: OrchestrationObservationRecord): string {
  return [
    observation.kind,
    observation.sliceId ?? '',
    observation.gateId ?? '',
    observation.reasonCode,
  ].join('\0');
}

function sanitizeObservationRecord(record: OrchestrationObservationRecord): OrchestrationObservationRecord {
  const summary = record.summary.length > ORCHESTRATION_OBSERVATION_SUMMARY_MAX
    ? `${record.summary.slice(0, ORCHESTRATION_OBSERVATION_SUMMARY_MAX - 3)}...`
    : record.summary;
  const details = sanitizeObservationDetails(record.details);
  return {
    ...record,
    summary,
    ...(details ? { details } : {}),
  };
}

function sanitizeObservationDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  let json = JSON.stringify(details);
  if (Buffer.byteLength(json, 'utf8') <= ORCHESTRATION_OBSERVATION_DETAILS_MAX_BYTES) return details;
  const truncated = {
    truncated: true,
    preview: json.slice(0, ORCHESTRATION_OBSERVATION_DETAILS_MAX_BYTES),
  };
  json = JSON.stringify(truncated);
  return Buffer.byteLength(json, 'utf8') <= ORCHESTRATION_OBSERVATION_DETAILS_MAX_BYTES
    ? truncated
    : { truncated: true };
}

function isOrchestrationObservationRecord(value: unknown): value is OrchestrationObservationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Partial<OrchestrationObservationRecord>;
  return typeof raw.id === 'string'
    && typeof raw.runId === 'string'
    && (raw.sliceId === null || typeof raw.sliceId === 'string')
    && (raw.gateId === null || typeof raw.gateId === 'string')
    && isObservationKind(raw.kind)
    && isObservationReasonCode(raw.reasonCode)
    && typeof raw.summary === 'string'
    && (raw.details === undefined || (typeof raw.details === 'object' && raw.details !== null && !Array.isArray(raw.details)))
    && typeof raw.terminal === 'boolean'
    && typeof raw.createdAt === 'string';
}

function isObservationKind(value: unknown): value is OrchestrationObservationKind {
  return typeof value === 'string' && ORCHESTRATION_OBSERVATION_KINDS.includes(value as OrchestrationObservationKind);
}

function isObservationReasonCode(value: unknown): value is OrchestrationObservationReasonCode {
  return typeof value === 'string' && ORCHESTRATION_OBSERVATION_REASON_CODES.includes(value as OrchestrationObservationReasonCode);
}

export function loadOrchestrationRunRecord(
  commonDir: string,
  config: WorkflowConfig,
  runId: string,
): OrchestrationRunRecord | null {
  const diagnostic = diagnoseOrchestrationRunRecord(commonDir, config, runId);
  if (diagnostic.status === 'missing') return null;
  if (diagnostic.status === 'valid') return diagnostic.record;
  throw new Error(diagnostic.reason);
}

export function loadUnsignedLegacyOrchestrationRunRecord(
  commonDir: string,
  config: WorkflowConfig,
  runId: string,
): OrchestrationRunRecord | null {
  assertSafeOrchestrationRunId(runId);
  const targetPath = orchestrationRunPath(commonDir, config, runId);
  if (!existsSync(targetPath)) return null;
  const parsed = readRawJsonFile(targetPath);
  if (!isPlainObject(parsed)) {
    throw new Error('legacy unsigned orchestration ledger JSON does not match the orchestration run schema.');
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.signature !== undefined || raw.integrity !== undefined) {
    throw new Error(`orchestrate upgrade-ledger --reseal-unsigned only trusts legacy unsigned ledgers; ${runId} already has signed ledger metadata.`);
  }
  const normalized = normalizeVersionedJsonValue<unknown>('orchestrationRun', raw);
  if (!isUnsignedLegacyOrchestrationRunRecord(normalized)) {
    throw new Error('legacy unsigned orchestration ledger JSON does not match the orchestration run schema.');
  }
  if (normalized.id !== runId) {
    throw new Error(`legacy unsigned orchestration ledger run id mismatch: directory is ${runId}, ledger is ${normalized.id}.`);
  }
  return normalized;
}

export function diagnoseOrchestrationRunRecord(
  commonDir: string,
  config: WorkflowConfig,
  runId: string,
): OrchestrationLedgerDiagnostic {
  if (!isSafeOrchestrationRunId(runId)) {
    return {
      status: 'invalid-run-id',
      runId,
      ledgerPath: null,
      mtimeMs: null,
      reason: `Invalid orchestration run id: ${runId}`,
    };
  }
  return diagnoseOrchestrationRunPath(commonDir, config, runId, orchestrationRunPath(commonDir, config, runId));
}

export function scanOrchestrationRunDiagnostics(
  commonDir: string,
  config: WorkflowConfig,
): OrchestrationRunScanDiagnostics {
  const runsRoot = orchestrationRunsRoot(commonDir, config);
  const valid: Extract<OrchestrationLedgerDiagnostic, { status: 'valid' }>[] = [];
  const corrupt: Extract<OrchestrationLedgerDiagnostic, { status: 'corrupt' }>[] = [];
  const invalidDirectories: OrchestrationRunDirectoryDiagnostic[] = [];
  if (!existsSync(runsRoot)) {
    return { records: [], valid, corrupt, invalidDirectories };
  }

  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directoryPath = path.join(runsRoot, entry.name);
    const targetPath = path.join(directoryPath, 'orchestration.json');
    if (!isSafeOrchestrationRunId(entry.name)) {
      invalidDirectories.push({
        status: 'invalid-run-directory',
        runId: entry.name,
        directoryPath,
        ledgerPath: existsSync(targetPath) ? targetPath : null,
        mtimeMs: statMtimeMs(existsSync(targetPath) ? targetPath : directoryPath),
        reason: 'directory name is not an addressable orchestration run id',
      });
      continue;
    }

    const diagnostic = diagnoseOrchestrationRunPath(commonDir, config, entry.name, targetPath);
    if (diagnostic.status === 'valid') valid.push(diagnostic);
    if (diagnostic.status === 'corrupt') corrupt.push(diagnostic);
  }

  valid.sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt));
  corrupt.sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0));
  invalidDirectories.sort((left, right) => (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0));
  return {
    records: valid.map((entry) => entry.record),
    valid,
    corrupt,
    invalidDirectories,
  };
}

export function listOrchestrationRunRecords(commonDir: string, config: WorkflowConfig): OrchestrationRunRecord[] {
  return scanOrchestrationRunDiagnostics(commonDir, config).records;
}

function orchestrationRunsRoot(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), 'orchestrate', 'runs');
}

function diagnoseOrchestrationRunPath(
  commonDir: string,
  config: WorkflowConfig,
  runId: string,
  targetPath: string,
): OrchestrationLedgerDiagnostic {
  if (!existsSync(targetPath)) {
    const interrupted = interruptedTempFileReason(targetPath, 'orchestration ledger');
    return {
      status: 'missing',
      runId,
      ledgerPath: targetPath,
      mtimeMs: null,
      reason: interrupted ?? 'orchestration ledger file is missing',
    };
  }

  const mtimeMs = statMtimeMs(targetPath);
  let parsed: unknown;
  try {
    parsed = readRawJsonFile(targetPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        status: 'corrupt',
        runId,
        ledgerPath: targetPath,
        mtimeMs,
        reason: `malformed JSON: ${error.message}`,
      };
    }
    throw error;
  }

  if (!isPlainObject(parsed)) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: 'ledger JSON does not match the orchestration run schema',
    };
  }

  const envelope = parsed as Record<string, unknown>;
  const unsignedLegacyReason = legacyUnsignedLedgerReason(envelope);
  if (unsignedLegacyReason) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: unsignedLegacyReason,
    };
  }

  const signatureReason = malformedSignatureReason(envelope.signature, 'ledger signature');
  if (signatureReason) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: signatureReason,
    };
  }

  if (!isOrchestrationRunIntegrity(envelope.integrity)) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: 'ledger integrity metadata is missing or malformed',
    };
  }
  const integrity = envelope.integrity;
  if (envelope.id !== runId || integrity.runId !== runId) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: `orchestration run id mismatch: directory is ${runId}, ledger is ${String(envelope.id)}, integrity is ${integrity.runId}`,
    };
  }

  let key: string;
  let fingerprint: string;
  try {
    key = resolveOrchestrationStateKey();
    fingerprint = stateKeyFingerprint(key);
  } catch (error) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!verifySignedPayload(envelope as unknown as OrchestrationRunDiskEnvelope, key)) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: integrity.keyFingerprint !== fingerprint
        ? `wrong ${ORCHESTRATION_STATE_KEY_ENV}: ledger was sealed with a different key fingerprint`
        : 'orchestration ledger signature verification failed; ledger contents may have been tampered with',
    };
  }

  if (integrity.keyFingerprint !== fingerprint) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: `wrong ${ORCHESTRATION_STATE_KEY_ENV}: ledger key fingerprint does not match the configured key`,
    };
  }

  const normalized = normalizeVersionedJsonValue<unknown>('orchestrationRun', envelope);
  if (!isOrchestrationRunRecord(normalized)) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: 'ledger JSON does not match the orchestration run schema',
    };
  }

  const headReason = verifyOrchestrationIntegrityHead(commonDir, config, normalized, key, fingerprint);
  if (headReason) {
    return {
      status: 'corrupt',
      runId,
      ledgerPath: targetPath,
      mtimeMs,
      reason: headReason,
    };
  }

  return {
    status: 'valid',
    runId,
    ledgerPath: targetPath,
    mtimeMs: mtimeMs ?? 0,
    record: normalized,
  };
}

function readRawJsonFile(targetPath: string): unknown {
  return JSON.parse(readFileSync(targetPath, 'utf8')) as unknown;
}

function legacyUnsignedLedgerReason(envelope: Record<string, unknown>): string | null {
  if (envelope.signature === undefined && envelope.integrity === undefined) {
    return 'legacy unsigned orchestration ledger is untrusted by default; run orchestrate upgrade-ledger --reseal-unsigned --reason <text> --i-understand-this-trusts-local-state to reseal it explicitly.';
  }
  if (envelope.signature === undefined) return 'ledger signature is missing';
  return null;
}

const HEX_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;

function malformedSignatureReason(value: unknown, label: string): string | null {
  if (value === undefined) return `${label} is missing`;
  if (value === null) return `${label} is null`;
  if (typeof value !== 'string') return `${label} must be a hex string`;
  if (value.length === 0) return `${label} is empty`;
  if (value.length !== 64) return `${label} has invalid length ${value.length}; expected 64 hex characters`;
  if (!HEX_SIGNATURE_PATTERN.test(value)) return `${label} is not hex encoded`;
  return null;
}

function verifyOrchestrationIntegrityHead(
  commonDir: string,
  config: WorkflowConfig,
  record: OrchestrationRunRecord,
  key: string,
  fingerprint: string,
): string | null {
  const targetPath = orchestrationIntegrityHeadPath(commonDir, config, record.id);
  if (!existsSync(targetPath)) {
    return interruptedTempFileReason(targetPath, 'orchestration integrity head')
      ?? `orchestration integrity head is missing for ${record.id}`;
  }

  let parsed: unknown;
  try {
    parsed = readRawJsonFile(targetPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return `malformed orchestration integrity head JSON: ${error.message}`;
    }
    throw error;
  }
  if (!isPlainObject(parsed)) return 'orchestration integrity head JSON does not match the expected schema';
  const head = parsed as Record<string, unknown>;
  const signatureReason = malformedSignatureReason(head.signature, 'integrity head signature');
  if (signatureReason) return signatureReason;
  if (!isOrchestrationRunIntegrityHead(head)) {
    return 'orchestration integrity head JSON does not match the expected schema';
  }
  if (!verifySignedPayload(head as OrchestrationRunIntegrityHead, key)) {
    return head.keyFingerprint !== fingerprint
      ? `wrong ${ORCHESTRATION_STATE_KEY_ENV}: integrity head was sealed with a different key fingerprint`
      : 'orchestration integrity head signature verification failed; rollback metadata may have been tampered with';
  }
  if (!record.integrity || !record.signature) return 'signed ledger metadata is missing after verification';
  if (head.runId !== record.id) {
    return `orchestration integrity head run id mismatch: expected ${record.id}, got ${head.runId}`;
  }
  if (head.keyFingerprint !== fingerprint || head.keyFingerprint !== record.integrity.keyFingerprint) {
    return `wrong ${ORCHESTRATION_STATE_KEY_ENV}: integrity head key fingerprint does not match the ledger and configured key`;
  }
  if (head.mutationIndex > record.integrity.mutationIndex) {
    return `orchestration ledger rollback detected: integrity head expects mutationIndex ${head.mutationIndex}, ledger has ${record.integrity.mutationIndex}`;
  }
  if (head.mutationIndex < record.integrity.mutationIndex) {
    return `interrupted orchestration ledger save detected: ledger mutationIndex ${record.integrity.mutationIndex} is newer than integrity head ${head.mutationIndex}`;
  }
  if (head.ledgerSignature !== record.signature) {
    return 'orchestration ledger rollback or transplant detected: integrity head signature does not match the ledger signature';
  }
  return null;
}

function isOrchestrationRunIntegrity(value: unknown): value is OrchestrationRunIntegrity {
  if (!isPlainObject(value)) return false;
  const raw = value as Partial<OrchestrationRunIntegrity>;
  return raw.version === 1
    && typeof raw.runId === 'string'
    && Number.isSafeInteger(raw.mutationIndex)
    && raw.mutationIndex >= 1
    && typeof raw.keyFingerprint === 'string'
    && /^[a-f0-9]{16}$/i.test(raw.keyFingerprint);
}

function isOrchestrationRunIntegrityHead(value: unknown): value is OrchestrationRunIntegrityHead {
  if (!isPlainObject(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === 1
    && typeof raw.runId === 'string'
    && Number.isSafeInteger(raw.mutationIndex)
    && typeof raw.mutationIndex === 'number'
    && raw.mutationIndex >= 1
    && typeof raw.ledgerSignature === 'string'
    && HEX_SIGNATURE_PATTERN.test(raw.ledgerSignature)
    && typeof raw.keyFingerprint === 'string'
    && /^[a-f0-9]{16}$/i.test(raw.keyFingerprint)
    && typeof raw.signature === 'string'
    && HEX_SIGNATURE_PATTERN.test(raw.signature);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function interruptedTempFileReason(targetPath: string, label: string): string | null {
  const dir = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const temp = entries.find((entry) => entry.startsWith(`.${basename}.tmp-`));
  return temp ? `interrupted ${label} save detected: temporary file remains at ${path.join(dir, temp)}` : null;
}

function statMtimeMs(targetPath: string): number | null {
  try {
    return statSync(targetPath).mtimeMs;
  } catch {
    return null;
  }
}

function isOrchestrationRunRecord(value: unknown): value is OrchestrationRunRecord {
  return isOrchestrationRunRecordShape(value, true);
}

function isUnsignedLegacyOrchestrationRunRecord(value: unknown): value is OrchestrationRunRecord {
  return isOrchestrationRunRecordShape(value, false);
}

function isOrchestrationRunRecordShape(value: unknown, requireSigned: boolean): value is OrchestrationRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<OrchestrationRunRecord>;
  if (!isSafeOrchestrationRunId(typeof record.id === 'string' ? record.id : '')) return false;
  if (requireSigned) {
    if (malformedSignatureReason(record.signature, 'ledger signature')) return false;
    if (!isOrchestrationRunIntegrity(record.integrity)) return false;
    if (record.integrity.runId !== record.id) return false;
  } else if (record.signature !== undefined || record.integrity !== undefined) {
    return false;
  }
  if (!['planned', 'prepared', 'dispatched', 'running', 'blocked', 'paused', 'completed', 'failed'].includes(record.status ?? '')) return false;
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return false;
  if (typeof record.branchName !== 'string' || typeof record.sha !== 'string') return false;
  if (!record.source || typeof record.source !== 'object') return false;
  if (!record.plan || typeof record.plan !== 'object') return false;
  if (!Array.isArray(record.slices)) return false;
  return record.slices.every(isOrchestrationSliceRecord);
}

function isOrchestrationSliceRecord(value: unknown): value is OrchestrationSliceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const slice = value as Partial<OrchestrationSliceRecord>;
  return typeof slice.id === 'string'
    && typeof slice.index === 'number'
    && ['planned', 'prepared', 'dispatched', 'running', 'blocked', 'completed', 'empty', 'failed'].includes(slice.status ?? '')
    && typeof slice.outcome === 'string'
    && Array.isArray(slice.dependsOn)
    && Array.isArray(slice.requestedFiles)
    && Array.isArray(slice.forbiddenFiles)
    && (slice.worktreePath === null || typeof slice.worktreePath === 'string' || slice.worktreePath === undefined)
    && (slice.branchName === null || typeof slice.branchName === 'string' || slice.branchName === undefined)
    && typeof slice.provider === 'string';
}

export function isActiveOrchestrationRun(
  record: OrchestrationRunRecord,
  options: OrchestrationReviewSatisfactionOptions = {},
): boolean {
  if (record.status !== 'completed') return true;
  const runOptions = { ...options, runId: record.id };
  return record.slices.some((slice) =>
    slice.worker?.status === 'succeeded'
    && !sliceReviewFullySatisfied(slice, runOptions)
    && sliceWorktreeExists(slice, options),
  );
}

export interface OrchestrationReviewSatisfactionOptions {
  headCache?: Map<string, string | null>;
  statusDigestCache?: Map<string, { digest: string; reliable: boolean } | null>;
  worktreeExistsCache?: Map<string, boolean>;
  // C2: verify the embedded review signature + binding on read. `reviewStateKey`
  // defaults to the env key (`resolveReviewStateKey`) when omitted; when no key is
  // configured signing is off and the signature is not enforced. `runId` lets the
  // read path enforce the run-id half of the binding — callers that have the run
  // pass it; callers that do not (e.g. unit calls) fall back to the worktree/branch
  // bindings, which already pin a record to one context.
  reviewStateKey?: string;
  runId?: string;
}

// C2: build the anti-replay binding for an embedded review record from the live
// run/slice/reviewRun context. Every field is also reconstructable on read, so the
// verifier can re-derive and compare them.
export function buildOrchestrationSliceReviewBinding(
  runId: string,
  slice: OrchestrationSliceRecord,
  reviewRun: ReviewRunRecord,
): OrchestrationSliceReviewBinding {
  return {
    runId,
    sliceId: slice.id,
    workerSessionId: slice.worker?.identity?.sessionId ?? null,
    branchName: slice.branchName ?? null,
    worktreePath: slice.worktreePath ?? null,
    sha: reviewRun.sha ?? null,
    worktreeStatusDigest: reviewRun.worktreeStatusDigest ?? null,
  };
}

// C2: sign an embedded review record in place, bound to its context. Returns the
// record unchanged when no review-state key is configured (signing is opt-in via
// the key, consistent with appendReviewRunRecord). The HMAC covers the whole
// record (verdict + binding) minus `signature`, so tampering any field is detected.
export function signOrchestrationSliceReview(
  record: OrchestrationSliceReviewRecord,
  runId: string,
  slice: OrchestrationSliceRecord,
  key: string | undefined = resolveReviewStateKey(),
): OrchestrationSliceReviewRecord {
  if (!key) return record;
  const bound: OrchestrationSliceReviewRecord = {
    ...record,
    binding: buildOrchestrationSliceReviewBinding(runId, slice, record.run),
  };
  return { ...bound, signature: signSignedPayload(bound, key) };
}

// C2: verify the embedded review signature + anti-replay binding. Returns true
// (block completion) when a review-state key is configured AND: the record is
// unsigned (reject-unsigned-when-active), the signature does not verify (tamper or
// forgery — the worker lacks the key), or any bound field no longer matches the
// live context (replay from another run/slice/worker/branch/worktree/commit/tree).
// When no key is configured signing is off and this is a no-op, preserving pre-C2
// behavior and legacy ledgers until the operator opts in (sets the key) and, if
// needed, runs `orchestrate upgrade-ledger`. The run-id half is enforced only when
// the caller supplies `options.runId`; the worktree/branch bindings already pin a
// record to one context for callers that cannot.
function sliceReviewSignatureBlocker(
  slice: OrchestrationSliceRecord,
  reviewRun: ReviewRunRecord,
  options: OrchestrationReviewSatisfactionOptions,
): boolean {
  const key = options.reviewStateKey ?? resolveReviewStateKey();
  if (!key) return false;
  const review = slice.review;
  if (!review?.signature || !review.binding) return true;
  if (!verifySignedPayload(review, key)) return true;
  const binding = review.binding;
  return binding.sliceId !== slice.id
    || binding.workerSessionId !== (slice.worker?.identity?.sessionId ?? null)
    || binding.branchName !== (slice.branchName ?? null)
    || binding.worktreePath !== (slice.worktreePath ?? null)
    || binding.sha !== (reviewRun.sha ?? null)
    || binding.worktreeStatusDigest !== (reviewRun.worktreeStatusDigest ?? null)
    || (options.runId !== undefined && binding.runId !== options.runId);
}

export function sliceReviewFullySatisfied(
  slice: OrchestrationSliceRecord,
  options: OrchestrationReviewSatisfactionOptions = {},
): boolean {
  const reviewRun = slice.review?.run;
  if (slice.worker?.status !== 'succeeded') return false;
  // B1 (Decision 2): an `empty` slice is never completion-satisfied, even if its
  // gates passed on the unchanged worktree. The run cannot complete with an
  // in-scope empty slice; the remedy is re-dispatch with a sharper goal, or defer.
  if (slice.status === 'empty') return false;
  if (reviewRun?.status !== 'passed') return false;
  if (
    reviewRun.dryRun
    || reviewRun.gateFilter
    || reviewRun.phaseFilter
    || !reviewRun.sha
  ) {
    return false;
  }
  // FU1: advisory NEGATIVE-only evidence. These can only WITHHOLD completion; they are
  // never positive evidence. `reviewDiagnostics` are unsigned and unverified on read, so
  // the first block is suppressible by a ledger-writing worker — acceptable because the
  // signed `slice.review` checked below is the unforgeable positive gate (deleting a
  // diagnostic only reverts to it, never fabricates a pass). The second reads
  // `slice.review`, which the C2 signature check below independently protects.
  if (sliceHasRejectedBlockingAiDiagnostic(slice)) return false;
  if (sliceReviewHasUntrustedBlockingAiEvidence(slice)) return false;
  // C2: the embedded verdict must carry a valid signature bound to this exact
  // context (when a review-state key is configured). This gates every positive
  // return below — including the cleaned-worktree branch — so a tampered or
  // replayed `slice.review` can never satisfy completion.
  if (sliceReviewSignatureBlocker(slice, reviewRun, options)) return false;

  if (!slice.worktreePath || !sliceWorktreeExists(slice, options)) {
    return slice.status === 'completed';
  }
  if (!reviewRun.worktreeStatusDigest || reviewRun.worktreeStatusReliable !== true) {
    return false;
  }
  const currentHead = currentSliceHead(slice, options);
  if (!currentHead) return false;
  if (reviewRun.sha !== currentHead) return false;
  const currentStatus = currentSliceStatusDigest(slice, options);
  return currentStatus !== null
    && currentStatus.reliable
    && reviewRun.worktreeStatusDigest === currentStatus.digest;
}

// FU2: a once-completed slice that would satisfy completion EXCEPT that its embedded
// review evidence predates signing, the review-state key is now configured, and its
// worktree has been cleaned (so a fresh re-review is impossible). `orchestrate
// upgrade-ledger` signs the persisted verdict in place — the correct remedy here.
// Scoped deliberately so the cockpit only ever advertises upgrade-ledger when it is
// both safe and sufficient:
//   - legacy-UNSIGNED only (`!review.signature`): a record whose signature is PRESENT
//     but fails verification is tampered/replayed, not legacy. upgrade-ledger re-signs
//     in place and would launder such a record, so it must never be offered as the fix;
//     that record stays blocked.
//   - worktree GONE only: with a worktree present the run is still active and the honest
//     remedy is re-review (re-runs the gates and re-signs), handled by the review
//     next-action — not this trust-the-persisted-verdict migration.
// Every other completion precondition (mirrors `sliceReviewFullySatisfied`) must already
// hold, so the missing signature is genuinely the sole remaining blocker. Without a key
// there is no migration concept, so this is a no-op (preserving pre-C2 behavior).
export function sliceReviewNeedsSignatureMigration(
  slice: OrchestrationSliceRecord,
  options: OrchestrationReviewSatisfactionOptions = {},
): boolean {
  const key = options.reviewStateKey ?? resolveReviewStateKey();
  if (!key) return false;
  const review = slice.review;
  const reviewRun = review?.run;
  if (slice.worker?.status !== 'succeeded') return false;
  if (slice.status !== 'completed') return false;
  if (!review || !reviewRun) return false;
  if (review.signature) return false;
  if (reviewRun.status !== 'passed') return false;
  if (reviewRun.dryRun || reviewRun.gateFilter || reviewRun.phaseFilter || !reviewRun.sha) {
    return false;
  }
  if (sliceHasRejectedBlockingAiDiagnostic(slice)) return false;
  if (sliceReviewHasUntrustedBlockingAiEvidence(slice)) return false;
  if (slice.worktreePath && sliceWorktreeExists(slice, options)) return false;
  return true;
}

// FU2: a completed run silently drops out of the cockpit once the key is enabled if
// every in-scope succeeded slice is unsigned-and-worktree-cleaned (it is then neither
// active nor PR-ready). Surface such a run so the operator is told to run `orchestrate
// upgrade-ledger` instead of the run vanishing.
export function orchestrationRunNeedsLedgerMigration(
  run: OrchestrationRunRecord,
  options: OrchestrationReviewSatisfactionOptions = {},
): boolean {
  if (run.status !== 'completed') return false;
  return selectActiveSlices(run).some((slice) => sliceReviewNeedsSignatureMigration(slice, options));
}

export function missingRelevantSliceWorktreeDiagnostic(
  slice: OrchestrationSliceRecord,
  options: OrchestrationReviewSatisfactionOptions = {},
): OrchestrationMissingWorktreeDiagnostic | null {
  if (!slice.worktreePath) return null;
  if (!sliceWorktreeShouldBeUsable(slice)) return null;
  if (sliceWorktreeExists(slice, options)) return null;
  return {
    sliceId: slice.id,
    status: slice.status,
    branchName: slice.branchName,
    worktreePath: slice.worktreePath,
    reason: `assigned worktree is missing: ${slice.worktreePath}`,
  };
}

function sliceWorktreeShouldBeUsable(slice: OrchestrationSliceRecord): boolean {
  return slice.status === 'prepared'
    || slice.status === 'dispatched'
    || slice.status === 'running'
    || (slice.status === 'planned' && Boolean(slice.worktreePath));
}

// FU1: reads UNSIGNED, advisory `reviewDiagnostics` (negative-only evidence). A
// diagnostic recorded after the active review that "passed" yet carries untrusted
// blocking AI evidence withholds completion. This block is intentionally suppressible
// (the entries are not signature-verified): a worker deleting one only reverts to the
// signed `slice.review`, which it cannot forge — so this can subtract trust, never add
// it. See the `reviewDiagnostics` field doc on `OrchestrationSliceRecord`.
function sliceHasRejectedBlockingAiDiagnostic(slice: OrchestrationSliceRecord): boolean {
  const activeReviewTime = slice.review?.reviewedAt ?? '';
  return (slice.reviewDiagnostics ?? []).some((diagnostic) =>
    diagnosticIsNewerThanActiveReview(diagnostic, activeReviewTime)
    && diagnostic.run.status === 'passed'
    && blockingAiReviewEvidenceBlocker({
      reviewRun: diagnostic.run,
      worker: slice.worker?.identity ?? null,
    }) !== null
  );
}

function diagnosticIsNewerThanActiveReview(
  diagnostic: OrchestrationSliceReviewRecord,
  activeReviewTime: string,
): boolean {
  return !activeReviewTime || diagnostic.reviewedAt > activeReviewTime;
}

function sliceReviewHasUntrustedBlockingAiEvidence(slice: OrchestrationSliceRecord): boolean {
  if (!slice.review) return false;
  return blockingAiReviewEvidenceBlocker({
    reviewRun: slice.review.run,
    worker: slice.worker?.identity ?? null,
  }) !== null;
}

export function assertSafeOrchestrationRunId(runId: string): void {
  if (!isSafeOrchestrationRunId(runId)) {
    throw new Error(`Invalid orchestration run id: ${runId}`);
  }
}

function isSafeOrchestrationRunId(runId: string): boolean {
  return /^orchestrate-\d{14}-[a-f0-9]{8}$/.test(runId);
}

function currentSliceHead(slice: OrchestrationSliceRecord, options: OrchestrationReviewSatisfactionOptions): string | null {
  if (!slice.worktreePath || !sliceWorktreeExists(slice, options)) return null;
  if (options.headCache?.has(slice.worktreePath)) return options.headCache.get(slice.worktreePath) ?? null;
  const head = runGit(slice.worktreePath, ['rev-parse', '--verify', 'HEAD'], true)?.trim() || null;
  options.headCache?.set(slice.worktreePath, head);
  return head;
}

function currentSliceStatusDigest(
  slice: OrchestrationSliceRecord,
  options: OrchestrationReviewSatisfactionOptions,
): { digest: string; reliable: boolean } | null {
  if (!slice.worktreePath || !sliceWorktreeExists(slice, options)) return null;
  if (options.statusDigestCache?.has(slice.worktreePath)) {
    return options.statusDigestCache.get(slice.worktreePath) ?? null;
  }
  const snapshot = readWorktreeStatusSnapshot(slice.worktreePath, { includeStatusDigest: true });
  const status = snapshot.exists
    ? { digest: snapshot.statusDigest, reliable: snapshot.statusDigestReliable }
    : null;
  options.statusDigestCache?.set(slice.worktreePath, status);
  return status;
}

export function sliceWorktreeExists(slice: OrchestrationSliceRecord, options: OrchestrationReviewSatisfactionOptions = {}): boolean {
  if (!slice.worktreePath) return false;
  if (options.worktreeExistsCache?.has(slice.worktreePath)) return options.worktreeExistsCache.get(slice.worktreePath) ?? false;
  const exists = existsSync(slice.worktreePath);
  options.worktreeExistsCache?.set(slice.worktreePath, exists);
  return exists;
}

function resolvePlanSections(planText: string, outcome: string | undefined): { globalText: string; slices: PlanSliceSource[] } {
  const ledgerSections = extractExplicitSliceLedgerSections(planText, 'slice-ledger');
  if (ledgerSections.slices.length > 0) return ledgerSections;

  const sections = extractExplicitSliceSections(planText);
  if (sections.slices.length > 0) return sections;

  const workerSections = extractExplicitSliceLedgerSections(planText, 'worker-slices');
  if (workerSections.slices.length > 0) return workerSections;

  const title = outcome?.trim() || inferPlanTitle(planText) || 'Orchestration slice';
  return {
    globalText: '',
    slices: [{
      title,
      text: planText || `# ${title}`,
    }],
  };
}

function extractExplicitSliceLedgerSections(
  planText: string,
  acceptedMarkerKind: 'slice-ledger' | 'worker-slices',
): { globalText: string; slices: PlanSliceSource[] } {
  if (!planText.trim()) return { globalText: '', slices: [] };
  const lines = planText.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const markerKind = sliceLedgerMarkerKind(lines[index]);
    if (markerKind !== acceptedMarkerKind) continue;

    const parsed = parseSliceLedgerList(lines, index, markerKind);
    if (parsed.slices.length < 2) continue;

    const globalText = [
      ...lines.slice(0, index),
      ...lines.slice(parsed.endIndex),
    ].join('\n').trim();
    const sections = { globalText, slices: parsed.slices };
    return sections;
  }

  return { globalText: '', slices: [] };
}

function sliceLedgerMarkerKind(line: string): 'slice-ledger' | 'worker-slices' | null {
  const trimmed = line.trim();
  const normalized = cleanHeading(trimmed.replace(/^#{1,6}\s+/, '').replace(/:$/, ''));
  if (/^(?:expected\s+)?slice\s+ledger$/i.test(normalized)) return 'slice-ledger';
  if (/^worker\s+slices$/i.test(normalized) || (/:$/.test(trimmed) && /\bworker\s+slices\b/i.test(normalized))) return 'worker-slices';
  return null;
}

function parseSliceLedgerList(
  lines: string[],
  markerIndex: number,
  markerKind: 'slice-ledger' | 'worker-slices',
): { endIndex: number; slices: PlanSliceSource[] } {
  const slices: PlanSliceSource[] = [];
  let index = markerIndex + 1;
  let sawListItem = false;
  let topLevelIndent: number | null = null;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed && !sawListItem) continue;
    if (!trimmed && sawListItem) break;
    if (/^#{1,6}\s+\S/.test(trimmed)) break;

    const bullet = /^(\s*)(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
    if (!bullet) {
      const indent = (/^(\s*)/.exec(line)?.[1] ?? '').length;
      if (sawListItem && topLevelIndent !== null && indent > topLevelIndent) {
        const previousSlice = slices.at(-1);
        if (previousSlice) previousSlice.text += `\n${line}`;
        continue;
      }
      if (sawListItem) break;
      continue;
    }

    const indent = (bullet[1] ?? '').length;
    topLevelIndent ??= indent;
    if (indent > topLevelIndent) {
      const previousSlice = slices.at(-1);
      if (previousSlice) previousSlice.text += `\n${line}`;
      continue;
    }
    if (indent < topLevelIndent) break;

    sawListItem = true;
    const entry = parseSliceLedgerEntry(bullet[2] ?? '');
    if (!entry || (markerKind === 'worker-slices' && isCoordinatorLedgerEntry(entry.title, entry.description))) continue;
    slices.push({
      title: entry.title,
      text: [
        `## Slice: ${entry.title}`,
        `- ${entry.description || entry.title}`,
      ].join('\n'),
    });
  }

  return { endIndex: index, slices };
}

function parseSliceLedgerEntry(value: string): { title: string; description: string } | null {
  const cleaned = cleanLine(value);
  if (!cleaned) return null;

  const explicitId = /^`?([A-Za-z][A-Za-z0-9_-]{1,127})`?\s*:\s*(.+)$/.exec(cleaned);
  if (explicitId) {
    return {
      title: cleanHeading(explicitId[1] ?? ''),
      description: cleanLine(explicitId[2] ?? ''),
    };
  }

  return {
    title: cleanHeading(cleaned),
    description: '',
  };
}

function isCoordinatorLedgerEntry(title: string, description: string): boolean {
  return /^(?:coordinator\b|integration phase\b|final verification\b)/i.test(`${title} ${description}`);
}

function extractExplicitSliceSections(planText: string): { globalText: string; slices: PlanSliceSource[] } {
  if (!planText.trim()) return { globalText: '', slices: [] };
  const lines = planText.split(/\r?\n/);
  const slices: PlanSliceSource[] = [];
  const globalLines: string[] = [];
  let current: { title: string; level: number; lines: string[] } | null = null;

  for (const line of lines) {
    const heading = /^(#{2,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      const title = cleanHeading(heading[2]);
      const isSliceHeading = /^(slice|step|phase)\b/i.test(title);
      if (current && level <= current.level) {
        slices.push({
          title: current.title,
          text: current.lines.join('\n').trim(),
        });
        current = null;
      }
      if (isSliceHeading && !current) {
        current = {
          title: title.replace(/^(slice|step|phase)\s*\d*[.:)-]?\s*/i, '').trim() || title,
          level,
          lines: [line],
        };
        continue;
      }
    }
    if (current) {
      current.lines.push(line);
    } else {
      globalLines.push(line);
    }
  }

  if (current) {
    slices.push({
      title: current.title,
      text: current.lines.join('\n').trim(),
    });
  }

  return {
    globalText: globalLines.join('\n').trim(),
    slices: slices.filter((slice) => slice.title.length > 0 && slice.text.length > 0),
  };
}

function inferPlanTitle(planText: string): string {
  const heading = planText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S/.test(line));
  return heading ? cleanHeading(heading.replace(/^#{1,6}\s+/, '')) : '';
}

function cleanHeading(value: string): string {
  return value.replace(/[#`*_]+/g, '').replace(/\s+/g, ' ').trim();
}

function extractPathHints(text: string): string[] {
  const out: string[] = [];
  for (const value of collectCodeSpanPathHints(text)) pushNormalizedPathHint(out, value);
  for (const value of collectBarePathHints(text)) pushNormalizedPathHint(out, value);
  return [...new Set(out)].sort();
}

function buildSliceGoalPlanText(sliceText: string, globalText: string): string {
  const combinedText = [globalText, sliceText].filter((part) => part.trim()).join('\n\n');
  const slicePreferredBullets = extractActionableBulletsFromLabeledBlocks(sliceText, [
    'acceptance criteria',
    'finish line',
    'done when',
    'tasks',
    'required semantics',
    'implementation shape',
  ]);
  const sliceActionableBullets = extractActionableBullets(sliceText);
  const globalFinishLineItems = extractFinishLineItemsFromLabeledBlocks(globalText, [
    'run outcome',
    'global constraints',
    'constraints',
    'requirements',
    'guardrails',
  ]);
  const finishLineItems = normalizeList([
    ...slicePreferredBullets,
    ...sliceActionableBullets,
    ...extractProseContextLines(sliceText),
    ...globalFinishLineItems,
    ...(sliceActionableBullets.length === 0 && globalFinishLineItems.length === 0 ? extractProseContextLines(combinedText) : []),
  ]);
  if (finishLineItems.length === 0) return combinedText || sliceText;
  return [
    '## Finish line',
    ...finishLineItems.map((item) => `- ${item}`),
    '',
    '## Source context',
    combinedText,
  ].join('\n');
}

function buildGlobalPlanContext(globalText: string, prompt: string | null): string {
  return [
    prompt ? `## Run outcome\n- ${prompt}` : '',
    globalText,
  ].filter((part) => part.trim()).join('\n\n');
}

function extractActionableBullets(text: string): string[] {
  return normalizeList(text.split(/\r?\n/).map(parseBullet));
}

function extractFinishLineItemsFromLabeledBlocks(text: string, labels: string[]): string[] {
  const blockLines = extractLinesFromLabeledBlocks(text, labels);
  return normalizeList([
    ...blockLines.map(parseBullet),
    ...blockLines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !parseBullet(line)),
  ]);
}

function extractActionableBulletsFromLabeledBlocks(text: string, labels: string[]): string[] {
  return normalizeList(extractLinesFromLabeledBlocks(text, labels).map(parseBullet));
}

function extractLinesFromLabeledBlocks(text: string, labels: string[]): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  let headingLevel = 0;
  let plainLabelBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const title = cleanHeading(heading[2] ?? '').toLowerCase();
      if (inBlock && !plainLabelBlock && level <= headingLevel) inBlock = false;
      if (inBlock && plainLabelBlock) inBlock = false;
      if (labels.some((label) => title.includes(label))) {
        inBlock = true;
        headingLevel = level;
        plainLabelBlock = false;
      }
      continue;
    }

    const plainLabel = /^([A-Za-z][A-Za-z0-9 /_-]+):$/.exec(trimmed);
    if (plainLabel) {
      const title = cleanHeading(plainLabel[1] ?? '').toLowerCase();
      inBlock = labels.some((label) => title.includes(label));
      headingLevel = 7;
      plainLabelBlock = inBlock;
      continue;
    }

    if (!inBlock) continue;
    out.push(line);
  }

  return out;
}

function extractProseContextLines(text: string): string[] {
  return normalizeList(text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s+/.test(line) && !parseBullet(line)));
}

function parseBullet(line: string): string {
  const checkbox = /^\s*(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+(.+)$/.exec(line)
    ?? /^\s*\[[ xX]\]\s+(.+)$/.exec(line);
  if (checkbox) return cleanLine(checkbox[1]);

  const match = /^\s*(?:[-*]|\d+[.)]|\[[ xX]\])\s+(.+)$/.exec(line);
  return match ? cleanLine(match[1]) : '';
}

function normalizeList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const cleaned = cleanLine(item).replace(/[.;]$/, '');
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    out.push(cleaned);
  }
  return out;
}

function cleanLine(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function collectCodeSpanPathHints(text: string): string[] {
  return [...text.matchAll(CODE_SPAN_PATTERN)].map((match) => match[1] ?? '');
}

function collectBarePathHints(text: string): string[] {
  return [...text.matchAll(BARE_PATH_PATTERN)].map((match) => match[1] ?? '');
}

function pushNormalizedPathHint(out: string[], raw: string): void {
  const value = raw.trim();
  if (!value || value.startsWith('/') || value.includes('..') || URL_SCHEME_PATTERN.test(value)) return;
  if (!/[/.]/.test(value)) return;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/')).replace(/^\.\/+/, '');
  if (!normalized || normalized.startsWith('../')) return;
  if (normalized === '.git' || normalized.startsWith('.git/')) return;
  out.push(normalized);
}

function reserveUniqueSliceId(baseId: string, counts: Map<string, number>, assigned: Set<string>): string {
  let count = counts.get(baseId) ?? 0;
  let candidate = count === 0 ? baseId : appendSliceIdSuffix(baseId, count + 1);
  while (assigned.has(candidate)) {
    count += 1;
    candidate = appendSliceIdSuffix(baseId, count + 1);
  }
  counts.set(baseId, count + 1);
  assigned.add(candidate);
  return candidate;
}

function appendSliceIdSuffix(baseId: string, suffixNumber: number): string {
  const suffix = `-${suffixNumber}`;
  const prefix = baseId.slice(0, TASK_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '');
  return `${prefix}${suffix}`;
}

function makeRunId(repoRoot: string, slices: OrchestrationSliceRecord[]): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const branch = runGit(repoRoot, ['branch', '--show-current'], true)?.trim() || 'detached';
  const entropy = crypto.randomBytes(16).toString('hex');
  const hash = sha256(`${branch}\n${slices.map((slice) => slice.id).join('\n')}\n${entropy}`).slice(0, 8);
  return `orchestrate-${stamp}-${hash}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function repoRelativePath(repoRoot: string, targetPath: string): string {
  return path.relative(normalizePath(repoRoot), normalizePath(targetPath)).replaceAll('\\', '/');
}
