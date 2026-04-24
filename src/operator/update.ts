import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { detectSetupDrift, formatSetupResult, type SetupDrift, setupConsumerRepo } from './docs.ts';
import { PIPELANE_GITHUB_URL, PIPELANE_REPO_SLUG, resolvePipelaneInstallSpec } from './install-source.ts';
import { resolveRepoRoot, runCommandCapture } from './state.ts';

export interface UpdateOptions {
  check: boolean;
  yes: boolean;
  json: boolean;
}

export interface UpdateStatus {
  repoRoot: string;
  installedSha: string;
  installedShaShort: string;
  latestSha: string;
  latestShaShort: string;
  installedVersion: string;
  upToDate: boolean;
  aheadBy: number | null;
  commits: Array<{ sha: string; subject: string }>;
}

export interface UpdateResult {
  status: UpdateStatus;
  action: 'up-to-date' | 'checked' | 'skipped' | 'installed';
  message: string;
  // Context-aware follow-up: what pipelane:setup would still change on this
  // consumer's disk after the npm install (or right now, for --check). Null
  // when detection couldn't run (missing .pipelane.json, etc.).
  followUpSteps: SetupDrift | null;
  // True iff runUpdate actually invoked setupConsumerRepo before returning
  // (inline setup accepted via prompt or --yes).
  ranSetup: boolean;
}

export function parseUpdateArgs(argv: string[]): UpdateOptions {
  const options: UpdateOptions = { check: false, yes: false, json: false };
  for (const token of argv) {
    if (token === '--check') options.check = true;
    else if (token === '--yes' || token === '-y') options.yes = true;
    else if (token === '--json') options.json = true;
    else if (token === '--help' || token === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown flag for pipelane update: ${token}`);
    }
  }
  return options;
}

export async function runUpdate(cwd: string, options: UpdateOptions): Promise<UpdateResult> {
  const repoRoot = resolveRepoRoot(cwd, true);
  const status = collectUpdateStatus(repoRoot);

  // --check path (pre-install) and upToDate path: run drift detection so the
  // operator sees whether the consumer's working tree is in sync with the
  // currently-installed pipelane, even when no upstream update exists.
  if (options.check || status.upToDate) {
    const driftResult = tryDetectDrift(repoRoot);
    const summary = status.upToDate
      ? `pipelane is up to date (${status.installedShaShort}).`
      : buildStatusMessage(status);
    if (options.json) {
      // JSON mode: no ambient text. Drift hint (if any) travels in the
      // result object's followUpSteps field. If detection failed, the
      // caller sees followUpSteps=null and can act accordingly.
      const result: UpdateResult = {
        status,
        action: status.upToDate ? 'up-to-date' : 'checked',
        message: summary,
        followUpSteps: driftResult.drift,
        ranSetup: false,
      };
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result;
    }
    process.stdout.write(`${summary}\n`);
    emitDriftHint(driftResult);
    return {
      status,
      action: status.upToDate ? 'up-to-date' : 'checked',
      message: summary,
      followUpSteps: driftResult.drift,
      ranSetup: false,
    };
  }

  // Behind main path: print the commit delta, install, detect drift, run
  // setup inline if needed. The user invoked `pipelane update` — that is
  // the consent. For read-only inspection, use `--check`.
  const summary = buildStatusMessage(status);
  if (!options.json) process.stdout.write(`${summary}\n`);

  installLatest(repoRoot);

  const after = collectUpdateStatus(repoRoot);
  const tail = after.upToDate
    ? `Installed ${after.installedShaShort} (up to date).`
    : `Installed pipelane; now at ${after.installedShaShort} (remote main: ${after.latestShaShort}).`;
  const message = `Upgrade complete.\n${tail}`;

  const driftResult = tryDetectDrift(repoRoot);

  if (options.json) {
    const result: UpdateResult = {
      status: after,
      action: 'installed',
      message,
      followUpSteps: driftResult.drift,
      ranSetup: false,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  process.stdout.write(`${message}\n`);
  emitDriftHint(driftResult);

  let ranSetup = false;
  const drift = driftResult.drift;
  if (drift?.needsSetup && drift.claude.collisions.length === 0) {
    const setupResult = setupConsumerRepo(repoRoot);
    process.stdout.write('\n' + formatSetupResult(setupResult).join('\n') + '\n');
    emitReopenHints(drift);
    ranSetup = true;
  }

  return {
    status: after,
    action: 'installed',
    message,
    followUpSteps: drift,
    ranSetup,
  };
}

interface DriftResult {
  drift: SetupDrift | null;
  // Set when detection couldn't run (no .pipelane.json, etc.). Non-JSON
  // callers surface it; JSON mode keeps the channel clean and carries the
  // null via followUpSteps instead.
  error: string | null;
}

function tryDetectDrift(repoRoot: string): DriftResult {
  try {
    return { drift: detectSetupDrift(repoRoot), error: null };
  } catch (error) {
    return { drift: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function emitDriftHint(result: DriftResult): void {
  if (result.error) {
    process.stdout.write(`\n[pipelane] Skipped drift detection: ${result.error}\n`);
    process.stdout.write('Run `pipelane init` or `pipelane bootstrap` to enable setup follow-up.\n');
    return;
  }
  const drift = result.drift;
  if (!drift) return;
  if (!drift.needsSetup) {
    process.stdout.write('\nNo additional steps required — templates are in sync.\n');
    return;
  }
  process.stdout.write('\n' + formatFollowUpSummary(drift) + '\n');
}

function emitReopenHints(drift: SetupDrift): void {
  if (drift.needsReopenClaude) {
    process.stdout.write('Reopen Claude so the new or renamed slash commands appear.\n');
  }
  if (drift.needsReopenCodex) {
    process.stdout.write('Reopen Codex to pick up .agents/skills changes.\n');
  }
}

export function formatFollowUpSummary(drift: SetupDrift): string {
  const lines: string[] = ['Follow-up needed:'];
  const changes: string[] = [];
  if (drift.claude.enabled) {
    const added = truncateList(drift.claude.addedCommands);
    const updated = truncateList(drift.claude.updatedCommands);
    const removed = truncateList(drift.claude.removedLegacyCommands);
    if (added) changes.push(`New slash commands: ${added}`);
    if (updated) changes.push(`Updated commands: ${updated}`);
    if (removed) changes.push(`Legacy commands to prune: ${removed}`);
  }
  if (drift.repoGuidance.willScaffold) {
    changes.push('REPO_GUIDANCE.md scaffold available');
  }
  if (drift.codex.enabled) {
    const added = truncateList(drift.codex.addedSkills);
    const updated = truncateList(drift.codex.updatedSkills);
    const removed = truncateList(drift.codex.removedLegacySkills);
    if (added) changes.push(`New Codex skills: ${added}`);
    if (updated) changes.push(`Updated Codex skills: ${updated}`);
    if (removed) changes.push(`Legacy Codex skills to prune: ${removed}`);
    if (drift.codex.runnerDrift) changes.push('Codex runner script updated');
  }
  if (drift.otherSurfaces.length > 0) {
    changes.push(`Other surfaces to re-render: ${drift.otherSurfaces.join(', ')}`);
  }
  if (drift.claude.collisions.length > 0) {
    // Collisions block setup. Surface them prominently; no "run setup"
    // step, no reopen hint.
    return [
      'Setup cannot run — collision with existing non-pipelane files:',
      ...drift.claude.collisions.map((file) => `  - .claude/commands/${file}`),
      'Resolve these manually (rename, remove, or change the alias in .pipelane.json), then rerun `pipelane update`.',
    ].join('\n');
  }
  lines.push('  1. Run setup to apply template changes:');
  for (const change of changes) {
    lines.push(`     - ${change}`);
  }
  let step = 2;
  if (drift.needsReopenClaude) {
    lines.push(`  ${step++}. Reopen Claude so the new or renamed slash commands appear.`);
  }
  if (drift.needsReopenCodex) {
    lines.push(`  ${step++}. Reopen Codex to pick up .agents/skills changes.`);
  }
  return lines.join('\n');
}

function truncateList(entries: string[], cap = 8): string {
  if (entries.length === 0) return '';
  if (entries.length <= cap) return entries.join(', ');
  return `${entries.slice(0, cap).join(', ')}, +${entries.length - cap} more`;
}

export function collectUpdateStatus(repoRoot: string): UpdateStatus {
  const { installedSha, installedVersion } = resolveInstalledPipelane(repoRoot);
  const latestSha = fetchLatestMainSha();
  const upToDate = Boolean(installedSha) && installedSha === latestSha;

  let aheadBy: number | null = null;
  let commits: Array<{ sha: string; subject: string }> = [];
  if (!upToDate && installedSha) {
    const compare = fetchCompare(installedSha, latestSha);
    if (compare) {
      aheadBy = compare.aheadBy;
      commits = compare.commits;
    }
  }

  return {
    repoRoot,
    installedSha,
    installedShaShort: shortSha(installedSha),
    latestSha,
    latestShaShort: shortSha(latestSha),
    installedVersion,
    upToDate,
    aheadBy,
    commits,
  };
}

function resolveInstalledPipelane(repoRoot: string): { installedSha: string; installedVersion: string } {
  const packagePath = path.join(repoRoot, 'node_modules', 'pipelane', 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(
      `pipelane is not installed in ${repoRoot}. Install it with: npm install --save-dev ${resolvePipelaneInstallSpec()}`,
    );
  }
  const installedVersion = readInstalledVersion(packagePath);
  const installedSha = readInstalledShaFromLock(repoRoot);
  return { installedSha, installedVersion };
}

function readInstalledVersion(packagePath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return parsed.version?.trim() ?? '';
  } catch {
    return '';
  }
}

function readInstalledShaFromLock(repoRoot: string): string {
  const lockPath = path.join(repoRoot, 'package-lock.json');
  if (!existsSync(lockPath)) return '';
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages?: Record<string, { resolved?: string }>;
      dependencies?: Record<string, { resolved?: string }>;
    };
    const entries: Array<{ resolved?: string } | undefined> = [
      parsed.packages?.['node_modules/pipelane'],
      parsed.dependencies?.pipelane,
    ];
    for (const entry of entries) {
      const sha = extractShaFromResolved(entry?.resolved);
      if (sha) return sha;
    }
  } catch {
    // fall through
  }
  return '';
}

function extractShaFromResolved(resolved: string | undefined): string {
  if (!resolved) return '';
  const hashIndex = resolved.lastIndexOf('#');
  if (hashIndex === -1) return '';
  const candidate = resolved.slice(hashIndex + 1).trim();
  return /^[a-f0-9]{7,40}$/i.test(candidate) ? candidate.toLowerCase() : '';
}

function fetchLatestMainSha(): string {
  const result = runCommandCapture('git', ['ls-remote', PIPELANE_GITHUB_URL, 'main']);
  if (!result.ok || !result.stdout) {
    throw new Error(
      `Could not fetch latest main SHA from ${PIPELANE_GITHUB_URL}: ${result.stderr || 'no output'}`,
    );
  }
  const sha = result.stdout.split(/\s+/)[0]?.trim() ?? '';
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`Unexpected git ls-remote output: ${result.stdout}`);
  }
  return sha.toLowerCase();
}

function fetchCompare(
  fromSha: string,
  toSha: string,
): { aheadBy: number; commits: Array<{ sha: string; subject: string }> } | null {
  const result = runCommandCapture('gh', [
    'api',
    `repos/${PIPELANE_REPO_SLUG}/compare/${fromSha}...${toSha}`,
  ]);
  if (!result.ok || !result.stdout) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      ahead_by?: number;
      commits?: Array<{ sha: string; commit: { message: string } }>;
    };
    const commits = (parsed.commits ?? []).map((entry) => ({
      sha: entry.sha,
      subject: entry.commit.message.split('\n', 1)[0] ?? '',
    }));
    return { aheadBy: parsed.ahead_by ?? commits.length, commits };
  } catch {
    return null;
  }
}

function installLatest(repoRoot: string): void {
  const result = runCommandCapture('npm', ['install', resolvePipelaneInstallSpec()], { cwd: repoRoot });
  if (!result.ok) {
    const detail = result.stderr || result.stdout;
    throw new Error(`npm install failed:\n${detail}`);
  }
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
}

function buildStatusMessage(status: UpdateStatus): string {
  if (status.upToDate) {
    return `pipelane is up to date (${status.installedShaShort}).`;
  }

  const lines = [
    `pipelane has updates available.`,
    `  Installed: ${status.installedShaShort || '(unknown sha)'} (v${status.installedVersion || '?'})`,
    `  Latest main: ${status.latestShaShort}`,
  ];
  if (status.aheadBy !== null) {
    lines.push(`  ${status.aheadBy} commit${status.aheadBy === 1 ? '' : 's'} ahead.`);
  }
  if (status.commits.length > 0) {
    lines.push('');
    lines.push('Commits since install:');
    for (const commit of status.commits.slice(0, 20)) {
      lines.push(`  ${commit.sha.slice(0, 7)} ${commit.subject}`);
    }
    if (status.commits.length > 20) {
      lines.push(`  … (+${status.commits.length - 20} more)`);
    }
  }
  return lines.join('\n');
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : '';
}

function printUsage(): void {
  process.stdout.write(`pipelane update — check for and install the latest pipelane from jokim1/pipelane#main

Usage:
  pipelane update           Check and install if behind; auto-run setup if needed
  pipelane update --check   Report status without mutating
  pipelane update --json    Emit JSON status/result; never auto-runs setup
  pipelane update --yes     Backward-compat no-op (update no longer prompts)
`);
}
