import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function writeFakeNpm(binDir, stateFile) {
  mkdirSync(binDir, { recursive: true });
  const targetPath = path.join(binDir, 'npm');
  writeFileSync(targetPath, `#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
const statePath = process.env.WORKFLOW_API_FIXTURE_FILE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const markerIndex = args.indexOf('--');
const workflowArgs = markerIndex === -1 ? args : args.slice(markerIndex + 1);

const valueAfter = (flag) => {
  const index = workflowArgs.indexOf(flag);
  return index === -1 ? '' : workflowArgs[index + 1] || '';
};

const respond = (payload, status = 0, stderr = '') => {
  if (stderr) {
    process.stderr.write(stderr);
  }
  process.stdout.write(JSON.stringify(payload, null, 2));
  process.exit(status);
};

const command = workflowArgs[0];
if (command === 'snapshot') {
  respond(state.snapshot, state.snapshotExitCode || 0);
}

if (command === 'branch') {
  const branchName = valueAfter('--branch');
  const branchState = state.branches[branchName];
  if (!branchState) {
    process.stderr.write('unknown branch');
    process.exit(1);
  }

  if (workflowArgs.includes('--patch')) {
    const filePath = valueAfter('--file');
    const scope = valueAfter('--scope') || 'branch';
    const patchKey = scope + ':' + filePath;
    if (!branchState.patches[patchKey]) {
      process.stderr.write('unknown patch');
      process.exit(1);
    }
    respond(branchState.patches[patchKey], branchState.patchExitCode || 0);
  }

  respond(branchState.details, branchState.detailsExitCode || 0);
}

if (command === 'action') {
  const actionId = workflowArgs[1];
  const actionState = state.actions[actionId];
  if (!actionState) {
    process.stderr.write('unknown action');
    process.exit(1);
  }

  if (workflowArgs.includes('--execute')) {
    if (actionState.executeStderr) {
      process.stderr.write(actionState.executeStderr);
    }
    setTimeout(() => {
      respond(actionState.execute, actionState.executeExitCode || 0);
    }, actionState.executeDelayMs || 15);
    return;
  }

  respond(actionState.preflight, actionState.preflightExitCode || 0);
}

process.stderr.write('unsupported fake npm invocation');
process.exit(1);
`, { mode: 0o755, encoding: 'utf8' });
}

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

async function startDashboardServer(repoRoot, env = {}) {
  const port = await getFreePort();
  const processHandle = spawn('node', [CLI_PATH, 'dashboard', '--repo', repoRoot, '--port', String(port)], {
    cwd: KIT_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  processHandle.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Dashboard server did not start in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 4000);

    const handleExit = (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dashboard server exited early with ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const handleStdout = () => {
      if (!stdout.includes(`Dashboard: http://127.0.0.1:${port}`)) {
        return;
      }
      clearTimeout(timeout);
      processHandle.stdout.off('data', handleStdout);
      processHandle.off('exit', handleExit);
      resolve();
    };

    processHandle.stdout.on('data', handleStdout);
    processHandle.once('exit', handleExit);
    handleStdout();
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    processHandle,
  };
}

function setWorkflowApiScript(repoRoot) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageJson.scripts = {
    ...(packageJson.scripts || {}),
    'workflow:api': 'node fake-workflow-api.js',
  };
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
}

function makeDashboardFixture() {
  const branchRow = {
    name: 'codex/pipeline-board-1234',
    status: 'open-pr',
    current: true,
    note: 'Ready for staging deploy.',
    task: {
      taskSlug: 'pipeline-board',
      mode: 'release',
      worktreePath: '/tmp/pipeline-board',
      updatedAt: '2026-04-14T20:00:00.000Z',
    },
    surfaces: ['frontend', 'sql'],
    cleanup: {
      available: false,
      eligible: false,
      reason: 'Cleanup should wait until the branch is live.',
    },
    pr: {
      number: 77,
      state: 'OPEN',
      url: 'https://example.test/pr/77',
      title: 'Pipeline board',
      mergedAt: null,
    },
    mergedSha: null,
    lanes: {
      local: {
        state: 'healthy',
        reason: 'local worktree exists and is clean',
        detail: '',
        freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
      },
      pr: {
        state: 'running',
        reason: 'PR #77 is open',
        detail: '',
        freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
      },
      base: {
        state: 'unknown',
        reason: 'branch has not landed on main yet',
        detail: 'Base: main',
        freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
      },
      staging: {
        state: 'awaiting_preflight',
        reason: 'ready for staging preflight',
        detail: '',
        freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
      },
      production: {
        state: 'blocked',
        reason: 'merge the branch before production deploy',
        detail: '',
        freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
      },
    },
    availableActions: [
      {
        id: 'deploy.staging',
        label: 'Deploy staging',
        state: 'awaiting_preflight',
        reason: 'run staging preflight for this task',
        risky: false,
        requiresConfirmation: false,
        freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
      },
      {
        id: 'deploy.prod',
        label: 'Deploy production',
        state: 'blocked',
        reason: 'merge the branch before production deploy',
        risky: true,
        requiresConfirmation: true,
        freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
      },
    ],
  };

  return {
    snapshot: {
      schemaVersion: '2026-04-14',
      command: 'workflow.api.snapshot',
      ok: true,
      message: 'workflow operator snapshot ready',
      warnings: [],
      issues: [],
      data: {
        boardContext: {
          mode: 'release',
          baseBranch: 'main',
          laneOrder: ['Local', 'PR', 'Base: main', 'Staging', 'Production'],
          releaseReadiness: {
            state: 'healthy',
            reason: 'release readiness is healthy',
            requestedSurfaces: ['frontend', 'sql'],
            blockedSurfaces: [],
            effectiveOverride: null,
            localReady: true,
            hostedReady: true,
            freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
          },
          activeTask: {
            taskSlug: 'pipeline-board',
            branchName: 'codex/pipeline-board-1234',
            worktreePath: '/tmp/pipeline-board',
            updatedAt: '2026-04-14T20:00:00.000Z',
          },
          overallFreshness: {
            checkedAt: '2026-04-14T20:00:00.000Z',
            observedAt: '2026-04-14T20:00:00.000Z',
            state: 'fresh',
          },
        },
        sourceHealth: [
          {
            name: 'git.local',
            state: 'healthy',
            blocking: false,
            reason: 'local branches loaded',
            freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
          },
        ],
        attention: [
          {
            severity: 'warning',
            branch: 'codex/pipeline-board-1234',
            lane: 'Staging',
            reason: 'Staging deploy has not run yet.',
            freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
            safeNextAction: 'deploy.staging',
          },
        ],
        availableActions: [
          {
            id: 'clean.plan',
            label: 'Plan cleanup',
            state: 'awaiting_preflight',
            reason: 'review cleanup candidates',
            risky: false,
            requiresConfirmation: false,
            freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
          },
        ],
        branches: [branchRow],
      },
    },
    branches: {
      'codex/pipeline-board-1234': {
        details: {
          schemaVersion: '2026-04-14',
          command: 'workflow.api.branch',
          ok: true,
          message: 'branch details ready for codex/pipeline-board-1234',
          warnings: [],
          issues: [],
          data: {
            branch: branchRow,
            branchFiles: [
              {
                path: 'src/dashboard.ts',
                changeType: 'modified',
                oldPath: '',
                scope: 'branch',
                patchAvailable: true,
                reason: '',
              },
            ],
            workspaceFiles: [
              {
                path: 'README.md',
                changeType: 'modified',
                oldPath: '',
                scope: 'workspace',
                patchAvailable: true,
                reason: '',
              },
              {
                path: 'notes.txt',
                changeType: 'untracked',
                oldPath: '',
                scope: 'workspace',
                patchAvailable: false,
                reason: 'patch preview is unavailable for untracked files',
              },
            ],
            counts: {
              branchFiles: 1,
              workspaceFiles: 2,
            },
            baseBranch: 'main',
            freshness: {
              checkedAt: '2026-04-14T20:00:00.000Z',
              observedAt: '2026-04-14T20:00:00.000Z',
              state: 'fresh',
            },
          },
        },
        patches: {
          'branch:src/dashboard.ts': {
            schemaVersion: '2026-04-14',
            command: 'workflow.api.branch.patch',
            ok: true,
            message: 'patch preview ready for src/dashboard.ts',
            warnings: [],
            issues: [],
            data: {
              branch: 'codex/pipeline-board-1234',
              path: 'src/dashboard.ts',
              scope: 'branch',
              patch: '@@ -1,3 +1,3 @@\\n-console.log(\"old\");\\n+console.log(\"new\");\\n',
              truncated: false,
              reason: '',
            },
          },
          'workspace:README.md': {
            schemaVersion: '2026-04-14',
            command: 'workflow.api.branch.patch',
            ok: true,
            message: 'patch preview ready for README.md',
            warnings: [],
            issues: [],
            data: {
              branch: 'codex/pipeline-board-1234',
              path: 'README.md',
              scope: 'workspace',
              patch: '@@ -1 +1 @@\\n-old\\n+new\\n',
              truncated: false,
              reason: '',
            },
          },
        },
      },
    },
    actions: {
      'deploy.staging': {
        preflight: {
          schemaVersion: '2026-04-14',
          command: 'workflow.api.action',
          ok: true,
          message: 'preflight ready',
          warnings: [],
          issues: [],
          data: {
            action: {
              id: 'deploy.staging',
              label: 'Deploy staging',
              risky: false,
            },
            preflight: {
              allowed: true,
              state: 'healthy',
              reason: 'staging deploy can run',
              warnings: [],
              issues: [],
              normalizedInputs: {
                taskSlug: 'pipeline-board',
              },
              requiresConfirmation: false,
              confirmation: null,
              freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
            },
          },
        },
        execute: {
          schemaVersion: '2026-04-14',
          command: 'workflow.api.action',
          ok: true,
          message: 'staging deploy started',
          warnings: [],
          issues: [],
          data: {
            action: {
              id: 'deploy.staging',
              label: 'Deploy staging',
              risky: false,
            },
            execution: {
              result: {
                environment: 'staging',
                sha: 'deadbeefcafebabe',
              },
            },
          },
        },
        executeStderr: 'Deploying staging...\\n',
      },
      'deploy.prod': {
        preflight: {
          schemaVersion: '2026-04-14',
          command: 'workflow.api.action',
          ok: false,
          message: 'confirmation required',
          warnings: [],
          issues: [],
          data: {
            action: {
              id: 'deploy.prod',
              label: 'Deploy production',
              risky: true,
            },
            preflight: {
              allowed: true,
              state: 'blocked',
              reason: 'Confirm production deploy.',
              warnings: [],
              issues: [],
              normalizedInputs: {
                taskSlug: 'pipeline-board',
              },
              requiresConfirmation: true,
              confirmation: {
                token: 'confirm-prod-token',
              },
              freshness: { checkedAt: '2026-04-14T20:00:00.000Z', observedAt: '2026-04-14T20:00:00.000Z', state: 'fresh' },
            },
          },
        },
        preflightExitCode: 1,
        execute: {
          schemaVersion: '2026-04-14',
          command: 'workflow.api.action',
          ok: true,
          message: 'production deploy started',
          warnings: [],
          issues: [],
          data: {
            action: {
              id: 'deploy.prod',
              label: 'Deploy production',
              risky: true,
            },
            execution: {
              result: {
                environment: 'prod',
                sha: 'deadbeefcafebabe',
              },
            },
          },
        },
        executeStderr: 'Deploying production...\\n',
      },
    },
  };
}

test('init writes tracked workflow files and setup seeds CLAUDE plus Codex wrappers', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-codex-'));

  try {
    const initResult = runCli(['init', '--project', 'Demo App'], repoRoot);
    assert.match(initResult.stdout, /Initialized pipelane/);
    assert.ok(existsSync(path.join(repoRoot, '.project-workflow.json')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'new.md')));
    assert.ok(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')));

    const setupResult = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    assert.match(setupResult.stdout, /[Pp]ipelane setup complete/);
    assert.ok(existsSync(path.join(repoRoot, 'CLAUDE.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'new', 'SKILL.md')));

    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    // Canonical pipelane:* script names
    assert.equal(packageJson.scripts['pipelane:new'], 'pipelane run new');
    assert.equal(packageJson.scripts['pipelane:resume'], 'pipelane run resume');
    assert.equal(packageJson.scripts['pipelane:board'], 'pipelane board');
    // Deprecation aliases for one release window — keep working through
    // the rename so existing Claude slash commands don't break.
    assert.equal(packageJson.scripts['workflow:new'], 'pipelane run new');
    assert.equal(packageJson.scripts['workflow:resume'], 'pipelane run resume');
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

test('new uses the default codex/ branch prefix', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Default Prefix', '--json'], repoRoot).stdout);
    assert.match(created.branch, /^codex\/default-prefix-[a-f0-9]{4}$/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('new honors a custom branchPrefix from .project-workflow.json', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const configPath = path.join(repoRoot, '.project-workflow.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.branchPrefix = 'task/';
    config.legacyBranchPrefixes = ['codex/'];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    commitAll(repoRoot, 'Adopt workflow-kit');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Custom Prefix', '--json'], repoRoot).stdout);
    assert.match(created.branch, /^task\/custom-prefix-[a-f0-9]{4}$/);

    // Repo-guard should still accept a legacy `codex/` branch for this task.
    execFileSync('git', ['checkout', '-b', 'codex/legacy-task-abcd'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const guarded = JSON.parse(runCli(['run', 'repo-guard', '--task', 'legacy-task', '--json'], repoRoot).stdout);
    assert.equal(guarded.createdWorktree, false, 'legacy prefix branch should satisfy repo-guard');
    assert.equal(guarded.lock.branchName, 'codex/legacy-task-abcd');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('new generates a task-<hex> slug when --task is omitted', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const created = JSON.parse(runCli(['run', 'new', '--json'], repoRoot).stdout);
    assert.match(created.taskSlug, /^task-[0-9a-f]{4}$/);
    assert.equal(created.createdWorktree, true);
    assert.ok(created.worktreePath.includes(created.taskSlug));
    assert.equal(run('git', ['branch', '--show-current'], created.worktreePath), created.branch);
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

test('dashboard proxies workflow:api routes and persists local board settings', async () => {
  const repoRoot = createRepo();
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-dashboard-bin-'));
  const fixtureFile = path.join(fakeBin, 'workflow-api-fixture.json');
  const fixture = makeDashboardFixture();
  const env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    WORKFLOW_API_FIXTURE_FILE: fixtureFile,
  };

  writeFakeNpm(fakeBin, fixtureFile);
  writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  setWorkflowApiScript(repoRoot);

  let server;

  try {
    server = await startDashboardServer(repoRoot, env);

    const health = await fetch(`${server.baseUrl}/api/health`).then((response) => response.json());
    assert.equal(health.workflowApiConfigured, true);
    assert.equal(health.repoExists, true);
    assert.ok(health.settingsPath);

    const settingsBefore = await fetch(`${server.baseUrl}/api/settings`).then((response) => response.json());
    assert.equal(settingsBefore.settings.boardTitle, `${path.basename(repoRoot)} Pipelane`);
    assert.equal(settingsBefore.settings.preferredPort, 3033);

    const settingsUpdateResponse = await fetch(`${server.baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          boardTitle: 'Operator Cockpit',
          boardSubtitle: 'Opinionated branch operations board.',
          preferredPort: 4044,
          autoRefreshSeconds: 45,
        },
      }),
    });
    assert.equal(settingsUpdateResponse.status, 200);
    const settingsUpdate = await settingsUpdateResponse.json();
    assert.equal(settingsUpdate.settings.boardTitle, 'Operator Cockpit');
    assert.equal(settingsUpdate.settings.autoRefreshSeconds, 45);
    assert.equal(settingsUpdate.restartRequired, true);

    const savedSettings = JSON.parse(readFileSync(settingsUpdate.settingsPath, 'utf8'));
    assert.equal(savedSettings.boardTitle, 'Operator Cockpit');
    assert.equal(savedSettings.preferredPort, 4044);

    const snapshot = await fetch(`${server.baseUrl}/api/snapshot`).then((response) => response.json());
    assert.equal(snapshot.command, 'workflow.api.snapshot');
    assert.equal(snapshot.data.branches[0].name, 'codex/pipeline-board-1234');

    const branch = await fetch(`${server.baseUrl}/api/branch/${encodeURIComponent('codex/pipeline-board-1234')}`).then((response) => response.json());
    assert.equal(branch.command, 'workflow.api.branch');
    assert.equal(branch.data.branchFiles[0].path, 'src/dashboard.ts');
    assert.equal(branch.data.workspaceFiles[1].patchAvailable, false);

    const patch = await fetch(`${server.baseUrl}/api/branch/${encodeURIComponent('codex/pipeline-board-1234')}/patch?file=${encodeURIComponent('src/dashboard.ts')}&scope=branch`).then((response) => response.json());
    assert.equal(patch.command, 'workflow.api.branch.patch');
    assert.match(patch.data.patch, /console\.log\("new"\)/);

    const preflightResponse = await fetch(`${server.baseUrl}/api/action/${encodeURIComponent('deploy.staging')}/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: { task: 'pipeline-board' } }),
    });
    assert.equal(preflightResponse.status, 200);
    const preflight = await preflightResponse.json();
    assert.equal(preflight.data.preflight.allowed, true);

    const executeResponse = await fetch(`${server.baseUrl}/api/action/${encodeURIComponent('deploy.prod')}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: { task: 'pipeline-board' }, confirmToken: 'confirm-prod-token' }),
    });
    assert.equal(executeResponse.status, 202);
    const executePayload = await executeResponse.json();
    assert.ok(executePayload.executionId);

    const streamText = await fetch(`${server.baseUrl}/api/executions/${executePayload.executionId}/events`).then((response) => response.text());
    assert.match(streamText, /event: start/);
    assert.match(streamText, /event: stderr/);
    assert.match(streamText, /event: final/);

    const execution = await fetch(`${server.baseUrl}/api/executions/${executePayload.executionId}`).then((response) => response.json());
    assert.equal(execution.execution.status, 'completed');
    assert.equal(execution.execution.finalEnvelope.data.execution.result.environment, 'prod');
  } finally {
    if (server?.processHandle) {
      server.processHandle.kill('SIGTERM');
      await once(server.processHandle, 'exit').catch(() => undefined);
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

async function runCliAsync(args, cwd, env = {}) {
  const child = spawn('node', [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const [code] = await once(child, 'exit');
  return { status: code ?? 0, stdout, stderr };
}

test('pipelane detects a running dashboard and skips spawning a second one', async () => {
  const repoRoot = createRepo();
  const port = await getFreePort();
  const probeHits = [];

  const fakeServer = createHttpServer((req, res) => {
    probeHits.push(req.url ?? '');
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, repoRoot }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  fakeServer.listen(port, '127.0.0.1');
  await once(fakeServer, 'listening');

  try {
    const result = await runCliAsync(
      ['pipelane', '--repo', repoRoot, '--port', String(port)],
      repoRoot,
      { PIPELANE_OPEN_COMMAND: 'skip' },
    );

    assert.equal(result.status, 0, `unexpected exit.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nprobeHits: ${JSON.stringify(probeHits)}`);
    assert.match(result.stdout, new RegExp(`already running at http://127\\.0\\.0\\.1:${port}`));
    assert.ok(probeHits.includes('/api/health'), 'expected /api/health to be probed');
  } finally {
    fakeServer.close();
    await once(fakeServer, 'close').catch(() => undefined);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pipelane status reports unreachable port and no PID file', async () => {
  const repoRoot = createRepo();
  const port = await getFreePort();

  try {
    const result = runCli(
      ['pipelane', 'status', '--repo', repoRoot, '--port', String(port)],
      repoRoot,
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Health: unreachable/);
    assert.match(result.stdout, /PID:\s+no PID file/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

function makeFakeUpdateBin(binDir, { latestSha, aheadCommits = [] }) {
  mkdirSync(binDir, { recursive: true });
  const gitPath = path.join(binDir, 'git');
  writeFileSync(gitPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'ls-remote' && args[2] === 'main') {
  process.stdout.write(${JSON.stringify(latestSha)} + '\\trefs/heads/main\\n');
  process.exit(0);
}
const { spawnSync } = require('node:child_process');
const res = spawnSync('/usr/bin/git', args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
`, { mode: 0o755, encoding: 'utf8' });

  const ghPath = path.join(binDir, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && /compare/.test(args[1] || '')) {
  const commits = ${JSON.stringify(aheadCommits)};
  process.stdout.write(JSON.stringify({ ahead_by: commits.length, commits: commits.map((c) => ({ sha: c.sha, commit: { message: c.subject } })) }));
  process.exit(0);
}
process.stderr.write('unsupported fake gh call: ' + args.join(' '));
process.exit(1);
`, { mode: 0o755, encoding: 'utf8' });
}

function writeFakeConsumer(consumerRoot, { installedVersion, installedSha }) {
  mkdirSync(path.join(consumerRoot, 'node_modules', 'pipelane'), { recursive: true });
  writeFileSync(
    path.join(consumerRoot, 'node_modules', 'pipelane', 'package.json'),
    JSON.stringify({ name: 'pipelane', version: installedVersion }, null, 2),
    'utf8',
  );
  writeFileSync(
    path.join(consumerRoot, 'package.json'),
    JSON.stringify({ name: 'fake-consumer', version: '0.0.1' }, null, 2),
    'utf8',
  );
  writeFileSync(
    path.join(consumerRoot, 'package-lock.json'),
    JSON.stringify({
      name: 'fake-consumer',
      version: '0.0.1',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fake-consumer', version: '0.0.1' },
        'node_modules/pipelane': {
          version: installedVersion,
          resolved: `git+ssh://git@github.com/jokim1/pipelane.git#${installedSha}`,
        },
      },
    }, null, 2),
    'utf8',
  );
}

test('update reports up-to-date when installed sha matches remote main', () => {
  const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-consumer-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const sha = '0123456789abcdef0123456789abcdef01234567';
  try {
    writeFakeConsumer(consumerRoot, { installedVersion: '0.2.0', installedSha: sha });
    makeFakeUpdateBin(binDir, { latestSha: sha });

    const result = spawnSync('node', [CLI_PATH, 'update', '--check', '--json'], {
      cwd: consumerRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, 'up-to-date');
    assert.equal(parsed.status.upToDate, true);
    assert.equal(parsed.status.installedSha, sha);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('update --check reports the commit list when behind', () => {
  const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-consumer-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const oldSha = '1111111111111111111111111111111111111111';
  const newSha = '2222222222222222222222222222222222222222';
  const commits = [
    { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'feat: first change\n\nbody' },
    { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', subject: 'fix: second change' },
  ];
  try {
    writeFakeConsumer(consumerRoot, { installedVersion: '0.2.0', installedSha: oldSha });
    makeFakeUpdateBin(binDir, { latestSha: newSha, aheadCommits: commits });

    const result = spawnSync('node', [CLI_PATH, 'update', '--check'], {
      cwd: consumerRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /updates available/);
    assert.match(result.stdout, /Installed: 1111111 \(v0\.2\.0\)/);
    assert.match(result.stdout, /Latest main: 2222222/);
    assert.match(result.stdout, /2 commits ahead/);
    assert.match(result.stdout, /feat: first change/);
    assert.match(result.stdout, /fix: second change/);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('update fails clearly when pipelane is not installed in consumer', () => {
  const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-missing-'));
  try {
    writeFileSync(
      path.join(consumerRoot, 'package.json'),
      JSON.stringify({ name: 'fake-consumer', version: '0.0.1' }, null, 2),
      'utf8',
    );
    const result = spawnSync('node', [CLI_PATH, 'update', '--check'], {
      cwd: consumerRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pipelane is not installed/);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test('pipelane help prints subcommand list', () => {
  const result = runCli(['pipelane', '--help'], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: workflow-kit pipelane/);
  assert.match(result.stdout, /start Pipelane Board/);
  assert.match(result.stdout, /stop the Pipelane Board/);
  assert.match(result.stdout, /--no-open/);
});
