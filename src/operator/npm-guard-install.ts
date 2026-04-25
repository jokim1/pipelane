import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NPM_GUARD_SHIM_MARKER = '# pipelane:npm-guard-shim';
const NPM_GUARD_CORE_MARKER = 'pipelane:npm-guard-core';

export interface InstallNpmGuardResult {
  binDir: string;
  shimPath: string;
  guardPath: string;
  installed: boolean;
  warnings: string[];
}

export interface NpmGuardStatus {
  binDir: string;
  shimPath: string;
  guardPath: string;
  installed: boolean;
  firstNpmPath: string | null;
  pathReady: boolean;
  warnings: string[];
}

function pipelaneHome(): string {
  return process.env.PIPELANE_HOME || path.join(os.homedir(), '.pipelane');
}

export function npmGuardPaths(homeDir = pipelaneHome()): { binDir: string; shimPath: string; guardPath: string } {
  const binDir = path.join(homeDir, 'bin');
  return {
    binDir,
    shimPath: path.join(binDir, 'npm'),
    guardPath: path.join(binDir, 'npm-guard.cjs'),
  };
}

function isExecutable(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(envPath = process.env.PATH || ''): string[] {
  return envPath.split(path.delimiter).filter(Boolean);
}

function executableCandidates(dir: string, name: string): string[] {
  return process.platform === 'win32'
    ? [path.join(dir, `${name}.cmd`), path.join(dir, `${name}.exe`), path.join(dir, name)]
    : [path.join(dir, name)];
}

function firstExecutableOnPath(name: string, envPath = process.env.PATH || ''): string | null {
  for (const entry of pathEntries(envPath)) {
    for (const candidate of executableCandidates(entry, name)) {
      if (existsSync(candidate) && isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function buildNpmGuardShim(guardPath: string): string {
  return `#!/bin/sh
${NPM_GUARD_SHIM_MARKER}
export PIPELANE_NPM_GUARD_SHIM="$0"
exec node "${guardPath}" npm "$@"
`;
}

function buildNpmGuardCore(): string {
  return `#!/usr/bin/env node
// ${NPM_GUARD_CORE_MARKER}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function pathEntries() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean);
}

function executableCandidates(dir, name) {
  return process.platform === 'win32'
    ? [path.join(dir, name + '.cmd'), path.join(dir, name + '.exe'), path.join(dir, name)]
    : [path.join(dir, name)];
}

function isExecutable(target) {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function findRealNpm(toolName) {
  if (process.env.PIPELANE_NPM_GUARD_REAL_NPM) {
    return process.env.PIPELANE_NPM_GUARD_REAL_NPM;
  }

  const guardCore = realpathOrSelf(__filename);
  const guardShim = process.env.PIPELANE_NPM_GUARD_SHIM ? realpathOrSelf(process.env.PIPELANE_NPM_GUARD_SHIM) : '';
  for (const dir of pathEntries()) {
    for (const candidate of executableCandidates(dir, toolName)) {
      if (!fs.existsSync(candidate) || !isExecutable(candidate)) {
        continue;
      }
      const resolved = realpathOrSelf(candidate);
      if (resolved === guardCore || resolved === guardShim) {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

function takeOptionValue(args, index) {
  return index + 1 < args.length ? args[index + 1] : '';
}

function parseNpmArgs(args) {
  const envPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX || '';
  let prefix = '';
  let prefixFromFlag = false;
  let cwdTarget = '';
  let globalInstall = process.env.npm_config_global === 'true' || process.env.NPM_CONFIG_GLOBAL === 'true';
  let command = '';
  const filteredArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--pipelane-allow-symlinked-node-modules') {
      process.env.PIPELANE_NPM_GUARD_ALLOW_SYMLINKED_NODE_MODULES = '1';
      continue;
    }
    filteredArgs.push(token);
  }

  for (let index = 0; index < filteredArgs.length; index += 1) {
    const token = filteredArgs[index];
    if (token === '--') {
      break;
    }
    if (token === '--global' || token === '-g' || token === '--location=global') {
      globalInstall = true;
      continue;
    }
    if (token === '--prefix') {
      prefix = takeOptionValue(filteredArgs, index);
      prefixFromFlag = true;
      index += 1;
      continue;
    }
    if (token.startsWith('--prefix=')) {
      prefix = token.slice('--prefix='.length);
      prefixFromFlag = true;
      continue;
    }
    if (token === '--cwd') {
      cwdTarget = takeOptionValue(filteredArgs, index);
      index += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      cwdTarget = token.slice('--cwd='.length);
      continue;
    }
    if (token === '--workspace' || token === '-w' || token === '--workspaces') {
      if (token !== '--workspaces') {
        index += 1;
      }
      continue;
    }
    if (token.startsWith('--workspace=')) {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    if (!command) {
      command = token;
    }
  }

  if (globalInstall && !prefix && envPrefix) {
    prefix = envPrefix;
  }

  return { command, prefix, prefixFromFlag, cwdTarget, globalInstall, args: filteredArgs };
}

function shouldInspectNodeModules(command) {
  return new Set(['install', 'i', 'add', 'ci', 'update', 'up', 'dedupe', 'link', 'install-test', 'it']).has(command);
}

function maybeBlockSymlinkedNodeModules(parsed) {
  if (process.env.PIPELANE_NPM_GUARD_DISABLE === '1' || process.env.PIPELANE_NPM_GUARD_ALLOW_SYMLINKED_NODE_MODULES === '1') {
    return false;
  }
  if (process.env.PIPELANE_NPM_GUARD_BYPASS === '1') {
    process.stderr.write('[pipelane] PIPELANE_NPM_GUARD_BYPASS=1 set; delegating to real npm without symlink protection.\\n');
    return false;
  }
  if (parsed.globalInstall || !shouldInspectNodeModules(parsed.command)) {
    return false;
  }

  const invocationRoot = path.resolve(process.cwd());
  const cwdRoot = parsed.cwdTarget ? path.resolve(invocationRoot, parsed.cwdTarget) : invocationRoot;
  const targetRoot = parsed.prefix ? path.resolve(cwdRoot, parsed.prefix) : cwdRoot;
  const canonicalInvocationRoot = realpathOrSelf(invocationRoot);
  const canonicalTargetRoot = realpathOrSelf(targetRoot);
  const targetIsInsideInvocationRoot = canonicalTargetRoot === canonicalInvocationRoot || canonicalTargetRoot.startsWith(canonicalInvocationRoot + path.sep);
  if (parsed.prefixFromFlag && parsed.prefix && path.isAbsolute(parsed.prefix) && !targetIsInsideInvocationRoot) {
    return false;
  }
  const nodeModulesPath = path.join(targetRoot, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(nodeModulesPath);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) {
    return false;
  }

  process.stderr.write([
    '[pipelane] Refusing npm ' + parsed.command + ' because ' + nodeModulesPath + ' is a symlink.',
    '[pipelane] Running npm install/ci/update here can remove or corrupt the shared node_modules target.',
    '[pipelane] To reinstall locally, remove only the symlink first: rm node_modules && npm install',
    '[pipelane] To bypass intentionally once, set PIPELANE_NPM_GUARD_ALLOW_SYMLINKED_NODE_MODULES=1.',
  ].join('\\n') + '\\n');
  return true;
}

const toolName = process.argv[2] || 'npm';
const rawArgs = process.argv.slice(3);
const parsed = parseNpmArgs(rawArgs);
if (maybeBlockSymlinkedNodeModules(parsed)) {
  process.exit(1);
}

const realNpm = findRealNpm(toolName);
if (!realNpm) {
  process.stderr.write('[pipelane] Could not find a real npm binary after the npm guard shim in PATH.\\n');
  process.exit(127);
}

const result = spawnSync(realNpm, parsed.args, { stdio: 'inherit', env: process.env });
if (result.error) {
  process.stderr.write(result.error.message + '\\n');
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
`;
}

export function npmGuardStatus(homeDir = pipelaneHome(), envPath = process.env.PATH || ''): NpmGuardStatus {
  const paths = npmGuardPaths(homeDir);
  const installed = existsSync(paths.shimPath)
    && existsSync(paths.guardPath)
    && readFileSync(paths.shimPath, 'utf8').includes(NPM_GUARD_SHIM_MARKER)
    && readFileSync(paths.guardPath, 'utf8').includes(NPM_GUARD_CORE_MARKER);
  const firstNpmPath = firstExecutableOnPath('npm', envPath);
  const normalizedBinDir = path.resolve(paths.binDir);
  const pathReady = pathEntries(envPath)[0] ? path.resolve(pathEntries(envPath)[0]) === normalizedBinDir : false;
  const warnings: string[] = [];

  if (!installed) {
    warnings.push(`npm guard is not installed at ${paths.shimPath}.`);
  }
  if (!pathReady) {
    warnings.push(`Put ${paths.binDir} first in PATH so npm resolves to pipelane's guard before version-manager npm shims.`);
  }
  if (installed && firstNpmPath && path.resolve(firstNpmPath) !== path.resolve(paths.shimPath)) {
    warnings.push(`Current PATH resolves npm to ${firstNpmPath}, not ${paths.shimPath}.`);
  }

  return {
    ...paths,
    installed,
    firstNpmPath,
    pathReady,
    warnings,
  };
}

export function installNpmGuard(options: { homeDir?: string; envPath?: string } = {}): InstallNpmGuardResult {
  const paths = npmGuardPaths(options.homeDir || pipelaneHome());
  mkdirSync(paths.binDir, { recursive: true });

  if (existsSync(paths.shimPath) && !readFileSync(paths.shimPath, 'utf8').includes(NPM_GUARD_SHIM_MARKER)) {
    throw new Error(`${paths.shimPath} already exists and is not managed by pipelane.`);
  }
  if (existsSync(paths.guardPath) && !readFileSync(paths.guardPath, 'utf8').includes(NPM_GUARD_CORE_MARKER)) {
    throw new Error(`${paths.guardPath} already exists and is not managed by pipelane.`);
  }

  writeFileSync(paths.guardPath, buildNpmGuardCore(), { mode: 0o755, encoding: 'utf8' });
  writeFileSync(paths.shimPath, buildNpmGuardShim(paths.guardPath), { mode: 0o755, encoding: 'utf8' });

  const status = npmGuardStatus(options.homeDir || pipelaneHome(), options.envPath || process.env.PATH || '');
  return {
    ...paths,
    installed: true,
    warnings: status.warnings,
  };
}

export function runNpmGuardSelfCheck(homeDir = pipelaneHome()): { ok: boolean; lines: string[] } {
  const paths = npmGuardPaths(homeDir);
  const status = npmGuardStatus(homeDir);
  const lines = [
    `npm guard installed: ${status.installed ? 'yes' : 'no'}`,
    `npm guard shim: ${paths.shimPath}`,
    `PATH first npm: ${status.firstNpmPath || '(none)'}`,
  ];
  lines.push(...status.warnings.map((warning) => `warning: ${warning}`));

  if (!status.installed) {
    return { ok: false, lines };
  }

  const root = mkdtempSync(path.join(os.tmpdir(), 'pipelane-npm-guard-'));
  try {
    const shared = path.join(root, 'shared');
    const worktree = path.join(root, 'worktree');
    const fakeBin = path.join(root, 'fake-bin');
    mkdirSync(path.join(shared, 'node_modules'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    symlinkSync(path.join(shared, 'node_modules'), path.join(worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const fakeNpm = path.join(fakeBin, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\necho fake npm should not run >&2\nexit 42\n', { mode: 0o755, encoding: 'utf8' });

    const result = spawnSync(paths.shimPath, ['install'], {
      cwd: worktree,
      env: {
        ...process.env,
        PATH: `${paths.binDir}${path.delimiter}${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const blocked = result.status === 1 && result.stderr.includes('Refusing npm install');
    lines.push(`symlinked node_modules block: ${blocked ? 'pass' : 'fail'}`);
    if (!blocked) {
      lines.push(result.stderr || result.stdout || 'guard self-check did not return the expected refusal');
    }
    return { ok: blocked && status.warnings.length === 0, lines };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
