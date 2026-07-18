import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readFixPromptBody } from './fix-prompt.ts';
import { readLessonPromptBody } from './lesson-prompt.ts';
import {
  installGlobalRuntime,
  isManagedGlobalRuntime,
  previousRuntimePath,
  readHostSkillPayloads,
  rollbackGlobalRuntime,
  withGlobalRuntimeInstallLock,
  writeHostSkillPayloads,
  type HostRuntimeRollbackResult,
} from './global-runtime.ts';
import { defaultWorkflowConfig, homeCodexDir, pipelaneHomeDir, readJsonFile, WORKFLOW_COMMANDS, writeJsonFile } from './state.ts';
import {
  desiredHostInstall,
  INIT_PIPELANE_SKILL_NAME,
  MACHINE_CODEX_SKILL_MARKER_PREFIX,
  PIPELANE_DISPATCH_SKILL_NAME,
  type DesiredInstallEntry,
} from './skill-rendering.ts';

const LEGACY_WRAPPER_SKILL_MARKER = 'Run the generic pipelane wrapper for this repo.';
const LEGACY_WORKFLOW_KIT_MARKER = 'Run the generic workflow-kit wrapper for this repo.';
const MANAGED_CODEX_SKILLS_FILENAME = 'managed-skills.json';
const MANAGED_PIPELANE_DIR = '.pipelane';
const OLD_BOOTSTRAP_SKILL_MARKER = '<!-- pipelane:codex-bootstrap:init-pipelane -->';
const LEGACY_PIPELANE_RUNTIME_DIR = '.pipelane';
const LEGACY_WORKFLOW_KIT_RUNTIME_DIR = '.workflow-kit';

interface ManagedSkillsManifest {
  skills?: unknown;
}

export interface InstallCodexSkillsResult {
  codexHome: string;
  runtimeRoot: string;
  installed: string[];
  skipped: string[];
  removedLegacySkills: string[];
}

function runtimeRoot(codexHome: string): string {
  void codexHome;
  return path.join(pipelaneHomeDir(), 'runtimes', 'codex');
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
    throw new Error(`Unsafe Codex skill name in managed manifest: ${skillName}`);
  }
  const root = path.resolve(skillsRoot);
  const target = path.resolve(root, skillName);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe Codex skill path escaped skills root: ${skillName}`);
  }
  return target;
}

function skillDocPath(skillsRoot: string, skillName: string): string {
  return path.join(skillDirPath(skillsRoot, skillName), 'SKILL.md');
}

function managedSkillsPath(root: string): string {
  return path.join(root, MANAGED_CODEX_SKILLS_FILENAME);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasLegacyRuntimeInvocation(body: string, runtimeDir: string, scriptName: string, argsPattern = ''): boolean {
  const pattern = new RegExp(
    String.raw`(?:^|[\s'"` + '`' + String.raw`])(?:[^\s'"` + '`' + String.raw`]+/)?skills/${escapeRegExp(runtimeDir)}/bin/${escapeRegExp(scriptName)}${argsPattern}(?:$|[\s'"` + '`' + String.raw`])`,
    'm',
  );
  return pattern.test(body);
}

function hasLegacyPipelaneWorkflowSignature(body: string, skillName: string): boolean {
  if (!body.includes(LEGACY_WRAPPER_SKILL_MARKER)) {
    return false;
  }
  if (skillName === INIT_PIPELANE_SKILL_NAME) {
    return hasLegacyRuntimeInvocation(body, LEGACY_PIPELANE_RUNTIME_DIR, 'bootstrap-pipelane.sh');
  }
  return hasLegacyRuntimeInvocation(
    body,
    LEGACY_PIPELANE_RUNTIME_DIR,
    'run-pipelane.sh',
    String.raw`\s+${escapeRegExp(skillName)}`,
  );
}

function hasLegacyWorkflowKitSignature(body: string, skillName: string): boolean {
  return body.includes(LEGACY_WORKFLOW_KIT_MARKER)
    && hasLegacyRuntimeInvocation(
      body,
      LEGACY_WORKFLOW_KIT_RUNTIME_DIR,
      'run-workflow-kit.sh',
      String.raw`\s+${escapeRegExp(skillName)}`,
    );
}

function isLegacyPipelaneRuntimeDir(skillsRoot: string, skillName: string): boolean {
  if (skillName !== PIPELANE_DISPATCH_SKILL_NAME) {
    return false;
  }
  const targetDir = skillDirPath(skillsRoot, skillName);
  const skillPath = path.join(targetDir, 'SKILL.md');
  const legacyRunnerPath = path.join(targetDir, 'bin', 'run-pipelane.sh');
  if (existsSync(skillPath) || !existsSync(legacyRunnerPath)) {
    return false;
  }
  const body = readFileSync(legacyRunnerPath, 'utf8');
  return body.includes('ensure_local_pipelane_config');
}

function isManagedCodexSkillBody(body: string, skillName: string): boolean {
  return (
    body.includes(`${MACHINE_CODEX_SKILL_MARKER_PREFIX}${skillName} -->`)
    || (skillName === INIT_PIPELANE_SKILL_NAME && body.includes(OLD_BOOTSTRAP_SKILL_MARKER))
    || hasLegacyPipelaneWorkflowSignature(body, skillName)
    || hasLegacyWorkflowKitSignature(body, skillName)
  );
}

function isManagedCodexSkill(skillsRoot: string, skillName: string): boolean {
  const body = readSkillBody(skillsRoot, skillName);
  return body !== null && isManagedCodexSkillBody(body, skillName);
}

function readManagedSkillNames(skillsRoot: string, runtimeRootPath: string): Set<string> {
  const manifests = [
    managedSkillsPath(runtimeRootPath),
    path.join(skillsRoot, MANAGED_PIPELANE_DIR, MANAGED_CODEX_SKILLS_FILENAME),
  ];
  const names = new Set<string>();
  for (const manifestPath of manifests) {
    const manifest = readJsonFile<ManagedSkillsManifest>(manifestPath, { skills: [] });
    if (Array.isArray(manifest.skills)) {
      for (const entry of manifest.skills) {
        if (typeof entry === 'string' && isSafeSkillName(entry)) {
          names.add(entry);
        }
      }
    }
  }
  return names;
}

function knownLegacySkillNames(desired: DesiredInstallEntry[]): Set<string> {
  return new Set([
    ...WORKFLOW_COMMANDS,
    PIPELANE_DISPATCH_SKILL_NAME,
    INIT_PIPELANE_SKILL_NAME,
    ...desired.map((entry) => entry.name),
  ]);
}

function removeLegacyCodexRuntimeDir(skillsRoot: string, runtimeRootPath: string): string[] {
  const legacyRoot = path.join(skillsRoot, MANAGED_PIPELANE_DIR);
  if (path.resolve(legacyRoot) === path.resolve(runtimeRootPath) || !existsSync(legacyRoot)) {
    return [];
  }
  if (!isManagedGlobalRuntime(legacyRoot, [MANAGED_CODEX_SKILLS_FILENAME, 'bin/run-pipelane.sh'])) {
    return [];
  }
  rmSync(legacyRoot, { recursive: true, force: true });
  return [MANAGED_PIPELANE_DIR];
}

function pruneLegacyCodexWrappers(skillsRoot: string, runtimeRootPath: string, desired: DesiredInstallEntry[]): string[] {
  if (!existsSync(skillsRoot)) {
    return [];
  }

  const candidates = new Set<string>([
    ...readManagedSkillNames(skillsRoot, runtimeRootPath),
    ...knownLegacySkillNames(desired),
  ]);

  const desiredNames = new Set(desired.map((entry) => entry.name));
  const removed: string[] = [];
  for (const skillName of candidates) {
    if (!isSafeSkillName(skillName)) {
      continue;
    }
    if (isLegacyPipelaneRuntimeDir(skillsRoot, skillName)) {
      rmSync(skillDirPath(skillsRoot, skillName), { recursive: true, force: true });
      removed.push(skillName);
      continue;
    }
    if (!isManagedCodexSkill(skillsRoot, skillName)) {
      continue;
    }

    const shouldRemoveLegacy = !desiredNames.has(skillName) || !readSkillBody(skillsRoot, skillName)?.includes(MACHINE_CODEX_SKILL_MARKER_PREFIX);
    if (shouldRemoveLegacy) {
      rmSync(skillDirPath(skillsRoot, skillName), { recursive: true, force: true });
      removed.push(skillName);
    }
  }

  removed.push(...removeLegacyCodexRuntimeDir(skillsRoot, runtimeRootPath));
  return removed.sort();
}

export function pruneLegacyCodexWrapperSkills(
  options: { codexHome?: string } = {},
): string[] {
  const codexHome = options.codexHome || homeCodexDir();
  const desired = desiredHostInstall('codex', 'machine-local', defaultWorkflowConfig('pipelane', 'Pipelane'), {
    runnerPath: path.join(runtimeRoot(codexHome), 'bin', 'run-pipelane.sh'),
    managedRuntimeRoot: runtimeRoot(codexHome),
    managedPipelaneBin: path.join(runtimeRoot(codexHome), 'bin', 'pipelane'),
    fixPromptBody: readFixPromptBody(),
    lessonPromptBody: readLessonPromptBody(),
  });
  return pruneLegacyCodexWrappers(path.join(codexHome, 'skills'), runtimeRoot(codexHome), desired.entries);
}

function assertOrSkipCollision(skillsRoot: string, entry: DesiredInstallEntry, skipped: string[]): boolean {
  const targetDir = skillDirPath(skillsRoot, entry.name);
  if (!existsSync(targetDir) || isManagedCodexSkill(skillsRoot, entry.name)) {
    return true;
  }

  if (!entry.required) {
    skipped.push(entry.slashAlias);
    return false;
  }

  throw new Error(
    `Codex skill alias collision: ${targetDir} already exists and is not managed by pipelane. Remove or rename the conflicting skill.`,
  );
}

function writeSkill(skillsRoot: string, entry: Pick<DesiredInstallEntry, 'name' | 'body'>): void {
  const skillDir = skillDirPath(skillsRoot, entry.name);
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillDocPath(skillsRoot, entry.name), entry.body, 'utf8');
}

export function rollbackCodexManagedRuntime(): HostRuntimeRollbackResult {
  const codexHome = homeCodexDir();
  const skillsRoot = path.join(codexHome, 'skills');
  const pipelaneRoot = runtimeRoot(codexHome);
  const previousRoot = previousRuntimePath(pipelaneRoot);
  // The payload snapshot, runtime swap, wrapper restoration, and compensation
  // are one transaction under the shared install lock: a concurrent rollback
  // or install must not interleave between the snapshot and the writes.
  return withGlobalRuntimeInstallLock(pipelaneRoot, () => {
    // Pre-swap validation: an inconsistent payload set refuses before any swap.
    const payloads = readHostSkillPayloads(previousRoot, `Retained runtime at ${previousRoot}`);
    const retiredNames = readManagedSkillNames(skillsRoot, pipelaneRoot);
    const result = rollbackGlobalRuntime(pipelaneRoot, { expectedHost: 'codex', lockHeld: true });
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
        resyncCommand: `${path.join(pipelaneRoot, 'bin', 'pipelane')} install-codex`,
      };
    }
    try {
      const outcome = restoreCodexSkillWrappers(skillsRoot, retiredNames, payloads);
      return { ...result, wrappersRestored: true, ...outcome, resyncCommand: null };
    } catch (error) {
      // Never leave the restored runtime active with half-written wrappers: put
      // the runtimes back the way they were, then surface the wrapper error.
      rollbackGlobalRuntime(pipelaneRoot, { expectedHost: 'codex', lockHeld: true });
      throw error;
    }
  });
}

function restoreCodexSkillWrappers(
  skillsRoot: string,
  retiredNames: Set<string>,
  payloads: Map<string, string>,
): { restoredSkills: string[]; removedSkills: string[]; skippedCollisions: string[] } {
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
      if (payloads.has(skillName) || !isManagedCodexSkill(skillsRoot, skillName)) {
        continue;
      }
      rmSync(skillDirPath(skillsRoot, skillName), { recursive: true, force: true });
      removedSkills.push(skillName);
    }
    const restoredSkills: string[] = [];
    const skippedCollisions: string[] = [];
    for (const [skillName, body] of payloads) {
      const targetDir = skillDirPath(skillsRoot, skillName);
      if (existsSync(targetDir) && !isManagedCodexSkill(skillsRoot, skillName)) {
        // A foreign (unmanaged) skill occupies this name; never clobber it
        // during a rollback.
        skippedCollisions.push(skillName);
        continue;
      }
      writeSkill(skillsRoot, { name: skillName, body });
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

export function installCodexBootstrapSkill(
  options: { codexHome?: string } = {},
): InstallCodexSkillsResult {
  const codexHome = options.codexHome || homeCodexDir();
  const skillsRoot = path.join(codexHome, 'skills');
  const pipelaneRoot = runtimeRoot(codexHome);
  const binDir = path.join(pipelaneRoot, 'bin');
  const install = desiredHostInstall('codex', 'machine-local', defaultWorkflowConfig('pipelane', 'Pipelane'), {
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
    const removedLegacySkills = pruneLegacyCodexWrappers(skillsRoot, pipelaneRoot, install.entries);
    const entriesToInstall = install.entries.filter((entry) => assertOrSkipCollision(skillsRoot, entry, skipped));
    installGlobalRuntime(pipelaneRoot, {
      host: 'codex',
      legacyMarkers: [MANAGED_CODEX_SKILLS_FILENAME],
      lockHeld: true,
    });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'run-pipelane.sh'), install.runnerScript, { mode: 0o755, encoding: 'utf8' });
    writeFileSync(path.join(binDir, 'bootstrap-pipelane.sh'), install.bootstrapScript, { mode: 0o755, encoding: 'utf8' });

    const managedNames: string[] = [];

    for (const entry of entriesToInstall) {
      writeSkill(skillsRoot, entry);
      installed.push(entry.slashAlias);
      managedNames.push(entry.name);
    }

    writeJsonFile(managedSkillsPath(pipelaneRoot), { skills: managedNames.sort() });
    const managedNameSet = new Set(managedNames);
    writeHostSkillPayloads(
      pipelaneRoot,
      install.entries
        .filter((entry) => managedNameSet.has(entry.name))
        .map((entry) => ({ name: entry.name, body: entry.body })),
    );

    return {
      codexHome,
      runtimeRoot: pipelaneRoot,
      installed: installed.sort(),
      skipped: skipped.sort(),
      removedLegacySkills,
    };
  });
}
