import {
  formatWorkflowCommand,
  loadReviewState,
  type ReviewGateConfig,
  type ReviewGateRunRecord,
  type ReviewRunRecord,
  type WorkflowContext,
} from './state.ts';
import { blockingAiReviewEvidenceBlocker } from './review-identity.ts';
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
  headLabel?: string;
}

export function evaluateReviewEvidenceForPr(
  context: WorkflowContext,
  options: { latestOverride?: ReviewRunRecord | null; command?: string; target?: ReviewEvidenceTarget } = {},
): ReviewEvidenceCheckResult {
  const reviewState = loadReviewState(context.commonDir, context.config);
  const expectedGates = context.config.reviewGates?.gates ?? [];
  if (expectedGates.length === 0) {
    return {
      allowed: true,
      latest: options.latestOverride ?? reviewState.records[0] ?? null,
      issues: [],
      message: '',
    };
  }
  const target = options.target ?? currentCheckoutReviewEvidenceTarget(context.repoRoot);
  const latest = options.latestOverride ?? selectReviewEvidenceRecord(reviewState.records, {
    currentBranch: target.branchName,
    currentSha: target.sha,
    currentWorktreeStatusDigest: target.worktreeStatusDigest,
    currentWorktreeStatusReliable: target.worktreeStatusReliable,
    currentWorktreeMaterialTreeHash: target.worktreeMaterialTreeHash,
    currentWorktreeMaterialTreeReliable: target.worktreeMaterialTreeReliable,
  });
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

  return {
    allowed: issues.length === 0,
    latest,
    issues,
    message: issues.length === 0 ? '' : formatReviewEvidenceBlocker(context, issues, options.command),
  };
}

function currentCheckoutReviewEvidenceTarget(repoRoot: string): ReviewEvidenceTarget {
  const worktreeStatus = readWorktreeStatusSnapshot(repoRoot, {
    includeStatusDigest: true,
    includeMaterialTreeHash: true,
  });
  return {
    branchName: worktreeStatus.branchName,
    sha: worktreeStatus.head,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeStatusReliable: worktreeStatus.statusDigestReliable,
    worktreeStatusWarnings: worktreeStatus.statusDigestWarnings,
    worktreeMaterialTreeHash: worktreeStatus.materialTreeHash ?? '',
    worktreeMaterialTreeReliable: worktreeStatus.materialTreeReliable === true,
    worktreeMaterialTreeWarnings: worktreeStatus.materialTreeWarnings ?? [],
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
    return [{
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
