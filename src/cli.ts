#!/usr/bin/env node

import { accessSync, constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';

import { handlePipelane } from './dashboard/launcher.ts';
import { getDashboardOptions, startDashboardServer } from './dashboard/server.ts';
import { collectBootstrapWarnings, parseBootstrapArgs, runBootstrap } from './operator/bootstrap.ts';
import { installClaudeBootstrapSkill } from './operator/claude-install.ts';
import { installCodexBootstrapSkill } from './operator/codex-install.ts';
import { handleConfigure } from './operator/commands/configure.ts';
import { formatSetupResult, initConsumerRepo, setupConsumerRepo, syncDocsOnly } from './operator/docs.ts';
import { runOperator } from './operator/index.ts';
import { installNpmGuard } from './operator/npm-guard-install.ts';
import { resolveRepoRoot } from './operator/state.ts';
import { bootstrapWorktreeNodeModulesIfNeeded } from './operator/task-workspaces.ts';
import { parseUpdateArgs, runUpdate } from './operator/update.ts';
import { runVerify } from './operator/verify.ts';

function printTopLevelHelp(): void {
  process.stdout.write(`Pipelane - release pipeline management and safety for AI vibe coders

Commands:
  bootstrap [--yes] [--project "Project Name"]
  init --project "Project Name"
  setup
  sync-docs
  configure [--json] [surface flags...]
  install-claude [--verbose]
  install-codex [--verbose]
  install-npm-guard
  verify
  update [--check] [--yes] [--json]
  dashboard [--repo <repo-root>] [--host <host>] [--port <port>]
  board [stop|status] [--repo <repo-root>] [--port <port>] [--no-open]
  run <operator command...>

Examples:
  pipelane bootstrap --project "My Project"
  pipelane install-claude
  pipelane install-npm-guard
  pipelane board
  pipelane board stop
  pipelane update --check
  pipelane dashboard --repo /absolute/path/to/repo
  pipelane run new --task "My Task"
`);
}

function parseProjectArg(args: string[], command: string): string {
  let projectName = '';
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`pipelane ${command} --project "Project Name"\n`);
      process.exit(0);
    }
    if (token === '--project' || token.startsWith('--project=')) {
      const value = token === '--project' ? args[index + 1] ?? '' : token.slice('--project='.length);
      if (token === '--project') index += 1;
      if (!value.trim()) {
        throw new Error(`pipelane ${command} requires --project "Project Name".`);
      }
      projectName = value;
      continue;
    }
    throw new Error(`Unknown flag for pipelane ${command}: ${token}`);
  }
  return projectName;
}

function assertNoArgs(args: string[], command: string): void {
  if (args.length > 0) {
    throw new Error(`pipelane ${command} does not accept arguments: ${args.join(' ')}`);
  }
}

function parseVerboseArg(args: string[], command: string): boolean {
  let verbose = false;
  for (const token of args) {
    if (token === '--verbose') {
      verbose = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write(`pipelane ${command} [--verbose]\n`);
      process.exit(0);
    }
    throw new Error(`Unknown flag for pipelane ${command}: ${token}`);
  }
  return verbose;
}

// Commands that own pipelane setup themselves; auto-bootstrap is irrelevant
// (init/bootstrap) or operates outside the worktree (install-claude/codex
// write to ~/.claude or ~/.codex). Skip the worktree symlink for these so
// we don't surprise users running them in unusual locations.
const SETUP_COMMANDS = new Set(['init', 'bootstrap', 'install-claude', 'install-codex', 'install-npm-guard', 'verify']);

function isExecutablePath(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function maybeReexecRepoLocalPipelane(cwd: string): void {
  if (process.env.PIPELANE_MANAGED_RUNTIME !== '1' || process.env.PIPELANE_RUNNER_REEXECED === '1') {
    return;
  }

  const repoRoot = resolveRepoRoot(cwd, true);
  const localBin = `${repoRoot}/node_modules/.bin/pipelane`;
  if (!existsSync(localBin) || !isExecutablePath(localBin)) {
    return;
  }

  const reexecEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PIPELANE_RUNNER_REEXECED: '1',
  };
  delete reexecEnv.PIPELANE_MANAGED_RUNTIME;
  delete reexecEnv.PIPELANE_MANAGED_RUNTIME_ROOT;

  const result = spawnSync(localBin, process.argv.slice(2), {
    cwd: repoRoot,
    env: reexecEnv,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status === null ? 1 : result.status);
}

async function confirmBootstrapWrites(yes: boolean | undefined): Promise<void> {
  if (yes) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('pipelane bootstrap can write .pipelane.json, .claude/, .agents/, package.json scripts, docs, and other generated repo files. Re-run with --yes after confirming those changes are intended.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('pipelane bootstrap can write .pipelane.json, .claude/, .agents/, package.json scripts, docs, and other generated repo files. Continue? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('pipelane bootstrap cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printTopLevelHelp();
    return;
  }

  // Auto-link shared node_modules into externally-created worktrees (Claude
  // Code worktrees, manual `git worktree add`) so any pipelane command
  // works without a manual symlink step. Same mechanism pipelane:new
  // already uses internally; this just covers worktrees pipelane didn't
  // create. Conservative trigger — only fires when the worktree has no
  // node_modules at all.
  if (!SETUP_COMMANDS.has(command)) {
    const bootstrap = bootstrapWorktreeNodeModulesIfNeeded(process.cwd());
    if (bootstrap.message) {
      process.stderr.write(`${bootstrap.message}\n`);
    }
    maybeReexecRepoLocalPipelane(process.cwd());
  }

  if (command === 'init') {
    const projectName = parseProjectArg(rest, 'init');
    if (!projectName.trim()) {
      throw new Error('pipelane init requires --project "Project Name".');
    }

    const result = initConsumerRepo(process.cwd(), projectName);
    const lines = [
      `Initialized pipelane in ${result.repoRoot}`,
      `Config: ${result.configPath}`,
      'Commit the tracked Pipelane files before using /new from a remote-backed repo.',
      'Next: run setup, then reopen Claude/Codex so slash commands are loaded.',
      'Tracked Codex skills will be written into .agents/skills for the repo.',
    ];
    const warnings = collectBootstrapWarnings(result.repoRoot);
    if (warnings.length > 0) {
      lines.push('Readiness warnings:');
      lines.push(...warnings.map((warning) => `- ${warning}`));
    }
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (command === 'bootstrap') {
    const options = parseBootstrapArgs(rest);
    await confirmBootstrapWrites(options.yes);
    const result = runBootstrap(process.cwd(), options);
    const lines = [
      `Bootstrapped pipelane in ${result.repoRoot}`,
      result.installedPackage ? 'Installed repo-local pipelane dependency.' : 'Reused existing repo-local pipelane dependency.',
      result.initializedRepo
        ? `Initialized tracked Pipelane files for ${result.displayName}.`
        : 'Repo was already pipelane-enabled; refreshed local setup.',
      result.createdClaude ? 'Created local CLAUDE.md from the Pipelane template.' : 'Preserved existing local CLAUDE.md.',
      'Commit the tracked Pipelane files before using /new from a remote-backed repo.',
      'Claude picks up the tracked .claude/commands files after the repo is initialized.',
    ];
    if (result.installedCodexSkills.length > 0) {
      lines.splice(4, 0, `Synced Codex skills in ${result.codexSkillsDir}`, `Slash commands: ${result.installedCodexSkills.join(', ')}`);
      lines.push('Codex picks up the tracked .agents/skills files after the repo is initialized.');
    } else {
      lines.push('Skipped tracked Codex skill sync because syncDocs.codexSkills is false.');
    }
    lines.push('If Claude or Codex was already open, reopen the repo or restart the client to refresh commands and skills.');
    if (result.warnings.length > 0) {
      lines.push('Readiness warnings:');
      lines.push(...result.warnings.map((warning) => `- ${warning}`));
    }
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (command === 'setup') {
    assertNoArgs(rest, 'setup');
    const result = setupConsumerRepo(process.cwd());
    process.stdout.write(formatSetupResult(result).join('\n') + '\n');
    return;
  }

  if (command === 'sync-docs') {
    assertNoArgs(rest, 'sync-docs');
    const result = syncDocsOnly(process.cwd());
    process.stdout.write([
      `Synced Pipelane docs for ${result.repoRoot}`,
      'If command files or Codex skills changed, reopen Claude/Codex so the refreshed commands are visible.',
    ].join('\n') + '\n');
    return;
  }

  if (command === 'configure') {
    await handleConfigure(process.cwd(), rest);
    return;
  }

  if (command === 'update') {
    const options = parseUpdateArgs(rest);
    await runUpdate(process.cwd(), options);
    return;
  }

  if (command === 'install-codex') {
    const verbose = parseVerboseArg(rest, 'install-codex');
    const result = installCodexBootstrapSkill();
    const lines = [
      `Installed ${result.installed.length} durable Pipelane Codex commands in ${result.codexHome}.`,
    ];
    if (result.removedLegacySkills.length > 0) {
      lines.push(`Removed legacy machine-local wrapper skills: ${result.removedLegacySkills.join(', ')}`);
    }
    if (result.skipped.length > 0) {
      lines.push(`Skipped unmanaged optional skills: ${result.skipped.join(', ')}. Use /pipelane-fix.`);
    }
    if (verbose) {
      lines.push(`Commands: ${result.installed.join(', ')}`);
      lines.push(`Runtime: ${result.runtimeRoot}`);
    }
    lines.push('Restart Codex if newly installed commands do not appear in this session.');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (command === 'install-claude') {
    const verbose = parseVerboseArg(rest, 'install-claude');
    const result = installClaudeBootstrapSkill();
    const lines = [`Installed ${result.installed.length} durable Pipelane Claude commands in ${result.claudeHome}.`];
    if (result.skipped.length > 0) {
      lines.push(`Skipped unmanaged optional skills: ${result.skipped.join(', ')}. Use /pipelane-fix.`);
    }
    if (verbose) {
      lines.push(`Commands: ${result.installed.join(', ')}`);
      lines.push(`Runtime: ${result.runtimeRoot}`);
    }
    lines.push('Restart Claude if newly installed skills do not appear in this session.');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (command === 'install-npm-guard') {
    assertNoArgs(rest, 'install-npm-guard');
    const result = installNpmGuard();
    const lines = [`Installed npm guard at ${result.shimPath}`];
    if (result.warnings.length > 0) {
      lines.push('PATH warnings:');
      lines.push(...result.warnings.map((warning) => `- ${warning}`));
      lines.push(`Add this before your Node version manager in shell startup: export PATH="${result.binDir}:$PATH"`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (command === 'verify') {
    assertNoArgs(rest, 'verify');
    const result = runVerify();
    process.stdout.write(`${result.message}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'dashboard') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write('pipelane dashboard [--repo <repo-root>] [--host <host>] [--port <port>]\n');
      return;
    }
    const options = getDashboardOptions(rest, process.cwd());
    await startDashboardServer(options);
    return;
  }

  if (command === 'board') {
    await handlePipelane(rest, process.cwd());
    return;
  }

  if (command === 'run') {
    await runOperator(process.cwd(), rest);
    return;
  }

  throw new Error(`Unknown top-level command "${command}".`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
