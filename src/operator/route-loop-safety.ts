import { createHash, randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';

import {
  buildDestinationPlanForCommand,
  canonicalizeDestinationFingerprint,
  destinationPlanFingerprintDigest,
  type DestinationPlan,
} from './destination-planner.ts';
import {
  DEFAULT_ROUTE_SAFETY,
  ensureTaskBindingId,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadRouteSafetyState,
  normalizePath,
  normalizeRouteSafetyConfig,
  nowIso,
  resolveWorkflowContext,
  runGit,
  saveRouteSafetyState,
  withRouteSafetyStateLock,
  type ParsedOperatorArgs,
  type ReviewRunRecord,
  type RouteSafetyRecord,
  type RouteSafetyResumeRecord,
  type RouteSafetyState,
  type WorkflowContext,
} from './state.ts';
import {
  evaluateReviewEvidenceForPr,
  recordReviewEvidenceConsents,
  type ReviewEvidenceCheckResult,
  type ReviewEvidenceIssue,
} from './review-enforcement.ts';
import { visibleReviewGateFailureOutput } from './review-output.ts';
import { reviewArtifactRoot } from './state.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';

export const ROUTE_SAFETY_FINGERPRINT_ENV = 'PIPELANE_ROUTE_SAFETY_FINGERPRINT';

export interface RouteSafetyPauseResult {
  action: 'continue' | 'stop';
  message: string;
}

interface RouteSafetyRouteIdentity {
  digest: string;
  fingerprint: string;
  attemptDigest: string;
  attemptFingerprint: string;
  worktreeStatusDigest: string;
  targetCommand: string;
  taskSlug: string;
  taskBindingId: string;
  durableTaskBinding: boolean;
  branchName: string;
  headSha: string;
}

interface PauseOptions {
  reason: string;
  issues?: ReviewEvidenceIssue[];
  latest?: ReviewRunRecord | null;
}

export function hasRouteSafetyResumeOverride(flags: ParsedOperatorArgs['flags']): boolean {
  return flags.oneMoreLoop
    || flags.moreLoops.trim().length > 0
    || flags.moreMinutes.trim().length > 0
    || flags.untilReviewPasses
    || flags.maxMoreLoops.trim().length > 0
    || flags.maxMoreMinutes.trim().length > 0
    || flags.acceptFindings
    || flags.scope.trim().length > 0;
}

export function routeSafetyDigestForPlan(plan: DestinationPlan): string {
  return destinationPlanFingerprintDigest(plan);
}

export async function evaluateDestinationRouteReviewSafety(
  context: WorkflowContext,
  plan: DestinationPlan,
  evidence: ReviewEvidenceCheckResult,
): Promise<RouteSafetyPauseResult> {
  const identity = routeIdentityForPlan(context, plan);
  const initialized = withRouteSafetyStateLock(context.commonDir, context.config, () => {
    const state = loadRouteSafetyState(context.commonDir, context.config);
    const record = updateRouteRecordWithReviewEvidence(state, identity, evidence.latest);
    saveRouteSafetyState(context.commonDir, context.config, state);
    return { state, record };
  });
  const { state, record } = initialized;
  if (record.legacyMigration?.status === 'pending') {
    return pauseRouteSafety(context, state, record, {
      reason: 'legacy route history is ambiguous and requires an explicit audited migration choice',
      issues: evidence.issues,
      latest: evidence.latest,
    });
  }
  if (evidence.allowed) {
    record.pauseReason = undefined;
    record.pausedAt = undefined;
    saveRouteSafetyState(context.commonDir, context.config, state);
    return { action: 'continue', message: '' };
  }

  const config = normalizeRouteSafetyConfig(context.config.routeSafety);
  const hasAcceptableFindings = reviewEvidenceIssuesAreAcceptableFindings(evidence);
  if (hasAcceptableFindings && routeFindingsAccepted(record, config, evidence.latest?.id ?? '')) {
    saveRouteSafetyState(context.commonDir, context.config, state);
    return { action: 'continue', message: '' };
  }

  const limitReason = routeLimitReason(record, config, { willRunAiReview: false });
  const findingReason = hasAcceptableFindings && config.stopOnMajorFindings
    ? 'blocking/major review findings are present'
    : '';
  const reason = findingReason || limitReason;
  if (!reason) {
    saveRouteSafetyState(context.commonDir, context.config, state);
    return { action: 'stop', message: evidence.message };
  }

  return pauseRouteSafety(context, state, record, {
    reason,
    issues: evidence.issues,
    latest: evidence.latest,
  });
}

export function guardReviewRunStartForRouteSafety(
  cwd: string,
  parsed: ParsedOperatorArgs,
): RouteSafetyPauseResult {
  const context = resolveWorkflowContext(cwd);
  const plan = buildReviewRoutePlan(cwd, parsed);
  const identity = plan ? routeIdentityForPlan(context, plan) : routeIdentityForCurrentReview(context);
  return withRouteSafetyStateLock(context.commonDir, context.config, () => {
    const state = loadRouteSafetyState(context.commonDir, context.config);
    const record = ensureRouteRecord(state, identity);
    const config = normalizeRouteSafetyConfig(context.config.routeSafety);
    const willRunAiReview = reviewRunMayUseAi(context.config.reviewGates?.gates ?? [], parsed);
    const reason = routeLimitReason(record, config, { willRunAiReview });
    if (!reason) {
      saveRouteSafetyState(context.commonDir, context.config, state);
      return { action: 'continue', message: '' };
    }
    markPaused(state, record, reason);
    saveRouteSafetyState(context.commonDir, context.config, state);
    return {
      action: 'stop',
      message: renderRouteSafetyPauseMessage(context, record, {
        reason,
        latest: null,
        issues: [],
      }),
    };
  });
}

export function recordReviewRunForRouteSafety(
  cwd: string,
  parsed: ParsedOperatorArgs,
  reviewRun: ReviewRunRecord,
): RouteSafetyPauseResult {
  const context = resolveWorkflowContext(cwd);
  const plan = buildReviewRoutePlan(cwd, parsed);
  const identity = plan ? routeIdentityForPlan(context, plan) : routeIdentityForCurrentReview(context);
  return withRouteSafetyStateLock(context.commonDir, context.config, () => {
    const state = loadRouteSafetyState(context.commonDir, context.config);
    const record = ensureRouteRecord(state, identity);
    countReviewRun(record, reviewRun);
    if (reviewRun.status === 'passed' && record.legacyMigration?.status !== 'pending') {
      record.pauseReason = undefined;
      record.pausedAt = undefined;
      saveRouteSafetyState(context.commonDir, context.config, state);
      return { action: 'continue', message: '' };
    }

    const config = normalizeRouteSafetyConfig(context.config.routeSafety);
    const reason = reviewRun.status === 'failed' && config.stopOnMajorFindings
      ? 'blocking/major review findings are present'
      : routeLimitReason(record, config, { willRunAiReview: false });
    if (!reason) {
      saveRouteSafetyState(context.commonDir, context.config, state);
      return { action: 'continue', message: '' };
    }
    markPaused(state, record, reason);
    saveRouteSafetyState(context.commonDir, context.config, state);
    return {
      action: 'stop',
      message: renderRouteSafetyPauseMessage(context, record, {
        reason,
        latest: reviewRun,
        issues: reviewIssuesFromRun(reviewRun),
      }),
    };
  });
}

export function routeSafetyAcceptsReviewFindings(
  cwd: string,
  parsed: ParsedOperatorArgs,
  evidence: ReviewEvidenceCheckResult,
): boolean {
  const context = resolveWorkflowContext(cwd);
  const config = normalizeRouteSafetyConfig(context.config.routeSafety);
  if (!reviewEvidenceIssuesAreAcceptableFindings(evidence)) return false;
  if (!config.stopOnMajorFindings) return true;

  const state = loadRouteSafetyState(context.commonDir, context.config);
  const envDigest = process.env[ROUTE_SAFETY_FINGERPRINT_ENV]?.trim() ?? '';
  if (envDigest) {
    const matchingAttempt = Object.values(state.routes).find((record) => record.currentAttemptDigest === envDigest);
    if (routeRecordAcceptsFindings(matchingAttempt, evidence.latest?.id ?? '', envDigest)) return true;
  }

  const plan = buildDestinationPlanForCommand(cwd, parsed);
  if (plan) {
    const identity = routeIdentityForPlan(context, plan);
    if (routeRecordAcceptsFindings(state.routes[identity.digest], evidence.latest?.id ?? '', identity.attemptDigest)) return true;
  }

  const reviewPlan = buildReviewRoutePlan(cwd, parsed);
  if (reviewPlan) {
    const identity = routeIdentityForPlan(context, reviewPlan);
    if (routeRecordAcceptsFindings(state.routes[identity.digest], evidence.latest?.id ?? '', identity.attemptDigest)) return true;
  }

  return false;
}

export function applyRouteSafetyResumeOverride(cwd: string, parsed: ParsedOperatorArgs): { message: string; record: RouteSafetyRecord } {
  const context = resolveWorkflowContext(cwd);
  let record: RouteSafetyRecord | null = null;
  let resume: RouteSafetyResumeRecord | null = null;
  let migrationMessage = '';
  withRouteSafetyStateLock(context.commonDir, context.config, () => {
    const state = loadRouteSafetyState(context.commonDir, context.config);
    record = findPausedRouteRecordForCurrentCheckout(context, state);
    if (!record) {
      throw new Error('No paused route-bound fix/review loop was found for this checkout. Re-run the route command to recreate the pause, then use the printed resume command.');
    }
    const migrationScope = parsed.flags.scope.trim();
    if (migrationScope) {
      const migration = record.legacyMigration;
      if (!migration || migration.status !== 'pending') {
        throw new Error('This route has no pending legacy budget migration. Re-run the route command and use only the choices it prints.');
      }
      const reason = parsed.flags.reason.trim();
      if (migrationScope === 'legacy-fresh-start') {
        resume = makeResumeRecord('legacy-fresh-start', 'resume', {
          reason,
          legacyMigrationAction: 'fresh-start',
        });
        record.legacyMigration = {
          ...migration,
          status: 'fresh-start',
          decidedAt: resume.recordedAt,
          reason,
        };
        migrationMessage = 'Started this new task binding with a fresh route budget by explicit informed choice.';
      } else {
        const sourceDigest = migrationScope.slice('legacy-import:'.length);
        if (!migration.candidateDigests.includes(sourceDigest)) {
          throw new Error(`Legacy route ${sourceDigest.slice(0, 12)} is not one of this migration's preserved candidates.`);
        }
        const source = state.routes[sourceDigest];
        if (!source || source.lineageVersion === 1) {
          throw new Error(`Legacy route candidate ${sourceDigest.slice(0, 12)} is no longer available. Re-run the route command before choosing a migration.`);
        }
        const allowances = mergeLegacyRouteBudget(record, [source]);
        resume = makeResumeRecord('legacy-import', 'resume', {
          reason,
          legacyMigrationAction: 'import',
          legacyMigrationSourceDigest: sourceDigest,
        });
        record.legacyMigration = {
          ...migration,
          status: 'imported',
          decidedAt: resume.recordedAt,
          reason,
          sourceDigest,
          ...allowances,
        };
        migrationMessage = `Imported the preserved budget from legacy route ${sourceDigest.slice(0, 12)} by explicit informed choice.`;
      }
      record.resumes = [resume, ...(record.resumes ?? [])].slice(0, 20);
      record.pauseReason = undefined;
      record.pausedAt = undefined;
    } else {
      resume = resumeRecordFromFlags(parsed);
      record.resumes = [resume, ...(record.resumes ?? [])].slice(0, 20);
      if (resume.acceptedFindings) {
        record.acceptedFindingsAt = resume.recordedAt;
        record.acceptedFindingsSource = 'resume --accept-findings';
        record.acceptedReviewRunId = record.lastReviewRunId;
        record.acceptedAttemptDigest = record.currentAttemptDigest;
      }
    }
    record.updatedAt = nowIso();
    state.latestPausedRouteFingerprintDigest = record.routeFingerprintDigest;
    saveRouteSafetyState(context.commonDir, context.config, state);
  });
  if (!record || !resume) throw new Error('Route safety resume could not be recorded.');
  if (resume.acceptedFindings) {
    const evidence = evaluateReviewEvidenceForPr(context, { command: record.targetCommand });
    recordReviewEvidenceConsents(
      context,
      evidence,
      record.targetCommand,
      resume.reason ?? 'accepted current findings through an explicit route resume',
      'accept-findings',
    );
  }
  return {
    record,
    message: migrationMessage || renderRouteSafetyResumeMessage(context, record, resume),
  };
}

async function pauseRouteSafety(
  context: WorkflowContext,
  state: RouteSafetyState,
  record: RouteSafetyRecord,
  options: PauseOptions,
): Promise<RouteSafetyPauseResult> {
  markPaused(state, record, options.reason);
  if (record.legacyMigration?.status === 'pending') {
    saveRouteSafetyState(context.commonDir, context.config, state);
    return {
      action: 'stop',
      message: renderRouteSafetyPauseMessage(context, record, options),
    };
  }
  if (!process.stdin.isTTY) {
    saveRouteSafetyState(context.commonDir, context.config, state);
    return {
      action: 'stop',
      message: renderRouteSafetyPauseMessage(context, record, options),
    };
  }

  process.stderr.write(`${renderRouteSafetyInteractiveMenu(context, record, options)}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('Enter 1, 2, 3, 4, or 5 [1]: ')).trim();
    if (answer === '' || answer === '1') {
      saveRouteSafetyState(context.commonDir, context.config, state);
      return {
        action: 'stop',
        message: renderRouteSafetyPauseMessage(context, record, options),
      };
    }
    if (answer === '2') {
      record.resumes = [makeResumeRecord('one-more-loop', 'tty', { oneMoreLoop: true }), ...(record.resumes ?? [])].slice(0, 20);
      saveRouteSafetyState(context.commonDir, context.config, state);
      return {
        action: 'stop',
        message: 'Recorded: allow one more fix/review loop for this route. Stop here, fix the findings, then rerun /pipelane review.',
      };
    }
    if (answer === '3') {
      const moreLoops = await questionPositiveInteger(rl, 'How many more fix/review loops? ');
      const moreMinutes = await questionPositiveInteger(rl, 'How many more minutes? ');
      record.resumes = [makeResumeRecord('more-loops-and-minutes', 'tty', { moreLoops, moreMinutes }), ...(record.resumes ?? [])].slice(0, 20);
      saveRouteSafetyState(context.commonDir, context.config, state);
      return {
        action: 'stop',
        message: `Recorded: allow ${moreLoops} more fix/review loop${moreLoops === 1 ? '' : 's'} and ${moreMinutes} more minutes for this route.`,
      };
    }
    if (answer === '4') {
      const confirmation = (await rl.question('Type "proceed with blocked evidence" to confirm: ')).trim();
      if (confirmation !== 'proceed with blocked evidence') {
        saveRouteSafetyState(context.commonDir, context.config, state);
        return {
          action: 'stop',
          message: 'Confirmation did not match. Stop here and show review findings.',
        };
      }
      const reason = (await rl.question('Why may this exact target and route proceed despite the blocked evidence? ')).trim();
      if (!reason) {
        saveRouteSafetyState(context.commonDir, context.config, state);
        return { action: 'stop', message: 'A non-empty informed-consent reason is required. Findings remain blocked.' };
      }
      const resume = makeResumeRecord('accept-findings', 'tty', {
        acceptedFindings: true,
        confirmation,
        reason,
      });
      record.resumes = [resume, ...(record.resumes ?? [])].slice(0, 20);
      record.acceptedFindingsAt = resume.recordedAt;
      record.acceptedFindingsSource = 'TTY option 4: proceed with blocked evidence';
      record.acceptedReviewRunId = record.lastReviewRunId;
      record.acceptedAttemptDigest = record.currentAttemptDigest;
      recordReviewEvidenceConsents(context, {
        allowed: false,
        latest: options.latest ?? null,
        issues: options.issues ?? [],
        bypassedIssues: [],
        consents: [],
        message: '',
      }, record.targetCommand, reason, 'accept-findings');
      saveRouteSafetyState(context.commonDir, context.config, state);
      return {
        action: 'continue',
        message: 'Recorded: findings accepted by the user for this exact route and target. The gates remain failed; they were not relabeled as passed.',
      };
    }
    if (answer === '5') {
      const maxMoreLoops = await questionPositiveInteger(rl, 'Maximum more fix/review loops? ');
      const maxMoreMinutes = await questionPositiveInteger(rl, 'Maximum more minutes? ');
      record.resumes = [makeResumeRecord('until-review-passes', 'tty', { maxMoreLoops, maxMoreMinutes }), ...(record.resumes ?? [])].slice(0, 20);
      saveRouteSafetyState(context.commonDir, context.config, state);
      return {
        action: 'stop',
        message: `Recorded: keep going until review passes, with explicit limits of ${maxMoreLoops} more fix/review loop${maxMoreLoops === 1 ? '' : 's'} and ${maxMoreMinutes} more minutes.`,
      };
    }
    saveRouteSafetyState(context.commonDir, context.config, state);
    return {
      action: 'stop',
      message: renderRouteSafetyPauseMessage(context, record, options),
    };
  } finally {
    rl.close();
  }
}

export function renderRouteSafetyInteractiveMenu(
  context: WorkflowContext,
  record: RouteSafetyRecord,
  options: PauseOptions,
): string {
  return [
    renderRouteSafetyPauseMessage(context, record, options),
    '',
    'Choose the action to take:',
    '1. Stop here and show review findings',
    '2. Return to the host for one repair/review attempt',
    '3. Choose how many more loops and minutes to allow',
    '4. Proceed anyway for this exact target and route',
    '5. Keep going until review passes, with explicit limits',
  ].join('\n');
}

function renderRouteSafetyPauseMessage(
  context: WorkflowContext,
  record: RouteSafetyRecord,
  options: PauseOptions,
): string {
  const config = normalizeRouteSafetyConfig(context.config.routeSafety);
  const limits = effectiveLimits(record, config);
  const elapsed = elapsedMinutes(record.firstStartedAt);
  const lines = [
    `Route-bound delivery paused before ${record.targetCommand}.`,
    `Reason: ${options.reason}.`,
    `Route: ${record.routeFingerprintDigest.slice(0, 12)}`,
    `Fix/review loops: ${record.fixReviewLoops}/${limits.fixReviewLoops}`,
    `Minutes: ${elapsed}/${limits.minutes}`,
    `AI review runs: ${record.aiReviewRuns}/${limits.aiReviewRuns}`,
  ];
  const findings = formatReviewFindings(options, reviewArtifactRoot(context.commonDir, context.config));
  if (findings.length > 0) {
    lines.push('', 'Review findings:', ...findings);
  }
  const bypassCommands = (context.config.reviewGates?.gates ?? [])
    .filter((gate) => gate.blocking !== false)
    .map((gate) => `pipelane run review override --gate ${gate.id} --scope=${JSON.stringify(record.targetCommand)} --reason="<why this exact target and route may proceed despite ${gate.id}>"`);
  lines.push(
    '',
    'Recommended recovery: repair every blocking finding or unavailable/pending evidence source, rerun /pipelane review, then retry the route.',
    ...(bypassCommands.length > 0 ? [
      'Exact-scope informed bypasses (one consent per configured blocking gate; evidence remains failed or pending):',
      ...bypassCommands,
    ] : []),
    '',
    'Resume commands:',
    'pipelane resume --one-more-loop',
    'pipelane resume --more-loops=2 --more-minutes=45',
    'pipelane resume --until-review-passes --max-more-loops=3 --max-more-minutes=120',
    'pipelane resume --accept-findings --reason="<why this exact target and route may proceed despite the blocked evidence>"',
  );
  if (record.legacyMigration?.status === 'pending') {
    lines.push(
      '',
      'Legacy budget migration choices (the preserved records are not silently imported or reset):',
      ...record.legacyMigration.candidateDigests.map((digest) =>
        `pipelane resume --scope=legacy-import:${digest} --reason="<why this legacy budget belongs to this task>"`
      ),
      'pipelane resume --scope=legacy-fresh-start --reason="<why a fresh budget is correct>"',
    );
  }
  return lines.join('\n');
}

function renderRouteSafetyResumeMessage(
  context: WorkflowContext,
  record: RouteSafetyRecord,
  resume: RouteSafetyResumeRecord,
): string {
  const config = normalizeRouteSafetyConfig(context.config.routeSafety);
  const limits = effectiveLimits(record, config);
  const action = resume.kind === 'one-more-loop'
    ? 'Allowed one more fix/review loop.'
    : resume.kind === 'more-loops-and-minutes'
      ? `Allowed ${resume.moreLoops} more fix/review loops and ${resume.moreMinutes} more minutes.`
      : resume.kind === 'until-review-passes'
        ? `Will keep going until review passes, with explicit limits of ${resume.maxMoreLoops} more fix/review loops and ${resume.maxMoreMinutes} more minutes.`
        : 'Accepted current review findings for this route.';
  return [
    action,
    `Route: ${record.routeFingerprintDigest.slice(0, 12)}`,
    `Fix/review loops allowed: ${limits.fixReviewLoops}`,
    `Minutes allowed: ${limits.minutes}`,
    `AI review runs allowed: ${limits.aiReviewRuns}`,
    `Next: rerun ${record.targetCommand}.`,
  ].join('\n');
}

function routeLimitReason(
  record: RouteSafetyRecord,
  config: Required<typeof DEFAULT_ROUTE_SAFETY>,
  options: { willRunAiReview: boolean },
): string {
  if (record.legacyMigration?.status === 'pending') {
    return 'legacy route history is ambiguous and requires an explicit audited migration choice';
  }
  const limits = effectiveLimits(record, config);
  if (record.fixReviewLoops >= limits.fixReviewLoops && record.lastReviewStatus !== 'passed') {
    return `fix/review loops reached ${limits.fixReviewLoops}`;
  }
  const elapsed = elapsedMinutes(record.firstStartedAt);
  if (elapsed >= limits.minutes) {
    return `minutes reached ${limits.minutes}`;
  }
  if (options.willRunAiReview && record.aiReviewRuns >= limits.aiReviewRuns) {
    return `AI review runs reached ${limits.aiReviewRuns}`;
  }
  return '';
}

function effectiveLimits(record: RouteSafetyRecord, config: Required<typeof DEFAULT_ROUTE_SAFETY>): { fixReviewLoops: number; minutes: number; aiReviewRuns: number } {
  let extraLoops = record.legacyMigration?.extraLoops ?? 0;
  let extraMinutes = record.legacyMigration?.extraMinutes ?? 0;
  for (const resume of record.resumes ?? []) {
    if (resume.oneMoreLoop) {
      extraLoops += 1;
      continue;
    }
    extraLoops += resume.moreLoops ?? 0;
    extraLoops += resume.maxMoreLoops ?? 0;
    extraMinutes += resume.moreMinutes ?? 0;
    extraMinutes += resume.maxMoreMinutes ?? 0;
  }
  return {
    fixReviewLoops: config.defaultFixReviewLoops + extraLoops,
    minutes: config.defaultMinutes + extraMinutes,
    aiReviewRuns: config.defaultAiReviewRuns + extraLoops,
  };
}

function updateRouteRecordWithReviewEvidence(
  state: RouteSafetyState,
  identity: RouteSafetyRouteIdentity,
  latest: ReviewRunRecord | null,
): RouteSafetyRecord {
  const record = ensureRouteRecord(state, identity);
  if (latest) countReviewRun(record, latest);
  return record;
}

function ensureRouteRecord(state: RouteSafetyState, identity: RouteSafetyRouteIdentity): RouteSafetyRecord {
  const existing = state.routes[identity.digest];
  const timestamp = nowIso();
  if (existing) {
    existing.updatedAt = timestamp;
    existing.targetCommand = identity.targetCommand;
    existing.taskSlug = identity.taskSlug;
    existing.branchName = identity.branchName;
    existing.headSha = identity.headSha;
    existing.taskBindingId = identity.taskBindingId;
    recordExactAttempt(existing, identity);
    return existing;
  }

  const legacy = legacyRouteCandidates(state, identity);
  const record: RouteSafetyRecord = {
    lineageVersion: 1,
    lineageDigest: identity.digest,
    lineageFingerprint: identity.fingerprint,
    taskBindingId: identity.taskBindingId,
    routeFingerprintDigest: identity.digest,
    routeFingerprint: identity.fingerprint,
    targetCommand: identity.targetCommand,
    taskSlug: identity.taskSlug,
    branchName: identity.branchName,
    headSha: identity.headSha,
    firstStartedAt: timestamp,
    updatedAt: timestamp,
    fixReviewLoops: 0,
    aiReviewRuns: 0,
    countedReviewRunIds: [],
  };
  if (legacy.exact.length > 0 && legacy.conflicting.length === 0 && identity.durableTaskBinding) {
    const allowances = mergeLegacyRouteBudget(record, legacy.exact.map((entry) => entry.record));
    record.legacyMigration = {
      status: 'imported',
      candidateDigests: legacy.exact.map((entry) => entry.digest),
      decidedAt: timestamp,
      reason: 'unambiguous automatic migration by project, task slug, branch, and target command',
      ...allowances,
    };
  } else if (legacy.exact.length > 0 || legacy.conflicting.length > 0) {
    record.legacyMigration = {
      status: 'pending',
      candidateDigests: [...legacy.exact, ...legacy.conflicting].map((entry) => entry.digest),
    };
  }
  recordExactAttempt(record, identity);
  state.routes[identity.digest] = record;
  return record;
}

interface LegacyRouteCandidate {
  digest: string;
  record: RouteSafetyRecord;
}

function legacyRouteCandidates(
  state: RouteSafetyState,
  identity: RouteSafetyRouteIdentity,
): { exact: LegacyRouteCandidate[]; conflicting: LegacyRouteCandidate[] } {
  const legacy = Object.entries(state.routes)
    .filter(([, record]) => record.lineageVersion !== 1 && !record.taskBindingId)
    .map(([digest, record]) => ({ digest, record }));
  const exact = legacy.filter(({ record }) =>
    record.targetCommand === identity.targetCommand
    && record.taskSlug === identity.taskSlug
    && record.branchName === identity.branchName
  );
  const exactDigests = new Set(exact.map((entry) => entry.digest));
  const conflicting = legacy.filter(({ digest, record }) => {
    if (exactDigests.has(digest) || record.targetCommand !== identity.targetCommand) return false;
    const missingIdentity = !record.taskSlug || !record.branchName || !identity.taskSlug || !identity.branchName;
    const reusedTaskSlug = Boolean(identity.taskSlug) && record.taskSlug === identity.taskSlug;
    const reusedBranch = Boolean(identity.branchName) && record.branchName === identity.branchName;
    return missingIdentity || reusedTaskSlug || reusedBranch;
  });
  return { exact, conflicting };
}

function mergeLegacyRouteBudget(target: RouteSafetyRecord, sources: RouteSafetyRecord[]): { extraLoops?: number; extraMinutes?: number } {
  if (sources.length === 0) return {};
  target.firstStartedAt = [target.firstStartedAt, ...sources.map((source) => source.firstStartedAt)]
    .sort()[0] ?? target.firstStartedAt;
  target.fixReviewLoops = Math.max(target.fixReviewLoops, ...sources.map((source) => source.fixReviewLoops));
  target.aiReviewRuns = Math.max(target.aiReviewRuns, ...sources.map((source) => source.aiReviewRuns));
  target.countedReviewRunIds = [...new Set([
    ...target.countedReviewRunIds,
    ...sources.flatMap((source) => source.countedReviewRunIds),
  ])].slice(0, 50);
  const allowanceTotals = sources.map(legacyResumeAllowanceTotals);
  const extraLoops = Math.max(0, ...allowanceTotals.map((entry) => entry.extraLoops));
  const extraMinutes = Math.max(0, ...allowanceTotals.map((entry) => entry.extraMinutes));
  const last = [...sources]
    .filter((source) => source.lastReviewRunId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (last?.lastReviewRunId) {
    target.lastReviewRunId = last.lastReviewRunId;
    target.lastReviewStatus = last.lastReviewStatus;
  }
  return {
    ...(extraLoops > 0 ? { extraLoops } : {}),
    ...(extraMinutes > 0 ? { extraMinutes } : {}),
  };
}

function legacyResumeAllowanceTotals(record: RouteSafetyRecord): { extraLoops: number; extraMinutes: number } {
  let extraLoops = 0;
  let extraMinutes = 0;
  for (const resume of record.resumes ?? []) {
    if (resume.kind === 'accept-findings' || resume.kind === 'legacy-import' || resume.kind === 'legacy-fresh-start') continue;
    extraLoops += resume.oneMoreLoop ? 1 : 0;
    extraLoops += resume.moreLoops ?? 0;
    extraLoops += resume.maxMoreLoops ?? 0;
    extraMinutes += resume.moreMinutes ?? 0;
    extraMinutes += resume.maxMoreMinutes ?? 0;
  }
  return { extraLoops, extraMinutes };
}

function recordExactAttempt(record: RouteSafetyRecord, identity: RouteSafetyRouteIdentity): void {
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

function countReviewRun(record: RouteSafetyRecord, reviewRun: ReviewRunRecord): void {
  if (record.countedReviewRunIds.includes(reviewRun.id)) {
    record.lastReviewRunId = reviewRun.id;
    record.lastReviewStatus = reviewRun.status;
    return;
  }
  record.countedReviewRunIds = [reviewRun.id, ...record.countedReviewRunIds].slice(0, 50);
  record.lastReviewRunId = reviewRun.id;
  record.lastReviewStatus = reviewRun.status;
  const attempt = record.attempts?.find((entry) => entry.digest === record.currentAttemptDigest);
  if (attempt) attempt.reviewRunId = reviewRun.id;
  if (reviewRun.status === 'failed') {
    record.fixReviewLoops += 1;
  }
  if (reviewRunUsesAiReview(reviewRun)) {
    record.aiReviewRuns += 1;
  }
}

function reviewRunUsesAiReview(reviewRun: ReviewRunRecord): boolean {
  return reviewRun.gates.some((gate) =>
    (gate.type === 'skill' || gate.type === 'agent')
    && gate.status !== 'skipped'
    && Boolean(gate.command)
    && gate.exitCode !== undefined
    && !(gate.status === 'pending' && gate.summary.startsWith('deferred:'))
    && gate.skipReason !== 'dry-run'
  );
}

function reviewRunMayUseAi(gates: Array<{ id: string; type: string; blocking?: boolean }>, parsed: ParsedOperatorArgs): boolean {
  if (parsed.flags.reviewDryRun) return false;
  const gateFilter = parsed.flags.reviewGate.trim();
  return gates.some((gate) =>
    (gate.type === 'skill' || gate.type === 'agent')
    && (!gateFilter || gate.id === gateFilter)
  );
}

/*
 * Stable lineage owns budgets; exact attempts own evidence and acceptance:
 *
 * binding + branch + route -> lineage --fix/commit--> attempt B --rerun--> review B
 *                                  | attempt A + review A --accept--> exact A only
 *                                  `--rebind/completion-----------> new lineage
 *
 * PR 3 adds the audited fix/token transitions without changing this identity split.
 */
function routeIdentityForPlan(context: WorkflowContext, plan: DestinationPlan): RouteSafetyRouteIdentity {
  const fp = plan.fingerprintInputs as { headSha?: unknown };
  const branchName = typeof (plan.fingerprintInputs as { branchName?: unknown }).branchName === 'string'
    ? String((plan.fingerprintInputs as { branchName?: unknown }).branchName)
    : '';
  const binding = resolveRouteTaskBinding(context, plan.taskSlug, branchName);
  const attemptFingerprint = canonicalizeDestinationFingerprint(plan.fingerprintInputs);
  const lineageFingerprint = canonicalizeDestinationFingerprint({
    serializationVersion: 1,
    projectKey: context.config.projectKey,
    taskBindingId: binding.taskBindingId,
    branchName,
    targetCommand: plan.targetCommand,
  });
  return {
    digest: createHash('sha256').update(lineageFingerprint).digest('hex'),
    fingerprint: lineageFingerprint,
    attemptDigest: createHash('sha256').update(attemptFingerprint).digest('hex'),
    attemptFingerprint,
    worktreeStatusDigest: typeof plan.fingerprintInputs.worktreeStatusDigest === 'string'
      ? plan.fingerprintInputs.worktreeStatusDigest
      : '',
    targetCommand: plan.targetCommand,
    taskSlug: binding.taskSlug,
    taskBindingId: binding.taskBindingId,
    durableTaskBinding: binding.durable,
    branchName,
    headSha: typeof fp.headSha === 'string' ? fp.headSha : '',
  };
}

function routeIdentityForCurrentReview(context: WorkflowContext): RouteSafetyRouteIdentity {
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
  const binding = resolveRouteTaskBinding(context, '', branchName);
  const lineageFingerprint = canonicalizeDestinationFingerprint({
    serializationVersion: 1,
    projectKey: context.config.projectKey,
    taskBindingId: binding.taskBindingId,
    branchName,
    targetCommand: formatWorkflowCommand(context.config, 'pr'),
  });
  return {
    digest: createHash('sha256').update(lineageFingerprint).digest('hex'),
    fingerprint: lineageFingerprint,
    attemptDigest: createHash('sha256').update(fingerprint).digest('hex'),
    attemptFingerprint: fingerprint,
    worktreeStatusDigest: status.statusDigest,
    targetCommand: formatWorkflowCommand(context.config, 'pr'),
    taskSlug: binding.taskSlug,
    taskBindingId: binding.taskBindingId,
    durableTaskBinding: binding.durable,
    branchName,
    headSha: status.head,
  };
}

function resolveRouteTaskBinding(
  context: WorkflowContext,
  requestedTaskSlug: string,
  branchName: string,
): { taskSlug: string; taskBindingId: string; durable: boolean } {
  if (requestedTaskSlug) {
    const lock = ensureTaskBindingId(context.commonDir, context.config, requestedTaskSlug);
    if (lock?.taskBindingId) {
      return { taskSlug: lock.taskSlug, taskBindingId: lock.taskBindingId, durable: true };
    }
  }
  const matches = loadAllTaskLocks(context.commonDir, context.config).filter((lock) =>
    lock.branchName === branchName && normalizePath(lock.worktreePath) === normalizePath(context.repoRoot)
  );
  if (matches.length === 1) {
    const lock = ensureTaskBindingId(context.commonDir, context.config, matches[0]!.taskSlug);
    if (lock?.taskBindingId) {
      return { taskSlug: lock.taskSlug, taskBindingId: lock.taskBindingId, durable: true };
    }
  }
  const taskSlug = requestedTaskSlug || '';
  const unboundIdentity = canonicalizeDestinationFingerprint({
    projectKey: context.config.projectKey,
    taskSlug,
    branchName,
    worktreePath: normalizePath(context.repoRoot),
  });
  return {
    taskSlug,
    taskBindingId: `unbound-${createHash('sha256').update(unboundIdentity).digest('hex').slice(0, 32)}`,
    durable: false,
  };
}

function buildReviewRoutePlan(cwd: string, parsed: ParsedOperatorArgs): DestinationPlan | null {
  return buildDestinationPlanForCommand(cwd, {
    ...parsed,
    command: 'pr',
    positional: [],
  });
}

function markPaused(state: RouteSafetyState, record: RouteSafetyRecord, reason: string): void {
  record.pausedAt = nowIso();
  record.pauseReason = reason;
  record.updatedAt = record.pausedAt;
  state.latestPausedRouteFingerprintDigest = record.routeFingerprintDigest;
}

function reviewEvidenceIssuesAreAcceptableFindings(evidence: ReviewEvidenceCheckResult): boolean {
  return Boolean(evidence.latest)
    && evidence.issues.length > 0
    && evidence.issues.every((issue) => issue.blocking && issue.status === 'failed');
}

function routeFindingsAccepted(record: RouteSafetyRecord, config: Required<typeof DEFAULT_ROUTE_SAFETY>, latestReviewRunId: string): boolean {
  return !config.stopOnMajorFindings || routeRecordAcceptsFindings(record, latestReviewRunId);
}

function routeRecordAcceptsFindings(
  record: RouteSafetyRecord | undefined,
  latestReviewRunId: string,
  expectedAttemptDigest = record?.currentAttemptDigest ?? '',
): boolean {
  return Boolean(
    record?.acceptedFindingsAt
    && latestReviewRunId
    && record.acceptedReviewRunId === latestReviewRunId
    && record.currentAttemptDigest
    && record.currentAttemptDigest === expectedAttemptDigest
    && record.acceptedAttemptDigest === record.currentAttemptDigest
  );
}

function findPausedRouteRecordForCurrentCheckout(context: WorkflowContext, state: RouteSafetyState): RouteSafetyRecord | null {
  const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const binding = resolveRouteTaskBinding(context, '', branchName);
  const latest = state.latestPausedRouteFingerprintDigest ? state.routes[state.latestPausedRouteFingerprintDigest] : null;
  if (latest && latest.branchName === branchName && latest.taskBindingId === binding.taskBindingId) return latest;
  const paused = Object.values(state.routes)
    .filter((record) =>
      record.pausedAt
      && record.branchName === branchName
      && record.taskBindingId === binding.taskBindingId
    )
    .sort((left, right) => (right.pausedAt ?? '').localeCompare(left.pausedAt ?? ''));
  return paused[0] ?? null;
}

function resumeRecordFromFlags(parsed: ParsedOperatorArgs): RouteSafetyResumeRecord {
  if (parsed.flags.oneMoreLoop) {
    return makeResumeRecord('one-more-loop', 'resume', { oneMoreLoop: true });
  }
  if (parsed.flags.moreLoops.trim() || parsed.flags.moreMinutes.trim()) {
    return makeResumeRecord('more-loops-and-minutes', 'resume', {
      moreLoops: parsePositiveInt(parsed.flags.moreLoops),
      moreMinutes: parsePositiveInt(parsed.flags.moreMinutes),
    });
  }
  if (parsed.flags.untilReviewPasses) {
    return makeResumeRecord('until-review-passes', 'resume', {
      maxMoreLoops: parsePositiveInt(parsed.flags.maxMoreLoops),
      maxMoreMinutes: parsePositiveInt(parsed.flags.maxMoreMinutes),
    });
  }
  return makeResumeRecord('accept-findings', 'resume', {
    acceptedFindings: true,
    reason: parsed.flags.reason.trim(),
  });
}

function makeResumeRecord(
  kind: RouteSafetyResumeRecord['kind'],
  source: RouteSafetyResumeRecord['source'],
  fields: Omit<RouteSafetyResumeRecord, 'id' | 'kind' | 'recordedAt' | 'source'> = {},
): RouteSafetyResumeRecord {
  return {
    id: `route-resume-${randomUUID().slice(0, 8)}`,
    kind,
    source,
    recordedAt: nowIso(),
    ...fields,
  };
}

async function questionPositiveInteger(rl: readline.Interface, prompt: string): Promise<number> {
  while (true) {
    const answer = (await rl.question(prompt)).trim();
    if (/^[1-9]\d*$/.test(answer) && Number.isSafeInteger(Number.parseInt(answer, 10))) {
      return Number.parseInt(answer, 10);
    }
    process.stderr.write('Enter a positive whole number.\n');
  }
}

function parsePositiveInt(value: string): number {
  return Number.parseInt(value.trim(), 10);
}

function elapsedMinutes(firstStartedAt: string): number {
  const started = Date.parse(firstStartedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 60000));
}

function formatReviewFindings(options: PauseOptions, artifactRoot?: string): string[] {
  const issues = options.issues && options.issues.length > 0
    ? options.issues
    : options.latest
      ? reviewIssuesFromRun(options.latest)
      : [];
  const lines: string[] = [];
  for (const issue of issues) {
    lines.push(`- ${issue.message}`);
    if (!issue.gate) continue;
    const output = visibleReviewGateFailureOutput(issue.gate, artifactRoot);
    if (!output) continue;
    lines.push(`  ${issue.gate.gateId} output:`);
    lines.push(...output.split('\n').map((line) => `    ${line}`));
  }
  return lines;
}

function reviewIssuesFromRun(reviewRun: ReviewRunRecord): ReviewEvidenceIssue[] {
  return reviewRun.gates
    .filter((gate) => gate.blocking && (gate.status === 'failed' || gate.status === 'pending'))
    .map((gate) => ({
      status: gate.status === 'failed' ? 'failed' as const : 'pending' as const,
      gateId: gate.gateId,
      message: `blocking gate ${gate.gateId} is ${gate.status}: ${gate.summary}`,
      blocking: true,
      gate,
    }));
}
