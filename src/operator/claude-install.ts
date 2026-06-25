import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readFixPromptBody } from './fix-prompt.ts';
import { installGlobalRuntime } from './global-runtime.ts';
import { defaultWorkflowConfig, homeClaudeDir, readJsonFile, writeJsonFile } from './state.ts';
import {
  desiredHostInstall,
  INIT_PIPELANE_SKILL_NAME,
  MACHINE_CLAUDE_SKILL_MARKER_PREFIX,
  PIPELANE_DISPATCH_SKILL_NAME,
  type DesiredInstallEntry,
} from './skill-rendering.ts';

const MANAGED_CLAUDE_RUNTIME_DIR = 'pipelane';
const MANAGED_CLAUDE_SKILLS_FILENAME = 'managed-skills.json';
const LEGACY_CLAUDE_SKILL_MARKER = '<!-- pipelane:claude-skill:init-pipelane -->';

export interface InstallClaudeSkillsResult {
  claudeHome: string;
  runtimeRoot: string;
  installed: string[];
  skipped: string[];
  removedLegacySkills: string[];
}

interface ManagedSkillsManifest {
  skills?: unknown;
}

function runtimeRoot(claudeHome: string): string {
  return path.join(claudeHome, 'skills', MANAGED_CLAUDE_RUNTIME_DIR);
}

function isSafeSkillName(skillName: string): boolean {
  return (
    skillName.length > 0
    && skillName.trim() === skillName
    && !path.isAbsolute(skillName)
    && !skillName.includes('/')
    && !skillName.includes('\\')
    && skillName !== '.'
    && skillName !== '..'
  );
}

function skillDirPath(skillsRoot: string, skillName: string): string {
  if (!isSafeSkillName(skillName)) {
    throw new Error(`Unsafe Claude skill name in managed manifest: ${skillName}`);
  }
  const root = path.resolve(skillsRoot);
  const target = path.resolve(root, skillName);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe Claude skill path escaped skills root: ${skillName}`);
  }
  return target;
}

function skillDocPath(skillsRoot: string, skillName: string): string {
  return path.join(skillDirPath(skillsRoot, skillName), 'SKILL.md');
}

function readSkillBody(skillsRoot: string, skillName: string): string | null {
  if (!isSafeSkillName(skillName)) {
    return null;
  }
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return null;
  }
  return readFileSync(targetPath, 'utf8');
}

function isManagedClaudeSkillBody(body: string, skillName: string): boolean {
  return (
    body.includes(`${MACHINE_CLAUDE_SKILL_MARKER_PREFIX}${skillName} -->`)
    || body.includes(LEGACY_CLAUDE_SKILL_MARKER)
  );
}

function isManagedClaudeSkill(skillsRoot: string, skillName: string): boolean {
  const body = readSkillBody(skillsRoot, skillName);
  return body !== null && isManagedClaudeSkillBody(body, skillName);
}

function readManagedSkillNames(runtimeRootPath: string): Set<string> {
  const manifest = readJsonFile<ManagedSkillsManifest>(
    path.join(runtimeRootPath, MANAGED_CLAUDE_SKILLS_FILENAME),
    { skills: [] },
  );
  const names = new Set<string>();
  if (Array.isArray(manifest.skills)) {
    for (const entry of manifest.skills) {
      if (typeof entry === 'string' && isSafeSkillName(entry)) {
        names.add(entry);
      }
    }
  }
  return names;
}

function pruneRemovedManagedClaudeSkills(
  skillsRoot: string,
  runtimeRootPath: string,
  desired: DesiredInstallEntry[],
): string[] {
  const candidates = new Set<string>([
    ...readManagedSkillNames(runtimeRootPath),
    INIT_PIPELANE_SKILL_NAME,
  ]);
  const desiredNames = new Set(desired.map((entry) => entry.name));
  const removed: string[] = [];

  for (const skillName of candidates) {
    if (!isSafeSkillName(skillName)) {
      continue;
    }
    if (desiredNames.has(skillName) || !isManagedClaudeSkill(skillsRoot, skillName)) {
      continue;
    }
    const skillDir = skillDirPath(skillsRoot, skillName);
    if (path.resolve(skillDir) === path.resolve(runtimeRootPath)) {
      continue;
    }
    rmSync(skillDir, { recursive: true, force: true });
    removed.push(skillName);
  }

  return removed.sort();
}

function assertOrSkipCollision(skillsRoot: string, entry: DesiredInstallEntry, skipped: string[]): boolean {
  const targetDir = skillDirPath(skillsRoot, entry.name);
  if (
    !existsSync(targetDir)
    || isManagedClaudeSkill(skillsRoot, entry.name)
    || entry.name === PIPELANE_DISPATCH_SKILL_NAME
  ) {
    return true;
  }

  if (!entry.required) {
    skipped.push(entry.slashAlias);
    return false;
  }

  throw new Error(
    `Claude skill alias collision: ${targetDir} already exists and is not managed by pipelane. Remove or rename the conflicting skill.`,
  );
}

function writeSkill(skillsRoot: string, runtimeDir: string, entry: DesiredInstallEntry): void {
  const skillDir = skillDirPath(skillsRoot, entry.name);
  if (path.resolve(skillDir) !== path.resolve(runtimeDir)) {
    rmSync(skillDir, { recursive: true, force: true });
    mkdirSync(skillDir, { recursive: true });
  } else {
    mkdirSync(skillDir, { recursive: true });
  }
  writeFileSync(skillDocPath(skillsRoot, entry.name), entry.body, 'utf8');
}

export function installClaudeBootstrapSkill(
  options: { claudeHome?: string } = {},
): InstallClaudeSkillsResult {
  const claudeHome = options.claudeHome || homeClaudeDir();
  const skillsRoot = path.join(claudeHome, 'skills');
  const pipelaneRoot = runtimeRoot(claudeHome);
  const binDir = path.join(pipelaneRoot, 'bin');
  const install = desiredHostInstall('claude', 'machine-local', defaultWorkflowConfig('pipelane', 'Pipelane'), {
    runnerPath: path.join(binDir, 'run-pipelane.sh'),
    bootstrapScriptPath: path.join(binDir, 'bootstrap-pipelane.sh'),
    managedRuntimeRoot: pipelaneRoot,
    managedPipelaneBin: path.join(binDir, 'pipelane'),
    fixPromptBody: readFixPromptBody(),
  });

  mkdirSync(skillsRoot, { recursive: true });
  const removedLegacySkills = pruneRemovedManagedClaudeSkills(skillsRoot, pipelaneRoot, install.entries);
  installGlobalRuntime(pipelaneRoot, { host: 'claude' });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'run-pipelane.sh'), install.runnerScript, { mode: 0o755, encoding: 'utf8' });
  writeFileSync(path.join(binDir, 'bootstrap-pipelane.sh'), install.bootstrapScript, { mode: 0o755, encoding: 'utf8' });

  const installed: string[] = [];
  const skipped: string[] = [];
  const managedNames: string[] = [];

  for (const entry of install.entries) {
    if (!assertOrSkipCollision(skillsRoot, entry, skipped)) {
      continue;
    }
    writeSkill(skillsRoot, pipelaneRoot, entry);
    installed.push(entry.slashAlias);
    managedNames.push(entry.name);
  }

  writeJsonFile(path.join(pipelaneRoot, MANAGED_CLAUDE_SKILLS_FILENAME), { skills: managedNames.sort() });

  return {
    claudeHome,
    runtimeRoot: pipelaneRoot,
    installed: installed.sort(),
    skipped: skipped.sort(),
    removedLegacySkills,
  };
}
