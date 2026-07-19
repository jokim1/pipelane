import crypto from 'node:crypto';

import {
  canonicalize,
} from './integrity.ts';
import {
  appendReviewOverrideRecord,
  ensureTaskBindingId,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadReviewState,
  nowIso,
  normalizeExistingPath,
  resolveWorkflowContext,
  runGit,
  type GateDefinitionHash,
  type OperatorFlags,
  type ReviewGateConfig,
  type ReviewGateRunRecord,
  type ReviewRunRecord,
  type WorkflowContext,
} from './state.ts';
import { buildReviewTargetManifest } from './review-contract.ts';
import { projectReviewRun, renderReviewPresentation } from './review-output.ts';
import { reviewArtifactRoot } from './state.ts';
import { resolveReviewActorIdentity } from './review-identity.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';

export type ReviewEvidenceGateStatus = 'missing' | 'failed' | 'pending';

export interface ReviewEvidenceIssue {
  status: ReviewEvidenceGateStatus;
  gateId?: string;
  message: string;
  gate?: ReviewGateRunRecord;
}

export interface ReviewEvidenceStaleness {
  reviewedSha: string;
  // Committed files changed between the reviewed sha and the evaluated head;
  // -1 when the reviewed sha is no longer resolvable locally.
  changedFileCount: number;
  dirtyWorktree: boolean;
}

export interface ReviewEvidenceCheckResult {
  allowed: boolean;
  latest: ReviewRunRecord | null;
  issues: ReviewEvidenceIssue[];
  staleness: ReviewEvidenceStaleness | null;
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
  return `${command} proceeded without green review evidence by informed consent: ${reason}`;
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

// Review evidence is informational: the evaluation reports what ran, what is
// open, and what is stale for the evaluated branch. Only missing, failed, or
// pending evidence asks for consent, and the single `--override --reason`
// flag always satisfies it (recorded, never re-checked). Staleness — commits
// or edits made after the reviewed sha — is a displayed fact, never a wall.
export function evaluateReviewEvidenceForPr(
  context: WorkflowContext,
  options: { latestOverride?: ReviewRunRecord | null; command?: string; target?: Pick<ReviewEvidenceTarget, 'branchName' | 'sha'> } = {},
): ReviewEvidenceCheckResult {
  const reviewState = loadReviewState(context.commonDir, context.config);
  const expectedGates = context.config.reviewGates?.gates ?? [];
  if (expectedGates.length === 0) {
    return {
      allowed: true,
      latest: options.latestOverride ?? reviewState.records[0] ?? null,
      issues: [],
      staleness: null,
      message: '',
    };
  }
  const target = options.target ?? currentBranchHeadTarget(context.repoRoot);
  const latest = options.latestOverride !== undefined
    ? options.latestOverride
    : selectLatestFullReviewRunForBranch(reviewState.records, target.branchName);
  const issues = collectReviewEvidenceIssues(latest, expectedGates);
  const staleness = computeReviewEvidenceStaleness(context.repoRoot, latest, target, !options.target);
  const routeAction = options.command ?? formatWorkflowCommand(context.config, 'pr');

  return {
    allowed: issues.length === 0,
    latest,
    issues,
    staleness,
    message: issues.length === 0
      ? ''
      : formatReviewEvidenceBlocker(context, issues, routeAction, latest, staleness),
  };
}

function currentBranchHeadTarget(repoRoot: string): { branchName: string; sha: string } {
  return {
    branchName: runGit(repoRoot, ['branch', '--show-current'], true)?.trim() ?? '',
    sha: runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '',
  };
}

function selectLatestFullReviewRunForBranch(records: ReviewRunRecord[], branchName: string): ReviewRunRecord | null {
  return records.find((record) =>
    record.branchName === branchName
    && record.dryRun !== true
    && !record.gateFilter
    && !record.phaseFilter
  ) ?? null;
}

export function selectCurrentReviewEvidenceRecord(
  context: WorkflowContext,
  records: ReviewRunRecord[] = loadReviewState(context.commonDir, context.config).records,
): ReviewRunRecord | null {
  const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  return selectLatestFullReviewRunForBranch(records, branchName);
}

function collectReviewEvidenceIssues(
  latest: ReviewRunRecord | null,
  expectedGates: ReviewGateConfig[],
): ReviewEvidenceIssue[] {
  const blockingGates = expectedGates.filter((gate) => gate.blocking !== false);
  if (!latest) {
    return [{
      status: 'missing',
      message: 'no full review run has been recorded for this branch',
    }];
  }

  const issues: ReviewEvidenceIssue[] = [];
  for (const gate of latest.gates) {
    if (gate.blocking === false) continue;
    if (gate.status === 'failed') {
      issues.push({
        status: 'failed',
        gateId: gate.gateId,
        message: `blocking gate ${gate.gateId} failed: ${gate.summary}`,
        gate,
      });
    } else if (gate.status === 'pending') {
      issues.push({
        status: 'pending',
        gateId: gate.gateId,
        message: `blocking gate ${gate.gateId} is pending: ${gate.summary}`,
        gate,
      });
    }
  }

  const observedGateIds = new Set(latest.gates.map((gate) => gate.gateId));
  for (const gateConfig of blockingGates) {
    if (!observedGateIds.has(gateConfig.id)) {
      issues.push({
        status: 'missing',
        gateId: gateConfig.id,
        message: `configured gate ${gateConfig.id} has not run yet (latest review ${latest.id} predates it)`,
      });
    }
  }

  if (latest.status !== 'passed' && issues.length === 0) {
    issues.push({
      status: latest.status === 'failed' ? 'failed' : 'pending',
      message: `latest review ${latest.id} status is ${latest.status}`,
    });
  }

  return issues;
}

function computeReviewEvidenceStaleness(
  repoRoot: string,
  latest: ReviewRunRecord | null,
  target: { branchName: string; sha: string },
  includeWorktreeState: boolean,
): ReviewEvidenceStaleness | null {
  if (!latest) return null;
  const dirtyWorktree = includeWorktreeState
    ? Boolean(runGit(repoRoot, ['status', '--short'], true)?.trim())
    : false;
  if (!latest.sha || !target.sha || latest.sha === target.sha) {
    return { reviewedSha: latest.sha, changedFileCount: 0, dirtyWorktree };
  }
  const diff = runGit(repoRoot, ['diff', '--name-only', `${latest.sha}..${target.sha}`], true);
  return {
    reviewedSha: latest.sha,
    changedFileCount: diff === null ? -1 : diff.split('\n').filter((line) => line.trim().length > 0).length,
    dirtyWorktree,
  };
}

// The informational block shown by /pr and /merge regardless of outcome:
// what ran, what's open, what's stale.
export function formatReviewEvidenceStatusLines(evidence: ReviewEvidenceCheckResult): string[] {
  const lines: string[] = [];
  if (!evidence.latest) {
    lines.push('Review: no full review run recorded for this branch.');
    return lines;
  }
  const latest = evidence.latest;
  const failed = latest.gates.filter((gate) => gate.blocking !== false && gate.status === 'failed');
  const pending = latest.gates.filter((gate) => gate.blocking !== false && gate.status === 'pending');
  const passed = latest.gates.filter((gate) => gate.status === 'passed');
  lines.push(`Review: ${latest.id} — ${latest.status} at ${shortSha(latest.sha)} (${passed.length} passed, ${failed.length} failed, ${pending.length} pending).`);
  if (failed.length > 0) {
    lines.push(`Open failed gates: ${failed.map((gate) => gate.gateId).join(', ')}.`);
  }
  if (pending.length > 0) {
    lines.push(`Open pending gates: ${pending.map((gate) => gate.gateId).join(', ')}.`);
  }
  const staleness = evidence.staleness;
  if (staleness) {
    if (staleness.changedFileCount === 0 && !staleness.dirtyWorktree) {
      lines.push('Review is current for this head.');
    } else {
      const parts: string[] = [];
      if (staleness.changedFileCount > 0) {
        parts.push(`${staleness.changedFileCount} file(s) changed since the reviewed commit ${shortSha(staleness.reviewedSha)}`);
      } else if (staleness.changedFileCount < 0) {
        parts.push(`the reviewed commit ${shortSha(staleness.reviewedSha)} is no longer resolvable locally`);
      }
      if (staleness.dirtyWorktree) {
        parts.push('the worktree has uncommitted changes');
      }
      if (parts.length > 0) {
        lines.push(`Stale: ${parts.join('; ')}.`);
      }
    }
  }
  return lines;
}

export function formatReviewEvidenceBlocker(
  context: WorkflowContext,
  issues: ReviewEvidenceIssue[],
  command = formatWorkflowCommand(context.config, 'pr'),
  latest: ReviewRunRecord | null = null,
  staleness: ReviewEvidenceStaleness | null = null,
): string {
  const gateIds = issues.flatMap((issue) => issue.gateId ? [issue.gateId] : []);
  const evidenceLines = latest
    ? renderReviewPresentation(projectReviewRun(latest, {
        artifactRoot: reviewArtifactRoot(context.commonDir, context.config),
        relation: 'current',
      }), {
        gateIds: gateIds.length > 0 ? gateIds : undefined,
        includePassed: gateIds.length > 0,
      })
    : [];
  return [
    `${command} needs review consent because review evidence is not green for this branch:`,
    ...issues.map((issue) => `- ${issue.message}`),
    ...(evidenceLines.length > 0 ? ['', 'Review evidence details:', ...evidenceLines] : []),
    ...(staleness && staleness.changedFileCount > 0
      ? [`Note: ${staleness.changedFileCount} file(s) changed since the reviewed commit (informational, never blocking on its own).`]
      : []),
    `Recommended: run /pipelane review, then retry ${command}.`,
    `Or proceed now with informed consent: ${command} --override --reason "<why this may proceed without green review evidence>".`,
    'The override and reason are recorded; failed or pending evidence is never relabeled as passed.',
  ].join('\n');
}

// Recording-integrity equality: `review record` and `review attest` refuse
// to bind evidence captured across a checkout mutation.
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
      // Recording falls back to the plain worktree snapshot when strict
      // target capture is unavailable.
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

function normalizeOptionalGateField(value: string | undefined): string {
  return value ?? '';
}

function shortSha(value: string): string {
  return value ? value.slice(0, 7) : 'unknown';
}
