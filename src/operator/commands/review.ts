import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
  detectPackageScripts,
  resolveReviewGateCatalog,
  buildReviewGatesConfigForPreset,
  type ResolvedReviewGateCatalogEntry,
} from '../review-gates.ts';
import { readWorktreeStatusSnapshot } from '../worktree-status.ts';
import {
  appendReviewRunRecord,
  defaultReviewGatesConfig,
  loadReviewState,
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
  type WorkflowConfig,
  type ReviewPlanGateConfig,
} from '../state.ts';

type ReviewSetupStatus = 'configured' | 'reported' | 'cancelled';
type ReviewCommandStatus = ReviewRunRecord['status'];
type ReviewAttestStatus = 'attested';

const REVIEW_CONFIG_CHANGE_GATE_ID = 'review-config-change';
const REVIEW_CONFIG_CHANGE_PATHS = ['.pipelane.json', '.project-workflow.json', 'package.json'];
const REVIEW_PHASE_ORDER = REVIEW_GATE_PHASES;
const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_AI_GATE_TIMEOUT_MS = 30 * 60 * 1000;
const NATIVE_COMMAND_PROBE_TIMEOUT_MS = 5000;
const MAX_REVIEW_RESTARTS_AFTER_MUTATION = 2;
const OUTPUT_TAIL_CHARS = 4000;
const REVIEW_SETUP_RECOMMENDED_PRESET: ReviewGatePreset = 'strict-production';

type GateInstallState = 'installed' | 'not installed' | 'unavailable' | 'not applicable';

interface ReviewSetupGateOption {
  number: number;
  entry: ResolvedReviewGateCatalogEntry;
  label: string;
  selected: boolean;
  recommended: boolean;
  installState: GateInstallState;
}

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

interface ReviewAttestReport {
  command: 'review pass';
  status: ReviewAttestStatus;
  runId: string;
  repoRoot: string;
  evidencePath: string;
  gateId: string;
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

interface BuildReviewAttempt {
  selectedGates: ReviewGateConfig[];
  changedFiles: string[];
  reviewConfigChanged: boolean;
}

interface ReviewGateMutation {
  gate: ReviewGateRunRecord;
  beforeHead: string;
  afterHead: string;
  beforeDigest: string;
  afterDigest: string;
}

interface AiReviewStatusMarker {
  status: Extract<ReviewGateRunRecord['status'], 'passed' | 'failed' | 'pending'> | null;
  summary: string;
}

export async function handleReview(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const subcommand = parsed.positional[0] ?? '';
  if (subcommand === 'setup') {
    await handleReviewSetup(cwd, parsed);
    return;
  }
  if (subcommand === 'pass' || subcommand === 'attest') {
    handleReviewPass(cwd, parsed);
    return;
  }

  handleReviewRun(cwd, parsed);
}

async function handleReviewSetup(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
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

  if (!presetFlag && parsed.flags.yes) {
    const prepared = prepareInteractiveReviewSetup(context.repoRoot);
    writeResult = saveInteractiveReviewSetup(context.repoRoot, prepared.gates);
    context = resolveWorkflowContext(cwd);
  }

  if (
    !presetFlag
    && !parsed.flags.yes
    && !parsed.flags.reviewPrint
    && !parsed.flags.reviewListGates
    && !parsed.flags.json
  ) {
    if (!canRunInteractiveReviewSetup()) {
      throw new Error('review setup requires a TTY for interactive setup. Use --yes to save recommended gates, --preset for automation, --print, --list-gates, or --json for non-interactive output.');
    }
    await runInteractiveReviewSetup(cwd, parsed);
    return;
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

function handleReviewPass(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const gateId = parsed.flags.reviewGate.trim();
  const message = parsed.flags.message.trim();
  const record = buildReviewPassRecord({
    repoRoot: context.repoRoot,
    commonDir: context.commonDir,
    config: context.config,
    gateId,
    message,
  });
  const persisted = appendReviewRunRecord(context.commonDir, context.config, record);
  const report: ReviewAttestReport = {
    command: 'review pass',
    status: 'attested',
    runId: persisted.id,
    repoRoot: context.repoRoot,
    evidencePath: reviewStatePath(context.commonDir, context.config),
    gateId,
    message: renderReviewPassReport(persisted, gateId, reviewStatePath(context.commonDir, context.config)),
  };

  printResult(parsed.flags, report);
}

export function buildReviewPassRecord(options: {
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  gateId: string;
  message: string;
}): ReviewRunRecord {
  const gateId = options.gateId.trim();
  const message = options.message.trim();
  if (!gateId) {
    throw new Error('review pass requires --gate <id>.');
  }
  if (!message) {
    throw new Error('review pass requires --message <what was run and why it is clean>.');
  }

  const expectedGate = options.config.reviewGates?.gates?.find((gate) => gate.id === gateId);
  if (!expectedGate) {
    throw new Error(`No configured review gate matches --gate ${gateId}. Run "pipelane run review setup --list-gates" to inspect configured gates.`);
  }
  if (!isPassAttestableGate(expectedGate)) {
    throw new Error(`review pass only accepts approval, skill, or agent fallback gates. Gate ${gateId} is type ${expectedGate.type}; rerun /pipelane review to execute it.`);
  }

  const currentBranch = runGit(options.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const currentSha = runGit(options.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '';
  const worktreeStatus = readWorktreeStatusSnapshot(options.repoRoot, { includeStatusDigest: true });
  if (!worktreeStatus.statusDigestReliable) {
    throw new Error(`review pass cannot attest an unreliable worktree digest: ${worktreeStatus.statusDigestWarnings.join('; ') || 'status digest is incomplete'}`);
  }

  const state = loadReviewState(options.commonDir, options.config);
  const base = state.records.find((record) =>
    !record.dryRun
    && !record.gateFilter
    && !record.phaseFilter
    && record.branchName === currentBranch
    && record.sha === currentSha
    && record.worktreeStatusDigest === worktreeStatus.statusDigest
  );
  if (!base) {
    throw new Error('review pass requires a full, non-dry-run /pipelane review for the current branch, HEAD, and worktree state.');
  }

  const gate = base.gates.find((entry) => entry.gateId === gateId);
  if (!gate) {
    throw new Error(`Gate ${gateId} is missing from the latest current review evidence. Rerun /pipelane review before passing it.`);
  }
  if (!isPassAttestableGate(gate)) {
    throw new Error(`review pass only accepts approval, skill, or agent fallback gates. Gate ${gateId} is type ${gate.type}; rerun /pipelane review to execute it.`);
  }
  if (gate.status === 'failed') {
    throw new Error(`Gate ${gateId} is failed, not pending. Fix it and rerun /pipelane review before passing it.`);
  }
  if (base.gates.some((entry) => entry.blocking !== false && entry.status === 'failed')) {
    throw new Error('review pass cannot clear evidence while a blocking gate is failed. Fix failed gates and rerun /pipelane review first.');
  }

  const startedAt = nowIso();
  const nextGates = base.gates.map((entry) => {
    if (entry.gateId !== gateId || entry.status !== 'pending') return entry;
    return {
      ...entry,
      status: 'passed' as const,
      summary: fallbackPassSummary(message),
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
    };
  });

  return {
    ...base,
    id: `review-pass-${new Date(startedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
    status: summarizeRunStatus(nextGates),
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeStatusReliable: worktreeStatus.statusDigestReliable,
    worktreeStatusWarnings: worktreeStatus.statusDigestWarnings,
    gates: nextGates,
    signature: undefined,
  };
}

function canRunInteractiveReviewSetup(): boolean {
  return (process.stdin.isTTY === true && process.stdout.isTTY === true)
    || (process.env.NODE_ENV === 'test' && process.env.PIPELANE_REVIEW_SETUP_INPUT !== undefined);
}

async function runInteractiveReviewSetup(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const prepared = prepareInteractiveReviewSetup(context.repoRoot);
  const prompter = createReviewSetupPrompter();

  try {
    process.stdout.write(`${renderInteractiveReviewSetup(prepared)}\n`);
    for (;;) {
      const answer = (await prompter.question('> ')).trim().toLowerCase();
      if (answer === 's' || answer === 'save') {
        const writeResult = saveInteractiveReviewSetup(context.repoRoot, prepared.gates);
        process.stdout.write(`${renderInteractiveReviewSetupSaved(context.repoRoot, writeResult, prepared.gates)}\n`);
        return;
      }
      if (answer === 'c' || answer === 'cancel') {
        const report: ReviewSetupReport = {
          command: 'review setup',
          status: 'cancelled',
          repoRoot: context.repoRoot,
          configPath: resolveReadableConfigPath(context.repoRoot),
          configPathIsLegacy: false,
          preset: context.config.reviewGates?.preset ?? 'standard',
          packageJson: {
            path: prepared.packageJson.path,
            found: prepared.packageJson.found,
            malformed: prepared.packageJson.malformed,
            parseError: prepared.packageJson.parseError,
          },
          detectedScripts: prepared.detectedScripts,
          effective: {
            planReview: { gates: context.config.reviewGates?.planReview?.gates ?? [] },
            gates: context.config.reviewGates?.gates ?? [],
          },
          missing: [],
          message: 'Review setup cancelled. No changes written.',
        };
        printResult(parsed.flags, report);
        return;
      }

      const gateNumber = Number.parseInt(answer, 10);
      const gate = Number.isSafeInteger(gateNumber)
        ? prepared.gates.find((candidate) => candidate.number === gateNumber)
        : undefined;
      if (!gate) {
        process.stdout.write('Choose a gate number, s to save, or c to cancel.\n');
        continue;
      }

      await toggleInteractiveGate(gate, prompter);
      process.stdout.write(`\n${renderInteractiveReviewSetup(prepared)}\n`);
    }
  } finally {
    prompter.close();
  }
}

function prepareInteractiveReviewSetup(repoRoot: string): {
  repoRoot: string;
  packageJson: ReviewSetupReport['packageJson'];
  detectedScripts: string[];
  gates: ReviewSetupGateOption[];
} {
  const detection = detectPackageScripts(repoRoot);
  const orderedCatalog = orderInteractiveReviewCatalog(resolveReviewGateCatalog({ repoRoot })
    .filter((entry) => entry.kind === 'review'));
  const gates = orderedCatalog.map((entry, index) => {
    const installState = detectGateInstallState(repoRoot, entry);
    const recommended = isRecommendedInteractiveGate(entry, installState);
    return {
      number: index + 1,
      entry,
      label: reviewSetupGateLabel(entry),
      selected: recommended,
      recommended,
      installState,
    };
  });
  return {
    repoRoot,
    packageJson: {
      path: detection.packageJsonPath,
      found: detection.found,
      malformed: detection.malformed,
      parseError: detection.parseError,
    },
    detectedScripts: Object.keys(detection.scripts).sort(),
    gates,
  };
}

function orderInteractiveReviewCatalog(entries: ResolvedReviewGateCatalogEntry[]): ResolvedReviewGateCatalogEntry[] {
  const order = new Map<string, number>([
    ['typecheck', 10],
    ['format-check', 20],
    ['lint', 30],
    ['secret-scan', 40],
    ['dependency-audit', 50],
    ['test', 60],
    ['build', 70],
    ['gstack-review', 80],
    ['karpathy-diff', 90],
    ['adversarial-review', 100],
    ['browser-qa', 110],
    ['karpathy-audit', 120],
    ['human-merge-approval', 130],
    ['human-prod-deploy-approval', 140],
    ['human-rollback-approval', 150],
  ]);
  return [...entries].sort((left, right) => {
    const leftOrder = order.get(left.id) ?? 1000;
    const rightOrder = order.get(right.id) ?? 1000;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    const phaseDelta = REVIEW_PHASE_ORDER.indexOf(left.phase as ReviewGatePhase) - REVIEW_PHASE_ORDER.indexOf(right.phase as ReviewGatePhase);
    return phaseDelta !== 0 ? phaseDelta : left.id.localeCompare(right.id);
  });
}

function isRecommendedInteractiveGate(entry: ResolvedReviewGateCatalogEntry, installState: GateInstallState): boolean {
  if (!entry.presets.includes(REVIEW_SETUP_RECOMMENDED_PRESET)) return false;
  if (!entry.available) return false;
  if (entry.type === 'skill' || entry.type === 'agent') return installState === 'installed';
  return true;
}

function detectGateInstallState(repoRoot: string, entry: ResolvedReviewGateCatalogEntry): GateInstallState {
  if (entry.type !== 'skill' && entry.type !== 'agent') return 'not applicable';
  const names = knownInstallNamesForGate(entry);
  if (names.length === 0) return 'unavailable';
  if (names.some((name) => isSkillInstalled(repoRoot, name))) return 'installed';
  return hasReviewGateInstaller(entry) ? 'not installed' : 'unavailable';
}

function knownInstallNamesForGate(entry: ResolvedReviewGateCatalogEntry): string[] {
  if (entry.type === 'skill' && entry.skill) return [...new Set([entry.skill, entry.id])];
  if (entry.id === 'adversarial-review') return ['adversarial-review', 'adversarial-code-reviewer'];
  return entry.role ? [entry.role, entry.id] : [entry.id];
}

function isSkillInstalled(repoRoot: string, name: string): boolean {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const candidates = [
    path.join(repoRoot, '.agents', 'skills', name, 'SKILL.md'),
    path.join(codexHome, 'skills', name, 'SKILL.md'),
    path.join(claudeHome, 'skills', name, 'SKILL.md'),
    path.join(os.homedir(), '.gstack', 'repos', 'gstack', '.agents', 'skills', `gstack-${name}`, 'SKILL.md'),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

async function toggleInteractiveGate(
  gate: ReviewSetupGateOption,
  prompter: { question(prompt: string): Promise<string> },
): Promise<void> {
  if (gate.selected) {
    gate.selected = false;
    return;
  }

  if (!gate.entry.available) {
    process.stdout.write(`${gate.label} cannot be enabled: ${gate.entry.missingReason ?? 'gate unavailable'}.\n`);
    return;
  }

  if ((gate.entry.type === 'skill' || gate.entry.type === 'agent') && gate.installState === 'unavailable') {
    process.stdout.write([
      `${gate.label} is unavailable.`,
      `Install ${reviewSetupInstallTarget(gate.entry)} outside Pipelane, then rerun review setup.`,
    ].join('\n') + '\n');
    gate.selected = false;
    return;
  }

  if ((gate.entry.type === 'skill' || gate.entry.type === 'agent') && gate.installState !== 'installed') {
    process.stdout.write([
      `${gate.label} is ${gate.installState}.`,
      '',
      `Install ${reviewSetupInstallTarget(gate.entry)} now?`,
      '',
      '1. Install and enable',
      '2. Leave disabled',
    ].join('\n') + '\n');
    const installAnswer = (await prompter.question('> ')).trim();
    if (installAnswer !== '1') {
      gate.selected = false;
      return;
    }
    if (installMissingReviewGate(gate)) {
      gate.installState = 'installed';
      gate.selected = true;
      return;
    }
    gate.selected = false;
    process.stdout.write('No installer is configured for this gate yet. It remains disabled.\n');
    return;
  }

  gate.selected = true;
}

function hasReviewGateInstaller(entry: ResolvedReviewGateCatalogEntry): boolean {
  if (process.env.NODE_ENV === 'test') {
    const allowed = configuredTestReviewGateInstallers();
    return allowed.includes(entry.id);
  }
  return false;
}

function installMissingReviewGate(gate: ReviewSetupGateOption): boolean {
  if (process.env.NODE_ENV === 'test') {
    const allowed = configuredTestReviewGateInstallers();
    return allowed.includes(gate.entry.id);
  }
  return false;
}

function configuredTestReviewGateInstallers(): string[] {
  return (process.env.PIPELANE_REVIEW_SETUP_INSTALL_SUCCESS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function reviewSetupInstallTarget(entry: ResolvedReviewGateCatalogEntry): string {
  if (entry.type === 'agent') return entry.role ?? entry.id;
  return entry.skill ?? entry.id;
}

function saveInteractiveReviewSetup(
  repoRoot: string,
  gates: ReviewSetupGateOption[],
): { configPath: string; isLegacy: boolean } {
  const selectedGates = orderReviewGates(gates
    .filter((gate) => gate.selected && gate.entry.available)
    .map((gate) => reviewSetupGateToConfig(gate.entry)));
  const recommendedConfig = buildReviewGatesConfigForPreset(REVIEW_SETUP_RECOMMENDED_PRESET, { repoRoot });
  const recommendedGates = orderReviewGates(recommendedConfig.gates);
  return patchReadableWorkflowConfig(repoRoot, (raw) => ({
    ...raw,
    reviewGates: sameJson(selectedGates, recommendedGates)
      ? buildReviewGatesPresetPatch(raw, REVIEW_SETUP_RECOMMENDED_PRESET, repoRoot)
      : buildReviewGatesExplicitPatch(raw, REVIEW_SETUP_RECOMMENDED_PRESET, selectedGates, repoRoot),
  }));
}

function buildReviewGatesExplicitPatch(
  raw: Record<string, unknown>,
  preset: ReviewGatePreset,
  gates: ReviewGateConfig[],
  repoRoot: string,
): Record<string, unknown> {
  const existing = asRecord(raw.reviewGates);
  const next: Record<string, unknown> = existing ? { ...existing, preset } : { preset };
  const planReview = asRecord(existing?.planReview);
  if (
    planReview
    && Array.isArray(planReview.gates)
    && getGeneratedDefaultCandidates(isReviewGatePreset(existing?.preset) ? existing.preset : 'standard', repoRoot)
      .some((candidate) => sameJson(planReview.gates, candidate.planReview?.gates ?? []))
  ) {
    delete next.planReview;
  }
  next.gates = gates;
  return next;
}

function reviewSetupGateToConfig(entry: ResolvedReviewGateCatalogEntry): ReviewGateConfig {
  return {
    id: entry.id,
    phase: entry.phase as ReviewGatePhase,
    type: entry.type,
    blocking: true,
    command: entry.command,
    skill: entry.skill,
    role: entry.role,
    when: entry.when,
    whenChanged: entry.whenChanged,
    userCommands: entry.userCommands,
  };
}

function createReviewSetupPrompter(): {
  question(prompt: string): Promise<string>;
  close(): void;
} {
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_REVIEW_SETUP_INPUT !== undefined) {
    const answers = process.env.PIPELANE_REVIEW_SETUP_INPUT.split(/\r?\n/);
    let index = 0;
    return {
      question(prompt: string): Promise<string> {
        process.stdout.write(prompt);
        if (index >= answers.length) {
          throw new Error('PIPELANE_REVIEW_SETUP_INPUT exhausted before review setup completed.');
        }
        return Promise.resolve(answers[index++]);
      },
      close(): void {},
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    question(prompt: string): Promise<string> {
      return rl.question(prompt);
    },
    close(): void {
      rl.close();
    },
  };
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
    worktreeStatusDigest: record.worktreeStatusDigest,
    worktreeStatusReliable: record.worktreeStatusReliable,
    worktreeStatusWarnings: record.worktreeStatusWarnings,
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
  const startedAt = nowIso();
  const runStartMs = Date.now();
  let attemptNumber = 0;
  let gateRecords: ReviewGateRunRecord[] = [];

  for (;;) {
    const attempt = buildReviewAttempt({
      repoRoot: options.repoRoot,
      baseBranch: options.baseBranch,
      gates: options.gates,
      gateFilter,
      phaseFilter,
    });
    if (gateFilter && attempt.selectedGates.length === 0) {
      throw new Error(`No review gate matches --gate ${gateFilter}. Run "pipelane run review setup --list-gates" to inspect configured gates.`);
    }

    const result = runReviewAttempt({
      repoRoot: options.repoRoot,
      baseBranch: options.baseBranch,
      dryRun: options.dryRun,
      reviewConfigChanged: attempt.reviewConfigChanged,
      changedFiles: attempt.changedFiles,
      activeSurfaces: options.activeSurfaces,
      selectedGates: attempt.selectedGates,
      restartAttempt: attemptNumber,
    });
    gateRecords = result.gates;

    if (!result.mutation) {
      break;
    }

    if (attemptNumber >= MAX_REVIEW_RESTARTS_AFTER_MUTATION) {
      gateRecords = markMutationRestartExhausted(gateRecords, result.mutation, attemptNumber, attempt.selectedGates);
      break;
    }

    attemptNumber += 1;
  }

  const finishedAt = nowIso();
  const status = summarizeRunStatus(gateRecords);
  const finalWorktreeStatus = readWorktreeStatusSnapshot(options.repoRoot, { includeStatusDigest: true });
  const finalChangedFiles = collectChangedFiles(options.repoRoot, options.baseBranch);

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
    changedFiles: finalChangedFiles,
    worktreeStatusDigest: finalWorktreeStatus.statusDigest,
    worktreeStatusReliable: finalWorktreeStatus.statusDigestReliable,
    worktreeStatusWarnings: finalWorktreeStatus.statusDigestWarnings,
    gates: gateRecords,
  };
}

function buildReviewAttempt(options: {
  repoRoot: string;
  baseBranch: string;
  gates: ReviewGateConfig[];
  gateFilter: string;
  phaseFilter: ReviewGatePhase | '';
}): BuildReviewAttempt {
  const changedFiles = collectChangedFiles(options.repoRoot, options.baseBranch);
  const reviewConfigChanged = changedFiles.some(isReviewConfigPath);
  const allGates = orderReviewGates(options.gates);
  const selectedGates = maybeAddReviewConfigChangeGate(allGates.filter((gate) =>
    (!options.phaseFilter || gate.phase === options.phaseFilter)
    && (!options.gateFilter || gate.id === options.gateFilter)
  ), {
    reviewConfigChanged,
  });

  return {
    selectedGates,
    changedFiles,
    reviewConfigChanged,
  };
}

function runReviewAttempt(options: {
  repoRoot: string;
  baseBranch: string;
  dryRun: boolean;
  reviewConfigChanged: boolean;
  changedFiles: string[];
  activeSurfaces: string[];
  selectedGates: ReviewGateConfig[];
  restartAttempt: number;
}): { gates: ReviewGateRunRecord[]; mutation: ReviewGateMutation | null } {
  const gateRecords: ReviewGateRunRecord[] = [];
  let blockingFailureBeforeAi = false;

  for (const gate of options.selectedGates) {
    if (blockingFailureBeforeAi && isAiReviewGate(gate)) {
      gateRecords.push(skippedGateRecord(gate, `skipped: earlier blocking gate failed; ${gate.type} review waits for deterministic gates to pass`));
      continue;
    }

    const before = readWorktreeStatusSnapshot(options.repoRoot, { includeStatusDigest: true });
    const record = runReviewGate({
      gate,
      repoRoot: options.repoRoot,
      baseBranch: options.baseBranch,
      dryRun: options.dryRun,
      reviewConfigChanged: options.reviewConfigChanged,
      changedFiles: options.changedFiles,
      activeSurfaces: options.activeSurfaces,
      restartAttempt: options.restartAttempt,
    });
    const after = readWorktreeStatusSnapshot(options.repoRoot, { includeStatusDigest: true });
    gateRecords.push(record);

    if (record.blocking && record.status === 'failed') {
      blockingFailureBeforeAi = true;
    }

    if (!options.dryRun && worktreeFingerprintChanged(before, after)) {
      return {
        gates: gateRecords,
        mutation: {
          gate: record,
          beforeHead: before.head,
          afterHead: after.head,
          beforeDigest: before.statusDigest,
          afterDigest: after.statusDigest,
        },
      };
    }
  }

  return { gates: gateRecords, mutation: null };
}

function orderReviewGates(gates: ReviewGateConfig[]): ReviewGateConfig[] {
  return [...gates].sort((left, right) => {
    const phaseDelta = REVIEW_PHASE_ORDER.indexOf(left.phase) - REVIEW_PHASE_ORDER.indexOf(right.phase);
    if (phaseDelta !== 0) return phaseDelta;
    const reviewDelta = reviewGateExecutionPriority(left) - reviewGateExecutionPriority(right);
    return reviewDelta !== 0 ? reviewDelta : left.id.localeCompare(right.id);
  });
}

function reviewGateExecutionPriority(gate: ReviewGateConfig): number {
  if (gate.phase !== 'ai-diff') return 100;
  if (gate.id === 'gstack-review') return 10;
  if (gate.id === 'karpathy-diff') return 20;
  if (gate.id === 'adversarial-review') return 30;
  return 100;
}

function runReviewGate(options: {
  gate: ReviewGateConfig;
  repoRoot: string;
  baseBranch: string;
  dryRun: boolean;
  reviewConfigChanged: boolean;
  changedFiles: string[];
  activeSurfaces: string[];
  restartAttempt: number;
}): ReviewGateRunRecord {
  const { gate, repoRoot, baseBranch, dryRun, reviewConfigChanged, changedFiles, activeSurfaces, restartAttempt } = options;
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

  if (dryRun && gate.type !== 'approval') {
    return finishGate(base, startMs, {
      status: 'skipped',
      summary: `dry-run: would run ${reviewGateCommandLabel(gate)}`,
      skipReason: 'dry-run',
    });
  }

  if (gate.type === 'approval') {
    return finishGate(base, startMs, {
      status: 'pending',
      summary: approvalGateSummary(gate),
    });
  }

  if (reviewConfigChanged) {
    return finishGate(base, startMs, {
      status: 'skipped',
      summary: `skipped: review config inputs changed; ${gate.type} gates require trusted approval before execution`,
      skipReason: 'review-config-changed',
    });
  }

  if (gate.type === 'skill' || gate.type === 'agent') {
    return runAiReviewGate({
      base,
      startMs,
      gate,
      repoRoot,
      baseBranch,
      changedFiles,
      restartAttempt,
    });
  }

  if (!gate.command) {
    return finishGate(base, startMs, {
      status: 'failed',
      summary: 'gate is executable but has no command configured',
      exitCode: null,
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

function runAiReviewGate(options: {
  base: Omit<ReviewGateRunRecord, 'status' | 'summary' | 'finishedAt' | 'durationMs'>;
  startMs: number;
  gate: ReviewGateConfig;
  repoRoot: string;
  baseBranch: string;
  changedFiles: string[];
  restartAttempt: number;
}): ReviewGateRunRecord {
  const { base, startMs, gate, repoRoot, baseBranch, changedFiles, restartAttempt } = options;
  const command = resolveAiReviewCommand(gate);
  if (!command) {
    return finishGate(base, startMs, {
      status: 'failed',
      summary: `AI review gate ${gate.id} has no runner; install codex/claude or set ${specificAiReviewCommandEnvName(gate)} or PIPELANE_REVIEW_AI_COMMAND`,
      exitCode: null,
    });
  }

  const prompt = renderAiReviewPrompt({
    repoRoot,
    baseBranch,
    gate,
    changedFiles,
    restartAttempt,
  });
  const timeoutMs = gate.timeoutMs ?? DEFAULT_AI_GATE_TIMEOUT_MS;
  const result = spawnSync('/bin/sh', ['-lc', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: prompt,
    shell: false,
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PIPELANE_REVIEW_GATE_ID: gate.id,
      PIPELANE_REVIEW_GATE_TYPE: gate.type,
      PIPELANE_REVIEW_GATE_SKILL: gate.skill ?? '',
      PIPELANE_REVIEW_GATE_ROLE: gate.role ?? '',
    },
  });
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const combinedOutput = `${stdout}\n${stderr}`;
  const marker = parseAiReviewStatusMarker(combinedOutput);
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';

  if (timedOut) {
    return finishGate(base, startMs, {
      command,
      status: 'failed',
      summary: `AI review command timed out after ${timeoutMs}ms`,
      exitCode,
      stdoutTail: tail(redactReviewOutput(stdout)),
      stderrTail: tail(redactReviewOutput(stderr)),
    });
  }
  if (result.error) {
    return finishGate(base, startMs, {
      command,
      status: 'failed',
      summary: `AI review command failed to start: ${result.error.message}`,
      exitCode,
      stdoutTail: tail(redactReviewOutput(stdout)),
      stderrTail: tail(redactReviewOutput(stderr)),
    });
  }
  if (exitCode !== 0) {
    return finishGate(base, startMs, {
      command,
      status: 'failed',
      summary: marker.summary || `AI review command exited ${exitCode}`,
      exitCode,
      stdoutTail: tail(redactReviewOutput(stdout)),
      stderrTail: tail(redactReviewOutput(stderr)),
    });
  }
  if (!marker.status) {
    return finishGate(base, startMs, {
      command,
      status: 'failed',
      summary: 'AI review command did not print PIPELANE_REVIEW_STATUS: passed|failed|pending',
      exitCode,
      stdoutTail: tail(redactReviewOutput(stdout)),
      stderrTail: tail(redactReviewOutput(stderr)),
    });
  }

  return finishGate(base, startMs, {
    command,
    status: marker.status,
    summary: marker.summary || `AI review ${marker.status}: ${reviewGateCommandLabel(gate)}`,
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

function isPassAttestableGate(gate: Pick<ReviewGateConfig | ReviewGateRunRecord, 'type'>): boolean {
  return gate.type === 'skill' || gate.type === 'agent' || gate.type === 'approval';
}

function fallbackPassSummary(message: string): string {
  return `fallback pass: ${message}`;
}

function isAiReviewGate(gate: Pick<ReviewGateConfig, 'type'>): boolean {
  return gate.type === 'skill' || gate.type === 'agent';
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

function approvalGateSummary(gate: ReviewGateConfig): string {
  if (gate.type === 'approval') {
    return `approval gate pending${gate.when ? ` (${gate.when})` : ''}`;
  }
  return `approval gate pending: ${gate.id}`;
}

function skippedGateRecord(gate: ReviewGateConfig, summary: string, skipReason = 'prior-blocking-failure'): ReviewGateRunRecord {
  const startedAt = nowIso();
  return {
    id: `${gate.id}-${crypto.randomUUID().slice(0, 8)}`,
    gateId: gate.id,
    phase: gate.phase,
    type: gate.type,
    blocking: gate.blocking !== false,
    command: gate.command,
    skill: gate.skill,
    role: gate.role,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    status: 'skipped',
    summary,
    skipReason,
  };
}

function worktreeFingerprintChanged(
  before: ReturnType<typeof readWorktreeStatusSnapshot>,
  after: ReturnType<typeof readWorktreeStatusSnapshot>,
): boolean {
  return before.head !== after.head || before.statusDigest !== after.statusDigest;
}

function markMutationRestartExhausted(
  gates: ReviewGateRunRecord[],
  mutation: ReviewGateMutation,
  restartAttempt: number,
  selectedGates: ReviewGateConfig[],
): ReviewGateRunRecord[] {
  const markedGates = gates.map((gate) => {
    if (gate.id !== mutation.gate.id) return gate;
    const headChanged = mutation.beforeHead !== mutation.afterHead
      ? `HEAD ${shortSha(mutation.beforeHead)} -> ${shortSha(mutation.afterHead)}`
      : 'HEAD unchanged';
    const digestChanged = mutation.beforeDigest !== mutation.afterDigest
      ? 'worktree digest changed'
      : 'worktree digest unchanged';
    return {
      ...gate,
      blocking: true,
      status: 'failed' as const,
      summary: `${gate.summary}; changed the tree after ${restartAttempt + 1} review attempts (${headChanged}, ${digestChanged}); rerun /pipelane review after the tree settles`,
    };
  });
  const seen = new Set(markedGates.map((gate) => gate.gateId));
  const mutationIndex = selectedGates.findIndex((gate) => gate.id === mutation.gate.gateId);
  const remainingGates = mutationIndex >= 0 ? selectedGates.slice(mutationIndex + 1) : [];
  return [
    ...markedGates,
    ...remainingGates
      .filter((gate) => !seen.has(gate.id))
      .map((gate) => skippedGateRecord(
        gate,
        'skipped: review restart exhausted before this gate could run',
        'restart-exhausted',
      )),
  ];
}

function reviewGateCommandLabel(gate: ReviewGateConfig): string {
  if (gate.command) return gate.command;
  if (gate.type === 'skill') {
    return gate.userCommands?.[0] ?? (gate.skill ? `skill:${gate.skill}` : gate.id);
  }
  if (gate.type === 'agent') {
    return gate.role ? `agent:${gate.role}` : gate.id;
  }
  return gate.id;
}

function resolveAiReviewCommand(gate: ReviewGateConfig): string {
  const specific = process.env[specificAiReviewCommandEnvName(gate)]?.trim();
  if (specific) return specific;
  const fallback = process.env.PIPELANE_REVIEW_AI_COMMAND?.trim();
  if (fallback) return fallback;
  return defaultAiReviewCommand();
}

function specificAiReviewCommandEnvName(gate: ReviewGateConfig): string {
  return `PIPELANE_REVIEW_${gate.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_COMMAND`;
}

function defaultAiReviewCommand(): string {
  if (commandExists('codex')) return 'codex exec --full-auto -';
  if (commandExists('claude')) return defaultClaudeReviewCommand();
  return '';
}

function defaultClaudeReviewCommand(): string {
  const help = commandHelp('claude');
  if (/\bdontAsk\b/.test(help)) return 'claude --print --permission-mode dontAsk';
  if (/\bbypassPermissions\b/.test(help)) return 'claude --print --permission-mode bypassPermissions';
  if (help.includes('--dangerously-skip-permissions')) return 'claude --print --dangerously-skip-permissions';
  return 'claude --print';
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NATIVE_COMMAND_PROBE_TIMEOUT_MS,
  });
  return !result.error;
}

function commandHelp(command: string): string {
  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NATIVE_COMMAND_PROBE_TIMEOUT_MS,
  });
  return `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`;
}

function renderAiReviewPrompt(options: {
  repoRoot: string;
  baseBranch: string;
  gate: ReviewGateConfig;
  changedFiles: string[];
  restartAttempt: number;
}): string {
  const { repoRoot, baseBranch, gate, changedFiles, restartAttempt } = options;
  const command = reviewGateCommandLabel(gate);
  const changedFileList = changedFiles.length > 0
    ? changedFiles.slice(0, 200).map((file) => `- ${file}`).join('\n')
    : '- none';
  const truncated = changedFiles.length > 200
    ? `\n- ... ${changedFiles.length - 200} more files omitted from this prompt`
    : '';

  return [
    'You are running an autonomous Pipelane review gate.',
    '',
    `Gate: ${gate.id}`,
    `Type: ${gate.type}`,
    `Skill: ${gate.skill ?? ''}`,
    `Role: ${gate.role ?? ''}`,
    `Command hint: ${command}`,
    `Repository: ${repoRoot}`,
    `Base branch: ${baseBranch}`,
    `Restart attempt after review-side edits: ${restartAttempt}`,
    '',
    'Changed files:',
    `${changedFileList}${truncated}`,
    '',
    'Rules:',
    '- Do not commit, push, merge, deploy, or create a PR.',
    '- Use the configured review command/skill/role named above.',
    '- If this is gstack-review, run the fix-first gstack /review flow. Apply only its allowed automatic fixes; do not ask the user for new approvals inside this gate.',
    '- If this is karpathy-diff, run it as a read-only traceability review. Do not apply proposed fixes during this gate.',
    '- If this is adversarial-review, perform a read-only adversarial code review.',
    '- If a clean result requires human judgment, unresolved non-mechanical fixes, or approval, report pending or failed instead of asking the user.',
    '- If you changed files, leave them in the worktree. Pipelane will restart deterministic gates and re-run review against the new tree.',
    '',
    'At the very end, print exactly one status marker line:',
    'PIPELANE_REVIEW_STATUS: passed',
    'or',
    'PIPELANE_REVIEW_STATUS: failed',
    'or',
    'PIPELANE_REVIEW_STATUS: pending',
    '',
    'Also print one concise summary marker line:',
    'PIPELANE_REVIEW_SUMMARY: <one sentence>',
  ].join('\n');
}

function parseAiReviewStatusMarker(output: string): AiReviewStatusMarker {
  const statusMatches = [...output.matchAll(/^PIPELANE_REVIEW_STATUS:\s*(passed|failed|pending)\s*$/gim)];
  const summaryMatches = [...output.matchAll(/^PIPELANE_REVIEW_SUMMARY:\s*(.+)$/gim)];
  const statusMatch = statusMatches[statusMatches.length - 1];
  const summaryMatch = summaryMatches[summaryMatches.length - 1];
  return {
    status: statusMatch ? statusMatch[1] as AiReviewStatusMarker['status'] : null,
    summary: summaryMatch?.[1]?.trim() ?? '',
  };
}

function shortSha(value: string): string {
  return value ? value.slice(0, 7) : 'unknown';
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
    lines.push('', 'Next: resolve pending AI runner output or approval gates, then rerun /pipelane review before PR enforcement.');
  } else {
    lines.push('', 'Next: continue to /pr when ready.');
  }

  return lines.join('\n');
}

function renderReviewPassReport(record: ReviewRunRecord, gateId: string, evidencePath: string): string {
  const gate = record.gates.find((entry) => entry.gateId === gateId);
  const lines = [
    'Pipelane review pass',
    `Status: ${record.status}`,
    `Evidence: ${evidencePath}`,
    `Run: ${record.id}`,
    `Gate: ${gateId}`,
    `Gate status: ${gate?.status ?? 'missing'}`,
  ];

  if (gate?.summary) {
    lines.push(`Summary: ${gate.summary}`);
  }

  const pending = record.gates.filter((entry) => entry.status === 'pending');
  if (pending.length > 0) {
    lines.push('', 'Still pending:');
    for (const entry of pending) {
      lines.push(`- ${entry.gateId}: ${entry.summary}`);
    }
  }

  if (record.status === 'passed') {
    lines.push('', 'Next: continue to /pr when ready.');
  } else {
    lines.push('', 'Next: resolve remaining pending approvals or external fallback gates, then rerun /pipelane review.');
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

function renderInteractiveReviewSetup(prepared: {
  packageJson: ReviewSetupReport['packageJson'];
  detectedScripts: string[];
  gates: ReviewSetupGateOption[];
}): string {
  const lines = [
    'Review setup',
    '',
    'I found these repo checks:',
    ...formatDetectedRepoChecks(prepared.gates),
    '',
    'Recommended gates are preselected below.',
    'Type a gate number to toggle it. Type s to save, or c to cancel.',
  ];

  for (const section of reviewSetupSections()) {
    const gates = prepared.gates.filter((gate) => section.ids.includes(gate.entry.id));
    if (gates.length === 0) continue;
    lines.push('', `${section.title}:`);
    for (const gate of gates) {
      lines.push(formatInteractiveGate(gate));
    }
  }

  lines.push('', 'Actions:', 's. Save and continue', 'c. Cancel');
  return lines.join('\n');
}

function renderInteractiveReviewSetupSaved(
  repoRoot: string,
  writeResult: { configPath: string; isLegacy: boolean },
  gates: ReviewSetupGateOption[],
): string {
  const enabled = gates
    .filter((gate) => gate.selected)
    .map((gate) => gate.entry.id);
  const byPhase = REVIEW_PHASE_ORDER
    .map((phase) => ({
      phase,
      ids: enabled.filter((id) => gates.find((gate) => gate.entry.id === id)?.entry.phase === phase),
    }))
    .filter((entry) => entry.ids.length > 0);
  const lines = [
    '',
    'Review gates configured.',
    `Config: ${path.relative(repoRoot, writeResult.configPath) || writeResult.configPath}`,
    '',
    'Enabled:',
  ];
  for (const entry of byPhase) {
    lines.push(`- ${entry.phase}: ${entry.ids.join(', ')}`);
  }
  if (byPhase.length === 0) lines.push('- none');
  lines.push('', 'Next: run /pipelane orchestrate');
  return lines.join('\n');
}

function formatDetectedRepoChecks(gates: ReviewSetupGateOption[]): string[] {
  const checks = gates
    .filter((gate) => gate.entry.type === 'command' && gate.entry.command)
    .map((gate) => `- ${gate.entry.command}`);
  return checks.length > 0 ? checks : ['- none'];
}

function reviewSetupSections(): Array<{ title: string; ids: string[] }> {
  return [
    { title: 'Static gates', ids: ['typecheck', 'format-check', 'lint', 'secret-scan', 'dependency-audit'] },
    { title: 'Behavioral gates', ids: ['test', 'build'] },
    { title: 'AI review gates', ids: ['gstack-review', 'karpathy-diff', 'adversarial-review'] },
    { title: 'Conditional gates', ids: ['browser-qa', 'karpathy-audit'] },
    { title: 'Human approval gates', ids: ['human-merge-approval', 'human-prod-deploy-approval', 'human-rollback-approval'] },
  ];
}

function formatInteractiveGate(gate: ReviewSetupGateOption): string {
  const selected = gate.selected ? '[on] ' : '[off]';
  const number = `${gate.number}.`.padEnd(4, ' ');
  const label = gate.label.padEnd(27, ' ');
  const detail = reviewSetupGateDetail(gate);
  return `${number}${selected} ${label}${detail}`;
}

function reviewSetupGateDetail(gate: ReviewSetupGateOption): string {
  const entry = gate.entry;
  if (entry.type === 'command') {
    if (entry.command) return entry.command;
    return noScriptFoundLabel(entry);
  }
  const target = entry.userCommands?.[0]
    ?? entry.skill
    ?? entry.role
    ?? entry.when
    ?? entry.type;
  const install = gate.installState === 'not applicable' ? '' : ` ${gate.installState}`;
  const condition = entry.whenChanged && entry.whenChanged.length > 0
    ? ` when ${entry.whenChanged.join(', ')} changes`
    : entry.when
      ? ` ${entry.when}`
      : '';
  return `${target}${condition}${install}`;
}

function noScriptFoundLabel(entry: ResolvedReviewGateCatalogEntry): string {
  const script = entry.scriptNames?.[0] ?? entry.id;
  return `no ${script} script found`;
}

function reviewSetupGateLabel(entry: ResolvedReviewGateCatalogEntry): string {
  const labels: Record<string, string> = {
    'typecheck': 'Typecheck',
    'format-check': 'Format check',
    'lint': 'Lint',
    'secret-scan': 'Secret scan',
    'dependency-audit': 'Dependency audit',
    'test': 'Tests',
    'build': 'Build',
    'karpathy-diff': 'Karpathy diff review',
    'gstack-review': 'gstack /review',
    'adversarial-review': 'Adversarial review',
    'browser-qa': 'Browser QA',
    'karpathy-audit': 'Instruction audit',
    'human-merge-approval': 'Merge approval',
    'human-prod-deploy-approval': 'Production deploy approval',
    'human-rollback-approval': 'Rollback approval',
  };
  return labels[entry.id] ?? entry.id;
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
