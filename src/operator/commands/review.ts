import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  detectPackageScripts,
  resolveReviewGateCatalog,
  buildReviewGatesConfigForPreset,
} from '../review-gates.ts';
import { readWorktreeStatusSnapshot } from '../worktree-status.ts';
import {
  appendReviewRunRecord,
  defaultReviewGatesConfig,
  nowIso,
  patchReadableWorkflowConfig,
  printResult,
  REVIEW_GATE_PHASES,
  resolveReadableConfigPath,
  reviewStatePath,
  resolveWorkflowContext,
  runGit,
  type ParsedOperatorArgs,
  type ReviewGateConfig,
  type ReviewGatePhase,
  type ReviewGateRunRecord,
  type ReviewGatePreset,
  type ReviewGatesConfig,
  type ReviewRunRecord,
  type ReviewPlanGateConfig,
} from '../state.ts';

type ReviewSetupStatus = 'configured' | 'reported';
type ReviewCommandStatus = ReviewRunRecord['status'];

const REVIEW_CONFIG_CHANGE_GATE_ID = 'review-config-change';
const REVIEW_CONFIG_CHANGE_PATHS = ['.pipelane.json', '.project-workflow.json', 'package.json'];
const REVIEW_PHASE_ORDER = REVIEW_GATE_PHASES;
const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;

interface ReviewSetupReport {
  command: 'review setup';
  status: ReviewSetupStatus;
  repoRoot: string;
  configPath: string | null;
  configPathIsLegacy: boolean;
  preset: ReviewGatePreset;
  packageJson: {
    path: string;
    found: boolean;
    malformed: boolean;
    parseError?: string;
  };
  detectedScripts: string[];
  effective: {
    planReview: {
      gates: ReviewPlanGateConfig[];
    };
    gates: ReviewGateConfig[];
  };
  missing: Array<{
    id: string;
    reason: string;
  }>;
  catalog?: Array<{
    id: string;
    kind: string;
    phase: string;
    type: string;
    presets: ReviewGatePreset[];
    available: boolean;
    command?: string;
    skill?: string;
    role?: string;
    userCommands?: string[];
    scriptNames?: string[];
    matchedScript?: string;
    optional?: boolean;
    missingReason?: string;
  }>;
  message: string;
}

export interface BuildReviewRunRecordOptions {
  repoRoot: string;
  baseBranch: string;
  preset: ReviewGatePreset;
  gates: ReviewGateConfig[];
  dryRun: boolean;
  gateFilter?: string;
  phaseFilter?: ReviewGatePhase | '';
  activeSurfaces: string[];
}

export async function handleReview(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const subcommand = parsed.positional[0] ?? '';
  if (subcommand === 'setup') {
    handleReviewSetup(cwd, parsed);
    return;
  }

  handleReviewRun(cwd, parsed);
}

function handleReviewSetup(cwd: string, parsed: ParsedOperatorArgs): void {
  let context = resolveWorkflowContext(cwd);
  const presetFlag = parsed.flags.reviewPreset.trim();
  let writeResult: { configPath: string; isLegacy: boolean } | null = null;

  if (presetFlag) {
    const preset = presetFlag as ReviewGatePreset;
    writeResult = patchReadableWorkflowConfig(context.repoRoot, (raw) => ({
      ...raw,
      reviewGates: buildReviewGatesPresetPatch(raw, preset, context.repoRoot),
    }));
    context = resolveWorkflowContext(cwd);
  }

  const preset = context.config.reviewGates?.preset ?? 'standard';
  const detection = detectPackageScripts(context.repoRoot);
  const resolvedCatalog = resolveReviewGateCatalog({ repoRoot: context.repoRoot })
    .filter((entry) => entry.presets.includes(preset));
  const effectivePlanGates = context.config.reviewGates?.planReview?.gates ?? [];
  const effectiveGates = context.config.reviewGates?.gates ?? [];
  const configPath = writeResult?.configPath ?? resolveReadableConfigPath(context.repoRoot);
  const report: ReviewSetupReport = {
    command: 'review setup',
    status: writeResult ? 'configured' : 'reported',
    repoRoot: context.repoRoot,
    configPath,
    configPathIsLegacy: writeResult?.isLegacy ?? (configPath ? path.basename(configPath) !== '.pipelane.json' : false),
    preset,
    packageJson: {
      path: detection.packageJsonPath,
      found: detection.found,
      malformed: detection.malformed,
      parseError: detection.parseError,
    },
    detectedScripts: Object.keys(detection.scripts).sort(),
    effective: {
      planReview: { gates: effectivePlanGates },
      gates: effectiveGates,
    },
    missing: resolvedCatalog
      .filter((entry) => !entry.available)
      .map((entry) => ({
        id: entry.id,
        reason: entry.missingReason ?? 'gate unavailable',
      })),
    catalog: parsed.flags.reviewListGates
      ? resolveReviewGateCatalog({ repoRoot: context.repoRoot }).map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          phase: entry.phase,
          type: entry.type,
          presets: entry.presets,
          available: entry.available,
          command: entry.command,
          skill: entry.skill,
          role: entry.role,
          userCommands: entry.userCommands,
          scriptNames: entry.scriptNames,
          matchedScript: entry.matchedScript,
          optional: entry.optional,
          missingReason: entry.missingReason,
        }))
      : undefined,
    message: '',
  };
  report.message = renderReviewSetupReport(report, {
    includeEffectiveJson: parsed.flags.reviewPrint,
    includeCatalog: parsed.flags.reviewListGates,
  });

  printResult(parsed.flags, report);
}

function handleReviewRun(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const preset = context.config.reviewGates?.preset ?? 'standard';
  const phaseFilter = parsed.flags.reviewPhase.trim() as ReviewGatePhase | '';
  const gateFilter = parsed.flags.reviewGate.trim();
  const dryRun = parsed.flags.reviewDryRun;
  const activeSurfaces = context.modeState.requestedSurfaces ?? context.config.surfaces;

  const record = buildReviewRunRecord({
    repoRoot: context.repoRoot,
    baseBranch: context.config.baseBranch,
    preset,
    gates: context.config.reviewGates?.gates ?? [],
    dryRun,
    gateFilter,
    phaseFilter,
    activeSurfaces,
  });

  appendReviewRunRecord(context.commonDir, context.config, record);

  const report = {
    command: 'review',
    status: record.status,
    runId: record.id,
    repoRoot: context.repoRoot,
    evidencePath: reviewStatePath(context.commonDir, context.config),
    preset,
    dryRun,
    gateFilter: gateFilter || null,
    phaseFilter: phaseFilter || null,
    changedFiles: record.changedFiles,
    gates: record.gates,
    message: renderReviewRunReport(record, reviewStatePath(context.commonDir, context.config)),
  };

  printResult(parsed.flags, report);

  if (record.status === 'failed') {
    process.exitCode = 1;
  }
}

export function buildReviewRunRecord(options: BuildReviewRunRecordOptions): ReviewRunRecord {
  const phaseFilter = options.phaseFilter ?? '';
  const gateFilter = options.gateFilter?.trim() ?? '';
  const changedFiles = collectChangedFiles(options.repoRoot, options.baseBranch);
  const worktreeStatus = readWorktreeStatusSnapshot(options.repoRoot, { includeStatusDigest: true });
  const reviewConfigChanged = changedFiles.some(isReviewConfigPath);
  const allGates = orderReviewGates(options.gates);
  const selectedGates = maybeAddReviewConfigChangeGate(allGates.filter((gate) =>
    (!phaseFilter || gate.phase === phaseFilter)
    && (!gateFilter || gate.id === gateFilter)
  ), {
    reviewConfigChanged,
  });

  if (gateFilter && selectedGates.length === 0) {
    throw new Error(`No review gate matches --gate ${gateFilter}. Run "pipelane run review setup --list-gates" to inspect configured gates.`);
  }

  const startedAt = nowIso();
  const runStartMs = Date.now();
  const gateRecords = selectedGates.map((gate) =>
    runReviewGate({
      gate,
      repoRoot: options.repoRoot,
      dryRun: options.dryRun,
      reviewConfigChanged,
      changedFiles,
      activeSurfaces: options.activeSurfaces,
    })
  );
  const finishedAt = nowIso();
  const status = summarizeRunStatus(gateRecords);

  return {
    id: `review-${new Date(startedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
    branchName: runGit(options.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '',
    sha: runGit(options.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '',
    preset: options.preset,
    status,
    dryRun: options.dryRun,
    gateFilter: gateFilter || undefined,
    phaseFilter: phaseFilter || undefined,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.now() - runStartMs),
    changedFiles,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeStatusReliable: worktreeStatus.statusDigestReliable,
    worktreeStatusWarnings: worktreeStatus.statusDigestWarnings,
    gates: gateRecords,
  };
}

function orderReviewGates(gates: ReviewGateConfig[]): ReviewGateConfig[] {
  return [...gates].sort((left, right) => {
    const phaseDelta = REVIEW_PHASE_ORDER.indexOf(left.phase) - REVIEW_PHASE_ORDER.indexOf(right.phase);
    return phaseDelta !== 0 ? phaseDelta : left.id.localeCompare(right.id);
  });
}

function runReviewGate(options: {
  gate: ReviewGateConfig;
  repoRoot: string;
  dryRun: boolean;
  reviewConfigChanged: boolean;
  changedFiles: string[];
  activeSurfaces: string[];
}): ReviewGateRunRecord {
  const { gate, repoRoot, dryRun, reviewConfigChanged, changedFiles, activeSurfaces } = options;
  const startedAt = nowIso();
  const startMs = Date.now();
  const base: Omit<ReviewGateRunRecord, 'status' | 'summary' | 'finishedAt' | 'durationMs'> = {
    id: `${gate.id}-${crypto.randomUUID().slice(0, 8)}`,
    gateId: gate.id,
    phase: gate.phase,
    type: gate.type,
    blocking: gate.blocking !== false,
    command: gate.command,
    skill: gate.skill,
    role: gate.role,
    startedAt,
  };
  const skipReason = skipReasonForGate(gate, changedFiles, activeSurfaces);
  if (skipReason) {
    return finishGate(base, startMs, {
      status: 'skipped',
      summary: skipReason,
      skipReason,
    });
  }

  if (gate.type !== 'command' && gate.type !== 'pipelane') {
    return finishGate(base, startMs, {
      status: 'pending',
      summary: manualGateSummary(gate),
    });
  }

  if (reviewConfigChanged) {
    return finishGate(base, startMs, {
      status: 'skipped',
      summary: `skipped: review config inputs changed; ${gate.type} gates require trusted approval before execution`,
      skipReason: 'review-config-changed',
    });
  }

  if (!gate.command) {
    return finishGate(base, startMs, {
      status: 'failed',
      summary: 'gate is executable but has no command configured',
      exitCode: null,
    });
  }

  if (dryRun) {
    return finishGate(base, startMs, {
      status: 'skipped',
      summary: `dry-run: would run ${gate.command}`,
      skipReason: 'dry-run',
    });
  }

  const timeoutMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const result = spawnSync(gate.command, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const ok = exitCode === 0 && !timedOut && !result.error;
  const errorSummary = result.error && !timedOut
    ? `command failed to start: ${result.error.message}`
    : timedOut
      ? `command timed out after ${timeoutMs}ms`
      : `command exited ${exitCode}`;

  return finishGate(base, startMs, {
    status: ok ? 'passed' : 'failed',
    summary: ok ? `command passed: ${gate.command}` : errorSummary,
    exitCode,
    stdoutTail: tail(redactReviewOutput(stdout)),
    stderrTail: tail(redactReviewOutput(stderr)),
  });
}

function finishGate(
  base: Omit<ReviewGateRunRecord, 'status' | 'summary' | 'finishedAt' | 'durationMs'>,
  startMs: number,
  result: Pick<ReviewGateRunRecord, 'status' | 'summary'> & Partial<ReviewGateRunRecord>,
): ReviewGateRunRecord {
  return {
    ...base,
    ...result,
    finishedAt: nowIso(),
    durationMs: Math.max(0, Date.now() - startMs),
  };
}

function summarizeRunStatus(gates: ReviewGateRunRecord[]): ReviewCommandStatus {
  if (gates.some((gate) => gate.blocking && gate.status === 'failed')) return 'failed';
  if (gates.some((gate) => gate.blocking && gate.status === 'pending')) return 'pending';
  return 'passed';
}

function skipReasonForGate(gate: ReviewGateConfig, changedFiles: string[], activeSurfaces: string[]): string | null {
  if (gate.whenChanged && gate.whenChanged.length > 0) {
    const matched = changedFiles.some((file) => gate.whenChanged?.some((pattern) => matchesPathPattern(file, pattern)));
    if (!matched) {
      return `skipped: no changed files matched ${gate.whenChanged.join(', ')}`;
    }
  }
  if (gate.when?.startsWith('surface:')) {
    const surface = gate.when.slice('surface:'.length).trim();
    if (surface && !activeSurfaces.includes(surface)) {
      return `skipped: surface ${surface} is not active`;
    }
  }
  return null;
}

function manualGateSummary(gate: ReviewGateConfig): string {
  if (gate.type === 'skill') {
    const command = gate.userCommands?.[0] ?? (gate.skill ? `skill:${gate.skill}` : 'the configured skill');
    return `manual skill gate pending: run ${command}`;
  }
  if (gate.type === 'agent') {
    return `agent gate pending: ${gate.role ?? gate.id}`;
  }
  if (gate.type === 'approval') {
    return `approval gate pending${gate.when ? ` (${gate.when})` : ''}`;
  }
  return `manual gate pending: ${gate.id}`;
}

function collectChangedFiles(repoRoot: string, baseBranch: string): string[] {
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

function maybeAddReviewConfigChangeGate(
  gates: ReviewGateConfig[],
  options: {
    reviewConfigChanged: boolean;
  },
): ReviewGateConfig[] {
  if (!options.reviewConfigChanged || gates.some((gate) => gate.id === REVIEW_CONFIG_CHANGE_GATE_ID)) return gates;
  return [
    {
      id: REVIEW_CONFIG_CHANGE_GATE_ID,
      phase: 'static',
      type: 'approval',
      blocking: true,
      when: 'review-config-changed',
    },
    ...gates,
  ];
}

function isReviewConfigPath(file: string): boolean {
  const normalized = normalizeRepoPath(file);
  return REVIEW_CONFIG_CHANGE_PATHS.includes(normalized);
}

function matchesPathPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizeRepoPath(file);
  const normalizedPattern = normalizeRepoPath(pattern);
  if (!normalizedPattern) return false;
  if (!normalizedPattern.includes('*')) return normalizedFile === normalizedPattern;
  return globPatternToRegExp(normalizedPattern).test(normalizedFile);
}

function normalizeRepoPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  source += '$';
  return new RegExp(source);
}

function tail(value: string): string | undefined {
  if (!value) return undefined;
  return value.length > OUTPUT_TAIL_CHARS ? value.slice(-OUTPUT_TAIL_CHARS) : value;
}

function redactReviewOutput(value: string): string {
  return value
    .replace(/([?&](?:token|key|secret|password|pass|auth|session|cookie)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH_HEADER]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2=[REDACTED]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)\s+("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2 [REDACTED]')
    .replace(/\b((?:token|key|secret|password|pass|session|cookie|api[_-]?key|access[_-]?key)\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|SESSION|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s]+)/g, (match) => {
      const key = match.split('=')[0];
      return `${key}=[REDACTED]`;
    });
}

function renderReviewRunReport(record: ReviewRunRecord, evidencePath: string): string {
  const lines = [
    'Pipelane review',
    `Status: ${record.status}`,
    `Preset: ${record.preset}`,
    `Evidence: ${evidencePath}`,
    `Run: ${record.id}`,
  ];

  if (record.dryRun) lines.push('Mode: dry-run');
  if (record.gateFilter) lines.push(`Gate filter: ${record.gateFilter}`);
  if (record.phaseFilter) lines.push(`Phase filter: ${record.phaseFilter}`);

  lines.push('', 'Gate results:');
  if (record.gates.length === 0) {
    lines.push('- none');
  } else {
    for (const gate of record.gates) {
      const marker = gate.status.toUpperCase();
      const blocking = gate.blocking ? 'blocking' : 'non-blocking';
      lines.push(`- ${gate.gateId} [${gate.phase}] ${marker} (${blocking}) - ${gate.summary}`);
    }
  }

  const pending = record.gates.filter((gate) => gate.status === 'pending');
  if (pending.length > 0) {
    lines.push('', 'Pending gates:');
    for (const gate of pending) {
      lines.push(`- ${gate.gateId}: ${gate.summary}`);
    }
  }

  if (record.status === 'failed') {
    lines.push('', 'Next: fix failed blocking gates, then rerun /pipelane review.');
  } else if (record.status === 'pending') {
    lines.push('', 'Next: complete pending AI/manual gates, then rerun or attach their evidence before PR enforcement.');
  } else {
    lines.push('', 'Next: continue to /pr when ready.');
  }

  return lines.join('\n');
}

function renderReviewSetupReport(
  report: ReviewSetupReport,
  options: {
    includeEffectiveJson: boolean;
    includeCatalog: boolean;
  },
): string {
  const lines = [
    'Pipelane review setup',
    `Status: ${report.status}`,
    `Preset: ${report.preset}`,
    `Config: ${report.configPath ?? 'inferred from defaults/package.json overlay'}`,
  ];

  if (!report.packageJson.found) {
    lines.push(`Package scripts: no package.json found at ${report.packageJson.path}`);
  } else if (report.packageJson.malformed) {
    lines.push(`Package scripts: package.json is malformed - ${report.packageJson.parseError ?? 'unknown parse error'}`);
  } else {
    lines.push(`Package scripts: ${report.detectedScripts.length > 0 ? report.detectedScripts.join(', ') : 'none detected'}`);
  }

  lines.push('', 'Plan review gates:');
  lines.push(...formatPlanGates(report.effective.planReview.gates));

  lines.push('', 'Review gates:');
  lines.push(...formatReviewGates(report.effective.gates));

  if (report.missing.length > 0) {
    lines.push('', 'Setup gaps:');
    lines.push(...report.missing.map((entry) => `- ${entry.id}: ${entry.reason}`));
  }

  if (options.includeCatalog) {
    lines.push('', 'Gate catalog:');
    lines.push(...formatCatalog(report.catalog ?? []));
  }

  if (options.includeEffectiveJson) {
    lines.push(
      '',
      'Effective reviewGates:',
      JSON.stringify({
        preset: report.preset,
        planReview: report.effective.planReview,
        gates: report.effective.gates,
      }, null, 2),
    );
  }

  lines.push('', 'Next: run /pipelane review to write gate evidence before PR handoff.');
  return lines.join('\n');
}

function buildReviewGatesPresetPatch(
  raw: Record<string, unknown>,
  preset: ReviewGatePreset,
  repoRoot: string,
): Record<string, unknown> {
  const existing = asRecord(raw.reviewGates);
  if (!existing) {
    return { preset };
  }

  const next: Record<string, unknown> = { ...existing, preset };
  const existingPreset = isReviewGatePreset(existing.preset) ? existing.preset : 'standard';
  const generatedDefaultCandidates = getGeneratedDefaultCandidates(existingPreset, repoRoot);

  const planReview = asRecord(existing.planReview);
  if (
    planReview
    && Array.isArray(planReview.gates)
    && generatedDefaultCandidates.some((candidate) => sameJson(planReview.gates, candidate.planReview?.gates ?? []))
  ) {
    const nextPlanReview = { ...planReview };
    delete nextPlanReview.gates;
    if (Object.keys(nextPlanReview).length > 0) {
      next.planReview = nextPlanReview;
    } else {
      delete next.planReview;
    }
  }

  if (
    Array.isArray(existing.gates)
    && generatedDefaultCandidates.some((candidate) => sameJson(existing.gates, candidate.gates ?? []))
  ) {
    delete next.gates;
  }

  return next;
}

function getGeneratedDefaultCandidates(
  preset: ReviewGatePreset,
  repoRoot: string,
): ReviewGatesConfig[] {
  if (preset === 'standard') {
    return [
      defaultReviewGatesConfig({ repoRoot }),
      defaultReviewGatesConfig(),
    ];
  }
  return [
    buildReviewGatesConfigForPreset(preset, { repoRoot }),
    buildReviewGatesConfigForPreset(preset),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isReviewGatePreset(value: unknown): value is ReviewGatePreset {
  return value === 'lean' || value === 'standard' || value === 'strict-production';
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatPlanGates(gates: ReviewPlanGateConfig[]): string[] {
  if (gates.length === 0) return ['- none'];
  return gates.map((gate) => {
    const target = gate.skill ? `skill:${gate.skill}` : gate.role ? `role:${gate.role}` : gate.type;
    const when = gate.when ? ` when ${gate.when}` : '';
    return `- ${gate.id} (${target}, ${gate.blocking === false ? 'non-blocking' : 'blocking'})${when}`;
  });
}

function formatReviewGates(gates: ReviewGateConfig[]): string[] {
  if (gates.length === 0) return ['- none'];
  return gates.map((gate) => {
    const target = gate.command
      ? gate.command
      : gate.skill
        ? `skill:${gate.skill}`
        : gate.role
          ? `role:${gate.role}`
          : gate.type;
    const conditions = [
      gate.when ? `when ${gate.when}` : '',
      gate.whenChanged && gate.whenChanged.length > 0 ? `when changed: ${gate.whenChanged.join(', ')}` : '',
    ].filter(Boolean);
    const suffix = conditions.length > 0 ? ` (${conditions.join('; ')})` : '';
    return `- ${gate.id} [${gate.phase}] ${target} - ${gate.blocking === false ? 'non-blocking' : 'blocking'}${suffix}`;
  });
}

function formatCatalog(catalog: NonNullable<ReviewSetupReport['catalog']>): string[] {
  if (catalog.length === 0) return ['- none'];
  return catalog.map((entry) => {
    const target = entry.command
      ?? (entry.skill ? `skill:${entry.skill}` : undefined)
      ?? (entry.role ? `role:${entry.role}` : undefined)
      ?? (entry.scriptNames && entry.scriptNames.length > 0 ? `scripts:${entry.scriptNames.join('|')}` : undefined)
      ?? entry.type;
    const status = entry.available
      ? 'available'
      : `missing: ${entry.missingReason ?? 'gate unavailable'}`;
    const aliases = entry.userCommands && entry.userCommands.length > 0
      ? ` aliases:${entry.userCommands.join(', ')}`
      : '';
    const optional = entry.optional ? ' optional' : '';
    const matched = entry.matchedScript ? ` script:${entry.matchedScript}` : '';
    return `- ${entry.id} [${entry.kind}/${entry.phase}] ${target} - ${status} presets:${entry.presets.join('|')}${optional}${matched}${aliases}`;
  });
}
