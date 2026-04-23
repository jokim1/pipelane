import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { aliasCommandName, readJsonFile, resolveWorkflowAliases, type WorkflowCommand, WORKFLOW_COMMANDS, type WorkflowConfig, writeJsonFile } from './state.ts';

const MANAGED_CODEX_SKILLS_FILENAME = '.pipelane-managed.json';
const MANAGED_CODEX_RUNTIME_DIR = '.pipelane';
const MANAGED_CODEX_RUNNER = path.join(MANAGED_CODEX_RUNTIME_DIR, 'bin', 'run-pipelane.sh');
const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';
const PIPELANE_CODEX_SKILL_MARKER = '<!-- pipelane:codex-skill:';

function buildSkill(command: WorkflowCommand, slashAlias: string): string {
  const skillName = aliasCommandName(slashAlias);
  return `---
name: ${skillName}
version: 1.0.0
description: Run the pipelane command currently mapped to ${slashAlias} in this repo.
allowed-tools:
  - Bash
---
${PIPELANE_CODEX_SKILL_MARKER}${command} -->

Run the repo-native pipelane command currently mapped to ${slashAlias}.

1. Parse any arguments that appear after the requested command invocation.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`"$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.agents/skills/${MANAGED_CODEX_RUNNER}" ${command} <parsed arguments>\`
4. Stream the command output directly.
`;
}

function managedCodexRunnerPath(skillsRoot: string): string {
  return path.join(skillsRoot, MANAGED_CODEX_RUNNER);
}

function buildManagedCodexRunner(): string {
  return `#!/bin/sh
set -eu

command="\${1:-}"
if [ -z "$command" ]; then
  echo "usage: run-pipelane.sh <command> [args...]" >&2
  exit 64
fi
shift

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
local_bin="$repo_root/node_modules/.bin/pipelane"
if [ -x "$local_bin" ]; then
  cd "$repo_root"
  exec "$local_bin" run "$command" "$@"
fi

codex_home="\${CODEX_HOME:-\${HOME:-}/.codex}"
global_bin="$codex_home/skills/.pipelane/bin/pipelane"
if [ -x "$global_bin" ]; then
  cd "$repo_root"
  exec "$global_bin" run "$command" "$@"
fi

echo "pipelane is unavailable for this repo." >&2
echo "Checked:" >&2
echo "  - $local_bin" >&2
echo "  - $global_bin" >&2
echo "Restore one of these runtimes and retry:" >&2
echo "  - run npm install in the repo to restore node_modules/.bin/pipelane" >&2
echo "  - run pipelane install-codex (or reinstall Codex skills) to restore the managed Codex runtime" >&2
exit 1
`;
}

function managedCodexSkillsPath(skillsRoot: string): string {
  return path.join(skillsRoot, MANAGED_CODEX_SKILLS_FILENAME);
}

function skillDocPath(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName, 'SKILL.md');
}

function isManagedCodexSkill(skillsRoot: string, skillName: string): boolean {
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(PIPELANE_CODEX_SKILL_MARKER);
}

function loadManagedCodexSkills(skillsRoot: string): Set<string> {
  const managed = new Set<string>();
  const manifest = readJsonFile(managedCodexSkillsPath(skillsRoot), { skills: [] as string[] });

  if (!existsSync(skillsRoot)) {
    return managed;
  }

  for (const entry of manifest.skills) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      continue;
    }

    if (isManagedCodexSkill(skillsRoot, entry)) {
      managed.add(entry);
    }
  }

  for (const entry of readdirSync(skillsRoot)) {
    if (entry.startsWith('.')) {
      continue;
    }

    if (isManagedCodexSkill(skillsRoot, entry)) {
      managed.add(entry);
    }
  }

  return managed;
}

function assertNoCodexSkillCollisions(skillsRoot: string, desiredSkills: Set<string>, managedSkills: Set<string>): void {
  for (const skillName of desiredSkills) {
    const targetDir = path.join(skillsRoot, skillName);
    if (existsSync(targetDir) && !managedSkills.has(skillName)) {
      throw new Error(
        `Codex skill alias collision: ${targetDir} already exists and is not managed by pipelane. Choose a different alias in .pipelane.json or remove the conflicting skill.`,
      );
    }
  }
}

function pruneManagedCodexSkills(skillsRoot: string, desiredSkills: Set<string>, managedSkills: Set<string>): void {
  for (const skillName of managedSkills) {
    if (!desiredSkills.has(skillName) && isManagedCodexSkill(skillsRoot, skillName)) {
      rmSync(path.join(skillsRoot, skillName), { recursive: true, force: true });
    }
  }
}

function saveManagedCodexSkills(skillsRoot: string, desiredSkills: Set<string>): void {
  writeJsonFile(managedCodexSkillsPath(skillsRoot), {
    skills: [...desiredSkills].sort(),
  });
}

export interface CodexSkillDrift {
  skillsDir: string;
  addedSkills: string[];        // desired skills whose SKILL.md is not on disk
  updatedSkills: string[];      // desired skills whose on-disk SKILL.md differs from what buildSkill would emit
  removedLegacySkills: string[];// managed skills no longer desired (setup would prune)
  runnerDrift: boolean;         // .pipelane/bin/run-pipelane.sh missing or stale
}

// Read-only mirror of syncCodexSkills: computes the same desired skill map
// and compares to disk without writing anything. `detectSetupDrift` uses this
// to answer "would pipelane:setup change anything on the Codex side?" so
// /pipelane update can surface the minimum follow-up steps.
export function detectCodexSkillDrift(
  repoRoot: string,
  config: WorkflowConfig,
): CodexSkillDrift {
  const skillsRoot = path.join(repoRoot, '.agents', 'skills');
  const aliases = resolveWorkflowAliases(config.aliases);
  const desiredSkills = new Set<string>();
  const desiredMappings = new Map<string, { command: WorkflowCommand; slashAlias: string }>();

  for (const command of WORKFLOW_COMMANDS) {
    const slashAlias = aliases[command];
    const skillName = aliasCommandName(slashAlias);
    if (skillName === INIT_PIPELANE_SKILL_NAME) {
      // syncCodexSkills throws here. Surface as a no-drift answer — the
      // collision becomes the caller's problem at sync time, not detection.
      return {
        skillsDir: skillsRoot,
        addedSkills: [],
        updatedSkills: [],
        removedLegacySkills: [],
        runnerDrift: false,
      };
    }
    desiredSkills.add(skillName);
    desiredMappings.set(skillName, { command, slashAlias });
  }

  const managedSkills = existsSync(skillsRoot) ? loadManagedCodexSkills(skillsRoot) : new Set<string>();
  const addedSkills: string[] = [];
  const updatedSkills: string[] = [];

  for (const [skillName, mapping] of desiredMappings.entries()) {
    const targetPath = skillDocPath(skillsRoot, skillName);
    if (!existsSync(targetPath)) {
      addedSkills.push(skillName);
      continue;
    }
    const onDisk = readFileSync(targetPath, 'utf8');
    if (onDisk !== buildSkill(mapping.command, mapping.slashAlias)) {
      updatedSkills.push(skillName);
    }
  }

  const removedLegacySkills: string[] = [];
  for (const skillName of managedSkills) {
    if (!desiredSkills.has(skillName)) {
      removedLegacySkills.push(skillName);
    }
  }

  const runnerPath = managedCodexRunnerPath(skillsRoot);
  const runnerDrift = !existsSync(runnerPath) || readFileSync(runnerPath, 'utf8') !== buildManagedCodexRunner();

  return {
    skillsDir: skillsRoot,
    addedSkills: addedSkills.sort(),
    updatedSkills: updatedSkills.sort(),
    removedLegacySkills: removedLegacySkills.sort(),
    runnerDrift,
  };
}

export function syncCodexSkills(
  repoRoot: string,
  config: WorkflowConfig,
): { skillsDir: string; installed: string[] } {
  const skillsRoot = path.join(repoRoot, '.agents', 'skills');
  mkdirSync(skillsRoot, { recursive: true });

  const aliases = resolveWorkflowAliases(config.aliases);
  const desiredSkills = new Set<string>();
  const desiredMappings = new Map<string, { command: WorkflowCommand; slashAlias: string }>();

  for (const command of WORKFLOW_COMMANDS) {
    const slashAlias = aliases[command];
    const skillName = aliasCommandName(slashAlias);
    if (skillName === INIT_PIPELANE_SKILL_NAME) {
      throw new Error(
        `Workflow aliases must stay distinct from the reserved Codex bootstrap skill. ${command} resolves to ${slashAlias}, which conflicts with ${INIT_PIPELANE_SKILL_NAME}.`,
      );
    }
    desiredSkills.add(skillName);
    desiredMappings.set(skillName, { command, slashAlias });
  }

  const managedSkills = loadManagedCodexSkills(skillsRoot);
  assertNoCodexSkillCollisions(skillsRoot, desiredSkills, managedSkills);
  pruneManagedCodexSkills(skillsRoot, desiredSkills, managedSkills);
  mkdirSync(path.dirname(managedCodexRunnerPath(skillsRoot)), { recursive: true });
  writeFileSync(managedCodexRunnerPath(skillsRoot), buildManagedCodexRunner(), { mode: 0o755, encoding: 'utf8' });

  for (const [skillName, mapping] of desiredMappings.entries()) {
    const skillDir = path.join(skillsRoot, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillDocPath(skillsRoot, skillName), buildSkill(mapping.command, mapping.slashAlias), 'utf8');
  }

  saveManagedCodexSkills(skillsRoot, desiredSkills);

  return {
    skillsDir: skillsRoot,
    installed: WORKFLOW_COMMANDS.map((command) => aliases[command]),
  };
}
