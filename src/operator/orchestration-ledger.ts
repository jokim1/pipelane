import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  buildGoalSpecDraft,
  renderGoalConfirmationPrompt,
  renderProviderGoalPrompt,
  type GoalSpec,
} from './goal-spec.ts';
import {
  DEFAULT_GOAL_PROVIDER,
  ensureInstallMarker,
  normalizePath,
  nowIso,
  readVersionedJsonFile,
  resolveStateDir,
  runGit,
  TASK_SLUG_MAX_LENGTH,
  writeVersionedJsonFile,
  type GoalProvider,
  type OrchestrateConfig,
  type ReviewGateConfig,
  type ReviewGatePreset,
  type ReviewActorIdentity,
  type ReviewRunRecord,
  type ReviewPlanGateConfig,
  type WorkflowConfig,
} from './state.ts';
import {
  blockingAiReviewEvidenceBlocker,
  type ReviewIndependenceLabel,
} from './review-identity.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';

export type OrchestrationRunStatus = 'planned' | 'prepared' | 'dispatched' | 'running' | 'blocked' | 'completed' | 'failed';
export type OrchestrationSliceStatus = 'planned' | 'prepared' | 'dispatched' | 'running' | 'blocked' | 'completed' | 'failed';
export type OrchestrationSliceWorkerStatus = 'running' | 'succeeded' | 'failed';

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

export interface OrchestrationSliceReviewRecord {
  status: ReviewRunRecord['status'];
  evidencePath: string;
  reviewedAt: string;
  reviewer?: ReviewActorIdentity;
  independence?: ReviewIndependenceLabel;
  independenceReason?: string;
  run: ReviewRunRecord;
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
  reviewDiagnostics?: OrchestrationSliceReviewRecord[];
  goalSpec: GoalSpec;
  provider: GoalProvider;
  providerPrompt: string;
  confirmationPrompt: string;
  requiresConfirmation: boolean;
  critique: string[];
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
    preset: ReviewGatePreset | null;
    planReview: {
      gates: ReviewPlanGateConfig[];
    };
    gates: ReviewGateConfig[];
  };
  slices: OrchestrationSliceRecord[];
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

export function buildOrchestrationRunRecord(input: BuildOrchestrationRunInput): OrchestrationRunRecord {
  const createdAt = nowIso();
  const rawPlanText = input.planText ?? '';
  const planText = rawPlanText.trim();
  const prompt = input.outcome?.trim() || null;
  const planSections = resolvePlanSections(planText, input.outcome);
  const sliceIdCounts = new Map<string, number>();
  const assignedSliceIds = new Set<string>();
  const slices = planSections.slices.map((slice, index) => {
    const draft = buildGoalSpecDraft({
      config: input.config,
      sliceId: planSections.slices.length === 1 ? input.sliceId : undefined,
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

    return {
      id: goalSpec.sliceId,
      index: index + 1,
      status: 'planned' as const,
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
      providerPrompt: renderProviderGoalPrompt(goalSpec, draft.provider),
      confirmationPrompt: renderGoalConfirmationPrompt(goalSpec),
      requiresConfirmation: draft.requiresConfirmation,
      critique: draft.critique,
    };
  });

  for (let index = 1; index < slices.length; index += 1) {
    slices[index].dependsOn = [slices[index - 1].id];
  }

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
      preset: input.config.reviewGates?.preset ?? null,
      planReview: {
        gates: cloneJson(input.config.reviewGates?.planReview?.gates ?? []),
      },
      gates: cloneJson(input.config.reviewGates?.gates ?? []),
    },
    slices,
  };
}

export function saveOrchestrationRunRecord(
  commonDir: string,
  config: WorkflowConfig,
  record: OrchestrationRunRecord,
): string {
  const targetPath = orchestrationRunPath(commonDir, config, record.id);
  ensureInstallMarker(commonDir, config);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeVersionedJsonFile('orchestrationRun', targetPath, record);
  return targetPath;
}

export function loadOrchestrationRunRecord(
  commonDir: string,
  config: WorkflowConfig,
  runId: string,
): OrchestrationRunRecord | null {
  assertSafeOrchestrationRunId(runId);
  const targetPath = orchestrationRunPath(commonDir, config, runId);
  if (!existsSync(targetPath)) return null;
  return readVersionedJsonFile<OrchestrationRunRecord | null>('orchestrationRun', commonDir, config, targetPath, null);
}

export function listOrchestrationRunRecords(commonDir: string, config: WorkflowConfig): OrchestrationRunRecord[] {
  const runsRoot = path.join(resolveStateDir(commonDir, config), 'orchestrate', 'runs');
  if (!existsSync(runsRoot)) return [];
  const records: OrchestrationRunRecord[] = [];
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeOrchestrationRunId(entry.name)) continue;
    const targetPath = path.join(runsRoot, entry.name, 'orchestration.json');
    if (!existsSync(targetPath)) continue;
    const record = readVersionedJsonFile<OrchestrationRunRecord | null>('orchestrationRun', commonDir, config, targetPath, null);
    if (record) records.push(record);
  }
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function isActiveOrchestrationRun(
  record: OrchestrationRunRecord,
  options: OrchestrationReviewSatisfactionOptions = {},
): boolean {
  if (record.status !== 'completed') return true;
  return record.slices.some((slice) =>
    slice.worker?.status === 'succeeded'
    && !sliceReviewFullySatisfied(slice, options)
    && sliceWorktreeExists(slice, options),
  );
}

export interface OrchestrationReviewSatisfactionOptions {
  headCache?: Map<string, string | null>;
  statusDigestCache?: Map<string, { digest: string; reliable: boolean } | null>;
  worktreeExistsCache?: Map<string, boolean>;
}

export function sliceReviewFullySatisfied(
  slice: OrchestrationSliceRecord,
  options: OrchestrationReviewSatisfactionOptions = {},
): boolean {
  const reviewRun = slice.review?.run;
  if (slice.worker?.status !== 'succeeded') return false;
  if (reviewRun?.status !== 'passed') return false;
  if (
    reviewRun.dryRun
    || reviewRun.gateFilter
    || reviewRun.phaseFilter
    || !reviewRun.sha
  ) {
    return false;
  }
  if (sliceHasRejectedBlockingAiDiagnostic(slice)) return false;
  if (sliceReviewHasUntrustedBlockingAiEvidence(slice)) return false;

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

function assertSafeOrchestrationRunId(runId: string): void {
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

function sliceWorktreeExists(slice: OrchestrationSliceRecord, options: OrchestrationReviewSatisfactionOptions = {}): boolean {
  if (!slice.worktreePath) return false;
  if (options.worktreeExistsCache?.has(slice.worktreePath)) return options.worktreeExistsCache.get(slice.worktreePath) ?? false;
  const exists = existsSync(slice.worktreePath);
  options.worktreeExistsCache?.set(slice.worktreePath, exists);
  return exists;
}

function resolvePlanSections(planText: string, outcome: string | undefined): { globalText: string; slices: PlanSliceSource[] } {
  const sections = extractExplicitSliceSections(planText);
  if (sections.slices.length > 0) return sections;

  const title = outcome?.trim() || inferPlanTitle(planText) || 'Orchestration slice';
  return {
    globalText: '',
    slices: [{
      title,
      text: planText || `# ${title}`,
    }],
  };
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
  const actionableBullets = extractActionableBullets(combinedText);
  const finishLineItems = normalizeList([
    ...actionableBullets,
    ...extractProseContextLines(globalText),
    ...extractProseContextLines(sliceText),
    ...(actionableBullets.length === 0 ? extractProseContextLines(combinedText) : []),
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
