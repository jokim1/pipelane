#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { handlePipelane } from './dashboard/launcher.ts';
import { getDashboardOptions, startDashboardServer } from './dashboard/server.ts';
import { parseBootstrapArgs, runBootstrap } from './operator/bootstrap.ts';
import { installClaudeBootstrapSkill } from './operator/claude-install.ts';
import { installCodexWrappers } from './operator/codex-install.ts';
import { handleConfigure } from './operator/commands/configure.ts';
import { initConsumerRepo, setupConsumerRepo, syncDocsOnly } from './operator/docs.ts';
import { runOperator } from './operator/index.ts';
import { CONFIG_FILENAME, resolveRepoRoot, resolveWorkflowAliases, type WorkflowConfig } from './operator/state.ts';
import { parseUpdateArgs, runUpdate } from './operator/update.ts';

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function printTopLevelHelp(): void {
  process.stdout.write(`Pipelane — release cockpit for AI vibe coders

Commands:
  bootstrap [--project "Project Name"]
  init --project "Project Name"
  setup
  sync-docs
  configure [--json] [surface flags...]
  install-claude
  install-codex
  update [--check] [--yes] [--json]
  dashboard [--repo <repo-root>] [--host <host>] [--port <port>]
  board [stop|status] [--repo <repo-root>] [--port <port>] [--no-open]
  run <operator command...>

Examples:
  pipelane bootstrap --project "My Project"
  pipelane install-claude
  pipelane board
  pipelane board stop
  pipelane update --check
  pipelane dashboard --repo /absolute/path/to/repo
  pipelane run new --task "My Task"
`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printTopLevelHelp();
    return;
  }

  if (command === 'init') {
    const projectName = valueAfter(rest, '--project');
    if (!projectName.trim()) {
      throw new Error('pipelane init requires --project "Project Name".');
    }

    const result = initConsumerRepo(process.cwd(), projectName);
    process.stdout.write([
      `Initialized pipelane in ${result.repoRoot}`,
      `Config: ${result.configPath}`,
      'Commit the tracked Pipelane files before using pipelane:new from a remote-backed repo.',
      'Next: run npm run pipelane:setup',
      'Each Codex user must run setup locally on their own machine.',
    ].join('\n') + '\n');
    return;
  }

  if (command === 'bootstrap') {
    const options = parseBootstrapArgs(rest);
    const result = runBootstrap(process.cwd(), options);
    const lines = [
      `Bootstrapped pipelane in ${result.repoRoot}`,
      result.installedPackage ? 'Installed repo-local pipelane dependency.' : 'Reused existing repo-local pipelane dependency.',
      result.initializedRepo
        ? `Initialized tracked Pipelane files for ${result.displayName}.`
        : 'Repo was already pipelane-enabled; refreshed local setup.',
      result.createdClaude ? 'Created local CLAUDE.md from the Pipelane template.' : 'Preserved existing local CLAUDE.md.',
      `Installed Codex wrappers in ${result.codexHome}`,
      `Slash commands: ${result.installedWrappers.join(', ')}`,
      'Commit the tracked Pipelane files before using pipelane:new from a remote-backed repo.',
      'Claude picks up the tracked .claude/commands files after the repo is initialized.',
      'If Codex was already open, reopen the repo or restart the client to refresh slash commands.',
    ];
    if (result.warnings.length > 0) {
      lines.push('Readiness warnings:');
      lines.push(...result.warnings.map((warning) => `- ${warning}`));
    }
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (command === 'setup') {
    const result = setupConsumerRepo(process.cwd());
    process.stdout.write([
      `Pipelane setup complete in ${result.repoRoot}`,
      result.createdClaude ? 'Created local CLAUDE.md from the Pipelane template.' : 'Preserved existing local CLAUDE.md.',
      `Installed Codex wrappers in ${result.codexHome}`,
      `Slash commands: ${result.installedWrappers.join(', ')}`,
      'Each Codex user must run npm run pipelane:setup on their own machine.',
      'If Claude or Codex was already open, reopen the repo or restart the client to refresh slash commands.',
      'Release mode still requires local deploy configuration in CLAUDE.md.',
    ].join('\n') + '\n');
    return;
  }

  if (command === 'sync-docs') {
    const result = syncDocsOnly(process.cwd());
    process.stdout.write(`Synced Pipelane docs for ${result.repoRoot}\n`);
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
    const repoRoot = resolveRepoRoot(process.cwd(), true);
    const configPath = path.join(repoRoot, CONFIG_FILENAME);
    const config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, 'utf8')) as WorkflowConfig
      : null;
    const result = config
      ? installCodexWrappers({ repoRoot, aliases: resolveWorkflowAliases(config.aliases) })
      : installCodexWrappers();
    process.stdout.write(`Installed Codex wrappers in ${result.codexHome}: ${result.installed.join(', ')}\n`);
    return;
  }

  if (command === 'install-claude') {
    const result = installClaudeBootstrapSkill();
    process.stdout.write(`Installed Claude skills in ${result.claudeHome}: ${result.installed.join(', ')}\n`);
    return;
  }

  if (command === 'dashboard') {
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
