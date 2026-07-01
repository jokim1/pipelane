import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
  detectPackageScripts,
  resolveReviewGateAlias,
  resolveReviewGateCatalog,
  type ResolvedReviewGateCatalogEntry,
} from '../review-gates.ts';
import {
  blockingAiReviewEvidenceBlocker,
  resolveReviewActorIdentity,
  resolveReviewAuthorIdentity,
} from '../review-identity.ts';
import {
  isIndependentAiReviewGate,
  matchesReviewRisk,
  REVIEW_GATES_POLICY_VERSION,
} from '../review-gate-policy.ts';
import { readWorktreeStatusSnapshot, type WorktreeStatusSnapshot } from '../worktree-status.ts';
import { DEPLOY_STATE_KEY_ENV, ORCHESTRATION_STATE_KEY_ENV, PROBE_STATE_KEY_ENV, REVIEW_STATE_KEY_ENV } from '../integrity.ts';
import {
  appendReviewRunRecord,
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
  type ReviewRunRecord,
  type WorkflowConfig,
  type ReviewPlanGateConfig,
} from '../state.ts';
import {
  guardReviewRunStartForRouteSafety,
  recordReviewRunForRouteSafety,
} from '../route-loop-safety.ts';

type ReviewSetupStatus = 'configured' | 'reported' | 'cancelled';
type ReviewCommandStatus = ReviewRunRecord['status'];
type ReviewAttestStatus = 'attested';

const REVIEW_CONFIG_CHANGE_GATE_ID = 'review-config-change';
const REVIEW_CONFIG_CHANGE_WHEN = 'review-config-changed';
const REVIEW_CONFIG_CHANGE_PATHS = ['.pipelane.json', '.project-workflow.json', 'package.json'];
const REVIEW_PHASE_ORDER = REVIEW_GATE_PHASES;
const DEFAULT_GATE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_REVIEW_SETUP_NPM_INSTALL_TIMEOUT_MS = 2 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;
const REVIEW_GATE_CAPTURE_TAIL_BYTES = 2 * 1024 * 1024;
const REVIEW_GATE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REVIEW_GATE_CAPTURE_HELPER_MAX_BUFFER_BYTES = REVIEW_GATE_CAPTURE_TAIL_BYTES * 6;
const REVIEW_GATE_RESULT_MARKER = 'PIPELANE_REVIEW_GATE_RESULT';
const REVIEW_GATE_SESSION_ENV = 'PIPELANE_REVIEW_GATE_SESSION_ID';
const AI_REVIEW_GATE_SCRUBBED_SESSION_ENV_KEYS = [
  'PIPELANE_AUTHOR_SESSION_ID',
  'PIPELANE_WORKER_SESSION_ID',
  'PIPELANE_ORCHESTRATE_WORKER_SESSION_ID',
  'PIPELANE_AGENT_SESSION_ID',
  'PIPELANE_REVIEW_GATE_SESSION_ID',
  'CODEX_SESSION_ID',
  'OPENAI_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'ANTHROPIC_SESSION_ID',
  'OPENCLAW_SESSION',
] as const;
const CODEX_CLAUDE_REVIEW_REPO = 'https://github.com/jokim1/codexskill-claude-review.git';
const CODEX_CLAUDE_REVIEW_SKILL_NAME = 'claude';
const KARPATHY_SKILLS_REPO = 'https://github.com/jokim1/karpathy-skills.git';
const GITLEAKS_NPM_PACKAGE = '@nogoo9/gitleaks';
const ANTHROPIC_API_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BEARER_TOKEN',
  'ANTHROPIC_CONSOLE_API_KEY',
  'ANTHROPIC_CONSOLE_AUTH_TOKEN',
];

type GateInstallState = 'installed' | 'not installed' | 'unavailable' | 'not applicable';

interface ReviewGateInstallResult {
  ok: boolean;
  message: string;
}

interface ReviewGateInstallOption {
  id: string;
  label: string;
  target: string;
  install(): ReviewGateInstallResult;
}

type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown' | 'unsupported' | 'conflict';
type ReviewSetupSectionId = 'M' | 'T' | 'C' | 'I' | 'H' | 'X';

interface ReviewSetupSection {
  id: ReviewSetupSectionId;
  title: string;
  ids: string[];
}

interface DetectedPackageManager {
  id: PackageManagerId;
  source: string;
  packageManager?: string;
  lockfile?: string;
  conflicts?: string[];
}

interface ReviewSetupSelectionResult {
  messages: string[];
  enabledIds: string[];
  disabledIds: string[];
  installedIds: string[];
  toggledOnIds: string[];
  toggledOffIds: string[];
}

interface ReviewSetupSaveOptions {
  existingReviewGates?: ReviewGateConfig[];
  preserveExistingReviewGates?: boolean;
  useSelectedDefaults?: boolean;
  changedGateIds?: Set<string>;
  disabledGateIds?: Set<string>;
}

interface AdversarialReviewProvider {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  installable: boolean;
  target?: string;
}

interface ReviewSetupGateOption {
  number: number;
  displayId: string;
  section: ReviewSetupSection;
  entry: ResolvedReviewGateCatalogEntry;
  label: string;
  selected: boolean;
  recommended: boolean;
  installState: GateInstallState;
  hydratedFromSavedConfig: boolean;
  adversarialProvider?: AdversarialReviewProvider;
}

interface ClaudeReviewSetupStatus {
  claudeCliPath: string | null;
  codeReviewHighAvailable: boolean;
  codeReviewHighSource: string;
  codexBridgeInstalled: boolean;
  codexBridgeTarget: string;
  apiEnvKeys: string[];
}

interface ReviewSetupReport {
  command: 'review setup';
  status: ReviewSetupStatus;
  repoRoot: string;
  configPath: string | null;
  configPathIsLegacy: boolean;
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
  actions?: string[];
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
  gates: ReviewGateConfig[];
  dryRun: boolean;
  gateFilter?: string;
  phaseFilter?: ReviewGatePhase | '';
  activeSurfaces: string[];
  reviewConfigChangeApproval?: ReviewGateRunRecord | null;
  onGateStart?: (gate: ReviewGateConfig) => void;
  onGateFinish?: (gate: ReviewGateRunRecord) => void;
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
  let writeResult: { configPath: string; isLegacy: boolean } | null = null;
  const actionMessages: string[] = [];
  const mutationFlags = hasReviewSetupMutationFlags(parsed);
  const hasSavedConfig = resolveReadableConfigPath(context.repoRoot) !== null;
  if (mutationFlags && (parsed.flags.reviewPrint || parsed.flags.reviewListGates)) {
    throw new Error('review setup cannot combine modifying flags (--toggle, --enable, --disable, --install, --reset) with read-only flags (--print, --list-gates). Run the modifying command first, then inspect with --print or --list-gates.');
  }

  if (mutationFlags) {
    const resetToDefaults = parsed.flags.yes || parsed.flags.reviewReset;
    const prepared = prepareInteractiveReviewSetup(context.repoRoot, context.config, { resetToDefaults });
    const selectionResult = applyReviewSetupSelections(context.repoRoot, prepared, parsed);
    if (resetToDefaults) {
      actionMessages.push('Reset review gates to recommended defaults.');
    }
    actionMessages.push(...selectionResult.messages);
    const existingReviewGates = hasSavedConfig ? context.config.reviewGates?.gates ?? [] : [];
    writeResult = saveInteractiveReviewSetup(context.repoRoot, prepared.gates, {
      existingReviewGates,
      preserveExistingReviewGates: hasSavedConfig && !resetToDefaults,
      useSelectedDefaults: resetToDefaults,
      changedGateIds: new Set([...selectionResult.enabledIds, ...selectionResult.installedIds, ...selectionResult.toggledOnIds]),
      disabledGateIds: new Set([...selectionResult.disabledIds, ...selectionResult.toggledOffIds]),
    });
    context = resolveWorkflowContext(cwd);
    if (!parsed.flags.json) {
      const preparedAfterWrite = prepareInteractiveReviewSetup(context.repoRoot, context.config);
      process.stdout.write(`${renderReviewSetupState(preparedAfterWrite, {
        status: 'configured',
        configPath: writeResult.configPath,
        actions: actionMessages,
      })}\n`);
      return;
    }
  }

  if (
    !mutationFlags
    && !parsed.flags.reviewPrint
    && !parsed.flags.reviewListGates
    && !parsed.flags.json
  ) {
    const prepared = prepareInteractiveReviewSetup(context.repoRoot, context.config);
    if (canRunInteractiveReviewSetup()) {
      await runInteractiveReviewSetup(cwd, parsed);
      return;
    }
    process.stdout.write(`${renderReviewSetupState(prepared, {
      status: 'reported',
      configPath: resolveReadableConfigPath(context.repoRoot),
    })}\n`);
    return;
  }

  const detection = detectPackageScripts(context.repoRoot);
  const resolvedCatalog = resolveReviewGateCatalog({ repoRoot: context.repoRoot });
  const effectivePlanGates = context.config.reviewGates?.planReview?.gates ?? [];
  const effectiveGates = context.config.reviewGates?.gates ?? [];
  const configPath = writeResult?.configPath ?? resolveReadableConfigPath(context.repoRoot);
  const report: ReviewSetupReport = {
    command: 'review setup',
    status: writeResult ? 'configured' : 'reported',
    repoRoot: context.repoRoot,
    configPath,
    configPathIsLegacy: writeResult?.isLegacy ?? (configPath ? path.basename(configPath) !== '.pipelane.json' : false),
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
    actions: actionMessages,
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

  const expectedGate = options.config.reviewGates?.gates?.find((gate) => gate.id === gateId)
    ?? (gateId === REVIEW_CONFIG_CHANGE_GATE_ID ? reviewConfigChangeGateConfig() : undefined);
  if (!expectedGate) {
    throw new Error(`No configured review gate matches --gate ${gateId}. Run "pipelane run review setup --list-gates" to inspect configured gates.`);
  }
  if (!isManualReviewGate(expectedGate)) {
    throw new Error(`review pass only accepts manual gates. Gate ${gateId} is type ${expectedGate.type}; rerun /pipelane review to execute it.`);
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
  if (!isManualReviewGate(gate)) {
    throw new Error(`review pass only accepts manual gates. Gate ${gateId} is type ${gate.type}; rerun /pipelane review to execute it.`);
  }
  if (gate.status === 'failed') {
    throw new Error(`Gate ${gateId} is failed, not pending. Fix it and rerun /pipelane review before passing it.`);
  }
  if (base.gates.some((entry) => entry.blocking !== false && entry.status === 'failed')) {
    throw new Error('review pass cannot clear evidence while a blocking gate is failed. Fix failed gates and rerun /pipelane review first.');
  }

  const startedAt = nowIso();
  const attester = resolveReviewActorIdentity();
  if (isIndependentAiReviewGate(gate) && base.authorIdentity) {
    const candidateGate: ReviewGateRunRecord = {
      ...gate,
      status: 'passed',
      attester,
      summary: manualPassSummary(message),
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
    };
    const blocker = blockingAiReviewEvidenceBlocker({
      reviewRun: { ...base, gates: [candidateGate] },
      worker: base.authorIdentity ?? null,
      allowSessionOnlyIndependence: true,
    });
    if (blocker) {
      throw new Error(`review pass cannot attest independent AI gate ${gateId}: ${blocker}`);
    }
  }
  const nextGates = base.gates.map((entry) => {
    if (entry.gateId !== gateId || entry.status !== 'pending') return entry;
    return {
      ...entry,
      status: 'passed' as const,
      attester,
      summary: manualPassSummary(message),
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
    };
  });

  return {
    ...base,
    id: `review-pass-${new Date(startedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
    status: gateId === REVIEW_CONFIG_CHANGE_GATE_ID
      ? summarizeConfigChangeApprovalStatus(nextGates)
      : summarizeRunStatus(nextGates),
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeStatusReliable: worktreeStatus.statusDigestReliable,
    worktreeStatusWarnings: worktreeStatus.statusDigestWarnings,
    authorIdentity: base.authorIdentity,
    reviewer: base.reviewer,
    gates: nextGates,
    signature: undefined,
  };
}

function canRunInteractiveReviewSetup(): boolean {
  return (process.stdin.isTTY === true && process.stdout.isTTY === true)
    || (process.env.NODE_ENV === 'test' && process.env.PIPELANE_REVIEW_SETUP_INPUT !== undefined);
}

async function runInteractiveReviewSetup(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  let context = resolveWorkflowContext(cwd);
  let prepared = prepareInteractiveReviewSetup(context.repoRoot, context.config);
  const prompter = createReviewSetupPrompter();

  try {
    process.stdout.write(`${renderReviewSetupState(prepared, {
      status: 'reported',
      configPath: resolveReadableConfigPath(context.repoRoot),
      interactive: true,
    })}\n`);
    for (;;) {
      const answer = (await prompter.question('> ')).trim();
      const normalizedAnswer = answer.toLowerCase();
      if (answer === '' || normalizedAnswer === 'q' || normalizedAnswer === 'quit' || normalizedAnswer === 'done' || normalizedAnswer === 'c' || normalizedAnswer === 'cancel') {
        process.stdout.write('Review setup closed.\n');
        return;
      }

      let gateId: string;
      try {
        gateId = resolveReviewSetupGateInput(prepared.gates, answer, 'input');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stdout.write(`${detail}\n`);
        continue;
      }

      const gate = requirePreparedGate(prepared.gates, gateId);
      const wasSelected = gate.selected;
      await toggleInteractiveGate(gate, prompter, context.repoRoot);
      if (gate.selected === wasSelected) {
        process.stdout.write(`\n${renderReviewSetupState(prepared, {
          status: 'reported',
          configPath: resolveReadableConfigPath(context.repoRoot),
          interactive: true,
        })}\n`);
        continue;
      }

      const hasSavedConfig = resolveReadableConfigPath(context.repoRoot) !== null;
      const writeResult = saveInteractiveReviewSetup(context.repoRoot, prepared.gates, {
        existingReviewGates: hasSavedConfig ? context.config.reviewGates?.gates ?? [] : [],
        preserveExistingReviewGates: hasSavedConfig,
        changedGateIds: gate.selected ? new Set([gate.entry.id]) : new Set(),
        disabledGateIds: gate.selected ? new Set() : new Set([gate.entry.id]),
      });
      context = resolveWorkflowContext(cwd);
      prepared = prepareInteractiveReviewSetup(context.repoRoot, context.config);
      process.stdout.write(`\n${renderReviewSetupState(prepared, {
        status: 'configured',
        configPath: writeResult.configPath,
        actions: [`Toggled ${gate.displayId} ${gate.entry.id} ${gate.selected ? 'on' : 'off'}.`],
        interactive: true,
      })}\n`);
    }
  } finally {
    prompter.close();
  }
}

function prepareInteractiveReviewSetup(repoRoot: string, config: WorkflowConfig, options: { resetToDefaults?: boolean } = {}): {
  repoRoot: string;
  packageJson: ReviewSetupReport['packageJson'];
  detectedScripts: string[];
  gates: ReviewSetupGateOption[];
  claude: ClaudeReviewSetupStatus;
} {
  const detection = detectPackageScripts(repoRoot);
  const hydrateFromSavedConfig = !options.resetToDefaults && resolveReadableConfigPath(repoRoot) !== null;
  const savedGateById = new Map<string, ReviewGateConfig>();
  if (hydrateFromSavedConfig) {
    for (const gate of config.reviewGates?.gates ?? []) {
      savedGateById.set(gate.id, gate);
    }
  }
  const orderedCatalog = orderInteractiveReviewCatalog(resolveReviewGateCatalog({ repoRoot })
    .filter((entry) => entry.kind === 'review'));
  const gates: ReviewSetupGateOption[] = orderedCatalog.map((entry, index) => {
    const savedGate = savedGateById.get(entry.id);
    const displayEntry = savedGate ? hydrateReviewSetupEntryFromSavedGate(entry, savedGate) : entry;
    const installState = detectGateInstallState(repoRoot, entry);
    const recommended = isRecommendedInteractiveGate(entry, installState);
    const section = reviewSetupSectionForGate(entry.id);
    return {
      number: index + 1,
      displayId: '',
      section,
      entry: displayEntry,
      label: reviewSetupGateLabel(displayEntry),
      selected: hydrateFromSavedConfig ? Boolean(savedGate) : recommended,
      recommended,
      installState,
      hydratedFromSavedConfig: Boolean(savedGate),
      adversarialProvider: entry.id === 'adversarial-review' && !savedGate && !hydrateFromSavedConfig && recommended
        ? preferredAdversarialReviewProvider(repoRoot)
        : undefined,
    };
  });
  for (const savedGate of savedGateById.values()) {
    if (gates.some((gate) => gate.entry.id === savedGate.id)) continue;
    const section = customReviewSetupSection();
    gates.push({
      number: gates.length + 1,
      displayId: '',
      section,
      entry: reviewSetupEntryFromCustomSavedGate(savedGate),
      label: savedGate.id,
      selected: true,
      recommended: false,
      installState: 'not applicable',
      hydratedFromSavedConfig: true,
    });
  }
  const codeReviewHigh = gates.find((gate) => gate.entry.id === 'code-review-high');
  const gstackReview = gates.find((gate) => gate.entry.id === 'gstack-review');
  if (!hydrateFromSavedConfig && codeReviewHigh?.selected && gstackReview?.selected) {
    gstackReview.selected = false;
    gstackReview.recommended = false;
  }
  assignReviewSetupDisplayIds(gates);
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
    claude: buildClaudeReviewSetupStatus(),
  };
}

function hydrateReviewSetupEntryFromSavedGate(
  entry: ResolvedReviewGateCatalogEntry,
  savedGate: ReviewGateConfig,
): ResolvedReviewGateCatalogEntry {
  return {
    ...entry,
    phase: savedGate.phase,
    type: savedGate.type,
    available: true,
    command: savedGate.command ?? entry.command,
    skill: savedGate.skill ?? entry.skill,
    role: savedGate.role ?? entry.role,
    when: savedGate.when ?? entry.when,
    whenChanged: savedGate.whenChanged ?? entry.whenChanged,
    userCommands: savedGate.userCommands ?? entry.userCommands,
  };
}

function reviewSetupEntryFromCustomSavedGate(gate: ReviewGateConfig): ResolvedReviewGateCatalogEntry {
  return {
    id: gate.id,
    kind: 'review',
    phase: gate.phase,
    type: gate.type,
    available: true,
    command: gate.command,
    skill: gate.skill,
    role: gate.role,
    when: gate.when,
    whenChanged: gate.whenChanged,
    userCommands: gate.userCommands,
    recommended: false,
  };
}

function assignReviewSetupDisplayIds(gates: ReviewSetupGateOption[]): void {
  const counters = new Map<ReviewSetupSectionId, number>();
  gates.forEach((gate, index) => {
    gate.number = index + 1;
    const next = (counters.get(gate.section.id) ?? 0) + 1;
    counters.set(gate.section.id, next);
    gate.displayId = `${gate.section.id}${next}`;
  });
}

function reviewSetupSectionForGate(gateId: string): ReviewSetupSection {
  return reviewSetupSections().find((section) => section.ids.includes(gateId)) ?? customReviewSetupSection();
}

function customReviewSetupSection(): ReviewSetupSection {
  return { id: 'X', title: 'Custom gates', ids: [] };
}

function hasReviewSetupMutationFlags(parsed: ParsedOperatorArgs): boolean {
  return parsed.flags.reviewEnable.length > 0
    || parsed.flags.reviewDisable.length > 0
    || parsed.flags.reviewInstall.length > 0
    || parsed.flags.reviewToggle.length > 0
    || parsed.flags.reviewReset
    || parsed.flags.yes;
}

function applyReviewSetupSelections(
  repoRoot: string,
  prepared: { gates: ReviewSetupGateOption[] },
  parsed: ParsedOperatorArgs,
): ReviewSetupSelectionResult {
  const installIds = resolveReviewSetupGateInputs(prepared.gates, parsed.flags.reviewInstall, '--install');
  const enableIds = resolveReviewSetupGateInputs(prepared.gates, parsed.flags.reviewEnable, '--enable');
  const disableIds = resolveReviewSetupGateInputs(prepared.gates, parsed.flags.reviewDisable, '--disable');
  const toggleIds = resolveReviewSetupGateInputs(prepared.gates, parsed.flags.reviewToggle, '--toggle');
  const installSet = new Set(installIds);
  const enableSet = new Set(enableIds);
  const disableSet = new Set(disableIds);
  const toggleSet = new Set(toggleIds);
  const conflicting = [...new Set([...installIds, ...enableIds])]
    .filter((id) => disableSet.has(id));
  if (conflicting.length > 0) {
    throw new Error(`review setup cannot both enable/install and disable: ${conflicting.join(', ')}`);
  }
  const toggleConflicts = [...toggleSet].filter((id) => installSet.has(id) || enableSet.has(id) || disableSet.has(id));
  if (toggleConflicts.length > 0) {
    throw new Error(`review setup cannot both toggle and explicitly set: ${toggleConflicts.join(', ')}`);
  }

  const messages: string[] = [];
  const toggledOnIds: string[] = [];
  const toggledOffIds: string[] = [];
  for (const id of installSet) {
    const gate = requirePreparedGate(prepared.gates, id);
    messages.push(installPreparedReviewGate(repoRoot, prepared.gates, gate));
  }
  for (const id of disableSet) {
    const gate = requirePreparedGate(prepared.gates, id);
    gate.selected = false;
    gate.adversarialProvider = undefined;
    messages.push(`Disabled ${gate.entry.id}.`);
  }
  for (const id of enableSet) {
    const gate = requirePreparedGate(prepared.gates, id);
    messages.push(enablePreparedReviewGate(repoRoot, prepared.gates, gate));
  }
  for (const id of toggleSet) {
    const gate = requirePreparedGate(prepared.gates, id);
    if (gate.selected) {
      gate.selected = false;
      gate.adversarialProvider = undefined;
      toggledOffIds.push(gate.entry.id);
      messages.push(`Toggled ${gate.displayId} ${gate.entry.id} off.`);
      continue;
    }
    messages.push(enablePreparedReviewGate(repoRoot, prepared.gates, gate).replace(/^Enabled /, `Toggled ${gate.displayId} `));
    toggledOnIds.push(gate.entry.id);
  }

  return {
    messages,
    enabledIds: enableIds,
    disabledIds: disableIds,
    installedIds: installIds,
    toggledOnIds,
    toggledOffIds,
  };
}

function resolveReviewSetupGateInputs(
  gates: ReviewSetupGateOption[],
  inputs: string[],
  flagName: string,
): string[] {
  return [...new Set(inputs.map((input) => resolveReviewSetupGateInput(gates, input, flagName)))];
}

function resolveReviewSetupGateInput(
  gates: ReviewSetupGateOption[],
  input: string,
  flagName: string,
): string {
  const trimmed = input.trim();
  const numeric = Number.parseInt(trimmed, 10);
  if (/^\d+$/.test(trimmed) && Number.isSafeInteger(numeric)) {
    const gate = gates.find((candidate) => candidate.number === numeric);
    if (gate) return gate.entry.id;
  }

  const displayId = trimmed.toUpperCase();
  const displayGate = gates.find((candidate) => candidate.displayId.toUpperCase() === displayId);
  if (displayGate) return displayGate.entry.id;

  const alias = resolveReviewGateAlias(trimmed);
  const normalized = (alias ?? trimmed).toLowerCase();
  const gate = gates.find((candidate) => candidate.entry.id === normalized);
  if (!gate) {
    throw new Error(`${flagName} received unknown review gate or display id "${input}". Run "pipelane run review setup" to inspect stable ids, or "pipelane run review setup --list-gates" to inspect gate ids.`);
  }
  return gate.entry.id;
}

function requirePreparedGate(gates: ReviewSetupGateOption[], id: string): ReviewSetupGateOption {
  const gate = gates.find((candidate) => candidate.entry.id === id);
  if (!gate) {
    throw new Error(`Unknown review gate "${id}".`);
  }
  return gate;
}

function enablePreparedReviewGate(
  repoRoot: string,
  gates: ReviewSetupGateOption[],
  gate: ReviewSetupGateOption,
): string {
  if (
    (!gate.entry.available || ((gate.entry.type === 'skill' || gate.entry.type === 'agent') && gate.installState !== 'installed'))
    && hasReviewGateInstaller(gate.entry, repoRoot)
  ) {
    return installPreparedReviewGate(repoRoot, gates, gate);
  }

  if (!gate.entry.available) {
    const installHint = hasReviewGateInstaller(gate.entry, repoRoot)
      ? ` Run "pipelane run review setup --install ${gate.entry.id}" to install and enable it.`
      : '';
    throw new Error(`${gate.entry.id} cannot be enabled: ${gate.entry.missingReason ?? 'gate unavailable'}.${installHint}`);
  }

  if ((gate.entry.type === 'skill' || gate.entry.type === 'agent') && gate.installState !== 'installed') {
    throw new Error(`${gate.entry.id} needs an installed reviewer before it can be enabled. Run "pipelane run review setup --install ${gate.entry.id}" to install and enable it.`);
  }

  if (gate.entry.id === 'adversarial-review' && !gate.selected) {
    gate.adversarialProvider = preferredAdversarialReviewProvider(repoRoot);
  }
  gate.selected = true;
  return `Enabled ${gate.entry.id}.`;
}

function installPreparedReviewGate(
  repoRoot: string,
  gates: ReviewSetupGateOption[],
  gate: ReviewSetupGateOption,
): string {
  if (gate.entry.type === 'command' && gate.entry.available) {
    gate.installState = 'not applicable';
    gate.selected = true;
    return `${gate.entry.id} already has a package.json script${gate.entry.matchedScript ? ` (${gate.entry.matchedScript})` : ''}; enabled without install.`;
  }

  const installers = reviewGateInstallOptions(gate.entry, repoRoot);
  if (installers.length === 0) {
    throw new Error(`${gate.entry.id} has no automatic installer. ${gate.entry.missingReason ?? ''}`.trim());
  }

  const result = installers[0].install();
  if (!result.ok) {
    throw new Error(result.message);
  }

  if (gate.entry.type === 'command') {
    const refreshed = resolveReviewGateCatalog({ repoRoot }).find((entry) => entry.id === gate.entry.id);
    if (!refreshed?.available) {
      gate.selected = false;
      throw new Error(`${result.message} ${gate.entry.id} is still unavailable: ${refreshed?.missingReason ?? 'package.json script not detected'}`);
    }
    gate.entry = refreshed;
    gate.installState = 'not applicable';
  } else {
    gate.installState = 'installed';
  }

  if (gate.entry.id === 'adversarial-review') {
    gate.adversarialProvider = preferredAdversarialReviewProvider(repoRoot);
  }
  gate.selected = true;
  renumberPreparedGates(gates);
  return result.message;
}

function renumberPreparedGates(gates: ReviewSetupGateOption[]): void {
  assignReviewSetupDisplayIds(gates);
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
    ['karpathy-diff', 80],
    ['code-review-high', 90],
    ['gstack-review', 100],
    ['adversarial-review', 110],
    ['code-review-ultra', 120],
    ['browser-qa', 130],
    ['karpathy-audit', 140],
    ['high-stakes-human-approval', 150],
    ['human-merge-approval', 160],
    ['human-prod-deploy-approval', 170],
    ['human-rollback-approval', 180],
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
  if (entry.id === 'code-review-high') return installState === 'installed';
  if (entry.id === 'adversarial-review') return installState === 'installed';
  if (entry.id === 'code-review-ultra') return installState === 'installed';
  if (entry.id === 'high-stakes-human-approval') return true;
  if (entry.recommended !== true) return false;
  if (!entry.available) return false;
  if (entry.type === 'skill' || entry.type === 'agent') return installState === 'installed';
  return true;
}

function detectGateInstallState(repoRoot: string, entry: ResolvedReviewGateCatalogEntry): GateInstallState {
  if (entry.type === 'command') {
    if (entry.available) return 'not applicable';
    return reviewGateInstallOptions(entry, repoRoot).length > 0 ? 'not installed' : 'unavailable';
  }
  if (entry.type !== 'skill' && entry.type !== 'agent') return 'not applicable';
  if (entry.id === 'code-review-high') {
    return isCodeReviewHighAvailable() ? 'installed' : 'unavailable';
  }
  if (entry.id === 'code-review-ultra') {
    return isExecutableOnPath('claude') ? 'installed' : 'unavailable';
  }
  if (entry.id === 'adversarial-review') {
    return isAdversarialReviewInstalled(repoRoot)
      ? 'installed'
      : reviewGateInstallOptions(entry, repoRoot).length > 0
        ? 'not installed'
        : 'unavailable';
  }
  const names = knownInstallNamesForGate(entry);
  if (names.length === 0) return 'unavailable';
  if (names.some((name) => isSkillInstalled(repoRoot, name))) return 'installed';
  return hasReviewGateInstaller(entry, repoRoot) ? 'not installed' : 'unavailable';
}

function knownInstallNamesForGate(entry: ResolvedReviewGateCatalogEntry): string[] {
  if (entry.type === 'skill' && entry.skill) return [...new Set([entry.skill, entry.id])];
  return entry.role ? [entry.role, entry.id] : [entry.id];
}

function isSkillInstalled(repoRoot: string, name: string): boolean {
  const codexHome = codexHomePath();
  const claudeHome = claudeHomePath();
  const names = skillInstallNameVariants(name);
  const candidates = names.flatMap((candidateName) => [
    path.join(repoRoot, '.agents', 'skills', candidateName, 'SKILL.md'),
    path.join(codexHome, 'skills', candidateName, 'SKILL.md'),
    path.join(claudeHome, 'skills', candidateName, 'SKILL.md'),
    path.join(claudeHome, 'skills', 'gstack', candidateName.replace(/^gstack-/, ''), 'SKILL.md'),
    path.join(os.homedir(), '.gstack', 'repos', 'gstack', '.agents', 'skills', candidateName, 'SKILL.md'),
  ]);
  if (isClaudeKarpathyPluginCommandInstalled(claudeHome, name)) {
    return true;
  }
  return candidates.some((candidate) => existsSync(candidate));
}

function isCodeReviewHighAvailable(): boolean {
  const forced = process.env.PIPELANE_REVIEW_CODE_REVIEW_HIGH_PROBE_RESULT?.trim().toLowerCase();
  if (forced === 'pass' || forced === 'passed' || forced === 'true' || forced === '1') return true;
  if (forced === 'fail' || forced === 'failed' || forced === 'false' || forced === '0') return false;
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_REVIEW_GATE_USE_REAL_NATIVE !== '1') return false;
  const configuredCommand = firstEnvValue(process.env, [
    'PIPELANE_REVIEW_CODE_REVIEW_HIGH_COMMAND',
    'PIPELANE_REVIEW_GATE_CODE_REVIEW_HIGH_COMMAND',
  ])?.value;
  return Boolean(configuredCommand || isExecutableOnPath('claude'));
}

function buildClaudeReviewSetupStatus(): ClaudeReviewSetupStatus {
  const codexHome = codexHomePath();
  const configuredCommand = firstEnvValue(process.env, [
    'PIPELANE_REVIEW_CODE_REVIEW_HIGH_COMMAND',
    'PIPELANE_REVIEW_GATE_CODE_REVIEW_HIGH_COMMAND',
  ]);
  const forced = process.env.PIPELANE_REVIEW_CODE_REVIEW_HIGH_PROBE_RESULT?.trim().toLowerCase();
  const claudeCliPath = executablePathOnPath('claude');
  const codeReviewHighAvailable = isCodeReviewHighAvailable();
  const codeReviewHighSource = configuredCommand
    ? `${configuredCommand.key}`
    : forced
      ? `probe override ${forced}`
      : claudeCliPath
        ? `Claude Code CLI at ${claudeCliPath}`
        : 'no configured command or claude executable';

  return {
    claudeCliPath,
    codeReviewHighAvailable,
    codeReviewHighSource,
    codexBridgeInstalled: isCodexClaudeReviewBridgeInstalled(codexHome),
    codexBridgeTarget: path.join(codexHome, 'skills', CODEX_CLAUDE_REVIEW_SKILL_NAME),
    apiEnvKeys: ANTHROPIC_API_ENV_KEYS.filter((key) => Boolean(process.env[key]?.trim())),
  };
}

function skillInstallNameVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const variants = new Set([trimmed]);
  if (!trimmed.startsWith('gstack-')) {
    variants.add(`gstack-${trimmed}`);
  }
  return [...variants];
}

function isClaudeKarpathyPluginCommandInstalled(claudeHome: string, name: string): boolean {
  const command = name === 'karpathy-diff'
    ? 'diff.md'
    : name === 'karpathy-audit'
      ? 'audit.md'
      : '';
  if (!command) return false;

  const versionRoot = path.join(claudeHome, 'plugins', 'cache', 'karpathy-skills', 'karpathy');
  if (!existsSync(versionRoot)) return false;
  try {
    return readdirSync(versionRoot, { withFileTypes: true }).some((entry) =>
      entry.isDirectory()
      && existsSync(path.join(versionRoot, entry.name, 'commands', command))
    );
  } catch {
    return false;
  }
}

function isAdversarialReviewInstalled(repoRoot: string): boolean {
  return adversarialReviewProviders(repoRoot).some((provider) => provider.installed);
}

function preferredAdversarialReviewProvider(repoRoot: string): AdversarialReviewProvider | undefined {
  const providers = adversarialReviewProviders(repoRoot);
  return providers.find((provider) => provider.installed)
    ?? providers.find((provider) => provider.installable)
    ?? providers[0];
}

function adversarialReviewProviders(repoRoot: string): AdversarialReviewProvider[] {
  const codexHome = codexHomePath();
  const claudeHome = claudeHomePath();
  const codexClaudeTarget = path.join(codexHome, 'skills', CODEX_CLAUDE_REVIEW_SKILL_NAME);
  return [
    {
      id: 'codex-claude-review',
      label: 'Codex /claude review bridge',
      command: '/claude review code',
      installed: isCodexClaudeReviewBridgeInstalled(codexHome),
      installable: true,
      target: `${CODEX_CLAUDE_REVIEW_REPO} -> ${codexClaudeTarget}`,
    },
    {
      id: 'claude-side-gstack-codex-challenge',
      label: 'Claude-side gstack /codex challenge',
      command: '/codex challenge',
      installed: isClaudeGstackCodexChallengeInstalled(claudeHome),
      installable: false,
    },
  ];
}

function codexHomePath(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function claudeHomePath(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function isCodexClaudeReviewBridgeInstalled(codexHome: string): boolean {
  return isCodexClaudeReviewSkillRoot(path.join(codexHome, 'skills', CODEX_CLAUDE_REVIEW_SKILL_NAME));
}

function isCodexClaudeReviewSkillRoot(skillRoot: string): boolean {
  const requiredFiles = [
    'SKILL.md',
    path.join('scripts', 'run-review.sh'),
    path.join('scripts', 'build-review-artifact.sh'),
  ];
  if (!requiredFiles.every((relativePath) => existsSync(path.join(skillRoot, relativePath)))) {
    return false;
  }
  return isExecutableFile(path.join(skillRoot, 'scripts', 'run-review.sh'))
    && isExecutableFile(path.join(skillRoot, 'scripts', 'build-review-artifact.sh'));
}

function isClaudeGstackCodexChallengeInstalled(claudeHome: string): boolean {
  if (!isExecutableOnPath('codex')) return false;
  const candidates = [
    path.join(claudeHome, 'skills', 'gstack', 'codex', 'SKILL.md'),
    path.join(claudeHome, 'skills', 'gstack', 'ship', 'sections', 'adversarial.md'),
    ...globalGstackCodexReviewCandidates(),
  ];
  return candidates.some((candidate) => fileContainsAll(candidate, ['codex', 'adversarial']));
}

function globalGstackCodexReviewCandidates(): string[] {
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_REVIEW_SETUP_USE_REAL_HOME !== '1') {
    return [];
  }
  return [
    path.join(os.homedir(), '.gstack', 'repos', 'gstack', '.agents', 'skills', 'gstack-codex', 'SKILL.md'),
    path.join(os.homedir(), '.gstack', 'repos', 'gstack', '.agents', 'skills', 'gstack-ship', 'SKILL.md'),
  ];
}

function fileContainsAll(filePath: string, needles: string[]): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, 'utf8').toLowerCase();
    return needles.every((needle) => content.includes(needle.toLowerCase()));
  } catch {
    return false;
  }
}

function isExecutableOnPath(command: string): boolean {
  return executablePathOnPath(command) !== null;
}

function executablePathOnPath(command: string): string | null {
  const pathValue = process.env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function toggleInteractiveGate(
  gate: ReviewSetupGateOption,
  prompter: { question(prompt: string): Promise<string> },
  repoRoot: string,
): Promise<void> {
  if (gate.selected) {
    gate.adversarialProvider = undefined;
    gate.selected = false;
    return;
  }

  if (!gate.entry.available && gate.installState === 'unavailable') {
    process.stdout.write(`${gate.label} cannot be enabled: ${gate.entry.missingReason ?? 'gate unavailable'}.\n`);
    return;
  }

  if ((gate.entry.type === 'command' || gate.entry.type === 'skill' || gate.entry.type === 'agent') && gate.installState === 'unavailable') {
    process.stdout.write([
      `${gate.label} is unavailable.`,
      `Install ${reviewSetupInstallTarget(gate.entry)} outside Pipelane, then rerun review setup.`,
    ].join('\n') + '\n');
    gate.selected = false;
    return;
  }

  if ((gate.entry.type === 'command' || gate.entry.type === 'skill' || gate.entry.type === 'agent') && gate.installState !== 'installed' && gate.installState !== 'not applicable') {
    const installers = reviewGateInstallOptions(gate.entry, repoRoot);
    if (installers.length === 0) {
      process.stdout.write([
        `${gate.label} is unavailable.`,
        `Install ${reviewSetupInstallTarget(gate.entry)} outside Pipelane, then rerun review setup.`,
      ].join('\n') + '\n');
      gate.selected = false;
      return;
    }

    const selectedInstaller = installers.length === 1
      ? await chooseSingleReviewGateInstaller(gate, installers[0], prompter)
      : await chooseReviewGateInstaller(gate, installers, prompter);
    if (!selectedInstaller) {
      gate.selected = false;
      return;
    }

    const result = selectedInstaller.install();
    if (result.ok) {
      if (gate.entry.type === 'command') {
        const refreshed = resolveReviewGateCatalog({ repoRoot }).find((entry) => entry.id === gate.entry.id);
        if (!refreshed?.available) {
          gate.selected = false;
          process.stdout.write(`${result.message}\n${gate.label} remains disabled: ${refreshed?.missingReason ?? 'package.json script not detected'}.\n`);
          return;
        }
        gate.entry = refreshed;
        gate.installState = 'not applicable';
      } else {
        gate.installState = 'installed';
      }
      if (gate.entry.id === 'adversarial-review') {
        gate.adversarialProvider = preferredAdversarialReviewProvider(repoRoot);
      }
      gate.selected = true;
      process.stdout.write(`${result.message}\n`);
      return;
    }
    gate.selected = false;
    gate.adversarialProvider = undefined;
    process.stdout.write(`${result.message}\n${gate.label} remains disabled.\n`);
    return;
  }

  if (!gate.entry.available) {
    process.stdout.write(`${gate.label} cannot be enabled: ${gate.entry.missingReason ?? 'gate unavailable'}.\n`);
    return;
  }

  if (gate.entry.id === 'adversarial-review') {
    gate.adversarialProvider = preferredAdversarialReviewProvider(repoRoot);
  }
  gate.selected = true;
}

async function chooseSingleReviewGateInstaller(
  gate: ReviewSetupGateOption,
  installer: ReviewGateInstallOption,
  prompter: { question(prompt: string): Promise<string> },
): Promise<ReviewGateInstallOption | null> {
  process.stdout.write([
    `${gate.label} is ${gate.installState}.`,
    '',
    `Install ${installer.label} now?`,
    `Target: ${installer.target}`,
    '',
    '1. Install and enable',
    '2. Leave disabled',
  ].join('\n') + '\n');
  const installAnswer = (await prompter.question('> ')).trim();
  return installAnswer === '1' ? installer : null;
}

async function chooseReviewGateInstaller(
  gate: ReviewSetupGateOption,
  installers: ReviewGateInstallOption[],
  prompter: { question(prompt: string): Promise<string> },
): Promise<ReviewGateInstallOption | null> {
  process.stdout.write(`${gate.label} is ${gate.installState}.\n\nChoose an installer:\n`);
  installers.forEach((installer, index) => {
    process.stdout.write(`${index + 1}. ${installer.label} (${installer.target})\n`);
  });
  process.stdout.write(`${installers.length + 1}. Leave disabled\n`);
  const installAnswer = Number.parseInt((await prompter.question('> ')).trim(), 10);
  if (!Number.isSafeInteger(installAnswer) || installAnswer < 1 || installAnswer > installers.length) {
    return null;
  }
  return installers[installAnswer - 1];
}

function hasReviewGateInstaller(entry: ResolvedReviewGateCatalogEntry, repoRoot?: string): boolean {
  return reviewGateInstallOptions(entry, repoRoot).length > 0;
}

function reviewGateInstallOptions(entry: ResolvedReviewGateCatalogEntry, repoRoot?: string): ReviewGateInstallOption[] {
  const testInstaller = testReviewGateInstallOption(entry, repoRoot);
  if (testInstaller) return [testInstaller];

  const commandInstaller = commandReviewGateInstallOption(entry, repoRoot);
  if (commandInstaller) return [commandInstaller];

  if (entry.id === 'adversarial-review') {
    const codexHome = codexHomePath();
    return [
      {
        id: 'codex-claude-review',
        label: 'Codex /claude review bridge',
        target: `${CODEX_CLAUDE_REVIEW_REPO} -> ${path.join(codexHome, 'skills', CODEX_CLAUDE_REVIEW_SKILL_NAME)}`,
        install: () => installCodexClaudeReviewBridge(codexHome),
      },
    ];
  }

  if (isKarpathyReviewGate(entry)) {
    const codexHome = codexHomePath();
    const skillId = entry.skill ?? entry.id;
    return [
      {
        id: `karpathy-${skillId}`,
        label: `${skillId} skill`,
        target: `${KARPATHY_SKILLS_REPO} skills/${skillId} -> ${path.join(codexHome, 'skills', skillId)}`,
        install: () => installKarpathySkill(codexHome, skillId),
      },
    ];
  }

  return [];
}

function isKarpathyReviewGate(entry: ResolvedReviewGateCatalogEntry): boolean {
  return entry.id === 'karpathy-diff' || entry.id === 'karpathy-audit';
}

function testReviewGateInstallOption(entry: ResolvedReviewGateCatalogEntry, repoRoot?: string): ReviewGateInstallOption | null {
  if (process.env.NODE_ENV === 'test') {
    const allowed = configuredTestReviewGateInstallers();
    if (allowed.includes(entry.id) || entry.id === 'adversarial-review') {
      return {
        id: `test-${entry.id}`,
        label: reviewSetupInstallTarget(entry),
        target: reviewSetupInstallTarget(entry),
        install: () => allowed.includes(entry.id)
          ? installTestReviewGate(repoRoot, entry)
          : { ok: false, message: `No test installer succeeded for ${entry.id}.` },
      };
    }
  }
  return null;
}

function installTestReviewGate(repoRoot: string | undefined, entry: ResolvedReviewGateCatalogEntry): ReviewGateInstallResult {
  if (entry.type === 'command') {
    if (!repoRoot) return { ok: false, message: `No repo root available for ${entry.id} test install.` };
    const scriptName = entry.scriptNames?.[0] ?? entry.id;
    const command = defaultPackageScriptForCommandGate(entry.id, scriptName);
    const patched = patchPackageJsonScript(repoRoot, scriptName, command);
    return patched.ok
      ? { ok: true, message: `Installed ${entry.id}.` }
      : patched;
  }
  return { ok: true, message: `Installed ${entry.id}.` };
}

function commandReviewGateInstallOption(entry: ResolvedReviewGateCatalogEntry, repoRoot?: string): ReviewGateInstallOption | null {
  if (entry.type !== 'command') return null;
  if (!repoRoot) return null;
  if (!['lint', 'format-check', 'dependency-audit', 'secret-scan'].includes(entry.id)) return null;

  const scriptName = entry.scriptNames?.[0] ?? entry.id;
  return {
    id: `package-${entry.id}`,
    label: `${entry.id} package script`,
    target: path.join(repoRoot, 'package.json'),
    install: () => installCommandReviewGate(repoRoot, entry, scriptName),
  };
}

function installCommandReviewGate(
  repoRoot: string,
  entry: ResolvedReviewGateCatalogEntry,
  scriptName: string,
): ReviewGateInstallResult {
  if (entry.id === 'dependency-audit') {
    const packageManager = detectPackageManager(repoRoot);
    if (packageManager.id !== 'npm' && packageManager.id !== 'unknown') {
      return unsupportedPackageManagerScriptRecipe(packageManager, entry.id, scriptName);
    }
    if (!hasNpmAuditLockfile(repoRoot)) {
      return missingNpmAuditLockfileRecipe(entry.id, scriptName);
    }
    return patchPackageJsonScript(repoRoot, scriptName, defaultPackageScriptForCommandGate(entry.id, scriptName));
  }

  if (entry.id === 'secret-scan') {
    if (!isExecutableOnPath('gitleaks')) {
      const install = installNpmDevDependencies(repoRoot, [GITLEAKS_NPM_PACKAGE], entry.id, scriptName);
      if (!install.ok) return install;
    }
    return patchPackageJsonScript(repoRoot, scriptName, defaultPackageScriptForCommandGate(entry.id, scriptName));
  }

  if (entry.id === 'format-check') {
    const install = installNpmDevDependencies(repoRoot, ['prettier'], entry.id, scriptName);
    if (!install.ok) return install;
    return patchPackageJsonScript(repoRoot, scriptName, defaultPackageScriptForCommandGate(entry.id, scriptName));
  }

  if (entry.id === 'lint') {
    const devDeps = usesTypeScript(repoRoot)
      ? ['eslint', '@eslint/js', 'typescript-eslint', 'globals']
      : ['eslint', '@eslint/js', 'globals'];
    const installPreflight = preflightNpmDevDependencyInstall(repoRoot, devDeps, entry.id, scriptName);
    if (!installPreflight.ok) return installPreflight;
    const configSafety = defaultEslintConfigSafety(repoRoot);
    if (!configSafety.ok) return configSafety;
    const install = installNpmDevDependencies(repoRoot, devDeps, entry.id, scriptName);
    if (!install.ok) return install;
    const config = writeDefaultEslintConfig(repoRoot, usesTypeScript(repoRoot));
    if (!config.ok) return config;
    return patchPackageJsonScript(repoRoot, scriptName, defaultPackageScriptForCommandGate(entry.id, scriptName));
  }

  return { ok: false, message: `${entry.id} has no automatic installer.` };
}

function defaultPackageScriptForCommandGate(gateId: string, scriptName: string): string {
  if (gateId === 'lint') return 'eslint .';
  if (gateId === 'format-check') return 'prettier --check .';
  if (gateId === 'secret-scan') return 'gitleaks detect --source . --redact';
  if (gateId === 'dependency-audit') return 'npm audit';
  return `npm run ${scriptName}`;
}

function readPackageJsonObject(repoRoot: string): Record<string, unknown> | null {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function detectPackageManager(repoRoot: string): DetectedPackageManager {
  const packageJson = readPackageJsonObject(repoRoot);
  const declared = typeof packageJson?.packageManager === 'string'
    ? packageJson.packageManager.trim()
    : '';
  const foundLockfiles = detectPackageManagerLockfiles(repoRoot);
  const foundIds = [...new Set(foundLockfiles.map((candidate) => candidate.id))];
  if (declared) {
    const declaredId = parsePackageManagerId(declared);
    if (
      foundIds.length > 1
      || (declaredId !== 'unsupported' && foundIds.some((id) => id !== declaredId))
    ) {
      return {
        id: 'conflict',
        source: `packageManager "${declared}" conflicts with lockfiles: ${foundLockfiles.map((candidate) => candidate.file).join(', ')}`,
        packageManager: declared,
        conflicts: foundLockfiles.map((candidate) => candidate.file),
      };
    }
    return {
      id: declaredId,
      source: declaredId === 'unsupported'
        ? `unsupported packageManager "${declared}"`
        : `packageManager "${declared}"`,
      packageManager: declared,
    };
  }

  const found = foundLockfiles;
  const ids = foundIds;
  if (ids.length === 0) {
    return { id: 'unknown', source: 'no packageManager field or lockfile' };
  }
  if (ids.length === 1) {
    return { id: ids[0], source: `${found[0].file} lockfile`, lockfile: found[0].file };
  }
  return {
    id: 'conflict',
    source: `multiple package-manager lockfiles: ${found.map((candidate) => candidate.file).join(', ')}`,
    conflicts: found.map((candidate) => candidate.file),
  };
}

function detectPackageManagerLockfiles(repoRoot: string): Array<{ id: PackageManagerId; file: string }> {
  const lockfiles: Array<{ id: PackageManagerId; file: string }> = [
    { id: 'pnpm', file: 'pnpm-lock.yaml' },
    { id: 'yarn', file: 'yarn.lock' },
    { id: 'bun', file: 'bun.lockb' },
    { id: 'bun', file: 'bun.lock' },
    { id: 'npm', file: 'package-lock.json' },
    { id: 'npm', file: 'npm-shrinkwrap.json' },
  ];
  return lockfiles.filter((candidate) => existsSync(path.join(repoRoot, candidate.file)));
}

function parsePackageManagerId(value: string): PackageManagerId {
  const name = value.split('@')[0]?.trim().toLowerCase();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
  return 'unsupported';
}

function preflightNpmDevDependencyInstall(
  repoRoot: string,
  packages: string[],
  gateId: string,
  scriptName: string,
): ReviewGateInstallResult {
  if (!existsSync(path.join(repoRoot, 'package.json'))) {
    const installCommand = `npm install --save-dev --ignore-scripts ${packages.join(' ')}`;
    return {
      ok: false,
      message: `No package.json found; automatic ${gateId} install requires an existing npm project. Recipe: create package.json, run "${installCommand}", add package.json script "${scriptName}": "${defaultPackageScriptForCommandGate(gateId, scriptName)}", then rerun "review setup --enable ${gateId}".`,
    };
  }

  const packageManager = detectPackageManager(repoRoot);
  if (packageManager.id !== 'npm' && packageManager.id !== 'unknown') {
    return unsupportedPackageManagerInstallRecipe(packageManager, packages, gateId, scriptName);
  }

  const nodeModulesPath = path.join(repoRoot, 'node_modules');
  try {
    if (lstatSync(nodeModulesPath).isSymbolicLink()) {
      return {
        ok: false,
        message: 'node_modules is a symlink; refusing to run npm install through it. Remove the symlink or install dependencies in the real dependency root, then rerun review setup.',
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        message: 'Could not inspect node_modules safely; refusing to run npm install.',
      };
    }
  }

  if (!isExecutableOnPath('npm')) {
    return { ok: false, message: 'npm is not installed or not on PATH.' };
  }

  return { ok: true, message: 'npm install preflight passed.' };
}

function unsupportedPackageManagerInstallRecipe(
  packageManager: DetectedPackageManager,
  packages: string[],
  gateId: string,
  scriptName: string,
): ReviewGateInstallResult {
  const installCommand = packageManagerDependencyInstallCommand(packageManager.id, packages);
  const scriptCommand = defaultPackageScriptForCommandGate(gateId, scriptName);
  const recipe = installCommand
    ? `Recipe: run "${installCommand}", add package.json script "${scriptName}": "${scriptCommand}", then rerun "review setup --enable ${gateId}".`
    : `Recipe: install ${packages.join(', ')} with the correct package manager, add package.json script "${scriptName}": "${scriptCommand}", then rerun "review setup --enable ${gateId}".`;
  return {
    ok: false,
    message: `Detected ${packageManager.source}; automatic ${gateId} install currently supports npm projects only. ${recipe}`,
  };
}

function unsupportedPackageManagerScriptRecipe(
  packageManager: DetectedPackageManager,
  gateId: string,
  scriptName: string,
): ReviewGateInstallResult {
  const scriptCommand = packageManagerScriptCommand(packageManager.id, gateId) ?? defaultPackageScriptForCommandGate(gateId, scriptName);
  const managerNote = packageManager.id === 'yarn'
    ? ' For Yarn Classic, use "yarn audit" instead if that is your configured audit command.'
    : '';
  return {
    ok: false,
    message: `Detected ${packageManager.source}; automatic ${gateId} setup currently supports npm projects only. Recipe: add package.json script "${scriptName}": "${scriptCommand}", then rerun "review setup --enable ${gateId}".${managerNote}`,
  };
}

function packageManagerDependencyInstallCommand(id: PackageManagerId, packages: string[]): string | null {
  const packageList = packages.join(' ');
  if (id === 'pnpm') return `pnpm add -D ${packageList}`;
  if (id === 'yarn') return `yarn add -D ${packageList}`;
  if (id === 'bun') return `bun add -d ${packageList}`;
  return null;
}

function packageManagerScriptCommand(id: PackageManagerId, gateId: string): string | null {
  if (gateId !== 'dependency-audit') return null;
  if (id === 'pnpm') return 'pnpm audit';
  if (id === 'yarn') return 'yarn npm audit';
  if (id === 'bun') return 'bun audit';
  return null;
}

function hasNpmAuditLockfile(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, 'package-lock.json'))
    || existsSync(path.join(repoRoot, 'npm-shrinkwrap.json'));
}

function missingNpmAuditLockfileRecipe(gateId: string, scriptName: string): ReviewGateInstallResult {
  return {
    ok: false,
    message: `No npm lockfile found; automatic ${gateId} setup uses npm audit, which requires package-lock.json or npm-shrinkwrap.json. Recipe: run "npm install --package-lock-only", add package.json script "${scriptName}": "${defaultPackageScriptForCommandGate(gateId, scriptName)}", then rerun "review setup --enable ${gateId}".`,
  };
}

function patchPackageJsonScript(repoRoot: string, scriptName: string, command: string): ReviewGateInstallResult {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return { ok: false, message: `No package.json found at ${packageJsonPath}.` };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      message: `Could not parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const scripts = parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
    ? parsed.scripts as Record<string, unknown>
    : {};
  const existing = scripts[scriptName];
  if (typeof existing === 'string' && existing.trim().length > 0) {
    return { ok: true, message: `${scriptName} already exists in package.json.` };
  }

  parsed.scripts = {
    ...scripts,
    [scriptName]: command,
  };
  writeJsonFileAtomic(packageJsonPath, parsed);
  return { ok: true, message: `Added package.json script "${scriptName}": ${command}` };
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function installNpmDevDependencies(
  repoRoot: string,
  packages: string[],
  gateId: string,
  scriptName: string,
): ReviewGateInstallResult {
  const preflight = preflightNpmDevDependencyInstall(repoRoot, packages, gateId, scriptName);
  if (!preflight.ok) return preflight;

  const result = spawnSync('npm', ['install', '--save-dev', '--ignore-scripts', ...packages], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: reviewSetupNpmInstallTimeoutMs(),
  });
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  if (timedOut) {
    return {
      ok: false,
      message: `Could not install ${packages.join(', ')}: npm install timed out after ${reviewSetupNpmInstallTimeoutMs()}ms.`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: `Could not install ${packages.join(', ')}: ${tail(redactReviewOutput(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)) || `npm exited ${result.status}`}`,
    };
  }
  return { ok: true, message: `Installed ${packages.join(', ')}.` };
}

function reviewSetupNpmInstallTimeoutMs(): number {
  const raw = process.env.PIPELANE_REVIEW_SETUP_NPM_INSTALL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REVIEW_SETUP_NPM_INSTALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REVIEW_SETUP_NPM_INSTALL_TIMEOUT_MS;
}

function usesTypeScript(repoRoot: string): boolean {
  if (existsSync(path.join(repoRoot, 'tsconfig.json')) || existsSync(path.join(repoRoot, 'tsconfig.build.json'))) {
    return true;
  }
  return containsFileWithExtension(repoRoot, '.ts') || containsFileWithExtension(repoRoot, '.tsx');
}

function containsFileWithExtension(root: string, extension: string): boolean {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith(extension)) return true;
      if (entry.isDirectory() && containsFileWithExtension(fullPath, extension)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function defaultEslintConfigSafety(repoRoot: string): ReviewGateInstallResult {
  if (hasExistingFlatEslintConfig(repoRoot)) {
    return { ok: true, message: 'ESLint flat config already exists.' };
  }

  if (hasLegacyEslintConfig(repoRoot)) {
    return {
      ok: false,
      message: 'Could not safely use the existing legacy ESLint config with a generic ESLint 9 install. Recipe: add an ESLint flat config and package.json script "lint", or install the ESLint version your legacy config expects, then rerun "review setup --enable lint".',
    };
  }

  const blockers = defaultEslintConfigBlockers(repoRoot);
  if (blockers.length === 0) {
    return { ok: true, message: 'Default ESLint config can be created.' };
  }

  return {
    ok: false,
    message: `Could not safely create a generic ESLint config because this repo looks project-specific (${blockers.join(', ')}). Recipe: add a project-specific ESLint config and package.json script "lint", then rerun "review setup --enable lint".`,
  };
}

function hasExistingEslintConfig(repoRoot: string): boolean {
  return hasExistingFlatEslintConfig(repoRoot) || hasLegacyEslintConfig(repoRoot);
}

function hasExistingFlatEslintConfig(repoRoot: string): boolean {
  const configNames = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
  ];
  return configNames.some((name) => existsSync(path.join(repoRoot, name)));
}

function hasLegacyEslintConfig(repoRoot: string): boolean {
  const configNames = [
    '.eslintrc',
    '.eslintrc.json',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yaml',
    '.eslintrc.yml',
  ];
  if (configNames.some((name) => existsSync(path.join(repoRoot, name)))) {
    return true;
  }
  const packageJson = readPackageJsonObject(repoRoot);
  return Boolean(packageJson?.eslintConfig && typeof packageJson.eslintConfig === 'object');
}

function defaultEslintConfigBlockers(repoRoot: string): string[] {
  const blockers: string[] = [];
  const packageJson = readPackageJsonObject(repoRoot);
  if (packageJson?.workspaces) {
    blockers.push('package.json workspaces');
  }

  const markerFiles = [
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.ts',
    'vue.config.js',
    'svelte.config.js',
    'svelte.config.ts',
    'astro.config.js',
    'astro.config.mjs',
    'astro.config.ts',
    'nuxt.config.js',
    'nuxt.config.ts',
    'remix.config.js',
    'angular.json',
    'pnpm-workspace.yaml',
    'lerna.json',
    'turbo.json',
    'nx.json',
  ];
  for (const marker of markerFiles) {
    if (existsSync(path.join(repoRoot, marker))) blockers.push(marker);
  }

  for (const workspaceDir of ['apps', 'packages']) {
    try {
      if (statSync(path.join(repoRoot, workspaceDir)).isDirectory()) blockers.push(`${workspaceDir}/`);
    } catch {
      // Missing workspace marker directories are fine.
    }
  }

  const dependencyNames = packageDependencyNames(packageJson);
  const frameworkDeps = [
    '@angular/core',
    '@remix-run/react',
    'astro',
    'next',
    'nuxt',
    'react',
    'react-dom',
    'svelte',
    'vite',
    'vue',
  ];
  for (const dependency of frameworkDeps) {
    if (dependencyNames.has(dependency)) blockers.push(`dependency ${dependency}`);
  }

  return [...new Set(blockers)];
}

function packageDependencyNames(packageJson: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = packageJson?.[key];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const dependencyName of Object.keys(dependencies)) {
      names.add(dependencyName);
    }
  }
  return names;
}

function writeDefaultEslintConfig(repoRoot: string, includeTypeScript: boolean): ReviewGateInstallResult {
  if (hasExistingEslintConfig(repoRoot)) {
    return { ok: true, message: 'ESLint config already exists.' };
  }

  const configPath = path.join(repoRoot, 'eslint.config.mjs');
  const body = includeTypeScript
    ? `import js from '@eslint/js';\nimport globals from 'globals';\nimport tseslint from 'typescript-eslint';\n\nexport default [\n  { ignores: ['dist/**', 'build/**', 'coverage/**', 'node_modules/**'] },\n  js.configs.recommended,\n  ...tseslint.configs.recommended,\n  {\n    languageOptions: {\n      globals: {\n        ...globals.browser,\n        ...globals.node,\n      },\n    },\n  },\n];\n`
    : `import js from '@eslint/js';\nimport globals from 'globals';\n\nexport default [\n  { ignores: ['dist/**', 'build/**', 'coverage/**', 'node_modules/**'] },\n  js.configs.recommended,\n  {\n    languageOptions: {\n      globals: {\n        ...globals.browser,\n        ...globals.node,\n      },\n    },\n  },\n];\n`;
  writeFileSync(configPath, body, 'utf8');
  return { ok: true, message: `Created ${path.relative(repoRoot, configPath)}.` };
}

function installCodexClaudeReviewBridge(codexHome: string): ReviewGateInstallResult {
  const skillRoot = path.join(codexHome, 'skills', CODEX_CLAUDE_REVIEW_SKILL_NAME);
  if (isCodexClaudeReviewSkillRoot(skillRoot)) {
    return { ok: true, message: 'Codex /claude review bridge is already installed.' };
  }

  if (existsSync(skillRoot)) {
    ensureSkillScriptsExecutable(skillRoot);
    if (isCodexClaudeReviewSkillRoot(skillRoot)) {
      return { ok: true, message: 'Codex /claude review bridge scripts were repaired.' };
    }
    return {
      ok: false,
      message: `${skillRoot} exists but is not a working /claude review skill. Move it aside or repair SKILL.md and scripts/*.sh, then rerun review setup.`,
    };
  }

  mkdirSync(path.dirname(skillRoot), { recursive: true });
  const localSource = findLocalCodexClaudeReviewSource();
  if (localSource) {
    try {
      symlinkSync(localSource, skillRoot, 'dir');
      ensureSkillScriptsExecutable(skillRoot);
    } catch (error) {
      return {
        ok: false,
        message: `Could not link ${localSource} to ${skillRoot}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return isCodexClaudeReviewSkillRoot(skillRoot)
      ? { ok: true, message: `Installed Codex /claude review bridge from ${localSource}. Restart Codex if /claude is not visible yet.` }
      : { ok: false, message: `Linked ${localSource}, but ${skillRoot} is still missing executable review scripts.` };
  }

  const clone = spawnSync('git', ['clone', CODEX_CLAUDE_REVIEW_REPO, skillRoot], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (clone.status !== 0) {
    return {
      ok: false,
      message: `Could not clone ${CODEX_CLAUDE_REVIEW_REPO}: ${tail(redactReviewOutput(`${clone.stderr ?? ''}\n${clone.stdout ?? ''}`)) || `git exited ${clone.status}`}`,
    };
  }

  ensureSkillScriptsExecutable(skillRoot);
  return isCodexClaudeReviewSkillRoot(skillRoot)
    ? { ok: true, message: `Installed Codex /claude review bridge at ${skillRoot}. Restart Codex if /claude is not visible yet.` }
    : { ok: false, message: `Cloned ${CODEX_CLAUDE_REVIEW_REPO}, but ${skillRoot} is missing executable review scripts.` };
}

function installKarpathySkill(codexHome: string, skillId: string): ReviewGateInstallResult {
  const skillRoot = path.join(codexHome, 'skills', skillId);
  if (isNamedSkillRoot(skillRoot, skillId)) {
    return { ok: true, message: `${skillId} is already installed.` };
  }

  if (existsSync(skillRoot)) {
    return {
      ok: false,
      message: `${skillRoot} exists but is not a working ${skillId} skill. Move it aside or repair SKILL.md, then rerun review setup.`,
    };
  }

  mkdirSync(path.dirname(skillRoot), { recursive: true });
  const localSource = findLocalKarpathySkillSource(skillId);
  if (localSource) {
    return copyKarpathySkill(localSource, skillRoot, skillId, `Installed ${skillId} from ${localSource}. Restart Codex if /karpathy is not visible yet.`);
  }

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-karpathy-skills-'));
  try {
    const repoRoot = path.join(tmpRoot, 'repo');
    const clone = spawnSync('git', ['clone', '--depth', '1', KARPATHY_SKILLS_REPO, repoRoot], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (clone.status !== 0) {
      return {
        ok: false,
        message: `Could not clone ${KARPATHY_SKILLS_REPO}: ${tail(redactReviewOutput(`${clone.stderr ?? ''}\n${clone.stdout ?? ''}`)) || `git exited ${clone.status}`}`,
      };
    }
    return copyKarpathySkill(
      path.join(repoRoot, 'skills', skillId),
      skillRoot,
      skillId,
      `Installed ${skillId} from ${KARPATHY_SKILLS_REPO}. Restart Codex if /karpathy is not visible yet.`,
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function copyKarpathySkill(sourceRoot: string, skillRoot: string, skillId: string, successMessage: string): ReviewGateInstallResult {
  if (!isNamedSkillRoot(sourceRoot, skillId)) {
    return { ok: false, message: `${sourceRoot} is not a working ${skillId} skill source.` };
  }
  try {
    cpSync(sourceRoot, skillRoot, { recursive: true });
  } catch (error) {
    rmSync(skillRoot, { recursive: true, force: true });
    return {
      ok: false,
      message: `Could not install ${skillId} to ${skillRoot}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isNamedSkillRoot(skillRoot, skillId)) {
    rmSync(skillRoot, { recursive: true, force: true });
    return { ok: false, message: `Installed ${skillId}, but ${skillRoot} is missing a valid SKILL.md.` };
  }
  return { ok: true, message: successMessage };
}

function findLocalKarpathySkillSource(skillId: string): string | null {
  const explicitSource = process.env.PIPELANE_KARPATHY_SKILLS_SOURCE;
  const candidates = [
    ...karpathySkillSourceCandidates(explicitSource, skillId),
    path.join(os.homedir(), 'dev', 'karpathy-skills', 'skills', skillId),
    path.join(os.homedir(), '.codex', 'skills', skillId),
    ...claudeKarpathyPluginSkillCandidates(claudeHomePath(), skillId),
  ];
  return candidates.find((candidate) => isNamedSkillRoot(candidate, skillId)) ?? null;
}

function karpathySkillSourceCandidates(root: string | undefined, skillId: string): string[] {
  if (!root || root.trim().length === 0) return [];
  const normalized = root.trim();
  return [
    normalized,
    path.join(normalized, 'skills', skillId),
    path.join(normalized, skillId),
  ];
}

function claudeKarpathyPluginSkillCandidates(claudeHome: string, skillId: string): string[] {
  const versionRoot = path.join(claudeHome, 'plugins', 'cache', 'karpathy-skills', 'karpathy');
  if (!existsSync(versionRoot)) return [];
  try {
    return readdirSync(versionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(versionRoot, entry.name, 'skills', skillId));
  } catch {
    return [];
  }
}

function isNamedSkillRoot(skillRoot: string, skillId: string): boolean {
  const skillFile = path.join(skillRoot, 'SKILL.md');
  return existsSync(skillFile) && fileContainsAll(skillFile, [`name: ${skillId}`]);
}

function findLocalCodexClaudeReviewSource(): string | null {
  const candidates = [
    process.env.PIPELANE_CODEX_CLAUDE_REVIEW_SOURCE,
    path.join(os.homedir(), 'dev', 'codexskill-claude-review'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  return candidates.find((candidate) => isCodexClaudeReviewSourceRoot(candidate)) ?? null;
}

function isCodexClaudeReviewSourceRoot(sourceRoot: string): boolean {
  return existsSync(path.join(sourceRoot, 'SKILL.md'))
    && existsSync(path.join(sourceRoot, 'scripts', 'run-review.sh'))
    && existsSync(path.join(sourceRoot, 'scripts', 'build-review-artifact.sh'));
}

function ensureSkillScriptsExecutable(skillRoot: string): void {
  const scriptsDir = path.join(skillRoot, 'scripts');
  if (!existsSync(scriptsDir)) return;
  try {
    for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
      chmodSync(path.join(scriptsDir, entry.name), 0o755);
    }
  } catch {
    // Installation verification below reports the user-visible failure.
  }
}

function configuredTestReviewGateInstallers(): string[] {
  return (process.env.PIPELANE_REVIEW_SETUP_INSTALL_SUCCESS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function reviewSetupInstallTarget(entry: ResolvedReviewGateCatalogEntry): string {
  if (entry.id === 'adversarial-review') return 'Codex /claude review bridge or Claude-side gstack /codex challenge';
  if (entry.type === 'agent') return entry.role ?? entry.id;
  return entry.skill ?? entry.id;
}

function saveInteractiveReviewSetup(
  repoRoot: string,
  gates: ReviewSetupGateOption[],
  options: ReviewSetupSaveOptions = {},
): { configPath: string; isLegacy: boolean } {
  const selectedGates = gates
    .filter((gate) => gate.selected && gate.entry.available)
    .map((gate) => reviewSetupGateToConfig(gate));
  const gatesToSave = orderReviewGates(options.preserveExistingReviewGates
    ? mergeReviewSetupGates(selectedGates, options)
    : selectedGates);
  return patchReadableWorkflowConfig(repoRoot, (raw) => ({
    ...raw,
    reviewGates: buildReviewGatesExplicitPatch(raw, gatesToSave),
  }));
}

function mergeReviewSetupGates(
  selectedGates: ReviewGateConfig[],
  options: ReviewSetupSaveOptions,
): ReviewGateConfig[] {
  const selectedById = new Map(selectedGates.map((gate) => [gate.id, gate]));
  const changedGateIds = options.changedGateIds ?? new Set<string>();
  const disabledGateIds = options.disabledGateIds ?? new Set<string>();
  const nextById = new Map<string, ReviewGateConfig>();

  if (options.useSelectedDefaults) {
    for (const gate of selectedGates) {
      if (!disabledGateIds.has(gate.id)) nextById.set(gate.id, gate);
    }
    for (const gate of options.existingReviewGates ?? []) {
      if (!selectedById.has(gate.id) && !disabledGateIds.has(gate.id)) {
        nextById.set(gate.id, gate);
      }
    }
    return [...nextById.values()];
  }

  for (const gate of options.existingReviewGates ?? []) {
    if (!disabledGateIds.has(gate.id)) nextById.set(gate.id, gate);
  }
  for (const id of changedGateIds) {
    const selected = selectedById.get(id);
    if (selected && !disabledGateIds.has(id)) nextById.set(id, selected);
  }
  return [...nextById.values()];
}

function buildReviewGatesExplicitPatch(
  raw: Record<string, unknown>,
  gates: ReviewGateConfig[],
): Record<string, unknown> {
  const existing = asRecord(raw.reviewGates);
  const next: Record<string, unknown> = {};
  const planReview = asRecord(existing?.planReview);
  if (planReview) {
    next.planReview = planReview;
  }
  next.policyVersion = REVIEW_GATES_POLICY_VERSION;
  next.gates = gates;
  return next;
}

function reviewSetupGateToConfig(gate: ReviewSetupGateOption): ReviewGateConfig {
  const entry = gate.entry;
  const userCommands = entry.id === 'adversarial-review' && gate.adversarialProvider
    ? [gate.adversarialProvider.command]
    : entry.userCommands;
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
    userCommands,
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
  const phaseFilter = parsed.flags.reviewPhase.trim() as ReviewGatePhase | '';
  const gateFilter = parsed.flags.reviewGate.trim();
  const dryRun = parsed.flags.reviewDryRun;
  const activeSurfaces = context.modeState.requestedSurfaces ?? context.config.surfaces;
  const startSafety = guardReviewRunStartForRouteSafety(cwd, parsed);
  if (startSafety.action === 'stop') {
    printResult(parsed.flags, {
      command: 'review',
      status: 'pending',
      runId: null,
      repoRoot: context.repoRoot,
      evidencePath: reviewStatePath(context.commonDir, context.config),
      dryRun,
      gateFilter: gateFilter || null,
      phaseFilter: phaseFilter || null,
      changedFiles: [],
      gates: [],
      message: startSafety.message,
    });
    process.exitCode = 1;
    return;
  }

  const record = buildReviewRunRecord({
    repoRoot: context.repoRoot,
    baseBranch: context.config.baseBranch,
    gates: context.config.reviewGates?.gates ?? [],
    dryRun,
    gateFilter,
    phaseFilter,
    activeSurfaces,
    reviewConfigChangeApproval: selectReviewConfigChangeApproval(context.commonDir, context.config, context.repoRoot),
  });

  appendReviewRunRecord(context.commonDir, context.config, record);
  const routeSafety = recordReviewRunForRouteSafety(cwd, parsed, record);

  const report = {
    command: 'review',
    status: record.status,
    runId: record.id,
    repoRoot: context.repoRoot,
    evidencePath: reviewStatePath(context.commonDir, context.config),
    dryRun,
    gateFilter: gateFilter || null,
    phaseFilter: phaseFilter || null,
    changedFiles: record.changedFiles,
    gates: record.gates,
    message: [
      renderReviewRunReport(record, reviewStatePath(context.commonDir, context.config)),
      routeSafety.action === 'stop' ? routeSafety.message : '',
    ].filter(Boolean).join('\n\n'),
  };

  printResult(parsed.flags, report);

  if (record.status === 'failed' || routeSafety.action === 'stop') {
    process.exitCode = 1;
  }
}

export function buildReviewRunRecord(options: BuildReviewRunRecordOptions): ReviewRunRecord {
  const phaseFilter = options.phaseFilter ?? '';
  const gateFilter = options.gateFilter?.trim() ?? '';
  const changedFiles = collectChangedFiles(options.repoRoot, options.baseBranch);
  const worktreeStatus = readWorktreeStatusSnapshot(options.repoRoot, { includeStatusDigest: true });
  const reviewConfigChanged = changedFiles.some(isReviewConfigPath);
  const reviewConfigChangeApproval = reviewConfigChanged ? options.reviewConfigChangeApproval ?? null : null;
  const reviewConfigChangeNeedsApproval = reviewConfigChanged && !reviewConfigChangeApproval;
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
  // B4 (programmatic-before-judge): evaluate ALL deterministic (command/pipelane)
  // gates before any AI judge (skill/agent), independent of phase authoring order —
  // gate type is not bound to phase, so a blocking command gate authored in a phase
  // that sorts after ai-diff must still gate the judges. If a blocking deterministic
  // gate fails, defer the expensive AI judge gates to `pending` instead of invoking
  // them. The review fails on the deterministic gate regardless, so this saves
  // tokens and fails closed (`pending`, never `skipped`). Records are assembled back
  // in the original gate order, so reordering only affects the deferral decision —
  // not the persisted/displayed gate order (e.g. a prepended config-change gate).
  const recordByGate = new Map<ReviewGateConfig, ReviewGateRunRecord>();
  const evaluateGate = (gate: ReviewGateConfig, deferAiGate: boolean): ReviewGateRunRecord => {
    options.onGateStart?.(gate);
    const record = gate.id === REVIEW_CONFIG_CHANGE_GATE_ID && reviewConfigChangeApproval
      ? approvedReviewConfigChangeGateRecord(gate, reviewConfigChangeApproval)
      : runReviewGate({
          gate,
          repoRoot: options.repoRoot,
          baseBranch: options.baseBranch,
          dryRun: options.dryRun,
          reviewConfigChanged: reviewConfigChangeNeedsApproval,
          changedFiles,
          activeSurfaces: options.activeSurfaces,
          deferAiGate,
        });
    options.onGateFinish?.(record);
    recordByGate.set(gate, record);
    return record;
  };
  let blockingDeterministicFailure = false;
  for (const gate of selectedGates) {
    if (!isDeterministicReviewGate(gate)) continue;
    const record = evaluateGate(gate, false);
    if (record.blocking && record.status === 'failed') blockingDeterministicFailure = true;
  }
  for (const gate of selectedGates) {
    if (isDeterministicReviewGate(gate)) continue;
    evaluateGate(gate, blockingDeterministicFailure);
  }
  const gateRecords = selectedGates.map((gate) => recordByGate.get(gate) as ReviewGateRunRecord);
  const finishedAt = nowIso();
  const status = summarizeRunStatus(gateRecords);

  return {
    id: `review-${new Date(startedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
    branchName: runGit(options.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '',
    sha: worktreeStatus.head,
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
    authorIdentity: resolveReviewAuthorIdentity(),
    reviewer: resolveReviewActorIdentity(),
    gates: gateRecords,
  };
}

// B4: deterministic gates execute programmatically (pass/fail) with no AI judge —
// these run before and gate the expensive skill/agent judges.
function isDeterministicReviewGate(gate: Pick<ReviewGateConfig, 'type'>): boolean {
  return gate.type === 'command' || gate.type === 'pipelane';
}

function orderReviewGates(gates: ReviewGateConfig[]): ReviewGateConfig[] {
  return [...gates].sort((left, right) => {
    const phaseDelta = REVIEW_PHASE_ORDER.indexOf(left.phase) - REVIEW_PHASE_ORDER.indexOf(right.phase);
    return phaseDelta !== 0 ? phaseDelta : left.id.localeCompare(right.id);
  });
}

// C2: review gates execute worker-influenced code (the slice's own `npm test`,
// build scripts, AI-reviewer commands) in a subprocess. They must NEVER inherit a
// pipelane state-signing key — a malicious gate command could otherwise read
// a state-signing key and forge signed evidence, defeating the signature
// guarantees whose trust boundary is "worker-influenced code does not hold keys". The
// orchestrator PARENT keeps the key (for signing + attestation via
// appendReviewRunRecord); only the gate child is scrubbed.
function gateSubprocessEnv(options: { stripAiReviewOverrides?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[REVIEW_STATE_KEY_ENV];
  delete env[ORCHESTRATION_STATE_KEY_ENV];
  delete env[DEPLOY_STATE_KEY_ENV];
  delete env[PROBE_STATE_KEY_ENV];
  if (options.stripAiReviewOverrides) {
    stripAiReviewOverrideEnv(env);
  }
  return env;
}

function stripAiReviewOverrideEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (
      key === 'PIPELANE_REVIEW_AI_COMMAND'
      || key === 'PIPELANE_REVIEW_GATE_COMMAND'
      || key === 'PIPELANE_REVIEW_PROVIDER'
      || key === 'PIPELANE_REVIEW_GATE_PROVIDER'
      || /^PIPELANE_REVIEW_(?:GATE_)?[A-Z0-9_]+_(?:COMMAND|PROVIDER)$/.test(key)
    ) {
      delete env[key];
    }
  }
}

function spawnReviewGateCommand(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    env: NodeJS.ProcessEnv;
    input?: string;
  },
): {
  result: { status: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException };
  stdout: string;
  stderr: string;
  aiReviewGateResult: 'passed' | 'failed' | null;
} {
  const payload = JSON.stringify({
    command,
    cwd: options.cwd,
    input: options.input ?? '',
    timeout: options.timeout,
    tailBytes: REVIEW_GATE_CAPTURE_TAIL_BYTES,
    maxOutputBytes: REVIEW_GATE_MAX_OUTPUT_BYTES,
    resultMarker: REVIEW_GATE_RESULT_MARKER,
  });
  const helper = spawnSync(process.execPath, ['-e', REVIEW_GATE_CAPTURE_HELPER], {
    cwd: options.cwd,
    encoding: 'utf8',
    input: payload,
    timeout: options.timeout + 5000,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: REVIEW_GATE_CAPTURE_HELPER_MAX_BUFFER_BYTES,
  });
  if (helper.error) {
    return {
      result: {
        status: null,
        signal: null,
        error: makeSpawnError((helper.error as NodeJS.ErrnoException).code ?? 'EHELPER', helper.error.message),
      },
      stdout: helper.stdout ?? '',
      stderr: helper.stderr ?? '',
      aiReviewGateResult: null,
    };
  }
  try {
    const parsed = JSON.parse(helper.stdout || '{}') as {
      status?: number | null;
      signal?: NodeJS.Signals | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      stdout?: string;
      stderr?: string;
      aiReviewGateResult?: 'passed' | 'failed' | null;
    };
    const error = parsed.errorCode
      ? makeSpawnError(parsed.errorCode, parsed.errorMessage ?? parsed.errorCode)
      : undefined;
    return {
      result: {
        status: typeof parsed.status === 'number' ? parsed.status : null,
        signal: parsed.signal ?? null,
        ...(error ? { error } : {}),
      },
      stdout: parsed.stdout ?? '',
      stderr: parsed.stderr ?? '',
      aiReviewGateResult: parsed.aiReviewGateResult ?? null,
    };
  } catch (error) {
    return {
      result: {
        status: null,
        signal: null,
        error: makeSpawnError('EHELPER', `review gate capture helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`),
      },
      stdout: helper.stdout ?? '',
      stderr: helper.stderr ?? '',
      aiReviewGateResult: null,
    };
  }
}

function makeSpawnError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

const REVIEW_GATE_CAPTURE_HELPER = String.raw`
const { spawn } = require('node:child_process');

let payloadText = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  payloadText += chunk;
});
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(payloadText || '{}');
  } catch (error) {
    emit({
      status: null,
      signal: null,
      errorCode: 'EHELPER',
      errorMessage: 'invalid capture helper payload: ' + (error && error.message ? error.message : String(error)),
      stdout: '',
      stderr: '',
      aiReviewGateResult: null,
    });
    return;
  }

  const tailBytes = Math.max(1, Number(payload.tailBytes) || 2097152);
  const maxOutputBytes = Math.max(tailBytes, Number(payload.maxOutputBytes) || 16777216);
  const timeout = Math.max(1, Number(payload.timeout) || 1);
  const resultMarker = String(payload.resultMarker || 'PIPELANE_REVIEW_GATE_RESULT');
  const markerRegex = new RegExp('(?:^|\\n)\\s*' + escapeRegExp(resultMarker) + '\\s*[:=]\\s*(passed|failed)\\b', 'gi');

  const stdout = makeTailBuffer();
  const stderr = makeTailBuffer();
  let stdoutScanCarry = '';
  let stderrScanCarry = '';
  let aiReviewGateResult = null;
  let outputBytes = 0;
  let outputLimited = false;
  let timedOut = false;
  let childError = null;
  let finished = false;

  const child = spawn(String(payload.command || ''), {
    cwd: String(payload.cwd || process.cwd()),
    shell: true,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const killHard = () => {
    try {
      child.kill('SIGKILL');
    } catch {}
  };
  const terminate = () => {
    try {
      child.kill('SIGTERM');
    } catch {}
    setTimeout(killHard, 1000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeout);
  timer.unref();

  child.on('error', (error) => {
    childError = {
      code: error && error.code ? String(error.code) : 'ECHILD',
      message: error && error.message ? error.message : String(error),
    };
    finish(null, null);
  });

  child.stdout.on('data', (chunk) => {
    appendTail(stdout, chunk);
    stdoutScanCarry = observe(stdoutScanCarry, chunk);
  });
  child.stderr.on('data', (chunk) => {
    appendTail(stderr, chunk);
    stderrScanCarry = observe(stderrScanCarry, chunk);
  });

  child.on('close', (status, signal) => {
    finish(status, signal);
  });

  if (payload.input) {
    child.stdin.end(String(payload.input));
  } else {
    child.stdin.end();
  }

  function makeTailBuffer() {
    return { chunks: [], bytes: 0 };
  }

  function appendTail(tail, chunk) {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes && !outputLimited) {
      outputLimited = true;
      terminate();
    }
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (source.length >= tailBytes) {
      tail.chunks = [Buffer.from(source.subarray(source.length - tailBytes))];
      tail.bytes = tailBytes;
      return;
    }
    tail.chunks.push(Buffer.from(source));
    tail.bytes += source.length;
    while (tail.bytes > tailBytes && tail.chunks.length > 0) {
      const excess = tail.bytes - tailBytes;
      const first = tail.chunks[0];
      if (first.length <= excess) {
        tail.chunks.shift();
        tail.bytes -= first.length;
      } else {
        tail.chunks[0] = Buffer.from(first.subarray(excess));
        tail.bytes -= excess;
      }
    }
  }

  function observe(carry, chunk) {
    const text = carry + chunk.toString('utf8');
    markerRegex.lastIndex = 0;
    let match;
    while ((match = markerRegex.exec(text)) !== null) {
      aiReviewGateResult = String(match[1]).toLowerCase() === 'passed' ? 'passed' : 'failed';
    }
    return text.slice(-4096);
  }

  function finish(status, signal) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    let errorCode = null;
    let errorMessage = null;
    if (childError) {
      errorCode = childError.code;
      errorMessage = childError.message;
    } else if (outputLimited) {
      errorCode = 'EOUTPUTLIMIT';
      errorMessage = 'review gate output exceeded ' + maxOutputBytes + ' bytes';
    } else if (timedOut) {
      errorCode = 'ETIMEDOUT';
      errorMessage = 'review gate timed out after ' + timeout + 'ms';
    }
    emit({
      status: typeof status === 'number' ? status : null,
      signal: signal || null,
      errorCode,
      errorMessage,
      stdout: tailBufferToString(stdout),
      stderr: tailBufferToString(stderr),
      aiReviewGateResult,
    });
  }
});

function tailBufferToString(tail) {
  return Buffer.concat(tail.chunks, tail.bytes).toString('utf8');
}

function emit(record) {
  process.stdout.write(JSON.stringify(record));
}

function escapeRegExp(value) {
  return String(value)
    .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace(/[{}]/g, '\\$&');
}
`;

function runReviewGate(options: {
  gate: ReviewGateConfig;
  repoRoot: string;
  baseBranch: string;
  dryRun: boolean;
  reviewConfigChanged: boolean;
  changedFiles: string[];
  activeSurfaces: string[];
  // B4: when a blocking deterministic gate has already failed this run, defer the
  // expensive AI judge to `pending` instead of invoking it.
  deferAiGate?: boolean;
}): ReviewGateRunRecord {
  const { gate, repoRoot, baseBranch, dryRun, reviewConfigChanged, changedFiles, activeSurfaces } = options;
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
    userCommands: gate.userCommands,
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

  if (gate.type === 'skill' || gate.type === 'agent') {
    if (options.deferAiGate) {
      // B4 (programmatic-before-judge): a blocking deterministic gate already
      // failed, so the review fails regardless — defer the judge to `pending`
      // (not `skipped`, which can pass) without spending tokens on it.
      return finishGate(base, startMs, {
        status: 'pending',
        summary: `deferred: a blocking deterministic gate failed; ${gate.type} judge ${gate.id} not invoked until programmatic gates pass`,
      });
    }
    return runAiReviewGate({
      base,
      startMs,
      gate,
      repoRoot,
      baseBranch,
      dryRun,
      reviewConfigChanged,
      changedFiles,
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
      skipReason: REVIEW_CONFIG_CHANGE_WHEN,
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
  const beforeStatus = readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
  const { result, stdout, stderr } = spawnReviewGateCommand(gate.command, {
    cwd: repoRoot,
    timeout: timeoutMs,
    env: gateSubprocessEnv({ stripAiReviewOverrides: true }),
  });
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const outputLimited = result.error && (result.error as NodeJS.ErrnoException).code === 'EOUTPUTLIMIT';
  const ok = exitCode === 0 && !timedOut && !result.error;
  const afterStatus = readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
  const checkoutMutationSummary = reviewGateCheckoutMutationSummary('Review command gate', beforeStatus, afterStatus);
  const errorSummary = result.error && !timedOut
    ? outputLimited
      ? `command exceeded output limit ${REVIEW_GATE_MAX_OUTPUT_BYTES} bytes`
      : `command failed to start: ${result.error.message}`
    : timedOut
      ? `command timed out after ${timeoutMs}ms`
      : `command exited ${exitCode}`;

  return finishGate(base, startMs, {
    status: ok && !checkoutMutationSummary ? 'passed' : 'failed',
    summary: ok && !checkoutMutationSummary
      ? `command passed: ${gate.command}`
      : checkoutMutationSummary ?? errorSummary,
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
  dryRun: boolean;
  reviewConfigChanged: boolean;
  changedFiles: string[];
}): ReviewGateRunRecord {
  const { base, startMs, gate, repoRoot, baseBranch, dryRun, reviewConfigChanged, changedFiles } = options;
  const resolved = resolveAiReviewGateCommand(gate);
  if (!resolved) {
    return finishGate(base, startMs, {
      status: 'pending',
      summary: manualGateSummary(gate),
    });
  }

  const command = resolved.command;
  if (reviewConfigChanged) {
    return finishGate({ ...base, command }, startMs, {
      status: 'skipped',
      summary: `skipped: review config inputs changed; ${gate.type} gates require trusted approval before execution`,
      skipReason: REVIEW_CONFIG_CHANGE_WHEN,
    });
  }

  if (dryRun) {
    return finishGate({ ...base, command }, startMs, {
      status: 'skipped',
      summary: `dry-run: would run AI review command ${command}`,
      skipReason: 'dry-run',
    });
  }

  const timeoutMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const sessionId = `review-gate:${gate.id}:${crypto.randomUUID()}`;
  const env = buildAiReviewGateEnv(resolved.provider, sessionId, gate);
  const prompt = renderAiReviewGatePrompt({
    gate,
    repoRoot,
    baseBranch,
    changedFiles,
  });
  const beforeStatus = readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
  const { result, stdout, stderr, aiReviewGateResult } = spawnReviewGateCommand(command, {
    cwd: repoRoot,
    input: prompt,
    timeout: timeoutMs,
    env,
  });
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const declared = aiReviewGateResult;
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const outputLimited = result.error && (result.error as NodeJS.ErrnoException).code === 'EOUTPUTLIMIT';
  const attester = resolveReviewActorIdentity({ provider: resolved.provider, env });
  const redactedStdout = tail(redactReviewOutput(stdout));
  const redactedStderr = tail(redactReviewOutput(stderr));
  const afterStatus = readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
  const worktreeMutationSummary = reviewGateCheckoutMutationSummary('AI review command', beforeStatus, afterStatus);

  if (result.error && !timedOut) {
    return finishGate({ ...base, command }, startMs, {
      status: 'failed',
      summary: outputLimited
        ? `AI review command exceeded output limit ${REVIEW_GATE_MAX_OUTPUT_BYTES} bytes`
        : `AI review command failed to start: ${result.error.message}`,
      exitCode,
      attester,
      stdoutTail: redactedStdout,
      stderrTail: redactedStderr,
    });
  }

  if (timedOut) {
    return finishGate({ ...base, command }, startMs, {
      status: 'failed',
      summary: `AI review command timed out after ${timeoutMs}ms`,
      exitCode,
      attester,
      stdoutTail: redactedStdout,
      stderrTail: redactedStderr,
    });
  }

  if (exitCode !== 0) {
    return finishGate({ ...base, command }, startMs, {
      status: 'failed',
      summary: declared === 'failed'
        ? `AI review reported failed: ${formatAiReviewGateTarget(gate)}`
        : `AI review command exited ${exitCode}`,
      exitCode,
      attester,
      stdoutTail: redactedStdout,
      stderrTail: redactedStderr,
    });
  }

  if (declared === 'failed') {
    return finishGate({ ...base, command }, startMs, {
      status: 'failed',
      summary: `AI review reported failed: ${formatAiReviewGateTarget(gate)}`,
      exitCode,
      attester,
      stdoutTail: redactedStdout,
      stderrTail: redactedStderr,
    });
  }

  if (worktreeMutationSummary) {
    return finishGate({ ...base, command }, startMs, {
      status: 'failed',
      summary: worktreeMutationSummary,
      exitCode,
      attester,
      stdoutTail: redactedStdout,
      stderrTail: redactedStderr,
    });
  }

  if (declared !== 'passed') {
    return finishGate({ ...base, command }, startMs, {
      status: 'failed',
      summary: `AI review command completed without ${REVIEW_GATE_RESULT_MARKER}=passed or ${REVIEW_GATE_RESULT_MARKER}=failed`,
      exitCode,
      attester,
      stdoutTail: redactedStdout,
      stderrTail: redactedStderr,
    });
  }

  return finishGate({ ...base, command }, startMs, {
    status: 'passed',
    summary: `AI review passed: ${formatAiReviewGateTarget(gate)}`,
    exitCode,
    attester,
    stdoutTail: redactedStdout,
    stderrTail: redactedStderr,
  });
}

function resolveAiReviewGateCommand(gate: ReviewGateConfig): { command: string; provider: string } | null {
  const explicit = gate.command?.trim();
  const command = explicit
    || firstEnvValue(process.env, reviewGateCommandEnvKeys(gate))?.value
    || defaultAiReviewGateCommand(gate);
  if (!command) return null;
  return {
    command,
    provider: resolveAiReviewGateProvider(gate, command),
  };
}

function reviewGateCommandEnvKeys(gate: Pick<ReviewGateConfig, 'id'>): string[] {
  const key = reviewGateEnvKey(gate.id);
  return [
    `PIPELANE_REVIEW_${key}_COMMAND`,
    `PIPELANE_REVIEW_GATE_${key}_COMMAND`,
    'PIPELANE_REVIEW_AI_COMMAND',
    'PIPELANE_REVIEW_GATE_COMMAND',
  ];
}

function reviewGateProviderEnvKeys(gate: Pick<ReviewGateConfig, 'id'>): string[] {
  const key = reviewGateEnvKey(gate.id);
  return [
    `PIPELANE_REVIEW_${key}_PROVIDER`,
    `PIPELANE_REVIEW_GATE_${key}_PROVIDER`,
    'PIPELANE_REVIEW_PROVIDER',
    'PIPELANE_REVIEW_GATE_PROVIDER',
  ];
}

function reviewGateEnvKey(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'GATE';
}

function firstEnvValue(env: NodeJS.ProcessEnv, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

function defaultAiReviewGateCommand(gate: ReviewGateConfig): string {
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_REVIEW_GATE_USE_REAL_NATIVE !== '1') {
    return '';
  }
  if (gate.id === 'code-review-high' || gate.id === 'code-review-ultra') {
    return '';
  }
  if (gate.type === 'agent' && isExecutableOnPath('claude')) return defaultClaudeReviewCommand();
  if (isExecutableOnPath('codex')) return 'codex exec --full-auto -';
  if (isExecutableOnPath('claude')) return defaultClaudeReviewCommand();
  return '';
}

function defaultClaudeReviewCommand(): string {
  const help = commandHelp('claude');
  if (/\bdontAsk\b/.test(help)) return 'claude --print --permission-mode dontAsk';
  if (/\bbypassPermissions\b/.test(help)) return 'claude --print --permission-mode bypassPermissions';
  if (help.includes('--dangerously-skip-permissions')) return 'claude --print --dangerously-skip-permissions';
  return 'claude --print';
}

function commandHelp(command: string): string {
  const result = spawnSync(command, ['--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`;
}

function resolveAiReviewGateProvider(gate: ReviewGateConfig, command: string): string {
  const envProvider = firstEnvValue(process.env, reviewGateProviderEnvKeys(gate))?.value;
  if (envProvider) return normalizeReviewProvider(envProvider);
  const token = firstCommandToken(command);
  if (token === 'codex') return 'codex';
  if (token === 'claude') return 'claude';
  if (token === 'openclaw') return 'openclaw';
  return 'unknown';
}

function firstCommandToken(command: string): string {
  const match = command.trim().match(/^["']?([A-Za-z0-9_.:/-]+)/);
  if (!match) return '';
  return path.basename(match[1]).toLowerCase();
}

function normalizeReviewProvider(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'unknown';
}

function buildAiReviewGateEnv(provider: string, sessionId: string, gate: ReviewGateConfig): NodeJS.ProcessEnv {
  const env = gateSubprocessEnv();
  for (const key of AI_REVIEW_GATE_SCRUBBED_SESSION_ENV_KEYS) {
    delete env[key];
  }
  return {
    ...env,
    [REVIEW_GATE_SESSION_ENV]: sessionId,
    PIPELANE_REVIEW_PROVIDER: provider,
    PIPELANE_AGENT_PROVIDER: provider,
    PIPELANE_REVIEW_GATE_ID: gate.id,
    PIPELANE_REVIEW_GATE_TYPE: gate.type,
    PIPELANE_REVIEW_GATE_PHASE: gate.phase,
  };
}

function renderAiReviewGatePrompt(options: {
  gate: ReviewGateConfig;
  repoRoot: string;
  baseBranch: string;
  changedFiles: string[];
}): string {
  const { gate, repoRoot, baseBranch, changedFiles } = options;
  const target = formatAiReviewGateTarget(gate);
  const changedFileLines = changedFiles.length > 0
    ? changedFiles.slice(0, 250).map((file) => `- ${file}`)
    : ['- none detected'];
  const truncated = changedFiles.length > 250
    ? [`- ... ${changedFiles.length - 250} more files omitted`]
    : [];
  const requestedCommand = gate.userCommands?.map((command) => command.trim()).find(Boolean);
  const prefix = gate.id === 'code-review-high'
    ? ['/code-review high', '']
    : gate.id === 'code-review-ultra'
      ? ['/code-review ultra', '']
      : requestedCommand
        ? [requestedCommand, '']
        : [];
  return [
    ...prefix,
    'You are running as an independent Pipelane AI review gate.',
    '',
    `Gate: ${gate.id}`,
    `Gate type: ${gate.type}`,
    `Gate phase: ${gate.phase}`,
    `Requested review: ${target}`,
    `Repository: ${repoRoot}`,
    `Base branch: ${baseBranch}`,
    '',
    'Changed files:',
    ...changedFileLines,
    ...truncated,
    '',
    'Review the current checkout against the base branch. Do not modify files.',
    'Report blocking correctness, security, data-loss, regression, or test-coverage issues.',
    'If the requested skill or slash command is unavailable, perform the closest equivalent review yourself.',
    '',
    'Required result protocol:',
    `- Print ${REVIEW_GATE_RESULT_MARKER}=failed if you found any blocking issue or could not complete the review.`,
    `- Print ${REVIEW_GATE_RESULT_MARKER}=passed only if the gate is clean.`,
    '- End your final response with exactly one standalone result marker line.',
    '- Do not omit the result marker after running tests, even when there are no findings.',
    '- If you are uncertain whether the review completed, print the failed marker.',
  ].join('\n');
}

function reviewGateCheckoutMutationSummary(
  label: string,
  before: WorktreeStatusSnapshot,
  after: WorktreeStatusSnapshot,
): string | null {
  if (before.head && after.head && before.head !== after.head) {
    return `${label} changed HEAD; revert gate commit(s) and rerun (${shortSha(before.head)} -> ${shortSha(after.head)})`;
  }
  if (!before.statusDigestReliable) {
    return `${label} could not verify unchanged worktree before execution: ${formatWorktreeStatusWarnings(before)}`;
  }
  if (!after.statusDigestReliable) {
    return `${label} could not verify unchanged worktree after execution: ${formatWorktreeStatusWarnings(after)}`;
  }
  if (before.statusDigest !== after.statusDigest) {
    return `${label} mutated the worktree; revert gate changes and rerun (${formatWorktreeStatusDelta(before, after)})`;
  }
  return null;
}

function shortSha(value: string): string {
  return value.slice(0, 12) || 'unknown';
}

function formatWorktreeStatusWarnings(snapshot: Pick<WorktreeStatusSnapshot, 'statusDigestWarnings'>): string {
  return snapshot.statusDigestWarnings.join('; ') || 'status digest was unreliable';
}

function formatWorktreeStatusDelta(
  before: Pick<WorktreeStatusSnapshot, 'changedPaths'>,
  after: Pick<WorktreeStatusSnapshot, 'changedPaths'>,
): string {
  const changedPaths = [...new Set([...before.changedPaths, ...after.changedPaths])];
  if (changedPaths.length === 0) return 'status digest changed';
  const shown = changedPaths.slice(0, 5).join(', ');
  const omitted = changedPaths.length > 5 ? `, +${changedPaths.length - 5} more` : '';
  return `changed paths: ${shown}${omitted}`;
}

function formatAiReviewGateTarget(gate: ReviewGateConfig): string {
  return gate.userCommands?.[0]
    ?? (gate.skill ? `skill:${gate.skill}` : undefined)
    ?? (gate.role ? `role:${gate.role}` : undefined)
    ?? gate.id;
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

function isManualReviewGate(gate: Pick<ReviewGateConfig | ReviewGateRunRecord, 'type'>): boolean {
  return gate.type === 'skill' || gate.type === 'agent' || gate.type === 'approval';
}

function manualPassSummary(message: string): string {
  return `manual pass: ${message}`;
}

function summarizeConfigChangeApprovalStatus(gates: ReviewGateRunRecord[]): ReviewCommandStatus {
  if (gates.some((gate) => gate.blocking && gate.skipReason === REVIEW_CONFIG_CHANGE_WHEN)) {
    return 'pending';
  }
  return summarizeRunStatus(gates);
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
  if (gate.when?.startsWith('risk:') && !matchesReviewRisk(changedFiles, gate.when)) {
    return `skipped: no changed files matched ${gate.when}`;
  }
  return null;
}

function manualGateSummary(gate: ReviewGateConfig): string {
  if (gate.id === 'karpathy-diff') {
    const command = gate.userCommands?.[0] ?? '/karpathy diff';
    return `author self-review pending: run ${command}`;
  }
  if (isIndependentAiReviewGate(gate)) {
    const command = gate.userCommands?.[0] ?? gate.role ?? gate.skill ?? gate.id;
    return `independent AI review pending: run ${command} from a separate reviewer session`;
  }
  if (gate.type === 'skill') {
    const command = gate.userCommands?.[0] ?? (gate.skill ? `skill:${gate.skill}` : 'the configured skill');
    return `manual skill gate pending: run ${command}`;
  }
  if (gate.type === 'agent') {
    const command = gate.userCommands?.[0];
    return command
      ? `agent gate pending: run ${command}`
      : `agent gate pending: ${gate.role ?? gate.id}`;
  }
  if (gate.type === 'approval') {
    return `approval gate pending${gate.when ? ` (${gate.when})` : ''}`;
  }
  return `manual gate pending: ${gate.id}`;
}

// Exported for B1: the orchestration material-change check reuses this exact
// committed+staged+unstaged+untracked detection to decide if a slice is `empty`.
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

function maybeAddReviewConfigChangeGate(
  gates: ReviewGateConfig[],
  options: {
    reviewConfigChanged: boolean;
  },
): ReviewGateConfig[] {
  if (!options.reviewConfigChanged || gates.some((gate) => gate.id === REVIEW_CONFIG_CHANGE_GATE_ID)) return gates;
  return [reviewConfigChangeGateConfig(), ...gates];
}

function reviewConfigChangeGateConfig(): ReviewGateConfig {
  return {
    id: REVIEW_CONFIG_CHANGE_GATE_ID,
    phase: 'static',
    type: 'approval',
    blocking: true,
    when: REVIEW_CONFIG_CHANGE_WHEN,
  };
}

function selectReviewConfigChangeApproval(
  commonDir: string,
  config: WorkflowConfig,
  repoRoot: string,
): ReviewGateRunRecord | null {
  const currentBranch = runGit(repoRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const currentSha = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '';
  const worktreeStatus = readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
  if (!worktreeStatus.statusDigestReliable) return null;

  const state = loadReviewState(commonDir, config);
  for (const record of state.records) {
    if (
      record.dryRun
      || record.gateFilter
      || record.phaseFilter
      || record.branchName !== currentBranch
      || record.sha !== currentSha
      || record.worktreeStatusDigest !== worktreeStatus.statusDigest
      || record.worktreeStatusReliable !== true
    ) {
      continue;
    }
    const approval = record.gates.find(isPassedReviewConfigChangeApprovalGate);
    if (approval) return approval;
  }
  return null;
}

function isPassedReviewConfigChangeApprovalGate(gate: ReviewGateRunRecord): boolean {
  return gate.gateId === REVIEW_CONFIG_CHANGE_GATE_ID
    && gate.type === 'approval'
    && gate.blocking === true
    && gate.status === 'passed'
    && gate.attester !== undefined;
}

function approvedReviewConfigChangeGateRecord(
  gate: ReviewGateConfig,
  approval: ReviewGateRunRecord,
): ReviewGateRunRecord {
  return {
    ...approval,
    gateId: gate.id,
    phase: gate.phase,
    type: gate.type,
    blocking: gate.blocking !== false,
    status: 'passed',
  };
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

  const configChangePending = pending.some((gate) => gate.gateId === REVIEW_CONFIG_CHANGE_GATE_ID);
  if (record.status === 'failed') {
    lines.push('', 'Next: fix failed blocking gates, then rerun /pipelane review.');
  } else if (configChangePending) {
    lines.push('', `Next: inspect the review config diff, then record approval with /pipelane review pass --gate ${REVIEW_CONFIG_CHANGE_GATE_ID} --message "<what changed and why it is trusted>".`);
  } else if (record.status === 'pending') {
    lines.push('', 'Next: complete pending AI/manual gates, then rerun or attach their evidence before PR enforcement.');
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
  } else if (gateId === REVIEW_CONFIG_CHANGE_GATE_ID) {
    lines.push('', 'Next: rerun /pipelane review to execute the configured gates under the approved review config.');
  } else {
    lines.push('', 'Next: complete the remaining pending AI/manual gates, then record each pass.');
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
  lines.push('', 'Delivery loop safety:');
  lines.push('- Defaults are configured by /pipelane configure: fix/review loops, minutes, AI review runs, and stop on major findings.');

  if (report.missing.length > 0) {
    lines.push('', 'Setup gaps:');
    lines.push(...report.missing.map((entry) => `- ${entry.id}: ${entry.reason}`));
  }

  if (report.actions && report.actions.length > 0) {
    lines.push('', 'Setup actions:');
    lines.push(...report.actions.map((entry) => `- ${entry}`));
  }

  if (options.includeCatalog) {
    lines.push('', 'Gate catalog:');
    lines.push(...formatCatalog(report.catalog ?? []));
  }

  lines.push('', 'Setup controls:');
  lines.push('- Toggle a gate: /pipelane review setup <display-id-or-gate-id>');
  lines.push('- Explicit toggle flag: /pipelane review setup --toggle <display-id-or-gate-id>');
  lines.push('- Enable a gate: /pipelane review setup --enable <gate-id>');
  lines.push('- Disable a gate: /pipelane review setup --disable <gate-id>');
  lines.push('- Install an optional gate: /pipelane review setup --install <gate-id>');
  lines.push('- Reset to recommended defaults: /pipelane review setup --reset');
  lines.push('- Multiple gates: /pipelane review setup C3,H1 or repeat the --toggle flag.');
  lines.push('- Opinionated default: self-review, deterministic checks, independent AI review, and cross-model review when installed.');
  lines.push('- Opting out trades speed for higher risk of missed correctness, security, or data-loss bugs.');

  if (options.includeEffectiveJson) {
    lines.push(
      '',
      'Effective reviewGates:',
      JSON.stringify({
        planReview: report.effective.planReview,
        gates: report.effective.gates,
      }, null, 2),
    );
  }

  lines.push('', 'Next: run /pipelane review to write gate evidence before PR handoff.');
  return lines.join('\n');
}

function renderReviewSetupState(
  prepared: {
    repoRoot: string;
    packageJson: ReviewSetupReport['packageJson'];
    detectedScripts: string[];
    gates: ReviewSetupGateOption[];
    claude: ClaudeReviewSetupStatus;
  },
  options: {
    status: ReviewSetupStatus;
    configPath: string | null;
    actions?: string[];
    interactive?: boolean;
  },
): string {
  const lines = [
    'Review setup',
    `Status: ${options.status}`,
    `Config: ${options.configPath ? displayRepoPath(prepared.repoRoot, options.configPath) : 'not saved; showing inferred recommended defaults'}`,
    '',
    packageScriptsSummary(prepared.packageJson, prepared.detectedScripts),
    '',
    'Claude review support:',
    ...formatClaudeReviewSetupStatus(prepared.claude),
  ];

  if (options.actions && options.actions.length > 0) {
    lines.push('', 'Setup actions:', ...options.actions.map((entry) => `- ${entry}`));
  }

  lines.push('', 'Review gates:');
  for (const section of reviewSetupSections()) {
    const gates = prepared.gates.filter((gate) => gate.section.id === section.id);
    if (gates.length === 0) continue;
    lines.push('', `${section.id}. ${section.title}:`);
    for (const gate of gates) {
      lines.push(formatReviewSetupRow(gate, prepared.repoRoot));
    }
  }

  const customGates = prepared.gates.filter((gate) => gate.section.id === 'X');
  if (customGates.length > 0) {
    lines.push('', 'X. Custom gates:');
    for (const gate of customGates) {
      lines.push(formatReviewSetupRow(gate, prepared.repoRoot));
    }
  }

  lines.push('', 'Controls:');
  if (options.interactive) {
    lines.push('- Type a row id such as C3 to toggle it immediately.');
    lines.push('- Press Enter or q to exit.');
  } else {
    lines.push('- Toggle a row: /pipelane review setup C3');
    lines.push('- Explicit toggle flag: /pipelane review setup --toggle C3');
    lines.push('- Toggle by gate id: /pipelane review setup --toggle gstack-review');
    lines.push('- Enable/disable: /pipelane review setup --enable gstack-review | --disable typecheck');
    lines.push('- Install optional support: /pipelane review setup --install secret-scan');
    lines.push('- Reset to recommended defaults: /pipelane review setup --reset');
  }
  return lines.join('\n');
}

function packageScriptsSummary(packageJson: ReviewSetupReport['packageJson'], detectedScripts: string[]): string {
  if (!packageJson.found) return `Package scripts: no package.json found at ${packageJson.path}`;
  if (packageJson.malformed) return `Package scripts: package.json is malformed - ${packageJson.parseError ?? 'unknown parse error'}`;
  return `Package scripts: ${detectedScripts.length > 0 ? detectedScripts.join(', ') : 'none detected'}`;
}

function displayRepoPath(repoRoot: string, targetPath: string): string {
  const relative = path.relative(repoRoot, targetPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : targetPath;
}

function formatClaudeReviewSetupStatus(status: ClaudeReviewSetupStatus): string[] {
  const claudeCli = status.claudeCliPath
    ? `installed at ${status.claudeCliPath}`
    : 'not found on PATH; subscription setup is install Claude Code, then run `claude auth login --claudeai` in the same environment Codex uses';
  const codeReviewHigh = status.codeReviewHighAvailable
    ? `available via ${status.codeReviewHighSource}`
    : `not available (${status.codeReviewHighSource})`;
  const bridge = status.codexBridgeInstalled
    ? `installed at ${status.codexBridgeTarget}`
    : `not installed; setup: /pipelane review setup --install adversarial-review`;
  const apiEnv = status.apiEnvKeys.length > 0
    ? `${status.apiEnvKeys.join(', ')} set; current Codex /claude bridge is subscription-only and does not use API keys`
    : 'not set; current Codex /claude bridge is subscription-only';

  return [
    `- Claude Code CLI subscription: ${claudeCli}`,
    `- /code-review high gate: ${codeReviewHigh}`,
    `- Codex /claude review bridge: ${bridge}`,
    `- Anthropic API env: ${apiEnv}`,
  ];
}

function reviewSetupSections(): ReviewSetupSection[] {
  return [
    { id: 'M', title: 'Mechanical gates', ids: ['typecheck', 'format-check', 'lint', 'secret-scan', 'dependency-audit'] },
    { id: 'T', title: 'Test gates', ids: ['test', 'build'] },
    { id: 'C', title: 'Code review gates', ids: ['karpathy-diff', 'code-review-high', 'gstack-review', 'adversarial-review', 'code-review-ultra'] },
    { id: 'I', title: 'Instruction and runtime gates', ids: ['karpathy-audit', 'browser-qa'] },
    { id: 'H', title: 'Human approval gates', ids: ['high-stakes-human-approval', 'human-merge-approval', 'human-prod-deploy-approval', 'human-rollback-approval'] },
  ];
}

function formatReviewSetupRow(gate: ReviewSetupGateOption, repoRoot: string): string {
  const selected = gate.selected ? 'on ' : 'off';
  const id = gate.displayId.padEnd(3, ' ');
  const gateId = gate.entry.id.padEnd(27, ' ');
  const detail = reviewSetupGateDetail(gate, repoRoot);
  const consequence = !gate.selected && gate.recommended
    ? ' | opted out: less review coverage'
    : '';
  return `${id} ${selected} ${gateId} ${gate.label} | ${detail}${consequence}`;
}

function reviewSetupGateDetail(gate: ReviewSetupGateOption, repoRoot: string): string {
  const entry = gate.entry;
  if (entry.type === 'command') {
    if (entry.command) return entry.command;
    const install = gate.installState === 'not installed'
      ? ' (installable)'
      : gate.installState === 'unavailable'
        ? ' (unavailable)'
        : '';
    return `${noScriptFoundLabel(entry)}${install}`;
  }
  if (entry.id === 'adversarial-review') {
    const savedCommand = gate.hydratedFromSavedConfig ? entry.userCommands?.[0] : undefined;
    const provider = gate.adversarialProvider ?? (savedCommand ? undefined : preferredAdversarialReviewProvider(repoRoot));
    const target = provider
      ? `${provider.command} (${provider.label})`
      : savedCommand ?? preferredReviewSetupCommand(entry) ?? entry.role ?? entry.id;
    const install = gate.installState === 'not applicable' ? '' : ` ${gate.installState}`;
    return `${target}${install}`;
  }
  const target = preferredReviewSetupCommand(entry)
    ?? entry.skill
    ?? entry.role
    ?? (entry.type === 'approval' ? 'approval' : entry.when)
    ?? entry.type;
  const install = gate.installState === 'not applicable' ? '' : ` ${gate.installState}`;
  const condition = entry.whenChanged && entry.whenChanged.length > 0
    ? ` when ${entry.whenChanged.join(', ')} changes`
    : entry.when
      ? ` ${entry.when}`
      : '';
  return `${target}${condition}${install}`;
}

function preferredReviewSetupCommand(entry: ResolvedReviewGateCatalogEntry): string | undefined {
  const preferredById: Record<string, string> = {
    'karpathy-diff': '/karpathy diff',
    'code-review-high': '/code-review high',
    'gstack-review': '/gstack review',
    'adversarial-review': '/claude review code',
    'code-review-ultra': '/code-review ultra',
    'karpathy-audit': '/karpathy-audit',
  };
  const preferred = preferredById[entry.id];
  if (preferred) return preferred;
  return entry.userCommands?.[0];
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
    'karpathy-diff': 'Author self-review',
    'code-review-high': 'Claude Code review high',
    'gstack-review': 'Independent AI review',
    'adversarial-review': 'Cross-model review',
    'code-review-ultra': 'High-stakes ultra review',
    'browser-qa': 'Browser QA',
    'karpathy-audit': 'Instruction audit',
    'high-stakes-human-approval': 'High-stakes human approval',
    'human-merge-approval': 'Merge approval',
    'human-prod-deploy-approval': 'Production deploy approval',
    'human-rollback-approval': 'Rollback approval',
  };
  return labels[entry.id] ?? entry.id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    return `- ${entry.id} [${entry.kind}/${entry.phase}] ${target} - ${status}${optional}${matched}${aliases}`;
  });
}
