import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { homeCodexDir } from './state.ts';

const COMMANDS = ['devmode', 'new', 'resume', 'pr', 'merge', 'deploy', 'clean'];

function buildSkill(command: string, codexHome: string): string {
  const descriptions: Record<string, string> = {
    devmode: 'Switch or check the workflow dev mode for the current repo.',
    new: 'Create a fresh task workspace for the current repo.',
    resume: 'Resume an existing task workspace for the current repo.',
    pr: 'Prepare or update the current repo pull request.',
    merge: 'Merge the current repo pull request.',
    deploy: 'Deploy the merged SHA for the current repo.',
    clean: 'Inspect and clean workflow task state for the current repo.',
  };

  return `---
name: ${command}
version: 1.0.0
description: ${descriptions[command]}
allowed-tools:
  - Bash
---

Run the generic workflow-kit wrapper for this repo.

1. Parse any arguments that appear after \`/${command}\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${codexHome}/skills/workflow-kit/bin/run-workflow.sh ${command} <parsed arguments>\`
4. Stream the command output directly.
5. If the current repo is not workflow-kit enabled, return the refusal unchanged.
`;
}

function buildRunScript(): string {
  return `#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: run-workflow.sh <command> [args...]" >&2
  exit 64
fi

subcommand="$1"
shift

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "This command only works inside a workflow-kit repo." >&2
  exit 2
fi

if [ ! -f "$repo_root/.project-workflow.json" ]; then
  echo "This repo is not workflow-kit enabled. Run workflow-kit init first." >&2
  exit 2
fi

cd "$repo_root"
exec npm run "workflow:$subcommand" -- "$@"
`;
}

export function installCodexWrappers(options: { codexHome?: string } = {}): { codexHome: string; installed: string[] } {
  const codexHome = options.codexHome || homeCodexDir();
  const skillsRoot = path.join(codexHome, 'skills');
  const workflowKitRoot = path.join(skillsRoot, 'workflow-kit');
  const binDir = path.join(workflowKitRoot, 'bin');

  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'run-workflow.sh'), buildRunScript(), { mode: 0o755, encoding: 'utf8' });

  const installed: string[] = [];
  for (const command of COMMANDS) {
    const skillDir = path.join(skillsRoot, command);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), buildSkill(command, codexHome), 'utf8');
    installed.push(command);
  }

  return { codexHome, installed };
}
