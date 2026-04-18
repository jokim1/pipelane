#!/usr/bin/env node

import { handlePipelane } from './dashboard/launcher.ts';
import { getDashboardOptions, startDashboardServer } from './dashboard/server.ts';
import { installCodexWrappers } from './operator/codex-install.ts';
import { handleConfigure } from './operator/commands/configure.ts';
import { initConsumerRepo, setupConsumerRepo, syncDocsOnly } from './operator/docs.ts';
import { runOperator } from './operator/index.ts';
import { parseUpdateArgs, runUpdate } from './operator/update.ts';

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function printTopLevelHelp(): void {
  process.stdout.write(`pipelane — release cockpit for AI vibe coders
  (formerly workflow-kit; the \`workflow-kit\` bin still works as a shim)

Commands:
  init --project "Project Name"
  setup
  sync-docs
  configure [--json] [surface flags...]
  install-codex
  update [--check] [--yes] [--json]
  dashboard [--repo <repo-root>] [--host <host>] [--port <port>]
  board [stop|status] [--repo <repo-root>] [--port <port>] [--no-open]
  run <operator command...>

Examples:
  pipelane board
  pipelane board stop
  pipelane update --check
  pipelane dashboard --repo /Users/josephkim/dev/rocketboard
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
      'Commit the tracked workflow files before using pipelane:new from a remote-backed repo.',
      'Next: run npm run pipelane:setup',
      'Each Codex user must run setup locally on their own machine.',
    ].join('\n') + '\n');
    return;
  }

  if (command === 'setup') {
    const result = setupConsumerRepo(process.cwd());
    process.stdout.write([
      `Pipelane setup complete in ${result.repoRoot}`,
      result.createdClaude ? 'Created local CLAUDE.md from workflow template.' : 'Preserved existing local CLAUDE.md.',
      `Installed Codex wrappers in ${result.codexHome}`,
      `Slash commands: ${result.installedWrappers.join(', ')}`,
      'Each Codex user must run npm run workflow:setup on their own machine.',
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
    const result = installCodexWrappers({ repoRoot: process.cwd() });
    process.stdout.write(`Installed Codex wrappers in ${result.codexHome}: ${result.installed.join(', ')}\n`);
    return;
  }

  if (command === 'dashboard') {
    const options = getDashboardOptions(rest, process.cwd());
    await startDashboardServer(options);
    return;
  }

  // `board` is the canonical subcommand that opens the Pipelane Board.
  // `pipelane` is kept as a legacy alias so the old `workflow-kit pipelane`
  // muscle memory keeps working through the `workflow-kit` bin shim.
  if (command === 'board' || command === 'pipelane') {
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
