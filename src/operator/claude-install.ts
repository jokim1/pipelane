import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readFixPromptBody } from './fix-prompt.ts';
import { readLessonPromptBody } from './lesson-prompt.ts';
import {
  installGlobalRuntime,
  previousRuntimePath,
  readHostSkillPayloads,
  rollbackGlobalRuntime,
  withGlobalRuntimeInstallLock,
  writeHostSkillPayloads,
  type HostRollbackSkillsOutcome,
  type HostRuntimeRollbackResult,
} from './global-runtime.ts';
import { defaultWorkflowConfig, homeClaudeDir, pipelaneHomeDir, readJsonFile, writeJsonFile } from './state.ts';
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
  void claudeHome;
  return path.join(pipelaneHomeDir(), 'runtimes', 'claude');
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

function writeSkill(skillsRoot: string, runtimeDir: string, entry: Pick<DesiredInstallEntry, 'name' | 'body'>): void {
  const skillDir = skillDirPath(skillsRoot, entry.name);
  if (path.resolve(skillDir) !== path.resolve(runtimeDir)) {
    rmSync(skillDir, { recursive: true, force: true });
    mkdirSync(skillDir, { recursive: true });
  } else {
    mkdirSync(skillDir, { recursive: true });
  }
  writeFileSync(skillDocPath(skillsRoot, entry.name), entry.body, 'utf8');
}

export function rollbackClaudeManagedRuntime(): HostRuntimeRollbackResult {
  const claudeHome = homeClaudeDir();
  const skillsRoot = path.join(claudeHome, 'skills');
  const pipelaneRoot = runtimeRoot(claudeHome);
  const previousRoot = previousRuntimePath(pipelaneRoot);
  // The payload snapshot, runtime swap, wrapper restoration, and compensation
  // are one transaction under the shared install lock: a concurrent rollback
  // or install must not interleave between the snapshot and the writes.
  return withGlobalRuntimeInstallLock(pipelaneRoot, () => {
    // Pre-swap validation: an inconsistent payload set refuses before any swap.
    const payloads = readHostSkillPayloads(previousRoot, `Retained runtime at ${previousRoot}`);
    const retiredNames = readManagedSkillNames(pipelaneRoot);
    const result = rollbackGlobalRuntime(pipelaneRoot, { expectedHost: 'claude', lockHeld: true });
    if (!payloads) {
      // The retained runtime predates host-skill payload retention: the dir swap
      // succeeded, but wrappers cannot be restored in lockstep. Tell the operator
      // how to re-sync them from the restored runtime itself.
      return {
        ...result,
        wrappersRestored: false,
        restoredSkills: [],
        removedSkills: [],
        skippedCollisions: [],
        resyncCommand: `${path.join(pipelaneRoot, 'bin', 'pipelane')} install-claude`,
      };
    }
    try {
      const outcome = restoreClaudeSkillWrappers(skillsRoot, pipelaneRoot, retiredNames, payloads);
      return { ...result, wrappersRestored: true, ...outcome, resyncCommand: null };
    } catch (error) {
      // Never leave the restored runtime active with half-written wrappers: put
      // the runtimes back the way they were, then surface the wrapper error.
      rollbackGlobalRuntime(pipelaneRoot, { expectedHost: 'claude', lockHeld: true });
      throw error;
    }
  });
}

function restoreClaudeSkillWrappers(
  skillsRoot: string,
  runtimeDir: string,
  retiredNames: Set<string>,
  payloads: Map<string, string>,
): Omit<HostRollbackSkillsOutcome, 'wrappersRestored' | 'resyncCommand'> {
  mkdirSync(skillsRoot, { recursive: true });
  // Wrapper mutations must be compensable: the outer runtime swap-back cannot
  // undo removed or rewritten SKILL.md files, so snapshot every wrapper this
  // restore may touch and put the snapshots back if any mutation fails.
  const touchable = new Set<string>([...retiredNames, ...payloads.keys()]);
  const snapshots = new Map<string, string | null>();
  for (const skillName of touchable) {
    snapshots.set(skillName, readSkillBody(skillsRoot, skillName));
  }
  try {
    const removedSkills: string[] = [];
    for (const skillName of retiredNames) {
      if (payloads.has(skillName) || !isManagedClaudeSkill(skillsRoot, skillName)) {
        continue;
      }
      rmSync(skillDirPath(skillsRoot, skillName), { recursive: true, force: true });
      removedSkills.push(skillName);
    }
    const restoredSkills: string[] = [];
    const skippedCollisions: string[] = [];
    for (const [skillName, body] of payloads) {
      const targetDir = skillDirPath(skillsRoot, skillName);
      if (
        existsSync(targetDir)
        && !isManagedClaudeSkill(skillsRoot, skillName)
      ) {
        // A foreign (unmanaged) skill occupies this name; never clobber it
        // during a rollback.
        skippedCollisions.push(skillName);
        continue;
      }
      writeSkill(skillsRoot, runtimeDir, { name: skillName, body });
      restoredSkills.push(skillName);
    }
    return {
      restoredSkills: restoredSkills.sort(),
      removedSkills: removedSkills.sort(),
      skippedCollisions: skippedCollisions.sort(),
    };
  } catch (error) {
    for (const [skillName, body] of snapshots) {
      try {
        if (body === null) {
          rmSync(skillDirPath(skillsRoot, skillName), { recursive: true, force: true });
        } else {
          // Write directly instead of via writeSkill: its delete-then-recreate
          // step can fail exactly like the mutation that got us here, leaving
          // the wrapper deleted instead of restored.
          const skillDir = skillDirPath(skillsRoot, skillName);
          mkdirSync(skillDir, { recursive: true });
          writeFileSync(skillDocPath(skillsRoot, skillName), body, 'utf8');
        }
      } catch {
        // Best effort: surface the original failure, not the compensation's.
      }
    }
    throw error;
  }
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
    managedRuntimeRoot: pipelaneRoot,
    managedPipelaneBin: path.join(binDir, 'pipelane'),
    fixPromptBody: readFixPromptBody(),
    lessonPromptBody: readLessonPromptBody(),
  });

  mkdirSync(skillsRoot, { recursive: true });
  // Pruning, the runtime install, generated assets, wrappers, the manifest,
  // and payloads are one transaction under the shared install lock so a
  // concurrent install or rollback cannot interleave a different generation.
  return withGlobalRuntimeInstallLock(pipelaneRoot, () => {
    const installed: string[] = [];
    const skipped: string[] = [];
    const entriesToInstall = install.entries.filter((entry) => assertOrSkipCollision(skillsRoot, entry, skipped));
    const removedLegacySkills = pruneRemovedManagedClaudeSkills(skillsRoot, pipelaneRoot, install.entries);
    installGlobalRuntime(pipelaneRoot, { host: 'claude', lockHeld: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'run-pipelane.sh'), install.runnerScript, { mode: 0o755, encoding: 'utf8' });
    writeFileSync(path.join(binDir, 'bootstrap-pipelane.sh'), install.bootstrapScript, { mode: 0o755, encoding: 'utf8' });

    const managedNames: string[] = [];

    for (const entry of entriesToInstall) {
      writeSkill(skillsRoot, pipelaneRoot, entry);
      installed.push(entry.slashAlias);
      managedNames.push(entry.name);
    }

    writeJsonFile(path.join(pipelaneRoot, MANAGED_CLAUDE_SKILLS_FILENAME), { skills: managedNames.sort() });
    const managedNameSet = new Set(managedNames);
    writeHostSkillPayloads(
      pipelaneRoot,
      install.entries
        .filter((entry) => managedNameSet.has(entry.name))
        .map((entry) => ({ name: entry.name, body: entry.body })),
    );

    return {
      claudeHome,
      runtimeRoot: pipelaneRoot,
      installed: installed.sort(),
      skipped: skipped.sort(),
      removedLegacySkills,
    };
  });
}
