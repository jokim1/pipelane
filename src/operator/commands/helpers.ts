import { createHash } from 'node:crypto';

import type { DeployConfig } from '../release-gate.ts';
import type { ApiStatusCell, LaneState } from '../api/envelope.ts';
import type { BranchLanes } from '../api/snapshot.ts';
import type { WorkflowCommand, WorkflowConfig, WorkflowContext } from '../state.ts';
import {
  DEFAULT_MODE,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadTaskLock,
  normalizePath,
  nowIso,
  parseSurfaceList,
  runCommandCapture,
  runGh,
  runGit,
  saveTaskLock,
  slugifyTaskName,
  type DeployRecord,
  type PrRecord,
  type TaskLock,
} from '../state.ts';
import { verifyTaskLockState } from '../repo-guard.ts';

export interface LivePr {
  number: number;
  title: string;
  url: string;
  state?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  mergedAt?: string | null;
}

export function resolveCommandSurfaces(
  context: WorkflowContext,
  explicit: string[] = [],
  fallback: string[] = [],
): string[] {
  if (explicit.length > 0) {
    return parseSurfaceList(context.config, explicit);
  }

  if (fallback.length > 0) {
    return fallback.filter((surface) => context.config.surfaces.includes(surface));
  }

  if (context.modeState.requestedSurfaces.length > 0) {
    return context.modeState.requestedSurfaces.filter((surface) => context.config.surfaces.includes(surface));
  }

  return [...context.config.surfaces];
}

export function inferActiveTaskLock(context: WorkflowContext, explicitTask = ''): { taskSlug: string; lock: TaskLock } {
  if (explicitTask.trim()) {
    const taskSlug = slugifyTaskName(explicitTask);
    const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
    if (!lock) {
      throw new Error(`No task lock found for ${taskSlug}.`);
    }
    return { taskSlug, lock };
  }

  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const repoPath = normalizePath(context.repoRoot);
  const matches = loadAllTaskLocks(context.commonDir, context.config).filter((lock) =>
    lock.branchName === branchName && normalizePath(lock.worktreePath) === repoPath
  );

  if (matches.length === 1) {
    return {
      taskSlug: matches[0].taskSlug,
      lock: matches[0],
    };
  }

  if (matches.length > 1) {
    throw new Error(`Multiple task locks match ${branchName} at ${context.repoRoot}. Pass --task explicitly.`);
  }

  throw new Error(`No task lock matches branch ${branchName} at ${context.repoRoot}. Run ${formatWorkflowCommand(context.config, 'new')} or pass --task.`);
}

export function ensureTaskLockMatchesCurrent(context: WorkflowContext, lock: TaskLock, requestedMode = ''): void {
  const branchName = runGit(context.repoRoot, ['branch', '--show-current']) ?? '';
  const mismatches = verifyTaskLockState({
    branchName,
    repoRoot: context.repoRoot,
    requestedMode,
    currentMode: context.modeState.mode ?? DEFAULT_MODE,
    lock,
  });

  if (mismatches.length > 0) {
    throw new Error([
      'Task lock mismatch.',
      ...mismatches.map((mismatch) => `- ${mismatch}`),
    ].join('\n'));
  }
}

export function latestCommitSubject(repoRoot: string): string {
  return runGit(repoRoot, ['log', '-1', '--pretty=%s']) ?? 'Update workflow task';
}

export function collectChangedPaths(repoRoot: string): string[] {
  // -z disables C-quoting and uses NUL separators, so tabs, newlines,
  // non-ASCII, and literal ` -> ` in filenames round-trip cleanly.
  const raw = runGit(repoRoot, ['status', '--porcelain', '-z'], true) ?? '';
  const entries = raw.split('\0').filter((entry) => entry.length > 0);
  const paths: string[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    // Each record is `XY<space>path`. For renames/copies (-z emits the NEW
    // name first, then the OLD name as a separate NUL-delimited entry),
    // we record the new name and skip the old one.
    const xy = entry.slice(0, 2);
    const payload = entry.length > 3 ? entry.slice(3) : '';
    if (!payload) continue;
    paths.push(payload);
    if (xy[0] === 'R' || xy[0] === 'C') {
      i += 1; // consume the "from" entry that follows
    }
  }

  return paths;
}

export function findDenyListHits(
  paths: string[],
  patterns: string[],
  forceInclude: string[],
): Array<{ path: string; pattern: string }> {
  const forced = new Set(forceInclude.map((entry) => entry.trim()).filter(Boolean));
  const hits: Array<{ path: string; pattern: string }> = [];
  for (const entry of paths) {
    if (forced.has(entry)) continue;
    const basename = entry.includes('/') ? entry.slice(entry.lastIndexOf('/') + 1) : entry;
    for (const pattern of patterns) {
      if (matchesDenyPattern(pattern, basename) || matchesDenyPattern(pattern, entry)) {
        hits.push({ path: entry, pattern });
        break;
      }
    }
  }
  return hits;
}

function matchesDenyPattern(pattern: string, candidate: string): boolean {
  const regex = new RegExp(`^${escapeForDenyRegex(pattern)}$`);
  return regex.test(candidate);
}

function escapeForDenyRegex(pattern: string): string {
  return pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
}

export function hasStagedChanges(repoRoot: string): boolean {
  return Boolean(runGit(repoRoot, ['diff', '--cached', '--name-only'], true)?.trim());
}

interface BaseDriftStatus {
  baseBranch: string;
  upstreamRef: string;
  ahead: number;
  behind: number;
  fetchFailed: boolean;
  fetchError: string;
}

export function buildStaleBaseBlocker(context: WorkflowContext, command: Extract<WorkflowCommand, 'pr' | 'merge'>): string {
  return buildStaleBaseBlockerForRepo({
    repoRoot: context.repoRoot,
    config: context.config,
    command,
  });
}

export function buildStaleBaseBlockerForRepo(options: {
  repoRoot: string;
  config: Pick<WorkflowConfig, 'aliases' | 'baseBranch'>;
  command: Extract<WorkflowCommand, 'pr' | 'merge'>;
}): string {
  const status = inspectBaseDrift(options.repoRoot, options.config.baseBranch);
  if (!status || status.behind <= 0) return '';

  const commandLabel = formatWorkflowCommand(options.config, options.command);
  const commitWord = status.behind === 1 ? 'commit' : 'commits';
  const lines = [
    `${commandLabel} blocked because this checkout is behind ${status.upstreamRef} by ${status.behind} ${commitWord}.`,
    'Rebase before creating, updating, or merging the PR so review only includes this task and does not carry upstream reversions.',
    '',
    'Run:',
    `  git fetch origin ${status.baseBranch}`,
    `  git rebase ${status.upstreamRef}`,
    '',
    `Then re-run ${commandLabel}.`,
  ];
  if (status.fetchFailed) {
    lines.splice(1, 0, `Remote refresh failed (${status.fetchError}); checked the existing ${status.upstreamRef} ref.`);
  }
  return lines.join('\n');
}

function inspectBaseDrift(repoRoot: string, rawBaseBranch: string): BaseDriftStatus | null {
  const baseBranch = rawBaseBranch.trim();
  if (!baseBranch) return null;
  const upstreamRef = `origin/${baseBranch}`;

  const fetch = runCommandCapture('git', ['fetch', 'origin', baseBranch, '--no-tags'], {
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
  const headSha = runCommandCapture('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
  const upstreamSha = runCommandCapture('git', ['rev-parse', '--verify', upstreamRef], { cwd: repoRoot });
  if (!headSha.ok || !headSha.stdout || !upstreamSha.ok || !upstreamSha.stdout) {
    return null;
  }

  const counts = runCommandCapture('git', ['rev-list', '--left-right', '--count', `HEAD...${upstreamRef}`], {
    cwd: repoRoot,
  });
  if (!counts.ok || !counts.stdout.trim()) return null;
  const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? '', 10);
  const behind = Number.parseInt(behindRaw ?? '', 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;

  return {
    baseBranch,
    upstreamRef,
    ahead,
    behind,
    fetchFailed: !fetch.ok,
    fetchError: fetch.stderr || fetch.stdout || `git fetch origin ${baseBranch} --no-tags exited ${fetch.exitCode}`,
  };
}

export function makeIdempotencyKey(options: {
  environment: 'staging' | 'prod';
  sha: string;
  surfaces: string[];
  taskSlug: string;
  // v1.2: rolling the deploy config (healthcheck URL, deploy workflow,
  // staging URL) should force a re-dispatch rather than short-circuit on a
  // stale succeeded record. Include it in the key so different configs
  // produce different keys naturally.
  configFingerprint?: string;
}): string {
  const canonical = JSON.stringify({
    environment: options.environment,
    sha: options.sha,
    surfaces: [...options.surfaces].sort(),
    taskSlug: options.taskSlug,
    configFingerprint: options.configFingerprint ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

// v1.2: per-surface probe URL. Multi-surface staging deploys now probe each
// surface separately so edge/sql can't inherit readiness from a frontend-only
// healthcheck. Returns '' when the surface has no probe configured; the
// caller decides whether to treat that as unverified.
export function resolveSurfaceHealthcheckUrl(
  deployConfig: DeployConfig,
  environment: 'staging' | 'prod',
  surface: string,
): string {
  const staging = environment === 'staging';
  if (surface === 'frontend') {
    const fe = staging ? deployConfig.frontend.staging : deployConfig.frontend.production;
    return fe.healthcheckUrl || fe.url || '';
  }
  if (surface === 'edge') {
    const edge = staging ? deployConfig.edge.staging : deployConfig.edge.production;
    return edge.healthcheckUrl || '';
  }
  if (surface === 'sql') {
    const sql = staging ? deployConfig.sql.staging : deployConfig.sql.production;
    return sql.healthcheckUrl || '';
  }
  if (surface === 'mcp') {
    const mcp = staging ? deployConfig.mcp?.staging : deployConfig.mcp?.production;
    return mcp?.healthcheckUrl || '';
  }
  return '';
}

export function buildPrBody(title: string, checks: string[]): string {
  return [
    '## Summary',
    `- ${title}`,
    '',
    '## Testing',
    ...checks.map((entry) => `- ${entry}`),
  ].join('\n');
}

function parseJsonOrThrow<T>(text: string | null, fallback: string): T {
  if (!text) {
    throw new Error(fallback);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(fallback);
  }
}

export function parsePrNumberFlag(raw: string, flagName = '--pr'): number {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`${flagName} requires a positive PR number.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flagName} requires a safe positive PR number.`);
  }
  return parsed;
}

export function inferTaskSlugsFromBranchName(config: WorkflowConfig, branchName: string): string[] {
  const prefixes = [config.branchPrefix, ...(config.legacyBranchPrefixes ?? []), 'task/', 'codex/']
    .map((prefix) => prefix.trim())
    .filter(Boolean)
    .filter((prefix, index, all) => all.indexOf(prefix) === index)
    .sort((left, right) => right.length - left.length);
  const slugs = new Set<string>();

  for (const prefix of prefixes) {
    if (!branchName.startsWith(prefix)) {
      continue;
    }
    const remainder = branchName.slice(prefix.length);
    if (!remainder) {
      continue;
    }
    const withoutNonce = remainder.replace(/-[a-f0-9]{4}$/i, '');
    const slug = slugifyTaskName(withoutNonce);
    if (slug) {
      slugs.add(slug);
    }
  }

  return [...slugs].sort();
}

export function inferTaskSlugFromBranchName(config: WorkflowConfig, branchName: string): string {
  const slugs = inferTaskSlugsFromBranchName(config, branchName);
  return slugs.length === 1 ? slugs[0] : '';
}

export function deriveTaskSlugFromPr(
  config: WorkflowConfig,
  pr: Pick<LivePr, 'number' | 'headRefName'>,
  fallbackBranchName = '',
): string {
  const branchName = (pr.headRefName ?? '').trim() || fallbackBranchName.trim();
  const canUseBranch = branchName
    && branchName !== config.baseBranch
    && branchName !== 'main'
    && branchName !== 'master';
  if (canUseBranch) {
    return inferTaskSlugFromBranchName(config, branchName) || slugifyTaskName(branchName);
  }
  return `pr-${pr.number}`;
}

export function prRecordFromLivePr(
  pr: LivePr,
  branchName: string,
): Omit<PrRecord, 'taskSlug' | 'updatedAt'> {
  const mergeSha = pr.mergeCommit?.oid?.trim();
  return {
    branchName,
    title: pr.title,
    number: pr.number,
    url: pr.url,
    ...(mergeSha ? { mergedSha: mergeSha } : {}),
    ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
  };
}

export function requireMergedPr(pr: LivePr, commandLabel: string): string {
  const mergeSha = pr.mergeCommit?.oid?.trim();
  if (pr.state !== 'MERGED' || !mergeSha) {
    throw new Error(`${commandLabel} can only use merged PRs. PR #${pr.number} is ${pr.state ?? 'unknown'} and has no merge commit.`);
  }
  return mergeSha;
}

export function loadPrsForBranch(repoRoot: string, branchName: string): LivePr[] {
  const output = runGh(repoRoot, [
    'pr',
    'list',
    '--state',
    'all',
    '--head',
    branchName,
    '--json',
    'number,title,url,state,baseRefName,headRefName,mergeCommit,mergedAt',
  ], true);

  if (!output) {
    return [];
  }

  return parseJsonOrThrow<LivePr[]>(output, `Could not parse PR list for ${branchName}.`);
}

export function loadPrForBranch(repoRoot: string, branchName: string): LivePr | null {
  return selectSinglePr(loadPrsForBranch(repoRoot, branchName), `branch ${branchName}`);
}

export function loadOpenPrForBranch(repoRoot: string, branchName: string): LivePr | null {
  const prs = loadPrsForBranch(repoRoot, branchName)
    .filter((pr) => !pr.state || pr.state === 'OPEN');
  return selectSinglePr(prs, `open PR for branch ${branchName}`);
}

function selectSinglePr(prs: LivePr[], label: string): LivePr | null {
  if (prs.length === 0) {
    return null;
  }

  const open = prs.filter((pr) => pr.state === 'OPEN');
  if (open.length === 1) {
    return open[0];
  }
  if (open.length > 1) {
    throw new Error(`Multiple open pull requests match ${label}. Pass --pr explicitly.`);
  }

  const active = prs.filter((pr) => pr.state && pr.state !== 'CLOSED');
  if (active.length === 1) {
    return active[0];
  }
  if (active.length > 1) {
    throw new Error(`Multiple pull requests match ${label}. Pass --pr explicitly.`);
  }

  if (prs.length === 1) {
    return prs[0];
  }

  throw new Error(`Multiple pull requests match ${label}. Pass --pr explicitly.`);
}

export function loadPrDetails(repoRoot: string, prNumber: number): {
  number: number;
  title: string;
  url: string;
  state?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  mergeCommit?: { oid: string } | null;
  mergedAt?: string | null;
} {
  const output = runGh(repoRoot, [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,url,state,baseRefName,headRefName,mergeCommit,mergedAt',
  ]);
  return parseJsonOrThrow(output, `Could not parse PR details for #${prNumber}.`);
}

export function loadPrByNumber(repoRoot: string, prNumber: number): LivePr {
  const pr = loadPrDetails(repoRoot, prNumber);
  if (pr.number !== prNumber || !pr.title || !pr.url) {
    throw new Error(`No pull request found for #${prNumber}.`);
  }
  return pr;
}

export interface PollForMergedShaOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function pollForMergedSha(
  repoRoot: string,
  prNumber: number,
  options: PollForMergedShaOptions = {},
): Promise<{ sha: string; mergedAt: string | null; title: string; url: string; number: number }> {
  const timeoutMs = options.timeoutMs ?? envNumber('PIPELANE_MERGE_POLL_TIMEOUT_MS', 30_000);
  const intervalMs = options.intervalMs ?? envNumber('PIPELANE_MERGE_POLL_INTERVAL_MS', 1_000);
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  let lastState: string | null = null;
  let lastDetails: ReturnType<typeof loadPrDetails> | null = null;

  while (Date.now() <= deadline) {
    const details = loadPrDetails(repoRoot, prNumber);
    lastDetails = details;
    lastState = details.state ?? null;
    const sha = details.mergeCommit?.oid?.trim();
    if (sha && details.state === 'MERGED') {
      return {
        sha,
        mergedAt: details.mergedAt ?? null,
        title: details.title,
        url: details.url,
        number: details.number,
      };
    }
    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }

  const suffix = lastDetails
    ? ` Last state: ${lastState ?? 'unknown'}, mergeCommit.oid: ${lastDetails.mergeCommit?.oid ?? 'none'}.`
    : '';
  throw new Error(
    `Timed out waiting for GitHub to report PR #${prNumber} as MERGED with a merge commit within ${timeoutMs}ms.${suffix}`,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function watchPrChecks(repoRoot: string, prNumber: number): void {
  const probe = runCommandCapture('gh', ['pr', 'checks', String(prNumber), '--required'], {
    cwd: repoRoot,
  });

  if (!probe.ok && /no required checks reported/i.test(probe.stderr)) {
    runGh(repoRoot, ['pr', 'checks', String(prNumber), '--watch', '--fail-fast']);
    return;
  }

  runGh(repoRoot, ['pr', 'checks', String(prNumber), '--required', '--watch', '--fail-fast']);
}

// v1.5: strip terminal control characters before embedding untrusted
// strings in CLI output. Defends against ANSI injection via fields that
// trace back to outside-the-process inputs — PR titles fetched via
// `gh pr view`, task-lock files that could be hand-edited, and env-derived
// attribution like GITHUB_ACTOR (attacker-controlled under
// pull_request_target). Matches CSI/OSC sequences plus all C0 control
// chars except tab (\x09) and LF (\x0A), DEL (\x7F), and C1 control
// chars (\x80-\x9F). CR (\x0D) is stripped so embedded \r can't return
// the cursor to column 0 and overwrite earlier output.
export function sanitizeForTerminal(raw: string): string {
  if (!raw) return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g, '');
}

// v1.3: persistent breadcrumb for AI↔AI handoff across sessions. Each
// state-mutating command calls this after savePrRecord / saveDeployState
// so `/status` and `/resume` can surface what to do next without the next
// operator re-deriving it from logs. Silently skips when no lock exists —
// `api snapshot` / top-level commands can be exercised outside a task.
export function setNextAction(
  commonDir: string,
  config: WorkflowConfig,
  taskSlug: string,
  text: string,
): TaskLock | null {
  const lock = loadTaskLock(commonDir, config, taskSlug);
  if (!lock) return null;
  return saveTaskLock(commonDir, config, taskSlug, {
    ...lock,
    nextAction: text,
    updatedAt: nowIso(),
  });
}

// Skip-smoke observability flag. Called after a successful `/deploy prod`
// promotion. Sets the TaskLock flag to true iff the promotion occurred
// without staging smoke being configured (operator intentionally skipped);
// otherwise clears the flag so repeat promotions with smoke wired in don't
// carry forward a stale "skipped" label.
export function updatePromotedWithoutStagingSmoke(
  commonDir: string,
  config: WorkflowConfig,
  taskSlug: string,
  skipped: boolean,
): TaskLock | null {
  const lock = loadTaskLock(commonDir, config, taskSlug);
  if (!lock) return null;
  return saveTaskLock(commonDir, config, taskSlug, {
    ...lock,
    promotedWithoutStagingSmoke: skipped ? true : undefined,
    updatedAt: nowIso(),
  });
}

// -------------------------------------------------------------------------
// Smoke readiness + shared handoff helper
// -------------------------------------------------------------------------
//
// `/merge` and `/deploy staging` handoff messages must reflect the smoke
// configuration. Without this, a release-mode repo that has not configured
// smoke gets told "run /smoke staging next" — which immediately blocks with
// a confusing "no smoke command configured" error. The plan's product rule:
// never recommend a command we know cannot run.
//
// The helper returns a plain-text string. Call sites that print wrap it in
// ANSI at print time (or not); `TaskLock.nextAction` stores the bare string
// so `/status` and `/resume` surface the same text. One source of truth.

export function isStagingSmokeConfigured(config: WorkflowConfig): boolean {
  const cmd = config.smoke?.staging?.command;
  return typeof cmd === 'string' && cmd.trim().length > 0;
}

export function isStagingSmokeRequired(config: WorkflowConfig): boolean {
  return config.smoke?.requireStagingSmoke === true;
}

export type SmokeHandoffStage =
  | 'after-merge-release'       // release-mode merge completed; setting up next-action
  | 'after-deploy-staging'      // staging deploy verified; setting up next-action
  | 'before-deploy-prod';       // prod precheck; blocks if required+unconfigured

export interface SmokeHandoffInput {
  config: WorkflowConfig;
  stage: SmokeHandoffStage;
  shortSha?: string;             // used in breadcrumb text after merge / deploy
}

export interface SmokeHandoffMessage {
  nextAction: string;            // bare plain-text (goes to TaskLock.nextAction)
  status: 'configured' | 'optional-unconfigured' | 'required-unconfigured';
  blocks: boolean;               // true iff prod deploy must be refused
}

export function buildSmokeHandoffMessage(input: SmokeHandoffInput): SmokeHandoffMessage {
  const configured = isStagingSmokeConfigured(input.config);
  const required = isStagingSmokeRequired(input.config);
  const setupCmd = formatWorkflowCommand(input.config, 'smoke', 'setup');
  const stagingCmd = formatWorkflowCommand(input.config, 'smoke', 'staging');
  const deployStagingCmd = formatWorkflowCommand(input.config, 'deploy', 'staging');
  const deployProdCmd = formatWorkflowCommand(input.config, 'deploy', 'prod');

  const status: SmokeHandoffMessage['status'] = configured
    ? 'configured'
    : (required ? 'required-unconfigured' : 'optional-unconfigured');

  if (input.stage === 'after-merge-release') {
    const sha = input.shortSha ?? '';
    const merged = sha ? `merged at ${sha}, ` : '';
    if (status === 'configured') {
      return {
        nextAction: `${merged}run ${deployStagingCmd}. After staging verifies, run ${stagingCmd} before ${deployProdCmd}.`,
        status,
        blocks: false,
      };
    }
    if (status === 'required-unconfigured') {
      return {
        nextAction: `${merged}run ${deployStagingCmd}. Smoke is required but not configured — run ${setupCmd} before ${deployProdCmd}.`,
        status,
        blocks: false,
      };
    }
    return {
      nextAction: `${merged}run ${deployStagingCmd}. After staging verifies, run ${setupCmd} to add smoke coverage or ${deployProdCmd} to promote with healthcheck-only evidence.`,
      status,
      blocks: false,
    };
  }

  if (input.stage === 'after-deploy-staging') {
    const sha = input.shortSha ?? '';
    const verified = sha ? `staging verified at ${sha}, ` : '';
    if (status === 'configured') {
      return {
        nextAction: `${verified}run ${stagingCmd}, then ${deployProdCmd}.`,
        status,
        blocks: false,
      };
    }
    if (status === 'required-unconfigured') {
      return {
        nextAction: `${verified}${deployProdCmd} is blocked until smoke is configured and passing. Run ${setupCmd}.`,
        status,
        blocks: false,
      };
    }
    return {
      nextAction: `${verified}run ${setupCmd} to add smoke coverage, or ${deployProdCmd} to promote with healthcheck-only evidence.`,
      status,
      blocks: false,
    };
  }

  // before-deploy-prod — the release-gate precheck. Only blocks on
  // required-unconfigured.
  if (status === 'required-unconfigured') {
    return {
      nextAction: `deploy prod blocked: staging smoke is required but smoke.staging.command is not configured. Run ${setupCmd} --staging-command="<command>" or edit .pipelane.json.`,
      status,
      blocks: true,
    };
  }
  // Configured or optional-unconfigured → caller handles its own gating.
  return {
    nextAction: '',
    status,
    blocks: false,
  };
}

// v0.6: 1-char glyph per canonical lane state. Uses UTF-8 symbols — tested
// terminals render them correctly (macOS Terminal, iTerm2, modern Linux
// terminals, Windows Terminal). Code-page 437/850 cmd.exe will mangle them;
// consumers stuck on legacy Windows should set NO_COLOR and expect `?`-like
// boxes. Mapping mirrors docs/public/PIPELANE_BOARD.md color language for symmetry
// with the web dashboard.
export function renderStateGlyph(state: LaneState): string {
  switch (state) {
    case 'healthy': return '✓';
    case 'running': return '⟳';
    case 'blocked': return '✗';
    case 'degraded': return '!';
    case 'stale': return '~';
    case 'awaiting_preflight': return '·';
    case 'bypassed': return '-';
    case 'unknown':
    default: return '?';
  }
}

// v0.6: fixed 5-lane line per branch. `[Local] [PR] [Base: <base>]
// [Staging] [Production]`. Base label carries the configured base-branch
// name so a consumer on `trunk` doesn't read "Base: main". Lane labels
// stay verbatim so grep-for-state tooling keeps working.
export function renderLaneLine(lanes: BranchLanes, baseBranch: string): string {
  const cells: Array<{ label: string; cell: ApiStatusCell }> = [
    { label: 'Local', cell: lanes.local },
    { label: 'PR', cell: lanes.pr },
    { label: `Base: ${baseBranch}`, cell: lanes.base },
    { label: 'Staging', cell: lanes.staging },
    { label: 'Production', cell: lanes.production },
  ];
  return cells
    .map(({ label, cell }) => `[${label} ${renderStateGlyph(cell.state)}]`)
    .join(' ');
}

export function resolveDeployTargetForTask(options: {
  repoRoot: string;
  baseBranch: string;
  explicitSha: string;
  prRecord: PrRecord | null;
  mode: string;
  config: WorkflowConfig;
}): { sha: string; ref: string } {
  if (options.mode === 'release') {
    if (options.explicitSha.trim()) {
      throw new Error(`Release mode deploys cannot use --sha. Use the recorded merged SHA from ${formatWorkflowCommand(options.config, 'merge')}.`);
    }

    if (!options.prRecord?.mergedSha) {
      throw new Error(`No merged SHA recorded for this task. Run ${formatWorkflowCommand(options.config, 'merge')} first.`);
    }

    return {
      sha: options.prRecord.mergedSha,
      ref: 'pr-state',
    };
  }

  if (options.explicitSha.trim()) {
    const resolved = runGit(options.repoRoot, ['rev-parse', '--verify', options.explicitSha.trim()], true);
    if (!resolved) {
      throw new Error(`Could not resolve ${options.explicitSha.trim()}.`);
    }
    return {
      sha: resolved.trim(),
      ref: '--sha',
    };
  }

  if (options.prRecord?.mergedSha) {
    return {
      sha: options.prRecord.mergedSha,
      ref: 'pr-state',
    };
  }

  const originRef = `origin/${options.baseBranch}`;
  const originSha = runGit(options.repoRoot, ['rev-parse', '--verify', originRef], true);
  if (originSha) {
    return {
      sha: originSha.trim(),
      ref: originRef,
    };
  }

  const localSha = runGit(options.repoRoot, ['rev-parse', '--verify', options.baseBranch], true);
  if (localSha) {
    return {
      sha: localSha.trim(),
      ref: options.baseBranch,
    };
  }

  throw new Error(`Could not resolve a deploy target from ${options.baseBranch}.`);
}

// v1.1: pick the most recent succeeded + verified (2xx) DeployRecord for
// the given environment + surfaces, excluding any sha matching the
// caller's `excludeSha` (the failing current deploy we're rolling back
// from). Matches surfaces by sorted-set equality so a rollback targeting
// [frontend, edge] cannot pick up a [frontend]-only record.
//
// When `configFingerprint` is provided, candidates whose own
// configFingerprint differs are rejected. Without this filter a
// rollback could target a sha that was verified-good under a DIFFERENT
// config (stale staging URL, rotated healthcheck path) — the
// healthcheck that certified the sha may no longer exist. Legacy
// records without a configFingerprint are accepted when the filter is
// set, matching the fail-open posture elsewhere in the release gate.
//
// Returns null when no qualifying earlier record exists. Callers treat
// null as "nothing to roll back to" and abort with a clear error.
export function findLastGoodDeploy(options: {
  records: DeployRecord[];
  environment: 'staging' | 'prod';
  surfaces: string[];
  excludeSha: string;
  configFingerprint?: string;
}): DeployRecord | null {
  const key = [...options.surfaces].sort().join(',');
  // Walk newest-first so we can short-circuit on the first qualifying hit.
  // A DeployRecord appended later in the array is always newer than one
  // earlier in the array — persistRecord preserves write order.
  for (let i = options.records.length - 1; i >= 0; i -= 1) {
    const record = options.records[i];
    if (record.environment !== options.environment) continue;
    if (record.status !== 'succeeded') continue;
    if (!record.sha) continue;
    if (record.sha === options.excludeSha) continue;
    const recordKey = [...(record.surfaces ?? [])].sort().join(',');
    if (recordKey !== key) continue;
    if (options.configFingerprint
      && record.configFingerprint
      && record.configFingerprint !== options.configFingerprint) {
      continue;
    }
    // Require verified (2xx) liveness. v1.2 per-surface verification is
    // preferred. Legacy aggregate `verification.statusCode` is accepted
    // as a fallback ONLY for single-surface rollbacks — a pre-v1.2
    // record has one probe (historically frontend), which can't
    // legitimately verify [frontend, edge] together. Rejecting legacy
    // aggregates on multi-surface rollbacks is the right safety call:
    // operators get a clear "no earlier verified deploy for these
    // surfaces" error and re-run the target deploy with per-surface
    // verification. Codex r6 P2.
    const perSurface = record.verificationBySurface;
    if (perSurface && typeof perSurface === 'object') {
      const allOk = options.surfaces.every((surface) => {
        const code = perSurface[surface]?.statusCode;
        return typeof code === 'number' && code >= 200 && code < 300;
      });
      if (!allOk) continue;
    } else if (options.surfaces.length === 1) {
      const code = record.verification?.statusCode;
      if (typeof code !== 'number' || code < 200 || code >= 300) continue;
    } else {
      // Multi-surface rollback + only aggregate verification → reject.
      continue;
    }
    return record;
  }
  return null;
}
