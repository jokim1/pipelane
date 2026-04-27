import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeUrlFingerprint, resolveProbeStateKey, verifySignedPayload } from './integrity.ts';

export type Mode = 'build' | 'release';
export type KnownSurface = 'frontend' | 'edge' | 'sql';
export const WORKFLOW_COMMANDS = ['devmode', 'new', 'resume', 'repo-guard', 'pr', 'merge', 'deploy', 'smoke', 'clean', 'status', 'doctor', 'rollback'] as const;
export type WorkflowCommand = (typeof WORKFLOW_COMMANDS)[number];
export const DEFAULT_WORKFLOW_ALIASES: Record<WorkflowCommand, string> = {
  devmode: '/devmode',
  new: '/new',
  resume: '/resume',
  'repo-guard': '/repo-guard',
  pr: '/pr',
  merge: '/merge',
  deploy: '/deploy',
  smoke: '/smoke',
  clean: '/clean',
  status: '/status',
  doctor: '/doctor',
  rollback: '/rollback',
};

// Managed Claude command files that aren't workflow operator actions. These
// still ship with `<!-- pipelane:command:<name> -->` markers, flow through
// the collision / prune / consumer-extension machinery, but are not aliased
// (filename is fixed) and are not dispatched via `pipelane run <name>`.
export const MANAGED_EXTRA_COMMANDS = ['pipelane', 'fix'] as const;
export type ManagedExtraCommand = (typeof MANAGED_EXTRA_COMMANDS)[number];
export const MANAGED_COMMANDS = [...WORKFLOW_COMMANDS, ...MANAGED_EXTRA_COMMANDS] as const;
export type ManagedCommand = (typeof MANAGED_COMMANDS)[number];

// v4: optional-plugin checks declared per-consumer. Absent = no checks run.
// Each field enables a specific plugin; consumers opt in per-project. Today
// only secret-manifest + gh-required-secrets are implemented; the shape is
// forward-compatible for future checks (SBOM, license scan, coverage floor).
export interface ChecksConfig {
  // Supabase function secret manifest check. Reads the manifest file and
  // verifies every `required` name appears in the configured supabase
  // projects (staging + production). Requires secretManifestPath.
  requireSecretManifest?: boolean;
  secretManifestPath?: string;
  // GitHub repo-level secrets that must exist (no env scope). Checked via
  // `gh secret list`.
  requiredRepoSecrets?: string[];
  // GitHub environment-level secrets (staging + production) that must exist.
  // Checked via `gh secret list --env <name>` for each environment.
  requiredEnvironmentSecrets?: string[];
}

export interface SmokePreflightStepConfig {
  name: string;
  command: string;
  critical?: boolean;
}

export interface SmokeCohortConfig {
  name: string;
  blocking?: boolean;
}

export interface SmokeEnvironmentConfig {
  command: string;
  preflight?: SmokePreflightStepConfig[];
  cohorts?: SmokeCohortConfig[];
}

export interface SmokeWaiverConfig {
  path?: string;
  maxExtensions?: number;
}

export interface SmokeHistoryConfig {
  dir?: string;
  latestPath?: string;
  retentionDays?: number;
  maxEntries?: number;
}

export interface SmokeConcurrencyConfig {
  mode?: 'single-flight';
}

export interface SmokeConfig {
  registryPath?: string;
  generatedSummaryPath?: string;
  criticalPathCoverage?: 'warn' | 'block';
  criticalPaths?: string[];
  requireStagingSmoke?: boolean;
  staging?: SmokeEnvironmentConfig;
  prod?: SmokeEnvironmentConfig;
  waivers?: SmokeWaiverConfig;
  history?: SmokeHistoryConfig;
  concurrency?: SmokeConcurrencyConfig;
}

export interface WorkflowConfig {
  version: number;
  projectKey: string;
  displayName: string;
  baseBranch: string;
  stateDir: string;
  taskWorktreeDirName: string;
  branchPrefix: string;
  legacyBranchPrefixes: string[];
  surfaces: string[];
  aliases: Record<WorkflowCommand, string>;
  prePrChecks: string[];
  prPathDenyList: string[];
  deployWorkflowName: string;
  buildMode: {
    description: string;
    autoDeployOnMerge: boolean;
  };
  releaseMode: {
    description: string;
    requireStagingPromotion: boolean;
  };
  // Optional; absent in default config. See ChecksConfig for semantics.
  checks?: ChecksConfig;
  // Optional; absent in default config. Per-surface opt-outs for
  // syncConsumerDocs. Missing entry = default true (current behavior).
  syncDocs?: SyncDocsConfig;
  // v1.4: path-prefix map for `/status --blast <sha>`. Keys are surface
  // names (typically the entries in `surfaces`), values are POSIX
  // directory prefixes ("src/frontend/") or exact filenames matched
  // against `git diff --name-only` output. Empty / absent = all changes
  // land in the "other" bucket with a hint to configure the map.
  surfacePathMap?: Record<string, string[]>;
  smoke?: SmokeConfig;
}

// Per-surface opt-out flags for `pipelane setup` / `pipelane sync-docs`.
// Absent or undefined means "sync this surface" (default true). Consumers
// that want partial regeneration (e.g. commands regen but NO marker
// injection into README/AGENTS/CONTRIBUTING) set the surfaces they want
// skipped to false.
export interface SyncDocsConfig {
  claudeCommands?: boolean;
  codexSkills?: boolean;
  readmeSection?: boolean;
  contributingSection?: boolean;
  agentsSection?: boolean;
  docsReleaseWorkflow?: boolean;
  pipelaneClaudeTemplate?: boolean;
  packageScripts?: boolean;
}

export const DEFAULT_SYNC_DOCS: Required<SyncDocsConfig> = {
  claudeCommands: true,
  codexSkills: true,
  readmeSection: true,
  contributingSection: true,
  agentsSection: true,
  docsReleaseWorkflow: true,
  pipelaneClaudeTemplate: true,
  packageScripts: true,
};

export function resolveSyncDocs(raw: SyncDocsConfig | undefined): Required<SyncDocsConfig> {
  // Defense in depth: setupConsumerRepo and syncDocsOnly call JSON.parse
  // directly and do NOT route through normalizeWorkflowConfig, so junk
  // values (string "false", null, arrays, spread-of-a-string) can reach
  // here unsanitized. Per-key type-check at use time guarantees that
  // only real booleans flip a surface, and any non-boolean value (or a
  // non-object `raw`) falls back to the declared default. This is what
  // prevents `{ "readmeSection": "false" }` from injecting the README
  // section (truthy string) when the consumer clearly meant to skip it.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_SYNC_DOCS };
  }
  const resolved: Required<SyncDocsConfig> = { ...DEFAULT_SYNC_DOCS };
  for (const key of Object.keys(DEFAULT_SYNC_DOCS) as (keyof SyncDocsConfig)[]) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'boolean') {
      resolved[key] = value;
    }
  }
  return resolved;
}

export const DEFAULT_BRANCH_PREFIX = 'codex/';

// Patterns matched against changed-file basenames during `pipelane run pr`
// before the silent `git add -A`. Keep this list short and unambiguous —
// the goal is "operator forgot to gitignore their secrets" not general
// pre-commit hooks. Override in .pipelane.json when a repo legit
// tracks one of these (e.g. a docs-only `CLAUDE.md`).
export const DEFAULT_PR_PATH_DENY_LIST = [
  'CLAUDE.md',
  '.env',
  '.env.*',
  '*.pem',
  '*.p12',
  'id_rsa*',
  '*.key',
];

export interface ModeState {
  mode: Mode;
  requestedSurfaces: string[];
  override: null | {
    reason: string;
    timestamp: string;
  };
  // v1.5: audit trail for the most recent release override. Unlike `override`
  // which is cleared when switching back to `build`, `lastOverride` persists
  // so `/status` can keep surfacing "this repo has previously bypassed the
  // release gate" even after the gate is re-armed. Always set whenever a
  // non-null `override` is written; never cleared by mode flips.
  lastOverride?: {
    reason: string;
    setAt: string;
    setBy: string;
  };
  updatedAt: string | null;
}

export interface TaskLock {
  taskSlug: string;
  taskName?: string;
  branchName: string;
  worktreePath: string;
  mode: Mode;
  surfaces: string[];
  updatedAt: string;
  // v1.3: persistent breadcrumb for AI↔AI handoff across sessions. Set by
  // state-mutating commands (/pr, /merge, /deploy) and surfaced by /status
  // today; /resume render integration is queued for the next slice. Absent
  // on fresh locks until the first mutation writes it.
  nextAction?: string;
  // Skip-smoke observability. Set to true when `/deploy prod` succeeds with
  // `smoke.staging.command` unconfigured AND `requireStagingSmoke` is not
  // true (i.e. the promotion was allowed but without smoke evidence). `/status`
  // surfaces it so the skip decision is visible instead of silent. A later
  // `/deploy prod` that DID run with staging smoke clears the flag on next
  // write.
  promotedWithoutStagingSmoke?: boolean;
  // Audit trail for task/worktree rebinding recoveries. The current lock
  // branch/path remain authoritative; history explains how they changed.
  bindingHistory?: Array<{
    reboundAt: string;
    reason: string;
    fromBranchName: string;
    fromWorktreePath: string;
    toBranchName: string;
    toWorktreePath: string;
    fingerprint: string;
  }>;
}

export interface PrRecord {
  taskSlug: string;
  branchName: string;
  title: string;
  number?: number;
  url?: string;
  mergedSha?: string;
  mergedAt?: string;
  updatedAt: string;
}

export interface ActionRunRecord {
  id: string;
  taskSlug: string;
  branchName: string;
  actionId: string;
  label: string;
  status: 'succeeded' | 'failed';
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  reason: string;
  stdout: string;
  stderr: string;
}

export interface ActionState {
  records: Record<string, ActionRunRecord[]>;
}

export type DeployStatus = 'requested' | 'succeeded' | 'failed' | 'unknown';

export interface DeployVerification {
  healthcheckUrl?: string;
  statusCode?: number;
  latencyMs?: number;
  probes?: number;
  error?: string;
}

export interface DeployRuntimeObservation {
  observedSha?: string;
  observedAt?: string;
  releaseMarkerUrl?: string;
  releaseMarkerState?: 'healthy' | 'unknown' | 'degraded' | 'unavailable';
  reason?: string;
}

export interface DeployRecord {
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  workflowName: string;
  requestedAt: string;
  // v0.1: per-task, verified-outcome aware, idempotent.
  taskSlug?: string;
  status?: DeployStatus;
  workflowRunId?: string;
  workflowRunUrl?: string;
  finishedAt?: string;
  durationMs?: number;
  verifiedAt?: string;
  verification?: DeployVerification;
  // v1.2: per-surface verification. A multi-surface deploy writes one entry
  // per surface so a frontend-only healthcheck can't credit edge/sql.
  verificationBySurface?: Record<string, DeployVerification>;
  // v1.2: fingerprint of deployConfig at deploy time. The observed-success
  // gate re-blocks when the current config has drifted (staging URL rotated,
  // healthcheck path changed, etc.). Computed by computeDeployConfigFingerprint.
  configFingerprint?: string;
  runtimeObservation?: DeployRuntimeObservation;
  // v1.2 (optional): HMAC-SHA256 over canonical record fields using the key
  // at env PIPELANE_DEPLOY_STATE_KEY. Unsigned records are accepted when no
  // key is configured; when a key IS configured, unsigned + invalid-sig
  // records are rejected on load. Defense-in-depth against fs-forged records.
  signature?: string;
  rollbackOfSha?: string;
  idempotencyKey?: string;
  triggeredBy?: string;
  failureReason?: string;
  smokeCoverageOverrideReason?: string;
}

export type SmokeEnvironment = 'staging' | 'prod';
export type SmokeRunStatus = 'passed' | 'failed' | 'passed_with_retries';
export type SmokeScenarioLifecycle = 'suggested' | 'accepted' | 'generated' | 'verified' | 'blocking' | 'quarantined';
export type SmokeSafetyFlag = 'readonly' | 'stagingOnly' | 'requiresSyntheticData' | 'externalDependency' | 'unsafeForAutomation';

export interface SmokeScenarioProvenance {
  source: 'discovered-tag' | 'internal-template' | 'user-feedback' | 'scenario-file';
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  updatedAt?: string;
}

export interface SmokeRegistryEntry {
  description?: string;
  blocking?: boolean;
  quarantine?: boolean;
  owner?: string;
  escalation?: string;
  runbook?: string;
  environments?: SmokeEnvironment[];
  surfaces?: string[];
  sourceTests?: string[];
  reviewBy?: string;
  reason?: string;
  lifecycle?: SmokeScenarioLifecycle;
  safetyFlags?: SmokeSafetyFlag[];
  requiredEnv?: string[];
  provenance?: SmokeScenarioProvenance;
  generated?: {
    path?: string;
    marker?: string;
    adapter?: string;
    status?: 'unverified' | 'passed' | 'failed' | 'passed_with_retries';
    verifiedAt?: string;
  };
}

export interface SmokeRegistryState {
  checks: Record<string, SmokeRegistryEntry>;
}

export interface SmokeWaiverRecord {
  tag: string;
  environment: SmokeEnvironment;
  reason: string;
  createdAt: string;
  expiresAt: string;
  extensions?: number;
}

export interface SmokeWaiverState {
  waivers: SmokeWaiverRecord[];
}

export interface SmokePreflightResult {
  name: string;
  critical: boolean;
  status: 'passed' | 'failed' | 'skipped';
  logPath: string;
}

export interface SmokeArtifacts {
  firstFailureTrace?: string;
  htmlReport?: string;
  screenshotDir?: string;
  logPath?: string;
}

export interface SmokeRunnerCheckResult {
  tag: string;
  status: SmokeRunStatus;
  attempts?: Array<{ attempt: number; status: SmokeRunStatus }>;
  artifacts?: SmokeArtifacts;
  tests?: { passed: number; total: number };
}

export interface SmokeRunnerResultContract {
  schemaVersion?: number;
  checks: SmokeRunnerCheckResult[];
}

export interface SmokeCohortResult {
  name: string;
  blocking: boolean;
  status: SmokeRunStatus;
  exitCode: number;
  artifacts?: SmokeArtifacts;
  checks?: SmokeRunnerCheckResult[];
  resultsPath?: string;
  contractError?: string;
}

export interface SmokeCheckResult {
  tag: string;
  status: SmokeRunStatus;
  quarantine: boolean;
  blocking: boolean;
  effectiveBlocking: boolean;
  waived?: boolean;
  waiverReason?: string;
  owner?: string;
  attempts: Array<{ attempt: number; status: SmokeRunStatus }>;
  artifacts?: SmokeArtifacts;
  cohorts?: string[];
  tests?: { passed: number; total: number };
}

export interface SmokeRunRecord {
  runId: string;
  environment: SmokeEnvironment;
  sha: string;
  baseUrl: string;
  status: SmokeRunStatus;
  startedAt: string;
  finishedAt: string;
  preflight: SmokePreflightResult[];
  cohortResults: SmokeCohortResult[];
  checks: SmokeCheckResult[];
  waiversApplied: SmokeWaiverRecord[];
  lastKnownGoodSha: string | null;
  drifted?: boolean;
  retryCount?: number;
}

export interface SmokeLatestState {
  staging: SmokeRunRecord | null;
  prod: SmokeRunRecord | null;
  updatedAt: string;
}

export interface SmokeEnvironmentLock {
  environment: SmokeEnvironment;
  operation: 'smoke' | 'deploy';
  runId: string;
  sha: string;
  createdAt: string;
  pid: number;
  repoRoot: string;
}

export interface OperatorFlags {
  apply: boolean;
  allStale: boolean;
  force: boolean;
  help: boolean;
  json: boolean;
  offline: boolean;
  override: boolean;
  skipSmokeCoverage: boolean;
  patch: boolean;
  reason: string;
  sha: string;
  pr: string;
  task: string;
  branch: string;
  file: string;
  title: string;
  message: string;
  recover: string;
  bindingFingerprint: string;
  mode: string;
  scope: string;
  surfaces: string[];
  execute: boolean;
  confirmToken: string;
  forceInclude: string[];
  async: boolean;
  // v1.4: mutually exclusive `/status` view selectors. Default (all false
  // and blastSha empty) renders the existing cockpit. Only one may be
  // set; handleStatus throws when two collide.
  week: boolean;
  stuck: boolean;
  blastSha: string;
  // v1.1: `/rollback <env> --revert-pr` alternate recovery path — opens a
  // `git revert <mergeCommit>` PR via gh instead of dispatching a deploy.
  // Mutually exclusive with the default redeploy flow. Release-mode only.
  revertPr: boolean;
  // `pipelane run smoke setup` flags. Values are stored exactly as provided
  // (trimmed of outer whitespace) so shell command strings with embedded
  // spaces / quotes / metacharacters roundtrip into .pipelane.json faithfully.
  // `requireStagingSmoke` uses an explicit tri-state empty / 'true' / 'false'
  // rather than a boolean so absence is distinguishable from explicit false —
  // presence means "operator opted in", absence means "leave the existing
  // value alone in the deep merge."
  stagingCommand: string;
  prodCommand: string;
  // Shorter input form for the common case: pick a package.json script by
  // name. `handleSmokeSetup` resolves these to `npm run <name>` before
  // writing config. Mutually exclusive with the matching --*-command flag.
  // Sidesteps the quoting footgun of the full-shell-command form.
  stagingScript: string;
  prodScript: string;
  requireStagingSmoke: string;
  generatedSummaryPath: string;
  criticalPaths: string[];
  criticalPathCoverage: string;
  refresh: boolean;
  baseUrl: string;
  smokeFeedback: string[];
  scenarioFile: string;
  makeBlocking: boolean;
}

export interface ParsedOperatorArgs {
  command: string;
  positional: string[];
  flags: OperatorFlags;
}

export interface WorkflowContext {
  cwd: string;
  repoRoot: string;
  commonDir: string;
  config: WorkflowConfig;
  modeState: ModeState;
}

export const DEFAULT_MODE: Mode = 'build';
export const DEFAULT_SURFACES = ['frontend', 'edge', 'sql'];
export const CONFIG_FILENAME = '.pipelane.json';
export const LEGACY_CONFIG_FILENAME = '.project-workflow.json';
const MODE_STATE_FILENAME = 'mode-state.json';
const PR_STATE_FILENAME = 'pr-state.json';
const DEPLOY_STATE_FILENAME = 'deploy-state.json';
const ACTION_STATE_FILENAME = 'action-state.json';
const DEPLOY_CONFIG_FILENAME = 'deploy-config.json';
const PROBE_STATE_FILENAME = 'probe-state.json';
const TASK_LOCKS_DIRNAME = 'task-locks';
const INSTALL_MARKER_FILENAME = 'installed.json';
const LEGACY_MIGRATION_FILENAME = 'legacy-migration.json';

// State-resilience invariants. Pipelane state lives at
// `<commonDir>/<config.stateDir>/`, where `config.stateDir` defaults
// to a value pipelane ships. When that default has been renamed in
// the past — most recently `rocketboard-workflow` →
// `pipelane-state` — every existing install silently re-initialized:
// mode-state defaulted to 'build', probes were "missing" (release
// gate fail-closed), deploy history looked empty. The fix has three
// layers, all anchored on the constants below:
//
//   LEGACY_STATE_DIRS — fallback chain. When the canonical state
//   dir has no install marker but a known-legacy dir exists with
//   files, copy the orphaned files forward on first load. New
//   legacy entries get added here as defaults are renamed.
//
//   INSTALL_MARKER_FILENAME — written into the canonical dir on
//   first save (or on completed legacy migration). Distinguishes
//   "fresh install" (no marker, silent default is correct) from
//   "regression" (marker present, expected file missing —
//   loud-warn instead of silent reset).
//
//   STATE_SCHEMA_VERSIONS / STATE_MIGRATIONS — every persisted
//   state file gets a schemaVersion envelope. A future shape
//   change registers a step in STATE_MIGRATIONS; loaders run them
//   forward and rewrite on first load. Today the registry is
//   empty (current shapes pinned as v1).
//
// Policy: the values here are public contract. Renaming a default
// state path or filename requires a corresponding LEGACY_STATE_DIRS
// entry; a breaking shape change requires a STATE_MIGRATIONS entry.
// See REPO_GUIDANCE.md "State-resilience invariants".
export const LEGACY_STATE_DIRS = ['rocketboard-workflow'];

export const STATE_SCHEMA_VERSIONS = {
  modeState: 1,
  probeState: 1,
  deployState: 1,
  prState: 1,
  actionState: 1,
  deployConfig: 1,
  taskLock: 1,
} as const;

export type StateKind = keyof typeof STATE_SCHEMA_VERSIONS;

// Migration steps from version N to N+1, per state kind. A future
// shape change (e.g. modeState v1 → v2) registers a function at
// `STATE_MIGRATIONS.modeState[1]` mapping a v1 shape forward. Today
// every shape is the v1 baseline; the registry exists so the next
// breaking change has a tested home rather than a special case in
// the loader.
export const STATE_MIGRATIONS: Record<StateKind, Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>> = {
  modeState: {},
  probeState: {},
  deployState: {},
  prState: {},
  actionState: {},
  deployConfig: {},
  taskLock: {},
};

// v1.2: doctor.probe records. One entry per (environment, surface). Written
// by `/doctor --probe` and read by the release-gate as a liveness check:
// a probe succeeded + fresh (<PROBE_STALE_MS) gates release alongside the
// observed-staging-success check. Stale or failed probes block release
// until the operator re-probes or confirms the surface is healthy some
// other way.
export const PROBE_STALE_MS = 24 * 60 * 60 * 1000;

export type ProbeEnvironment = 'staging' | 'production';

export interface ProbeRecord {
  environment: ProbeEnvironment;
  surface: string;
  url: string;
  urlFingerprint?: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error?: string;
  probedAt: string;
  signature?: string;
}

export interface ProbeState {
  records: ProbeRecord[];
  updatedAt: string;
}

export function defaultWorkflowConfig(projectKey: string, displayName: string): WorkflowConfig {
  return {
    version: 1,
    projectKey,
    displayName,
    baseBranch: 'main',
    stateDir: 'pipelane-state',
    taskWorktreeDirName: `${projectKey}-worktrees`,
    branchPrefix: DEFAULT_BRANCH_PREFIX,
    legacyBranchPrefixes: [],
    surfaces: [...DEFAULT_SURFACES],
    aliases: { ...DEFAULT_WORKFLOW_ALIASES },
    prePrChecks: [
      'npm run test',
      'npm run typecheck',
      'npm run build',
    ],
    prPathDenyList: [...DEFAULT_PR_PATH_DENY_LIST],
    deployWorkflowName: 'Deploy Hosted',
    buildMode: {
      description: 'Fast lane. Production deploy is expected to happen after merge.',
      autoDeployOnMerge: true,
    },
    releaseMode: {
      description: 'Protected lane. Promote the same merged SHA through staging before prod.',
      requireStagingPromotion: true,
    },
    smoke: undefined,
  };
}

export function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Cap at 128 chars to keep disk filenames + git branch names within
// reasonable bounds without silently amputating human-meaningful suffixes.
// macOS/Linux filename max is 255; git refs have no formal cap but stay
// readable well under 128.
//
// History: until #34 this was .slice(0, 32), which silently dropped
// trailing characters from common task names like
// "fix-delete-project-sidebar-update" (33 chars) → "...updat". #34 raised
// the cap to 128; this commit removes the silent-truncation behavior
// entirely — hitting the cap now throws an actionable error instead of
// amputating. Silent truncation is the UX bug; the cap is just the
// specific value at which the bug manifests.
export const TASK_SLUG_MAX_LENGTH = 128;

export function slugifyTaskName(taskName: string): string {
  const slug = taskName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length > TASK_SLUG_MAX_LENGTH) {
    throw new Error(
      `Task name too long after slugification: ${slug.length} chars, max is ${TASK_SLUG_MAX_LENGTH}. ` +
      `Original input: "${taskName}". Shorten the name and retry.`,
    );
  }

  return slug;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): string | null {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (error) {
    if (options.allowFailure) {
      return null;
    }

    const err = error as { stderr?: Buffer | string; message: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : err.stderr?.toString().trim();
    throw new Error(stderr || err.message);
  }
}

export function runCommandCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { ok: boolean; exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return {
      ok: false,
      exitCode: result.status ?? 1,
      stdout: '',
      stderr: result.error.message,
    };
  }

  return {
    ok: result.status === 0,
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

export function runGit(cwd: string, args: string[], allowFailure = false): string | null {
  return runCommand('git', args, { cwd, allowFailure });
}

export function runGh(cwd: string, args: string[], allowFailure = false): string | null {
  return runCommand('gh', args, { cwd, allowFailure });
}

export function runShell(cwd: string, command: string, quiet = false): void {
  try {
    execFileSync('sh', ['-lc', command], {
      cwd,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
  } catch (error) {
    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message: string; status?: number };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : err.stderr?.toString().trim();
    const stdout = typeof err.stdout === 'string' ? err.stdout.trim() : err.stdout?.toString().trim();
    throw new Error([
      `Command failed in ${cwd}: ${command}`,
      typeof err.status === 'number' ? `Exit code: ${err.status}` : '',
      stderr || stdout || err.message,
      'Fix the command output above, then rerun the Pipelane command.',
    ].filter(Boolean).join('\n'));
  }
}

export function resolveRepoRoot(cwd: string, allowNoGit = false): string {
  const repoRoot = runGit(cwd, ['rev-parse', '--show-toplevel'], allowNoGit);

  if (repoRoot) {
    return normalizePath(repoRoot);
  }

  if (allowNoGit) {
    return normalizePath(cwd);
  }

  throw new Error('Not inside a git repository.');
}

export function resolveGitCommonDir(repoRoot: string): string {
  const commonDir = runGit(repoRoot, ['rev-parse', '--git-common-dir']);

  if (!commonDir) {
    throw new Error('Could not resolve the git common dir.');
  }

  return normalizePath(path.resolve(repoRoot, commonDir));
}

export function resolveConfigPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILENAME);
}

export function resolveReadableConfigPath(repoRoot: string): string | null {
  const configPath = resolveConfigPath(repoRoot);
  if (existsSync(configPath)) {
    return configPath;
  }

  const legacyConfigPath = path.join(repoRoot, LEGACY_CONFIG_FILENAME);
  if (existsSync(legacyConfigPath)) {
    return legacyConfigPath;
  }

  return null;
}

// Read a tracked `pipelane` block from the repo's package.json. Consumers who
// gitignore `.pipelane.json` can persist durable customizations here
// (aliases, smoke commands, syncDocs opt-outs) so fresh checkouts and new
// worktrees don't regress to bare defaults. Returns null when package.json
// is missing, malformed, or has no `pipelane` field.
export function readPackageJsonOverlay(repoRoot: string): Partial<WorkflowConfig> | null {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const pipelaneField = (parsed as Record<string, unknown>).pipelane;
  if (!pipelaneField || typeof pipelaneField !== 'object' || Array.isArray(pipelaneField)) return null;
  return pipelaneField as Partial<WorkflowConfig>;
}

function readPackageJsonName(repoRoot: string): string | null {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
    if (typeof parsed.name !== 'string') return null;
    const trimmed = parsed.name.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// Layer a stack of Partial<WorkflowConfig>s on top of a full base, with deep
// merge for the nested record-valued fields pipelane treats compositionally
// (aliases, syncDocs, smoke, etc.). Later overlays win. The output is a
// Partial — pass it through `normalizeWorkflowConfig` to produce a full
// config. Arrays and primitive fields use last-write-wins; we deliberately
// don't concatenate `surfaces` / `prePrChecks` / `prPathDenyList` because
// consumers expect the overlay value to replace the default, not extend it.
function mergeWorkflowLayers(
  base: WorkflowConfig,
  ...overlays: Array<Partial<WorkflowConfig> | null | undefined>
): Partial<WorkflowConfig> {
  let current: Partial<WorkflowConfig> = { ...base };
  for (const overlay of overlays) {
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) continue;
    const next: Partial<WorkflowConfig> = { ...current, ...overlay };
    next.aliases = { ...(current.aliases ?? {} as Record<WorkflowCommand, string>), ...(overlay.aliases ?? {}) } as Record<WorkflowCommand, string>;
    if (overlay.syncDocs) next.syncDocs = { ...current.syncDocs, ...overlay.syncDocs };
    if (overlay.checks) next.checks = { ...current.checks, ...overlay.checks };
    if (overlay.smoke) next.smoke = { ...current.smoke, ...overlay.smoke };
    if (overlay.surfacePathMap) next.surfacePathMap = { ...current.surfacePathMap, ...overlay.surfacePathMap };
    if (overlay.buildMode) next.buildMode = { ...current.buildMode, ...overlay.buildMode } as WorkflowConfig['buildMode'];
    if (overlay.releaseMode) next.releaseMode = { ...current.releaseMode, ...overlay.releaseMode } as WorkflowConfig['releaseMode'];
    current = next;
  }
  return current;
}

// Build a usable WorkflowConfig from repo-derived signals alone, no
// `.pipelane.json` required. Used for the self-heal path: `pipelane setup`
// on a fresh checkout of a consumer that gitignores `.pipelane.json`, or
// that has only a `package.json:pipelane` overlay. projectKey/displayName
// fall back through: explicit override > package.json name > repo basename.
export function synthesizeWorkflowConfig(repoRoot: string): WorkflowConfig {
  const overlay = readPackageJsonOverlay(repoRoot);
  const overlayName = typeof overlay?.displayName === 'string' ? overlay.displayName.trim() : '';
  const inferredName = overlayName || readPackageJsonName(repoRoot) || path.basename(repoRoot);
  const overlayKey = typeof overlay?.projectKey === 'string' ? overlay.projectKey.trim() : '';
  const projectKey = overlayKey || inferProjectKey(inferredName);
  const base = defaultWorkflowConfig(projectKey, inferredName);
  const merged = mergeWorkflowLayers(base, overlay);
  return normalizeWorkflowConfig(merged);
}

export function loadWorkflowConfig(repoRoot: string): WorkflowConfig {
  const configPath = resolveReadableConfigPath(repoRoot);

  // Self-heal: when neither `.pipelane.json` nor the legacy file is present,
  // derive a workable config from defaults + optional package.json overlay.
  // Callers that need to mutate the file (e.g. `smoke setup`) materialize it
  // via `patchReadableWorkflowConfig`, which writes on first patch.
  if (!configPath) {
    return synthesizeWorkflowConfig(repoRoot);
  }

  let parsed: Partial<WorkflowConfig>;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<WorkflowConfig>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ${path.basename(configPath)} at ${configPath}: ${detail}. Fix the JSON by hand before rerunning.`);
  }

  // Layer defaults < package.json overlay < tracked file. The file keeps
  // winning for existing consumers (no behavior change when it's complete),
  // and a partial file — e.g. after a future `smoke setup --write-to=file`
  // that only persists the smoke slice — still produces a full config by
  // pulling the rest from overlay/defaults.
  const overlay = readPackageJsonOverlay(repoRoot);
  const overlayName = typeof overlay?.displayName === 'string' ? overlay.displayName.trim() : '';
  const fileName = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
  const inferredName = fileName || overlayName || readPackageJsonName(repoRoot) || path.basename(repoRoot);
  const overlayKey = typeof overlay?.projectKey === 'string' ? overlay.projectKey.trim() : '';
  const fileKey = typeof parsed.projectKey === 'string' ? parsed.projectKey.trim() : '';
  const projectKey = fileKey || overlayKey || inferProjectKey(inferredName);
  const base = defaultWorkflowConfig(projectKey, inferredName);
  const merged = mergeWorkflowLayers(base, overlay, parsed);
  return normalizeWorkflowConfig(merged);
}

export function normalizeWorkflowConfig(raw: Partial<WorkflowConfig>): WorkflowConfig {
  const branchPrefix = normalizeBranchPrefix(raw.branchPrefix);
  const legacyBranchPrefixes = normalizeLegacyBranchPrefixes(raw.legacyBranchPrefixes)
    .filter((prefix, index, all) => prefix !== branchPrefix && all.indexOf(prefix) === index);
  return {
    ...(raw as WorkflowConfig),
    branchPrefix,
    legacyBranchPrefixes,
    prPathDenyList: raw.prPathDenyList ?? [...DEFAULT_PR_PATH_DENY_LIST],
    aliases: resolveWorkflowAliases(raw.aliases),
    checks: normalizeChecksConfig(raw.checks),
    syncDocs: normalizeSyncDocsConfig(raw.syncDocs),
    surfacePathMap: normalizeSurfacePathMap(raw.surfacePathMap),
    smoke: normalizeSmokeConfig(raw.smoke),
  };
}

function normalizeSmokeConfig(raw: SmokeConfig | undefined): SmokeConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const normalizeEnvironment = (value: SmokeEnvironmentConfig | undefined): SmokeEnvironmentConfig | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const command = typeof value.command === 'string' ? value.command.trim() : '';
    if (!command) return undefined;
    const preflight = Array.isArray(value.preflight)
      ? value.preflight
          .filter((step): step is SmokePreflightStepConfig =>
            Boolean(step)
            && typeof step.name === 'string'
            && step.name.trim().length > 0
            && typeof step.command === 'string'
            && step.command.trim().length > 0,
          )
          .map((step) => ({
            name: step.name.trim(),
            command: step.command.trim(),
            critical: step.critical === true,
          }))
      : undefined;
    const cohorts = Array.isArray(value.cohorts)
      ? value.cohorts
          .filter((cohort): cohort is SmokeCohortConfig =>
            Boolean(cohort)
            && typeof cohort.name === 'string'
            && cohort.name.trim().length > 0,
          )
          .map((cohort) => ({
            name: cohort.name.trim(),
            blocking: cohort.blocking !== false,
          }))
      : undefined;
    return {
      command,
      preflight,
      cohorts,
    };
  };
  const criticalPaths = Array.isArray(raw.criticalPaths)
    ? raw.criticalPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const normalized: SmokeConfig = {
    registryPath: typeof raw.registryPath === 'string' && raw.registryPath.trim().length > 0 ? raw.registryPath.trim() : undefined,
    generatedSummaryPath: typeof raw.generatedSummaryPath === 'string' && raw.generatedSummaryPath.trim().length > 0 ? raw.generatedSummaryPath.trim() : undefined,
    criticalPathCoverage: raw.criticalPathCoverage === 'block' ? 'block' : (raw.criticalPathCoverage === 'warn' ? 'warn' : undefined),
    criticalPaths,
    requireStagingSmoke: raw.requireStagingSmoke === true,
    staging: normalizeEnvironment(raw.staging),
    prod: normalizeEnvironment(raw.prod),
    waivers: raw.waivers && typeof raw.waivers === 'object'
      ? {
          path: typeof raw.waivers.path === 'string' && raw.waivers.path.trim().length > 0 ? raw.waivers.path.trim() : undefined,
          maxExtensions: typeof raw.waivers.maxExtensions === 'number' && Number.isFinite(raw.waivers.maxExtensions)
            ? Math.max(0, Math.trunc(raw.waivers.maxExtensions))
            : undefined,
        }
      : undefined,
    history: raw.history && typeof raw.history === 'object'
      ? {
          dir: typeof raw.history.dir === 'string' && raw.history.dir.trim().length > 0 ? raw.history.dir.trim() : undefined,
          latestPath: typeof raw.history.latestPath === 'string' && raw.history.latestPath.trim().length > 0 ? raw.history.latestPath.trim() : undefined,
          retentionDays: typeof raw.history.retentionDays === 'number' && Number.isFinite(raw.history.retentionDays)
            ? Math.max(1, Math.trunc(raw.history.retentionDays))
            : undefined,
          maxEntries: typeof raw.history.maxEntries === 'number' && Number.isFinite(raw.history.maxEntries)
            ? Math.max(1, Math.trunc(raw.history.maxEntries))
            : undefined,
        }
      : undefined,
    concurrency: raw.concurrency && raw.concurrency.mode === 'single-flight'
      ? { mode: 'single-flight' }
      : undefined,
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

// Accept a surface→path-list map only when both shape and value types
// check out. Garbage keys and non-string-array values are dropped rather
// than crashing loadWorkflowConfig, matching how checks/syncDocs handle
// malformed input. Returns undefined when nothing survives so the
// serialized config stays minimal.
function normalizeSurfacePathMap(
  raw: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [surface, patterns] of Object.entries(raw)) {
    if (typeof surface !== 'string' || !surface.trim()) continue;
    if (!Array.isArray(patterns)) continue;
    const cleaned = patterns.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    );
    if (cleaned.length > 0) out[surface] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Strip non-boolean and unknown keys. Returns undefined when no boolean
// flags remain so the serialized config stays minimal for consumers that
// never opt out. Explicit `true` values are preserved as-is (they don't
// collapse to undefined). Runs on the `loadWorkflowConfig` path only;
// setup + sync-docs bypass it and rely on `resolveSyncDocs` at use-time
// for runtime defense.
function normalizeSyncDocsConfig(raw: SyncDocsConfig | undefined): SyncDocsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const keys: (keyof SyncDocsConfig)[] = [
    'claudeCommands',
    'codexSkills',
    'readmeSection',
    'contributingSection',
    'agentsSection',
    'docsReleaseWorkflow',
    'pipelaneClaudeTemplate',
    'packageScripts',
  ];
  const out: SyncDocsConfig = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// v4: preserve the checks field if present; returning undefined keeps the
// default "no checks" semantics for consumers that never opted in.
function normalizeChecksConfig(raw: ChecksConfig | undefined): ChecksConfig | undefined {
  if (!raw) return undefined;
  return {
    requireSecretManifest: raw.requireSecretManifest === true,
    secretManifestPath: typeof raw.secretManifestPath === 'string' ? raw.secretManifestPath.trim() : undefined,
    requiredRepoSecrets: Array.isArray(raw.requiredRepoSecrets)
      ? raw.requiredRepoSecrets.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : undefined,
    requiredEnvironmentSecrets: Array.isArray(raw.requiredEnvironmentSecrets)
      ? raw.requiredEnvironmentSecrets.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : undefined,
  };
}

function normalizeLegacyBranchPrefixes(prefixes: unknown): string[] {
  if (!Array.isArray(prefixes)) return [];
  const normalized: string[] = [];
  for (const entry of prefixes) {
    const prefix = normalizeOptionalBranchPrefix(entry);
    if (prefix) normalized.push(prefix);
  }
  return normalized;
}

function normalizeBranchPrefix(prefix: unknown): string {
  return normalizeOptionalBranchPrefix(prefix) ?? DEFAULT_BRANCH_PREFIX;
}

function normalizeOptionalBranchPrefix(prefix: unknown): string | null {
  if (typeof prefix !== 'string') return null;
  const trimmed = prefix.trim();
  if (!trimmed) return null;
  const normalized = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  if (!isValidBranchPrefix(normalized)) return null;
  return normalized;
}

function isValidBranchPrefix(prefix: string): boolean {
  const candidate = `${prefix}branch-prefix-validation`;
  return runCommandCapture('git', ['check-ref-format', '--branch', candidate]).ok;
}

export function writeWorkflowConfig(repoRoot: string, config: WorkflowConfig): void {
  writeJsonFile(resolveConfigPath(repoRoot), {
    ...config,
    aliases: resolveWorkflowAliases(config.aliases),
  });
}

// Read the readable workflow config file, run the patcher, atomically write
// the result back to the same path. Used by `pipelane run smoke setup` to
// update only the smoke subtree without disturbing unrelated keys.
//
// - If no config file exists, throws with the same init-guidance message
//   `loadWorkflowConfig` uses so the operator sees a consistent hint.
// - If the existing file is malformed JSON, throws with the parse error
//   (including line/column when the runtime reports it). Never auto-repairs.
// - Writes to the same path the config was read from — if the repo is still
//   on legacy `.project-workflow.json`, the legacy file is updated in place
//   rather than silently creating a second `.pipelane.json`.
export function patchReadableWorkflowConfig(
  repoRoot: string,
  patcher: (raw: Record<string, unknown>) => Record<string, unknown>,
): { configPath: string; isLegacy: boolean } {
  let configPath = resolveReadableConfigPath(repoRoot);
  // Self-heal: if no file is tracked (consumer gitignored `.pipelane.json`
  // or never ran `pipelane init`), materialize one from synthesized defaults
  // + any `package.json:pipelane` overlay before patching. The patcher then
  // sees a complete JSON object and writes its slice on top. This is the
  // only write-to-disk path in the self-heal flow — `loadWorkflowConfig`
  // intentionally stays read-only so the gitignore promise holds until a
  // mutation actually needs to persist.
  if (!configPath) {
    writeWorkflowConfig(repoRoot, synthesizeWorkflowConfig(repoRoot));
    configPath = resolveConfigPath(repoRoot);
  }
  const raw = readFileSync(configPath, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ${path.basename(configPath)} at ${configPath}: ${detail}. Fix the JSON by hand before rerunning.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed ${path.basename(configPath)} at ${configPath}: expected a JSON object. Fix the JSON by hand before rerunning.`);
  }
  const next = patcher(parsed);
  writeJsonFile(configPath, next);
  return { configPath, isLegacy: configPath.endsWith(LEGACY_CONFIG_FILENAME) };
}

export function resolveStateDir(commonDir: string, config: WorkflowConfig): string {
  return path.join(commonDir, config.stateDir);
}

export function resolveSharedRepoRoot(commonDir: string): string {
  return path.dirname(normalizePath(commonDir));
}

export function ensureStateDir(commonDir: string, config: WorkflowConfig): string {
  const stateDir = resolveStateDir(commonDir, config);
  mkdirSync(path.join(stateDir, TASK_LOCKS_DIRNAME), { recursive: true });
  // Idempotent legacy migration runs before marker is planted so a
  // successful copy doesn't get suppressed by the marker we'd
  // otherwise plant first. Both calls are no-ops on subsequent
  // invocations.
  migrateLegacyStateDir(commonDir, config);
  ensureInstallMarker(commonDir, config);
  return stateDir;
}

export function modeStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), MODE_STATE_FILENAME);
}

export function deployStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), DEPLOY_STATE_FILENAME);
}

export function actionStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), ACTION_STATE_FILENAME);
}

export function deployConfigPath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), DEPLOY_CONFIG_FILENAME);
}

export function prStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), PR_STATE_FILENAME);
}

export function probeStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), PROBE_STATE_FILENAME);
}

export function resolveSmokeTrackedDir(repoRoot: string): string {
  return path.join(repoRoot, '.pipelane');
}

export function resolveSmokeRegistryPath(repoRoot: string, config: WorkflowConfig): string {
  return path.join(repoRoot, config.smoke?.registryPath ?? '.pipelane/smoke-checks.json');
}

export function resolveSmokeWaiversPath(repoRoot: string, config: WorkflowConfig): string {
  return path.join(repoRoot, config.smoke?.waivers?.path ?? '.pipelane/waivers.json');
}

export function resolveSmokeRuntimeRoot(commonDir: string): string {
  return path.join(resolveSharedRepoRoot(commonDir), '.pipelane', 'state', 'smoke');
}

export function resolveSmokeHistoryDir(commonDir: string, config: WorkflowConfig): string {
  const relative = config.smoke?.history?.dir?.trim();
  if (relative) {
    return path.join(resolveSharedRepoRoot(commonDir), relative);
  }
  return path.join(resolveSmokeRuntimeRoot(commonDir), 'history');
}

export function resolveSmokeLatestPath(commonDir: string, config: WorkflowConfig): string {
  const relative = config.smoke?.history?.latestPath?.trim();
  if (relative) {
    return path.join(resolveSharedRepoRoot(commonDir), relative);
  }
  return path.join(resolveSmokeRuntimeRoot(commonDir), 'latest.json');
}

export function resolveSmokeHistoryRecordPath(commonDir: string, config: WorkflowConfig, runId: string): string {
  return path.join(resolveSmokeHistoryDir(commonDir, config), `${runId}.json`);
}

export function resolveSmokeLogsDir(commonDir: string): string {
  return path.join(resolveSmokeRuntimeRoot(commonDir), 'logs');
}

export function resolveSmokeLockPath(commonDir: string, environment: SmokeEnvironment): string {
  return path.join(resolveSmokeRuntimeRoot(commonDir), 'locks', `${environment}.json`);
}

export function loadProbeState(commonDir: string, config: WorkflowConfig): ProbeState {
  const raw = readVersionedJsonFile<ProbeState>('probeState', commonDir, config, probeStatePath(commonDir, config), { records: [] as ProbeRecord[], updatedAt: '' });
  const normalized = normalizeProbeState(raw);
  const structurallyValid = normalized.records.filter((record) =>
    !record.urlFingerprint || record.urlFingerprint === computeUrlFingerprint(record.url)
  );
  const key = resolveProbeStateKey();
  if (!key) {
    return { ...normalized, records: structurallyValid };
  }
  return {
    ...normalized,
    records: structurallyValid.filter((record) =>
      typeof record.urlFingerprint === 'string'
      && verifySignedPayload(record, key)
    ),
  };
}

export function loadSmokeRegistry(repoRoot: string, config: WorkflowConfig): SmokeRegistryState {
  const raw = readJsonFile<SmokeRegistryState>(resolveSmokeRegistryPath(repoRoot, config), { checks: {} });
  const source = raw && typeof raw === 'object' ? raw : { checks: {} };
  const checks = source.checks && typeof source.checks === 'object' ? source.checks : {};
  return { checks: checks as Record<string, SmokeRegistryEntry> };
}

export function saveSmokeRegistry(repoRoot: string, config: WorkflowConfig, value: SmokeRegistryState): void {
  mkdirSync(resolveSmokeTrackedDir(repoRoot), { recursive: true });
  writeJsonFile(resolveSmokeRegistryPath(repoRoot, config), value);
}

export function loadSmokeWaivers(repoRoot: string, config: WorkflowConfig): SmokeWaiverState {
  const raw = readJsonFile<SmokeWaiverState>(resolveSmokeWaiversPath(repoRoot, config), { waivers: [] });
  const waivers = Array.isArray(raw?.waivers) ? raw.waivers : [];
  return { waivers: waivers as SmokeWaiverRecord[] };
}

export function saveSmokeWaivers(repoRoot: string, config: WorkflowConfig, value: SmokeWaiverState): void {
  mkdirSync(resolveSmokeTrackedDir(repoRoot), { recursive: true });
  writeJsonFile(resolveSmokeWaiversPath(repoRoot, config), value);
}

export function loadSmokeLatestState(commonDir: string, config: WorkflowConfig): SmokeLatestState {
  return readJsonFile<SmokeLatestState>(resolveSmokeLatestPath(commonDir, config), {
    staging: null,
    prod: null,
    updatedAt: '',
  });
}

export function saveSmokeLatestState(commonDir: string, config: WorkflowConfig, value: SmokeLatestState): void {
  writeJsonFile(resolveSmokeLatestPath(commonDir, config), value);
}

export function saveSmokeRunRecord(commonDir: string, config: WorkflowConfig, value: SmokeRunRecord): void {
  writeJsonFile(resolveSmokeHistoryRecordPath(commonDir, config, value.runId), value);
}

export function loadSmokeRunRecord(commonDir: string, config: WorkflowConfig, runId: string): SmokeRunRecord | null {
  return readJsonFile<SmokeRunRecord | null>(resolveSmokeHistoryRecordPath(commonDir, config, runId), null);
}

export function listSmokeRunRecords(commonDir: string, config: WorkflowConfig): SmokeRunRecord[] {
  const historyDir = resolveSmokeHistoryDir(commonDir, config);
  if (!existsSync(historyDir)) {
    return [];
  }
  return readdirSync(historyDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readJsonFile<SmokeRunRecord | null>(path.join(historyDir, entry), null))
    .filter((entry): entry is SmokeRunRecord => entry !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function loadSmokeEnvironmentLock(commonDir: string, environment: SmokeEnvironment): SmokeEnvironmentLock | null {
  return readJsonFile<SmokeEnvironmentLock | null>(resolveSmokeLockPath(commonDir, environment), null);
}

export function saveSmokeEnvironmentLock(commonDir: string, value: SmokeEnvironmentLock): void {
  writeJsonFile(resolveSmokeLockPath(commonDir, value.environment), value);
}

export function removeSmokeEnvironmentLock(commonDir: string, environment: SmokeEnvironment): void {
  const targetPath = resolveSmokeLockPath(commonDir, environment);
  if (existsSync(targetPath)) {
    unlinkSync(targetPath);
  }
}

// v1.2: mirror `normalizeModeState` — a malformed probe-state.json (valid
// JSON but missing `records`, or records with unexpected shape) otherwise
// crashes every consumer of explainSurfaceProbe with `undefined is not
// iterable`. Silently coerce the container shape and drop individual
// records that don't look right. Half-written files from an interrupted
// save, hand-edits, and future schema evolutions all fail-closed to an
// empty probe set rather than bricking the release gate.
function normalizeProbeState(raw: ProbeState): ProbeState {
  const source = (raw ?? {}) as Partial<ProbeState>;
  const records = Array.isArray(source.records) ? source.records : [];
  const updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : '';
  const valid: ProbeRecord[] = [];
  for (const entry of records) {
    const record = entry as Partial<ProbeRecord> | null;
    if (!record || typeof record !== 'object') continue;
    if (record.environment !== 'staging' && record.environment !== 'production') continue;
    if (typeof record.surface !== 'string' || record.surface.length === 0) continue;
    if (typeof record.url !== 'string') continue;
    if (typeof record.ok !== 'boolean') continue;
    if (typeof record.probedAt !== 'string') continue;
    const statusCode = typeof record.statusCode === 'number' ? record.statusCode : null;
    const latencyMs = typeof record.latencyMs === 'number' ? record.latencyMs : null;
    valid.push({
      environment: record.environment,
      surface: record.surface,
      url: record.url,
      urlFingerprint: typeof record.urlFingerprint === 'string' ? record.urlFingerprint : undefined,
      ok: record.ok,
      statusCode,
      latencyMs,
      error: typeof record.error === 'string' ? record.error : undefined,
      probedAt: record.probedAt,
      signature: typeof record.signature === 'string' ? record.signature : undefined,
    });
  }
  return { records: valid, updatedAt };
}

export function saveProbeState(commonDir: string, config: WorkflowConfig, value: ProbeState): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('probeState', probeStatePath(commonDir, config), value);
}

export function taskLockPath(commonDir: string, config: WorkflowConfig, taskSlug: string): string {
  return path.join(resolveStateDir(commonDir, config), TASK_LOCKS_DIRNAME, `${taskSlug}.json`);
}

export function readJsonFile<T>(targetPath: string, fallback: T): T {
  if (!existsSync(targetPath)) {
    return fallback;
  }

  try {
    return JSON.parse(readFileSync(targetPath, 'utf8')) as T;
  } catch (error) {
    // Half-written state files from an interrupted write surface as
    // SyntaxError (truncated JSON). Fail closed to the caller's fallback
    // instead of bricking every state consumer until a human deletes the
    // file. Non-parse failures still bubble — permissions and I/O errors
    // are real operator problems, not schema drift.
    if (error instanceof SyntaxError) {
      warnMalformedJson(targetPath);
      return fallback;
    }
    throw error;
  }
}

const malformedJsonWarnings = new Set<string>();

function warnMalformedJson(targetPath: string): void {
  if (malformedJsonWarnings.has(targetPath)) return;
  malformedJsonWarnings.add(targetPath);
  process.stderr.write(
    `[pipelane] WARNING: ${targetPath} contains malformed JSON; using fallback state for this run. Fix or remove the file so future commands read the intended state.\n`,
  );
}

export function writeJsonFile(targetPath: string, value: unknown): void {
  const dir = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  const tmpPath = path.join(
    dir,
    `.${basename}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, targetPath);
  } finally {
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { force: true });
    }
  }
}

// State-resilience helpers. See "State-resilience invariants"
// constants block above for the rationale.

export function installMarkerPath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), INSTALL_MARKER_FILENAME);
}

export function legacyMigrationPath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), LEGACY_MIGRATION_FILENAME);
}

export function hasInstallMarker(commonDir: string, config: WorkflowConfig): boolean {
  return existsSync(installMarkerPath(commonDir, config));
}

export function ensureInstallMarker(commonDir: string, config: WorkflowConfig): void {
  const target = installMarkerPath(commonDir, config);
  if (existsSync(target)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  writeJsonFile(target, { installedAt: nowIso() });
}

const missingStateWarnings = new Set<string>();

function warnMissingStateAfterInstall(targetPath: string): void {
  if (missingStateWarnings.has(targetPath)) return;
  missingStateWarnings.add(targetPath);
  process.stderr.write(
    `[pipelane] WARNING: ${targetPath} is missing but install marker exists. `
    + `Pipelane has previously written state at this location, so this is likely an upgrade `
    + `regression (renamed config.stateDir, manual rm, etc.). Defaulting for this run; `
    + `investigate before relying on the result.\n`,
  );
}

const legacyMigrationLogged = new Set<string>();

// One-shot best-effort migration from a known-legacy state dir into
// the canonical one. Idempotent: skipped when the install marker is
// already present (canonical install was created first), when an
// audit file exists from a prior migration, or when no legacy dir
// has any contents. File-level non-destructive: copies a legacy file
// forward only when the canonical equivalent is absent, so any
// fresh canonical state written post-rename keeps priority over
// stale legacy data.
export function migrateLegacyStateDir(commonDir: string, config: WorkflowConfig): void {
  const canonicalDir = resolveStateDir(commonDir, config);
  if (hasInstallMarker(commonDir, config)) return;
  if (existsSync(legacyMigrationPath(commonDir, config))) return;

  for (const legacyName of LEGACY_STATE_DIRS) {
    if (legacyName === config.stateDir) continue;
    const legacyDir = path.join(commonDir, legacyName);
    if (!existsSync(legacyDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(legacyDir);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;

    mkdirSync(canonicalDir, { recursive: true });
    const copied: string[] = [];
    for (const name of entries) {
      const src = path.join(legacyDir, name);
      const dst = path.join(canonicalDir, name);
      if (existsSync(dst)) continue;
      try {
        // cpSync handles both files and directories with `recursive: true`.
        cpSync(src, dst, { recursive: true });
        copied.push(name);
      } catch {
        // Per-entry failures don't abort the run — the operator can
        // re-attempt by deleting the partial canonical entry. We
        // record what was copied successfully.
      }
    }

    if (copied.length === 0) continue;

    writeJsonFile(legacyMigrationPath(commonDir, config), {
      from: legacyDir,
      to: canonicalDir,
      copiedAt: nowIso(),
      entries: copied,
    });
    // Plant the install marker so subsequent loads know this dir is
    // populated and the loud-warn path is armed for any genuinely
    // missing files post-migration.
    ensureInstallMarker(commonDir, config);

    // De-dup so concurrent commands in the same process (the
    // dashboard server hitting multiple loaders) don't each emit
    // a copy of the migration banner.
    if (!legacyMigrationLogged.has(canonicalDir)) {
      legacyMigrationLogged.add(canonicalDir);
      process.stderr.write(
        `[pipelane] Migrated ${copied.length} legacy state file(s) from ${legacyDir} to ${canonicalDir}. `
        + `The legacy directory is unchanged; remove it manually once you've confirmed pipelane behaves correctly.\n`,
      );
    }
    // Stop after the first hit. Multiple legacy dirs at once would
    // mean pipelane has been moved twice without a marker — an
    // operator should resolve that manually rather than us guessing
    // the order.
    return;
  }
}

// Wrap readJsonFile with schema-version migration and the
// install-marker loud-warn. Strips the schemaVersion envelope so
// callers see the clean shape and can pass it back to writers
// without round-tripping the version field.
//
// `commonDir`+`config` are required because the warn-on-missing
// behavior keys off the install marker, which lives inside the
// canonical state dir. State files outside that dir (smoke history,
// repo-tracked configs) should keep using readJsonFile directly.
export function readVersionedJsonFile<T>(
  kind: StateKind,
  commonDir: string,
  config: WorkflowConfig,
  targetPath: string,
  fallback: T,
): T {
  if (!existsSync(targetPath)) {
    if (hasInstallMarker(commonDir, config)) {
      warnMissingStateAfterInstall(targetPath);
    }
    return fallback;
  }

  const raw = readJsonFile<unknown>(targetPath, fallback as unknown);
  if (raw === fallback) return fallback;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw as T;
  }

  let value = raw as Record<string, unknown>;
  const onDiskVersion = typeof value.schemaVersion === 'number' ? value.schemaVersion : 0;
  const targetVersion = STATE_SCHEMA_VERSIONS[kind];
  const migrations = STATE_MIGRATIONS[kind];

  for (let v = onDiskVersion; v < targetVersion; v++) {
    const migrate = migrations[v];
    if (migrate) value = migrate(value);
  }

  if ('schemaVersion' in value) {
    const stripped = { ...value };
    delete stripped.schemaVersion;
    return stripped as T;
  }
  return value as T;
}

export function writeVersionedJsonFile(kind: StateKind, targetPath: string, value: unknown): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    writeJsonFile(targetPath, {
      ...(value as Record<string, unknown>),
      schemaVersion: STATE_SCHEMA_VERSIONS[kind],
    });
  } else {
    writeJsonFile(targetPath, value);
  }
}

export function loadModeState(commonDir: string, config: WorkflowConfig): ModeState {
  const raw = readVersionedJsonFile<ModeState>('modeState', commonDir, config, modeStatePath(commonDir, config), {
    mode: DEFAULT_MODE,
    requestedSurfaces: [...config.surfaces],
    override: null,
    updatedAt: null,
  });
  return normalizeModeState(raw);
}

// v1.5: drop malformed fields on load rather than letting them crash
// renderers downstream (`/devmode status` prints `last.setBy.length`
// directly). A corrupt or hand-edited mode-state.json where
// `lastOverride` is a string, array, or missing one of its three
// required subfields gets silently dropped back to `undefined`. Strict:
// all three strings, all non-empty — partials are as suspicious as
// fully-malformed entries.
function normalizeModeState(raw: ModeState): ModeState {
  const last = raw.lastOverride as unknown;
  if (last && typeof last === 'object' && !Array.isArray(last)) {
    const entry = last as Record<string, unknown>;
    if (
      typeof entry.reason === 'string' && entry.reason.length > 0
      && typeof entry.setAt === 'string' && entry.setAt.length > 0
      && typeof entry.setBy === 'string' && entry.setBy.length > 0
    ) {
      return {
        ...raw,
        lastOverride: { reason: entry.reason, setAt: entry.setAt, setBy: entry.setBy },
      };
    }
  }
  if (raw.lastOverride !== undefined) {
    return { ...raw, lastOverride: undefined };
  }
  return raw;
}

export function saveModeState(commonDir: string, config: WorkflowConfig, value: ModeState): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('modeState', modeStatePath(commonDir, config), value);
}

export function loadDeployState(commonDir: string, config: WorkflowConfig): { records: DeployRecord[] } {
  const loaded = readVersionedJsonFile<unknown>('deployState', commonDir, config, deployStatePath(commonDir, config), { records: [] as DeployRecord[] });
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return { records: [] };
  }
  const records = (loaded as { records?: unknown }).records;
  return { records: Array.isArray(records) ? records as DeployRecord[] : [] };
}

export function saveDeployState(commonDir: string, config: WorkflowConfig, value: { records: DeployRecord[] }): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('deployState', deployStatePath(commonDir, config), value);
}

export function loadPrState(commonDir: string, config: WorkflowConfig): { records: Record<string, PrRecord> } {
  return readVersionedJsonFile('prState', commonDir, config, prStatePath(commonDir, config), { records: {} as Record<string, PrRecord> });
}

export function savePrState(commonDir: string, config: WorkflowConfig, value: { records: Record<string, PrRecord> }): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('prState', prStatePath(commonDir, config), value);
}

export function loadActionState(commonDir: string, config: WorkflowConfig): ActionState {
  const raw = readVersionedJsonFile<ActionState>('actionState', commonDir, config, actionStatePath(commonDir, config), { records: {} });
  const records: Record<string, ActionRunRecord[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)) {
    return { records };
  }

  for (const [taskSlug, entries] of Object.entries(raw.records)) {
    if (!Array.isArray(entries)) continue;
    records[taskSlug] = entries
      .filter((entry): entry is ActionRunRecord => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const item = entry as unknown as Record<string, unknown>;
        return typeof item.id === 'string'
          && typeof item.taskSlug === 'string'
          && typeof item.branchName === 'string'
          && typeof item.actionId === 'string'
          && typeof item.label === 'string'
          && (item.status === 'succeeded' || item.status === 'failed')
          && typeof item.exitCode === 'number'
          && typeof item.startedAt === 'string'
          && typeof item.finishedAt === 'string'
          && typeof item.reason === 'string'
          && typeof item.stdout === 'string'
          && typeof item.stderr === 'string';
      })
      .slice(0, 20);
  }
  return { records };
}

export function saveActionState(commonDir: string, config: WorkflowConfig, value: ActionState): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('actionState', actionStatePath(commonDir, config), value);
}

export function appendActionRunRecord(commonDir: string, config: WorkflowConfig, record: ActionRunRecord): ActionRunRecord {
  const state = loadActionState(commonDir, config);
  const existing = state.records[record.taskSlug] ?? [];
  state.records[record.taskSlug] = [record, ...existing].slice(0, 20);
  saveActionState(commonDir, config, state);
  return record;
}

export function loadPrRecord(commonDir: string, config: WorkflowConfig, taskSlug: string): PrRecord | null {
  return loadPrState(commonDir, config).records[taskSlug] ?? null;
}

export function savePrRecord(commonDir: string, config: WorkflowConfig, taskSlug: string, record: Omit<PrRecord, 'taskSlug' | 'updatedAt'> & { updatedAt?: string }): PrRecord {
  const state = loadPrState(commonDir, config);
  const next: PrRecord = {
    ...(state.records[taskSlug] ?? {
      taskSlug,
      branchName: record.branchName,
      title: record.title,
      updatedAt: nowIso(),
    }),
    ...record,
    taskSlug,
    updatedAt: record.updatedAt ?? nowIso(),
  };
  state.records[taskSlug] = next;
  savePrState(commonDir, config, state);
  return next;
}

export function loadTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string): TaskLock | null {
  return readVersionedJsonFile<TaskLock | null>('taskLock', commonDir, config, taskLockPath(commonDir, config, taskSlug), null);
}

export function saveTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string, value: TaskLock): TaskLock {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('taskLock', taskLockPath(commonDir, config, taskSlug), value);
  return value;
}

export function removeTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string): void {
  const targetPath = taskLockPath(commonDir, config, taskSlug);
  if (existsSync(targetPath)) {
    unlinkSync(targetPath);
  }
}

export function loadAllTaskLocks(commonDir: string, config: WorkflowConfig): TaskLock[] {
  const lockDir = path.join(resolveStateDir(commonDir, config), TASK_LOCKS_DIRNAME);

  if (!existsSync(lockDir)) {
    return [];
  }

  return readdirSync(lockDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const targetPath = path.join(lockDir, entry);
      // Route through readVersionedJsonFile so task locks written
      // with a schemaVersion envelope (post-state-resilience) get
      // migrated forward and the version field stripped before
      // returning to consumers expecting the bare TaskLock shape.
      return readVersionedJsonFile<TaskLock | null>('taskLock', commonDir, config, targetPath, null);
    })
    .filter((entry): entry is TaskLock => entry !== null)
    .sort((left, right) => left.taskSlug.localeCompare(right.taskSlug));
}

export function surfaceSetKey(values: string[]): string {
  return [...new Set(values.filter(Boolean))].sort().join(',');
}

export function resolveWorkflowContext(cwd: string): WorkflowContext {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadWorkflowConfig(repoRoot);
  const commonDir = resolveGitCommonDir(repoRoot);
  // Trigger legacy-state migration at the canonical entry point so
  // read-only commands (/status, /landing-report) pull state forward
  // even when no save runs in the same process. Idempotent: skipped
  // when the install marker exists or no legacy dir has data.
  migrateLegacyStateDir(commonDir, config);
  const modeState = loadModeState(commonDir, config);
  return {
    cwd,
    repoRoot,
    commonDir,
    config,
    modeState,
  };
}

export function printResult(flags: OperatorFlags | { json?: boolean }, output: unknown): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (typeof output === 'object' && output !== null && 'message' in output) {
    process.stdout.write(`${String((output as { message: string }).message)}\n`);
    return;
  }

  process.stdout.write(`${String(output)}\n`);
}

export function inferProjectKey(projectName: string): string {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

export function normalizeWorkflowAlias(alias: unknown, fallback: string): string {
  // Coerce to string before `.trim()` so a consumer writing `"aliases": {
  // "clean": 42 }` gets the nice "Invalid workflow alias" error instead of
  // a cryptic `.trim is not a function` crash.
  const aliasValue = typeof alias === 'string' ? alias : '';
  const raw = (aliasValue || fallback).trim().toLowerCase();
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;

  if (!/^\/[a-z0-9][a-z0-9-_]*$/.test(prefixed)) {
    const display = typeof alias === 'string' ? alias : String(alias);
    throw new Error(`Invalid workflow alias "${display || fallback}". Use slash commands like /new or /release-pr.`);
  }

  return prefixed;
}

export function resolveWorkflowAliases(
  aliases: Partial<Record<WorkflowCommand, string>> | Record<string, string> | undefined,
): Record<WorkflowCommand, string> {
  const next = {} as Record<WorkflowCommand, string>;
  const seen = new Map<string, WorkflowCommand>();

  // Flag typos like `cleanup: '/cleanup'` when the actual command is `clean`
  // before silently dropping them. The user gets told which keys pipelane
  // accepts so they can fix the spelling.
  if (aliases && typeof aliases === 'object') {
    const known = new Set<string>(WORKFLOW_COMMANDS);
    const unknown = Object.keys(aliases).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown workflow alias key(s): ${unknown.join(', ')}. Known keys: ${WORKFLOW_COMMANDS.join(', ')}.`,
      );
    }
  }

  for (const command of WORKFLOW_COMMANDS) {
    const resolved = normalizeWorkflowAlias(aliases?.[command] ?? DEFAULT_WORKFLOW_ALIASES[command], DEFAULT_WORKFLOW_ALIASES[command]);
    const conflict = seen.get(resolved);
    if (conflict) {
      throw new Error(`Workflow aliases must be unique. ${conflict} and ${command} both resolve to ${resolved}.`);
    }
    seen.set(resolved, command);
    next[command] = resolved;
  }

  return next;
}

export function formatWorkflowCommand(
  config: Pick<WorkflowConfig, 'aliases'>,
  command: WorkflowCommand,
  args: string | string[] = '',
): string {
  const aliases = resolveWorkflowAliases(config.aliases);
  const suffix = Array.isArray(args)
    ? args.map((entry) => entry.trim()).filter(Boolean).join(' ')
    : args.trim();
  return suffix ? `${aliases[command]} ${suffix}` : aliases[command];
}

export function aliasCommandName(alias: string): string {
  return normalizeWorkflowAlias(alias, alias).slice(1);
}

export function parseOperatorArgs(argv: string[]): ParsedOperatorArgs {
  const positional: string[] = [];
  const flags: OperatorFlags = {
    apply: false,
    allStale: false,
    force: false,
    help: false,
    json: false,
    offline: false,
    override: false,
    skipSmokeCoverage: false,
    patch: false,
    reason: '',
    sha: '',
    pr: '',
    task: '',
    branch: '',
    file: '',
    title: '',
    message: '',
    recover: '',
    bindingFingerprint: '',
    mode: '',
    scope: '',
    surfaces: [],
    execute: false,
    confirmToken: '',
    forceInclude: [],
    async: false,
    week: false,
    stuck: false,
    blastSha: '',
    revertPr: false,
    stagingCommand: '',
    prodCommand: '',
    stagingScript: '',
    prodScript: '',
    requireStagingSmoke: '',
    generatedSummaryPath: '',
    criticalPaths: [],
    criticalPathCoverage: '',
    refresh: false,
    baseUrl: '',
    smokeFeedback: [],
    scenarioFile: '',
    makeBlocking: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.startsWith('--') ? token.indexOf('=') : -1;
    const flagName = equalsIndex > 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex > 0 ? token.slice(equalsIndex + 1) : null;

    const readFlagValue = (flag: string): string => {
      if (inlineValue !== null) {
        if (!inlineValue.trim()) {
          throw new Error(`${flag} requires a non-empty value.`);
        }
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} requires a value.`);
      }
      index += 1;
      return next;
    };

    const rejectInlineValue = (flag: string): void => {
      if (inlineValue !== null) {
        throw new Error(`${flag} does not take a value.`);
      }
    };

    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }

    // Doctor supports these historical flag-shaped mode selectors. Keep them
    // as positional mode tokens so handleDoctor can preserve both
    // `doctor probe` and `doctor --probe`; validation below makes them legal
    // only for the doctor command instead of silently leaking into others.
    if (token === '--probe' || token === '--fix' || token === '--diagnose' || token === '--check-guard') {
      positional.push(token);
      continue;
    }

    if (flagName === '--apply') {
      rejectInlineValue('--apply');
      flags.apply = true;
      continue;
    }

    if (flagName === '--all-stale') {
      rejectInlineValue('--all-stale');
      flags.allStale = true;
      continue;
    }

    if (flagName === '--force') {
      rejectInlineValue('--force');
      flags.force = true;
      continue;
    }

    if (flagName === '--json') {
      rejectInlineValue('--json');
      flags.json = true;
      continue;
    }

    if (flagName === '--offline') {
      rejectInlineValue('--offline');
      flags.offline = true;
      continue;
    }

    if (flagName === '--override') {
      rejectInlineValue('--override');
      flags.override = true;
      continue;
    }

    if (flagName === '--skip-smoke-coverage') {
      rejectInlineValue('--skip-smoke-coverage');
      flags.skipSmokeCoverage = true;
      continue;
    }

    if (flagName === '--patch') {
      rejectInlineValue('--patch');
      flags.patch = true;
      continue;
    }

    if (flagName === '--reason') {
      flags.reason = readFlagValue('--reason');
      continue;
    }

    if (flagName === '--task') {
      flags.task = readFlagValue('--task');
      continue;
    }

    if (flagName === '--branch') {
      flags.branch = readFlagValue('--branch');
      continue;
    }

    if (flagName === '--file') {
      flags.file = readFlagValue('--file');
      continue;
    }

    if (flagName === '--title') {
      flags.title = readFlagValue('--title');
      continue;
    }

    if (flagName === '--message') {
      flags.message = readFlagValue('--message');
      continue;
    }

    if (flagName === '--recover') {
      flags.recover = readFlagValue('--recover');
      continue;
    }

    if (flagName === '--binding-fingerprint') {
      flags.bindingFingerprint = readFlagValue('--binding-fingerprint');
      continue;
    }

    if (flagName === '--sha') {
      flags.sha = readFlagValue('--sha');
      continue;
    }

    if (flagName === '--pr') {
      flags.pr = readFlagValue('--pr');
      continue;
    }

    if (flagName === '--mode') {
      flags.mode = readFlagValue('--mode');
      continue;
    }

    if (flagName === '--scope') {
      flags.scope = readFlagValue('--scope');
      continue;
    }

    if (flagName === '--execute') {
      rejectInlineValue('--execute');
      flags.execute = true;
      continue;
    }

    if (flagName === '--confirm-token') {
      flags.confirmToken = readFlagValue('--confirm-token');
      continue;
    }

    if (flagName === '--force-include') {
      const raw = readFlagValue('--force-include');
      flags.forceInclude.push(...raw.split(',').map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (flagName === '--async') {
      rejectInlineValue('--async');
      flags.async = true;
      continue;
    }

    if (flagName === '--surfaces') {
      const raw = readFlagValue('--surfaces');
      flags.surfaces.push(...raw.split(',').map((item) => item.trim()).filter(Boolean));
      continue;
    }

    if (flagName === '--week') {
      rejectInlineValue('--week');
      flags.week = true;
      continue;
    }

    if (flagName === '--stuck') {
      rejectInlineValue('--stuck');
      flags.stuck = true;
      continue;
    }

    if (flagName === '--blast') {
      try {
        flags.blastSha = readFlagValue('--blast');
      } catch {
        throw new Error('--blast requires a commit sha or rev-parseable ref as the next argument.');
      }
      continue;
    }

    if (flagName === '--revert-pr') {
      rejectInlineValue('--revert-pr');
      flags.revertPr = true;
      continue;
    }

    // smoke setup flags. Shell command values (staging / prod command) and
    // path values pass through readFlagValue which preserves embedded
    // spaces, quotes, and metacharacters intact — parser test covers this.
    if (flagName === '--staging-command') {
      flags.stagingCommand = readFlagValue('--staging-command');
      continue;
    }
    if (flagName === '--prod-command') {
      flags.prodCommand = readFlagValue('--prod-command');
      continue;
    }
    if (flagName === '--staging-script') {
      flags.stagingScript = readFlagValue('--staging-script');
      continue;
    }
    if (flagName === '--prod-script') {
      flags.prodScript = readFlagValue('--prod-script');
      continue;
    }
    if (flagName === '--require-staging-smoke') {
      const raw = readFlagValue('--require-staging-smoke').trim();
      if (raw !== 'true' && raw !== 'false') {
        throw new Error(`--require-staging-smoke must be "true" or "false", got "${raw}".`);
      }
      flags.requireStagingSmoke = raw;
      continue;
    }
    if (flagName === '--generated-summary-path') {
      flags.generatedSummaryPath = readFlagValue('--generated-summary-path');
      continue;
    }
    if (flagName === '--critical-path') {
      // Repeatable. Preserve first-seen order while deduping so operators
      // listing "--critical-path=auth --critical-path=checkout --critical-path=auth"
      // get ['auth', 'checkout'].
      const value = readFlagValue('--critical-path').trim();
      if (value.length > 0 && !flags.criticalPaths.includes(value)) {
        flags.criticalPaths.push(value);
      }
      continue;
    }
    if (flagName === '--critical-path-coverage') {
      const raw = readFlagValue('--critical-path-coverage').trim();
      if (raw !== 'warn' && raw !== 'block') {
        throw new Error(`--critical-path-coverage must be "warn" or "block", got "${raw}".`);
      }
      flags.criticalPathCoverage = raw;
      continue;
    }
    if (flagName === '--refresh') {
      rejectInlineValue('--refresh');
      flags.refresh = true;
      continue;
    }
    if (flagName === '--base-url') {
      flags.baseUrl = readFlagValue('--base-url').trim();
      continue;
    }
    if (flagName === '--feedback') {
      const value = readFlagValue('--feedback').trim();
      if (value.length > 0) flags.smokeFeedback.push(value);
      continue;
    }
    if (flagName === '--scenario-file') {
      flags.scenarioFile = readFlagValue('--scenario-file').trim();
      continue;
    }
    if (flagName === '--make-blocking') {
      rejectInlineValue('--make-blocking');
      flags.makeBlocking = true;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown flag "${flagName}" for pipelane run. Run "pipelane run --help" for supported commands and flags.`);
    }

    positional.push(token);
  }

  return {
    command: positional[0] ?? '',
    positional: positional.slice(1),
    flags,
  };
}

export function validateOperatorArgs(parsed: ParsedOperatorArgs): void {
  if (!parsed.command || parsed.command === '--help' || parsed.command === '-h' || parsed.flags.help) {
    return;
  }

  const failUnexpected = (usage: string): never => {
    const rendered = parsed.positional.length > 0 ? ` "${parsed.positional.join(' ')}"` : '';
    throw new Error(`${parsed.command} does not accept positional argument(s)${rendered}.\nUsage: ${usage}`);
  };

  const requireNoPositional = (usage: string): void => {
    if (parsed.positional.length > 0) failUnexpected(usage);
  };
  const requirePositivePrNumber = (): void => {
    const pr = parsed.flags.pr.trim();
    if (!pr) return;
    if (!/^[1-9]\d*$/.test(pr)) {
      throw new Error('--pr requires a positive PR number.');
    }
    const parsedPr = Number.parseInt(pr, 10);
    if (!Number.isSafeInteger(parsedPr)) {
      throw new Error('--pr requires a safe positive PR number.');
    }
  };

  switch (parsed.command) {
    case 'devmode': {
      if (parsed.positional.length > 1) failUnexpected('pipelane run devmode [status|build|release] [--surfaces <csv>] [--override --reason <text>]');
      const action = parsed.positional[0] ?? 'status';
      if (action && action !== 'status' && action !== 'build' && action !== 'release') {
        throw new Error(`Unknown devmode action "${action}". Supported actions: status, build, release.`);
      }
      if (action === 'status') {
        assertOnlyFlags(parsed, []);
      } else if (action === 'build') {
        assertOnlyFlags(parsed, ['surfaces']);
      } else {
        assertOnlyFlags(parsed, ['surfaces', 'override', 'reason']);
      }
      if (parsed.flags.reason && !parsed.flags.override) {
        throw new Error('devmode only accepts --reason together with --override.');
      }
      return;
    }
    case 'new':
      assertOnlyFlags(parsed, ['task', 'surfaces', 'offline']);
      requireNoPositional('pipelane run new [--task <task-name>] [--surfaces <csv>] [--offline]');
      return;
    case 'resume':
      assertOnlyFlags(parsed, ['task']);
      requireNoPositional('pipelane run resume [--task <task-name>]');
      return;
    case 'repo-guard':
      assertOnlyFlags(parsed, ['task', 'mode', 'surfaces', 'offline']);
      requireNoPositional('pipelane run repo-guard --task <task-name> [--mode build|release] [--surfaces <csv>] [--offline]');
      return;
    case 'pr':
      assertOnlyFlags(parsed, ['task', 'title', 'message', 'forceInclude', 'recover', 'bindingFingerprint']);
      requireNoPositional('pipelane run pr [--task <task-name>] [--title <title>] [--message <message>] [--force-include <path>]');
      return;
    case 'merge':
      assertOnlyFlags(parsed, ['task', 'pr']);
      requirePositivePrNumber();
      if (parsed.flags.task.trim() && parsed.flags.pr.trim()) {
        throw new Error('merge cannot combine --task and --pr; choose one PR/task identity.');
      }
      requireNoPositional('pipelane run merge [--task <task-name> | --pr <number>]');
      return;
    case 'release-check':
      assertOnlyFlags(parsed, ['surfaces']);
      requireNoPositional('pipelane run release-check [--surfaces <csv>]');
      return;
    case 'task-lock':
      assertOnlyFlags(parsed, ['task', 'mode']);
      if (parsed.positional.length !== 1 || parsed.positional[0] !== 'verify') {
        throw new Error('task-lock requires exactly: pipelane run task-lock verify --task <task-name> [--mode build|release]');
      }
      return;
    case 'deploy':
      assertOnlyFlags(parsed, ['task', 'pr', 'sha', 'surfaces', 'async', 'skipSmokeCoverage', 'reason']);
      requirePositivePrNumber();
      if (parsed.positional.length === 0) {
        throw new Error('deploy requires an environment: staging or prod.');
      }
      if (parsed.positional[0] !== 'staging' && parsed.positional[0] !== 'prod' && parsed.positional[0] !== 'production') {
        throw new Error('deploy requires an environment: staging or prod.');
      }
      if (parsed.flags.reason && !parsed.flags.skipSmokeCoverage) {
        throw new Error('deploy only accepts --reason together with --skip-smoke-coverage.');
      }
      if (parsed.flags.task.trim() && parsed.flags.pr.trim()) {
        throw new Error('deploy cannot combine --task and --pr; choose one PR/task identity.');
      }
      if (parsed.flags.pr.trim() && parsed.flags.sha.trim()) {
        throw new Error('deploy cannot combine --pr and --sha; --pr deploys the PR merge commit.');
      }
      if (parsed.flags.skipSmokeCoverage && parsed.positional[0] === 'staging') {
        throw new Error('--skip-smoke-coverage only applies to production deploys.');
      }
      return;
    case 'smoke': {
      const [subcommand] = parsed.positional;
      if (!subcommand) {
        assertOnlyFlags(parsed, []);
        return;
      }
      if (subcommand === 'setup') {
        // Only setup accepts the setup flags. Other subcommands below still
        // fall into assertOnlyFlags with their own allowlist so a stray
        // --staging-command on `smoke plan` raises "Unexpected flag".
        assertOnlyFlags(parsed, [
          'stagingCommand',
          'prodCommand',
          'stagingScript',
          'prodScript',
          'requireStagingSmoke',
          'generatedSummaryPath',
          'criticalPaths',
          'criticalPathCoverage',
          'baseUrl',
          'smokeFeedback',
          'scenarioFile',
          'makeBlocking',
        ]);
        // Script and full-command forms are mutually exclusive — passing
        // both leaves the operator's intent ambiguous. Reject with both
        // flag names so the error message tells them what to drop.
        if (parsed.flags.stagingScript.trim() && parsed.flags.stagingCommand.trim()) {
          throw new Error('smoke setup: --staging-script and --staging-command are mutually exclusive — pass one.');
        }
        if (parsed.flags.prodScript.trim() && parsed.flags.prodCommand.trim()) {
          throw new Error('smoke setup: --prod-script and --prod-command are mutually exclusive — pass one.');
        }
        if (parsed.positional.length > 1) failUnexpected('pipelane run smoke setup [--staging-script <name> | --staging-command <cmd>] [--prod-script <name> | --prod-command <cmd>] [--require-staging-smoke <true|false>] [--generated-summary-path <path>] [--critical-path <path>]... [--critical-path-coverage <warn|block>] [--feedback <text>] [--scenario-file <path>] [--base-url <url>] [--make-blocking]');
        return;
      }
      if (subcommand === 'plan') {
        assertOnlyFlags(parsed, ['refresh', 'smokeFeedback', 'scenarioFile']);
        if (parsed.flags.reason) {
          throw new Error('smoke plan does not accept --reason.');
        }
        if (!parsed.flags.refresh && (parsed.flags.smokeFeedback.length > 0 || parsed.flags.scenarioFile.trim().length > 0)) {
          throw new Error('smoke plan only accepts --feedback or --scenario-file together with --refresh.');
        }
        if (parsed.positional.length > 1) failUnexpected('pipelane run smoke plan [--refresh] [--feedback <text>] [--scenario-file <path>]');
        return;
      }
      assertOnlyFlags(parsed, ['reason']);
      if (subcommand === 'staging' || subcommand === 'prod') {
        if (parsed.flags.reason) {
          throw new Error(`smoke ${subcommand} does not accept --reason.`);
        }
        if (parsed.positional.length > 1) failUnexpected('pipelane run smoke <staging|prod>');
        return;
      }
      if (subcommand === 'waiver') {
        if (parsed.positional.length !== 4) {
          throw new Error('Usage: pipelane run smoke waiver <create|extend> <@smoke-tag> <staging|prod> --reason <text>');
        }
        return;
      }
      if (subcommand === 'quarantine' || subcommand === 'unquarantine') {
        if (subcommand === 'unquarantine' && parsed.flags.reason) {
          throw new Error('smoke unquarantine does not accept --reason.');
        }
        if (parsed.positional.length !== 2) {
          throw new Error(`Usage: pipelane run smoke ${subcommand} <@smoke-tag> [--reason <text>]`);
        }
        return;
      }
      throw new Error('smoke requires one of: plan, setup, staging, prod, waiver, quarantine, unquarantine.');
    }
    case 'clean':
      assertOnlyFlags(parsed, ['apply', 'allStale', 'task', 'force']);
      if (!parsed.flags.apply && (parsed.flags.allStale || parsed.flags.task.trim() || parsed.flags.force)) {
        throw new Error('clean only accepts --task, --all-stale, or --force when --apply is also passed.');
      }
      if (parsed.flags.force && !parsed.flags.task.trim()) {
        throw new Error('clean --force is only valid with --task <task-name>; --all-stale is metadata-only.');
      }
      requireNoPositional('pipelane run clean [--apply (--task <task-name> [--force]|--all-stale)]');
      return;
    case 'status':
      assertOnlyFlags(parsed, ['week', 'stuck', 'blastSha']);
      requireNoPositional('pipelane run status [--week|--stuck|--blast <sha>] [--json]');
      return;
    case 'doctor': {
      assertOnlyFlags(parsed, ['apply']);
      if (parsed.positional.length > 1) failUnexpected('pipelane run doctor [diagnose|probe|fix|check-guard|--diagnose|--probe|--fix|--check-guard]');
      const mode = parsed.positional[0];
      if (
        mode
        && mode !== 'diagnose'
        && mode !== 'probe'
        && mode !== 'fix'
        && mode !== 'check-guard'
        && mode !== '--diagnose'
        && mode !== '--probe'
        && mode !== '--fix'
        && mode !== '--check-guard'
      ) {
        throw new Error(`Unknown doctor mode "${mode}". Supported modes: diagnose, probe, fix, check-guard.`);
      }
      return;
    }
    case 'rollback':
      assertOnlyFlags(parsed, ['task', 'surfaces', 'async', 'revertPr', 'sha']);
      if (parsed.positional.length === 0) {
        throw new Error('rollback requires an environment: staging or prod.');
      }
      if (parsed.positional[0] !== 'staging' && parsed.positional[0] !== 'prod' && parsed.positional[0] !== 'production') {
        throw new Error('rollback requires an environment: staging or prod.');
      }
      if (parsed.flags.revertPr && parsed.positional.length > 1) {
        throw new Error('--revert-pr does not accept surface positional arguments; it opens a revert PR for the resolved merge commit.');
      }
      if (parsed.flags.revertPr && parsed.flags.surfaces.length > 0) {
        throw new Error('--revert-pr does not accept --surfaces; it opens a revert PR for the resolved merge commit.');
      }
      if (parsed.flags.revertPr && parsed.flags.async) {
        throw new Error('--revert-pr cannot be combined with --async; it opens a PR and does not dispatch a deploy.');
      }
      if (parsed.flags.sha && !parsed.flags.revertPr) {
        throw new Error('/rollback only accepts --sha with --revert-pr. The redeploy rollback path selects the last verified-good DeployRecord automatically.');
      }
      return;
    case 'api': {
      const [subcommand] = parsed.positional;
      if (!subcommand || subcommand === 'snapshot') {
        assertOnlyFlags(parsed, []);
        if (parsed.positional.length > 1) failUnexpected('pipelane run api snapshot');
        return;
      }
      if (subcommand === 'branch') {
        assertOnlyFlags(parsed, ['branch', 'file', 'patch', 'scope']);
        if (parsed.positional.length > 1) failUnexpected('pipelane run api branch --branch <branch> [--patch --file <path>]');
        return;
      }
      if (subcommand === 'action') {
        assertOnlyFlags(parsed, [
          'task',
          'offline',
          'surfaces',
          'override',
          'reason',
          'mode',
          'title',
          'message',
          'pr',
          'recover',
          'bindingFingerprint',
          'sha',
          'skipSmokeCoverage',
          'allStale',
          'execute',
          'confirmToken',
        ]);
        if (parsed.positional.length !== 2) {
          throw new Error('api action requires exactly: pipelane run api action <action-id> [--execute] [--confirm-token <token>]');
        }
        requirePositivePrNumber();
        const actionId = parsed.positional[1] ?? '';
        if (
          (actionId === 'merge' || actionId === 'deploy.staging' || actionId === 'deploy.prod')
          && parsed.flags.task.trim()
          && parsed.flags.pr.trim()
        ) {
          throw new Error(`${actionId} cannot combine --task and --pr; choose one PR/task identity.`);
        }
        if (
          (actionId === 'deploy.staging' || actionId === 'deploy.prod')
          && parsed.flags.pr.trim()
          && parsed.flags.sha.trim()
        ) {
          throw new Error(`${actionId} cannot combine --pr and --sha; --pr deploys the PR merge commit.`);
        }
        return;
      }
      throw new Error('Unknown api subcommand. Supported: snapshot, branch, action.');
    }
    default:
      return;
  }
}

type OperatorFlagKey = keyof OperatorFlags;

const FLAG_RENDERERS: Array<{ key: OperatorFlagKey; label: string; active: (flags: OperatorFlags) => boolean }> = [
  { key: 'apply', label: '--apply', active: (flags) => flags.apply },
  { key: 'allStale', label: '--all-stale', active: (flags) => flags.allStale },
  { key: 'force', label: '--force', active: (flags) => flags.force },
  { key: 'offline', label: '--offline', active: (flags) => flags.offline },
  { key: 'override', label: '--override', active: (flags) => flags.override },
  { key: 'skipSmokeCoverage', label: '--skip-smoke-coverage', active: (flags) => flags.skipSmokeCoverage },
  { key: 'patch', label: '--patch', active: (flags) => flags.patch },
  { key: 'reason', label: '--reason', active: (flags) => flags.reason.trim().length > 0 },
  { key: 'sha', label: '--sha', active: (flags) => flags.sha.trim().length > 0 },
  { key: 'pr', label: '--pr', active: (flags) => flags.pr.trim().length > 0 },
  { key: 'task', label: '--task', active: (flags) => flags.task.trim().length > 0 },
  { key: 'branch', label: '--branch', active: (flags) => flags.branch.trim().length > 0 },
  { key: 'file', label: '--file', active: (flags) => flags.file.trim().length > 0 },
  { key: 'title', label: '--title', active: (flags) => flags.title.trim().length > 0 },
  { key: 'message', label: '--message', active: (flags) => flags.message.trim().length > 0 },
  { key: 'recover', label: '--recover', active: (flags) => flags.recover.trim().length > 0 },
  { key: 'bindingFingerprint', label: '--binding-fingerprint', active: (flags) => flags.bindingFingerprint.trim().length > 0 },
  { key: 'mode', label: '--mode', active: (flags) => flags.mode.trim().length > 0 },
  { key: 'scope', label: '--scope', active: (flags) => flags.scope.trim().length > 0 },
  { key: 'surfaces', label: '--surfaces', active: (flags) => flags.surfaces.length > 0 },
  { key: 'execute', label: '--execute', active: (flags) => flags.execute },
  { key: 'confirmToken', label: '--confirm-token', active: (flags) => flags.confirmToken.trim().length > 0 },
  { key: 'forceInclude', label: '--force-include', active: (flags) => flags.forceInclude.length > 0 },
  { key: 'async', label: '--async', active: (flags) => flags.async },
  { key: 'week', label: '--week', active: (flags) => flags.week },
  { key: 'stuck', label: '--stuck', active: (flags) => flags.stuck },
  { key: 'blastSha', label: '--blast', active: (flags) => flags.blastSha.trim().length > 0 },
  { key: 'revertPr', label: '--revert-pr', active: (flags) => flags.revertPr },
  { key: 'stagingCommand', label: '--staging-command', active: (flags) => flags.stagingCommand.trim().length > 0 },
  { key: 'prodCommand', label: '--prod-command', active: (flags) => flags.prodCommand.trim().length > 0 },
  { key: 'stagingScript', label: '--staging-script', active: (flags) => flags.stagingScript.trim().length > 0 },
  { key: 'prodScript', label: '--prod-script', active: (flags) => flags.prodScript.trim().length > 0 },
  { key: 'requireStagingSmoke', label: '--require-staging-smoke', active: (flags) => flags.requireStagingSmoke.length > 0 },
  { key: 'generatedSummaryPath', label: '--generated-summary-path', active: (flags) => flags.generatedSummaryPath.trim().length > 0 },
  { key: 'criticalPaths', label: '--critical-path', active: (flags) => flags.criticalPaths.length > 0 },
  { key: 'criticalPathCoverage', label: '--critical-path-coverage', active: (flags) => flags.criticalPathCoverage.length > 0 },
  { key: 'refresh', label: '--refresh', active: (flags) => flags.refresh },
  { key: 'baseUrl', label: '--base-url', active: (flags) => flags.baseUrl.trim().length > 0 },
  { key: 'smokeFeedback', label: '--feedback', active: (flags) => flags.smokeFeedback.length > 0 },
  { key: 'scenarioFile', label: '--scenario-file', active: (flags) => flags.scenarioFile.trim().length > 0 },
  { key: 'makeBlocking', label: '--make-blocking', active: (flags) => flags.makeBlocking },
];

function assertOnlyFlags(parsed: ParsedOperatorArgs, allowed: OperatorFlagKey[]): void {
  const allowedSet = new Set<OperatorFlagKey>(['json', 'help', ...allowed]);
  const unexpected = FLAG_RENDERERS
    .filter((entry) => !allowedSet.has(entry.key) && entry.active(parsed.flags))
    .map((entry) => entry.label);
  if (unexpected.length === 0) return;
  throw new Error(`${parsed.command} does not accept flag(s): ${unexpected.join(', ')}.`);
}

export function parseSurfaceList(config: WorkflowConfig, values: string[]): string[] {
  const requested = [...new Set(values.flatMap((value) => value.split(',').map((item) => item.trim()).filter(Boolean)))];

  for (const surface of requested) {
    if (!config.surfaces.includes(surface)) {
      throw new Error(`Unsupported surface "${surface}". Supported surfaces: ${config.surfaces.join(', ')}`);
    }
  }

  return requested.length > 0 ? requested : [...config.surfaces];
}

export function homeCodexDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function homeClaudeDir(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}
