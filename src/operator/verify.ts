import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readFixPromptBody } from './fix-prompt.ts';
import { npmGuardStatus, runNpmGuardSelfCheck } from './npm-guard-install.ts';
import { CONFIG_FILENAME, defaultWorkflowConfig, homeClaudeDir, homeCodexDir, writeJsonFile } from './state.ts';
import {
  desiredHostInstall,
  type DesiredInstall,
  type HostInstall,
} from './skill-rendering.ts';

type VerifyCheckStatus = 'ok' | 'fail' | 'skip';

interface VerifyCheck {
  name: string;
  status: VerifyCheckStatus;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  message: string;
}

function isExecutable(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function checkFile(checks: VerifyCheck[], name: string, targetPath: string, options: { expectedBody?: string; executable?: boolean } = {}): void {
  if (!existsSync(targetPath)) {
    checks.push({ name, status: 'fail', detail: `missing: ${targetPath}` });
    return;
  }
  if (options.executable && !isExecutable(targetPath)) {
    checks.push({ name, status: 'fail', detail: `not executable: ${targetPath}` });
    return;
  }
  if (options.expectedBody !== undefined && readFileSync(targetPath, 'utf8') !== options.expectedBody) {
    checks.push({ name, status: 'fail', detail: `content drift: ${targetPath}` });
    return;
  }
  checks.push({ name, status: 'ok', detail: targetPath });
}

function checkOptionalSkill(checks: VerifyCheck[], name: string, targetPath: string, expectedBody: string, managedMarker: string): void {
  if (!existsSync(targetPath)) {
    checks.push({ name, status: 'skip', detail: `not installed (optional): ${targetPath}` });
    return;
  }
  const body = readFileSync(targetPath, 'utf8');
  if (!body.includes(managedMarker)) {
    checks.push({ name, status: 'skip', detail: `unmanaged optional skill: ${targetPath}` });
    return;
  }
  if (body !== expectedBody) {
    checks.push({ name, status: 'fail', detail: `content drift: ${targetPath}` });
    return;
  }
  checks.push({ name, status: 'ok', detail: targetPath });
}

function runtimeRoot(host: HostInstall, home: string): string {
  return host === 'codex'
    ? path.join(home, 'skills', '.pipelane')
    : path.join(home, 'skills', 'pipelane');
}

function desiredMachineInstall(host: HostInstall, home: string): DesiredInstall {
  const root = runtimeRoot(host, home);
  const binDir = path.join(root, 'bin');
  return desiredHostInstall(host, 'machine-local', defaultWorkflowConfig('pipelane', 'Pipelane'), {
    runnerPath: path.join(binDir, 'run-pipelane.sh'),
    bootstrapScriptPath: path.join(binDir, 'bootstrap-pipelane.sh'),
    managedRuntimeRoot: root,
    managedPipelaneBin: path.join(binDir, 'pipelane'),
    fixPromptBody: readFixPromptBody(),
  });
}

function hostInstallSignals(host: HostInstall, home: string, install: DesiredInstall): string[] {
  const skillsRoot = path.join(home, 'skills');
  const root = runtimeRoot(host, home);
  const signals = [
    path.join(root, 'bin', 'pipelane'),
    path.join(root, 'bin', 'run-pipelane.sh'),
    path.join(root, 'managed-skills.json'),
    ...install.entries.filter((entry) => entry.required).map((entry) => path.join(skillsRoot, entry.name, 'SKILL.md')),
  ];
  if (host === 'codex') {
    signals.push(path.join(skillsRoot, 'pipelane', 'bin', 'run-pipelane.sh'));
  }
  return signals;
}

function checkHostInstall(checks: VerifyCheck[], host: HostInstall, home: string): string | null {
  const install = desiredMachineInstall(host, home);
  const skillsRoot = path.join(home, 'skills');
  const root = runtimeRoot(host, home);
  const markerPrefix = host === 'codex' ? 'pipelane:codex-global-skill:' : 'pipelane:claude-global-skill:';
  if (!hostInstallSignals(host, home, install).some((targetPath) => existsSync(targetPath))) {
    checks.push({
      name: `${host} durable commands`,
      status: 'skip',
      detail: `not installed (optional host; run pipelane install-${host})`,
    });
    return null;
  }

  for (const entry of install.entries) {
    const targetPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    const checkName = `${host}${entry.required ? '' : ' optional'} skill ${entry.slashAlias}`;
    if (entry.required) {
      checkFile(checks, checkName, targetPath, { expectedBody: entry.body });
    } else {
      checkOptionalSkill(checks, checkName, targetPath, entry.body, `${markerPrefix}${entry.name}`);
    }
  }

  checkFile(checks, `${host} runner`, path.join(root, 'bin', 'run-pipelane.sh'), {
    expectedBody: install.runnerScript,
    executable: true,
  });
  checkFile(checks, `${host} bootstrap runner`, path.join(root, 'bin', 'bootstrap-pipelane.sh'), {
    expectedBody: install.bootstrapScript,
    executable: true,
  });
  checkFile(checks, `${host} managed runtime`, path.join(root, 'bin', 'pipelane'), { executable: true });
  return path.join(root, 'bin', 'run-pipelane.sh');
}

export function runVerify(): VerifyResult {
  const checks: VerifyCheck[] = [];
  const codexRunnerPath = checkHostInstall(checks, 'codex', homeCodexDir());
  const claudeRunnerPath = checkHostInstall(checks, 'claude', homeClaudeDir());

  addNpmGuardCheck(checks);
  const runnerChecks: Array<{ name: string; path: string }> = [];
  if (codexRunnerPath) {
    runnerChecks.push({ name: 'codex temporary runner self-test', path: codexRunnerPath });
  }
  if (claudeRunnerPath) {
    runnerChecks.push({ name: 'claude temporary runner self-test', path: claudeRunnerPath });
  }
  if (runnerChecks.length === 0) {
    checks.push({
      name: 'durable command host',
      status: 'fail',
      detail: 'no Codex or Claude durable commands are installed; run pipelane install-codex or pipelane install-claude',
    });
  }
  for (const runner of runnerChecks) {
    checks.push(runTemporaryRunnerCheck(runner.name, runner.path));
  }

  const ok = checks.every((check) => check.status !== 'fail');
  const lines = ['Pipelane durable install verify:'];
  for (const check of checks) {
    lines.push(`  ${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
  }
  return {
    ok,
    checks,
    message: lines.join('\n'),
  };
}

function addNpmGuardCheck(checks: VerifyCheck[]): void {
  const guard = npmGuardStatus();
  if (!guard.installed) {
    checks.push({
      name: 'npm guard',
      status: 'skip',
      detail: `not installed (optional; run pipelane install-npm-guard to protect raw npm installs in symlinked worktrees)`,
    });
    return;
  }

  const selfCheck = runNpmGuardSelfCheck();
  checks.push({
    name: 'npm guard',
    status: selfCheck.ok ? 'ok' : 'fail',
    detail: selfCheck.lines.join('; '),
  });
}

function runTemporaryRunnerCheck(name: string, runnerPath: string): VerifyCheck {
  if (!existsSync(runnerPath)) {
    return { name, status: 'fail', detail: `missing: ${runnerPath}` };
  }
  if (!isExecutable(runnerPath)) {
    return { name, status: 'fail', detail: `not executable: ${runnerPath}` };
  }

  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-verify-'));
  try {
    const init = spawnSync('git', ['init', '-b', 'main'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (init.status !== 0) {
      return { name, status: 'fail', detail: init.stderr || 'git init failed' };
    }
    writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"pipelane-verify"}\n', 'utf8');
    const configPath = path.join(repoRoot, CONFIG_FILENAME);
    writeJsonFile(configPath, defaultWorkflowConfig('pipelane-verify', 'Pipelane Verify'));
    const packageBefore = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    const configBefore = readFileSync(configPath, 'utf8');
    const result = spawnSync(runnerPath, ['status', '--json'], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      return {
        name,
        status: 'fail',
        detail: result.stderr || result.stdout || `runner exited ${result.status}`,
      };
    }
    const wroteAdapters = [
      '.claude',
      '.agents',
      '.pipelane',
    ].filter((entry) => existsSync(path.join(repoRoot, entry)));
    const packageChanged = readFileSync(path.join(repoRoot, 'package.json'), 'utf8') !== packageBefore;
    const configChanged = readFileSync(configPath, 'utf8') !== configBefore;
    if (wroteAdapters.length > 0 || packageChanged || configChanged) {
      return {
        name,
        status: 'fail',
        detail: `unexpected repo writes: ${wroteAdapters.join(', ') || (packageChanged ? 'package.json' : CONFIG_FILENAME)}`,
      };
    }
    return { name, status: 'ok', detail: 'global runner reached Pipelane in a temporary configured repo without adapter writes' };
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}
