import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_RUNTIME_FILENAME = '.pipelane-runtime.json';
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000;

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

function ensureInstallableRuntime(root: string): void {
  const required = ['package.json', 'bin/pipelane', 'dist/cli.js', 'templates'];
  for (const relativePath of required) {
    if (!existsSync(path.join(root, relativePath))) {
      throw new Error(`Current pipelane package is missing required runtime asset: ${relativePath}`);
    }
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
        const previousRoot = previousRuntimePath(targetRoot);
        rmSync(previousRoot, { recursive: true, force: true });
        renameSync(asideRoot, previousRoot);
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

export function rollbackGlobalRuntime(targetRoot: string): RuntimeRollbackResult {
  const previousRoot = previousRuntimePath(targetRoot);
  const releaseLock = acquireInstallLock(targetRoot);
  try {
    const restored = readManagedRuntimeMetadata(previousRoot);
    if (!restored) {
      throw new Error(`No pipelane-managed previous runtime is retained at ${previousRoot}; nothing to roll back to.`);
    }
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
