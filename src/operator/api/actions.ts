import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { ParsedOperatorArgs } from '../state.ts';
import { nowIso, resolveWorkflowContext } from '../state.ts';
import {
  buildApiEnvelope,
  buildFreshness,
  type ApiEnvelope,
  type LaneState,
} from './envelope.ts';
import {
  buildActionFingerprint,
  consumeActionConfirmation,
  createActionConfirmation,
} from './confirm-tokens.ts';

export const STABLE_ACTION_IDS = [
  'new',
  'resume',
  'devmode.build',
  'devmode.release',
  'taskLock.verify',
  'pr',
  'merge',
  'deploy.staging',
  'deploy.prod',
  'clean.plan',
  'clean.apply',
] as const;

export type StableActionId = (typeof STABLE_ACTION_IDS)[number];

// Typed risky set so TS flags a forgotten entry instead of silently
// dropping a new risky action into the non-risky path.
export const API_RISKY_ACTION_IDS: ReadonlySet<StableActionId> = new Set<StableActionId>([
  'clean.apply',
  'merge',
  'deploy.prod',
]);

const ACTION_LABELS: Record<StableActionId, string> = {
  new: 'Create task workspace',
  resume: 'Resume task workspace',
  'devmode.build': 'Switch to build mode',
  'devmode.release': 'Switch to release mode',
  'taskLock.verify': 'Verify task lock',
  pr: 'Prepare PR',
  merge: 'Merge PR',
  'deploy.staging': 'Deploy staging',
  'deploy.prod': 'Deploy production',
  'clean.plan': 'Plan cleanup',
  'clean.apply': 'Apply cleanup',
};

export interface ActionPreflightData {
  action: { id: string; label: string; risky: boolean };
  preflight: {
    allowed: boolean;
    state: LaneState;
    reason: string;
    warnings: string[];
    issues: unknown[];
    normalizedInputs: Record<string, unknown>;
    requiresConfirmation: boolean;
    confirmation: { token: string; expiresAt: string } | null;
    freshness: ReturnType<typeof buildFreshness>;
  };
}

export interface ActionExecutionData extends ActionPreflightData {
  execution: {
    exitCode: number;
    result: unknown;
    stderr: string;
  };
}

export function isStableActionId(value: string): value is StableActionId {
  return (STABLE_ACTION_IDS as readonly string[]).includes(value);
}

export function buildActionPreflightEnvelope(cwd: string, actionId: StableActionId, parsed: ParsedOperatorArgs): ApiEnvelope<ActionPreflightData> {
  const context = resolveWorkflowContext(cwd);
  const normalizedInputs = normalizeInputs(actionId, parsed);
  const risky = API_RISKY_ACTION_IDS.has(actionId);
  const checkedAt = nowIso();

  const gate = evaluatePreflightGate(actionId, normalizedInputs);
  if (!gate.allowed) {
    const data: ActionPreflightData = {
      action: { id: actionId, label: ACTION_LABELS[actionId], risky },
      preflight: {
        allowed: false,
        state: 'blocked',
        reason: gate.reason,
        warnings: [],
        issues: [],
        normalizedInputs,
        requiresConfirmation: false,
        confirmation: null,
        freshness: buildFreshness({ checkedAt, stale: true }),
      },
    };
    return buildApiEnvelope<ActionPreflightData>({
      command: 'workflow.api.action',
      ok: false,
      message: gate.reason,
      data,
    });
  }

  let confirmation: { token: string; expiresAt: string } | null = null;
  if (risky) {
    const fingerprint = buildActionFingerprint(actionId, normalizedInputs);
    const record = createActionConfirmation(context.commonDir, context.config, {
      actionId,
      fingerprint,
      normalizedInputs,
    });
    confirmation = { token: record.token, expiresAt: record.expiresAt };
  }

  const data: ActionPreflightData = {
    action: { id: actionId, label: ACTION_LABELS[actionId], risky },
    preflight: {
      allowed: true,
      state: 'healthy',
      reason: '',
      warnings: [],
      issues: [],
      normalizedInputs,
      requiresConfirmation: risky,
      confirmation,
      freshness: buildFreshness({ checkedAt }),
    },
  };

  return buildApiEnvelope<ActionPreflightData>({
    command: 'workflow.api.action',
    ok: true,
    message: `${actionId} preflight ready`,
    data,
  });
}

// v0.7: scope-aware preflight gating. Actions that need operator scope
// (e.g. clean.apply requires --task or --all-stale) emit
// allowed:false + state:blocked before a confirm token is ever issued.
// The CLI still enforces the same rule at execute time.
type PreflightGateResult =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: string };

function evaluatePreflightGate(actionId: StableActionId, inputs: Record<string, unknown>): PreflightGateResult {
  if (actionId === 'clean.apply') {
    const taskRaw = inputs.task;
    const task = typeof taskRaw === 'string' ? taskRaw.trim() : '';
    const allStale = inputs.allStale === true;
    if (!task && !allStale) {
      return {
        allowed: false,
        reason: '/clean --apply requires scope: pass --task <slug> or --all-stale.',
      };
    }
    if (task && allStale) {
      return {
        allowed: false,
        reason: '/clean --apply cannot combine --task and --all-stale.',
      };
    }
  }
  return { allowed: true };
}

export async function runActionExecute(cwd: string, actionId: StableActionId, parsed: ParsedOperatorArgs, confirmToken: string): Promise<ApiEnvelope<ActionExecutionData | ActionPreflightData>> {
  const context = resolveWorkflowContext(cwd);
  const normalizedInputs = normalizeInputs(actionId, parsed);
  const risky = API_RISKY_ACTION_IDS.has(actionId);
  const checkedAt = nowIso();

  if (risky) {
    const fingerprint = buildActionFingerprint(actionId, normalizedInputs);
    try {
      consumeActionConfirmation(context.commonDir, context.config, confirmToken, fingerprint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const preflight: ActionPreflightData = {
        action: { id: actionId, label: ACTION_LABELS[actionId], risky: true },
        preflight: {
          allowed: false,
          state: 'blocked',
          reason: message,
          warnings: [],
          issues: [],
          normalizedInputs,
          requiresConfirmation: true,
          confirmation: null,
          freshness: buildFreshness({ checkedAt, stale: true }),
        },
      };
      return buildApiEnvelope<ActionPreflightData>({
        command: 'workflow.api.action',
        ok: false,
        message,
        data: preflight,
      });
    }
  }

  const underlyingArgs = buildUnderlyingArgs(actionId, parsed);
  const childEnv = buildChildEnv(actionId);
  const result = runCliWithJson(cwd, underlyingArgs, childEnv);

  const data: ActionExecutionData = {
    action: { id: actionId, label: ACTION_LABELS[actionId], risky },
    preflight: {
      allowed: true,
      state: result.ok ? 'healthy' : 'blocked',
      reason: result.ok ? '' : result.stderr || `${actionId} exited ${result.exitCode}`,
      warnings: [],
      issues: [],
      normalizedInputs,
      requiresConfirmation: risky,
      confirmation: null,
      freshness: buildFreshness({ checkedAt, stale: !result.ok }),
    },
    execution: {
      exitCode: result.exitCode,
      result: result.parsed,
      stderr: result.stderr,
    },
  };

  return buildApiEnvelope<ActionExecutionData>({
    command: 'workflow.api.action',
    ok: result.ok,
    message: result.ok ? `${actionId} executed` : `${actionId} failed: ${result.stderr || 'see execution.stderr'}`,
    data,
  });
}

function normalizeInputs(actionId: StableActionId, parsed: ParsedOperatorArgs): Record<string, unknown> {
  const { flags } = parsed;
  switch (actionId) {
    case 'new':
      return { task: flags.task, offline: flags.offline };
    case 'resume':
      return { task: flags.task };
    case 'devmode.build':
      return {};
    case 'devmode.release':
      return { surfaces: flags.surfaces, override: flags.override, reason: flags.reason };
    case 'taskLock.verify':
      return { task: flags.task, mode: flags.mode };
    case 'pr':
      return { task: flags.task, title: flags.title, message: flags.message };
    case 'merge':
      return { task: flags.task };
    case 'deploy.staging':
      return { task: flags.task, sha: flags.sha, surfaces: flags.surfaces };
    case 'deploy.prod':
      return { task: flags.task, sha: flags.sha, surfaces: flags.surfaces };
    case 'clean.plan':
      return {};
    case 'clean.apply':
      return { task: flags.task, allStale: flags.allStale };
  }
}

function buildUnderlyingArgs(actionId: StableActionId, parsed: ParsedOperatorArgs): string[] {
  const { flags } = parsed;
  const args: string[] = ['run'];
  const pushOpt = (flag: string, value: string) => {
    if (value && value.trim()) args.push(flag, value);
  };
  const pushSurfaces = () => {
    if (flags.surfaces.length > 0) args.push('--surfaces', flags.surfaces.join(','));
  };

  switch (actionId) {
    case 'new':
      args.push('new');
      pushOpt('--task', flags.task);
      if (flags.offline) args.push('--offline');
      break;
    case 'resume':
      args.push('resume');
      pushOpt('--task', flags.task);
      break;
    case 'devmode.build':
      args.push('devmode', 'build');
      break;
    case 'devmode.release':
      args.push('devmode', 'release');
      pushSurfaces();
      if (flags.override) args.push('--override');
      pushOpt('--reason', flags.reason);
      break;
    case 'taskLock.verify':
      args.push('task-lock', 'verify');
      pushOpt('--task', flags.task);
      pushOpt('--mode', flags.mode);
      break;
    case 'pr':
      args.push('pr');
      pushOpt('--task', flags.task);
      pushOpt('--title', flags.title);
      pushOpt('--message', flags.message);
      break;
    case 'merge':
      args.push('merge');
      pushOpt('--task', flags.task);
      break;
    case 'deploy.staging':
      args.push('deploy', 'staging');
      pushOpt('--task', flags.task);
      pushOpt('--sha', flags.sha);
      pushSurfaces();
      break;
    case 'deploy.prod':
      args.push('deploy', 'prod');
      pushOpt('--task', flags.task);
      pushOpt('--sha', flags.sha);
      pushSurfaces();
      break;
    case 'clean.plan':
      args.push('clean');
      break;
    case 'clean.apply':
      args.push('clean', '--apply');
      pushOpt('--task', flags.task);
      if (flags.allStale) args.push('--all-stale');
      break;
  }

  args.push('--json');
  return args;
}

// Env vars that exist only as test hooks for the CLI. The API action executor
// is a long-lived parent (board, dashboard, CI dispatcher) — if any of these
// happen to be exported in its shell, we don't want them leaking into every
// CLI child and silently bypassing a gate.
const TEST_HOOK_ENV_KEYS = [
  'PIPELANE_DEPLOY_PROD_CONFIRM_STUB',
  'PIPELANE_CLEAN_MIN_AGE_MS',
  'PIPELANE_CHECKS_SUPABASE_SECRETS_STUB',
  'PIPELANE_CHECKS_GH_SECRETS_STUB',
];

function buildChildEnv(actionId: StableActionId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of TEST_HOOK_ENV_KEYS) {
    delete env[key];
  }
  if (actionId === 'deploy.prod') {
    // deploy.prod's CLI shim also requires human confirmation. The API path
    // has already proved humanness via the HMAC confirm-token consume above,
    // so tell the child CLI it can skip the typed-SHA TTY prompt. The child
    // scrubs this flag the moment it reads it so grandchild subprocesses
    // don't inherit an open prod-confirm bit.
    env.PIPELANE_DEPLOY_PROD_API_CONFIRMED = '1';
  } else {
    // Never let a stray bypass leak into other actions' execution.
    delete env.PIPELANE_DEPLOY_PROD_API_CONFIRMED;
  }
  return env;
}

function runCliWithJson(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; exitCode: number; stdout: string; stderr: string; parsed: unknown } {
  const cliPath = resolveCliEntry();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  let parsed: unknown = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = stdout;
    }
  }
  return {
    ok: result.status === 0,
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    parsed,
  };
}

function resolveCliEntry(): string {
  // In dev the module loads as src/operator/api/actions.ts; in a packed
  // build it's dist/operator/api/actions.js. Either way, cli.(ts|js)
  // lives two directories up. Prefer the compiled entry when present —
  // faster startup and matches what consumers run via the pipelane bin.
  const here = fileURLToPath(import.meta.url);
  const kitRoot = path.resolve(path.dirname(here), '..', '..', '..');
  const distCli = path.join(kitRoot, 'dist', 'cli.js');
  if (existsSync(distCli)) return distCli;
  return path.join(kitRoot, 'src', 'cli.ts');
}

export function parseApiActionFlags(argv: string[]): { execute: boolean; confirmToken: string; rest: string[] } {
  const rest: string[] = [];
  let execute = false;
  let confirmToken = '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--execute') {
      execute = true;
      continue;
    }
    if (token === '--confirm-token') {
      confirmToken = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    rest.push(token);
  }
  return { execute, confirmToken, rest };
}

