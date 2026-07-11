import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TEST_FILES = ['test/pipelane.test.mjs'].sort();
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;
const DEFAULT_KILL_GRACE_MS = 5 * 1000;
const EXIT_TIMEOUT = 124;
const MAX_TIMER_MS = 2_147_483_647;
const SIGNAL_FALLBACK_CODES = new Map([
  ['SIGHUP', 129],
  ['SIGINT', 130],
  ['SIGTERM', 143],
]);

const repoRoot = process.cwd();
const forwardedArgs = process.argv.slice(2);
const runTmp = mkdtempSync(path.join(os.tmpdir(), 'pipelane-test-run-'));

main().catch((error) => {
  console.error(`[pipelane-test] ${error instanceof Error ? error.message : String(error)}`);
  preserveTempDir();
  process.exit(1);
});

async function main() {
  console.error(`[pipelane-test] temp dir: ${runTmp}`);

  const manifest = resolveManifest();
  printManifest(manifest);
  const nodeArgs = buildNodeArgs(manifest);

  if (process.env.PIPELANE_TEST_DIRECT_NODE === '1') {
    console.error('[pipelane-test] WARNING: PIPELANE_TEST_DIRECT_NODE=1; supervisor timeout, heartbeat, and process-group cleanup are disabled.');
    const result = await runDirectNode(nodeArgs);
    finishFromChildResult(result);
    return;
  }

  if (process.platform === 'win32') {
    throw new Error('test runner process-tree cleanup supports macOS and Linux only in this phase');
  }

  const timeoutMs = parseTimeoutMs();
  const heartbeatMs = parsePositiveIntegerEnv('PIPELANE_TEST_HEARTBEAT_MS', DEFAULT_HEARTBEAT_MS);
  const killGraceMs = parsePositiveIntegerEnv('PIPELANE_TEST_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS);
  const result = await runSupervisedNode(nodeArgs, { timeoutMs, heartbeatMs, killGraceMs });
  finishFromChildResult(result);
}

function resolveManifest() {
  const rawFiles = process.env.PIPELANE_TEST_FILES
    ? process.env.PIPELANE_TEST_FILES.split(path.delimiter)
    : DEFAULT_TEST_FILES;
  const files = [...new Set(rawFiles.map((file) => file.trim()).filter(Boolean))]
    .map((file) => path.resolve(repoRoot, file))
    .sort();

  if (files.length === 0) {
    throw new Error('test manifest is empty');
  }

  for (const file of files) {
    if (!existsSync(file)) {
      throw new Error(`test manifest entry is missing: ${file}`);
    }
    if (!statSync(file).isFile()) {
      throw new Error(`test manifest entry is not a file: ${file}`);
    }
  }

  return files;
}

function printManifest(manifest) {
  const label = manifest.length === 1 ? 'file' : 'files';
  console.error(`[pipelane-test] manifest (${manifest.length} ${label}):`);
  for (const file of manifest) {
    console.error(`[pipelane-test] - ${path.relative(repoRoot, file) || file}`);
  }
}

function buildNodeArgs(manifest) {
  const args = ['--test', '--test-force-exit'];
  if (manifest.length > 1 && !hasExplicitTestConcurrency(forwardedArgs)) {
    args.push('--test-concurrency=1');
    console.error('[pipelane-test] using --test-concurrency=1 for multi-file manifest');
  }
  args.push(...forwardedArgs, ...manifest);
  return args;
}

function hasExplicitTestConcurrency(args) {
  return args.some((arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='));
}

function parseTimeoutMs() {
  if (process.env.PIPELANE_TEST_TIMEOUT_MS === '0') {
    console.error('[pipelane-test] WARNING: PIPELANE_TEST_TIMEOUT_MS=0; timeout protection is disabled.');
    return 0;
  }
  return parsePositiveIntegerEnv('PIPELANE_TEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer in milliseconds`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_TIMER_MS} milliseconds`);
  }
  return value;
}

function childEnv() {
  return {
    ...process.env,
    TMPDIR: runTmp,
    TMP: runTmp,
    TEMP: runTmp,
    PIPELANE_TEST_TMPDIR: runTmp,
  };
}

function nodeCommand() {
  return process.env.PIPELANE_TEST_NODE || process.execPath;
}

function runDirectNode(nodeArgs) {
  return new Promise((resolve) => {
    let spawnError = null;
    const child = spawn(nodeCommand(), nodeArgs, {
      stdio: 'inherit',
      env: childEnv(),
    });

    child.on('error', (error) => {
      spawnError = error;
      console.error(`[pipelane-test] spawn error: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      resolve({ code, signal, spawnError, timedOut: false });
    });
  });
}

function runSupervisedNode(nodeArgs, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child = null;
    let result = null;
    let spawnError = null;
    let timedOut = false;
    let parentSignal = null;
    let timeoutTimer = null;
    let heartbeatTimer = null;
    let terminationPromise = null;
    let childCloseResolve = null;
    const childClosePromise = new Promise((childResolve) => {
      childCloseResolve = childResolve;
    });

    const cleanupTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    };

    const resolveOnce = (nextResult) => {
      if (result) return;
      result = nextResult;
      cleanupTimers();
      resolve(nextResult);
    };

    const terminateChild = async (reason) => {
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        if (!child?.pid) return;
        console.error(`[pipelane-test] ${reason}; terminating child process group ${child.pid}`);
        signalChildProcessTree(child.pid, 'SIGTERM');
        await Promise.race([childClosePromise, delay(options.killGraceMs)]);
        if (isProcessTreeAlive(child.pid)) {
          console.error(`[pipelane-test] child process group ${child.pid} still alive; sending SIGKILL`);
          signalChildProcessTree(child.pid, 'SIGKILL');
        }
        await Promise.race([waitForProcessTreeExit(child.pid, 1_000), childClosePromise]);
      })();
      return terminationPromise;
    };

    const handleParentSignal = (signal) => {
      if (parentSignal) return;
      parentSignal = signal;
      cleanupTimers();
      void terminateChild(`received ${signal}`).finally(() => {
        preserveTempDir();
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        process.removeListener('SIGHUP', onSighup);
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(SIGNAL_FALLBACK_CODES.get(signal) ?? 1);
        }
        setTimeout(() => process.exit(SIGNAL_FALLBACK_CODES.get(signal) ?? 1), 100).unref();
      });
    };

    const onSigint = () => handleParentSignal('SIGINT');
    const onSigterm = () => handleParentSignal('SIGTERM');
    const onSighup = () => handleParentSignal('SIGHUP');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);

    try {
      child = spawn(nodeCommand(), nodeArgs, {
        stdio: 'inherit',
        env: childEnv(),
        detached: true,
      });
    } catch (error) {
      spawnError = error;
      console.error(`[pipelane-test] spawn error: ${error.message}`);
      cleanupTimers();
      resolveOnce({ code: 1, signal: null, spawnError, timedOut: false });
      return;
    }

    console.error(`[pipelane-test] child pid: ${child.pid ?? 'unknown'}`);

    if (options.heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        console.error(`[pipelane-test] heartbeat elapsed=${formatDuration(Date.now() - startedAt)} child=${child?.pid ?? 'unknown'}`);
      }, options.heartbeatMs);
      heartbeatTimer.unref();
    }

    if (options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        void terminateChild(`timeout after ${options.timeoutMs}ms`).finally(() => {
          if (parentSignal) return;
          process.removeListener('SIGINT', onSigint);
          process.removeListener('SIGTERM', onSigterm);
          process.removeListener('SIGHUP', onSighup);
          resolveOnce({
            code: EXIT_TIMEOUT,
            signal: null,
            spawnError,
            timedOut,
          });
        });
      }, options.timeoutMs);
      timeoutTimer.unref();
    }

    child.on('error', (error) => {
      spawnError = error;
      console.error(`[pipelane-test] spawn error: ${error.message}`);
    });

    child.on('close', (code, signal) => {
      childCloseResolve();
      if (parentSignal) return;
      cleanupTimers();
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGHUP', onSighup);
      const finish = async () => {
        if (terminationPromise) await terminationPromise;
        resolveOnce({
          code: timedOut ? EXIT_TIMEOUT : code,
          signal: timedOut ? null : signal,
          spawnError,
          timedOut,
        });
      };
      void finish();
    });
  });
}

function finishFromChildResult(result) {
  if (result.code === 0 && result.signal === null && !result.spawnError && !result.timedOut) {
    rmSync(runTmp, { recursive: true, force: true });
    process.exit(0);
  }

  preserveTempDir();

  if (result.timedOut) {
    process.exit(EXIT_TIMEOUT);
  }
  if (result.spawnError) {
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[pipelane-test] child exited from signal ${result.signal}`);
    process.exit(1);
  }
  process.exit(result.code ?? 1);
}

function preserveTempDir() {
  console.error(`[pipelane-test] preserved temp dir: ${runTmp}`);
}

function signalChildProcessTree(pid, signal) {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    console.error(`[pipelane-test] warning: failed to signal child process group ${pid} with ${signal}: ${error.message}`);
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    console.error(`[pipelane-test] warning: failed to signal child process ${pid} with ${signal}: ${error.message}`);
  }
}

async function waitForProcessTreeExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessTreeAlive(pid)) {
    await delay(50);
  }
}

function isProcessTreeAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${remainderSeconds.toString().padStart(2, '0')}s`;
}
