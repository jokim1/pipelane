import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'run-tests.mjs');

test('runner passing fixture exits 0 and removes temp root', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'passing.test.mjs', `
    import test from 'node:test';
    test('passes', () => {});
  `);

  const result = await runRunner({ files: [fixture] });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(existsSync(parseTempDir(result.stderr)), false);
});

test('runner failing fixture exits nonzero and preserves temp root', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'failing.test.mjs', `
    import test from 'node:test';
    test('fails', () => {
      throw new Error('fixture failure');
    });
  `);

  const result = await runRunner({ files: [fixture] });
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.notEqual(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(existsSync(tempDir), true);
  assert.match(result.stderr, /preserved temp dir:/);
});

test('runner hanging fixture times out with 124 and preserves temp root', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'hanging.test.mjs', `
    import test from 'node:test';
    process.on('SIGTERM', () => {});
    test('hangs', async () => new Promise(() => {}));
  `);

  const result = await runRunner({
    files: [fixture],
    env: { PIPELANE_TEST_TIMEOUT_MS: '150', PIPELANE_TEST_KILL_GRACE_MS: '100' },
  });
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(result.code, 124, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(existsSync(tempDir), true);
  assert.match(result.stderr, /timeout after 150ms/);
  assert.match(result.stderr, /preserved temp dir:/);
});

test('runner timeout kills a grandchild process group member', async (t) => {
  const dir = makeFixtureDir(t);
  const marker = path.join(dir, 'grandchild-survived');
  const fixture = writeFixture(dir, 'grandchild.test.mjs', `
    import test from 'node:test';
    import { spawn } from 'node:child_process';
    process.on('SIGTERM', () => {});
    test('spawns grandchild then hangs', async () => {
      const marker = process.env.PIPELANE_GRANDCHILD_MARKER;
      const child = spawn(process.execPath, ['-e', \`
        const { writeFileSync } = require('node:fs');
        setTimeout(() => writeFileSync(\${JSON.stringify(marker)}, 'alive'), 900);
        setInterval(() => {}, 100);
      \`], { stdio: 'ignore' });
      child.unref();
      await new Promise(() => {});
    });
  `);

  const result = await runRunner({
    files: [fixture],
    env: {
      PIPELANE_GRANDCHILD_MARKER: marker,
      PIPELANE_TEST_TIMEOUT_MS: '150',
      PIPELANE_TEST_KILL_GRACE_MS: '100',
    },
  });
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(result.code, 124, result.stderr);
  await delay(1100);
  assert.equal(existsSync(marker), false, 'grandchild marker should not be written after process-group cleanup');
});

test('runner timeout escalates when only a grandchild survives SIGTERM', async (t) => {
  const dir = makeFixtureDir(t);
  const marker = path.join(dir, 'sigterm-ignored-grandchild-survived');
  const ready = path.join(dir, 'sigterm-ignored-grandchild-ready');
  const fixture = writeFixture(dir, 'grandchild-survives-sigterm.test.mjs', `
    import test from 'node:test';
    import { spawn } from 'node:child_process';
    import { existsSync } from 'node:fs';
    test('spawns sigterm-ignoring grandchild then lets parent die on SIGTERM', async () => {
      const marker = process.env.PIPELANE_GRANDCHILD_MARKER;
      const ready = process.env.PIPELANE_GRANDCHILD_READY;
      const child = spawn(process.execPath, ['-e', \`
        const { writeFileSync } = require('node:fs');
        process.on('SIGTERM', () => {});
        writeFileSync(\${JSON.stringify(ready)}, 'ready');
        setTimeout(() => writeFileSync(\${JSON.stringify(marker)}, 'alive'), 2500);
        setInterval(() => {}, 100);
      \`], { stdio: 'ignore' });
      child.unref();
      const deadline = Date.now() + 2000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise(() => {});
    });
  `);

  const result = await runRunner({
    files: [fixture],
    env: {
      PIPELANE_GRANDCHILD_MARKER: marker,
      PIPELANE_GRANDCHILD_READY: ready,
      PIPELANE_TEST_TIMEOUT_MS: '2000',
      PIPELANE_TEST_KILL_GRACE_MS: '100',
    },
  });
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(result.code, 124, result.stderr);
  assert.equal(existsSync(ready), true, 'grandchild should be ready before timeout cleanup');
  assert.match(result.stderr, /still alive; sending SIGKILL/);
  await delay(1700);
  assert.equal(existsSync(marker), false, 'SIGTERM-ignoring grandchild should not survive timeout escalation');
});

test('runner SIGINT terminates child group and reports the signal', async (t) => {
  await assertSignalCleanup(t, 'SIGINT', 130);
});

test('runner SIGTERM terminates child group and reports the signal', async (t) => {
  await assertSignalCleanup(t, 'SIGTERM', 143);
});

test('runner forwards node:test arguments', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'pattern.test.mjs', `
    import test from 'node:test';
    test('selected case', () => {});
    test('unselected failure', () => {
      throw new Error('this test should not run');
    });
  `);

  const result = await runRunner({
    files: [fixture],
    args: ['--test-name-pattern', '^selected case$'],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
});

test('runner prints heartbeat while fixture is still running', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'heartbeat.test.mjs', `
    import test from 'node:test';
    test('slow pass', async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
  `);

  const result = await runRunner({
    files: [fixture],
    env: { PIPELANE_TEST_HEARTBEAT_MS: '75' },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /heartbeat elapsed=/);
});

test('runner spawn failure exits nonzero and preserves temp root', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'passing.test.mjs', `
    import test from 'node:test';
    test('would pass', () => {});
  `);
  const missingNode = path.join(dir, 'missing-node');

  const result = await runRunner({
    files: [fixture],
    env: { PIPELANE_TEST_NODE: missingNode },
  });
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /spawn error:/);
  assert.equal(existsSync(tempDir), true);
});

test('runner rejects timer values above the Node timer range before invoking node', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'passing.test.mjs', `
    import test from 'node:test';
    test('would pass', () => {});
  `);

  const result = await runRunner({
    files: [fixture],
    env: { PIPELANE_TEST_TIMEOUT_MS: '2147483648' },
  });
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /PIPELANE_TEST_TIMEOUT_MS must be an integer from 1 to 2147483647 milliseconds/);
  assert.doesNotMatch(result.stderr, /child pid:/);
  assert.equal(existsSync(tempDir), true);
});

test('runner direct-node escape hatch bypasses supervisor timeout and warns', async (t) => {
  const dir = makeFixtureDir(t);
  const fixture = writeFixture(dir, 'direct.test.mjs', `
    import test from 'node:test';
    test('slow direct pass', async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
  `);

  const result = await runRunner({
    files: [fixture],
    env: {
      PIPELANE_TEST_DIRECT_NODE: '1',
      PIPELANE_TEST_TIMEOUT_MS: '50',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /PIPELANE_TEST_DIRECT_NODE=1/);
  assert.ok(result.elapsedMs >= 200, `direct-node run finished too quickly: ${result.elapsedMs}ms`);
});

test('runner injects sequential test concurrency for multi-file manifests', async (t) => {
  const dir = makeFixtureDir(t);
  const marker = path.join(dir, 'first-finished');
  const first = writeFixture(dir, 'a-first.test.mjs', `
    import test from 'node:test';
    import { writeFileSync } from 'node:fs';
    test('first file writes marker', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(process.env.PIPELANE_ORDER_MARKER, 'done');
    });
  `);
  const second = writeFixture(dir, 'b-second.test.mjs', `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    test('second file sees marker', () => {
      assert.equal(existsSync(process.env.PIPELANE_ORDER_MARKER), true);
    });
  `);

  const result = await runRunner({
    files: [second, first],
    env: { PIPELANE_ORDER_MARKER: marker },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /using --test-concurrency=1/);
});

test('runner does not inject test concurrency when caller sets it explicitly', async (t) => {
  const dir = makeFixtureDir(t);
  const first = writeFixture(dir, 'first.test.mjs', `
    import test from 'node:test';
    test('first pass', () => {});
  `);
  const second = writeFixture(dir, 'second.test.mjs', `
    import test from 'node:test';
    test('second pass', () => {});
  `);

  const result = await runRunner({
    files: [first, second],
    args: ['--test-concurrency=1'],
  });

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /using --test-concurrency=1/);
});

test('runner fixture file override runs only requested tiny files', async (t) => {
  const dir = makeFixtureDir(t);
  const requested = writeFixture(dir, 'requested.test.mjs', `
    import test from 'node:test';
    test('requested fixture', () => {});
  `);
  writeFixture(dir, 'unlisted-failure.test.mjs', `
    import test from 'node:test';
    test('unlisted failure', () => {
      throw new Error('unlisted file should not run');
    });
  `);

  const result = await runRunner({ files: [requested] });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /manifest \(1 file\):/);
  assert.match(result.stderr, /requested\.test\.mjs/);
  assert.doesNotMatch(result.stderr, /unlisted-failure\.test\.mjs/);
  assert.doesNotMatch(result.stderr, /test\/pipelane\.test\.mjs/);
});

test('runner missing manifest entry fails before invoking node', async (t) => {
  const dir = makeFixtureDir(t);
  const missing = path.join(dir, 'missing.test.mjs');

  const result = await runRunner({ files: [missing] });
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, new RegExp(escapeRegExp(missing)));
  assert.doesNotMatch(result.stderr, /child pid:/);
  assert.equal(existsSync(tempDir), true);
});

function makeFixtureDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-runner-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir, name, source) {
  const file = path.join(dir, name);
  writeFileSync(file, `${source.trim()}\n`, 'utf8');
  return file;
}

async function assertSignalCleanup(t, signal, fallbackCode) {
  const dir = makeFixtureDir(t);
  const marker = path.join(dir, `${signal.toLowerCase()}-grandchild-survived`);
  const fixture = writeFixture(dir, `${signal.toLowerCase()}.test.mjs`, `
    import test from 'node:test';
    import { spawn } from 'node:child_process';
    process.on('SIGTERM', () => {});
    test('waits for parent signal', async () => {
      const marker = process.env.PIPELANE_SIGNAL_MARKER;
      const child = spawn(process.execPath, ['-e', \`
        const { writeFileSync } = require('node:fs');
        setTimeout(() => writeFileSync(\${JSON.stringify(marker)}, 'alive'), 900);
        setInterval(() => {}, 100);
      \`], { stdio: 'ignore' });
      child.unref();
      await new Promise(() => {});
    });
  `);

  const run = spawnRunner({
    files: [fixture],
    env: {
      PIPELANE_SIGNAL_MARKER: marker,
      PIPELANE_TEST_TIMEOUT_MS: '5000',
      PIPELANE_TEST_KILL_GRACE_MS: '100',
    },
  });
  await waitFor(() => /child pid: \d+/.test(run.stderr), 2000);
  run.child.kill(signal);
  const result = await run.result;
  const tempDir = parseTempDir(result.stderr);
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  assert.ok(
    result.signal === signal || result.code === fallbackCode,
    `expected ${signal} or fallback ${fallbackCode}, got code=${result.code} signal=${result.signal}\n${result.stderr}`,
  );
  assert.match(result.stderr, new RegExp(`received ${signal}`));
  assert.equal(existsSync(tempDir), true);
  await delay(1100);
  assert.equal(existsSync(marker), false, `${signal} cleanup should kill the grandchild`);
}

async function runRunner(options) {
  const run = spawnRunner(options);
  return run.result;
}

function spawnRunner({ files, args = [], env = {} }) {
  const mergedEnv = runnerEnv(files, env);
  const child = spawn(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    env: mergedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const startedAt = Date.now();
  const run = {
    child,
    stdout: '',
    stderr: '',
    result: null,
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    run.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    run.stderr += chunk;
  });

  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: run.stdout,
        stderr: run.stderr,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });

  const safety = new Promise((_, reject) => {
    setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`runner self-test timed out\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`));
      }, 1000).unref();
    }, 10_000).unref();
  });

  run.result = Promise.race([closed, safety]);
  return run;
}

function runnerEnv(files, overrides) {
  const env = { ...process.env };
  for (const key of [
    'PIPELANE_TEST_DIRECT_NODE',
    'PIPELANE_TEST_FILES',
    'PIPELANE_TEST_HEARTBEAT_MS',
    'PIPELANE_TEST_KILL_GRACE_MS',
    'PIPELANE_TEST_NODE',
    'PIPELANE_TEST_TIMEOUT_MS',
    'NODE_TEST_CONTEXT',
    'NODE_TEST_WORKER_ID',
  ]) {
    delete env[key];
  }

  env.PIPELANE_TEST_FILES = files.join(path.delimiter);
  env.PIPELANE_TEST_TIMEOUT_MS = '5000';
  env.PIPELANE_TEST_HEARTBEAT_MS = '60000';
  env.PIPELANE_TEST_KILL_GRACE_MS = '500';

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

function parseTempDir(stderr) {
  const match = stderr.match(/\[pipelane-test\] temp dir: ([^\n]+)/);
  assert.ok(match, `runner did not print temp dir\n${stderr}`);
  return match[1].trim();
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
