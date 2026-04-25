import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readFixPromptBody } from './fix-prompt.ts';
import { installGlobalRuntime } from './global-runtime.ts';
import { defaultWorkflowConfig, homeCodexDir, readJsonFile, WORKFLOW_COMMANDS, writeJsonFile } from './state.ts';
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
  return path.join(codexHome, 'skills', MANAGED_PIPELANE_DIR);
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

function managedSkillsPath(skillsRoot: string): string {
  return path.join(skillsRoot, MANAGED_PIPELANE_DIR, MANAGED_CODEX_SKILLS_FILENAME);
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
  return body.includes('ensure_local_pipelane_config')
    && body.includes('This repo is not pipelane enabled. Run pipelane init first.');
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

function readManagedSkillNames(skillsRoot: string): Set<string> {
  const manifest = readJsonFile<ManagedSkillsManifest>(managedSkillsPath(skillsRoot), { skills: [] });
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

function knownLegacySkillNames(desired: DesiredInstallEntry[]): Set<string> {
  return new Set([
    ...WORKFLOW_COMMANDS,
    PIPELANE_DISPATCH_SKILL_NAME,
    INIT_PIPELANE_SKILL_NAME,
    ...desired.map((entry) => entry.name),
  ]);
}

function pruneLegacyCodexWrappers(skillsRoot: string, desired: DesiredInstallEntry[]): string[] {
  if (!existsSync(skillsRoot)) {
    return [];
  }

  const candidates = new Set<string>([
    ...readManagedSkillNames(skillsRoot),
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

  const legacyRunScriptPath = path.join(skillsRoot, MANAGED_PIPELANE_DIR, 'bin', 'run-pipelane.sh');
  if (existsSync(legacyRunScriptPath)) {
    unlinkSync(legacyRunScriptPath);
  }

  return removed.sort();
}

export function pruneLegacyCodexWrapperSkills(
  options: { codexHome?: string } = {},
): string[] {
  const codexHome = options.codexHome || homeCodexDir();
  const desired = desiredHostInstall('codex', 'machine-local', defaultWorkflowConfig('pipelane', 'Pipelane'), {
    runnerPath: path.join(runtimeRoot(codexHome), 'bin', 'run-pipelane.sh'),
    bootstrapScriptPath: path.join(runtimeRoot(codexHome), 'bin', 'bootstrap-pipelane.sh'),
    managedRuntimeRoot: runtimeRoot(codexHome),
    managedPipelaneBin: path.join(runtimeRoot(codexHome), 'bin', 'pipelane'),
    fixPromptBody: readFixPromptBody(),
  });
  return pruneLegacyCodexWrappers(path.join(codexHome, 'skills'), desired.entries);
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

function writeSkill(skillsRoot: string, entry: DesiredInstallEntry): void {
  const skillDir = skillDirPath(skillsRoot, entry.name);
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillDocPath(skillsRoot, entry.name), entry.body, 'utf8');
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
    bootstrapScriptPath: path.join(binDir, 'bootstrap-pipelane.sh'),
    managedRuntimeRoot: pipelaneRoot,
    managedPipelaneBin: path.join(binDir, 'pipelane'),
    fixPromptBody: readFixPromptBody(),
  });

  mkdirSync(skillsRoot, { recursive: true });
  const removedLegacySkills = pruneLegacyCodexWrappers(skillsRoot, install.entries);
  installGlobalRuntime(pipelaneRoot, {
    host: 'codex',
    legacyMarkers: [MANAGED_CODEX_SKILLS_FILENAME],
  });
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
    writeSkill(skillsRoot, entry);
    installed.push(entry.slashAlias);
    managedNames.push(entry.name);
  }

  writeJsonFile(managedSkillsPath(skillsRoot), { skills: managedNames.sort() });

  return {
    codexHome,
    runtimeRoot: pipelaneRoot,
    installed: installed.sort(),
    skipped: skipped.sort(),
    removedLegacySkills,
  };
}
