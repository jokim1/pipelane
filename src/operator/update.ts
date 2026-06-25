import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stopDashboardForRepo } from '../dashboard/launcher.ts';
import { installClaudeBootstrapSkill } from './claude-install.ts';
import { installCodexBootstrapSkill } from './codex-install.ts';
import {
  applyAgentsGuidanceMigrationsWithApproval,
  detectSetupDrift,
  formatAgentsGuidanceMigrations,
  formatSetupResult,
  type SetupConsumerRepoResult,
  type SetupDrift,
  setupConsumerRepo,
} from './docs.ts';
import { PIPELANE_GITHUB_URL, PIPELANE_REPO_SLUG, resolvePipelaneInstallSpec, resolvePipelaneInstallSpecForSha } from './install-source.ts';
import { homeClaudeDir, homeCodexDir, readJsonFile, resolveRepoRoot, runCommandCapture, runGit, writeJsonFile } from './state.ts';

export interface UpdateOptions {
  check: boolean;
  yes: boolean;
  json: boolean;
  output?: UpdateOutputTarget;
  initialStatus?: UpdateStatus;
  postInstallLatestSha?: string;
  stopBoard?: boolean;
  followUp?: boolean;
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

export type UpdateOutputTarget = 'stdout' | 'stderr' | 'silent';

export interface AutoUpdateResult {
  checked: boolean;
  updated: boolean;
  skippedReason: string | null;
  status: UpdateStatus | null;
}

interface AutoUpdateCache {
  checkedAt: string;
  installedSha: string;
  latestSha: string;
  upToDate: boolean;
  aheadBy?: number | null;
  commits?: Array<{ sha: string; subject: string }>;
}

const AUTO_UPDATE_DEFAULT_TTL_MS = 60 * 60 * 1000;
const AUTO_UPDATE_AVAILABLE_DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const AUTO_UPDATE_DEFAULT_TIMEOUT_MS = 5000;
const AUTO_UPDATE_REFRESH_LOCK_TTL_MS = 30 * 1000;

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

export async function maybeAutoUpdate(cwd: string): Promise<AutoUpdateResult> {
  if (autoUpdateDisabled()) {
    return { checked: false, updated: false, skippedReason: 'disabled', status: null };
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(cwd, true);
  } catch (error) {
    return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status: null };
  }

  const updateRoot = resolveAutoUpdateRoot(repoRoot);
  if (!updateRoot) {
    return { checked: false, updated: false, skippedReason: 'node_modules symlink target does not identify a shared repo checkout', status: null };
  }

  const packagePath = path.join(updateRoot, 'node_modules', 'pipelane', 'package.json');
  if (!existsSync(packagePath)) {
    return { checked: false, updated: false, skippedReason: 'pipelane is not installed in node_modules', status: null };
  }

  const installedSha = readInstalledShaFromLock(updateRoot);
  if (!installedSha) {
    return { checked: false, updated: false, skippedReason: 'installed pipelane commit is unknown', status: null };
  }

  const cached = readFreshAutoUpdateCache(updateRoot, installedSha);
  if (cached) {
    const status = {
      repoRoot: updateRoot,
      installedSha,
      installedShaShort: shortSha(installedSha),
      latestSha: cached.latestSha,
      latestShaShort: shortSha(cached.latestSha),
      installedVersion: readInstalledVersion(packagePath),
      upToDate: cached.upToDate,
      aheadBy: typeof cached.aheadBy === 'number' ? cached.aheadBy : null,
      commits: normalizeCachedCommits(cached.commits),
    };
    if (status.upToDate) {
      return {
        checked: false,
        updated: false,
        skippedReason: 'fresh cache',
        status,
      };
    }
    if (!autoInstallEnabled()) {
      process.stderr.write(formatAutoUpdateNotice(status));
      return { checked: false, updated: false, skippedReason: 'notify-only fresh cache', status };
    }
    try {
      process.stderr.write(`[pipelane] Auto-updating pipelane ${status.installedShaShort || '(unknown)'} -> ${status.latestShaShort} before continuing.\n`);
      const result = await runUpdate(updateRoot, {
        check: false,
        yes: true,
        json: false,
        output: 'stderr',
        initialStatus: status,
        postInstallLatestSha: status.latestSha,
        stopBoard: false,
        followUp: false,
      });
      return { checked: false, updated: result.action === 'installed', skippedReason: null, status: result.status };
    } catch (error) {
      process.stderr.write(`[pipelane] Auto-update skipped: ${error instanceof Error ? error.message : String(error)}\n`);
      return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status };
    }
  }

  if (!autoInstallEnabled()) {
    const scheduled = startDetachedAutoUpdateRefresh(updateRoot);
    return {
      checked: false,
      updated: false,
      skippedReason: scheduled ? 'refresh scheduled' : 'refresh already running',
      status: null,
    };
  }

  let status: UpdateStatus;
  try {
    status = collectUpdateStatus(updateRoot, { timeoutMs: autoUpdateTimeoutMs() });
  } catch (error) {
    return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status: null };
  }

  if (status.upToDate) {
    writeAutoUpdateCache(updateRoot, status);
    return { checked: true, updated: false, skippedReason: null, status };
  }

  try {
    process.stderr.write(`[pipelane] Auto-updating pipelane ${status.installedShaShort || '(unknown)'} -> ${status.latestShaShort} before continuing.\n`);
    const result = await runUpdate(updateRoot, {
      check: false,
      yes: true,
      json: false,
      output: 'stderr',
      initialStatus: status,
      postInstallLatestSha: status.latestSha,
      stopBoard: false,
      followUp: false,
    });
    return { checked: true, updated: result.action === 'installed', skippedReason: null, status: result.status };
  } catch (error) {
    process.stderr.write(`[pipelane] Auto-update skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    return { checked: true, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status };
  }
}

export function refreshAutoUpdateCache(cwd: string): AutoUpdateResult {
  if (autoUpdateDisabled()) {
    return { checked: false, updated: false, skippedReason: 'disabled', status: null };
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(cwd, true);
  } catch (error) {
    return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status: null };
  }

  const updateRoot = resolveAutoUpdateRoot(repoRoot);
  if (!updateRoot) {
    return { checked: false, updated: false, skippedReason: 'node_modules symlink target does not identify a shared repo checkout', status: null };
  }

  const packagePath = path.join(updateRoot, 'node_modules', 'pipelane', 'package.json');
  if (!existsSync(packagePath)) {
    return { checked: false, updated: false, skippedReason: 'pipelane is not installed in node_modules', status: null };
  }

  const installedSha = readInstalledShaFromLock(updateRoot);
  if (!installedSha) {
    return { checked: false, updated: false, skippedReason: 'installed pipelane commit is unknown', status: null };
  }

  const inheritedLock = process.env.PIPELANE_AUTO_UPDATE_REFRESH_LOCK?.trim();
  const lockPath = inheritedLock || tryAcquireAutoUpdateRefreshLock(updateRoot);
  if (!lockPath) {
    return { checked: false, updated: false, skippedReason: 'refresh already running', status: null };
  }

  try {
    const status = collectUpdateStatus(updateRoot, { timeoutMs: autoUpdateTimeoutMs() });
    writeAutoUpdateCache(updateRoot, status);
    return { checked: true, updated: false, skippedReason: null, status };
  } catch (error) {
    writeAutoUpdateCache(updateRoot, {
      repoRoot: updateRoot,
      installedSha,
      installedShaShort: shortSha(installedSha),
      latestSha: installedSha,
      latestShaShort: shortSha(installedSha),
      installedVersion: readInstalledVersion(packagePath),
      upToDate: true,
      aheadBy: null,
      commits: [],
    });
    return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status: null };
  } finally {
    releaseAutoUpdateRefreshLock(lockPath);
  }
}

function resolveAutoUpdateRoot(repoRoot: string): string | null {
  const symlinkTarget = symlinkedNodeModulesTarget(repoRoot);
  if (!symlinkTarget) {
    return repoRoot;
  }
  if (path.basename(symlinkTarget) !== 'node_modules') {
    return null;
  }
  const sharedRepoRoot = path.dirname(symlinkTarget);
  const expectedSharedRoot = expectedSharedRepoRoot(repoRoot);
  if (!expectedSharedRoot || normalizeAutoUpdatePath(sharedRepoRoot) !== normalizeAutoUpdatePath(expectedSharedRoot)) {
    return null;
  }
  if (!existsSync(path.join(sharedRepoRoot, 'package-lock.json'))) {
    return null;
  }
  return sharedRepoRoot;
}

function expectedSharedRepoRoot(repoRoot: string): string | null {
  const commonDir = runGit(repoRoot, ['rev-parse', '--git-common-dir'], true);
  if (!commonDir) {
    return null;
  }
  const normalizedCommonDir = normalizeAutoUpdatePath(path.isAbsolute(commonDir) ? commonDir : path.join(repoRoot, commonDir));
  if (normalizedCommonDir.includes(`${path.sep}.git${path.sep}modules${path.sep}`)) {
    return null;
  }
  return path.dirname(normalizedCommonDir);
}

function normalizeAutoUpdatePath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export async function runUpdate(cwd: string, options: UpdateOptions): Promise<UpdateResult> {
  const repoRoot = resolveRepoRoot(cwd, true);
  const status = options.initialStatus ?? collectUpdateStatus(repoRoot);

  // --check path (pre-install) and upToDate path: run drift detection so the
  // operator sees whether the consumer's working tree is in sync with the
  // currently-installed pipelane, even when no upstream update exists.
  if (options.check || status.upToDate) {
    let driftResult = tryDetectDrift(repoRoot);
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
    writeUpdateOutput(options, `${summary}\n`);
    emitGlobalSurfaceRefreshHint(globalSurfaces, options);
    if (!options.check) {
      const appliedAgentsMigration = await maybeApplyAgentsGuidanceMigrationsFromDrift(driftResult.drift, options.yes);
      if (appliedAgentsMigration) {
        driftResult = tryDetectDrift(repoRoot);
      }
    }
    emitDriftHint(driftResult, options);
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
  if (!options.json) writeUpdateOutput(options, `${summary}\n`);

  const npmInstallTarget = prepareSafeNpmInstallTarget(repoRoot, options);
  try {
    installLatest(repoRoot, {
      quiet: options.json,
      output: options.output,
      installSpec: resolvePipelaneInstallSpecForSha(status.latestSha),
    });
  } catch (error) {
    try {
      npmInstallTarget.restoreOnFailure();
    } catch (restoreError) {
      const installDetail = error instanceof Error ? error.message : String(error);
      const restoreDetail = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error([
        'npm install failed after replacing symlinked node_modules, and restoring the original symlink also failed:',
        installDetail,
        '',
        'node_modules restore failed:',
        restoreDetail,
      ].join('\n'));
    }
    throw error;
  }
  const boardStop = options.stopBoard === false
    ? { stopped: false, pid: null, reason: 'dashboard stop skipped' }
    : await stopDashboardForRepo(repoRoot);

  const after = options.postInstallLatestSha
    ? collectUpdateStatusFromKnownLatest(repoRoot, options.postInstallLatestSha)
    : collectUpdateStatus(repoRoot);
  const tail = after.upToDate
    ? `Installed ${after.installedShaShort} (up to date).`
    : `Installed pipelane; now at ${after.installedShaShort} (remote main: ${after.latestShaShort}).`;
  const message = `Upgrade complete.\n${tail}`;

  if (options.followUp === false) {
    const result: UpdateResult = {
      status: after,
      action: 'installed',
      message,
      followUpSteps: null,
      ranSetup: false,
      globalSurfaces: skippedGlobalSurfaces('implicit auto-update install-only'),
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result;
    }
    if (!options.json) {
      writeUpdateOutput(options, `${message}\n`);
    }
    return result;
  }

  let driftResult = tryDetectDrift(repoRoot);
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

  writeUpdateOutput(options, `${message}\n`);
  if (boardStop.stopped) {
    writeUpdateOutput(options, `Stopped existing Pipelane Board (PID ${boardStop.pid}) so the next board start uses the updated package.\n`);
  }
  emitGlobalSurfaceRefreshHint(globalSurfaces, options);
  if (!driftResult.drift?.needsSetup) {
    const appliedAgentsMigration = await maybeApplyAgentsGuidanceMigrationsFromDrift(driftResult.drift, options.yes);
    if (appliedAgentsMigration) {
      driftResult = tryDetectDrift(repoRoot);
    }
  }
  emitDriftHint(driftResult, options);

  let ranSetup = false;
  const drift = driftResult.drift;
  if (drift?.needsSetup && drift.claude.collisions.length === 0) {
    const setupResult = await maybeApplyAgentsGuidanceMigrationsFromSetupResult(
      setupConsumerRepo(repoRoot),
      options.yes,
    );
    writeUpdateOutput(options, '\n' + formatSetupResult(setupResult).join('\n') + '\n');
    emitReopenHints(drift, options);
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

function writeUpdateOutput(options: Pick<UpdateOptions, 'output'>, text: string): void {
  const target = options.output ?? 'stdout';
  if (target === 'silent') {
    return;
  }
  if (target === 'stderr') {
    process.stderr.write(text);
    return;
  }
  process.stdout.write(text);
}

function autoUpdateDisabled(): boolean {
  if (process.env.PIPELANE_AUTO_UPDATE_REEXECED === '1') {
    return true;
  }
  const raw = process.env.PIPELANE_AUTO_UPDATE?.trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

// Self-update (auto-installing the newer main on `run`) is OPT-IN. The default
// is notify-only: pipelane reports that an update exists and how to apply it,
// but does not install — auto-installing rewrote the consumer's package.json
// pipelane pin (github:…#main -> #<sha>) on every run. Opt back into automatic
// upgrades with PIPELANE_AUTO_UPDATE=1 (or true/on/yes/auto/install).
function autoInstallEnabled(): boolean {
  const raw = process.env.PIPELANE_AUTO_UPDATE?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes' || raw === 'auto' || raw === 'install';
}

function autoUpdateTtlMs(upToDate = true): number {
  const raw = process.env.PIPELANE_AUTO_UPDATE_TTL_MS?.trim();
  if (!raw) {
    return upToDate ? AUTO_UPDATE_DEFAULT_TTL_MS : AUTO_UPDATE_AVAILABLE_DEFAULT_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : (upToDate ? AUTO_UPDATE_DEFAULT_TTL_MS : AUTO_UPDATE_AVAILABLE_DEFAULT_TTL_MS);
}

function autoUpdateTimeoutMs(): number {
  const raw = process.env.PIPELANE_AUTO_UPDATE_TIMEOUT_MS?.trim();
  if (!raw) {
    return AUTO_UPDATE_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AUTO_UPDATE_DEFAULT_TIMEOUT_MS;
}

function pipelaneHomeDir(): string {
  return process.env.PIPELANE_HOME || path.join(os.homedir(), '.pipelane');
}

function autoUpdateCachePath(repoRoot: string): string {
  return path.join(pipelaneHomeDir(), 'update-checks', `${autoUpdateCacheKey(repoRoot)}.json`);
}

function autoUpdateRefreshLockPath(repoRoot: string): string {
  return path.join(pipelaneHomeDir(), 'update-checks', `${autoUpdateCacheKey(repoRoot)}.lock`);
}

function autoUpdateCacheKey(repoRoot: string): string {
  let resolved = repoRoot;
  try {
    resolved = realpathSync(repoRoot);
  } catch {
    // Use the normalized repo root if the path cannot be resolved.
  }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 24);
}

function startDetachedAutoUpdateRefresh(updateRoot: string): boolean {
  if (process.env.PIPELANE_REFRESH_UPDATE_CACHE === '1') {
    return false;
  }
  const cliPath = process.argv[1];
  if (!cliPath) {
    return false;
  }
  const lockPath = tryAcquireAutoUpdateRefreshLock(updateRoot);
  if (!lockPath) {
    return false;
  }

  try {
    const child = spawn(process.execPath, [cliPath], {
      cwd: updateRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PIPELANE_REFRESH_UPDATE_CACHE: '1',
        PIPELANE_AUTO_UPDATE_REFRESH_LOCK: lockPath,
      },
    });
    child.on('error', () => releaseAutoUpdateRefreshLock(lockPath));
    child.unref();
    return true;
  } catch {
    releaseAutoUpdateRefreshLock(lockPath);
    return false;
  }
}

function tryAcquireAutoUpdateRefreshLock(repoRoot: string): string | null {
  const lockPath = autoUpdateRefreshLockPath(repoRoot);
  const tryOpen = (): string | null => {
    try {
      mkdirSync(path.dirname(lockPath), { recursive: true });
      const fd = openSync(lockPath, 'wx', 0o600);
      closeSync(fd);
      return lockPath;
    } catch {
      return null;
    }
  };

  const acquired = tryOpen();
  if (acquired) {
    return acquired;
  }

  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > AUTO_UPDATE_REFRESH_LOCK_TTL_MS) {
      unlinkSync(lockPath);
      return tryOpen();
    }
  } catch {
    return tryOpen();
  }
  return null;
}

function releaseAutoUpdateRefreshLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Lock cleanup is best-effort. Stale locks expire quickly.
  }
}

function readFreshAutoUpdateCache(repoRoot: string, installedSha: string): AutoUpdateCache | null {
  try {
    const cachePath = autoUpdateCachePath(repoRoot);
    if (!existsSync(cachePath)) {
      return null;
    }
    const cache = readJsonFile<AutoUpdateCache | null>(cachePath, null);
    if (!cache || cache.installedSha !== installedSha || !cache.latestSha || !cache.checkedAt || typeof cache.upToDate !== 'boolean') {
      return null;
    }
    const checkedAt = Date.parse(cache.checkedAt);
    if (!Number.isFinite(checkedAt)) {
      return null;
    }
    if (Date.now() - checkedAt > autoUpdateTtlMs(cache.upToDate)) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function normalizeCachedCommits(value: unknown): Array<{ sha: string; subject: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { sha: string; subject: string } =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as { sha?: unknown }).sha === 'string' &&
      typeof (entry as { subject?: unknown }).subject === 'string',
    )
    .map((entry) => ({ sha: entry.sha, subject: entry.subject }));
}

function writeAutoUpdateCache(repoRoot: string, status: UpdateStatus): void {
  try {
    writeJsonFile(autoUpdateCachePath(repoRoot), {
      checkedAt: new Date().toISOString(),
      installedSha: status.installedSha,
      latestSha: status.latestSha,
      upToDate: status.upToDate,
      aheadBy: status.aheadBy,
      commits: status.commits,
    } satisfies AutoUpdateCache);
  } catch {
    // Cache failures must never block the actual pipelane command.
  }
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

async function maybeApplyAgentsGuidanceMigrationsFromDrift(
  drift: SetupDrift | null,
  yes: boolean,
): Promise<boolean> {
  const migrations = drift?.agentsGuidanceMigrations ?? [];
  const applied = await applyAgentsGuidanceMigrationsWithApproval(migrations, { yes });
  return applied.length > 0;
}

async function maybeApplyAgentsGuidanceMigrationsFromSetupResult(
  result: SetupConsumerRepoResult,
  yes: boolean,
): Promise<SetupConsumerRepoResult> {
  const applied = await applyAgentsGuidanceMigrationsWithApproval(result.agentsGuidanceMigrations, { yes });
  if (applied.length === 0) {
    return result;
  }
  return {
    ...result,
    agentsGuidanceMigrations: [],
    appliedAgentsGuidanceMigrations: [
      ...result.appliedAgentsGuidanceMigrations,
      ...applied,
    ],
  };
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

interface PreparedNpmInstallTarget {
  restoreOnFailure(): void;
}

function prepareSafeNpmInstallTarget(repoRoot: string, options: UpdateOptions): PreparedNpmInstallTarget {
  const target = symlinkedNodeModulesTarget(repoRoot);
  if (!target) {
    return { restoreOnFailure() {} };
  }
  if (path.basename(target) !== 'node_modules') {
    throw new Error([
      `Refusing to run npm install for pipelane update in ${repoRoot} because node_modules is a symlink to ${target}.`,
      'Run `pipelane update` from a checkout whose node_modules is a real directory, not a symlink.',
    ].join('\n'));
  }

  const nodeModulesPath = path.join(repoRoot, 'node_modules');
  unlinkSync(nodeModulesPath);
  mkdirSync(nodeModulesPath, { recursive: true });

  if (!options.json) {
    writeUpdateOutput(
      options,
      `[pipelane] Replaced symlinked node_modules with a local directory before running npm install; shared dependencies at ${target} were left untouched.\n`,
    );
  }

  return {
    restoreOnFailure() {
      rmSync(nodeModulesPath, { recursive: true, force: true });
      symlinkSync(target, nodeModulesPath, 'dir');
    },
  };
}

function emitGlobalSurfaceRefreshHint(result: GlobalSurfaceRefresh, options: Pick<UpdateOptions, 'output'>): void {
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
    writeUpdateOutput(options, `\n${lines.join('\n')}\n`);
  }
}

function emitDriftHint(result: DriftResult, options: Pick<UpdateOptions, 'output'>): void {
  if (result.error) {
    writeUpdateOutput(options, `\n[pipelane] Skipped drift detection: ${result.error}\n`);
    writeUpdateOutput(options, 'Run `pipelane init` or `pipelane bootstrap` to enable setup follow-up.\n');
    return;
  }
  const drift = result.drift;
  if (!drift) return;
  const warnings = drift.warnings ?? [];
  const agentsGuidanceMigrations = drift.agentsGuidanceMigrations ?? [];
  if (!drift.needsSetup) {
    if (agentsGuidanceMigrations.length > 0) {
      writeUpdateOutput(options, '\nAGENTS.md guidance migration requires approval:\n');
      writeUpdateOutput(options, formatAgentsGuidanceMigrations(agentsGuidanceMigrations).join('\n') + '\n');
      writeUpdateOutput(options, 'Run `pipelane setup --yes` to apply these AGENTS.md changes non-interactively, or run `pipelane setup` in a TTY and approve the prompt.\n');
      return;
    }
    if (warnings.length > 0) {
      writeUpdateOutput(options, '\nReadiness warnings:\n');
      writeUpdateOutput(options, warnings.map((warning) => `- ${warning}`).join('\n') + '\n');
      return;
    }
    writeUpdateOutput(options, '\nNo additional steps required — templates are in sync.\n');
    return;
  }
  writeUpdateOutput(options, '\n' + formatFollowUpSummary(drift) + '\n');
}

function emitReopenHints(drift: SetupDrift, options: Pick<UpdateOptions, 'output'>): void {
  if (drift.needsReopenClaude) {
    writeUpdateOutput(options, 'Reopen Claude so the new or renamed slash commands appear.\n');
  }
  if (drift.needsReopenCodex) {
    writeUpdateOutput(options, 'Reopen Codex to pick up .agents/skills changes.\n');
  }
}

export function formatFollowUpSummary(drift: SetupDrift): string {
  const lines: string[] = ['Follow-up needed:'];
  const changes: string[] = [];
  const warnings = drift.warnings ?? [];
  const agentsGuidanceMigrations = drift.agentsGuidanceMigrations ?? [];
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
  if (drift.claudeGuidance?.willScaffold) {
    changes.push('CLAUDE.md scaffold available');
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
  if (agentsGuidanceMigrations.length > 0) {
    const count = agentsGuidanceMigrations.reduce((sum, migration) => sum + migration.replacements.length, 0);
    changes.push(`AGENTS.md guidance migration requires approval (${count} line${count === 1 ? '' : 's'})`);
  }
  if (warnings.length > 0) {
    changes.push(`Readiness warnings: ${warnings.join(' ')}`);
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

export function collectUpdateStatus(
  repoRoot: string,
  options: { timeoutMs?: number } = {},
): UpdateStatus {
  const { installedSha, installedVersion } = resolveInstalledPipelane(repoRoot);
  const deadlineMs = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
  const latestSha = fetchLatestMainSha(remainingUpdateTimeoutMs(deadlineMs, options.timeoutMs));
  const upToDate = Boolean(installedSha) && installedSha === latestSha;

  let aheadBy: number | null = null;
  let commits: Array<{ sha: string; subject: string }> = [];
  if (!upToDate && installedSha) {
    const compare = fetchCompare(installedSha, latestSha, remainingUpdateTimeoutMs(deadlineMs, options.timeoutMs));
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

function collectUpdateStatusFromKnownLatest(repoRoot: string, latestSha: string): UpdateStatus {
  const { installedSha, installedVersion } = resolveInstalledPipelane(repoRoot);
  const normalizedLatestSha = latestSha.toLowerCase();
  return {
    repoRoot,
    installedSha,
    installedShaShort: shortSha(installedSha),
    latestSha: normalizedLatestSha,
    latestShaShort: shortSha(normalizedLatestSha),
    installedVersion,
    upToDate: Boolean(installedSha) && installedSha === normalizedLatestSha,
    aheadBy: null,
    commits: [],
  };
}

function remainingUpdateTimeoutMs(deadlineMs: number | null, originalTimeoutMs: number | undefined): number | undefined {
  if (deadlineMs === null || originalTimeoutMs === undefined) {
    return undefined;
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Timed out after ${originalTimeoutMs}ms while checking for pipelane updates.`);
  }
  return Math.max(1, Math.floor(remainingMs));
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

function fetchLatestMainSha(timeoutMs?: number): string {
  const result = runCommandCapture('git', ['ls-remote', PIPELANE_GITHUB_URL, 'main'], { timeoutMs });
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
  timeoutMs?: number,
): { aheadBy: number; commits: Array<{ sha: string; subject: string }> } | null {
  const result = runCommandCapture('gh', [
    'api',
    `repos/${PIPELANE_REPO_SLUG}/compare/${fromSha}...${toSha}`,
  ], { timeoutMs });
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

function installLatest(repoRoot: string, options: { quiet?: boolean; output?: UpdateOutputTarget; installSpec?: string } = {}): void {
  const result = runCommandCapture('npm', ['install', options.installSpec ?? resolvePipelaneInstallSpec()], { cwd: repoRoot });
  if (!result.ok) {
    const detail = result.stderr || result.stdout;
    throw new Error(`npm install failed:\n${detail}`);
  }
  if (options.quiet) {
    return;
  }
  if (result.stdout) {
    writeUpdateOutput({ output: options.output }, `${result.stdout}\n`);
  }
  if (result.stderr) {
    const target = options.output === 'silent' ? 'silent' : 'stderr';
    writeUpdateOutput({ output: target }, `${result.stderr}\n`);
  }
}

export function formatAutoUpdateNotice(status: UpdateStatus): string {
  const installed = status.installedShaShort || '(unknown)';
  const lines = [
    `[pipelane] New Pipelane update available (${installed} -> ${status.latestShaShort}).`,
    '[pipelane] Run `/pipelane update` to install it, or `pipelane update` from a shell.',
    `[pipelane] ${formatAutoUpdateHighlights(status)}`,
  ];
  return `${lines.join('\n')}\n`;
}

function formatAutoUpdateHighlights(status: UpdateStatus): string {
  const subjects = status.commits
    .map((commit) => formatCommitSubjectSentence(commit.subject))
    .filter(Boolean);

  if (subjects.length > 0) {
    const visible = subjects.slice(0, 3);
    const total = status.aheadBy ?? status.commits.length;
    const hidden = total - visible.length;
    const more = total > visible.length
      ? ` ${hidden} more commit${hidden === 1 ? '' : 's'} ${hidden === 1 ? 'is' : 'are'} included.`
      : '';
    return `What's new: ${visible.join(' ')}${more}`;
  }

  if (status.aheadBy !== null) {
    return `This update includes ${status.aheadBy} commit${status.aheadBy === 1 ? '' : 's'} since your installed version. Run \`/pipelane update --check\` to inspect it before installing.`;
  }

  return 'Run `/pipelane update --check` to inspect the update before installing.';
}

function formatCommitSubjectSentence(subject: string): string {
  const normalized = subject.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const capped = normalized.length > 140
    ? `${normalized.slice(0, 137).trimEnd()}...`
    : normalized;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
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
  pipelane update --yes     Apply setup guidance migrations without prompting
`);
}
