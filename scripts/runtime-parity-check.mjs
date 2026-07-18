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
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
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
const REQUIRED_EXECUTABLE_ASSETS = [
  'bin/pipelane',
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
  'dist/operator/task-budget.js',
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

function pathEntryExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
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

function walkFiles(root, relative = '', invalid = []) {
  const normalizedRoot = path.resolve(root);
  const absolute = path.resolve(normalizedRoot, relative);
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${path.sep}`)) {
    invalid.push(`${relative}: manifest path escapes runtime root`);
    return [];
  }
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (stats.isSymbolicLink()) {
    invalid.push(`${relative}: symbolic links are not allowed in runtime payloads`);
    return [];
  }
  if (stats.isFile()) {
    return [relative];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  const collected = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    collected.push(...walkFiles(root, relative ? `${relative}/${entry.name}` : entry.name, invalid));
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
  const invalid = [];
  for (const entry of manifestEntries(root)) {
    for (const file of walkFiles(root, entry, invalid)) {
      files.add(file.replaceAll('\\', '/'));
    }
  }
  return { files, invalid };
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
  if (metadata.version !== 1) {
    drift.push(`${relative}: unsupported metadata version ${JSON.stringify(metadata.version)}`);
  }
  const runtimePackage = readJson(path.join(runtimeRoot, 'package.json'));
  if (!runtimePackage || typeof runtimePackage.version !== 'string' || runtimePackage.version.trim().length === 0) {
    drift.push('package.json: package version is missing or invalid');
  } else if (metadata.packageVersion !== runtimePackage.version.trim()) {
    drift.push(`${relative}: packageVersion ${JSON.stringify(metadata.packageVersion)} does not match package.json version ${JSON.stringify(runtimePackage.version.trim())}`);
  }
  if (typeof metadata.installedAt !== 'string' || Number.isNaN(Date.parse(metadata.installedAt))) {
    drift.push(`${relative}: installedAt is missing or invalid`);
  }
  if (typeof metadata.sourceSha !== 'string' || !/^[a-f0-9]{7,40}$/i.test(metadata.sourceSha.trim())) {
    drift.push(`${relative}: sourceSha is missing or invalid`);
  }
  if (metadata.sourceDirty !== undefined && typeof metadata.sourceDirty !== 'boolean') {
    drift.push(`${relative}: sourceDirty must be a boolean when present`);
  }
  const buildInfo = readJson(path.join(runtimeRoot, BUILD_INFO_RELATIVE));
  if (!buildInfo || typeof buildInfo.sha !== 'string' || !/^[a-f0-9]{7,40}$/i.test(buildInfo.sha.trim()) || typeof buildInfo.dirty !== 'boolean') {
    drift.push(`${BUILD_INFO_RELATIVE}: missing or invalid runtime build provenance`);
  } else if (
    typeof metadata.sourceSha === 'string'
    && /^[a-f0-9]{7,40}$/i.test(metadata.sourceSha.trim())
    && (!sameBuildSha(metadata.sourceSha, buildInfo.sha) || Boolean(metadata.sourceDirty) !== buildInfo.dirty)
  ) {
    drift.push(`${relative}: source provenance does not match ${BUILD_INFO_RELATIVE}`);
  }
  return drift;
}

function runtimeRootDrift(runtimeRoot) {
  const stats = lstatSync(runtimeRoot);
  return stats.isDirectory()
    ? []
    : ['runtime root: expected a real directory, not a symbolic link or other file'];
}

async function generatedRuntimeDrift(host, runtimeRoot) {
  const drift = [];
  for (const relative of REQUIRED_GENERATED_ASSETS) {
    const target = path.join(runtimeRoot, relative);
    if (!existsSync(target)) {
      drift.push(`${relative}: missing generated runtime asset`);
    } else if (!lstatSync(target).isFile()) {
      drift.push(`${relative}: generated runtime asset is not a file`);
    }
  }
  const manifestPath = path.join(runtimeRoot, 'managed-skills.json');
  if (existsSync(manifestPath) && lstatSync(manifestPath).isFile()) {
    const manifest = readJson(manifestPath);
    if (!manifest || !Array.isArray(manifest.skills) || manifest.skills.some((entry) => typeof entry !== 'string')) {
      drift.push('managed-skills.json: invalid generated runtime manifest');
    }
  }
  if (process.platform !== 'win32') {
    for (const relative of REQUIRED_EXECUTABLE_ASSETS) {
      const target = path.join(runtimeRoot, relative);
      if (!existsSync(target)) continue;
      if (!lstatSync(target).isFile()) {
        drift.push(`${relative}: runtime entrypoint is not a regular file`);
        continue;
      }
      try {
        accessSync(target, constants.X_OK);
      } catch {
        drift.push(`${relative}: runtime entrypoint is not executable`);
      }
    }
  }
  const renderingModulePath = path.join(localRoot, 'dist', 'operator', 'skill-rendering.js');
  if (existsSync(renderingModulePath)) {
    const rendering = await import(pathToFileURL(renderingModulePath).href);
    const managedPipelaneBin = path.join(runtimeRoot, 'bin', 'pipelane');
    const expected = new Map([
      ['bin/run-pipelane.sh', rendering.renderManagedRunnerScript({
        managedRuntimeRoot: runtimeRoot,
        managedPipelaneBin,
        hostLabel: host === 'claude' ? 'Claude' : 'Codex',
      })],
      ['bin/bootstrap-pipelane.sh', rendering.renderBootstrapScript(managedPipelaneBin)],
    ]);
    for (const [relative, body] of expected) {
      const target = path.join(runtimeRoot, relative);
      if (!existsSync(target) || !lstatSync(target).isFile()) continue;
      try {
        if (readFileSync(target, 'utf8') !== body) {
          drift.push(`${relative}: generated runtime content differs`);
        }
      } catch {
        drift.push(`${relative}: generated runtime content is unreadable`);
      }
    }
  }
  return drift;
}

function hostSkillsRootFor(host) {
  const home = host === 'claude'
    ? (process.env.CLAUDE_HOME?.trim() || path.join(os.homedir(), '.claude'))
    : (process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'));
  return path.join(home, 'skills');
}

function isSafeSkillName(skillName) {
  return (
    typeof skillName === 'string'
    && skillName.length > 0
    && skillName.trim() === skillName
    && !path.isAbsolute(skillName)
    && !skillName.includes('/')
    && !skillName.includes('\\')
    && skillName !== '.'
    && skillName !== '..'
  );
}

// The manifest cannot attest its own completeness: derive the expected skill
// set from the LOCAL tree's rendering (the independent authority parity
// already trusts for runner content). Required skills can never be
// collision-skipped at install, so required ⊆ manifest ⊆ all-expected.
async function expectedHostSkillNames(host, runtimeRoot) {
  const rendering = await import(pathToFileURL(path.join(localRoot, 'dist', 'operator', 'skill-rendering.js')).href);
  const state = await import(pathToFileURL(path.join(localRoot, 'dist', 'operator', 'state.js')).href);
  const fixPrompt = await import(pathToFileURL(path.join(localRoot, 'dist', 'operator', 'fix-prompt.js')).href);
  const lessonPrompt = await import(pathToFileURL(path.join(localRoot, 'dist', 'operator', 'lesson-prompt.js')).href);
  const binDir = path.join(runtimeRoot, 'bin');
  const install = rendering.desiredHostInstall(host, 'machine-local', state.defaultWorkflowConfig('pipelane', 'Pipelane'), {
    runnerPath: path.join(binDir, 'run-pipelane.sh'),
    managedRuntimeRoot: runtimeRoot,
    managedPipelaneBin: path.join(binDir, 'pipelane'),
    fixPromptBody: fixPrompt.readFixPromptBody(),
    lessonPromptBody: lessonPrompt.readLessonPromptBody(),
  });
  return {
    all: new Set(install.entries.map((entry) => entry.name)),
    required: new Set(install.entries.filter((entry) => entry.required).map((entry) => entry.name)),
    bodies: new Map(install.entries.map((entry) => [entry.name, entry.body])),
  };
}

// The runtime's managed-skills manifest and carried host-skill payloads must
// name real, byte-identical installed wrappers — an empty manifest or a
// mismatched wrapper is a mixed-version install, not a passing fleet.
async function managedSkillWrapperDrift(host, runtimeRoot) {
  const drift = [];
  const manifest = readJson(path.join(runtimeRoot, 'managed-skills.json'));
  const names = Array.isArray(manifest?.skills)
    ? manifest.skills.filter((entry) => typeof entry === 'string')
    : [];
  if (names.length === 0) {
    drift.push('managed-skills.json: no managed skills recorded');
    return drift;
  }
  let expected = null;
  try {
    expected = await expectedHostSkillNames(host, runtimeRoot);
  } catch (error) {
    drift.push(`managed-skills.json: completeness authority unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (expected) {
    for (const name of expected.required) {
      if (!names.includes(name)) {
        drift.push(`managed-skills.json: required skill ${name} is missing from the manifest`);
      }
    }
    for (const name of names) {
      if (!expected.all.has(name)) {
        drift.push(`managed-skills.json: skill ${name} is not part of the expected install set`);
      }
    }
  }
  const unsafe = names.filter((name) => !isSafeSkillName(name));
  if (unsafe.length > 0) {
    drift.push(`managed-skills.json: unsafe skill name(s): ${unsafe.join(', ')}`);
    return drift;
  }
  const payloadRoot = path.join(runtimeRoot, 'host-skills');
  if (!existsSync(payloadRoot)) {
    drift.push('host-skills: runtime carries no skill payloads (predates payload retention; reinstall to restore wrapper parity)');
    return drift;
  }
  if (!lstatSync(payloadRoot).isDirectory()) {
    drift.push('host-skills: payload root must be a real directory, not a symbolic link or other file');
    return drift;
  }
  const skillsRoot = hostSkillsRootFor(host);
  for (const name of names) {
    const payloadDir = path.join(payloadRoot, name);
    const payloadPath = path.join(payloadRoot, name, 'SKILL.md');
    if (!existsSync(payloadDir) || !lstatSync(payloadDir).isDirectory()) {
      drift.push(`host-skills/${name}: payload directory must be a real directory`);
      continue;
    }
    if (!existsSync(payloadPath) || !lstatSync(payloadPath).isFile()) {
      drift.push(`host-skills/${name}/SKILL.md: payload missing for manifest skill`);
      continue;
    }
    const payloadBody = readFileSync(payloadPath, 'utf8');
    const expectedBody = expected?.bodies.get(name);
    if (expectedBody !== undefined && payloadBody !== expectedBody) {
      drift.push(`host-skills/${name}/SKILL.md: payload content differs from local renderer`);
    }
    const wrapperPath = path.join(skillsRoot, name, 'SKILL.md');
    if (!existsSync(wrapperPath) || !lstatSync(wrapperPath).isFile()) {
      drift.push(`skills/${name}/SKILL.md: installed wrapper missing`);
      continue;
    }
    if (digestFile(payloadPath) !== digestFile(wrapperPath)) {
      drift.push(`skills/${name}/SKILL.md: installed wrapper content differs from runtime payload`);
    }
  }
  try {
    for (const entry of readdirSync(payloadRoot)) {
      if (!names.includes(entry)) {
        drift.push(`host-skills/${entry}: payload not recorded in managed-skills.json`);
      }
    }
  } catch {
    drift.push('host-skills: payload directory is unreadable');
  }
  // The manifest also cannot hide orphans: a wrapper carrying this host's
  // managed marker but absent from the manifest is a retired command still
  // exposed to the host.
  try {
    const rendering = await import(pathToFileURL(path.join(localRoot, 'dist', 'operator', 'skill-rendering.js')).href);
    const markerPrefix = host === 'claude'
      ? rendering.MACHINE_CLAUDE_SKILL_MARKER_PREFIX
      : rendering.MACHINE_CODEX_SKILL_MARKER_PREFIX;
    if (typeof markerPrefix === 'string' && markerPrefix.length > 0 && existsSync(skillsRoot)) {
      for (const entry of readdirSync(skillsRoot)) {
        if (names.includes(entry) || !isSafeSkillName(entry)) {
          continue;
        }
        const wrapperPath = path.join(skillsRoot, entry, 'SKILL.md');
        if (!existsSync(wrapperPath) || !lstatSync(wrapperPath).isFile()) {
          continue;
        }
        if (readFileSync(wrapperPath, 'utf8').includes(`${markerPrefix}${entry} -->`)) {
          drift.push(`skills/${entry}/SKILL.md: managed wrapper not recorded in managed-skills.json`);
        }
      }
    }
  } catch (error) {
    drift.push(`skills: orphan-wrapper scan unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
  return drift;
}

function compareManifest(runtimeRoot) {
  const drift = [];
  const localManifest = collectManifestFiles(localRoot);
  const runtimeManifest = collectManifestFiles(runtimeRoot);
  const localFiles = localManifest.files;
  const runtimeFiles = runtimeManifest.files;
  drift.push(...localManifest.invalid.map((entry) => `local build ${entry}`));
  drift.push(...runtimeManifest.invalid.map((entry) => `runtime ${entry}`));
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
    .filter((entry) => pathEntryExists(entry.root));

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

    const rootDrift = runtimeRootDrift(root);
    // An invalid root is already authoritative drift. Do not follow a runtime
    // root symlink or treat a regular file as a directory while collecting
    // secondary diagnostics from a tree that is outside the trust boundary.
    const manifest = rootDrift.length === 0
      ? compareManifest(root)
      : { drift: [...rootDrift], compared: 0 };
    // Never execute modules from a runtime whose packaged bytes already
    // differ. The behavioral probe is only safe after content parity proves
    // the imported module and all of its packaged dependencies are local bits.
    const surfaceProbe = rootDrift.length === 0 && manifest.drift.length === 0 ? await probeReviewSurface(root) : null;
    if (rootDrift.length === 0) {
      manifest.drift.unshift(...runtimeMetadataDrift(host, root), ...await generatedRuntimeDrift(host, root));
    }
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

    if (surfaceProbe === null) {
      lines.push(`[${host}] review-surface contract probe: SKIPPED (package content drift)`);
    } else if (surfaceProbe.length === 0) {
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

    const wrapperDrift = rootDrift.length === 0 ? await managedSkillWrapperDrift(host, root) : null;
    if (wrapperDrift === null) {
      lines.push(`[${host}] managed skill wrappers: SKIPPED (invalid runtime root)`);
    } else if (wrapperDrift.length === 0) {
      lines.push(`[${host}] managed skill wrappers: OK (manifest, payloads, and installed wrappers agree)`);
    } else {
      failed = true;
      lines.push(`[${host}] managed skill wrappers: DRIFT`);
      for (const entry of wrapperDrift) {
        lines.push(`    - ${entry}`);
      }
    }
  }

  lines.push(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.stdout.write(`${lines.join('\n')}\n`);
  if (failed) {
    process.exit(1);
  }
}

await main();
