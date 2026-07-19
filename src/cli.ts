#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { handlePipelane } from './dashboard/launcher.ts';
import { getDashboardOptions, startDashboardServer } from './dashboard/server.ts';
import { installClaudeBootstrapSkill, rollbackClaudeManagedRuntime } from './operator/claude-install.ts';
import { installCodexBootstrapSkill, rollbackCodexManagedRuntime } from './operator/codex-install.ts';
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
import {
  formatSecretProvisioningResult,
  provisionRepositorySecrets,
  SECRET_PROVISIONING_GUIDE_URL,
  SecretProvisioningManifestError,
} from './operator/secret-provisioning.ts';
import { resolveRepoRoot } from './operator/state.ts';
import { bootstrapWorktreeNodeModulesIfNeeded } from './operator/task-workspaces.ts';
import { maybeNotifyUpdate, parseUpdateArgs, runUpdate } from './operator/update.ts';
import { runVerify } from './operator/verify.ts';
import {
  buildRuntimeWarnings,
  formatPipelaneRuntimeBanner,
  formatPipelaneVersion,
  resolvePipelaneRuntimeIdentity,
} from './runtime-identity.ts';

function printTopLevelHelp(): void {
  process.stdout.write(`Pipelane - build, release, and development orchestration for AI-assisted codebases

Commands:
  setup [--yes] [--provision-secrets] [--rotate-secrets] [--approve-secret-manifest=<sha256>]
  configure [--json] [surface flags...]
  configure --provision-secrets [--rotate-secrets] --approve-secret-manifest=<sha256>
  update [--check] [--yes] [--json]
  install-claude [--verbose] [--rollback]
  install-codex [--verbose] [--rollback]
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

function parseSetupArgs(args: string[]): { yes: boolean; provisionSecrets: boolean; rotateSecrets: boolean; approvalId?: string } {
  let yes = false;
  let provisionSecrets = false;
  let rotateSecrets = false;
  let approvalId: string | undefined;
  for (const token of args) {
    if (token === '--yes' || token === '-y') {
      yes = true;
      continue;
    }
    if (token === '--provision-secrets') {
      provisionSecrets = true;
      continue;
    }
    if (token === '--rotate-secrets') {
      provisionSecrets = true;
      rotateSecrets = true;
      continue;
    }
    if (token.startsWith('--approve-secret-manifest=')) {
      approvalId = token.slice('--approve-secret-manifest='.length);
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write([
        'pipelane setup [--yes] [--provision-secrets] [--rotate-secrets] [--approve-secret-manifest=<sha256>]',
        '',
        'Private CI inputs are declared by individual repositories; Pipelane does not require secrets or a corpus globally.',
        `Guide: ${SECRET_PROVISIONING_GUIDE_URL}`,
        '',
      ].join('\n'));
      process.exit(0);
    }
    throw new Error(`Unknown flag for pipelane setup: ${token}`);
  }
  return { yes, provisionSecrets, rotateSecrets, ...(approvalId ? { approvalId } : {}) };
}

function parseInstallArgs(args: string[], command: string): { verbose: boolean; rollback: boolean } {
  let verbose = false;
  let rollback = false;
  for (const token of args) {
    if (token === '--verbose') {
      verbose = true;
      continue;
    }
    if (token === '--rollback') {
      rollback = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write(`pipelane ${command} [--verbose] [--rollback]\n`);
      process.exit(0);
    }
    throw new Error(`Unknown flag for pipelane ${command}: ${token}`);
  }
  return { verbose, rollback };
}

function formatRuntimeRollbackLines(
  host: string,
  result: {
    runtimeRoot: string;
    restored: { sourceSha?: string; packageVersion: string; installedAt: string };
    retired: { sourceSha?: string } | null;
    wrappersRestored: boolean;
    restoredSkills: string[];
    removedSkills: string[];
    skippedCollisions: string[];
    resyncCommand: string | null;
  },
): string[] {
  const restoredRef = result.restored.sourceSha?.slice(0, 7) ?? 'unknown sha';
  const lines = [
    `Rolled back the managed ${host} runtime at ${result.runtimeRoot}.`,
    `Restored: ${restoredRef} (v${result.restored.packageVersion}, installed ${result.restored.installedAt}).`,
  ];
  lines.push(result.retired
    ? `Retired runtime (${result.retired.sourceSha?.slice(0, 7) ?? 'unknown sha'}) is retained as the new previous; rerun with --rollback to roll forward again.`
    : 'No runtime was active before the rollback, so nothing was retired.');
  if (result.wrappersRestored) {
    lines.push(`Restored ${result.restoredSkills.length} managed skill wrapper(s) in lockstep with the runtime.`);
    if (result.removedSkills.length > 0) {
      lines.push(`Removed wrappers the restored runtime does not provide: ${result.removedSkills.join(', ')}.`);
    }
    if (result.skippedCollisions.length > 0) {
      lines.push(`Left unmanaged skills in place (name collisions): ${result.skippedCollisions.join(', ')}.`);
    }
  } else {
    lines.push('Restored runtime predates host-skill payload retention; installed skill wrappers were left as-is.');
    if (result.resyncCommand) {
      lines.push(`Re-sync wrappers from the restored runtime with: ${result.resyncCommand}`);
    }
  }
  return lines;
}

// Commands that operate outside the worktree. Skip the worktree symlink for
// these so we don't surprise users running them in unusual locations.
const SKIP_WORKTREE_BOOTSTRAP_COMMANDS = new Set(['init', 'bootstrap', 'install-claude', 'install-codex', 'install-npm-guard', 'verify', 'run', 'review']);
const UPDATE_NOTICE_COMMANDS = new Set(['setup', 'configure', 'dashboard', 'board', 'review', 'run']);

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function boardOptionArgs(args: string[]): string[] {
  const [sub, ...rest] = args;
  if (!sub || sub.startsWith('--')) return args;
  if (sub === 'start' || sub === 'stop' || sub === 'status') return rest;
  return args;
}

function updateNoticeRoot(command: string, args: string[], cwd: string): string {
  if (command === 'dashboard') {
    return path.resolve(valueAfter(args, '--repo') || process.env.ROCKETBOARD_ROOT || cwd);
  }
  if (command === 'board') {
    const options = boardOptionArgs(args);
    return path.resolve(valueAfter(options, '--repo') || process.env.ROCKETBOARD_ROOT || cwd);
  }
  return cwd;
}

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

function reportSetupSecretProvisioning(
  repoRoot: string,
  options: { provisionSecrets: boolean; rotateSecrets: boolean; approvalId?: string },
): void {
  try {
    const result = provisionRepositorySecrets(repoRoot, {
      apply: options.provisionSecrets,
      rotate: options.rotateSecrets,
      approvalId: options.approvalId,
    });
    if (!result) {
      if (options.provisionSecrets) {
        throw new Error('No .github/pipelane-provisioning.json manifest was found in this repository.');
      }
      return;
    }
    process.stdout.write(`${formatSecretProvisioningResult(
      result,
      '/pipelane setup --provision-secrets',
    ).join('\n')}\n`);
    if (options.provisionSecrets && !result.ok) process.exitCode = 64;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (options.provisionSecrets || error instanceof SecretProvisioningManifestError) throw error;
    process.stdout.write(`Repository secret provisioning is declared but could not be inspected: ${detail}\n`);
  }
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

  if (command === '--version' || command === '-v') {
    assertNoArgs(rest, '--version');
    process.stdout.write(`${formatPipelaneVersion(resolvePipelaneRuntimeIdentity())}\n`);
    return;
  }

  if (!command || command === '--help' || command === '-h') {
    printTopLevelHelp();
    return;
  }

  if (command === 'init' || command === 'bootstrap' || command === 'sync-docs') {
    handleUnsupportedRepoLocalAdapterCommand(command, rest);
    return;
  }

  if (command === 'run') {
    // Keep the structured stdout contract intact for --json callers. The
    // identity line is deliberately the first stderr line so a combined
    // terminal/agent transcript still answers exactly which build ran.
    const runtimeIdentity = resolvePipelaneRuntimeIdentity();
    process.stderr.write(`${formatPipelaneRuntimeBanner(runtimeIdentity)}\n`);
    for (const warning of buildRuntimeWarnings(runtimeIdentity, process.cwd())) {
      process.stderr.write(`${warning}\n`);
    }
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
  if (UPDATE_NOTICE_COMMANDS.has(command)) {
    maybeNotifyUpdate(updateNoticeRoot(command, rest, process.cwd()));
  }
  if (command === 'setup') {
    const options = parseSetupArgs(rest);
    let result = setupConsumerRepo(process.cwd());
    result = await maybeApplyGuidanceMigrationsAfterPrompt(result, options.yes);
    result = await maybeApplyLessonsMigrationAfterPrompt(result, options.yes);
    process.stdout.write(formatSetupResult(result).join('\n') + '\n');
    reportSetupSecretProvisioning(result.repoRoot, options);
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
    const { verbose, rollback } = parseInstallArgs(rest, 'install-codex');
    if (rollback) {
      const rollbackResult = rollbackCodexManagedRuntime();
      process.stdout.write(formatRuntimeRollbackLines('Codex', rollbackResult).join('\n') + '\n');
      return;
    }
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
    const { verbose, rollback } = parseInstallArgs(rest, 'install-claude');
    if (rollback) {
      const rollbackResult = rollbackClaudeManagedRuntime();
      process.stdout.write(formatRuntimeRollbackLines('Claude', rollbackResult).join('\n') + '\n');
      return;
    }
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
