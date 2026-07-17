import { execFileSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_RUNTIME_FILENAME = '.pipelane-runtime.json';
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000;
const GENERATED_RUNTIME_ASSETS = [
  'managed-skills.json',
  'bin/run-pipelane.sh',
  'bin/bootstrap-pipelane.sh',
] as const;

interface RuntimePackageJson {
  version?: string;
  files?: unknown;
}

export interface ManagedRuntimeMetadata {
  version: number;
  managedBy: 'pipelane';
  host: string;
  packageVersion: string;
  installedAt: string;
  sourceSha?: string;
  sourceDirty?: boolean;
  installSpec?: string;
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readPackageJson(root: string): RuntimePackageJson {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as RuntimePackageJson;
}

function installableEntries(root: string): string[] {
  const pkg = readPackageJson(root);
  const fromManifest = Array.isArray(pkg.files)
    ? pkg.files.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  return [...new Set(['package.json', ...fromManifest])];
}

function ensureInstallableRuntime(root: string, label = 'Current pipelane package'): void {
  const required = [
    { path: 'package.json', kind: 'file', executable: false },
    { path: 'bin/pipelane', kind: 'file', executable: true },
    { path: 'dist/cli.js', kind: 'file', executable: false },
    { path: 'templates', kind: 'directory', executable: false },
  ] as const;
  for (const { path: relativePath, kind, executable } of required) {
    if (!existsSync(path.join(root, relativePath))) {
      throw new Error(`${label} is missing required runtime asset: ${relativePath}`);
    }
    const target = path.join(root, relativePath);
    const stats = lstatSync(target);
    if ((kind === 'file' && !stats.isFile()) || (kind === 'directory' && !stats.isDirectory())) {
      throw new Error(`${label} has an invalid required runtime asset: ${relativePath} must be a ${kind}.`);
    }
    if (executable && process.platform !== 'win32') {
      try {
        accessSync(target, constants.X_OK);
      } catch {
        throw new Error(`${label} has an invalid required runtime asset: ${relativePath} must be executable.`);
      }
    }
  }
}

function ensureRuntimeRootDirectory(root: string, label: string): void {
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link or other file.`);
  }
}

function ensureRestorableRuntime(root: string, label: string): void {
  ensureRuntimeRootDirectory(root, label);
  ensureInstallableRuntime(root, label);
  for (const relativePath of GENERATED_RUNTIME_ASSETS) {
    if (!existsSync(path.join(root, relativePath))) {
      throw new Error(`${label} is missing required generated runtime asset: ${relativePath}`);
    }
    const target = path.join(root, relativePath);
    if (!lstatSync(target).isFile()) {
      throw new Error(`${label} has an invalid required generated runtime asset: ${relativePath} must be a file.`);
    }
    if (process.platform !== 'win32' && relativePath.startsWith('bin/')) {
      try {
        accessSync(target, constants.X_OK);
      } catch {
        throw new Error(`${label} has an invalid required generated runtime asset: ${relativePath} must be executable.`);
      }
    }
  }
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'managed-skills.json'), 'utf8')) as { skills?: unknown };
    // Empty manifests are refused here too: retention shares this predicate,
    // and a corrupted empty-manifest runtime must never rotate over a valid
    // rollback target.
    if (!Array.isArray(manifest.skills) || manifest.skills.length === 0 || manifest.skills.some((entry) => typeof entry !== 'string')) {
      throw new Error('skills must be a non-empty array of strings');
    }
  } catch (error) {
    throw new Error(`${label} has an invalid managed-skills.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function managedRuntimePath(targetRoot: string): string {
  return path.join(targetRoot, MANAGED_RUNTIME_FILENAME);
}

export function readManagedRuntimeMetadata(targetRoot: string): ManagedRuntimeMetadata | null {
  const metadataPath = managedRuntimePath(targetRoot);
  if (!existsSync(metadataPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as ManagedRuntimeMetadata;
    return parsed?.managedBy === 'pipelane' ? parsed : null;
  } catch {
    return null;
  }
}

interface RuntimeSourceProvenance {
  sha: string;
  dirty?: boolean;
}

function readBuildInfoProvenance(sourceRoot: string): RuntimeSourceProvenance | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(sourceRoot, 'dist', 'build-info.json'), 'utf8')) as { sha?: unknown; dirty?: unknown };
    const sha = typeof parsed.sha === 'string' ? parsed.sha.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{7,40}$/.test(sha)) {
      return null;
    }
    return parsed.dirty === true ? { sha, dirty: true } : { sha };
  } catch {
    return null;
  }
}

function tryNormalizeLegacyRuntimeMetadata(root: string, host: string): boolean {
  try {
    ensureRestorableRuntime(root, `Legacy runtime at ${root}`);
    const pkg = readPackageJson(root);
    const metadata: ManagedRuntimeMetadata = {
      version: 1,
      managedBy: 'pipelane',
      host,
      packageVersion: pkg.version?.trim() || '0.0.0',
      installedAt: new Date().toISOString(),
    };
    const provenance = readBuildInfoProvenance(root);
    if (provenance) {
      metadata.sourceSha = provenance.sha;
      if (provenance.dirty) metadata.sourceDirty = true;
    }
    writeFileSync(managedRuntimePath(root), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // A damaged legacy runtime must remain replaceable. It cannot be a safe
    // rollback target, so the install succeeds without retaining that tree.
    return false;
  }
}

function resolveRuntimeSourceProvenance(sourceRoot: string): RuntimeSourceProvenance | null {
  const fromEnv = process.env.PIPELANE_INSTALL_SOURCE_SHA?.trim();
  if (fromEnv && /^[a-f0-9]{7,40}$/i.test(fromEnv)) {
    return { sha: fromEnv.toLowerCase() };
  }
  // dist/build-info.json records the tree the shipped dist was built from —
  // the truth about the bits being installed even when the source root's HEAD
  // has moved past the build, or the root is a git-less npx/npm pack dir.
  const buildInfo = readBuildInfoProvenance(sourceRoot);
  if (buildInfo) {
    return buildInfo;
  }
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase();
    return sha ? { sha } : null;
  } catch {
    return null;
  }
}

// Damaged managed metadata must never be advertised as a rollback target: a
// retained runtime whose metadata cannot round-trip through rollback reporting
// makes the install claim a safety net it does not have.
export function isCompleteRuntimeMetadata(metadata: ManagedRuntimeMetadata | null, host?: string): boolean {
  return Boolean(
    metadata
    && metadata.managedBy === 'pipelane'
    && metadata.version === 1
    && (host === undefined ? typeof metadata.host === 'string' && metadata.host.trim().length > 0 : metadata.host === host)
    && typeof metadata.packageVersion === 'string' && metadata.packageVersion.trim().length > 0
    && typeof metadata.installedAt === 'string' && !Number.isNaN(Date.parse(metadata.installedAt)),
  );
}

function sameRuntimeSource(left: ManagedRuntimeMetadata | null, right: ManagedRuntimeMetadata): boolean {
  if (!left || left.host !== right.host || left.packageVersion !== right.packageVersion) return false;
  if (left.sourceDirty === true || right.sourceDirty === true) return false;
  const leftSha = left.sourceSha?.trim().toLowerCase() ?? '';
  const rightSha = right.sourceSha?.trim().toLowerCase() ?? '';
  if (!/^[a-f0-9]{7,40}$/.test(leftSha) || !/^[a-f0-9]{7,40}$/.test(rightSha)) return false;
  const [shorter, longer] = leftSha.length < rightSha.length ? [leftSha, rightSha] : [rightSha, leftSha];
  return longer.startsWith(shorter);
}

export function previousRuntimePath(targetRoot: string): string {
  return `${targetRoot}.previous`;
}

function installLockPath(targetRoot: string): string {
  void targetRoot;
  const home = process.env.PIPELANE_HOME || path.join(os.homedir(), '.pipelane');
  return path.join(home, 'install.lock');
}

function acquireInstallLock(targetRoot: string): () => void {
  const lockPath = installLockPath(targetRoot);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch {
    try {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      if (ageMs > INSTALL_LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
      } else {
        throw new Error(`Another pipelane runtime install appears to be in progress at ${lockPath}. Retry after it finishes.`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Another pipelane runtime install')) {
        throw error;
      }
      throw new Error(`Could not acquire pipelane runtime install lock at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  writeFileSync(
    path.join(lockPath, 'owner.json'),
    `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), targetRoot }, null, 2)}\n`,
    'utf8',
  );
  return () => rmSync(lockPath, { recursive: true, force: true });
}

export function isManagedGlobalRuntime(targetRoot: string, legacyMarkers: string[] = []): boolean {
  if (readManagedRuntimeMetadata(targetRoot)) {
    return true;
  }

  return legacyMarkers.length > 0 && legacyMarkers.every((relativePath) => existsSync(path.join(targetRoot, relativePath)));
}

export function installGlobalRuntime(
  targetRoot: string,
  options: { host: string; legacyMarkers?: string[] },
): { runtimeRoot: string; packageVersion: string } {
  const sourceRoot = packageRoot();
  ensureInstallableRuntime(sourceRoot);

  const parentDir = path.dirname(targetRoot);
  mkdirSync(parentDir, { recursive: true });
  const releaseLock = acquireInstallLock(targetRoot);
  const tempRoot = mkdtempSync(path.join(parentDir, '.pipelane-install-'));
  let asideRoot: string | null = null;
  let retainCurrentRuntime = true;
  try {
    if (existsSync(targetRoot)) {
      const currentMetadata = readManagedRuntimeMetadata(targetRoot);
      if (!currentMetadata) {
        const legacyMarkers = options.legacyMarkers ?? [];
        if (legacyMarkers.length === 0 || !legacyMarkers.every((relativePath) => existsSync(path.join(targetRoot, relativePath)))) {
          throw new Error(`${targetRoot} already exists and is not managed by pipelane.`);
        }
        retainCurrentRuntime = tryNormalizeLegacyRuntimeMetadata(targetRoot, options.host);
      } else if (!isCompleteRuntimeMetadata(currentMetadata, options.host)) {
        // Managed but damaged metadata: the tree cannot serve as a rollback
        // target, so discard instead of advertising a broken safety net.
        retainCurrentRuntime = false;
      } else {
        try {
          ensureRestorableRuntime(targetRoot, `Current runtime at ${targetRoot}`);
        } catch {
          retainCurrentRuntime = false;
        }
      }
    }

    const pkg = readPackageJson(sourceRoot);
    const packageVersion = pkg.version?.trim() || '0.0.0';

    for (const relativePath of installableEntries(sourceRoot)) {
      const sourcePath = path.join(sourceRoot, relativePath);
      if (!existsSync(sourcePath)) {
        throw new Error(`Current pipelane package manifest references a missing path: ${relativePath}`);
      }
      const targetPath = path.join(tempRoot, relativePath);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath, { recursive: true });
    }

    const metadata: ManagedRuntimeMetadata = {
      version: 1,
      managedBy: 'pipelane',
      host: options.host,
      packageVersion,
      installedAt: new Date().toISOString(),
    };
    const provenance = resolveRuntimeSourceProvenance(sourceRoot);
    if (provenance) {
      metadata.sourceSha = provenance.sha;
      if (provenance.dirty) {
        metadata.sourceDirty = true;
      }
    }
    const installSpec = process.env.PIPELANE_INSTALL_SPEC?.trim();
    if (installSpec) {
      metadata.installSpec = installSpec;
    }
    writeFileSync(managedRuntimePath(tempRoot), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    const previousRoot = previousRuntimePath(targetRoot);
    if (existsSync(previousRoot)) {
      const previousMetadata = readManagedRuntimeMetadata(previousRoot);
      if (!previousMetadata) {
        throw new Error(`${previousRoot} already exists and is not managed by pipelane; refusing to replace it.`);
      }
      ensureRestorableRuntime(previousRoot, `Retained runtime at ${previousRoot}`);
      if (previousMetadata.host !== options.host) {
        throw new Error(`${previousRoot} belongs to host ${previousMetadata.host || 'unknown'}, not ${options.host}; refusing to replace it.`);
      }
    }
    const preservePrevious = existsSync(previousRoot)
      && sameRuntimeSource(readManagedRuntimeMetadata(targetRoot), metadata);

    if (existsSync(targetRoot)) {
      asideRoot = `${targetRoot}.previous-${process.pid}-${Date.now()}`;
      renameSync(targetRoot, asideRoot);
    }
    renameSync(tempRoot, targetRoot);
    if (asideRoot) {
      // Retain exactly one prior runtime as the rollback target. Best effort:
      // a failed retention must not fail the already-completed install. Keep
      // both the old canonical target and the retired active runtime until the
      // replacement rename succeeds, then remove the superseded target.
      try {
        if (!retainCurrentRuntime || preservePrevious) {
          rmSync(asideRoot, { recursive: true, force: true });
        } else {
          const replacedPreviousRoot = existsSync(previousRoot)
            ? `${previousRoot}.replaced-${process.pid}-${Date.now()}`
            : null;
          if (replacedPreviousRoot) {
            renameSync(previousRoot, replacedPreviousRoot);
          }
          try {
            renameSync(asideRoot, previousRoot);
          } catch (error) {
            if (replacedPreviousRoot && !existsSync(previousRoot) && existsSync(replacedPreviousRoot)) {
              renameSync(replacedPreviousRoot, previousRoot);
            }
            throw error;
          }
          if (replacedPreviousRoot) {
            try {
              rmSync(replacedPreviousRoot, { recursive: true, force: true });
            } catch {
              // The new rollback target is already canonical. Leaving the
              // superseded backup is safer than failing the active install.
            }
          }
        }
      } catch {
        // Keep asideRoot on disk for manual recovery. If a prior canonical
        // rollback target existed, the rotation above restores it first.
      }
    }

    return { runtimeRoot: targetRoot, packageVersion };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    if (asideRoot && !existsSync(targetRoot) && existsSync(asideRoot)) {
      renameSync(asideRoot, targetRoot);
    }
    throw error;
  } finally {
    releaseLock();
  }
}

export interface RuntimeRollbackResult {
  runtimeRoot: string;
  restored: ManagedRuntimeMetadata;
  retired: ManagedRuntimeMetadata | null;
}

export function rollbackGlobalRuntime(
  targetRoot: string,
  options: { expectedHost?: string } = {},
): RuntimeRollbackResult {
  const previousRoot = previousRuntimePath(targetRoot);
  const releaseLock = acquireInstallLock(targetRoot);
  try {
    if (!existsSync(previousRoot)) {
      throw new Error(`No pipelane-managed previous runtime is retained at ${previousRoot}; nothing to roll back to.`);
    }
    ensureRuntimeRootDirectory(previousRoot, `Retained runtime at ${previousRoot}`);
    const restored = readManagedRuntimeMetadata(previousRoot);
    if (!restored) {
      throw new Error(`No pipelane-managed previous runtime is retained at ${previousRoot}; nothing to roll back to.`);
    }
    if (options.expectedHost && restored.host !== options.expectedHost) {
      throw new Error(`Retained runtime at ${previousRoot} belongs to host ${restored.host || 'unknown'}, not ${options.expectedHost}; refusing to activate it.`);
    }
    if (!isCompleteRuntimeMetadata(restored, options.expectedHost)) {
      throw new Error(`Retained runtime metadata at ${previousRoot} is incomplete; refusing to activate it.`);
    }
    ensureRestorableRuntime(previousRoot, `Retained runtime at ${previousRoot}`);
    if (existsSync(targetRoot)) {
      ensureRuntimeRootDirectory(targetRoot, `Current runtime at ${targetRoot}`);
      if (!isManagedGlobalRuntime(targetRoot)) {
        throw new Error(`${targetRoot} exists and is not managed by pipelane; refusing to roll back over it.`);
      }
    }
    const retired = readManagedRuntimeMetadata(targetRoot);
    const asideRoot = `${targetRoot}.rollback-${process.pid}-${Date.now()}`;
    let movedCurrent = false;
    if (existsSync(targetRoot)) {
      renameSync(targetRoot, asideRoot);
      movedCurrent = true;
    }
    try {
      renameSync(previousRoot, targetRoot);
    } catch (error) {
      if (movedCurrent) {
        renameSync(asideRoot, targetRoot);
      }
      throw error;
    }
    if (movedCurrent) {
      // The rolled-back runtime becomes the new previous, so a second rollback
      // rolls forward again.
      try {
        renameSync(asideRoot, previousRoot);
      } catch (error) {
        // The command must not report failure after silently changing the live
        // runtime. Put both runtimes back where they started before surfacing
        // the rotation error.
        try {
          renameSync(targetRoot, previousRoot);
          renameSync(asideRoot, targetRoot);
        } catch (restoreError) {
          throw new Error(
            `Runtime rollback activated ${targetRoot} but could not retain or restore the retired runtime. `
            + `Recovery paths: active=${targetRoot}, retired=${asideRoot}, previous=${previousRoot}. `
            + `Rotation error: ${error instanceof Error ? error.message : String(error)}. `
            + `Restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
        throw error;
      }
    }
    return { runtimeRoot: targetRoot, restored, retired };
  } finally {
    releaseLock();
  }
}

export const HOST_SKILLS_DIRNAME = 'host-skills';

export interface HostSkillPayload {
  name: string;
  body: string;
}

export interface HostRollbackSkillsOutcome {
  wrappersRestored: boolean;
  restoredSkills: string[];
  removedSkills: string[];
  skippedCollisions: string[];
  resyncCommand: string | null;
}

export type HostRuntimeRollbackResult = RuntimeRollbackResult & HostRollbackSkillsOutcome;

function isSafePayloadSkillName(skillName: string): boolean {
  return (
    skillName.length > 0
    && skillName.trim() === skillName
    && !path.isAbsolute(skillName)
    && !skillName.includes('/')
    && !skillName.includes('\\')
    && skillName !== '.'
    && skillName !== '..'
  );
}

export function hostSkillPayloadPath(targetRoot: string, skillName: string): string {
  if (!isSafePayloadSkillName(skillName)) {
    throw new Error(`Unsafe managed skill name in runtime payloads: ${skillName}`);
  }
  return path.join(targetRoot, HOST_SKILLS_DIRNAME, skillName, 'SKILL.md');
}

// The runtime carries the exact wrapper payloads it installed, so a rollback
// can restore host skills in lockstep with the runtime bits instead of leaving
// newer wrappers pointed at an older runtime.
export function writeHostSkillPayloads(targetRoot: string, payloads: HostSkillPayload[]): void {
  rmSync(path.join(targetRoot, HOST_SKILLS_DIRNAME), { recursive: true, force: true });
  for (const payload of payloads) {
    const target = hostSkillPayloadPath(targetRoot, payload.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, payload.body, 'utf8');
  }
}

// Payloads a retained runtime carries for its managed skills. Returns null when
// the runtime predates payload retention (no host-skills dir); throws when the
// manifest is unreadable, empty, or inconsistent with the payload dir — an
// inconsistent runtime is not a safe rollback target. The manifest is
// validated BEFORE the legacy no-payload branch so a payload-less runtime
// cannot smuggle an empty manifest past the refusal.
export function readHostSkillPayloads(targetRoot: string, label: string): Map<string, string> | null {
  let names: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, 'managed-skills.json'), 'utf8')) as { skills?: unknown };
    names = Array.isArray(manifest.skills)
      ? manifest.skills.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A missing manifest file is the generated-asset validator's finding to
      // report; deferring keeps its refusal message authoritative.
      return null;
    }
    throw new Error(`${label} has an unreadable managed-skills.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (names.length === 0) {
    // A managed runtime always installs at least one skill: an empty or
    // truncated manifest would turn the restore step into a mass prune of
    // installed wrappers. Refuse instead of trusting it.
    throw new Error(`${label} has a managed-skills manifest that lists no skills; refusing to roll back to an inconsistent runtime.`);
  }
  const payloadRoot = path.join(targetRoot, HOST_SKILLS_DIRNAME);
  let payloadRootStats;
  try {
    payloadRootStats = lstatSync(payloadRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!payloadRootStats.isDirectory()) {
    throw new Error(`${label} has an invalid host-skill payload root; refusing to follow a symbolic link or other file.`);
  }
  const payloads = new Map<string, string>();
  for (const name of names) {
    const payloadDir = path.join(payloadRoot, name);
    if (!existsSync(payloadDir) || !lstatSync(payloadDir).isDirectory()) {
      throw new Error(`${label} has an invalid host-skill payload directory for ${name}; refusing to follow a symbolic link or other file.`);
    }
    const target = hostSkillPayloadPath(targetRoot, name);
    if (!existsSync(target) || !lstatSync(target).isFile()) {
      throw new Error(`${label} is missing the host-skill payload for ${name}; refusing to roll back to an inconsistent runtime.`);
    }
    payloads.set(name, readFileSync(target, 'utf8'));
  }
  return payloads;
}
