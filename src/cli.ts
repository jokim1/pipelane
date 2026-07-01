#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { handlePipelane } from './dashboard/launcher.ts';
import { getDashboardOptions, startDashboardServer } from './dashboard/server.ts';
import { installClaudeBootstrapSkill } from './operator/claude-install.ts';
import { installCodexBootstrapSkill } from './operator/codex-install.ts';
import { handleConfigure } from './operator/commands/configure.ts';
import {
  applyAgentsGuidanceMigrationsWithApproval,
  applyClaudeGuidanceMigrationsWithApproval,
  applyLessonsMigrationWithApproval,
  formatSetupResult,
  setupConsumerRepo,
  type SetupConsumerRepoResult,
} from './operator/docs.ts';
import { runOperator } from './operator/index.ts';
import { installNpmGuard } from './operator/npm-guard-install.ts';
import { loadDeployConfig } from './operator/release-gate.ts';
import { resolveRepoRoot } from './operator/state.ts';
import { bootstrapWorktreeNodeModulesIfNeeded } from './operator/task-workspaces.ts';
import { parseUpdateArgs, runUpdate } from './operator/update.ts';
import { runVerify } from './operator/verify.ts';

function printTopLevelHelp(): void {
  process.stdout.write(`Pipelane - build, release, and development orchestration for AI-assisted codebases

Commands:
  setup [--yes]
  configure [--json] [surface flags...]
  update [--check] [--yes] [--json]
  install-claude [--verbose]
  install-codex [--verbose]
  install-npm-guard
  verify
  dashboard [--repo <repo-root>] [--host <host>] [--port <port>]
  board [stop|status] [--repo <repo-root>] [--port <port>] [--no-open]
  review [review args...]
  run <operator command...>

Examples:
  pipelane install-codex
  pipelane install-claude
  pipelane install-npm-guard
  pipelane setup
  pipelane configure
  pipelane board
  pipelane board stop
  pipelane update --check
  pipelane dashboard --repo /absolute/path/to/repo
  pipelane review setup C4
  pipelane run new --task "My Task"
  pipelane run new --unnamed
`);
}

function assertNoArgs(args: string[], command: string): void {
  if (args.length > 0) {
    throw new Error(`pipelane ${command} does not accept arguments: ${args.join(' ')}`);
  }
}

function parseSetupArgs(args: string[]): { yes: boolean } {
  let yes = false;
  for (const token of args) {
    if (token === '--yes' || token === '-y') {
      yes = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write('pipelane setup [--yes]\n');
      process.exit(0);
    }
    throw new Error(`Unknown flag for pipelane setup: ${token}`);
  }
  return { yes };
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

// Commands that operate outside the worktree. Skip the worktree symlink for
// these so we don't surprise users running them in unusual locations.
const SKIP_WORKTREE_BOOTSTRAP_COMMANDS = new Set(['init', 'bootstrap', 'install-claude', 'install-codex', 'install-npm-guard', 'verify']);

function repoLocalPipelanePackageExists(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'));
}

function legacyRepoLocalInstallNoticeLines(cwd: string): string[] {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(cwd, true);
  } catch {
    repoRoot = cwd;
  }
  if (!repoLocalPipelanePackageExists(repoRoot)) {
    return [];
  }
  return [`Ignored legacy repo-local Pipelane install in ${repoRoot}/node_modules; durable commands use the machine-local runtime.`];
}

// Per-alias guidance for an optional skill whose name collided with a pre-existing
// unmanaged skill (so install skipped it). /fix and /orchestrate have always-installed
// pipelane-namespaced equivalents; anything else just needs the conflict resolved.
function skippedSkillFallback(slashAlias: string): string {
  if (slashAlias === '/fix') return 'use /pipelane-fix';
  if (slashAlias === '/orchestrate') return 'use /pipelane orchestrate';
  return 'rename or remove the conflicting skill and re-run install';
}

function formatSkippedSkillsLine(skipped: string[]): string {
  const parts = skipped.map((alias) => `${alias} (${skippedSkillFallback(alias)})`);
  return `Skipped unmanaged optional skills (a non-pipelane skill of the same name exists): ${parts.join('; ')}.`;
}

function repoLocalAdapterUnsupportedMessage(command: string): string {
  return [
    `pipelane ${command} is no longer supported.`,
    'Pipelane has one supported setup path: durable machine-local commands plus local runtime config.',
    'Run `pipelane install-codex` or `pipelane install-claude` once per machine.',
    'Then run `pipelane setup`, `pipelane review setup`, and `pipelane configure` from each repo as needed.',
    'Pipelane no longer scaffolds tracked repo-local adapters or package.json workflow scripts.',
  ].join('\n');
}

function handleUnsupportedRepoLocalAdapterCommand(command: string, args: string[]): void {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${repoLocalAdapterUnsupportedMessage(command)}\n`);
    return;
  }
  throw new Error(repoLocalAdapterUnsupportedMessage(command));
}

async function maybeOfferConfigureAfterBootstrap(repoRoot: string): Promise<void> {
  if (loadDeployConfig(repoRoot) || !process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Deploy Configuration is still empty. Configure deploy targets now? [Y/n] ')).trim().toLowerCase();
    if (answer === 'n' || answer === 'no') {
      process.stdout.write('Next: run `/pipelane configure` before the first /deploy.\n');
      return;
    }
  } finally {
    rl.close();
  }
  await handleConfigure(repoRoot, []);
}

async function maybeApplyGuidanceMigrationsAfterPrompt(
  result: SetupConsumerRepoResult,
  yes: boolean,
): Promise<SetupConsumerRepoResult> {
  const appliedAgents = await applyAgentsGuidanceMigrationsWithApproval(result.agentsGuidanceMigrations, { yes });
  const appliedClaude = await applyClaudeGuidanceMigrationsWithApproval(result.claudeGuidanceMigrations, { yes });
  if (appliedAgents.length === 0 && appliedClaude.length === 0) {
    return result;
  }
  return {
    ...result,
    agentsGuidanceMigrations: appliedAgents.length > 0 ? [] : result.agentsGuidanceMigrations,
    appliedAgentsGuidanceMigrations: [
      ...result.appliedAgentsGuidanceMigrations,
      ...appliedAgents,
    ],
    claudeGuidanceMigrations: appliedClaude.length > 0 ? [] : result.claudeGuidanceMigrations,
    appliedClaudeGuidanceMigrations: [
      ...result.appliedClaudeGuidanceMigrations,
      ...appliedClaude,
    ],
  };
}

async function maybeApplyLessonsMigrationAfterPrompt(
  result: SetupConsumerRepoResult,
  yes: boolean,
): Promise<SetupConsumerRepoResult> {
  const applied = await applyLessonsMigrationWithApproval(result.lessonsMigration, { yes });
  if (!applied) {
    return result;
  }
  return {
    ...result,
    lessonsMigration: null,
    appliedLessonsMigration: applied,
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printTopLevelHelp();
    return;
  }

  if (command === 'init' || command === 'bootstrap' || command === 'sync-docs') {
    handleUnsupportedRepoLocalAdapterCommand(command, rest);
    return;
  }

  // Auto-link shared node_modules into externally-created worktrees (Claude
  // Code worktrees, manual `git worktree add`) so any pipelane command
  // works without a manual symlink step. Same mechanism pipelane:new
  // already uses internally; this just covers worktrees pipelane didn't
  // create. Conservative trigger — only fires when the worktree has no
  // node_modules at all.
  if (!SKIP_WORKTREE_BOOTSTRAP_COMMANDS.has(command)) {
    const bootstrap = bootstrapWorktreeNodeModulesIfNeeded(process.cwd());
    if (bootstrap.message) {
      process.stderr.write(`${bootstrap.message}\n`);
    }
  }
  if (command === 'setup') {
    const options = parseSetupArgs(rest);
    let result = setupConsumerRepo(process.cwd());
    result = await maybeApplyGuidanceMigrationsAfterPrompt(result, options.yes);
    result = await maybeApplyLessonsMigrationAfterPrompt(result, options.yes);
    process.stdout.write(formatSetupResult(result).join('\n') + '\n');
    if (!options.yes) {
      await maybeOfferConfigureAfterBootstrap(result.repoRoot);
    }
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

  if (command === 'review') {
    await runOperator(process.cwd(), ['review', ...rest]);
    return;
  }

  if (command === 'install-codex') {
    const verbose = parseVerboseArg(rest, 'install-codex');
    const result = installCodexBootstrapSkill();
    const lines = [
      `Installed ${result.installed.length} durable Pipelane Codex commands in ${result.codexHome}.`,
    ];
    lines.push(...legacyRepoLocalInstallNoticeLines(process.cwd()));
    if (result.removedLegacySkills.length > 0) {
      lines.push(`Removed legacy machine-local wrapper skills: ${result.removedLegacySkills.join(', ')}`);
    }
    if (result.skipped.length > 0) {
      lines.push(formatSkippedSkillsLine(result.skipped));
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
    lines.push(...legacyRepoLocalInstallNoticeLines(process.cwd()));
    if (result.removedLegacySkills.length > 0) {
      lines.push(`Removed legacy machine-local wrapper skills: ${result.removedLegacySkills.join(', ')}`);
    }
    if (result.skipped.length > 0) {
      lines.push(formatSkippedSkillsLine(result.skipped));
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
