import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readPackageJsonOverlay, resolveReadableConfigPath, resolveRepoRoot, runCommandCapture } from './state.ts';
import { resolvePipelaneInstallSpec } from './install-source.ts';

export interface BootstrapOptions {
  projectName?: string;
  yes?: boolean;
}

export interface BootstrapResult {
  repoRoot: string;
  displayName: string;
  installedPackage: boolean;
  initializedRepo: boolean;
  createdClaude: boolean;
  codexSkillsDir: string;
  installedCodexSkills: string[];
  warnings: string[];
}

function hasPipelaneDependency(repoRoot: string): boolean {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.pipelane ||
      pkg.devDependencies?.pipelane ||
      pkg.optionalDependencies?.pipelane,
    );
  } catch {
    return false;
  }
}

function localPipelaneInstalled(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'));
}

function inferProjectName(repoRoot: string, provided: string | undefined): string {
  const trimmed = provided?.trim() ?? '';
  return trimmed || path.basename(repoRoot);
}

function runOrThrow(repoRoot: string, command: string, args: string[]): { stdout: string; stderr: string } {
  const result = runCommandCapture(command, args, { cwd: repoRoot, env: process.env });
  if (!result.ok) {
    const rendered = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(rendered || `${command} ${args.join(' ')} failed in ${repoRoot}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function runLocalPipelane(repoRoot: string, args: string[]): string {
  const result = runOrThrow(repoRoot, 'npx', ['--no-install', 'pipelane', ...args]);
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function parseSetupOutput(stdout: string): { createdClaude: boolean; codexSkillsDir: string; installedCodexSkills: string[] } {
  const createdClaude = stdout.includes('Created local CLAUDE.md from the Pipelane template.');
  const codexSkillsDir = stdout.match(/Synced Codex skills in (.+)/)?.[1]?.trim() ?? '';
  const wrapperCsv = stdout.match(/Slash commands: (.+)/)?.[1]?.trim() ?? '';
  const installedCodexSkills = wrapperCsv
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { createdClaude, codexSkillsDir, installedCodexSkills };
}

function readDisplayName(repoRoot: string): string {
  const configPath = resolveReadableConfigPath(repoRoot);
  if (configPath) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { displayName?: string };
      const fromFile = parsed.displayName?.trim();
      if (fromFile) return fromFile;
    } catch {
      // fall through to overlay / basename
    }
  }
  const overlay = readPackageJsonOverlay(repoRoot);
  const fromOverlay = typeof overlay?.displayName === 'string' ? overlay.displayName.trim() : '';
  if (fromOverlay) return fromOverlay;
  return path.basename(repoRoot);
}

function readBaseBranch(repoRoot: string): string {
  const configPath = resolveReadableConfigPath(repoRoot);
  if (configPath) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { baseBranch?: string };
      const fromFile = parsed.baseBranch?.trim();
      if (fromFile) return fromFile;
    } catch {
      // fall through to overlay / default
    }
  }
  const overlay = readPackageJsonOverlay(repoRoot);
  const fromOverlay = typeof overlay?.baseBranch === 'string' ? overlay.baseBranch.trim() : '';
  if (fromOverlay) return fromOverlay;
  return 'main';
}

export function collectBootstrapWarnings(repoRoot: string): string[] {
  const baseBranch = readBaseBranch(repoRoot);
  const warnings: string[] = [];
  const gitRepo = runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot });

  if (!gitRepo.ok) {
    warnings.push(
      'No git repository detected. `bootstrap` scaffolded the files successfully, but `/new`, `/pr`, `/merge`, and `/deploy` require a git repo. Clone the target repo or run `git init -b main` before using the workflow.',
    );
    return warnings;
  }

  const head = runCommandCapture('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
  if (!head.ok) {
    warnings.push(
      `This repo has no commits yet. Create the initial \`${baseBranch}\` commit before using \`/new\` so task worktrees have a real base to branch from.`,
    );
  }

  const origin = runCommandCapture('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
  if (!origin.ok) {
    warnings.push(
      `No \`origin\` remote detected. \`/new\` refreshes \`origin/${baseBranch}\` by default and will fail until that remote exists and the base branch is pushed. If you intentionally want a local-only flow, rerun \`/new --offline\`.`,
    );
  }

  return warnings;
}

export function parseBootstrapArgs(argv: string[]): BootstrapOptions {
  const options: BootstrapOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project' || token.startsWith('--project=')) {
      const value = token === '--project' ? argv[index + 1] ?? '' : token.slice('--project='.length);
      if (token === '--project') index += 1;
      if (!value.trim()) {
        throw new Error('pipelane bootstrap --project requires a non-empty value.');
      }
      options.projectName = value;
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write('pipelane bootstrap [--yes] [--project "Project Name"]\n');
      process.exit(0);
    }
    if (token === '--yes' || token === '-y') {
      options.yes = true;
      continue;
    }
    throw new Error(`Unknown flag for pipelane bootstrap: ${token}`);
  }
  return options;
}

export function runBootstrap(cwd: string, options: BootstrapOptions): BootstrapResult {
  const repoRoot = resolveRepoRoot(cwd, true);
  // Treat the repo as already pipelane-enabled when either the tracked
  // config file exists OR a `pipelane` overlay is declared in
  // `package.json`. The overlay case lets consumers who gitignore
  // `.pipelane.json` skip the file-writing `init` step on every fresh
  // worktree — `pipelane setup` now self-heals from the overlay.
  const hasOverlay = readPackageJsonOverlay(repoRoot) !== null;
  const initializedRepo = !resolveReadableConfigPath(repoRoot) && !hasOverlay;
  const projectName = inferProjectName(repoRoot, options.projectName);

  let installedPackage = false;
  if (!localPipelaneInstalled(repoRoot)) {
    const installArgs = hasPipelaneDependency(repoRoot)
      ? ['install']
      : ['install', '--save-dev', resolvePipelaneInstallSpec()];
    runOrThrow(repoRoot, 'npm', installArgs);
    installedPackage = true;
  }

  if (initializedRepo) {
    runLocalPipelane(repoRoot, ['init', '--project', projectName]);
  }

  const setupOutput = runLocalPipelane(repoRoot, ['setup']);
  const parsedSetup = parseSetupOutput(setupOutput);

  return {
    repoRoot,
    displayName: readDisplayName(repoRoot),
    installedPackage,
    initializedRepo,
    createdClaude: parsedSetup.createdClaude,
    codexSkillsDir: parsedSetup.codexSkillsDir,
    installedCodexSkills: parsedSetup.installedCodexSkills,
    warnings: collectBootstrapWarnings(repoRoot),
  };
}
