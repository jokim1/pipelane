// Dev-tree <-> managed-runtime parity check (Convergence S0 exit criterion).
//
// Compares the local build against each installed managed runtime
// (~/.pipelane/runtimes/<host>, PIPELANE_HOME honored):
//   1. Content parity over every package-manifest entry, two-directional, so
//      stale extras retained inside a runtime are drift too.
//   2. Behavioral probe of the review surface: dynamically imports
//      review-gate-policy.js and review-data.js from both dists and compares
//      their exported contract values (policy versions, enforcement mode,
//      result-protocol markers).
//   3. Review/pr/merge surface digest report + provenance summary.
//
// Exit 0: parity (or no managed runtimes installed — reported, not an error).
// Exit 1: drift. Exit 2: local build missing.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const localRoot = process.cwd();
const RUNTIME_HOSTS = ['codex', 'claude'];
// Files the host installer writes into a runtime after the package copy.
const INSTALL_GENERATED = new Set([
  '.pipelane-runtime.json',
  'managed-skills.json',
  'bin/run-pipelane.sh',
  'bin/bootstrap-pipelane.sh',
]);
const REQUIRED_GENERATED_ASSETS = [
  'managed-skills.json',
  'bin/run-pipelane.sh',
  'bin/bootstrap-pipelane.sh',
];
const BUILD_INFO_RELATIVE = 'dist/build-info.json';
const REVIEW_SURFACE_MODULES = [
  'dist/operator/commands/review.js',
  'dist/operator/commands/pr.js',
  'dist/operator/commands/merge.js',
  'dist/operator/review-enforcement.js',
  'dist/operator/review-identity.js',
  'dist/operator/review-gates.js',
  'dist/operator/review-gate-policy.js',
  'dist/operator/review-data.js',
  'dist/operator/route-loop-safety.js',
];

function pipelaneHomeDir() {
  const override = process.env.PIPELANE_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.pipelane');
}

function readJson(target) {
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function digestFile(target) {
  return createHash('sha256').update(readFileSync(target)).digest('hex');
}

function sameBuildSha(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  if (normalizedLeft === normalizedRight) return true;
  if (!/^[a-f0-9]{7,40}$/.test(normalizedLeft) || !/^[a-f0-9]{7,40}$/.test(normalizedRight)) return false;
  const [shorter, longer] = normalizedLeft.length < normalizedRight.length
    ? [normalizedLeft, normalizedRight]
    : [normalizedRight, normalizedLeft];
  return longer.startsWith(shorter);
}

function walkFiles(root, relative = '') {
  const absolute = path.join(root, relative);
  const stats = statSync(absolute);
  if (stats.isFile()) {
    return [relative];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  const collected = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    collected.push(...walkFiles(root, relative ? `${relative}/${entry.name}` : entry.name));
  }
  return collected;
}

function manifestEntries(root) {
  const pkg = readJson(path.join(root, 'package.json')) ?? {};
  const fromManifest = Array.isArray(pkg.files)
    ? pkg.files.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  return [...new Set(['package.json', ...fromManifest])];
}

function collectManifestFiles(root) {
  const files = new Set();
  for (const entry of manifestEntries(root)) {
    if (!existsSync(path.join(root, entry))) {
      continue;
    }
    for (const file of walkFiles(root, entry)) {
      files.add(file.replaceAll('\\', '/'));
    }
  }
  return files;
}

function buildInfoDrift(localTarget, runtimeTarget) {
  const local = readJson(localTarget);
  const runtime = readJson(runtimeTarget);
  if (!local && !runtime) return null;
  if (!local || !runtime) return `${BUILD_INFO_RELATIVE}: missing on ${local ? 'runtime' : 'local'} side`;
  // builtAt is expected to differ between builds of the same tree.
  if (!sameBuildSha(local.sha, runtime.sha) || Boolean(local.dirty) !== Boolean(runtime.dirty)) {
    return `${BUILD_INFO_RELATIVE}: local ${local.sha}${local.dirty ? '-dirty' : ''} vs runtime ${runtime.sha}${runtime.dirty ? '-dirty' : ''}`;
  }
  return null;
}

function runtimeMetadataDrift(host, runtimeRoot) {
  const relative = '.pipelane-runtime.json';
  const metadata = readJson(path.join(runtimeRoot, relative));
  if (!metadata || metadata.managedBy !== 'pipelane') {
    return [`${relative}: missing or invalid managed-runtime metadata`];
  }
  const drift = [];
  if (metadata.host !== host) {
    drift.push(`${relative}: expected host ${host}, found ${JSON.stringify(metadata.host)}`);
  }
  if (typeof metadata.packageVersion !== 'string' || metadata.packageVersion.trim().length === 0) {
    drift.push(`${relative}: packageVersion is missing or invalid`);
  }
  if (typeof metadata.installedAt !== 'string' || Number.isNaN(Date.parse(metadata.installedAt))) {
    drift.push(`${relative}: installedAt is missing or invalid`);
  }
  return drift;
}

function generatedRuntimeDrift(runtimeRoot) {
  const drift = [];
  for (const relative of REQUIRED_GENERATED_ASSETS) {
    const target = path.join(runtimeRoot, relative);
    if (!existsSync(target)) {
      drift.push(`${relative}: missing generated runtime asset`);
    } else if (!statSync(target).isFile()) {
      drift.push(`${relative}: generated runtime asset is not a file`);
    }
  }
  const manifestPath = path.join(runtimeRoot, 'managed-skills.json');
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (!manifest || !Array.isArray(manifest.skills) || manifest.skills.some((entry) => typeof entry !== 'string')) {
      drift.push('managed-skills.json: invalid generated runtime manifest');
    }
  }
  return drift;
}

function compareManifest(runtimeRoot) {
  const drift = [];
  const localFiles = collectManifestFiles(localRoot);
  const runtimeFiles = collectManifestFiles(runtimeRoot);
  const union = [...new Set([...localFiles, ...runtimeFiles])].sort();
  let compared = 0;
  for (const relative of union) {
    if (INSTALL_GENERATED.has(relative)) {
      continue;
    }
    if (relative === BUILD_INFO_RELATIVE) {
      const infoDrift = buildInfoDrift(path.join(localRoot, relative), path.join(runtimeRoot, relative));
      if (infoDrift) drift.push(infoDrift);
      compared += 1;
      continue;
    }
    const localHas = localFiles.has(relative);
    const runtimeHas = runtimeFiles.has(relative);
    if (!localHas || !runtimeHas) {
      drift.push(`${relative}: only in ${localHas ? 'local build' : 'runtime'}`);
      continue;
    }
    compared += 1;
    if (digestFile(path.join(localRoot, relative)) !== digestFile(path.join(runtimeRoot, relative))) {
      drift.push(`${relative}: content differs`);
    }
  }
  return { drift, compared };
}

function comparableExports(moduleExports) {
  const values = {};
  for (const key of Object.keys(moduleExports).sort()) {
    const value = moduleExports[key];
    if (typeof value === 'function' || value === undefined) {
      continue;
    }
    try {
      values[key] = JSON.parse(JSON.stringify(value));
    } catch {
      values[key] = String(value);
    }
  }
  return values;
}

async function probeReviewSurface(runtimeRoot) {
  const drift = [];
  for (const relative of ['dist/operator/review-gate-policy.js', 'dist/operator/review-data.js']) {
    const localTarget = path.join(localRoot, relative);
    const runtimeTarget = path.join(runtimeRoot, relative);
    if (!existsSync(localTarget) || !existsSync(runtimeTarget)) {
      drift.push(`${relative}: missing on ${existsSync(localTarget) ? 'runtime' : 'local'} side`);
      continue;
    }
    const [localModule, runtimeModule] = await Promise.all([
      import(pathToFileURL(localTarget).href),
      import(pathToFileURL(runtimeTarget).href),
    ]);
    const localValues = comparableExports(localModule);
    const runtimeValues = comparableExports(runtimeModule);
    const keys = [...new Set([...Object.keys(localValues), ...Object.keys(runtimeValues)])].sort();
    for (const key of keys) {
      const localJson = JSON.stringify(localValues[key]);
      const runtimeJson = JSON.stringify(runtimeValues[key]);
      if (localJson !== runtimeJson) {
        drift.push(`${relative} export ${key}: local ${localJson} vs runtime ${runtimeJson}`);
      }
    }
  }
  return drift;
}

function localGitDescription() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: localRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: localRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
    return `${sha.slice(0, 12)}${dirty ? '-dirty' : ''}`;
  } catch {
    return 'unknown';
  }
}

async function main() {
  if (!existsSync(path.join(localRoot, 'dist', 'cli.js'))) {
    process.stderr.write('Local dist/cli.js is missing. Run `npm run build` first (or use `npm run parity:runtime`).\n');
    process.exit(2);
  }

  const buildInfo = readJson(path.join(localRoot, BUILD_INFO_RELATIVE));
  const lines = ['Runtime parity check'];
  lines.push(`Local: ${localRoot} @ git ${localGitDescription()} (dist built from ${buildInfo?.sha ? `${String(buildInfo.sha).slice(0, 12)}${buildInfo.dirty ? '-dirty' : ''}` : 'unknown'})`);

  const runtimeRoots = RUNTIME_HOSTS
    .map((host) => ({ host, root: path.join(pipelaneHomeDir(), 'runtimes', host) }))
    .filter((entry) => existsSync(entry.root));

  if (runtimeRoots.length === 0) {
    lines.push('No managed runtimes are installed; nothing to compare.');
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  let failed = false;
  for (const { host, root } of runtimeRoots) {
    const metadata = readJson(path.join(root, '.pipelane-runtime.json'));
    const provenance = metadata?.sourceSha
      ? `sourceSha ${String(metadata.sourceSha).slice(0, 12)}${metadata.sourceDirty ? '-dirty' : ''}`
      : 'sourceSha unknown';
    lines.push(`[${host}] ${root} (${provenance}, installed ${metadata?.installedAt ?? 'unknown'})`);

    const manifest = compareManifest(root);
    manifest.drift.unshift(...runtimeMetadataDrift(host, root), ...generatedRuntimeDrift(root));
    const surfaceProbe = await probeReviewSurface(root);
    const surfaceDigestDrift = manifest.drift.filter((entry) => REVIEW_SURFACE_MODULES.some((module) => entry.startsWith(module)));

    if (manifest.drift.length === 0) {
      lines.push(`[${host}] manifest parity: OK (${manifest.compared} files compared)`);
    } else {
      failed = true;
      lines.push(`[${host}] manifest parity: DRIFT (${manifest.drift.length} difference(s), ${manifest.compared} files compared)`);
      for (const entry of manifest.drift) {
        lines.push(`    - ${entry}`);
      }
    }

    if (surfaceProbe.length === 0) {
      lines.push(`[${host}] review-surface contract probe: OK (policy/enforcement/result-protocol exports match)`);
    } else {
      failed = true;
      lines.push(`[${host}] review-surface contract probe: DRIFT`);
      for (const entry of surfaceProbe) {
        lines.push(`    - ${entry}`);
      }
    }

    lines.push(surfaceDigestDrift.length === 0
      ? `[${host}] review/pr/merge surface parity: OK`
      : `[${host}] review/pr/merge surface parity: DRIFT (${surfaceDigestDrift.length} module(s))`);
  }

  lines.push(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.stdout.write(`${lines.join('\n')}\n`);
  if (failed) {
    process.exit(1);
  }
}

await main();
