import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDashboardRuntimeMetadata, getDashboardOptions } from './server.ts';

interface HealthResult {
  ok: boolean;
  status?: number;
  payload?: Record<string, unknown>;
}

function pidDir(): string {
  return path.join(os.homedir(), '.pipelane', 'dashboard', 'pids');
}

function logDir(): string {
  return path.join(os.homedir(), '.pipelane', 'dashboard', 'logs');
}

function slugHash(repoRoot: string): string {
  const name = path.basename(path.resolve(repoRoot)) || 'repo';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  let hash = 0;
  const absolute = path.resolve(repoRoot);
  for (let i = 0; i < absolute.length; i += 1) {
    hash = (hash * 31 + absolute.charCodeAt(i)) | 0;
  }
  return `${slug}-${Math.abs(hash).toString(16).slice(0, 8)}`;
}

function pidFilePath(repoRoot: string): string {
  return path.join(pidDir(), `${slugHash(repoRoot)}.pid`);
}

function logFilePath(repoRoot: string): string {
  return path.join(logDir(), `${slugHash(repoRoot)}.log`);
}

function probeHealth(host: string, port: number, timeoutMs: number): Promise<HealthResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HealthResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const req = httpRequest(
      {
        hostname: host,
        port,
        path: '/api/health',
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          let payload: Record<string, unknown> | undefined;
          if (body.trim()) {
            try {
              const parsed = JSON.parse(body) as unknown;
              if (parsed && typeof parsed === 'object') {
                payload = parsed as Record<string, unknown>;
              }
            } catch {
              payload = undefined;
            }
          }
          finish({ ok: status >= 200 && status < 300, status, payload });
        });
        res.resume();
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('probe timeout'));
      finish({ ok: false });
    });
    req.on('error', () => finish({ ok: false }));
    req.end();
  });
}

async function waitForHealthy(host: string, port: number, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const result = await probeHealth(host, port, 500);
    if (result.ok) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function openBrowser(url: string): void {
  const override = process.env.PIPELANE_OPEN_COMMAND;
  if (override === 'skip') {
    return;
  }

  let command = override || '';
  let args: string[] = [];
  if (!command) {
    if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else if (process.platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      command = 'xdg-open';
      args = [url];
    }
  } else {
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // Best-effort; we still want the CLI to return cleanly.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(repoRoot: string): number | null {
  const target = pidFilePath(repoRoot);
  if (!existsSync(target)) {
    return null;
  }
  const raw = readFileSync(target, 'utf8').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function writePidFile(repoRoot: string, pid: number): void {
  mkdirSync(pidDir(), { recursive: true });
  writeFileSync(pidFilePath(repoRoot), `${pid}\n`, 'utf8');
}

function clearPidFile(repoRoot: string): void {
  const target = pidFilePath(repoRoot);
  if (existsSync(target)) {
    try {
      unlinkSync(target);
    } catch {
      // ignore
    }
  }
}

function resolveCliEntrypoint(): string {
  // Prefer compiled cli.js when running from dist/ (installed packages),
  // fall back to cli.ts when running in-repo from src/.
  const jsPath = fileURLToPath(new URL('../cli.js', import.meta.url));
  if (existsSync(jsPath)) {
    return jsPath;
  }
  return fileURLToPath(new URL('../cli.ts', import.meta.url));
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function runtimeMatches(health: HealthResult): boolean {
  const runtime = health.payload?.runtime;
  if (!runtime || typeof runtime !== 'object') {
    return false;
  }
  const expected = buildDashboardRuntimeMetadata();
  const actual = runtime as Record<string, unknown>;
  return actual.entrypoint === expected.entrypoint
    && actual.uiFilePath === expected.uiFilePath
    && actual.gitSha === expected.gitSha
    && actual.assetVersion === expected.assetVersion;
}

function healthRepoRoot(health: HealthResult): string {
  const raw = health.payload?.repoRoot;
  return typeof raw === 'string' ? path.resolve(raw) : '';
}

function healthPid(health: HealthResult): number | null {
  const raw = health.payload?.pid;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stopExistingDashboard(pid: number | null, repoRoot: string): boolean {
  if (!pid || !isProcessAlive(pid)) {
    return false;
  }
  try {
    process.kill(pid);
    clearPidFile(repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function runStart(argv: string[], cwd: string): Promise<void> {
  const options = getDashboardOptions(argv, cwd, { allowNoOpen: true });
  const url = `http://${options.host}:${options.port}`;
  const noOpen = hasFlag(argv, '--no-open');

  const existingHealth = await probeHealth(options.host, options.port, 500);
  if (existingHealth.ok) {
    const runningRepoRoot = healthRepoRoot(existingHealth);
    if (runningRepoRoot && runningRepoRoot !== path.resolve(options.repoRoot)) {
      process.stdout.write(
        `Port ${options.port} is already serving a Pipelane Board for ${runningRepoRoot}.\n`
          + `Requested repo: ${path.resolve(options.repoRoot)}\n`
          + 'Use --port <n> or stop the other board first.\n',
      );
      process.exitCode = 1;
      return;
    }

    if (runtimeMatches(existingHealth)) {
      process.stdout.write(`Pipelane Board already running at ${url}\n`);
      if (!noOpen) {
        openBrowser(url);
        process.stdout.write(`Opened ${url} in browser.\n`);
      }
      return;
    }

    const stopped = stopExistingDashboard(healthPid(existingHealth) ?? readPidFile(options.repoRoot), options.repoRoot);
    if (stopped) {
      process.stdout.write(`Restarting stale Pipelane Board at ${url}; launcher/runtime changed.\n`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } else {
      process.stdout.write(
        `Pipelane Board at ${url} is running with a different runtime and could not be stopped automatically.\n`
          + 'Stop it manually or choose another --port.\n',
      );
      process.exitCode = 1;
      return;
    }
  }

  const storedPid = readPidFile(options.repoRoot);
  if (storedPid && isProcessAlive(storedPid)) {
    process.stdout.write(`PID ${storedPid} is alive but port ${options.port} is not responding; starting a fresh server.\n`);
    try {
      process.kill(storedPid);
    } catch {
      // Already dead or not ours.
    }
    clearPidFile(options.repoRoot);
  } else if (storedPid) {
    clearPidFile(options.repoRoot);
  }

  mkdirSync(logDir(), { recursive: true });
  const logPath = logFilePath(options.repoRoot);
  const logFd = openSync(logPath, 'a');

  const cliEntrypoint = resolveCliEntrypoint();
  const needsTsStripping = cliEntrypoint.endsWith('.ts');
  const spawnArgs = [
    ...(needsTsStripping ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : []),
    cliEntrypoint,
    'dashboard',
    '--repo',
    options.repoRoot,
    '--host',
    options.host,
    '--port',
    String(options.port),
  ];

  const child = spawn(process.execPath, spawnArgs, {
    cwd: options.repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();

  if (typeof child.pid === 'number') {
    writePidFile(options.repoRoot, child.pid);
  }

  const healthy = await waitForHealthy(options.host, options.port, 8000);
  if (!healthy) {
    process.stdout.write(
      `Dashboard did not become healthy within 8s. See logs: ${logPath}\n`
        + `PID ${child.pid ?? 'unknown'} may still be starting; retry \`pipelane board\` shortly.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Pipelane Board ready at ${url}\n`);
  process.stdout.write(`Logs: ${logPath}\n`);
  if (!noOpen) {
    openBrowser(url);
    process.stdout.write(`Opened ${url} in browser.\n`);
  }
}

async function runStop(argv: string[], cwd: string): Promise<void> {
  const options = getDashboardOptions(argv, cwd, { allowNoOpen: true });
  const storedPid = readPidFile(options.repoRoot);

  if (!storedPid) {
    const health = await probeHealth(options.host, options.port, 500);
    if (health.ok) {
      process.stdout.write(
        `A dashboard is responding on http://${options.host}:${options.port} but was not started by this command (no PID file).\n`
          + 'Stop it manually if you want it gone.\n',
      );
      return;
    }
    process.stdout.write('No Pipelane Board is running for this repo.\n');
    return;
  }

  if (!isProcessAlive(storedPid)) {
    clearPidFile(options.repoRoot);
    process.stdout.write(`No running dashboard for PID ${storedPid}. Cleared stale PID file.\n`);
    return;
  }

  try {
    process.kill(storedPid);
    process.stdout.write(`Stopped Pipelane Board (PID ${storedPid}).\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`Could not stop PID ${storedPid}: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  clearPidFile(options.repoRoot);
}

async function runStatus(argv: string[], cwd: string): Promise<void> {
  const options = getDashboardOptions(argv, cwd, { allowNoOpen: true });
  const url = `http://${options.host}:${options.port}`;
  const health = await probeHealth(options.host, options.port, 500);
  const storedPid = readPidFile(options.repoRoot);
  const pidAlive = storedPid ? isProcessAlive(storedPid) : false;

  process.stdout.write(
    [
      `URL:    ${url}`,
      `Port:   ${options.port}`,
      `Repo:   ${options.repoRoot}`,
      `Health: ${health.ok ? `ok (HTTP ${health.status ?? 'unknown'})` : 'unreachable'}`,
      `PID:    ${storedPid ? `${storedPid} (${pidAlive ? 'alive' : 'stale'})` : 'no PID file'}`,
      `Logs:   ${logFilePath(options.repoRoot)}`,
    ].join('\n') + '\n',
  );
}

export async function handlePipelane(argv: string[], cwd: string): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(
      [
        'Usage: pipelane board [subcommand] [options]',
        '',
        'Subcommands:',
        '  (default)   start Pipelane Board (idempotent) and open the browser',
        '  stop        stop the Pipelane Board started by this command for the current repo',
        '  status      print health, port, PID, log path for this repo',
        '',
        'Options:',
        '  --repo <path>   target repo (default: cwd)',
        '  --port <n>      override port (default: settings.preferredPort or 3033)',
        '  --host <host>   override host (default: 127.0.0.1)',
        '  --no-open       start the server but do not launch the browser',
      ].join('\n') + '\n',
    );
    return;
  }
  if (!sub || sub.startsWith('--')) {
    await runStart(argv, cwd);
    return;
  }
  if (sub === 'start') {
    await runStart(rest, cwd);
    return;
  }
  if (sub === 'stop') {
    await runStop(rest, cwd);
    return;
  }
  if (sub === 'status') {
    await runStatus(rest, cwd);
    return;
  }

  throw new Error([
    `Unknown Pipelane Board subcommand "${sub}".`,
    sub === 'fix' ? 'Did you mean the managed `/fix` command? `/pipelane fix` opens the board router, not the fix workflow.' : '',
    'Supported board subcommands: start, stop, status.',
  ].filter(Boolean).join('\n'));
}
