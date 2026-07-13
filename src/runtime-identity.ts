import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PipelaneRuntimeIdentity {
  version: string;
  sha: string;
  builtAt: string | null;
  packageRoot: string;
  source: 'dist' | 'src';
}

interface BuildInfoFile {
  sha?: unknown;
  builtAt?: unknown;
}

interface PackageJsonShape {
  version?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

export function resolvePipelaneRuntimeIdentity(moduleUrl = import.meta.url): PipelaneRuntimeIdentity {
  const modulePath = fileURLToPath(moduleUrl);
  const source = modulePath.includes(`${path.sep}dist${path.sep}`) ? 'dist' : 'src';
  const packageRoot = resolvePackageRoot(modulePath);
  const packageJson = readJsonFile<PackageJsonShape>(path.join(packageRoot, 'package.json')) ?? {};
  const buildInfo = source === 'dist'
    ? readJsonFile<BuildInfoFile>(path.join(packageRoot, 'dist', 'build-info.json'))
    : null;
  const builtSha = cleanText(buildInfo?.sha);
  const sourceSha = source === 'src' ? resolveGitSha(packageRoot) : '';

  return {
    version: cleanText(packageJson.version) || 'unknown',
    sha: builtSha || sourceSha || 'unknown',
    builtAt: cleanIsoTimestamp(buildInfo?.builtAt),
    packageRoot,
    source,
  };
}

export function formatPipelaneRuntimeBanner(identity: PipelaneRuntimeIdentity): string {
  return `pipelane v${identity.version} (${shortBuildSha(identity.sha)}) from ${identity.packageRoot}`;
}

export function formatPipelaneVersion(identity: PipelaneRuntimeIdentity): string {
  const lines = [formatPipelaneRuntimeBanner(identity)];
  lines.push(`build timestamp: ${identity.builtAt ?? 'unavailable'}`);
  return lines.join('\n');
}

export function buildRuntimeWarnings(identity: PipelaneRuntimeIdentity, cwd: string): string[] {
  const warnings: string[] = [];
  const pinnedSha = resolveHostPipelanePin(cwd);
  if (pinnedSha && identity.sha !== 'unknown' && !sameGitSha(identity.sha, pinnedSha)) {
    warnings.push(
      `Warning: running ${shortBuildSha(identity.sha)} but repo pins ${shortBuildSha(pinnedSha)} — run npm install or point npx at the repo install.`,
    );
  }
  if (distIsOlderThanSource(identity)) {
    warnings.push(`Warning: dist/ is older than the newest src/ file in ${identity.packageRoot} — run npm run build.`);
  }
  return warnings;
}

function resolvePackageRoot(modulePath: string): string {
  let current = path.dirname(modulePath);
  while (true) {
    if (existsSync(path.join(current, 'package.json'))) {
      try {
        return realpathSync(current);
      } catch {
        return path.resolve(current);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(path.dirname(modulePath), '..');
    current = parent;
  }
}

function resolveGitSha(packageRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function resolveHostPipelanePin(cwd: string): string {
  const repoRoot = resolveGitRoot(cwd);
  const packageJson = readJsonFile<PackageJsonShape>(path.join(repoRoot, 'package.json'));
  if (!packageJson) return '';
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    const spec = cleanText((dependencies as Record<string, unknown>).pipelane);
    if (!spec) continue;
    const match = /(?:github:|git\+https?:|https?:)[^#\s]+#([a-f0-9]{7,64})(?:$|\s)/i.exec(spec);
    if (match) return match[1];
  }
  return '';
}

function resolveGitRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

function distIsOlderThanSource(identity: PipelaneRuntimeIdentity): boolean {
  if (identity.source !== 'dist') return false;
  const srcDir = path.join(identity.packageRoot, 'src');
  const gitMarker = path.join(identity.packageRoot, '.git');
  if (!existsSync(srcDir) || !existsSync(gitMarker)) return false;
  const newestSourceMtime = newestFileMtime(srcDir);
  if (newestSourceMtime <= 0) return false;
  const builtAtMs = identity.builtAt ? Date.parse(identity.builtAt) : NaN;
  const distReferenceMtime = Number.isFinite(builtAtMs)
    ? builtAtMs
    : safeMtime(path.join(identity.packageRoot, 'dist', 'cli.js'));
  return distReferenceMtime > 0 && newestSourceMtime > distReferenceMtime;
}

function newestFileMtime(root: string): number {
  let newest = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) newest = Math.max(newest, newestFileMtime(target));
      else if (entry.isFile()) newest = Math.max(newest, safeMtime(target));
    }
  } catch {
    return newest;
  }
  return newest;
}

function safeMtime(target: string): number {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

function readJsonFile<T>(target: string): T | null {
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as T;
  } catch {
    return null;
  }
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanIsoTimestamp(value: unknown): string | null {
  const text = cleanText(value);
  if (!text || Number.isNaN(Date.parse(text))) return null;
  return new Date(text).toISOString();
}

function shortBuildSha(value: string): string {
  return /^[a-f0-9]{7,64}$/i.test(value) ? value.slice(0, 7) : value;
}

function sameGitSha(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}
