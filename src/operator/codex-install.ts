import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { aliasCommandName, homeCodexDir, readJsonFile, resolveWorkflowAliases, type WorkflowCommand, WORKFLOW_COMMANDS, writeJsonFile } from './state.ts';

const MANAGED_CODEX_SKILLS_FILENAME = 'managed-skills.json';
const WORKFLOW_KIT_SKILL_MARKER = 'Run the generic workflow-kit wrapper for this repo.';
const LEGACY_ROCKETBOARD_SKILL_MARKER = 'rocketboard-workflow/bin/run-workflow.sh';

interface ManagedCodexSkillsManifest {
  version: number;
  repos: Record<string, string[]>;
}

function buildSkill(slashAlias: string, codexHome: string): string {
  return `---
name: ${aliasCommandName(slashAlias)}
version: 1.0.0
description: Run the workflow-kit command currently mapped to ${slashAlias} in this repo.
allowed-tools:
  - Bash
---

Run the generic workflow-kit wrapper for this repo.

1. Parse any arguments that appear after \`${slashAlias}\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${codexHome}/skills/workflow-kit/bin/run-workflow.sh --alias ${slashAlias} <parsed arguments>\`
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

if [ "$subcommand" = "--alias" ]; then
  if [ "$#" -lt 1 ]; then
    echo "Usage: run-workflow.sh --alias </command> [args...]" >&2
    exit 64
  fi

  alias_name="$1"
  shift

  resolved_command="$(node - "$repo_root" "$alias_name" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.argv[2];
const aliasName = (process.argv[3] || '').trim().toLowerCase();
const configPath = path.join(repoRoot, '.project-workflow.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const commands = ['devmode', 'new', 'resume', 'pr', 'merge', 'deploy', 'clean'];
const defaults = {
  devmode: '/devmode',
  new: '/new',
  resume: '/resume',
  pr: '/pr',
  merge: '/merge',
  deploy: '/deploy',
  clean: '/clean',
};

const normalize = (value, fallback) => {
  const raw = String(value || fallback).trim().toLowerCase();
  return raw.startsWith('/') ? raw : '/' + raw;
};

const aliases = Object.fromEntries(commands.map((command) => [
  command,
  normalize(config.aliases?.[command], defaults[command]),
]));

for (const command of commands) {
  if (aliases[command] === aliasName) {
    process.stdout.write(command);
    process.exit(0);
  }
}

process.exit(3);
NODE
)"

  if [ -z "$resolved_command" ]; then
    echo "Alias $alias_name is not configured for this repo. Rerun workflow:setup if aliases changed." >&2
    exit 2
  fi

  subcommand="$resolved_command"
fi

cd "$repo_root"
exec npm run "workflow:$subcommand" -- "$@"
`;
}

function managedCodexSkillsPath(skillsRoot: string): string {
  return path.join(skillsRoot, 'workflow-kit', MANAGED_CODEX_SKILLS_FILENAME);
}

function skillDocPath(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName, 'SKILL.md');
}

function isManagedWorkflowSkill(skillsRoot: string, skillName: string): boolean {
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(WORKFLOW_KIT_SKILL_MARKER) || content.includes(LEGACY_ROCKETBOARD_SKILL_MARKER);
}

function loadManagedCodexManifest(skillsRoot: string): ManagedCodexSkillsManifest {
  const fallback = { version: 2, repos: {} } satisfies ManagedCodexSkillsManifest;
  const raw = readJsonFile(managedCodexSkillsPath(skillsRoot), fallback as ManagedCodexSkillsManifest | { skills: string[] });

  if ('repos' in raw && raw.repos && typeof raw.repos === 'object') {
    return {
      version: 2,
      repos: Object.fromEntries(
        Object.entries(raw.repos).map(([repoRoot, skills]) => [repoRoot, Array.isArray(skills) ? skills.filter((entry) => typeof entry === 'string') : []]),
      ),
    };
  }

  return fallback;
}

function loadManagedCodexSkills(skillsRoot: string, manifest: ManagedCodexSkillsManifest): Set<string> {
  const managed = new Set<string>();

  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot)) {
      if (entry === 'workflow-kit') {
        continue;
      }

      if (isManagedWorkflowSkill(skillsRoot, entry)) {
        managed.add(entry);
      }
    }
  }

  for (const skills of Object.values(manifest.repos)) {
    for (const entry of skills) {
      if (isManagedWorkflowSkill(skillsRoot, entry)) {
        managed.add(entry);
      }
    }
  }

  return managed;
}

function assertNoCodexSkillCollisions(skillsRoot: string, desiredSkills: Set<string>, managedSkills: Set<string>): void {
  for (const skillName of desiredSkills) {
    const targetDir = path.join(skillsRoot, skillName);
    if (existsSync(targetDir) && !managedSkills.has(skillName)) {
      throw new Error(
        `Codex skill alias collision: ${targetDir} already exists and is not managed by workflow-kit. Choose a different alias in .project-workflow.json or remove the conflicting skill.`,
      );
    }
  }
}

function pruneManagedCodexSkills(skillsRoot: string, desiredSkills: Set<string>, managedSkills: Set<string>): void {
  for (const skillName of managedSkills) {
    if (!desiredSkills.has(skillName) && isManagedWorkflowSkill(skillsRoot, skillName)) {
      rmSync(path.join(skillsRoot, skillName), { recursive: true, force: true });
    }
  }
}

function saveManagedCodexManifest(skillsRoot: string, manifest: ManagedCodexSkillsManifest): void {
  writeJsonFile(managedCodexSkillsPath(skillsRoot), {
    version: 2,
    repos: Object.fromEntries(
      Object.entries(manifest.repos)
        .filter(([, skills]) => skills.length > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([repoRoot, skills]) => [repoRoot, [...new Set(skills)].sort()]),
    ),
  });
}

function desiredCodexSkillsForRepo(manifest: ManagedCodexSkillsManifest, repoRoot: string, aliases: Record<WorkflowCommand, string>): Set<string> {
  manifest.repos[repoRoot] = WORKFLOW_COMMANDS.map((command) => aliasCommandName(aliases[command]));

  const desiredSkills = new Set<string>();
  for (const skills of Object.values(manifest.repos)) {
    for (const skillName of skills) {
      desiredSkills.add(skillName);
    }
  }

  return desiredSkills;
}

export function installCodexWrappers(
  options: { codexHome?: string; repoRoot: string; aliases?: Partial<Record<WorkflowCommand, string>> | Record<string, string> } ,
): { codexHome: string; installed: string[] } {
  const codexHome = options.codexHome || homeCodexDir();
  const skillsRoot = path.join(codexHome, 'skills');
  const workflowKitRoot = path.join(skillsRoot, 'workflow-kit');
  const binDir = path.join(workflowKitRoot, 'bin');
  const aliases = resolveWorkflowAliases(options.aliases);

  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'run-workflow.sh'), buildRunScript(), { mode: 0o755, encoding: 'utf8' });

  const manifest = loadManagedCodexManifest(skillsRoot);
  const desiredSkills = desiredCodexSkillsForRepo(manifest, options.repoRoot, aliases);
  const managedSkills = loadManagedCodexSkills(skillsRoot, manifest);
  assertNoCodexSkillCollisions(skillsRoot, desiredSkills, managedSkills);
  pruneManagedCodexSkills(skillsRoot, desiredSkills, managedSkills);

  const installed: string[] = [];
  for (const skillName of desiredSkills) {
    const slashAlias = `/${skillName}`;
    const skillDir = path.join(skillsRoot, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), buildSkill(slashAlias, codexHome), 'utf8');
  }

  for (const command of WORKFLOW_COMMANDS) {
    installed.push(aliases[command]);
  }
  saveManagedCodexManifest(skillsRoot, manifest);

  return { codexHome, installed };
}
