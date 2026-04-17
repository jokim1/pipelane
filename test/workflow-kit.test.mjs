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

// Mark this process + every child spawn as a test run. Production-gated test
// hooks (PIPELANE_DEPLOY_PROD_CONFIRM_STUB, PIPELANE_CLEAN_MIN_AGE_MS) only
// activate when NODE_ENV is 'test', which prevents a stray env var in a
// shared shell from disabling a safety gate.
process.env.NODE_ENV = 'test';

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
  const pr = { number, title, url: 'https://example.test/pr/' + number, state: 'OPEN', mergeCommit: null, mergedAt: null };
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
    pr.state = 'MERGED';
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

// v1.2: derive readiness from observed staging deploys, not a stored
// .ready:true flag. The flag now has no authority — only DeployRecord history
// matters. These tests prove (a) flipping .ready:true does NOT clear the
// gate, and (b) a real staging-succeeded record DOES.
function buildFullDeployConfig(options = {}) {
  return {
    platform: 'fly.io',
    frontend: {
      production: {
        url: 'https://app.example.test',
        deployWorkflow: 'Deploy Hosted',
        autoDeployOnMain: false,
        healthcheckUrl: 'https://app.example.test/health',
      },
      staging: {
        url: 'https://staging.example.test',
        deployWorkflow: 'Deploy Hosted',
        healthcheckUrl: 'https://staging.example.test/health',
        ready: options.legacyReady === true,
      },
    },
    edge: {
      staging: {
        deployCommand: 'supabase functions deploy --staging',
        verificationCommand: 'supabase functions test',
        healthcheckUrl: 'https://staging.example.test/edge-health',
        ready: options.legacyReady === true,
      },
      production: {
        deployCommand: 'supabase functions deploy',
        verificationCommand: 'supabase functions test',
        healthcheckUrl: 'https://app.example.test/edge-health',
      },
    },
    sql: {
      staging: {
        applyCommand: 'supabase db push --staging',
        verificationCommand: 'supabase db lint',
        healthcheckUrl: 'https://staging.example.test/db-health',
        ready: options.legacyReady === true,
      },
      production: {
        applyCommand: 'supabase db push',
        verificationCommand: 'supabase db lint',
        healthcheckUrl: 'https://app.example.test/db-health',
      },
    },
    supabase: {
      staging: { projectRef: 'staging-ref' },
      production: { projectRef: 'production-ref' },
    },
  };
}

function writeFullDeployConfigClaude(repoRoot, options = {}) {
  const claudeMdPath = path.join(repoRoot, 'CLAUDE.md');
  const existing = readFileSync(claudeMdPath, 'utf8');
  const fullConfig = buildFullDeployConfig(options);
  const newSection = [
    '## Deploy Configuration',
    '',
    '```json',
    JSON.stringify(fullConfig, null, 2),
    '```',
    '',
  ].join('\n');
  // Replace the existing Deploy Configuration block (placed by setup) with
  // the populated one.
  const replaced = existing.replace(
    /## Deploy Configuration[\s\S]*?(?=\n##\s|$)/,
    newSection,
  );
  writeFileSync(claudeMdPath, replaced, 'utf8');
  return fullConfig;
}

async function fingerprintForFullConfig(options = {}) {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  return mod.computeDeployConfigFingerprint(buildFullDeployConfig(options));
}

async function writeStagingSucceededRecord(repoRoot, surfaces) {
  const stateDir = path.join(repoRoot, '.git', 'workflow-kit-state');
  mkdirSync(stateDir, { recursive: true });
  const fingerprint = await fingerprintForFullConfig();
  const verificationBySurface = Object.fromEntries(surfaces.map((s) => [
    s,
    { healthcheckUrl: 'https://staging.example.test/' + s + '-health', statusCode: 200, latencyMs: 50, probes: 2 },
  ]));
  const records = [{
    environment: 'staging',
    sha: '1111111111111111111111111111111111111111',
    surfaces,
    workflowName: 'Deploy Hosted',
    requestedAt: '2026-04-15T00:00:00Z',
    finishedAt: '2026-04-15T00:01:00Z',
    durationMs: 60000,
    taskSlug: 'bootstrap',
    status: 'succeeded',
    workflowRunId: 'run-1',
    verifiedAt: '2026-04-15T00:01:30Z',
    verification: verificationBySurface['frontend'] ?? verificationBySurface[surfaces[0]],
    verificationBySurface,
    configFingerprint: fingerprint,
    idempotencyKey: 'bootstrap-1',
    triggeredBy: 'test',
  }];
  writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({ records }, null, 2), 'utf8');
}

test('release-check blocks when CLAUDE config is full but no staging deploy record exists', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.deepEqual(output.blockedSurfaces.sort(), ['edge', 'frontend', 'sql']);
    assert.match(output.message, /no succeeded deploy observed/);
    assert.match(output.message, /workflow:deploy -- staging/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check ignores legacy .ready:true flag (v1.2 honor-system kill)', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    // Pre-v1.2 honor system: just flip .ready:true and the gate cleared.
    // Now it must NOT clear without an observed deploy record.
    writeFullDeployConfigClaude(repoRoot, { legacyReady: true });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.match(output.message, /no succeeded deploy observed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check passes when a staging-succeeded DeployRecord covers every requested surface', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);

    const result = runCli(['run', 'release-check', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 0);
    assert.equal(output.ready, true);
    assert.deepEqual(output.blockedSurfaces, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check still blocks the surfaces that lack a staging-succeeded record', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    // Only frontend has been observed-succeeded. edge + sql still blocked.
    await writeStagingSucceededRecord(repoRoot, ['frontend']);

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.deepEqual(output.blockedSurfaces.sort(), ['edge', 'sql']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check: a later staging failure re-blocks a previously-succeeded surface', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    const fingerprint = await fingerprintForFullConfig();

    const stateDir = path.join(repoRoot, '.git', 'workflow-kit-state');
    mkdirSync(stateDir, { recursive: true });
    // Records are ordered oldest → newest. A fresh succeeded deploy
    // followed by a failed re-deploy of the same surface must re-block.
    const okProbe = { healthcheckUrl: 'x', statusCode: 200, latencyMs: 10, probes: 2 };
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({
      records: [
        {
          environment: 'staging', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          surfaces: ['frontend', 'edge', 'sql'], workflowName: 'Deploy Hosted',
          requestedAt: '2026-04-10T00:00:00Z', finishedAt: '2026-04-10T00:01:00Z',
          taskSlug: 'bootstrap', status: 'succeeded',
          verifiedAt: '2026-04-10T00:01:30Z',
          verification: okProbe,
          verificationBySurface: { frontend: okProbe, edge: okProbe, sql: okProbe },
          configFingerprint: fingerprint,
          idempotencyKey: 'old-1', triggeredBy: 'test',
        },
        {
          environment: 'staging', sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          surfaces: ['frontend'], workflowName: 'Deploy Hosted',
          requestedAt: '2026-04-15T00:00:00Z', finishedAt: '2026-04-15T00:01:00Z',
          taskSlug: 'regression', status: 'failed',
          failureReason: 'healthcheck returned HTTP 503',
          configFingerprint: fingerprint,
          idempotencyKey: 'new-1', triggeredBy: 'test',
        },
      ],
    }, null, 2), 'utf8');

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    // frontend's latest record is FAILED → blocked. edge/sql's latest is
    // the earlier succeeded record → still cleared.
    assert.deepEqual(output.blockedSurfaces, ['frontend']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check rejects staging success records without verifiedAt', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);

    const stateDir = path.join(repoRoot, '.git', 'workflow-kit-state');
    mkdirSync(stateDir, { recursive: true });
    // Hand-forged record with status:'succeeded' but no verifiedAt and no
    // verification block. handleDeploy never produces this shape; only a
    // human or an AI writing deploy-state.json directly would.
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({
      records: [{
        environment: 'staging', sha: 'cccccccccccccccccccccccccccccccccccccccc',
        surfaces: ['frontend', 'edge', 'sql'], workflowName: 'Deploy Hosted',
        requestedAt: '2026-04-15T00:00:00Z',
        taskSlug: 'forged', status: 'succeeded',
        idempotencyKey: 'forged-1',
      }],
    }, null, 2), 'utf8');

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.match(output.message, /no succeeded deploy observed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('parseDeployConfigMarkdown preserves legacy .ready:true for backwards compat', async () => {
  // Guards against a silent parse regression: the flag is ignored by the
  // evaluator, but must still round-trip through the schema so old consumer
  // CLAUDE.md files don't produce undefined-property crashes.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  const markdown = [
    '## Deploy Configuration',
    '',
    '```json',
    JSON.stringify({
      platform: '',
      frontend: { production: { url: '', deployWorkflow: '', autoDeployOnMain: false, healthcheckUrl: '' },
        staging: { url: '', deployWorkflow: '', healthcheckUrl: '', ready: true } },
      edge: { staging: { deployCommand: '', verificationCommand: '', healthcheckUrl: '', ready: true },
        production: { deployCommand: '', verificationCommand: '', healthcheckUrl: '' } },
      sql: { staging: { applyCommand: '', verificationCommand: '', healthcheckUrl: '', ready: true },
        production: { applyCommand: '', verificationCommand: '', healthcheckUrl: '' } },
      supabase: { staging: { projectRef: '' }, production: { projectRef: '' } },
    }, null, 2),
    '```',
  ].join('\n');

  const parsed = mod.parseDeployConfigMarkdown(markdown);
  assert.ok(parsed, 'markdown parsed');
  assert.equal(parsed.frontend.staging.ready, true, 'frontend.staging.ready round-trips');
  assert.equal(parsed.edge.staging.ready, true, 'edge.staging.ready round-trips');
  assert.equal(parsed.sql.staging.ready, true, 'sql.staging.ready round-trips');
});

test('release-check re-blocks when the deploy config fingerprint drifts', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);

    // Baseline: record fingerprint matches current config → cleared.
    const baseline = JSON.parse(runCli(['run', 'release-check', '--json'], repoRoot).stdout);
    assert.equal(baseline.ready, true);

    // Now rotate the staging URL in CLAUDE.md. The record's stored
    // configFingerprint no longer matches → gate re-blocks, operator must
    // re-run staging to re-register against the new config shape.
    const claudeMdPath = path.join(repoRoot, 'CLAUDE.md');
    const existing = readFileSync(claudeMdPath, 'utf8');
    writeFileSync(
      claudeMdPath,
      existing.replace('staging.example.test', 'staging-v2.example.test'),
      'utf8',
    );

    const drifted = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(drifted.stdout);
    assert.equal(drifted.status, 1);
    assert.equal(output.ready, false);
    // The "no succeeded deploy observed" message is accurate: under the new
    // fingerprint, none of the existing records qualify.
    assert.match(output.message, /no succeeded deploy observed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check accepts HMAC-signed records when PIPELANE_DEPLOY_STATE_KEY is configured', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);

    const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
    const fingerprint = await fingerprintForFullConfig();
    const key = 'deadbeef'.repeat(8);
    const okProbe = { healthcheckUrl: 'https://staging.example.test/health', statusCode: 200, latencyMs: 50, probes: 2 };
    const record = {
      environment: 'staging',
      sha: '1111111111111111111111111111111111111111',
      surfaces: ['frontend', 'edge', 'sql'],
      workflowName: 'Deploy Hosted',
      requestedAt: '2026-04-15T00:00:00Z',
      finishedAt: '2026-04-15T00:01:00Z',
      durationMs: 60000,
      taskSlug: 'bootstrap',
      status: 'succeeded',
      workflowRunId: 'run-1',
      verifiedAt: '2026-04-15T00:01:30Z',
      verification: okProbe,
      verificationBySurface: { frontend: okProbe, edge: okProbe, sql: okProbe },
      configFingerprint: fingerprint,
      idempotencyKey: 'signed-1',
      triggeredBy: 'test',
    };
    const signed = { ...record, signature: mod.signDeployRecord(record, key) };
    const stateDir = path.join(repoRoot, '.git', 'workflow-kit-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({ records: [signed] }, null, 2), 'utf8');

    // With the key set, signed record clears the gate.
    const ok = runCli(['run', 'release-check', '--json'], repoRoot, { PIPELANE_DEPLOY_STATE_KEY: key });
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).ready, true);

    // With a DIFFERENT key configured, the same record's signature no longer
    // verifies → gate blocks. Proves the key actually participates.
    const blocked = runCli(['run', 'release-check', '--json'], repoRoot, { PIPELANE_DEPLOY_STATE_KEY: 'a'.repeat(64) }, true);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).ready, false);

    // Without the key configured, signature is ignored and the record clears
    // (backwards-compat path for consumers who haven't opted into signing).
    const unkeyed = runCli(['run', 'release-check', '--json'], repoRoot);
    assert.equal(unkeyed.status, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check: legacy aggregate verification only credits frontend', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    const fingerprint = await fingerprintForFullConfig();

    // Legacy-style record: no verificationBySurface, only the aggregate
    // verification block. Surfaces ['frontend','edge','sql'] — under the
    // new gate edge/sql lack their own probe results and must block.
    const stateDir = path.join(repoRoot, '.git', 'workflow-kit-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({
      records: [{
        environment: 'staging', sha: '1111111111111111111111111111111111111111',
        surfaces: ['frontend', 'edge', 'sql'], workflowName: 'Deploy Hosted',
        requestedAt: '2026-04-15T00:00:00Z', finishedAt: '2026-04-15T00:01:00Z',
        taskSlug: 'legacy', status: 'succeeded',
        verifiedAt: '2026-04-15T00:01:30Z',
        verification: { healthcheckUrl: 'x', statusCode: 200, latencyMs: 10, probes: 2 },
        configFingerprint: fingerprint,
        idempotencyKey: 'legacy-1', triggeredBy: 'test',
      }],
    }, null, 2), 'utf8');

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.deepEqual(output.blockedSurfaces.sort(), ['edge', 'sql']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check does not count failed staging records as observed success', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);

    const stateDir = path.join(repoRoot, '.git', 'workflow-kit-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({
      records: [{
        environment: 'staging',
        sha: '2222222222222222222222222222222222222222',
        surfaces: ['frontend', 'edge', 'sql'],
        workflowName: 'Deploy Hosted',
        requestedAt: '2026-04-15T00:00:00Z',
        finishedAt: '2026-04-15T00:00:30Z',
        status: 'failed',
        failureReason: 'workflow run reported non-zero exit',
        idempotencyKey: 'fail-1',
      }],
    }, null, 2), 'utf8');

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.match(output.message, /no succeeded deploy observed/);
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

    const deployed = JSON.parse(runCli(['run', 'deploy', 'prod', '--async', '--json'], created.worktreePath, env).stdout);
    assert.equal(deployed.environment, 'prod');
    assert.equal(deployed.sha, 'deadbeefcafebabe');
    assert.equal(deployed.status, 'requested');
    assert.equal(deployed.taskSlug, 'api-work');
    assert.ok(deployed.idempotencyKey, 'record carries an idempotencyKey');

    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.workflows.length, 1);
    assert.equal(ghState.workflows[0].name, 'Deploy Hosted');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy verifies via gh run watch + healthcheck stubs and records status=succeeded', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Verify Path', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Verify Path', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);

    const deployed = JSON.parse(runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env).stdout);
    assert.equal(deployed.status, 'succeeded');
    assert.equal(deployed.environment, 'staging');
    assert.equal(deployed.verification.statusCode, 200);
    assert.equal(deployed.verification.probes, 2);
    assert.ok(deployed.verifiedAt);
    assert.ok(deployed.durationMs >= 0);

    // Re-running the same deploy should short-circuit via idempotency.
    const redeployed = JSON.parse(runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env).stdout);
    assert.equal(redeployed.status, 'succeeded');
    assert.equal(redeployed.idempotencyKey, deployed.idempotencyKey);

    // Only ONE gh workflow run dispatch should be recorded (idempotent).
    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.workflows.length, 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy fails closed when healthcheck returns non-2xx', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '503',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Bad Healthcheck', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Bad Healthcheck', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);

    const failed = runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /healthcheck returned HTTP 503/);

    const stateFile = path.join(repoRoot, '.git', 'workflow-kit-state', 'deploy-state.json');
    const deployState = JSON.parse(readFileSync(stateFile, 'utf8'));
    const latest = deployState.records.at(-1);
    assert.equal(latest.status, 'failed');
    assert.equal(latest.verification.statusCode, 503);
    assert.equal(latest.taskSlug, 'bad-healthcheck');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy prod blocks without typed-SHA confirmation in a non-TTY', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'prod-confirm-test', '--json'], repoRoot);
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Prod Confirm', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Prod Confirm', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);

    // Succeed staging so the prod staging gate clears, which lets us exercise
    // the typed-SHA confirmation path.
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env);

    // No PIPELANE_DEPLOY_PROD_CONFIRM_STUB, no TTY → confirmation must fail.
    const blocked = runCli(['run', 'deploy', 'prod', '--json'], created.worktreePath, env, true);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /typed SHA prefix confirmation is required/);
    assert.match(blocked.stderr, /deadbeefcafebabe/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy prod proceeds when typed-SHA prefix matches via confirm stub', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const base = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'prod-confirm-test', '--json'], repoRoot);
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Prod Confirm OK', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Prod Confirm OK', '--json'], created.worktreePath, base);
    runCli(['run', 'merge', '--json'], created.worktreePath, base);
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, base);

    // Wrong prefix → rejected.
    const wrong = runCli(['run', 'deploy', 'prod', '--json'], created.worktreePath, {
      ...base,
      PIPELANE_DEPLOY_PROD_CONFIRM_STUB: 'beef',
    }, true);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /typed SHA prefix did not match/);

    // Correct prefix (first 4 chars of 'deadbeefcafebabe') → dispatches.
    const ok = JSON.parse(runCli(['run', 'deploy', 'prod', '--json'], created.worktreePath, {
      ...base,
      PIPELANE_DEPLOY_PROD_CONFIRM_STUB: 'DEAD',
    }).stdout);
    assert.equal(ok.status, 'succeeded');
    assert.equal(ok.environment, 'prod');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy prod rejects PIPELANE_DEPLOY_PROD_CONFIRM_STUB outside NODE_ENV=test', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const baseEnv = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'confirm-stub-gate', '--json'], repoRoot);
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Stub Gate', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Stub Gate', '--json'], created.worktreePath, baseEnv);
    runCli(['run', 'merge', '--json'], created.worktreePath, baseEnv);
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, baseEnv);

    // NODE_ENV explicitly NOT 'test'. CONFIRM_STUB must be rejected even
    // though its value would otherwise satisfy the prefix.
    const blocked = runCli(['run', 'deploy', 'prod', '--json'], created.worktreePath, {
      ...baseEnv,
      NODE_ENV: 'production',
      PIPELANE_DEPLOY_PROD_CONFIRM_STUB: 'DEAD',
    }, true);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /NODE_ENV is not "test"/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('api action deploy.prod --execute bypasses the TTY prompt via the API env var', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'prod-api-test', '--json'], repoRoot);
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Prod Api', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Prod Api', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env);

    // Preflight issues a token fingerprinted on the normalized deploy.prod inputs.
    const preflight = JSON.parse(runCli(
      ['run', 'api', 'action', 'deploy.prod', '--task', 'Prod Api'],
      created.worktreePath,
      env,
    ).stdout);
    const token = preflight.data.preflight.confirmation.token;
    assert.ok(token);

    // Execute goes through the CLI without a TTY and without a stub: the API
    // path injects PIPELANE_DEPLOY_PROD_API_CONFIRMED=1, which must skip the prompt.
    const executed = runCli(
      ['run', 'api', 'action', 'deploy.prod', '--task', 'Prod Api', '--execute', '--confirm-token', token],
      created.worktreePath,
      env,
    );
    const envelope = JSON.parse(executed.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.execution.exitCode, 0);
    assert.equal(envelope.data.execution.result.status, 'succeeded');
    assert.equal(envelope.data.execution.result.environment, 'prod');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy prod blocks when release-mode staging lacks a succeeded record', () => {
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
    // Switch to release mode with override (we're testing the prod gate,
    // not the release-readiness gate).
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'prod-gate-test', '--json'], repoRoot);
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Prod Gate', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Prod Gate', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);

    const blocked = runCli(['run', 'deploy', 'prod', '--async', '--json'], created.worktreePath, env, true);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /deploy prod blocked: no succeeded staging deploy/);
    assert.match(blocked.stderr, /deadbee/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('merge fails closed when gh never reports mergeCommit.oid', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  // Break the merge step: pr.state flips to MERGED but mergeCommit stays null,
  // so the poller sees a half-merged PR and must fail rather than invent a SHA.
  const ghPath = path.join(ghBin, 'gh');
  const original = readFileSync(ghPath, 'utf8');
  writeFileSync(
    ghPath,
    original.replace(
      "pr.mergeCommit = { oid: 'deadbeefcafebabe' };",
      "pr.state = 'MERGED'; pr.mergeCommit = null;",
    ),
    { mode: 0o755, encoding: 'utf8' },
  );

  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_MERGE_POLL_TIMEOUT_MS: '200',
    PIPELANE_MERGE_POLL_INTERVAL_MS: '50',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'SHA Miss', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'SHA Miss', '--json'], created.worktreePath, env);

    const failed = runCli(['run', 'merge', '--json'], created.worktreePath, env, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Timed out waiting for GitHub to report PR #\d+ as MERGED with a merge commit/);
    assert.doesNotMatch(failed.stderr, /rev-parse/);

    const prState = readFileSync(path.join(repoRoot, '.git', 'workflow-kit-state', 'pr-state.json'), 'utf8');
    assert.doesNotMatch(prState, /mergedSha/, 'no mergedSha recorded on failure');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('pr blocks denied paths and --force-include overrides per-path', () => {
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
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Deny Guard', '--json'], repoRoot).stdout);
    // A denied file (operator-local CLAUDE.md) + a .env secret + a harmless
    // feature file. The first two should block; the third is fine.
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'feature\n', 'utf8');
    writeFileSync(path.join(created.worktreePath, 'CLAUDE.md'), '# local\n', 'utf8');
    writeFileSync(path.join(created.worktreePath, '.env'), 'TOKEN=secret\n', 'utf8');

    const blocked = runCli(['run', 'pr', '--title', 'Deny Guard', '--json'], created.worktreePath, env, true);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /prPathDenyList/);
    assert.match(blocked.stderr, /CLAUDE\.md \(matched CLAUDE\.md\)/);
    assert.match(blocked.stderr, /\.env \(matched \.env\)/);

    // Nothing should have been staged or committed yet.
    const stagedAfterBlock = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: created.worktreePath,
      encoding: 'utf8',
    }).trim();
    assert.equal(stagedAfterBlock, '', 'no files staged after deny-list block');

    // Force-include both denied files to allow the PR through. This is
    // explicit, per-path: no global flag to disable the check.
    const ok = runCli(
      ['run', 'pr', '--title', 'Deny Guard', '--force-include', 'CLAUDE.md', '--force-include', '.env', '--json'],
      created.worktreePath,
      env,
    );
    assert.equal(ok.status, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('clean --apply --all-stale prunes stale task locks', () => {
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

    // PIPELANE_CLEAN_MIN_AGE_MS=0 bypasses the 5-minute prune floor for tests.
    const result = runCli(['run', 'clean', '--apply', '--all-stale'], repoRoot, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    assert.match(result.stdout, /Pruned stale task locks/);
    assert.match(result.stdout, /cleanup-me/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply without scope refuses to run', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const failed = runCli(['run', 'clean', '--apply'], repoRoot, {}, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /requires scope/);
    assert.match(failed.stderr, /--task <slug>/);
    assert.match(failed.stderr, /--all-stale/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply cannot combine --task and --all-stale', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const failed = runCli(['run', 'clean', '--apply', '--task', 'Anything', '--all-stale'], repoRoot, {}, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /cannot combine --task and --all-stale/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --task prunes just the named lock', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const keep = JSON.parse(runCli(['run', 'new', '--task', 'Keep Me', '--json'], repoRoot).stdout);
    const drop = JSON.parse(runCli(['run', 'new', '--task', 'Drop Me', '--json'], repoRoot).stdout);

    for (const created of [keep, drop]) {
      execFileSync('git', ['worktree', 'remove', '--force', created.worktreePath], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['branch', '-D', created.branch], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    const result = runCli(['run', 'clean', '--apply', '--task', 'Drop Me', '--json'], repoRoot, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, ['drop-me']);

    // keep-me's lock file must still exist.
    const keepLockPath = path.join(repoRoot, '.git', 'workflow-kit-state', 'task-locks', 'keep-me.json');
    assert.ok(existsSync(keepLockPath), 'targeted prune did not touch keep-me');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply refuses to prune locks with a missing or unparseable updatedAt', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Corrupt Meta', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'remove', '--force', created.worktreePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['branch', '-D', created.branch], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Corrupt the lock: remove updatedAt so lockAge() returns null. The
    // pruner must fail closed and skip, not sweep.
    const lockPath = path.join(repoRoot, '.git', 'workflow-kit-state', 'task-locks', 'corrupt-meta.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    delete lock.updatedAt;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');

    const result = runCli(['run', 'clean', '--apply', '--all-stale', '--json'], repoRoot);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, []);
    assert.equal(envelope.skipped.length, 1);
    assert.match(envelope.skipped[0].reason, /missing or unparseable/);
    assert.ok(existsSync(lockPath), 'corrupt lock preserved');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply refuses to prune locks younger than 5 minutes', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Too Young', '--json'], repoRoot).stdout);

    // Kill the worktree + branch so the lock looks dead, but leave the
    // lock file's updatedAt at "just now". Default 5-minute floor applies.
    execFileSync('git', ['worktree', 'remove', '--force', created.worktreePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['branch', '-D', created.branch], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = runCli(['run', 'clean', '--apply', '--all-stale', '--json'], repoRoot);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, []);
    assert.equal(envelope.skipped.length, 1);
    assert.equal(envelope.skipped[0].taskSlug, 'too-young');
    assert.match(envelope.skipped[0].reason, /below the 300s prune floor/);
    // The lock file should still exist.
    const lockPath = path.join(repoRoot, '.git', 'workflow-kit-state', 'task-locks', 'too-young.json');
    assert.ok(existsSync(lockPath), 'young lock kept');
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

test('api snapshot emits a wire-compatible envelope', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    runCli(['run', 'new', '--task', 'Snapshot Task', '--json'], repoRoot);

    const result = runCli(['run', 'api', 'snapshot'], repoRoot);
    const envelope = JSON.parse(result.stdout);

    assert.equal(envelope.schemaVersion, '2026-04-14');
    assert.equal(envelope.command, 'workflow.api.snapshot');
    assert.equal(envelope.ok, true);
    assert.ok(Array.isArray(envelope.warnings));
    assert.ok(Array.isArray(envelope.issues));
    assert.ok(envelope.data, 'data object present');

    const { boardContext, sourceHealth, attention, availableActions, branches } = envelope.data;
    assert.ok(boardContext);
    assert.equal(boardContext.baseBranch, 'main');
    assert.deepEqual(boardContext.laneOrder, ['Local', 'PR', 'Base: main', 'Staging', 'Production']);
    assert.ok(boardContext.overallFreshness?.checkedAt);
    assert.ok(Array.isArray(sourceHealth) && sourceHealth.length >= 1);
    assert.ok(sourceHealth.find((entry) => entry.name === 'git.local'));
    assert.ok(sourceHealth.find((entry) => entry.name === 'task-locks'));
    assert.ok(Array.isArray(attention));
    assert.ok(Array.isArray(availableActions));

    assert.ok(Array.isArray(branches) && branches.length === 1);
    const [branch] = branches;
    assert.match(branch.name, /^codex\/snapshot-task-[a-f0-9]{4}$/);
    assert.equal(branch.task.taskSlug, 'snapshot-task');
    for (const laneKey of ['local', 'pr', 'base', 'staging', 'production']) {
      assert.ok(branch.lanes[laneKey], `lane ${laneKey} present`);
      assert.ok(typeof branch.lanes[laneKey].state === 'string');
      assert.ok(branch.lanes[laneKey].freshness?.state);
    }
    assert.equal(branch.lanes.pr.state, 'awaiting_preflight', 'no PR opened yet');
    assert.equal(branch.lanes.base.state, 'awaiting_preflight', 'branch has not landed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api snapshot marks staging as bypassed in build mode', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    // Force a merged PR state so staging/production lanes are computed
    // beyond the "awaiting_preflight" fast-path.
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Bypass Check', '--json'], repoRoot).stdout);
    const prStatePath = path.join(repoRoot, '.git', 'workflow-kit-state', 'pr-state.json');
    mkdirSync(path.dirname(prStatePath), { recursive: true });
    writeFileSync(prStatePath, JSON.stringify({
      records: {
        'bypass-check': {
          taskSlug: 'bypass-check',
          branchName: created.branch,
          title: 'bypass check',
          number: 42,
          url: 'https://example.test/pr/42',
          mergedSha: 'deadbeefcafebabe00000000000000000000abcd',
          mergedAt: '2026-04-17T00:00:00Z',
          updatedAt: '2026-04-17T00:00:00Z',
        },
      },
    }, null, 2), 'utf8');

    const envelope = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    const [branch] = envelope.data.branches;
    assert.equal(branch.lanes.staging.state, 'bypassed', 'build mode bypasses staging');
    assert.equal(branch.lanes.production.state, 'awaiting_preflight', 'no prod deploy recorded');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action preflight: non-risky action returns no confirmation', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const envelope = JSON.parse(runCli(['run', 'api', 'action', 'resume'], repoRoot).stdout);
    assert.equal(envelope.schemaVersion, '2026-04-14');
    assert.equal(envelope.command, 'workflow.api.action');
    assert.equal(envelope.data.action.id, 'resume');
    assert.equal(envelope.data.action.risky, false);
    assert.equal(envelope.data.preflight.requiresConfirmation, false);
    assert.equal(envelope.data.preflight.confirmation, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action preflight: risky action issues a confirmation token', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const envelope = JSON.parse(runCli(['run', 'api', 'action', 'merge'], repoRoot).stdout);
    assert.equal(envelope.data.action.risky, true);
    assert.equal(envelope.data.preflight.requiresConfirmation, true);
    assert.ok(envelope.data.preflight.confirmation?.token);
    assert.match(envelope.data.preflight.confirmation.token, /^[a-f0-9]{32}$/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action execute: risky action rejects missing or bad tokens', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const noToken = runCli(['run', 'api', 'action', 'merge', '--execute'], repoRoot, {}, true);
    assert.equal(noToken.status, 1);
    const envelope1 = JSON.parse(noToken.stdout);
    assert.equal(envelope1.ok, false);
    assert.match(envelope1.data.preflight.reason, /No confirmation token/);

    const badToken = runCli(
      ['run', 'api', 'action', 'merge', '--execute', '--confirm-token', 'deadbeefdeadbeefdeadbeefdeadbeef'],
      repoRoot,
      {},
      true,
    );
    assert.equal(badToken.status, 1);
    const envelope2 = JSON.parse(badToken.stdout);
    assert.equal(envelope2.ok, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action execute: risky action accepts a matching confirm token and runs the handler', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    // clean.apply now requires scope. Pass --all-stale so the preflight is
    // allowed and the confirm token binds to that scope via the fingerprint.
    const preflight = JSON.parse(runCli(['run', 'api', 'action', 'clean.apply', '--all-stale'], repoRoot).stdout);
    const token = preflight.data.preflight.confirmation.token;
    assert.ok(token);

    const executed = runCli(
      ['run', 'api', 'action', 'clean.apply', '--all-stale', '--execute', '--confirm-token', token],
      repoRoot,
    );
    assert.equal(executed.status, 0);
    const envelope = JSON.parse(executed.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.action.id, 'clean.apply');
    assert.equal(envelope.data.execution.exitCode, 0);
    assert.ok(envelope.data.execution.result, 'handler output parsed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action preflight: clean.apply without scope returns allowed:false state:blocked and no token', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const result = runCli(['run', 'api', 'action', 'clean.apply'], repoRoot, {}, true);
    // Envelope is emitted even when preflight is blocked; exit is non-zero.
    assert.notEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.preflight.allowed, false);
    assert.equal(envelope.data.preflight.state, 'blocked');
    assert.equal(envelope.data.preflight.requiresConfirmation, false);
    assert.equal(envelope.data.preflight.confirmation, null);
    assert.match(envelope.data.preflight.reason, /requires scope/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action execute: non-risky action runs without a token', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const executed = runCli(['run', 'api', 'action', 'clean.plan', '--execute'], repoRoot);
    const envelope = JSON.parse(executed.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.action.risky, false);
    assert.equal(envelope.data.execution.exitCode, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
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
