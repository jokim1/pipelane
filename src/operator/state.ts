import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeUrlFingerprint, resolveProbeStateKey, resolveReviewConsentStateKey, resolveReviewStateKey, signSignedPayload, verifySignedPayload } from './integrity.ts';
import { buildDefaultReviewGatesConfig } from './review-gates.ts';

export type Mode = 'build' | 'release';
export type KnownSurface = 'frontend' | 'edge' | 'sql';
export const WORKFLOW_COMMANDS = ['devmode', 'new', 'adopt', 'resume', 'repo-guard', 'pr', 'merge', 'release', 'release-check', 'deploy', 'clean', 'status', 'doctor', 'rollback'] as const;
export type WorkflowCommand = (typeof WORKFLOW_COMMANDS)[number];
export const MANAGED_WORKFLOW_COMMANDS = ['devmode', 'new', 'adopt', 'resume', 'repo-guard', 'pr', 'merge', 'release', 'deploy', 'clean', 'status', 'doctor', 'rollback'] as const;
export type ManagedWorkflowCommand = (typeof MANAGED_WORKFLOW_COMMANDS)[number];
export const DEFAULT_WORKFLOW_ALIASES: Record<WorkflowCommand, string> = {
  devmode: '/devmode',
  new: '/new',
  adopt: '/adopt',
  resume: '/resume',
  'repo-guard': '/repo-guard',
  pr: '/pr',
  merge: '/merge',
  release: '/release',
  'release-check': '/release-check',
  deploy: '/deploy',
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
export const MANAGED_COMMANDS = [...MANAGED_WORKFLOW_COMMANDS, ...MANAGED_EXTRA_COMMANDS] as const;
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

export type ReviewPlanGatePhase = 'plan';
export type ReviewGatePhase = 'static' | 'behavioral' | 'ai-diff' | 'instruction' | 'runtime' | 'human';
export type ReviewGateType = 'command' | 'skill' | 'agent' | 'approval' | 'pipelane';
export type ReviewProfile = 'docs-only' | 'implementation';
export type ReviewEnforcementMode = 'legacy-v2' | 'strict-v3';

export function isStableEvidenceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

export interface ReviewPlanGateConfig {
  id: string;
  phase: ReviewPlanGatePhase;
  type: Exclude<ReviewGateType, 'command' | 'pipelane'>;
  blocking?: boolean;
  skill?: string;
  role?: string;
  when?: string;
}

export interface ReviewGateConfig {
  id: string;
  phase: ReviewGatePhase;
  type: ReviewGateType;
  blocking?: boolean;
  command?: string;
  skill?: string;
  role?: string;
  when?: string;
  whenChanged?: string[];
  timeoutMs?: number;
  userCommands?: string[];
  profiles?: ReviewProfile[];
  baselineCommandId?: string;
  replacesBaselineCommandId?: string;
}

export interface ReviewGatesConfig {
  policyVersion?: number;
  enforcementMode?: ReviewEnforcementMode;
  planReview?: {
    gates?: ReviewPlanGateConfig[];
  };
  gates?: ReviewGateConfig[];
}

export type AcceptabilityClass = 'manual-review' | 'external-review' | 'policy-bypass';
export type GateDefinitionHash = string;
export type BypassPolicy = 'allowed-with-reason' | 'non-bypassable';

export interface BlockerCause {
  code: string;
  summary: string;
  evidence?: string[];
  remediation: string[];
  bypassPolicy: BypassPolicy;
}

export interface AcceptanceScope {
  gateId: string;
  gateDefinitionHash: GateDefinitionHash;
  acceptabilityClass: AcceptabilityClass;
  policyVersion: number;
  branchName: string;
  sha: string;
  worktreeStatusDigest: string;
  worktreeMaterialTreeHash: string;
}

export interface ReviewAcceptanceRecord extends AcceptanceScope {
  id: string;
  actor: ReviewActorIdentity;
  source: string;
  reason: string;
  reasonHash: string;
  recordedAt: string;
  signature?: string;
}

export interface ReviewAcceptanceState { records: ReviewAcceptanceRecord[]; }

export type ReviewConsentKind = 'gate-bypass' | 'accept-findings' | 'manual-substitution';
export type ReviewConsentGateState = ReviewGateRunStatus | 'missing' | 'unavailable' | 'malformed-protocol' | 'incomplete';

export interface ReviewConsentRecord {
  id: string;
  kind: ReviewConsentKind;
  gateId: string;
  gateDefinitionHash: GateDefinitionHash;
  policyVersion: number;
  enforcementMode: ReviewEnforcementMode;
  taskBindingId: string;
  reviewRunId?: string;
  originalGateState: ReviewConsentGateState;
  branchName: string;
  sha: string;
  worktreeStatusDigest: string;
  worktreeMaterialTreeHash: string;
  reviewTargetDigest: string;
  routeAction: string;
  actor: ReviewActorIdentity;
  source: string;
  reason: string;
  reasonHash: string;
  recordedAt: string;
  signature?: string;
}

export type OrchestrateGoalConfirmationMode = 'confirm' | 'auto' | 'off';
export const GOAL_PROVIDERS = ['codex', 'claude', 'generic'] as const;
export type GoalProvider = (typeof GOAL_PROVIDERS)[number];
export const DEFAULT_GOAL_PROVIDER: GoalProvider = 'codex';

export interface OrchestrateConfig {
  baseBranch?: string;
  maxConcurrentSlices?: number;
  goalMode?: {
    default?: OrchestrateGoalConfirmationMode;
    maxTurns?: number;
    maxMinutes?: number;
    requireConfirmationFor?: string[];
  };
  hardStops?: {
    maxIterationsPerSlice?: number;
    maxReviewLoops?: number;
    maxMinutesPerSlice?: number;
    // B2: stop a slice's review auto-fix once its canonical no-progress signature
    // repeats this many consecutive times (default 2). Guards against looping on a
    // fix that never changes the failure.
    maxStalledIterations?: number;
  };
}

export interface RouteSafetyConfig {
  defaultFixReviewLoops?: number;
  defaultMinutes?: number;
  defaultAiReviewRuns?: number;
  stopOnMajorFindings?: boolean;
}

export const DEFAULT_ROUTE_SAFETY: Required<RouteSafetyConfig> = {
  defaultFixReviewLoops: 1,
  defaultMinutes: 90,
  defaultAiReviewRuns: 1,
  stopOnMajorFindings: true,
};

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
  // Legacy field. Repo-local adapter generation is no longer supported; setup
  // resolves every sync surface to false even if older config still carries
  // these keys.
  syncDocs?: SyncDocsConfig;
  // v1.4: path-prefix map for `/status --blast <sha>`. Keys are surface
  // names (typically the entries in `surfaces`), values are POSIX
  // directory prefixes ("src/frontend/") or exact filenames matched
  // against `git diff --name-only` output. Empty / absent = all changes
  // land in the "other" bucket with a hint to configure the map.
  surfacePathMap?: Record<string, string[]>;
  reviewGates?: ReviewGatesConfig;
  routeSafety: RouteSafetyConfig;
  orchestrate?: OrchestrateConfig;
}

// Legacy per-surface flags. They are preserved while reading older configs,
// but repo-local adapter generation is no longer a supported setup path.
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
  claudeCommands: false,
  codexSkills: false,
  readmeSection: false,
  contributingSection: false,
  agentsSection: false,
  docsReleaseWorkflow: false,
  pipelaneClaudeTemplate: false,
  packageScripts: false,
};

export function resolveSyncDocs(_raw: SyncDocsConfig | undefined): Required<SyncDocsConfig> {
  // Repo-local adapter generation used to be configurable per surface. The
  // supported path is now machine-local only, so old truthy values must not
  // trigger writes into consumer repos.
  return { ...DEFAULT_SYNC_DOCS };
}

export const DEFAULT_BRANCH_PREFIX = 'codex/';

// Patterns matched against changed-file basenames during `pipelane run pr`
// before the silent `git add -A`. Keep this list short and unambiguous —
// the goal is "operator forgot to gitignore their secrets" not general
// pre-commit hooks. Override in machine-local Pipelane config when a repo legit
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
  taskBindingId?: string;
  taskBrief?: TaskBrief;
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
  // Timestamp for the nextAction breadcrumb itself. Older locks omit this;
  // readers fall back to updatedAt so the state format remains compatible.
  nextActionUpdatedAt?: string;
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

export interface TaskBrief {
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  source: 'new' | 'adopt' | 'first-review' | 'rebind';
  digest: string;
}

export const TASK_LOCK_STALE_MS = 72 * 60 * 60 * 1000;

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

export type StatusDecisionStatus = 'pending' | 'cancelled' | 'blocked' | 'executed' | 'failed';

export interface StatusDecisionRecord {
  id: string;
  actionId: string;
  label: string;
  status: StatusDecisionStatus;
  question: string;
  selectedOption: string;
  createdAt: string;
  answeredAt: string;
  actor: string;
  branchName: string;
  headSha: string;
  source: 'board' | 'branch' | 'orchestration';
  taskSlug?: string;
  runId?: string;
  sliceId?: string;
  preflightAllowed?: boolean;
  preflightReason?: string;
  executionExitCode?: number;
  executionMessage?: string;
  confirmationRequired?: boolean;
  normalizedInputs?: Record<string, unknown>;
}

export interface ActionState {
  records: Record<string, ActionRunRecord[]>;
  decisions?: StatusDecisionRecord[];
}

export type ReviewGateRunStatus = 'passed' | 'failed' | 'skipped' | 'pending';
export type ReviewRunStatus = 'passed' | 'failed' | 'pending';

export type ReviewFindingSeverity = 'critical' | 'warning' | 'nit';

export interface ReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  title: string;
  location?: string;
}

export interface ReviewResultMetadata {
  protocolVersion: 0 | 1;
  declaredStatus: 'passed' | 'failed';
  effectiveStatus: 'passed' | 'failed';
  blockingCount: number;
  advisoryCount: number;
  findingsKnown: boolean;
  providerExitCode?: number;
  adapterExitCode: number;
}

export interface ReviewCapabilityEvidence {
  requestedCapability: string;
  effectiveCapability: 'contract-supplied-adapter' | 'role-equivalent-adapter' | 'manual-attestation' | 'unavailable';
  adapter: string;
  provider: string;
  sourceKind?: string;
  source?: string;
  contractDigest?: string;
  contractBytes?: number;
  contractSupplied: boolean;
  wrapperCompatible: boolean;
}

export interface ReviewReportArtifactReference {
  path: string;
  digest: string;
  bytes: number;
  reportBytes: number;
  diagnosticsBytes: number;
  reportTruncated: boolean;
  diagnosticsTruncated: boolean;
  diagnosticOnly?: boolean;
}

export interface ReviewIntent {
  text: string;
  source: 'explicit-unbound' | 'orchestration-slice' | 'task-brief';
  digest: string;
  taskBindingId?: string;
}

export interface ReviewIntentCandidate {
  text: string;
  source: ReviewIntent['source'];
  authoritative: boolean;
  taskBindingId?: string;
}

export interface ReviewTargetManifest {
  baseBranchLabel: string;
  baseTipOid: string;
  mergeBaseOid: string;
  headOid: string;
  worktreeStatusDigest: string;
  materialTreeHash: string;
  serializationVersion: number;
  baseTreeManifestDigest: string;
  materialTreeManifestDigest: string;
  changedFilesDigest: string;
  ignorePolicyDigest: string;
  machineFingerprint: string;
  targetDigest: string;
}

export interface ReviewGateRunRecord {
  id: string;
  gateId: string;
  phase: ReviewGatePhase;
  type: ReviewGateType;
  blocking: boolean;
  status: ReviewGateRunStatus;
  attester?: ReviewActorIdentity;
  command?: string;
  skill?: string;
  role?: string;
  when?: string;
  whenChanged?: string[];
  timeoutMs?: number;
  userCommands?: string[];
  profiles?: ReviewProfile[];
  baselineCommandId?: string;
  replacesBaselineCommandId?: string;
  summary: string;
  exitCode?: number | null;
  signal?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  stdoutTail?: string;
  stderrTail?: string;
  capability?: ReviewCapabilityEvidence;
  result?: ReviewResultMetadata;
  findings?: ReviewFinding[];
  reportArtifact?: ReviewReportArtifactReference;
  skipReason?: string;
}

export interface ReviewActorIdentity {
  provider: string;
  sessionId: string | null;
  source: string;
}

export interface ReviewRunRecord {
  id: string;
  branchName: string;
  sha: string;
  status: ReviewRunStatus;
  dryRun: boolean;
  gateFilter?: string;
  phaseFilter?: ReviewGatePhase;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedFiles: string[];
  worktreeStatusDigest?: string;
  worktreeStatusReliable?: boolean;
  worktreeStatusWarnings?: string[];
  worktreeMaterialTreeHash?: string;
  worktreeMaterialTreeReliable?: boolean;
  worktreeMaterialTreeWarnings?: string[];
  authorIdentity?: ReviewActorIdentity | null;
  reviewer?: ReviewActorIdentity;
  enforcementMode?: ReviewEnforcementMode;
  policyVersion?: number;
  taskBindingId?: string;
  intent?: ReviewIntent;
  target?: ReviewTargetManifest;
  gates: ReviewGateRunRecord[];
  signature?: string;
}

export interface ReviewOverrideRecord {
  id: string;
  command: string;
  reason: string;
  recordedAt: string;
  actor: ReviewActorIdentity;
  branchName: string;
  sha: string;
  signature?: string;
}

export interface ReviewState {
  records: ReviewRunRecord[];
  overrides: ReviewOverrideRecord[];
  consents?: ReviewConsentRecord[];
}

export type RouteSafetyResumeKind = 'one-more-loop' | 'more-loops-and-minutes' | 'until-review-passes' | 'accept-findings' | 'legacy-import' | 'legacy-fresh-start';

export interface RouteSafetyResumeRecord {
  id: string;
  kind: RouteSafetyResumeKind;
  recordedAt: string;
  source: 'resume' | 'tty';
  oneMoreLoop?: boolean;
  moreLoops?: number;
  moreMinutes?: number;
  maxMoreLoops?: number;
  maxMoreMinutes?: number;
  acceptedFindings?: boolean;
  confirmation?: string;
  reason?: string;
  legacyMigrationAction?: 'import' | 'fresh-start';
  legacyMigrationSourceDigest?: string;
}

export interface RouteSafetyAttemptRecord {
  digest: string;
  fingerprint: string;
  headSha: string;
  worktreeStatusDigest: string;
  observedAt: string;
  reviewRunId?: string;
}

export interface RouteSafetyLegacyMigration {
  status: 'pending' | 'imported' | 'fresh-start';
  candidateDigests: string[];
  extraLoops?: number;
  extraMinutes?: number;
  decidedAt?: string;
  reason?: string;
  sourceDigest?: string;
}

export interface RouteSafetyRecord {
  lineageVersion?: 1;
  lineageDigest?: string;
  lineageFingerprint?: string;
  taskBindingId?: string;
  routeFingerprintDigest: string;
  routeFingerprint: string;
  targetCommand: string;
  taskSlug: string;
  branchName: string;
  headSha: string;
  firstStartedAt: string;
  updatedAt: string;
  fixReviewLoops: number;
  aiReviewRuns: number;
  countedReviewRunIds: string[];
  acceptedFindingsAt?: string;
  acceptedFindingsSource?: string;
  acceptedReviewRunId?: string;
  lastReviewRunId?: string;
  lastReviewStatus?: ReviewRunStatus;
  pausedAt?: string;
  pauseReason?: string;
  resumes?: RouteSafetyResumeRecord[];
  attempts?: RouteSafetyAttemptRecord[];
  currentAttemptDigest?: string;
  acceptedAttemptDigest?: string;
  legacyMigration?: RouteSafetyLegacyMigration;
}

export interface RouteSafetyState {
  routes: Record<string, RouteSafetyRecord>;
  latestPausedRouteFingerprintDigest?: string;
}

export type DeployStatus = 'requested' | 'succeeded' | 'failed' | 'unknown';

export interface DeployVerification {
  method?: 'healthcheck' | 'command';
  healthcheckUrl?: string;
  verificationCommand?: string;
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
}

export interface DeployEnvironmentLock {
  environment: DeployRecord['environment'];
  runId: string;
  sha: string;
  createdAt: string;
  pid: number;
  repoRoot: string;
}

export type DeployEnvironmentLockClaimResult =
  | { status: 'claimed'; lock: DeployEnvironmentLock }
  | { status: 'blocked'; existing: DeployEnvironmentLock | null };

export interface OperatorFlags {
  apply: boolean;
  allStale: boolean;
  force: boolean;
  statusOnly: boolean;
  // Scoped bulk-apply variants for /clean. Each names a category that
  // pipelane is willing to remove without per-task confirmation. They are
  // mutually exclusive with --task and --all-stale.
  // - completedWithIgnored: prod-verified task locks blocked only on
  //   ignored content (dist/, .turbo/, etc.) — the underlying PR is merged
  //   and prod-verified, so the ignored files are recoverable build output.
  // - safeOrphans: orphan worktrees with no tracked changes, regardless of
  //   PR state.
  // - mergedOrphans: orphan worktrees whose branches have a merged PR
  //   (work is on main; remaining tree differences are stale follow-ups).
  completedWithIgnored: boolean;
  safeOrphans: boolean;
  mergedOrphans: boolean;
  help: boolean;
  json: boolean;
  offline: boolean;
  unnamed: boolean;
  override: boolean;
  plan: boolean;
  preview: boolean;
  yes: boolean;
  skipSmokeCoverage: boolean;
  patch: boolean;
  reason: string;
  sha: string;
  pr: string;
  task: string;
  brief: string;
  briefFile: string;
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
  reviewPrint: boolean;
  reviewListGates: boolean;
  reviewEnable: string[];
  reviewDisable: string[];
  reviewInstall: string[];
  reviewToggle: string[];
  reviewReset: boolean;
  reviewDryRun: boolean;
  reviewGate: string;
  reviewPhase: string;
  reviewIntent: string;
  reviewEnforcementMode: string;
  goalSliceId: string;
  goalOutcome: string;
  goalPlanFile: string;
  goalProvider: string;
  goalMaxTurns: string;
  goalMaxMinutes: string;
  orchestrationRunId: string;
  goalSlicesFile: string;
  orchestrationAnalysisFile: string;
  orchestrationDrafts: string;
  scopeThrough: string;
  orchestrationBaseBranch: string;
  orchestrationAbandon: boolean;
  orchestrationPurgeWorktrees: boolean;
  orchestrationResealUnsigned: boolean;
  orchestrationTrustsLocalState: boolean;
  oneMoreLoop: boolean;
  moreLoops: string;
  moreMinutes: string;
  untilReviewPasses: boolean;
  maxMoreLoops: string;
  maxMoreMinutes: string;
  acceptFindings: boolean;
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
const REVIEW_STATE_FILENAME = 'review-state.json';
const REVIEW_ACCEPTANCE_STATE_FILENAME = 'review-acceptance-state.json';
const REVIEW_STATE_LOCK_FILENAME = 'review-state.lock';
const ROUTE_SAFETY_STATE_FILENAME = 'route-safety-state.json';
const ROUTE_SAFETY_STATE_LOCK_FILENAME = 'route-safety-state.lock';
const REVIEW_STATE_MAX_RECORDS = 20;
const REVIEW_OVERRIDE_MAX_RECORDS = 50;
const REVIEW_ACCEPTANCE_MAX_RECORDS = 200;
const REVIEW_CONSENT_MAX_RECORDS = 200;
const ACTION_STATE_MAX_DECISIONS = 100;
const REVIEW_STATE_LOCK_STALE_MS = 2 * 60 * 1000;
const DEPLOY_CONFIG_FILENAME = 'deploy-config.json';
const PROBE_STATE_FILENAME = 'probe-state.json';
const TASK_LOCKS_DIRNAME = 'task-locks';
const TASK_BINDING_LOCKS_DIRNAME = 'task-binding-locks';
const TASK_BINDING_LOCK_STALE_MS = 2 * 60 * 1000;
const TASK_CLEANUP_LOCKS_DIRNAME = 'task-cleanup-locks';
const TASK_CLEANUP_LOCK_STALE_MS = 10 * 60 * 1000;
const ORPHAN_CLEANUP_LOCKS_DIRNAME = 'orphan-cleanup-locks';
const INSTALL_MARKER_FILENAME = 'installed.json';
const LEGACY_MIGRATION_FILENAME = 'legacy-migration.json';

// State-resilience invariants. Pipelane state lives under
// `$PIPELANE_HOME/repos/<repo-key>/state`, where the repo key is derived from
// the git common dir. Older releases wrote state at
// `<commonDir>/<config.stateDir>` and, before that, at
// `<commonDir>/rocketboard-workflow`. When that default has been renamed in
// the past, existing installs silently re-initialized: mode-state defaulted to
// 'build', probes were "missing" (release gate fail-closed), deploy history
// looked empty. The fix has three layers, all anchored on the constants below:
//
//   LEGACY_STATE_DIRS — fallback chain, in addition to config.stateDir. When
//   the canonical state dir has no install marker but a known-legacy dir exists
//   with files, copy the orphaned files forward on first load. New legacy
//   entries get added here as defaults are renamed.
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
  reviewState: 1,
  reviewAcceptanceState: 1,
  routeSafetyState: 1,
  orchestrationRun: 2,
  orchestrationObservations: 1,
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
  reviewState: {},
  reviewAcceptanceState: {},
  routeSafetyState: {},
  orchestrationRun: {
    // v1 -> v2 (G1): providerPrompt/confirmationPrompt are no longer persisted
    // on the slice record. The worker prompt is derived from the resolved
    // goalSpec at dispatch time (Decision 1 — kills the stale-prompt class).
    // Strip the dead fields from in-flight v1 ledgers on read so they shed them
    // on the next save; goalSpec + provider remain, so derivation is lossless.
    1: (raw) => {
      if (Array.isArray(raw.slices)) {
        raw.slices = raw.slices.map((slice) => {
          if (!slice || typeof slice !== 'object' || Array.isArray(slice)) return slice;
          const next = { ...(slice as Record<string, unknown>) };
          delete next.providerPrompt;
          delete next.confirmationPrompt;
          return next;
        });
      }
      return raw;
    },
  },
  orchestrationObservations: {},
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

export function defaultReviewGatesConfig(options: {
  repoRoot?: string;
  scripts?: Record<string, string>;
} = {}): ReviewGatesConfig {
  return buildDefaultReviewGatesConfig(options);
}

export function defaultWorkflowConfig(
  projectKey: string,
  displayName: string,
  options: { repoRoot?: string } = {},
): WorkflowConfig {
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
    reviewGates: defaultReviewGatesConfig({ repoRoot: options.repoRoot }),
    routeSafety: { ...DEFAULT_ROUTE_SAFETY },
  };
}

export function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

export function normalizeExistingPath(targetPath: string): string {
  try {
    return normalizePath(realpathSync(targetPath));
  } catch {
    return normalizePath(targetPath);
  }
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

const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);
const MAX_TRANSIENT_SPAWN_RETRIES = 4;
const TRANSIENT_SPAWN_BACKOFF_MS = 20;

// A transient spawn failure (EAGAIN/EMFILE/ENFILE/ENOMEM) means the OS could not
// create the child process at all, so the command never ran. These surface
// intermittently under heavy concurrent subprocess load and are safe to retry —
// unlike a command that ran and exited non-zero.
export function isTransientSpawnError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_SPAWN_CODES.has(code);
}

function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs a subprocess operation, retrying only on transient spawn failures with a
// short escalating backoff. A retried spawn is safe because the process never
// started; a real non-zero exit (or after the retry budget) propagates as-is so
// callers still fail closed. Prevents intermittent EAGAIN under load from
// crashing long-running work such as an orchestration review pass.
export function runWithTransientSpawnRetry<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (isTransientSpawnError(error) && attempt < MAX_TRANSIENT_SPAWN_RETRIES) {
        sleepSyncMs(TRANSIENT_SPAWN_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
): string | null {
  try {
    return runWithTransientSpawnRetry(() => execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd());
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { ok: boolean; exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
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

export function pipelaneHomeDir(): string {
  return normalizePath(process.env.PIPELANE_HOME || path.join(os.homedir(), '.pipelane'));
}

export function resolveRepoConfigKey(repoRoot: string): string {
  const commonDir = runGit(repoRoot, ['rev-parse', '--git-common-dir'], true);
  const anchor = commonDir ? path.resolve(repoRoot, commonDir) : repoRoot;
  const canonical = normalizeExistingPath(anchor);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

export function resolveMachineRepoDir(repoRoot: string): string {
  return path.join(pipelaneHomeDir(), 'repos', resolveRepoConfigKey(repoRoot));
}

export function resolveMachineConfigPath(repoRoot: string): string {
  return path.join(resolveMachineRepoDir(repoRoot), 'config.json');
}

export function resolveConfigPath(repoRoot: string): string {
  return resolveMachineConfigPath(repoRoot);
}

export function resolveReadableConfigPath(repoRoot: string): string | null {
  const configPath = resolveConfigPath(repoRoot);
  if (existsSync(configPath)) {
    return configPath;
  }

  return null;
}

// Legacy repo-local config inputs are intentionally ignored. Active Pipelane
// config is machine-local only.
export function readPackageJsonOverlay(repoRoot: string): Partial<WorkflowConfig> | null {
  void repoRoot;
  return null;
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
// (aliases, syncDocs, routeSafety, etc.). Later overlays win. The output is a
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
    if (overlay.routeSafety) next.routeSafety = { ...current.routeSafety, ...overlay.routeSafety };
    if (overlay.surfacePathMap) next.surfacePathMap = { ...current.surfacePathMap, ...overlay.surfacePathMap };
    delete (next as Record<string, unknown>).smoke;
    if (isRecord(overlay.orchestrate)) {
      next.orchestrate = {
        ...current.orchestrate,
        ...overlay.orchestrate,
        goalMode: isRecord(overlay.orchestrate.goalMode)
          ? { ...current.orchestrate?.goalMode, ...overlay.orchestrate.goalMode }
          : current.orchestrate?.goalMode,
        hardStops: isRecord(overlay.orchestrate.hardStops)
          ? { ...current.orchestrate?.hardStops, ...overlay.orchestrate.hardStops }
          : current.orchestrate?.hardStops,
      };
    }
    if (overlay.reviewGates) {
      next.reviewGates = {
        ...current.reviewGates,
        ...overlay.reviewGates,
        planReview: overlay.reviewGates.planReview
          ? { ...current.reviewGates?.planReview, ...overlay.reviewGates.planReview }
          : current.reviewGates?.planReview,
      };
    }
    if (overlay.buildMode) next.buildMode = { ...current.buildMode, ...overlay.buildMode } as WorkflowConfig['buildMode'];
    if (overlay.releaseMode) next.releaseMode = { ...current.releaseMode, ...overlay.releaseMode } as WorkflowConfig['releaseMode'];
    current = next;
  }
  return current;
}

// Build a usable WorkflowConfig from repo-derived signals alone. Active config
// is machine-local only; repo-local package/config overlays are ignored.
export function synthesizeWorkflowConfig(repoRoot: string): WorkflowConfig {
  const inferredName = readPackageJsonName(repoRoot) || path.basename(repoRoot);
  const projectKey = inferProjectKey(inferredName);
  const base = defaultWorkflowConfig(projectKey, inferredName, { repoRoot });
  return normalizeWorkflowConfig(base, { repoRoot });
}

export function loadWorkflowConfig(repoRoot: string): WorkflowConfig {
  const configPath = resolveReadableConfigPath(repoRoot);

  // Self-heal: when no machine-local config exists, derive a workable config
  // from defaults and repo signals. Mutators materialize the local file through
  // patchReadableWorkflowConfig/writeWorkflowConfig.
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

  const fileName = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
  const inferredName = fileName || readPackageJsonName(repoRoot) || path.basename(repoRoot);
  const fileKey = typeof parsed.projectKey === 'string' ? parsed.projectKey.trim() : '';
  const projectKey = fileKey || inferProjectKey(inferredName);
  const base = defaultWorkflowConfig(projectKey, inferredName, { repoRoot });
  // A persisted machine config identifies an existing repo. Missing mode is
  // therefore a legacy-v2 compatibility choice, not permission to inherit a
  // newly activated strict default. Only setup/migration writes strict-v3.
  const parsedReviewGates = isRecord(parsed.reviewGates) ? parsed.reviewGates : {};
  const persistedEnforcementMode = parsedReviewGates.enforcementMode === 'strict-v3'
    ? 'strict-v3'
    : 'legacy-v2';
  const compatibleParsed: Partial<WorkflowConfig> = {
    ...parsed,
    reviewGates: {
      ...parsedReviewGates,
      enforcementMode: persistedEnforcementMode,
      policyVersion: persistedEnforcementMode === 'strict-v3' ? 3 : 2,
    } as ReviewGatesConfig,
  };
  const merged = mergeWorkflowLayers(base, compatibleParsed);
  return normalizeWorkflowConfig(merged, { repoRoot });
}

export function normalizeWorkflowConfig(
  raw: Partial<WorkflowConfig>,
  options: { repoRoot?: string } = {},
): WorkflowConfig {
  const displayName = cleanString(raw.displayName) ?? 'Project';
  const projectKey = cleanString(raw.projectKey) ?? inferProjectKey(displayName);
  const withDefaults = mergeWorkflowLayers(
    defaultWorkflowConfig(projectKey, displayName, { repoRoot: options.repoRoot }),
    raw,
  );
  const branchPrefix = normalizeBranchPrefix(withDefaults.branchPrefix);
  const legacyBranchPrefixes = normalizeLegacyBranchPrefixes(withDefaults.legacyBranchPrefixes)
    .filter((prefix, index, all) => prefix !== branchPrefix && all.indexOf(prefix) === index);
  const normalized = {
    ...(withDefaults as WorkflowConfig),
    branchPrefix,
    legacyBranchPrefixes,
    prPathDenyList: withDefaults.prPathDenyList ?? [...DEFAULT_PR_PATH_DENY_LIST],
    aliases: resolveWorkflowAliases(withDefaults.aliases),
    checks: normalizeChecksConfig(withDefaults.checks),
    syncDocs: normalizeSyncDocsConfig(withDefaults.syncDocs),
    surfacePathMap: normalizeSurfacePathMap(withDefaults.surfacePathMap),
    reviewGates: normalizeReviewGatesConfig(withDefaults.reviewGates, { repoRoot: options.repoRoot }),
    routeSafety: normalizeRouteSafetyConfig(withDefaults.routeSafety),
    orchestrate: normalizeOrchestrateConfig(withDefaults.orchestrate),
  } as WorkflowConfig & Record<string, unknown>;
  delete normalized.smoke;
  return normalized;
}

export const REVIEW_GATE_PHASES: readonly ReviewGatePhase[] = ['static', 'behavioral', 'ai-diff', 'instruction', 'runtime', 'human'];
const REVIEW_GATE_TYPES: readonly ReviewGateType[] = ['command', 'skill', 'agent', 'approval', 'pipelane'];
const REVIEW_PLAN_GATE_TYPES: readonly ReviewPlanGateConfig['type'][] = ['skill', 'agent', 'approval'];
const ORCHESTRATE_GOAL_CONFIRMATION_MODES: readonly OrchestrateGoalConfirmationMode[] = ['confirm', 'auto', 'off'];

function normalizeOrchestrateConfig(raw: OrchestrateConfig | undefined): OrchestrateConfig | undefined {
  if (!isRecord(raw)) return undefined;

  const goalMode = isRecord(raw.goalMode) ? raw.goalMode : undefined;
  const hardStops = isRecord(raw.hardStops) ? raw.hardStops : undefined;
  const baseBranch = cleanString(raw.baseBranch);
  return {
    ...(baseBranch ? { baseBranch } : {}),
    maxConcurrentSlices: positiveConfigInteger(raw.maxConcurrentSlices),
    goalMode: goalMode
      ? {
          default: includesString(ORCHESTRATE_GOAL_CONFIRMATION_MODES, goalMode.default)
            ? goalMode.default
            : undefined,
          maxTurns: positiveConfigInteger(goalMode.maxTurns),
          maxMinutes: positiveConfigInteger(goalMode.maxMinutes),
          requireConfirmationFor: cleanStringList(goalMode.requireConfirmationFor),
        }
      : undefined,
    hardStops: hardStops
      ? {
          maxIterationsPerSlice: positiveConfigInteger(hardStops.maxIterationsPerSlice),
          maxReviewLoops: positiveConfigInteger(hardStops.maxReviewLoops),
          maxMinutesPerSlice: positiveConfigInteger(hardStops.maxMinutesPerSlice),
          maxStalledIterations: positiveConfigInteger(hardStops.maxStalledIterations),
        }
      : undefined,
  };
}

function positiveConfigInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function normalizeRouteSafetyConfig(raw: RouteSafetyConfig | undefined): Required<RouteSafetyConfig> {
  if (!isRecord(raw)) return { ...DEFAULT_ROUTE_SAFETY };
  return {
    defaultFixReviewLoops: positiveConfigInteger(raw.defaultFixReviewLoops) ?? DEFAULT_ROUTE_SAFETY.defaultFixReviewLoops,
    defaultMinutes: positiveConfigInteger(raw.defaultMinutes) ?? DEFAULT_ROUTE_SAFETY.defaultMinutes,
    defaultAiReviewRuns: positiveConfigInteger(raw.defaultAiReviewRuns) ?? DEFAULT_ROUTE_SAFETY.defaultAiReviewRuns,
    stopOnMajorFindings: typeof raw.stopOnMajorFindings === 'boolean'
      ? raw.stopOnMajorFindings
      : DEFAULT_ROUTE_SAFETY.stopOnMajorFindings,
  };
}

export function normalizeReviewGatesConfig(
  raw: ReviewGatesConfig | undefined,
  options: { repoRoot?: string } = {},
): ReviewGatesConfig {
  const defaults = defaultReviewGatesConfig({ repoRoot: options.repoRoot });
  if (!isRecord(raw)) return defaults;

  const planReview = isRecord(raw.planReview) ? raw.planReview : undefined;
  const planGates = Array.isArray(planReview?.gates)
    ? normalizeReviewPlanGateList(planReview.gates)
    : defaults.planReview?.gates;
  const gates = Array.isArray(raw.gates)
    ? normalizeReviewGateList(raw.gates)
    : defaults.gates;
  const enforcementMode: ReviewEnforcementMode = raw.enforcementMode === 'strict-v3'
    ? 'strict-v3'
    : 'legacy-v2';
  const legacyPolicyVersion = raw.enforcementMode === 'legacy-v2'
    ? 2
    : typeof raw.policyVersion === 'number' && Number.isFinite(raw.policyVersion)
      ? Math.trunc(raw.policyVersion)
      : 2;

  return {
    enforcementMode,
    policyVersion: enforcementMode === 'strict-v3' ? 3 : legacyPolicyVersion,
    planReview: {
      gates: planGates ?? [],
    },
    gates: gates ?? [],
  };
}

function normalizeReviewPlanGateList(raw: unknown[]): ReviewPlanGateConfig[] {
  const seen = new Set<string>();
  const out: ReviewPlanGateConfig[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = cleanString(entry.id);
    if (!id || seen.has(id)) continue;
    const type = includesString(REVIEW_PLAN_GATE_TYPES, entry.type) ? entry.type : undefined;
    if (!type) continue;

    const skill = cleanString(entry.skill);
    const role = cleanString(entry.role);
    if (type === 'skill' && !skill) continue;
    if (type === 'agent' && !role) continue;

    seen.add(id);
    out.push({
      id,
      phase: 'plan',
      type,
      blocking: entry.blocking !== false,
      skill: type === 'skill' ? skill : undefined,
      role: type === 'agent' ? role : undefined,
      when: cleanString(entry.when),
    });
  }
  return out;
}

function normalizeReviewGateList(raw: unknown[]): ReviewGateConfig[] {
  const seen = new Set<string>();
  const out: ReviewGateConfig[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = cleanString(entry.id);
    if (!id || seen.has(id)) continue;
    const phase = includesString(REVIEW_GATE_PHASES, entry.phase) ? entry.phase : undefined;
    const type = includesString(REVIEW_GATE_TYPES, entry.type) ? entry.type : undefined;
    if (!phase || !type) continue;

    const command = cleanString(entry.command);
    const skill = cleanString(entry.skill);
    const role = cleanString(entry.role);
    if ((type === 'command' || type === 'pipelane') && !command) continue;
    if (type === 'skill' && !skill) continue;
    if (type === 'agent' && !role) continue;

    const timeoutMs = typeof entry.timeoutMs === 'number' && Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0
      ? Math.trunc(entry.timeoutMs)
      : undefined;

    seen.add(id);
    out.push({
      id,
      phase,
      type,
      blocking: entry.blocking !== false,
      command: type === 'command' || type === 'pipelane' || type === 'skill' || type === 'agent'
        ? command
        : undefined,
      skill: type === 'skill' ? skill : undefined,
      role: type === 'agent' ? role : undefined,
      when: cleanString(entry.when),
      whenChanged: cleanStringList(entry.whenChanged),
      timeoutMs,
      userCommands: cleanStringList(entry.userCommands),
      profiles: cleanReviewProfiles(entry.profiles),
      baselineCommandId: cleanStableId(entry.baselineCommandId),
      replacesBaselineCommandId: cleanStableId(entry.replacesBaselineCommandId),
    });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function includesString<const T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = cleanString(entry);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out.length > 0 ? out : undefined;
}

function cleanReviewProfiles(value: unknown): ReviewProfile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ReviewProfile[] = [];
  for (const entry of value) {
    if ((entry === 'docs-only' || entry === 'implementation') && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out.length > 0 ? out : undefined;
}

function cleanStableId(value: unknown): string | undefined {
  const clean = cleanString(value);
  if (!isStableEvidenceId(clean)) return undefined;
  return clean;
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
// never opt in. Explicit `true` values are preserved as-is (they don't
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
  const configPath = resolveConfigPath(repoRoot);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeJsonFile(configPath, {
    ...config,
    aliases: resolveWorkflowAliases(config.aliases),
  });
}

// Read machine-local workflow config, run the patcher, and write the result
// back to the same local path. If no config exists yet, materialize one from
// synthesized defaults before patching.
export function patchReadableWorkflowConfig(
  repoRoot: string,
  patcher: (raw: Record<string, unknown>) => Record<string, unknown>,
): { configPath: string; isLegacy: boolean } {
  let configPath = resolveReadableConfigPath(repoRoot);
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
  return { configPath, isLegacy: false };
}

export function resolveStateDir(commonDir: string, config: WorkflowConfig): string {
  void config;
  return path.join(resolveMachineRepoDirForCommonDir(commonDir), 'state');
}

function resolveMachineRepoDirForCommonDir(commonDir: string): string {
  const canonical = normalizeExistingPath(commonDir);
  const key = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return path.join(pipelaneHomeDir(), 'repos', key);
}

function legacyStateDirPath(commonDir: string, stateDirName: string): string {
  return path.join(commonDir, stateDirName);
}

export function resolveSharedRepoRoot(commonDir: string): string {
  return path.dirname(normalizePath(commonDir));
}

export function ensureStateDir(commonDir: string, config: WorkflowConfig): string {
  const stateDir = resolveStateDir(commonDir, config);
  // Idempotent legacy migration runs before marker is planted so a
  // successful copy doesn't get suppressed by the marker or an empty
  // canonical task-locks directory we'd otherwise create first. Both
  // calls are no-ops on subsequent invocations.
  migrateLegacyStateDir(commonDir, config);
  mkdirSync(path.join(stateDir, TASK_LOCKS_DIRNAME), { recursive: true });
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

export function reviewStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), REVIEW_STATE_FILENAME);
}

export function reviewArtifactRoot(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), 'review-artifacts');
}

export function reviewAcceptanceStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), REVIEW_ACCEPTANCE_STATE_FILENAME);
}

export function routeSafetyStatePath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), ROUTE_SAFETY_STATE_FILENAME);
}

function reviewStateLockPath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), REVIEW_STATE_LOCK_FILENAME);
}

function routeSafetyStateLockPath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), ROUTE_SAFETY_STATE_LOCK_FILENAME);
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

export function resolveDeployRuntimeRoot(commonDir: string): string {
  // Keep deploy locks at their historical path for rolling-upgrade safety.
  // Older Pipelane processes still coordinate deploys through smoke-runtime;
  // moving the file would let old and new processes deploy concurrently.
  return path.join(resolveMachineRepoDir(resolveSharedRepoRoot(commonDir)), 'smoke-runtime');
}

export function resolveDeployLockPath(commonDir: string, environment: DeployRecord['environment']): string {
  return path.join(resolveDeployRuntimeRoot(commonDir), 'locks', `${environment}.json`);
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

export function loadDeployEnvironmentLock(commonDir: string, environment: DeployRecord['environment']): DeployEnvironmentLock | null {
  const raw = readJsonFile<unknown>(resolveDeployLockPath(commonDir, environment), null);
  return isDeployEnvironmentLock(raw, environment) ? raw : null;
}

function isDeployEnvironmentLock(value: unknown, environment: DeployRecord['environment']): value is DeployEnvironmentLock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lock = value as Partial<DeployEnvironmentLock>;
  return lock.environment === environment
    && typeof lock.runId === 'string' && lock.runId.length > 0
    && typeof lock.sha === 'string' && lock.sha.length > 0
    && typeof lock.createdAt === 'string'
    && typeof lock.pid === 'number' && Number.isSafeInteger(lock.pid) && lock.pid > 0
    && typeof lock.repoRoot === 'string' && lock.repoRoot.length > 0;
}

export function claimDeployEnvironmentLock(
  commonDir: string,
  value: DeployEnvironmentLock,
  options: { isStale(existing: DeployEnvironmentLock): boolean },
): DeployEnvironmentLockClaimResult {
  const targetPath = resolveDeployLockPath(commonDir, value.environment);
  const reclaimPath = deployLockReclaimPath(targetPath);
  if (deployLockReclaimInProgress(reclaimPath)) {
    return { status: 'blocked', existing: loadDeployEnvironmentLock(commonDir, value.environment) };
  }
  if (writeDeployEnvironmentLockExclusively(targetPath, value)) {
    return { status: 'claimed', lock: value };
  }

  const existing = loadDeployEnvironmentLock(commonDir, value.environment);
  if (existing && !options.isStale(existing)) {
    return { status: 'blocked', existing };
  }

  if (!acquireDeployLockMutationGuard(reclaimPath)) {
    return { status: 'blocked', existing };
  }

  try {
    const current = loadDeployEnvironmentLock(commonDir, value.environment);
    if (current && !options.isStale(current)) {
      return { status: 'blocked', existing: current };
    }
    if (current) {
      removeDeployEnvironmentLockFile(targetPath, current.runId);
    } else if (existsSync(targetPath)) {
      // An unreadable or structurally invalid lock cannot identify a live
      // owner. The mutation guard makes quarantine/removal and re-claim a
      // single-writer transition instead of permanently wedging deploys.
      removeDeployEnvironmentLockFile(targetPath);
    }
    return writeDeployEnvironmentLockExclusively(targetPath, value)
      ? { status: 'claimed', lock: value }
      : { status: 'blocked', existing: loadDeployEnvironmentLock(commonDir, value.environment) };
  } finally {
    rmSync(reclaimPath, { recursive: true, force: true });
  }
}

function deployLockReclaimPath(targetPath: string): string {
  return `${targetPath}.reclaim`;
}

function acquireDeployLockMutationGuard(reclaimPath: string): boolean {
  if (deployLockReclaimInProgress(reclaimPath)) return false;
  try {
    mkdirSync(reclaimPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function deployLockReclaimInProgress(reclaimPath: string): boolean {
  if (!existsSync(reclaimPath)) return false;
  try {
    const stats = statSync(reclaimPath);
    if (Date.now() - stats.mtimeMs > 5 * 60 * 1000) {
      rmSync(reclaimPath, { recursive: true, force: true });
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function writeDeployEnvironmentLockExclusively(targetPath: string, value: DeployEnvironmentLock): boolean {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  try {
    writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function removeDeployEnvironmentLock(
  commonDir: string,
  environment: DeployRecord['environment'],
  expectedRunId?: string,
): boolean {
  const targetPath = resolveDeployLockPath(commonDir, environment);
  const reclaimPath = deployLockReclaimPath(targetPath);
  if (!acquireDeployLockMutationGuard(reclaimPath)) return false;
  try {
    return removeDeployEnvironmentLockFile(targetPath, expectedRunId);
  } finally {
    rmSync(reclaimPath, { recursive: true, force: true });
  }
}

function removeDeployEnvironmentLockFile(targetPath: string, expectedRunId?: string): boolean {
  if (!existsSync(targetPath)) {
    return false;
  }
  if (expectedRunId) {
    const current = readJsonFile<DeployEnvironmentLock | null>(targetPath, null);
    if (current?.runId !== expectedRunId) return false;
  }
  unlinkSync(targetPath);
  return true;
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

function taskCleanupLockPath(commonDir: string, config: WorkflowConfig, taskSlug: string): string {
  return path.join(resolveStateDir(commonDir, config), TASK_CLEANUP_LOCKS_DIRNAME, `${taskSlug}.lock`);
}

function clearStaleTaskCleanupLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs <= TASK_CLEANUP_LOCK_STALE_MS) return false;
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function acquireTaskCleanupLock(commonDir: string, config: WorkflowConfig, taskSlug: string): { acquired: true; release: () => void } | { acquired: false; reason: string } {
  const lockPath = taskCleanupLockPath(commonDir, config, taskSlug);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  clearStaleTaskCleanupLock(lockPath);
  let created = false;
  try {
    mkdirSync(lockPath);
    created = true;
    writeFileSync(
      path.join(lockPath, 'owner.json'),
      `${JSON.stringify({ taskSlug, pid: process.pid, acquiredAt: nowIso() }, null, 2)}\n`,
      'utf8',
    );
    return { acquired: true, release: () => rmSync(lockPath, { recursive: true, force: true }) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      return { acquired: false, reason: 'another cleanup already owns this task lock' };
    }
    if (created) rmSync(lockPath, { recursive: true, force: true });
    return { acquired: false, reason: `could not acquire cleanup lock: ${err.message}` };
  }
}

function assertTaskCleanupUnlocked(commonDir: string, config: WorkflowConfig, taskSlug: string): void {
  const lockPath = taskCleanupLockPath(commonDir, config, taskSlug);
  clearStaleTaskCleanupLock(lockPath);
  if (existsSync(lockPath)) {
    throw new Error(`Task ${taskSlug} is being cleaned by another Pipelane process; retry after cleanup finishes.`);
  }
}

function orphanCleanupLockPath(commonDir: string, config: WorkflowConfig, worktreePath: string): string {
  // Hash the absolute worktree path so the lockfile name is stable across
  // operators (independent of working dir) and filesystem-safe (no slashes).
  // Truncate to 16 chars — enough to make collisions vanishingly unlikely
  // for the small set of orphans pipelane sees in practice.
  const key = crypto.createHash('sha256').update(normalizePath(worktreePath)).digest('hex').slice(0, 16);
  return path.join(resolveStateDir(commonDir, config), ORPHAN_CLEANUP_LOCKS_DIRNAME, `${key}.lock`);
}

/**
 * Same shape as acquireTaskCleanupLock, keyed on the orphan worktree's
 * absolute path. Used by `/clean --apply --safe-orphans` and
 * `--merged-orphans` so two concurrent invocations don't both attempt the
 * same `git worktree remove` (which would surface a confusing per-orphan
 * git error on the loser instead of a clean "busy" message).
 */
export function acquireOrphanCleanupLock(commonDir: string, config: WorkflowConfig, worktreePath: string): { acquired: true; release: () => void } | { acquired: false; reason: string } {
  const lockPath = orphanCleanupLockPath(commonDir, config, worktreePath);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  clearStaleTaskCleanupLock(lockPath);
  let created = false;
  try {
    mkdirSync(lockPath);
    created = true;
    writeFileSync(
      path.join(lockPath, 'owner.json'),
      `${JSON.stringify({ worktreePath: normalizePath(worktreePath), pid: process.pid, acquiredAt: nowIso() }, null, 2)}\n`,
      'utf8',
    );
    return { acquired: true, release: () => rmSync(lockPath, { recursive: true, force: true }) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      return { acquired: false, reason: 'another /clean run already owns this orphan worktree' };
    }
    if (created) rmSync(lockPath, { recursive: true, force: true });
    return { acquired: false, reason: `could not acquire orphan cleanup lock: ${err.message}` };
  }
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
  writeJsonFile(target, { installedAt: nowIso(), stateFiles: [] });
}

const missingStateWarnings = new Set<string>();

function stateFileMarkerKey(commonDir: string, config: WorkflowConfig, targetPath: string): string {
  return normalizePath(path.relative(resolveStateDir(commonDir, config), targetPath)).replaceAll('\\', '/');
}

function readInstallMarker(commonDir: string, config: WorkflowConfig): Record<string, unknown> | null {
  const target = installMarkerPath(commonDir, config);
  if (!existsSync(target)) return null;
  const marker = readJsonFile<unknown>(target, null);
  return marker && typeof marker === 'object' && !Array.isArray(marker)
    ? marker as Record<string, unknown>
    : null;
}

function markStateFilesWritten(commonDir: string, config: WorkflowConfig, entries: string[]): void {
  ensureInstallMarker(commonDir, config);
  const target = installMarkerPath(commonDir, config);
  const marker = readInstallMarker(commonDir, config) ?? { installedAt: nowIso() };
  const existing = Array.isArray(marker.stateFiles)
    ? marker.stateFiles.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const stateFiles = [...new Set([...existing, ...entries.map((entry) => entry.replaceAll('\\', '/'))])].sort();
  writeJsonFile(target, { ...marker, stateFiles });
}

function nearestMarkedStateRoot(targetPath: string): string {
  let current = path.dirname(targetPath);
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(path.join(current, INSTALL_MARKER_FILENAME))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

function markStateFileWritten(targetPath: string): void {
  const root = nearestMarkedStateRoot(targetPath);
  if (!root) return;
  const markerPath = path.join(root, INSTALL_MARKER_FILENAME);
  const marker = readJsonFile<unknown>(markerPath, null);
  const markerObject = marker && typeof marker === 'object' && !Array.isArray(marker)
    ? marker as Record<string, unknown>
    : { installedAt: nowIso() };
  const existing = Array.isArray(markerObject.stateFiles)
    ? markerObject.stateFiles.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const key = normalizePath(path.relative(root, targetPath)).replaceAll('\\', '/');
  if (key.startsWith(`${TASK_LOCKS_DIRNAME}/`)) return;
  const stateFiles = [...new Set([...existing, key])].sort();
  writeJsonFile(markerPath, { ...markerObject, stateFiles });
}

function shouldWarnMissingState(commonDir: string, config: WorkflowConfig, targetPath: string): boolean {
  const marker = readInstallMarker(commonDir, config);
  if (!marker) return false;
  const expected = Array.isArray(marker.stateFiles)
    ? marker.stateFiles.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return expected.includes(stateFileMarkerKey(commonDir, config, targetPath));
}

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

  const legacyStateDirNames = Array.from(new Set([config.stateDir, ...LEGACY_STATE_DIRS]));
  for (const legacyName of legacyStateDirNames) {
    const legacyDir = legacyStateDirPath(commonDir, legacyName);
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
    markStateFilesWritten(commonDir, config, copied);

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
// canonical state dir. State files outside that dir, such as repo-tracked
// configs, should keep using readJsonFile directly.
export function readVersionedJsonFile<T>(
  kind: StateKind,
  commonDir: string,
  config: WorkflowConfig,
  targetPath: string,
  fallback: T,
): T {
  if (!existsSync(targetPath)) {
    if (kind !== 'taskLock' && shouldWarnMissingState(commonDir, config, targetPath)) {
      warnMissingStateAfterInstall(targetPath);
    }
    return fallback;
  }

  const raw = readJsonFile<unknown>(targetPath, fallback as unknown);
  if (raw === fallback) return fallback;
  return normalizeVersionedJsonValue<T>(kind, raw);
}

export function normalizeVersionedJsonValue<T>(kind: StateKind, raw: unknown): T {
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
  markStateFileWritten(targetPath);
}

export function loadModeState(commonDir: string, config: WorkflowConfig): ModeState {
  const raw = readVersionedJsonFile<ModeState>('modeState', commonDir, config, modeStatePath(commonDir, config), {
    mode: DEFAULT_MODE,
    requestedSurfaces: [...config.surfaces],
    override: null,
    updatedAt: null,
  });
  return normalizeModeState(raw, config);
}

// v1.5: drop malformed fields on load rather than letting them crash
// renderers downstream (`/devmode status` prints `last.setBy.length`
// directly). A corrupt or hand-edited mode-state.json where
// `lastOverride` is a string, array, or missing one of its three
// required subfields gets silently dropped back to `undefined`. Strict:
// all three strings, all non-empty — partials are as suspicious as
// fully-malformed entries.
function normalizeModeState(raw: ModeState, config: WorkflowConfig): ModeState {
  const normalized: ModeState = {
    ...raw,
    requestedSurfaces: normalizeModeStateSurfaces(raw.requestedSurfaces as unknown, config),
  };
  const last = raw.lastOverride as unknown;
  if (last && typeof last === 'object' && !Array.isArray(last)) {
    const entry = last as Record<string, unknown>;
    if (
      typeof entry.reason === 'string' && entry.reason.length > 0
      && typeof entry.setAt === 'string' && entry.setAt.length > 0
      && typeof entry.setBy === 'string' && entry.setBy.length > 0
    ) {
      return {
        ...normalized,
        lastOverride: { reason: entry.reason, setAt: entry.setAt, setBy: entry.setBy },
      };
    }
  }
  if (raw.lastOverride !== undefined) {
    return { ...normalized, lastOverride: undefined };
  }
  return normalized;
}

function normalizeModeStateSurfaces(raw: unknown, config: WorkflowConfig): string[] {
  if (!Array.isArray(raw)) return [...config.surfaces];
  const requested = [...new Set(raw
    .filter((surface): surface is string => typeof surface === 'string')
    .map((surface) => surface.trim())
    .filter(Boolean))];
  if (requested.length === 0) return [...config.surfaces];
  const configured = new Set(config.surfaces);
  return requested.filter((surface) => configured.has(surface));
}

export function saveModeState(commonDir: string, config: WorkflowConfig, value: ModeState): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('modeState', modeStatePath(commonDir, config), value);
}

export function loadDeployState(commonDir: string, config: WorkflowConfig): { records: DeployRecord[] } {
  const loaded = readVersionedJsonFile<unknown>('deployState', commonDir, config, deployStatePath(commonDir, config), { records: [] });
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return { records: [] };
  }
  const records = (loaded as { records?: unknown }).records;
  return {
    records: Array.isArray(records)
      ? records.map(normalizeDeployRecord).filter((record): record is DeployRecord => record !== null)
      : [],
  };
}

function normalizeDeployRecord(value: unknown): DeployRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const environment = raw.environment;
  if (environment !== 'staging' && environment !== 'prod') return null;
  if (typeof raw.sha !== 'string' || raw.sha.trim().length === 0) return null;
  if (!Array.isArray(raw.surfaces)) return null;
  const surfaces = raw.surfaces
    .filter((surface): surface is string => typeof surface === 'string' && surface.trim().length > 0)
    .map((surface) => surface.trim());
  if (surfaces.length === 0) return null;

  const record = {
    ...raw,
    environment,
    sha: raw.sha,
    surfaces,
    workflowName: typeof raw.workflowName === 'string' ? raw.workflowName : '',
    requestedAt: raw.requestedAt as DeployRecord['requestedAt'],
  } as DeployRecord;
  if (raw.status !== undefined && !isDeployStatus(raw.status)) {
    delete (record as { status?: unknown }).status;
  }
  return record;
}

function isDeployStatus(value: unknown): value is DeployStatus {
  return value === 'requested' || value === 'succeeded' || value === 'failed' || value === 'unknown';
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
  const decisions: StatusDecisionRecord[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)) {
    return { records, decisions };
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
  if (Array.isArray(raw.decisions)) {
    decisions.push(...raw.decisions
      .map(normalizeStatusDecisionRecord)
      .filter((record): record is StatusDecisionRecord => record !== null)
      .slice(0, ACTION_STATE_MAX_DECISIONS));
  }
  return { records, decisions };
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

export function saveStatusDecisionRecord(commonDir: string, config: WorkflowConfig, record: StatusDecisionRecord): StatusDecisionRecord {
  const state = loadActionState(commonDir, config);
  const existing = state.decisions ?? [];
  state.decisions = [record, ...existing.filter((entry) => entry.id !== record.id)].slice(0, ACTION_STATE_MAX_DECISIONS);
  saveActionState(commonDir, config, state);
  return record;
}

function normalizeStatusDecisionRecord(value: unknown): StatusDecisionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string'
    || typeof raw.actionId !== 'string'
    || typeof raw.label !== 'string'
    || !isStatusDecisionStatus(raw.status)
    || typeof raw.question !== 'string'
    || typeof raw.selectedOption !== 'string'
    || typeof raw.createdAt !== 'string'
    || typeof raw.answeredAt !== 'string'
    || typeof raw.actor !== 'string'
    || typeof raw.branchName !== 'string'
    || typeof raw.headSha !== 'string'
    || (raw.source !== 'board' && raw.source !== 'branch' && raw.source !== 'orchestration')
  ) {
    return null;
  }

  const record: StatusDecisionRecord = {
    id: raw.id,
    actionId: raw.actionId,
    label: raw.label,
    status: raw.status,
    question: raw.question,
    selectedOption: raw.selectedOption,
    createdAt: raw.createdAt,
    answeredAt: raw.answeredAt,
    actor: raw.actor,
    branchName: raw.branchName,
    headSha: raw.headSha,
    source: raw.source,
  };
  if (typeof raw.taskSlug === 'string') record.taskSlug = raw.taskSlug;
  if (typeof raw.runId === 'string') record.runId = raw.runId;
  if (typeof raw.sliceId === 'string') record.sliceId = raw.sliceId;
  if (typeof raw.preflightAllowed === 'boolean') record.preflightAllowed = raw.preflightAllowed;
  if (typeof raw.preflightReason === 'string') record.preflightReason = raw.preflightReason;
  if (typeof raw.executionExitCode === 'number') record.executionExitCode = raw.executionExitCode;
  if (typeof raw.executionMessage === 'string') record.executionMessage = raw.executionMessage;
  if (typeof raw.confirmationRequired === 'boolean') record.confirmationRequired = raw.confirmationRequired;
  if (raw.normalizedInputs && typeof raw.normalizedInputs === 'object' && !Array.isArray(raw.normalizedInputs)) {
    record.normalizedInputs = raw.normalizedInputs as Record<string, unknown>;
  }
  return record;
}

function isStatusDecisionStatus(value: unknown): value is StatusDecisionStatus {
  return value === 'pending'
    || value === 'cancelled'
    || value === 'blocked'
    || value === 'executed'
    || value === 'failed';
}

export function loadReviewState(commonDir: string, config: WorkflowConfig): ReviewState {
  const raw = readVersionedJsonFile<ReviewState>('reviewState', commonDir, config, reviewStatePath(commonDir, config), { records: [], overrides: [], consents: [] });
  const stateKey = resolveReviewStateKey();
  const records = Array.isArray(raw?.records)
    ? raw.records.filter(isReviewRunRecord).slice(0, REVIEW_STATE_MAX_RECORDS)
      .filter((record) => !stateKey || verifySignedPayload(record, stateKey))
    : [];
  const overrides = Array.isArray(raw?.overrides)
    ? raw.overrides.filter(isReviewOverrideRecord).slice(0, REVIEW_OVERRIDE_MAX_RECORDS)
      .filter((record) => !stateKey || verifySignedPayload(record, stateKey))
    : [];
  const consentKey = resolveReviewConsentStateKey();
  const consents = Array.isArray(raw?.consents)
    ? raw.consents.filter(isReviewConsentRecord).slice(0, REVIEW_CONSENT_MAX_RECORDS)
      .filter((record) => verifySignedPayload(record, consentKey))
    : [];
  return { records, overrides, consents };
}

export function saveReviewState(commonDir: string, config: WorkflowConfig, value: ReviewState): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('reviewState', reviewStatePath(commonDir, config), {
    records: value.records.slice(0, REVIEW_STATE_MAX_RECORDS),
    overrides: (value.overrides ?? []).slice(0, REVIEW_OVERRIDE_MAX_RECORDS),
    consents: (value.consents ?? []).slice(0, REVIEW_CONSENT_MAX_RECORDS),
  });
}

export function loadReviewAcceptanceState(commonDir: string, config: WorkflowConfig): ReviewAcceptanceState {
  const raw = readVersionedJsonFile<ReviewAcceptanceState>(
    'reviewAcceptanceState',
    commonDir,
    config,
    reviewAcceptanceStatePath(commonDir, config),
    { records: [] },
  );
  const stateKey = resolveReviewStateKey();
  const records = Array.isArray(raw?.records)
    ? raw.records.filter(isReviewAcceptanceRecord).slice(0, REVIEW_ACCEPTANCE_MAX_RECORDS)
      .filter((record) => !stateKey || verifySignedPayload(record, stateKey))
    : [];
  return { records };
}

export function saveReviewAcceptanceState(commonDir: string, config: WorkflowConfig, value: ReviewAcceptanceState): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('reviewAcceptanceState', reviewAcceptanceStatePath(commonDir, config), {
    records: value.records.slice(0, REVIEW_ACCEPTANCE_MAX_RECORDS),
  });
}

export function appendReviewAcceptanceRecord(
  commonDir: string,
  config: WorkflowConfig,
  record: ReviewAcceptanceRecord,
): ReviewAcceptanceRecord {
  const lock = acquireReviewStateLock(commonDir, config);
  try {
    const state = loadReviewAcceptanceState(commonDir, config);
    const stateKey = resolveReviewStateKey();
    const persisted = stateKey
      ? { ...record, signature: signSignedPayload(record, stateKey) }
      : record;
    state.records = [persisted, ...state.records].slice(0, REVIEW_ACCEPTANCE_MAX_RECORDS);
    saveReviewAcceptanceState(commonDir, config, state);
    return persisted;
  } finally {
    lock.release();
  }
}

export function reviewAcceptanceReasonHash(reason: string): string {
  return crypto.createHash('sha256').update(reason.trim()).digest('hex');
}

export function appendReviewRunRecord(
  commonDir: string,
  config: WorkflowConfig,
  record: ReviewRunRecord,
  dependencies: {
    resolveSigningKey?: () => string | undefined;
    signRecord?: (record: ReviewRunRecord, key: string) => string;
    saveLedger?: (commonDir: string, config: WorkflowConfig, state: ReviewState) => void;
  } = {},
): ReviewRunRecord {
  const lock = acquireReviewStateLock(commonDir, config);
  try {
    const state = loadReviewState(commonDir, config);
    const stateKey = (dependencies.resolveSigningKey ?? resolveReviewStateKey)();
    const persisted = stateKey
      ? { ...record, signature: (dependencies.signRecord ?? signSignedPayload)(record, stateKey) }
      : record;
    state.records = [persisted, ...state.records].slice(0, REVIEW_STATE_MAX_RECORDS);
    (dependencies.saveLedger ?? saveReviewState)(commonDir, config, state);
    return persisted;
  } finally {
    lock.release();
  }
}

export function appendReviewOverrideRecord(commonDir: string, config: WorkflowConfig, record: ReviewOverrideRecord): ReviewOverrideRecord {
  const lock = acquireReviewStateLock(commonDir, config);
  try {
    const state = loadReviewState(commonDir, config);
    const stateKey = resolveReviewStateKey();
    const persisted = stateKey
      ? { ...record, signature: signSignedPayload(record, stateKey) }
      : record;
    state.overrides = [persisted, ...(state.overrides ?? [])].slice(0, REVIEW_OVERRIDE_MAX_RECORDS);
    saveReviewState(commonDir, config, state);
    return persisted;
  } finally {
    lock.release();
  }
}

export function appendReviewConsentRecord(commonDir: string, config: WorkflowConfig, record: ReviewConsentRecord): ReviewConsentRecord {
  const lock = acquireReviewStateLock(commonDir, config);
  try {
    const state = loadReviewState(commonDir, config);
    const consentKey = resolveReviewConsentStateKey();
    const persisted = { ...record, signature: signSignedPayload(record, consentKey) };
    state.consents = [persisted, ...(state.consents ?? [])].slice(0, REVIEW_CONSENT_MAX_RECORDS);
    saveReviewState(commonDir, config, state);
    return persisted;
  } finally {
    lock.release();
  }
}

export function withReviewStateLock<T>(commonDir: string, config: WorkflowConfig, fn: () => T): T {
  const lock = acquireReviewStateLock(commonDir, config);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

export function loadRouteSafetyState(commonDir: string, config: WorkflowConfig): RouteSafetyState {
  const raw = readVersionedJsonFile<RouteSafetyState>('routeSafetyState', commonDir, config, routeSafetyStatePath(commonDir, config), { routes: {} });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { routes: {} };
  const routes: Record<string, RouteSafetyRecord> = {};
  const rawRoutes = (raw as { routes?: unknown }).routes;
  if (rawRoutes && typeof rawRoutes === 'object' && !Array.isArray(rawRoutes)) {
    for (const [digest, record] of Object.entries(rawRoutes)) {
      const normalized = normalizeRouteSafetyRecord(record);
      if (normalized && (normalized.lineageDigest === digest || normalized.routeFingerprintDigest === digest)) {
        routes[digest] = normalized;
      }
    }
  }
  const latestPausedRouteFingerprintDigest = typeof raw.latestPausedRouteFingerprintDigest === 'string'
    && routes[raw.latestPausedRouteFingerprintDigest]
    ? raw.latestPausedRouteFingerprintDigest
    : undefined;
  return {
    routes,
    ...(latestPausedRouteFingerprintDigest ? { latestPausedRouteFingerprintDigest } : {}),
  };
}

export function saveRouteSafetyState(commonDir: string, config: WorkflowConfig, value: RouteSafetyState): void {
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('routeSafetyState', routeSafetyStatePath(commonDir, config), value);
}

export function withRouteSafetyStateLock<T>(commonDir: string, config: WorkflowConfig, fn: () => T): T {
  const lock = acquireDirectoryStateLock(
    routeSafetyStateLockPath(commonDir, config),
    'route safety state is locked: another process is updating the route lineage. Wait and retry.',
  );
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function normalizeRouteSafetyRecord(value: unknown): RouteSafetyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.routeFingerprintDigest !== 'string'
    || typeof raw.routeFingerprint !== 'string'
    || typeof raw.targetCommand !== 'string'
    || typeof raw.taskSlug !== 'string'
    || typeof raw.branchName !== 'string'
    || typeof raw.headSha !== 'string'
    || typeof raw.firstStartedAt !== 'string'
    || typeof raw.updatedAt !== 'string'
  ) {
    return null;
  }
  const countedReviewRunIds = Array.isArray(raw.countedReviewRunIds)
    ? raw.countedReviewRunIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const record: RouteSafetyRecord = {
    routeFingerprintDigest: raw.routeFingerprintDigest,
    routeFingerprint: raw.routeFingerprint,
    targetCommand: raw.targetCommand,
    taskSlug: raw.taskSlug,
    branchName: raw.branchName,
    headSha: raw.headSha,
    firstStartedAt: raw.firstStartedAt,
    updatedAt: raw.updatedAt,
    fixReviewLoops: nonNegativeInteger(raw.fixReviewLoops),
    aiReviewRuns: nonNegativeInteger(raw.aiReviewRuns),
    countedReviewRunIds,
  };
  if (raw.lineageVersion === 1) record.lineageVersion = 1;
  if (typeof raw.lineageDigest === 'string') record.lineageDigest = raw.lineageDigest;
  if (typeof raw.lineageFingerprint === 'string') record.lineageFingerprint = raw.lineageFingerprint;
  if (typeof raw.taskBindingId === 'string') record.taskBindingId = raw.taskBindingId;
  if (typeof raw.acceptedFindingsAt === 'string') record.acceptedFindingsAt = raw.acceptedFindingsAt;
  if (typeof raw.acceptedFindingsSource === 'string') record.acceptedFindingsSource = raw.acceptedFindingsSource;
  if (typeof raw.acceptedReviewRunId === 'string') record.acceptedReviewRunId = raw.acceptedReviewRunId;
  if (typeof raw.acceptedAttemptDigest === 'string') record.acceptedAttemptDigest = raw.acceptedAttemptDigest;
  if (typeof raw.lastReviewRunId === 'string') record.lastReviewRunId = raw.lastReviewRunId;
  if (raw.lastReviewStatus === 'passed' || raw.lastReviewStatus === 'failed' || raw.lastReviewStatus === 'pending') {
    record.lastReviewStatus = raw.lastReviewStatus;
  }
  if (typeof raw.pausedAt === 'string') record.pausedAt = raw.pausedAt;
  if (typeof raw.pauseReason === 'string') record.pauseReason = raw.pauseReason;
  if (typeof raw.currentAttemptDigest === 'string') record.currentAttemptDigest = raw.currentAttemptDigest;
  if (Array.isArray(raw.attempts)) {
    const attempts = raw.attempts.filter(isRouteSafetyAttemptRecord).slice(0, 50);
    if (attempts.length > 0) record.attempts = attempts;
  }
  const legacyMigration = normalizeRouteSafetyLegacyMigration(raw.legacyMigration);
  if (legacyMigration) record.legacyMigration = legacyMigration;
  if (Array.isArray(raw.resumes)) {
    const resumes = raw.resumes
      .map(normalizeRouteSafetyResumeRecord)
      .filter((entry): entry is RouteSafetyResumeRecord => entry !== null);
    if (resumes.length > 0) record.resumes = resumes;
  }
  return record;
}

function normalizeRouteSafetyResumeRecord(value: unknown): RouteSafetyResumeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string'
    || typeof raw.recordedAt !== 'string'
    || (raw.source !== 'resume' && raw.source !== 'tty')
    || (
      raw.kind !== 'one-more-loop'
      && raw.kind !== 'more-loops-and-minutes'
      && raw.kind !== 'until-review-passes'
      && raw.kind !== 'accept-findings'
      && raw.kind !== 'legacy-import'
      && raw.kind !== 'legacy-fresh-start'
    )
  ) {
    return null;
  }
  const record: RouteSafetyResumeRecord = {
    id: raw.id,
    kind: raw.kind,
    recordedAt: raw.recordedAt,
    source: raw.source,
  };
  if (raw.oneMoreLoop === true) record.oneMoreLoop = true;
  const moreLoops = positiveConfigInteger(raw.moreLoops);
  if (moreLoops !== undefined) record.moreLoops = moreLoops;
  const moreMinutes = positiveConfigInteger(raw.moreMinutes);
  if (moreMinutes !== undefined) record.moreMinutes = moreMinutes;
  const maxMoreLoops = positiveConfigInteger(raw.maxMoreLoops);
  if (maxMoreLoops !== undefined) record.maxMoreLoops = maxMoreLoops;
  const maxMoreMinutes = positiveConfigInteger(raw.maxMoreMinutes);
  if (maxMoreMinutes !== undefined) record.maxMoreMinutes = maxMoreMinutes;
  if (raw.acceptedFindings === true) record.acceptedFindings = true;
  if (typeof raw.confirmation === 'string') record.confirmation = raw.confirmation;
  if (typeof raw.reason === 'string') record.reason = raw.reason;
  if (raw.legacyMigrationAction === 'import' || raw.legacyMigrationAction === 'fresh-start') {
    record.legacyMigrationAction = raw.legacyMigrationAction;
  }
  if (typeof raw.legacyMigrationSourceDigest === 'string') record.legacyMigrationSourceDigest = raw.legacyMigrationSourceDigest;
  return record;
}

function isRouteSafetyAttemptRecord(value: unknown): value is RouteSafetyAttemptRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.digest === 'string'
    && typeof raw.fingerprint === 'string'
    && typeof raw.headSha === 'string'
    && typeof raw.worktreeStatusDigest === 'string'
    && typeof raw.observedAt === 'string'
    && (raw.reviewRunId === undefined || typeof raw.reviewRunId === 'string');
}

function normalizeRouteSafetyLegacyMigration(value: unknown): RouteSafetyLegacyMigration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.status !== 'pending' && raw.status !== 'imported' && raw.status !== 'fresh-start') return null;
  if (!Array.isArray(raw.candidateDigests) || !raw.candidateDigests.every((entry) => typeof entry === 'string')) return null;
  return {
    status: raw.status,
    candidateDigests: raw.candidateDigests,
    ...(nonNegativeInteger(raw.extraLoops) > 0 ? { extraLoops: nonNegativeInteger(raw.extraLoops) } : {}),
    ...(nonNegativeInteger(raw.extraMinutes) > 0 ? { extraMinutes: nonNegativeInteger(raw.extraMinutes) } : {}),
    ...(typeof raw.decidedAt === 'string' ? { decidedAt: raw.decidedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(typeof raw.sourceDigest === 'string' ? { sourceDigest: raw.sourceDigest } : {}),
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isReviewRunRecord(value: unknown): value is ReviewRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const changedFiles = raw.changedFiles;
  const gates = raw.gates;
  return typeof raw.id === 'string'
    && typeof raw.branchName === 'string'
    && typeof raw.sha === 'string'
    && (raw.status === 'passed' || raw.status === 'failed' || raw.status === 'pending')
    && typeof raw.dryRun === 'boolean'
    && (raw.gateFilter === undefined || typeof raw.gateFilter === 'string')
    && (raw.phaseFilter === undefined || includesString(REVIEW_GATE_PHASES, raw.phaseFilter))
    && typeof raw.startedAt === 'string'
    && typeof raw.finishedAt === 'string'
    && typeof raw.durationMs === 'number'
    && Array.isArray(changedFiles)
    && changedFiles.every((entry) => typeof entry === 'string')
    && (raw.worktreeStatusDigest === undefined || typeof raw.worktreeStatusDigest === 'string')
    && (raw.worktreeStatusReliable === undefined || typeof raw.worktreeStatusReliable === 'boolean')
    && (raw.worktreeMaterialTreeHash === undefined || typeof raw.worktreeMaterialTreeHash === 'string')
    && (raw.worktreeMaterialTreeReliable === undefined || typeof raw.worktreeMaterialTreeReliable === 'boolean')
    && (raw.authorIdentity === undefined || raw.authorIdentity === null || isReviewActorIdentity(raw.authorIdentity))
    && (raw.reviewer === undefined || isReviewActorIdentity(raw.reviewer))
    && (raw.enforcementMode === undefined || raw.enforcementMode === 'legacy-v2' || raw.enforcementMode === 'strict-v3')
    && (raw.policyVersion === undefined || (typeof raw.policyVersion === 'number' && Number.isSafeInteger(raw.policyVersion)))
    && (raw.taskBindingId === undefined || typeof raw.taskBindingId === 'string')
    && (raw.intent === undefined || isReviewIntent(raw.intent))
    && (raw.target === undefined || isReviewTargetManifest(raw.target))
    && (raw.signature === undefined || typeof raw.signature === 'string')
    && (
      raw.worktreeStatusWarnings === undefined
      || (
        Array.isArray(raw.worktreeStatusWarnings)
        && raw.worktreeStatusWarnings.every((entry) => typeof entry === 'string')
      )
    )
    && (
      raw.worktreeMaterialTreeWarnings === undefined
      || (
        Array.isArray(raw.worktreeMaterialTreeWarnings)
        && raw.worktreeMaterialTreeWarnings.every((entry) => typeof entry === 'string')
      )
    )
    && Array.isArray(gates)
    && gates.every(isReviewGateRunRecord);
}

function isReviewActorIdentity(value: unknown): value is ReviewActorIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.provider === 'string'
    && (raw.sessionId === null || typeof raw.sessionId === 'string')
    && typeof raw.source === 'string';
}

function isReviewOverrideRecord(value: unknown): value is ReviewOverrideRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === 'string'
    && typeof raw.command === 'string'
    && typeof raw.reason === 'string'
    && typeof raw.recordedAt === 'string'
    && isReviewActorIdentity(raw.actor)
    && typeof raw.branchName === 'string'
    && typeof raw.sha === 'string'
    && (raw.signature === undefined || typeof raw.signature === 'string');
}

function isReviewConsentRecord(value: unknown): value is ReviewConsentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === 'string'
    && (raw.kind === 'gate-bypass' || raw.kind === 'accept-findings' || raw.kind === 'manual-substitution')
    && typeof raw.gateId === 'string'
    && typeof raw.gateDefinitionHash === 'string'
    && typeof raw.policyVersion === 'number'
    && Number.isSafeInteger(raw.policyVersion)
    && (raw.enforcementMode === 'legacy-v2' || raw.enforcementMode === 'strict-v3')
    && typeof raw.taskBindingId === 'string'
    && (raw.reviewRunId === undefined || typeof raw.reviewRunId === 'string')
    && typeof raw.originalGateState === 'string'
    && typeof raw.branchName === 'string'
    && typeof raw.sha === 'string'
    && typeof raw.worktreeStatusDigest === 'string'
    && typeof raw.worktreeMaterialTreeHash === 'string'
    && typeof raw.reviewTargetDigest === 'string'
    && typeof raw.routeAction === 'string'
    && isReviewActorIdentity(raw.actor)
    && typeof raw.source === 'string'
    && typeof raw.reason === 'string'
    && typeof raw.reasonHash === 'string'
    && typeof raw.recordedAt === 'string'
    && (raw.signature === undefined || typeof raw.signature === 'string');
}

function isReviewAcceptanceRecord(value: unknown): value is ReviewAcceptanceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === 'string'
    && typeof raw.gateId === 'string'
    && typeof raw.gateDefinitionHash === 'string'
    && isAcceptabilityClass(raw.acceptabilityClass)
    && typeof raw.policyVersion === 'number'
    && Number.isSafeInteger(raw.policyVersion)
    && raw.policyVersion >= 0
    && typeof raw.branchName === 'string'
    && typeof raw.sha === 'string'
    && typeof raw.worktreeStatusDigest === 'string'
    && typeof raw.worktreeMaterialTreeHash === 'string'
    && isReviewActorIdentity(raw.actor)
    && typeof raw.source === 'string'
    && typeof raw.reason === 'string'
    && typeof raw.reasonHash === 'string'
    && typeof raw.recordedAt === 'string'
    && (raw.signature === undefined || typeof raw.signature === 'string');
}

function isAcceptabilityClass(value: unknown): value is AcceptabilityClass {
  return value === 'manual-review' || value === 'external-review' || value === 'policy-bypass';
}

function isReviewGateRunRecord(value: unknown): value is ReviewGateRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === 'string'
    && typeof raw.gateId === 'string'
    && includesString(REVIEW_GATE_PHASES, raw.phase)
    && includesString(REVIEW_GATE_TYPES, raw.type)
    && typeof raw.blocking === 'boolean'
    && (raw.status === 'passed' || raw.status === 'failed' || raw.status === 'skipped' || raw.status === 'pending')
    && (raw.attester === undefined || isReviewActorIdentity(raw.attester))
    && (raw.command === undefined || typeof raw.command === 'string')
    && (raw.skill === undefined || typeof raw.skill === 'string')
    && (raw.role === undefined || typeof raw.role === 'string')
    && (raw.when === undefined || typeof raw.when === 'string')
    && (raw.whenChanged === undefined || (Array.isArray(raw.whenChanged) && raw.whenChanged.every((entry) => typeof entry === 'string')))
    && (raw.timeoutMs === undefined || (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs >= 0))
    && (
      raw.userCommands === undefined
      || (
        Array.isArray(raw.userCommands)
        && raw.userCommands.every((entry) => typeof entry === 'string')
      )
    )
    && (raw.profiles === undefined || (Array.isArray(raw.profiles) && raw.profiles.every((entry) => entry === 'docs-only' || entry === 'implementation')))
    && (raw.baselineCommandId === undefined || typeof raw.baselineCommandId === 'string')
    && (raw.replacesBaselineCommandId === undefined || typeof raw.replacesBaselineCommandId === 'string')
    && typeof raw.summary === 'string'
    && (raw.exitCode === undefined || raw.exitCode === null || typeof raw.exitCode === 'number')
    && (raw.signal === undefined || raw.signal === null || typeof raw.signal === 'string')
    && (raw.errorCode === undefined || raw.errorCode === null || typeof raw.errorCode === 'string')
    && (raw.errorMessage === undefined || raw.errorMessage === null || typeof raw.errorMessage === 'string')
    && typeof raw.durationMs === 'number'
    && typeof raw.startedAt === 'string'
    && typeof raw.finishedAt === 'string'
    && (raw.stdoutTail === undefined || typeof raw.stdoutTail === 'string')
    && (raw.stderrTail === undefined || typeof raw.stderrTail === 'string')
    && (raw.capability === undefined || isReviewCapabilityEvidence(raw.capability))
    && (raw.result === undefined || isReviewResultMetadata(raw.result))
    && (raw.findings === undefined || (Array.isArray(raw.findings) && raw.findings.every(isReviewFinding)))
    && (raw.reportArtifact === undefined || isReviewReportArtifactReference(raw.reportArtifact))
    && (raw.skipReason === undefined || typeof raw.skipReason === 'string');
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === 'string'
    && (raw.severity === 'critical' || raw.severity === 'warning' || raw.severity === 'nit')
    && typeof raw.title === 'string'
    && (raw.location === undefined || typeof raw.location === 'string');
}

function isReviewResultMetadata(value: unknown): value is ReviewResultMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (raw.protocolVersion === 0 || raw.protocolVersion === 1)
    && (raw.declaredStatus === 'passed' || raw.declaredStatus === 'failed')
    && (raw.effectiveStatus === 'passed' || raw.effectiveStatus === 'failed')
    && typeof raw.blockingCount === 'number'
    && typeof raw.advisoryCount === 'number'
    && typeof raw.findingsKnown === 'boolean'
    && (raw.providerExitCode === undefined || typeof raw.providerExitCode === 'number')
    && typeof raw.adapterExitCode === 'number';
}

function isReviewCapabilityEvidence(value: unknown): value is ReviewCapabilityEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.requestedCapability === 'string'
    && (raw.effectiveCapability === 'contract-supplied-adapter' || raw.effectiveCapability === 'role-equivalent-adapter' || raw.effectiveCapability === 'manual-attestation' || raw.effectiveCapability === 'unavailable')
    && typeof raw.adapter === 'string'
    && typeof raw.provider === 'string'
    && typeof raw.contractSupplied === 'boolean'
    && typeof raw.wrapperCompatible === 'boolean'
    && (raw.sourceKind === undefined || typeof raw.sourceKind === 'string')
    && (raw.source === undefined || typeof raw.source === 'string')
    && (raw.contractDigest === undefined || typeof raw.contractDigest === 'string')
    && (raw.contractBytes === undefined || typeof raw.contractBytes === 'number');
}

function isReviewReportArtifactReference(value: unknown): value is ReviewReportArtifactReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.path === 'string'
    && typeof raw.digest === 'string'
    && typeof raw.bytes === 'number'
    && typeof raw.reportBytes === 'number'
    && typeof raw.diagnosticsBytes === 'number'
    && typeof raw.reportTruncated === 'boolean'
    && typeof raw.diagnosticsTruncated === 'boolean'
    && (raw.diagnosticOnly === undefined || typeof raw.diagnosticOnly === 'boolean');
}

function isReviewIntent(value: unknown): value is ReviewIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.text === 'string'
    && (raw.source === 'explicit-unbound' || raw.source === 'orchestration-slice' || raw.source === 'task-brief')
    && typeof raw.digest === 'string'
    && (raw.taskBindingId === undefined || typeof raw.taskBindingId === 'string');
}

function isReviewTargetManifest(value: unknown): value is ReviewTargetManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.baseBranchLabel === 'string'
    && typeof raw.baseTipOid === 'string'
    && typeof raw.mergeBaseOid === 'string'
    && typeof raw.headOid === 'string'
    && typeof raw.worktreeStatusDigest === 'string'
    && typeof raw.materialTreeHash === 'string'
    && typeof raw.serializationVersion === 'number'
    && typeof raw.baseTreeManifestDigest === 'string'
    && typeof raw.materialTreeManifestDigest === 'string'
    && typeof raw.changedFilesDigest === 'string'
    && typeof raw.ignorePolicyDigest === 'string'
    && typeof raw.machineFingerprint === 'string'
    && typeof raw.targetDigest === 'string';
}

function acquireReviewStateLock(commonDir: string, config: WorkflowConfig): { release: () => void } {
  return acquireDirectoryStateLock(
    reviewStateLockPath(commonDir, config),
    'review state is locked: another review run is writing evidence. Wait for it to finish and retry.',
  );
}

function acquireDirectoryStateLock(lockPath: string, lockedMessage: string): { release: () => void } {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  clearStaleReviewStateLock(lockPath);
  try {
    mkdirSync(lockPath);
    writeJsonFile(
      path.join(lockPath, 'owner.json'),
      { pid: process.pid, acquiredAt: nowIso() },
    );
    return { release: () => rmSync(lockPath, { recursive: true, force: true }) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      throw new Error(lockedMessage);
    }
    throw new Error(`could not acquire state lock: ${err.message}`);
  }
}

function clearStaleReviewStateLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs <= REVIEW_STATE_LOCK_STALE_MS) return false;
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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

export function newTaskBindingId(): string {
  return `task-binding-${crypto.randomUUID()}`;
}

export function legacyTaskBindingId(config: WorkflowConfig, lock: TaskLock): string {
  return `task-binding-legacy-${crypto.createHash('sha256').update(JSON.stringify({
    projectKey: config.projectKey,
    taskSlug: lock.taskSlug,
    branchName: lock.branchName,
    worktreePath: normalizePath(lock.worktreePath),
    createdBeforeBindingIdsAt: lock.updatedAt,
  })).digest('hex').slice(0, 32)}`;
}

export function ensureTaskBindingId(commonDir: string, config: WorkflowConfig, taskSlug: string): TaskLock | null {
  const lockGuard = acquireTaskBindingLock(commonDir, config, taskSlug);
  try {
    const lock = loadTaskLock(commonDir, config, taskSlug);
    if (!lock || lock.taskBindingId) return lock;
    const taskBindingId = legacyTaskBindingId(config, lock);
    return saveTaskLock(commonDir, config, taskSlug, { ...lock, taskBindingId });
  } finally {
    lockGuard.release();
  }
}

export function updateTaskBinding(
  commonDir: string,
  config: WorkflowConfig,
  taskSlug: string,
  update: (current: TaskLock) => TaskLock,
): TaskLock {
  const lockGuard = acquireTaskBindingLock(commonDir, config, taskSlug);
  try {
    const current = loadTaskLock(commonDir, config, taskSlug);
    if (!current) throw new Error(`No task lock found for ${taskSlug}.`);
    return saveTaskLock(commonDir, config, taskSlug, update(current));
  } finally {
    lockGuard.release();
  }
}

export function saveTaskLock(commonDir: string, config: WorkflowConfig, taskSlug: string, value: TaskLock): TaskLock {
  assertTaskCleanupUnlocked(commonDir, config, taskSlug);
  ensureStateDir(commonDir, config);
  writeVersionedJsonFile('taskLock', taskLockPath(commonDir, config, taskSlug), value);
  return value;
}

function acquireTaskBindingLock(commonDir: string, config: WorkflowConfig, taskSlug: string): { release: () => void } {
  const root = path.join(resolveStateDir(commonDir, config), TASK_BINDING_LOCKS_DIRNAME);
  const lockPath = path.join(root, `${slugifyTaskName(taskSlug)}.lock`);
  mkdirSync(root, { recursive: true });
  try {
    if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > TASK_BINDING_LOCK_STALE_MS) {
      rmSync(lockPath, { recursive: true, force: true });
    }
    mkdirSync(lockPath);
    writeJsonFile(path.join(lockPath, 'owner.json'), { pid: process.pid, acquiredAt: nowIso() });
    return { release: () => rmSync(lockPath, { recursive: true, force: true }) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      throw new Error(`task binding ${taskSlug} is locked by another Pipelane process. Wait and retry.`);
    }
    throw error;
  }
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
    const legacyIgnoredAliasKeys = new Set(['smoke']);
    const unknown = Object.keys(aliases).filter((key) => !known.has(key) && !legacyIgnoredAliasKeys.has(key));
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
    statusOnly: false,
    completedWithIgnored: false,
    safeOrphans: false,
    mergedOrphans: false,
    help: false,
    json: false,
    offline: false,
    unnamed: false,
    override: false,
    plan: false,
    preview: false,
    yes: false,
    skipSmokeCoverage: false,
    patch: false,
    reason: '',
    sha: '',
    pr: '',
    task: '',
    brief: '',
    briefFile: '',
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
    reviewPrint: false,
    reviewListGates: false,
    reviewEnable: [],
    reviewDisable: [],
    reviewInstall: [],
    reviewToggle: [],
    reviewReset: false,
    reviewDryRun: false,
    reviewGate: '',
    reviewPhase: '',
    reviewIntent: '',
    reviewEnforcementMode: '',
    goalSliceId: '',
    goalOutcome: '',
    goalPlanFile: '',
    goalProvider: '',
    goalMaxTurns: '',
    goalMaxMinutes: '',
    orchestrationRunId: '',
    goalSlicesFile: '',
    orchestrationAnalysisFile: '',
    orchestrationDrafts: '',
    scopeThrough: '',
    orchestrationBaseBranch: '',
    orchestrationAbandon: false,
    orchestrationPurgeWorktrees: false,
    orchestrationResealUnsigned: false,
    orchestrationTrustsLocalState: false,
    oneMoreLoop: false,
    moreLoops: '',
    moreMinutes: '',
    untilReviewPasses: false,
    maxMoreLoops: '',
    maxMoreMinutes: '',
    acceptFindings: false,
  };

  const setPrFromShorthand = (raw: string, source: string): void => {
    const normalized = raw.replace(/^#/, '').trim();
    if (!/^[1-9]\d*$/.test(normalized)) {
      throw new Error(`${source} requires a positive PR number. Use --pr <number>.`);
    }
    if (flags.pr && flags.pr !== normalized) {
      throw new Error(`Conflicting PR values: --pr ${flags.pr} and ${source} ${raw}.`);
    }
    flags.pr = normalized;
  };

  const commandAcceptsPrShorthand = (): boolean => {
    const command = positional[0] ?? '';
    if (command === 'merge' || command === 'deploy') return true;
    if (command === 'api') {
      const actionId = positional[1] === 'action' ? positional[2] ?? '' : '';
      return ['merge', 'deploy.staging', 'deploy.prod', 'route.deploy.staging', 'route.deploy.prod'].includes(actionId);
    }
    return false;
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

    const readCsvFlagValues = (flag: string): string[] => {
      const values = [readFlagValue(flag)];
      while (shouldConsumeCsvFlagContinuation(values[values.length - 1], argv[index + 1])) {
        index += 1;
        values.push(argv[index]);
      }
      return splitCsvFlagValue(values.join(' '));
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

    if (flagName === '--completed-with-ignored') {
      rejectInlineValue('--completed-with-ignored');
      flags.completedWithIgnored = true;
      continue;
    }

    if (flagName === '--safe-orphans') {
      rejectInlineValue('--safe-orphans');
      flags.safeOrphans = true;
      continue;
    }

    if (flagName === '--merged-orphans') {
      rejectInlineValue('--merged-orphans');
      flags.mergedOrphans = true;
      continue;
    }

    if (flagName === '--force') {
      rejectInlineValue('--force');
      flags.force = true;
      continue;
    }

    if (flagName === '--status-only') {
      rejectInlineValue('--status-only');
      flags.statusOnly = true;
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

    if (flagName === '--unnamed') {
      rejectInlineValue('--unnamed');
      flags.unnamed = true;
      continue;
    }

    if (flagName === '--override') {
      rejectInlineValue('--override');
      flags.override = true;
      continue;
    }

    if (flagName === '--plan') {
      rejectInlineValue('--plan');
      flags.plan = true;
      continue;
    }

    if (flagName === '--preview') {
      rejectInlineValue('--preview');
      flags.preview = true;
      continue;
    }

    if (flagName === '--yes' || flagName === '-y') {
      rejectInlineValue(flagName);
      flags.yes = true;
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
    if (flagName === '--brief') {
      flags.brief = readFlagValue('--brief');
      continue;
    }
    if (flagName === '--brief-file') {
      flags.briefFile = readFlagValue('--brief-file');
      continue;
    }
    if (flagName === '--one-more-loop') {
      rejectInlineValue('--one-more-loop');
      flags.oneMoreLoop = true;
      continue;
    }
    if (flagName === '--more-loops') {
      flags.moreLoops = readFlagValue('--more-loops').trim();
      continue;
    }
    if (flagName === '--more-minutes') {
      flags.moreMinutes = readFlagValue('--more-minutes').trim();
      continue;
    }
    if (flagName === '--until-review-passes') {
      rejectInlineValue('--until-review-passes');
      flags.untilReviewPasses = true;
      continue;
    }
    if (flagName === '--max-more-loops') {
      flags.maxMoreLoops = readFlagValue('--max-more-loops').trim();
      continue;
    }
    if (flagName === '--max-more-minutes') {
      flags.maxMoreMinutes = readFlagValue('--max-more-minutes').trim();
      continue;
    }
    if (flagName === '--accept-findings') {
      rejectInlineValue('--accept-findings');
      flags.acceptFindings = true;
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

    if (flagName === '--print') {
      rejectInlineValue('--print');
      flags.reviewPrint = true;
      continue;
    }
    if (flagName === '--list-gates') {
      rejectInlineValue('--list-gates');
      flags.reviewListGates = true;
      continue;
    }
    if (flagName === '--enable') {
      flags.reviewEnable.push(...readCsvFlagValues('--enable'));
      continue;
    }
    if (flagName === '--disable') {
      flags.reviewDisable.push(...readCsvFlagValues('--disable'));
      continue;
    }
    if (flagName === '--install') {
      flags.reviewInstall.push(...readCsvFlagValues('--install'));
      continue;
    }
    if (flagName === '--toggle') {
      flags.reviewToggle.push(...readCsvFlagValues('--toggle'));
      continue;
    }
    if (flagName === '--reset') {
      rejectInlineValue('--reset');
      flags.reviewReset = true;
      continue;
    }
    if (flagName === '--dry-run') {
      rejectInlineValue('--dry-run');
      flags.reviewDryRun = true;
      continue;
    }
    if (flagName === '--gate') {
      flags.reviewGate = readFlagValue('--gate').trim();
      continue;
    }
    if (flagName === '--phase') {
      flags.reviewPhase = readFlagValue('--phase').trim();
      continue;
    }
    if (flagName === '--intent') {
      flags.reviewIntent = readFlagValue('--intent');
      continue;
    }
    if (flagName === '--enforcement-mode') {
      flags.reviewEnforcementMode = readFlagValue('--enforcement-mode').trim();
      continue;
    }
    if (flagName === '--slice-id') {
      flags.goalSliceId = readFlagValue('--slice-id').trim();
      continue;
    }
    if (flagName === '--outcome') {
      flags.goalOutcome = readFlagValue('--outcome').trim();
      continue;
    }
    if (flagName === '--plan-file') {
      flags.goalPlanFile = readFlagValue('--plan-file').trim();
      continue;
    }
    if (flagName === '--provider') {
      flags.goalProvider = readFlagValue('--provider').trim();
      continue;
    }
    if (flagName === '--max-turns') {
      flags.goalMaxTurns = readFlagValue('--max-turns').trim();
      continue;
    }
    if (flagName === '--max-minutes') {
      flags.goalMaxMinutes = readFlagValue('--max-minutes').trim();
      continue;
    }
    if (flagName === '--run-id') {
      flags.orchestrationRunId = readFlagValue('--run-id').trim();
      continue;
    }
    if (flagName === '--slices-file') {
      flags.goalSlicesFile = readFlagValue('--slices-file').trim();
      continue;
    }
    if (flagName === '--analysis-file') {
      flags.orchestrationAnalysisFile = readFlagValue('--analysis-file').trim();
      continue;
    }
    if (flagName === '--drafts') {
      flags.orchestrationDrafts = readFlagValue('--drafts').trim();
      continue;
    }
    if (flagName === '--through') {
      flags.scopeThrough = readFlagValue('--through').trim();
      continue;
    }
    if (flagName === '--base-branch') {
      flags.orchestrationBaseBranch = readFlagValue('--base-branch').trim();
      continue;
    }
    if (flagName === '--abandon') {
      rejectInlineValue('--abandon');
      flags.orchestrationAbandon = true;
      continue;
    }
    if (flagName === '--purge-worktrees') {
      rejectInlineValue('--purge-worktrees');
      flags.orchestrationPurgeWorktrees = true;
      continue;
    }
    if (flagName === '--reseal-unsigned') {
      rejectInlineValue('--reseal-unsigned');
      flags.orchestrationResealUnsigned = true;
      continue;
    }
    if (flagName === '--i-understand-this-trusts-local-state') {
      rejectInlineValue('--i-understand-this-trusts-local-state');
      flags.orchestrationTrustsLocalState = true;
      continue;
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown flag "${flagName}" for pipelane run. Run "pipelane run --help" for supported commands and flags.`);
    }

    if (commandAcceptsPrShorthand()) {
      const hashMatch = /^#([1-9]\d*)$/.exec(token);
      if (hashMatch) {
        setPrFromShorthand(hashMatch[1], '#');
        continue;
      }
      if (/^pr$/i.test(token)) {
        const next = argv[index + 1];
        const nextMatch = next ? /^#?([1-9]\d*)$/.exec(next) : null;
        if (!nextMatch) {
          throw new Error('PR shorthand requires a number. Use `--pr 625`; in shells, do not leave `#625` unquoted because `#` starts a comment.');
        }
        setPrFromShorthand(nextMatch[1], 'PR');
        index += 1;
        continue;
      }
    }

    positional.push(token);
  }

  const command = positional[0] ?? '';
  const commandPositionals = positional.slice(1);
  normalizeReviewSetupPositionalToggles(command, commandPositionals, flags);

  return {
    command,
    positional: commandPositionals,
    flags,
  };
}

function normalizeReviewSetupPositionalToggles(command: string, positional: string[], flags: OperatorFlags): void {
  if (command !== 'review' || positional[0] !== 'setup' || positional.length <= 1) {
    return;
  }

  const selections = positional.splice(1);
  for (const selection of selections) {
    flags.reviewToggle.push(...splitCsvFlagValue(selection));
  }
}

function splitCsvFlagValue(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shouldConsumeCsvFlagContinuation(previousValue: string, nextToken: string | undefined): boolean {
  if (nextToken === undefined || nextToken.startsWith('--')) return false;
  const previous = previousValue.trimEnd();
  const next = nextToken.trimStart();
  return previous.endsWith(',') || next === ',' || next.startsWith(',');
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
  const rejectPlanAndYes = (commandLabel: string): void => {
    if (parsed.flags.plan && parsed.flags.yes) {
      throw new Error(`${commandLabel} cannot combine --plan and --yes.`);
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
      assertOnlyFlags(parsed, ['task', 'brief', 'briefFile', 'surfaces', 'offline', 'unnamed', 'force']);
      requireNoPositional('pipelane run new (--task <task-name> | --unnamed) [--brief <objective> | --brief-file <json>] [--surfaces <csv>] [--offline] [--force]');
      if (parsed.flags.task.trim() && parsed.flags.unnamed) {
        throw new Error('new cannot combine --task and --unnamed; provide a task name or explicitly request a generated slug.');
      }
      if (parsed.flags.brief.trim() && parsed.flags.briefFile.trim()) throw new Error('new cannot combine --brief and --brief-file.');
      return;
    case 'adopt':
      assertOnlyFlags(parsed, ['task', 'brief', 'briefFile', 'branch', 'surfaces', 'force']);
      requireNoPositional('pipelane run adopt [--task <task-name>] [--brief <objective> | --brief-file <json>] [--branch <branch>] [--surfaces <csv>] [--force]');
      if (parsed.flags.brief.trim() && parsed.flags.briefFile.trim()) throw new Error('adopt cannot combine --brief and --brief-file.');
      return;
    case 'resume':
      assertOnlyFlags(parsed, ['task', 'oneMoreLoop', 'moreLoops', 'moreMinutes', 'untilReviewPasses', 'maxMoreLoops', 'maxMoreMinutes', 'acceptFindings', 'reason', 'scope']);
      requireNoPositional('pipelane run resume [--task <task-name>] [--one-more-loop | --more-loops <n> --more-minutes <n> | --until-review-passes --max-more-loops <n> --max-more-minutes <n> | --accept-findings]');
      validateResumeRouteSafetyFlags(parsed);
      return;
    case 'repo-guard':
      assertOnlyFlags(parsed, ['task', 'mode', 'surfaces', 'offline']);
      requireNoPositional('pipelane run repo-guard --task <task-name> [--mode build|release] [--surfaces <csv>] [--offline]');
      return;
    case 'pr':
      assertOnlyFlags(parsed, ['task', 'title', 'message', 'forceInclude', 'recover', 'bindingFingerprint', 'override', 'reason', 'plan', 'yes']);
      if (parsed.flags.reason && !parsed.flags.override) {
        throw new Error('pr only accepts --reason together with --override.');
      }
      if (parsed.flags.override && !parsed.flags.reason.trim()) {
        throw new Error('pr --override requires --reason <why review gate evidence is being skipped>.');
      }
      rejectPlanAndYes('pr');
      requireNoPositional('pipelane run pr [--task <task-name>] [--title <title>] [--message <message>] [--force-include <path>] [--override --reason <text>] [--plan|--yes]');
      return;
    case 'merge':
      assertOnlyFlags(parsed, ['task', 'pr', 'title', 'message', 'forceInclude', 'override', 'reason', 'plan', 'yes']);
      requirePositivePrNumber();
      if (parsed.flags.task.trim() && parsed.flags.pr.trim()) {
        throw new Error('merge cannot combine --task and --pr; choose one PR/task identity.');
      }
      if (parsed.flags.reason && !parsed.flags.override) {
        throw new Error('merge only accepts --reason together with --override.');
      }
      if (parsed.flags.override && !parsed.flags.reason.trim()) {
        throw new Error('merge --override requires --reason <why review gate evidence is being skipped>.');
      }
      rejectPlanAndYes('merge');
      requireNoPositional('pipelane run merge [--task <task-name> | --pr <number>] [--title <title>] [--message <message>] [--force-include <path>] [--override --reason <text>] [--plan|--yes]');
      return;
    case 'release-check':
      assertOnlyFlags(parsed, ['surfaces']);
      requireNoPositional('pipelane run release-check [--surfaces <csv>]');
      return;
    case 'release': {
      const subcommand = parsed.positional[0] ?? 'status';
      if (subcommand === 'status') {
        assertOnlyFlags(parsed, ['surfaces']);
        if (parsed.positional.length > 1) failUnexpected('pipelane run release status [--surfaces <csv>]');
        return;
      }
      if (subcommand === 'enable') {
        assertOnlyFlags(parsed, []);
        if (parsed.positional.length > 1) failUnexpected('pipelane run release enable');
        return;
      }
      if (subcommand === 'doctor') {
        assertOnlyFlags(parsed, ['apply']);
        if (parsed.positional.length > 2) failUnexpected('pipelane run release doctor [diagnose|probe|fix|check-guard|--diagnose|--probe|--fix|--check-guard]');
        const mode = parsed.positional[1];
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
          throw new Error(`Unknown release doctor mode "${mode}". Supported modes: diagnose, probe, fix, check-guard.`);
        }
        return;
      }
      throw new Error('release requires one of: status, enable, doctor.');
    }
    case 'task-lock':
      assertOnlyFlags(parsed, ['task', 'mode']);
      if (parsed.positional.length !== 1 || parsed.positional[0] !== 'verify') {
        throw new Error('task-lock requires exactly: pipelane run task-lock verify --task <task-name> [--mode build|release]');
      }
      return;
    case 'deploy':
      assertOnlyFlags(parsed, ['task', 'pr', 'sha', 'surfaces', 'async', 'skipSmokeCoverage', 'reason', 'title', 'message', 'forceInclude', 'plan', 'yes']);
      requirePositivePrNumber();
      if (
        parsed.positional.length > 0
        && parsed.positional[0] !== 'staging'
        && parsed.positional[0] !== 'prod'
        && parsed.positional[0] !== 'production'
      ) {
        throw new Error('deploy requires an environment: staging or prod.');
      }
      if (parsed.flags.skipSmokeCoverage) {
        throw new Error('--skip-smoke-coverage is no longer supported. Pipelane release deploys use deploy verification and healthchecks; QA smoke coverage belongs in a separate QA workflow.');
      }
      if (parsed.flags.reason) {
        throw new Error('deploy does not accept --reason.');
      }
      if (parsed.flags.task.trim() && parsed.flags.pr.trim()) {
        throw new Error('deploy cannot combine --task and --pr; choose one PR/task identity.');
      }
      if (parsed.flags.pr.trim() && parsed.flags.sha.trim()) {
        throw new Error('deploy cannot combine --pr and --sha; --pr deploys the PR merge commit.');
      }
      rejectPlanAndYes('deploy');
      return;
    case 'review': {
      const subcommand = parsed.positional[0] ?? '';
      if (subcommand === 'setup') {
        assertOnlyFlags(parsed, ['reviewPrint', 'reviewListGates', 'reviewEnable', 'reviewDisable', 'reviewInstall', 'reviewToggle', 'reviewReset', 'reviewEnforcementMode', 'yes']);
        if (parsed.positional.length !== 1) {
          throw new Error('review setup requires exactly: pipelane run review setup [gate[,gate...]...] [--yes] [--reset] [--print] [--list-gates] [--toggle <gate[,gate...]>] [--enable <gate[,gate...]>] [--disable <gate[,gate...]>] [--install <gate[,gate...]>]');
        }
        if (parsed.flags.reviewEnforcementMode && parsed.flags.reviewEnforcementMode !== 'legacy-v2' && parsed.flags.reviewEnforcementMode !== 'strict-v3') {
          throw new Error('--enforcement-mode must be legacy-v2 or strict-v3.');
        }
        return;
      }
      if (subcommand === 'pass' || subcommand === 'attest') {
        assertOnlyFlags(parsed, ['reviewGate', 'message']);
        if (parsed.positional.length !== 1) {
          throw new Error('review pass requires exactly: pipelane run review pass --gate <id> --message <what was run and why it is clean>');
        }
        if (!parsed.flags.reviewGate.trim()) {
          throw new Error('review pass requires --gate <id>.');
        }
        if (!parsed.flags.message.trim()) {
          throw new Error('review pass requires --message <what was run and why it is clean>.');
        }
        return;
      }
      if (subcommand === 'override') {
        assertOnlyFlags(parsed, ['reviewGate', 'reason', 'scope']);
        if (parsed.positional.length !== 1) {
          throw new Error('review override requires exactly: pipelane run review override --gate <id> --reason <informed-consent-reason> [--scope <exact-route-action>]');
        }
        if (!parsed.flags.reviewGate.trim()) throw new Error('review override requires --gate <id>.');
        if (!parsed.flags.reason.trim()) throw new Error('review override requires --reason <informed-consent-reason>.');
        return;
      }
      if (subcommand === 'gc') {
        assertOnlyFlags(parsed, []);
        if (parsed.positional.length !== 1) throw new Error('review gc accepts no additional arguments.');
        return;
      }
      assertOnlyFlags(parsed, ['reviewDryRun', 'reviewGate', 'reviewPhase', 'reviewIntent']);
      if (parsed.positional.length > 0) {
        throw new Error('review requires: pipelane run review [--dry-run] [--gate <id>] [--phase static|behavioral|ai-diff|instruction|runtime|human], pipelane run review pass --gate <id> --message <text>, pipelane run review override --gate <id> --reason <text> [--scope <action>], or pipelane run review setup [gate[,gate...]...] [--yes] [--reset] [--print] [--list-gates] [--toggle <gate[,gate...]>] [--enable <gate[,gate...]>] [--disable <gate[,gate...]>] [--install <gate[,gate...]>]');
      }
      const phase = parsed.flags.reviewPhase.trim();
      if (phase && !includesString(REVIEW_GATE_PHASES, phase)) {
        throw new Error(`--phase must be one of: ${REVIEW_GATE_PHASES.join(', ')}.`);
      }
      if (parsed.flags.reviewEnforcementMode && parsed.flags.reviewEnforcementMode !== 'legacy-v2' && parsed.flags.reviewEnforcementMode !== 'strict-v3') {
        throw new Error('--enforcement-mode must be legacy-v2 or strict-v3.');
      }
      return;
    }
    case 'orchestrate': {
      const subcommand = parsed.positional[0] ?? '';
      if (subcommand === '' || subcommand === 'run') {
        assertOnlyFlags(parsed, [
          'goalSliceId',
          'goalOutcome',
          'goalPlanFile',
          'goalProvider',
          'goalMaxTurns',
          'goalMaxMinutes',
          'orchestrationRunId',
          'offline',
          'plan',
          'preview',
          'yes',
          'goalSlicesFile',
          'orchestrationAnalysisFile',
          'orchestrationDrafts',
          'orchestrationBaseBranch',
        ]);
        if (parsed.positional.length > (subcommand === 'run' ? 1 : 0)) {
          throw new Error('orchestrate requires: pipelane run orchestrate [--plan-file <path> | --outcome <text>] [--preview|--plan|--yes] [--analysis-file <path>] [--provider codex|claude|generic] [--max-turns <n>] [--max-minutes <n>], or pipelane run orchestrate <goal-spec|plan|analyze|prepare|dispatch|start|review|plan-review|scope|outline|finalize|upgrade-ledger> ...');
        }
        if (parsed.flags.yes && (parsed.flags.preview || parsed.flags.plan)) {
          throw new Error('orchestrate cannot combine --yes with --preview or --plan.');
        }
        if (parsed.flags.yes && !parsed.flags.goalPlanFile.trim() && !parsed.flags.goalOutcome.trim()) {
          throw new Error('orchestrate --yes requires --plan-file <path> or --outcome <text>.');
        }
        if (parsed.flags.orchestrationDrafts.trim()) {
          throw new Error('orchestrate --drafts is not supported in v1.');
        }
        if (parsed.flags.goalSlicesFile.trim() && !parsed.flags.goalPlanFile.trim()) {
          throw new Error('orchestrate --slices-file requires --plan-file <path>.');
        }
        if (parsed.flags.goalSlicesFile.trim() && !parsed.flags.yes) {
          throw new Error('orchestrate --slices-file is only valid with --yes in the bare orchestrate flow, or with orchestrate analyze/plan.');
        }
        if (parsed.flags.orchestrationAnalysisFile.trim() && !parsed.flags.yes) {
          throw new Error('orchestrate --analysis-file is only valid with --yes in the bare orchestrate flow, or with orchestrate analyze.');
        }
        if (parsed.flags.orchestrationRunId.trim()) {
          const newRunFlags = [
            ['--slice-id', parsed.flags.goalSliceId],
            ['--outcome', parsed.flags.goalOutcome],
            ['--plan-file', parsed.flags.goalPlanFile],
            ['--provider', parsed.flags.goalProvider],
            ['--max-turns', parsed.flags.goalMaxTurns],
            ['--max-minutes', parsed.flags.goalMaxMinutes],
            ['--slices-file', parsed.flags.goalSlicesFile],
            ['--analysis-file', parsed.flags.orchestrationAnalysisFile],
            ['--drafts', parsed.flags.orchestrationDrafts],
            ['--base-branch', parsed.flags.orchestrationBaseBranch],
          ].filter(([, value]) => value.trim()).map(([flag]) => flag);
          if (parsed.flags.offline) newRunFlags.push('--offline');
          if (parsed.flags.plan) newRunFlags.push('--plan');
          if (parsed.flags.preview) newRunFlags.push('--preview');
          if (parsed.flags.yes) newRunFlags.push('--yes');
          if (newRunFlags.length > 0) {
            throw new Error(`orchestrate --run-id only shows an existing run and cannot combine with: ${newRunFlags.join(', ')}.`);
          }
        }
        const provider = parsed.flags.goalProvider.trim();
        if (provider && !includesString(GOAL_PROVIDERS, provider)) {
          throw new Error(`--provider must be one of: ${GOAL_PROVIDERS.join(', ')}.`);
        }
        for (const [flag, value] of [
          ['--max-turns', parsed.flags.goalMaxTurns],
          ['--max-minutes', parsed.flags.goalMaxMinutes],
        ] as const) {
          if (value.trim() && (!/^[1-9]\d*$/.test(value.trim()) || !Number.isSafeInteger(Number.parseInt(value.trim(), 10)))) {
            throw new Error(`${flag} requires a safe positive integer.`);
          }
        }
        return;
      }
      if (subcommand === 'analyze') {
        assertOnlyFlags(parsed, [
          'goalPlanFile',
          'goalSlicesFile',
          'orchestrationRunId',
          'orchestrationAnalysisFile',
          'orchestrationDrafts',
        ]);
        if (parsed.positional.length !== 1) {
          throw new Error('orchestrate analyze requires exactly: pipelane run orchestrate analyze (--plan-file <path> | --run-id <id>) --analysis-file <path> [--slices-file <path>]');
        }
        if (parsed.flags.orchestrationDrafts.trim()) {
          throw new Error('orchestrate analyze --drafts is not supported in v1.');
        }
        if (!parsed.flags.orchestrationAnalysisFile.trim()) {
          throw new Error('orchestrate analyze requires --analysis-file <path>.');
        }
        if (parsed.flags.goalPlanFile.trim() && parsed.flags.orchestrationRunId.trim()) {
          throw new Error('orchestrate analyze cannot combine --plan-file and --run-id.');
        }
        if (!parsed.flags.goalPlanFile.trim() && !parsed.flags.orchestrationRunId.trim()) {
          throw new Error('orchestrate analyze requires --plan-file <path> or --run-id <id>.');
        }
        if (parsed.flags.goalSlicesFile.trim() && !parsed.flags.goalPlanFile.trim()) {
          throw new Error('orchestrate analyze --slices-file requires --plan-file <path>.');
        }
        return;
      }
      if (subcommand === 'plan-review') {
        const action = parsed.positional[1] ?? '';
        if (action !== 'pass' && action !== 'bypass') {
          throw new Error('orchestrate plan-review requires exactly: pipelane run orchestrate plan-review <pass|bypass> --run-id <id> --gate <id> (--message <text> | --reason <text>)');
        }
        assertOnlyFlags(parsed, action === 'pass'
          ? ['orchestrationRunId', 'reviewGate', 'message']
          : ['orchestrationRunId', 'reviewGate', 'reason']);
        if (parsed.positional.length !== 2) {
          throw new Error(`orchestrate plan-review ${action} requires exactly: pipelane run orchestrate plan-review ${action} --run-id <id> --gate <id> ${action === 'pass' ? '--message <text>' : '--reason <text>'}`);
        }
        if (!parsed.flags.orchestrationRunId.trim()) {
          throw new Error(`orchestrate plan-review ${action} requires --run-id <id>.`);
        }
        if (!parsed.flags.reviewGate.trim()) {
          throw new Error(`orchestrate plan-review ${action} requires --gate <id>.`);
        }
        if (action === 'pass' && !parsed.flags.message.trim()) {
          throw new Error('orchestrate plan-review pass requires --message <text>.');
        }
        if (action === 'bypass' && !parsed.flags.reason.trim()) {
          throw new Error('orchestrate plan-review bypass requires --reason <text>.');
        }
        return;
      }
      if (subcommand !== 'goal-spec' && subcommand !== 'plan' && subcommand !== 'prepare' && subcommand !== 'dispatch' && subcommand !== 'start' && subcommand !== 'review' && subcommand !== 'scope' && subcommand !== 'outline' && subcommand !== 'finalize' && subcommand !== 'upgrade-ledger') {
        throw new Error('orchestrate requires exactly: pipelane run orchestrate [--plan-file <path> | --outcome <text>] [--preview|--plan|--yes], or pipelane run orchestrate <goal-spec|plan|analyze|prepare|dispatch|start|review|plan-review|scope|outline|finalize|upgrade-ledger> [--slice-id <id>] [--outcome <text>] [--plan-file <path>] [--slices-file <path>] [--analysis-file <path>] [--run-id <id>] [--through <slice-id>] [--provider codex|claude|generic]');
      }
      if (subcommand === 'scope' || subcommand === 'outline' || subcommand === 'finalize' || subcommand === 'upgrade-ledger') {
        assertOnlyFlags(parsed, subcommand === 'scope'
          ? ['orchestrationRunId', 'scopeThrough']
          : subcommand === 'upgrade-ledger'
            ? ['orchestrationRunId', 'orchestrationResealUnsigned', 'reason', 'orchestrationTrustsLocalState']
            : subcommand === 'finalize'
              ? ['orchestrationRunId', 'orchestrationAbandon', 'orchestrationPurgeWorktrees', 'reason']
              : ['orchestrationRunId']);
        if (parsed.positional.length !== 1) {
          throw new Error(`orchestrate ${subcommand} requires exactly: pipelane run orchestrate ${subcommand} --run-id <id>${subcommand === 'scope' ? ' --through <slice-id>' : subcommand === 'upgrade-ledger' ? ' [--reseal-unsigned --reason <text> --i-understand-this-trusts-local-state]' : ''}`);
        }
        if (!parsed.flags.orchestrationRunId.trim()) {
          throw new Error(`orchestrate ${subcommand} requires --run-id <id>.`);
        }
        if (subcommand === 'scope' && !parsed.flags.scopeThrough.trim()) {
          throw new Error('orchestrate scope requires --through <slice-id>.');
        }
        if (subcommand === 'finalize' && parsed.flags.orchestrationPurgeWorktrees && !parsed.flags.orchestrationAbandon) {
          throw new Error('orchestrate finalize --purge-worktrees requires --abandon.');
        }
        if (subcommand === 'finalize' && parsed.flags.orchestrationPurgeWorktrees && !parsed.flags.reason.trim()) {
          throw new Error('orchestrate finalize --purge-worktrees requires --reason <text>.');
        }
        if (subcommand === 'upgrade-ledger') {
          const resealFlagCount = [
            parsed.flags.orchestrationResealUnsigned,
            parsed.flags.reason.trim().length > 0,
            parsed.flags.orchestrationTrustsLocalState,
          ].filter(Boolean).length;
          if (resealFlagCount > 0 && resealFlagCount < 3) {
            throw new Error('orchestrate upgrade-ledger resealing requires all of: --reseal-unsigned --reason <text> --i-understand-this-trusts-local-state.');
          }
        }
        return;
      }
      if (subcommand === 'prepare' || subcommand === 'dispatch' || subcommand === 'start' || subcommand === 'review') {
        assertOnlyFlags(parsed, subcommand === 'start'
          ? ['orchestrationRunId', 'goalSliceId', 'force']
          : subcommand === 'review'
            ? ['orchestrationRunId', 'goalSliceId', 'reviewDryRun', 'reviewGate', 'reviewPhase']
            : ['orchestrationRunId', 'offline']);
        if (parsed.positional.length !== 1) {
          throw new Error(`orchestrate ${subcommand} requires exactly: pipelane run orchestrate ${subcommand} --run-id <id>${subcommand === 'prepare' ? ' [--offline]' : subcommand === 'start' ? ' [--slice-id <id>] [--force]' : subcommand === 'review' ? ' [--slice-id <id>] [--dry-run] [--gate <id>] [--phase static|behavioral|ai-diff|instruction|runtime|human]' : ''}`);
        }
        if (!parsed.flags.orchestrationRunId.trim()) {
          throw new Error(`orchestrate ${subcommand} requires --run-id <id>.`);
        }
        if (subcommand === 'dispatch' && parsed.flags.offline) {
          throw new Error('orchestrate dispatch does not accept --offline.');
        }
        const phase = parsed.flags.reviewPhase.trim();
        if (subcommand === 'review' && phase && !includesString(REVIEW_GATE_PHASES, phase)) {
          throw new Error(`--phase must be one of: ${REVIEW_GATE_PHASES.join(', ')}.`);
        }
        return;
      }
      assertOnlyFlags(parsed, [
        'goalSliceId',
        'goalOutcome',
        'goalPlanFile',
        'goalProvider',
        'goalMaxTurns',
        'goalMaxMinutes',
        'goalSlicesFile',
        'orchestrationDrafts',
        'orchestrationBaseBranch',
      ]);
      if (parsed.positional.length !== 1) {
        throw new Error(`orchestrate ${subcommand} requires exactly: pipelane run orchestrate ${subcommand} [--slice-id <id>] [--outcome <text>] [--plan-file <path>] [--slices-file <path>] [--provider codex|claude|generic] [--max-turns <n>] [--max-minutes <n>]`);
      }
      if (subcommand === 'plan' && !parsed.flags.goalPlanFile.trim() && !parsed.flags.goalOutcome.trim()) {
        throw new Error('orchestrate plan requires --plan-file <path> or --outcome <text>.');
      }
      if (parsed.flags.orchestrationDrafts.trim()) {
        throw new Error(`orchestrate ${subcommand} --drafts is not supported in v1.`);
      }
      if (parsed.flags.goalSlicesFile.trim()) {
        if (subcommand !== 'plan') {
          throw new Error('orchestrate --slices-file is only valid with: pipelane run orchestrate plan.');
        }
        if (!parsed.flags.goalPlanFile.trim()) {
          throw new Error('orchestrate plan --slices-file requires --plan-file <path>.');
        }
      }
      const provider = parsed.flags.goalProvider.trim();
      if (provider && !includesString(GOAL_PROVIDERS, provider)) {
        throw new Error(`--provider must be one of: ${GOAL_PROVIDERS.join(', ')}.`);
      }
      for (const [flag, value] of [
        ['--max-turns', parsed.flags.goalMaxTurns],
        ['--max-minutes', parsed.flags.goalMaxMinutes],
      ] as const) {
        if (value.trim() && (!/^[1-9]\d*$/.test(value.trim()) || !Number.isSafeInteger(Number.parseInt(value.trim(), 10)))) {
          throw new Error(`${flag} requires a safe positive integer.`);
        }
      }
      return;
    }
    case 'clean': {
      assertOnlyFlags(parsed, [
        'apply',
        'allStale',
        'task',
        'force',
        'statusOnly',
        'completedWithIgnored',
        'safeOrphans',
        'mergedOrphans',
      ]);
      const bulkScopes: Array<'completedWithIgnored' | 'safeOrphans' | 'mergedOrphans'> = [];
      if (parsed.flags.completedWithIgnored) bulkScopes.push('completedWithIgnored');
      if (parsed.flags.safeOrphans) bulkScopes.push('safeOrphans');
      if (parsed.flags.mergedOrphans) bulkScopes.push('mergedOrphans');
      const taskGiven = parsed.flags.task.trim().length > 0;
      const scopeFlagsGiven = parsed.flags.allStale || taskGiven || bulkScopes.length > 0;
      if (parsed.flags.statusOnly && parsed.flags.apply) {
        throw new Error('clean --status-only cannot be combined with --apply.');
      }
      if (parsed.flags.statusOnly && (scopeFlagsGiven || parsed.flags.force)) {
        throw new Error(
          'clean --status-only cannot be combined with --task, --all-stale, --completed-with-ignored, --safe-orphans, --merged-orphans, or --force.',
        );
      }
      if (!parsed.flags.apply && (scopeFlagsGiven || parsed.flags.force)) {
        throw new Error(
          'clean only accepts --task, --all-stale, --completed-with-ignored, --safe-orphans, --merged-orphans, or --force when --apply is also passed.',
        );
      }
      // Bulk scopes are mutually exclusive with each other and with
      // --task/--all-stale. Each names a different category, and combining
      // them would obscure which removals an operator authorized.
      const totalScopes = bulkScopes.length + (parsed.flags.allStale ? 1 : 0) + (taskGiven ? 1 : 0);
      if (totalScopes > 1) {
        // Preserve the original "cannot combine --task and --all-stale"
        // wording for the most-common collision so existing tooling /
        // tests that grep for that phrase continue to match. Other
        // collisions get a more general explanation.
        if (taskGiven && parsed.flags.allStale && bulkScopes.length === 0) {
          throw new Error([
            '/clean --apply cannot combine --task and --all-stale.',
            'Pick one scope so the operator knows what to prune.',
          ].join('\n'));
        }
        throw new Error(
          'clean --apply accepts exactly one scope: --task <slug>, --all-stale, --completed-with-ignored, --safe-orphans, or --merged-orphans.',
        );
      }
      if (parsed.flags.force && !taskGiven) {
        throw new Error(
          'clean --force is only valid with --task <task-name>; the bulk scopes apply per-category safety rules instead.',
        );
      }
      requireNoPositional(
        'pipelane run clean [--status-only | --apply (--task <task-name> [--force]|--all-stale|--completed-with-ignored|--safe-orphans|--merged-orphans)]',
      );
      return;
    }
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
        const taskPrExclusiveActions = new Set([
          'merge',
          'deploy.staging',
          'deploy.prod',
          'route.merge',
          'route.deploy.staging',
          'route.deploy.prod',
        ]);
        const prShaExclusiveActions = new Set([
          'deploy.staging',
          'deploy.prod',
          'route.deploy.staging',
          'route.deploy.prod',
        ]);
        if (
          taskPrExclusiveActions.has(actionId)
          && parsed.flags.task.trim()
          && parsed.flags.pr.trim()
        ) {
          throw new Error(`${actionId} cannot combine --task and --pr; choose one PR/task identity.`);
        }
        if (
          prShaExclusiveActions.has(actionId)
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

function validateResumeRouteSafetyFlags(parsed: ParsedOperatorArgs): void {
  const hasMigrationScope = parsed.flags.scope.trim().length > 0;
  const modes = [
    parsed.flags.oneMoreLoop,
    parsed.flags.moreLoops.trim().length > 0 || parsed.flags.moreMinutes.trim().length > 0,
    parsed.flags.untilReviewPasses || parsed.flags.maxMoreLoops.trim().length > 0 || parsed.flags.maxMoreMinutes.trim().length > 0,
    parsed.flags.acceptFindings || hasMigrationScope,
  ].filter(Boolean).length;
  if (modes === 0) return;
  if (parsed.flags.task.trim()) {
    throw new Error('resume route-loop overrides do not accept --task; run the printed resume command from the paused checkout.');
  }
  if (modes > 1) {
    throw new Error('resume accepts one route-loop override at a time: --one-more-loop, --more-loops/--more-minutes, --until-review-passes, or --accept-findings.');
  }
  if ((parsed.flags.acceptFindings || hasMigrationScope) && !parsed.flags.reason.trim()) {
    throw new Error('resume --accept-findings and legacy migration choices require --reason <informed-consent-reason>.');
  }
  if (parsed.flags.reason.trim() && !parsed.flags.acceptFindings && !hasMigrationScope) {
    throw new Error('resume only accepts --reason with --accept-findings or an explicit legacy migration --scope.');
  }
  if (hasMigrationScope && !/^legacy-(?:import:[a-f0-9]{64}|fresh-start)$/.test(parsed.flags.scope.trim())) {
    throw new Error('resume --scope must be legacy-import:<candidate-digest> or legacy-fresh-start.');
  }
  const requirePositive = (flag: string, value: string): void => {
    if (!/^[1-9]\d*$/.test(value.trim()) || !Number.isSafeInteger(Number.parseInt(value.trim(), 10))) {
      throw new Error(`${flag} requires a safe positive integer.`);
    }
  };
  if (parsed.flags.moreLoops.trim() || parsed.flags.moreMinutes.trim()) {
    if (!parsed.flags.moreLoops.trim() || !parsed.flags.moreMinutes.trim()) {
      throw new Error('resume --more-loops must be combined with --more-minutes.');
    }
    requirePositive('--more-loops', parsed.flags.moreLoops);
    requirePositive('--more-minutes', parsed.flags.moreMinutes);
  }
  if (parsed.flags.untilReviewPasses || parsed.flags.maxMoreLoops.trim() || parsed.flags.maxMoreMinutes.trim()) {
    if (!parsed.flags.untilReviewPasses) {
      throw new Error('resume --max-more-loops and --max-more-minutes require --until-review-passes.');
    }
    if (!parsed.flags.maxMoreLoops.trim() || !parsed.flags.maxMoreMinutes.trim()) {
      throw new Error('resume --until-review-passes requires --max-more-loops and --max-more-minutes.');
    }
    requirePositive('--max-more-loops', parsed.flags.maxMoreLoops);
    requirePositive('--max-more-minutes', parsed.flags.maxMoreMinutes);
  }
}

type OperatorFlagKey = keyof OperatorFlags;

const FLAG_RENDERERS: Array<{ key: OperatorFlagKey; label: string; active: (flags: OperatorFlags) => boolean }> = [
  { key: 'apply', label: '--apply', active: (flags) => flags.apply },
  { key: 'allStale', label: '--all-stale', active: (flags) => flags.allStale },
  { key: 'force', label: '--force', active: (flags) => flags.force },
  { key: 'statusOnly', label: '--status-only', active: (flags) => flags.statusOnly },
  { key: 'completedWithIgnored', label: '--completed-with-ignored', active: (flags) => flags.completedWithIgnored },
  { key: 'safeOrphans', label: '--safe-orphans', active: (flags) => flags.safeOrphans },
  { key: 'mergedOrphans', label: '--merged-orphans', active: (flags) => flags.mergedOrphans },
  { key: 'offline', label: '--offline', active: (flags) => flags.offline },
  { key: 'unnamed', label: '--unnamed', active: (flags) => flags.unnamed },
  { key: 'override', label: '--override', active: (flags) => flags.override },
  { key: 'plan', label: '--plan', active: (flags) => flags.plan },
  { key: 'preview', label: '--preview', active: (flags) => flags.preview },
  { key: 'yes', label: '--yes', active: (flags) => flags.yes },
  { key: 'skipSmokeCoverage', label: '--skip-smoke-coverage', active: (flags) => flags.skipSmokeCoverage },
  { key: 'patch', label: '--patch', active: (flags) => flags.patch },
  { key: 'reason', label: '--reason', active: (flags) => flags.reason.trim().length > 0 },
  { key: 'sha', label: '--sha', active: (flags) => flags.sha.trim().length > 0 },
  { key: 'pr', label: '--pr', active: (flags) => flags.pr.trim().length > 0 },
  { key: 'task', label: '--task', active: (flags) => flags.task.trim().length > 0 },
  { key: 'brief', label: '--brief', active: (flags) => flags.brief.trim().length > 0 },
  { key: 'briefFile', label: '--brief-file', active: (flags) => flags.briefFile.trim().length > 0 },
  { key: 'oneMoreLoop', label: '--one-more-loop', active: (flags) => flags.oneMoreLoop },
  { key: 'moreLoops', label: '--more-loops', active: (flags) => flags.moreLoops.trim().length > 0 },
  { key: 'moreMinutes', label: '--more-minutes', active: (flags) => flags.moreMinutes.trim().length > 0 },
  { key: 'untilReviewPasses', label: '--until-review-passes', active: (flags) => flags.untilReviewPasses },
  { key: 'maxMoreLoops', label: '--max-more-loops', active: (flags) => flags.maxMoreLoops.trim().length > 0 },
  { key: 'maxMoreMinutes', label: '--max-more-minutes', active: (flags) => flags.maxMoreMinutes.trim().length > 0 },
  { key: 'acceptFindings', label: '--accept-findings', active: (flags) => flags.acceptFindings },
  { key: 'branch', label: '--branch', active: (flags) => flags.branch.trim().length > 0 },
  { key: 'file', label: '--file', active: (flags) => flags.file.trim().length > 0 },
  { key: 'title', label: '--title', active: (flags) => flags.title.trim().length > 0 },
  { key: 'message', label: '--message', active: (flags) => flags.message.trim().length > 0 },
  { key: 'recover', label: '--recover', active: (flags) => flags.recover.trim().length > 0 },
  { key: 'bindingFingerprint', label: '--binding-fingerprint', active: (flags) => flags.bindingFingerprint.trim().length > 0 },
  { key: 'mode', label: '--mode', active: (flags) => flags.mode.trim().length > 0 },
  { key: 'scope', label: '--scope', active: (flags) => flags.scope.trim().length > 0 },
  { key: 'reviewIntent', label: '--intent', active: (flags) => flags.reviewIntent.trim().length > 0 },
  { key: 'reviewEnforcementMode', label: '--enforcement-mode', active: (flags) => flags.reviewEnforcementMode.trim().length > 0 },
  { key: 'surfaces', label: '--surfaces', active: (flags) => flags.surfaces.length > 0 },
  { key: 'execute', label: '--execute', active: (flags) => flags.execute },
  { key: 'confirmToken', label: '--confirm-token', active: (flags) => flags.confirmToken.trim().length > 0 },
  { key: 'forceInclude', label: '--force-include', active: (flags) => flags.forceInclude.length > 0 },
  { key: 'async', label: '--async', active: (flags) => flags.async },
  { key: 'week', label: '--week', active: (flags) => flags.week },
  { key: 'stuck', label: '--stuck', active: (flags) => flags.stuck },
  { key: 'blastSha', label: '--blast', active: (flags) => flags.blastSha.trim().length > 0 },
  { key: 'revertPr', label: '--revert-pr', active: (flags) => flags.revertPr },
  { key: 'reviewPrint', label: '--print', active: (flags) => flags.reviewPrint },
  { key: 'reviewListGates', label: '--list-gates', active: (flags) => flags.reviewListGates },
  { key: 'reviewEnable', label: '--enable', active: (flags) => flags.reviewEnable.length > 0 },
  { key: 'reviewDisable', label: '--disable', active: (flags) => flags.reviewDisable.length > 0 },
  { key: 'reviewInstall', label: '--install', active: (flags) => flags.reviewInstall.length > 0 },
  { key: 'reviewToggle', label: '--toggle', active: (flags) => flags.reviewToggle.length > 0 },
  { key: 'reviewReset', label: '--reset', active: (flags) => flags.reviewReset },
  { key: 'reviewDryRun', label: '--dry-run', active: (flags) => flags.reviewDryRun },
  { key: 'reviewGate', label: '--gate', active: (flags) => flags.reviewGate.trim().length > 0 },
  { key: 'reviewPhase', label: '--phase', active: (flags) => flags.reviewPhase.trim().length > 0 },
  { key: 'goalSliceId', label: '--slice-id', active: (flags) => flags.goalSliceId.trim().length > 0 },
  { key: 'goalOutcome', label: '--outcome', active: (flags) => flags.goalOutcome.trim().length > 0 },
  { key: 'goalPlanFile', label: '--plan-file', active: (flags) => flags.goalPlanFile.trim().length > 0 },
  { key: 'goalProvider', label: '--provider', active: (flags) => flags.goalProvider.trim().length > 0 },
  { key: 'goalMaxTurns', label: '--max-turns', active: (flags) => flags.goalMaxTurns.trim().length > 0 },
  { key: 'goalMaxMinutes', label: '--max-minutes', active: (flags) => flags.goalMaxMinutes.trim().length > 0 },
  { key: 'orchestrationRunId', label: '--run-id', active: (flags) => flags.orchestrationRunId.trim().length > 0 },
  { key: 'goalSlicesFile', label: '--slices-file', active: (flags) => flags.goalSlicesFile.trim().length > 0 },
  { key: 'orchestrationAnalysisFile', label: '--analysis-file', active: (flags) => flags.orchestrationAnalysisFile.trim().length > 0 },
  { key: 'orchestrationDrafts', label: '--drafts', active: (flags) => flags.orchestrationDrafts.trim().length > 0 },
  { key: 'scopeThrough', label: '--through', active: (flags) => flags.scopeThrough.trim().length > 0 },
  { key: 'orchestrationBaseBranch', label: '--base-branch', active: (flags) => flags.orchestrationBaseBranch.trim().length > 0 },
  { key: 'orchestrationAbandon', label: '--abandon', active: (flags) => flags.orchestrationAbandon },
  { key: 'orchestrationPurgeWorktrees', label: '--purge-worktrees', active: (flags) => flags.orchestrationPurgeWorktrees },
  { key: 'orchestrationResealUnsigned', label: '--reseal-unsigned', active: (flags) => flags.orchestrationResealUnsigned },
  { key: 'orchestrationTrustsLocalState', label: '--i-understand-this-trusts-local-state', active: (flags) => flags.orchestrationTrustsLocalState },
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
