import crypto from 'node:crypto';

import {
  canonicalize,
  resolveReviewStateKey,
  signSignedPayload,
} from './integrity.ts';
import {
  appendReviewOverrideRecord,
  appendReviewConsentRecord,
  assertRecordedReviewArtifact,
  ensureTaskBindingId,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadReviewAcceptanceState,
  loadReviewState,
  nowIso,
  normalizeExistingPath,
  resolveWorkflowContext,
  runGit,
  saveReviewState,
  withReviewStateLock,
  type GateDefinitionHash,
  type OperatorFlags,
  type ReviewAcceptanceRecord,
  type ReviewConsentKind,
  type ReviewConsentRecord,
  type ReviewExternalEvidenceRecord,
  type ReviewGateConfig,
  type ReviewGateRunRecord,
  type ReviewRunRecord,
  type WorkflowConfig,
  type WorkflowContext,
} from './state.ts';
import { blockingAiReviewEvidenceBlocker, resolveReviewActorIdentity } from './review-identity.ts';
import { lookupReviewVerdict, type ReviewVerdictEntry, type ReviewVerdictScope } from './review-verdicts.ts';
import { REVIEW_GATES_POLICY_VERSION } from './review-gate-policy.ts';
import { buildReviewTargetManifest, resolveBaseTip, type ReviewDispositionPromptEntry } from './review-contract.ts';
import { readVerifiedReviewArtifact } from './review-artifacts.ts';
import { reviewArtifactRoot } from './state.ts';
import { projectReviewRun, renderReviewPresentation } from './review-output.ts';
import { normalizeReviewDataField, REVIEW_DATA_LIMITS } from './review-data.ts';
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
  target?: ReviewEvidenceTarget;
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
  const normalizedReason = normalizeReviewDataField(reason, {
    field: 'review informed-consent reason',
    maxBytes: REVIEW_DATA_LIMITS.reasonBytes,
    redact: true,
  });
  const currentTarget = targetOverride ? null : currentCheckoutReviewEvidenceTarget(context.repoRoot);
  if (evidence.target && currentTarget && !reviewEvidenceTargetsEqual(evidence.target, currentTarget)) {
    throw new Error('The exact review target changed before informed consent could be recorded. No consent was written; reevaluate the current target.');
  }
  const target = targetOverride ?? evidence.target ?? currentTarget ?? currentCheckoutReviewEvidenceTarget(context.repoRoot);
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
      source: kind === 'accept-findings'
        ? 'route-safety'
        : kind === 'manual-substitution'
          ? 'manual-attestation'
          : 'review-override',
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
  return consent.policyVersion === policyVersion
    && consent.enforcementMode === enforcementMode
    && consent.taskBindingId === target.taskBindingId
    && consent.branchName === target.branchName
    && consent.sha === target.sha
    && consent.worktreeStatusDigest === target.worktreeStatusDigest
    && consent.worktreeMaterialTreeHash === target.worktreeMaterialTreeHash
    && consent.reviewTargetDigest === target.reviewTargetDigest
    && consent.routeAction === routeAction
    && (
      consent.kind !== 'accept-findings'
      || (currentReviewRunId.length > 0 && consent.reviewRunId === currentReviewRunId)
    );
}

export function selectCurrentReviewConsents(
  context: WorkflowContext,
  latest: ReviewRunRecord | null,
  target: ReviewEvidenceTarget = currentCheckoutReviewEvidenceTarget(context.repoRoot),
): ReviewConsentRecord[] {
  const state = loadReviewState(context.commonDir, context.config);
  const policyVersion = context.config.reviewGates?.policyVersion ?? 2;
  const enforcementMode = context.config.reviewGates?.enforcementMode ?? 'legacy-v2';
  return (state.consents ?? []).filter((consent) => {
    if (!consentMatchesTarget(consent, target, consent.routeAction, policyVersion, enforcementMode, latest?.id ?? '')) return false;
    if (consent.kind !== 'manual-substitution') return true;
    const manual = latest?.gates.find((gate) => gate.gateId === consent.gateId)?.manualAttestation;
    return Boolean(manual?.substitutionRequested && manual.status === 'passed' && manual.reviewRunId === consent.reviewRunId);
  });
}

function issueHasConsent(issue: ReviewEvidenceIssue, consents: ReviewConsentRecord[], expectedGates: ReviewGateConfig[]): boolean {
  const matchesGate = (gate: ReviewGateConfig, allowManualSubstitution: boolean): boolean => consents.some((consent) => {
    if (consent.gateId !== gate.id || consent.gateDefinitionHash !== reviewGateDefinitionHash(gate)) return false;
    if (consent.kind !== 'manual-substitution') return true;
    if (!allowManualSubstitution) return false;
    const manual = issue.gate?.manualAttestation;
    return Boolean(
      manual
      && manual.status === 'passed'
      && manual.substitutionRequested
      && consent.reviewRunId === manual.reviewRunId
    );
  });
  if (issue.gateId) {
    const gate = expectedGates.find((candidate) => candidate.id === issue.gateId);
    return Boolean(gate && matchesGate(gate, true));
  }
  return expectedGates.length > 0 && expectedGates.every((gate) => matchesGate(gate, false));
}

function formatReviewConsentMessage(routeAction: string, issues: ReviewEvidenceIssue[], consents: ReviewConsentRecord[]): string {
  const kinds = new Set(consents.map((consent) => consent.kind));
  const authorization = kinds.size === 1 && kinds.has('manual-substitution')
    ? 'explicit exact-scope manual review substitution authorizes this action'
    : kinds.size === 1 && kinds.has('accept-findings')
      ? 'the user accepted these findings for this exact action'
      : 'explicit exact-scope consent authorizes this action';
  const label = (consent: ReviewConsentRecord): string => consent.kind === 'manual-substitution'
    ? 'manual review substituted'
    : consent.kind === 'accept-findings'
      ? 'findings accepted'
      : 'bypassed by user';
  return [
    `${routeAction} review evidence remains non-automatic, but ${authorization}.`,
    ...issues.map((issue) => `- ${issue.gateId ?? 'review'}: ${issue.message}`),
    ...consents.map((consent) => `- ${label(consent)} (${consent.id}): ${consent.reason}`),
    'The failed or pending evidence was not relabeled as passed; the underlying manual capability was not relabeled as automatic review.',
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
  const attachedLatest = selectedLatest
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
  const latest = attachedLatest
    ? applyReviewFindingDispositions(attachedLatest, reviewState.findingDispositions ?? [], target)
    : null;
  const issues = collectReviewEvidenceIssues({
    latest,
    expectedGates,
    externalEvidence: reviewState.externalEvidence ?? [],
    strictIndependentAi: (context.config.reviewGates?.policyVersion ?? 1) >= 2,
    strictEvidence: context.config.reviewGates?.enforcementMode === 'strict-v3',
    artifactRoot: reviewArtifactRoot(context.commonDir, context.config),
    currentReviewTargetDigest: target.reviewTargetDigest,
    expectedEnforcementMode: context.config.reviewGates?.enforcementMode ?? 'legacy-v2',
    expectedPolicyVersion: context.config.reviewGates?.policyVersion ?? REVIEW_GATES_POLICY_VERSION,
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
    target,
    message: issues.length === 0
      ? ''
      : allBypassed
        ? formatReviewConsentMessage(routeAction, bypassedIssues, activeConsents)
        : formatReviewEvidenceBlocker(context, remainingIssues, options.command, latest, activeConsents),
  };
}

function applyReviewFindingDispositions(
  reviewRun: ReviewRunRecord,
  dispositions: NonNullable<ReturnType<typeof loadReviewState>['findingDispositions']>,
  target: ReviewEvidenceTarget,
): ReviewRunRecord {
  const applicable = dispositions.filter((record) => {
    if (
      record.reviewRunId !== reviewRun.id
      || record.branchName !== target.branchName
      || record.sha !== target.sha
      || record.worktreeStatusDigest !== target.worktreeStatusDigest
      || record.worktreeMaterialTreeHash !== target.worktreeMaterialTreeHash
      || record.taskBindingId !== target.taskBindingId
      || record.reviewTargetDigest !== target.reviewTargetDigest
    ) return false;
    try {
      assertRecordedReviewArtifact(record.artifact);
      return true;
    } catch {
      return false;
    }
  });
  if (applicable.length === 0) return reviewRun;
  const byGate = new Map<string, Set<string>>();
  for (const disposition of applicable) {
    const ids = byGate.get(disposition.gateId) ?? new Set<string>();
    ids.add(disposition.finding.id);
    byGate.set(disposition.gateId, ids);
  }
  let changed = false;
  const gates = reviewRun.gates.map((gate): ReviewGateRunRecord => {
    const ids = byGate.get(gate.gateId);
    if (!ids || !gate.result?.findingsKnown || !gate.findings?.some((finding) => ids.has(finding.id))) return gate;
    const findings = gate.findings.filter((finding) => !ids.has(finding.id));
    const blockingCount = findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'warning').length;
    const advisoryCount = findings.filter((finding) => finding.severity === 'nit').length;
    const effectiveStatus = blockingCount > 0 ? 'failed' as const : 'passed' as const;
    const dispositionCount = gate.findings.length - findings.length;
    changed = true;
    return {
      ...gate,
      status: effectiveStatus,
      summary: `${gate.summary} (${dispositionCount} finding${dispositionCount === 1 ? '' : 's'} satisfied by spin-off disposition at this exact HEAD; original review result remains ${gate.result.declaredStatus})`,
      findings,
      result: {
        ...gate.result,
        effectiveStatus,
        blockingCount,
        advisoryCount,
      },
    };
  });
  return changed ? { ...reviewRun, status: summarizeReviewRunStatus(gates), gates } : reviewRun;
}

export function reviewEvidenceTargetsEqual(left: ReviewEvidenceTarget, right: ReviewEvidenceTarget): boolean {
  return left.branchName === right.branchName
    && left.sha === right.sha
    && left.worktreeStatusDigest === right.worktreeStatusDigest
    && left.worktreeMaterialTreeHash === right.worktreeMaterialTreeHash
    && left.taskBindingId === right.taskBindingId
    && left.reviewTargetDigest === right.reviewTargetDigest;
}

export function currentCheckoutReviewEvidenceTarget(repoRoot: string): ReviewEvidenceTarget {
  const context = resolveWorkflowContext(repoRoot);
  const worktreeStatus = readWorktreeStatusSnapshot(repoRoot, {
    includeStatusDigest: true,
    includeMaterialTreeHash: true,
  });
  const lock = loadAllTaskLocks(context.commonDir, context.config).find((candidate) =>
    candidate.branchName === worktreeStatus.branchName
    && normalizeExistingPath(candidate.worktreePath) === normalizeExistingPath(repoRoot)
  );
  const migratedLock = lock ? ensureTaskBindingId(context.commonDir, context.config, lock.taskSlug) : null;
  const taskBindingId = migratedLock?.taskBindingId ?? '';
  let reviewTargetDigest = crypto.createHash('sha256').update(canonicalize({
    version: 2,
    branchName: worktreeStatus.branchName,
    sha: worktreeStatus.head,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeMaterialTreeHash: worktreeStatus.materialTreeHash ?? '',
  })).digest('hex');
  let worktreeStatusDigest = worktreeStatus.statusDigest;
  let worktreeStatusReliable = worktreeStatus.statusDigestReliable;
  let worktreeStatusWarnings = worktreeStatus.statusDigestWarnings;
  let worktreeMaterialTreeHash = worktreeStatus.materialTreeHash ?? '';
  let worktreeMaterialTreeReliable = worktreeStatus.materialTreeReliable === true;
  let worktreeMaterialTreeWarnings = worktreeStatus.materialTreeWarnings ?? [];
  if (context.config.reviewGates?.enforcementMode === 'strict-v3') {
    try {
      const strictTarget = buildReviewTargetManifest(repoRoot, context.config.baseBranch).manifest;
      reviewTargetDigest = strictTarget.targetDigest;
      worktreeStatusDigest = strictTarget.worktreeStatusDigest;
      worktreeStatusReliable = true;
      worktreeStatusWarnings = [];
      worktreeMaterialTreeHash = strictTarget.materialTreeHash;
      worktreeMaterialTreeReliable = true;
      worktreeMaterialTreeWarnings = [];
    } catch {
      // An exact status/material identity still permits informed consent when
      // target capture itself is the blocking condition.
    }
  }
  return {
    branchName: worktreeStatus.branchName,
    sha: worktreeStatus.head,
    worktreeStatusDigest,
    worktreeStatusReliable,
    worktreeStatusWarnings,
    worktreeMaterialTreeHash,
    worktreeMaterialTreeReliable,
    worktreeMaterialTreeWarnings,
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

export function formatReviewEvidenceBlocker(
  context: WorkflowContext,
  issues: ReviewEvidenceIssue[],
  command = formatWorkflowCommand(context.config, 'pr'),
  latestOverride?: ReviewRunRecord | null,
  consents: ReviewConsentRecord[] = [],
): string {
  const latest = latestOverride === undefined ? selectCurrentReviewEvidenceRecord(context) : latestOverride;
  const gateIds = issues.flatMap((issue) => issue.gateId ? [issue.gateId] : []);
  const evidenceLines = latest
    ? renderReviewPresentation(projectReviewRun(latest, {
        artifactRoot: reviewArtifactRoot(context.commonDir, context.config),
        relation: 'current',
        consents,
      }), {
        gateIds: gateIds.length > 0 ? gateIds : undefined,
        includePassed: gateIds.length > 0,
      })
    : [];
  const bypassCommands = (context.config.reviewGates?.gates ?? [])
    .filter((gate) => gate.blocking !== false)
    .map((gate) => `/pipelane review override --gate ${gate.id} --scope=${JSON.stringify(command)} --reason "<why this exact target and action may proceed despite ${gate.id}>"`);
  return [
    `${command} blocked because review gate evidence is not ready.`,
    ...issues.map((issue) => `- ${issue.message}`),
    ...(evidenceLines.length > 0 ? ['', 'Review evidence details:', ...evidenceLines] : []),
    `Recommended: Run /pipelane review${context.config.reviewGates?.enforcementMode === 'strict-v3' ? ' --intent "<what this change should accomplish>"' : ''} after repairing the evidence source or findings, then retry ${command}.`,
    ...(bypassCommands.length > 0 ? [
      'Proceed anyway only with explicit informed consent for every blocking gate in scope:',
      ...bypassCommands,
      'A bypass never relabels failed, pending, unavailable, or malformed evidence as passed.',
    ] : []),
  ].join('\n');
}

function collectReviewEvidenceIssues(options: {
  latest: ReviewRunRecord | null;
  expectedGates: ReviewGateConfig[];
  externalEvidence: ReviewExternalEvidenceRecord[];
  strictIndependentAi: boolean;
  strictEvidence: boolean;
  artifactRoot: string;
  currentReviewTargetDigest: string;
  expectedEnforcementMode: 'legacy-v2' | 'strict-v3';
  expectedPolicyVersion: number;
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
    externalEvidence,
    strictIndependentAi,
    strictEvidence,
    artifactRoot,
    currentReviewTargetDigest,
    expectedEnforcementMode,
    expectedPolicyVersion,
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
      ? [{
          status: 'missing' as const,
          message: 'no review run has been recorded for this checkout',
          blocking: true,
        }, ...blockingGates.map((gate) => ({
          status: 'missing' as const,
          gateId: gate.id,
          message: `configured gate ${gate.id} has no review run for this checkout`,
          blocking: true,
        }))]
      : [{
          status: 'missing',
          message: 'no review run has been recorded for this checkout',
          blocking: true,
        }];
  }

  const issues: ReviewEvidenceIssue[] = [];
  if (
    latest.enforcementMode !== undefined
    && (latest.enforcementMode !== expectedEnforcementMode || latest.policyVersion !== expectedPolicyVersion)
  ) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} used ${latest.enforcementMode} policy ${latest.policyVersion ?? 'unknown'}, not ${expectedEnforcementMode} policy ${expectedPolicyVersion}; rerun review after the mode change`,
      blocking: true,
    });
  }
  if (strictEvidence && (latest.enforcementMode !== 'strict-v3' || latest.policyVersion !== expectedPolicyVersion)) {
    issues.push({
      status: 'incomplete',
      message: `latest review ${latest.id} is legacy evidence and cannot satisfy strict-v3; rerun review or use an exact-scope informed bypass`,
      blocking: true,
    });
  }
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

  if (strictEvidence) {
    if (!latest.intent) {
      issues.push({ status: 'incomplete', message: `latest review ${latest.id} has no authoritative intent evidence`, blocking: true });
    }
    if (!latest.target) {
      issues.push({ status: 'incomplete', message: `latest review ${latest.id} has no immutable target manifest`, blocking: true });
    } else if (latest.target.targetDigest !== currentReviewTargetDigest) {
      issues.push({ status: 'incomplete', message: `latest review ${latest.id} targets a different immutable checkout`, blocking: true });
    }
  }

  for (const gate of latest.gates) {
    const blocking = gate.blocking !== false;
    if (!blocking) continue;
    const expected = expectedGates.find((candidate) => candidate.id === gate.gateId);
    const recordedExternal = gate.externalEvidenceId
      ? externalEvidence.find((record) => record.id === gate.externalEvidenceId)
      : undefined;
    let recordedExternalValid = false;
    if (gate.externalEvidenceId) {
      const error = validateRecordedExternalReviewEvidence({
        reviewRun: latest,
        gate,
        expected,
        record: recordedExternal,
        policyVersion: expectedPolicyVersion,
        enforcementMode: expectedEnforcementMode,
        currentReviewTargetDigest,
      });
      if (error) {
        issues.push({ status: 'incomplete', gateId: gate.gateId, message: error, blocking, gate });
      } else {
        recordedExternalValid = true;
      }
    }
    if (strictEvidence && (gate.type === 'skill' || gate.type === 'agent') && gate.status === 'passed' && !recordedExternalValid) {
      const strictSkill = expected?.id === 'karpathy-diff' || expected?.id === 'karpathy-audit';
      const capabilityOk = gate.capability?.wrapperCompatible === true
        && gate.capability.contractSupplied === true
        && gate.capability.effectiveCapability === (strictSkill ? 'contract-supplied-adapter' : 'role-equivalent-adapter');
      if (!capabilityOk) {
        issues.push({ status: 'incomplete', gateId: gate.gateId, message: `blocking gate ${gate.gateId} lacks compatible capability evidence`, blocking, gate });
      }
      if (!gate.result || (strictSkill && gate.result.protocolVersion !== 1) || gate.result.effectiveStatus !== 'passed') {
        issues.push({ status: 'incomplete', gateId: gate.gateId, message: `blocking gate ${gate.gateId} lacks a valid strict result envelope`, blocking, gate });
      }
      if (!gate.reportArtifact || gate.reportArtifact.diagnosticOnly) {
        issues.push({ status: 'incomplete', gateId: gate.gateId, message: `blocking gate ${gate.gateId} lacks an authoritative retained report artifact`, blocking, gate });
      } else {
        try {
          readVerifiedReviewArtifact(artifactRoot, gate.reportArtifact);
        } catch (error) {
          issues.push({ status: 'incomplete', gateId: gate.gateId, message: `blocking gate ${gate.gateId} report integrity failed: ${error instanceof Error ? error.message : String(error)}`, blocking, gate });
        }
      }
    }
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

function validateRecordedExternalReviewEvidence(options: {
  reviewRun: ReviewRunRecord;
  gate: ReviewGateRunRecord;
  expected: ReviewGateConfig | undefined;
  record: ReviewExternalEvidenceRecord | undefined;
  policyVersion: number;
  enforcementMode: ReviewExternalEvidenceRecord['enforcementMode'];
  currentReviewTargetDigest: string;
}): string | null {
  const { reviewRun, gate, expected, record } = options;
  if (!record) return `blocking gate ${gate.gateId} references missing recorded external review evidence ${gate.externalEvidenceId}`;
  if (!expected || gate.gateId !== 'code-review-high' || record.gateId !== gate.gateId) {
    return `recorded external review evidence ${record.id} is not sanctioned for gate ${gate.gateId}`;
  }
  if (
    record.gateDefinitionHash !== reviewGateDefinitionHash(expected)
    || record.policyVersion !== options.policyVersion
    || record.enforcementMode !== options.enforcementMode
  ) {
    return `recorded external review evidence ${record.id} is stale for the current ${gate.gateId} definition or policy`;
  }
  if (
    record.branchName !== reviewRun.branchName
    || record.sha !== reviewRun.sha
    || record.worktreeStatusDigest !== (reviewRun.worktreeStatusDigest ?? '')
    || record.worktreeMaterialTreeHash !== (reviewRun.worktreeMaterialTreeHash ?? '')
    || record.taskBindingId !== (reviewRun.taskBindingId ?? '')
    || record.reviewTargetDigest !== options.currentReviewTargetDigest
  ) {
    return `recorded external review evidence ${record.id} is for a different branch, HEAD, task binding, or worktree state`;
  }
  try {
    assertRecordedReviewArtifact(record.artifact);
  } catch (error) {
    return `recorded external review evidence ${record.id} failed artifact integrity: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
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
  // A reviewed record identifies the current content when the branch matches
  // and either the recorded SHA equals the current SHA or the reliable
  // material tree matches exactly (same content, different commit — the E1
  // channel). The latter is what lets a review recorded before a `/pr` commit
  // still attach equivalent evidence at `/merge` on the resulting commit,
  // whose tree the /pr backfill certified identical.
  const shaOrMaterialMatches = reviewRun.sha === options.currentSha
    || reviewRecordMaterialTreeMatchesCurrentWorktree(reviewRun, {
      currentWorktreeMaterialTreeHash: options.currentWorktreeMaterialTreeHash,
      currentWorktreeMaterialTreeReliable: options.currentWorktreeMaterialTreeReliable,
    });
  if (
    reviewRun.branchName !== options.currentBranch
    || !shaOrMaterialMatches
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

  // E6: a mode-compatible verdict-cache hit is equivalent to a fresh pass for
  // the exact current tree. Every consumer performs an exact-scope lookup —
  // all nine D13 qualifiers (gate definition, contract, tree, base tip,
  // review mode, reviewed scope, intent) are recomputed here and any that
  // cannot be reconstructed makes the cache a miss. Only full-mode entries
  // can qualify (delta scopes never equal a full scope), and signature/key
  // validity is enforced inside the store (D16).
  if (options.currentWorktreeMaterialTreeReliable === true && options.currentWorktreeMaterialTreeHash) {
    const configuredGates = options.context.config.reviewGates?.gates ?? [];
    for (const pendingGate of pendingManualGates) {
      const configuredGate = configuredGates.find((candidate) => candidate.id === pendingGate.gateId);
      if (!configuredGate) continue;
      const candidate = verdictCacheEvidenceCandidate({
        context: options.context,
        configuredGate,
        pendingGate,
        currentWorktreeMaterialTreeHash: options.currentWorktreeMaterialTreeHash,
        allRecords: options.allRecords,
      });
      if (candidate) evidenceCandidates.push(candidate);
    }
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
      capability: passed.capability,
      result: passed.result,
      findings: passed.findings,
      reportArtifact: passed.reportArtifact,
      manualAttestation: passed.manualAttestation,
      exitCode: passed.exitCode,
      signal: passed.signal,
      errorCode: passed.errorCode,
      errorMessage: passed.errorMessage,
      stdoutTail: passed.stdoutTail,
      stderrTail: passed.stderrTail,
    };
    if (passed.attester) attachedGate.attester = passed.attester;
    return attachedGate;
  });

  return attached
    ? { ...reviewRun, status: summarizeReviewRunStatus(gates), gates }
    : reviewRun;
}

// Pre-S3 contract identity: until the bundled judge/finder contract ships with
// its own digest (D3, slice S3), the reviewer contract consumed by an AI gate
// is pinned by the enforcement mode + policy version that render it, plus the
// gate's dispositioned-findings context — a recorded spin-off disposition
// changes the instructions the reviewer receives ("do not re-report"), so a
// verdict issued without that context must never be replayed after it exists.
// Shared by the review runner (write + consult) and the E6 evidence path so
// the two sides can never drift.
export function computeReviewVerdictContractDigest(options: {
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  gateId: string;
}): string {
  const enforcementMode = options.config.reviewGates?.enforcementMode ?? 'legacy-v2';
  const policyVersion = options.config.reviewGates?.policyVersion ?? REVIEW_GATES_POLICY_VERSION;
  const dispositionsDigest = crypto.createHash('sha256')
    .update(canonicalize(collectDispositionedKarpathyFindings(options)))
    .digest('hex');
  return crypto.createHash('sha256').update(canonicalize({
    contract: 'pre-s3-gate-policy',
    enforcementMode,
    policyVersion,
    dispositionsDigest,
  })).digest('hex');
}

// Full-mode reviewed-scope digest over the exact path set a full review
// covers (D13's reviewedScopeDigest until S5 introduces delta hunk sets).
export function computeFullReviewedScopeDigest(changedFiles: string[]): string {
  return crypto.createHash('sha256').update(canonicalize({
    scope: 'full-changed-paths',
    paths: [...changedFiles].sort(),
  })).digest('hex');
}

// E6 scope reconstruction (legacy-v2 only): every D13 qualifier except
// intentDigest, derived from the current checkout. Returns null — a cache
// miss — whenever the current checkout is not exactly the evidence tree or any
// qualifier cannot be recomputed, so stale-base/stale-contract/stale-scope
// entries can never satisfy an evidence check. strict-v3 does not participate
// in the verdict cache in S2 (see computeAiReviewGateVerdictScope), so callers
// never reach here under strict.
function computeEvidenceVerdictScopeBase(
  context: WorkflowContext,
  configuredGate: ReviewGateConfig,
  currentWorktreeMaterialTreeHash: string,
): Omit<ReviewVerdictScope, 'intentDigest'> | null {
  const config = context.config;
  const checkout = currentCheckoutReviewEvidenceTarget(context.repoRoot);
  if (
    checkout.worktreeMaterialTreeReliable !== true
    || checkout.worktreeMaterialTreeHash !== currentWorktreeMaterialTreeHash
  ) {
    return null;
  }
  let contractDigest: string;
  try {
    contractDigest = computeReviewVerdictContractDigest({
      repoRoot: context.repoRoot,
      commonDir: context.commonDir,
      config,
      gateId: configuredGate.id,
    });
  } catch {
    return null;
  }
  let baseTipOid: string;
  try {
    baseTipOid = resolveBaseTip(context.repoRoot, config.baseBranch);
  } catch {
    return null;
  }
  return {
    gateId: configuredGate.id,
    gateDefinitionHash: reviewGateDefinitionHash(configuredGate),
    contractDigest,
    materialTreeHash: currentWorktreeMaterialTreeHash,
    baseTipOid,
    reviewMode: 'full',
    deltaBaseTree: '',
    reviewedScopeDigest: computeFullReviewedScopeDigest(collectChangedFiles(context.repoRoot, config.baseBranch)),
  };
}

// E6 candidate construction via exact-scope lookup (legacy-v2). The signed
// entry proves the verdict; the original gate record (resolved by reviewRunId
// provenance when review-state still retains it) supplies full evidence
// fidelity — findings, capability, result envelope, and report artifact. The
// entry's key already binds the CONFIGURED gate definition, so the original
// record is matched by identity (gateId/status/manual), not by re-hashing its
// runtime command fields; when the run was pruned, the entry's own attested
// pass is accepted (D7).
function verdictCacheEvidenceCandidate(options: {
  context: WorkflowContext;
  configuredGate: ReviewGateConfig;
  pendingGate: ReviewGateRunRecord;
  currentWorktreeMaterialTreeHash: string;
  allRecords: ReviewRunRecord[];
}): { recordedAt: string; gate: ReviewGateRunRecord } | null {
  const { context, configuredGate, pendingGate } = options;
  if (context.config.reviewGates?.enforcementMode === 'strict-v3') return null;
  const scopeBase = computeEvidenceVerdictScopeBase(context, configuredGate, options.currentWorktreeMaterialTreeHash);
  if (!scopeBase) return null;
  const hit = lookupReviewVerdict(context.commonDir, context.config, { ...scopeBase, intentDigest: '' });
  if (!hit || hit.status !== 'passed') return null;
  const originalGate = findOriginalVerdictGateRecord(options.allRecords, hit, pendingGate.gateId);
  return originalGate
    ? originalGateVerdictCandidate(pendingGate, originalGate, hit)
    : {
        recordedAt: hit.recordedAt,
        gate: {
          ...pendingGate,
          status: 'passed',
          summary: `verdict cache hit: full-mode passed verdict for this exact scope recorded ${hit.recordedAt} by review run ${hit.reviewRunId}`,
          startedAt: hit.recordedAt,
          finishedAt: hit.recordedAt,
          durationMs: 0,
          ...(hit.attester ? { attester: hit.attester } : {}),
        },
      };
}

function findOriginalVerdictGateRecord(
  records: ReviewRunRecord[],
  hit: ReviewVerdictEntry,
  gateId: string,
): ReviewGateRunRecord | null {
  const run = records.find((record) => record.id === hit.reviewRunId);
  return run?.gates.find((gate) =>
    gate.gateId === gateId
    && gate.status === hit.status
    && !gate.externalEvidenceId
    && isPassedManualReviewGate(gate)
  ) ?? null;
}

// The candidate keeps the pending gate's definition fields (current config),
// takes the authorization-relevant `attester` from the SIGNED cache hit, and
// imports only presentation (findings, tails) from the retained original run.
// Review-state records are unsigned under the compatibility default, so nothing
// authorization-relevant is ever sourced from them — editing the retained
// record cannot swap in a fabricated independent identity to satisfy the AI-
// independence check (legacy is the only cached mode; capability/result/report
// are strict-only evidence and are intentionally not carried here).
function originalGateVerdictCandidate(
  pendingGate: ReviewGateRunRecord,
  originalGate: ReviewGateRunRecord,
  hit: ReviewVerdictEntry,
): { recordedAt: string; gate: ReviewGateRunRecord } {
  return {
    recordedAt: hit.recordedAt,
    gate: {
      ...pendingGate,
      status: 'passed',
      summary: `verdict cache hit (run ${hit.reviewRunId}): ${originalGate.summary}`,
      startedAt: hit.recordedAt,
      finishedAt: hit.recordedAt,
      durationMs: 0,
      ...(hit.attester ? { attester: hit.attester } : {}),
      ...(originalGate.findings ? { findings: originalGate.findings } : {}),
      ...(originalGate.stdoutTail ? { stdoutTail: originalGate.stdoutTail } : {}),
      ...(originalGate.stderrTail ? { stderrTail: originalGate.stderrTail } : {}),
    },
  };
}

// Dispositioned-findings context for a gate at the current checkout: spin-off
// dispositions and accepted findings that the next reviewer round is told not
// to re-report. Lives here (not commands/review.ts) because both the prompt
// renderers and the verdict-cache scope computation consume it, and the cache
// side must never drift from what the prompt actually contained.
export function collectDispositionedKarpathyFindings(options: {
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  gateId: string;
}): ReviewDispositionPromptEntry[] {
  if (options.gateId !== 'karpathy-diff') return [];
  const target = currentCheckoutReviewEvidenceTarget(options.repoRoot);
  const state = loadReviewState(options.commonDir, options.config);
  const entries: ReviewDispositionPromptEntry[] = [];
  for (const disposition of state.findingDispositions ?? []) {
    if (
      disposition.gateId !== options.gateId
      || disposition.branchName !== target.branchName
      || disposition.sha !== target.sha
      || disposition.worktreeStatusDigest !== target.worktreeStatusDigest
      || disposition.worktreeMaterialTreeHash !== target.worktreeMaterialTreeHash
      || disposition.taskBindingId !== target.taskBindingId
      || disposition.reviewTargetDigest !== target.reviewTargetDigest
    ) continue;
    entries.push({
      disposition: 'spin-off',
      findingRef: disposition.findingRef,
      severity: disposition.finding.severity,
      title: disposition.finding.title,
      ...(disposition.finding.location ? { location: disposition.finding.location } : {}),
      reason: disposition.reason,
      followUpTask: disposition.followUpTask,
    });
  }
  for (const consent of state.consents ?? []) {
    if (
      consent.kind !== 'accept-findings'
      || consent.gateId !== options.gateId
      || consent.branchName !== target.branchName
      || consent.sha !== target.sha
      || consent.worktreeStatusDigest !== target.worktreeStatusDigest
      || consent.worktreeMaterialTreeHash !== target.worktreeMaterialTreeHash
      || consent.taskBindingId !== target.taskBindingId
      || consent.reviewTargetDigest !== target.reviewTargetDigest
      || !consent.reviewRunId
    ) continue;
    const review = state.records.find((record) => record.id === consent.reviewRunId);
    const gate = review?.gates.find((candidate) => candidate.gateId === options.gateId);
    for (const finding of gate?.findings ?? []) {
      entries.push({
        disposition: 'accepted',
        findingRef: `${review!.id}/${gate!.gateId}/${finding.id}`,
        severity: finding.severity,
        title: finding.title,
        ...(finding.location ? { location: finding.location } : {}),
        reason: consent.reason,
      });
    }
  }
  const unique = new Map(entries.map((entry) => [`${entry.disposition}\0${entry.findingRef}`, entry]));
  return [...unique.values()];
}

// Changed-file collection for review scope. Lives here so evidence-time scope
// reconstruction and the review runner share one derivation (re-exported from
// commands/review.ts for existing consumers).
export function collectChangedFiles(repoRoot: string, baseBranch: string): string[] {
  const compareRef = runGit(repoRoot, ['rev-parse', '--verify', `origin/${baseBranch}`], true)?.trim()
    ? `origin/${baseBranch}`
    : baseBranch;
  const mergeBase = runGit(repoRoot, ['merge-base', 'HEAD', compareRef], true)?.trim() ?? '';
  const outputs = [
    mergeBase ? runGit(repoRoot, ['diff', '--name-only', `${mergeBase}...HEAD`], true) ?? '' : '',
    runGit(repoRoot, ['diff', '--cached', '--name-only'], true) ?? '',
    runGit(repoRoot, ['diff', '--name-only'], true) ?? '',
    runGit(repoRoot, ['ls-files', '--others', '--exclude-standard'], true) ?? '',
  ];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const file = line.trim();
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

// E1 (merge-channel parity): /pr validated this record against the pre-commit
// checkout through the status-digest channel, then committed exactly that
// content. Backfilling the commit's tree hash as the record's material
// identity transfers that trust into the channel /merge can always check, so
// a record whose material capture was unreliable still satisfies /merge the
// way it satisfied /pr. The caller supplies `expectedCommitTree` — the
// write-tree of the reviewed pre-commit checkout — and the backfill refuses
// unless the committed HEAD tree equals it, so content introduced during the
// commit itself (a pre-commit hook, a concurrent writer restaging files) can
// never be certified as reviewed. Records that already carry a reliable
// material identity are left untouched, and legacy material-tree-only records
// remain acceptable to /merge unchanged.
export function backfillReviewEvidenceMaterialTreeFromCommit(
  context: WorkflowContext,
  reviewRunId: string,
  expectedCommitTree: string,
): string | null {
  if (!reviewRunId) return null;
  if (!/^[a-f0-9]{40,64}$/i.test(expectedCommitTree)) return null;
  const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const headTree = runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD^{tree}'], true)?.trim() ?? '';
  if (!branchName || !/^[a-f0-9]{40,64}$/i.test(headTree)) return null;
  if (headTree !== expectedCommitTree) return null;
  return withReviewStateLock(context.commonDir, context.config, () => {
    const state = loadReviewState(context.commonDir, context.config);
    const index = state.records.findIndex((record) => record.id === reviewRunId);
    if (index < 0) return null;
    const record = state.records[index];
    if (record.branchName !== branchName) return null;
    if (record.worktreeMaterialTreeReliable === true && record.worktreeMaterialTreeHash) return null;
    const { signature: _signature, ...unsignedFields } = {
      ...record,
      worktreeMaterialTreeHash: headTree,
      worktreeMaterialTreeReliable: true,
      worktreeMaterialTreeWarnings: ['material identity backfilled from the /pr commit tree (E1 merge-channel parity)'],
    };
    const unsigned: ReviewRunRecord = unsignedFields;
    const stateKey = resolveReviewStateKey();
    state.records[index] = stateKey
      ? { ...unsigned, signature: signSignedPayload(unsigned, stateKey) }
      : unsigned;
    saveReviewState(context.commonDir, context.config, state);
    return headTree;
  });
}

export function reviewGateDefinitionHash(gate: ReviewGateConfig | ReviewGateRunRecord): GateDefinitionHash {
  const id = 'gateId' in gate ? gate.gateId : gate.id;
  return crypto.createHash('sha256').update(canonicalize({
    id,
    phase: gate.phase,
    type: gate.type,
    blocking: gate.blocking !== false,
    command: normalizeOptionalGateField(gate.command),
    skill: normalizeOptionalGateField(gate.skill),
    role: normalizeOptionalGateField(gate.role),
    when: normalizeOptionalGateField(gate.when),
    whenChanged: gate.whenChanged ?? [],
    timeoutMs: gate.timeoutMs ?? null,
    userCommands: gate.userCommands ?? [],
    profiles: gate.profiles ?? [],
    baselineCommandId: normalizeOptionalGateField(gate.baselineCommandId),
    replacesBaselineCommandId: normalizeOptionalGateField(gate.replacesBaselineCommandId),
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
    && reviewRunsTargetSameCheckout(expected, evidence);
}

export function reviewRunsTargetSameCheckout(expected: ReviewRunRecord, evidence: ReviewRunRecord): boolean {
  return evidence.branchName === expected.branchName
    && evidence.sha === expected.sha
    && reviewRecordMatchesCurrentWorktree(evidence, {
      currentWorktreeStatusDigest: expected.worktreeStatusDigest ?? '',
      currentWorktreeStatusReliable: expected.worktreeStatusReliable,
      currentWorktreeMaterialTreeHash: expected.worktreeMaterialTreeHash ?? '',
      currentWorktreeMaterialTreeReliable: expected.worktreeMaterialTreeReliable,
    });
}

function isPassedManualReviewGate(gate: ReviewGateRunRecord): boolean {
  return gate.status === 'passed'
    && isManualReviewGateRun(gate)
    && gate.manualAttestation?.substitutionRequested !== true;
}

function manualReviewGateEvidenceMatches(expected: ReviewGateRunRecord, evidence: ReviewGateRunRecord): boolean {
  return isManualReviewGateRun(expected)
    && isManualReviewGateRun(evidence)
    && reviewGateDefinitionHash(expected) === reviewGateDefinitionHash(evidence);
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
