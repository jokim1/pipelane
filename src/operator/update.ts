import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { stopDashboardForRepo } from '../dashboard/launcher.ts';
import { installClaudeBootstrapSkill } from './claude-install.ts';
import { installCodexBootstrapSkill } from './codex-install.ts';
import { detectSetupDrift, formatSetupResult, type SetupDrift, setupConsumerRepo } from './docs.ts';
import { PIPELANE_GITHUB_URL, PIPELANE_REPO_SLUG, resolvePipelaneInstallSpec } from './install-source.ts';
import { homeClaudeDir, homeCodexDir, resolveRepoRoot, runCommandCapture } from './state.ts';

export interface UpdateOptions {
  check: boolean;
  yes: boolean;
  json: boolean;
}

export interface UpdateStatus {
  repoRoot: string;
  installedSha: string;
  installedShaShort: string;
  latestSha: string;
  latestShaShort: string;
  installedVersion: string;
  upToDate: boolean;
  aheadBy: number | null;
  commits: Array<{ sha: string; subject: string }>;
}

export interface UpdateResult {
  status: UpdateStatus;
  action: 'up-to-date' | 'checked' | 'skipped' | 'installed';
  message: string;
  // Context-aware follow-up: what pipelane:setup would still change on this
  // consumer's disk after the npm install (or right now, for --check). Null
  // when detection couldn't run (missing .pipelane.json, etc.).
  followUpSteps: SetupDrift | null;
  // True iff runUpdate actually invoked setupConsumerRepo before returning
  // (inline setup accepted via prompt or --yes).
  ranSetup: boolean;
  globalSurfaces: GlobalSurfaceRefresh;
}

type GlobalSurfaceRefreshStatus = 'refreshed' | 'skipped' | 'failed';

export interface GlobalSurfaceRefreshCheck {
  status: GlobalSurfaceRefreshStatus;
  detail: string;
}

export interface GlobalSurfaceRefresh {
  codex: GlobalSurfaceRefreshCheck;
  claude: GlobalSurfaceRefreshCheck;
}

export function parseUpdateArgs(argv: string[]): UpdateOptions {
  const options: UpdateOptions = { check: false, yes: false, json: false };
  for (const token of argv) {
    if (token === '--check') options.check = true;
    else if (token === '--yes' || token === '-y') options.yes = true;
    else if (token === '--json') options.json = true;
    else if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown flag for pipelane update: ${token}`);
    }
  }
  return options;
}

export async function runUpdate(cwd: string, options: UpdateOptions): Promise<UpdateResult> {
  const repoRoot = resolveRepoRoot(cwd, true);
  const status = collectUpdateStatus(repoRoot);

  // --check path (pre-install) and upToDate path: run drift detection so the
  // operator sees whether the consumer's working tree is in sync with the
  // currently-installed pipelane, even when no upstream update exists.
  if (options.check || status.upToDate) {
    const driftResult = tryDetectDrift(repoRoot);
    const globalSurfaces = options.check
      ? skippedGlobalSurfaces('read-only --check')
      : refreshInstalledGlobalSurfaces(repoRoot);
    const summary = status.upToDate
      ? `pipelane is up to date (${status.installedShaShort}).`
      : buildStatusMessage(status);
    if (options.json) {
      // JSON mode: no ambient text. Drift hint (if any) travels in the
      // result object's followUpSteps field. If detection failed, the
      // caller sees followUpSteps=null and can act accordingly.
      const result: UpdateResult = {
        status,
        action: status.upToDate ? 'up-to-date' : 'checked',
        message: summary,
        followUpSteps: driftResult.drift,
        ranSetup: false,
        globalSurfaces,
      };
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result;
    }
    process.stdout.write(`${summary}\n`);
    emitGlobalSurfaceRefreshHint(globalSurfaces);
    emitDriftHint(driftResult);
    return {
      status,
      action: status.upToDate ? 'up-to-date' : 'checked',
      message: summary,
      followUpSteps: driftResult.drift,
      ranSetup: false,
      globalSurfaces,
    };
  }

  // Behind main path: print the commit delta, install, detect drift, run
  // setup inline if needed. The user invoked `pipelane update` — that is
  // the consent. For read-only inspection, use `--check`.
  const summary = buildStatusMessage(status);
  if (!options.json) process.stdout.write(`${summary}\n`);

  assertSafeNpmInstallTarget(repoRoot);
  installLatest(repoRoot, { quiet: options.json });
  const boardStop = await stopDashboardForRepo(repoRoot);

  const after = collectUpdateStatus(repoRoot);
  const tail = after.upToDate
    ? `Installed ${after.installedShaShort} (up to date).`
    : `Installed pipelane; now at ${after.installedShaShort} (remote main: ${after.latestShaShort}).`;
  const message = `Upgrade complete.\n${tail}`;

  const driftResult = tryDetectDrift(repoRoot);
  const globalSurfaces = refreshInstalledGlobalSurfaces(repoRoot);

  if (options.json) {
    const result: UpdateResult = {
      status: after,
      action: 'installed',
      message,
      followUpSteps: driftResult.drift,
      ranSetup: false,
      globalSurfaces,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  process.stdout.write(`${message}\n`);
  if (boardStop.stopped) {
    process.stdout.write(`Stopped existing Pipelane Board (PID ${boardStop.pid}) so the next board start uses the updated package.\n`);
  }
  emitGlobalSurfaceRefreshHint(globalSurfaces);
  emitDriftHint(driftResult);

  let ranSetup = false;
  const drift = driftResult.drift;
  if (drift?.needsSetup && drift.claude.collisions.length === 0) {
    const setupResult = setupConsumerRepo(repoRoot);
    process.stdout.write('\n' + formatSetupResult(setupResult).join('\n') + '\n');
    emitReopenHints(drift);
    ranSetup = true;
  }

  return {
    status: after,
    action: 'installed',
    message,
    followUpSteps: drift,
    ranSetup,
    globalSurfaces,
  };
}

interface DriftResult {
  drift: SetupDrift | null;
  // Set when detection couldn't run (no .pipelane.json, etc.). Non-JSON
  // callers surface it; JSON mode keeps the channel clean and carries the
  // null via followUpSteps instead.
  error: string | null;
}

function tryDetectDrift(repoRoot: string): DriftResult {
  try {
    return { drift: detectSetupDrift(repoRoot), error: null };
  } catch (error) {
    return { drift: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function skippedGlobalSurfaces(reason: string): GlobalSurfaceRefresh {
  return {
    codex: { status: 'skipped', detail: reason },
    claude: { status: 'skipped', detail: reason },
  };
}

function isExecutable(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function installedCodexSurfaceSignals(): string[] {
  const skillsRoot = path.join(homeCodexDir(), 'skills');
  return [
    path.join(skillsRoot, '.pipelane', 'bin', 'pipelane'),
    path.join(skillsRoot, '.pipelane', 'bin', 'run-pipelane.sh'),
    path.join(skillsRoot, '.pipelane', 'managed-skills.json'),
    path.join(skillsRoot, 'pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'init-pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'new', 'SKILL.md'),
    // Legacy pre-durable installs used this path as a runtime directory. Its
    // presence should still trigger a refresh so update can repair it.
    path.join(skillsRoot, 'pipelane', 'bin', 'run-pipelane.sh'),
  ];
}

function installedClaudeSurfaceSignals(): string[] {
  const skillsRoot = path.join(homeClaudeDir(), 'skills');
  return [
    path.join(skillsRoot, 'pipelane', 'bin', 'pipelane'),
    path.join(skillsRoot, 'pipelane', 'bin', 'run-pipelane.sh'),
    path.join(skillsRoot, 'pipelane', 'managed-skills.json'),
    path.join(skillsRoot, 'pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'init-pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'new', 'SKILL.md'),
  ];
}

function refreshInstalledGlobalSurfaces(repoRoot: string): GlobalSurfaceRefresh {
  return {
    codex: refreshGlobalSurface(repoRoot, 'codex', installedCodexSurfaceSignals()),
    claude: refreshGlobalSurface(repoRoot, 'claude', installedClaudeSurfaceSignals()),
  };
}

function refreshGlobalSurface(repoRoot: string, host: 'codex' | 'claude', signals: string[]): GlobalSurfaceRefreshCheck {
  if (!signals.some((targetPath) => existsSync(targetPath))) {
    return { status: 'skipped', detail: `not installed (run pipelane install-${host} to add it)` };
  }

  const installCommand = host === 'codex' ? 'install-codex' : 'install-claude';
  const localBin = path.join(repoRoot, 'node_modules', '.bin', 'pipelane');
  if (isExecutable(localBin)) {
    const result = runCommandCapture(localBin, [installCommand], {
      cwd: repoRoot,
      env: process.env,
    });
    if (result.ok) {
      return { status: 'refreshed', detail: `refreshed via ${localBin}` };
    }
    return {
      status: 'failed',
      detail: result.stderr || result.stdout || `${localBin} ${installCommand} exited ${result.exitCode}`,
    };
  }

  try {
    if (host === 'codex') {
      installCodexBootstrapSkill();
    } else {
      installClaudeBootstrapSkill();
    }
    return { status: 'refreshed', detail: 'refreshed via current runtime' };
  } catch (error) {
    return {
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function symlinkedNodeModulesTarget(repoRoot: string): string | null {
  const nodeModulesPath = path.join(repoRoot, 'node_modules');
  try {
    const stat = lstatSync(nodeModulesPath);
    if (!stat.isSymbolicLink()) {
      return null;
    }
    try {
      return realpathSync(nodeModulesPath);
    } catch {
      return nodeModulesPath;
    }
  } catch {
    return null;
  }
}

function assertSafeNpmInstallTarget(repoRoot: string): void {
  const target = symlinkedNodeModulesTarget(repoRoot);
  if (!target) {
    return;
  }
  const sharedRepoHint = path.basename(target) === 'node_modules'
    ? path.dirname(target)
    : null;
  const rerun = sharedRepoHint
    ? `Run \`pipelane update\` from the shared checkout instead: cd ${sharedRepoHint} && pipelane update`
    : 'Run `pipelane update` from a checkout whose node_modules is a real directory, not a symlink.';
  throw new Error([
    `Refusing to run npm install for pipelane update in ${repoRoot} because node_modules is a symlink to ${target}.`,
    'Running npm install/update through a symlinked node_modules can remove or corrupt the shared dependency tree.',
    rerun,
  ].join('\n'));
}

function emitGlobalSurfaceRefreshHint(result: GlobalSurfaceRefresh): void {
  const lines: string[] = [];
  if (result.codex.status === 'refreshed') {
    lines.push('Refreshed machine-local Codex commands. Restart Codex if command discovery is already loaded.');
  } else if (result.codex.status === 'failed') {
    lines.push(`Machine-local Codex refresh failed: ${result.codex.detail}`);
  }

  if (result.claude.status === 'refreshed') {
    lines.push('Refreshed machine-local Claude commands. Restart Claude if skill discovery is already loaded.');
  } else if (result.claude.status === 'failed') {
    lines.push(`Machine-local Claude refresh failed: ${result.claude.detail}`);
  }

  if (lines.length > 0) {
    process.stdout.write(`\n${lines.join('\n')}\n`);
  }
}

function emitDriftHint(result: DriftResult): void {
  if (result.error) {
    process.stdout.write(`\n[pipelane] Skipped drift detection: ${result.error}\n`);
    process.stdout.write('Run `pipelane init` or `pipelane bootstrap` to enable setup follow-up.\n');
    return;
  }
  const drift = result.drift;
  if (!drift) return;
  if (!drift.needsSetup) {
    process.stdout.write('\nNo additional steps required — templates are in sync.\n');
    return;
  }
  process.stdout.write('\n' + formatFollowUpSummary(drift) + '\n');
}

function emitReopenHints(drift: SetupDrift): void {
  if (drift.needsReopenClaude) {
    process.stdout.write('Reopen Claude so the new or renamed slash commands appear.\n');
  }
  if (drift.needsReopenCodex) {
    process.stdout.write('Reopen Codex to pick up .agents/skills changes.\n');
  }
}

export function formatFollowUpSummary(drift: SetupDrift): string {
  const lines: string[] = ['Follow-up needed:'];
  const changes: string[] = [];
  if (drift.claude.enabled) {
    const added = truncateList(drift.claude.addedCommands);
    const updated = truncateList(drift.claude.updatedCommands);
    const removed = truncateList(drift.claude.removedLegacyCommands);
    if (added) changes.push(`New slash commands: ${added}`);
    if (updated) changes.push(`Updated commands: ${updated}`);
    if (removed) changes.push(`Legacy commands to prune: ${removed}`);
  }
  if (drift.repoGuidance.willScaffold) {
    changes.push('REPO_GUIDANCE.md scaffold available');
  }
  if (drift.codex.enabled) {
    const added = truncateList(drift.codex.addedSkills);
    const updated = truncateList(drift.codex.updatedSkills);
    const removed = truncateList(drift.codex.removedLegacySkills);
    if (added) changes.push(`New Codex skills: ${added}`);
    if (updated) changes.push(`Updated Codex skills: ${updated}`);
    if (removed) changes.push(`Legacy Codex skills to prune: ${removed}`);
    if (drift.codex.runnerDrift) changes.push('Codex runner script updated');
  }
  if (drift.otherSurfaces.length > 0) {
    changes.push(`Other surfaces to re-render: ${drift.otherSurfaces.join(', ')}`);
  }
  if (drift.claude.collisions.length > 0) {
    // Collisions block setup. Surface them prominently; no "run setup"
    // step, no reopen hint.
    return [
      'Setup cannot run — collision with existing non-pipelane files:',
      ...drift.claude.collisions.map((file) => `  - .claude/commands/${file}`),
      'Resolve these manually (rename, remove, or change the alias in .pipelane.json), then rerun `pipelane update`.',
    ].join('\n');
  }
  lines.push('  1. Run setup to apply template changes:');
  for (const change of changes) {
    lines.push(`     - ${change}`);
  }
  let step = 2;
  if (drift.needsReopenClaude) {
    lines.push(`  ${step++}. Reopen Claude so the new or renamed slash commands appear.`);
  }
  if (drift.needsReopenCodex) {
    lines.push(`  ${step++}. Reopen Codex to pick up .agents/skills changes.`);
  }
  return lines.join('\n');
}

function truncateList(entries: string[], cap = 8): string {
  if (entries.length === 0) return '';
  if (entries.length <= cap) return entries.join(', ');
  return `${entries.slice(0, cap).join(', ')}, +${entries.length - cap} more`;
}

export function collectUpdateStatus(repoRoot: string): UpdateStatus {
  const { installedSha, installedVersion } = resolveInstalledPipelane(repoRoot);
  const latestSha = fetchLatestMainSha();
  const upToDate = Boolean(installedSha) && installedSha === latestSha;

  let aheadBy: number | null = null;
  let commits: Array<{ sha: string; subject: string }> = [];
  if (!upToDate && installedSha) {
    const compare = fetchCompare(installedSha, latestSha);
    if (compare) {
      aheadBy = compare.aheadBy;
      commits = compare.commits;
    }
  }

  return {
    repoRoot,
    installedSha,
    installedShaShort: shortSha(installedSha),
    latestSha,
    latestShaShort: shortSha(latestSha),
    installedVersion,
    upToDate,
    aheadBy,
    commits,
  };
}

function resolveInstalledPipelane(repoRoot: string): { installedSha: string; installedVersion: string } {
  const packagePath = path.join(repoRoot, 'node_modules', 'pipelane', 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(
      `pipelane is not installed in ${repoRoot}. Install it with: npm install --save-dev ${resolvePipelaneInstallSpec()}`,
    );
  }
  const installedVersion = readInstalledVersion(packagePath);
  const installedSha = readInstalledShaFromLock(repoRoot);
  return { installedSha, installedVersion };
}

function readInstalledVersion(packagePath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version?.trim() ?? '';
  } catch {
    return '';
  }
}

function readInstalledShaFromLock(repoRoot: string): string {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  if (!existsSync(lockPath)) return '';
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages?: Record<string, { resolved?: string }>;
      dependencies?: Record<string, { resolved?: string }>;
    };
    const entries: Array<{ resolved?: string } | undefined> = [
      parsed.packages?.['node_modules/pipelane'],
      parsed.dependencies?.pipelane,
    ];
    for (const entry of entries) {
      const sha = extractShaFromResolved(entry?.resolved);
      if (sha) return sha;
    }
  } catch {
    // fall through
  }
  return '';
}

function extractShaFromResolved(resolved: string | undefined): string {
  if (!resolved) return '';
  const hashIndex = resolved.lastIndexOf('#');
  if (hashIndex === -1) return '';
  const candidate = resolved.slice(hashIndex + 1).trim();
  return /^[a-f0-9]{7,40}$/i.test(candidate) ? candidate.toLowerCase() : '';
}

function fetchLatestMainSha(): string {
  const result = runCommandCapture('git', ['ls-remote', PIPELANE_GITHUB_URL, 'main']);
  if (!result.ok || !result.stdout) {
    throw new Error(
      `Could not fetch latest main SHA from ${PIPELANE_GITHUB_URL}: ${result.stderr || 'no output'}`,
    );
  }
  const sha = result.stdout.split(/\s+/)[0]?.trim() ?? '';
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`Unexpected git ls-remote output: ${result.stdout}`);
  }
  return sha.toLowerCase();
}

function fetchCompare(
  fromSha: string,
  toSha: string,
): { aheadBy: number; commits: Array<{ sha: string; subject: string }> } | null {
  const result = runCommandCapture('gh', [
    'api',
    `repos/${PIPELANE_REPO_SLUG}/compare/${fromSha}...${toSha}`,
  ]);
  if (!result.ok || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      ahead_by?: number;
      commits?: Array<{ sha: string; commit: { message: string } }>;
    };
    const commits = (parsed.commits ?? []).map((entry) => ({
      sha: entry.sha,
      subject: entry.commit.message.split('\n', 1)[0] ?? '',
    }));
    return { aheadBy: parsed.ahead_by ?? commits.length, commits };
  } catch {
    return null;
  }
}

function installLatest(repoRoot: string, options: { quiet?: boolean } = {}): void {
  const result = runCommandCapture('npm', ['install', resolvePipelaneInstallSpec()], { cwd: repoRoot });
  if (!result.ok) {
    const detail = result.stderr || result.stdout;
    throw new Error(`npm install failed:\n${detail}`);
  }
  if (!options.quiet && result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (!options.quiet && result.stderr) process.stderr.write(`${result.stderr}\n`);
}

function buildStatusMessage(status: UpdateStatus): string {
  if (status.upToDate) {
    return `pipelane is up to date (${status.installedShaShort}).`;
  }

  const lines = [
    `pipelane has updates available.`,
    `  Installed: ${status.installedShaShort || '(unknown sha)'} (v${status.installedVersion || '?'})`,
    `  Latest main: ${status.latestShaShort}`,
  ];
  if (status.aheadBy !== null) {
    lines.push(`  ${status.aheadBy} commit${status.aheadBy === 1 ? '' : 's'} ahead.`);
  }
  if (status.commits.length > 0) {
    lines.push('');
    lines.push('Commits since install:');
    for (const commit of status.commits.slice(0, 20)) {
      lines.push(`  ${commit.sha.slice(0, 7)} ${commit.subject}`);
    }
    if (status.commits.length > 20) {
      lines.push(`  … (+${status.commits.length - 20} more)`);
    }
  }
  return lines.join('\n');
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : '';
}

function printUsage(): void {
  process.stdout.write(`pipelane update — check for and install the latest pipelane from jokim1/pipelane#main

Usage:
  pipelane update           Check and install if behind; auto-run setup if needed
  pipelane update --check   Report status without mutating
  pipelane update --json    Emit JSON status/result; never auto-runs setup
  pipelane update --yes     Backward-compat no-op (update no longer prompts)
`);
}
