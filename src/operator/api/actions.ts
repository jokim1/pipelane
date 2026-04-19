import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { ParsedOperatorArgs } from '../state.ts';
import { loadDeployState, nowIso, resolveWorkflowContext, type DeployRecord } from '../state.ts';
import {
  computeDeployConfigFingerprint,
  emptyDeployConfig,
  loadDeployConfig,
  normalizeDeployEnvironment,
  resolveDeployStateKey,
  verifyDeployRecord,
} from '../release-gate.ts';
import { findLastGoodDeploy, inferActiveTaskLock, resolveCommandSurfaces } from '../commands/helpers.ts';
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
  // v1.2: doctor.* actions — both non-risky. doctor.diagnose is a pure
  // read; doctor.probe writes probe-state.json but only stores observed
  // liveness (never changes runtime behavior outside its own lane).
  // doctor.fix is interactive and lives behind the CLI today; it's NOT
  // registered as an API action because it needs TTY prompts — exposing
  // it over the API would either require a config-shape payload (which
  // duplicates `pipelane configure`) or a long-lived stdin proxy.
  'doctor.diagnose',
  'doctor.probe',
  // v1.1: rollback.* — one-command deploy recovery. Pipelane-only
  // extension above Rocketboard's shared baseline. rollback.staging is
  // low-risk (staging is allowed to break); rollback.prod joins the
  // risky set alongside deploy.prod and requires a confirm-token.
  // --revert-pr is NOT exposed as an API action — opening a PR from a
  // long-lived board/CI shell needs branch-rename + conflict handling
  // that live behind the TTY path today.
  'rollback.staging',
  'rollback.prod',
] as const;

export type StableActionId = (typeof STABLE_ACTION_IDS)[number];

// Typed risky set so TS flags a forgotten entry instead of silently
// dropping a new risky action into the non-risky path.
export const API_RISKY_ACTION_IDS: ReadonlySet<StableActionId> = new Set<StableActionId>([
  'clean.apply',
  'merge',
  'deploy.prod',
  'rollback.prod',
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
  'doctor.diagnose': 'Diagnose deploy configuration',
  'doctor.probe': 'Run live healthcheck probe',
  'rollback.staging': 'Rollback staging to last-good deploy',
  'rollback.prod': 'Rollback production to last-good deploy',
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
  const normalizedInputs = normalizeInputs(actionId, parsed, cwd);
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
  const normalizedInputs = normalizeInputs(actionId, parsed, cwd);
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

function normalizeInputs(actionId: StableActionId, parsed: ParsedOperatorArgs, cwd?: string): Record<string, unknown> {
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
    case 'doctor.diagnose':
      return {};
    case 'doctor.probe':
      return {};
    case 'rollback.staging': {
      const resolved = resolveRollbackInputs(cwd, 'staging', flags.surfaces, flags.task);
      return { task: flags.task, surfaces: flags.surfaces, resolvedSurfaces: resolved?.surfaces, targetSha: resolved?.targetSha };
    }
    case 'rollback.prod': {
      const resolved = resolveRollbackInputs(cwd, 'prod', flags.surfaces, flags.task);
      return { task: flags.task, surfaces: flags.surfaces, resolvedSurfaces: resolved?.surfaces, targetSha: resolved?.targetSha };
    }
  }
}

// v1.1 R7 fix: bind the rollback target sha to the confirm-token
// fingerprint. Preflight resolves the target against the current deploy
// state; execute re-resolves. If the state shifted (another deploy
// succeeded or failed between preflight and execute), the target sha
// will be different, the fingerprint won't match, and the token
// consume rejects. This closes the TOCTOU window where a human-
// approved "roll back to X" could become "roll back to Y" invisibly.
//
// The surface fallback chain MUST mirror handleRollback's exactly
// (flags → lock.surfaces → config.surfaces) or preflight and execute
// compute different targetSha values on the same repo state. Codex
// caught an earlier version that used config.surfaces directly when
// flags were empty, diverging from execute's lock-first fallback.
//
// Returns undefined (not null) when resolution fails so the resulting
// fingerprint value is stable across failed-resolution calls. Failed
// resolution still lets preflight hand out a token, but the subsequent
// handleRollback invocation will throw a clear error anyway.
function resolveRollbackInputs(
  cwd: string | undefined,
  environment: 'staging' | 'prod',
  surfaceFlags: string[],
  taskFlag: string,
): { surfaces: string[]; targetSha: string } | undefined {
  if (!cwd) return undefined;
  try {
    const context = resolveWorkflowContext(cwd);
    const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
    const deployState = loadDeployState(context.commonDir, context.config);
    const stateKey = resolveDeployStateKey();
    const trustedRecords = stateKey
      ? deployState.records.filter((record) => verifyDeployRecord(record, stateKey))
      : deployState.records;
    // Use the same resolveCommandSurfaces helper handleRollback uses at
    // execute time. Codex caught an earlier manual reconstruction that
    // missed modeState.requestedSurfaces + the parseSurfaceList
    // validation step — those differences could make preflight and
    // execute compute different targetSha values for the same inputs.
    // Task-lock lookup is best-effort (operator may preflight without
    // an active lock, e.g. from a dashboard UI).
    let lockSurfaces: string[] = [];
    try {
      const { lock } = inferActiveTaskLock(context, taskFlag);
      lockSurfaces = lock.surfaces ?? [];
    } catch {
      // No active task lock — resolveCommandSurfaces will fall through
      // to modeState.requestedSurfaces and then config.surfaces.
    }
    const surfaces = [...resolveCommandSurfaces(context, surfaceFlags, lockSurfaces)].sort();
    // Current record = latest record for this (env, surfaces). We need
    // the whole record (not just sha) so we can mirror handleRollback's
    // excludeSha logic: prefer rollbackOfSha (the original broken sha)
    // when the latest record is itself a failed/pending rollback. Codex
    // round 4 P1: preflight used record.sha unconditionally, which
    // drifted from execute on retry scenarios.
    let currentRecord: DeployRecord | null = null;
    const sortedKey = surfaces.join(',');
    for (let i = trustedRecords.length - 1; i >= 0; i -= 1) {
      const record = trustedRecords[i];
      if (record.environment !== environment) continue;
      if (!record.sha) continue;
      const recordKey = [...(record.surfaces ?? [])].sort().join(',');
      if (recordKey !== sortedKey) continue;
      currentRecord = record;
      break;
    }
    if (!currentRecord) return undefined;
    // Mirror handleRollback's cascade guard + excludeSha selection.
    if (currentRecord.status === 'succeeded' && currentRecord.rollbackOfSha) {
      // No rollback target when already at a prior rollback result.
      return undefined;
    }
    const excludeSha = currentRecord.rollbackOfSha ?? currentRecord.sha;
    const target = findLastGoodDeploy({
      records: trustedRecords,
      environment,
      surfaces,
      excludeSha,
      configFingerprint: computeDeployConfigFingerprint(deployConfig, environment),
    });
    if (!target?.sha) return undefined;
    return { surfaces, targetSha: target.sha };
  } catch {
    return undefined;
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
    case 'doctor.diagnose':
      args.push('doctor');
      break;
    case 'doctor.probe':
      args.push('doctor', 'probe');
      break;
    case 'rollback.staging':
      args.push('rollback', 'staging');
      pushOpt('--task', flags.task);
      pushSurfaces();
      break;
    case 'rollback.prod':
      args.push('rollback', 'prod');
      pushOpt('--task', flags.task);
      pushSurfaces();
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
  // v1.2: doctor.probe (dispatched via the API) re-reads the deploy config
  // and runs real fetches. Neither doctor stub should pass through from a
  // parent board/CI shell. The stubs are also gated on NODE_ENV==='test' at
  // the CLI; scrubbing here is belt-and-suspenders.
  // PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS is intentionally NOT scrubbed —
  // the API→CLI deploy.prod flow relies on it passing through (see
  // "api action deploy.prod --execute bypasses the TTY prompt via the API env var").
  'PIPELANE_DOCTOR_PROBE_STUB_STATUS',
  'PIPELANE_DOCTOR_FIX_STUB',
];

function buildChildEnv(actionId: StableActionId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of TEST_HOOK_ENV_KEYS) {
    delete env[key];
  }
  if (actionId === 'deploy.prod' || actionId === 'rollback.prod') {
    // Both deploy.prod and rollback.prod's CLI shims require human
    // confirmation via requireProdConfirmation. The API path has already
    // proved humanness via the HMAC confirm-token consume above, so tell
    // the child CLI it can skip the typed-SHA TTY prompt. The child
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

