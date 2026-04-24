import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3033;
const SNAPSHOT_CACHE_MS = 10_000;
const EXECUTION_HISTORY_LIMIT = 40;
const EXECUTION_EVENT_HISTORY_LIMIT = 200;

type JsonObject = Record<string, unknown>;

type ExecutionEventType = 'start' | 'stdout' | 'stderr' | 'final' | 'error';

interface ExecutionEvent {
  type: ExecutionEventType;
  at: string;
  payload: unknown;
}

interface ExecutionRecord {
  id: string;
  actionId: string;
  repoRoot: string;
  params: JsonObject;
  confirmToken: string;
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  stdout: string;
  stderr: string;
  finalEnvelope: JsonObject | null;
  errorMessage: string;
  exitCode: number | null;
  events: ExecutionEvent[];
  clients: Set<ServerResponse>;
  child: ChildProcessWithoutNullStreams | null;
}

interface DashboardServerOptions {
  repoRoot: string;
  host: string;
  port: number;
  settingsPath: string;
  settings: DashboardSettings;
}

interface DashboardOptionParseOptions {
  allowNoOpen?: boolean;
}

interface BranchAuthor {
  name: string;
  email: string;
  display: string;
}

interface DashboardSettings {
  boardTitle: string;
  boardSubtitle: string;
  preferredPort: number;
  autoRefreshSeconds: number;
}

const DEFAULT_BOARD_SUBTITLE = 'Pipelane — the release cockpit for AI vibe coders. Branch pipeline triage, action preflight, execution follow-through, and cleanup discipline.';
const DEFAULT_AUTO_REFRESH_SECONDS = 30;

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function sanitizePort(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
}

function sanitizeBoundedInt(raw: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function repoDashboardSlug(repoRoot: string): string {
  const name = path.basename(path.resolve(repoRoot)) || 'repo';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

function defaultDashboardSettings(repoRoot: string): DashboardSettings {
  const repoName = path.basename(path.resolve(repoRoot)) || 'Repo';
  return {
    boardTitle: `${repoName} Pipelane`,
    boardSubtitle: DEFAULT_BOARD_SUBTITLE,
    preferredPort: DEFAULT_PORT,
    autoRefreshSeconds: DEFAULT_AUTO_REFRESH_SECONDS,
  };
}

function dashboardSettingsPath(repoRoot: string): string {
  const slug = repoDashboardSlug(repoRoot);
  const hash = createHash('sha1').update(path.resolve(repoRoot)).digest('hex').slice(0, 8);
  return path.join(os.homedir(), '.pipelane', 'dashboard', `${slug}-${hash}.json`);
}

function readDashboardSettings(repoRoot: string, settingsPath = dashboardSettingsPath(repoRoot)): DashboardSettings {
  const defaults = defaultDashboardSettings(repoRoot);
  if (!existsSync(settingsPath)) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<DashboardSettings>;
    return {
      boardTitle: String(parsed.boardTitle || defaults.boardTitle).trim() || defaults.boardTitle,
      boardSubtitle: String(parsed.boardSubtitle || defaults.boardSubtitle).trim() || defaults.boardSubtitle,
      preferredPort: sanitizeBoundedInt(parsed.preferredPort, defaults.preferredPort, 1024, 65535),
      autoRefreshSeconds: sanitizeBoundedInt(parsed.autoRefreshSeconds, defaults.autoRefreshSeconds, 10, 300),
    };
  } catch {
    return defaults;
  }
}

function writeDashboardSettings(repoRoot: string, settingsPath: string, patch: Partial<DashboardSettings>): DashboardSettings {
  const nextSettings = {
    ...readDashboardSettings(repoRoot, settingsPath),
    ...patch,
  };
  const normalized: DashboardSettings = {
    boardTitle: String(nextSettings.boardTitle || defaultDashboardSettings(repoRoot).boardTitle).trim() || defaultDashboardSettings(repoRoot).boardTitle,
    boardSubtitle: String(nextSettings.boardSubtitle || defaultDashboardSettings(repoRoot).boardSubtitle).trim() || defaultDashboardSettings(repoRoot).boardSubtitle,
    preferredPort: sanitizeBoundedInt(nextSettings.preferredPort, DEFAULT_PORT, 1024, 65535),
    autoRefreshSeconds: sanitizeBoundedInt(nextSettings.autoRefreshSeconds, DEFAULT_AUTO_REFRESH_SECONDS, 10, 300),
  };

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return normalized;
}

function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body) as JsonObject);
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function dashCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function buildWorkflowArgsFromParams(params: JsonObject): string[] {
  const args: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const flag = `--${dashCase(key)}`;

    if (typeof value === 'boolean') {
      if (value) {
        args.push(flag);
      }
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      args.push(flag, value.map((entry) => String(entry)).join(','));
      continue;
    }

    if (typeof value === 'object') {
      throw new Error(`Unsupported action param "${key}".`);
    }

    args.push(flag, String(value));
  }

  return args;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function buildTransportFailure(message: string, stderr = '', details = ''): JsonObject {
  return {
    ok: false,
    error: 'pipelane_api_transport_failure',
    message,
    stderr,
    details,
  };
}

function readRepoPackageJson(repoRoot: string): JsonObject | null {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as JsonObject;
  } catch {
    return null;
  }
}

function pipelaneApiConfigured(repoRoot: string): boolean {
  const packageJson = readRepoPackageJson(repoRoot);
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts !== 'object') {
    return false;
  }

  return typeof (scripts as Record<string, unknown>)['pipelane:api'] === 'string';
}

function readBranchAuthors(repoRoot: string): Map<string, BranchAuthor> {
  const authors = new Map<string, BranchAuthor>();

  try {
    const stdout = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)%00%(authorname)%00%(authoremail)', 'refs/heads'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    for (const line of stdout.split('\n')) {
      if (!line) {
        continue;
      }
      const [branchName, name, email] = line.split('\0');
      if (!branchName || !name) {
        continue;
      }
      authors.set(branchName, {
        name,
        email: email || '',
        display: email ? `${name}` : name,
      });
    }
  } catch {
    return authors;
  }

  return authors;
}

function enrichBranchRowAuthor(row: unknown, authors: Map<string, BranchAuthor>): unknown {
  if (!row || typeof row !== 'object') {
    return row;
  }

  const branchRow = row as Record<string, unknown>;
  const branchName = typeof branchRow.name === 'string' ? branchRow.name : '';
  const author = branchName ? authors.get(branchName) ?? null : null;

  return {
    ...branchRow,
    author,
  };
}

function enrichEnvelopeWithBranchAuthors(envelope: JsonObject, authors: Map<string, BranchAuthor>): JsonObject {
  const data = envelope.data;
  if (!data || typeof data !== 'object') {
    return envelope;
  }

  const dataRecord = data as Record<string, unknown>;

  if (Array.isArray(dataRecord.branches)) {
    return {
      ...envelope,
      data: {
        ...dataRecord,
        branches: dataRecord.branches.map((row) => enrichBranchRowAuthor(row, authors)),
      },
    };
  }

  if (dataRecord.branch) {
    return {
      ...envelope,
      data: {
        ...dataRecord,
        branch: enrichBranchRowAuthor(dataRecord.branch, authors),
      },
    };
  }

  return envelope;
}

async function runWorkflowJson(repoRoot: string, args: string[]): Promise<{ status: number; envelope: JsonObject; stderr: string }> {
  const result = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('npm', ['run', '--silent', 'pipelane:api', '--', ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({
        status: typeof status === 'number' ? status : 1,
        stdout,
        stderr,
      });
    });
  });

  const trimmed = result.stdout.trim();
  if (!trimmed) {
    throw new Error(`pipelane:api produced no JSON output.${result.stderr ? ` stderr: ${result.stderr.trim()}` : ''}`);
  }

  try {
    const envelope = JSON.parse(trimmed) as JsonObject;
    return {
      status: result.status,
      envelope,
      stderr: result.stderr,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`pipelane:api returned invalid JSON (${message}).`);
  }
}

function encodeSseEvent(event: ExecutionEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({ at: event.at, payload: event.payload })}\n\n`;
}

function appendExecutionEvent(record: ExecutionRecord, event: ExecutionEvent): void {
  record.events.push(event);
  if (record.events.length > EXECUTION_EVENT_HISTORY_LIMIT) {
    record.events.splice(0, record.events.length - EXECUTION_EVENT_HISTORY_LIMIT);
  }

  const encoded = encodeSseEvent(event);
  for (const client of record.clients) {
    client.write(encoded);
  }

  if (event.type === 'final' || event.type === 'error') {
    for (const client of record.clients) {
      client.end();
    }
    record.clients.clear();
  }
}

function executionSnapshot(record: ExecutionRecord): JsonObject {
  return {
    id: record.id,
    actionId: record.actionId,
    repoRoot: record.repoRoot,
    params: record.params,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    status: record.status,
    stdout: record.stdout,
    stderr: record.stderr,
    exitCode: record.exitCode,
    finalEnvelope: record.finalEnvelope,
    errorMessage: record.errorMessage,
  };
}

function getUiFilePath(): string {
  return fileURLToPath(new URL('./public/index.html', import.meta.url));
}

function printDashboardBanner(options: DashboardServerOptions): void {
  process.stdout.write(`Dashboard repo: ${options.repoRoot}\n`);
  process.stdout.write(`Dashboard: http://${options.host}:${options.port}\n`);
  process.stdout.write(`Dashboard settings: ${options.settingsPath}\n`);
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<void> {
  const uiFilePath = getUiFilePath();
  let dashboardSettings = options.settings;
  const executions = new Map<string, ExecutionRecord>();
  const snapshotCache = {
    expiresAt: 0,
    envelope: null as JsonObject | null,
  };

  function pruneExecutions(): void {
    const settled = [...executions.values()]
      .filter((record) => record.status !== 'running')
      .sort((left, right) => {
        const leftTime = left.completedAt ?? left.startedAt;
        const rightTime = right.completedAt ?? right.startedAt;
        return leftTime.localeCompare(rightTime);
      });

    while (settled.length > EXECUTION_HISTORY_LIMIT) {
      const oldest = settled.shift();
      if (!oldest) {
        break;
      }
      executions.delete(oldest.id);
    }
  }

  async function getSnapshot(forceRefresh = false): Promise<JsonObject> {
    if (!forceRefresh && snapshotCache.envelope && snapshotCache.expiresAt > Date.now()) {
      return snapshotCache.envelope;
    }

    const branchAuthors = readBranchAuthors(options.repoRoot);
    const { envelope } = await runWorkflowJson(options.repoRoot, ['snapshot', '--json']);
    const enrichedEnvelope = enrichEnvelopeWithBranchAuthors(envelope, branchAuthors);
    snapshotCache.envelope = enrichedEnvelope;
    snapshotCache.expiresAt = Date.now() + SNAPSHOT_CACHE_MS;
    return enrichedEnvelope;
  }

  async function getBranchDetails(branchName: string): Promise<JsonObject> {
    const branchAuthors = readBranchAuthors(options.repoRoot);
    const { envelope } = await runWorkflowJson(options.repoRoot, ['branch', '--branch', branchName, '--json']);
    return enrichEnvelopeWithBranchAuthors(envelope, branchAuthors);
  }

  async function getBranchPatch(branchName: string, filePath: string, scope: string): Promise<JsonObject> {
    const args = ['branch', '--branch', branchName, '--file', filePath, '--patch', '--json'];
    if (scope) {
      args.push('--scope', scope);
    }
    const { envelope } = await runWorkflowJson(options.repoRoot, args);
    return envelope;
  }

  async function postActionPreflight(actionId: string, params: JsonObject): Promise<{ status: number; envelope: JsonObject }> {
    const { status, envelope } = await runWorkflowJson(options.repoRoot, [
      'action',
      actionId,
      ...buildWorkflowArgsFromParams(params),
      '--json',
    ]);
    return { status, envelope };
  }

  function startExecution(actionId: string, params: JsonObject, confirmToken: string): ExecutionRecord {
    const id = randomUUID();
    const record: ExecutionRecord = {
      id,
      actionId,
      repoRoot: options.repoRoot,
      params,
      confirmToken,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'running',
      stdout: '',
      stderr: '',
      finalEnvelope: null,
      errorMessage: '',
      exitCode: null,
      events: [],
      clients: new Set<ServerResponse>(),
      child: null,
    };

    executions.set(id, record);
    appendExecutionEvent(record, {
      type: 'start',
      at: record.startedAt,
      payload: {
        actionId,
        params,
      },
    });

    const args = [
      'run',
      '--silent',
      'pipelane:api',
      '--',
      'action',
      actionId,
      ...buildWorkflowArgsFromParams(params),
      '--execute',
    ];
    if (confirmToken) {
      args.push('--confirm-token', confirmToken);
    }
    args.push('--json');

    const child = spawn('npm', args, {
      cwd: options.repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    record.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      record.stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      record.stderr += text;
      appendExecutionEvent(record, {
        type: 'stderr',
        at: new Date().toISOString(),
        payload: {
          chunk: text,
        },
      });
    });
    child.on('error', (error: Error) => {
      record.status = 'failed';
      record.completedAt = new Date().toISOString();
      record.errorMessage = error.message;
      appendExecutionEvent(record, {
        type: 'error',
        at: record.completedAt,
        payload: {
          message: error.message,
        },
      });
      pruneExecutions();
    });
    child.on('close', (code) => {
      record.exitCode = typeof code === 'number' ? code : 1;
      record.completedAt = new Date().toISOString();

      const trimmedStdout = record.stdout.trim();
      if (!trimmedStdout) {
        record.status = 'failed';
        record.errorMessage = 'pipelane:api execute produced no JSON output.';
        appendExecutionEvent(record, {
          type: 'error',
          at: record.completedAt,
          payload: {
            message: record.errorMessage,
            stderr: record.stderr,
          },
        });
        pruneExecutions();
        return;
      }

      try {
        const envelope = JSON.parse(trimmedStdout) as JsonObject;
        record.finalEnvelope = envelope;
        record.status = record.exitCode === 0 ? 'completed' : 'failed';
        appendExecutionEvent(record, {
          type: 'final',
          at: record.completedAt,
          payload: {
            exitCode: record.exitCode,
            envelope,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record.status = 'failed';
        record.errorMessage = `pipelane:api execute returned invalid JSON (${message}).`;
        appendExecutionEvent(record, {
          type: 'stdout',
          at: record.completedAt,
          payload: {
            chunk: record.stdout,
          },
        });
        appendExecutionEvent(record, {
          type: 'error',
          at: record.completedAt,
          payload: {
            message: record.errorMessage,
            stderr: record.stderr,
          },
        });
      }

      pruneExecutions();
    });

    return record;
  }

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
      const pathname = url.pathname;

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          repoRoot: options.repoRoot,
          repoExists: existsSync(options.repoRoot),
          pipelaneApiConfigured: pipelaneApiConfigured(options.repoRoot),
          uiFileExists: existsSync(uiFilePath),
          settingsPath: options.settingsPath,
          checkedAt: new Date().toISOString(),
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/settings') {
        sendJson(res, 200, {
          ok: true,
          settings: dashboardSettings,
          settingsPath: options.settingsPath,
          notes: {
            preferredPort: 'Preferred port is applied the next time the dashboard server starts.',
          },
        });
        return;
      }

      if (method === 'PUT' && pathname === '/api/settings') {
        try {
          const body = await readJsonBody(req);
          const rawSettings = (body.settings ?? body) as Partial<DashboardSettings>;
          const nextSettings = writeDashboardSettings(options.repoRoot, options.settingsPath, rawSettings);
          dashboardSettings = nextSettings;
          sendJson(res, 200, {
            ok: true,
            settings: dashboardSettings,
            settingsPath: options.settingsPath,
            restartRequired: nextSettings.preferredPort !== options.port,
            message: nextSettings.preferredPort !== options.port
              ? `Settings saved. Restart the dashboard to use port ${nextSettings.preferredPort}.`
              : 'Settings saved.',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, buildTransportFailure('Could not save dashboard settings.', '', message));
        }
        return;
      }

      if (method === 'GET' && pathname === '/api/snapshot') {
        const forceRefresh = url.searchParams.get('refresh') === '1';
        try {
          const envelope = await getSnapshot(forceRefresh);
          sendJson(res, 200, envelope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 502, buildTransportFailure('Could not load Pipelane snapshot.', '', message));
        }
        return;
      }

      if (method === 'GET' && pathname.startsWith('/api/branch/') && pathname.endsWith('/patch')) {
        const branchValue = pathname.slice('/api/branch/'.length, -'/patch'.length);
        const branchName = decodeURIComponent(branchValue.replace(/\/$/, ''));
        const filePath = url.searchParams.get('file') ?? '';
        const scope = url.searchParams.get('scope') ?? '';

        if (!branchName || !filePath) {
          sendJson(res, 400, buildTransportFailure('Branch patch requests require both a branch and a file path.'));
          return;
        }

        try {
          const envelope = await getBranchPatch(branchName, filePath, scope);
          sendJson(res, 200, envelope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 502, buildTransportFailure(`Could not load patch preview for ${filePath}.`, '', message));
        }
        return;
      }

      if (method === 'GET' && pathname.startsWith('/api/branch/')) {
        const branchName = decodeURIComponent(pathname.slice('/api/branch/'.length));
        if (!branchName) {
          sendJson(res, 400, buildTransportFailure('Branch detail requests require a branch name.'));
          return;
        }

        try {
          const envelope = await getBranchDetails(branchName);
          sendJson(res, 200, envelope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 502, buildTransportFailure(`Could not load branch details for ${branchName}.`, '', message));
        }
        return;
      }

      if (method === 'POST' && pathname.startsWith('/api/action/') && pathname.endsWith('/preflight')) {
        const actionValue = pathname.slice('/api/action/'.length, -'/preflight'.length);
        const actionId = decodeURIComponent(actionValue.replace(/\/$/, ''));
        if (!actionId) {
          sendJson(res, 400, buildTransportFailure('Action preflight requests require an action id.'));
          return;
        }

        try {
          const body = await readJsonBody(req);
          const params = (body.params ?? {}) as JsonObject;
          const result = await postActionPreflight(actionId, params);
          sendJson(res, 200, result.envelope);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 502, buildTransportFailure(`Could not preflight action ${actionId}.`, '', message));
        }
        return;
      }

      if (method === 'POST' && pathname.startsWith('/api/action/') && pathname.endsWith('/execute')) {
        const actionValue = pathname.slice('/api/action/'.length, -'/execute'.length);
        const actionId = decodeURIComponent(actionValue.replace(/\/$/, ''));
        if (!actionId) {
          sendJson(res, 400, buildTransportFailure('Action execute requests require an action id.'));
          return;
        }

        try {
          const body = await readJsonBody(req);
          const params = (body.params ?? {}) as JsonObject;
          const confirmToken = typeof body.confirmToken === 'string' ? body.confirmToken : '';
          const record = startExecution(actionId, params, confirmToken);
          sendJson(res, 202, {
            ok: true,
            executionId: record.id,
            actionId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 502, buildTransportFailure(`Could not start action ${actionId}.`, '', message));
        }
        return;
      }

      if (method === 'GET' && pathname.startsWith('/api/executions/') && pathname.endsWith('/events')) {
        const idValue = pathname.slice('/api/executions/'.length, -'/events'.length);
        const executionId = decodeURIComponent(idValue.replace(/\/$/, ''));
        const record = executions.get(executionId);

        if (!record) {
          sendJson(res, 404, buildTransportFailure(`No execution named ${executionId} was found.`));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        record.clients.add(res);

        for (const event of record.events) {
          res.write(encodeSseEvent(event));
        }

        if (record.status !== 'running') {
          res.end();
          return;
        }

        req.on('close', () => {
          record.clients.delete(res);
          res.end();
        });
        return;
      }

      if (method === 'GET' && pathname.startsWith('/api/executions/')) {
        const executionId = decodeURIComponent(pathname.slice('/api/executions/'.length));
        const record = executions.get(executionId);

        if (!record) {
          sendJson(res, 404, buildTransportFailure(`No execution named ${executionId} was found.`));
          return;
        }

        sendJson(res, 200, {
          ok: true,
          execution: executionSnapshot(record),
        });
        return;
      }

      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        if (!existsSync(uiFilePath)) {
          sendText(res, 404, 'Dashboard UI not found.');
          return;
        }

        sendText(res, 200, readFileSync(uiFilePath, 'utf8'), 'text/html; charset=utf-8');
        return;
      }

      sendJson(res, 404, buildTransportFailure('Route not found.'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, buildTransportFailure('Unexpected dashboard server failure.', '', message));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => {
      printDashboardBanner(options);
      resolve();
    });
  });
}

export function getDashboardOptions(
  argv: string[],
  cwd: string,
  parseOptions: DashboardOptionParseOptions = {},
): DashboardServerOptions {
  validateDashboardOptions(argv, parseOptions);
  const repoRoot = path.resolve(valueAfter(argv, '--repo') || process.env.ROCKETBOARD_ROOT || cwd);
  const settingsPath = dashboardSettingsPath(repoRoot);
  const settings = readDashboardSettings(repoRoot, settingsPath);
  return {
    repoRoot,
    host: valueAfter(argv, '--host') || DEFAULT_HOST,
    port: sanitizePort(valueAfter(argv, '--port') || process.env.PORT || String(settings.preferredPort || DEFAULT_PORT)),
    settingsPath,
    settings,
  };
}

function validateDashboardOptions(argv: string[], parseOptions: DashboardOptionParseOptions): void {
  const valueFlags = new Set(['--repo', '--host', '--port']);
  const booleanFlags = new Set(parseOptions.allowNoOpen ? ['--no-open'] : []);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (booleanFlags.has(token)) {
      continue;
    }
    if (valueFlags.has(token)) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${token} requires a value.`);
      }
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown dashboard option "${token}". Supported options: --repo <path>, --host <host>, --port <port>${parseOptions.allowNoOpen ? ', --no-open' : ''}.`);
    }
    throw new Error(`Unexpected dashboard argument "${token}".`);
  }
}
