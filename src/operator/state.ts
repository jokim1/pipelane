import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Mode = 'build' | 'release';
export type KnownSurface = 'frontend' | 'edge' | 'sql';
export const WORKFLOW_COMMANDS = ['devmode', 'new', 'resume', 'pr', 'merge', 'deploy', 'clean', 'status', 'doctor'] as const;
export type WorkflowCommand = (typeof WORKFLOW_COMMANDS)[number];
export const DEFAULT_WORKFLOW_ALIASES: Record<WorkflowCommand, string> = {
  devmode: '/devmode',
  new: '/new',
  resume: '/resume',
  pr: '/pr',
  merge: '/merge',
  deploy: '/deploy',
  clean: '/clean',
  status: '/status',
  doctor: '/doctor',
};

// Managed Claude command files that aren't workflow operator actions. These
// still ship with `<!-- workflow-kit:command:<name> -->` markers, flow through
// the collision / prune / consumer-extension machinery, but are not aliased
// (filename is fixed) and are not dispatched via `pipelane run <name>`.
export const MANAGED_EXTRA_COMMANDS = ['pipelane'] as const;
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
}

// Per-surface opt-out flags for `pipelane setup` / `pipelane sync-docs`.
// Absent or undefined means "sync this surface" (default true). Consumers
// that want partial regeneration (e.g. commands regen but NO marker
// injection into README/AGENTS/CONTRIBUTING) set the surfaces they want
// skipped to false.
export interface SyncDocsConfig {
  claudeCommands?: boolean;
  readmeSection?: boolean;
  contributingSection?: boolean;
  agentsSection?: boolean;
  docsReleaseWorkflow?: boolean;
  workflowClaudeTemplate?: boolean;
  packageScripts?: boolean;
}

export const DEFAULT_SYNC_DOCS: Required<SyncDocsConfig> = {
  claudeCommands: true,
  readmeSection: true,
  contributingSection: true,
  agentsSection: true,
  docsReleaseWorkflow: true,
  workflowClaudeTemplate: true,
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
// pre-commit hooks. Override in .project-workflow.json when a repo legit
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

export type DeployStatus = 'requested' | 'succeeded' | 'failed' | 'unknown';

export interface DeployVerification {
  healthcheckUrl?: string;
  statusCode?: number;
  latencyMs?: number;
  probes?: number;
  error?: string;
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
  // v1.2 (optional): HMAC-SHA256 over canonical record fields using the key
  // at env PIPELANE_DEPLOY_STATE_KEY. Unsigned records are accepted when no
  // key is configured; when a key IS configured, unsigned + invalid-sig
  // records are rejected on load. Defense-in-depth against fs-forged records.
  signature?: string;
  rollbackOfSha?: string;
  idempotencyKey?: string;
  triggeredBy?: string;
  failureReason?: string;
}

export interface OperatorFlags {
  apply: boolean;
  allStale: boolean;
  json: boolean;
  offline: boolean;
  override: boolean;
  reason: string;
  sha: string;
  task: string;
  title: string;
  message: string;
  mode: string;
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
export const CONFIG_FILENAME = '.project-workflow.json';
const MODE_STATE_FILENAME = 'mode-state.json';
const PR_STATE_FILENAME = 'pr-state.json';
const DEPLOY_STATE_FILENAME = 'deploy-state.json';
const PROBE_STATE_FILENAME = 'probe-state.json';
const TASK_LOCKS_DIRNAME = 'task-locks';

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
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error?: string;
  probedAt: string;
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
    stateDir: 'workflow-kit-state',
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
  execFileSync('sh', ['-lc', command], {
    cwd,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
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

export function loadWorkflowConfig(repoRoot: string): WorkflowConfig {
  const configPath = resolveConfigPath(repoRoot);

  if (!existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${repoRoot}. Run workflow-kit init first.`);
  }

  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<WorkflowConfig>;
  return normalizeWorkflowConfig(parsed);
}

export function normalizeWorkflowConfig(raw: Partial<WorkflowConfig>): WorkflowConfig {
  return {
    ...(raw as WorkflowConfig),
    branchPrefix: normalizeBranchPrefix(raw.branchPrefix ?? DEFAULT_BRANCH_PREFIX),
    legacyBranchPrefixes: (raw.legacyBranchPrefixes ?? []).map(normalizeBranchPrefix),
    prPathDenyList: raw.prPathDenyList ?? [...DEFAULT_PR_PATH_DENY_LIST],
    aliases: resolveWorkflowAliases(raw.aliases),
    checks: normalizeChecksConfig(raw.checks),
    syncDocs: normalizeSyncDocsConfig(raw.syncDocs),
    surfacePathMap: normalizeSurfacePathMap(raw.surfacePathMap),
  };
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
    'readmeSection',
    'contributingSection',
    'agentsSection',
    'docsReleaseWorkflow',
    'workflowClaudeTemplate',
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

function normalizeBranchPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return DEFAULT_BRANCH_PREFIX;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function writeWorkflowConfig(repoRoot: string, config: WorkflowConfig): void {
  writeJsonFile(resolveConfigPath(repoRoot), {
    ...config,
    aliases: resolveWorkflowAliases(config.aliases),
  });
}

export function resolveStateDir(commonDir: string, config: WorkflowConfig): string {
  return path.join(commonDir, config.stateDir);
}

export function ensureStateDir(commonDir: string, config: WorkflowConfig): string {
  const stateDir = resolveStateDir(commonDir, config);
  mkdirSync(path.join(stateDir, TASK_LOCKS_DIRNAME), { recursive: true });
  return stateDir;
}

export function modeStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), MODE_STATE_FILENAME);
}

export function deployStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), DEPLOY_STATE_FILENAME);
}

export function prStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), PR_STATE_FILENAME);
}

export function probeStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), PROBE_STATE_FILENAME);
}

export function loadProbeState(commonDir: string, config: WorkflowConfig): ProbeState {
  const raw = readJsonFile<ProbeState>(probeStatePath(commonDir, config), { records: [] as ProbeRecord[], updatedAt: '' });
  return normalizeProbeState(raw);
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
      ok: record.ok,
      statusCode,
      latencyMs,
      error: typeof record.error === 'string' ? record.error : undefined,
      probedAt: record.probedAt,
    });
  }
  return { records: valid, updatedAt };
}

export function saveProbeState(commonDir: string, config: WorkflowConfig, value: ProbeState): void {
  ensureStateDir(commonDir, config);
  writeJsonFile(probeStatePath(commonDir, config), value);
}

export function taskLockPath(commonDir: string, config: WorkflowConfig, taskSlug: string): string {
  return path.join(resolveStateDir(commonDir, config), TASK_LOCKS_DIRNAME, `${taskSlug}.json`);
}

export function readJsonFile<T>(targetPath: string, fallback: T): T {
  if (!existsSync(targetPath)) {
    return fallback;
  }

  return JSON.parse(readFileSync(targetPath, 'utf8')) as T;
}

export function writeJsonFile(targetPath: string, value: unknown): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function loadModeState(commonDir: string, config: WorkflowConfig): ModeState {
  const raw = readJsonFile<ModeState>(modeStatePath(commonDir, config), {
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
  writeJsonFile(modeStatePath(commonDir, config), value);
}

export function loadDeployState(commonDir: string, config: WorkflowConfig): { records: DeployRecord[] } {
  return readJsonFile(deployStatePath(commonDir, config), { records: [] as DeployRecord[] });
}

export function saveDeployState(commonDir: string, config: WorkflowConfig, value: { records: DeployRecord[] }): void {
  ensureStateDir(commonDir, config);
  writeJsonFile(deployStatePath(commonDir, config), value);
}

export function loadPrState(commonDir: string, config: WorkflowConfig): { records: Record<string, PrRecord> } {
  return readJsonFile(prStatePath(commonDir, config), { records: {} as Record<string, PrRecord> });
}

export function savePrState(commonDir: string, config: WorkflowConfig, value: { records: Record<string, PrRecord> }): void {
  ensureStateDir(commonDir, config);
  writeJsonFile(prStatePath(commonDir, config), value);
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
  return readJsonFile(taskLockPath(commonDir, config, taskSlug), null);
}

export function saveTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string, value: TaskLock): TaskLock {
  ensureStateDir(commonDir, config);
  writeJsonFile(taskLockPath(commonDir, config, taskSlug), value);
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
      return JSON.parse(readFileSync(targetPath, 'utf8')) as TaskLock;
    })
    .sort((left, right) => left.taskSlug.localeCompare(right.taskSlug));
}

export function surfaceSetKey(values: string[]): string {
  return [...new Set(values.filter(Boolean))].sort().join(',');
}

export function resolveWorkflowContext(cwd: string): WorkflowContext {
  const repoRoot = resolveRepoRoot(cwd);
  const config = loadWorkflowConfig(repoRoot);
  const commonDir = resolveGitCommonDir(repoRoot);
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

export function aliasCommandName(alias: string): string {
  return normalizeWorkflowAlias(alias, alias).slice(1);
}

export function parseOperatorArgs(argv: string[]): ParsedOperatorArgs {
  const positional: string[] = [];
  const flags: OperatorFlags = {
    apply: false,
    allStale: false,
    json: false,
    offline: false,
    override: false,
    reason: '',
    sha: '',
    task: '',
    title: '',
    message: '',
    mode: '',
    surfaces: [],
    execute: false,
    confirmToken: '',
    forceInclude: [],
    async: false,
    week: false,
    stuck: false,
    blastSha: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--apply') {
      flags.apply = true;
      continue;
    }

    if (token === '--all-stale') {
      flags.allStale = true;
      continue;
    }

    if (token === '--json') {
      flags.json = true;
      continue;
    }

    if (token === '--offline') {
      flags.offline = true;
      continue;
    }

    if (token === '--override') {
      flags.override = true;
      continue;
    }

    if (token === '--reason') {
      flags.reason = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--task') {
      flags.task = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--title') {
      flags.title = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--message') {
      flags.message = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--sha') {
      flags.sha = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--mode') {
      flags.mode = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--execute') {
      flags.execute = true;
      continue;
    }

    if (token === '--confirm-token') {
      flags.confirmToken = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (token === '--force-include') {
      const raw = argv[index + 1] ?? '';
      flags.forceInclude.push(...raw.split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }

    if (token === '--async') {
      flags.async = true;
      continue;
    }

    if (token === '--surfaces') {
      const raw = argv[index + 1] ?? '';
      flags.surfaces.push(...raw.split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }

    if (token === '--week') {
      flags.week = true;
      continue;
    }

    if (token === '--stuck') {
      flags.stuck = true;
      continue;
    }

    if (token === '--blast') {
      const next = argv[index + 1];
      // Reject a flag-shaped next token so `/status --blast --json`
      // doesn't silently swallow `--json` as the sha and fall through to
      // rev-parse. Value-taking flags elsewhere in this parser are
      // looser for historical reasons; scoping this guard to --blast
      // avoids regressing existing call sites.
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--blast requires a commit sha or rev-parseable ref as the next argument.');
      }
      flags.blastSha = next;
      index += 1;
      continue;
    }

    positional.push(token);
  }

  return {
    command: positional[0] ?? '',
    positional: positional.slice(1),
    flags,
  };
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
