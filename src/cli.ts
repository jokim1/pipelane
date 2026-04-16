#!/usr/bin/env node

import { getDashboardOptions, startDashboardServer } from './dashboard/server.ts';
import { installCodexWrappers } from './operator/codex-install.ts';
import { initConsumerRepo, setupConsumerRepo, syncDocsOnly } from './operator/docs.ts';
import { runOperator } from './operator/index.ts';

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] ?? '';
}

function printTopLevelHelp(): void {
  process.stdout.write(`workflow-kit

Commands:
  init --project "Project Name"
  setup
  sync-docs
  install-codex
  dashboard [--repo <repo-root>] [--host <host>] [--port <port>]
  run <workflow command...>

Examples:
  workflow-kit dashboard --repo /Users/josephkim/dev/rocketboard
  workflow-kit run new --task "My Task"
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
      throw new Error('workflow-kit init requires --project "Project Name".');
    }

    const result = initConsumerRepo(process.cwd(), projectName);
    process.stdout.write([
      `Initialized workflow-kit in ${result.repoRoot}`,
      `Config: ${result.configPath}`,
      'Commit the tracked workflow files before using workflow:new from a remote-backed repo.',
      'Next: run npm run workflow:setup',
    ].join('\n') + '\n');
    return;
  }

  if (command === 'setup') {
    const result = setupConsumerRepo(process.cwd());
    process.stdout.write([
      `Workflow setup complete in ${result.repoRoot}`,
      result.createdClaude ? 'Created local CLAUDE.md from workflow template.' : 'Preserved existing local CLAUDE.md.',
      `Installed Codex wrappers in ${result.codexHome}`,
      `Wrappers: ${result.installedWrappers.join(', ')}`,
    ].join('\n') + '\n');
    return;
  }

  if (command === 'sync-docs') {
    const result = syncDocsOnly(process.cwd());
    process.stdout.write(`Synced workflow docs for ${result.repoRoot}\n`);
    return;
  }

  if (command === 'install-codex') {
    const result = installCodexWrappers();
    process.stdout.write(`Installed Codex wrappers in ${result.codexHome}: ${result.installed.join(', ')}\n`);
    return;
  }

  if (command === 'dashboard') {
    const options = getDashboardOptions(rest, process.cwd());
    await startDashboardServer(options);
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
