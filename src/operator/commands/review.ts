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
import { resolveReviewActorIdentity } from '../review-identity.ts';
import { readWorktreeStatusSnapshot, type WorktreeStatusSnapshot } from '../worktree-status.ts';
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

type ReviewSetupStatus = 'configured' | 'reported' | 'cancelled';
type ReviewCommandStatus = ReviewRunRecord['status'];
type ReviewAttestStatus = 'attested';

const REVIEW_CONFIG_CHANGE_GATE_ID = 'review-config-change';
const REVIEW_CONFIG_CHANGE_PATHS = ['.pipelane.json', '.project-workflow.json', 'package.json'];
const REVIEW_PHASE_ORDER = REVIEW_GATE_PHASES;
const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REVIEW_SETUP_NPM_INSTALL_TIMEOUT_MS = 2 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;
const REVIEW_GATE_RESULT_MARKER = 'PIPELANE_REVIEW_GATE_RESULT';
const REVIEW_GATE_SESSION_ENV = 'PIPELANE_REVIEW_GATE_SESSION_ID';
const CODEX_CLAUDE_REVIEW_REPO = 'https://github.com/jokim1/codexskill-claude-review.git';
const CODEX_CLAUDE_REVIEW_SKILL_NAME = 'claude';
const KARPATHY_SKILLS_REPO = 'https://github.com/jokim1/karpathy-skills.git';

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
  entry: ResolvedReviewGateCatalogEntry;
  label: string;
  selected: boolean;
  recommended: boolean;
  installState: GateInstallState;
  adversarialProvider?: AdversarialReviewProvider;
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
  const selectionFlags = hasReviewSetupSelectionFlags(parsed);
  if (selectionFlags && (parsed.flags.reviewPrint || parsed.flags.reviewListGates)) {
    throw new Error('review setup cannot combine modifying flags (--enable, --disable, --install) with read-only flags (--print, --list-gates). Run the modifying command first, then inspect with --print or --list-gates.');
  }

  if (parsed.flags.yes || selectionFlags) {
    const prepared = prepareInteractiveReviewSetup(context.repoRoot);
    const selectionResult = applyReviewSetupSelections(context.repoRoot, prepared, parsed);
    actionMessages.push(...selectionResult.messages);
    const existingReviewGates = context.config.reviewGates?.gates ?? [];
    writeResult = saveInteractiveReviewSetup(context.repoRoot, prepared.gates, {
      existingReviewGates,
      preserveExistingReviewGates: selectionFlags,
      useSelectedDefaults: parsed.flags.yes,
      changedGateIds: new Set([...selectionResult.enabledIds, ...selectionResult.installedIds]),
      disabledGateIds: new Set(selectionResult.disabledIds),
    });
    context = resolveWorkflowContext(cwd);
  }

  if (
    !parsed.flags.yes
    && !selectionFlags
    && !parsed.flags.reviewPrint
    && !parsed.flags.reviewListGates
    && !parsed.flags.json
  ) {
    if (!canRunInteractiveReviewSetup()) {
      const prepared = prepareInteractiveReviewSetup(context.repoRoot);
      process.stdout.write(`${renderNonInteractiveReviewSetup(prepared)}\n`);
      return;
    }
    await runInteractiveReviewSetup(cwd, parsed);
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

  const expectedGate = options.config.reviewGates?.gates?.find((gate) => gate.id === gateId);
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
    status: summarizeRunStatus(nextGates),
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    worktreeStatusDigest: worktreeStatus.statusDigest,
    worktreeStatusReliable: worktreeStatus.statusDigestReliable,
    worktreeStatusWarnings: worktreeStatus.statusDigestWarnings,
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

      await toggleInteractiveGate(gate, prompter, context.repoRoot);
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

function hasReviewSetupSelectionFlags(parsed: ParsedOperatorArgs): boolean {
  return parsed.flags.reviewEnable.length > 0
    || parsed.flags.reviewDisable.length > 0
    || parsed.flags.reviewInstall.length > 0;
}

function applyReviewSetupSelections(
  repoRoot: string,
  prepared: { gates: ReviewSetupGateOption[] },
  parsed: ParsedOperatorArgs,
): ReviewSetupSelectionResult {
  const installIds = resolveReviewSetupGateInputs(prepared.gates, parsed.flags.reviewInstall, '--install');
  const enableIds = resolveReviewSetupGateInputs(prepared.gates, parsed.flags.reviewEnable, '--enable');
  const disableIds = resolveReviewSetupGateInputs(prepared.gates, parsed.flags.reviewDisable, '--disable');
  const installSet = new Set(installIds);
  const enableSet = new Set(enableIds);
  const disableSet = new Set(disableIds);
  const conflicting = [...new Set([...installIds, ...enableIds])]
    .filter((id) => disableSet.has(id));
  if (conflicting.length > 0) {
    throw new Error(`review setup cannot both enable/install and disable: ${conflicting.join(', ')}`);
  }

  const messages: string[] = [];
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
    enablePreparedReviewGate(repoRoot, gate);
    messages.push(`Enabled ${gate.entry.id}.`);
  }

  return {
    messages,
    enabledIds: enableIds,
    disabledIds: disableIds,
    installedIds: installIds,
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

  const alias = resolveReviewGateAlias(trimmed);
  const normalized = (alias ?? trimmed).toLowerCase();
  const gate = gates.find((candidate) => candidate.entry.id === normalized);
  if (!gate) {
    throw new Error(`${flagName} received unknown review gate "${input}". Run "pipelane run review setup --list-gates" to inspect available gate ids.`);
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

function enablePreparedReviewGate(repoRoot: string, gate: ReviewSetupGateOption): void {
  if (!gate.entry.available) {
    const installHint = hasReviewGateInstaller(gate.entry, repoRoot)
      ? ` Run "pipelane run review setup --install ${gate.entry.id}" to install and enable it.`
      : '';
    throw new Error(`${gate.entry.id} cannot be enabled: ${gate.entry.missingReason ?? 'gate unavailable'}.${installHint}`);
  }

  if ((gate.entry.type === 'skill' || gate.entry.type === 'agent') && gate.installState !== 'installed') {
    throw new Error(`${gate.entry.id} needs an installed reviewer before it can be enabled. Run "pipelane run review setup --install ${gate.entry.id}" to install and enable it.`);
  }

  if (gate.entry.id === 'adversarial-review') {
    gate.adversarialProvider = preferredAdversarialReviewProvider(repoRoot);
  }
  gate.selected = true;
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
  gates.forEach((gate, index) => {
    gate.number = index + 1;
  });
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
    ['gstack-review', 90],
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
  const pathValue = process.env.PATH || '';
  return pathValue.split(path.delimiter).some((dir) => {
    if (!dir) return false;
    return isExecutableFile(path.join(dir, command));
  });
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
      return {
        ok: false,
        message: 'gitleaks is not installed or not on PATH. Install gitleaks, then rerun review setup --install secret-scan.',
      };
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

  const record = buildReviewRunRecord({
    repoRoot: context.repoRoot,
    baseBranch: context.config.baseBranch,
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
  const gateRecords = selectedGates.map((gate) => {
    options.onGateStart?.(gate);
    const record = runReviewGate({
      gate,
      repoRoot: options.repoRoot,
      baseBranch: options.baseBranch,
      dryRun: options.dryRun,
      reviewConfigChanged,
      changedFiles,
      activeSurfaces: options.activeSurfaces,
    });
    options.onGateFinish?.(record);
    return record;
  });
  const finishedAt = nowIso();
  const status = summarizeRunStatus(gateRecords);

  return {
    id: `review-${new Date(startedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
    branchName: runGit(options.repoRoot, ['branch', '--show-current'], true)?.trim() ?? '',
    sha: runGit(options.repoRoot, ['rev-parse', '--verify', 'HEAD'], true)?.trim() ?? '',
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
    reviewer: resolveReviewActorIdentity(),
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
  baseBranch: string;
  dryRun: boolean;
  reviewConfigChanged: boolean;
  changedFiles: string[];
  activeSurfaces: string[];
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
      skipReason: 'review-config-changed',
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
  const result = spawnSync(command, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    input: prompt,
    timeout: timeoutMs,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const output = `${stdout}\n${stderr}`;
  const declared = parseAiReviewGateResult(output);
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const attester = resolveReviewActorIdentity({ provider: resolved.provider, env });
  const redactedStdout = tail(redactReviewOutput(stdout));
  const redactedStderr = tail(redactReviewOutput(stderr));
  const afterStatus = readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
  const worktreeMutationSummary = aiReviewWorktreeMutationSummary(beforeStatus, afterStatus);

  if (result.error && !timedOut) {
    return finishGate({ ...base, command }, startMs, {
      status: 'failed',
      summary: `AI review command failed to start: ${result.error.message}`,
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
  return {
    ...process.env,
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
  return [
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
    '- Put the result marker on its own line after your findings.',
  ].join('\n');
}

function parseAiReviewGateResult(output: string): 'passed' | 'failed' | null {
  const matches = [...output.matchAll(new RegExp(`(?:^|\\n)\\s*${REVIEW_GATE_RESULT_MARKER}\\s*[:=]\\s*(passed|failed)\\b`, 'gi'))];
  const last = matches.at(-1);
  if (!last) return null;
  return last[1].toLowerCase() === 'passed' ? 'passed' : 'failed';
}

function aiReviewWorktreeMutationSummary(
  before: WorktreeStatusSnapshot,
  after: WorktreeStatusSnapshot,
): string | null {
  if (!before.statusDigestReliable) {
    return `AI review command could not verify unchanged worktree before execution: ${formatWorktreeStatusWarnings(before)}`;
  }
  if (!after.statusDigestReliable) {
    return `AI review command could not verify unchanged worktree after execution: ${formatWorktreeStatusWarnings(after)}`;
  }
  if (before.statusDigest !== after.statusDigest) {
    return `AI review command mutated the worktree; revert reviewer changes and rerun (${formatWorktreeStatusDelta(before, after)})`;
  }
  return null;
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
  lines.push('- Enable a gate: /pipelane review setup --enable <gate-id>');
  lines.push('- Disable a gate: /pipelane review setup --disable <gate-id>');
  lines.push('- Install an optional gate: /pipelane review setup --install <gate-id>');
  lines.push('- Save defaults plus changes: combine --yes with --enable/--disable/--install as needed.');
  lines.push('- AI review gates: karpathy-diff, gstack-review, adversarial-review.');

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

function renderNonInteractiveReviewSetup(prepared: {
  repoRoot: string;
  packageJson: ReviewSetupReport['packageJson'];
  detectedScripts: string[];
  gates: ReviewSetupGateOption[];
}): string {
  return [
    renderInteractiveReviewSetup(prepared),
    '',
    'Non-interactive actions:',
    '- Save current selection: /pipelane review setup --yes',
    '- Enable a gate: /pipelane review setup --enable <gate-id>',
    '- Disable a gate: /pipelane review setup --disable <gate-id>',
    '- Install and enable an optional gate: /pipelane review setup --install <gate-id>',
    '- Print effective config: /pipelane review setup --print',
  ].join('\n');
}

function renderInteractiveReviewSetup(prepared: {
  repoRoot: string;
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
      lines.push(formatInteractiveGate(gate, prepared.repoRoot));
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
    { title: 'AI review gates', ids: ['karpathy-diff', 'gstack-review', 'adversarial-review'] },
    { title: 'Conditional gates', ids: ['browser-qa', 'karpathy-audit'] },
    { title: 'Human approval gates', ids: ['human-merge-approval', 'human-prod-deploy-approval', 'human-rollback-approval'] },
  ];
}

function formatInteractiveGate(gate: ReviewSetupGateOption, repoRoot: string): string {
  const selected = gate.selected ? '[on] ' : '[off]';
  const number = `${gate.number}.`.padEnd(4, ' ');
  const label = gate.label.padEnd(27, ' ');
  const detail = reviewSetupGateDetail(gate, repoRoot);
  return `${number}${selected} ${label}${detail}`;
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
    const provider = preferredAdversarialReviewProvider(repoRoot);
    const target = provider
      ? `${provider.command} (${provider.label})`
      : entry.userCommands?.[0] ?? entry.role ?? entry.id;
    const install = gate.installState === 'not applicable' ? '' : ` ${gate.installState}`;
    return `${target}${install}`;
  }
  const target = entry.userCommands?.[0]
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
