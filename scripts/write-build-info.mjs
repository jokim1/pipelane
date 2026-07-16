import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const outputPath = path.join(repoRoot, 'dist', 'build-info.json');
const temporaryPath = `${outputPath}.tmp-${process.pid}`;

function resolveBuildSha() {
  const supplied = process.env.PIPELANE_BUILD_SHA?.trim();
  if (supplied) return supplied;
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function resolveBuildDirty() {
  const supplied = process.env.PIPELANE_BUILD_DIRTY?.trim().toLowerCase();
  if (supplied) {
    if (['1', 'true', 'yes'].includes(supplied)) return true;
    if (['0', 'false', 'no'].includes(supplied)) return false;
    throw new Error('PIPELANE_BUILD_DIRTY must be one of: 1, 0, true, false, yes, no.');
  }
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
  } catch {
    return false;
  }
}

function resolveBuildTimestamp() {
  const supplied = process.env.PIPELANE_BUILD_TIMESTAMP?.trim();
  if (supplied) {
    const parsed = new Date(supplied);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    throw new Error('PIPELANE_BUILD_TIMESTAMP must be an ISO-8601 timestamp.');
  }
  return new Date().toISOString();
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(temporaryPath, `${JSON.stringify({
  sha: resolveBuildSha(),
  dirty: resolveBuildDirty(),
  builtAt: resolveBuildTimestamp(),
}, null, 2)}\n`, 'utf8');
renameSync(temporaryPath, outputPath);
