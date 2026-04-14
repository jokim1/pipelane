import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const KIT_ROOT = '/tmp/workflow-kit-build';
const CLI_PATH = path.join(KIT_ROOT, 'src', 'cli.ts');
const FIXTURE_ROOT = path.join(KIT_ROOT, 'test', 'fixtures', 'sample-repo');

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runCli(args, cwd, env = {}, allowFailure = false) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr || `CLI failed: ${args.join(' ')}`);
  }

  return result;
}

function createRepo() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-repo-'));
  cpSync(FIXTURE_ROOT, repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return repoRoot;
}

function createRemoteBackedRepo() {
  const repoRoot = createRepo();
  const remoteRoot = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-remote-'));
  execFileSync('git', ['init', '--bare', remoteRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return { repoRoot, remoteRoot };
}

function commitAll(repoRoot, message) {
  execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', message], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['push'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFakeGh(binDir, stateFile) {
  mkdirSync(binDir, { recursive: true });
  const targetPath = path.join(binDir, 'gh');
  writeFileSync(targetPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const statePath = process.env.GH_STATE_FILE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { prs: {}, workflows: [] };
const args = process.argv.slice(2);
const writeState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n', 'utf8');
const findFlag = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] || '';
};
if (args[0] === 'pr' && args[1] === 'list') {
  const head = findFlag('--head');
  const pr = state.prs[head];
  process.stdout.write(JSON.stringify(pr ? [pr] : []));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  const head = findFlag('--head');
  const title = findFlag('--title');
  const number = Object.keys(state.prs).length + 1;
  const pr = { number, title, url: 'https://example.test/pr/' + number, mergeCommit: null, mergedAt: null };
  state.prs[head] = pr;
  writeState();
  process.stdout.write(pr.url + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'edit') {
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((entry) => entry.number === number);
  process.stdout.write(JSON.stringify(pr || { number, title: 'Unknown', url: '', mergeCommit: null, mergedAt: null }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((entry) => entry.number === number);
  if (pr) {
    pr.mergeCommit = { oid: 'deadbeefcafebabe' };
    pr.mergedAt = '2026-04-13T00:00:00Z';
    writeState();
  }
  process.exit(0);
}
if (args[0] === 'workflow' && args[1] === 'run') {
  state.workflows.push({ name: args[2], args: args.slice(3) });
  writeState();
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755, encoding: 'utf8' });
}

test('init writes tracked workflow files and setup seeds CLAUDE plus Codex wrappers', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-codex-'));

  try {
    const initResult = runCli(['init', '--project', 'Demo App'], repoRoot);
    assert.match(initResult.stdout, /Initialized workflow-kit/);
    assert.ok(existsSync(path.join(repoRoot, '.project-workflow.json')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'new.md')));
    assert.ok(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')));

    const setupResult = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    assert.match(setupResult.stdout, /Workflow setup complete/);
    assert.ok(existsSync(path.join(repoRoot, 'CLAUDE.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'new', 'SKILL.md')));

    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.scripts['workflow:new'], 'workflow-kit run new');
    assert.equal(packageJson.scripts['workflow:resume'], 'workflow-kit run resume');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('new creates a fresh task workspace and resume restores it', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Primary Task', '--json'], repoRoot).stdout);

    assert.equal(created.taskSlug, 'primary-task');
    assert.equal(created.createdWorktree, true);
    assert.ok(created.worktreePath.includes('primary-task'));
    assert.equal(run('git', ['branch', '--show-current'], created.worktreePath), created.branch);

    const resumed = JSON.parse(runCli(['run', 'resume', '--task', 'Primary Task', '--json'], repoRoot).stdout);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.worktreePath, created.worktreePath);

    const autoResumed = JSON.parse(runCli(['run', 'resume', '--json'], repoRoot).stdout);
    assert.equal(autoResumed.resumed, true);
    assert.equal(autoResumed.worktreePath, created.worktreePath);

    const duplicate = runCli(['run', 'new', '--task', 'Primary Task'], repoRoot, {}, true);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already active/);
    assert.match(duplicate.stderr, /workflow:resume/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('release-check fails closed before local CLAUDE is configured', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.deepEqual(output.blockedSurfaces.sort(), ['edge', 'frontend', 'sql']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pr, merge, deploy, and task-lock work with a fake gh adapter', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'API Work', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');

    const pr = JSON.parse(runCli(['run', 'pr', '--title', 'API Work', '--json'], created.worktreePath, env).stdout);
    assert.match(pr.url, /example\.test\/pr/);

    const verify = JSON.parse(runCli(['run', 'task-lock', 'verify', '--task', 'API Work', '--json'], created.worktreePath, env).stdout);
    assert.equal(verify.ok, true);

    const merged = JSON.parse(runCli(['run', 'merge', '--json'], created.worktreePath, env).stdout);
    assert.equal(merged.mergedSha, 'deadbeefcafebabe');

    const deployed = JSON.parse(runCli(['run', 'deploy', 'prod', '--json'], created.worktreePath, env).stdout);
    assert.equal(deployed.environment, 'prod');
    assert.equal(deployed.sha, 'deadbeefcafebabe');

    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.workflows.length, 1);
    assert.equal(ghState.workflows[0].name, 'Deploy Hosted');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('clean --apply prunes stale task locks', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Cleanup Me', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'remove', '--force', created.worktreePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['branch', '-D', created.branch], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = runCli(['run', 'clean', '--apply'], repoRoot);
    assert.match(result.stdout, /Pruned stale task locks/);
    assert.match(result.stdout, /cleanup-me/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});
