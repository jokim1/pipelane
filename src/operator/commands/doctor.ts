import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  computeUrlFingerprint,
  CONVERGENCE_STATE_KEY_ENV,
  convergenceStateKeyPath,
  MIN_STATE_KEY_LENGTH,
  resolveConvergenceStateKey,
  resolveProbeStateKey,
  resolveReviewConsentStateKey,
  REVIEW_CONSENT_STATE_KEY_ENV,
  reviewConsentStateKeyPath,
  signSignedPayload,
  stateKeyFingerprint,
} from '../integrity.ts';
import {
  additionalDeploySurfaceNames,
  emptyDeployConfig,
  explainSurfaceProbe,
  loadDeployConfig,
  resolveSurfaceProbeUrl,
  saveSharedDeployConfig,
  type DeployConfig,
} from '../release-gate.ts';
import { runNpmGuardSelfCheck } from '../npm-guard-install.ts';
import {
  deploySurfaceContractConfigurationIssues,
  loadConfiguredDeploySurfaceContracts,
} from '../deploy-surface-contract.ts';
import { sanitizeForTerminal } from './helpers.ts';
import {
  ensureStateDir,
  formatWorkflowCommand,
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
// - default (diagnose): read machine-local deploy config, list missing fields,
//   detect platform from well-known config files (fly.toml, vercel.json,
//   netlify.toml, render.yaml, app.json, .github/workflows/).
// - `--probe`: hit each configured staging healthcheck URL and record
//   liveness to probe-state.json. Release-gate reads this.
// - `--fix`: interactive wizard that prompts for platform + URLs, saves
//   machine-local deploy config, and auto-runs --probe.
//
// All three write JSON output under `--json` and human text otherwise.
export async function handleDoctor(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  if (parsed.flags.apply) {
    // `--apply` is the scoped-prune flag on /clean; repurpose `--probe`
    // for clarity. This branch catches an operator who typed --apply here.
    throw new Error('/doctor does not accept --apply. Use --probe (live healthcheck) or --fix (wizard).');
  }

  const mode = resolveDoctorMode(parsed);
  if (mode === 'check-guard') {
    runCheckGuard(parsed);
    return;
  }
  const context = resolveWorkflowContext(cwd);
  if (mode === 'probe') {
    await withDoctorStateLock(context, 'probe', async () => {
      await runProbe(context, parsed);
    });
    return;
  }
  if (mode === 'fix') {
    await withDoctorStateLock(context, 'fix', async () => {
      await runFix(context, parsed);
    });
    return;
  }
  runDiagnose(context, parsed);
}

type DoctorMode = 'diagnose' | 'probe' | 'fix' | 'check-guard';

function resolveDoctorMode(parsed: ParsedOperatorArgs): DoctorMode {
  // Modes arrive as positional args since /doctor doesn't take --probe /
  // --fix as boolean flags elsewhere. Accept either positional or the
  // explicit forms so `pipelane run doctor --probe` and `pipelane run doctor probe` both work.
  const positional = parsed.positional[0];
  const flagsToken = findFlag(parsed);
  if (positional === 'probe' || flagsToken === '--probe') return 'probe';
  if (positional === 'fix' || flagsToken === '--fix') return 'fix';
  if (positional === 'check-guard' || flagsToken === '--check-guard') return 'check-guard';
  if (positional === 'diagnose' || flagsToken === '--diagnose') return 'diagnose';
  return 'diagnose';
}

function findFlag(parsed: ParsedOperatorArgs): string | null {
  // Operator may have passed --probe / --fix / --diagnose as raw tokens that
  // fell through parseOperatorArgs into positional. Scan positional for
  // them; the explicit form is slightly more discoverable than positional.
  for (const entry of parsed.positional) {
    if (entry === '--probe' || entry === '--fix' || entry === '--diagnose' || entry === '--check-guard') return entry;
  }
  return null;
}

function runCheckGuard(parsed: ParsedOperatorArgs): void {
  const result = runNpmGuardSelfCheck();
  printResult(parsed.flags, {
    ok: result.ok,
    message: ['Doctor npm guard:', ...result.lines.map((line) => `  ${line}`)].join('\n'),
  });
  if (!result.ok) {
    process.exitCode = 1;
  }
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
  signingKeys: SigningKeyStatus[];
  message: string;
}

export interface SigningKeyStatus {
  name: string;
  path: string;
  source: 'file' | 'env';
  persisted: boolean;
  provisioned: boolean;
  fingerprint: string | null;
  error: string | null;
}

// Resolving a persisted key auto-provisions it, so running /doctor is the
// fleet-wide (machine-wide) provisioning step E4 requires before any
// convergence enforcement flips. "provisioned" means the persisted key FILE
// exists — an ambient env override is reported as its own source and never
// counts as machine-wide provisioning, because a later run without the
// override would mint a different key.
export function collectSigningKeyStatus(): SigningKeyStatus[] {
  const classes: Array<{ name: string; path: string; envName: string; resolve: () => string }> = [
    { name: 'review-consent-state', path: reviewConsentStateKeyPath(), envName: REVIEW_CONSENT_STATE_KEY_ENV, resolve: resolveReviewConsentStateKey },
    { name: 'convergence-state', path: convergenceStateKeyPath(), envName: CONVERGENCE_STATE_KEY_ENV, resolve: resolveConvergenceStateKey },
  ];
  return classes.map((entry) => {
    const envOverride = Boolean(process.env[entry.envName]?.trim());
    try {
      // Always resolve: without an override this provisions the persisted key;
      // with one it validates the active override before doctor certifies the
      // machine's signing-key state.
      entry.resolve();
      const persisted = existsSync(entry.path);
      const persistedKey = persisted ? readFileSync(entry.path, 'utf8').trim() : '';
      // A persisted file only counts as provisioned when its contents would
      // pass the resolver's own validation; an env override must not let a
      // junk file certify machine-wide readiness.
      const persistedValid = persistedKey.length >= MIN_STATE_KEY_LENGTH;
      let error: string | null = null;
      if (envOverride && !persisted) {
        error = `${entry.envName} override is active but no persisted key file exists; unset the override or provision ${entry.path}.`;
      } else if (persisted && !persistedValid) {
        error = `Persisted key at ${entry.path} is invalid (shorter than ${MIN_STATE_KEY_LENGTH} characters); rotate or re-provision it.`;
      }
      return {
        name: entry.name,
        path: entry.path,
        source: envOverride ? 'env' as const : 'file' as const,
        persisted,
        provisioned: persisted && persistedValid,
        fingerprint: persisted && persistedValid ? stateKeyFingerprint(persistedKey) : null,
        error,
      };
    } catch (error) {
      return {
        name: entry.name,
        path: entry.path,
        source: envOverride ? 'env' as const : 'file' as const,
        persisted: existsSync(entry.path),
        provisioned: false,
        fingerprint: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function runDiagnose(context: WorkflowContext, parsed: ParsedOperatorArgs): void {
  const report = buildDiagnoseReport(context);
  printResult(parsed.flags, report);
}

export function buildDiagnoseReport(context: WorkflowContext): DiagnoseReport {
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const platform = detectPlatform(context.repoRoot, deployConfig);
  const contracts = loadConfiguredDeploySurfaceContracts(context.repoRoot, context.config, deployConfig);
  const surfaceContractIssues = contracts.flatMap((contract) =>
    deploySurfaceContractConfigurationIssues(contract, context.config, deployConfig)
  );
  const missing = [...new Set([...listMissingFields(deployConfig), ...surfaceContractIssues])];
  const probeState = loadProbeState(context.commonDir, context.config);
  const lines: string[] = [];
  lines.push('Doctor diagnosis:');
  lines.push(`  Platform: ${platform.configured || '(unset)'} ${platform.detected && platform.detected !== platform.configured ? `(detected: ${platform.detected})` : ''}`.trimEnd());
  if (platform.sources.length > 0) {
    lines.push(`  Platform signals: ${platform.sources.join(', ')}`);
  }
  for (const contract of contracts) {
    lines.push(`  Deploy surfaces: ${contract.surfaces.join(', ') || '(invalid contract)'} (${path.relative(context.repoRoot, contract.manifestPath)})`);
  }
  if (missing.length === 0) {
    lines.push('  Deploy configuration: complete');
  } else {
    lines.push(`  Deploy configuration: ${missing.length} missing field(s)`);
    for (const field of missing) {
      lines.push(`    - ${field}`);
    }
    lines.push(`  Fix: \`${formatWorkflowCommand(context.config, 'doctor', '--fix')}\``);
  }
  const staleNodeModules = detectStaleNodeModulesLink(context.repoRoot);
  if (staleNodeModules) {
    lines.push(`  node_modules link: stale (${staleNodeModules.target})`);
    lines.push('  Fix: remove only the node_modules symlink, then rerun the Pipelane command or reinstall dependencies in the shared checkout.');
  }
  const versionSkew = detectManagedLocalVersionSkew(context.repoRoot);
  if (versionSkew) {
    lines.push(`  Runtime versions: managed ${versionSkew.managedVersion}, ignored repo-local ${versionSkew.localVersion}`);
    lines.push('  Warning: durable commands use the machine-local runtime; remove or update the repo-local install only if legacy tooling still calls it.');
  }
  const signingKeys = collectSigningKeyStatus();
  lines.push('  Signing keys:');
  for (const key of signingKeys) {
    if (key.provisioned) {
      lines.push(`    - ${key.name}: provisioned (fingerprint ${key.fingerprint})${key.source === 'env' ? ' with env override active' : ''}`);
    } else {
      lines.push(`    - ${key.name}: NOT provisioned (${key.error})`);
    }
  }
  const latestStaging = latestProbeRecordsBySurface(probeState.records, 'staging');
  if (latestStaging.length === 0) {
    lines.push(`  Probe state: no probes recorded. Run \`${formatWorkflowCommand(context.config, 'doctor', '--probe')}\`.`);
  } else {
    lines.push(`  Probe state: ${latestStaging.length} staging surface probe(s) recorded.`);
    for (const record of latestStaging) {
      const freshness = explainSurfaceProbe({
        probeState,
        surface: record.surface,
        environment: 'staging',
        expectedUrl: resolveSurfaceProbeUrl(deployConfig, 'staging', record.surface) || undefined,
      });
      let label = 'UNKNOWN';
      if (freshness.state === 'healthy') label = 'OK';
      if (freshness.state === 'degraded') label = 'FAILED';
      if (freshness.state === 'stale') label = 'STALE';
      const detail = freshness.state === 'healthy'
        ? `HTTP ${record.statusCode ?? '?'}`
        : freshness.reason;
      lines.push(`    - ${record.surface}: ${label} (${detail}) at ${record.probedAt}`);
    }
  }
  return {
    platform,
    missingFields: missing,
    probeState: { present: probeState.records.length > 0, records: probeState.records },
    signingKeys,
    message: lines.join('\n'),
  };
}

function detectStaleNodeModulesLink(repoRoot: string): { target: string } | null {
  const nodeModulesPath = path.join(repoRoot, 'node_modules');
  try {
    const stat = lstatSync(nodeModulesPath);
    if (!stat.isSymbolicLink()) {
      return null;
    }
    const rawTarget = readlinkSync(nodeModulesPath);
    const target = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(repoRoot, rawTarget);
    return existsSync(target) ? null : { target };
  } catch {
    return null;
  }
}

function readJsonVersion(targetPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(targetPath, 'utf8')) as { version?: string; packageVersion?: string };
    return parsed.version || parsed.packageVersion || '';
  } catch {
    return '';
  }
}

function detectManagedLocalVersionSkew(repoRoot: string): { managedVersion: string; localVersion: string } | null {
  const managedRoot = process.env.PIPELANE_MANAGED_RUNTIME_ROOT;
  if (!managedRoot) {
    return null;
  }
  const managedVersion = readJsonVersion(path.join(managedRoot, '.pipelane-runtime.json'))
    || readJsonVersion(path.join(managedRoot, 'package.json'));
  const localVersion = readJsonVersion(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'));
  if (!managedVersion || !localVersion || managedVersion === localVersion) {
    return null;
  }
  return { managedVersion, localVersion };
}

function latestProbeRecordsBySurface(records: ProbeRecord[], environment: ProbeEnvironment): ProbeRecord[] {
  const latest = new Map<string, ProbeRecord>();
  for (const record of records) {
    if (record.environment !== environment) continue;
    latest.set(record.surface, record);
  }
  return [...latest.values()];
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
  // `/doctor --probe` in CI before `/pr`).
  const stagingFailed = outcome.records.some((record) => record.environment === 'staging' && !record.ok);
  if (stagingFailed) {
    process.exitCode = 1;
  }
}

export async function executeProbe(context: WorkflowContext, nowFn: () => Date = () => new Date()): Promise<ProbeOutcome> {
  const deployConfig = loadDeployConfig(context.repoRoot);
  if (!deployConfig) {
    throw new Error([
      'No machine-local deploy configuration saved.',
      `Run \`${formatWorkflowCommand(context.config, 'doctor', '--fix')}\` to create it.`,
    ].join('\n'));
  }

  const targets = collectProbeTargets(deployConfig);
  // probeUrl always resolves (catches its own errors into the record), so
  // Promise.all can't short-circuit on a single bad target. Parallelizing
  // cuts end-to-end probe latency from sum-of-targets to max-of-targets.
  const key = resolveProbeStateKey();
  const records = (await Promise.all(targets.map((target) => probeUrl(target, nowFn))))
    .map((record) => finalizeProbeRecord(record, key));

  // Merge new records on top of the existing snapshot so a partial
  // re-probe (single surface) doesn't wipe out previously-probed surfaces.
  const previous = loadProbeState(context.commonDir, context.config);
  const merged = mergeProbeRecords(previous.records, records);
  const now = nowFn().toISOString();
  saveProbeState(context.commonDir, context.config, { records: merged, updatedAt: now });

  const lines = ['Doctor probe:'];
  if (records.length === 0) {
    lines.push('  No probe targets — machine-local deploy config has no configured healthcheck URLs.');
  } else {
    for (const record of records) {
      const errorText = record.error ? sanitizeForTerminal(record.error) : 'no response';
      const status = record.ok
        ? `OK (HTTP ${record.statusCode ?? '?'}, ${record.latencyMs ?? '?'}ms)`
        : `FAILED (${record.statusCode ? `HTTP ${record.statusCode}` : errorText})`;
      // URLs come from machine-local deploy config but probe records are
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
  for (const surface of additionalDeploySurfaceNames(config)) {
    const surfaceConfig = config.surfaces[surface];
    if (surfaceConfig.staging.healthcheckUrl) {
      targets.push({ environment: 'staging', surface, url: surfaceConfig.staging.healthcheckUrl });
    }
    if (surfaceConfig.production.healthcheckUrl) {
      targets.push({ environment: 'production', surface, url: surfaceConfig.production.healthcheckUrl });
    }
  }
  return targets;
}

// 5s bound keeps /doctor --probe responsive even when a configured
// staging URL stalls (DNS timeout, TCP hang). Override via
// PIPELANE_DOCTOR_PROBE_TIMEOUT_MS for slow staging environments.
// Default matches what a human expects from an "interactive CLI healthcheck."
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const MIN_PROBE_TIMEOUT_MS = 100;
export const MAX_PROBE_TIMEOUT_MS = 30000;

export function resolveProbeTimeoutMs(): number {
  const raw = process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS;
  if (!raw) return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROBE_TIMEOUT_MS;
  const clamped = Math.trunc(parsed);
  return Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, clamped));
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

function finalizeProbeRecord(record: ProbeRecord, key: string | undefined): ProbeRecord {
  const finalized: ProbeRecord = {
    ...record,
    urlFingerprint: computeUrlFingerprint(record.url),
  };
  if (!key) return finalized;
  return {
    ...finalized,
    signature: signSignedPayload(finalized, key),
  };
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

const DOCTOR_LOCK_FILENAME = 'doctor.lock.json';

interface DoctorLockMetadata {
  pid: number;
  createdAt: string;
  mode: 'probe' | 'fix';
}

async function withDoctorStateLock<T>(
  context: WorkflowContext,
  mode: 'probe' | 'fix',
  work: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(ensureStateDir(context.commonDir, context.config), DOCTOR_LOCK_FILENAME);
  acquireDoctorStateLock(lockPath, mode);
  try {
    return await work();
  } finally {
    releaseDoctorStateLock(lockPath);
  }
}

function acquireDoctorStateLock(lockPath: string, mode: 'probe' | 'fix'): void {
  const metadata: DoctorLockMetadata = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    mode,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (pruneStaleDoctorStateLock(lockPath)) continue;
      const existing = readDoctorStateLock(lockPath);
      const detail = existing
        ? `${existing.mode} already running in pid ${existing.pid} since ${existing.createdAt}`
        : 'another doctor state mutation is already running';
      throw new Error(`Doctor state is locked: ${detail}. Wait for it to finish and retry.`);
    }
  }
}

function pruneStaleDoctorStateLock(lockPath: string): boolean {
  const existing = readDoctorStateLock(lockPath);
  if (!existing) {
    unlinkIfExists(lockPath);
    return true;
  }
  try {
    process.kill(existing.pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      unlinkIfExists(lockPath);
      return true;
    }
    return false;
  }
}

function readDoctorStateLock(lockPath: string): DoctorLockMetadata | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<DoctorLockMetadata>;
    if ((parsed.mode === 'probe' || parsed.mode === 'fix')
      && typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && typeof parsed.createdAt === 'string'
      && parsed.createdAt.length > 0) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
        mode: parsed.mode,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function releaseDoctorStateLock(lockPath: string): void {
  unlinkIfExists(lockPath);
}

function unlinkIfExists(targetPath: string): void {
  try {
    unlinkSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

// ---------------------------------------------------------------------------
// fix wizard
// ---------------------------------------------------------------------------

async function runFix(context: WorkflowContext, parsed: ParsedOperatorArgs): Promise<void> {
  if (parsed.flags.json) {
    throw new Error('/doctor --fix is interactive and cannot run under --json. Use `pipelane configure` for scripted configuration.');
  }
  if (!process.stdin.isTTY && !process.env.PIPELANE_DOCTOR_FIX_STUB) {
    throw new Error('/doctor --fix requires a TTY. Re-run from a terminal, or use `pipelane configure --json ...` for scripted config.');
  }
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const detected = detectPlatform(context.repoRoot, deployConfig);
  const next = await promptFixValues(deployConfig, detected);
  saveSharedDeployConfig(context.repoRoot, next);

  const outcome = await executeProbe(context);
  const lines = [
    'Doctor fix: saved machine-local deploy configuration.',
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
