import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stopDashboardForRepo } from '../dashboard/launcher.ts';
import { installClaudeBootstrapSkill } from './claude-install.ts';
import { installCodexBootstrapSkill } from './codex-install.ts';
import { readManagedRuntimeMetadata, type ManagedRuntimeMetadata } from './global-runtime.ts';
import {
  applyAgentsGuidanceMigrationsWithApproval,
  applyClaudeGuidanceMigrationsWithApproval,
  applyLessonsMigrationWithApproval,
  detectSetupDrift,
  formatAgentsGuidanceMigrations,
  formatClaudeGuidanceMigrations,
  formatLessonsMigration,
  formatSetupResult,
  type SetupDrift,
  setupConsumerRepo,
} from './docs.ts';
import { PIPELANE_GITHUB_URL, PIPELANE_REPO_SLUG, resolvePipelaneInstallSpecForSha } from './install-source.ts';
import { homeClaudeDir, homeCodexDir, pipelaneHomeDir, readJsonFile, resolveRepoRoot, runCommandCapture, writeJsonFile } from './state.ts';

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
  // Context-aware follow-up after update/check. Active setup is machine-local,
  // so repo-local adapter/doc/script drift should not become a setup trigger.
  // Null when detection couldn't run (missing machine-local config, etc.).
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
  failureReason?: string;
}

const AUTO_UPDATE_DEFAULT_TTL_MS = 60 * 60 * 1000;
const AUTO_UPDATE_AVAILABLE_DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const AUTO_UPDATE_DEFAULT_TIMEOUT_MS = 5000;
const AUTO_UPDATE_FAILURE_TTL_MS = 5 * 60 * 1000;
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

type ManagedRuntimeHost = 'codex' | 'claude';

interface ManagedRuntimeInstall {
  host: ManagedRuntimeHost;
  root: string;
  metadata: ManagedRuntimeMetadata | null;
  installed: boolean;
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

function managedRuntimeRoot(host: ManagedRuntimeHost): string {
  return path.join(pipelaneHomeDir(), 'runtimes', host);
}

function readManagedRuntimeInstall(host: ManagedRuntimeHost, root = managedRuntimeRoot(host)): ManagedRuntimeInstall {
  const metadata = readManagedRuntimeMetadata(root);
  const installed = Boolean(metadata) || existsSync(path.join(root, 'bin', 'pipelane'));
  return { host, root, metadata, installed };
}

function discoverManagedRuntimeInstalls(): ManagedRuntimeInstall[] {
  return [
    readManagedRuntimeInstall('codex'),
    readManagedRuntimeInstall('claude'),
  ].filter((install) => install.installed);
}

function currentManagedRuntimeInstall(): ManagedRuntimeInstall | null {
  const root = process.env.PIPELANE_MANAGED_RUNTIME_ROOT?.trim();
  if (!root) {
    return null;
  }
  const normalized = path.resolve(root);
  for (const host of ['codex', 'claude'] as const) {
    if (path.resolve(managedRuntimeRoot(host)) === normalized) {
      return readManagedRuntimeInstall(host, normalized);
    }
  }
  const metadata = readManagedRuntimeMetadata(normalized);
  return {
    host: metadata?.host === 'claude' ? 'claude' : 'codex',
    root: normalized,
    metadata,
    installed: Boolean(metadata) || existsSync(path.join(normalized, 'bin', 'pipelane')),
  };
}

function primaryManagedRuntimeInstall(): ManagedRuntimeInstall | null {
  const current = currentManagedRuntimeInstall();
  if (current?.installed) {
    return current;
  }
  return discoverManagedRuntimeInstalls()[0] ?? null;
}

function managedRuntimeSourceSha(install: ManagedRuntimeInstall | null): string {
  const sha = install?.metadata?.sourceSha?.trim() ?? '';
  return /^[a-f0-9]{7,40}$/i.test(sha) ? sha.toLowerCase() : '';
}

function managedRuntimeVersion(install: ManagedRuntimeInstall | null): string {
  return install?.metadata?.packageVersion?.trim()
    || (install ? readInstalledVersion(path.join(install.root, 'package.json')) : '');
}

export function maybeNotifyUpdate(cwd: string): AutoUpdateResult {
  if (autoUpdateDisabled()) {
    return { checked: false, updated: false, skippedReason: 'disabled', status: null };
  }

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(cwd, true);
  } catch (error) {
    return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status: null };
  }

  const runtime = primaryManagedRuntimeInstall();
  if (!runtime) {
    return { checked: false, updated: false, skippedReason: 'durable Pipelane runtime is not installed', status: null };
  }
  const installedSha = managedRuntimeSourceSha(runtime);
  if (!installedSha) {
    return { checked: false, updated: false, skippedReason: 'installed durable Pipelane commit is unknown', status: null };
  }

  const cached = readFreshAutoUpdateCache(repoRoot, installedSha);
  if (cached) {
    const status = {
      repoRoot,
      installedSha,
      installedShaShort: shortSha(installedSha),
      latestSha: cached.latestSha,
      latestShaShort: shortSha(cached.latestSha),
      installedVersion: managedRuntimeVersion(runtime),
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
    process.stderr.write(formatAutoUpdateNotice(status));
    return { checked: false, updated: false, skippedReason: 'notify-only fresh cache', status };
  }

  let status: UpdateStatus;
  try {
    status = collectUpdateStatus(repoRoot, { timeoutMs: autoUpdateTimeoutMs() });
  } catch (error) {
    writeAutoUpdateFailureCache(repoRoot, installedSha, error);
    return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status: null };
  }

  if (status.upToDate) {
    writeAutoUpdateCache(repoRoot, status);
    return { checked: true, updated: false, skippedReason: null, status };
  }

  writeAutoUpdateCache(repoRoot, status);
  process.stderr.write(formatAutoUpdateNotice(status));
  return { checked: true, updated: false, skippedReason: null, status };
}

export async function maybeAutoUpdate(cwd: string): Promise<AutoUpdateResult> {
  return maybeNotifyUpdate(cwd);
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

  const runtime = primaryManagedRuntimeInstall();
  if (!runtime) {
    return { checked: false, updated: false, skippedReason: 'durable Pipelane runtime is not installed', status: null };
  }
  const installedSha = managedRuntimeSourceSha(runtime);
  if (!installedSha) {
    return { checked: false, updated: false, skippedReason: 'installed durable Pipelane commit is unknown', status: null };
  }

  const inheritedLock = process.env.PIPELANE_AUTO_UPDATE_REFRESH_LOCK?.trim();
  const lockPath = inheritedLock || tryAcquireAutoUpdateRefreshLock(repoRoot);
  if (!lockPath) {
    return { checked: false, updated: false, skippedReason: 'refresh already running', status: null };
  }

  try {
    const status = collectUpdateStatus(repoRoot, { timeoutMs: autoUpdateTimeoutMs() });
    writeAutoUpdateCache(repoRoot, status);
    return { checked: true, updated: false, skippedReason: null, status };
  } catch (error) {
    writeAutoUpdateFailureCache(repoRoot, installedSha, error);
    return { checked: false, updated: false, skippedReason: error instanceof Error ? error.message : String(error), status: null };
  } finally {
    releaseAutoUpdateRefreshLock(lockPath);
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
    if (!options.check && !options.json) {
      driftResult = await applyUpdateGuidanceMigrations(repoRoot, driftResult, options);
    }
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

  // Behind main path: print the commit delta, refresh durable runtimes, detect
  // drift, run setup inline if needed. The user invoked `pipelane update` —
  // that is the consent. For read-only inspection, use `--check`.
  const summary = buildStatusMessage(status);
  if (!options.json) writeUpdateOutput(options, `${summary}\n`);

  const installRefresh = installLatestManagedRuntimes(status.latestSha, options);
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
  if (!options.json) {
    driftResult = await applyUpdateGuidanceMigrations(repoRoot, driftResult, options);
  }
  const globalSurfaces = installRefresh;

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
  emitDriftHint(driftResult, options);

  let ranSetup = false;
  const drift = driftResult.drift;
  if (drift?.needsSetup && drift.claude.collisions.length === 0) {
    const setupResult = setupConsumerRepo(repoRoot);
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

async function applyUpdateGuidanceMigrations(
  repoRoot: string,
  result: DriftResult,
  options: Pick<UpdateOptions, 'yes'>,
): Promise<DriftResult> {
  const drift = result.drift;
  if (!drift || result.error) {
    return result;
  }

  const appliedAgents = await applyAgentsGuidanceMigrationsWithApproval(
    drift.agentsGuidanceMigrations ?? [],
    { yes: options.yes },
  );
  const appliedClaude = await applyClaudeGuidanceMigrationsWithApproval(
    drift.claudeGuidanceMigrations ?? [],
    { yes: options.yes },
  );
  const appliedLessons = await applyLessonsMigrationWithApproval(
    drift.lessonsMigration ?? null,
    { yes: options.yes },
  );

  if (appliedAgents.length === 0 && appliedClaude.length === 0 && !appliedLessons) {
    return result;
  }
  return tryDetectDrift(repoRoot);
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

function autoUpdateFailureTtlMs(): number {
  return Math.min(AUTO_UPDATE_FAILURE_TTL_MS, autoUpdateTtlMs(true));
}

function autoUpdateTimeoutMs(): number {
  const raw = process.env.PIPELANE_AUTO_UPDATE_TIMEOUT_MS?.trim();
  if (!raw) {
    return AUTO_UPDATE_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AUTO_UPDATE_DEFAULT_TIMEOUT_MS;
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
    if (Date.now() - checkedAt > autoUpdateCacheTtlMs(cache)) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function autoUpdateCacheTtlMs(cache: AutoUpdateCache): number {
  if (cache.failureReason) {
    return autoUpdateFailureTtlMs();
  }
  if (!cache.upToDate && typeof cache.aheadBy !== 'number' && normalizeCachedCommits(cache.commits).length === 0) {
    return autoUpdateFailureTtlMs();
  }
  return autoUpdateTtlMs(cache.upToDate);
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

function writeAutoUpdateFailureCache(repoRoot: string, installedSha: string, error: unknown): void {
  try {
    writeJsonFile(autoUpdateCachePath(repoRoot), {
      checkedAt: new Date().toISOString(),
      installedSha,
      latestSha: installedSha,
      upToDate: true,
      aheadBy: null,
      commits: [],
      failureReason: error instanceof Error ? error.message : String(error),
    } satisfies AutoUpdateCache);
  } catch {
    // Failure backoff is best-effort; update notices must never block commands.
  }
}

interface DriftResult {
  drift: SetupDrift | null;
  // Set when detection couldn't run (no machine-local config, etc.). Non-JSON
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

function installedCodexSurfaceSignals(): string[] {
  const skillsRoot = path.join(homeCodexDir(), 'skills');
  const runtimeRoot = managedRuntimeRoot('codex');
  return [
    path.join(runtimeRoot, 'bin', 'pipelane'),
    path.join(runtimeRoot, 'bin', 'run-pipelane.sh'),
    path.join(runtimeRoot, 'managed-skills.json'),
    path.join(skillsRoot, 'pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'init-pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'new', 'SKILL.md'),
    // Legacy durable installs used these host-local runtime directories. Their
    // presence should still trigger a refresh so update can move them.
    path.join(skillsRoot, '.pipelane', 'bin', 'run-pipelane.sh'),
    path.join(skillsRoot, 'pipelane', 'bin', 'run-pipelane.sh'),
  ];
}

function installedClaudeSurfaceSignals(): string[] {
  const skillsRoot = path.join(homeClaudeDir(), 'skills');
  const runtimeRoot = managedRuntimeRoot('claude');
  return [
    path.join(runtimeRoot, 'bin', 'pipelane'),
    path.join(runtimeRoot, 'bin', 'run-pipelane.sh'),
    path.join(runtimeRoot, 'managed-skills.json'),
    path.join(skillsRoot, 'pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'init-pipelane', 'SKILL.md'),
    path.join(skillsRoot, 'new', 'SKILL.md'),
    // Legacy durable installs used the same path as the /pipelane skill.
    path.join(skillsRoot, 'pipelane', 'bin', 'run-pipelane.sh'),
  ];
}

function refreshInstalledGlobalSurfaces(repoRoot: string): GlobalSurfaceRefresh {
  return {
    codex: refreshGlobalSurface(repoRoot, 'codex', installedCodexSurfaceSignals()),
    claude: refreshGlobalSurface(repoRoot, 'claude', installedClaudeSurfaceSignals()),
  };
}

function refreshGlobalSurface(repoRoot: string, host: 'codex' | 'claude', signals: string[]): GlobalSurfaceRefreshCheck {
  void repoRoot;
  if (!signals.some((targetPath) => existsSync(targetPath))) {
    return { status: 'skipped', detail: `not installed (run pipelane install-${host} to add it)` };
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

function installLatestManagedRuntimes(latestSha: string, options: Pick<UpdateOptions, 'json' | 'output'>): GlobalSurfaceRefresh {
  const byHost = new Map<ManagedRuntimeHost, ManagedRuntimeInstall>();
  for (const install of discoverManagedRuntimeInstalls()) {
    byHost.set(install.host, install);
  }
  const current = currentManagedRuntimeInstall();
  if (current?.installed) {
    byHost.set(current.host, current);
  }
  if (byHost.size === 0) {
    throw new Error(
      'No durable Pipelane runtime is installed. Run `pipelane install-codex` or `pipelane install-claude` before updating.',
    );
  }

  const spec = resolvePipelaneInstallSpecForSha(latestSha);
  const results: Record<ManagedRuntimeHost, GlobalSurfaceRefreshCheck> = {
    codex: { status: 'skipped', detail: 'not installed' },
    claude: { status: 'skipped', detail: 'not installed' },
  };

  for (const host of ['codex', 'claude'] as const) {
    if (!byHost.has(host)) {
      continue;
    }
    const result = runCommandCapture('npx', ['-y', spec, `install-${host}`], {
      env: {
        ...process.env,
        PIPELANE_INSTALL_SOURCE_SHA: latestSha,
        PIPELANE_INSTALL_SPEC: spec,
      },
    });
    if (!result.ok) {
      results[host] = { status: 'failed', detail: result.stderr || result.stdout || `npx exited ${result.exitCode}` };
      continue;
    }
    if (!options.json && result.stdout && options.output !== 'silent') {
      writeUpdateOutput(options, `${result.stdout}\n`);
    }
    if (!options.json && result.stderr && options.output !== 'silent') {
      writeUpdateOutput({ output: 'stderr' }, `${result.stderr}\n`);
    }
    results[host] = { status: 'refreshed', detail: `installed ${shortSha(latestSha)} via ${spec}` };
  }

  const failures = Object.entries(results)
    .filter(([, result]) => result.status === 'failed')
    .map(([host, result]) => `${host}: ${result.detail}`);
  if (failures.length > 0) {
    throw new Error(`Pipelane managed runtime update failed:\n${failures.join('\n')}`);
  }

  return results;
}

function emitGlobalSurfaceRefreshHint(result: GlobalSurfaceRefresh, options: Pick<UpdateOptions, 'output'>): void {
  const lines: string[] = [];
  if (result.codex.status === 'refreshed') {
    lines.push('- Refreshed machine-local Codex commands. Restart Codex if command discovery is already loaded.');
  } else if (result.codex.status === 'failed') {
    lines.push(`- Codex command refresh failed: ${result.codex.detail}`);
  }

  if (result.claude.status === 'refreshed') {
    lines.push('- Refreshed machine-local Claude commands. Restart Claude if skill discovery is already loaded.');
  } else if (result.claude.status === 'failed') {
    lines.push(`- Claude command refresh failed: ${result.claude.detail}`);
  }

  if (lines.length > 0) {
    writeUpdateOutput(options, `\nUpdated surfaces:\n${lines.join('\n')}\n`);
  }
}

function emitDriftHint(result: DriftResult, options: Pick<UpdateOptions, 'output'>): void {
  if (result.error) {
    writeUpdateOutput(options, `\n[pipelane] Skipped drift detection: ${result.error}\n`);
    writeUpdateOutput(options, 'Run `pipelane setup` for clean local setup, or `pipelane configure` if deploy values are missing.\n');
    return;
  }
  const drift = result.drift;
  if (!drift) return;
  const warnings = drift.warnings ?? [];
  const agentsGuidanceMigrations = drift.agentsGuidanceMigrations ?? [];
  const claudeGuidanceMigrations = drift.claudeGuidanceMigrations ?? [];
  if (!drift.needsSetup) {
    let emittedGuidanceMigration = false;
    if (agentsGuidanceMigrations.length > 0) {
      writeUpdateOutput(options, '\nOptional guidance updates:\n');
      writeUpdateOutput(options, formatAgentsGuidanceMigrations(agentsGuidanceMigrations).join('\n') + '\n');
      emittedGuidanceMigration = true;
    }
    if (claudeGuidanceMigrations.length > 0) {
      if (!emittedGuidanceMigration) writeUpdateOutput(options, '\nOptional guidance updates:\n');
      writeUpdateOutput(options, formatClaudeGuidanceMigrations(claudeGuidanceMigrations).join('\n') + '\n');
      emittedGuidanceMigration = true;
    }
    if (drift.lessonsMigration) {
      if (!emittedGuidanceMigration) writeUpdateOutput(options, '\nOptional guidance updates:\n');
      writeUpdateOutput(options, formatLessonsMigration(drift.lessonsMigration).join('\n') + '\n');
      emittedGuidanceMigration = true;
    }
    if (emittedGuidanceMigration) {
      writeUpdateOutput(options, '- Next: reply `1` or `Y` to apply these changes, or run `/pipelane update --yes`.\n');
      return;
    }
    if (warnings.length > 0) {
      writeUpdateOutput(options, '\nReadiness warnings:\n');
      writeUpdateOutput(options, warnings.map((warning) => `- ${warning}`).join('\n') + '\n');
      return;
    }
    writeUpdateOutput(options, '\nNo additional steps required — machine-local setup is in sync.\n');
    return;
  }
  writeUpdateOutput(options, '\n' + formatFollowUpSummary(drift) + '\n');
}

function emitReopenHints(drift: SetupDrift, options: Pick<UpdateOptions, 'output'>): void {
  if (drift.needsReopenClaude) {
    writeUpdateOutput(options, 'Reopen Claude so the new or renamed slash commands appear.\n');
  }
  if (drift.needsReopenCodex) {
    writeUpdateOutput(options, 'Reopen Codex to pick up machine-local command changes.\n');
  }
}

export function formatFollowUpSummary(drift: SetupDrift): string {
  const lines: string[] = ['Follow-up needed:'];
  const changes: string[] = [];
  const warnings = drift.warnings ?? [];
  const agentsGuidanceMigrations = drift.agentsGuidanceMigrations ?? [];
  const claudeGuidanceMigrations = drift.claudeGuidanceMigrations ?? [];
  if (drift.claude.enabled) {
    const added = truncateList(drift.claude.addedCommands);
    const updated = truncateList(drift.claude.updatedCommands);
    const removed = truncateList(drift.claude.removedLegacyCommands);
    if (added) changes.push(`New slash commands: ${added}`);
    if (updated) changes.push(`Updated commands: ${updated}`);
    if (removed) changes.push(`Legacy commands to prune: ${removed}`);
  }
  if (drift.repoGuidance.willScaffold) {
    changes.push('REPO_GUIDANCE.md is absent; setup will not create a scaffold automatically');
  }
  if (drift.claudeGuidance?.willScaffold) {
    changes.push('CLAUDE.md is absent; setup will not create a scaffold automatically');
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
    changes.push(`Legacy repo-local surfaces detected: ${drift.otherSurfaces.join(', ')}`);
  }
  if (agentsGuidanceMigrations.length > 0) {
    const count = agentsGuidanceMigrations.reduce((sum, migration) => sum + migration.replacements.length, 0);
    const hasSection = agentsGuidanceMigrations.some((migration) => Boolean(migration.sectionAction));
    const details = [
      hasSection ? 'workspace policy' : '',
      count > 0 ? `${count} line${count === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    changes.push(`AGENTS.md consumer-owned guidance note${details ? ` (${details})` : ''}`);
  }
  if (claudeGuidanceMigrations.length > 0) {
    changes.push('CLAUDE.md consumer-owned guidance note');
  }
  if (drift.lessonsMigration) {
    changes.push(drift.lessonsMigration.action === 'insert'
      ? 'CLAUDE.md Lessons block guidance available (capture instruction + empty entries region)'
      : 'CLAUDE.md Lessons instruction guidance available (existing entries preserved)');
  }
  if (warnings.length > 0) {
    changes.push(`Readiness warnings: ${warnings.join(' ')}`);
  }
  if (drift.claude.collisions.length > 0) {
    // Collisions block setup. Surface them prominently; no "run setup"
    // step, no reopen hint.
    return [
      'Legacy repo-local setup cannot run — collision with existing non-pipelane files:',
      ...drift.claude.collisions.map((file) => `  - .claude/commands/${file}`),
      'Resolve these manually (rename, remove, or change the alias in machine-local Pipelane config), then rerun `pipelane update`.',
    ].join('\n');
  }
  lines.push('  1. Run setup to repair machine-local state:');
  for (const change of changes) {
    lines.push(`     - ${change}`);
  }
  let step = 2;
  if (drift.needsReopenClaude) {
    lines.push(`  ${step++}. Reopen Claude so the new or renamed slash commands appear.`);
  }
  if (drift.needsReopenCodex) {
    lines.push(`  ${step++}. Reopen Codex to pick up machine-local command changes.`);
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
  const runtime = primaryManagedRuntimeInstall();
  if (!runtime) {
    throw new Error(
      'Pipelane durable runtime is not installed. Run `pipelane install-codex` or `pipelane install-claude`.',
    );
  }
  const installedSha = managedRuntimeSourceSha(runtime);
  if (!installedSha) {
    throw new Error(
      `Pipelane durable runtime at ${runtime.root} does not record an installed source SHA. Reinstall with \`pipelane install-${runtime.host}\`.`,
    );
  }
  const installedVersion = managedRuntimeVersion(runtime);
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
  const runtime = primaryManagedRuntimeInstall();
  const installedSha = managedRuntimeSourceSha(runtime);
  const installedVersion = managedRuntimeVersion(runtime);
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

function readInstalledVersion(packagePath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version?.trim() ?? '';
  } catch {
    return '';
  }
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

export function formatAutoUpdateNotice(status: UpdateStatus): string {
  const installed = status.installedShaShort || '(unknown)';
  const lines = [
    `[pipelane] A new Pipelane update is available: ${installed} -> ${status.latestShaShort}.`,
    '[pipelane] Run `/pipelane update` to get the latest changes:',
    ...formatAutoUpdateHighlightLines(status),
  ];
  return `${lines.join('\n')}\n`;
}

function formatAutoUpdateHighlightLines(status: UpdateStatus): string[] {
  const subjects = status.commits
    .map((commit) => formatCommitSubjectBullet(commit.subject))
    .filter(Boolean);

  if (subjects.length > 0) {
    const visible = subjects.slice(0, 3);
    const total = status.aheadBy ?? status.commits.length;
    const hidden = total - visible.length;
    const lines = visible.map((subject) => `[pipelane] - ${subject}`);
    if (total > visible.length) {
      lines.push(`[pipelane] - ${hidden} more commit${hidden === 1 ? '' : 's'} ${hidden === 1 ? 'is' : 'are'} included.`);
    }
    return lines;
  }

  if (status.aheadBy !== null) {
    return [`[pipelane] - ${status.aheadBy} commit${status.aheadBy === 1 ? '' : 's'} since your installed version.`];
  }

  return ['[pipelane] - Run `/pipelane update --check` to inspect the update before installing.'];
}

function formatCommitSubjectBullet(subject: string): string {
  const normalized = subject.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > 140
    ? `${normalized.slice(0, 137).trimEnd()}...`
    : normalized;
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
