import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(KIT_ROOT, 'test', 'fixtures', 'sample-repo');
const CLI_PATH = path.join(KIT_ROOT, 'src', 'cli.ts');
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-home-'));
process.env.NODE_ENV = 'test';
process.env.PIPELANE_AUTO_UPDATE = '0';
process.env.PIPELANE_HOME = TEST_HOME;
process.env.CODEX_HOME = path.join(TEST_HOME, 'codex');
process.env.CLAUDE_HOME = path.join(TEST_HOME, 'claude');

const localState = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'local-state.ts')).href);
const state = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'state.ts')).href);
const worktreeStatus = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'worktree-status.ts')).href);
const operator = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'index.ts')).href);
const apiActions = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'api', 'actions.ts')).href);
const destination = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'destination-planner.ts')).href);
const deploy = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'deploy.ts')).href);
const docs = await import(pathToFileURL(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts')).href);

const FIXED_TIME = '2026-07-13T00:00:00.000Z';

function git(repoRoot, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createRepo({ initialized = true } = {}) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-repo-'));
  cpSync(FIXTURE_ROOT, repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'codex@example.com']);
  git(repoRoot, ['config', 'user.name', 'Codex']);
  if (initialized) localState.initializeManagedLocalState(repoRoot);
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'Initial commit']);
  return repoRoot;
}

function cleanup(...paths) {
  for (const target of paths) rmSync(target, { recursive: true, force: true });
}

function excludePath(repoRoot) {
  return localState.resolveManagedLocalStateExcludePath(repoRoot);
}

function entry(entryPath, kind = 'directory', reason = 'machine-local runtime', createdAt = FIXED_TIME) {
  return { schemaVersion: 1, path: entryPath, kind, reason, createdAt };
}

function installEntries(repoRoot, entries) {
  const target = excludePath(repoRoot);
  const current = readFileSync(target);
  const parsed = localState.parseManagedLocalState(target, current);
  const block = localState.serializeManagedLocalStateBlock(entries);
  const boundary = parsed.userOwnedBytes.length > 0 && parsed.userOwnedBytes.at(-1) !== 0x0a ? Buffer.from('\n') : Buffer.alloc(0);
  writeFileSync(target, Buffer.concat([parsed.userOwnedBytes, boundary, block]));
  return block;
}

function stripManagedBlock(repoRoot) {
  const target = excludePath(repoRoot);
  const parsed = localState.parseManagedLocalState(target, readFileSync(target));
  writeFileSync(target, parsed.userOwnedBytes);
}

function runCli(repoRoot, args, env = {}, allowFailure = false) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PIPELANE_AUTO_UPDATE: '0',
      PIPELANE_HOME: process.env.PIPELANE_HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_HOME: process.env.CLAUDE_HOME,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}

function withEnv(patch, fn) {
  const before = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeMachineConfig(repoRoot, patch = {}) {
  const config = state.defaultWorkflowConfig('local-state-test', 'Local State Test', { repoRoot });
  config.prePrChecks = [];
  config.reviewGates = { policyVersion: 2, enforcementMode: 'legacy-v2', gates: [] };
  Object.assign(config, patch);
  state.writeWorkflowConfig(repoRoot, config);
  return config;
}

function addBareOrigin(repoRoot) {
  const bare = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-remote-'));
  git(repoRoot, ['clone', '--bare', repoRoot, bare]);
  git(repoRoot, ['remote', 'add', 'origin', bare]);
  git(repoRoot, ['push', '-u', 'origin', 'main']);
  return bare;
}

function createRemoteConflict(repoRoot, bare, writes) {
  const clone = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-remote-clone-'));
  git(repoRoot, ['clone', bare, clone]);
  git(clone, ['config', 'user.email', 'remote@example.com']);
  git(clone, ['config', 'user.name', 'Remote']);
  for (const [relativePath, contents] of Object.entries(writes)) {
    mkdirSync(path.dirname(path.join(clone, relativePath)), { recursive: true });
    writeFileSync(path.join(clone, relativePath), contents);
  }
  git(clone, ['add', '-f', ...Object.keys(writes)]);
  git(clone, ['commit', '-m', 'Track prospective managed root']);
  git(clone, ['push', 'origin', 'main']);
  return clone;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('[T01] local-state missing block errors while empty and populated canonical blocks parse', () => {
  const missing = Buffer.from('user-owned\n');
  assert.throws(() => localState.parseManagedLocalState('/tmp/exclude-T01', missing), /\/tmp\/exclude-T01.*required v1 block is missing/);
  const empty = localState.emptyManagedLocalStateBlock();
  assert.deepEqual(localState.parseManagedLocalState('/tmp/exclude-T01', empty).entries, []);
  const populated = localState.serializeManagedLocalStateBlock([entry('runtime')]);
  assert.deepEqual(localState.parseManagedLocalState('/tmp/exclude-T01', populated).entries, [entry('runtime')]);
});

test('[T02] local-state canonical LF preserves LF and CRLF user bytes plus file mode', () => {
  const repoRoot = createRepo();
  try {
    const target = excludePath(repoRoot);
    const userBytes = Buffer.from('lf-line\ncrlf-line\r\nno-final-newline');
    writeFileSync(target, userBytes);
    chmodSync(target, 0o640);
    localState.initializeManagedLocalState(repoRoot);
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'preserve bytes', { now: () => FIXED_TIME });
    const parsed = localState.parseManagedLocalState(target, readFileSync(target));
    assert.deepEqual(parsed.userOwnedBytes, userBytes);
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.equal(parsed.canonicalBlock.includes(Buffer.from('\r')), false);
  } finally { cleanup(repoRoot); }
});

test('[T03] local-state partial duplicate nested and out-of-order markers fail with the exclude path', () => {
  const p = '/tmp/exact-info-exclude-T03';
  const start = localState.MANAGED_LOCAL_STATE_START_MARKER;
  const end = localState.MANAGED_LOCAL_STATE_END_MARKER;
  const cases = [
    `${start}\n`,
    `${start}\n${start}\n${end}\n`,
    `${start}\n${start}\n${end}\n${end}\n`,
    `${end}\n${start}\n`,
  ];
  for (const value of cases) assert.throws(() => localState.parseManagedLocalState(p, Buffer.from(value)), new RegExp(p));
});

test('[T04] local-state rejects invalid and noncanonical metadata, Unicode, timestamp, and pattern drift', () => {
  const start = localState.MANAGED_LOCAL_STATE_START_MARKER;
  const end = localState.MANAGED_LOCAL_STATE_END_MARKER;
  const line = (json, pattern = '/runtime/') => Buffer.from(`${start}\n# pipelane-entry: ${json}\n${pattern}\n${end}\n`);
  const valid = entry('runtime');
  const cases = [
    line('{bad json'),
    line(JSON.stringify({ path: 'runtime', schemaVersion: 1, kind: 'directory', reason: 'x', createdAt: FIXED_TIME })),
    line('{"schemaVersion":1,"path":"runtime","kind":"directory","reason":"\\ud800","createdAt":"2026-07-13T00:00:00.000Z"}'),
    line(JSON.stringify({ ...valid, createdAt: '2026-07-13T00:00:00Z' })),
    line(JSON.stringify(valid).replace('runtime', '\\u0072untime')),
    line(JSON.stringify(valid), '/different/'),
  ];
  for (const value of cases) assert.throws(() => localState.parseManagedLocalState('/tmp/T04-exclude', value), /Invalid Pipelane local-state configuration/);
});

test('[T05] local-state enforces entry, block, file, and reason bounds before writes', () => {
  assert.throws(
    () => localState.serializeManagedLocalStateBlock(Array.from({ length: 129 }, (_, i) => entry(`r${i}`))),
    /limit of 128/,
  );
  assert.throws(() => localState.serializeManagedLocalStateBlock([entry('runtime', 'directory', 'x'.repeat(257))]), /256 Unicode scalar/);
  assert.throws(
    () => localState.serializeManagedLocalStateBlock(Array.from({ length: 128 }, (_, i) => entry(`r${i}`, 'directory', '😀'.repeat(256)))),
    /managed block exceeds 65536 bytes/,
  );
  assert.throws(
    () => localState.parseManagedLocalState('/tmp/T05-exclude', Buffer.alloc(localState.MANAGED_LOCAL_STATE_MAX_FILE_BYTES + 1)),
    /exceeds 1048576 bytes/,
  );
});

test('[T06] local-state metacharacters produce exact root-only file and directory Git matches', () => {
  const repoRoot = createRepo();
  const specialFile = 'local #!*[?]\\ file ';
  const specialDir = 'dir #!*[?]\\ space ';
  try {
    writeFileSync(path.join(repoRoot, specialFile), 'secret');
    mkdirSync(path.join(repoRoot, specialDir));
    writeFileSync(path.join(repoRoot, specialDir, 'inside.txt'), 'secret');
    localState.addManagedLocalState(repoRoot, specialFile, 'exact file', { now: () => FIXED_TIME });
    localState.addManagedLocalState(repoRoot, specialDir, 'exact directory', { now: () => FIXED_TIME });
    assert.equal(git(repoRoot, ['status', '--short']), '');
    writeFileSync(path.join(repoRoot, `${specialFile}x`), 'visible');
    assert.match(git(repoRoot, ['status', '--short']), /local/);
    const parsed = localState.parseManagedLocalState(excludePath(repoRoot), readFileSync(excludePath(repoRoot)));
    assert.match(parsed.canonicalBlock.toString('utf8'), /\\#\\!\\\*\\\[\\\?\\\]\\\\/);
  } finally { cleanup(repoRoot); }
});

test('[T07] local-state rejects unsafe paths, missing roots, and root symlinks', () => {
  for (const value of ['', '.', '/', '/absolute', '../escape', 'a/../b', '.git', '.git/config', 'bad\u0000path', 'bad\npath']) {
    assert.throws(() => localState.normalizeManagedLocalStatePath(value));
  }
  const repoRoot = createRepo();
  try {
    assert.throws(() => localState.planManagedLocalStateAdd(repoRoot, 'missing', 'x', FIXED_TIME), /existing exact file or directory/);
    symlinkSync('README.md', path.join(repoRoot, 'runtime-link'));
    assert.throws(() => localState.planManagedLocalStateAdd(repoRoot, 'runtime-link', 'x', FIXED_TIME), /symlink/);
  } finally { cleanup(repoRoot); }
});

test('[T08] local-state tracked roots descendants ancestors duplicate and overlap reject without exclude writes', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'tracked-root'));
    writeFileSync(path.join(repoRoot, 'tracked-root', 'child'), 'tracked');
    git(repoRoot, ['add', '-f', 'tracked-root/child']);
    const before = readFileSync(excludePath(repoRoot));
    assert.throws(() => localState.addManagedLocalState(repoRoot, 'tracked-root', 'x', { now: () => FIXED_TIME }), /tracked path/);
    assert.deepEqual(readFileSync(excludePath(repoRoot)), before);
    assert.throws(() => localState.serializeManagedLocalStateBlock([entry('a'), entry('a')]), /Duplicate/);
    assert.throws(() => localState.serializeManagedLocalStateBlock([entry('a'), entry('a/b')]), /Overlapping/);

    const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], { input: 'ancestor' });
    git(repoRoot, ['update-index', '--index-info'], {
      input: `100644 ${blob} 1\tancestor\n100644 ${blob} 2\tancestor\n100644 ${blob} 3\tancestor\n`,
    });
    installEntries(repoRoot, [entry('ancestor/runtime')]);
    const inspection = localState.inspectManagedLocalState(repoRoot);
    for (const stage of [1, 2, 3]) assert.match(inspection.warnings.join('\n'), new RegExp(`index stage ${stage}`));
  } finally { cleanup(repoRoot); }
});

test('[T09] local-state linked worktree conflict blocks only the affected index', () => {
  const repoRoot = createRepo();
  const linked = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-linked-'));
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'shared runtime', { now: () => FIXED_TIME });
    git(repoRoot, ['worktree', 'add', '-b', 'conflicting', linked, 'main']);
    mkdirSync(path.join(linked, 'runtime'));
    writeFileSync(path.join(linked, 'runtime', 'tracked.txt'), 'tracked');
    git(linked, ['add', '-f', 'runtime/tracked.txt']);
    git(linked, ['commit', '-m', 'Track runtime on linked branch']);
    assert.equal(localState.inspectManagedLocalState(repoRoot).valid, true);
    assert.equal(localState.inspectManagedLocalState(linked).valid, false);
    assert.match(localState.inspectManagedLocalState(linked).warnings.join('\n'), /tracked path runtime\/tracked.txt/);
  } finally { cleanup(linked, repoRoot); }
});

test('[T10] local-state inspection uses three batches and validates actual plus synthetic directory probes', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'directory probe', { now: () => FIXED_TIME });
    rmSync(path.join(repoRoot, 'runtime'), { recursive: true });
    const inspection = localState.inspectManagedLocalState(repoRoot);
    assert.equal(inspection.valid, true);
    assert.equal(inspection.validationGitCalls, 3);
    assert.equal(inspection.entries[0].actualKind, 'missing');
    assert.equal(inspection.entries[0].pattern, '/runtime/');
  } finally { cleanup(repoRoot); }
});

test('[T11] local-state higher-precedence tracked negation reports source and pattern as unreliable', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'x');
    localState.addManagedLocalState(repoRoot, 'runtime', 'negation test', { now: () => FIXED_TIME });
    writeFileSync(path.join(repoRoot, '.gitignore'), '!runtime/\n!runtime/**\n');
    git(repoRoot, ['add', '.gitignore']);
    git(repoRoot, ['commit', '-m', 'Negate runtime ignore']);
    const inspection = localState.inspectManagedLocalState(repoRoot);
    assert.equal(inspection.valid, false);
    assert.equal(inspection.reliable, false);
    assert.match(inspection.warnings.join('\n'), /\.gitignore.*!runtime/);
  } finally { cleanup(repoRoot); }
});

test('[T12] local-state ls-files and index batch failures or malformed responses block clearly', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'a', 'runtime'), { recursive: true });
    localState.addManagedLocalState(repoRoot, 'a/runtime', 'Git diagnostics', { now: () => FIXED_TIME });
    for (const [key, label] of [
      ['PIPELANE_LOCAL_STATE_GIT_FAIL', 'ls-files'],
      ['PIPELANE_LOCAL_STATE_GIT_MALFORM', 'ls-files'],
      ['PIPELANE_LOCAL_STATE_GIT_FAIL', 'index-ancestors'],
      ['PIPELANE_LOCAL_STATE_GIT_MALFORM', 'index-ancestors'],
    ]) {
      const inspection = withEnv({ [key]: label }, () => localState.inspectManagedLocalState(repoRoot));
      assert.equal(inspection.valid, false);
      assert.match(inspection.warnings.join('\n'), /git (?:ls-files|index-ancestors|cat-file)/);
    }
  } finally { cleanup(repoRoot); }
});

test('[T13] local-state check-ignore failure or malformed output never partially succeeds', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'ignore diagnostics', { now: () => FIXED_TIME });
    for (const key of ['PIPELANE_LOCAL_STATE_GIT_FAIL', 'PIPELANE_LOCAL_STATE_GIT_MALFORM']) {
      const inspection = withEnv({ [key]: 'check-ignore' }, () => localState.inspectManagedLocalState(repoRoot));
      assert.equal(inspection.valid, false);
      assert.match(inspection.warnings.join('\n'), /managed ignore verification failed/);
    }
  } finally { cleanup(repoRoot); }
});

test('[T14] local-state exclude missing unreadable oversized directory and symlink shapes fail with guidance', () => {
  const repoRoot = createRepo();
  const target = excludePath(repoRoot);
  const saved = readFileSync(target);
  try {
    rmSync(target);
    assert.match(localState.inspectManagedLocalState(repoRoot).warnings.join('\n'), /setup/);
    writeFileSync(target, saved);
    chmodSync(target, 0o000);
    const unreadable = localState.inspectManagedLocalState(repoRoot);
    assert.equal(unreadable.valid, false);
    assert.match(unreadable.warnings.join('\n'), /unreadable/);
    chmodSync(target, 0o600);
    writeFileSync(target, Buffer.alloc(localState.MANAGED_LOCAL_STATE_MAX_FILE_BYTES + 1));
    assert.match(localState.inspectManagedLocalState(repoRoot).warnings.join('\n'), /exceeds/);
    rmSync(target);
    mkdirSync(target);
    assert.match(localState.inspectManagedLocalState(repoRoot).warnings.join('\n'), /not a regular file/);
    rmSync(target, { recursive: true });
    const real = `${target}.real`;
    writeFileSync(real, saved);
    symlinkSync(real, target);
    assert.match(localState.inspectManagedLocalState(repoRoot).warnings.join('\n'), /symlink/);
  } finally {
    try { chmodSync(target, 0o600); } catch {}
    cleanup(repoRoot);
  }
});

test('[T15] local-state outside edits trigger one rebuild and a repeated edit stops without overwrite', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    let edits = 0;
    localState.addManagedLocalState(repoRoot, 'runtime', 'retry once', {
      now: () => FIXED_TIME,
      beforeCompare: (attempt, target) => {
        if (attempt === 0) {
          edits += 1;
          writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from('# outside-one\n')]));
        }
      },
    });
    assert.equal(edits, 1);
    assert.match(readFileSync(excludePath(repoRoot), 'utf8'), /outside-one/);
    mkdirSync(path.join(repoRoot, 'runtime-two'));
    assert.throws(() => localState.addManagedLocalState(repoRoot, 'runtime-two', 'retry twice', {
      now: () => FIXED_TIME,
      beforeCompare: (attempt, target) => writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from(`# outside-${attempt + 2}\n`)])),
    }), /Concurrent edit detected twice/);
    assert.match(readFileSync(excludePath(repoRoot), 'utf8'), /outside-3/);
  } finally { cleanup(repoRoot); }
});

test('[T16] local-state token leases serialize and reclaim only provably dead owners', () => {
  const repoRoot = createRepo();
  const commonDir = state.resolveGitCommonDir(repoRoot);
  const leasePath = localState.resolveManagedLocalStateLeasePath(repoRoot);
  try {
    const lease = localState.acquireManagedLocalStateWriterLease(commonDir, { waitMs: 0 });
    assert.throws(() => localState.acquireManagedLocalStateWriterLease(commonDir, { waitMs: 0 }), /still live.*Do not delete/);
    assert.equal(localState.releaseManagedLocalStateWriterLease({ ...lease, token: '0'.repeat(64) }), false);
    assert.equal(existsSync(leasePath), true);
    assert.equal(localState.releaseManagedLocalStateWriterLease(lease), true);

    mkdirSync(leasePath);
    writeFileSync(path.join(leasePath, 'owner.json'), `${JSON.stringify({ pid: 99999999, acquiredAt: FIXED_TIME, token: '1'.repeat(64) })}\n`);
    const reclaimed = withEnv({ PIPELANE_LOCAL_STATE_TEST_LIVENESS: 'dead' }, () => localState.acquireManagedLocalStateWriterLease(commonDir, { waitMs: 0 }));
    assert.equal(localState.releaseManagedLocalStateWriterLease(reclaimed), true);

    mkdirSync(leasePath);
    writeFileSync(path.join(leasePath, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: FIXED_TIME, token: '2'.repeat(64) })}\n`);
    assert.throws(
      () => withEnv({ PIPELANE_LOCAL_STATE_TEST_LIVENESS: 'unverifiable' }, () => localState.acquireManagedLocalStateWriterLease(commonDir, { waitMs: 0 })),
      /cannot be inspected/,
    );
    rmSync(leasePath, { recursive: true });
    mkdirSync(leasePath);
    writeFileSync(path.join(leasePath, 'owner.json'), 'malformed');
    assert.throws(() => localState.acquireManagedLocalStateWriterLease(commonDir, { waitMs: 0 }), /missing or malformed/);
  } finally { cleanup(leasePath, repoRoot); }
});

test('[T17] local-state pre-rename failure keeps original bytes and stale temp files are harmless', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    const target = excludePath(repoRoot);
    const original = readFileSync(target);
    const stale = path.join(path.dirname(target), '.pipelane-local-state-stale.tmp');
    writeFileSync(stale, 'stale');
    assert.throws(() => localState.addManagedLocalState(repoRoot, 'runtime', 'interrupt', {
      now: () => FIXED_TIME,
      beforeRename: () => { throw new Error('simulated interruption'); },
    }), /simulated interruption/);
    assert.deepEqual(readFileSync(target), original);
    assert.equal(readFileSync(stale, 'utf8'), 'stale');
    assert.equal(readdirSync(path.dirname(target)).filter((name) => name.includes(String(process.pid))).length, 0);
  } finally { cleanup(repoRoot); }
});

test('[T18] local-state verification rollback is conditional and never overwrites concurrent drift', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    const target = excludePath(repoRoot);
    const original = readFileSync(target);
    assert.throws(() => localState.addManagedLocalState(repoRoot, 'runtime', 'verify', {
      now: () => FIXED_TIME,
      verify: () => { throw new Error('verification failed'); },
    }), /prior exclude bytes were restored/);
    assert.deepEqual(readFileSync(target), original);
    assert.throws(() => localState.addManagedLocalState(repoRoot, 'runtime', 'verify drift', {
      now: () => FIXED_TIME,
      verify: (_root, candidate) => {
        writeFileSync(target, Buffer.concat([candidate, Buffer.from('# concurrent drift\n')]));
        throw new Error('verification failed after drift');
      },
    }), /were not restored/);
    assert.match(readFileSync(target, 'utf8'), /concurrent drift/);
  } finally { cleanup(repoRoot); }
});

test('[T19] local-state list text and JSON cover empty present missing conflict without content disclosure', () => {
  const repoRoot = createRepo();
  try {
    const empty = JSON.parse(runCli(repoRoot, ['run', 'local-state', 'list', '--json']).stdout);
    assert.deepEqual(empty.entries, []);
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'private-token-name'), 'do-not-print');
    localState.addManagedLocalState(repoRoot, 'runtime', 'list states', { now: () => FIXED_TIME });
    let text = runCli(repoRoot, ['run', 'local-state', 'list']).stdout;
    assert.match(text, /runtime \[directory\] present/);
    assert.doesNotMatch(text, /private-token-name|do-not-print/);
    rmSync(path.join(repoRoot, 'runtime'), { recursive: true });
    const missing = JSON.parse(runCli(repoRoot, ['run', 'local-state', 'list', '--json']).stdout);
    assert.equal(missing.entries[0].present, false);
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'tracked'), 'x');
    git(repoRoot, ['add', '-f', 'runtime/tracked']);
    const conflict = JSON.parse(runCli(repoRoot, ['run', 'local-state', 'list', '--json']).stdout);
    assert.equal(conflict.entries[0].conflict, true);
  } finally { cleanup(repoRoot); }
});

test('[T20] local-state prompt accept writes once while refusal and EOF write nothing', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    const target = excludePath(repoRoot);
    const before = readFileSync(target);
    const refused = JSON.parse(runCli(repoRoot, ['run', 'local-state', 'add', '--path', 'runtime', '--reason', 'prompt', '--json'], { PIPELANE_LOCAL_STATE_CONFIRM_STUB: 'no' }).stdout);
    assert.equal(refused.cancelled, true);
    assert.deepEqual(readFileSync(target), before);
    runCli(repoRoot, ['run', 'local-state', 'add', '--path', 'runtime', '--reason', 'prompt', '--json'], { PIPELANE_LOCAL_STATE_CONFIRM_STUB: 'yes' });
    assert.equal(localState.inspectManagedLocalState(repoRoot).entries.length, 1);
    runCli(repoRoot, ['run', 'local-state', 'remove', '--path', 'runtime', '--yes']);
    const eof = JSON.parse(runCli(repoRoot, ['run', 'local-state', 'add', '--path', 'runtime', '--reason', 'prompt', '--json'], { PIPELANE_LOCAL_STATE_CONFIRM_STUB: 'eof' }).stdout);
    assert.equal(eof.cancelled, true);
    assert.equal(localState.inspectManagedLocalState(repoRoot).entries.length, 0);

    const planned = localState.planManagedLocalStateAdd(repoRoot, 'runtime', 'kind-bound approval', FIXED_TIME);
    rmSync(path.join(repoRoot, 'runtime'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'runtime'), 'now a file');
    const beforeDriftedAdd = readFileSync(target);
    assert.throws(
      () => localState.addPlannedManagedLocalState(repoRoot, planned),
      /changed after authorization[\s\S]*Approved kind: directory; current kind: file/,
    );
    assert.deepEqual(readFileSync(target), beforeDriftedAdd);
    assert.equal(localState.inspectManagedLocalState(repoRoot).entries.length, 0);
  } finally { cleanup(repoRoot); }
});

test('[T21] local-state non-TTY requires path reason and yes in every combination', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    const incomplete = [
      ['run', 'local-state', 'add'],
      ['run', 'local-state', 'add', '--path', 'runtime'],
      ['run', 'local-state', 'add', '--reason', 'needed'],
      ['run', 'local-state', 'add', '--yes'],
      ['run', 'local-state', 'add', '--path', 'runtime', '--reason', 'needed'],
      ['run', 'local-state', 'add', '--path', 'runtime', '--yes'],
      ['run', 'local-state', 'add', '--reason', 'needed', '--yes'],
    ];
    for (const args of incomplete) assert.notEqual(runCli(repoRoot, args, {}, true).status, 0, args.join(' '));
    runCli(repoRoot, ['run', 'local-state', 'add', '--path', 'runtime', '--reason', 'needed', '--yes']);
    assert.equal(localState.inspectManagedLocalState(repoRoot).entries[0].path, 'runtime');
  } finally { cleanup(repoRoot); }
});

test('[T22] local-state remove is exact, tolerates missing root, retains empty block, and never deletes content', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'keep');
    localState.addManagedLocalState(repoRoot, 'runtime', 'remove', { now: () => FIXED_TIME });
    assert.notEqual(runCli(repoRoot, ['run', 'local-state', 'remove', '--path', 'other', '--yes'], {}, true).status, 0);
    const approvedRemoval = localState.planManagedLocalStateRemove(repoRoot, 'runtime');
    localState.removeManagedLocalState(repoRoot, 'runtime');
    localState.addManagedLocalState(repoRoot, 'runtime', 'replacement', { now: () => '2026-07-13T00:00:01.000Z' });
    const beforeReplacedRemoval = readFileSync(excludePath(repoRoot));
    assert.throws(
      () => localState.removePlannedManagedLocalState(repoRoot, approvedRemoval),
      /declaration for runtime changed after authorization/,
    );
    assert.deepEqual(readFileSync(excludePath(repoRoot)), beforeReplacedRemoval);
    assert.equal(localState.inspectManagedLocalState(repoRoot).entries[0].reason, 'replacement');
    rmSync(path.join(repoRoot, 'runtime'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'keep');
    runCli(repoRoot, ['run', 'local-state', 'remove', '--path', 'runtime', '--yes']);
    assert.equal(readFileSync(path.join(repoRoot, 'runtime', 'state'), 'utf8'), 'keep');
    assert.deepEqual(localState.parseManagedLocalState(excludePath(repoRoot), readFileSync(excludePath(repoRoot))).canonicalBlock, localState.emptyManagedLocalStateBlock());
  } finally { cleanup(repoRoot); }
});

test('[T23] local-state path flag scope subcommands dispatch and help validate', () => {
  const repoRoot = createRepo();
  try {
    assert.notEqual(runCli(repoRoot, ['run', 'status', '--path', 'runtime'], {}, true).status, 0);
    assert.notEqual(runCli(repoRoot, ['run', 'local-state', 'future'], {}, true).status, 0);
    assert.notEqual(runCli(repoRoot, ['run', 'local-state', 'list', '--path', 'runtime'], {}, true).status, 0);
    const help = runCli(repoRoot, ['run', '--help']).stdout;
    assert.match(help, /local-state add --path <path> --reason <text>/);
    assert.match(help, /local-state remove --path <path>/);
  } finally { cleanup(repoRoot); }
});

test('[T24] local-state empty block digest is stable, migration changes identity, and validation uses zero Git calls', () => {
  const repoRoot = createRepo();
  try {
    const valid = localState.inspectManagedLocalState(repoRoot);
    assert.equal(valid.validationGitCalls, 0);
    assert.equal(valid.canonicalBlockHash, '7a05ad02cd9063709d63289e8c154ec6715678314b934a3140c421d7a4355b5d');
    const validStatus = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
    stripManagedBlock(repoRoot);
    const missing = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
    assert.equal(missing.statusDigestReliable, false);
    assert.notEqual(missing.statusDigest, validStatus.statusDigest);
    localState.initializeManagedLocalState(repoRoot);
    assert.equal(worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest, validStatus.statusDigest);
  } finally { cleanup(repoRoot); }
});

test('[T25] local-state recreated managed runtime content leaves status digest and material tree stable', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'churn', { now: () => FIXED_TIME });
    const before = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true, includeMaterialTreeHash: true });
    for (let i = 0; i < 5; i += 1) writeFileSync(path.join(repoRoot, 'runtime', `state-${i}`), `value-${i}`);
    const after = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true, includeMaterialTreeHash: true });
    assert.equal(after.statusDigest, before.statusDigest);
    assert.equal(after.materialTreeHash, before.materialTreeHash);
    assert.equal(after.dirty, false);
  } finally { cleanup(repoRoot); }
});

test('[T26] local-state add remove and metadata edits change digest while final empty differs from missing legacy state', () => {
  const repoRoot = createRepo();
  try {
    const empty = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest;
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'first', { now: () => FIXED_TIME });
    const added = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest;
    installEntries(repoRoot, [entry('runtime', 'directory', 'edited')]);
    const edited = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest;
    localState.removeManagedLocalState(repoRoot, 'runtime');
    const removed = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest;
    assert.notEqual(added, empty);
    assert.notEqual(edited, added);
    assert.equal(removed, empty);
    stripManagedBlock(repoRoot);
    assert.notEqual(worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest, removed);
  } finally { cleanup(repoRoot); }
});

test('[T27] local-state unrelated valid info exclude edits leave status and review evidence identity stable', async () => {
  const repoRoot = createRepo();
  try {
    const reviewContract = await import(pathToFileURL(path.join(KIT_ROOT, 'dist', 'operator', 'review-contract.js')).href);
    const beforeStatus = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest;
    const beforeReview = reviewContract.buildReviewTargetManifest(repoRoot, 'main').manifest;
    const target = excludePath(repoRoot);
    writeFileSync(target, Buffer.concat([Buffer.from('user-only-pattern\n'), readFileSync(target)]));
    const afterStatus = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true }).statusDigest;
    const afterReview = reviewContract.buildReviewTargetManifest(repoRoot, 'main').manifest;
    assert.equal(afterStatus, beforeStatus);
    assert.equal(afterReview.targetDigest, beforeReview.targetDigest);
    assert.equal(afterReview.ignorePolicyDigest, beforeReview.ignorePolicyDigest);
  } finally { cleanup(repoRoot); }
});

test('[T28] local-state malformed and tracked conflict snapshots force dirty unreliable actionable warnings', () => {
  const repoRoot = createRepo();
  try {
    const target = excludePath(repoRoot);
    writeFileSync(target, `${localState.MANAGED_LOCAL_STATE_START_MARKER}\ntruncated\n`);
    let snapshot = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
    assert.equal(snapshot.dirty, true);
    assert.equal(snapshot.statusDigestReliable, false);
    assert.match(snapshot.statusDigestWarnings.join('\n'), /exactly one managed block/);
    writeFileSync(target, localState.emptyManagedLocalStateBlock());
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'tracked'), 'x');
    installEntries(repoRoot, [entry('runtime')]);
    git(repoRoot, ['add', '-f', 'runtime/tracked']);
    snapshot = worktreeStatus.readWorktreeStatusSnapshot(repoRoot, { includeStatusDigest: true });
    assert.equal(snapshot.dirty, true);
    assert.equal(snapshot.statusDigestReliable, false);
    assert.match(snapshot.statusDigestWarnings.join('\n'), /tracked path/);
  } finally { cleanup(repoRoot); }
});

test('[T29] local-state direct PR blocks before checks staging commit push or PR creation', () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot, { prePrChecks: ['node -e "require(\\\'fs\\\').writeFileSync(\\\'check-ran\\\',\\\'yes\\\')"'] });
    writeFileSync(path.join(repoRoot, 'source.txt'), 'change');
    stripManagedBlock(repoRoot);
    const head = git(repoRoot, ['rev-parse', 'HEAD']);
    const result = runCli(repoRoot, ['run', 'pr', '--title', 'Blocked PR'], {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed local-state is invalid/);
    assert.equal(existsSync(path.join(repoRoot, 'check-ran')), false);
    assert.equal(git(repoRoot, ['rev-parse', 'HEAD']), head);
    assert.match(git(repoRoot, ['status', '--short']), /source.txt/);
  } finally { cleanup(repoRoot); }
});

test('[T30] local-state PR stages normal source while managed runtime remains absent', () => {
  const repoRoot = createRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-gh-'));
  let bare = '';
  try {
    writeMachineConfig(repoRoot);
    git(repoRoot, ['switch', '-c', 'codex/local-state-pr']);
    bare = addBareOrigin(repoRoot);
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'private-state'), 'secret');
    localState.addManagedLocalState(repoRoot, 'runtime', 'PR staging', { now: () => FIXED_TIME });
    writeFileSync(path.join(repoRoot, 'source.txt'), 'normal source');
    const gh = path.join(ghBin, 'gh');
    writeFileSync(gh, '#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then printf "[]"; elif [ "$1 $2" = "pr create" ]; then printf "https://example.test/pr/1"; elif [ "$1 $2" = "pr view" ]; then printf "{}"; else exit 0; fi\n');
    chmodSync(gh, 0o755);
    runCli(repoRoot, ['run', 'pr', '--title', 'Managed runtime staging', '--message', 'Commit source'], { PATH: `${ghBin}:${process.env.PATH}` });
    assert.equal(git(repoRoot, ['show', '--format=', '--name-only', 'HEAD']).includes('source.txt'), true);
    assert.equal(git(repoRoot, ['ls-tree', '-r', '--name-only', 'HEAD']).includes('runtime/private-state'), false);
    assert.equal(readFileSync(path.join(repoRoot, 'runtime', 'private-state'), 'utf8'), 'secret');
  } finally { cleanup(ghBin, bare, repoRoot); }
});

test('[T31] local-state direct deploy dispatch blocks before locks records workflows or healthchecks', async () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot);
    stripManagedBlock(repoRoot);
    const commonDir = state.resolveGitCommonDir(repoRoot);
    const before = readdirSync(commonDir).sort();
    const parsed = state.parseOperatorArgs(['deploy', 'staging']);
    await assert.rejects(() => deploy.dispatchDeploy(repoRoot, parsed), /managed local-state is invalid/);
    assert.deepEqual(readdirSync(commonDir).sort(), before);
  } finally { cleanup(repoRoot); }
});

test('[T32] local-state destination execution blocks malformed state without review gates', () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot);
    writeFileSync(excludePath(repoRoot), `${localState.MANAGED_LOCAL_STATE_START_MARKER}\n`);
    const result = runCli(repoRoot, ['run', 'pr', '--title', 'Destination'], {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed local-state is invalid/);
    assert.doesNotMatch(result.stderr, /review gate/i);
  } finally { cleanup(repoRoot); }
});

test('[T33] local-state valid managed-only state plans from the committed milestone and SHA', () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot);
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'planning', { now: () => FIXED_TIME });
    writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'churn');
    const parsed = state.parseOperatorArgs(['pr', '--title', 'Plan']);
    const plan = destination.buildDestinationPlanForCommand(repoRoot, parsed);
    const head = git(repoRoot, ['rev-parse', 'HEAD']);
    assert.equal(plan.fingerprintInputs.targetSha, head);
    assert.equal(plan.fingerprintInputs.worktree.dirty, false);
    assert.equal(plan.fingerprintInputs.worktree.reliable, true);
    assert.doesNotMatch(JSON.stringify(plan), /runtime\/state/);
  } finally { cleanup(repoRoot); }
});

test('[T34] local-state policy edit after route confirmation produces approval fingerprint drift', () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot);
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'before', { now: () => FIXED_TIME });
    const parsed = state.parseOperatorArgs(['pr', '--title', 'Plan']);
    const first = destination.buildDestinationPlanForCommand(repoRoot, parsed);
    installEntries(repoRoot, [entry('runtime', 'directory', 'after')]);
    const second = destination.buildDestinationPlanForCommand(repoRoot, parsed);
    assert.notEqual(sha256(JSON.stringify(first.fingerprintInputs)), sha256(JSON.stringify(second.fingerprintInputs)));
  } finally { cleanup(repoRoot); }
});

test('[T35] local-state default cleanup plan retains managed ignored runtime content', () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot);
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'keep');
    localState.addManagedLocalState(repoRoot, 'runtime', 'cleanup scope', { now: () => FIXED_TIME });
    const result = runCli(repoRoot, ['run', 'clean', '--json'], {}, true);
    assert.equal(result.status, 0);
    assert.equal(readFileSync(path.join(repoRoot, 'runtime', 'state'), 'utf8'), 'keep');
    assert.equal(operator.classifyOperatorManagedStateSensitivity(state.parseOperatorArgs(['clean'])), 'independent-recovery');
  } finally { cleanup(repoRoot); }
});

test('[T36] local-state recreation between reads keeps review and route identity stable without PR or delete proposals', async () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot);
    mkdirSync(path.join(repoRoot, 'runtime'));
    localState.addManagedLocalState(repoRoot, 'runtime', 'background recreation', { now: () => FIXED_TIME });
    const reviewContract = await import(pathToFileURL(path.join(KIT_ROOT, 'dist', 'operator', 'review-contract.js')).href);
    const parsed = state.parseOperatorArgs(['deploy']);
    const beforeReview = reviewContract.buildReviewTargetManifest(repoRoot, 'main').manifest.targetDigest;
    const beforePlan = destination.buildDestinationPlanForCommand(repoRoot, parsed);
    for (let i = 0; i < 10; i += 1) {
      rmSync(path.join(repoRoot, 'runtime'), { recursive: true, force: true });
      mkdirSync(path.join(repoRoot, 'runtime'));
      writeFileSync(path.join(repoRoot, 'runtime', `recreated-${i}`), String(i));
    }
    const afterReview = reviewContract.buildReviewTargetManifest(repoRoot, 'main').manifest.targetDigest;
    const afterPlan = destination.buildDestinationPlanForCommand(repoRoot, parsed);
    assert.equal(afterReview, beforeReview);
    assert.deepEqual(afterPlan.fingerprintInputs, beforePlan.fingerprintInputs);
    assert.deepEqual(afterPlan.remainingSteps.map((step) => step.id), beforePlan.remainingSteps.map((step) => step.id));
    assert.doesNotMatch(afterPlan.message, /delete/i);
  } finally { cleanup(repoRoot); }
});

test('[T37] local-state tracked modifications remain visible and declaration conflict is reported', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'tracked'), 'one');
    git(repoRoot, ['add', '-f', 'runtime/tracked']);
    git(repoRoot, ['commit', '-m', 'Track runtime file']);
    installEntries(repoRoot, [entry('runtime')]);
    writeFileSync(path.join(repoRoot, 'runtime', 'tracked'), 'two');
    assert.match(git(repoRoot, ['status', '--short']), /M runtime\/tracked/);
    const inspection = localState.inspectManagedLocalState(repoRoot);
    assert.equal(inspection.valid, false);
    assert.match(inspection.warnings.join('\n'), /tracked path runtime\/tracked/);
  } finally { cleanup(repoRoot); }
});

test('[T38] local-state removing declaration makes existing files visible without deleting them', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'keep');
    runCli(repoRoot, ['run', 'local-state', 'add', '--path', 'runtime', '--reason', 'visibility', '--yes']);
    assert.equal(git(repoRoot, ['status', '--short']), '');
    runCli(repoRoot, ['run', 'local-state', 'remove', '--path', 'runtime', '--yes']);
    assert.match(git(repoRoot, ['status', '--short']), /runtime\//);
    assert.equal(readFileSync(path.join(repoRoot, 'runtime', 'state'), 'utf8'), 'keep');
  } finally { cleanup(repoRoot); }
});

test('[T39] local-state setup initializes once, preserves user bytes, and is shared by linked worktrees', () => {
  const repoRoot = createRepo({ initialized: false });
  const linked = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-setup-linked-'));
  try {
    const target = excludePath(repoRoot);
    const user = readFileSync(target);
    const first = docs.setupConsumerRepo(repoRoot);
    assert.equal(first.localStateInitialized, true);
    const parsed = localState.parseManagedLocalState(target, readFileSync(target));
    assert.deepEqual(parsed.userOwnedBytes, user);
    const bytes = readFileSync(target);
    const second = docs.setupConsumerRepo(repoRoot);
    assert.equal(second.localStateInitialized, false);
    assert.deepEqual(readFileSync(target), bytes);
    git(repoRoot, ['worktree', 'add', '-b', 'setup-linked', linked, 'main']);
    assert.equal(path.resolve(excludePath(linked)).replace(/^\/private\/var\//, '/var/'), path.resolve(target).replace(/^\/private\/var\//, '/var/'));
    assert.deepEqual(localState.parseManagedLocalState(excludePath(linked), readFileSync(excludePath(linked))).entries, []);
  } finally { cleanup(linked, repoRoot); }
});

test('[T40] local-state golden empty and Unicode bytes plus digest suffixes are exact', () => {
  const emptyText = '# >>> pipelane local-state v1 >>>\n# <<< pipelane local-state v1 <<<\n';
  const unicodeText = '# >>> pipelane local-state v1 >>>\n# pipelane-entry: {"schemaVersion":1,"path":"状态/é space","kind":"directory","reason":"本機 runtime ✨","createdAt":"2026-07-13T00:00:00.000Z"}\n/状态/é space/\n# <<< pipelane local-state v1 <<<\n';
  const unicode = localState.serializeManagedLocalStateBlock([entry('状态/é space', 'directory', '本機 runtime ✨')]);
  assert.deepEqual(localState.emptyManagedLocalStateBlock(), Buffer.from(emptyText, 'utf8'));
  assert.deepEqual(unicode, Buffer.from(unicodeText, 'utf8'));
  assert.equal(localState.managedLocalStateBlockHash(localState.emptyManagedLocalStateBlock()), '7a05ad02cd9063709d63289e8c154ec6715678314b934a3140c421d7a4355b5d');
  assert.equal(localState.managedLocalStateBlockHash(unicode), 'e1f8444a136d8b13a42d60b0534d58d3009668a17d6d5edf9476f8260dc6f245');
  assert.equal(localState.managedLocalStateDigestSuffix(unicode), '\0pipelane-managed-local-state-v1\0e1f8444a136d8b13a42d60b0534d58d3009668a17d6d5edf9476f8260dc6f245');
});

test('[T41] local-state file-directory kind drift is unreliable even when ignore probes match', () => {
  const repoRoot = createRepo();
  try {
    mkdirSync(path.join(repoRoot, 'as-directory'));
    writeFileSync(path.join(repoRoot, 'as-file'), 'file');
    localState.addManagedLocalState(repoRoot, 'as-directory', 'drift directory', { now: () => FIXED_TIME });
    localState.addManagedLocalState(repoRoot, 'as-file', 'drift file', { now: () => FIXED_TIME });
    rmSync(path.join(repoRoot, 'as-directory'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'as-directory'), 'now file');
    rmSync(path.join(repoRoot, 'as-file'));
    mkdirSync(path.join(repoRoot, 'as-file'));
    const inspection = localState.inspectManagedLocalState(repoRoot);
    assert.equal(inspection.reliable, false);
    assert.match(inspection.warnings.join('\n'), /expected directory, found file/);
    assert.match(inspection.warnings.join('\n'), /expected file, found directory/);
  } finally { cleanup(repoRoot); }
});

test('[T42] local-state prospective tree batch catches descendants and file ancestors plus failures', () => {
  const repoRoot = createRepo();
  const linked = mkdtempSync(path.join(os.tmpdir(), 'pipelane-local-state-target-'));
  try {
    mkdirSync(path.join(repoRoot, 'runtime-root'));
    mkdirSync(path.join(repoRoot, 'obstruct', 'nested'), { recursive: true });
    localState.addManagedLocalState(repoRoot, 'runtime-root', 'target descendant', { now: () => FIXED_TIME });
    localState.addManagedLocalState(repoRoot, 'obstruct/nested', 'target ancestor', { now: () => FIXED_TIME });
    git(repoRoot, ['worktree', 'add', '-b', 'target-conflict', linked, 'main']);
    mkdirSync(path.join(linked, 'runtime-root'));
    writeFileSync(path.join(linked, 'runtime-root', 'tracked'), 'x');
    writeFileSync(path.join(linked, 'obstruct'), 'file ancestor');
    git(linked, ['add', '-f', 'runtime-root/tracked', 'obstruct']);
    git(linked, ['commit', '-m', 'Prospective conflicts']);
    assert.throws(() => localState.assertManagedLocalStateValidForTree(repoRoot, 'target-conflict'), /obstructing blob ancestor.*tracks runtime-root/s);
    assert.throws(
      () => withEnv({ PIPELANE_LOCAL_STATE_GIT_FAIL: 'target-tree' }, () => localState.assertManagedLocalStateValidForTree(repoRoot, 'main')),
      /target-tree failed/,
    );
    assert.throws(
      () => withEnv({ PIPELANE_LOCAL_STATE_GIT_MALFORM: 'target-tree' }, () => localState.assertManagedLocalStateValidForTree(repoRoot, 'main')),
      /response|malformed/,
    );
  } finally { cleanup(linked, repoRoot); }
});

test('[T43] local-state revert PR validates current before fetch and target before switch', () => {
  const repoRoot = createRepo();
  try {
    writeMachineConfig(repoRoot);
    stripManagedBlock(repoRoot);
    const result = runCli(repoRoot, ['run', 'rollback', 'prod', '--revert-pr', '--sha', git(repoRoot, ['rev-parse', '--short', 'HEAD'])], {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed local-state is invalid/);
    const source = readFileSync(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'rollback.ts'), 'utf8');
    const currentGuard = source.indexOf('assertManagedLocalStateValid(context.repoRoot)', source.indexOf('async function handleRevertPr'));
    const fetch = source.indexOf("runGit(context.repoRoot, ['fetch'", currentGuard);
    const targetGuard = source.indexOf('assertManagedLocalStateValidForTree(context.repoRoot, baseRef)', fetch);
    const switchBranch = source.indexOf("runGit(context.repoRoot, ['switch', '-c'", targetGuard);
    assert.ok(currentGuard < fetch && fetch < targetGuard && targetGuard < switchBranch);
  } finally { cleanup(repoRoot); }
});

test('[T44] local-state catchup refuses fetched base that tracks or obstructs a live managed root', async () => {
  const repoRoot = createRepo();
  let bare = '';
  let clone = '';
  try {
    writeMachineConfig(repoRoot);
    mkdirSync(path.join(repoRoot, 'runtime'));
    writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'live');
    localState.addManagedLocalState(repoRoot, 'runtime', 'catchup', { now: () => FIXED_TIME });
    bare = addBareOrigin(repoRoot);
    clone = createRemoteConflict(repoRoot, bare, { 'runtime/tracked': 'remote' });
    const before = git(repoRoot, ['rev-parse', 'HEAD']);
    const parsed = state.parseOperatorArgs(['api', 'action', 'git.catchupBase']);
    const result = await apiActions.runActionExecute(repoRoot, 'git.catchupBase', parsed, '');
    assert.equal(result.ok, false);
    assert.match(result.message, /target validation blocked|tracks runtime/);
    assert.equal(git(repoRoot, ['rev-parse', 'HEAD']), before);
    assert.equal(readFileSync(path.join(repoRoot, 'runtime', 'state'), 'utf8'), 'live');
  } finally { cleanup(clone, bare, repoRoot); }
});

test('[T46] local-state merge deploy rollback and scoped cleanup retain independent recovery classification', () => {
  assert.equal(operator.classifyOperatorManagedStateSensitivity(state.parseOperatorArgs(['merge'])), 'independent-recovery');
  assert.equal(operator.classifyOperatorManagedStateSensitivity(state.parseOperatorArgs(['rollback', 'prod'])), 'independent-recovery');
  assert.equal(operator.classifyOperatorManagedStateSensitivity(state.parseOperatorArgs(['clean', '--apply', '--task', 'x'])), 'independent-recovery');
  assert.equal(apiActions.classifyStableActionManagedStateSensitivity('merge'), 'independent-recovery');
  assert.equal(apiActions.classifyStableActionManagedStateSensitivity('rollback.prod'), 'independent-recovery');
  assert.equal(apiActions.classifyStableActionManagedStateSensitivity('clean.apply'), 'independent-recovery');
});

test('[T48] local-state new and worktree-creating repo-guard reject conflicting base before writes', () => {
  for (const command of ['new', 'repo-guard']) {
    const repoRoot = createRepo();
    let bare = '';
    let clone = '';
    try {
      writeMachineConfig(repoRoot);
      mkdirSync(path.join(repoRoot, 'runtime'));
      writeFileSync(path.join(repoRoot, 'runtime', 'state'), 'live');
      localState.addManagedLocalState(repoRoot, 'runtime', `${command} target`, { now: () => FIXED_TIME });
      bare = addBareOrigin(repoRoot);
      clone = createRemoteConflict(repoRoot, bare, { 'runtime/descendant': 'remote' });
      const beforeWorktrees = git(repoRoot, ['worktree', 'list', '--porcelain']);
      const args = command === 'new'
        ? ['run', 'new', '--task', 'target-conflict']
        : ['run', 'repo-guard', '--task', 'target-conflict'];
      const result = runCli(repoRoot, args, {}, true);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /target validation blocked|tracks runtime/);
      assert.equal(git(repoRoot, ['worktree', 'list', '--porcelain']), beforeWorktrees);
      const stateDir = path.join(state.resolveMachineRepoDir(repoRoot), 'state', 'task-locks');
      assert.equal(existsSync(stateDir) ? readdirSync(stateDir).length : 0, 0);
    } finally { cleanup(clone, bare, repoRoot); }
  }
});
