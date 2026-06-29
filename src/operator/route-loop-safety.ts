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
  formatWorkflowCommand,
  loadRouteSafetyState,
  normalizeRouteSafetyConfig,
  nowIso,
  resolveWorkflowContext,
  runGit,
  saveRouteSafetyState,
  type ParsedOperatorArgs,
  type ReviewRunRecord,
  type RouteSafetyRecord,
  type RouteSafetyResumeRecord,
  type RouteSafetyState,
  type WorkflowContext,
} from './state.ts';
import type { ReviewEvidenceCheckResult, ReviewEvidenceIssue } from './review-enforcement.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';

export const ROUTE_SAFETY_FINGERPRINT_ENV = 'PIPELANE_ROUTE_SAFETY_FINGERPRINT';

export interface RouteSafetyPauseResult {
  action: 'continue' | 'stop';
  message: string;
}

interface RouteSafetyRouteIdentity {
  digest: string;
  fingerprint: string;
  targetCommand: string;
  taskSlug: string;
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
    || flags.acceptFindings;
}

export function routeSafetyDigestForPlan(plan: DestinationPlan): string {
  return destinationPlanFingerprintDigest(plan);
}

export async function evaluateDestinationRouteReviewSafety(
  context: WorkflowContext,
  plan: DestinationPlan,
  evidence: ReviewEvidenceCheckResult,
): Promise<RouteSafetyPauseResult> {
  const identity = routeIdentityForPlan(plan);
  const state = loadRouteSafetyState(context.commonDir, context.config);
  const record = updateRouteRecordWithReviewEvidence(state, identity, evidence.latest);
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
  const identity = plan ? routeIdentityForPlan(plan) : routeIdentityForCurrentReview(context);
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
}

export function recordReviewRunForRouteSafety(
  cwd: string,
  parsed: ParsedOperatorArgs,
  reviewRun: ReviewRunRecord,
): RouteSafetyPauseResult {
  const context = resolveWorkflowContext(cwd);
  const plan = buildReviewRoutePlan(cwd, parsed);
  const identity = plan ? routeIdentityForPlan(plan) : routeIdentityForCurrentReview(context);
  const state = loadRouteSafetyState(context.commonDir, context.config);
  const record = ensureRouteRecord(state, identity);
  countReviewRun(record, reviewRun);
  if (reviewRun.status === 'passed') {
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
  if (envDigest && routeRecordAcceptsFindings(state.routes[envDigest], evidence.latest?.id ?? '')) return true;

  const plan = buildDestinationPlanForCommand(cwd, parsed);
  if (plan && routeRecordAcceptsFindings(state.routes[routeSafetyDigestForPlan(plan)], evidence.latest?.id ?? '')) return true;

  const reviewPlan = buildReviewRoutePlan(cwd, parsed);
  if (reviewPlan && routeRecordAcceptsFindings(state.routes[routeSafetyDigestForPlan(reviewPlan)], evidence.latest?.id ?? '')) return true;

  return false;
}

export function applyRouteSafetyResumeOverride(cwd: string, parsed: ParsedOperatorArgs): { message: string; record: RouteSafetyRecord } {
  const context = resolveWorkflowContext(cwd);
  const state = loadRouteSafetyState(context.commonDir, context.config);
  const record = findPausedRouteRecordForCurrentCheckout(context, state);
  if (!record) {
    throw new Error('No paused route-bound fix/review loop was found for this checkout. Re-run the route command to recreate the pause, then use the printed resume command.');
  }
  const resume = resumeRecordFromFlags(parsed);
  record.resumes = [resume, ...(record.resumes ?? [])].slice(0, 20);
  record.updatedAt = nowIso();
  if (resume.acceptedFindings) {
    record.acceptedFindingsAt = resume.recordedAt;
    record.acceptedFindingsSource = 'resume --accept-findings';
    record.acceptedReviewRunId = record.lastReviewRunId;
  }
  state.latestPausedRouteFingerprintDigest = record.routeFingerprintDigest;
  saveRouteSafetyState(context.commonDir, context.config, state);
  return {
    record,
    message: renderRouteSafetyResumeMessage(context, record, resume),
  };
}

async function pauseRouteSafety(
  context: WorkflowContext,
  state: RouteSafetyState,
  record: RouteSafetyRecord,
  options: PauseOptions,
): Promise<RouteSafetyPauseResult> {
  markPaused(state, record, options.reason);
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
      const confirmation = (await rl.question('Type "continue without fixing" to confirm: ')).trim();
      if (confirmation !== 'continue without fixing') {
        saveRouteSafetyState(context.commonDir, context.config, state);
        return {
          action: 'stop',
          message: 'Confirmation did not match. Stop here and show review findings.',
        };
      }
      const resume = makeResumeRecord('accept-findings', 'tty', {
        acceptedFindings: true,
        confirmation,
      });
      record.resumes = [resume, ...(record.resumes ?? [])].slice(0, 20);
      record.acceptedFindingsAt = resume.recordedAt;
      record.acceptedFindingsSource = 'TTY option 4: continue without fixing these findings';
      record.acceptedReviewRunId = record.lastReviewRunId;
      saveRouteSafetyState(context.commonDir, context.config, state);
      return {
        action: 'continue',
        message: 'Recorded: continue without fixing these findings for this route.',
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
    '2. Allow one more fix/review loop',
    '3. Choose how many more loops and minutes to allow',
    '4. Continue without fixing these findings',
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
  const findings = formatReviewFindings(options);
  if (findings.length > 0) {
    lines.push('', 'Review findings:', ...findings);
  }
  lines.push(
    '',
    'Resume commands:',
    'pipelane resume --one-more-loop',
    'pipelane resume --more-loops=2 --more-minutes=45',
    'pipelane resume --until-review-passes --max-more-loops=3 --max-more-minutes=120',
    'pipelane resume --accept-findings',
  );
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
  let extraLoops = 0;
  let extraMinutes = 0;
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
    return existing;
  }
  const record: RouteSafetyRecord = {
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
  state.routes[identity.digest] = record;
  return record;
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

function routeIdentityForPlan(plan: DestinationPlan): RouteSafetyRouteIdentity {
  const fp = plan.fingerprintInputs as { headSha?: unknown };
  return {
    digest: routeSafetyDigestForPlan(plan),
    fingerprint: canonicalizeDestinationFingerprint(plan.fingerprintInputs),
    targetCommand: plan.targetCommand,
    taskSlug: plan.taskSlug,
    branchName: typeof (plan.fingerprintInputs as { branchName?: unknown }).branchName === 'string'
      ? String((plan.fingerprintInputs as { branchName?: unknown }).branchName)
      : '',
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
  const digest = createHash('sha256').update(fingerprint).digest('hex');
  return {
    digest,
    fingerprint,
    targetCommand: formatWorkflowCommand(context.config, 'pr'),
    taskSlug: '',
    branchName,
    headSha: status.head,
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

function routeRecordAcceptsFindings(record: RouteSafetyRecord | undefined, latestReviewRunId: string): boolean {
  return Boolean(record?.acceptedFindingsAt && latestReviewRunId && record.acceptedReviewRunId === latestReviewRunId);
}

function findPausedRouteRecordForCurrentCheckout(context: WorkflowContext, state: RouteSafetyState): RouteSafetyRecord | null {
  const branchName = runGit(context.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const headSha = runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '';
  const latest = state.latestPausedRouteFingerprintDigest ? state.routes[state.latestPausedRouteFingerprintDigest] : null;
  if (latest && latest.branchName === branchName && latest.headSha === headSha) return latest;
  const paused = Object.values(state.routes)
    .filter((record) => record.pausedAt && record.branchName === branchName && record.headSha === headSha)
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

function formatReviewFindings(options: PauseOptions): string[] {
  if (options.issues && options.issues.length > 0) {
    return options.issues.map((issue) => `- ${issue.message}`);
  }
  if (!options.latest) return [];
  return reviewIssuesFromRun(options.latest).map((issue) => `- ${issue.message}`);
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
