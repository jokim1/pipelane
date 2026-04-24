#!/usr/bin/env node

import { handlePipelane } from './dashboard/launcher.ts';
import { getDashboardOptions, startDashboardServer } from './dashboard/server.ts';
import { collectBootstrapWarnings, parseBootstrapArgs, runBootstrap } from './operator/bootstrap.ts';
import { installClaudeBootstrapSkill } from './operator/claude-install.ts';
import { installCodexBootstrapSkill } from './operator/codex-install.ts';
import { handleConfigure } from './operator/commands/configure.ts';
import { formatSetupResult, initConsumerRepo, setupConsumerRepo, syncDocsOnly } from './operator/docs.ts';
import { runOperator } from './operator/index.ts';
import { parseUpdateArgs, runUpdate } from './operator/update.ts';

function printTopLevelHelp(): void {
  process.stdout.write(`Pipelane - release pipeline management and safety for AI vibe coders

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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printTopLevelHelp();
    return;
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
      'Commit the tracked Pipelane files before using pipelane:new from a remote-backed repo.',
      'Next: run npm run pipelane:setup',
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
    const result = runBootstrap(process.cwd(), options);
    const lines = [
      `Bootstrapped pipelane in ${result.repoRoot}`,
      result.installedPackage ? 'Installed repo-local pipelane dependency.' : 'Reused existing repo-local pipelane dependency.',
      result.initializedRepo
        ? `Initialized tracked Pipelane files for ${result.displayName}.`
        : 'Repo was already pipelane-enabled; refreshed local setup.',
      result.createdClaude ? 'Created local CLAUDE.md from the Pipelane template.' : 'Preserved existing local CLAUDE.md.',
      'Commit the tracked Pipelane files before using pipelane:new from a remote-backed repo.',
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
    assertNoArgs(rest, 'install-codex');
    const result = installCodexBootstrapSkill();
    const lines = [
      `Installed Codex bootstrap skill in ${result.codexHome}: ${result.installed.join(', ')}`,
    ];
    if (result.removedLegacySkills.length > 0) {
      lines.push(`Removed legacy machine-local wrapper skills: ${result.removedLegacySkills.join(', ')}`);
    }
    lines.push('Repo-tracked Codex skills now live under .agents/skills after pipelane bootstrap/setup.');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (command === 'install-claude') {
    assertNoArgs(rest, 'install-claude');
    const result = installClaudeBootstrapSkill();
    process.stdout.write(`Installed Claude skills in ${result.claudeHome}: ${result.installed.join(', ')}\n`);
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
