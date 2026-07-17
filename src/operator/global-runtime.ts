import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    { path: 'package.json', kind: 'file' },
    { path: 'bin/pipelane', kind: 'file' },
    { path: 'dist/cli.js', kind: 'file' },
    { path: 'templates', kind: 'directory' },
  ] as const;
  for (const { path: relativePath, kind } of required) {
    if (!existsSync(path.join(root, relativePath))) {
      throw new Error(`${label} is missing required runtime asset: ${relativePath}`);
    }
    const stats = statSync(path.join(root, relativePath));
    if ((kind === 'file' && !stats.isFile()) || (kind === 'directory' && !stats.isDirectory())) {
      throw new Error(`${label} has an invalid required runtime asset: ${relativePath} must be a ${kind}.`);
    }
  }
}

function ensureRestorableRuntime(root: string, label: string): void {
  ensureInstallableRuntime(root, label);
  for (const relativePath of GENERATED_RUNTIME_ASSETS) {
    if (!existsSync(path.join(root, relativePath))) {
      throw new Error(`${label} is missing required generated runtime asset: ${relativePath}`);
    }
    if (!statSync(path.join(root, relativePath)).isFile()) {
      throw new Error(`${label} has an invalid required generated runtime asset: ${relativePath} must be a file.`);
    }
  }
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'managed-skills.json'), 'utf8')) as { skills?: unknown };
    if (!Array.isArray(manifest.skills) || manifest.skills.some((entry) => typeof entry !== 'string')) {
      throw new Error('skills must be an array of strings');
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

  if (existsSync(targetRoot) && !isManagedGlobalRuntime(targetRoot, options.legacyMarkers ?? [])) {
    throw new Error(`${targetRoot} already exists and is not managed by pipelane.`);
  }

  const parentDir = path.dirname(targetRoot);
  mkdirSync(parentDir, { recursive: true });
  const releaseLock = acquireInstallLock(targetRoot);
  const tempRoot = mkdtempSync(path.join(parentDir, '.pipelane-install-'));
  let asideRoot: string | null = null;
  try {
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
      // a failed retention must not fail the already-completed install, so the
      // aside dir is left in place for manual recovery instead.
      try {
        if (preservePrevious) {
          rmSync(asideRoot, { recursive: true, force: true });
        } else {
          rmSync(previousRoot, { recursive: true, force: true });
          renameSync(asideRoot, previousRoot);
        }
      } catch {
        // Keep asideRoot on disk; it still holds the prior runtime.
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
    const restored = readManagedRuntimeMetadata(previousRoot);
    if (!restored) {
      throw new Error(`No pipelane-managed previous runtime is retained at ${previousRoot}; nothing to roll back to.`);
    }
    if (options.expectedHost && restored.host !== options.expectedHost) {
      throw new Error(`Retained runtime at ${previousRoot} belongs to host ${restored.host || 'unknown'}, not ${options.expectedHost}; refusing to activate it.`);
    }
    if (!restored.packageVersion?.trim() || !restored.installedAt?.trim()) {
      throw new Error(`Retained runtime metadata at ${previousRoot} is incomplete; refusing to activate it.`);
    }
    ensureRestorableRuntime(previousRoot, `Retained runtime at ${previousRoot}`);
    if (existsSync(targetRoot) && !isManagedGlobalRuntime(targetRoot)) {
      throw new Error(`${targetRoot} exists and is not managed by pipelane; refusing to roll back over it.`);
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
      renameSync(asideRoot, previousRoot);
    }
    return { runtimeRoot: targetRoot, restored, retired };
  } finally {
    releaseLock();
  }
}
