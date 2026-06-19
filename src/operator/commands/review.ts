import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
  detectPackageScripts,
  resolveReviewGateCatalog,
  type ResolvedReviewGateCatalogEntry,
} from '../review-gates.ts';
import { readWorktreeStatusSnapshot } from '../worktree-status.ts';
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
const OUTPUT_TAIL_CHARS = 4000;
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

  if (parsed.flags.yes) {
    const prepared = prepareInteractiveReviewSetup(context.repoRoot);
    writeResult = saveInteractiveReviewSetup(context.repoRoot, prepared.gates);
    context = resolveWorkflowContext(cwd);
  }

  if (
    !parsed.flags.yes
    && !parsed.flags.reviewPrint
    && !parsed.flags.reviewListGates
    && !parsed.flags.json
  ) {
    if (!canRunInteractiveReviewSetup()) {
      throw new Error('review setup requires a TTY for interactive setup. Use --yes to save recommended gates, --print, --list-gates, or --json for non-interactive output.');
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
  const nextGates = base.gates.map((entry) => {
    if (entry.gateId !== gateId || entry.status !== 'pending') return entry;
    return {
      ...entry,
      status: 'passed' as const,
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
  if (entry.type !== 'skill' && entry.type !== 'agent') return 'not applicable';
  if (entry.id === 'adversarial-review') {
    return isAdversarialReviewInstalled(repoRoot)
      ? 'installed'
      : reviewGateInstallOptions(entry).length > 0
        ? 'not installed'
        : 'unavailable';
  }
  const names = knownInstallNamesForGate(entry);
  if (names.length === 0) return 'unavailable';
  if (names.some((name) => isSkillInstalled(repoRoot, name))) return 'installed';
  return hasReviewGateInstaller(entry) ? 'not installed' : 'unavailable';
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
    const installers = reviewGateInstallOptions(gate.entry);
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
      gate.installState = 'installed';
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

function hasReviewGateInstaller(entry: ResolvedReviewGateCatalogEntry): boolean {
  return reviewGateInstallOptions(entry).length > 0;
}

function reviewGateInstallOptions(entry: ResolvedReviewGateCatalogEntry): ReviewGateInstallOption[] {
  const testInstaller = testReviewGateInstallOption(entry);
  if (testInstaller) return [testInstaller];

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

function testReviewGateInstallOption(entry: ResolvedReviewGateCatalogEntry): ReviewGateInstallOption | null {
  if (process.env.NODE_ENV === 'test') {
    const allowed = configuredTestReviewGateInstallers();
    if (allowed.includes(entry.id) || entry.id === 'adversarial-review') {
      return {
        id: `test-${entry.id}`,
        label: reviewSetupInstallTarget(entry),
        target: reviewSetupInstallTarget(entry),
        install: () => allowed.includes(entry.id)
          ? { ok: true, message: `Installed ${entry.id}.` }
          : { ok: false, message: `No test installer succeeded for ${entry.id}.` },
      };
    }
  }
  return null;
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
): { configPath: string; isLegacy: boolean } {
  const selectedGates = orderReviewGates(gates
    .filter((gate) => gate.selected && gate.entry.available)
    .map((gate) => reviewSetupGateToConfig(gate)));
  return patchReadableWorkflowConfig(repoRoot, (raw) => ({
    ...raw,
    reviewGates: buildReviewGatesExplicitPatch(raw, selectedGates),
  }));
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

  if (options.includeCatalog) {
    lines.push('', 'Gate catalog:');
    lines.push(...formatCatalog(report.catalog ?? []));
  }

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
    return noScriptFoundLabel(entry);
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
