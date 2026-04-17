import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

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
}

const PIPELANE_GITHUB_URL = 'https://github.com/jokim1/pipelane.git';
const PIPELANE_REPO_SLUG = 'jokim1/pipelane';
const PIPELANE_GITHUB_SPEC = 'pipelane@github:jokim1/pipelane#main';

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

  if (options.json && (options.check || status.upToDate)) {
    const result: UpdateResult = {
      status,
      action: status.upToDate ? 'up-to-date' : 'checked',
      message: buildStatusMessage(status),
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  if (status.upToDate) {
    const message = `pipelane is up to date (${status.installedShaShort}).`;
    if (!options.json) process.stdout.write(`${message}\n`);
    return { status, action: 'up-to-date', message };
  }

  const summary = buildStatusMessage(status);
  if (!options.json) process.stdout.write(`${summary}\n`);

  if (options.check) {
    return { status, action: 'checked', message: summary };
  }

  const confirmed = options.yes || (await promptYesNo('Upgrade now? [y/N] '));
  if (!confirmed) {
    const message = 'Upgrade skipped.';
    process.stdout.write(`${message}\n`);
    return { status, action: 'skipped', message };
  }

  installLatest(repoRoot);

  const after = collectUpdateStatus(repoRoot);
  const tail = after.upToDate
    ? `Installed ${after.installedShaShort} (up to date).`
    : `Installed pipelane; now at ${after.installedShaShort} (remote main: ${after.latestShaShort}).`;
  const message = `Upgrade complete.\n${tail}`;
  if (options.json) {
    const result: UpdateResult = { status: after, action: 'installed', message };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  process.stdout.write(`${message}\n`);
  return { status: after, action: 'installed', message };
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
      `pipelane is not installed in ${repoRoot}. Install it with: npm install --save-dev pipelane@github:jokim1/pipelane#main`,
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
  const result = runCommandCapture('npm', ['install', PIPELANE_GITHUB_SPEC], { cwd: repoRoot });
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

async function promptYesNo(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printUsage(): void {
  process.stdout.write(`pipelane update — check for and install the latest pipelane from jokim1/pipelane#main

Usage:
  pipelane update           Check, prompt, and upgrade
  pipelane update --check   Report status without mutating
  pipelane update --yes     Skip the prompt (for CI / non-TTY)
  pipelane update --json    Emit JSON status/result
`);
}
