import crypto from 'node:crypto';

import {
  canonicalize,
  resolveReviewStateKey,
} from './integrity.ts';
import {
  appendReviewOverrideRecord,
  appendReviewConsentRecord,
  ensureTaskBindingId,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadReviewAcceptanceState,
  loadReviewState,
  nowIso,
  normalizeExistingPath,
  resolveWorkflowContext,
  runGit,
  type GateDefinitionHash,
  type OperatorFlags,
  type ReviewAcceptanceRecord,
  type ReviewConsentKind,
  type ReviewConsentRecord,
  type ReviewGateConfig,
  type ReviewGateRunRecord,
  type ReviewRunRecord,
  type WorkflowContext,
} from './state.ts';
import { blockingAiReviewEvidenceBlocker, resolveReviewActorIdentity } from './review-identity.ts';
import { REVIEW_GATES_POLICY_VERSION } from './review-gate-policy.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';

export type ReviewEvidenceGateStatus = 'missing' | 'failed' | 'pending' | 'incomplete';

export interface ReviewEvidenceIssue {
  status: ReviewEvidenceGateStatus;
  gateId?: string;
  message: string;
  blocking: boolean;
  gate?: ReviewGateRunRecord;
}

export interface ReviewEvidenceCheckResult {
  allowed: boolean;
  latest: ReviewRunRecord | null;
  issues: ReviewEvidenceIssue[];
  bypassedIssues: ReviewEvidenceIssue[];
  consents: ReviewConsentRecord[];
  message: string;
}

export interface ReviewEvidenceTarget {
  branchName: string;
  sha: string;
  worktreeStatusDigest: string;
  worktreeStatusReliable: boolean;
  worktreeStatusWarnings: string[];
  worktreeMaterialTreeHash: string;
  worktreeMaterialTreeReliable: boolean;
  worktreeMaterialTreeWarnings: string[];
  taskBindingId: string;
  reviewTargetDigest: string;
  headLabel?: string;
}

export function reviewEvidenceOverrideReason(flags: Pick<OperatorFlags, 'override' | 'reason'>): string {
  if (!flags.override) return '';
  return flags.reason.trim();
}

export function formatReviewEvidenceOverrideMessage(command: string, reason: string): string {
  return `${command} review evidence was bypassed by the user for this exact target; failed or pending gates were not passed: ${reason}`;
}

export function recordReviewEvidenceOverride(context: WorkflowContext, command: string, reason: string): void {
  const recordedAt = nowIso();
  appendReviewOverrideRecord(context.commonDir, context.config, {
    id: `review-override-${new Date(recordedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
    command,
    reason,
    recordedAt,
    actor: resolveReviewActorIdentity(),
    branchName: runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '',
    sha: runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '',
  });
}

/**
 * blocked evidence -> informed choice -> signed consent -> exact route action
 *       |                    |                    |
 *       +-- scope changes ---+------> invalid (never relabeled as passed)
 */
export function recordReviewEvidenceConsents(
  context: WorkflowContext,
  evidence: ReviewEvidenceCheckResult,
  routeAction: string,
  reason: string,
  kind: ReviewConsentKind = 'gate-bypass',
  targetOverride?: ReviewEvidenceTarget,
): ReviewConsentRecord[] {
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error('review bypass requires a non-empty informed-consent reason.');
  const target = targetOverride ?? currentCheckoutReviewEvidenceTarget(context.repoRoot);
  const issueByGate = new Map<string, ReviewEvidenceIssue>();
  for (const issue of [...evidence.issues, ...evidence.bypassedIssues]) {
    if (issue.gateId) issueByGate.set(issue.gateId, issue);
  }
  const gateConfigs = (context.config.reviewGates?.gates ?? []).filter((gate) => gate.blocking !== false);
  const selected = issueByGate.size > 0
    ? gateConfigs.filter((gate) => issueByGate.has(gate.id))
    : gateConfigs;
  if (selected.length === 0) throw new Error('review bypass found no configured blocking gate in scope.');
  const recordedAt = nowIso();
  return selected.map((gate) => {
    const issue = issueByGate.get(gate.id);
    const originalGateState = issue?.status ?? 'missing';
    return appendReviewConsentRecord(context.commonDir, context.config, {
      id: `review-consent-${new Date(recordedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
      kind,
      gateId: gate.id,
      gateDefinitionHash: reviewGateDefinitionHash(gate),
      policyVersion: context.config.reviewGates?.policyVersion ?? 2,
      enforcementMode: context.config.reviewGates?.enforcementMode ?? 'legacy-v2',
      taskBindingId: target.taskBindingId,
      ...(evidence.latest?.id ? { reviewRunId: evidence.latest.id } : {}),
      originalGateState,
      branchName: target.branchName,
      sha: target.sha,
      worktreeStatusDigest: target.worktreeStatusDigest,
      worktreeMaterialTreeHash: target.worktreeMaterialTreeHash,
      reviewTargetDigest: target.reviewTargetDigest,
      routeAction,
      actor: resolveReviewActorIdentity(),
      source: kind === 'accept-findings' ? 'route-safety' : 'review-override',
      reason: normalizedReason,
      reasonHash: crypto.createHash('sha256').update(normalizedReason).digest('hex'),
      recordedAt,
    });
  });
}

function consentMatchesTarget(
  consent: ReviewConsentRecord,
  target: ReviewEvidenceTarget,
  routeAction: string,
  policyVersion: number,
  enforcementMode: ReviewConsentRecord['enforcementMode'],
  currentReviewRunId: string,
): boolean {
  return consent.kind !== 'manual-substitution'
    && consent.policyVersion === policyVersion
    && consent.enforcementMode === enforcementMode
    && consent.taskBindingId === target.taskBindingId
    && consent.branchName === target.branchName
    && consent.sha === target.sha
    && consent.worktreeStatusDigest === target.worktreeStatusDigest
    && consent.worktreeMaterialTreeHash === target.worktreeMaterialTreeHash
    && consent.reviewTargetDigest === target.reviewTargetDigest
    && consent.routeAction === routeAction
    && (consent.kind !== 'accept-findings' || (currentReviewRunId.length > 0 && consent.reviewRunId === currentReviewRunId));
}

function issueHasConsent(issue: ReviewEvidenceIssue, consents: ReviewConsentRecord[], expectedGates: ReviewGateConfig[]): boolean {
  const matchesGate = (gate: ReviewGateConfig): boolean => consents.some((consent) =>
    consent.gateId === gate.id && consent.gateDefinitionHash === reviewGateDefinitionHash(gate)
  );
  if (issue.gateId) {
    const gate = expectedGates.find((candidate) => candidate.id === issue.gateId);
    return Boolean(gate && matchesGate(gate));
  }
  return expectedGates.length > 0 && expectedGates.every(matchesGate);
}

function formatReviewConsentMessage(routeAction: string, issues: ReviewEvidenceIssue[], consents: ReviewConsentRecord[]): string {
  return [
    `${routeAction} review evidence remains blocked, but explicit exact-scope consent authorizes this action.`,
    ...issues.map((issue) => `- ${issue.gateId ?? 'review'}: bypassed by user; ${issue.message}`),
    ...consents.map((consent) => `- consent ${consent.id}: ${consent.reason}`),
    'The failed or pending evidence was not relabeled as passed.',
  ].join('\n');
}

export function evaluateReviewEvidenceForPr(
  context: WorkflowContext,
  options: { latestOverride?: ReviewRunRecord | null; command?: string; target?: ReviewEvidenceTarget } = {},
): ReviewEvidenceCheckResult {
  const reviewState = loadReviewState(context.commonDir, context.config);
  const reviewAcceptanceState = resolveReviewStateKey()
    ? loadReviewAcceptanceState(context.commonDir, context.config)
    : { records: [] };
  const expectedGates = context.config.reviewGates?.gates ?? [];
  if (expectedGates.length === 0) {
    return {
      allowed: true,
      latest: options.latestOverride ?? reviewState.records[0] ?? null,
      issues: [],
      bypassedIssues: [],
      consents: [],
      message: '',
    };
  }
  const target = options.target ?? currentCheckoutReviewEvidenceTarget(context.repoRoot);
  const selectedLatest = options.latestOverride ?? selectReviewEvidenceRecord(reviewState.records, {
    currentBranch: target.branchName,
    currentSha: target.sha,
    currentWorktreeStatusDigest: target.worktreeStatusDigest,
    currentWorktreeStatusReliable: target.worktreeStatusReliable,
    currentWorktreeMaterialTreeHash: target.worktreeMaterialTreeHash,
    currentWorktreeMaterialTreeReliable: target.worktreeMaterialTreeReliable,
  });
  const latest = selectedLatest
    ? attachEquivalentReviewGateEvidence({
        context,
        reviewRun: selectedLatest,
        allRecords: reviewState.records,
        acceptanceRecords: reviewAcceptanceState.records,
        currentBranch: target.branchName,
        currentSha: target.sha,
        currentWorktreeStatusDigest: target.worktreeStatusDigest,
        currentWorktreeStatusReliable: target.worktreeStatusReliable,
        currentWorktreeMaterialTreeHash: target.worktreeMaterialTreeHash,
        currentWorktreeMaterialTreeReliable: target.worktreeMaterialTreeReliable,
      })
    : null;
  const issues = collectReviewEvidenceIssues({
    latest,
    expectedGates,
    strictIndependentAi: context.config.reviewGates?.policyVersion === REVIEW_GATES_POLICY_VERSION,
    currentBranch: target.branchName,
    currentSha: target.sha,
    currentHeadLabel: target.headLabel ?? 'current HEAD',
    currentWorktreeStatusDigest: target.worktreeStatusDigest,
    currentWorktreeStatusReliable: target.worktreeStatusReliable,
    currentWorktreeStatusWarnings: target.worktreeStatusWarnings,
    currentWorktreeMaterialTreeHash: target.worktreeMaterialTreeHash,
    currentWorktreeMaterialTreeReliable: target.worktreeMaterialTreeReliable,
    currentWorktreeMaterialTreeWarnings: target.worktreeMaterialTreeWarnings,
  });
  const routeAction = options.command ?? formatWorkflowCommand(context.config, 'pr');
  const expectedBlockingGates = expectedGates.filter((gate) => gate.blocking !== false);
  const activeConsents = (reviewState.consents ?? []).filter((consent) => consentMatchesTarget(
    consent,
    target,
    routeAction,
    context.config.reviewGates?.policyVersion ?? 2,
    context.config.reviewGates?.enforcementMode ?? 'legacy-v2',
    latest?.id ?? '',
  ));
  const bypassedIssues = issues.filter((issue) => issueHasConsent(issue, activeConsents, expectedBlockingGates));
  const remainingIssues = issues.filter((issue) => !bypassedIssues.includes(issue));
  const allBypassed = issues.length > 0 && remainingIssues.length === 0;

  return {
    allowed: remainingIssues.length === 0,
    latest,
    issues: remainingIssues,
    bypassedIssues,
    consents: activeConsents,
    message: issues.length === 0
      ? ''
      : allBypassed
        ? formatReviewConsentMessage(routeAction, bypassedIssues, activeConsents)
        : formatReviewEvidenceBlocker(context, remainingIssues, options.command),
  };
}

function currentCheckoutReviewEvidenceTarget(repoRoot: string): ReviewEvidenceTarget {
  const worktreeStatus = readWorktreeStatusSnapshot(repoRoot, {
    includeStatusDigest: true,
    includeMaterialTreeHash: true,
  });
  const context = resolveWorkflowContext(repoRoot);
  const lock = loadAllTaskLocks(context.commonDir, context.config).find((candidate) =>
    candidate.branchName === worktreeStatus.branchName
    && normalizeExistingPath(candidate.worktreePath) === normalizeExistingPath(repoRoot)
  );
  const migratedLock = lock ? ensureTaskBindingId(context.commonDir, context.config, lock.taskSlug) : null;
  const taskBindingId = migratedLock?.taskBindingId ?? '';
  const reviewTargetDigest = crypto.createHash('sha256').update(canonicalize({
    version: 2,
    branchName: worktreeStatus.branchName,
    sha: worktreeStatus.head,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeMaterialTreeHash: worktreeStatus.materialTreeHash ?? '',
  })).digest('hex');
  return {
    branchName: worktreeStatus.branchName,
    sha: worktreeStatus.head,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeStatusReliable: worktreeStatus.statusDigestReliable,
    worktreeStatusWarnings: worktreeStatus.statusDigestWarnings,
    worktreeMaterialTreeHash: worktreeStatus.materialTreeHash ?? '',
    worktreeMaterialTreeReliable: worktreeStatus.materialTreeReliable === true,
    worktreeMaterialTreeWarnings: worktreeStatus.materialTreeWarnings ?? [],
    taskBindingId,
    reviewTargetDigest,
  };
}

export function selectReviewEvidenceRecord(
  records: ReviewRunRecord[],
  options: {
    currentBranch: string;
    currentSha: string;
    currentWorktreeStatusDigest: string;
    currentWorktreeStatusReliable?: boolean;
    currentWorktreeMaterialTreeHash?: string;
    currentWorktreeMaterialTreeReliable?: boolean;
  },
): ReviewRunRecord | null {
  const { currentBranch, currentSha } = options;
  return records.find((record) =>
    record.branchName === currentBranch
    && record.sha === currentSha
    && reviewRecordMatchesCurrentWorktree(record, options)
  )
    ?? records.find((record) => record.branchName === currentBranch && record.sha === currentSha)
    ?? records.find((record) =>
      record.branchName === currentBranch
      && reviewRecordMatchesCurrentWorktree(record, options)
    )
    ?? records.find((record) => record.branchName === currentBranch)
    ?? null;
}

export function selectCurrentReviewEvidenceRecord(
  context: WorkflowContext,
  records: ReviewRunRecord[] = loadReviewState(context.commonDir, context.config).records,
): ReviewRunRecord | null {
  const target = currentCheckoutReviewEvidenceTarget(context.repoRoot);
  return records.find((record) =>
    record.branchName === target.branchName
    && reviewRecordMatchesCurrentWorktree(record, {
      currentWorktreeStatusDigest: target.worktreeStatusDigest,
      currentWorktreeStatusReliable: target.worktreeStatusReliable,
      currentWorktreeMaterialTreeHash: target.worktreeMaterialTreeHash,
      currentWorktreeMaterialTreeReliable: target.worktreeMaterialTreeReliable,
    })
  ) ?? null;
}

export function formatReviewEvidenceBlocker(context: WorkflowContext, issues: ReviewEvidenceIssue[], command = formatWorkflowCommand(context.config, 'pr')): string {
  return [
    `${command} blocked because review gate evidence is not ready.`,
    ...issues.map((issue) => `- ${issue.message}`),
    `Run /pipelane review and complete any pending AI/manual gates before retrying ${command}.`,
  ].join('\n');
}

function collectReviewEvidenceIssues(options: {
  latest: ReviewRunRecord | null;
  expectedGates: ReviewGateConfig[];
  strictIndependentAi: boolean;
  currentBranch: string;
  currentSha: string;
  currentHeadLabel: string;
  currentWorktreeStatusDigest: string;
  currentWorktreeStatusReliable: boolean;
  currentWorktreeStatusWarnings: string[];
  currentWorktreeMaterialTreeHash: string;
  currentWorktreeMaterialTreeReliable: boolean;
  currentWorktreeMaterialTreeWarnings: string[];
}): ReviewEvidenceIssue[] {
  const {
    latest,
    expectedGates,
    strictIndependentAi,
    currentBranch,
    currentSha,
    currentHeadLabel,
    currentWorktreeStatusDigest,
    currentWorktreeStatusReliable,
    currentWorktreeStatusWarnings,
    currentWorktreeMaterialTreeHash,
    currentWorktreeMaterialTreeReliable,
    currentWorktreeMaterialTreeWarnings,
  } = options;
  if (!latest) {
    const blockingGates = expectedGates.filter((gate) => gate.blocking !== false);
    return blockingGates.length > 0
      ? blockingGates.map((gate) => ({
          status: 'missing' as const,
          gateId: gate.id,
          message: `configured gate ${gate.id} has no review run for this checkout`,
          blocking: true,
        }))
      : [{
          status: 'missing',
          message: 'no review run has been recorded for this checkout',
          blocking: true,
        }];
  }

  const issues: ReviewEvidenceIssue[] = [];
  if (latest.dryRun) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} was a dry run`,
      blocking: true,
    });
  }
  if (latest.gateFilter || latest.phaseFilter) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} was filtered${latest.gateFilter ? ` by gate ${latest.gateFilter}` : ''}${latest.phaseFilter ? ` by phase ${latest.phaseFilter}` : ''}`,
      blocking: true,
    });
  }
  if (latest.branchName !== currentBranch) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} is for ${latest.branchName || 'unknown branch'}, not ${currentBranch || 'the current branch'}`,
      blocking: true,
    });
  }
  const materialTreeMatches = reviewRecordMaterialTreeMatchesCurrentWorktree(latest, {
    currentWorktreeMaterialTreeHash,
    currentWorktreeMaterialTreeReliable,
  });
  if (latest.sha !== currentSha && !materialTreeMatches) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} is for ${shortSha(latest.sha)}, not ${currentHeadLabel} ${shortSha(currentSha)}`,
      blocking: true,
    });
  }
  const worktreeIdentityMatches = reviewRecordMatchesCurrentWorktree(latest, {
    currentWorktreeStatusDigest,
    currentWorktreeStatusReliable,
    currentWorktreeMaterialTreeHash,
    currentWorktreeMaterialTreeReliable,
  });
  if (latest.worktreeStatusDigest === undefined && latest.worktreeMaterialTreeHash === undefined) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} does not include a worktree identity`,
      blocking: true,
    });
  } else if (!worktreeIdentityMatches) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} is for a different worktree state`,
      blocking: true,
    });
  }
  if (latest.worktreeStatusReliable === false && latest.worktreeMaterialTreeReliable !== true) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} recorded an unreliable worktree identity: ${formatWorktreeIdentityWarnings(latest.worktreeStatusWarnings ?? [], latest.worktreeMaterialTreeWarnings ?? [])}`,
      blocking: true,
    });
  }
  if (!currentWorktreeStatusReliable && !currentWorktreeMaterialTreeReliable) {
    issues.push({
      status: 'incomplete',
      message: `current worktree identity is unreliable: ${formatWorktreeIdentityWarnings(currentWorktreeStatusWarnings, currentWorktreeMaterialTreeWarnings)}`,
      blocking: true,
    });
  }

  for (const gate of latest.gates) {
    const blocking = gate.blocking !== false;
    if (!blocking) continue;
    if (gate.status === 'failed') {
      issues.push({
        status: 'failed',
        gateId: gate.gateId,
        message: `blocking gate ${gate.gateId} failed: ${gate.summary}`,
        blocking,
        gate,
      });
    } else if (gate.status === 'pending') {
      issues.push({
        status: 'pending',
        gateId: gate.gateId,
        message: `blocking gate ${gate.gateId} is pending: ${gate.summary}`,
        blocking,
        gate,
      });
    }
  }

  const aiReviewBlocker = strictIndependentAi
    ? blockingAiReviewEvidenceBlocker({
        reviewRun: latest,
        worker: latest.authorIdentity ?? null,
        allowSessionOnlyIndependence: true,
      })
    : blockingAiReviewEvidenceBlocker({
        reviewRun: latest,
        worker: latest.reviewer ?? null,
        allowTrustedAttesterWithoutWorker: true,
      });
  if (aiReviewBlocker) {
    issues.push({
      status: 'incomplete',
      message: `blocking AI review evidence is not independently attested: ${aiReviewBlocker}`,
      blocking: true,
    });
  }

  if (
    latest.status !== 'passed'
    && !issues.some((issue) => issue.status === latest.status)
  ) {
    issues.push({
      status: latest.status === 'failed' ? 'failed' : 'pending',
      message: `latest review ${latest.id} status is ${latest.status}`,
      blocking: true,
    });
  }

  const observedByGateId = new Map(latest.gates.map((gate) => [gate.gateId, gate]));
  for (const gateConfig of expectedGates) {
    const gate = observedByGateId.get(gateConfig.id);
    const blocking = gate?.blocking ?? gateConfig.blocking !== false;
    if (!gate) {
      issues.push({
        status: 'missing',
        gateId: gateConfig.id,
        message: `configured gate ${gateConfig.id} is missing from latest review ${latest.id}`,
        blocking,
      });
      continue;
    }
  }

  return issues.filter((issue) => issue.blocking);
}

function attachEquivalentReviewGateEvidence(options: {
  context: WorkflowContext;
  reviewRun: ReviewRunRecord;
  allRecords: ReviewRunRecord[];
  acceptanceRecords: ReviewAcceptanceRecord[];
  currentBranch: string;
  currentSha: string;
  currentWorktreeStatusDigest: string;
  currentWorktreeStatusReliable: boolean;
  currentWorktreeMaterialTreeHash: string;
  currentWorktreeMaterialTreeReliable: boolean;
}): ReviewRunRecord {
  const { reviewRun } = options;
  if (!reviewRunCoversFullGateSet(reviewRun)) return reviewRun;
  if (
    reviewRun.branchName !== options.currentBranch
    || reviewRun.sha !== options.currentSha
    || !reviewRecordMatchesCurrentWorktree(reviewRun, options)
  ) {
    return reviewRun;
  }
  const pendingManualGates = reviewRun.gates.filter((gate) =>
    gate.status === 'pending'
    && gate.blocking !== false
    && isManualReviewGateRun(gate)
  );
  if (pendingManualGates.length === 0) return reviewRun;

  const evidenceCandidates: Array<{ recordedAt: string; gate: ReviewGateRunRecord }> = [];
  for (const record of options.allRecords) {
    if (!reviewRunMatchesEquivalentGateEvidence(reviewRun, record)) continue;
    for (const gate of record.gates) {
      if (isPassedManualReviewGate(gate)) {
        evidenceCandidates.push({ recordedAt: gate.finishedAt || record.finishedAt, gate });
      }
    }
  }
  for (const acceptance of options.acceptanceRecords) {
    const pendingGate = pendingManualGates.find((gate) => gate.gateId === acceptance.gateId);
    if (!pendingGate || !reviewAcceptanceMatchesGate(reviewRun, pendingGate, acceptance, options.context.config.reviewGates?.policyVersion ?? 1)) continue;
    evidenceCandidates.push({
      recordedAt: acceptance.recordedAt,
      gate: reviewAcceptanceToGate(pendingGate, acceptance),
    });
  }

  evidenceCandidates.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const passedByGateId = new Map<string, ReviewGateRunRecord>();
  for (const candidate of evidenceCandidates) {
    if (!passedByGateId.has(candidate.gate.gateId)) {
      passedByGateId.set(candidate.gate.gateId, candidate.gate);
    }
  }

  if (passedByGateId.size === 0) return reviewRun;
  let attached = false;
  const gates = reviewRun.gates.map((gate): ReviewGateRunRecord => {
    if (gate.status !== 'pending' || !isManualReviewGateRun(gate)) return gate;
    const passed = passedByGateId.get(gate.gateId);
    if (!passed || !manualReviewGateEvidenceMatches(gate, passed)) return gate;
    attached = true;
    const attachedGate: ReviewGateRunRecord = {
      ...gate,
      status: 'passed',
      summary: passed.summary,
      startedAt: passed.startedAt,
      finishedAt: passed.finishedAt,
      durationMs: passed.durationMs,
    };
    if (passed.attester) attachedGate.attester = passed.attester;
    return attachedGate;
  });

  return attached
    ? { ...reviewRun, status: summarizeReviewRunStatus(gates), gates }
    : reviewRun;
}

export function reviewGateDefinitionHash(gate: Pick<ReviewGateConfig, 'id' | 'phase' | 'type' | 'blocking' | 'command' | 'skill' | 'role' | 'userCommands'> | Pick<ReviewGateRunRecord, 'gateId' | 'phase' | 'type' | 'blocking' | 'command' | 'skill' | 'role' | 'userCommands'>): GateDefinitionHash {
  const id = 'gateId' in gate ? gate.gateId : gate.id;
  return crypto.createHash('sha256').update(canonicalize({
    id,
    phase: gate.phase,
    type: gate.type,
    blocking: gate.blocking !== false,
    command: normalizeOptionalGateField(gate.command),
    skill: normalizeOptionalGateField(gate.skill),
    role: normalizeOptionalGateField(gate.role),
    userCommands: gate.userCommands ?? [],
  })).digest('hex');
}

function reviewAcceptanceMatchesGate(
  reviewRun: ReviewRunRecord,
  gate: ReviewGateRunRecord,
  acceptance: ReviewAcceptanceRecord,
  policyVersion: number,
): boolean {
  return acceptance.acceptabilityClass !== 'policy-bypass'
    && acceptance.gateId === gate.gateId
    && acceptance.gateDefinitionHash === reviewGateDefinitionHash(gate)
    && acceptance.policyVersion === policyVersion
    && acceptance.branchName === reviewRun.branchName
    && acceptance.sha === reviewRun.sha
    && acceptance.worktreeStatusDigest === (reviewRun.worktreeStatusDigest ?? '')
    && acceptance.worktreeMaterialTreeHash === (reviewRun.worktreeMaterialTreeHash ?? '');
}

function reviewAcceptanceToGate(gate: ReviewGateRunRecord, acceptance: ReviewAcceptanceRecord): ReviewGateRunRecord {
  return {
    ...gate,
    status: 'passed',
    attester: acceptance.actor,
    summary: `manual acceptance: ${acceptance.reason}`,
    startedAt: acceptance.recordedAt,
    finishedAt: acceptance.recordedAt,
    durationMs: 0,
  };
}

function reviewRunCoversFullGateSet(reviewRun: ReviewRunRecord): boolean {
  return reviewRun.dryRun === false && !reviewRun.gateFilter && !reviewRun.phaseFilter;
}

function reviewRunMatchesEquivalentGateEvidence(expected: ReviewRunRecord, evidence: ReviewRunRecord): boolean {
  return reviewRunCoversFullGateSet(evidence)
    && evidence.branchName === expected.branchName
    && evidence.sha === expected.sha
    && reviewRecordMatchesCurrentWorktree(evidence, {
      currentWorktreeStatusDigest: expected.worktreeStatusDigest ?? '',
      currentWorktreeStatusReliable: expected.worktreeStatusReliable,
      currentWorktreeMaterialTreeHash: expected.worktreeMaterialTreeHash ?? '',
      currentWorktreeMaterialTreeReliable: expected.worktreeMaterialTreeReliable,
    });
}

function isPassedManualReviewGate(gate: ReviewGateRunRecord): boolean {
  return gate.status === 'passed' && isManualReviewGateRun(gate);
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

function reviewRecordMatchesCurrentWorktree(
  record: Pick<ReviewRunRecord, 'worktreeStatusDigest' | 'worktreeStatusReliable' | 'worktreeMaterialTreeHash' | 'worktreeMaterialTreeReliable'>,
  options: {
    currentWorktreeStatusDigest: string;
    currentWorktreeStatusReliable?: boolean;
    currentWorktreeMaterialTreeHash?: string;
    currentWorktreeMaterialTreeReliable?: boolean;
  },
): boolean {
  if (
    options.currentWorktreeStatusReliable !== false
    && record.worktreeStatusReliable !== false
    && record.worktreeStatusDigest === options.currentWorktreeStatusDigest
  ) {
    return true;
  }
  return reviewRecordMaterialTreeMatchesCurrentWorktree(record, options);
}

function reviewRecordMaterialTreeMatchesCurrentWorktree(
  record: Pick<ReviewRunRecord, 'worktreeMaterialTreeHash' | 'worktreeMaterialTreeReliable'>,
  options: {
    currentWorktreeMaterialTreeHash?: string;
    currentWorktreeMaterialTreeReliable?: boolean;
  },
): boolean {
  return record.worktreeMaterialTreeReliable === true
    && options.currentWorktreeMaterialTreeReliable === true
    && Boolean(record.worktreeMaterialTreeHash)
    && record.worktreeMaterialTreeHash === options.currentWorktreeMaterialTreeHash;
}

function formatWorktreeIdentityWarnings(statusWarnings: string[], materialTreeWarnings: string[]): string {
  return [...statusWarnings, ...materialTreeWarnings].join('; ') || 'worktree identity was unreliable';
}

function shortSha(value: string): string {
  return value ? value.slice(0, 7) : 'unknown';
}
