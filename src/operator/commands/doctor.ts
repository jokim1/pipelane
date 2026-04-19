import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  emptyDeployConfig,
  loadDeployConfig,
  replaceDeployConfigSection,
  type DeployConfig,
} from '../release-gate.ts';
import { sanitizeForTerminal } from './helpers.ts';
import {
  loadProbeState,
  printResult,
  resolveWorkflowContext,
  saveProbeState,
  type ParsedOperatorArgs,
  type ProbeEnvironment,
  type ProbeRecord,
  type WorkflowContext,
} from '../state.ts';

// v1.2: /doctor is the guided-config + live-probe command. Three modes:
// - default (diagnose): read CLAUDE.md, list missing deploy-config fields,
//   detect platform from well-known config files (fly.toml, vercel.json,
//   netlify.toml, render.yaml, app.json, .github/workflows/).
// - `--probe`: hit each configured staging healthcheck URL and record
//   liveness to probe-state.json. Release-gate reads this.
// - `--fix`: interactive wizard that prompts for platform + URLs, writes
//   the Deploy Configuration block in CLAUDE.md, and auto-runs --probe.
//
// All three write JSON output under `--json` and human text otherwise.
export async function handleDoctor(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);

  if (parsed.flags.apply) {
    // `--apply` is the scoped-prune flag on /clean; repurpose `--probe`
    // for clarity. This branch catches an operator who typed --apply here.
    throw new Error('/doctor does not accept --apply. Use --probe (live healthcheck) or --fix (wizard).');
  }

  const mode = resolveDoctorMode(parsed);
  if (mode === 'probe') {
    await runProbe(context, parsed);
    return;
  }
  if (mode === 'fix') {
    await runFix(context, parsed);
    return;
  }
  runDiagnose(context, parsed);
}

type DoctorMode = 'diagnose' | 'probe' | 'fix';

function resolveDoctorMode(parsed: ParsedOperatorArgs): DoctorMode {
  // Modes arrive as positional args since /doctor doesn't take --probe /
  // --fix as boolean flags elsewhere. Accept either positional or the
  // explicit forms so `pipelane run doctor --probe` and `pipelane run doctor probe` both work.
  const positional = parsed.positional[0];
  const flagsToken = findFlag(parsed);
  if (positional === 'probe' || flagsToken === '--probe') return 'probe';
  if (positional === 'fix' || flagsToken === '--fix') return 'fix';
  if (positional === 'diagnose' || flagsToken === '--diagnose') return 'diagnose';
  return 'diagnose';
}

function findFlag(parsed: ParsedOperatorArgs): string | null {
  // Operator may have passed --probe / --fix / --diagnose as raw tokens that
  // fell through parseOperatorArgs into positional. Scan positional for
  // them; the explicit form is slightly more discoverable than positional.
  for (const entry of parsed.positional) {
    if (entry === '--probe' || entry === '--fix' || entry === '--diagnose') return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

export interface DiagnoseReport {
  platform: { detected: string; configured: string; sources: string[] };
  missingFields: string[];
  probeState: {
    present: boolean;
    records: ProbeRecord[];
  };
  message: string;
}

function runDiagnose(context: WorkflowContext, parsed: ParsedOperatorArgs): void {
  const report = buildDiagnoseReport(context);
  printResult(parsed.flags, report);
}

export function buildDiagnoseReport(context: WorkflowContext): DiagnoseReport {
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const platform = detectPlatform(context.repoRoot, deployConfig);
  const missing = listMissingFields(deployConfig);
  const probeState = loadProbeState(context.commonDir, context.config);
  const lines: string[] = [];
  lines.push('Doctor diagnosis:');
  lines.push(`  Platform: ${platform.configured || '(unset)'} ${platform.detected && platform.detected !== platform.configured ? `(detected: ${platform.detected})` : ''}`.trimEnd());
  if (platform.sources.length > 0) {
    lines.push(`  Platform signals: ${platform.sources.join(', ')}`);
  }
  if (missing.length === 0) {
    lines.push('  Deploy configuration: complete');
  } else {
    lines.push(`  Deploy configuration: ${missing.length} missing field(s)`);
    for (const field of missing) {
      lines.push(`    - ${field}`);
    }
    lines.push('  Fix: `npm run workflow:doctor -- --fix`');
  }
  const freshStaging = probeState.records.filter((r) => r.environment === 'staging');
  if (freshStaging.length === 0) {
    lines.push('  Probe state: no probes recorded. Run `npm run workflow:doctor -- --probe`.');
  } else {
    lines.push(`  Probe state: ${freshStaging.length} staging probe(s) recorded.`);
    for (const record of freshStaging) {
      lines.push(`    - ${record.surface}: ${record.ok ? 'OK' : 'FAILED'} (${record.statusCode ?? 'no status'}) at ${record.probedAt}`);
    }
  }
  return {
    platform,
    missingFields: missing,
    probeState: { present: probeState.records.length > 0, records: probeState.records },
    message: lines.join('\n'),
  };
}

export interface PlatformDetection {
  detected: string;
  configured: string;
  sources: string[];
}

export function detectPlatform(repoRoot: string, deployConfig: DeployConfig): PlatformDetection {
  const sources: string[] = [];
  const configured = deployConfig.platform || '';
  const hints: Array<{ file: string; platform: string }> = [
    { file: 'fly.toml', platform: 'fly.io' },
    { file: '.vercel/project.json', platform: 'vercel' },
    { file: 'vercel.json', platform: 'vercel' },
    { file: 'netlify.toml', platform: 'netlify' },
    { file: 'render.yaml', platform: 'render' },
    { file: 'app.json', platform: 'heroku' },
  ];
  let detected = '';
  for (const hint of hints) {
    if (existsSync(path.join(repoRoot, hint.file))) {
      sources.push(hint.file);
      if (!detected) detected = hint.platform;
    }
  }
  // GitHub Actions deploy workflow presence is a weak signal — detect it
  // but don't override a stronger platform-specific config file.
  const ghWorkflowsDir = path.join(repoRoot, '.github', 'workflows');
  if (existsSync(ghWorkflowsDir)) {
    sources.push('.github/workflows/');
    if (!detected) detected = 'github-actions';
  }
  return { detected, configured, sources };
}

export function listMissingFields(config: DeployConfig): string[] {
  const missing: string[] = [];
  if (!config.platform) missing.push('platform');
  if (!config.frontend.staging.url && !config.frontend.staging.deployWorkflow) missing.push('frontend.staging.url or deployWorkflow');
  if (!config.frontend.staging.healthcheckUrl && !config.frontend.staging.url) missing.push('frontend.staging.healthcheckUrl');
  if (!config.frontend.production.url && !config.frontend.production.deployWorkflow) missing.push('frontend.production.url or deployWorkflow');
  if (!config.frontend.production.healthcheckUrl && !config.frontend.production.url) missing.push('frontend.production.healthcheckUrl');
  return missing;
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

export interface ProbeOutcome {
  records: ProbeRecord[];
  message: string;
}

async function runProbe(context: WorkflowContext, parsed: ParsedOperatorArgs): Promise<void> {
  const outcome = await executeProbe(context);
  printResult(parsed.flags, outcome);
  // Only staging probes gate release. A flaky production probe is worth
  // recording but shouldn't flip the exit code for scripted callers (e.g.
  // `npm run workflow:doctor -- --probe` in CI before `workflow:pr`).
  const stagingFailed = outcome.records.some((record) => record.environment === 'staging' && !record.ok);
  if (stagingFailed) {
    process.exitCode = 1;
  }
}

export async function executeProbe(context: WorkflowContext, nowFn: () => Date = () => new Date()): Promise<ProbeOutcome> {
  const deployConfig = loadDeployConfig(context.repoRoot);
  if (!deployConfig) {
    throw new Error([
      'No Deploy Configuration block in CLAUDE.md.',
      'Run `npm run workflow:doctor -- --fix` to create one.',
    ].join('\n'));
  }

  const targets = collectProbeTargets(deployConfig);
  // probeUrl always resolves (catches its own errors into the record), so
  // Promise.all can't short-circuit on a single bad target. Parallelizing
  // cuts end-to-end probe latency from sum-of-targets to max-of-targets.
  const records = await Promise.all(targets.map((target) => probeUrl(target, nowFn)));

  // Merge new records on top of the existing snapshot so a partial
  // re-probe (single surface) doesn't wipe out previously-probed surfaces.
  const previous = loadProbeState(context.commonDir, context.config);
  const merged = mergeProbeRecords(previous.records, records);
  const now = nowFn().toISOString();
  saveProbeState(context.commonDir, context.config, { records: merged, updatedAt: now });

  const lines = ['Doctor probe:'];
  if (records.length === 0) {
    lines.push('  No probe targets — CLAUDE.md has no configured healthcheck URLs.');
  } else {
    for (const record of records) {
      const errorText = record.error ? sanitizeForTerminal(record.error) : 'no response';
      const status = record.ok
        ? `OK (HTTP ${record.statusCode ?? '?'}, ${record.latencyMs ?? '?'}ms)`
        : `FAILED (${record.statusCode ? `HTTP ${record.statusCode}` : errorText})`;
      // URLs come from CLAUDE.md (operator-owned) but probe records are
      // unsigned state, so scrub before rendering — mirrors the v1.5
      // ANSI-injection defense on override reasons/setBy.
      lines.push(`  ${record.environment}:${record.surface}: ${status} @ ${sanitizeForTerminal(record.url)}`);
    }
  }
  const updatedAt = merged.length > 0 ? `Updated ${now}` : '';
  if (updatedAt) lines.push(`  ${updatedAt}`);

  return { records, message: lines.join('\n') };
}

interface ProbeTarget {
  environment: ProbeEnvironment;
  surface: string;
  url: string;
}

export function collectProbeTargets(config: DeployConfig): ProbeTarget[] {
  const targets: ProbeTarget[] = [];
  const frontendStaging = config.frontend.staging.healthcheckUrl || config.frontend.staging.url;
  const frontendProd = config.frontend.production.healthcheckUrl || config.frontend.production.url;
  if (frontendStaging) targets.push({ environment: 'staging', surface: 'frontend', url: frontendStaging });
  if (frontendProd) targets.push({ environment: 'production', surface: 'frontend', url: frontendProd });
  if (config.edge.staging.healthcheckUrl) targets.push({ environment: 'staging', surface: 'edge', url: config.edge.staging.healthcheckUrl });
  if (config.edge.production.healthcheckUrl) targets.push({ environment: 'production', surface: 'edge', url: config.edge.production.healthcheckUrl });
  if (config.sql.staging.healthcheckUrl) targets.push({ environment: 'staging', surface: 'sql', url: config.sql.staging.healthcheckUrl });
  if (config.sql.production.healthcheckUrl) targets.push({ environment: 'production', surface: 'sql', url: config.sql.production.healthcheckUrl });
  return targets;
}

// 5s bound keeps /doctor --probe responsive even when a configured
// staging URL stalls (DNS timeout, TCP hang). Override via
// PIPELANE_DOCTOR_PROBE_TIMEOUT_MS for slow staging environments.
// Default matches what a human expects from an "interactive CLI healthcheck."
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

function resolveProbeTimeoutMs(): number {
  const raw = process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS;
  if (!raw) return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}

async function probeUrl(target: ProbeTarget, nowFn: () => Date): Promise<ProbeRecord> {
  const stub = process.env.PIPELANE_DOCTOR_PROBE_STUB_STATUS;
  const probedAt = nowFn().toISOString();
  if (stub) {
    // Test hook mirrors deploy.ts's healthcheck stub. Fixes the status
    // across every target in the same probe invocation so tests can assert
    // the persisted records without spinning up an HTTP server. Gated on
    // NODE_ENV==='test' so a stray export in an operator's shell can't
    // silently fake every probe in a real invocation.
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('PIPELANE_DOCTOR_PROBE_STUB_STATUS is set but NODE_ENV is not "test". Unset it and re-run.');
    }
    const statusCode = Number(stub);
    const code = Number.isFinite(statusCode) ? statusCode : 599;
    const ok = code >= 200 && code < 300;
    return {
      environment: target.environment,
      surface: target.surface,
      url: target.url,
      ok,
      statusCode: code,
      latencyMs: 1,
      error: ok ? undefined : `stubbed HTTP ${code}`,
      probedAt,
    };
  }

  const timeoutMs = resolveProbeTimeoutMs();
  const started = Date.now();
  try {
    const response = await fetch(target.url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - started;
    const ok = response.status >= 200 && response.status < 300;
    return {
      environment: target.environment,
      surface: target.surface,
      url: target.url,
      ok,
      statusCode: response.status,
      latencyMs,
      error: ok ? undefined : `HTTP ${response.status}`,
      probedAt,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    // AbortSignal.timeout raises a DOMException with name "TimeoutError";
    // normalize it so the record's error is actionable instead of cryptic.
    const rawMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const message = isTimeout ? `timeout after ${timeoutMs}ms` : rawMessage;
    return {
      environment: target.environment,
      surface: target.surface,
      url: target.url,
      ok: false,
      statusCode: null,
      latencyMs,
      error: message,
      probedAt,
    };
  }
}

export function mergeProbeRecords(previous: ProbeRecord[], incoming: ProbeRecord[]): ProbeRecord[] {
  const keyed = new Map<string, ProbeRecord>();
  for (const record of previous) {
    keyed.set(`${record.environment}:${record.surface}`, record);
  }
  for (const record of incoming) {
    keyed.set(`${record.environment}:${record.surface}`, record);
  }
  return [...keyed.values()].sort((a, b) =>
    `${a.environment}:${a.surface}`.localeCompare(`${b.environment}:${b.surface}`),
  );
}

// ---------------------------------------------------------------------------
// fix wizard
// ---------------------------------------------------------------------------

async function runFix(context: WorkflowContext, parsed: ParsedOperatorArgs): Promise<void> {
  if (parsed.flags.json) {
    throw new Error('/doctor --fix is interactive and cannot run under --json. Use `pipelane configure` for scripted configuration.');
  }
  if (!process.stdin.isTTY && !process.env.PIPELANE_DOCTOR_FIX_STUB) {
    throw new Error('/doctor --fix requires a TTY. Re-run from a terminal, or use `pipelane configure --json=...` for scripted config.');
  }
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const detected = detectPlatform(context.repoRoot, deployConfig);
  const next = await promptFixValues(deployConfig, detected);
  const claudePath = path.join(context.repoRoot, 'CLAUDE.md');
  const existing = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  writeFileSync(claudePath, replaceDeployConfigSection(existing, next), 'utf8');

  const outcome = await executeProbe(context);
  const lines = [
    'Doctor fix: wrote Deploy Configuration block to CLAUDE.md.',
    outcome.message,
  ];
  printResult(parsed.flags, { config: next, probe: outcome.records, message: lines.join('\n') });
}

// Test hook: PIPELANE_DOCTOR_FIX_STUB=JSON lets a non-TTY test invoke the
// fix path without wiring a full readline interface. Keeps the wizard's
// prompt logic reachable in CI.
interface FixStub {
  platform?: string;
  frontendStagingUrl?: string;
  frontendStagingHealthcheck?: string;
  frontendStagingWorkflow?: string;
  frontendProductionUrl?: string;
  frontendProductionHealthcheck?: string;
  frontendProductionWorkflow?: string;
}

async function promptFixValues(base: DeployConfig, detected: PlatformDetection): Promise<DeployConfig> {
  const stub = readFixStub();
  const next: DeployConfig = JSON.parse(JSON.stringify(base));
  if (stub) {
    if (stub.platform !== undefined) next.platform = stub.platform;
    if (stub.frontendStagingUrl !== undefined) next.frontend.staging.url = stub.frontendStagingUrl;
    if (stub.frontendStagingHealthcheck !== undefined) next.frontend.staging.healthcheckUrl = stub.frontendStagingHealthcheck;
    if (stub.frontendStagingWorkflow !== undefined) next.frontend.staging.deployWorkflow = stub.frontendStagingWorkflow;
    if (stub.frontendProductionUrl !== undefined) next.frontend.production.url = stub.frontendProductionUrl;
    if (stub.frontendProductionHealthcheck !== undefined) next.frontend.production.healthcheckUrl = stub.frontendProductionHealthcheck;
    if (stub.frontendProductionWorkflow !== undefined) next.frontend.production.deployWorkflow = stub.frontendProductionWorkflow;
    return next;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`Doctor fix: guided Deploy Configuration wizard.\n`);
    if (detected.detected) {
      process.stdout.write(`Detected platform: ${detected.detected} (${detected.sources.join(', ')}).\n`);
    }
    next.platform = await ask(rl, 'Deploy platform', next.platform || detected.detected);

    process.stdout.write('\nFrontend (staging):\n');
    next.frontend.staging.url = await ask(rl, '  URL', next.frontend.staging.url);
    next.frontend.staging.healthcheckUrl = await ask(rl, '  Healthcheck URL', next.frontend.staging.healthcheckUrl || next.frontend.staging.url);
    next.frontend.staging.deployWorkflow = await ask(rl, '  Deploy workflow (optional)', next.frontend.staging.deployWorkflow);

    process.stdout.write('\nFrontend (production):\n');
    next.frontend.production.url = await ask(rl, '  URL', next.frontend.production.url);
    next.frontend.production.healthcheckUrl = await ask(rl, '  Healthcheck URL', next.frontend.production.healthcheckUrl || next.frontend.production.url);
    next.frontend.production.deployWorkflow = await ask(rl, '  Deploy workflow (optional)', next.frontend.production.deployWorkflow);
    return next;
  } finally {
    rl.close();
  }
}

function readFixStub(): FixStub | null {
  const raw = process.env.PIPELANE_DOCTOR_FIX_STUB;
  if (!raw) return null;
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('PIPELANE_DOCTOR_FIX_STUB is set but NODE_ENV is not "test". Unset it and re-run.');
  }
  return JSON.parse(raw) as FixStub;
}

function ask(rl: readline.Interface, label: string, current: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const hint = current ? ` [${current}]` : '';
    rl.question(`${label}${hint}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed || current);
    });
  });
}

