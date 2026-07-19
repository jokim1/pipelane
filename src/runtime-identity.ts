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
import { sanitizeForTerminal } from './operator/text-output.ts';

export interface PipelaneRuntimeIdentity {
  version: string;
  sha: string;
  dirty: boolean;
  builtAt: string | null;
  packageRoot: string;
  source: 'dist' | 'src';
}

interface BuildInfoFile {
  sha?: unknown;
  dirty?: unknown;
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
  const packageRootDir = findPackageRootDir(modulePath);
  const source = modulePath.startsWith(path.join(packageRootDir, 'dist') + path.sep) ? 'dist' : 'src';
  const packageRoot = canonicalizePackageRoot(packageRootDir);
  const packageJson = readJsonFile<PackageJsonShape>(path.join(packageRoot, 'package.json')) ?? {};
  const buildInfo = source === 'dist'
    ? readJsonFile<BuildInfoFile>(path.join(packageRoot, 'dist', 'build-info.json'))
    : null;
  const builtSha = cleanBuildSha(buildInfo?.sha);
  const sourceGit = source === 'src' ? resolveGitIdentity(packageRoot) : { sha: '', dirty: false };

  return {
    version: cleanText(packageJson.version) || 'unknown',
    sha: builtSha || sourceGit.sha || 'unknown',
    dirty: source === 'dist' ? buildInfo?.dirty === true : sourceGit.dirty,
    builtAt: cleanIsoTimestamp(buildInfo?.builtAt),
    packageRoot,
    source,
  };
}

export function formatPipelaneRuntimeBanner(identity: PipelaneRuntimeIdentity): string {
  return `pipelane v${cleanBannerField(identity.version, 'unknown')} (${formatBuildRef(identity)}) from ${cleanBannerField(identity.packageRoot, 'unknown')}`;
}

export function formatPipelaneVersion(identity: PipelaneRuntimeIdentity): string {
  const lines = [formatPipelaneRuntimeBanner(identity)];
  lines.push(`build timestamp: ${cleanIsoTimestamp(identity.builtAt) ?? 'unavailable'}`);
  return lines.join('\n');
}

export function buildRuntimeWarnings(identity: PipelaneRuntimeIdentity, cwd: string): string[] {
  const warnings: string[] = [];
  const pinnedSha = resolveHostPipelanePin(cwd);
  if (pinnedSha && identity.sha !== 'unknown' && (identity.dirty || !sameGitSha(identity.sha, pinnedSha))) {
    warnings.push(
      `Warning: running ${formatBuildRef(identity)} but repo pins ${shortBuildSha(pinnedSha)} — run npm install or point npx at the repo install.`,
    );
  }
  if (distIsOlderThanSource(identity)) {
    warnings.push(`Warning: dist/ is older than the newest src/ file in ${cleanBannerField(identity.packageRoot, 'unknown')} — run npm run build.`);
  }
  return warnings;
}

function findPackageRootDir(modulePath: string): string {
  let current = path.dirname(modulePath);
  while (true) {
    if (existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(path.dirname(modulePath), '..');
    current = parent;
  }
}

function canonicalizePackageRoot(packageRootDir: string): string {
  try {
    return realpathSync(packageRootDir);
  } catch {
    return path.resolve(packageRootDir);
  }
}

function resolveGitIdentity(packageRoot: string): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: '', dirty: false };
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

function cleanBuildSha(value: unknown): string {
  const text = cleanText(value);
  return /^[a-f0-9]{7,64}$/i.test(text) ? text : '';
}

function cleanBannerField(value: unknown, fallback: string): string {
  const text = sanitizeForTerminal(cleanText(value)).replace(/\s*\n+\s*/g, ' ');
  return text || fallback;
}

function cleanIsoTimestamp(value: unknown): string | null {
  const text = cleanText(value);
  if (!text || Number.isNaN(Date.parse(text))) return null;
  return new Date(text).toISOString();
}

function shortBuildSha(value: string): string {
  return cleanBuildSha(value).slice(0, 7) || 'unknown';
}

function formatBuildRef(identity: Pick<PipelaneRuntimeIdentity, 'sha' | 'dirty'>): string {
  return `${shortBuildSha(identity.sha)}${identity.dirty ? '-dirty' : ''}`;
}

function sameGitSha(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}
