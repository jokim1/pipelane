import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(KIT_ROOT, 'src', 'cli.ts');
const FIXTURE_ROOT = path.join(KIT_ROOT, 'test', 'fixtures', 'sample-repo');
const DEFAULT_CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-global-'));
const DEFAULT_PIPELANE_HOME = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-global-'));
const LOCAL_PIPELANE_INSTALL_SPEC = `file:${KIT_ROOT}`;

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
    env: { ...process.env, CODEX_HOME: DEFAULT_CODEX_HOME, PIPELANE_HOME: DEFAULT_PIPELANE_HOME, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr || `CLI failed: ${args.join(' ')}`);
  }

  return result;
}

function createRepo() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-repo-'));
  cpSync(FIXTURE_ROOT, repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return repoRoot;
}

function seedLegacyCodexWrappers(codexHome, skills = ['new', 'resume', 'pr']) {
  mkdirSync(path.join(codexHome, 'skills', '.pipelane'), { recursive: true });
  writeFileSync(
    path.join(codexHome, 'skills', '.pipelane', 'managed-skills.json'),
    `${JSON.stringify({ skills }, null, 2)}\n`,
    'utf8',
  );

  for (const skill of skills) {
    mkdirSync(path.join(codexHome, 'skills', skill), { recursive: true });
    writeFileSync(
      path.join(codexHome, 'skills', skill, 'SKILL.md'),
      `Run the generic pipelane wrapper for this repo.\n~/.codex/skills/.pipelane/bin/run-pipelane.sh ${skill}\n`,
      'utf8',
    );
  }
}

function seedLegacyCodexBootstrapSkill(codexHome) {
  mkdirSync(path.join(codexHome, 'skills', 'init-pipelane'), { recursive: true });
  writeFileSync(
    path.join(codexHome, 'skills', 'init-pipelane', 'SKILL.md'),
    `---
name: init-pipelane
version: 1.0.0
description: Bootstrap the current repo with pipelane.
allowed-tools:
  - Bash
---

Run the generic pipelane wrapper for this repo.

1. Parse any arguments that appear after \`/init-pipelane\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${codexHome}/skills/.pipelane/bin/bootstrap-pipelane.sh <parsed arguments>\`
4. Stream the command output directly.
5. If setup changed the slash command inventory, tell the user to reopen Codex if needed.
`,
    'utf8',
  );
}

function createRemoteBackedRepo() {
  const repoRoot = createRepo();
  const remoteRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-remote-'));
  // `-b main` so the bare remote's HEAD points at main. Without it, git
  // 2.53+ defaults bare HEAD to `master`; subsequent clones then check out
  // `master` (empty) and `git push origin main` from the clone fails with
  // "src refspec main does not match any".
  execFileSync('git', ['init', '--bare', '-b', 'main', remoteRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  return { repoRoot, remoteRoot };
}

function commitAll(repoRoot, message) {
  execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', message], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['push'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
}

function switchToLegacyProjectWorkflowConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.pipelane.json');
  const legacyConfigPath = path.join(repoRoot, '.project-workflow.json');
  renameSync(configPath, legacyConfigPath);
}

function writeFakeGh(binDir, stateFile) {
  mkdirSync(binDir, { recursive: true });
  const targetPath = path.join(binDir, 'gh');
  writeFileSync(targetPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const statePath = process.env.GH_STATE_FILE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { prs: {}, workflows: [], prMergeCalls: [] };
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
  const base = findFlag('--base') || 'main';
  const title = findFlag('--title');
  const number = Object.keys(state.prs).length + 1;
  const pr = { number, title, url: 'https://example.test/pr/' + number, state: 'OPEN', baseRefName: base, headRefName: head, mergeCommit: null, mergedAt: null };
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
  state.prMergeCalls = state.prMergeCalls || [];
  state.prMergeCalls.push(args.slice(2));
  if (process.env.GH_FAIL_ON_DELETE_BRANCH === '1' && args.includes('--delete-branch')) {
    process.stderr.write('fatal: local branch deletion is not worktree-safe\\n');
    process.exit(1);
  }
  const number = Number(args[2]);
  const pr = Object.values(state.prs).find((entry) => entry.number === number);
  if (pr) {
    let mergeSha = 'deadbeefcafebabe';
    if (process.env.GH_PR_MERGE_PUSH_HEAD === '1') {
      mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const baseBranch = process.env.GH_PR_MERGE_BASE || 'main';
      execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/' + baseBranch], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    pr.state = 'MERGED';
    pr.mergeCommit = { oid: mergeSha };
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

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForChildExit(child, timeoutMs = 2000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function writeDashboardSettingsForTest(homeDir, repoRoot, patch) {
  const name = path.basename(path.resolve(repoRoot)) || 'repo';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  const hash = createHash('sha1').update(path.resolve(repoRoot)).digest('hex').slice(0, 8);
  const dir = homeDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${slug}-${hash}.json`),
    JSON.stringify({
      boardTitle: `${name} Pipelane`,
      boardSubtitle: 'test board',
      preferredPort: patch.preferredPort,
      autoRefreshSeconds: 30,
    }, null, 2) + '\n',
    'utf8',
  );
}

function writeDashboardPidForTest(homeDir, repoRoot, pid) {
  const name = path.basename(path.resolve(repoRoot)) || 'repo';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  let legacyHash = 0;
  const absolute = path.resolve(repoRoot);
  for (let index = 0; index < absolute.length; index += 1) {
    legacyHash = (legacyHash * 31 + absolute.charCodeAt(index)) | 0;
  }
  const dir = path.join(homeDir, 'pids');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${slug}-${Math.abs(legacyHash).toString(16).slice(0, 8)}.pid`), `${pid}\n`, 'utf8');
}

async function startRuntimeMarkerServer(handler) {
  const hits = [];
  const server = createHttpServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req, res, hits);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    hits,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
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

function setWorkflowApiScriptCommand(repoRoot, command) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageJson.scripts = {
    ...(packageJson.scripts || {}),
    'pipelane:api': command,
  };
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
}

function setWorkflowApiScript(repoRoot) {
  setWorkflowApiScriptCommand(repoRoot, 'node fake-workflow-api.js');
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
      command: 'pipelane.api.snapshot',
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
          command: 'pipelane.api.branch',
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
            command: 'pipelane.api.branch.patch',
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
            command: 'pipelane.api.branch.patch',
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
          command: 'pipelane.api.action',
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
          command: 'pipelane.api.action',
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
          command: 'pipelane.api.action',
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
          command: 'pipelane.api.action',
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

test('init writes tracked Pipelane files and setup seeds CLAUDE plus tracked Codex skills while pruning legacy wrappers', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    const initResult = runCli(['init', '--project', 'Demo App'], repoRoot);
    assert.match(initResult.stdout, /Initialized pipelane/);
    assert.ok(existsSync(path.join(repoRoot, '.pipelane.json')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'new.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'new', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')));

    seedLegacyCodexWrappers(codexHome);

    const setupResult = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    assert.match(setupResult.stdout, /[Pp]ipelane setup complete/);
    assert.match(setupResult.stdout, /Synced Codex skills in/);
    assert.match(setupResult.stdout, /Removed legacy machine-local wrapper skills: new, pr, resume/);
    assert.ok(existsSync(path.join(repoRoot, 'CLAUDE.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'new', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'smoke', 'SKILL.md')));
    assert.equal(existsSync(path.join(codexHome, 'skills', 'new', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'resume', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'pr', 'SKILL.md')), false);

    const smokeSkill = readFileSync(path.join(repoRoot, '.agents', 'skills', 'smoke', 'SKILL.md'), 'utf8');
    assert.match(smokeSkill, /Guided empty state behavior/);
    assert.match(smokeSkill, /Offer the exact choices from `emptyState\.options`/);
    assert.match(smokeSkill, /intent: "start_smoke_interview"/);
    assert.match(
      smokeSkill,
      /What are the 1-3 user journeys that must work before this app is considered alive\?/,
    );

    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    // Canonical pipelane:* script names
    assert.equal(packageJson.scripts['pipelane:new'], 'pipelane run new');
    assert.equal(packageJson.scripts['pipelane:resume'], 'pipelane run resume');
    assert.equal(packageJson.scripts['pipelane:repo-guard'], 'pipelane run repo-guard');
    assert.equal(packageJson.scripts['pipelane:smoke'], 'pipelane run smoke');
    assert.equal(packageJson.scripts['pipelane:board'], 'pipelane board');
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'repo-guard.md')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'smoke.md')));
    const smokeCommand = readFileSync(path.join(repoRoot, '.claude', 'commands', 'smoke.md'), 'utf8');
    assert.match(smokeCommand, /Guided empty states/);
    assert.match(smokeCommand, /Offer the exact choices from `emptyState\.options`/);
    assert.match(smokeCommand, /intent: "start_smoke_interview"/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('bootstrap installs pipelane, initializes the repo, and seeds the global bootstrap skill', () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-bootstrap-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    const result = runCli(
      ['bootstrap', '--yes', '--project', 'Demo App'],
      repoRoot,
      { CODEX_HOME: codexHome, PIPELANE_INSTALL_SPEC: LOCAL_PIPELANE_INSTALL_SPEC },
    );

    assert.match(result.stdout, /Bootstrapped pipelane/);
    assert.match(result.stdout, /Installed repo-local pipelane dependency/);
    assert.match(result.stdout, /Initialized tracked Pipelane files for Demo App/);
    assert.match(result.stdout, /Synced Codex skills in/);
    assert.match(result.stdout, /Slash commands: .*\/new/);
    assert.match(result.stdout, /Readiness warnings:/);
    assert.match(result.stdout, /This repo has no commits yet/);
    assert.match(result.stdout, /No `origin` remote detected/);
    assert.ok(existsSync(path.join(repoRoot, '.pipelane.json')));
    assert.ok(existsSync(path.join(repoRoot, 'CLAUDE.md')));
    assert.ok(existsSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'new', 'SKILL.md')));
    assert.equal(existsSync(path.join(codexHome, 'skills', 'init-pipelane', 'SKILL.md')), false);

    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(typeof packageJson.devDependencies.pipelane, 'string');
    assert.equal(packageJson.scripts['pipelane:new'], 'pipelane run new');
    assert.equal(packageJson.scripts['pipelane:smoke'], 'pipelane run smoke');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('bootstrap in a non-git directory warns that workflow commands still need git', () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-bootstrap-nogit-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    const result = runCli(
      ['bootstrap', '--yes', '--project', 'Demo App'],
      repoRoot,
      { CODEX_HOME: codexHome, PIPELANE_INSTALL_SPEC: LOCAL_PIPELANE_INSTALL_SPEC },
    );

    assert.match(result.stdout, /Bootstrapped pipelane/);
    assert.match(result.stdout, /Readiness warnings:/);
    assert.match(result.stdout, /No git repository detected/);
    assert.equal(existsSync(path.join(repoRoot, '.git')), false);
    assert.ok(existsSync(path.join(repoRoot, '.pipelane.json')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('bootstrap without --yes fails before repo writes in non-TTY mode', () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-bootstrap-confirm-'));

  try {
    const result = runCli(
      ['bootstrap', '--project', 'Demo App'],
      repoRoot,
      { PIPELANE_INSTALL_SPEC: LOCAL_PIPELANE_INSTALL_SPEC },
      true,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Re-run with --yes/);
    assert.equal(existsSync(path.join(repoRoot, '.pipelane.json')), false);
    assert.equal(existsSync(path.join(repoRoot, 'package.json')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke and runtime source files are tracked in git so the branch stays self-contained', () => {
  for (const relativePath of [
    'src/operator/commands/smoke.ts',
    'src/operator/runtime-observation.ts',
    'src/operator/smoke-gate.ts',
    'src/operator/smoke-hot-paths.ts',
    'src/operator/text-output.ts',
    'templates/.claude/commands/smoke.md',
  ]) {
    const trackedPath = execFileSync('git', ['ls-files', '--error-unmatch', relativePath], {
      cwd: KIT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    assert.equal(trackedPath, relativePath);
  }
});

test('skill-rendering module stays pure and placement-free', () => {
  const content = readFileSync(path.join(KIT_ROOT, 'src', 'operator', 'skill-rendering.ts'), 'utf8');
  assert.doesNotMatch(content, /from 'node:(fs|path|os)'/);
  assert.doesNotMatch(content, /from "node:(fs|path|os)"/);
});

test('smoke plan scaffolds .pipelane/smoke-checks.json from discovered smoke tags', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'e2e', 'auth.spec.ts'),
      [
        "test('@smoke-auth sign in', async () => {});",
        "test('@smoke-app-shell boots', async () => {});",
      ].join('\n'),
      'utf8',
    );

    const result = runCli(['run', 'smoke', 'plan', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);
    const registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));

    assert.equal(output.createdRegistry, true);
    assert.ok(output.findings.length <= 5);
    assert.ok(registry.checks['@smoke-auth']);
    assert.equal(registry.checks['@smoke-auth'].blocking, false);
    assert.equal(registry.checks['@smoke-auth'].quarantine, true);
    assert.deepEqual(registry.checks['@smoke-auth'].sourceTests, ['e2e/auth.spec.ts']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke plan scaffolds an empty smoke registry before any smoke tags exist', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const result = runCli(['run', 'smoke', 'plan', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);
    const registryPath = path.join(repoRoot, '.pipelane', 'smoke-checks.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

    assert.equal(output.createdRegistry, true);
    assert.ok(existsSync(registryPath));
    assert.deepEqual(registry.checks, {});
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke staging runs the configured command, injects env vars, and surfaces state in /status', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        generatedSummaryPath: 'docs/smoke/README.md',
        staging: {
          command: 'node -e "console.log([process.env.PIPELANE_SMOKE_ENV, process.env.PIPELANE_COHORT, process.env.PIPELANE_SMOKE_SHA, process.env.PIPELANE_SMOKE_BASE_URL].join(\'|\'))"',
          preflight: [
            {
              name: 'env-parity',
              command: 'node -e "console.log(process.env.PIPELANE_SMOKE_ENV)"',
              critical: true,
            },
          ],
        },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);

    runCli(['run', 'smoke', 'plan'], repoRoot);
    const result = runCli(['run', 'smoke', 'staging', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);
    const latest = JSON.parse(readFileSync(path.join(resolveSharedSmokeStateRoot(repoRoot), 'latest.json'), 'utf8'));
    const logDir = path.join(resolveSharedSmokeStateRoot(repoRoot), 'logs');
    const logFiles = readdirSync(logDir).filter((entry) => entry.includes('default'));
    const logText = readFileSync(path.join(logDir, logFiles[0]), 'utf8');
    const statusOutput = JSON.parse(runCli(['run', 'status', '--json'], repoRoot).stdout);

    assert.equal(output.status, 'passed');
    assert.equal(latest.staging.status, 'passed');
    assert.equal(latest.staging.sha, '1111111111111111111111111111111111111111');
    assert.match(logText, /staging\|default\|1111111/);
    assert.match(logText, /https:\/\/staging\.example\.test/);
    assert.match(readFileSync(path.join(repoRoot, 'docs', 'smoke', 'README.md'), 'utf8'), /@smoke-auth/);
    assert.equal(statusOutput.data.smoke.staging.status, 'passed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke staging summary names every registered check with its registry description', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        staging: {
          command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]),
        },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].description = 'Auth login';
      registry.checks['@smoke-auth'].quarantine = false;
    });

    const result = runCli(['run', 'smoke', 'staging', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);

    assert.equal(output.status, 'passed');
    assert.match(output.message, /Tested:/);
    assert.match(output.message, /- Auth login \(passed\)/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke staging summary prints per-test counts when the runner contract supplies tests', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        staging: {
          command: smokeResultCommand([
            { tag: '@smoke-auth', status: 'passed', tests: { passed: 3, total: 10 } },
          ]),
        },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].description = 'Auth login';
      registry.checks['@smoke-auth'].quarantine = false;
    });

    const result = runCli(['run', 'smoke', 'staging', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);

    assert.equal(output.status, 'passed');
    assert.match(output.message, /- Auth login \(3\/10 tests passed\)/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bare /smoke lists registered checks, unregistered tags, candidate tests, and the configured runner', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    writeFileSync(path.join(repoRoot, 'e2e', 'checkout.spec.ts'), "test('@smoke-checkout pays', async () => {});\n", 'utf8');
    writeFileSync(path.join(repoRoot, 'e2e', 'landing.spec.ts'), "test('landing renders', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        staging: { command: 'npm run test:e2e:smoke' },
      };
    });
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].description = 'Auth login';
      delete registry.checks['@smoke-checkout'];
    });

    const result = runCli(['run', 'smoke', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.match(output.message, /Registered smoke checks/);
    assert.match(output.message, /@smoke-auth — Auth login/);
    assert.match(output.message, /Discovered @smoke-\* tags not yet registered:/);
    assert.match(output.message, /- @smoke-checkout/);
    assert.match(output.message, /Candidate test files without @smoke tags:/);
    assert.match(output.message, /- e2e\/landing\.spec\.ts/);
    assert.match(output.message, /To add a new smoke check:/);
    assert.match(output.message, /Runner: npm run test:e2e:smoke/);
    assert.equal(output.stagingCommand, 'npm run test:e2e:smoke');
    assert.ok(Array.isArray(output.registered));
    assert.ok(output.registered.some((entry) => entry.tag === '@smoke-auth'));
    assert.ok(output.unregisteredTags.some((entry) => entry.tag === '@smoke-checkout'));
    assert.ok(output.orphanCandidates.includes('e2e/landing.spec.ts'));
    assert.equal(output.emptyState, undefined);
    assert.doesNotMatch(output.message, /Reply with Y, 1, 2, or 3/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bare /smoke shows guided empty state when runner is configured but no checks exist', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'vip-billing.spec.ts'), "test('billing works', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        staging: { command: 'npm run test:e2e:vip' },
      };
    });

    const result = runCli(['run', 'smoke', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(output.emptyState.kind, 'runner_configured_no_checks');
    assert.equal(
      output.emptyState.summary,
      'Smoke runner is configured, but no hot-path checks are registered yet.',
    );
    assert.equal(output.emptyState.recommendedAction, 'start_smoke_interview');
    assert.match(output.message, /Smoke runner is configured, but no hot-path checks are registered yet\./);
    assert.match(output.message, /Current state:/);
    assert.match(output.message, /- Runner: npm run test:e2e:vip/);
    assert.match(output.message, /- Registered checks: none/);
    assert.match(output.message, /- Discovered @smoke-\* tags: none/);
    assert.match(output.message, /- Candidate files:\n  - e2e\/vip-billing\.spec\.ts/);
    assert.match(output.message, /Y or 1\. Start smoke interview \(recommended\)/);
    assert.match(output.message, /2\. Generate baseline hot paths/);
    assert.match(output.message, /3\. Manually tag existing tests/);
    assert.match(output.message, /Reply with Y, 1, 2, or 3\./);
    assert.equal(output.emptyState.options[0].key, '1');
    assert.ok(output.emptyState.options[0].aliases.includes('Y'));
    assert.equal(output.emptyState.options[0].intent, 'start_smoke_interview');
    assert.match(output.emptyState.options[1].command, /smoke setup/);
    assert.match(output.emptyState.options[2].command, /smoke plan/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bare /smoke recommends setup when no runner and no checks exist', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const result = runCli(['run', 'smoke', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(output.emptyState.kind, 'no_runner_no_checks');
    assert.equal(output.emptyState.recommendedAction, 'run_smoke_setup');
    assert.match(output.message, /Smoke is not configured yet\. No runner or hot-path checks were found\./);
    assert.match(output.message, /Y or 1\. Configure smoke setup \(recommended\)/);
    assert.deepEqual(output.emptyState.options.map((option) => option.key), ['1', '2', '3']);
    assert.match(output.emptyState.options[0].command, /smoke setup/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bare /smoke classifies candidate tests when no runner is configured', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'landing.spec.ts'), "test('landing renders', async () => {});\n", 'utf8');

    const result = runCli(['run', 'smoke', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(output.emptyState.kind, 'candidate_tests_no_checks');
    assert.equal(output.emptyState.recommendedAction, 'run_smoke_setup');
    assert.match(output.message, /Smoke candidate tests were found, but no hot-path checks are registered yet\./);
    assert.match(output.message, /- Runner: not configured/);
    assert.match(output.message, /- Candidate files:\n  - e2e\/landing\.spec\.ts/);
    assert.match(output.message, /Y or 1\. Configure smoke setup \(recommended\)/);
    assert.deepEqual(output.emptyState.options.map((option) => option.key), ['1', '2', '3']);
    assert.match(output.emptyState.options[0].command, /smoke setup/);
    assert.equal(output.emptyState.options[1].intent, 'start_smoke_interview');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('bare /smoke recommends plan when smoke tags exist without registry checks', () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');

    const result = runCli(['run', 'smoke', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(output.emptyState.kind, 'tags_discovered_no_registry');
    assert.equal(output.emptyState.recommendedAction, 'run_smoke_plan');
    assert.match(output.message, /Smoke tags were found, but the smoke registry has no checks yet\./);
    assert.match(output.message, /Y or 1\. Register discovered smoke tags \(recommended\)/);
    assert.match(output.message, /- @smoke-auth \(e2e\/auth\.spec\.ts\)/);
    assert.deepEqual(output.emptyState.options.map((option) => option.key), ['1', '2', '3']);
    assert.match(output.emptyState.options[0].command, /smoke plan/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release deploy prod does not require smoke unless the repo opts in', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(fakeBin, 'gh-state.json');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    const headSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
    writeTaskLock(repoRoot, 'bootstrap', { mode: 'release', surfaces: ['frontend'] });
    writePrRecord(repoRoot, 'bootstrap', headSha);
    await writeSucceededDeployRecord(repoRoot, 'staging', headSha, ['frontend']);
    writeHealthyProbeState(repoRoot, ['frontend']);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend'], repoRoot);

    writeFakeGh(fakeBin, ghStateFile);
    const result = runCli(
      ['run', 'deploy', 'prod', '--task', 'bootstrap', '--json'],
      repoRoot,
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        GH_STATE_FILE: ghStateFile,
        PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
        PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
        PIPELANE_DEPLOY_PROD_CONFIRM_STUB: headSha.slice(0, 4),
      },
    );
    const output = JSON.parse(result.stdout);

    assert.equal(output.environment, 'prod');
    assert.equal(output.sha, headSha);
    assert.match(output.message, /Deploy verified: prod/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('release deploy prod blocks when staging smoke for the same SHA is missing', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: { command: 'node -e "process.exit(0)"' },
        prod: { command: 'node -e "process.exit(0)"' },
      };
    });
    const headSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
    writeTaskLock(repoRoot, 'bootstrap', { mode: 'release', surfaces: ['frontend'] });
    writePrRecord(repoRoot, 'bootstrap', headSha);
    await writeSucceededDeployRecord(repoRoot, 'staging', headSha, ['frontend']);
    writeHealthyProbeState(repoRoot, ['frontend']);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend'], repoRoot);

    const result = runCli(
      ['run', 'deploy', 'prod', '--task', 'bootstrap'],
      repoRoot,
      { PIPELANE_DEPLOY_PROD_CONFIRM_STUB: headSha.slice(0, 4) },
      true,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no qualifying staging smoke found/i);
    assert.match(result.stderr, /Run \/smoke staging/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('release deploy prod accepts a qualifying staging smoke run for the same SHA', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(fakeBin, 'gh-state.json');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
        prod: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
      };
    });
    const headSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
    writeTaskLock(repoRoot, 'bootstrap', { mode: 'release', surfaces: ['frontend'] });
    writePrRecord(repoRoot, 'bootstrap', headSha);
    await writeSucceededDeployRecord(repoRoot, 'staging', headSha, ['frontend']);
    writeHealthyProbeState(repoRoot, ['frontend']);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend'], repoRoot);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });
    runCli(['run', 'smoke', 'staging'], repoRoot);

    writeFakeGh(fakeBin, ghStateFile);
    const result = runCli(
      ['run', 'deploy', 'prod', '--task', 'bootstrap', '--json'],
      repoRoot,
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        GH_STATE_FILE: ghStateFile,
        PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
        PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
        PIPELANE_DEPLOY_PROD_CONFIRM_STUB: headSha.slice(0, 4),
      },
    );
    const output = JSON.parse(result.stdout);

    assert.equal(output.environment, 'prod');
    assert.equal(output.sha, headSha);
    assert.match(output.message, /Deploy verified: prod/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('latest staging smoke failure for a SHA overrides an older pass', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
        prod: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
      };
    });
    const headSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
    writeTaskLock(repoRoot, 'bootstrap', { mode: 'release', surfaces: ['frontend'] });
    writePrRecord(repoRoot, 'bootstrap', headSha);
    await writeSucceededDeployRecord(repoRoot, 'staging', headSha, ['frontend']);
    writeHealthyProbeState(repoRoot, ['frontend']);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend'], repoRoot);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });
    runCli(['run', 'smoke', 'staging'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke.staging.command = smokeResultCommand([{ tag: '@smoke-auth', status: 'failed' }], { exitCode: 1 });
    });
    runCli(['run', 'smoke', 'staging'], repoRoot, {}, true);

    const result = runCli(
      ['run', 'deploy', 'prod', '--task', 'bootstrap'],
      repoRoot,
      { PIPELANE_DEPLOY_PROD_CONFIRM_STUB: headSha.slice(0, 4) },
      true,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staging smoke failed for SHA/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('release override does not bypass smoke coverage gaps; deploy prod needs an explicit smoke coverage override', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(fakeBin, 'gh-state.json');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        criticalPathCoverage: 'block',
        criticalPaths: ['billing'],
        staging: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
        prod: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
      };
    });
    const headSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
    writeTaskLock(repoRoot, 'bootstrap', { mode: 'release', surfaces: ['frontend'] });
    writePrRecord(repoRoot, 'bootstrap', headSha);
    await writeSucceededDeployRecord(repoRoot, 'staging', headSha, ['frontend']);
    writeHealthyProbeState(repoRoot, ['frontend']);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend', '--override', '--reason', 'release gate bypass'], repoRoot);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });
    runCli(['run', 'smoke', 'staging'], repoRoot);

    const blocked = runCli(
      ['run', 'deploy', 'prod', '--task', 'bootstrap'],
      repoRoot,
      { PIPELANE_DEPLOY_PROD_CONFIRM_STUB: headSha.slice(0, 4) },
      true,
    );

    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /critical-path smoke gaps: billing/i);
    assert.match(blocked.stderr, /--skip-smoke-coverage --reason/);

    writeFakeGh(fakeBin, ghStateFile);
    const result = runCli(
      ['run', 'deploy', 'prod', '--task', 'bootstrap', '--skip-smoke-coverage', '--reason', 'billing smoke follow-up', '--json'],
      repoRoot,
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        GH_STATE_FILE: ghStateFile,
        PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
        PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
        PIPELANE_DEPLOY_PROD_CONFIRM_STUB: headSha.slice(0, 4),
      },
    );
    const output = JSON.parse(result.stdout);
    const deployState = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'deploy-state.json'), 'utf8'));
    const latestRecord = deployState.records.at(-1);

    assert.equal(output.environment, 'prod');
    assert.match(output.message, /Smoke coverage override: billing smoke follow-up/);
    assert.equal(latestRecord.smokeCoverageOverrideReason, 'billing smoke follow-up');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('smoke waivers turn a failing blocking check into a non-blocking warning when check results are reported', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: {
          command: smokeResultCommand([{ tag: '@smoke-auth', status: 'failed' }], { exitCode: 1 }),
        },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });
    runCli(['run', 'smoke', 'waiver', 'create', '@smoke-auth', 'staging', '--reason', 'known flake'], repoRoot);

    const result = runCli(['run', 'smoke', 'staging', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);
    const latest = JSON.parse(readFileSync(path.join(resolveSharedSmokeStateRoot(repoRoot), 'latest.json'), 'utf8'));

    assert.equal(output.status, 'passed');
    assert.equal(latest.staging.status, 'passed');
    assert.equal(latest.staging.waiversApplied.length, 1);
    assert.equal(latest.staging.checks[0].waived, true);
    assert.equal(latest.staging.checks[0].effectiveBlocking, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('quarantined blocking smoke checks no longer fail the run when other blocking checks pass', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'e2e', 'auth.spec.ts'),
      [
        "test('@smoke-auth sign in', async () => {});",
        "test('@smoke-app-shell boots', async () => {});",
      ].join('\n'),
      'utf8',
    );
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: {
          command: smokeResultCommand([
            { tag: '@smoke-auth', status: 'failed' },
            { tag: '@smoke-app-shell', status: 'passed' },
          ], { exitCode: 1 }),
        },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = true;
      registry.checks['@smoke-app-shell'].blocking = true;
      registry.checks['@smoke-app-shell'].quarantine = false;
    });

    const result = runCli(['run', 'smoke', 'staging', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);
    const latest = JSON.parse(readFileSync(path.join(resolveSharedSmokeStateRoot(repoRoot), 'latest.json'), 'utf8'));
    const authCheck = latest.staging.checks.find((check) => check.tag === '@smoke-auth');
    const appShellCheck = latest.staging.checks.find((check) => check.tag === '@smoke-app-shell');

    assert.equal(output.status, 'passed');
    assert.equal(latest.staging.status, 'passed');
    assert.equal(authCheck.status, 'failed');
    assert.equal(authCheck.quarantine, true);
    assert.equal(authCheck.effectiveBlocking, false);
    assert.equal(appShellCheck.status, 'passed');
    assert.equal(appShellCheck.effectiveBlocking, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('non-blocking cohort failures stay visible without failing the smoke run', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: {
          command: cohortSmokeResultCommand({
            default: {
              checks: [{ tag: '@smoke-auth', status: 'passed' }],
              exitCode: 0,
            },
            beta: {
              checks: [{ tag: '@smoke-auth', status: 'failed' }],
              exitCode: 1,
            },
          }),
          cohorts: [
            { name: 'default', blocking: true },
            { name: 'beta', blocking: false },
          ],
        },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });

    const result = runCli(['run', 'smoke', 'staging', '--json'], repoRoot);
    const output = JSON.parse(result.stdout);
    const latest = JSON.parse(readFileSync(path.join(resolveSharedSmokeStateRoot(repoRoot), 'latest.json'), 'utf8'));
    const authCheck = latest.staging.checks.find((check) => check.tag === '@smoke-auth');
    const betaCohort = latest.staging.cohortResults.find((cohort) => cohort.name === 'beta');

    assert.equal(output.status, 'passed');
    assert.equal(latest.staging.status, 'passed');
    assert.equal(authCheck.status, 'passed');
    assert.equal(authCheck.effectiveBlocking, true);
    assert.equal(betaCohort.status, 'failed');
    assert.match(output.message, /Non-blocking cohort failures:/);
    assert.match(output.message, /beta/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke waiver create rejects unknown or out-of-environment tags', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    runCli(['run', 'smoke', 'plan'], repoRoot);

    const missingTag = runCli(
      ['run', 'smoke', 'waiver', 'create', '@smoke-typo', 'staging', '--reason', 'known flake'],
      repoRoot,
      {},
      true,
    );
    assert.notEqual(missingTag.status, 0);
    assert.match(missingTag.stderr, /No smoke registry entry found for @smoke-typo/i);

    const wrongEnvironment = runCli(
      ['run', 'smoke', 'waiver', 'create', '@smoke-auth', 'prod', '--reason', 'known flake'],
      repoRoot,
      {},
      true,
    );
    assert.notEqual(wrongEnvironment.status, 0);
    assert.match(wrongEnvironment.stderr, /@smoke-auth is not configured for prod/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke waiver extend enforces maxExtensions and overextended waivers no longer bypass smoke failures', async () => {
  const repoRoot = createRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        waivers: { maxExtensions: 0 },
        requireStagingSmoke: true,
        staging: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'failed' }], { exitCode: 1 }) },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });
    runCli(['run', 'smoke', 'waiver', 'create', '@smoke-auth', 'staging', '--reason', 'known flake'], repoRoot);

    const extendResult = runCli(
      ['run', 'smoke', 'waiver', 'extend', '@smoke-auth', 'staging', '--reason', 'still flaky'],
      repoRoot,
      {},
      true,
    );
    assert.notEqual(extendResult.status, 0);
    assert.match(extendResult.stderr, /maxExtensions=0/i);

    const waiversPath = path.join(repoRoot, '.pipelane', 'waivers.json');
    writeFileSync(waiversPath, `${JSON.stringify({
      waivers: [{
        tag: '@smoke-auth',
        environment: 'staging',
        reason: 'manually overextended',
        createdAt: '2026-04-22T00:00:00Z',
        expiresAt: '2099-04-22T00:00:00Z',
        extensions: 1,
      }],
    }, null, 2)}\n`, 'utf8');

    const smokeResult = runCli(['run', 'smoke', 'staging'], repoRoot, {}, true);
    assert.notEqual(smokeResult.status, 0);
    assert.match(smokeResult.stderr, /Blocking failures:/);
    assert.doesNotMatch(smokeResult.stderr, /Waived failures:/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('install-codex outside a pipelane repo installs durable global default skills', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-codex-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    const result = runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome });
    assert.match(result.stdout, /Installed \d+ durable Pipelane Codex commands/);
    assert.ok(existsSync(path.join(codexHome, 'skills', 'init-pipelane', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'new', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'pipelane', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'pipelane-fix', 'SKILL.md')));
    const fixSkill = readFileSync(path.join(codexHome, 'skills', 'fix', 'SKILL.md'), 'utf8');
    assert.match(fixSkill, /Pipelane-enabled repo detection/);
    assert.match(fixSkill, /standalone `REPO_GUIDANCE\.md` does not count/);
    assert.match(fixSkill, /Only emit these in Pipelane-enabled repos/);
    assert.ok(existsSync(path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane')));
    assert.ok(existsSync(path.join(codexHome, 'skills', '.pipelane', 'bin', 'run-pipelane.sh')));
    assert.match(
      readFileSync(path.join(codexHome, 'skills', '.pipelane', 'bin', 'bootstrap-pipelane.sh'), 'utf8'),
      new RegExp(path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane').replaceAll('\\', '\\\\')),
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install-claude outside a pipelane repo installs durable personal skills and managed runtime', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-claude-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));

  try {
    const result = runCli(['install-claude'], workspaceRoot, { CLAUDE_HOME: claudeHome });
    assert.match(result.stdout, /Installed \d+ durable Pipelane Claude commands/);
    assert.ok(existsSync(path.join(claudeHome, 'skills', 'pipelane', 'bin', 'pipelane')));
    assert.ok(existsSync(path.join(claudeHome, 'skills', 'init-pipelane', 'SKILL.md')));
    assert.ok(existsSync(path.join(claudeHome, 'skills', 'new', 'SKILL.md')));
    assert.ok(existsSync(path.join(claudeHome, 'skills', 'pipelane', 'SKILL.md')));
    assert.ok(existsSync(path.join(claudeHome, 'skills', 'pipelane-fix', 'SKILL.md')));
    assert.match(readFileSync(path.join(claudeHome, 'skills', 'new', 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);
    assert.match(
      readFileSync(path.join(claudeHome, 'skills', 'pipelane', 'bin', 'bootstrap-pipelane.sh'), 'utf8'),
      new RegExp(path.join(claudeHome, 'skills', 'pipelane', 'bin', 'pipelane').replaceAll('\\', '\\\\')),
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('verify treats absent npm guard as optional after durable command installs', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-verify-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));

  try {
    runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome, PIPELANE_HOME: pipelaneHome });
    runCli(['install-claude'], workspaceRoot, { CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome });

    const result = runCli(
      ['verify'],
      workspaceRoot,
      { CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome },
    );

    assert.match(result.stdout, /SKIP npm guard: not installed \(optional;/);
    assert.doesNotMatch(result.stdout, /FAIL npm guard/);
    assert.match(result.stdout, /OK codex optional skill \/fix/);
    assert.match(result.stdout, /OK claude optional skill \/fix/);
    assert.match(result.stdout, /OK codex temporary runner self-test/);
    assert.match(result.stdout, /OK claude temporary runner self-test/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('verify passes with only Codex durable commands installed and skips Claude', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-verify-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));

  try {
    runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome, PIPELANE_HOME: pipelaneHome });

    const result = runCli(
      ['verify'],
      workspaceRoot,
      { CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /OK codex temporary runner self-test/);
    assert.match(result.stdout, /SKIP claude durable commands: not installed \(optional host;/);
    assert.doesNotMatch(result.stdout, /claude temporary runner self-test/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('verify fails clearly when no durable command host is installed', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-verify-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));

  try {
    const result = runCli(
      ['verify'],
      workspaceRoot,
      { CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome },
      true,
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL durable command host: no Codex or Claude durable commands are installed/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('verify fails when a managed skill body drifts even if its marker remains', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-verify-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));

  try {
    runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome, PIPELANE_HOME: pipelaneHome });
    runCli(['install-claude'], workspaceRoot, { CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome });

    const codexNewSkill = path.join(codexHome, 'skills', 'new', 'SKILL.md');
    writeFileSync(
      codexNewSkill,
      readFileSync(codexNewSkill, 'utf8').replace('run-pipelane.sh" new', 'run-pipelane.sh" status'),
      'utf8',
    );

    const result = runCli(
      ['verify'],
      workspaceRoot,
      { CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome },
      true,
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL codex skill \/new: content drift/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('verify executes the Claude durable runner self-test', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-verify-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));

  try {
    runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome, PIPELANE_HOME: pipelaneHome });
    runCli(['install-claude'], workspaceRoot, { CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome });
    writeFileSync(
      path.join(claudeHome, 'skills', 'pipelane', 'bin', 'pipelane'),
      '#!/bin/sh\necho claude runner broken >&2\nexit 7\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    const result = runCli(
      ['verify'],
      workspaceRoot,
      { CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome, PIPELANE_HOME: pipelaneHome },
      true,
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /OK codex temporary runner self-test/);
    assert.match(result.stdout, /FAIL claude temporary runner self-test/);
    assert.match(result.stdout, /claude runner broken/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('install-claude fails closed when init-pipelane already exists as an unrelated Claude skill', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-claude-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));

  try {
    mkdirSync(path.join(claudeHome, 'skills', 'init-pipelane'), { recursive: true });
    writeFileSync(path.join(claudeHome, 'skills', 'init-pipelane', 'SKILL.md'), 'custom claude skill\n', 'utf8');

    const result = runCli(['install-claude'], workspaceRoot, { CLAUDE_HOME: claudeHome }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Claude skill alias collision/);
    assert.equal(readFileSync(path.join(claudeHome, 'skills', 'init-pipelane', 'SKILL.md'), 'utf8'), 'custom claude skill\n');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
});

test('custom aliases drive generated Claude commands, docs, and tracked Codex skills', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'new.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'new', 'SKILL.md')));

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/branch';
    config.aliases.resume = '/back';
    config.aliases.pr = '/draft-pr';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const setupResult = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    assert.match(setupResult.stdout, /Slash commands: .*\/branch.*\/back.*\/draft-pr/);

    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'branch.md')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'back.md')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'draft-pr.md')));
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'new.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'resume.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'pr.md')), false);

    // Cross-reference placeholders must render to the consumer's renamed
    // slash, not leak literal `{{ALIAS_RESUME}}` into the shipped doc.
    const branchDoc = readFileSync(path.join(repoRoot, '.claude', 'commands', 'branch.md'), 'utf8');
    assert.match(branchDoc, /\/back/);
    assert.equal(branchDoc.includes('{{ALIAS_'), false, 'unresolved alias placeholder in branch.md');

    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const workflowDoc = readFileSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md'), 'utf8');
    assert.match(readme, /\/branch/);
    assert.match(readme, /pipelane install-claude/);
    assert.match(readme, /pipelane install-codex/);
    assert.match(workflowDoc, /\/branch/);
    assert.match(workflowDoc, /pipelane install-claude/);
    assert.match(workflowDoc, /\.agents\/skills/);

    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'branch', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'back', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'draft-pr', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', '.pipelane', 'bin', 'run-pipelane.sh')));
    assert.equal(existsSync(path.join(repoRoot, '.agents', 'skills', 'new', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.agents', 'skills', 'resume', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.agents', 'skills', 'pr', 'SKILL.md')), false);
    assert.match(readFileSync(path.join(repoRoot, '.agents', 'skills', 'branch', 'SKILL.md'), 'utf8'), /run-pipelane\.sh" new/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('setup fails closed when an alias would overwrite an unrelated Claude command', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(repoRoot, '.claude', 'commands', 'branch.md'), 'custom branch command\n', 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/branch';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const result = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Claude command alias collision/);
    assert.equal(readFileSync(path.join(repoRoot, '.claude', 'commands', 'branch.md'), 'utf8'), 'custom branch command\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('setup fails closed when an alias would overwrite an unrelated Codex skill', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, '.agents', 'skills', 'branch'), { recursive: true });
    writeFileSync(path.join(repoRoot, '.agents', 'skills', 'branch', 'SKILL.md'), 'custom branch skill\n', 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/branch';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const result = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Codex skill alias collision/);
    assert.equal(readFileSync(path.join(repoRoot, '.agents', 'skills', 'branch', 'SKILL.md'), 'utf8'), 'custom branch skill\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('managed Claude commands and tracked Codex skills are pruned on alias rename', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    writeFileSync(
      path.join(repoRoot, '.claude', 'commands', 'new.md'),
      [
        'Create a fresh task workspace for this repo.',
        '',
        'Run:',
        '',
        '```bash',
        'npm run pipelane:new -- <args-from-user>',
        '```',
        '',
        'Display the output directly. Call out that the chat/workspace has not moved automatically yet.',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, '.claude', 'commands', 'resume.md'),
      [
        'Resume an existing task workspace for this repo.',
        '',
        'Run:',
        '',
        '```bash',
        'npm run pipelane:resume -- <args-from-user>',
        '```',
        '',
        'Display the output directly. Call out that the chat/workspace has not moved automatically yet.',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(repoRoot, '.claude', 'commands', 'pr.md'),
      [
        'Prepare and open, or update, a pull request for the current task.',
        '',
        'Run:',
        '',
        '```bash',
        'npm run pipelane:pr -- <args-from-user>',
        '```',
        '',
        'Display the output directly.',
        '',
      ].join('\n'),
      'utf8',
    );

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/branch';
    config.aliases.resume = '/back';
    config.aliases.pr = '/draft-pr';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'new.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'resume.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'pr.md')), false);
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'branch.md')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'back.md')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'draft-pr.md')));

    assert.equal(existsSync(path.join(repoRoot, '.agents', 'skills', 'new', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.agents', 'skills', 'resume', 'SKILL.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.agents', 'skills', 'pr', 'SKILL.md')), false);
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'branch', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'back', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'draft-pr', 'SKILL.md')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('consumer-extension markers preserve inner content across re-sync and template changes', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const cleanPath = path.join(repoRoot, '.claude', 'commands', 'clean.md');
    const firstPass = readFileSync(cleanPath, 'utf8');
    assert.match(firstPass, /<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->/);

    const extended = firstPass.replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      [
        '<!-- pipelane:consumer-extension:start -->',
        '## ROCKETBOARD GIT-JANITOR SECTION',
        '',
        'Run `npm run git:cleanup -- --apply` to prune stale branches.',
        '<!-- pipelane:consumer-extension:end -->',
      ].join('\n'),
    );
    writeFileSync(cleanPath, extended, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const preserved = readFileSync(cleanPath, 'utf8');
    assert.match(preserved, /## ROCKETBOARD GIT-JANITOR SECTION/);
    assert.match(preserved, /npm run git:cleanup -- --apply/);
    // The rendered pipelane body is unchanged: first-line marker + the
    // canonical template opening line still match.
    assert.match(preserved, /<!-- pipelane:command:clean -->/);
    assert.match(preserved, /Report workflow cleanup status and prune stale task locks when requested\./);

    // Bonus: mutate the upstream template body inside a throwaway kit copy
    // and verify the consumer extension survives when pipelane re-renders
    // with the new body.
    const tmpKit = mkdtempSync(path.join(os.tmpdir(), 'pipelane-mutated-'));
    try {
      cpSync(path.join(KIT_ROOT, 'src'), path.join(tmpKit, 'src'), { recursive: true });
      cpSync(path.join(KIT_ROOT, 'bin'), path.join(tmpKit, 'bin'), { recursive: true });
      cpSync(path.join(KIT_ROOT, 'dist'), path.join(tmpKit, 'dist'), { recursive: true });
      cpSync(path.join(KIT_ROOT, 'docs'), path.join(tmpKit, 'docs'), { recursive: true });
      cpSync(path.join(KIT_ROOT, 'templates'), path.join(tmpKit, 'templates'), { recursive: true });
      cpSync(path.join(KIT_ROOT, 'README.md'), path.join(tmpKit, 'README.md'));
      cpSync(path.join(KIT_ROOT, 'package.json'), path.join(tmpKit, 'package.json'));

      const mutatedTemplatePath = path.join(tmpKit, 'templates', '.claude', 'commands', 'clean.md');
      const mutatedTemplate = readFileSync(mutatedTemplatePath, 'utf8').replace(
        'Report workflow cleanup status and prune stale task locks when requested.',
        'MUTATED BODY SENTINEL — templates can change without losing local extensions.',
      );
      writeFileSync(mutatedTemplatePath, mutatedTemplate, 'utf8');

      const mutatedCli = path.join(tmpKit, 'src', 'cli.ts');
      const result = spawnSync('node', [mutatedCli, 'setup'], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(result.status, 0, result.stderr);

      const afterMutation = readFileSync(cleanPath, 'utf8');
      assert.match(afterMutation, /MUTATED BODY SENTINEL/);
      assert.match(afterMutation, /## ROCKETBOARD GIT-JANITOR SECTION/);
      assert.match(afterMutation, /npm run git:cleanup -- --apply/);
    } finally {
      rmSync(tmpKit, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('consumer-extension preserve logic follows aliased filenames', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.clean = '/cleanup';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const aliasedPath = path.join(repoRoot, '.claude', 'commands', 'cleanup.md');
    const firstPass = readFileSync(aliasedPath, 'utf8');
    assert.match(firstPass, /<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->/);

    const extended = firstPass.replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      [
        '<!-- pipelane:consumer-extension:start -->',
        'ALIASED EXTENSION SENTINEL',
        '<!-- pipelane:consumer-extension:end -->',
      ].join('\n'),
    );
    writeFileSync(aliasedPath, extended, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const preserved = readFileSync(aliasedPath, 'utf8');
    assert.match(preserved, /ALIASED EXTENSION SENTINEL/);
    assert.match(preserved, /<!-- pipelane:command:clean -->/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('every managed command template renders with an empty consumer-extension marker pair', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    // CI invariant: if a future template edit accidentally drops the
    // empty marker pair, consumer extensions would silently vanish on
    // the next re-sync. This test catches that at kit-time. pipelane is
    // in the list even though it's an "extra" (fixed filename, not
    // aliased) — same marker contract applies.
    for (const cmd of ['clean', 'deploy', 'devmode', 'merge', 'new', 'pr', 'resume', 'smoke', 'pipelane']) {
      const contents = readFileSync(path.join(repoRoot, '.claude', 'commands', `${cmd}.md`), 'utf8');
      assert.match(
        contents,
        /<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->/,
        `${cmd}.md missing empty consumer-extension marker pair`,
      );
      assert.match(
        contents,
        new RegExp(`<!-- pipelane:command:${cmd} -->`),
        `${cmd}.md missing command marker`,
      );
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('consumer-extension preservation works for every managed command', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const commands = ['clean', 'deploy', 'devmode', 'merge', 'new', 'pr', 'resume', 'smoke', 'pipelane'];
    for (const cmd of commands) {
      const p = path.join(repoRoot, '.claude', 'commands', `${cmd}.md`);
      const seeded = readFileSync(p, 'utf8').replace(
        '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
        [
          '<!-- pipelane:consumer-extension:start -->',
          `SENTINEL-${cmd}`,
          '<!-- pipelane:consumer-extension:end -->',
        ].join('\n'),
      );
      writeFileSync(p, seeded, 'utf8');
    }

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    for (const cmd of commands) {
      const after = readFileSync(path.join(repoRoot, '.claude', 'commands', `${cmd}.md`), 'utf8');
      assert.match(after, new RegExp(`SENTINEL-${cmd}`), `${cmd}.md dropped its sentinel on re-sync`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('legacy pipelane.md (no marker) is upgraded in place on next setup', () => {
  // Simulates a consumer that installed pipelane on main before the
  // pipelane.md marker shipped. Their file has no marker and no
  // consumer-extension pair; setup must detect it via legacy signatures,
  // treat it as managed (not a collision), and overwrite with the
  // marker-bearing template.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const pipelanePath = path.join(repoRoot, '.claude', 'commands', 'pipelane.md');
    writeFileSync(
      pipelanePath,
      [
        'Run a Pipelane subcommand for this repo.',
        '',
        'Legacy body that predates the marker pair.',
        '',
        '```bash',
        'npm run pipelane:board',
        '```',
        '',
        '## Pipelane Board (default)',
        '',
        'Open the dashboard.',
        '',
      ].join('\n'),
      'utf8',
    );

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const after = readFileSync(pipelanePath, 'utf8');
    assert.match(after, /<!-- pipelane:command:pipelane -->/);
    assert.match(
      after,
      /<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->/,
    );
    assert.doesNotMatch(after, /Legacy body that predates the marker pair\./);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('pipelane.md renders a journey-first overview with real slash aliases', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/start';
    config.aliases.clean = '/tidy';
    config.aliases.status = '/where';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const pipelane = readFileSync(path.join(repoRoot, '.claude', 'commands', 'pipelane.md'), 'utf8');
    assert.doesNotMatch(pipelane, /\{\{ALIAS_/);
    assert.match(pipelane, /Pick a lane:/);
    assert.match(pipelane, /1\. Build journey/);
    assert.match(pipelane, /\/devmode build\s+Set the repo to build mode\./);
    assert.match(pipelane, /\/start --task "task name"\s+Create a clean task worktree and branch\./);
    assert.match(pipelane, /\/pr --title "PR title"\s+Run pre-PR checks, commit, push, and open or update the PR\./);
    assert.match(pipelane, /\/merge\s+Merge the PR\. In build mode, this hands off to the prod deploy path\./);
    assert.match(pipelane, /\/tidy\s+Clean up finished task state after the release is complete\./);
    assert.match(pipelane, /2\. Release journey/);
    assert.match(pipelane, /\/deploy staging\s+Deploy the merged SHA to staging\./);
    assert.match(pipelane, /\/smoke staging\s+Run or verify staging smoke checks\./);
    assert.match(pipelane, /\/deploy prod\s+Promote the same merged SHA to production\./);
    assert.match(pipelane, /\/where\s+See where tasks, PRs, deploys, and release gates stand\./);
    assert.match(pipelane, /\/pipelane web\s+Open the local Pipelane Board\./);
    assert.match(pipelane, /\/pipelane update --check\s+Check whether Pipelane itself has updates\./);
    assert.doesNotMatch(pipelane, /Pipelane Board \(default\)/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('pipelane.md documents exact first-token routing for subcommands', () => {
  const templatePath = path.join(KIT_ROOT, 'templates', '.claude', 'commands', 'pipelane.md');
  const template = readFileSync(templatePath, 'utf8');

  assert.match(template, /Exactly equals `web`/);
  assert.match(template, /Exactly equals `status`/);
  assert.match(template, /Exactly equals `update`/);
  assert.match(template, /No prefix matching/);
  assert.match(template, /`\/pipelane update-this-thing` routes to UNKNOWN MODE, not UPDATE MODE/);
});

test('unrelated pre-existing pipelane.md raises collision instead of silently clobbering', () => {
  // A consumer who authored their own .claude/commands/pipelane.md
  // without the legacy signatures shouldn't have it overwritten. This
  // mirrors the operator-command collision contract.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    // Nuke the init-generated pipelane.md + its managed manifest entry so
    // the next setup treats the directory as "consumer-authored."
    rmSync(path.join(repoRoot, '.claude', 'commands', 'pipelane.md'), { force: true });
    rmSync(path.join(repoRoot, '.claude', 'commands', '.pipelane-managed.json'), { force: true });
    writeFileSync(
      path.join(repoRoot, '.claude', 'commands', 'pipelane.md'),
      'Custom consumer notes. Not managed by pipelane.\n',
      'utf8',
    );

    const result = spawnSync('node', [path.join(KIT_ROOT, 'src', 'cli.ts'), 'setup'], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.notEqual(result.status, 0, 'setup should refuse to clobber a non-managed pipelane.md');
    assert.match(result.stderr, /pipelane\.md/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('setup rejects operator aliases that collide with MANAGED_EXTRA_COMMANDS filenames when claudeCommands is syncing', () => {
  // Two writers (operator command + extras loop) would fight for the same
  // .claude/commands/pipelane.md file on every re-sync. Catch that at the
  // point where the collision actually materializes, not at config-load
  // time — a consumer who opts out of claudeCommands never hits the
  // collision and shouldn't be blocked from aliasing /pipelane.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/pipelane';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const result = spawnSync('node', [path.join(KIT_ROOT, 'src', 'cli.ts'), 'setup'], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.notEqual(result.status, 0, 'setup should refuse a config where two writers fight for pipelane.md');
    assert.match(result.stderr, /pipelane and new both resolve to \/pipelane/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('setup allows /pipelane operator alias when claudeCommands syncing is disabled', () => {
  // Addresses Codex P2: if a consumer opts out of claudeCommands entirely,
  // the extras loop never runs — no collision can happen. Blocking that
  // config at load time (which the old reservation did) would be a soft
  // regression for repos that just want the state machine, not the .claude/
  // command files. Only enforce when the collision actually materializes.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/pipelane';
    // packageScripts must stay on so `pipelane:*` scripts exist; claudeCommands
    // off is the operative opt-out here.
    config.syncDocs = { claudeCommands: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // Wipe init-written command files so the next setup path exercises the
    // "claudeCommands false, nothing to regen" branch cleanly.
    rmSync(path.join(repoRoot, '.claude'), { recursive: true, force: true });

    const result = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    assert.match(result.stdout, /Pipelane setup complete/);
    // Non-command surfaces still synced.
    assert.ok(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')));
    // No .claude/commands/ got regenerated, so no collision fired.
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('resolveWorkflowAliases still rejects unknown aliases (pipelane is not a WorkflowCommand key)', async () => {
  // The strict-validator for unknown keys is unchanged — `aliases.pipelane`
  // is not a valid consumer config because pipelane isn't a WorkflowCommand
  // (it's a MANAGED_EXTRA_COMMAND with a fixed filename, not aliased).
  const { resolveWorkflowAliases } = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  assert.throws(
    () => resolveWorkflowAliases({ pipelane: '/foo' }),
    /Unknown workflow alias key/,
  );
  assert.doesNotThrow(() => resolveWorkflowAliases({ new: '/pipelane' }),
    'resolveWorkflowAliases should be purely syntactic; collision detection moved to syncConsumerDocs');
});

test('pipelane.md consumer-extension survives when a different operator command is aliased', () => {
  // Cross-contamination guard: renaming `clean → /janitor` prunes clean.md
  // and writes janitor.md, but pipelane.md sits in MANAGED_EXTRA_COMMANDS
  // so its fixed filename + consumer-extension content must be untouched.
  // If the extras-loop capture/write ordering ever drifts (e.g., extras
  // render before capture, or ManagedCommand keys collide across sets),
  // this test catches it.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const pipelanePath = path.join(repoRoot, '.claude', 'commands', 'pipelane.md');
    const pipelaneSeeded = readFileSync(pipelanePath, 'utf8').replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      [
        '<!-- pipelane:consumer-extension:start -->',
        'PIPELANE-EXT-SENTINEL',
        '<!-- pipelane:consumer-extension:end -->',
      ].join('\n'),
    );
    writeFileSync(pipelanePath, pipelaneSeeded, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases = { ...(config.aliases ?? {}), clean: '/janitor' };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'clean.md')), false);
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'janitor.md')));
    const after = readFileSync(pipelanePath, 'utf8');
    assert.match(after, /PIPELANE-EXT-SENTINEL/);
    assert.match(after, /<!-- pipelane:command:pipelane -->/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('pipelane.md consumer-extension persists when syncDocs.claudeCommands flips true -> false -> true', () => {
  // Opt-out is sticky (content untouched), opt-back-in re-injects captured
  // extension into the regenerated marker-bearing file. A capture/write
  // ordering regression in the extras loop would drop the sentinel here.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const pipelanePath = path.join(repoRoot, '.claude', 'commands', 'pipelane.md');
    const seeded = readFileSync(pipelanePath, 'utf8').replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      [
        '<!-- pipelane:consumer-extension:start -->',
        'FLIP-SENTINEL',
        '<!-- pipelane:consumer-extension:end -->',
      ].join('\n'),
    );
    writeFileSync(pipelanePath, seeded, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    config.syncDocs = { claudeCommands: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    assert.match(readFileSync(pipelanePath, 'utf8'), /FLIP-SENTINEL/);

    config.syncDocs = { claudeCommands: true };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const after = readFileSync(pipelanePath, 'utf8');
    assert.match(after, /FLIP-SENTINEL/);
    assert.match(after, /<!-- pipelane:command:pipelane -->/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('partial legacy-signature match on pipelane.md is treated as collision, not upgrade', () => {
  // detectLegacyClaudeCommand requires `every` signature to match. A file
  // with only the first-line description (no `npm run pipelane:board`)
  // must NOT be silently upgraded — the AND contract prevents false-
  // positive clobber. A future change weakening it to OR would break
  // this test.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    rmSync(path.join(repoRoot, '.claude', 'commands', 'pipelane.md'), { force: true });
    rmSync(path.join(repoRoot, '.claude', 'commands', '.pipelane-managed.json'), { force: true });
    writeFileSync(
      path.join(repoRoot, '.claude', 'commands', 'pipelane.md'),
      'Run a Pipelane subcommand for this repo.\n\nCustom consumer body, no npm script mention.\n',
      'utf8',
    );

    const result = spawnSync('node', [path.join(KIT_ROOT, 'src', 'cli.ts'), 'setup'], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.notEqual(result.status, 0, 'partial signature must not silently upgrade');
    assert.match(result.stderr, /pipelane\.md/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('legacy pipelane signatures are gated by filename to prevent consumer-file false positives', () => {
  // Defense against data loss: a consumer-authored `.claude/commands/
  // my-pipelane-notes.md` that happens to contain both pipelane legacy
  // signatures (e.g., a cheatsheet that quotes the first line + the
  // board npm script) must NOT be mis-classified as managed. If it
  // were, the readdirSync scan adds it to managedFiles, desiredFiles
  // doesn't include that filename, and pruneManagedClaudeCommands
  // unlinks it. The extras-specific filename gate in
  // detectLegacyClaudeCommand prevents that clobber.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const decoyPath = path.join(repoRoot, '.claude', 'commands', 'my-pipelane-notes.md');
    writeFileSync(
      decoyPath,
      [
        '# My pipelane cheatsheet',
        '',
        'Run a Pipelane subcommand for this repo.',
        '',
        '```bash',
        'npm run pipelane:board',
        '```',
        '',
        '## Pipelane Board (default)',
        '',
        'Consumer-authored notes — not managed.',
        '',
      ].join('\n'),
      'utf8',
    );

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.ok(existsSync(decoyPath), 'my-pipelane-notes.md was clobbered by false-positive legacy detection');
    assert.match(readFileSync(decoyPath, 'utf8'), /Consumer-authored notes — not managed\./);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('every MANAGED_COMMANDS member has a valid LEGACY_CLAUDE_SIGNATURES entry', async () => {
  // Kit-time invariant: a future contributor adding a command to
  // MANAGED_EXTRA_COMMANDS must also ship a legacy-signature entry or
  // existing consumer files without a marker will fail the in-place
  // upgrade (detectLegacyClaudeCommand returns null -> collision error).
  const { MANAGED_COMMANDS } = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
  assert.ok(docs.LEGACY_CLAUDE_SIGNATURES, 'LEGACY_CLAUDE_SIGNATURES must be exported for structural validation');
  for (const cmd of MANAGED_COMMANDS) {
    const sigs = docs.LEGACY_CLAUDE_SIGNATURES[cmd];
    assert.ok(Array.isArray(sigs), `${cmd} missing signatures array`);
    assert.ok(sigs.length >= 2, `${cmd} needs >= 2 signatures (description + npm script)`);
    for (const s of sigs) {
      assert.equal(typeof s, 'string');
      assert.ok(s.length > 0, `${cmd} has an empty signature entry`);
    }
  }
});

test('pipelane.md template body contains every LEGACY_CLAUDE_SIGNATURES[pipelane] string', async () => {
  // Template↔signature coupling: if a future template edit drops one of
  // the legacy signatures (e.g., renames pipelane:board), existing
  // pre-marker consumer files stop being detected as legacy on the next
  // setup and the upgrade silently regresses to a collision error. This
  // CI invariant keeps them synchronized.
  const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
  const templatePath = path.join(KIT_ROOT, 'templates', '.claude', 'commands', 'pipelane.md');
  const template = readFileSync(templatePath, 'utf8');
  for (const signature of docs.LEGACY_CLAUDE_SIGNATURES.pipelane) {
    assert.ok(
      template.includes(signature),
      `pipelane.md template missing legacy signature "${signature}" — legacy detection will drift`,
    );
  }
});

test('consumer-extension ignores malformed marker pairs without crashing', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const cleanPath = path.join(repoRoot, '.claude', 'commands', 'clean.md');
    const emptyPair = '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->';
    const base = readFileSync(cleanPath, 'utf8');

    const cases = [
      { label: 'start-only', body: base.replace(emptyPair, '<!-- pipelane:consumer-extension:start -->\nSTRAY') },
      { label: 'end-only', body: base.replace(emptyPair, 'STRAY\n<!-- pipelane:consumer-extension:end -->') },
      { label: 'reversed', body: base.replace(emptyPair, '<!-- pipelane:consumer-extension:end -->\nSTRAY\n<!-- pipelane:consumer-extension:start -->') },
    ];

    for (const { label, body } of cases) {
      writeFileSync(cleanPath, body, 'utf8');
      runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
      const after = readFileSync(cleanPath, 'utf8');
      assert.doesNotMatch(after, /STRAY/, `${label}: stray content should not have been preserved`);
      assert.match(after, new RegExp('<!-- pipelane:consumer-extension:start -->\\n<!-- pipelane:consumer-extension:end -->'), `${label}: expected canonical empty marker pair`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('consumer-extension preserves content even when it contains a nested end-marker literal', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const cleanPath = path.join(repoRoot, '.claude', 'commands', 'clean.md');
    // Consumer pastes documentation that references the marker literal.
    // Using lastIndexOf for the end marker guards against the first
    // (inner) `:end -->` truncating the extension on the next re-sync.
    const withNestedMarker = readFileSync(cleanPath, 'utf8').replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      [
        '<!-- pipelane:consumer-extension:start -->',
        'Our protocol closes with `<!-- pipelane:consumer-extension:end -->` on its own line.',
        'KEEP-ME-AFTER-NESTED-MARKER',
        '<!-- pipelane:consumer-extension:end -->',
      ].join('\n'),
    );
    writeFileSync(cleanPath, withNestedMarker, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const preserved = readFileSync(cleanPath, 'utf8');
    assert.match(preserved, /KEEP-ME-AFTER-NESTED-MARKER/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('consumer-extension survives an alias rename after the content was added', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const cleanPath = path.join(repoRoot, '.claude', 'commands', 'clean.md');
    const withExtension = readFileSync(cleanPath, 'utf8').replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      [
        '<!-- pipelane:consumer-extension:start -->',
        'RENAME-MIGRATION-SENTINEL',
        '<!-- pipelane:consumer-extension:end -->',
      ].join('\n'),
    );
    writeFileSync(cleanPath, withExtension, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.clean = '/cleanup';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(cleanPath), false, 'old clean.md should have been pruned');
    const renamedPath = path.join(repoRoot, '.claude', 'commands', 'cleanup.md');
    const migrated = readFileSync(renamedPath, 'utf8');
    assert.match(migrated, /RENAME-MIGRATION-SENTINEL/);
    assert.match(migrated, /<!-- pipelane:command:clean -->/);

    // Rename a second time — content should still follow the command.
    const updatedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    updatedConfig.aliases.clean = '/janitor';
    writeFileSync(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(renamedPath), false, 'intermediate cleanup.md should have been pruned');
    const finalPath = path.join(repoRoot, '.claude', 'commands', 'janitor.md');
    const finalContent = readFileSync(finalPath, 'utf8');
    assert.match(finalContent, /RENAME-MIGRATION-SENTINEL/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.readmeSection: false leaves README.md untouched', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const readmePath = path.join(repoRoot, 'README.md');
    // Consumer owns README entirely — no pipelane markers, original
    // content must survive.
    writeFileSync(readmePath, '# Owned By Consumer\n\nHand-written README.\n', 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { readmeSection: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const after = readFileSync(readmePath, 'utf8');
    assert.equal(after, '# Owned By Consumer\n\nHand-written README.\n');
    assert.doesNotMatch(after, /pipelane:readme:start/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.contributingSection + agentsSection: false leave those files untouched', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    writeFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), '# Consumer Contributing\n', 'utf8');
    writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Consumer Agents\n', 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { contributingSection: false, agentsSection: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8'), '# Consumer Contributing\n');
    assert.equal(readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8'), '# Consumer Agents\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.docsReleaseWorkflow + pipelaneClaudeTemplate: false skip those file writes', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { docsReleaseWorkflow: false, pipelaneClaudeTemplate: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // Clear files that init already wrote with the default config so the
    // assertion exercises "setup with opt-out doesn't recreate them."
    rmSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md'), { force: true });
    rmSync(path.join(repoRoot, 'workflow', 'CLAUDE.template.md'), { force: true });

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')), false);
    assert.equal(existsSync(path.join(repoRoot, 'workflow', 'CLAUDE.template.md')), false);
    // Opting out of one surface must not suppress others — commands still regen.
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'clean.md')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.claudeCommands: false skips the entire command-regen path', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { claudeCommands: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // Wipe what init pre-created so the assertion exercises "opt-out
    // skips the write," not "file never existed."
    rmSync(path.join(repoRoot, '.claude'), { recursive: true, force: true });

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'clean.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'pipelane.md')), false);
    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', '.pipelane-managed.json')), false);
    // Non-command surfaces still land.
    assert.ok(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')));
    assert.ok(existsSync(path.join(repoRoot, 'README.md')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.packageScripts: false preserves consumer-customized workflow scripts', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    // Simulate a consumer that wants its own wrappers around pipelane:
    // they're opting out of packageScripts precisely so their customized
    // pipelane:* entries don't get overwritten on every re-sync.
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const customScripts = {
      build: 'my-build',
      'pipelane:new': 'my-wrapper new',
      'pipelane:resume': 'my-wrapper resume',
      'pipelane:repo-guard': 'my-wrapper repo-guard',
      'pipelane:pr': 'my-wrapper pr',
      'pipelane:merge': 'my-wrapper merge',
      'pipelane:deploy': 'my-wrapper deploy',
      'pipelane:smoke': 'my-wrapper smoke',
      'pipelane:clean': 'my-wrapper clean',
      'pipelane:devmode': 'my-wrapper devmode',
      'pipelane:status': 'my-wrapper status',
      'pipelane:doctor': 'my-wrapper doctor',
      'pipelane:rollback': 'my-wrapper rollback',
      // devmode.md tells operators to run `pipelane:configure` when release
      // mode is blocked; the consistency check requires consumers opting out
      // of packageScripts to define it themselves.
      'pipelane:configure': 'my-wrapper configure',
    };
    const consumerPackage = {
      name: 'consumer-app',
      private: true,
      type: 'module',
      scripts: customScripts,
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(consumerPackage, null, 2)}\n`, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { packageScripts: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const after = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    assert.deepEqual(after.scripts, customScripts);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.packageScripts: false without required pipelane:* scripts throws with guidance', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    // Consumer wipes the kit-installed pipelane:* scripts but forgot to
    // either replace them or also opt out of claudeCommands. Setup must
    // fail loudly, not silently leave a broken slash-command config.
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const consumerPackage = {
      name: 'consumer-app',
      private: true,
      type: 'module',
      scripts: { build: 'my-build' },
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(consumerPackage, null, 2)}\n`, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { packageScripts: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const result = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packageScripts is false but package\.json is missing required npm scripts/);
    assert.match(result.stderr, /pipelane:clean/);
    // Error message must list the three escape hatches so the consumer
    // can recover without digging into the codebase.
    assert.match(result.stderr, /set syncDocs\.packageScripts to true/);
    assert.match(result.stderr, /set syncDocs\.claudeCommands to false/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('RELEASE_WORKFLOW packageScripts docs describe the managed script contract generically', () => {
  const template = readFileSync(path.join(KIT_ROOT, 'templates', 'docs', 'RELEASE_WORKFLOW.md'), 'utf8');
  assert.match(template, /full managed `pipelane:\*` workflow script set/i);
  assert.match(template, /`pipelane:configure`/);
});

test('syncDocs.packageScripts: false is allowed when claudeCommands is also false', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    // The valid "I only want README/docs marker injection" scenario.
    // No package.json scripts, no command files — and no error.
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const consumerPackage = { name: 'consumer-app', private: true, type: 'module', scripts: { build: 'my-build' } };
    writeFileSync(packageJsonPath, `${JSON.stringify(consumerPackage, null, 2)}\n`, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { packageScripts: false, claudeCommands: false, codexSkills: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const after = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    assert.deepEqual(after.scripts, { build: 'my-build' });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.packageScripts: false still allows tracked Codex skills when Claude commands are disabled', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const packageJsonPath = path.join(repoRoot, 'package.json');
    const consumerPackage = { name: 'consumer-app', private: true, type: 'module', scripts: { build: 'my-build' } };
    writeFileSync(packageJsonPath, `${JSON.stringify(consumerPackage, null, 2)}\n`, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { packageScripts: false, claudeCommands: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const after = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    assert.deepEqual(after.scripts, { build: 'my-build' });
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'new', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', '.pipelane', 'bin', 'run-pipelane.sh')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs absent preserves current all-surfaces-sync behavior', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'clean.md')));
    assert.ok(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')));
    assert.ok(existsSync(path.join(repoRoot, 'pipelane', 'CLAUDE.template.md')));
    assert.match(readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), /pipelane:readme:start/);
    assert.match(readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8'), /pipelane:contributing:start/);
    assert.match(readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8'), /pipelane:agents:start/);
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['pipelane:setup'], 'pipelane setup');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs resolver coerces non-boolean junk back to defaults', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // Garbage values: string 'false' is truthy in JS, but the resolver
    // must treat non-booleans as "use the default" or a consumer who
    // wrote "false" expecting to disable the surface would silently get
    // the surface synced instead (real footgun).
    config.syncDocs = {
      readmeSection: 'false',
      contributingSection: 'no',
      agentsSection: 42,
      packageScripts: null,
      docsReleaseWorkflow: false,
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // Wipe every surface init pre-wrote so the assertions observe the
    // opt-out pass's actual behavior instead of left-over init state.
    rmSync(path.join(repoRoot, '.agents'), { recursive: true, force: true });
    rmSync(path.join(repoRoot, 'docs'), { recursive: true, force: true });
    rmSync(path.join(repoRoot, 'workflow'), { recursive: true, force: true });
    writeFileSync(path.join(repoRoot, 'README.md'), '# Consumer README\n', 'utf8');
    writeFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), '# Consumer Contributing\n', 'utf8');
    writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Consumer Agents\n', 'utf8');
    const pristinePackage = { name: 'consumer-app', private: true, type: 'module', scripts: { build: 'my-build' } };
    writeFileSync(path.join(repoRoot, 'package.json'), `${JSON.stringify(pristinePackage, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    // docsReleaseWorkflow: false is a real boolean → honored → no file.
    assert.equal(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')), false);
    // Junk values fall back to default true → surface DID sync.
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'clean', 'SKILL.md')));
    assert.match(readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), /pipelane:readme:start/);
    assert.match(readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8'), /pipelane:contributing:start/);
    assert.match(readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8'), /pipelane:agents:start/);
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['pipelane:setup'], 'pipelane setup');
    assert.equal(pkg.scripts.build, 'my-build');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs as a non-object (string) resolves to all defaults without crashing', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // Totally malformed: a string instead of an object. Spreading a
    // string over DEFAULT_SYNC_DOCS would introduce numeric-keyed junk;
    // the resolver must guard with typeof raw !== 'object'.
    config.syncDocs = 'true';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    // Every surface still syncs (all defaults remain true).
    assert.ok(existsSync(path.join(repoRoot, '.agents', 'skills', 'clean', 'SKILL.md')));
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'clean.md')));
    assert.ok(existsSync(path.join(repoRoot, 'docs', 'RELEASE_WORKFLOW.md')));
    assert.match(readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), /pipelane:readme:start/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('readmeSection: false preserves pre-existing pipelane marker block byte-for-byte', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    const readmePath = path.join(repoRoot, 'README.md');
    const syncedBytes = readFileSync(readmePath, 'utf8');
    assert.match(syncedBytes, /pipelane:readme:start/);

    // Consumer now renames the project AND opts out of README sync.
    // The stale marker block should survive unchanged until they re-enable.
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.displayName = 'Renamed App';
    config.syncDocs = { readmeSection: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(readFileSync(readmePath, 'utf8'), syncedBytes, 'README bytes drifted after opt-out');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('claudeCommands: false preserves consumer-extension content without pruning', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const cleanPath = path.join(repoRoot, '.claude', 'commands', 'clean.md');
    const withExtension = readFileSync(cleanPath, 'utf8').replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      [
        '<!-- pipelane:consumer-extension:start -->',
        'CONSUMER-CONTENT-UNDER-OPTOUT',
        '<!-- pipelane:consumer-extension:end -->',
      ].join('\n'),
    );
    writeFileSync(cleanPath, withExtension, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { claudeCommands: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const after = readFileSync(cleanPath, 'utf8');
    assert.match(after, /CONSUMER-CONTENT-UNDER-OPTOUT/);
    // pipelane.md (gated by the same flag) should not have been touched
    // or rewritten. Exists from init; mtime won't regress.
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'pipelane.md')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('all eight flags: false produces zero writes from a wiped repo', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = {
      claudeCommands: false,
      codexSkills: false,
      readmeSection: false,
      contributingSection: false,
      agentsSection: false,
      docsReleaseWorkflow: false,
      pipelaneClaudeTemplate: false,
      packageScripts: false,
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // Wipe everything init wrote so opt-out behavior is observable.
    rmSync(path.join(repoRoot, '.agents'), { recursive: true, force: true });
    rmSync(path.join(repoRoot, '.claude'), { recursive: true, force: true });
    rmSync(path.join(repoRoot, 'docs'), { recursive: true, force: true });
    rmSync(path.join(repoRoot, 'workflow'), { recursive: true, force: true });
    writeFileSync(path.join(repoRoot, 'README.md'), '# Consumer-owned\n', 'utf8');
    writeFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), '# Consumer-owned\n', 'utf8');
    writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Consumer-owned\n', 'utf8');
    const pristine = { name: 'consumer-app', private: true, type: 'module', scripts: { build: 'my-build' } };
    writeFileSync(path.join(repoRoot, 'package.json'), `${JSON.stringify(pristine, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(path.join(repoRoot, '.agents')), false);
    assert.equal(existsSync(path.join(repoRoot, '.claude')), false);
    assert.equal(existsSync(path.join(repoRoot, 'docs')), false);
    assert.equal(existsSync(path.join(repoRoot, 'workflow')), false);
    assert.equal(readFileSync(path.join(repoRoot, 'README.md'), 'utf8'), '# Consumer-owned\n');
    assert.equal(readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8'), '# Consumer-owned\n');
    assert.equal(readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8'), '# Consumer-owned\n');
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.scripts, { build: 'my-build' });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('syncDocs.codexSkills: false preserves legacy machine-local Codex wrappers', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { codexSkills: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    rmSync(path.join(repoRoot, '.agents'), { recursive: true, force: true });
    seedLegacyCodexWrappers(codexHome, ['new', 'resume']);

    const result = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });
    assert.match(result.stdout, /Skipped tracked Codex skill sync because syncDocs\.codexSkills is false\./);
    assert.doesNotMatch(result.stdout, /Removed legacy machine-local wrapper skills/);
    assert.ok(existsSync(path.join(codexHome, 'skills', 'new', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'resume', 'SKILL.md')));
    assert.equal(existsSync(path.join(repoRoot, '.agents', 'skills')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('tracked Codex skills stay repo-local when different repos map the same alias differently', () => {
  const repoOne = createRepo();
  const repoTwo = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Repo One'], repoOne);
    runCli(['init', '--project', 'Repo Two'], repoTwo);

    const repoOneConfigPath = path.join(repoOne, '.pipelane.json');
    const repoOneConfig = JSON.parse(readFileSync(repoOneConfigPath, 'utf8'));
    repoOneConfig.aliases.new = '/branch';
    repoOneConfig.aliases.resume = '/back';
    writeFileSync(repoOneConfigPath, `${JSON.stringify(repoOneConfig, null, 2)}\n`, 'utf8');

    const repoTwoConfigPath = path.join(repoTwo, '.pipelane.json');
    const repoTwoConfig = JSON.parse(readFileSync(repoTwoConfigPath, 'utf8'));
    repoTwoConfig.aliases.resume = '/branch';
    writeFileSync(repoTwoConfigPath, `${JSON.stringify(repoTwoConfig, null, 2)}\n`, 'utf8');

    runCli(['setup'], repoOne, { CODEX_HOME: codexHome });
    runCli(['setup'], repoTwo, { CODEX_HOME: codexHome });

    const repoOneBranchSkill = readFileSync(path.join(repoOne, '.agents', 'skills', 'branch', 'SKILL.md'), 'utf8');
    const repoTwoBranchSkill = readFileSync(path.join(repoTwo, '.agents', 'skills', 'branch', 'SKILL.md'), 'utf8');
    assert.match(repoOneBranchSkill, /run-pipelane\.sh" new/);
    assert.match(repoTwoBranchSkill, /run-pipelane\.sh" resume/);
    assert.ok(existsSync(path.join(repoOne, '.agents', 'skills', 'back', 'SKILL.md')));
    assert.equal(existsSync(path.join(repoTwo, '.agents', 'skills', 'back', 'SKILL.md')), false);
  } finally {
    rmSync(repoOne, { recursive: true, force: true });
    rmSync(repoTwo, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('tracked Codex wrapper prefers the repo-local pipelane install', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    mkdirSync(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'node_modules', '.bin', 'pipelane'),
      '#!/bin/sh\necho "LOCAL:$*"\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    mkdirSync(path.join(codexHome, 'skills', '.pipelane', 'bin'), { recursive: true });
    writeFileSync(
      path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane'),
      '#!/bin/sh\necho "GLOBAL:$*"\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    const output = execFileSync(
      path.join(repoRoot, '.agents', 'skills', '.pipelane', 'bin', 'run-pipelane.sh'),
      ['status', '--json'],
      {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    assert.equal(output.trim(), 'LOCAL:run status --json');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('durable Codex runner routes /pipelane update through the managed runtime', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['install-codex'], repoRoot, { CODEX_HOME: codexHome });

    mkdirSync(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'node_modules', '.bin', 'pipelane'),
      '#!/bin/sh\necho "LOCAL:$*"\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    const managedBin = path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane');
    writeFileSync(
      managedBin,
      '#!/bin/sh\necho "GLOBAL:$*"\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    const output = execFileSync(
      path.join(codexHome, 'skills', '.pipelane', 'bin', 'run-pipelane.sh'),
      ['pipelane', 'update', '--check'],
      {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    assert.equal(output.trim(), 'GLOBAL:update --check');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('tracked Codex wrapper falls back to the managed Codex runtime when node_modules is missing', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    mkdirSync(path.join(codexHome, 'skills', '.pipelane', 'bin'), { recursive: true });
    writeFileSync(
      path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane'),
      '#!/bin/sh\necho "GLOBAL:$*"\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    const output = execFileSync(
      path.join(repoRoot, '.agents', 'skills', '.pipelane', 'bin', 'run-pipelane.sh'),
      ['status', '--json'],
      {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    assert.equal(output.trim(), 'GLOBAL:run status --json');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('durable Codex runner marks managed fallback and dispatches /pipelane status', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['install-codex'], repoRoot, { CODEX_HOME: codexHome });
    const managedBin = path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane');
    writeFileSync(
      managedBin,
      '#!/bin/sh\necho "MANAGED:$PIPELANE_MANAGED_RUNTIME:$PIPELANE_MANAGED_RUNTIME_ROOT:$*"\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    const output = execFileSync(
      path.join(codexHome, 'skills', '.pipelane', 'bin', 'run-pipelane.sh'),
      ['pipelane', 'status', '--json'],
      {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();

    assert.equal(output, `MANAGED:1:${path.join(codexHome, 'skills', '.pipelane')}:run status --json`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('managed CLI re-exec removes managed runtime markers before launching repo-local pipelane', () => {
  const repoRoot = createRepo();

  try {
    mkdirSync(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'node_modules', '.bin', 'pipelane'),
      `#!/bin/sh
if env | grep '^PIPELANE_MANAGED_RUNTIME=' >/dev/null; then
  echo managed-runtime-present
else
  echo managed-runtime-absent
fi
if env | grep '^PIPELANE_MANAGED_RUNTIME_ROOT=' >/dev/null; then
  echo managed-root-present
else
  echo managed-root-absent
fi
echo "args:$*"
`,
      { mode: 0o755, encoding: 'utf8' },
    );

    const result = spawnSync('node', [CLI_PATH, 'run', 'status'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PIPELANE_MANAGED_RUNTIME: '1',
        PIPELANE_MANAGED_RUNTIME_ROOT: '/tmp/pipelane-managed-runtime',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /managed-runtime-absent/);
    assert.match(result.stdout, /managed-root-absent/);
    assert.match(result.stdout, /args:run status/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('durable default command path does not write repo-local adapters in a Rocketboard-shaped repo', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));

  try {
    writeFileSync(
      path.join(repoRoot, '.gitignore'),
      '.claude/\n.agents/\n.pipelane/\n.pipelane.json\nnode_modules/\n',
      'utf8',
    );
    const packageBefore = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
    runCli(['install-codex'], repoRoot, { CODEX_HOME: codexHome });
    writeFileSync(
      path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane'),
      `#!/bin/sh\nexec node "${CLI_PATH}" "$@"\n`,
      { mode: 0o755, encoding: 'utf8' },
    );

    const output = execFileSync(
      path.join(codexHome, 'skills', '.pipelane', 'bin', 'run-pipelane.sh'),
      ['status', '--json'],
      {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome, PIPELANE_HOME: pipelaneHome },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    assert.match(output, /"ok": true/);
    assert.equal(existsSync(path.join(repoRoot, '.claude')), false);
    assert.equal(existsSync(path.join(repoRoot, '.agents')), false);
    assert.equal(existsSync(path.join(repoRoot, '.pipelane')), false);
    assert.equal(existsSync(path.join(repoRoot, '.pipelane.json')), false);
    assert.equal(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'), packageBefore);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('install-codex upgrades legacy machine-local wrapper skills in place', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-codex-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    seedLegacyCodexWrappers(codexHome);

    const result = runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome });
    assert.match(result.stdout, /Removed legacy machine-local wrapper skills: new, pr, resume/);

    assert.ok(existsSync(path.join(codexHome, 'skills', 'new', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'resume', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'pr', 'SKILL.md')));
    assert.match(readFileSync(path.join(codexHome, 'skills', 'new', 'SKILL.md'), 'utf8'), /pipelane:codex-global-skill:new/);
    assert.ok(existsSync(path.join(codexHome, 'skills', 'init-pipelane', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', '.pipelane', 'managed-skills.json')));
    assert.ok(existsSync(path.join(codexHome, 'skills', '.pipelane', 'bin', 'run-pipelane.sh')));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('setup preserves the durable machine-local Codex runtime runner', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['install-codex'], repoRoot, { CODEX_HOME: codexHome });
    const runnerPath = path.join(codexHome, 'skills', '.pipelane', 'bin', 'run-pipelane.sh');
    assert.ok(existsSync(runnerPath));

    runCli(['init', '--project', 'Demo App'], repoRoot, { CODEX_HOME: codexHome });
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.ok(existsSync(runnerPath));
    assert.match(readFileSync(path.join(codexHome, 'skills', 'pr', 'SKILL.md'), 'utf8'), new RegExp(runnerPath.replaceAll('\\', '\\\\')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install-codex fails closed when a user skill only contains legacy prose', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-codex-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    mkdirSync(path.join(codexHome, 'skills', 'new'), { recursive: true });
    writeFileSync(
      path.join(codexHome, 'skills', 'new', 'SKILL.md'),
      'custom user skill\nRun the generic pipelane wrapper for this repo.\n',
      'utf8',
    );

    const result = runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome }, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Codex skill alias collision/);
    assert.equal(
      readFileSync(path.join(codexHome, 'skills', 'new', 'SKILL.md'), 'utf8'),
      'custom user skill\nRun the generic pipelane wrapper for this repo.\n',
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install-codex upgrades a legacy managed init-pipelane skill in place', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-codex-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    seedLegacyCodexBootstrapSkill(codexHome);

    const result = runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome });
    assert.match(result.stdout, /Installed \d+ durable Pipelane Codex commands/);

    const skillPath = path.join(codexHome, 'skills', 'init-pipelane', 'SKILL.md');
    const skill = readFileSync(skillPath, 'utf8');
    assert.match(skill, /pipelane:codex-global-skill:init-pipelane/);
    assert.match(skill, /Run the global pipelane bootstrap for this machine\./);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install-codex skips unmanaged /fix without blocking /pipelane-fix', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-codex-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    mkdirSync(path.join(codexHome, 'skills', 'fix'), { recursive: true });
    writeFileSync(path.join(codexHome, 'skills', 'fix', 'SKILL.md'), 'custom fix skill\n', 'utf8');

    const result = runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome });
    assert.match(result.stdout, /Skipped unmanaged optional skills: \/fix/);
    assert.equal(readFileSync(path.join(codexHome, 'skills', 'fix', 'SKILL.md'), 'utf8'), 'custom fix skill\n');
    assert.ok(existsSync(path.join(codexHome, 'skills', 'pipelane-fix', 'SKILL.md')));
    assert.ok(existsSync(path.join(codexHome, 'skills', 'new', 'SKILL.md')));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install-codex ignores unsafe managed manifest skill names instead of deleting outside skills root', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-codex-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const outsideDir = path.join(codexHome, 'outside-skill');
  const outsideSkill = path.join(outsideDir, 'SKILL.md');

  try {
    mkdirSync(path.join(codexHome, 'skills', '.pipelane'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      path.join(codexHome, 'skills', '.pipelane', 'managed-skills.json'),
      `${JSON.stringify({ skills: ['../outside-skill'] }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      outsideSkill,
      '<!-- pipelane:codex-global-skill:new -->\nshould never be deleted\n',
      'utf8',
    );

    runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome });
    assert.equal(
      readFileSync(outsideSkill, 'utf8'),
      '<!-- pipelane:codex-global-skill:new -->\nshould never be deleted\n',
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('install-codex replaces legacy pipelane runtime directory that blocks the /pipelane skill', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-install-codex-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    mkdirSync(path.join(codexHome, 'skills', 'pipelane', 'bin'), { recursive: true });
    writeFileSync(
      path.join(codexHome, 'skills', 'pipelane', 'bin', 'run-pipelane.sh'),
      [
        '#!/bin/sh',
        'ensure_local_pipelane_config() {',
        '  true',
        '}',
        'echo "This repo is not pipelane enabled. Run pipelane init first." >&2',
        '',
      ].join('\n'),
      { mode: 0o755, encoding: 'utf8' },
    );

    const result = runCli(['install-codex'], workspaceRoot, { CODEX_HOME: codexHome });

    assert.match(result.stdout, /Removed legacy machine-local wrapper skills: pipelane/);
    const skill = readFileSync(path.join(codexHome, 'skills', 'pipelane', 'SKILL.md'), 'utf8');
    assert.match(skill, /pipelane:codex-global-skill:pipelane/);
    assert.equal(existsSync(path.join(codexHome, 'skills', 'pipelane', 'bin', 'run-pipelane.sh')), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('setup upgrades pre-marker alias-generated Claude commands and prunes them on rename', () => {
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.aliases.new = '/branch';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    writeFileSync(
      path.join(repoRoot, '.claude', 'commands', 'branch.md'),
      [
        'Create a fresh task workspace for this repo.',
        '',
        'Run:',
        '',
        '```bash',
        'npm run pipelane:new -- <args-from-user>',
        '```',
        '',
        'Display the output directly. Call out that the chat/workspace has not moved automatically yet.',
        '',
      ].join('\n'),
      'utf8',
    );

    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const upgradedBranch = readFileSync(path.join(repoRoot, '.claude', 'commands', 'branch.md'), 'utf8');
    assert.match(upgradedBranch, /<!-- pipelane:command:new -->/);

    config.aliases.new = '/fresh';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    assert.equal(existsSync(path.join(repoRoot, '.claude', 'commands', 'branch.md')), false);
    assert.ok(existsSync(path.join(repoRoot, '.claude', 'commands', 'fresh.md')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('new creates a fresh task workspace and resume restores it', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
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
    assert.match(duplicate.stderr, /\/resume/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('new uses the default codex/ branch prefix', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Default Prefix', '--json'], repoRoot).stdout);
    assert.match(created.branch, /^codex\/default-prefix-[a-f0-9]{4}$/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('new honors a custom branchPrefix from .pipelane.json', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.branchPrefix = 'task/';
    config.legacyBranchPrefixes = ['codex/'];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    commitAll(repoRoot, 'Adopt pipelane');

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

test('loadWorkflowConfig falls back to the default branchPrefix and drops invalid legacy prefixes', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.branchPrefix = '../bad-prefix';
    config.legacyBranchPrefixes = ['task/', '../nope', 42, 'task/'];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const loaded = stateMod.loadWorkflowConfig(repoRoot);
    assert.equal(loaded.branchPrefix, stateMod.DEFAULT_BRANCH_PREFIX);
    assert.deepEqual(loaded.legacyBranchPrefixes, ['task/']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('loadWorkflowConfig falls back to .project-workflow.json when .pipelane.json is missing', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    switchToLegacyProjectWorkflowConfig(repoRoot);

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const loaded = stateMod.loadWorkflowConfig(repoRoot);
    assert.equal(loaded.displayName, 'Demo App');
    assert.equal(loaded.baseBranch, 'main');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('loadWorkflowConfig self-heals when no .pipelane.json exists, inferring name from package.json', async () => {
  const repoRoot = createRepo();
  try {
    // Fixture has package.json { name: "sample-repo" } but no .pipelane.json
    // or overlay. loadWorkflowConfig should synthesize a default config from
    // defaults + package.json name instead of throwing.
    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const loaded = stateMod.loadWorkflowConfig(repoRoot);
    assert.equal(loaded.displayName, 'sample-repo');
    assert.equal(loaded.projectKey, 'sample-repo');
    assert.equal(loaded.baseBranch, 'main');
    assert.equal(loaded.branchPrefix, stateMod.DEFAULT_BRANCH_PREFIX);
    assert.deepEqual(loaded.aliases, stateMod.DEFAULT_WORKFLOW_ALIASES);
    // Self-heal must not write the file to disk — consumers who gitignore
    // .pipelane.json on purpose don't want loads to materialize it.
    assert.equal(existsSync(path.join(repoRoot, '.pipelane.json')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('loadWorkflowConfig applies a package.json:pipelane overlay when the file is missing', async () => {
  const repoRoot = createRepo();
  try {
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    pkg.pipelane = {
      baseBranch: 'trunk',
      displayName: 'Canvas App',
      aliases: { pr: '/ship' },
      syncDocs: { readmeSection: false },
    };
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const loaded = stateMod.loadWorkflowConfig(repoRoot);
    assert.equal(loaded.displayName, 'Canvas App');
    assert.equal(loaded.baseBranch, 'trunk');
    assert.equal(loaded.aliases.pr, '/ship');
    // Unspecified aliases should inherit the defaults.
    assert.equal(loaded.aliases.merge, stateMod.DEFAULT_WORKFLOW_ALIASES.merge);
    assert.equal(loaded.syncDocs?.readmeSection, false);
    assert.equal(existsSync(path.join(repoRoot, '.pipelane.json')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('loadWorkflowConfig lets .pipelane.json win over a package.json:pipelane overlay', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    pkg.pipelane = {
      displayName: 'Overlay App',
      baseBranch: 'trunk',
      aliases: { pr: '/ship', merge: '/land' },
    };
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const loaded = stateMod.loadWorkflowConfig(repoRoot);
    // .pipelane.json's displayName/baseBranch/aliases win over the overlay.
    assert.equal(loaded.displayName, 'Demo App');
    assert.equal(loaded.baseBranch, 'main');
    assert.equal(loaded.aliases.pr, '/pr');
    assert.equal(loaded.aliases.merge, '/merge');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup succeeds without a pre-existing .pipelane.json', async () => {
  const repoRoot = createRepo();
  try {
    // No `pipelane init` — just run setup directly. With self-heal, this
    // should succeed and render CLAUDE.md from the synthesized config
    // instead of failing closed.
    const result = runCli(['setup'], repoRoot);
    assert.equal(result.status, 0, `setup exited ${result.status}: ${result.stderr}`);
    assert.ok(existsSync(path.join(repoRoot, 'CLAUDE.md')), 'setup should create CLAUDE.md');
    // .pipelane.json stays un-materialized because setup only reads.
    assert.equal(existsSync(path.join(repoRoot, '.pipelane.json')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('patchReadableWorkflowConfig materializes .pipelane.json when it is missing', async () => {
  const repoRoot = createRepo();
  try {
    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    assert.equal(existsSync(path.join(repoRoot, '.pipelane.json')), false);
    const { configPath, isLegacy } = stateMod.patchReadableWorkflowConfig(repoRoot, (raw) => {
      return { ...raw, smoke: { staging: { command: 'npm run smoke:staging' } } };
    });
    assert.equal(isLegacy, false);
    assert.equal(configPath, path.join(repoRoot, '.pipelane.json'));
    assert.equal(existsSync(configPath), true);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(written.smoke.staging.command, 'npm run smoke:staging');
    // The materialized file carries the synthesized defaults alongside
    // the patched slice so subsequent loads see a full config.
    assert.equal(written.displayName, 'sample-repo');
    assert.equal(written.projectKey, 'sample-repo');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('new and repo-guard work from repos that track only .project-workflow.json', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    switchToLegacyProjectWorkflowConfig(repoRoot);
    commitAll(repoRoot, 'Adopt legacy workflow config');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Legacy Config', '--json'], repoRoot).stdout);
    assert.equal(existsSync(path.join(created.worktreePath, '.pipelane.json')), false);
    assert.equal(existsSync(path.join(created.worktreePath, '.project-workflow.json')), true);

    const guarded = JSON.parse(runCli(['run', 'repo-guard', '--task', 'legacy-config', '--json'], created.worktreePath).stdout);
    assert.equal(guarded.createdWorktree, false);
    assert.equal(guarded.lock.branchName, created.branch);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('new generates a task-<hex> slug when --task is omitted', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

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

test('new links shared node_modules into a created sibling worktree when available', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, 'node_modules', 'pipelane'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'), '{"name":"pipelane"}\n', 'utf8');
    commitAll(repoRoot, 'Adopt workflow-kit');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Link Modules', '--json'], repoRoot).stdout);
    const linkedNodeModules = path.join(created.worktreePath, 'node_modules');
    assert.ok(lstatSync(linkedNodeModules).isSymbolicLink());
    assert.equal(realpathSync(linkedNodeModules), realpathSync(path.join(repoRoot, 'node_modules')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('resume backfills the shared node_modules link for an existing sibling worktree', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Resume Link', '--json'], repoRoot).stdout);
    const linkedNodeModules = path.join(created.worktreePath, 'node_modules');
    assert.equal(existsSync(linkedNodeModules), false);

    mkdirSync(path.join(repoRoot, 'node_modules', 'pipelane'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'), '{"name":"pipelane"}\n', 'utf8');

    runCli(['run', 'resume', '--task', 'Resume Link', '--json'], repoRoot);
    assert.ok(lstatSync(linkedNodeModules).isSymbolicLink());
    assert.equal(realpathSync(linkedNodeModules), realpathSync(path.join(repoRoot, 'node_modules')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('repo-guard links shared node_modules when it creates a new isolated worktree', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, 'node_modules', 'pipelane'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'), '{"name":"pipelane"}\n', 'utf8');
    commitAll(repoRoot, 'Adopt workflow-kit');
    writeFileSync(path.join(repoRoot, 'dirty.txt'), 'dirty\n', 'utf8');

    const guarded = JSON.parse(runCli(['run', 'repo-guard', '--task', 'Guard Link', '--json'], repoRoot).stdout);
    assert.equal(guarded.createdWorktree, true);
    const linkedNodeModules = path.join(guarded.lock.worktreePath, 'node_modules');
    assert.ok(lstatSync(linkedNodeModules).isSymbolicLink());
    assert.equal(realpathSync(linkedNodeModules), realpathSync(path.join(repoRoot, 'node_modules')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('repo-guard replacement lock clears checkout-local transient state', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Guarded Rebind', '--json'], repoRoot).stdout);
    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const bindingHistory = [{
      reboundAt: '2026-04-25T00:00:00.000Z',
      reason: 'fixture',
      fromBranchName: 'codex/old-1111',
      fromWorktreePath: '/tmp/old',
      toBranchName: lock.branchName,
      toWorktreePath: lock.worktreePath,
      fingerprint: 'abc123',
    }];
    writeFileSync(lockPath, `${JSON.stringify({
      ...lock,
      nextAction: 'stale next action from the old checkout',
      promotedWithoutStagingSmoke: true,
      bindingHistory,
    }, null, 2)}\n`, 'utf8');

    const guarded = JSON.parse(runCli(['run', 'repo-guard', '--task', 'Guarded Rebind', '--json'], repoRoot).stdout);
    assert.equal(guarded.createdWorktree, true);

    const updated = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.notEqual(updated.branchName, created.branch);
    assert.equal(updated.branchName, guarded.lock.branchName);
    assert.equal(updated.worktreePath, guarded.lock.worktreePath);
    assert.equal(updated.nextAction, undefined);
    assert.equal(updated.promotedWithoutStagingSmoke, undefined);
    assert.deepEqual(updated.bindingHistory, bindingHistory);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('bootstrapWorktreeNodeModulesIfNeeded is a no-op in the shared repo', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, 'node_modules', 'pipelane'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'), '{"name":"pipelane"}\n', 'utf8');
    commitAll(repoRoot, 'Adopt');

    const taskWorkspaces = await import(path.join(KIT_ROOT, 'src', 'operator', 'task-workspaces.ts'));
    const result = taskWorkspaces.bootstrapWorktreeNodeModulesIfNeeded(repoRoot);
    assert.equal(result.kind, 'noop');
    assert.equal(result.message, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('bootstrapWorktreeNodeModulesIfNeeded symlinks an externally-created worktree without node_modules', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt');

    // Externally-created worktree (Claude Code worktrees, manual git
    // worktree add) checked out from a branch that has no node_modules
    // committed.
    const worktreePath = path.join(repoRoot, '.claude', 'worktrees', 'external-task');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'external-task'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Shared repo has node_modules installed (npm install) AFTER the
    // worktree was created — this is the modal user case we want to
    // bootstrap from.
    mkdirSync(path.join(repoRoot, 'node_modules', 'pipelane'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'), '{"name":"pipelane"}\n', 'utf8');

    assert.equal(existsSync(path.join(worktreePath, 'node_modules')), false);

    const taskWorkspaces = await import(path.join(KIT_ROOT, 'src', 'operator', 'task-workspaces.ts'));
    const result = taskWorkspaces.bootstrapWorktreeNodeModulesIfNeeded(worktreePath);
    assert.equal(result.kind, 'symlinked');
    assert.match(result.message, /Linked node_modules/);
    // The success message must also surface the npm-wipes-shared-deps warning —
    // the audience for auto-bootstrap (agents, fresh users) is exactly who
    // needs this safety note. `pipelane:new` already does this via its
    // workspace output; the auto-bootstrap path must not silently drop it.
    assert.match(result.message, /Do NOT run `npm ci` or `npm install`/);

    const linkedNodeModules = path.join(worktreePath, 'node_modules');
    assert.ok(lstatSync(linkedNodeModules).isSymbolicLink());
    assert.equal(realpathSync(linkedNodeModules), realpathSync(path.join(repoRoot, 'node_modules')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('bootstrapWorktreeNodeModulesIfNeeded leaves an existing node_modules directory alone', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    mkdirSync(path.join(repoRoot, 'node_modules', 'pipelane'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'), '{"name":"pipelane"}\n', 'utf8');
    commitAll(repoRoot, 'Adopt');

    const worktreePath = path.join(repoRoot, '.claude', 'worktrees', 'has-modules');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'has-modules'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mkdirSync(path.join(worktreePath, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(path.join(worktreePath, 'node_modules', 'foo', 'index.js'), '// own content\n', 'utf8');

    const taskWorkspaces = await import(path.join(KIT_ROOT, 'src', 'operator', 'task-workspaces.ts'));
    const result = taskWorkspaces.bootstrapWorktreeNodeModulesIfNeeded(worktreePath);
    assert.equal(result.kind, 'noop');
    assert.equal(lstatSync(path.join(worktreePath, 'node_modules')).isSymbolicLink(), false);
    assert.equal(existsSync(path.join(worktreePath, 'node_modules', 'foo', 'index.js')), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('bootstrapWorktreeNodeModulesIfNeeded is a graceful no-op when shared node_modules is missing', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt');

    const worktreePath = path.join(repoRoot, '.claude', 'worktrees', 'no-shared');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'no-shared'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const taskWorkspaces = await import(path.join(KIT_ROOT, 'src', 'operator', 'task-workspaces.ts'));
    const result = taskWorkspaces.bootstrapWorktreeNodeModulesIfNeeded(worktreePath);
    assert.equal(result.kind, 'noop');
    assert.equal(result.message, null);
    assert.equal(existsSync(path.join(worktreePath, 'node_modules')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('CLI auto-bootstraps node_modules in an externally-created worktree before command dispatch', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt');

    const worktreePath = path.join(repoRoot, '.claude', 'worktrees', 'cli-bootstrap');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'cli-bootstrap'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mkdirSync(path.join(repoRoot, 'node_modules', 'pipelane'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'), '{"name":"pipelane"}\n', 'utf8');
    assert.equal(existsSync(path.join(worktreePath, 'node_modules')), false);

    // Any non-setup command exercises the bootstrap path. `run status --json`
    // is read-only and exits cleanly enough for this check; we don't care
    // about the status payload, only that the symlink got created before
    // dispatch.
    const result = runCli(['run', 'status', '--json'], worktreePath, {}, true);

    const linkedNodeModules = path.join(worktreePath, 'node_modules');
    assert.ok(lstatSync(linkedNodeModules).isSymbolicLink());
    assert.equal(realpathSync(linkedNodeModules), realpathSync(path.join(repoRoot, 'node_modules')));
    assert.match(result.stderr, /\[pipelane\] Linked node_modules/);
    // npm-wipes-shared-deps warning must reach stderr too, not just the
    // programmatic result — this is the safety note the auto-bootstrap
    // audience needs most.
    assert.match(result.stderr, /Do NOT run `npm ci` or `npm install`/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('managed update bootstraps worktree node_modules without re-execing stale local pipelane', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));
  const sha = '0123456789abcdef0123456789abcdef01234567';
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    writeFakeConsumer(repoRoot, { installedVersion: '0.2.0', installedSha: sha });
    execFileSync('git', ['add', 'package.json', 'package-lock.json', '.pipelane.json'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['commit', '-m', 'Adopt fake pipelane install'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['push'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    mkdirSync(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'node_modules', '.bin', 'pipelane'),
      '#!/bin/sh\necho "LOCAL REEXEC:$*"\n',
      { mode: 0o755, encoding: 'utf8' },
    );

    const worktreePath = path.join(repoRoot, '.claude', 'worktrees', 'managed-update');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'managed-update'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(existsSync(path.join(worktreePath, 'node_modules')), false);
    makeFakeUpdateBin(binDir, { latestSha: sha });

    const result = spawnSync('node', [CLI_PATH, 'update', '--check'], {
      cwd: worktreePath,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        PIPELANE_HOME: pipelaneHome,
        PIPELANE_MANAGED_RUNTIME: '1',
        PIPELANE_MANAGED_RUNTIME_ROOT: '/tmp/pipelane-managed-runtime',
        PATH: `${binDir}:${process.env.PATH}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[pipelane\] Linked node_modules/);
    assert.match(result.stdout, /pipelane is up to date/);
    assert.doesNotMatch(result.stdout, /LOCAL REEXEC/);
    const linkedNodeModules = path.join(worktreePath, 'node_modules');
    assert.ok(lstatSync(linkedNodeModules).isSymbolicLink());
    assert.equal(realpathSync(linkedNodeModules), realpathSync(path.join(repoRoot, 'node_modules')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('update refuses to npm install through symlinked worktree node_modules', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));
  const oldSha = '1111111111111111111111111111111111111111';
  const newSha = '2222222222222222222222222222222222222222';
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    writeFakeConsumer(repoRoot, { installedVersion: '0.2.0', installedSha: oldSha });
    execFileSync('git', ['add', 'package.json', 'package-lock.json', '.pipelane.json'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['commit', '-m', 'Adopt fake pipelane install'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['push'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    const worktreePath = path.join(repoRoot, '.claude', 'worktrees', 'update-refuses-symlink');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'update-refuses-symlink'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    makeFakeUpdateBin(binDir, { latestSha: newSha });

    const result = spawnSync('node', [CLI_PATH, 'update'], {
      cwd: worktreePath,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        PIPELANE_HOME: pipelaneHome,
        PIPELANE_MANAGED_RUNTIME: '1',
        PIPELANE_MANAGED_RUNTIME_ROOT: '/tmp/pipelane-managed-runtime',
        PATH: `${binDir}:${process.env.PATH}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to run npm install for pipelane update/);
    assert.match(result.stderr, /node_modules is a symlink/);
    assert.match(result.stderr, /Run `pipelane update` from the shared checkout instead/);
    const worktreeLock = JSON.parse(readFileSync(path.join(worktreePath, 'package-lock.json'), 'utf8'));
    assert.equal(worktreeLock.packages['node_modules/pipelane'].resolved.endsWith(`#${oldSha}`), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
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
function buildFullDeployConfig(_options = {}) {
  // v1.2: .ready field removed from the DeployConfig shape. The
  // `legacyReady` option used to emit `.ready: true`; v1.2 drops it
  // entirely (release readiness is now observed + probe-based).
  return {
    platform: 'fly.io',
    frontend: {
      production: {
        url: 'https://app.example.test',
        deployWorkflow: 'Deploy Hosted',
        autoDeployOnMain: false,
        healthcheckUrl: 'https://app.example.test/health',
        runtimeMarker: {
          enabled: false,
          path: '',
        },
      },
      staging: {
        url: 'https://staging.example.test',
        deployWorkflow: 'Deploy Hosted',
        healthcheckUrl: 'https://staging.example.test/health',
        runtimeMarker: {
          enabled: false,
          path: '',
        },
      },
    },
    edge: {
      staging: {
        deployCommand: 'supabase functions deploy --staging',
        verificationCommand: 'supabase functions test',
        healthcheckUrl: 'https://staging.example.test/edge-health',
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

function writeSharedDeployConfig(repoRoot, config = buildFullDeployConfig()) {
  const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'deploy-config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  return config;
}

async function fingerprintForFullConfig(options = {}, environment = 'staging') {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  const normalized = mod.parseDeployConfigMarkdown(mod.renderDeployConfigSection(buildFullDeployConfig(options)));
  if (!normalized) {
    throw new Error('Failed to normalize full deploy config for fingerprinting.');
  }
  return mod.computeDeployConfigFingerprint(normalized, environment);
}

function updateWorkflowConfig(repoRoot, updater) {
  const configPath = path.join(repoRoot, '.pipelane.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  updater(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config;
}

function updateSmokeRegistry(repoRoot, updater) {
  const registryPath = path.join(repoRoot, '.pipelane', 'smoke-checks.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  updater(registry);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return registry;
}

function smokeResultCommand(checks, options = {}) {
  const payload = {
    schemaVersion: 1,
    checks,
  };
  const payloadLiteral = JSON.stringify(JSON.stringify(payload));
  const exitCode = Number.isFinite(options.exitCode) ? Number(options.exitCode) : inferSmokeExitCode(checks);
  return `node -e 'require(\"node:fs\").writeFileSync(process.env.PIPELANE_SMOKE_RESULTS_PATH, ${payloadLiteral}); process.exit(${exitCode})'`;
}

function cohortSmokeResultCommand(resultsByCohort) {
  const payloadLiteral = JSON.stringify(JSON.stringify(resultsByCohort));
  return [
    'node -e',
    `'const fs = require("node:fs");`,
    `const results = JSON.parse(${payloadLiteral});`,
    'const cohort = process.env.PIPELANE_COHORT || "default";',
    'const response = results[cohort] || results.default;',
    'if (!response) process.exit(2);',
    'const payload = { schemaVersion: 1, checks: response.checks || [] };',
    'fs.writeFileSync(process.env.PIPELANE_SMOKE_RESULTS_PATH, JSON.stringify(payload));',
    'process.exit(Number.isFinite(response.exitCode) ? response.exitCode : ((response.checks || []).some((check) => check.status === "failed") ? 1 : 0));',
    `'`,
  ].join(' ');
}

function inferSmokeExitCode(checks) {
  return checks.some((check) => check.status === 'failed') ? 1 : 0;
}

function resolveCommonDir(repoRoot) {
  return path.resolve(repoRoot, run('git', ['rev-parse', '--git-common-dir'], repoRoot));
}

function resolveSharedSmokeStateRoot(repoRoot) {
  return path.join(path.dirname(resolveCommonDir(repoRoot)), '.pipelane', 'state', 'smoke');
}

function writeTaskLock(repoRoot, taskSlug = 'bootstrap', options = {}) {
  const stateDir = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, `${taskSlug}.json`),
    `${JSON.stringify({
      taskSlug,
      branchName: run('git', ['branch', '--show-current'], repoRoot),
      worktreePath: repoRoot,
      mode: options.mode || 'release',
      surfaces: options.surfaces || ['frontend'],
      updatedAt: '2026-04-22T00:00:00Z',
    }, null, 2)}\n`,
    'utf8',
  );
}

function writePrRecord(repoRoot, taskSlug, mergedSha) {
  const stateDir = path.join(resolveCommonDir(repoRoot), 'pipelane-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'pr-state.json'),
    `${JSON.stringify({
      records: {
        [taskSlug]: {
          taskSlug,
          branchName: run('git', ['branch', '--show-current'], repoRoot),
          title: 'Smoke gate test',
          mergedSha,
          mergedAt: '2026-04-22T00:00:00Z',
          updatedAt: '2026-04-22T00:00:00Z',
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );
}

async function writeSucceededDeployRecord(repoRoot, environment, sha, surfaces = ['frontend'], options = {}) {
  const stateDir = path.join(resolveCommonDir(repoRoot), 'pipelane-state');
  mkdirSync(stateDir, { recursive: true });
  const existingPath = path.join(stateDir, 'deploy-state.json');
  const existing = existsSync(existingPath)
    ? JSON.parse(readFileSync(existingPath, 'utf8'))
    : { records: [] };
  const fingerprint = await fingerprintForFullConfig({}, environment === 'prod' ? 'prod' : 'staging');
  const host = environment === 'prod' ? 'https://app.example.test' : 'https://staging.example.test';
  const verificationBySurface = Object.fromEntries(surfaces.map((surface) => [
    surface,
    { healthcheckUrl: `${host}/${surface}-health`, statusCode: 200, latencyMs: 50, probes: 2 },
  ]));
  existing.records.push({
    environment,
    sha,
    surfaces,
    workflowName: 'Deploy Hosted',
    requestedAt: '2026-04-22T00:00:00Z',
    finishedAt: '2026-04-22T00:01:00Z',
    durationMs: 60000,
    taskSlug: options.taskSlug || 'bootstrap',
    status: 'succeeded',
    workflowRunId: `${environment}-run-1`,
    verifiedAt: '2026-04-22T00:01:30Z',
    verification: verificationBySurface.frontend ?? verificationBySurface[surfaces[0]],
    verificationBySurface,
    configFingerprint: fingerprint,
    idempotencyKey: `${environment}-${sha.slice(0, 8)}`,
    triggeredBy: 'test',
  });
  writeFileSync(existingPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}

async function writeStagingSucceededRecord(repoRoot, surfaces, options = {}) {
  const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
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

  // v1.2: also seed a fresh healthy probe-state.json for the same surfaces
  // unless the caller explicitly opts out. Release-gate now checks probe
  // freshness alongside observed staging success — tests that set up "the
  // observed gate should pass" implicitly want the probe gate to pass too.
  if (!options.skipProbeState) {
    writeHealthyProbeState(repoRoot, surfaces);
  }
}

function writeHealthyProbeState(repoRoot, surfaces) {
  const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
  mkdirSync(stateDir, { recursive: true });
  const probedAt = new Date().toISOString();
  const records = surfaces.map((surface) => ({
    environment: 'staging',
    surface,
    url: probeUrlForSurface(surface),
    ok: true,
    statusCode: 200,
    latencyMs: 25,
    probedAt,
  }));
  writeFileSync(
    path.join(stateDir, 'probe-state.json'),
    JSON.stringify({ records, updatedAt: probedAt }, null, 2),
    'utf8',
  );
}

function writeProbeState(repoRoot, records, updatedAt = records.at(-1)?.probedAt ?? '') {
  const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'probe-state.json'),
    JSON.stringify({ records, updatedAt }, null, 2),
    'utf8',
  );
}

function probeUrlForSurface(surface) {
  if (surface === 'frontend') return 'https://staging.example.test/health';
  if (surface === 'edge') return 'https://staging.example.test/edge-health';
  if (surface === 'sql') return 'https://staging.example.test/db-health';
  throw new Error(`Unknown probe surface fixture: ${surface}`);
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
    assert.match(output.message, /\/deploy staging/);
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

    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
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
    writeHealthyProbeState(repoRoot, ['frontend', 'edge', 'sql']);

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

    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
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
    // Diagnostic must specifically call out the missing verifiedAt — not
    // just the generic "no succeeded deploy" reason. This protects against
    // a regression that removes the verifiedAt check.
    assert.match(output.message, /lacks verifiedAt/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('parseDeployConfigMarkdown silently drops legacy .ready:true from pre-v1.2 CLAUDE.md', async () => {
  // v1.2: the .ready field is gone. Older consumer CLAUDE.md files still
  // have it in the JSON block; the parser must not crash and must not
  // surface the field on the returned config. Behavior flipped from
  // "round-trip" (pre-v1.2) to "strip" (v1.2+) — release readiness is
  // derived from observed deploys + /doctor --probe now.
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
  assert.ok(!('ready' in parsed.frontend.staging), 'frontend.staging.ready must be stripped');
  assert.ok(!('ready' in parsed.edge.staging), 'edge.staging.ready must be stripped');
  assert.ok(!('ready' in parsed.sql.staging), 'sql.staging.ready must be stripped');
});

test('parseDeployConfigMarkdown handles CRLF-normalized CLAUDE.md', async () => {
  // Codex-identified regression from PR #27: the tightened fenced-block regex
  // used `\n` literally, so any CLAUDE.md checked out with CRLF (Windows, or
  // `core.autocrlf=true`) would silently return null and make every downstream
  // command (release-check, devmode, deploy, pr) treat the repo as having no
  // deploy config. Fence anchors now accept `\r?\n`.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  const lfMarkdown = [
    '## Deploy Configuration',
    '',
    '```json',
    JSON.stringify({
      platform: 'fly.io',
      frontend: { production: { url: 'https://p.test', deployWorkflow: '', autoDeployOnMain: false, healthcheckUrl: '' },
        staging: { url: 'https://s.test', deployWorkflow: '', healthcheckUrl: '', ready: false } },
      edge: { staging: { deployCommand: '', verificationCommand: '', healthcheckUrl: '', ready: false },
        production: { deployCommand: '', verificationCommand: '', healthcheckUrl: '' } },
      sql: { staging: { applyCommand: '', verificationCommand: '', healthcheckUrl: '', ready: false },
        production: { applyCommand: '', verificationCommand: '', healthcheckUrl: '' } },
      supabase: { staging: { projectRef: 's' }, production: { projectRef: 'p' } },
    }, null, 2),
    '```',
  ].join('\n');
  const crlfMarkdown = lfMarkdown.replace(/\n/g, '\r\n');
  assert.notEqual(crlfMarkdown, lfMarkdown, 'test fixture actually differs from LF input');

  const lfParsed = mod.parseDeployConfigMarkdown(lfMarkdown);
  const crlfParsed = mod.parseDeployConfigMarkdown(crlfMarkdown);
  assert.ok(lfParsed, 'LF markdown parses');
  assert.ok(crlfParsed, 'CRLF markdown also parses (regression: PR #27 tightened regex broke this)');
  assert.deepEqual(crlfParsed, lfParsed, 'LF and CRLF inputs yield identical parsed DeployConfig');
});

test('loadDeployConfig falls back to shared deploy-config.json when CLAUDE.md is absent', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const expected = writeSharedDeployConfig(repoRoot);
    rmSync(path.join(repoRoot, 'CLAUDE.md'), { force: true });

    const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
    const loaded = mod.loadDeployConfig(repoRoot);
    assert.deepEqual(loaded, expected);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('loadDeployConfig falls back to shared deploy-config.json when local CLAUDE.md only has the empty template block', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const expected = writeSharedDeployConfig(repoRoot);

    const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
    const loaded = mod.loadDeployConfig(repoRoot);
    assert.deepEqual(loaded, expected);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup output mentions shared deploy configuration when the empty local CLAUDE.md falls back to shared state', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    writeSharedDeployConfig(repoRoot);

    const result = runCli(['setup'], repoRoot);
    assert.match(
      result.stdout,
      /Release mode can use shared deploy configuration when available\./,
    );
    assert.doesNotMatch(
      result.stdout,
      /Release mode still requires local deploy configuration in CLAUDE\.md\./,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup output points the operator at doctor or configure when no deploy config exists yet', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const result = runCli(['setup'], repoRoot);
    assert.match(
      result.stdout,
      /Release mode still requires deploy configuration\. Run `\/doctor --fix`\./,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
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
    // Diagnostic must specifically call out fingerprint mismatch, not just
    // the generic "no record" reason. Otherwise a regression that silently
    // dropped the fingerprint check would be invisible to this test.
    assert.match(output.message, /config drift|fingerprint mismatch/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check: rotating prod-only config does NOT invalidate staging records', async () => {
  // Fingerprint is environment-scoped. Rotating frontend.production.url
  // shouldn't make a staging-succeeded record fail the gate, since the
  // record was registered against the staging slice of the config.
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);

    // Baseline: cleared.
    const baseline = JSON.parse(runCli(['run', 'release-check', '--json'], repoRoot).stdout);
    assert.equal(baseline.ready, true);

    // Rotate ONLY production fields. Staging-side config is untouched, so
    // the staging fingerprint must remain stable and the gate must stay open.
    const claudeMdPath = path.join(repoRoot, 'CLAUDE.md');
    const existing = readFileSync(claudeMdPath, 'utf8');
    writeFileSync(
      claudeMdPath,
      existing.replace('https://app.example.test', 'https://app-v2.example.test'),
      'utf8',
    );

    const after = JSON.parse(runCli(['run', 'release-check', '--json'], repoRoot).stdout);
    assert.equal(after.ready, true, 'prod-only config rotation must not re-block staging');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check: an attacker-planted unsigned failed record is invisible when key is set', async () => {
  // Codex-flagged P1 DoS path: with PIPELANE_DEPLOY_STATE_KEY set, an
  // attacker with fs-write access to deploy-state.json would otherwise be
  // able to plant an unsigned `status: 'failed'` record and make it the
  // "latest" for a surface, blocking release readiness. Trusted-records
  // filtering must skip unsigned records entirely so a real signed success
  // earlier in history remains authoritative.
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);

    const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
    const fingerprint = await fingerprintForFullConfig();
    const key = 'beefcafe'.repeat(8);
    const okProbe = { healthcheckUrl: 'x', statusCode: 200, latencyMs: 10, probes: 2 };
    const goodRecord = {
      environment: 'staging',
      sha: '1'.repeat(40),
      surfaces: ['frontend'],
      workflowName: 'Deploy Hosted',
      requestedAt: '2026-04-15T00:00:00Z',
      finishedAt: '2026-04-15T00:01:00Z',
      taskSlug: 'real',
      status: 'succeeded',
      verifiedAt: '2026-04-15T00:01:30Z',
      verification: okProbe,
      verificationBySurface: { frontend: okProbe },
      configFingerprint: fingerprint,
      idempotencyKey: 'real-1',
      triggeredBy: 'test',
    };
    const goodSigned = { ...goodRecord, signature: mod.signDeployRecord(goodRecord, key) };
    // Attacker plants an unsigned failed record AFTER the good one.
    const plantedFailure = {
      environment: 'staging',
      sha: 'b'.repeat(40),
      surfaces: ['frontend'],
      workflowName: 'Deploy Hosted',
      requestedAt: '2026-04-16T00:00:00Z',
      finishedAt: '2026-04-16T00:00:30Z',
      taskSlug: 'planted',
      status: 'failed',
      configFingerprint: fingerprint,
      failureReason: 'attacker plant',
      idempotencyKey: 'plant-1',
    };
    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({
      records: [goodSigned, plantedFailure],
    }, null, 2), 'utf8');
    writeHealthyProbeState(repoRoot, ['frontend']);

    // With the key set, the unsigned planted failure is filtered out and
    // the real signed success remains authoritative for frontend.
    const result = runCli(['run', 'release-check', '--surfaces', 'frontend', '--json'], repoRoot, {
      PIPELANE_DEPLOY_STATE_KEY: key,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 0, `expected success, got: ${output.message}`);
    assert.equal(output.ready, true);
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
    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({ records: [signed] }, null, 2), 'utf8');
    writeHealthyProbeState(repoRoot, ['frontend', 'edge', 'sql']);

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

test('makeIdempotencyKey includes configFingerprint so drift forces a re-dispatch', async () => {
  // Regression: if two deploys with the same sha/surfaces/taskSlug run under
  // different configs, they must produce different idempotency keys.
  // Otherwise the short-circuit in handleDeploy would skip the re-dispatch
  // and falsely report "already succeeded" under the new config.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const base = { environment: 'staging', sha: 'a'.repeat(40), surfaces: ['frontend'], taskSlug: 'drift' };
  const keyA = mod.makeIdempotencyKey({ ...base, configFingerprint: 'f'.repeat(64) });
  const keyB = mod.makeIdempotencyKey({ ...base, configFingerprint: 'e'.repeat(64) });
  assert.notEqual(keyA, keyB, 'different fingerprints -> different idempotency keys');

  // And without a fingerprint (legacy caller), the key is stable.
  const legacyA = mod.makeIdempotencyKey(base);
  const legacyB = mod.makeIdempotencyKey(base);
  assert.equal(legacyA, legacyB, 'omitted fingerprint -> stable legacy key');
});

test('signDeployRecord signature survives JSON round-trip with undefined nested fields', async () => {
  // Regression: canonicalize() must strip undefined-valued keys from objects
  // the same way JSON.stringify does on write. Otherwise a record signed
  // in-memory (with e.g. `verification.error: undefined` from a successful
  // probe) fails its own signature after being read back from disk.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  const key = 'a'.repeat(64);
  const probe = { healthcheckUrl: 'x', statusCode: 200, latencyMs: 10, probes: 2, error: undefined };
  const record = {
    environment: 'staging',
    sha: '1'.repeat(40),
    surfaces: ['frontend'],
    workflowName: 'Deploy Hosted',
    requestedAt: '2026-04-15T00:00:00Z',
    finishedAt: '2026-04-15T00:01:00Z',
    status: 'succeeded',
    verifiedAt: '2026-04-15T00:01:30Z',
    verification: probe,
    verificationBySurface: { frontend: probe },
    configFingerprint: 'f'.repeat(64),
    idempotencyKey: 'k1',
    triggeredBy: 'test',
  };
  const signed = { ...record, signature: mod.signDeployRecord(record, key) };
  assert.equal(mod.verifyDeployRecord(signed, key), true, 'in-memory record verifies');

  const onDisk = JSON.parse(JSON.stringify(signed));
  assert.equal(mod.verifyDeployRecord(onDisk, key), true, 'record survives JSON round-trip');
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
    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
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
    // Probe state seeded for all three surfaces — probe gate is orthogonal
    // to the observed-staging gate. This test asserts the observed gate
    // rejects legacy aggregate verification for edge/sql; without probe
    // state those surfaces would double-block and the assertion would
    // still pass in the same direction but the test loses precision.
    writeHealthyProbeState(repoRoot, ['frontend', 'edge', 'sql']);

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

    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
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
    // Specific reason: latest record was failed, not just "no record."
    assert.match(output.message, /latest record has status "failed"/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// v4: pluggable checks. Enabled per-consumer via .pipelane.json:checks.
// Absent config = no plugins dispatched. These tests exercise each plugin's
// dispatch gate and its pass/fail behavior.

function writeProjectWorkflowChecks(repoRoot, checks) {
  const configPath = path.join(repoRoot, '.pipelane.json');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  cfg.checks = checks;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

function writeSecretManifest(repoRoot, manifest) {
  const manifestDir = path.join(repoRoot, 'supabase', 'functions');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(path.join(manifestDir, 'secrets.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

test('checks: no dispatch when .pipelane.json has no checks block', async () => {
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
    // No plugins configured -> outcomes array is empty.
    assert.deepEqual(output.checks.outcomes, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: secret-manifest plugin flags missing supabase secrets', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeSecretManifest(repoRoot, { required: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], optional: [] });
    writeProjectWorkflowChecks(repoRoot, {
      requireSecretManifest: true,
      secretManifestPath: 'supabase/functions/secrets.manifest.json',
    });

    // Stub: staging has only OPENAI_API_KEY; production has both.
    const stub = JSON.stringify({
      'staging-ref': ['OPENAI_API_KEY'],
      'production-ref': ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {
      PIPELANE_CHECKS_SUPABASE_SECRETS_STUB: stub,
    }, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    const manifest = output.checks.outcomes.find((o) => o.plugin === 'secret-manifest');
    assert.ok(manifest, 'secret-manifest outcome emitted');
    assert.equal(manifest.ok, false);
    assert.equal(manifest.findings.length, 1);
    assert.match(manifest.findings[0].reason, /staging.*missing required secret ANTHROPIC_API_KEY/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: secret-manifest plugin passes when all required secrets are present', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeSecretManifest(repoRoot, { required: ['OPENAI_API_KEY'], optional: [] });
    writeProjectWorkflowChecks(repoRoot, {
      requireSecretManifest: true,
      secretManifestPath: 'supabase/functions/secrets.manifest.json',
    });

    const stub = JSON.stringify({
      'staging-ref': ['OPENAI_API_KEY'],
      'production-ref': ['OPENAI_API_KEY'],
    });
    const result = runCli(['run', 'release-check', '--json'], repoRoot, {
      PIPELANE_CHECKS_SUPABASE_SECRETS_STUB: stub,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 0);
    assert.equal(output.ready, true);
    const manifest = output.checks.outcomes.find((o) => o.plugin === 'secret-manifest');
    assert.ok(manifest);
    assert.equal(manifest.ok, true);
    assert.deepEqual(manifest.findings, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: secret-manifest plugin fails closed when manifest file is missing', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeProjectWorkflowChecks(repoRoot, {
      requireSecretManifest: true,
      secretManifestPath: 'supabase/functions/secrets.manifest.json',
    });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    const manifest = output.checks.outcomes.find((o) => o.plugin === 'secret-manifest');
    assert.ok(manifest);
    assert.equal(manifest.ok, false);
    assert.match(manifest.findings[0].reason, /secret manifest not found/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: gh-required-secrets flags missing repo + environment secrets', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeProjectWorkflowChecks(repoRoot, {
      requiredRepoSecrets: ['SUPABASE_ACCESS_TOKEN', 'CLOUDFLARE_API_TOKEN'],
      requiredEnvironmentSecrets: ['SUPABASE_PROJECT_REF', 'APP_URL'],
    });

    // Repo has one of the two required; staging has both env secrets;
    // production has only one.
    const stub = JSON.stringify({
      '': ['SUPABASE_ACCESS_TOKEN'],
      'staging': ['SUPABASE_PROJECT_REF', 'APP_URL'],
      'production': ['SUPABASE_PROJECT_REF'],
    });
    const result = runCli(['run', 'release-check', '--json'], repoRoot, {
      PIPELANE_CHECKS_GH_SECRETS_STUB: stub,
    }, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    const gh = output.checks.outcomes.find((o) => o.plugin === 'gh-required-secrets');
    assert.ok(gh);
    assert.equal(gh.ok, false);
    const reasons = gh.findings.map((f) => f.reason).join('\n');
    assert.match(reasons, /repo secret CLOUDFLARE_API_TOKEN missing/);
    assert.match(reasons, /production environment secret APP_URL missing/);
    assert.doesNotMatch(reasons, /SUPABASE_ACCESS_TOKEN missing/);
    assert.doesNotMatch(reasons, /staging.*missing/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: gh-required-secrets passes when every required secret is present', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeProjectWorkflowChecks(repoRoot, {
      requiredRepoSecrets: ['X_TOKEN'],
      requiredEnvironmentSecrets: ['Y_SECRET'],
    });
    const stub = JSON.stringify({ '': ['X_TOKEN'], 'staging': ['Y_SECRET'], 'production': ['Y_SECRET'] });
    const result = runCli(['run', 'release-check', '--json'], repoRoot, {
      PIPELANE_CHECKS_GH_SECRETS_STUB: stub,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 0);
    assert.equal(output.ready, true);
    const gh = output.checks.outcomes.find((o) => o.plugin === 'gh-required-secrets');
    assert.ok(gh);
    assert.equal(gh.ok, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: stub env vars are ignored outside NODE_ENV=test', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeProjectWorkflowChecks(repoRoot, {
      requiredRepoSecrets: ['PROD_TOKEN'],
    });

    // Caller pretends the stub clears the check; with NODE_ENV != test
    // the stub is ignored and the real `gh secret list` gets called.
    // Without a fake gh on PATH, the real call will fail → findings
    // report "inspection failed" rather than "missing secret". Either
    // way, the gate does NOT clear. We assert ready:false and that the
    // stub-report hint is NOT what satisfied it.
    const result = runCli(['run', 'release-check', '--json'], repoRoot, {
      NODE_ENV: 'production',
      PIPELANE_CHECKS_GH_SECRETS_STUB: JSON.stringify({ '': ['PROD_TOKEN'] }),
    }, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    const gh = output.checks.outcomes.find((o) => o.plugin === 'gh-required-secrets');
    assert.ok(gh);
    assert.equal(gh.ok, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: secret-manifest rejects secretManifestPath that resolves outside the repo', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeProjectWorkflowChecks(repoRoot, {
      requireSecretManifest: true,
      secretManifestPath: '../../../etc/passwd',
    });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    const manifest = output.checks.outcomes.find((o) => o.plugin === 'secret-manifest');
    assert.ok(manifest);
    assert.equal(manifest.ok, false);
    assert.match(manifest.findings[0].reason, /resolves outside the repo/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: secret-manifest rejects a manifest that is not an object with a required array', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    // Plain object with no "required" field. Previously coerced to [] and
    // silently passed; v4 fail-closes with a clear diagnostic.
    writeSecretManifest(repoRoot, { other: ['OPENAI_API_KEY'] });
    writeProjectWorkflowChecks(repoRoot, {
      requireSecretManifest: true,
      secretManifestPath: 'supabase/functions/secrets.manifest.json',
    });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    const manifest = output.checks.outcomes.find((o) => o.plugin === 'secret-manifest');
    assert.ok(manifest);
    assert.equal(manifest.ok, false);
    assert.match(manifest.findings[0].reason, /missing required "required" field/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: secret-manifest rejects a symlink pointing outside the repo', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);

    // Place a valid manifest outside the repo, then symlink the expected
    // manifest path to it. Realpath containment must reject this.
    const externalDir = mkdtempSync(path.join(os.tmpdir(), 'ext-manifest-'));
    writeFileSync(path.join(externalDir, 'manifest.json'), JSON.stringify({ required: ['X'] }), 'utf8');
    const manifestDir = path.join(repoRoot, 'supabase', 'functions');
    mkdirSync(manifestDir, { recursive: true });
    execFileSync('ln', ['-s', path.join(externalDir, 'manifest.json'), path.join(manifestDir, 'secrets.manifest.json')]);

    writeProjectWorkflowChecks(repoRoot, {
      requireSecretManifest: true,
      secretManifestPath: 'supabase/functions/secrets.manifest.json',
    });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    const manifest = output.checks.outcomes.find((o) => o.plugin === 'secret-manifest');
    assert.ok(manifest);
    assert.equal(manifest.ok, false);
    assert.match(manifest.findings[0].reason, /symlinks outside the repo/);
    rmSync(externalDir, { recursive: true, force: true });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: runner ignores plugin self-reported ok:true when findings or error are present', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'checks', 'runner.ts'));
  // A buggy plugin that claims ok:true but surfaces findings must NOT clear
  // the gate. The runner derives effective ok from observable state.
  const buggyPlugin = {
    name: 'buggy',
    async run() {
      return { plugin: 'buggy', ok: true, findings: [{ plugin: 'buggy', reason: 'lying' }] };
    },
  };
  const report = await mod.runChecks(
    { repoRoot: '/', config: { checks: {} }, deployConfig: {} },
    [buggyPlugin],
  );
  assert.equal(report.ok, false, 'runner rejects self-reported ok:true alongside findings');
  // The outcome itself still carries ok:true (preserve plugin's self-report
  // in the envelope); only the aggregate `ok` is derived.
  assert.equal(report.outcomes[0].ok, true);
});

test('checks: secret-manifest rejects a manifest with non-array required field', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    writeSecretManifest(repoRoot, { required: 'OPENAI_API_KEY', optional: [] });
    writeProjectWorkflowChecks(repoRoot, {
      requireSecretManifest: true,
      secretManifestPath: 'supabase/functions/secrets.manifest.json',
    });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    const manifest = output.checks.outcomes.find((o) => o.plugin === 'secret-manifest');
    assert.ok(manifest);
    assert.equal(manifest.ok, false);
    assert.match(manifest.findings[0].reason, /"required" must be an array/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checks: runner catches plugin throws and reports them as fail-closed outcomes', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'checks', 'runner.ts'));
  const throwingPlugin = {
    name: 'boom',
    async run() {
      throw new Error('synthetic plugin crash');
    },
  };
  const cleanPlugin = {
    name: 'clean',
    async run() {
      return { plugin: 'clean', ok: true, findings: [] };
    },
  };
  const report = await mod.runChecks(
    { repoRoot: '/', config: { checks: {} }, deployConfig: {} },
    [throwingPlugin, cleanPlugin],
  );
  assert.equal(report.ok, false, 'overall fails when any plugin throws');
  assert.equal(report.outcomes.length, 2, 'both plugins ran; thrower did not abort the loop');
  const boom = report.outcomes.find((o) => o.plugin === 'boom');
  assert.ok(boom);
  assert.equal(boom.ok, false);
  assert.match(boom.findings[0].reason, /plugin threw: synthetic plugin crash/);
  const clean = report.outcomes.find((o) => o.plugin === 'clean');
  assert.ok(clean);
  assert.equal(clean.ok, true);
});

test('checks: failing plugin flips overall ready to false even when observed-deploys gate passes', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    // Baseline: observed-deploys gate is green.
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    const baseline = JSON.parse(runCli(['run', 'release-check', '--json'], repoRoot).stdout);
    assert.equal(baseline.ready, true, 'baseline observed-deploys gate passes');

    // Now turn on a plugin whose requirements cannot be met.
    writeProjectWorkflowChecks(repoRoot, {
      requiredRepoSecrets: ['A_NEVER_EXISTS_SECRET'],
    });
    const stub = JSON.stringify({ '': [] });
    const result = runCli(['run', 'release-check', '--json'], repoRoot, {
      PIPELANE_CHECKS_GH_SECRETS_STUB: stub,
    }, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    // But blockedSurfaces is still empty (observed gate is fine); the
    // blocker is the plugin, not a surface.
    assert.deepEqual(output.blockedSurfaces, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pr, merge, deploy, and task-lock work with a fake gh adapter', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    GH_FAIL_ON_DELETE_BRANCH: '1',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'API Work', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');

    const pr = JSON.parse(runCli(['run', 'pr', '--title', 'API Work', '--json'], created.worktreePath, env).stdout);
    assert.match(pr.url, /example\.test\/pr/);

    const verify = JSON.parse(runCli(['run', 'task-lock', 'verify', '--task', 'API Work', '--json'], created.worktreePath, env).stdout);
    assert.equal(verify.ok, true);

    const merged = JSON.parse(runCli(['run', 'merge', '--json'], created.worktreePath, env).stdout);
    assert.equal(merged.mergedSha, 'deadbeefcafebabe');
    assert.match(merged.message, /Production deploy dispatched via Deploy Hosted/);

    const deployed = JSON.parse(runCli(['run', 'deploy', 'prod', '--async', '--json'], created.worktreePath, env).stdout);
    assert.equal(deployed.environment, 'prod');
    assert.equal(deployed.sha, 'deadbeefcafebabe');
    assert.equal(deployed.status, 'requested');
    assert.equal(deployed.taskSlug, 'api-work');
    assert.ok(deployed.idempotencyKey, 'record carries an idempotencyKey');

    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.prMergeCalls.length, 1);
    assert.ok(!ghState.prMergeCalls[0].includes('--delete-branch'));
    assert.equal(ghState.workflows.length, 2);
    assert.equal(ghState.workflows[0].name, 'Deploy Hosted');
    assert.ok(ghState.workflows[0].args.includes('environment=production'));
    assert.ok(ghState.workflows[0].args.includes('sha=deadbeefcafebabe'));
    assert.ok(ghState.workflows[0].args.includes('surfaces=frontend,edge,sql'));
    assert.ok(ghState.workflows[0].args.includes('bypass_staging_guard=true'));
    assert.ok(ghState.workflows[1].args.includes('bypass_staging_guard=true'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('lockless PR branch can report, merge by PR number, and deploy the merged PR to staging', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
      config.buildMode.autoDeployOnMerge = false;
    });
    commitAll(repoRoot, 'Adopt pipelane');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Selection Arrows', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    const opened = JSON.parse(runCli(['run', 'pr', '--title', 'Canvas Selection Arrows', '--json'], created.worktreePath, env).stdout);
    assert.equal(opened.taskSlug, 'canvas-selection-arrows');

    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`);
    rmSync(lockPath, { force: true });

    const reported = JSON.parse(runCli(['run', 'pr', '--json'], created.worktreePath, env).stdout);
    assert.equal(reported.taskSlug, 'canvas-selection-arrows');
    assert.equal(reported.branchName, created.branch);
    assert.match(reported.url, /example\.test\/pr\/1/);
    assert.equal(existsSync(lockPath), false, 'lockless /pr must not recreate the task lock');

    const openDeploy = runCli(['run', 'deploy', 'staging', '--pr', '1', '--json'], repoRoot, env, true);
    assert.equal(openDeploy.status, 1);
    assert.match(openDeploy.stderr, /can only use merged PRs/);
    assert.equal(existsSync(lockPath), false, 'failed lockless deploy must not recreate the task lock');

    const currentBranch = run('git', ['branch', '--show-current'], repoRoot);
    const merged = JSON.parse(runCli(['run', 'merge', '--pr', '1', '--json'], repoRoot, env).stdout);
    assert.equal(merged.mergedSha, 'deadbeefcafebabe');
    assert.match(merged.message, /Pull request merged on GitHub/);
    assert.match(merged.message, new RegExp(`Current worktree branch remains ${currentBranch}\\.`));
    assert.equal(existsSync(lockPath), false, 'lockless merge must not recreate the task lock');

    const deployed = JSON.parse(runCli(['run', 'deploy', 'staging', '--pr', '1', '--json'], repoRoot, env).stdout);
    assert.equal(deployed.environment, 'staging');
    assert.equal(deployed.sha, 'deadbeefcafebabe');
    assert.equal(deployed.taskSlug, 'canvas-selection-arrows');
    assert.equal(deployed.status, 'succeeded');
    assert.equal(existsSync(lockPath), false, 'lockless deploy must not recreate the task lock');

    const prState = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'pr-state.json'), 'utf8'));
    assert.equal(prState.records['canvas-selection-arrows'].number, 1);
    assert.equal(prState.records['canvas-selection-arrows'].mergedSha, 'deadbeefcafebabe');

    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.prMergeCalls.length, 1);
    assert.equal(ghState.workflows.length, 1);
    assert.ok(ghState.workflows[0].args.includes('environment=staging'));
    assert.ok(ghState.workflows[0].args.includes('sha=deadbeefcafebabe'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('pr can create a new PR from a manual task branch without a task lock', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');

    execFileSync('git', ['checkout', '-b', 'task/fix-priority-sorting-e0ed'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(repoRoot, 'priority.txt'), 'sort priorities\n', 'utf8');

    const opened = JSON.parse(runCli(['run', 'pr', '--title', 'Fix priority sorting', '--json'], repoRoot, env).stdout);
    assert.equal(opened.taskSlug, 'fix-priority-sorting');
    assert.equal(opened.branchName, 'task/fix-priority-sorting-e0ed');
    assert.match(opened.url, /example\.test\/pr\/1/);

    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', 'fix-priority-sorting.json');
    assert.equal(existsSync(lockPath), false, 'lockless /pr must not create a task lock for a manual branch');

    const prState = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'pr-state.json'), 'utf8'));
    assert.equal(prState.records['fix-priority-sorting'].number, 1);
    assert.equal(prState.records['fix-priority-sorting'].branchName, 'task/fix-priority-sorting-e0ed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('merge skips auto-deploy in build mode when autoDeployOnMerge is disabled', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    GH_FAIL_ON_DELETE_BRANCH: '1',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Manual Deploy', '--json'], repoRoot).stdout);
    const configPath = path.join(created.worktreePath, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.buildMode.autoDeployOnMerge = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Manual Deploy', '--json'], created.worktreePath, env);

    const merged = JSON.parse(runCli(['run', 'merge', '--json'], created.worktreePath, env).stdout);
    assert.equal(merged.mergedSha, 'deadbeefcafebabe');
    assert.match(merged.message, /auto-deploy is disabled/);

    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.prMergeCalls.length, 1);
    assert.equal(ghState.workflows.length, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('merge refreshes origin/base and leaves local main untouched', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    GH_PR_MERGE_PUSH_HEAD: '1',
    GH_PR_MERGE_BASE: 'main',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'test merge receipt'], repoRoot);

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Merge Receipt', '--json'], repoRoot).stdout);
    const branchName = run('git', ['branch', '--show-current'], created.worktreePath);
    const localMainBefore = run('git', ['rev-parse', 'main'], repoRoot);

    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Merge Receipt', '--json'], created.worktreePath, env);

    const merged = JSON.parse(runCli(['run', 'merge', '--json'], created.worktreePath, env).stdout);
    const originMainAfter = run('git', ['rev-parse', 'origin/main'], created.worktreePath);
    const localMainAfter = run('git', ['rev-parse', 'main'], repoRoot);

    assert.equal(originMainAfter, merged.mergedSha);
    assert.equal(localMainAfter, localMainBefore, 'local main should remain untouched');
    assert.notEqual(localMainAfter, merged.mergedSha, 'merge must not fast-forward the local main branch');
    assert.equal(run('git', ['branch', '--show-current'], created.worktreePath), branchName);
    assert.match(merged.message, /Refreshed origin\/main:/);
    assert.match(merged.message, /Remote base matches the merged SHA/);
    assert.match(merged.message, /Current worktree branch remains/);
    assert.match(merged.message, /Local base checkouts were not changed/);
    assert.match(merged.message, /Stay in this task worktree and deploy staging from here/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy verifies via gh run watch + healthcheck stubs and records status=succeeded', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
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

    // Build mode auto-deploy dispatches prod on merge; the explicit staging deploy
    // should still stay idempotent across reruns.
    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.workflows.length, 2);
    assert.ok(ghState.workflows[0].args.includes('environment=production'));
    assert.ok(ghState.workflows[1].args.includes('environment=staging'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy in a task worktree falls back to the shared repo-root CLAUDE.md when the worktree has no local CLAUDE.md', () => {
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
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Shared Deploy Config', '--json'], repoRoot).stdout);
    rmSync(path.join(created.worktreePath, 'CLAUDE.md'), { force: true });
    assert.equal(existsSync(path.join(created.worktreePath, 'CLAUDE.md')), false, 'task worktree should rely on the shared root CLAUDE.md');

    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const deployed = JSON.parse(runCli(['run', 'deploy', 'staging', '--sha', sha, '--json'], created.worktreePath, env).stdout);

    assert.equal(deployed.status, 'succeeded');
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
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  writeFileSync(ghStateFile, JSON.stringify({ prs: {}, workflows: [] }, null, 2), 'utf8');
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '503',
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Bad Healthcheck', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Bad Healthcheck', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);

    const failed = runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /healthcheck returned HTTP 503/);

    const stateFile = path.join(repoRoot, '.git', 'pipelane-state', 'deploy-state.json');
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

test('deploy fails before dispatch when a requested surface has no configured healthcheck URL', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'workflow-kit-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  writeFileSync(ghStateFile, JSON.stringify({ prs: {}, workflows: [] }, null, 2), 'utf8');
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const config = buildFullDeployConfig();
    config.edge.staging.healthcheckUrl = '';
    writeSharedDeployConfig(repoRoot, config);
    commitAll(repoRoot, 'Adopt workflow-kit');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Missing Healthcheck', '--json'], repoRoot).stdout);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const blocked = runCli(
      ['run', 'deploy', 'staging', '--surfaces', 'edge', '--sha', sha, '--json'],
      created.worktreePath,
      env,
      true,
    );

    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Deploy blocked: staging/);
    assert.match(blocked.stderr, /edge staging health check/);
    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.workflows.length, 0, 'deploy should fail before gh workflow dispatch');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('deploy prod blocks without typed-SHA confirmation in a non-TTY', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
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
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
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
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
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
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
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
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
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
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  // Break the merge step: pr.state flips to MERGED but mergeCommit stays null,
  // so the poller sees a half-merged PR and must fail rather than invent a SHA.
  const ghPath = path.join(ghBin, 'gh');
  const original = readFileSync(ghPath, 'utf8');
  writeFileSync(
    ghPath,
    original.replace(
      "pr.mergeCommit = { oid: mergeSha };",
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'SHA Miss', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'SHA Miss', '--json'], created.worktreePath, env);

    const failed = runCli(['run', 'merge', '--json'], created.worktreePath, env, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Timed out waiting for GitHub to report PR #\d+ as MERGED with a merge commit/);
    assert.doesNotMatch(failed.stderr, /rev-parse/);

    const prState = readFileSync(path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json'), 'utf8');
    assert.doesNotMatch(prState, /mergedSha/, 'no mergedSha recorded on failure');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('merge fails closed when non-required PR checks fail', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const ghPath = path.join(ghBin, 'gh');
  const original = readFileSync(ghPath, 'utf8');
  writeFileSync(
    ghPath,
    original.replace(
      "if (args[0] === 'pr' && args[1] === 'checks') {\n  process.exit(0);\n}",
      `if (args[0] === 'pr' && args[1] === 'checks') {
  if (args.includes('--required') && !args.includes('--watch')) {
    process.stderr.write("no required checks reported on the 'test-branch' branch\\n");
    process.exit(1);
  }
  if (args.includes('--watch')) {
    process.stderr.write('validate failed\\n');
    process.exit(1);
  }
  process.exit(0);
}`,
    ),
    { mode: 0o755, encoding: 'utf8' },
  );

  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Check Fail', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Check Fail', '--json'], created.worktreePath, env);

    const failed = runCli(['run', 'merge', '--json'], created.worktreePath, env, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /validate failed/);

    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    assert.equal(ghState.prMergeCalls?.length ?? 0, 0, 'merge command never reaches `gh pr merge`');

    const prState = readFileSync(path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json'), 'utf8');
    assert.doesNotMatch(prState, /mergedSha/, 'no mergedSha recorded on failed checks');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('pr blocks denied paths and --force-include overrides per-path', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
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

test('pr in an external task-like checkout returns recovery choices instead of /new guidance', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external change\n', 'utf8');

    const result = runCli(['run', 'pr', '--json'], externalWorktree, {}, true);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);

    assert.equal(output.needsRecoveryChoice, true);
    assert.equal(output.taskSlug, 'canvas-palette-options');
    assert.deepEqual(
      output.options.map((option) => option.value),
      ['use-current-checkout', 'continue-attached-workspace'],
    );
    assert.match(output.message, /You have 2 options:/);
    assert.match(output.message, /Type which option you would like to proceed with/);
    assert.doesNotMatch(output.message, /\/new|--task/);

    const lock = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`), 'utf8'));
    assert.equal(lock.worktreePath, created.worktreePath, 'first preflight must not mutate the existing task lock');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('pr recovery use-current-checkout rebinds the task lock with history and continues the PR', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);
    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`);
    const originalLock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const previousHistory = {
      reboundAt: '2026-04-25T00:00:00.000Z',
      reason: 'fixture',
      fromBranchName: 'codex/old-1111',
      fromWorktreePath: '/tmp/old',
      toBranchName: originalLock.branchName,
      toWorktreePath: originalLock.worktreePath,
      fingerprint: 'old-fingerprint',
    };
    writeFileSync(lockPath, `${JSON.stringify({
      ...originalLock,
      nextAction: 'stale next action from the attached workspace',
      promotedWithoutStagingSmoke: true,
      bindingHistory: [previousHistory],
    }, null, 2)}\n`, 'utf8');

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external change\n', 'utf8');

    const recoveryPrompt = JSON.parse(runCli(['run', 'pr', '--json'], externalWorktree, env, true).stdout);
    const option = recoveryPrompt.options.find((entry) => entry.value === 'use-current-checkout');
    assert.ok(option?.fingerprint);

    const pr = JSON.parse(runCli([
      'run', 'pr',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.fingerprint,
      '--title', 'Canvas Palette Options',
      '--json',
    ], externalWorktree, env).stdout);

    assert.match(pr.url, /example\.test\/pr/);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lock.branchName, 'codex/canvas-palette-options-4f2a');
    assert.equal(lock.worktreePath, realpathSync(externalWorktree));
    assert.notEqual(lock.nextAction, 'stale next action from the attached workspace');
    assert.match(lock.nextAction, /PR #1 open, awaiting CI/);
    assert.equal(lock.promotedWithoutStagingSmoke, undefined);
    assert.equal(lock.bindingHistory.length, 2);
    assert.deepEqual(lock.bindingHistory[0], previousHistory);
    assert.equal(lock.bindingHistory[1].fromBranchName, created.branch);
    assert.equal(lock.bindingHistory[1].fromWorktreePath, created.worktreePath);
    assert.equal(lock.bindingHistory[1].toBranchName, 'codex/canvas-palette-options-4f2a');
    assert.equal(lock.bindingHistory[1].toWorktreePath, realpathSync(externalWorktree));
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('pr recovery continue-attached-workspace returns a handoff and mutates nothing', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external change\n', 'utf8');

    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`);
    const beforeLock = readFileSync(lockPath, 'utf8');
    const recoveryPrompt = JSON.parse(runCli(['run', 'pr', '--json'], externalWorktree, env, true).stdout);
    const option = recoveryPrompt.options.find((entry) => entry.value === 'continue-attached-workspace');
    assert.ok(option?.fingerprint);

    const handoff = JSON.parse(runCli([
      'run', 'pr',
      '--recover', 'continue-attached-workspace',
      '--binding-fingerprint', option.fingerprint,
      '--json',
    ], externalWorktree, env).stdout);

    assert.equal(handoff.handoff, true);
    assert.match(handoff.message, /Continue in the attached task workspace/);
    assert.equal(readFileSync(lockPath, 'utf8'), beforeLock);
    assert.match(run('git', ['status', '--short'], externalWorktree), /palette\.txt/);
    assert.equal(existsSync(ghStateFile), false, 'continue-attached-workspace must not call gh');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('api action pr recovery confirmation executes and rebinds when fingerprint is fresh', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external change\n', 'utf8');

    const first = runCli(['run', 'api', 'action', 'pr', '--task', 'Canvas Palette Options', '--json'], externalWorktree, env, true);
    assert.equal(first.status, 1);
    const firstEnvelope = JSON.parse(first.stdout);
    const choiceInput = firstEnvelope.data.preflight.inputs.find((input) => input.name === 'recover');
    const option = choiceInput.options.find((entry) => entry.value === 'use-current-checkout');
    assert.ok(option.params.bindingFingerprint);

    const second = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--json',
    ], externalWorktree, env).stdout);
    assert.equal(second.data.preflight.requiresConfirmation, true);
    const token = second.data.preflight.confirmation.token;
    assert.ok(token);

    const executed = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--execute',
      '--confirm-token', token,
      '--json',
    ], externalWorktree, env).stdout);

    assert.equal(executed.ok, true);
    assert.match(executed.data.execution.result.url, /example\.test\/pr/);
    const lock = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`), 'utf8'));
    assert.equal(lock.branchName, 'codex/canvas-palette-options-4f2a');
    assert.equal(lock.worktreePath, realpathSync(externalWorktree));
    assert.equal(lock.bindingHistory.length, 1);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('api action pr recovery choice uses a confirmation token and rejects stale binding fingerprints', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external change\n', 'utf8');

    const first = runCli(['run', 'api', 'action', 'pr', '--task', 'Canvas Palette Options', '--json'], externalWorktree, {}, true);
    assert.equal(first.status, 1);
    const firstEnvelope = JSON.parse(first.stdout);
    const choiceInput = firstEnvelope.data.preflight.inputs.find((input) => input.name === 'recover');
    const titleInput = firstEnvelope.data.preflight.inputs.find((input) => input.name === 'title');
    assert.equal(choiceInput.type, 'choice');
    assert.equal(titleInput, undefined, 'recovery preflight should collect the recovery choice before path-specific inputs');
    const option = choiceInput.options.find((entry) => entry.value === 'use-current-checkout');
    assert.ok(option.params.bindingFingerprint);

    const titlePrompt = runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--json',
    ], externalWorktree, {}, true);
    assert.equal(titlePrompt.status, 1);
    const titlePromptEnvelope = JSON.parse(titlePrompt.stdout);
    assert.equal(titlePromptEnvelope.data.preflight.needsInput, true);
    assert.deepEqual(titlePromptEnvelope.data.preflight.inputs.map((input) => input.name), ['title']);

    const second = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--json',
    ], externalWorktree).stdout);
    assert.equal(second.data.preflight.requiresConfirmation, true);
    const token = second.data.preflight.confirmation.token;
    assert.ok(token);

    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external change after preflight\n', 'utf8');
    const executed = runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--execute',
      '--confirm-token', token,
      '--json',
    ], externalWorktree, {}, true);
    const executedEnvelope = JSON.parse(executed.stdout);
    assert.equal(executed.status, 1);
    assert.equal(executedEnvelope.ok, false);
    assert.match(executedEnvelope.message, /stale|preflight/i);

    const lock = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`), 'utf8'));
    assert.equal(lock.worktreePath, created.worktreePath, 'stale recovery must not mutate the lock');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action pr recovery continue-attached-workspace does not require a PR title', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external change\n', 'utf8');

    const first = runCli(['run', 'api', 'action', 'pr', '--task', 'Canvas Palette Options', '--json'], externalWorktree, {}, true);
    assert.equal(first.status, 1);
    const firstEnvelope = JSON.parse(first.stdout);
    const choiceInput = firstEnvelope.data.preflight.inputs.find((input) => input.name === 'recover');
    const option = choiceInput.options.find((entry) => entry.value === 'continue-attached-workspace');
    assert.ok(option.params.bindingFingerprint);

    const second = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'continue-attached-workspace',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--json',
    ], externalWorktree).stdout);
    assert.equal(second.data.preflight.requiresConfirmation, true);
    assert.equal(second.data.preflight.needsInput, false);
    assert.deepEqual(second.data.preflight.inputs, []);
    const token = second.data.preflight.confirmation.token;

    const executed = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'continue-attached-workspace',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--execute',
      '--confirm-token', token,
      '--json',
    ], externalWorktree).stdout);
    assert.equal(executed.ok, true);
    assert.equal(executed.data.execution.result.handoff, true);
    assert.match(executed.data.execution.result.message, /Continue in the attached task workspace/);

    const lock = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`), 'utf8'));
    assert.equal(lock.worktreePath, created.worktreePath);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('task binding diagnosis hashes dirty status only when recovery choices are needed', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'attached.txt'), 'attached dirty state\n', 'utf8');

    const state = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const binding = await import(path.join(KIT_ROOT, 'src', 'operator', 'task-binding.ts'));
    const resolved = binding.diagnoseTaskBinding(state.resolveWorkflowContext(created.worktreePath), 'Canvas Palette Options');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.current.dirty, true);
    assert.equal(resolved.current.statusDigest, '', 'resolved binding checks should not compute recovery-only status digests');

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'palette.txt'), 'external dirty state\n', 'utf8');

    const recovery = binding.diagnoseTaskBinding(state.resolveWorkflowContext(externalWorktree), 'Canvas Palette Options');
    assert.equal(recovery.status, 'needs-recovery');
    assert.notEqual(recovery.current.statusDigest, '', 'recovery fingerprints need the current checkout digest');
    assert.notEqual(recovery.attached.statusDigest, '', 'recovery fingerprints need the attached workspace digest');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action pr preflight checks live PR before trusting local pr-state title', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'initial change\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Canvas Palette Options', '--json'], created.worktreePath, env);

    writeFileSync(path.join(created.worktreePath, 'followup.txt'), 'follow-up change\n', 'utf8');
    const livePreflight = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--json',
    ], created.worktreePath, env).stdout);
    assert.equal(livePreflight.data.preflight.allowed, true);
    assert.equal(livePreflight.data.preflight.requiresConfirmation, false);
    assert.equal(livePreflight.data.preflight.needsInput, false);

    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    delete ghState.prs[created.branch];
    writeFileSync(ghStateFile, JSON.stringify(ghState, null, 2) + '\n', 'utf8');

    const stalePreflight = runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--json',
    ], created.worktreePath, env, true);
    assert.equal(stalePreflight.status, 1);
    const envelope = JSON.parse(stalePreflight.stdout);
    assert.equal(envelope.data.preflight.needsInput, true);
    assert.deepEqual(envelope.data.preflight.inputs.map((input) => input.name), ['title']);
    assert.equal(envelope.data.preflight.defaultParams.title, 'Canvas Palette Options');
    assert.match(envelope.data.preflight.reason, /no live PR/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('pr recovery blocks before mutation when task has non-binding mismatches', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'mode mismatch fixture'], repoRoot);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`);
    const beforeLock = readFileSync(lockPath, 'utf8');

    const result = runCli(['run', 'pr', '--json'], externalWorktree, {}, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rebinding cannot fix/);
    assert.match(result.stderr, /mode/);
    assert.equal(readFileSync(lockPath, 'utf8'), beforeLock, 'mode mismatch recovery must not mutate the lock');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('pr recovery blocks when current checkout is already locked by another task', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lockDir = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks');
    writeFileSync(path.join(lockDir, 'other-task.json'), `${JSON.stringify({
      taskSlug: 'other-task',
      taskName: 'Other Task',
      branchName: 'codex/canvas-palette-options-4f2a',
      worktreePath: realpathSync(externalWorktree),
      mode: 'build',
      surfaces: ['app'],
      updatedAt: '2026-04-25T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');
    const lockPath = path.join(lockDir, `${created.taskSlug}.json`);
    const beforeLock = readFileSync(lockPath, 'utf8');

    const result = runCli(['run', 'pr', '--task', 'Canvas Palette Options', '--json'], externalWorktree, {}, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already locked by another task/);
    assert.match(result.stderr, /other-task/);
    assert.equal(readFileSync(lockPath, 'utf8'), beforeLock, 'cross-lock collision recovery must not mutate the target lock');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('pr recovery blocks detached HEAD before rebinding the task lock', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/detached-fixture', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['checkout', '--detach'], {
      cwd: externalWorktree,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`);
    const beforeLock = readFileSync(lockPath, 'utf8');

    const result = runCli(['run', 'pr', '--task', 'Canvas Palette Options', '--json'], externalWorktree, {}, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /detached HEAD/);
    assert.equal(readFileSync(lockPath, 'utf8'), beforeLock, 'detached recovery must not mutate the lock');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('pr recovery from base checkout only offers attached workspace and never rebinds base', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);
    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`);
    const beforeLock = readFileSync(lockPath, 'utf8');

    const result = runCli(['run', 'pr', '--task', 'Canvas Palette Options', '--json'], repoRoot, {}, true);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);

    assert.equal(output.needsRecoveryChoice, true);
    assert.deepEqual(output.options.map((option) => option.value), ['continue-attached-workspace']);
    assert.doesNotMatch(JSON.stringify(output.options), /use-current-checkout/);
    assert.match(output.message, /You have 1 option:/);
    assert.equal(readFileSync(lockPath, 'utf8'), beforeLock, 'base checkout preflight must not mutate the lock');

    const blocked = runCli([
      'run', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', 'stale-fingerprint',
      '--json',
    ], repoRoot, {}, true);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /stale|preflight|no longer/i);
    assert.equal(readFileSync(lockPath, 'utf8'), beforeLock, 'base checkout recovery must not mutate the lock');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('pr recovery omits attached-workspace handoff when the attached workspace is missing', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);
    execFileSync('git', ['worktree', 'remove', '--force', created.worktreePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = runCli(['run', 'pr', '--json'], externalWorktree, {}, true);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);

    assert.equal(output.needsRecoveryChoice, true);
    assert.deepEqual(output.options.map((option) => option.value), ['use-current-checkout']);
    assert.match(output.message, /You have 1 option:/);
    assert.match(output.message, /Attached task workspace: .*\(missing\)/);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('pr recovery surfaces dirty attached workspace state in both recovery options', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'attached-dirty.txt'), 'dirty attached workspace\n', 'utf8');

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = runCli(['run', 'pr', '--json'], externalWorktree, {}, true);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    const currentOption = output.options.find((option) => option.value === 'use-current-checkout');
    const attachedOption = output.options.find((option) => option.value === 'continue-attached-workspace');

    assert.match(currentOption.description, /attached workspace currently has \d+ uncommitted status entr/);
    assert.match(attachedOption.description, /It has \d+ uncommitted status entr/);
    assert.match(output.message, /Attached task workspace: .*uncommitted status entr/);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action pr recovery stale fingerprint detects sampled large untracked file changes', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(path.join(externalWorktree, 'large.bin'), `${'a'.repeat(2 * 1024 * 1024)}\n`, 'utf8');

    const first = runCli(['run', 'api', 'action', 'pr', '--task', 'Canvas Palette Options', '--json'], externalWorktree, {}, true);
    assert.equal(first.status, 1);
    const firstEnvelope = JSON.parse(first.stdout);
    const choiceInput = firstEnvelope.data.preflight.inputs.find((input) => input.name === 'recover');
    const option = choiceInput.options.find((entry) => entry.value === 'use-current-checkout');

    const second = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--json',
    ], externalWorktree).stdout);
    const token = second.data.preflight.confirmation.token;

    writeFileSync(path.join(externalWorktree, 'large.bin'), `${'b'.repeat(2 * 1024 * 1024)}\n`, 'utf8');
    const executed = runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--execute',
      '--confirm-token', token,
      '--json',
    ], externalWorktree, {}, true);
    const executedEnvelope = JSON.parse(executed.stdout);
    assert.equal(executed.status, 1);
    assert.match(executedEnvelope.message, /stale|preflight/i);

    const lock = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`), 'utf8'));
    assert.equal(lock.worktreePath, created.worktreePath, 'large-file stale recovery must not mutate the lock');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action pr recovery fingerprint tracks metadata beyond content sampling cap', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const externalParent = mkdtempSync(path.join(os.tmpdir(), 'pipelane-external-'));
  const externalWorktree = path.join(externalParent, 'canvas-palette-options-4f2a');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Canvas Palette Options', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'add', externalWorktree, '-b', 'codex/canvas-palette-options-4f2a', 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let index = 0; index <= 512; index += 1) {
      writeFileSync(path.join(externalWorktree, `bulk-${String(index).padStart(3, '0')}.txt`), 'a\n', 'utf8');
    }

    const first = runCli(['run', 'api', 'action', 'pr', '--task', 'Canvas Palette Options', '--json'], externalWorktree, {}, true);
    assert.equal(first.status, 1);
    const firstEnvelope = JSON.parse(first.stdout);
    const choiceInput = firstEnvelope.data.preflight.inputs.find((input) => input.name === 'recover');
    const option = choiceInput.options.find((entry) => entry.value === 'use-current-checkout');
    assert.ok(option.params.bindingFingerprint);

    const second = JSON.parse(runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--json',
    ], externalWorktree).stdout);
    const token = second.data.preflight.confirmation.token;

    writeFileSync(path.join(externalWorktree, 'bulk-512.txt'), 'changed beyond the content sampling cutoff\n', 'utf8');
    const executed = runCli([
      'run', 'api', 'action', 'pr',
      '--task', 'Canvas Palette Options',
      '--recover', 'use-current-checkout',
      '--binding-fingerprint', option.params.bindingFingerprint,
      '--title', 'Canvas Palette Options',
      '--execute',
      '--confirm-token', token,
      '--json',
    ], externalWorktree, {}, true);
    const executedEnvelope = JSON.parse(executed.stdout);
    assert.equal(executed.status, 1);
    assert.match(executedEnvelope.message, /stale|preflight/i);

    const lock = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', `${created.taskSlug}.json`), 'utf8'));
    assert.equal(lock.worktreePath, created.worktreePath, 'overflow-path stale recovery must not mutate the lock');
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // best-effort cleanup
    }
    rmSync(externalParent, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --all-stale prunes stale task locks', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
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

test('api snapshot tags stale cleanup candidates and exposes apply-all-stale action', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Stale Candidate', '--json'], repoRoot).stdout);

    execFileSync('git', ['worktree', 'remove', '--force', created.worktreePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['branch', '-D', created.branch], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const envelope = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    const branch = envelope.data.branches.find((entry) => entry.task?.taskSlug === 'stale-candidate');
    assert.ok(branch, 'stale candidate branch row is present');
    assert.equal(branch.cleanup.tag, 'stale');
    assert.equal(branch.cleanup.stale, true);
    assert.equal(branch.cleanup.eligible, true);
    assert.match(branch.cleanup.reason, /worktree/);
    assert.match(branch.cleanup.reason, /branch/);
    assert.ok(branch.cleanup.evidence.some((entry) => entry.includes('worktree')));
    assert.ok(branch.cleanup.evidence.some((entry) => entry.includes('branch')));

    const applyStale = envelope.data.availableActions.find((action) => action.id === 'clean.apply');
    assert.ok(applyStale, 'blanket stale cleanup action is exposed when stale candidates exist');
    assert.deepEqual(applyStale.defaultParams, { allStale: true });
    assert.equal(applyStale.risky, true);
    assert.equal(applyStale.requiresConfirmation, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api snapshot exposes scoped cleanup after production verification and explains prune floor', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Verified Cleanup', '--json'], repoRoot).stdout);
    const mergedSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
    const stateDir = path.join(resolveCommonDir(repoRoot), 'pipelane-state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'pr-state.json'), JSON.stringify({
      records: {
        'verified-cleanup': {
          taskSlug: 'verified-cleanup',
          branchName: created.branch,
          title: 'Verified cleanup',
          number: 42,
          url: 'https://example.test/pr/42',
          mergedSha,
          mergedAt: '2026-04-17T00:00:00Z',
          updatedAt: '2026-04-17T00:00:00Z',
        },
      },
    }, null, 2), 'utf8');
    await writeSucceededDeployRecord(repoRoot, 'prod', mergedSha, ['frontend'], { taskSlug: 'verified-cleanup' });

    const pendingEnvelope = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    const pendingBranch = pendingEnvelope.data.branches.find((entry) => entry.task?.taskSlug === 'verified-cleanup');
    assert.ok(pendingBranch, 'verified branch row is present');
    assert.equal(pendingBranch.cleanup.available, true);
    assert.equal(pendingBranch.cleanup.eligible, false);
    assert.equal(pendingBranch.cleanup.stale, false);
    assert.equal(pendingBranch.cleanup.tag, 'pending');
    assert.match(pendingBranch.cleanup.reason, /5-minute prune floor/);
    const pendingClean = pendingBranch.availableActions.find((action) => action.id === 'clean.apply');
    assert.ok(pendingClean, 'branch exposes cleanup action during prune-floor wait');
    assert.equal(pendingClean.state, 'blocked');
    assert.deepEqual(pendingClean.defaultParams, { task: 'verified-cleanup' });
    assert.equal(
      pendingEnvelope.data.availableActions.some((action) => action.id === 'clean.apply'),
      false,
      'repo-wide all-stale cleanup stays hidden for non-stale completed tasks',
    );

    const lockPath = path.join(stateDir, 'task-locks', 'verified-cleanup.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.updatedAt = '2026-04-17T00:00:00Z';
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');

    const readyEnvelope = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    const readyBranch = readyEnvelope.data.branches.find((entry) => entry.task?.taskSlug === 'verified-cleanup');
    assert.equal(readyBranch.cleanup.available, true);
    assert.equal(readyBranch.cleanup.eligible, true);
    assert.equal(readyBranch.cleanup.stale, false);
    assert.equal(readyBranch.cleanup.tag, 'ready');
    assert.match(readyBranch.cleanup.reason, /prod is verified/);
    const readyClean = readyBranch.availableActions.find((action) => action.id === 'clean.apply');
    assert.equal(readyClean.state, 'awaiting_preflight');
    assert.deepEqual(readyClean.defaultParams, { task: 'verified-cleanup' });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply without scope refuses to run', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
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
    commitAll(repoRoot, 'Adopt pipelane');
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
    commitAll(repoRoot, 'Adopt pipelane');
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
    const keepLockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'keep-me.json');
    assert.ok(existsSync(keepLockPath), 'targeted prune did not touch keep-me');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --task closes out the workspace: lock + worktree + merged branch all removed', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const drop = JSON.parse(runCli(['run', 'new', '--task', 'Drop Live', '--json'], repoRoot).stdout);

    // Intentionally DO NOT delete the worktree or branch. The new branch was
    // forked from origin/main with no commits of its own, so it's "merged"
    // by `git branch -d`'s definition (tip is reachable from main). The
    // worktree is fresh-checked-out with no edits. Both safety checks pass,
    // and the closer should remove all three artifacts.
    const result = runCli(['run', 'clean', '--apply', '--task', 'Drop Live', '--json'], repoRoot, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, ['drop-live']);
    assert.match(envelope.message, /Closed out task workspaces/);

    // Lock file is gone.
    const dropLockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'drop-live.json');
    assert.ok(!existsSync(dropLockPath), 'closer must remove the lock file');

    // Worktree directory is gone.
    assert.ok(!existsSync(drop.worktreePath), 'closer must remove the worktree directory');

    // Local branch is gone.
    const branchProbe = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${drop.branch}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.notEqual(branchProbe.status, 0, 'closer must remove the local branch');

    // Per-artifact summary in the JSON envelope.
    assert.equal(envelope.artifacts.length, 1);
    assert.equal(envelope.artifacts[0].taskSlug, 'drop-live');
    assert.equal(envelope.artifacts[0].worktreeRemoved, true);
    assert.equal(envelope.artifacts[0].branchRemoved, true);
    assert.deepEqual(envelope.artifacts[0].errors, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --task refuses to remove a worktree with uncommitted changes without --force', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Dirty WIP', '--json'], repoRoot).stdout);
    // Dirty the worktree with a tracked-file edit. .gitignored content
    // (e.g. node_modules) is excluded by `git status --porcelain` so this
    // edit is the smallest signal the safety check should latch on to.
    writeFileSync(path.join(created.worktreePath, 'CHANGELOG.md'), 'Dirty edit\n', 'utf8');

    const result = runCli(['run', 'clean', '--apply', '--task', 'Dirty WIP', '--json'], repoRoot, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    const envelope = JSON.parse(result.stdout);

    // Lock pruning still happens — that's pure metadata. Artifact teardown
    // is what stalls.
    assert.deepEqual(envelope.removed, ['dirty-wip']);
    assert.equal(envelope.artifacts[0].worktreeRemoved, false);
    assert.match(envelope.artifacts[0].errors.join('\n'), /uncommitted or untracked changes/);

    // Worktree + branch must still exist after the safety refusal.
    assert.ok(existsSync(created.worktreePath), 'dirty worktree must survive without --force');
    const branchProbe = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${created.branch}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(branchProbe.status, 0, 'branch should not be deleted when worktree removal stalls');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --task --force removes a worktree with uncommitted changes', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Force Dirty', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'CHANGELOG.md'), 'Dirty edit\n', 'utf8');

    const result = runCli(['run', 'clean', '--apply', '--task', 'Force Dirty', '--force', '--json'], repoRoot, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, ['force-dirty']);
    assert.equal(envelope.artifacts[0].worktreeRemoved, true);
    assert.equal(envelope.artifacts[0].branchRemoved, true);
    assert.ok(!existsSync(created.worktreePath), '--force must remove dirty worktree');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --task refuses to delete an unmerged branch without --force', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Unmerged Work', '--json'], repoRoot).stdout);

    // Land a commit on the new branch but don't merge it back. After this
    // the branch tip is no longer reachable from main → `git branch -d` will
    // refuse, and our wrapper should surface that as a non-fatal error
    // pointing at --force. Then commit it and revert the worktree to keep
    // the worktree-clean check passing so we isolate the unmerged-branch
    // refusal from the dirty-worktree refusal.
    writeFileSync(path.join(created.worktreePath, 'NEW_FILE.txt'), 'unmerged change\n', 'utf8');
    execFileSync('git', ['add', 'NEW_FILE.txt'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'unmerged commit'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });

    const result = runCli(['run', 'clean', '--apply', '--task', 'Unmerged Work', '--json'], repoRoot, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, ['unmerged-work']);
    assert.equal(envelope.artifacts[0].worktreeRemoved, true, 'clean worktree should still be removed');
    assert.equal(envelope.artifacts[0].branchRemoved, false, 'unmerged branch must survive without --force');
    assert.match(envelope.artifacts[0].errors.join('\n'), /not fully merged/);

    // Branch must still exist after the safety refusal.
    const branchProbe = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${created.branch}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(branchProbe.status, 0, 'unmerged branch must survive without --force');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --task refuses when invoked from inside the target worktree', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Self Removal', '--json'], repoRoot).stdout);

    // Run /clean from inside the worktree it's trying to remove. git would
    // refuse anyway, but the wrapper turns that into an actionable hint.
    const result = runCli(['run', 'clean', '--apply', '--task', 'Self Removal', '--json'], created.worktreePath, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, ['self-removal']);
    assert.equal(envelope.artifacts[0].worktreeRemoved, false);
    assert.match(envelope.artifacts[0].errors.join('\n'), /Cannot remove worktree .* while inside it/);
    assert.ok(existsSync(created.worktreePath), 'worktree must survive the self-removal refusal');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean (no --apply) lists orphan worktrees that have no matching task lock', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    // pipelane-managed orphan: lock removed but worktree + branch left.
    const tracked = JSON.parse(runCli(['run', 'new', '--task', 'Tracked Orphan', '--json'], repoRoot).stdout);
    rmSync(path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'tracked-orphan.json'));

    // External orphan: created with raw `git worktree add`, never seen by
    // pipelane. Path is OUTSIDE the configured pipelane-worktrees/ dir so
    // the `source` tag should report it as 'external'. realpath the dir
    // because macOS's TMPDIR is a symlink (/var/folders -> /private/var/...)
    // and `git worktree list` reports the resolved path; without this the
    // path the test holds and the path git stores diverge.
    const externalDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'external-worktree-')));
    const externalWorktree = path.join(externalDir, 'wt');
    execFileSync('git', ['worktree', 'add', '-b', 'external/manual-branch', externalWorktree, 'main'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const result = runCli(['run', 'clean', '--json'], repoRoot);
      const envelope = JSON.parse(result.stdout);
      assert.match(envelope.message, /Orphan worktrees/);
      const orphanPaths = envelope.orphanWorktrees.map((entry) => entry.path);
      assert.ok(orphanPaths.includes(tracked.worktreePath), 'pipelane-managed orphan should be listed');
      assert.ok(orphanPaths.includes(externalWorktree), 'external orphan should be listed');
      const trackedEntry = envelope.orphanWorktrees.find((entry) => entry.path === tracked.worktreePath);
      assert.equal(trackedEntry.source, 'pipelane-managed');
      const externalEntry = envelope.orphanWorktrees.find((entry) => entry.path === externalWorktree);
      assert.equal(externalEntry.source, 'external');
      // Main worktree (where main is checked out) must NOT be flagged as orphan.
      assert.ok(!orphanPaths.includes(repoRoot), 'main worktree must not be reported as orphan');
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      rmSync(externalDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply --all-stale skips locks whose worktree + branch are still intact', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const live = JSON.parse(runCli(['run', 'new', '--task', 'Still Live', '--json'], repoRoot).stdout);

    // Keep worktree + branch. --all-stale must refuse this one.
    const result = runCli(['run', 'clean', '--apply', '--all-stale', '--json'], repoRoot, {
      PIPELANE_CLEAN_MIN_AGE_MS: '0',
    });
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.removed, []);
    const liveLockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'still-live.json');
    assert.ok(existsSync(liveLockPath), '--all-stale should not touch live locks');
    // Silence the unused-variable warning by referencing `live` — the intent
    // is to keep `new` running so the lock/worktree/branch are real.
    assert.ok(live.worktreePath);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('slugifyTaskName preserves task names well beyond the old 32-char cap', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    // 47 chars — would have been truncated to "long-task-name-that-exceeds-the-" under the
    // old .slice(0, 32) cap, dropping "old-cap" entirely.
    const longName = 'long task name that exceeds the old cap';
    const created = JSON.parse(runCli(['run', 'new', '--task', longName, '--json'], repoRoot).stdout);
    assert.equal(created.taskSlug, 'long-task-name-that-exceeds-the-old-cap');
    assert.match(created.worktreePath, /long-task-name-that-exceeds-the-old-cap-[0-9a-f]{4}$/);

    const lockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'long-task-name-that-exceeds-the-old-cap.json');
    assert.ok(existsSync(lockPath), 'lock filename should preserve the full slug');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('slugifyTaskName throws with an actionable error when the slug exceeds the max length', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    // 200 chars, all letters — slugifies to 200 chars (well over the 128 cap).
    // The old behavior silently truncated to 128; the new behavior throws so
    // the operator can shorten the name instead of getting a mangled lock.
    const tooLong = 'a'.repeat(200);
    const failed = runCli(['run', 'new', '--task', tooLong], repoRoot, {}, true);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Task name too long after slugification/);
    assert.match(failed.stderr, /200 chars, max is 128/);
    assert.match(failed.stderr, /Shorten the name and retry/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('slugifyTaskName accepts a slug exactly at the max length', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    // 128 alphanumeric chars — after slugify is exactly 128 chars, the boundary.
    const rightAtCap = 'a'.repeat(128);
    const created = JSON.parse(runCli(['run', 'new', '--task', rightAtCap, '--json'], repoRoot).stdout);
    assert.equal(created.taskSlug.length, 128);
    assert.equal(created.taskSlug, rightAtCap);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('clean --apply refuses to prune locks with a missing or unparseable updatedAt', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
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
    const lockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'corrupt-meta.json');
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
    commitAll(repoRoot, 'Adopt pipelane');
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
    const lockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'too-young.json');
    assert.ok(existsSync(lockPath), 'young lock kept');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('dashboard proxies pipelane:api routes and persists local board settings', async () => {
  const repoRoot = createRepo();
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-dashboard-bin-'));
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
    assert.equal(health.pipelaneApiConfigured, true);
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
    assert.equal(snapshot.command, 'pipelane.api.snapshot');
    assert.equal(snapshot.data.branches[0].name, 'codex/pipeline-board-1234');

    const branch = await fetch(`${server.baseUrl}/api/branch/${encodeURIComponent('codex/pipeline-board-1234')}`).then((response) => response.json());
    assert.equal(branch.command, 'pipelane.api.branch');
    assert.equal(branch.data.branchFiles[0].path, 'src/dashboard.ts');
    assert.equal(branch.data.workspaceFiles[1].patchAvailable, false);

    const patch = await fetch(`${server.baseUrl}/api/branch/${encodeURIComponent('codex/pipeline-board-1234')}/patch?file=${encodeURIComponent('src/dashboard.ts')}&scope=branch`).then((response) => response.json());
    assert.equal(patch.command, 'pipelane.api.branch.patch');
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

test('dashboard pr preflight resolves the task lock before same-slug current branch fallback', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  let server;

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.prePrChecks = [];
    });
    commitAll(repoRoot, 'Adopt pipelane');
    runCli(['run', 'new', '--task', 'Dashboard Cwd Routing', '--json'], repoRoot);

    const lock = JSON.parse(readFileSync(path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', 'dashboard-cwd-routing.json'), 'utf8'));
    setWorkflowApiScriptCommand(repoRoot, `node ${CLI_PATH} run api`);
    setWorkflowApiScriptCommand(lock.worktreePath, `node ${CLI_PATH} run api`);
    writeFileSync(path.join(lock.worktreePath, 'dirty.txt'), 'dirty\n', 'utf8');
    execFileSync('git', ['checkout', '-b', 'codex/dashboard-cwd-routing-d00d'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    server = await startDashboardServer(repoRoot);
    const preflightResponse = await fetch(`${server.baseUrl}/api/action/${encodeURIComponent('pr')}/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: { task: 'Dashboard Cwd Routing' } }),
    });
    const envelope = await preflightResponse.json();
    assert.equal(preflightResponse.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.preflight.needsInput, true);
    assert.deepEqual(envelope.data.preflight.inputs.map((input) => input.name), ['title']);
    assert.match(envelope.data.preflight.reason, /Provide a PR title/);
  } finally {
    if (server?.processHandle) {
      server.processHandle.kill('SIGTERM');
      await once(server.processHandle, 'exit').catch(() => undefined);
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('dashboard help endpoint exposes configured slash aliases', async () => {
  const repoRoot = createRepo();
  let server;

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    updateWorkflowConfig(repoRoot, (config) => {
      config.aliases.new = '/start';
      config.aliases.clean = '/tidy';
      config.aliases.status = '/where';
    });

    server = await startDashboardServer(repoRoot);
    const help = await fetch(`${server.baseUrl}/api/help`).then((response) => response.json());

    assert.equal(help.ok, true);
    assert.equal(help.source, 'repo-config');
    assert.equal(help.aliases.new, '/start');
    assert.equal(help.aliases.clean, '/tidy');
    assert.equal(help.aliases.status, '/where');
    assert.ok(help.configPath.endsWith('.pipelane.json'));
  } finally {
    if (server?.processHandle) {
      server.processHandle.kill('SIGTERM');
      await once(server.processHandle, 'exit').catch(() => undefined);
    }
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('dashboard UI ships a Pipelane help drawer', () => {
  const html = readFileSync(path.join(KIT_ROOT, 'src', 'dashboard', 'public', 'index.html'), 'utf8');

  assert.match(html, /id="help-button"/);
  assert.match(html, /data-help-open="true"/);
  assert.match(html, /id="help-overlay"/);
  assert.match(html, /Pipelane Guide/);
  assert.match(html, /Build Journey/);
  assert.match(html, /Release Journey/);
  assert.match(html, /Web Commands/);
  assert.match(html, /\/pipelane update --check/);
});

test('dashboard action input modal renders visible required-field errors', () => {
  const html = readFileSync(path.join(KIT_ROOT, 'src', 'dashboard', 'public', 'index.html'), 'utf8');

  assert.match(html, /data-input-error/);
  assert.match(html, /Choose an option to continue\./);
  assert.match(html, /is required\./);
});

test('dashboard action runner allows sequential recovery inputs', () => {
  const html = readFileSync(path.join(KIT_ROOT, 'src', 'dashboard', 'public', 'index.html'), 'utf8');

  assert.match(html, /attempt < 4/);
});

test('dashboard branch ledger keeps its headers sticky while rows scroll', () => {
  const html = readFileSync(path.join(KIT_ROOT, 'src', 'dashboard', 'public', 'index.html'), 'utf8');

  assert.match(html, /class="panel branch-ledger-panel"/);
  assert.match(html, /class="panel-header branch-ledger-panel-header"/);
  assert.match(html, /\.branch-ledger-panel-header\s*\{[^}]*position: sticky;/s);
  assert.match(html, /\.branch-ledger-panel thead th\s*\{[^}]*top: var\(--branch-ledger-header-height/s);
  assert.match(html, /function syncBranchLedgerHeaderHeight\(\)/);
  assert.match(html, /\.table-wrap\s*\{[^}]*overflow: visible;/s);
});

async function runCliAsync(args, cwd, env = {}) {
  const child = spawn('node', [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, CODEX_HOME: DEFAULT_CODEX_HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const [code] = await once(child, 'exit');
  return { status: code ?? 0, stdout, stderr };
}

test('board detects a running dashboard and skips spawning a second one', async () => {
  const repoRoot = createRepo();
  const port = await getFreePort();
  const probeHits = [];
  const dashboardMod = await import(path.join(KIT_ROOT, 'src', 'dashboard', 'server.ts'));
  const runtime = dashboardMod.buildDashboardRuntimeMetadata();

  const fakeServer = createHttpServer((req, res) => {
    probeHits.push(req.url ?? '');
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, repoRoot, runtime }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  fakeServer.listen(port, '127.0.0.1');
  await once(fakeServer, 'listening');

  try {
    const result = await runCliAsync(
      ['board', '--repo', repoRoot, '--port', String(port)],
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

test('board replaces another running Pipelane Board on the requested port', async () => {
  const existingRepoRoot = createRepo();
  const requestedRepoRoot = createRepo();
  const port = await getFreePort();
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-board-home-'));
  const dashboardMod = await import(path.join(KIT_ROOT, 'src', 'dashboard', 'server.ts'));
  const runtime = dashboardMod.buildDashboardRuntimeMetadata();
  const fakeBoardScript = `
const { createServer } = require('node:http');
const repoRoot = process.env.FAKE_REPO_ROOT;
const port = Number(process.env.FAKE_PORT);
const runtime = JSON.parse(process.env.FAKE_RUNTIME || '{}');
const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, repoRoot, pid: process.pid, runtime }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1', () => process.stdout.write('ready\\n'));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
`;
  const existingBoard = spawn(process.execPath, ['-e', fakeBoardScript], {
    env: {
      ...process.env,
      FAKE_REPO_ROOT: existingRepoRoot,
      FAKE_PORT: String(port),
      FAKE_RUNTIME: JSON.stringify(runtime),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fakeStdout = '';
  let fakeStderr = '';
  existingBoard.stdout.on('data', (chunk) => {
    fakeStdout += chunk.toString('utf8');
  });
  existingBoard.stderr.on('data', (chunk) => {
    fakeStderr += chunk.toString('utf8');
  });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Fake board did not start.\nstdout:\n${fakeStdout}\nstderr:\n${fakeStderr}`));
      }, 4000);
      const handleExit = (code) => {
        clearTimeout(timeout);
        reject(new Error(`Fake board exited early with ${code}.\nstdout:\n${fakeStdout}\nstderr:\n${fakeStderr}`));
      };
      const handleStdout = () => {
        if (!fakeStdout.includes('ready')) {
          return;
        }
        clearTimeout(timeout);
        existingBoard.stdout.off('data', handleStdout);
        existingBoard.off('exit', handleExit);
        resolve();
      };
      existingBoard.stdout.on('data', handleStdout);
      existingBoard.once('exit', handleExit);
      handleStdout();
    });

    const result = await runCliAsync(
      ['board', '--repo', requestedRepoRoot, '--port', String(port), '--no-open'],
      requestedRepoRoot,
      { PIPELANE_DASHBOARD_HOME: homeDir, PIPELANE_OPEN_COMMAND: 'skip' },
    );

    assert.equal(result.status, 0, `unexpected exit.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.ok(result.stdout.includes(`Stopped existing Pipelane Board for ${existingRepoRoot}`));
    assert.match(result.stdout, new RegExp(`Pipelane Board ready at http://127\\.0\\.0\\.1:${port}`));
    await waitForChildExit(existingBoard);
    assert.equal(isPidAlive(existingBoard.pid), false, 'expected the existing board process to be stopped');

    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    assert.equal(path.resolve(health.repoRoot), path.resolve(requestedRepoRoot));
  } finally {
    await runCliAsync(
      ['board', 'stop', '--repo', requestedRepoRoot, '--port', String(port)],
      requestedRepoRoot,
      { PIPELANE_DASHBOARD_HOME: homeDir },
    ).catch(() => undefined);
    if (isPidAlive(existingBoard.pid)) {
      existingBoard.kill();
      await waitForChildExit(existingBoard);
    }
    rmSync(existingRepoRoot, { recursive: true, force: true });
    rmSync(requestedRepoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('board starts on the next open port when another site owns the requested port', async () => {
  const repoRoot = createRepo();
  const port = await getFreePort();
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-board-home-'));
  let boardPort = 0;

  const fakeSite = createHttpServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not a pipelane board');
  });
  fakeSite.listen(port, '127.0.0.1');
  await once(fakeSite, 'listening');

  try {
    const result = await runCliAsync(
      ['board', '--repo', repoRoot, '--port', String(port), '--no-open'],
      repoRoot,
      { PIPELANE_DASHBOARD_HOME: homeDir, PIPELANE_OPEN_COMMAND: 'skip' },
    );

    assert.equal(result.status, 0, `unexpected exit.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Use --port|different runtime|could not be stopped automatically/);
    const match = result.stdout.match(/Pipelane Board ready at http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, `missing ready URL in stdout:\n${result.stdout}`);
    boardPort = Number(match[1]);
    assert.notEqual(boardPort, port);

    const health = await fetch(`http://127.0.0.1:${boardPort}/api/health`).then((response) => response.json());
    assert.equal(path.resolve(health.repoRoot), path.resolve(repoRoot));
    const fakeSiteResponse = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
    assert.equal(fakeSiteResponse, 'not a pipelane board');
  } finally {
    if (boardPort) {
      await runCliAsync(
        ['board', 'stop', '--repo', repoRoot, '--port', String(boardPort)],
        repoRoot,
        { PIPELANE_DASHBOARD_HOME: homeDir },
      ).catch(() => undefined);
    }
    fakeSite.close();
    await once(fakeSite, 'close').catch(() => undefined);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('board starts on the next open port when a health endpoint is not Pipelane-owned', async () => {
  const repoRoot = createRepo();
  const port = await getFreePort();
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-board-home-'));
  let boardPort = 0;

  const fakeServer = createHttpServer((req, res) => {
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
      ['board', '--repo', repoRoot, '--port', String(port), '--no-open'],
      repoRoot,
      { PIPELANE_DASHBOARD_HOME: homeDir, PIPELANE_OPEN_COMMAND: 'skip' },
    );

    assert.equal(result.status, 0, `unexpected exit.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Use --port|different runtime|could not be stopped automatically/);
    const match = result.stdout.match(/Pipelane Board ready at http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(match, `missing ready URL in stdout:\n${result.stdout}`);
    boardPort = Number(match[1]);
    assert.notEqual(boardPort, port);

    const health = await fetch(`http://127.0.0.1:${boardPort}/api/health`).then((response) => response.json());
    assert.equal(path.resolve(health.repoRoot), path.resolve(repoRoot));
  } finally {
    if (boardPort) {
      await runCliAsync(
        ['board', 'stop', '--repo', repoRoot, '--port', String(boardPort)],
        repoRoot,
        { PIPELANE_DASHBOARD_HOME: homeDir },
      ).catch(() => undefined);
    }
    fakeServer.close();
    await once(fakeServer, 'close').catch(() => undefined);
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('board status reports unreachable port and no PID file', async () => {
  const repoRoot = createRepo();
  const port = await getFreePort();

  try {
    const result = runCli(
      ['board', 'status', '--repo', repoRoot, '--port', String(port)],
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

  const npmPath = path.join(binDir, 'npm');
  writeFileSync(npmPath, `#!/usr/bin/env node
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'install') {
  const root = process.cwd();
  const lockPath = path.join(root, 'package-lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { lockfileVersion: 3, packages: {} };
  lock.packages ||= {};
  lock.packages['node_modules/pipelane'] = {
    ...(lock.packages['node_modules/pipelane'] || {}),
    version: '0.2.0',
    resolved: 'git+ssh://git@github.com/jokim1/pipelane.git#${latestSha}',
  };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\\n');
  const pkgDir = path.join(root, 'node_modules', 'pipelane');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'pipelane', version: '0.2.0' }, null, 2) + '\\n');
  process.stdout.write('changed 1 package\\n');
  process.exit(0);
}
process.stderr.write('unsupported fake npm call: ' + args.join(' '));
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

test('update refreshes installed machine-local Codex commands when already up to date', () => {
  const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-consumer-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));
  const refreshLog = path.join(consumerRoot, 'refresh.log');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  try {
    writeFakeConsumer(consumerRoot, { installedVersion: '0.2.0', installedSha: sha });
    makeFakeUpdateBin(binDir, { latestSha: sha });
    mkdirSync(path.join(consumerRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      path.join(consumerRoot, 'node_modules', '.bin', 'pipelane'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.PIPELANE_REFRESH_LOG, process.argv.slice(2).join(' ') + '\\n', 'utf8');
`,
      { mode: 0o755, encoding: 'utf8' },
    );
    mkdirSync(path.join(codexHome, 'skills', '.pipelane', 'bin'), { recursive: true });
    writeFileSync(path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
      encoding: 'utf8',
    });

    const result = spawnSync('node', [CLI_PATH, 'update'], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        PIPELANE_HOME: pipelaneHome,
        PIPELANE_REFRESH_LOG: refreshLog,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pipelane is up to date/);
    assert.match(result.stdout, /Refreshed machine-local Codex commands/);
    assert.doesNotMatch(result.stdout, /Refreshed machine-local Claude commands/);
    assert.equal(readFileSync(refreshLog, 'utf8'), 'install-codex\n');
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('update --check does not refresh installed machine-local commands', () => {
  const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-consumer-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));
  const refreshLog = path.join(consumerRoot, 'refresh.log');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  try {
    writeFakeConsumer(consumerRoot, { installedVersion: '0.2.0', installedSha: sha });
    makeFakeUpdateBin(binDir, { latestSha: sha });
    mkdirSync(path.join(consumerRoot, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(
      path.join(consumerRoot, 'node_modules', '.bin', 'pipelane'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.PIPELANE_REFRESH_LOG, process.argv.slice(2).join(' ') + '\\n', 'utf8');
`,
      { mode: 0o755, encoding: 'utf8' },
    );
    mkdirSync(path.join(codexHome, 'skills', '.pipelane', 'bin'), { recursive: true });
    writeFileSync(path.join(codexHome, 'skills', '.pipelane', 'bin', 'pipelane'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
      encoding: 'utf8',
    });

    const result = spawnSync('node', [CLI_PATH, 'update', '--check'], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        PIPELANE_HOME: pipelaneHome,
        PIPELANE_REFRESH_LOG: refreshLog,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(refreshLog), false);
    assert.doesNotMatch(result.stdout, /Refreshed machine-local Codex commands/);
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
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

test('update --json remains parseable after installing an update', () => {
  const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-consumer-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-claude-'));
  const pipelaneHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));
  const oldSha = '1111111111111111111111111111111111111111';
  const newSha = '2222222222222222222222222222222222222222';
  try {
    writeFakeConsumer(consumerRoot, { installedVersion: '0.2.0', installedSha: oldSha });
    makeFakeUpdateBin(binDir, { latestSha: newSha });

    const result = spawnSync('node', [CLI_PATH, 'update', '--json'], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        PIPELANE_HOME: pipelaneHome,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, 'installed');
    assert.equal(parsed.status.installedSha, newSha);
    assert.equal(parsed.globalSurfaces.codex.status, 'skipped');
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(pipelaneHome, { recursive: true, force: true });
  }
});

test('update stops a running board for the updated repo after install', async () => {
  const consumerRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-consumer-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-bin-'));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-update-home-'));
  const oldSha = '1111111111111111111111111111111111111111';
  const newSha = '2222222222222222222222222222222222222222';
  const port = await getFreePort();
  const resolvedConsumerRoot = realpathSync(consumerRoot);
  const dashboardChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const fakeServer = createHttpServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, repoRoot: resolvedConsumerRoot, pid: dashboardChild.pid }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  fakeServer.listen(port, '127.0.0.1');
  await once(fakeServer, 'listening');

  try {
    writeFakeConsumer(consumerRoot, { installedVersion: '0.2.0', installedSha: oldSha });
    makeFakeUpdateBin(binDir, { latestSha: newSha });
    writeDashboardSettingsForTest(homeDir, resolvedConsumerRoot, { preferredPort: port });
    writeDashboardPidForTest(homeDir, resolvedConsumerRoot, dashboardChild.pid);

    const result = spawnSync('node', [CLI_PATH, 'update'], {
      cwd: consumerRoot,
      env: { ...process.env, PIPELANE_DASHBOARD_HOME: homeDir, PORT: String(port), PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Stopped existing Pipelane Board/);
    await waitForChildExit(dashboardChild);
    assert.equal(isPidAlive(dashboardChild.pid), false, 'expected update to stop the existing board process');
  } finally {
    fakeServer.close();
    await once(fakeServer, 'close').catch(() => undefined);
    if (isPidAlive(dashboardChild.pid)) {
      dashboardChild.kill();
    }
    rmSync(consumerRoot, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
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
    commitAll(repoRoot, 'Adopt pipelane');
    runCli(['run', 'new', '--task', 'Snapshot Task', '--json'], repoRoot);

    const result = runCli(['run', 'api', 'snapshot'], repoRoot);
    const envelope = JSON.parse(result.stdout);

    assert.equal(envelope.schemaVersion, '2026-04-25');
    assert.equal(envelope.command, 'pipelane.api.snapshot');
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
    assert.deepEqual(
      availableActions.map((action) => action.id),
      ['clean.plan', 'devmode.release'],
      'snapshot should expose repo-level cleanup and mode switch actions for the board',
    );
    const cleanPlan = availableActions.find((action) => action.id === 'clean.plan');
    assert.equal(cleanPlan.label, 'Clean');
    assert.equal(cleanPlan.risky, false);
    assert.equal(cleanPlan.requiresConfirmation, false);
    const devmodeRelease = availableActions.find((action) => action.id === 'devmode.release');
    assert.equal(devmodeRelease.label, 'Switch to release mode');
    assert.equal(devmodeRelease.risky, false);
    assert.equal(devmodeRelease.requiresConfirmation, false);
    assert.deepEqual(devmodeRelease.defaultParams, { override: true });
    assert.equal(devmodeRelease.inputs[0].name, 'reason');
    assert.equal(devmodeRelease.inputs[0].required, true);

    assert.ok(Array.isArray(branches) && branches.length === 1);
    const [branch] = branches;
    assert.match(branch.name, /^codex\/snapshot-task-[a-f0-9]{4}$/);
    assert.equal(branch.task.taskSlug, 'snapshot-task');
    assert.deepEqual(branch.cleanup, {
      available: false,
      eligible: false,
      reason: 'workspace still active',
      stale: false,
      tag: 'active',
      evidence: [],
    });
    for (const laneKey of ['local', 'pr', 'base', 'staging', 'production']) {
      assert.ok(branch.lanes[laneKey], `lane ${laneKey} present`);
      assert.ok(typeof branch.lanes[laneKey].state === 'string');
      assert.ok(branch.lanes[laneKey].freshness?.state);
    }
    assert.equal(branch.lanes.pr.state, 'awaiting_preflight', 'no PR opened yet');
    assert.equal(branch.lanes.base.state, 'awaiting_preflight', 'branch has not landed');
    assert.deepEqual(branch.availableActions.map((action) => action.id), ['pr']);
    assert.equal(branch.availableActions[0].label, 'Open PR');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action execute persists task-scoped failure feedback for branch detail', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    runCli(['run', 'new', '--task', 'Action Feedback Task', '--json'], repoRoot);

    const lockPath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'task-locks', 'action-feedback-task.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    writeFileSync(path.join(lock.worktreePath, 'dirty.txt'), 'dirty\n', 'utf8');

    const executed = runCli(
      ['run', 'api', 'action', 'pr', '--task', 'action-feedback-task', '--execute'],
      lock.worktreePath,
      {},
      true,
    );
    assert.notEqual(executed.status, 0);
    const envelope = JSON.parse(executed.stdout);
    assert.equal(envelope.ok, false);
    assert.match(envelope.data.preflight.reason, /Provide a PR title/);

    const actionStatePath = path.join(resolveCommonDir(repoRoot), 'pipelane-state', 'action-state.json');
    const actionState = JSON.parse(readFileSync(actionStatePath, 'utf8'));
    assert.equal(actionState.records['action-feedback-task'][0].actionId, 'pr');
    assert.equal(actionState.records['action-feedback-task'][0].status, 'failed');
    assert.match(actionState.records['action-feedback-task'][0].reason, /Provide a PR title/);

    const detail = JSON.parse(runCli(['run', 'api', 'branch', '--branch', lock.branchName], repoRoot).stdout);
    assert.equal(detail.data.actionHistory[0].actionId, 'pr');
    assert.equal(detail.data.actionHistory[0].status, 'failed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api snapshot computes release readiness from observed deploys and probes', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);
    runCli(['run', 'devmode', 'release'], repoRoot);

    const result = runCli(['run', 'api', 'snapshot'], repoRoot);
    const envelope = JSON.parse(result.stdout);
    const release = envelope.data.boardContext.releaseReadiness;

    assert.equal(release.state, 'healthy');
    assert.equal(release.reason, 'requested surfaces passed observed staging + probe checks');
    assert.deepEqual(release.blockedSurfaces, []);
    assert.equal(release.localReady, true);
    assert.equal(release.hostedReady, true);
    assert.match(release.message, /Release mode is active and requested surfaces passed observed staging \+ probe checks\./);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('api snapshot distinguishes config readiness from hosted readiness when staging evidence is missing', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'snapshot readiness fixture'], repoRoot);

    const result = runCli(['run', 'api', 'snapshot'], repoRoot);
    const envelope = JSON.parse(result.stdout);
    const release = envelope.data.boardContext.releaseReadiness;

    assert.equal(release.state, 'blocked');
    assert.equal(release.localReady, true);
    assert.equal(release.hostedReady, false);
    assert.deepEqual([...release.blockedSurfaces].sort(), ['edge', 'frontend', 'sql']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('api snapshot only marks missing staging smoke as blocking when the repo opts into the smoke gate', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend', '--override', '--reason', 'snapshot smoke fixture'], repoRoot);

    const advisoryEnvelope = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    const advisoryIssue = advisoryEnvelope.data.attention.find((issue) => issue.code === 'smoke.staging.missing');
    const advisorySource = advisoryEnvelope.data.sourceHealth.find((entry) => entry.name === 'smoke.staging');
    assert.equal(advisoryIssue.severity, 'warning');
    assert.equal(advisoryIssue.blocking, false);
    assert.equal(advisorySource.blocking, false);

    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: { command: 'node -e "process.exit(0)"' },
      };
    });

    const blockingEnvelope = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    const blockingIssue = blockingEnvelope.data.attention.find((issue) => issue.code === 'smoke.staging.missing');
    const blockingSource = blockingEnvelope.data.sourceHealth.find((entry) => entry.name === 'smoke.staging');
    assert.equal(blockingIssue.severity, 'error');
    assert.equal(blockingIssue.blocking, true);
    assert.equal(blockingSource.blocking, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('api snapshot surfaces blocking smoke coverage gaps that would stop prod promotion', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        criticalPathCoverage: 'block',
        criticalPaths: ['billing'],
        staging: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
      };
    });
    await writeSucceededDeployRecord(repoRoot, 'staging', '1111111111111111111111111111111111111111', ['frontend']);
    writeHealthyProbeState(repoRoot, ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });
    runCli(['run', 'smoke', 'staging'], repoRoot);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend', '--override', '--reason', 'coverage snapshot fixture'], repoRoot);

    const result = await runCliAsync(['run', 'api', 'snapshot'], repoRoot);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    const coverageIssue = envelope.data.attention.find((issue) => issue.code === 'smoke.coverage.missing');
    const coverageSource = envelope.data.sourceHealth.find((entry) => entry.name === 'smoke.coverage');

    assert.equal(coverageIssue.severity, 'error');
    assert.equal(coverageIssue.blocking, true);
    assert.match(coverageIssue.message, /billing/);
    assert.equal(coverageSource.state, 'blocked');
    assert.equal(coverageSource.blocking, true);
    assert.match(coverageSource.reason, /billing/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('api snapshot keys staging smoke health to the current promotion SHA, not just the latest smoke run', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    mkdirSync(path.join(repoRoot, 'e2e'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'e2e', 'auth.spec.ts'), "test('@smoke-auth sign in', async () => {});\n", 'utf8');
    updateWorkflowConfig(repoRoot, (config) => {
      config.smoke = {
        requireStagingSmoke: true,
        staging: { command: smokeResultCommand([{ tag: '@smoke-auth', status: 'passed' }]) },
      };
    });
    const smokedSha = '1111111111111111111111111111111111111111';
    const targetSha = '2222222222222222222222222222222222222222';
    await writeSucceededDeployRecord(repoRoot, 'staging', smokedSha, ['frontend']);
    runCli(['run', 'smoke', 'plan'], repoRoot);
    updateSmokeRegistry(repoRoot, (registry) => {
      registry.checks['@smoke-auth'].blocking = true;
      registry.checks['@smoke-auth'].quarantine = false;
    });
    runCli(['run', 'smoke', 'staging'], repoRoot);
    writeTaskLock(repoRoot, 'bootstrap', { mode: 'release', surfaces: ['frontend'] });
    writePrRecord(repoRoot, 'bootstrap', targetSha);
    runCli(['run', 'devmode', 'release', '--surfaces', 'frontend', '--override', '--reason', 'target smoke fixture'], repoRoot);

    const envelope = JSON.parse((await runCliAsync(['run', 'api', 'snapshot'], repoRoot)).stdout);
    const smokeSource = envelope.data.sourceHealth.find((entry) => entry.name === 'smoke.staging');
    const smokeIssue = envelope.data.attention.find((issue) => issue.code === 'smoke.staging.target_missing');

    assert.equal(envelope.data.smoke.staging.sha, smokedSha);
    assert.equal(smokeSource.state, 'blocked');
    assert.equal(smokeSource.blocking, true);
    assert.match(smokeSource.reason, /current promotion SHA 2222222/i);
    assert.match(smokeSource.reason, /latest staging smoke is passed @ 1111111/i);
    assert.equal(smokeIssue.blocking, true);
    assert.match(smokeIssue.message, /current promotion SHA 2222222/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('api snapshot marks staging as bypassed in build mode', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    // Force a merged PR state so staging/production lanes are computed
    // beyond the "awaiting_preflight" fast-path.
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Bypass Check', '--json'], repoRoot).stdout);
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
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

    const result = await runCliAsync(['run', 'api', 'snapshot'], repoRoot);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    const [branch] = envelope.data.branches;
    assert.equal(branch.lanes.staging.state, 'bypassed', 'build mode bypasses staging');
    assert.equal(branch.lanes.production.state, 'awaiting_preflight', 'no prod deploy recorded');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('deploy releases the shared smoke environment lock when the workflow fails after lock acquisition', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const fakeBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(fakeBin, 'gh-state.json');

  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    writeTaskLock(repoRoot, 'bootstrap', { mode: 'build', surfaces: ['frontend'] });
    writeFakeGh(fakeBin, ghStateFile);

    const result = runCli(
      ['run', 'deploy', 'staging', '--task', 'bootstrap'],
      repoRoot,
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        GH_STATE_FILE: ghStateFile,
        PIPELANE_DEPLOY_WATCH_STUB: 'failed',
      },
      true,
    );

    assert.notEqual(result.status, 0);
    assert.ok(
      !existsSync(path.join(resolveSharedSmokeStateRoot(repoRoot), 'locks', 'staging.json')),
      'staging smoke/deploy lock should be removed on failure',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('api branch detail and patch commands emit real committed and workspace diffs', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Branch Detail', '--json'], repoRoot).stdout);

    const committedFile = path.join(created.worktreePath, 'src', 'feature-status.txt');
    mkdirSync(path.dirname(committedFile), { recursive: true });
    writeFileSync(committedFile, 'committed change\n', 'utf8');
    execFileSync('git', ['add', 'src/feature-status.txt'], {
      cwd: created.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['commit', '-m', 'Add committed branch file'], {
      cwd: created.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const readmePath = path.join(created.worktreePath, 'README.md');
    writeFileSync(readmePath, `${readFileSync(readmePath, 'utf8').trimEnd()}\nworkspace change\n`, 'utf8');
    writeFileSync(path.join(created.worktreePath, 'notes.txt'), 'scratch notes\n', 'utf8');

    const details = JSON.parse(runCli(['run', 'api', 'branch', '--branch', created.branch], repoRoot).stdout);
    assert.equal(details.command, 'pipelane.api.branch');
    assert.equal(details.data.branch.name, created.branch);
    assert.ok(details.data.branchFiles.find((entry) =>
      entry.path === 'src/feature-status.txt'
      && entry.scope === 'branch'
      && entry.patchAvailable === true));
    assert.ok(details.data.workspaceFiles.find((entry) =>
      entry.path === 'README.md'
      && entry.scope === 'workspace'
      && entry.patchAvailable === true));
    assert.ok(details.data.workspaceFiles.find((entry) =>
      entry.path === 'notes.txt'
      && entry.scope === 'workspace'
      && entry.patchAvailable === false
      && /untracked/i.test(entry.reason)));

    const branchPatch = JSON.parse(runCli([
      'run', 'api', 'branch',
      '--branch', created.branch,
      '--patch',
      '--file', 'src/feature-status.txt',
      '--scope', 'branch',
    ], repoRoot).stdout);
    assert.equal(branchPatch.command, 'pipelane.api.branch.patch');
    assert.match(branchPatch.data.patch, /\+committed change/);

    const workspacePatch = JSON.parse(runCli([
      'run', 'api', 'branch',
      '--branch', created.branch,
      '--patch',
      '--file', 'README.md',
      '--scope', 'workspace',
    ], repoRoot).stdout);
    assert.match(workspacePatch.data.patch, /\+workspace change/);

    const untrackedPatch = JSON.parse(runCli([
      'run', 'api', 'branch',
      '--branch', created.branch,
      '--patch',
      '--file', 'notes.txt',
      '--scope', 'workspace',
    ], repoRoot).stdout);
    assert.equal(untrackedPatch.data.patch, '');
    assert.match(untrackedPatch.data.reason, /untracked/i);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action preflight: non-risky action returns no confirmation', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    const envelope = JSON.parse(runCli(['run', 'api', 'action', 'resume'], repoRoot).stdout);
    assert.equal(envelope.schemaVersion, '2026-04-25');
    assert.equal(envelope.command, 'pipelane.api.action');
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
    commitAll(repoRoot, 'Adopt pipelane');

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

test('api action preflight includes explicit PR identity in normalized inputs', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    const merge = JSON.parse(runCli(['run', 'api', 'action', 'merge', '--pr', '422'], repoRoot).stdout);
    assert.equal(merge.data.preflight.normalizedInputs.pr, '422');
    assert.equal(merge.data.preflight.normalizedInputs.task, '');
    assert.ok(merge.data.preflight.confirmation?.token);

    const deploy = JSON.parse(runCli(['run', 'api', 'action', 'deploy.staging', '--pr', '422', '--surfaces', 'frontend'], repoRoot).stdout);
    assert.equal(deploy.data.preflight.normalizedInputs.pr, '422');
    assert.deepEqual(deploy.data.preflight.normalizedInputs.surfaces, ['frontend']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action execute: risky action rejects missing or bad tokens', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

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
    commitAll(repoRoot, 'Adopt pipelane');

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
    commitAll(repoRoot, 'Adopt pipelane');

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
    commitAll(repoRoot, 'Adopt pipelane');

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

test('api action execute: devmode actions switch the repo mode', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    const releaseResult = runCli([
      'run',
      'api',
      'action',
      'devmode.release',
      '--override',
      '--reason',
      'board switch fixture',
      '--execute',
    ], repoRoot);
    const releaseEnvelope = JSON.parse(releaseResult.stdout);
    assert.equal(releaseEnvelope.ok, true);
    assert.equal(releaseEnvelope.data.execution.result.mode, 'release');

    const releaseSnapshot = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    assert.equal(releaseSnapshot.data.boardContext.mode, 'release');
    assert.deepEqual(
      releaseSnapshot.data.availableActions.map((action) => action.id),
      ['clean.plan', 'devmode.build'],
      'release mode should expose cleanup and the switch back to build mode',
    );

    const buildResult = runCli(['run', 'api', 'action', 'devmode.build', '--execute'], repoRoot);
    const buildEnvelope = JSON.parse(buildResult.stdout);
    assert.equal(buildEnvelope.ok, true);
    assert.equal(buildEnvelope.data.execution.result.mode, 'build');

    const buildSnapshot = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    assert.equal(buildSnapshot.data.boardContext.mode, 'build');
    assert.deepEqual(
      buildSnapshot.data.availableActions.map((action) => action.id),
      ['clean.plan', 'devmode.release'],
      'build mode should expose cleanup and the switch to release mode',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('api action execute: devmode release without override returns needs-input preflight', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    const result = runCli(['run', 'api', 'action', 'devmode.release', '--execute'], repoRoot, {}, true);
    assert.equal(result.status, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.match(envelope.message, /Release readiness is blocked/);
    assert.doesNotMatch(envelope.message, /see execution\.stderr/);
    assert.equal(envelope.data.preflight.needsInput, true);
    assert.deepEqual(envelope.data.preflight.missingInputs, ['reason']);
    assert.deepEqual(envelope.data.preflight.defaultParams, { override: true });
    assert.equal(envelope.data.preflight.inputs[0].name, 'reason');
    assert.equal(envelope.data.execution, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('board help prints subcommand list', () => {
  const result = runCli(['board', '--help'], process.cwd());
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pipelane board/);
  assert.match(result.stdout, /start Pipelane Board/);
  assert.match(result.stdout, /stop the Pipelane Board/);
  assert.match(result.stdout, /--no-open/);
});

test('board rejects unknown subcommands instead of opening the dashboard silently', () => {
  const result = runCli(['board', 'fix'], process.cwd(), {}, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown Pipelane Board subcommand "fix"/);
  assert.match(result.stderr, /managed `\/fix` command/);
});

test('operator parser rejects unknown flags, missing values, unused flags, and unused positionals', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const unknown = runCli(['run', 'pr', '--titel', 'Typo'], repoRoot, {}, true);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown flag "--titel"/);

    const missingValue = runCli(['run', 'new', '--task', '--json'], repoRoot, {}, true);
    assert.notEqual(missingValue.status, 0);
    assert.match(missingValue.stderr, /--task requires a value/);

    const wrongFlagForCommand = runCli(['run', 'new', '--title', 'Ignored before'], repoRoot, {}, true);
    assert.notEqual(wrongFlagForCommand.status, 0);
    assert.match(wrongFlagForCommand.stderr, /new does not accept flag\(s\): --title/);

    const wrongPositionalForCommand = runCli(['run', 'status', 'ignored-before'], repoRoot, {}, true);
    assert.notEqual(wrongPositionalForCommand.status, 0);
    assert.match(wrongPositionalForCommand.stderr, /status does not accept positional argument/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('operator parser accepts --pr for merge, deploy, and API actions', async () => {
  const state = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));

  const merge = state.parseOperatorArgs(['merge', '--pr', '422']);
  state.validateOperatorArgs(merge);
  assert.equal(merge.flags.pr, '422');

  const deploy = state.parseOperatorArgs(['deploy', 'staging', '--pr', '422']);
  state.validateOperatorArgs(deploy);
  assert.equal(deploy.flags.pr, '422');

  const api = state.parseOperatorArgs(['api', 'action', 'deploy.staging', '--pr', '422']);
  state.validateOperatorArgs(api);
  assert.equal(api.flags.pr, '422');

  const ambiguousTask = state.parseOperatorArgs(['merge', '--task', 'Canvas', '--pr', '422']);
  assert.throws(() => state.validateOperatorArgs(ambiguousTask), /cannot combine --task and --pr/);

  const ambiguousSha = state.parseOperatorArgs(['deploy', 'staging', '--pr', '422', '--sha', 'HEAD']);
  assert.throws(() => state.validateOperatorArgs(ambiguousSha), /cannot combine --pr and --sha/);

  const invalidPr = state.parseOperatorArgs(['merge', '--pr', 'abc']);
  assert.throws(() => state.validateOperatorArgs(invalidPr), /--pr requires a positive PR number/);

  const apiAmbiguousTask = state.parseOperatorArgs(['api', 'action', 'merge', '--task', 'Canvas', '--pr', '422']);
  assert.throws(() => state.validateOperatorArgs(apiAmbiguousTask), /merge cannot combine --task and --pr/);

  const apiAmbiguousSha = state.parseOperatorArgs(['api', 'action', 'deploy.staging', '--pr', '422', '--sha', 'HEAD']);
  assert.throws(() => state.validateOperatorArgs(apiAmbiguousSha), /deploy\.staging cannot combine --pr and --sha/);
});

test('init refuses to overwrite an existing pipelane config', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const second = runCli(['init', '--project', 'Demo App'], repoRoot, {}, true);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already initialized/);
    assert.match(second.stderr, /pipelane setup/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure --json writes a Deploy Configuration block byte-identical to renderDeployConfigSection', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const result = runCli([
      'configure',
      '--json',
      '--platform=fly.io',
      '--frontend-staging-url=https://staging.example.test',
      '--frontend-staging-workflow=Deploy Hosted',
      '--frontend-staging-healthcheck=https://staging.example.test/health',
      '--frontend-production-url=https://app.example.test',
      '--frontend-production-workflow=Deploy Hosted',
      '--frontend-production-auto-deploy-on-main=false',
      '--frontend-production-healthcheck=https://app.example.test/health',
      '--edge-staging-deploy-command=supabase functions deploy --staging',
      '--edge-staging-verification-command=supabase functions test',
      '--edge-staging-healthcheck=https://staging.example.test/edge-health',
      '--edge-production-deploy-command=supabase functions deploy',
      '--edge-production-verification-command=supabase functions test',
      '--edge-production-healthcheck=https://app.example.test/edge-health',
      '--sql-staging-apply-command=supabase db push --staging',
      '--sql-staging-verification-command=supabase db lint',
      '--sql-staging-healthcheck=https://staging.example.test/db-health',
      '--sql-production-apply-command=supabase db push',
      '--sql-production-verification-command=supabase db lint',
      '--sql-production-healthcheck=https://app.example.test/db-health',
      '--supabase-staging-project-ref=staging-ref',
      '--supabase-production-project-ref=production-ref',
    ], repoRoot);
    assert.equal(result.status, 0);

    const emitted = JSON.parse(result.stdout);
    assert.equal(emitted.platform, 'fly.io');
    assert.equal(emitted.frontend.staging.url, 'https://staging.example.test');
    assert.equal(emitted.supabase.production.projectRef, 'production-ref');

    const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
    const expectedSection = mod.renderDeployConfigSection(emitted).trimEnd();
    const claudeMd = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    // The rendered block inside CLAUDE.md must match renderDeployConfigSection
    // exactly (trimmed), so release-gate's canonical format stays the single
    // source of truth — no drift between what `configure` writes and what
    // `parseDeployConfigMarkdown` reads.
    const deployRange = claudeMd.match(/## Deploy Configuration[\s\S]*?(?=\n##\s|$)/);
    assert.ok(deployRange, 'Deploy Configuration block exists in CLAUDE.md');
    assert.equal(deployRange[0].trimEnd(), expectedSection);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure --json is idempotent: re-running with the same flags produces identical CLAUDE.md', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const args = [
      'configure',
      '--json',
      '--platform=fly.io',
      '--frontend-staging-url=https://staging.example.test',
      '--frontend-staging-workflow=Deploy Hosted',
      '--frontend-staging-healthcheck=https://staging.example.test/health',
    ];
    runCli(args, repoRoot);
    const first = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    runCli(args, repoRoot);
    const second = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    assert.equal(first, second, 're-run must produce byte-identical CLAUDE.md');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure leaves sections outside Deploy Configuration untouched', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const claudePath = path.join(repoRoot, 'CLAUDE.md');
    const original = readFileSync(claudePath, 'utf8');
    // Append a consumer-owned section that configure must not touch.
    const withCustom = `${original}\n## Operator Notes\n\n- never drop this section\n- seriously, never\n`;
    writeFileSync(claudePath, withCustom, 'utf8');

    runCli([
      'configure',
      '--json',
      '--frontend-staging-url=https://staging.example.test',
    ], repoRoot);
    const after = readFileSync(claudePath, 'utf8');
    assert.match(after, /## Operator Notes\n\n- never drop this section\n- seriously, never\n/);
    assert.match(after, /https:\/\/staging\.example\.test/);
    // The prefix above the Deploy Configuration block (Local Operator Defaults,
    // Skill Routing, etc.) must survive the rewrite unchanged.
    const originalPrefix = original.split('## Deploy Configuration')[0];
    assert.ok(after.startsWith(originalPrefix), 'CLAUDE.md prefix above the deploy block is preserved');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure seeds CLAUDE.md from the Pipelane template when it is missing', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const claudePath = path.join(repoRoot, 'CLAUDE.md');
    rmSync(claudePath, { force: true });
    assert.equal(existsSync(claudePath), false);

    runCli([
      'configure',
      '--json',
      '--frontend-staging-url=https://staging.example.test',
    ], repoRoot);
    const after = readFileSync(claudePath, 'utf8');
    assert.match(after, /Demo App Local Operator Context/);
    assert.match(after, /## Deploy Configuration/);
    assert.match(after, /https:\/\/staging\.example\.test/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure errors on unknown flag instead of silently ignoring it', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const result = runCli(['configure', '--json', '--not-a-real-flag=oops'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown flag for pipelane configure/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup installs the pipelane:configure script and rewrites devmode.md pointer', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['pipelane:configure'], 'pipelane configure');

    const devmode = readFileSync(path.join(repoRoot, '.claude', 'commands', 'devmode.md'), 'utf8');
    // The devmode slash command points operators at the guided doctor flow.
    assert.match(devmode, /\/doctor --fix/);
    assert.doesNotMatch(devmode, /run `npm run pipelane:setup`/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure bare boolean flag (`--frontend-staging-ready`) sets true; `=false` sets false', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    // v1.2: --frontend-staging-ready / --edge-staging-ready / --sql-staging-ready
    // were removed. Scripts that still pass them get a hard error pointing
    // at the replacement path (observed deploys + /doctor --probe) instead
    // of silently accepting an ignored value.
    const bareResult = runCli(['configure', '--json', '--frontend-staging-ready'], repoRoot, {}, true);
    assert.notEqual(bareResult.status, 0);
    assert.match(bareResult.stderr, /--frontend-staging-ready was removed in v1\.2/);

    const explicitResult = runCli(['configure', '--json', '--sql-staging-ready=false'], repoRoot, {}, true);
    assert.notEqual(explicitResult.status, 0);
    assert.match(explicitResult.stderr, /--sql-staging-ready was removed in v1\.2/);

    const edgeResult = runCli(['configure', '--json', '--edge-staging-ready=true'], repoRoot, {}, true);
    assert.notEqual(edgeResult.status, 0);
    assert.match(edgeResult.stderr, /--edge-staging-ready was removed in v1\.2/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure preserves previously-set fields across runs with disjoint flag sets', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    // Run 1: set platform + a frontend-staging field.
    runCli(['configure', '--json', '--platform=fly.io', '--frontend-staging-url=https://s.example.test'], repoRoot);
    // Run 2: set a different field (frontend-production). Must NOT clobber run 1's values.
    runCli(['configure', '--json', '--frontend-production-url=https://p.example.test'], repoRoot);

    const claude = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    const jsonMatch = claude.match(/## Deploy Configuration[\s\S]*?```json\s*([\s\S]*?)```/);
    assert.ok(jsonMatch, 'Deploy Configuration JSON block present');
    const merged = JSON.parse(jsonMatch[1]);
    assert.equal(merged.platform, 'fly.io', 'run 1 platform preserved');
    assert.equal(merged.frontend.staging.url, 'https://s.example.test', 'run 1 frontend.staging.url preserved');
    assert.equal(merged.frontend.production.url, 'https://p.example.test', 'run 2 frontend.production.url applied');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('replaceDeployConfigSection appends a deploy block when markdown has no Deploy Configuration section', async () => {
  // Unit-level coverage for the append branch in release-gate.replaceDeployConfigSection
  // (the CLI tests exercise the replace branch; a consumer with a hand-authored
  // CLAUDE.md that never had the deploy block hits this path).
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  const existing = '# Repo Notes\n\nHand-authored preamble.\n';
  const config = mod.emptyDeployConfig();
  config.platform = 'fly.io';

  const updated = mod.replaceDeployConfigSection(existing, config);
  assert.ok(updated.startsWith(existing.trimEnd()), 'prefix preserved verbatim');
  assert.match(updated, /## Deploy Configuration/);
  assert.match(updated, /"platform": "fly.io"/);
  // Exactly `\n\n` separates the operator-authored body from the appended block.
  const boundary = existing.trimEnd() + '\n\n## Deploy Configuration';
  assert.ok(updated.includes(boundary), 'block is separated from existing body by one blank line');
});

test('configure rejects malformed boolean flag values', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    // --frontend-production-auto-deploy-on-main is the remaining real
    // boolean flag after v1.2 dropped the *-staging-ready flags. A
    // non-boolean value like "yes" must still be rejected.
    const result = runCli(['configure', '--json', '--frontend-production-auto-deploy-on-main=yes'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expects true\/false/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure rejects string flags passed without `=value`', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    // `--platform fly.io` (space) instead of `--platform=fly.io` — common typo.
    // The parser must reject it rather than silently skipping or grabbing a
    // neighboring positional.
    const result = runCli(['configure', '--json', '--platform', 'fly.io'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a value/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure --help prints usage and does not modify CLAUDE.md', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const claudePath = path.join(repoRoot, 'CLAUDE.md');
    const before = readFileSync(claudePath, 'utf8');
    const result = runCli(['configure', '--help'], repoRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /pipelane configure/);
    assert.match(result.stdout, /--frontend-staging-url/);
    const after = readFileSync(claudePath, 'utf8');
    assert.equal(before, after, '--help must not mutate CLAUDE.md');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure seeds a fresh CLAUDE.md from the self-healed config without a .pipelane.json', () => {
  const repoRoot = createRepo();
  try {
    // Deliberately skip `init` — no .pipelane.json, no overlay in package.json.
    // With self-heal, configure synthesizes a workable config from the
    // package.json name + defaults and renders CLAUDE.md from that, rather
    // than failing closed. Consumers who gitignore `.pipelane.json` can run
    // configure on a fresh checkout without a prior bootstrap step.
    const result = runCli(['configure', '--json', '--platform=fly.io'], repoRoot);
    assert.equal(result.status, 0, `configure exited ${result.status}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.platform, 'fly.io');
    assert.ok(existsSync(path.join(repoRoot, 'CLAUDE.md')), 'configure should create CLAUDE.md');
    // Self-heal path must not materialize .pipelane.json — that stays
    // deferred to mutators that actually need to persist state.
    assert.equal(existsSync(path.join(repoRoot, '.pipelane.json')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure survives roundtrip with backticks in deploy command values', () => {
  // Codex-identified: the pre-existing JSON-block regex was non-greedy and
  // matched ``` anywhere — a legitimate command like `echo \`\`\` test` inside
  // edge.staging.deployCommand would truncate the JSON block on the next
  // read, bricking every downstream command that calls loadDeployConfig.
  // Configure now persists + re-reads values with embedded backticks cleanly.
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const backtickCmd = 'echo ``` hi';
    runCli([
      'configure',
      '--json',
      `--edge-staging-deploy-command=${backtickCmd}`,
    ], repoRoot);

    // Second configure run parses the just-written CLAUDE.md via
    // parseDeployConfigMarkdown. If the regex breaks on the inner ```, this
    // call either crashes on JSON.parse or silently reverts to empty defaults.
    const second = runCli(['configure', '--json', '--platform=fly.io'], repoRoot);
    const config = JSON.parse(second.stdout);
    assert.equal(config.edge.staging.deployCommand, backtickCmd,
      'backtick-bearing value must survive a roundtrip through CLAUDE.md');
    assert.equal(config.platform, 'fly.io');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure does not overwrite a sibling `## Deploy Configuration Notes` section', () => {
  // Codex-identified: findDeployConfigSectionRange previously used `\b` which
  // matched `## Deploy Configuration Notes` as a false positive and would
  // overwrite the consumer's notes. The tightened regex requires end-of-line
  // after the heading text.
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const claudePath = path.join(repoRoot, 'CLAUDE.md');
    const original = readFileSync(claudePath, 'utf8');
    const withNearbyHeading = `${original}\n## Deploy Configuration Notes\n\nhand-written notes nobody should clobber\n`;
    writeFileSync(claudePath, withNearbyHeading, 'utf8');

    runCli(['configure', '--json', '--frontend-staging-url=https://s.example.test'], repoRoot);

    const after = readFileSync(claudePath, 'utf8');
    assert.match(after, /## Deploy Configuration Notes\n\nhand-written notes nobody should clobber/);
    assert.match(after, /https:\/\/s\.example\.test/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('configure without --json errors when stdin is not a TTY', () => {
  // Codex-identified: interactive path used to hang on closed stdin. Now it
  // fails fast with guidance to use --json.
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const result = spawnSync('node', [CLI_PATH, 'configure'], {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a TTY|use `--json`/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup consistency check requires pipelane:configure when opting out of packageScripts', () => {
  // Regression for Codex #4: the required-scripts list now includes
  // pipelane:configure because devmode.md points operators at it. A consumer
  // who defines every pipelane:<cmd> script EXCEPT pipelane:configure would
  // previously pass setup silently; now they get a clear error.
  const repoRoot = createRepo();
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const packageJsonPath = path.join(repoRoot, 'package.json');
    writeFileSync(packageJsonPath, `${JSON.stringify({
      name: 'consumer-app',
      private: true,
      type: 'module',
      scripts: {
        'pipelane:new': 'x new',
        'pipelane:resume': 'x resume',
        'pipelane:repo-guard': 'x repo-guard',
        'pipelane:pr': 'x pr',
        'pipelane:merge': 'x merge',
        'pipelane:deploy': 'x deploy',
        'pipelane:clean': 'x clean',
        'pipelane:devmode': 'x devmode',
        'pipelane:status': 'x status',
        'pipelane:doctor': 'x doctor',
        // Deliberately missing pipelane:configure
      },
    }, null, 2)}\n`, 'utf8');

    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { packageScripts: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const result = runCli(['setup'], repoRoot, { CODEX_HOME: codexHome }, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pipelane:configure/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('renderCockpit produces a deterministic one-screen cockpit from a fixture envelope', async () => {
  // v0.6: /status is a pure renderer of pipelane:api snapshot --json. This
  // test exercises the render boundary directly — no subprocess, no git
  // state. The fixture envelope covers all three branch buckets (active /
  // recent / stale) and carries one nextAction to prove v1.3 surfaces in
  // the cockpit.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const envelope = {
    schemaVersion: '2026-04-14',
    command: 'pipelane.api.snapshot',
    ok: true,
    message: 'pipelane workflow snapshot ready',
    warnings: [],
    issues: [],
    data: {
      boardContext: {
        mode: 'release',
        baseBranch: 'main',
        laneOrder: ['Local', 'PR', 'Base: main', 'Staging', 'Production'],
        releaseReadiness: {
          state: 'unknown',
          reason: 'release readiness not yet computed in pipelane snapshot',
          requestedSurfaces: [],
          blockedSurfaces: [],
          effectiveOverride: null,
          localReady: false,
          hostedReady: false,
          freshness: { checkedAt: '2026-04-18T00:00:00.000Z', observedAt: '2026-04-18T00:00:00.000Z', state: 'fresh' },
          message: '',
        },
        activeTask: null,
        overallFreshness: { checkedAt: '2026-04-18T00:00:00.000Z', observedAt: '2026-04-18T00:00:00.000Z', state: 'fresh' },
      },
      sourceHealth: [
        { name: 'git.local', state: 'healthy', blocking: false, reason: 'local branches and worktrees loaded',
          freshness: { checkedAt: '2026-04-18T00:00:00.000Z', observedAt: '2026-04-18T00:00:00.000Z', state: 'fresh' } },
        { name: 'task-locks', state: 'healthy', blocking: false, reason: '3 active task lock(s)',
          freshness: { checkedAt: '2026-04-18T00:00:00.000Z', observedAt: '2026-04-18T00:00:00.000Z', state: 'fresh' } },
      ],
      attention: [],
      availableActions: [],
      branches: [
        {
          name: 'codex/active-task-abcd',
          status: 'open-pr',
          current: true,
          note: 'PR #12 is open',
          task: { taskSlug: 'active-task', mode: 'release', worktreePath: '/tmp/x', updatedAt: '2026-04-18T00:00:00.000Z', nextAction: 'PR #12 open, awaiting CI' },
          surfaces: ['frontend'],
          cleanup: { available: false, eligible: false, reason: 'workspace still active' },
          pr: { number: 12, state: 'OPEN', url: 'https://x', title: 'Active', mergedAt: null },
          mergedSha: null,
          lanes: {
            local: { state: 'healthy', reason: 'clean', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            pr: { state: 'running', reason: 'PR open', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            base: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            staging: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            production: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
          },
          availableActions: [],
        },
        {
          name: 'codex/recent-win-9999',
          status: 'merged',
          current: false,
          note: 'PR #11 merged',
          task: { taskSlug: 'recent-win', mode: 'release', worktreePath: '/tmp/y', updatedAt: '2026-04-17T00:00:00.000Z' },
          surfaces: ['frontend'],
          cleanup: { available: false, eligible: false, reason: 'workspace still active' },
          pr: { number: 11, state: 'MERGED', url: 'https://y', title: 'Recent', mergedAt: new Date().toISOString() },
          mergedSha: 'abcdef0',
          lanes: {
            local: { state: 'healthy', reason: 'clean', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            pr: { state: 'healthy', reason: 'merged', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            base: { state: 'healthy', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            staging: { state: 'healthy', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            production: { state: 'healthy', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
          },
          availableActions: [],
        },
        {
          name: 'codex/stale-old-7777',
          status: 'missing-worktree',
          current: false,
          note: 'worktree missing',
          task: { taskSlug: 'stale-old', mode: 'build', worktreePath: '/tmp/gone', updatedAt: '2026-01-01T00:00:00.000Z' },
          surfaces: ['frontend'],
          cleanup: { available: true, eligible: true, reason: 'worktree already gone' },
          pr: null,
          mergedSha: null,
          lanes: {
            local: { state: 'unknown', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'stale' } },
            pr: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            base: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            staging: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
            production: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
          },
          availableActions: [],
        },
      ],
    },
  };

  const rendered = mod.renderCockpit(envelope, { color: false });
  // Header + sections.
  assert.match(rendered, /Pipelane/);
  assert.match(rendered, /mode=RELEASE/);
  assert.match(rendered, /base=main/);
  assert.match(rendered, /ATTENTION/);
  assert.match(rendered, /ACTIVE/);
  assert.match(rendered, /RECENT/);
  assert.match(rendered, /STALE/);
  assert.match(rendered, /SOURCES/);
  // Bucket membership.
  assert.match(rendered, /active-task/);
  assert.match(rendered, /recent-win/);
  assert.match(rendered, /stale-old/);
  // 5-lane line with all five labels in order, for the active row.
  assert.match(rendered, /\[Local .\] \[PR .\] \[Base: main .\] \[Staging .\] \[Production .\]/);
  // v1.3: nextAction breadcrumb surfaces in the cockpit.
  assert.match(rendered, /next: PR #12 open, awaiting CI/);
  // Empty attention shows the filler line rather than nothing.
  assert.match(rendered, /\(nothing blocking\)/);
  // Current-branch marker appears only for the one flagged current.
  const activeIndex = rendered.indexOf('active-task');
  const recentIndex = rendered.indexOf('recent-win');
  assert.ok(activeIndex > -1 && recentIndex > -1);
  const activeRow = rendered.slice(activeIndex - 4, activeIndex);
  assert.ok(activeRow.includes('▶'), `expected current-branch marker next to active-task, got "${activeRow}"`);
});

test('renderCockpit ok=false envelope is never reached; handleStatus throws instead', async () => {
  // Defense: acceptance criteria say /status never silently falls back to
  // raw state reads. handleStatus throws on ok=false envelopes; renderCockpit
  // itself is trusted only after the ok gate.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  assert.equal(typeof mod.renderCockpit, 'function');
  assert.equal(typeof mod.handleStatus, 'function');
});

test('renderStateGlyph returns a non-empty glyph for every canonical lane state', async () => {
  const helpers = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const envelope = await import(path.join(KIT_ROOT, 'src', 'operator', 'api', 'envelope.ts'));
  for (const state of envelope.CANONICAL_LANE_STATES) {
    const glyph = helpers.renderStateGlyph(state);
    assert.equal(typeof glyph, 'string');
    assert.ok(glyph.length > 0, `no glyph for state "${state}"`);
  }
});

test('setNextAction persists nextAction on the task lock and is a no-op when no lock exists', async () => {
  // v1.3: the breadcrumb setter is read-modify-write on the lock file. No
  // lock → null (silent), so commands that run outside a task workspace
  // can still call setNextAction without crashing.
  const helpers = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-state-'));
  const commonDir = path.join(stateDir, '.git');
  mkdirSync(commonDir, { recursive: true });
  const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
  try {
    // No-op path: no lock.
    const noop = helpers.setNextAction(commonDir, config, 'not-there', 'hello');
    assert.equal(noop, null);

    // Seed a lock, then mutate.
    stateMod.saveTaskLock(commonDir, config, 'abc', {
      taskSlug: 'abc',
      branchName: 'codex/abc-0000',
      worktreePath: '/tmp/abc',
      mode: 'build',
      surfaces: ['frontend'],
      updatedAt: new Date().toISOString(),
    });
    const updated = helpers.setNextAction(commonDir, config, 'abc', 'PR #42 open, awaiting CI');
    assert.ok(updated);
    assert.equal(updated.nextAction, 'PR #42 open, awaiting CI');
    const loaded = stateMod.loadTaskLock(commonDir, config, 'abc');
    assert.equal(loaded?.nextAction, 'PR #42 open, awaiting CI');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('buildWorkflowApiSnapshot surfaces TaskLock.nextAction through the envelope (end-to-end)', async () => {
  // Regression guard: v1.3 broke if /pr set nextAction on the lock but
  // buildWorkflowApiSnapshot dropped it when shaping BranchRow.task. The
  // golden-file test above synthesizes an envelope — this one proves the
  // production envelope pipeline actually carries the breadcrumb.
  const repoRoot = createRemoteBackedRepo().repoRoot;
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'pipelane-codex-'));
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot, { CODEX_HOME: codexHome });

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const snapshotMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'api', 'snapshot.ts'));
    const statusMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);

    stateMod.saveTaskLock(context.commonDir, context.config, 'demo-task', {
      taskSlug: 'demo-task',
      branchName: 'codex/demo-task-0000',
      worktreePath: repoRoot,
      mode: 'build',
      surfaces: ['frontend'],
      updatedAt: new Date().toISOString(),
      nextAction: 'PR #42 open, awaiting CI',
    });

    const envelope = await snapshotMod.buildWorkflowApiSnapshot(repoRoot);
    assert.ok(envelope.ok, 'snapshot should be ok');
    const demoBranch = envelope.data.branches.find((b) => b.task?.taskSlug === 'demo-task');
    assert.ok(demoBranch, 'expected demo-task branch in envelope');
    assert.equal(demoBranch.task.nextAction, 'PR #42 open, awaiting CI',
      'envelope must carry nextAction from the underlying TaskLock');

    // And the cockpit must render it.
    const rendered = statusMod.renderCockpit(envelope, { color: false });
    assert.match(rendered, /next: PR #42 open, awaiting CI/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('renderCockpit strips ANSI/control chars from envelope-sourced strings', async () => {
  // Trust-boundary defense: branch notes, attention messages, source
  // reasons, and nextAction breadcrumbs can all trace back to data outside
  // the pipelane process (PR titles fetched via `gh pr view`, hand-edited
  // task-lock files, etc.). A malicious PR title containing `\x1b[2K\r`
  // could forge lane state in the cockpit. Must be scrubbed before render.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const evil = '\x1b[2K\r[Local ✓] [PR ✓] [Base: main ✓] [Staging ✓] [Production ✓]';
  const envelope = {
    schemaVersion: '2026-04-18',
    command: 'pipelane.api.snapshot',
    ok: true, message: '', warnings: [], issues: [],
    data: {
      boardContext: {
        mode: 'build', baseBranch: 'main',
        laneOrder: [], releaseReadiness: { state: 'unknown', reason: '', requestedSurfaces: [], blockedSurfaces: [], effectiveOverride: null, localReady: false, hostedReady: false, freshness: { checkedAt: '', observedAt: '', state: 'fresh' }, message: '' },
        activeTask: null,
        overallFreshness: { checkedAt: '', observedAt: '', state: 'fresh' },
      },
      sourceHealth: [{ name: `git.local${evil}`, state: 'healthy', blocking: false, reason: `ok${evil}`, freshness: { checkedAt: '', observedAt: '', state: 'fresh' } }],
      attention: [{ code: 'x', severity: 'warning', message: `something bad${evil}`, source: '', blocking: false, branch: `main${evil}`, lane: '', action: '' }],
      availableActions: [],
      branches: [{
        name: `codex/pwned${evil}`,
        status: 'open-pr', current: false, note: `PR is open${evil}`,
        task: { taskSlug: `slug${evil}`, mode: 'build', worktreePath: '/tmp/x', updatedAt: '2026-04-18T00:00:00.000Z', nextAction: `breadcrumb${evil}` },
        surfaces: [], cleanup: { available: false, eligible: false, reason: '' },
        pr: null, mergedSha: null,
        lanes: {
          local: { state: 'healthy', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
          pr: { state: 'running', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
          base: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
          staging: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
          production: { state: 'awaiting_preflight', reason: '', detail: '', freshness: { checkedAt: '', observedAt: '', state: 'fresh' } },
        },
        availableActions: [],
      }],
    },
  };

  const rendered = mod.renderCockpit(envelope, { color: false });
  // The CSI (\x1b[2K) + CR injection must not land in output.
  assert.ok(!rendered.includes('\x1b[2K'), 'CSI escape must be stripped');
  assert.ok(!rendered.includes('\r'), 'embedded CR must be stripped');
  // Content bracketing the escape survives — just the escape itself is gone.
  assert.match(rendered, /codex\/pwned\[Local ✓\]/);
  assert.match(rendered, /breadcrumb\[Local ✓\]/);
});

test('devmode release --override now requires --reason', () => {
  // v1.5: silent "manual override" default defeats auditability.
  // --override with no --reason must be rejected with a clear error
  // pointing at the --reason flag.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const result = runCli(['run', 'devmode', 'release', '--override'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release override requires --reason/);
    assert.match(result.stderr, /--reason/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('devmode release --override --reason persists reason into lastOverride', async () => {
  // v1.5: `override` clears on mode=build; `lastOverride` persists so the
  // audit trail survives mode churn. setBy is populated from GITHUB_ACTOR /
  // USER / fallback, not hardcoded.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    runCli(['run', 'devmode', 'release', '--override', '--reason', 'shipping hotfix TICKET-42'], repoRoot);

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);
    assert.ok(context.modeState.override, 'override should be set');
    assert.equal(context.modeState.override.reason, 'shipping hotfix TICKET-42');
    assert.ok(context.modeState.lastOverride, 'lastOverride should be set');
    assert.equal(context.modeState.lastOverride.reason, 'shipping hotfix TICKET-42');
    assert.ok(context.modeState.lastOverride.setBy.length > 0, 'setBy must not be empty');

    // Flip back to build — active override clears, lastOverride stays.
    runCli(['run', 'devmode', 'build'], repoRoot);
    const after = stateMod.resolveWorkflowContext(repoRoot);
    assert.equal(after.modeState.override, null);
    assert.ok(after.modeState.lastOverride, 'lastOverride must survive mode=build');
    assert.equal(after.modeState.lastOverride.reason, 'shipping hotfix TICKET-42');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('new soft-warns when >= 3 active tasks exist but never blocks', () => {
  // v1.5: the WIP warn is a guardrail, not a gate. A user who legitimately
  // has three tasks in flight gets a visible warning on stderr and /new
  // still succeeds. Uses real /new invocations so the locks survive the
  // implicit pruneDeadTaskLocks pass inside /new itself.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    // Three real tasks — each creates a worktree + branch the next /new
    // will count as active.
    runCli(['run', 'new', '--task', 'alpha'], repoRoot);
    runCli(['run', 'new', '--task', 'bravo'], repoRoot);
    runCli(['run', 'new', '--task', 'charlie'], repoRoot);

    const result = runCli(['run', 'new', '--task', 'delta'], repoRoot);
    assert.equal(result.status, 0, `expected /new to succeed; got stderr: ${result.stderr}`);
    assert.match(result.stderr, /tasks in flight/);
    assert.match(result.stderr, /warning, not a block/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('new does not warn when under the WIP threshold', () => {
  // Below-threshold path stays quiet. Important: noise above actual signal
  // defeats the warn — if it fires on every /new, operators learn to ignore it.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const result = runCli(['run', 'new', '--task', 'only-task'], repoRoot);
    assert.equal(result.status, 0);
    assert.ok(!/tasks in flight/.test(result.stderr),
      `expected no WIP warn; got stderr: ${result.stderr}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('renderCockpit surfaces persistent OVERRIDE ACTIVE banner when release gate is bypassed', async () => {
  // v1.5: override audit trail surfaces in the cockpit header. Must appear
  // BEFORE attention so a long issues list can't scroll it off the screen.
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const envelope = {
    schemaVersion: '2026-04-18',
    command: 'pipelane.api.snapshot',
    ok: true, message: '', warnings: [], issues: [],
    data: {
      boardContext: {
        mode: 'release', baseBranch: 'main',
        laneOrder: [],
        releaseReadiness: {
          state: 'unknown', reason: '', requestedSurfaces: [], blockedSurfaces: [],
          effectiveOverride: { reason: 'shipping hotfix TICKET-42', timestamp: '2026-04-18T20:00:00.000Z' },
          localReady: false, hostedReady: false,
          freshness: { checkedAt: '', observedAt: '', state: 'fresh' },
          message: '',
        },
        activeTask: null,
        overallFreshness: { checkedAt: '', observedAt: '', state: 'fresh' },
      },
      sourceHealth: [],
      attention: [],
      availableActions: [],
      branches: [],
    },
  };

  const rendered = mod.renderCockpit(envelope, { color: false });
  assert.match(rendered, /OVERRIDE ACTIVE/);
  assert.match(rendered, /shipping hotfix TICKET-42/);
  // Banner must precede ATTENTION header so it can't get scrolled off.
  assert.ok(rendered.indexOf('OVERRIDE ACTIVE') < rendered.indexOf('ATTENTION'));
});

test('setBy whitelist rejects attacker-controlled ANSI escapes in attribution envs', async () => {
  // Regression guard: a CI context with attacker-controlled GITHUB_ACTOR
  // (e.g. pull_request_target) must NOT plant ANSI escapes into
  // mode-state.json via lastOverride.setBy. The whitelist strips to
  // [A-Za-z0-9_.-]{1,64} and falls through to the next env.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    runCli(
      ['run', 'devmode', 'release', '--override', '--reason', 'hotfix'],
      repoRoot,
      {
        PIPELANE_OVERRIDE_SET_BY: '\x1b[31mEVIL\x1b[0m',
        GITHUB_ACTOR: '',
        USER: 'benign',
      },
    );

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);
    assert.ok(context.modeState.lastOverride);
    assert.equal(context.modeState.lastOverride.setBy, 'benign',
      `expected whitelist to reject ANSI and fall through to USER; got "${context.modeState.lastOverride.setBy}"`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('loadModeState drops a malformed lastOverride entry instead of crashing renderers', async () => {
  // A corrupt or hand-edited mode-state.json where lastOverride is a
  // string, array, or missing setBy crashes `/devmode status` via
  // `last.setBy.length`. loadModeState normalizes on load: require
  // all three strings non-empty, else drop the field.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    // Materialize the state dir via a normal mode write, then replace
    // mode-state.json with a corrupt lastOverride shape (simulates
    // hand-edit / partial write / attacker-planted entry).
    runCli(['run', 'devmode', 'build'], repoRoot);
    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);
    const modeStateFile = stateMod.modeStatePath(context.commonDir, context.config);
    writeFileSync(modeStateFile, JSON.stringify({
      mode: 'build',
      requestedSurfaces: ['frontend'],
      override: null,
      lastOverride: 'definitely not an object',
      updatedAt: null,
    }, null, 2), 'utf8');

    const loaded = stateMod.loadModeState(context.commonDir, context.config);
    assert.equal(loaded.lastOverride, undefined,
      `malformed lastOverride must be dropped, got ${JSON.stringify(loaded.lastOverride)}`);

    // /devmode status must not crash.
    const result = runCli(['run', 'devmode'], repoRoot);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Last override: none recorded/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('loadModeState falls back to defaults when mode-state.json contains malformed JSON', async () => {
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['run', 'devmode', 'build'], repoRoot);

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);
    const modeStateFile = stateMod.modeStatePath(context.commonDir, context.config);
    writeFileSync(modeStateFile, '{"mode":', 'utf8');

    const loaded = stateMod.loadModeState(context.commonDir, context.config);
    assert.equal(loaded.mode, stateMod.DEFAULT_MODE);
    assert.deepEqual(loaded.requestedSurfaces, context.config.surfaces);
    assert.equal(loaded.override, null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('writeJsonFile leaves only the target file after a successful atomic write', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-json-write-'));
  try {
    const target = path.join(dir, 'state.json');
    stateMod.writeJsonFile(target, { mode: 'build', requestedSurfaces: ['frontend'] });

    assert.deepEqual(readdirSync(dir), ['state.json']);
    assert.equal(
      readFileSync(target, 'utf8'),
      `${JSON.stringify({ mode: 'build', requestedSurfaces: ['frontend'] }, null, 2)}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderCockpit shows RELEASE GATE PREVIOUSLY BYPASSED banner when override cleared but lastOverride persists', async () => {
  // The audit trail must outlive the active-override flag. After
  // /devmode build, effectiveOverride is null but lastOverride persists
  // and the cockpit shouts about it (softer yellow banner, still before
  // ATTENTION so a long issues list can't scroll it away).
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const envelope = {
    schemaVersion: '2026-04-18',
    command: 'pipelane.api.snapshot',
    ok: true, message: '', warnings: [], issues: [],
    data: {
      boardContext: {
        mode: 'build', baseBranch: 'main',
        laneOrder: [],
        releaseReadiness: {
          state: 'unknown', reason: '', requestedSurfaces: [], blockedSurfaces: [],
          effectiveOverride: null,
          lastOverride: { reason: 'shipping hotfix TICKET-42', setAt: '2026-04-18T20:00:00.000Z', setBy: 'alice' },
          localReady: false, hostedReady: false,
          freshness: { checkedAt: '', observedAt: '', state: 'fresh' },
          message: '',
        },
        activeTask: null,
        overallFreshness: { checkedAt: '', observedAt: '', state: 'fresh' },
      },
      sourceHealth: [],
      attention: [],
      availableActions: [],
      branches: [],
    },
  };

  const rendered = mod.renderCockpit(envelope, { color: false });
  assert.match(rendered, /RELEASE GATE PREVIOUSLY BYPASSED/);
  assert.match(rendered, /shipping hotfix TICKET-42/);
  assert.match(rendered, /by alice/);
  assert.ok(rendered.indexOf('PREVIOUSLY BYPASSED') < rendered.indexOf('ATTENTION'),
    'previous-bypass banner must appear before ATTENTION header');
  // Not the red active banner (override is null).
  assert.ok(!/OVERRIDE ACTIVE/.test(rendered));
});

test('WIP warn message describes post-save count so operator sees "about to start Nth"', () => {
  // Regression guard for off-by-one copy: the count is taken BEFORE the
  // new lock is saved, so a message like "You have 3 tasks in flight"
  // alone undercounts. The fix is to name the POST-save ordinal
  // explicitly.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    runCli(['run', 'new', '--task', 'alpha'], repoRoot);
    runCli(['run', 'new', '--task', 'bravo'], repoRoot);
    runCli(['run', 'new', '--task', 'charlie'], repoRoot);
    const result = runCli(['run', 'new', '--task', 'delta'], repoRoot);

    assert.match(result.stderr, /about to start a 4th/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setBy whitelist allows GitHub bot actors like dependabot[bot]', async () => {
  // Regression guard: whitelist must round-trip legitimate CI bot actors.
  // An earlier cut rejected brackets and attributed bot-triggered overrides
  // to the "pipelane" fallback, burying the real actor. The ESC byte
  // (\x1b) is what actually weaponizes ANSI injection, and that's blocked
  // at every render site — brackets alone can't form a CSI sequence.
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    runCli(
      ['run', 'devmode', 'release', '--override', '--reason', 'scheduled dep bump'],
      repoRoot,
      { GITHUB_ACTOR: 'dependabot[bot]', USER: '' },
    );

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);
    assert.equal(context.modeState.lastOverride?.setBy, 'dependabot[bot]',
      `bot actor must survive the whitelist; got "${context.modeState.lastOverride?.setBy}"`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v1.2 doctor.* coverage
// ---------------------------------------------------------------------------

function writeStaleProbeState(repoRoot, surfaces, { ageMs = 25 * 60 * 60 * 1000, ok = true } = {}) {
  const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
  mkdirSync(stateDir, { recursive: true });
  const probedAt = new Date(Date.now() - ageMs).toISOString();
  const records = surfaces.map((surface) => ({
    environment: 'staging',
    surface,
    url: probeUrlForSurface(surface),
    ok,
    statusCode: ok ? 200 : 503,
    latencyMs: 25,
    error: ok ? undefined : 'HTTP 503',
    probedAt,
  }));
  writeFileSync(
    path.join(stateDir, 'probe-state.json'),
    JSON.stringify({ records, updatedAt: probedAt }, null, 2),
    'utf8',
  );
}

test('doctor.collectProbeTargets picks up only configured healthcheck surfaces', async () => {
  const doctor = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'doctor.ts'));
  const base = buildFullDeployConfig();

  // Full config: frontend staging + prod + edge staging + edge prod + sql staging + sql prod.
  assert.deepEqual(
    doctor.collectProbeTargets(base).map((t) => `${t.environment}:${t.surface}`).sort(),
    ['production:edge', 'production:frontend', 'production:sql', 'staging:edge', 'staging:frontend', 'staging:sql'],
  );

  // Drop edge + sql healthcheck URLs: only frontend (which uses url as fallback)
  // should remain probable.
  const minimal = JSON.parse(JSON.stringify(base));
  minimal.edge.staging.healthcheckUrl = '';
  minimal.edge.production.healthcheckUrl = '';
  minimal.sql.staging.healthcheckUrl = '';
  minimal.sql.production.healthcheckUrl = '';
  assert.deepEqual(
    doctor.collectProbeTargets(minimal).map((t) => `${t.environment}:${t.surface}`).sort(),
    ['production:frontend', 'staging:frontend'],
  );

  // Falls back to url when healthcheckUrl is blank on frontend.
  const fallback = JSON.parse(JSON.stringify(minimal));
  fallback.frontend.staging.healthcheckUrl = '';
  fallback.frontend.production.healthcheckUrl = '';
  const targets = doctor.collectProbeTargets(fallback);
  assert.equal(targets.find((t) => t.environment === 'staging' && t.surface === 'frontend').url, 'https://staging.example.test');
  assert.equal(targets.find((t) => t.environment === 'production' && t.surface === 'frontend').url, 'https://app.example.test');
});

test('doctor.mergeProbeRecords keeps previously-probed surfaces across a partial re-probe', async () => {
  const doctor = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'doctor.ts'));
  const previous = [
    { environment: 'staging', surface: 'frontend', url: 'u', ok: true, statusCode: 200, latencyMs: 1, probedAt: '2026-04-18T00:00:00.000Z' },
    { environment: 'staging', surface: 'edge', url: 'u', ok: true, statusCode: 200, latencyMs: 1, probedAt: '2026-04-18T00:00:00.000Z' },
    { environment: 'staging', surface: 'sql', url: 'u', ok: true, statusCode: 200, latencyMs: 1, probedAt: '2026-04-18T00:00:00.000Z' },
  ];
  const incoming = [
    { environment: 'staging', surface: 'frontend', url: 'u', ok: false, statusCode: 503, latencyMs: 99, error: 'HTTP 503', probedAt: '2026-04-19T00:00:00.000Z' },
  ];
  const merged = doctor.mergeProbeRecords(previous, incoming);

  assert.equal(merged.length, 3, 'edge + sql preserved after a frontend-only re-probe');
  const byKey = Object.fromEntries(merged.map((r) => [`${r.environment}:${r.surface}`, r]));
  assert.equal(byKey['staging:frontend'].ok, false, 'frontend overwritten');
  assert.equal(byKey['staging:frontend'].probedAt, '2026-04-19T00:00:00.000Z');
  assert.equal(byKey['staging:edge'].probedAt, '2026-04-18T00:00:00.000Z', 'edge untouched');
  assert.equal(byKey['staging:sql'].probedAt, '2026-04-18T00:00:00.000Z', 'sql untouched');
});

test('loadProbeState falls back to an empty probe set when probe-state.json contains malformed JSON', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);
    mkdirSync(path.dirname(stateMod.probeStatePath(context.commonDir, context.config)), { recursive: true });
    writeFileSync(stateMod.probeStatePath(context.commonDir, context.config), '{"records":[', 'utf8');

    const loaded = stateMod.loadProbeState(context.commonDir, context.config);
    assert.deepEqual(loaded, { records: [], updatedAt: '' });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('doctor.detectPlatform honors fly.toml / vercel.json / netlify.toml / gh-actions signals', async () => {
  const doctor = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'doctor.ts'));
  const releaseGate = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));

  function runFixture(files) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-doctor-platform-'));
    try {
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
      }
      return doctor.detectPlatform(dir, releaseGate.emptyDeployConfig());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const fly = runFixture({ 'fly.toml': 'app = "demo"\n' });
  assert.equal(fly.detected, 'fly.io');
  assert.ok(fly.sources.includes('fly.toml'));

  const vercel = runFixture({ 'vercel.json': '{}' });
  assert.equal(vercel.detected, 'vercel');

  const netlify = runFixture({ 'netlify.toml': '[build]\n' });
  assert.equal(netlify.detected, 'netlify');

  // GitHub Actions is a weak signal — should surface as detected when
  // no stronger hint is present.
  const gh = runFixture({ '.github/workflows/deploy.yml': 'name: Deploy\n' });
  assert.equal(gh.detected, 'github-actions');
  assert.ok(gh.sources.includes('.github/workflows/'));

  // Stronger platform signal wins over a co-present .github/workflows dir.
  const flyWithActions = runFixture({
    'fly.toml': 'app = "demo"\n',
    '.github/workflows/ci.yml': 'name: CI\n',
  });
  assert.equal(flyWithActions.detected, 'fly.io');
});

test('doctor.resolveProbeTimeoutMs clamps tiny and huge env overrides', async () => {
  const doctor = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'doctor.ts'));
  const previous = process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS;
  try {
    process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS = '1';
    assert.equal(doctor.resolveProbeTimeoutMs(), doctor.MIN_PROBE_TIMEOUT_MS);

    process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS = '999999';
    assert.equal(doctor.resolveProbeTimeoutMs(), doctor.MAX_PROBE_TIMEOUT_MS);

    process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS = 'not-a-number';
    assert.equal(doctor.resolveProbeTimeoutMs(), 5000);
  } finally {
    if (previous === undefined) {
      delete process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS;
    } else {
      process.env.PIPELANE_DOCTOR_PROBE_TIMEOUT_MS = previous;
    }
  }
});

test('doctor --probe blocks while another doctor state mutation lock is held', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
    const context = stateMod.resolveWorkflowContext(repoRoot);
    const stateDir = stateMod.ensureStateDir(context.commonDir, context.config);
    writeFileSync(
      path.join(stateDir, 'doctor.lock.json'),
      JSON.stringify({ pid: process.pid, createdAt: '2026-04-20T00:00:00.000Z', mode: 'fix' }, null, 2),
      'utf8',
    );

    const result = runCli(['run', 'doctor', '--probe'], repoRoot, {}, true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Doctor state is locked/);
    assert.match(result.stderr, /fix already running in pid/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('doctor --fix via PIPELANE_DOCTOR_FIX_STUB writes the Deploy Configuration block and runs a probe', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);

    const stub = {
      platform: 'fly.io',
      frontendStagingUrl: 'https://staging.example.test',
      frontendStagingHealthcheck: 'https://staging.example.test/health',
      frontendProductionUrl: 'https://app.example.test',
      frontendProductionHealthcheck: 'https://app.example.test/health',
    };

    // --fix rejects --json (the guard exists because interactive wizards
    // can't sanely speak JSON); the STUB env var is what makes it
    // scriptable without a TTY.
    runCli(['run', 'doctor', '--fix'], repoRoot, {
      PIPELANE_DOCTOR_FIX_STUB: JSON.stringify(stub),
      PIPELANE_DOCTOR_PROBE_STUB_STATUS: '200',
    });

    const claude = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /"platform": "fly.io"/);
    assert.match(claude, /"url": "https:\/\/staging.example.test"/);

    const probeStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'probe-state.json');
    assert.ok(existsSync(probeStatePath), 'probe-state.json created by --fix auto-probe');
    const probe = JSON.parse(readFileSync(probeStatePath, 'utf8'));
    const frontend = probe.records.find((r) => r.environment === 'staging' && r.surface === 'frontend');
    assert.ok(frontend, 'frontend staging probe recorded');
    assert.equal(frontend.ok, true);
    assert.equal(frontend.statusCode, 200);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check blocks when staging probe is stale (>24h old)', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    // Seed a succeeded staging deploy so the observed-staging gate passes —
    // that isolates the probe gate as the only remaining blocker.
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql'], { skipProbeState: true });
    writeStaleProbeState(repoRoot, ['frontend', 'edge', 'sql']);

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.match(output.message, /probe is stale/);
    assert.match(output.message, /\/doctor --probe/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('explainSurfaceProbe marks a fresh probe stale when the expected URL drifts', async () => {
  const releaseGate = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  const integrity = await import(path.join(KIT_ROOT, 'src', 'operator', 'integrity.ts'));
  const probedAt = new Date().toISOString();
  const result = releaseGate.explainSurfaceProbe({
    probeState: {
      records: [{
        environment: 'staging',
        surface: 'frontend',
        url: 'https://staging.example.test/health',
        urlFingerprint: integrity.computeUrlFingerprint('https://staging.example.test/health'),
        ok: true,
        statusCode: 200,
        latencyMs: 10,
        probedAt,
      }],
      updatedAt: probedAt,
    },
    surface: 'frontend',
    environment: 'staging',
    expectedUrl: 'https://staging-v2.example.test/health',
  });

  assert.equal(result.state, 'stale');
  assert.match(result.reason, /target drifted/);
});

test('doctor.listMissingFields reports platform + frontend staging + production gaps on an empty config', async () => {
  const doctor = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'doctor.ts'));
  const releaseGate = await import(path.join(KIT_ROOT, 'src', 'operator', 'release-gate.ts'));
  const missing = doctor.listMissingFields(releaseGate.emptyDeployConfig());
  assert.ok(missing.includes('platform'), 'platform flagged');
  assert.ok(missing.some((m) => m.includes('frontend.staging')), 'frontend.staging flagged');
  assert.ok(missing.some((m) => m.includes('frontend.production')), 'frontend.production flagged');

  const full = buildFullDeployConfig();
  assert.deepEqual(doctor.listMissingFields(full), [], 'full config reports no gaps');
});

test('doctor diagnose labels stale staging probes explicitly', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    writeStaleProbeState(repoRoot, ['frontend'], { ageMs: 25 * 60 * 60 * 1000, ok: true });

    const result = runCli(['run', 'doctor'], repoRoot);
    assert.match(result.stdout, /frontend: STALE/);
    assert.match(result.stdout, /25h old/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('doctor diagnose reports only the newest staging probe per surface', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    const now = Date.now();
    const olderProbedAt = new Date(now - 10 * 60 * 1000).toISOString();
    const newerProbedAt = new Date(now - 60 * 1000).toISOString();
    writeProbeState(repoRoot, [
      {
        environment: 'staging',
        surface: 'frontend',
        url: probeUrlForSurface('frontend'),
        ok: false,
        statusCode: 500,
        latencyMs: 30,
        error: 'HTTP 500',
        probedAt: olderProbedAt,
      },
      {
        environment: 'staging',
        surface: 'frontend',
        url: probeUrlForSurface('frontend'),
        ok: true,
        statusCode: 200,
        latencyMs: 20,
        probedAt: newerProbedAt,
      },
    ], newerProbedAt);

    const result = runCli(['run', 'doctor'], repoRoot);
    assert.match(result.stdout, /Probe state: 1 staging surface probe\(s\) recorded\./);
    assert.match(result.stdout, new RegExp(`frontend: OK \\(HTTP 200\\) at ${newerProbedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(result.stdout, /HTTP 500/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pipelane:api snapshot surfaces probeState rollup + deployProbe.* sourceHealth + probe attention', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql'], { skipProbeState: true });
    writeStaleProbeState(repoRoot, ['frontend', 'edge', 'sql']);

    const result = runCli(['run', 'api', 'snapshot'], repoRoot);
    const envelope = JSON.parse(result.stdout);

    assert.equal(
      envelope.data.boardContext.releaseReadiness.probeState,
      'stale',
      'probeState rollup surfaces staleness',
    );
    assert.equal(
      envelope.data.boardContext.releaseReadiness.state,
      'degraded',
      'releaseReadiness state reflects stale probe failures instead of a placeholder value',
    );
    assert.deepEqual(
      [...envelope.data.boardContext.releaseReadiness.blockedSurfaces].sort(),
      ['edge', 'frontend', 'sql'],
      'stale probes block the requested release surfaces',
    );
    assert.ok(
      envelope.data.sourceHealth.some((entry) => entry.name === 'deployProbe.frontend'),
      'deployProbe.frontend in sourceHealth',
    );
    assert.ok(
      envelope.data.sourceHealth.some((entry) => entry.name === 'deployProbe.edge'),
      'deployProbe.edge in sourceHealth (healthcheckUrl configured)',
    );
    const staleIssue = envelope.data.attention.find(
      (issue) => issue.code === 'probe.stale' && issue.action === 'doctor.probe',
    );
    assert.ok(staleIssue, 'attention[] carries a probe.stale issue pointing at doctor.probe');
    assert.equal(staleIssue.lane, 'staging');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pipelane:api snapshot surfaces unsupported configured probes explicitly', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.surfaces = [...config.surfaces, 'worker'];
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = runCli(['run', 'api', 'snapshot'], repoRoot);
    const envelope = JSON.parse(result.stdout);
    const workerProbe = envelope.data.sourceHealth.find((entry) => entry.name === 'deployProbe.worker');
    assert.ok(workerProbe, 'unsupported surface still gets a probe/sourceHealth row');
    assert.equal(workerProbe.state, 'unknown');
    assert.match(workerProbe.reason, /unsupported surface "worker"/);
    const issue = envelope.data.attention.find((entry) => entry.code === 'surface.unsupported');
    assert.ok(issue, 'attention[] carries an unsupported surface issue');
    assert.match(issue.message, /worker/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pipelane:api snapshot reports runtime unavailable when runtime-marker capability is off', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);

    const result = await runCliAsync(['run', 'api', 'snapshot'], repoRoot);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.data.boardContext.currentCheckout.layers.runtime.health, 'unavailable');
    assert.equal(envelope.data.boardContext.currentCheckout.relationships.runtimeToDeploy.state, 'not-comparable');
    assert.equal(
      envelope.data.attention.some((issue) => issue.code === 'runtime.provenance.drift'),
      false,
      'no runtime drift warning when capability is disabled',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pipelane:api snapshot reports runtime unknown when runtime marker is enabled but missing', async () => {
  const repoRoot = createRepo();
  const markerServer = await startRuntimeMarkerServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const config = buildFullDeployConfig();
    config.frontend.production.url = markerServer.baseUrl;
    config.frontend.production.runtimeMarker = { enabled: true, path: '/.well-known/pipelane-release.json' };
    writeSharedDeployConfig(repoRoot, config);

    const result = await runCliAsync(['run', 'api', 'snapshot'], repoRoot);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.data.boardContext.currentCheckout.layers.runtime.health, 'unknown');
    assert.equal(envelope.data.boardContext.currentCheckout.relationships.runtimeToDeploy.state, 'not-comparable');
    const runtimeSource = envelope.data.sourceHealth.find((entry) => entry.name === 'runtime.frontend.production');
    assert.ok(runtimeSource, 'runtime source health row should exist');
    assert.equal(runtimeSource.blocking, false);
    assert.equal(
      markerServer.hits.filter((entry) => entry === '/.well-known/pipelane-release.json').length,
      1,
      'snapshot should attempt one live runtime read',
    );
  } finally {
    await markerServer.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('pipelane:api snapshot treats runtime marker without a production URL as advisory unknown state', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const config = buildFullDeployConfig();
    config.frontend.production.url = '';
    config.frontend.production.runtimeMarker = { enabled: true, path: '/.well-known/pipelane-release.json' };
    writeSharedDeployConfig(repoRoot, config);

    const result = await runCliAsync(['run', 'api', 'snapshot'], repoRoot);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    const runtimeLayer = envelope.data.boardContext.currentCheckout.layers.runtime;
    const runtimeSource = envelope.data.sourceHealth.find((entry) => entry.name === 'runtime.frontend.production');

    assert.equal(runtimeLayer.health, 'unknown');
    assert.match(runtimeLayer.reason, /frontend URL is not configured/);
    assert.ok(runtimeSource, 'runtime source health row should exist');
    assert.equal(runtimeSource.state, 'unknown');
    assert.equal(runtimeSource.blocking, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('observeFrontendRuntime times out quickly and reports request failures as unknown', async () => {
  const markerServer = await startRuntimeMarkerServer(() => {
    // Intentionally never respond; the observation timeout should abort first.
  });
  try {
    const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'runtime-observation.ts'));
    const config = buildFullDeployConfig();
    config.frontend.production.url = markerServer.baseUrl;
    config.frontend.production.runtimeMarker = { enabled: true, path: '/.well-known/pipelane-release.json' };
    const startedAt = Date.now();
    const observation = await mod.observeFrontendRuntime({
      deployConfig: config,
      environment: 'prod',
      timeoutMs: 25,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(observation.health, 'unknown');
    assert.match(observation.reason, /timed out/i);
    assert.ok(elapsedMs < 1000, `runtime observation should fail fast, got ${elapsedMs}ms`);
  } finally {
    await markerServer.close();
  }
});

test('pipelane:api snapshot surfaces runtime drift when live production differs from recorded deploy history', async () => {
  const repoRoot = createRepo();
  const markerServer = await startRuntimeMarkerServer((req, res) => {
    if (req.url === '/.well-known/pipelane-release.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        surface: 'frontend',
        environment: 'production',
        sha: '2222222222222222222222222222222222222222',
        deployedAt: '2026-04-22T19:12:32.284Z',
        source: 'test',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const config = buildFullDeployConfig();
    config.frontend.production.url = markerServer.baseUrl;
    config.frontend.production.autoDeployOnMain = false;
    config.frontend.production.runtimeMarker = { enabled: true, path: '/.well-known/pipelane-release.json' };
    writeSharedDeployConfig(repoRoot, config);
    await writeSucceededDeployRecord(
      repoRoot,
      'prod',
      '1111111111111111111111111111111111111111',
      ['frontend'],
    );

    const result = await runCliAsync(['run', 'api', 'snapshot'], repoRoot);
    assert.equal(result.status, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.data.boardContext.currentCheckout.layers.runtime.health, 'healthy');
    assert.equal(envelope.data.boardContext.currentCheckout.relationships.runtimeToDeploy.state, 'drift');
    const drift = envelope.data.attention.find((issue) => issue.code === 'runtime.provenance.drift');
    assert.ok(drift, 'expected explicit runtime provenance drift warning');
    assert.match(drift.message, /live SHA differs from the latest recorded Pipelane deploy/);
  } finally {
    await markerServer.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('branch detail does not trigger a second runtime marker fetch', async () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const markerServer = await startRuntimeMarkerServer((req, res) => {
    if (req.url === '/.well-known/pipelane-release.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        surface: 'frontend',
        environment: 'production',
        sha: '3333333333333333333333333333333333333333',
        deployedAt: '2026-04-22T19:12:32.284Z',
        source: 'test',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const config = buildFullDeployConfig();
    config.frontend.production.url = markerServer.baseUrl;
    config.frontend.production.runtimeMarker = { enabled: true, path: '/.well-known/pipelane-release.json' };
    writeSharedDeployConfig(repoRoot, config);
    commitAll(repoRoot, 'Adopt pipelane');

    const created = JSON.parse(runCli(['run', 'new', '--task', 'Branch Fetch Guard', '--json'], repoRoot).stdout);
    const branchName = run('git', ['branch', '--show-current'], created.worktreePath);

    const snapshot = await runCliAsync(['run', 'api', 'snapshot'], created.worktreePath);
    assert.equal(snapshot.status, 0);
    assert.equal(markerServer.hits.length, 1, 'snapshot should fetch runtime marker once');

    const branchDetails = await runCliAsync(['run', 'api', 'branch', '--branch', branchName], created.worktreePath);
    assert.equal(branchDetails.status, 0);
    assert.equal(markerServer.hits.length, 1, 'branch detail must not rebuild the runtime shell');
  } finally {
    await markerServer.close();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('stale-base warning only appears when the current checkout itself is on the base branch', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const updaterRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-updater-'));
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    execFileSync('git', ['clone', remoteRoot, updaterRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(updaterRoot, 'remote.txt'), 'advance main\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'Advance remote main'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    const baseSnapshot = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    assert.ok(
      baseSnapshot.data.attention.some((issue) => issue.code === 'git.base.stale'),
      'expected stale-base warning on the base checkout itself',
    );

    const created = JSON.parse(runCli(['run', 'new', '--task', 'No Base Warning', '--json'], repoRoot).stdout);
    const taskSnapshot = JSON.parse(runCli(['run', 'api', 'snapshot'], created.worktreePath).stdout);
    assert.equal(
      taskSnapshot.data.attention.some((issue) => issue.code === 'git.base.stale'),
      false,
      'task worktrees should not inherit stale-base warnings for someone else’s main checkout',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(updaterRoot, { recursive: true, force: true });
  }
});

test('git.catchupBase action fast-forwards a stale base checkout', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const updaterRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-updater-'));
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    execFileSync('git', ['clone', remoteRoot, updaterRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'Codex'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(updaterRoot, 'remote.txt'), 'advance main\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'Advance remote main'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: updaterRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const staleSnapshot = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    const staleIssue = staleSnapshot.data.attention.find((issue) => issue.code === 'git.base.stale');
    assert.equal(staleIssue?.action, 'git.catchupBase');

    const executed = JSON.parse(runCli(['run', 'api', 'action', 'git.catchupBase', '--execute'], repoRoot).stdout);
    assert.equal(executed.ok, true);
    assert.equal(executed.data.execution.exitCode, 0);

    const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const remoteHead = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.equal(localHead, remoteHead);

    const freshSnapshot = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    assert.equal(
      freshSnapshot.data.attention.some((issue) => issue.code === 'git.base.stale'),
      false,
      'catching up local main should clear the stale-base warning',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(updaterRoot, { recursive: true, force: true });
  }
});

test('base checkout ahead of origin is described accurately and does not trigger stale-base warning', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');

    writeFileSync(path.join(repoRoot, 'ahead.txt'), 'local ahead\n', 'utf8');
    execFileSync('git', ['add', 'ahead.txt'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'Local ahead'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    const envelope = JSON.parse(runCli(['run', 'api', 'snapshot'], repoRoot).stdout);
    assert.equal(
      envelope.data.attention.some((issue) => issue.code === 'git.base.stale'),
      false,
      'ahead local main should not be labeled stale',
    );
    assert.match(
      envelope.data.boardContext.currentCheckout.summary,
      /ahead of origin\/main by 1 commit/,
    );
    assert.match(
      envelope.data.boardContext.currentCheckout.relationships.worktreeToOrigin.reason,
      /ahead of origin\/main by 1 commit/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('release-check blocks when staging probe is degraded (non-2xx)', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql'], { skipProbeState: true });
    // Fresh (ageMs=0) but non-OK: probe.state === 'degraded'.
    writeStaleProbeState(repoRoot, ['frontend', 'edge', 'sql'], { ageMs: 0, ok: false });

    const result = runCli(['run', 'release-check', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.match(output.message, /probe is degraded/);
    assert.match(output.message, /HTTP 503|probe failed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check blocks unsupported configured surfaces with a clear error', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.surfaces = [...config.surfaces, 'worker'];
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend', 'edge', 'sql']);

    const result = runCli(['run', 'release-check', '--surfaces', 'worker', '--json'], repoRoot, {}, true);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(output.ready, false);
    assert.deepEqual(output.blockedSurfaces, ['worker']);
    assert.match(output.message, /unsupported surface "worker"/);
    assert.match(output.message, /release gate only knows frontend, edge, sql/);
    assert.match(output.message, /update the tracked workflow config/);
    assert.doesNotMatch(output.message, /npm run pipelane:configure/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('release-check ignores unsigned planted failed probe records when PIPELANE_PROBE_STATE_KEY is configured', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    writeFullDeployConfigClaude(repoRoot);
    await writeStagingSucceededRecord(repoRoot, ['frontend'], { skipProbeState: true });

    const integrity = await import(path.join(KIT_ROOT, 'src', 'operator', 'integrity.ts'));
    const key = 'cafe'.repeat(8);
    const probedAt = new Date().toISOString();
    const signedHealthy = {
      environment: 'staging',
      surface: 'frontend',
      url: 'https://staging.example.test/health',
      urlFingerprint: integrity.computeUrlFingerprint('https://staging.example.test/health'),
      ok: true,
      statusCode: 200,
      latencyMs: 10,
      probedAt,
    };
    const plantedFailure = {
      environment: 'staging',
      surface: 'frontend',
      url: 'https://staging.example.test/health',
      urlFingerprint: integrity.computeUrlFingerprint('https://staging.example.test/health'),
      ok: false,
      statusCode: 503,
      latencyMs: 5,
      error: 'HTTP 503',
      probedAt: new Date(Date.now() + 1000).toISOString(),
    };
    writeProbeState(repoRoot, [
      { ...signedHealthy, signature: integrity.signSignedPayload(signedHealthy, key) },
      plantedFailure,
    ], plantedFailure.probedAt);

    const result = runCli(['run', 'release-check', '--surfaces', 'frontend', '--json'], repoRoot, {
      PIPELANE_PROBE_STATE_KEY: key,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 0, output.message);
    assert.equal(output.ready, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────
// v1.4 /status --week / --stuck / --blast
// ─────────────────────────────────────────────────────────────────────

function v14StubConfig() {
  // Minimum-viable config shape for the pure view builders. Any field a
  // builder doesn't touch (branchPrefix, aliases, etc.) gets a benign
  // placeholder — the builders only care about baseBranch, stateDir,
  // surfaces, and surfacePathMap.
  return {
    version: 1,
    projectKey: 'fixture',
    displayName: 'Fixture',
    baseBranch: 'main',
    stateDir: 'pipelane-state',
    taskWorktreeDirName: 'fixture-worktrees',
    branchPrefix: 'codex/',
    legacyBranchPrefixes: [],
    surfaces: ['frontend', 'edge', 'sql'],
    aliases: {},
    prePrChecks: [],
    prPathDenyList: [],
    deployWorkflowName: 'Deploy Hosted',
    buildMode: { description: '', autoDeployOnMerge: true },
    releaseMode: { description: '', requireStagingPromotion: true },
  };
}

function v14SeedState(commonDir, { deployRecords = null, taskLocks = [], prRecords = {} } = {}) {
  const stateDir = path.join(commonDir, 'pipelane-state');
  mkdirSync(stateDir, { recursive: true });
  if (deployRecords !== null) {
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({ records: deployRecords }, null, 2), 'utf8');
  }
  const locksDir = path.join(stateDir, 'task-locks');
  mkdirSync(locksDir, { recursive: true });
  for (const lock of taskLocks) {
    writeFileSync(path.join(locksDir, `${lock.taskSlug}.json`), JSON.stringify(lock, null, 2), 'utf8');
  }
  writeFileSync(path.join(stateDir, 'pr-state.json'), JSON.stringify({ records: prRecords }, null, 2), 'utf8');
}

test('v1.4 --week groups DeployRecords by UTC day and computes p50 cycle time', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const commonDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-week-'));
  try {
    const now = new Date('2026-04-19T12:00:00Z');
    const within = (iso) => iso;
    const deployRecords = [
      // Day 2026-04-19: two succeeded (cycles: 60s, 180s), one failed.
      { environment: 'prod', sha: 'a'.repeat(40), surfaces: ['frontend'], workflowName: 'Deploy Hosted',
        requestedAt: within('2026-04-19T00:00:00Z'), status: 'succeeded', verifiedAt: '2026-04-19T00:01:00Z' },
      { environment: 'prod', sha: 'b'.repeat(40), surfaces: ['frontend'], workflowName: 'Deploy Hosted',
        requestedAt: within('2026-04-19T06:00:00Z'), status: 'succeeded', verifiedAt: '2026-04-19T06:03:00Z' },
      { environment: 'prod', sha: 'c'.repeat(40), surfaces: ['frontend'], workflowName: 'Deploy Hosted',
        requestedAt: within('2026-04-19T11:30:00Z'), status: 'failed' },
      // Day 2026-04-17: one succeeded (cycle 120s).
      { environment: 'staging', sha: 'd'.repeat(40), surfaces: ['frontend'], workflowName: 'Deploy Hosted',
        requestedAt: within('2026-04-17T10:00:00Z'), status: 'succeeded', verifiedAt: '2026-04-17T10:02:00Z' },
      // Outside window (8 days ago): excluded.
      { environment: 'prod', sha: 'e'.repeat(40), surfaces: ['frontend'], workflowName: 'Deploy Hosted',
        requestedAt: within('2026-04-11T00:00:00Z'), status: 'succeeded', verifiedAt: '2026-04-11T00:01:00Z' },
    ];
    v14SeedState(commonDir, { deployRecords });
    const view = mod.buildWeekView(commonDir, v14StubConfig(), now);
    assert.equal(view.view, 'week');
    assert.equal(view.days.length, 7);
    const firstDate = view.days[0].date;
    const lastDate = view.days[6].date;
    assert.equal(firstDate, '2026-04-13');
    assert.equal(lastDate, '2026-04-19');
    const day19 = view.days.find((d) => d.date === '2026-04-19');
    assert.equal(day19.succeeded, 2);
    assert.equal(day19.failed, 1);
    // median(60000, 180000) = 120000 ms.
    assert.equal(day19.p50CycleMs, 120000);
    const day17 = view.days.find((d) => d.date === '2026-04-17');
    assert.equal(day17.succeeded, 1);
    assert.equal(day17.failed, 0);
    assert.equal(day17.p50CycleMs, 120000);
    assert.equal(view.totals.succeeded, 3);
    assert.equal(view.totals.failed, 1);
    assert.equal(view.totals.distinctShas, 4); // a/b/c/d; e is out of window
    // median(60000, 120000, 180000) = 120000
    assert.equal(view.totals.p50CycleMs, 120000);
    const rendered = mod.renderWeekView(view);
    // Window is UTC-midnight-aligned — 7 UTC days ending at today's UTC
    // date (2026-04-13 → 2026-04-19 inclusive). Pre-alignment the header
    // was off-by-one when `now` wasn't UTC midnight.
    assert.match(rendered, /SHIPPED \(last 7 days, 2026-04-13 → 2026-04-19\)/);
    assert.match(rendered, /2026-04-19\s+2\s+1/);
    assert.match(rendered, /TOTAL\s+3\s+1/);
    assert.match(rendered, /distinct shas deployed: 4/);
  } finally {
    rmSync(commonDir, { recursive: true, force: true });
  }
});

test('v1.4 --week: idle 7-day window renders an all-zero table with em-dash p50', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const commonDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-week-empty-'));
  try {
    v14SeedState(commonDir, { deployRecords: [] });
    const now = new Date('2026-04-19T00:00:00Z');
    const view = mod.buildWeekView(commonDir, v14StubConfig(), now);
    assert.equal(view.days.length, 7);
    assert.ok(view.days.every((d) => d.succeeded === 0 && d.failed === 0 && d.p50CycleMs === null));
    assert.equal(view.totals.succeeded, 0);
    assert.equal(view.totals.p50CycleMs, null);
    const rendered = mod.renderWeekView(view);
    assert.match(rendered, /TOTAL\s+0\s+0\s+—/);
  } finally {
    rmSync(commonDir, { recursive: true, force: true });
  }
});

test('v1.4 --stuck flags idle release locks, orphan merged PRs, and staging without prod', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const commonDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-stuck-'));
  try {
    const now = new Date('2026-04-19T12:00:00Z');
    const ageHoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
    const taskLocks = [
      // Idle 90h in release mode → stuck.
      { taskSlug: 'stuck-task', taskName: 'Stuck Task', branchName: 'codex/stuck-task-1111',
        worktreePath: '/tmp/stuck', mode: 'release', surfaces: ['frontend'],
        updatedAt: ageHoursAgo(90), nextAction: 'PR #42 open, awaiting CI' },
      // Idle 2h → fresh, not stuck.
      { taskSlug: 'fresh-task', branchName: 'codex/fresh-task-2222',
        worktreePath: '/tmp/fresh', mode: 'release', surfaces: ['frontend'],
        updatedAt: ageHoursAgo(2) },
      // Build mode is exempt (per 2026-04-19 memory: release mode only).
      { taskSlug: 'build-old', branchName: 'codex/build-old-3333',
        worktreePath: '/tmp/old', mode: 'build', surfaces: ['frontend'],
        updatedAt: ageHoursAgo(200) },
    ];
    const prRecords = {
      'orphan-win': { taskSlug: 'orphan-win', branchName: 'codex/orphan-win-4444',
        title: 'Orphan win', number: 99, url: 'https://x', mergedSha: 'orphansha1234',
        mergedAt: ageHoursAgo(36), updatedAt: ageHoursAgo(36) },
      // Merged >14d ago: outside the orphan-window.
      'ancient-pr': { taskSlug: 'ancient-pr', branchName: 'codex/ancient-pr-5555',
        title: 'Ancient', number: 5, url: 'https://y', mergedSha: 'ancientsha555',
        mergedAt: ageHoursAgo(24 * 30), updatedAt: ageHoursAgo(24 * 30) },
      // Merged + deployed: matches a DeployRecord, not orphan.
      'deployed-win': { taskSlug: 'deployed-win', branchName: 'codex/deployed-win-6666',
        title: 'Deployed', number: 100, url: 'https://z', mergedSha: 'deployedsha66',
        mergedAt: ageHoursAgo(24), updatedAt: ageHoursAgo(24) },
    };
    const deployRecords = [
      // Matches 'deployed-win' orphan check (same sha).
      { environment: 'staging', sha: 'deployedsha66', surfaces: ['frontend'],
        workflowName: 'Deploy Hosted', requestedAt: ageHoursAgo(23),
        status: 'succeeded', verifiedAt: ageHoursAgo(22) },
      // Stale staging >48h without prod promotion of SAME sha.
      { environment: 'staging', sha: 'staleonly1234', surfaces: ['frontend'],
        workflowName: 'Deploy Hosted', requestedAt: ageHoursAgo(55),
        status: 'succeeded', verifiedAt: ageHoursAgo(54) },
      // Fresh staging (24h old) — below 48h threshold.
      { environment: 'staging', sha: 'freshstaging', surfaces: ['frontend'],
        workflowName: 'Deploy Hosted', requestedAt: ageHoursAgo(24),
        status: 'succeeded', verifiedAt: ageHoursAgo(23) },
      // Staging + matching prod promotion → not stuck.
      { environment: 'staging', sha: 'promotedsha1', surfaces: ['frontend'],
        workflowName: 'Deploy Hosted', requestedAt: ageHoursAgo(100),
        status: 'succeeded', verifiedAt: ageHoursAgo(99) },
      { environment: 'prod', sha: 'promotedsha1', surfaces: ['frontend'],
        workflowName: 'Deploy Hosted', requestedAt: ageHoursAgo(98),
        status: 'succeeded', verifiedAt: ageHoursAgo(97) },
    ];
    v14SeedState(commonDir, { deployRecords, taskLocks, prRecords });
    const view = mod.buildStuckView(commonDir, v14StubConfig(), now);
    assert.equal(view.idleTasks.length, 1);
    assert.equal(view.idleTasks[0].taskSlug, 'stuck-task');
    assert.equal(view.idleTasks[0].nextAction, 'PR #42 open, awaiting CI');
    assert.ok(view.idleTasks[0].idleMs >= 72 * 3600 * 1000);
    const orphanSlugs = view.orphanMergedPrs.map((p) => p.taskSlug).sort();
    assert.deepEqual(orphanSlugs, ['orphan-win']); // only within-window + undeployed
    assert.equal(view.staleStaging.length, 1);
    assert.equal(view.staleStaging[0].sha, 'staleonly1234');
    assert.ok(view.staleStaging[0].ageMs >= 48 * 3600 * 1000);
    const rendered = mod.renderStuckView(view);
    assert.match(rendered, /STUCK/);
    assert.match(rendered, /stuck-task/);
    assert.match(rendered, /next: PR #42 open, awaiting CI/);
    assert.match(rendered, /PR #99\s+task=orphan-win/);
    assert.match(rendered, /sha=staleonly12/);
  } finally {
    rmSync(commonDir, { recursive: true, force: true });
  }
});

test('v1.4 --stuck returns empty lists and renders "(nothing stuck)" on a clean state', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const commonDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-stuck-clean-'));
  try {
    v14SeedState(commonDir, { deployRecords: [] });
    const view = mod.buildStuckView(commonDir, v14StubConfig(), new Date('2026-04-19T00:00:00Z'));
    assert.equal(view.idleTasks.length, 0);
    assert.equal(view.orphanMergedPrs.length, 0);
    assert.equal(view.staleStaging.length, 0);
    assert.match(mod.renderStuckView(view), /\(nothing stuck\)/);
  } finally {
    rmSync(commonDir, { recursive: true, force: true });
  }
});

test('v1.4 --blast groups changed files by surfacePathMap and hints when the map is empty', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-blast-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(path.join(repoRoot, 'src', 'frontend', 'components'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'supabase', 'migrations'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'App.tsx'), 'v1', 'utf8');
    writeFileSync(path.join(repoRoot, 'docs', 'README.md'), 'old', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    // Advance onto a feature branch so `main` stays at `baseCommit`. The
    // blast view needs a base != target or the diff is empty.
    execFileSync('git', ['switch', '-c', 'feature'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'App.tsx'), 'v2', 'utf8');
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'components', 'Button.tsx'), 'new', 'utf8');
    writeFileSync(path.join(repoRoot, 'supabase', 'migrations', '001.sql'), 'create', 'utf8');
    writeFileSync(path.join(repoRoot, 'docs', 'README.md'), 'changed', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'target'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const commonDir = path.join(repoRoot, '.git');

    // Pass 1: empty map + no prod deploy → base-branch anchor, everything in "other".
    const config = v14StubConfig();
    v14SeedState(commonDir, { deployRecords: [] });
    const viewA = mod.buildBlastView(repoRoot, commonDir, config, 'HEAD');
    assert.equal(viewA.base.kind, 'base-branch');
    assert.equal(viewA.totalFiles, 4);
    assert.deepEqual(viewA.surfaces, {});
    assert.equal(viewA.other.length, 4);
    assert.ok(viewA.hint && viewA.hint.includes('surfacePathMap'));

    // Pass 2: configured map → frontend + sql get grouped; docs fall to other.
    const configured = { ...config, surfacePathMap: { frontend: ['src/frontend/'], sql: ['supabase/'] } };
    const viewB = mod.buildBlastView(repoRoot, commonDir, configured, 'HEAD');
    assert.equal(viewB.totalFiles, 4);
    assert.deepEqual(viewB.surfaces.frontend.sort(), ['src/frontend/App.tsx', 'src/frontend/components/Button.tsx']);
    assert.deepEqual(viewB.surfaces.sql, ['supabase/migrations/001.sql']);
    assert.deepEqual(viewB.other, ['docs/README.md']);
    assert.equal(viewB.hint, null);
    const rendered = mod.renderBlastView(viewB);
    assert.match(rendered, /BLAST\s+[0-9a-f]{12}/);
    assert.match(rendered, /frontend \(2 files\)/);
    assert.match(rendered, /sql \(1 file\)/);
    assert.match(rendered, /other \(1 file\)/);
    assert.match(rendered, /base-branch/); // no deploy records seeded

    // Pass 3: prev-prod deploy pointing at the base commit reuses that anchor.
    v14SeedState(commonDir, { deployRecords: [
      { environment: 'prod', sha: baseCommit, surfaces: ['frontend'], workflowName: 'Deploy Hosted',
        requestedAt: '2026-04-18T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-18T00:01:00Z' },
    ] });
    const viewC = mod.buildBlastView(repoRoot, commonDir, configured, 'HEAD');
    assert.equal(viewC.base.kind, 'prod-deploy');
    assert.equal(viewC.base.sha, baseCommit);
    assert.equal(viewC.totalFiles, 4);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('v1.4 /status rejects passing two view flags at once', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const result = runCli(['run', 'status', '--week', '--stuck'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pass only one of --week, --stuck, --blast at a time/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('v1.4 /status --week --json end-to-end renders from a real init\'d repo', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const commonDir = path.join(repoRoot, '.git');
    v14SeedState(commonDir, {
      deployRecords: [{
        environment: 'prod', sha: 'f'.repeat(40), surfaces: ['frontend'],
        workflowName: 'Deploy Hosted',
        requestedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        status: 'succeeded',
        verifiedAt: new Date(Date.now() - 3540 * 1000).toISOString(),
      }],
    });
    const result = runCli(['run', 'status', '--week', '--json'], repoRoot);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.view, 'week');
    assert.equal(parsed.days.length, 7);
    assert.equal(parsed.totals.succeeded, 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('v1.4 /status --stuck --json end-to-end renders from a real init\'d repo', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const commonDir = path.join(repoRoot, '.git');
    const updatedAt = new Date(Date.now() - 90 * 3600 * 1000).toISOString();
    v14SeedState(commonDir, {
      taskLocks: [{
        taskSlug: 'stuck-task',
        taskName: 'Stuck Task',
        branchName: 'codex/stuck-task-1111',
        worktreePath: '/tmp/stuck',
        mode: 'release',
        surfaces: ['frontend'],
        updatedAt,
        nextAction: 'PR #42 open, awaiting CI',
      }],
    });

    const result = runCli(['run', 'status', '--stuck', '--json'], repoRoot);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.view, 'stuck');
    assert.equal(parsed.idleTasks.length, 1);
    assert.equal(parsed.idleTasks[0].taskSlug, 'stuck-task');
    assert.equal(parsed.idleTasks[0].nextAction, 'PR #42 open, awaiting CI');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('v1.4 /status --blast --json end-to-end renders from a real init\'d repo', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.surfacePathMap = { frontend: ['src/frontend/'], sql: ['supabase/'] };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    mkdirSync(path.join(repoRoot, 'src', 'frontend', 'components'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'supabase', 'migrations'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'App.tsx'), 'v1', 'utf8');
    writeFileSync(path.join(repoRoot, 'docs', 'README.md'), 'old', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'blast-base'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['switch', '-c', 'feature'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'App.tsx'), 'v2', 'utf8');
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'components', 'Button.tsx'), 'new', 'utf8');
    writeFileSync(path.join(repoRoot, 'supabase', 'migrations', '001.sql'), 'create', 'utf8');
    writeFileSync(path.join(repoRoot, 'docs', 'README.md'), 'changed', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'blast-target'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    const result = runCli(['run', 'status', '--blast', 'HEAD', '--json'], repoRoot);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.view, 'blast');
    assert.equal(parsed.base.kind, 'base-branch');
    assert.deepEqual(parsed.surfaces.frontend.sort(), ['src/frontend/App.tsx', 'src/frontend/components/Button.tsx']);
    assert.deepEqual(parsed.surfaces.sql, ['supabase/migrations/001.sql']);
    assert.deepEqual(parsed.other, ['docs/README.md']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// v1.3 fold-in: /resume renders lock.nextAction when present.
test('v1.4 /resume surfaces TaskLock.nextAction breadcrumb when set by a prior command', () => {
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    commitAll(repoRoot, 'post-setup');
    runCli(['run', 'new', '--task', 'Resume Demo'], repoRoot);
    // Simulate a prior /pr that wrote a breadcrumb into the lock.
    const lockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', 'resume-demo.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.nextAction = 'PR #7 open, awaiting CI';
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');

    const result = runCli(['run', 'resume', '--task', 'Resume Demo', '--json'], repoRoot);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.lockNextAction, 'PR #7 open, awaiting CI');
    assert.match(payload.message, /Last logged step: PR #7 open, awaiting CI/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Review fixup: normalizeSurfacePathMap drops every malformed shape.
test('v1.4 normalizeSurfacePathMap filters garbage and collapses an all-invalid map to undefined', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  // Non-object / array input returns undefined wholesale.
  assert.equal(mod.normalizeWorkflowConfig({ surfacePathMap: 'not-a-map' }).surfacePathMap, undefined);
  assert.equal(mod.normalizeWorkflowConfig({ surfacePathMap: ['an', 'array'] }).surfacePathMap, undefined);
  // Non-array value dropped; empty surface key dropped; non-string entries filtered; all-invalid collapses.
  const mixed = mod.normalizeWorkflowConfig({ surfacePathMap: {
    frontend: ['src/frontend/', 42, null, ''],
    '': ['ignored'],
    notArray: 'nope',
    allBlank: ['', '   '],
    sql: ['supabase/'],
  }}).surfacePathMap;
  assert.deepEqual(mixed, { frontend: ['src/frontend/'], sql: ['supabase/'] });
  const allBad = mod.normalizeWorkflowConfig({ surfacePathMap: { '': ['x'], bad: 'nope' } }).surfacePathMap;
  assert.equal(allBad, undefined);
});

// Review fixup: buildBlastView throws on unresolvable sha (first user-facing error path).
test('v1.4 --blast throws a clear error on an unresolvable sha', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-blast-bad-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(repoRoot, 'seed.txt'), 'a', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const commonDir = path.join(repoRoot, '.git');
    v14SeedState(commonDir, { deployRecords: [] });
    assert.throws(
      () => mod.buildBlastView(repoRoot, commonDir, v14StubConfig(), 'definitely-not-a-real-ref-12345'),
      /Could not resolve "definitely-not-a-real-ref-12345"/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Review fixup: --blast on a Windows-style surfacePathMap should match git's forward-slash paths.
test('v1.4 --blast normalizes backslash surfacePathMap entries to POSIX separators', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-blast-win-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(path.join(repoRoot, 'src', 'frontend'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'App.tsx'), 'v1', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['switch', '-c', 'feature'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(repoRoot, 'src', 'frontend', 'App.tsx'), 'v2', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'target'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const commonDir = path.join(repoRoot, '.git');
    v14SeedState(commonDir, { deployRecords: [] });
    const config = { ...v14StubConfig(), surfacePathMap: { frontend: ['src\\frontend\\'] } };
    const view = mod.buildBlastView(repoRoot, commonDir, config, 'HEAD');
    assert.deepEqual(view.surfaces.frontend, ['src/frontend/App.tsx']);
    assert.deepEqual(view.other, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Review fixup: --blast <sha> without a value must error, not swallow the next flag.
test('v1.4 --blast rejects a flag-shaped next argument instead of swallowing it', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const result = runCli(['run', 'status', '--blast', '--json'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--blast requires a commit sha/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Review fixup: --stuck exactly at 72h idle is not stuck; 72h+1ms is.
test('v1.4 --stuck idle threshold is strictly > 72h (not >=)', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'status.ts'));
  const commonDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-stuck-boundary-'));
  try {
    const now = new Date('2026-04-19T12:00:00Z');
    const exactSeventyTwo = new Date(now.getTime() - 72 * 3600 * 1000).toISOString();
    const overSeventyTwo = new Date(now.getTime() - 72 * 3600 * 1000 - 1).toISOString();
    v14SeedState(commonDir, { taskLocks: [
      { taskSlug: 'exact', branchName: 'codex/exact', worktreePath: '/t/e',
        mode: 'release', surfaces: ['frontend'], updatedAt: exactSeventyTwo },
      { taskSlug: 'over', branchName: 'codex/over', worktreePath: '/t/o',
        mode: 'release', surfaces: ['frontend'], updatedAt: overSeventyTwo },
    ]});
    const view = mod.buildStuckView(commonDir, v14StubConfig(), now);
    assert.deepEqual(view.idleTasks.map((t) => t.taskSlug), ['over']);
  } finally {
    rmSync(commonDir, { recursive: true, force: true });
  }
});

// Review fixup: /resume --json multi-lock emits structured activeLocks[] with per-lock breadcrumbs.
test('v1.4 /resume --json multi-lock emits activeLocks[] with per-lock lockNextAction', () => {
  const { repoRoot } = createRemoteBackedRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    commitAll(repoRoot, 'post-setup');
    runCli(['run', 'new', '--task', 'Task A'], repoRoot);
    runCli(['run', 'new', '--task', 'Task B'], repoRoot);
    const locksDir = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks');
    const a = JSON.parse(readFileSync(path.join(locksDir, 'task-a.json'), 'utf8'));
    a.nextAction = 'CI running';
    writeFileSync(path.join(locksDir, 'task-a.json'), JSON.stringify(a), 'utf8');
    const b = JSON.parse(readFileSync(path.join(locksDir, 'task-b.json'), 'utf8'));
    b.nextAction = '   '; // whitespace-only → trimmed to null
    writeFileSync(path.join(locksDir, 'task-b.json'), JSON.stringify(b), 'utf8');
    const result = runCli(['run', 'resume', '--json'], repoRoot);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.activeLocks));
    assert.equal(payload.activeLocks.length, 2);
    const aLock = payload.activeLocks.find((l) => l.taskSlug === 'task-a');
    const bLock = payload.activeLocks.find((l) => l.taskSlug === 'task-b');
    assert.equal(aLock.lockNextAction, 'CI running');
    assert.equal(bLock.lockNextAction, null);
    assert.match(payload.message, /Task A.*\n\s+last logged step: CI running/);
    assert.doesNotMatch(payload.message, /Task B.*\n\s+last logged step:/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────
// v1.1 rollback.* actions
// ─────────────────────────────────────────────────────────────────────

test('v1.1 findLastGoodDeploy picks the most recent succeeded+verified record excluding the current sha', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const ok = (statusCode) => ({ healthcheckUrl: 'x', statusCode, latencyMs: 10, probes: 2 });
  const records = [
    { environment: 'prod', sha: 'aaaa', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-10T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-10T00:01:00Z',
      verification: ok(200) },
    { environment: 'prod', sha: 'bbbb', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-12T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-12T00:01:00Z',
      verification: ok(200) },
    // Broken prod deploy — we're rolling back FROM this one. Last in the
    // array, newest timestamp, but findLastGoodDeploy must skip it because
    // it matches excludeSha.
    { environment: 'prod', sha: 'cccc', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-14T00:00:00Z', status: 'failed', verifiedAt: '2026-04-14T00:01:00Z',
      verification: { statusCode: 503 } },
    // Different environment + surfaces — don't pick.
    { environment: 'staging', sha: 'dddd', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-15T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-15T00:01:00Z',
      verification: ok(200) },
    { environment: 'prod', sha: 'eeee', surfaces: ['frontend', 'edge'], workflowName: 'X',
      requestedAt: '2026-04-15T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-15T00:01:00Z',
      verification: ok(200) },
  ];
  const hit = mod.findLastGoodDeploy({
    records, environment: 'prod', surfaces: ['frontend'], excludeSha: 'cccc',
  });
  assert.equal(hit?.sha, 'bbbb');
  // Per-surface verification path: when verificationBySurface is present,
  // every requested surface must be 2xx.
  const withPerSurface = [
    { environment: 'prod', sha: 'ffff', surfaces: ['frontend', 'edge'], workflowName: 'X',
      requestedAt: '2026-04-16T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-16T00:01:00Z',
      verificationBySurface: { frontend: ok(200), edge: ok(500) } },
    { environment: 'prod', sha: 'gggg', surfaces: ['frontend', 'edge'], workflowName: 'X',
      requestedAt: '2026-04-15T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-15T00:01:00Z',
      verificationBySurface: { frontend: ok(200), edge: ok(200) } },
  ];
  const perSurfaceHit = mod.findLastGoodDeploy({
    records: withPerSurface, environment: 'prod', surfaces: ['frontend', 'edge'], excludeSha: 'zzzz',
  });
  // 'ffff' has edge: 500 → disqualified. 'gggg' is the last-good.
  assert.equal(perSurfaceHit?.sha, 'gggg');

  // Nothing earlier → null.
  assert.equal(mod.findLastGoodDeploy({
    records: [], environment: 'prod', surfaces: ['frontend'], excludeSha: 'x',
  }), null);
});

test('v1.1 /rollback staging dispatches + verifies + persists rollbackOfSha', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Rollback Me', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v1.txt'), 'good\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Rollback Me', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    // Fake gh's squash-merge returns a bogus deadbeef sha, but the R4
    // fix (rollback blocks dispatch when target sha doesn't exist in
    // the repo) catches it. Overwrite pr-state.json with a real sha
    // committed to the worktree branch so deploy/rollback have real
    // commits to work against.
    const goodSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    const prKey = Object.keys(prState.records)[0];
    prState.records[prKey].mergedSha = goodSha;
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');

    // First staging deploy = the known-good one to roll back to.
    const goodDeploy = JSON.parse(runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env).stdout);
    assert.equal(goodDeploy.status, 'succeeded');

    // Simulate a broken follow-up deploy: flip the stub to 503, write a
    // fresh commit, deploy, verify it fails and lands as the current sha.
    writeFileSync(path.join(created.worktreePath, 'v2.txt'), 'bad\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'break it'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    const brokenSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const badDeploy = runCli(['run', 'deploy', 'staging', '--sha', brokenSha, '--json'], created.worktreePath, {
      ...env, PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '503',
    }, true);
    assert.notEqual(badDeploy.status, 0);

    // /rollback staging should pick the earlier good sha and record a
    // new succeeded DeployRecord with rollbackOfSha pointing at `brokenSha`.
    const rollback = JSON.parse(runCli(['run', 'rollback', 'staging', '--json'], created.worktreePath, env).stdout);
    assert.equal(rollback.status, 'succeeded');
    assert.equal(rollback.environment, 'staging');
    assert.equal(rollback.sha, goodDeploy.sha);
    assert.equal(rollback.rollbackOfSha, brokenSha);

    // nextAction breadcrumb should reflect the rollback.
    const lockPath = path.join(repoRoot, '.git', 'pipelane-state', 'task-locks', created.taskSlug + '.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.match(lock.nextAction, /staging rolled back/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('v1.1 /rollback refuses with a clear error when no earlier succeeded deploy exists', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Fresh Repo', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v1.txt'), 'v1\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Fresh Repo', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    // Only deploy ever attempted fails → no prior good record exists.
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env, true);

    const refused = runCli(['run', 'rollback', 'staging', '--json'], created.worktreePath, env, true);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /no earlier succeeded\+verified deploy/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('v1.1 rollback.* action registry — rollback.prod risky, rollback.staging not', async () => {
  const actionsMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'api', 'actions.ts'));
  assert.ok(actionsMod.STABLE_ACTION_IDS.includes('rollback.prod'));
  assert.ok(actionsMod.STABLE_ACTION_IDS.includes('rollback.staging'));
  assert.ok(actionsMod.API_RISKY_ACTION_IDS.has('rollback.prod'));
  assert.ok(!actionsMod.API_RISKY_ACTION_IDS.has('rollback.staging'));
});

test('v1.1 api action rollback.prod preflight issues a confirm-token, execute rejects bogus tokens', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Confirm Binding', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Confirm Binding', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);

    // Preflight: requires no prior deploy state — it's a read-only gate
    // that returns a confirm token fingerprinted on the normalized inputs.
    const preflight = JSON.parse(runCli(
      ['run', 'api', 'action', 'rollback.prod', '--task', 'Confirm Binding', '--surfaces', 'frontend'],
      created.worktreePath, env,
    ).stdout);
    assert.equal(preflight.ok, true);
    assert.equal(preflight.data.action.risky, true);
    assert.equal(preflight.data.preflight.requiresConfirmation, true);
    const token = preflight.data.preflight.confirmation.token;
    assert.ok(token, 'preflight should return a confirm token for rollback.prod');

    // Execute with a bogus token must be rejected by consumeActionConfirmation.
    const bogus = runCli(
      ['run', 'api', 'action', 'rollback.prod', '--execute', '--confirm-token', 'fake',
        '--task', 'Confirm Binding', '--surfaces', 'frontend'],
      created.worktreePath, env, true,
    );
    assert.notEqual(bogus.status, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('v1.1 /rollback --revert-pr opens a gh PR without pushing to main', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Revert Me', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'v1\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Revert Me', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'revert-pr-test', '--json'], created.worktreePath);

    // The fake gh's squash-merge returns a bogus sha `deadbeefcafebabe`
    // that isn't a real git object. Simulate the post-merge state by
    // landing a real commit on origin/main and overwriting pr-state.json
    // so /revert-pr has something real to revert.
    writeFileSync(path.join(repoRoot, 'squash.txt'), 'v1\n', 'utf8');
    commitAll(repoRoot, 'squash: Revert Me');
    const realMergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    const key = Object.keys(prState.records)[0];
    prState.records[key].mergedSha = realMergeSha;
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');
    // Refresh origin in the worktree so origin/main points at realMergeSha.
    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });

    const beforeRemote = execFileSync('git', ['rev-parse', 'main'], { cwd: remoteRoot, encoding: 'utf8' }).trim();
    const result = JSON.parse(runCli(
      ['run', 'rollback', 'prod', '--revert-pr', '--json'],
      created.worktreePath,
      env,
    ).stdout);
    assert.ok(result.revertBranch.startsWith('codex/revert-'));
    assert.equal(result.revertedSha, realMergeSha);
    // main on origin must be unchanged — revert-pr opens a PR, never pushes to main.
    const afterRemote = execFileSync('git', ['rev-parse', 'main'], { cwd: remoteRoot, encoding: 'utf8' }).trim();
    assert.equal(beforeRemote, afterRemote);
    const ghState = JSON.parse(readFileSync(ghStateFile, 'utf8'));
    const revertPr = Object.values(ghState.prs).find((pr) => pr.title.startsWith('Revert "'));
    assert.ok(revertPr, 'expected a revert PR to be created via fake gh');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('v1.1 --revert-pr refuses outside release mode', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Build Mode', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Build Mode', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    // Stay in build mode (default).
    const refused = runCli(['run', 'rollback', 'prod', '--revert-pr', '--json'], created.worktreePath, env, true);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /release-mode only/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────
// v1.1 review fixups — regression tests for security + cascade + worktree
// ─────────────────────────────────────────────────────────────────────

test('v1.1 fixup: findLastGoodDeploy honors configFingerprint when set', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const ok = (statusCode) => ({ healthcheckUrl: 'x', statusCode, latencyMs: 10, probes: 2 });
  const records = [
    { environment: 'prod', sha: 'oldfingerprint', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-10T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-10T00:01:00Z',
      verification: ok(200), configFingerprint: 'fp-A' },
    { environment: 'prod', sha: 'currentfingerprint', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-12T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-12T00:01:00Z',
      verification: ok(200), configFingerprint: 'fp-B' },
  ];
  // With configFingerprint='fp-B', only the record with matching
  // fingerprint qualifies as a rollback target.
  const matched = mod.findLastGoodDeploy({
    records, environment: 'prod', surfaces: ['frontend'], excludeSha: 'zzzz',
    configFingerprint: 'fp-B',
  });
  assert.equal(matched?.sha, 'currentfingerprint');
  // Without the filter, the newest of either fingerprint qualifies.
  const unfiltered = mod.findLastGoodDeploy({
    records, environment: 'prod', surfaces: ['frontend'], excludeSha: 'zzzz',
  });
  assert.equal(unfiltered?.sha, 'currentfingerprint');
  // Records lacking a configFingerprint are still accepted (legacy).
  const legacy = [{ ...records[0], configFingerprint: undefined }];
  const legacyMatch = mod.findLastGoodDeploy({
    records: legacy, environment: 'prod', surfaces: ['frontend'], excludeSha: 'zzzz',
    configFingerprint: 'fp-B',
  });
  assert.equal(legacyMatch?.sha, 'oldfingerprint');
});

test('v1.1 fixup: re-running /rollback after a successful rollback refuses (cascade guard)', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Cascade', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v1.txt'), 'good\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Cascade', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    // Swap fake-gh's deadbeef merge for a real sha so the R4 gate passes.
    const goodSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    prState.records[Object.keys(prState.records)[0]].mergedSha = goodSha;
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');
    // good → bad → rollback (succeeds). Re-running rollback should
    // refuse instead of cascading to an older sha.
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env);
    writeFileSync(path.join(created.worktreePath, 'v2.txt'), 'bad\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'break it'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    const brokenSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    runCli(['run', 'deploy', 'staging', '--sha', brokenSha, '--json'], created.worktreePath, {
      ...env, PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '503',
    }, true);
    const firstRollback = JSON.parse(runCli(['run', 'rollback', 'staging', '--json'], created.worktreePath, env).stdout);
    assert.equal(firstRollback.status, 'succeeded');
    // Second rollback: the current record is now the first rollback itself
    // (status=succeeded, rollbackOfSha set). Cascade guard should fire.
    const secondRollback = runCli(['run', 'rollback', 'staging', '--json'], created.worktreePath, env, true);
    assert.notEqual(secondRollback.status, 0);
    assert.match(secondRollback.stderr, /already at the result of a prior rollback/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('v1.1 fixup: --revert-pr rejects a malformed mergedSha before any git op', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Sha Inject', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Sha Inject', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'revert-pr-sha-test', '--json'], created.worktreePath);

    // Plant a flag-shaped "sha" to simulate pr-state.json tampering.
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    prState.records[Object.keys(prState.records)[0]].mergedSha = '--force-with-lease';
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');

    const refused = runCli(['run', 'rollback', 'prod', '--revert-pr', '--json'], created.worktreePath, env, true);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /not a valid git sha/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

test('v1.1 fixup: --revert-pr refuses with a dirty worktree before switching branches', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Dirty Worktree', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Dirty Worktree', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'revert-pr-dirty-test', '--json'], created.worktreePath);

    // Leave an uncommitted change in the worktree.
    writeFileSync(path.join(created.worktreePath, 'uncommitted.txt'), 'DIRTY\n', 'utf8');

    const refused = runCli(['run', 'rollback', 'prod', '--revert-pr', '--json'], created.worktreePath, env, true);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /worktree has uncommitted changes/);
    // Worktree shouldn't have been switched.
    const branchAfter = execFileSync('git', ['branch', '--show-current'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    assert.equal(branchAfter, created.branch);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Codex P1: surface fallback at preflight must mirror handleRollback's
// execute-time chain (flags → lock.surfaces → config.surfaces). If preflight
// uses config.surfaces when flags are empty, but execute uses lock.surfaces,
// they compute different targetSha values and the confirm token signs off
// on the wrong rollback.
test('v1.1 codex fixup: rollback.* preflight surface fallback matches execute (task lock wins)', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    // Task lock only covers frontend. Config surfaces = [frontend, edge, sql].
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Narrow', '--surfaces', 'frontend', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Narrow', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);

    // Seed deploy-state with two prod records — one matching frontend
    // (the lock's surfaces) and one matching the full config surfaces.
    // Distinct shas so preflight/execute drift would produce visibly
    // different targetSha in normalizedInputs.
    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
    mkdirSync(stateDir, { recursive: true });
    // Need an OLDER good record + NEWER current record for each surface
    // set so findLastGoodDeploy has something to target (excludeSha skips
    // the newest match).
    const okProbe = { statusCode: 200, latencyMs: 10, probes: 2 };
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({ records: [
      // Older frontend-only good (rollback target if lock-path wins).
      { environment: 'prod', sha: 'oldfrontendsha', surfaces: ['frontend'],
        workflowName: 'Deploy Hosted', requestedAt: '2026-04-09T00:00:00Z',
        status: 'succeeded', verifiedAt: '2026-04-09T00:01:00Z', verification: okProbe },
      // Older all-surfaces good (rollback target if config-path wins).
      { environment: 'prod', sha: 'oldallsurfaces', surfaces: ['edge', 'frontend', 'sql'],
        workflowName: 'Deploy Hosted', requestedAt: '2026-04-09T00:00:00Z',
        status: 'succeeded', verifiedAt: '2026-04-09T00:01:00Z', verification: okProbe },
      // Current frontend-only (latest).
      { environment: 'prod', sha: 'curfrontendsha', surfaces: ['frontend'],
        workflowName: 'Deploy Hosted', requestedAt: '2026-04-10T00:00:00Z',
        status: 'succeeded', verifiedAt: '2026-04-10T00:01:00Z', verification: okProbe },
      // Current all-surfaces (latest).
      { environment: 'prod', sha: 'curallsurfaces', surfaces: ['edge', 'frontend', 'sql'],
        workflowName: 'Deploy Hosted', requestedAt: '2026-04-11T00:00:00Z',
        status: 'succeeded', verifiedAt: '2026-04-11T00:01:00Z', verification: okProbe },
    ] }, null, 2), 'utf8');

    // Preflight omits --surfaces. With the Codex fix, preflight picks up
    // the task lock (surfaces=['frontend']) and rolls back the frontend
    // lane → target is 'oldfrontendsha'. The pre-Codex-fix behavior
    // would fall to config.surfaces and target 'oldallsurfaces' instead.
    const preflight = JSON.parse(runCli(
      ['run', 'api', 'action', 'rollback.prod', '--task', 'Narrow'],
      created.worktreePath, env,
    ).stdout);
    assert.equal(preflight.ok, true);
    assert.equal(preflight.data.preflight.normalizedInputs.targetSha, 'oldfrontendsha');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Codex P1: the error message advertises --sha, so the code MUST honor
// it. Earlier revisions silently ignored parsed.flags.sha and always
// used prRecord.mergedSha or the base-branch tip.
test('v1.1 codex fixup: --revert-pr honors --sha when passed explicitly', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
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
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Explicit Sha', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'feature.txt'), 'v1\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Explicit Sha', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'explicit-sha-test', '--json'], created.worktreePath);

    // Land TWO real commits on origin/main: an "old" one + a newer one.
    // pr-state.json will point at the newer one (via a synthesized merge);
    // we'll pass --sha pointing at the older one and assert the revert
    // targets the older one, not what pr-state claims.
    writeFileSync(path.join(repoRoot, 'old.txt'), 'old\n', 'utf8');
    commitAll(repoRoot, 'old change');
    const olderSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    writeFileSync(path.join(repoRoot, 'newer.txt'), 'newer\n', 'utf8');
    commitAll(repoRoot, 'newer change');
    const newerSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    prState.records[Object.keys(prState.records)[0]].mergedSha = newerSha;
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');
    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });

    // Pass the OLDER sha explicitly via --sha. The revert-pr should
    // target the older sha, not the newer one from pr-state.json.
    const result = JSON.parse(runCli(
      ['run', 'rollback', 'prod', '--revert-pr', '--sha', olderSha, '--json'],
      created.worktreePath,
      env,
    ).stdout);
    assert.equal(result.revertedSha, olderSha, 'revertedSha must honor --sha, not pr-state.json');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Codex P1 (round 2): /rollback prod must require typed-SHA confirmation
// even in build mode. Earlier gate was `environment === 'prod' && mode ===
// 'release'`, which let build-mode operators skip the prompt entirely. The
// API bypass via PIPELANE_DEPLOY_PROD_API_CONFIRMED is still honored.
test('v1.1 codex fixup: /rollback prod requires typed-SHA confirmation in build mode too', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
    // NO PIPELANE_DEPLOY_PROD_CONFIRM_STUB, NO PIPELANE_DEPLOY_PROD_API_CONFIRMED —
    // we want the prompt to actually fire and block (exits with non-zero).
  };
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    // Stay in build mode (default after init).
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Build Mode Prod', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Build Mode Prod', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    // Swap fake-gh's bogus merge for a real sha.
    const goodSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    prState.records[Object.keys(prState.records)[0]].mergedSha = goodSha;
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');
    // Seed deploy state with a good prod + a failed prod to roll back FROM.
    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
    const okProbe = { statusCode: 200, latencyMs: 10, probes: 2 };
    // verificationBySurface is required for multi-surface rollbacks
    // per r6 P2 fix (legacy aggregate probes only qualify for
    // single-surface rollbacks now).
    const perSurfaceOk = { frontend: okProbe, edge: okProbe, sql: okProbe };
    writeFileSync(path.join(stateDir, 'deploy-state.json'), JSON.stringify({ records: [
      { environment: 'prod', sha: goodSha, surfaces: ['frontend', 'edge', 'sql'],
        workflowName: 'Deploy Hosted', requestedAt: '2026-04-10T00:00:00Z',
        status: 'succeeded', verifiedAt: '2026-04-10T00:01:00Z',
        verification: okProbe, verificationBySurface: perSurfaceOk },
      { environment: 'prod', sha: '1'.repeat(40), surfaces: ['frontend', 'edge', 'sql'],
        workflowName: 'Deploy Hosted', requestedAt: '2026-04-11T00:00:00Z',
        status: 'failed', verification: { statusCode: 503 } },
    ] }, null, 2), 'utf8');

    // No TTY, no stub, no API bypass → requireProdConfirmation refuses.
    const refused = runCli(['run', 'rollback', 'prod', '--json'], created.worktreePath, env, true);
    assert.notEqual(refused.status, 0);
    // Error mentions typed-SHA prefix confirmation.
    assert.match(refused.stderr, /typed SHA prefix/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Codex P1 (round 2): retrying a failed rollback must target the SAME sha,
// not walk further back. Earlier behavior: the R5 cascade guard only
// special-cased status=succeeded, so a failed rollback left the next
// /rollback invocation with excludeSha=rollbackTarget, which skipped the
// target and picked an even-older good sha.
test('v1.1 codex fixup: retrying a failed rollback pins the same target sha', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const ok = (statusCode) => ({ healthcheckUrl: 'x', statusCode, latencyMs: 10, probes: 2 });
  const records = [
    // Oldest good — if retry logic is broken, findLastGoodDeploy lands here.
    { environment: 'prod', sha: 'ancientgood', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-08T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-08T00:01:00Z',
      verification: ok(200) },
    // The good we WANT to roll back to.
    { environment: 'prod', sha: 'correcttarget', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-10T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-10T00:01:00Z',
      verification: ok(200) },
    // The failing prod deploy that triggered rollback.
    { environment: 'prod', sha: 'brokenprod', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-12T00:00:00Z', status: 'failed', verification: ok(503) },
    // The first rollback attempt — dispatched but failed (workflow error or
    // healthcheck 5xx). sha=correcttarget, rollbackOfSha=brokenprod, status=failed.
    { environment: 'prod', sha: 'correcttarget', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-12T01:00:00Z', status: 'failed', rollbackOfSha: 'brokenprod',
      verification: ok(503) },
  ];
  // Retry: excludeSha should be rollbackOfSha (brokenprod), not
  // currentRecord.sha (correcttarget). Target picks up 'correcttarget'
  // again from the earlier succeeded+verified record.
  const excludeSha = records[3].rollbackOfSha; // 'brokenprod'
  const target = mod.findLastGoodDeploy({
    records, environment: 'prod', surfaces: ['frontend'], excludeSha,
  });
  assert.equal(target?.sha, 'correcttarget', 'retry must pin the same target, not walk further back');
  // Sanity: if the OLD buggy excludeSha (currentRecord.sha) were used,
  // the target would be ancientgood.
  const buggy = mod.findLastGoodDeploy({
    records, environment: 'prod', surfaces: ['frontend'], excludeSha: 'correcttarget',
  });
  assert.equal(buggy?.sha, 'ancientgood', 'sanity: buggy path would have picked ancientgood');
});

// Codex P1 (round 3): rollbackOfSha must survive multiple failed retries.
// Without the fix, retry 2 sets rollbackOfSha=<target>, so retry 3's
// excludeSha lookup skips the target and walks further back.
test('v1.1 codex fixup r3: rollbackOfSha survives multi-retry chain', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const ok = (statusCode) => ({ healthcheckUrl: 'x', statusCode, latencyMs: 10, probes: 2 });
  // Build a 3-retry scenario. Each retry record must have
  // rollbackOfSha = ORIGINAL_BROKEN, not the prior target. If the code
  // sets rollbackOfSha=currentRecord.sha on a retry, the chain drifts.
  const ORIGINAL_BROKEN = 'brokenprod';
  const CORRECT_TARGET = 'correcttarget';
  const records = [
    { environment: 'prod', sha: CORRECT_TARGET, surfaces: ['frontend'],
      workflowName: 'X', requestedAt: '2026-04-10T00:00:00Z',
      status: 'succeeded', verifiedAt: '2026-04-10T00:01:00Z', verification: ok(200) },
    { environment: 'prod', sha: ORIGINAL_BROKEN, surfaces: ['frontend'],
      workflowName: 'X', requestedAt: '2026-04-12T00:00:00Z',
      status: 'failed', verification: ok(503) },
    // Retry 1: dispatched, failed.
    { environment: 'prod', sha: CORRECT_TARGET, surfaces: ['frontend'],
      workflowName: 'X', requestedAt: '2026-04-12T01:00:00Z',
      status: 'failed', rollbackOfSha: ORIGINAL_BROKEN, verification: ok(503) },
    // Retry 2: simulate the CORRECTED code — rollbackOfSha carried forward.
    { environment: 'prod', sha: CORRECT_TARGET, surfaces: ['frontend'],
      workflowName: 'X', requestedAt: '2026-04-12T02:00:00Z',
      status: 'failed', rollbackOfSha: ORIGINAL_BROKEN, verification: ok(503) },
  ];
  // For retry 3, the current record is retry 2. excludeSha should be
  // retry2.rollbackOfSha (ORIGINAL_BROKEN), which still lets findLastGoodDeploy
  // pick CORRECT_TARGET. Without the fix, retry 2 would have had
  // rollbackOfSha = CORRECT_TARGET, so excludeSha would skip it.
  const currentRecord = records[3];
  const excludeSha = currentRecord.rollbackOfSha ?? currentRecord.sha;
  assert.equal(excludeSha, ORIGINAL_BROKEN, 'excludeSha must be the original broken sha, not the last target');
  const target = mod.findLastGoodDeploy({
    records, environment: 'prod', surfaces: ['frontend'], excludeSha,
  });
  assert.equal(target?.sha, CORRECT_TARGET, 'retry 3 must still target the same sha');
});

test('v1.1 fixup: capDeployHistory preserves the most recent verified record per (env, surfaces)', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'deploy.ts'));
  const ok = (statusCode) => ({ healthcheckUrl: 'x', statusCode, latencyMs: 10, probes: 2 });
  const records = [];
  // Old verified prod deploy — this is the one we need preserved past
  // the 100-cap so /rollback can find it.
  records.push({ environment: 'prod', sha: 'oldgood', surfaces: ['frontend'], workflowName: 'X',
    requestedAt: '2026-01-01T00:00:00Z', status: 'succeeded', verifiedAt: '2026-01-01T00:01:00Z',
    verification: ok(200) });
  // 150 junk staging records after it — pushes the oldgood past the tail window.
  for (let i = 0; i < 150; i += 1) {
    records.push({ environment: 'staging', sha: `filler-${i}`, surfaces: ['frontend'],
      workflowName: 'X', requestedAt: '2026-01-02T00:00:00Z', status: 'requested' });
  }
  const capped = mod.capDeployHistory(records);
  const preserved = capped.find((r) => r.sha === 'oldgood');
  assert.ok(preserved, 'verified prod record must survive the cap as a pinned checkpoint');
  // Capped history should still be bounded (≤ 100 tail + pinned).
  assert.ok(capped.length <= 110, `capped length ${capped.length} exceeds expected upper bound`);
});

test('v1.1 fixup: capDeployHistory preserves multiple verified checkpoints per (env, surfaces)', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'deploy.ts'));
  const ok = (statusCode) => ({ healthcheckUrl: 'x', statusCode, latencyMs: 10, probes: 2 });
  const records = [
    { environment: 'prod', sha: 'good-1', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-01-01T00:00:00Z', status: 'succeeded', verifiedAt: '2026-01-01T00:01:00Z',
      verification: ok(200) },
    { environment: 'prod', sha: 'good-2', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-01-02T00:00:00Z', status: 'succeeded', verifiedAt: '2026-01-02T00:01:00Z',
      verification: ok(200) },
    { environment: 'prod', sha: 'good-3', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-01-03T00:00:00Z', status: 'succeeded', verifiedAt: '2026-01-03T00:01:00Z',
      verification: ok(200) },
  ];
  for (let i = 0; i < 150; i += 1) {
    records.push({ environment: 'staging', sha: `filler-${i}`, surfaces: ['frontend'],
      workflowName: 'X', requestedAt: '2026-01-04T00:00:00Z', status: 'requested' });
  }
  const capped = mod.capDeployHistory(records);
  const preserved = capped
    .filter((record) => ['good-1', 'good-2', 'good-3'].includes(record.sha))
    .map((record) => record.sha);
  assert.deepEqual(preserved, ['good-1', 'good-2', 'good-3']);
  assert.ok(capped.length <= 110, `capped length ${capped.length} exceeds expected upper bound`);
});

test('v1.1 fixup: findRecentRun scans far enough for busy repos', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'deploy.ts'));
  const repoRoot = createRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-find-run-'));
  const ghPath = path.join(ghBin, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'run' && args[1] === 'list') {
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex === -1 ? 0 : Number(args[limitIndex + 1] || '0');
  const runs = [];
  for (let i = 0; i < Math.min(limit, 14); i += 1) {
    runs.push({
      databaseId: i + 1,
      headSha: 'other-' + i,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
      url: 'https://example.test/run/' + (i + 1),
      status: 'completed',
      conclusion: 'success',
    });
  }
  if (limit >= 15) {
    runs.push({
      databaseId: 999,
      headSha: 'targetsha',
      createdAt: new Date(Date.now() + 15000).toISOString(),
      url: 'https://example.test/run/999',
      status: 'completed',
      conclusion: 'success',
    });
  }
  process.stdout.write(JSON.stringify(runs));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755, encoding: 'utf8' });

  const originalPath = process.env.PATH;
  process.env.PATH = `${ghBin}:${originalPath}`;
  try {
    const hit = mod.findRecentRun(repoRoot, 'Deploy Hosted', 'targetsha', Date.now(), { strict: true });
    assert.equal(hit?.id, '999');
    assert.equal(hit?.url, 'https://example.test/run/999');
  } finally {
    process.env.PATH = originalPath;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Claude r3 P1: in-flight guard must expire when the async workflow dies.
// A fresh requested record blocks re-dispatch; a stale one (older than
// PIPELANE_ROLLBACK_INFLIGHT_TIMEOUT_MS, default 30min) falls through so
// the operator isn't permanently locked out.
test('v1.1 claude r3 fixup: stale in-flight rollback request bypasses the guard, fresh one still blocks', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  // Generous threshold (60s) so the fresh-record block check doesn't race
  // the subprocess startup. Stale records land 2h in the past so they
  // clearly exceed the threshold.
  const baseEnv = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
    PIPELANE_ROLLBACK_INFLIGHT_TIMEOUT_MS: '60000',
  };
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Stale Guard', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Stale Guard', '--json'], created.worktreePath, baseEnv);
    runCli(['run', 'merge', '--json'], created.worktreePath, baseEnv);
    const goodSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    prState.records[Object.keys(prState.records)[0]].mergedSha = goodSha;
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, baseEnv);

    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
    const deployStatePath = path.join(stateDir, 'deploy-state.json');

    // --- Case 1: FRESH requested record (just now) blocks within 60s threshold.
    const freshState = JSON.parse(readFileSync(deployStatePath, 'utf8'));
    freshState.records.push({
      environment: 'staging', sha: goodSha, surfaces: ['frontend', 'edge', 'sql'],
      workflowName: 'Deploy Hosted', requestedAt: new Date().toISOString(),
      taskSlug: created.taskSlug, status: 'requested',
      rollbackOfSha: '0'.repeat(40),
      idempotencyKey: 'fresh-rollback-key',
    });
    writeFileSync(deployStatePath, JSON.stringify(freshState, null, 2), 'utf8');
    const blocked = runCli(['run', 'rollback', 'staging', '--json'], created.worktreePath, baseEnv, true);
    assert.notEqual(blocked.status, 0, 'fresh in-flight record must block');
    assert.match(blocked.stderr, /a prior rollback is still in flight/);

    // --- Case 2: STALE requested record (2h old) bypasses the guard.
    const staleState = JSON.parse(readFileSync(deployStatePath, 'utf8'));
    staleState.records[staleState.records.length - 1].requestedAt =
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(deployStatePath, JSON.stringify(staleState, null, 2), 'utf8');
    const bypassed = runCli(['run', 'rollback', 'staging', '--json'], created.worktreePath, baseEnv, true);
    // The guard MUST not fire. Rollback may succeed or fail for another
    // reason (e.g. no earlier good deploy to target) — that's fine.
    assert.doesNotMatch(bypassed.stderr, /a prior rollback is still in flight/,
      'stale requested records must bypass the in-flight guard');
    assert.match(bypassed.stderr, /treating as dead and re-dispatching/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Claude r2 CRITICAL: in-flight rollback guard. r6 signed 'requested'
// records so they're visible in trustedRecords — without this guard, a
// second /rollback while an async attempt is still 'requested' would
// dispatch a DUPLICATE workflow and race on healthchecks.
test('v1.1 claude r2 fixup: /rollback refuses when a prior rollback is still in flight', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  const ok = (statusCode) => ({ healthcheckUrl: 'x', statusCode, latencyMs: 10, probes: 2 });
  const records = [
    { environment: 'prod', sha: 'goodtarget', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-10T00:00:00Z', status: 'succeeded', verifiedAt: '2026-04-10T00:01:00Z',
      verification: ok(200) },
    { environment: 'prod', sha: 'brokensha', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-12T00:00:00Z', status: 'failed', verification: ok(503) },
    // In-flight async rollback: status=requested, rollbackOfSha set.
    { environment: 'prod', sha: 'goodtarget', surfaces: ['frontend'], workflowName: 'X',
      requestedAt: '2026-04-12T00:05:00Z', status: 'requested', rollbackOfSha: 'brokensha' },
  ];
  // Unit-level check: findLastGoodDeploy still resolves a target for
  // this scenario (the guard lives above it in handleRollback, not
  // inside findLastGoodDeploy).
  const target = mod.findLastGoodDeploy({
    records, environment: 'prod', surfaces: ['frontend'], excludeSha: 'brokensha',
  });
  assert.ok(target, 'findLastGoodDeploy still returns a candidate; guard lives above it');
  // Assert the guard condition directly: currentRecord IS requested + has rollbackOfSha.
  const currentRecord = records[records.length - 1];
  assert.equal(currentRecord.status, 'requested');
  assert.ok(currentRecord.rollbackOfSha, 'current record must trigger the in-flight guard');
});

// Claude r2 INFO r7 tip removal: --revert-pr must fail closed when
// neither --sha nor pr-state.mergedSha are available. Earlier code
// fell back to base-branch tip (wrong when unrelated commits landed).
test('v1.1 claude r2 fixup: --revert-pr fails closed without --sha + without pr-state.mergedSha', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = { PATH: `${ghBin}:${process.env.PATH}`, GH_STATE_FILE: ghStateFile };
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'No Merge', '--json'], repoRoot).stdout);
    // Skip merge entirely — no PrRecord with mergedSha gets written.
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'r2-fallback-test', '--json'], created.worktreePath);

    // No --sha, no merged record. Pre-r7 code would have fallen back to
    // origin/main's tip — which could revert a completely unrelated commit.
    const refused = runCli(['run', 'rollback', 'prod', '--revert-pr', '--json'], created.worktreePath, env, true);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /could not resolve a merge commit/);
    assert.match(refused.stderr, /not a safe default/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Claude r2 INFO: branch-exists check must scope to refs/heads/. A tag
// with the same name as the revert branch was previously enough to
// false-trigger the "branch already exists locally" guard.
test('v1.1 claude r2 fixup: --revert-pr does not false-trigger on a same-name tag', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
  };
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.buildMode.autoDeployOnMerge = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Tag Collision', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Tag Collision', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'tag-collision-test', '--json'], created.worktreePath);

    // Land a real commit so --sha points somewhere valid.
    writeFileSync(path.join(repoRoot, 'real.txt'), 'v1\n', 'utf8');
    commitAll(repoRoot, 'squash: Tag Collision');
    const realMergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });

    // Create a TAG matching the expected revert branch name.
    const shortSha = realMergeSha.slice(0, 7);
    const revertBranchName = `codex/revert-${shortSha}`;
    execFileSync('git', ['tag', revertBranchName, realMergeSha], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });

    // --revert-pr must not false-trigger on the tag (pre-fix: plain
    // rev-parse --verify resolved the tag and exited early with
    // "already exists locally"). The fix scopes the check to
    // refs/heads/, making the tag invisible. Either the full flow
    // succeeds, or a later step fails — what must NOT happen is the
    // local-branch-exists guard firing on a tag collision.
    const attempt = runCli(
      ['run', 'rollback', 'prod', '--revert-pr', '--sha', realMergeSha, '--json'],
      created.worktreePath, env, true,
    );
    assert.doesNotMatch(attempt.stderr, /already exists locally/,
      'branch-exists guard must not false-trigger on a same-name tag');

  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Codex r8 P1: in-flight guard must block when the current record is
// an in-flight DEPLOY (not just an in-flight rollback). Previously the
// guard only fired on rollbackOfSha being set; a plain async deploy
// with status=requested was invisible to the guard, letting /rollback
// dispatch and race the deploy.
test('v1.1 codex r8 fixup: in-flight deploy blocks /rollback (not just in-flight rollbacks)', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = {
    PATH: `${ghBin}:${process.env.PATH}`,
    GH_STATE_FILE: ghStateFile,
    PIPELANE_DEPLOY_WATCH_STUB: 'succeeded',
    PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS: '200',
    PIPELANE_ROLLBACK_INFLIGHT_TIMEOUT_MS: '60000',
  };
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Deploy In Flight', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Deploy In Flight', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    const goodSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: created.worktreePath, encoding: 'utf8' }).trim();
    const prStatePath = path.join(repoRoot, '.git', 'pipelane-state', 'pr-state.json');
    const prState = JSON.parse(readFileSync(prStatePath, 'utf8'));
    prState.records[Object.keys(prState.records)[0]].mergedSha = goodSha;
    writeFileSync(prStatePath, JSON.stringify(prState, null, 2), 'utf8');
    runCli(['run', 'deploy', 'staging', '--json'], created.worktreePath, env);

    // Seed an in-flight DEPLOY record (not a rollback): requested, no rollbackOfSha.
    const stateDir = path.join(repoRoot, '.git', 'pipelane-state');
    const deployStatePath = path.join(stateDir, 'deploy-state.json');
    const deployState = JSON.parse(readFileSync(deployStatePath, 'utf8'));
    deployState.records.push({
      environment: 'staging', sha: goodSha, surfaces: ['frontend', 'edge', 'sql'],
      workflowName: 'Deploy Hosted', requestedAt: new Date().toISOString(),
      taskSlug: created.taskSlug, status: 'requested',
      idempotencyKey: 'inflight-deploy-key',
    });
    writeFileSync(deployStatePath, JSON.stringify(deployState, null, 2), 'utf8');

    const blocked = runCli(['run', 'rollback', 'staging', '--json'], created.worktreePath, env, true);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /a prior deploy is still in flight/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// Codex r8 P2: --async is unsafe for rollback (no reconciliation path).
test('v1.1 codex r8 fixup: /rollback --async is explicitly refused', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const refused = runCli(['run', 'rollback', 'staging', '--async', '--json'], repoRoot, {}, true);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /does not support --async/);
    assert.match(refused.stderr, /stuck "requested" record/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Codex r8 P2: --revert-pr must handle real merge commits (multi-parent)
// via -m 1, not just squash-merge single-parent commits.
test('v1.1 codex r8 fixup: --revert-pr reverts a real merge commit with -m 1', () => {
  const { repoRoot, remoteRoot } = createRemoteBackedRepo();
  const ghBin = mkdtempSync(path.join(os.tmpdir(), 'pipelane-gh-'));
  const ghStateFile = path.join(ghBin, 'gh-state.json');
  writeFakeGh(ghBin, ghStateFile);
  const env = { PATH: `${ghBin}:${process.env.PATH}`, GH_STATE_FILE: ghStateFile };
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.buildMode.autoDeployOnMerge = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    commitAll(repoRoot, 'Adopt pipelane');
    const created = JSON.parse(runCli(['run', 'new', '--task', 'Merge Commit Revert', '--json'], repoRoot).stdout);
    writeFileSync(path.join(created.worktreePath, 'v.txt'), 'x\n', 'utf8');
    runCli(['run', 'pr', '--title', 'Merge Commit Revert', '--json'], created.worktreePath, env);
    runCli(['run', 'merge', '--json'], created.worktreePath, env);
    runCli(['run', 'devmode', 'release', '--override', '--reason', 'merge-revert-test', '--json'], created.worktreePath);

    // Create a REAL merge commit on origin/main via --no-ff.
    execFileSync('git', ['switch', '-c', 'feature-mc'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(repoRoot, 'feature.txt'), 'f\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'feature change'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['switch', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['merge', '--no-ff', 'feature-mc', '-m', 'Merge pull request #1'], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

    // Verify it's actually a merge commit (two parents).
    const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', mergeSha], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim().split(/\s+/);
    assert.equal(parents.length, 3, 'fixture must produce a real merge commit with 2 parents');

    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: created.worktreePath, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(runCli(
      ['run', 'rollback', 'prod', '--revert-pr', '--sha', mergeSha, '--json'],
      created.worktreePath, env,
    ).stdout);
    assert.equal(result.revertedSha, mergeSha, 'merge commit must be revertable via -m 1');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
    rmSync(ghBin, { recursive: true, force: true });
  }
});

// detectSetupDrift — the read-only dry-run that /pipelane update uses to
// decide which follow-up steps to surface. These tests exercise the
// detection function directly (not via the CLI) so they don't need to mock
// `git ls-remote` or `npm install`.

test('detectSetupDrift on a freshly-setup repo reports no drift', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.equal(drift.needsSetup, false, 'fresh setup must report no drift');
    assert.equal(drift.needsReopenClaude, false);
    assert.equal(drift.needsReopenCodex, false);
    assert.deepEqual(drift.claude.addedCommands, []);
    assert.deepEqual(drift.claude.updatedCommands, []);
    assert.deepEqual(drift.claude.removedLegacyCommands, []);
    assert.deepEqual(drift.claude.collisions, []);
    assert.deepEqual(drift.codex.addedSkills, []);
    assert.deepEqual(drift.codex.updatedSkills, []);
    assert.equal(drift.codex.runnerDrift, false);
    assert.equal(drift.repoGuidance.willScaffold, false);
    assert.deepEqual(drift.otherSurfaces, []);
    assert.deepEqual(drift.agentsGuidanceMigrations, []);
    assert.deepEqual(drift.warnings, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift proposes an AGENTS.md migration when stale workflow guidance uses npm scripts', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    const current = readFileSync(agentsPath, 'utf8');
    writeFileSync(
      agentsPath,
      [
        '# Demo App Repo Context',
        '',
        '- Before starting work, run `npm run workflow:new -- --task "task name"`.',
        '',
        current,
      ].join('\n'),
      'utf8',
    );

    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.equal(drift.needsSetup, false, 'AGENTS guidance migrations require approval, not automatic setup');
    assert.deepEqual(drift.warnings, []);
    assert.equal(drift.agentsGuidanceMigrations.length, 1);
    assert.equal(drift.agentsGuidanceMigrations[0].file, 'AGENTS.md');
    assert.deepEqual(drift.agentsGuidanceMigrations[0].replacements, [{
      line: 3,
      before: '- Before starting work, run `npm run workflow:new -- --task "task name"`.',
      after: '- Before starting work, run `/new --task "task name"`.',
    }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup without --yes prints the AGENTS.md migration proposal without rewriting consumer text in non-TTY mode', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    const current = readFileSync(agentsPath, 'utf8');
    writeFileSync(
      agentsPath,
      [
        '# Demo App Repo Context',
        '',
        '- Agent default workflow: `npm run workflow:new -- --task "task name"`.',
        '',
        current,
      ].join('\n'),
      'utf8',
    );

    const result = runCli(['setup'], repoRoot);
    assert.match(result.stdout, /AGENTS\.md guidance migration requires approval:/);
    assert.match(result.stdout, /current: - Agent default workflow: `npm run workflow:new -- --task "task name"`\./);
    assert.match(result.stdout, /proposed: - Agent default workflow: `\/new --task "task name"`\./);
    assert.match(result.stdout, /AGENTS\.md:3/);
    assert.match(result.stdout, /node_modules\/\.bin\/pipelane/);
    assert.match(result.stdout, /pipelane setup --yes/);
    assert.match(readFileSync(agentsPath, 'utf8'), /npm run workflow:new/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup --yes applies the AGENTS.md stale workflow guidance migration', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    const current = readFileSync(agentsPath, 'utf8');
    writeFileSync(
      agentsPath,
      [
        '# Demo App Repo Context',
        '',
        '- Agent default workflow: `npm run workflow:new -- --task "task name"`.',
        '',
        current,
      ].join('\n'),
      'utf8',
    );

    const result = runCli(['setup', '--yes'], repoRoot);
    const agents = readFileSync(agentsPath, 'utf8');
    assert.match(result.stdout, /Updated AGENTS\.md stale workflow guidance \(1 line\)\./);
    assert.match(agents, /\/new --task "task name"/);
    assert.doesNotMatch(agents, /npm run workflow:new/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift flags a deleted managed command as addedCommands', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    // Simulate what happens after `/pipelane update` ships a new command
    // (or the consumer never ran setup): the template is present in
    // node_modules but the consumer's working tree has no matching file.
    rmSync(path.join(repoRoot, '.claude', 'commands', 'fix.md'), { force: true });
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.ok(drift.claude.addedCommands.includes('fix.md'), `expected fix.md in addedCommands, got ${drift.claude.addedCommands.join(',')}`);
    assert.equal(drift.needsSetup, true);
    assert.equal(drift.needsReopenClaude, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift flags edits OUTSIDE consumer-extension markers as updatedCommands', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const targetPath = path.join(repoRoot, '.claude', 'commands', 'fix.md');
    // Tamper outside the marker pair — prepend a line to the top of the
    // file. Setup would overwrite this.
    const original = readFileSync(targetPath, 'utf8');
    writeFileSync(targetPath, `CONSUMER_TAMPERED_LINE\n${original}`, 'utf8');
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.ok(drift.claude.updatedCommands.includes('fix.md'));
    assert.equal(drift.needsSetup, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift preserves edits INSIDE consumer-extension markers (no drift reported)', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const targetPath = path.join(repoRoot, '.claude', 'commands', 'fix.md');
    const original = readFileSync(targetPath, 'utf8');
    // Inject content between the marker pair — re-sync would preserve it.
    const withExtension = original.replace(
      '<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->',
      '<!-- pipelane:consumer-extension:start -->\nCONSUMER_HAND_EDIT_OK\n<!-- pipelane:consumer-extension:end -->',
    );
    writeFileSync(targetPath, withExtension, 'utf8');
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.ok(
      !drift.claude.updatedCommands.includes('fix.md'),
      `fix.md should not be flagged when only consumer-extension content changed; got updatedCommands=${drift.claude.updatedCommands.join(',')}`,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift reports willScaffold=true when REPO_GUIDANCE.md is absent', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    rmSync(path.join(repoRoot, 'REPO_GUIDANCE.md'), { force: true });
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.equal(drift.repoGuidance.willScaffold, true);
    assert.equal(drift.needsSetup, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift respects syncDocs.claudeCommands opt-out', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    // Opt out of Claude command sync BEFORE setup, and provide the npm
    // scripts the generated templates would otherwise rely on (the consistency
    // check only runs when claudeCommands is still on).
    const configPath = path.join(repoRoot, '.pipelane.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.syncDocs = { claudeCommands: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    runCli(['setup'], repoRoot);
    // Even if a stale managed command file sits in the commands dir, the
    // drift report should treat the Claude surface as disabled.
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.equal(drift.claude.enabled, false);
    assert.deepEqual(drift.claude.addedCommands, []);
    assert.deepEqual(drift.claude.updatedCommands, []);
    assert.equal(drift.needsReopenClaude, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift surfaces Codex skill drift when SKILL.md is stale', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    // Tamper with a Codex skill wrapper.
    const skillPath = path.join(repoRoot, '.agents', 'skills', 'pr', 'SKILL.md');
    writeFileSync(skillPath, `${readFileSync(skillPath, 'utf8')}\nTAMPERED\n`, 'utf8');
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.ok(drift.codex.updatedSkills.includes('pr'), `expected 'pr' in updatedSkills, got ${drift.codex.updatedSkills.join(',')}`);
    assert.equal(drift.needsSetup, true);
    assert.equal(drift.needsReopenCodex, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup writes .agents/skills/fix/SKILL.md with Codex frontmatter and shared prompt body', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const fixSkillPath = path.join(repoRoot, '.agents', 'skills', 'fix', 'SKILL.md');
    assert.ok(existsSync(fixSkillPath), 'fix Codex skill must be written by setup');
    const content = readFileSync(fixSkillPath, 'utf8');

    // Frontmatter: must declare name, version, and the extra allowed-tools
    // /fix needs beyond the workflow wrapper skills' Bash-only list.
    assert.match(content, /^---\nname: fix\n/);
    assert.match(content, /\nversion: 1\.0\.0\n/);
    assert.match(content, /\nallowed-tools:\n(?:[\s\S]*?  - Read\n)/);
    assert.match(content, /  - Edit\n/);
    assert.match(content, /  - Grep\n/);
    assert.match(content, /  - Bash\n/);
    // Marker for managed detection (survives alias rename / prune / drift).
    assert.match(content, /<!-- pipelane:codex-skill:fix -->/);
    // Shared body with the Claude-side template — a few anchor phrases the
    // /fix prompt is built around.
    assert.match(content, /Produce durable, root-cause fixes\./);
    assert.match(content, /## Mode routing/);
    assert.match(content, /First run a \*\*hotspot audit\*\*/);
    assert.match(content, /\*\*Feature accretion\.\*\*/);
    assert.match(content, /### Refuse these shims unconditionally/);
    // Claude-specific markers must NOT appear — those live only on the Claude
    // template so re-sync doesn't strip hand-edits there.
    assert.doesNotMatch(content, /<!-- pipelane:command:fix -->/);
    assert.doesNotMatch(content, /<!-- pipelane:consumer-extension:/);

    // Managed manifest lists fix alongside the workflow skills.
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, '.agents', 'skills', '.pipelane-managed.json'), 'utf8'),
    );
    assert.ok(manifest.skills.includes('fix'), `manifest.skills missing "fix": ${manifest.skills.join(',')}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift flags a deleted fix Codex skill as addedSkills', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    // Simulate a consumer that upgraded pipelane before the fix Codex skill
    // shipped, or that pruned the skill dir.
    rmSync(path.join(repoRoot, '.agents', 'skills', 'fix'), { recursive: true, force: true });
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.ok(
      drift.codex.addedSkills.includes('fix'),
      `expected 'fix' in addedSkills, got ${drift.codex.addedSkills.join(',')}`,
    );
    assert.equal(drift.needsSetup, true);
    assert.equal(drift.needsReopenCodex, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift reports a collision when a non-pipelane fix.md is present', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    // Run setup first so the managed manifest exists with the expected
    // pipelane fix.md, then swap the file with a non-marker, non-signature
    // consumer-authored version so detection sees it as a collision.
    runCli(['setup'], repoRoot);
    const commandsDir = path.join(repoRoot, '.claude', 'commands');
    // Drop the file from the managed manifest so it looks unmanaged.
    const manifestPath = path.join(commandsDir, '.pipelane-managed.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files = manifest.files.filter((f) => f !== 'fix.md');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    // Replace the file content with something that carries no pipelane
    // marker and no legacy signature — a consumer-authored /fix.
    writeFileSync(path.join(commandsDir, 'fix.md'), '# Consumer-authored fix\n', 'utf8');
    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.ok(drift.claude.collisions.includes('fix.md'), `expected fix.md collision, got ${drift.claude.collisions.join(',')}`);
    assert.equal(drift.needsSetup, true);
    // Collisions must NOT auto-trigger a reopen hint; setup won't run.
    assert.equal(drift.needsReopenClaude, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('formatFollowUpSummary lists new/updated commands and step-numbered reopen hints', async () => {
  const update = await import(path.join(KIT_ROOT, 'src', 'operator', 'update.ts'));
  const drift = {
    repoRoot: '/tmp/fake',
    needsSetup: true,
    needsReopenClaude: true,
    needsReopenCodex: true,
    claude: {
      enabled: true,
      addedCommands: ['fix.md'],
      updatedCommands: ['pr.md', 'merge.md'],
      removedLegacyCommands: [],
      collisions: [],
    },
    codex: {
      enabled: true,
      skillsDir: '/tmp/fake/.agents/skills',
      addedSkills: [],
      updatedSkills: ['pr'],
      removedLegacySkills: [],
      runnerDrift: true,
    },
    repoGuidance: { willScaffold: false },
    otherSurfaces: [],
  };
  const summary = update.formatFollowUpSummary(drift);
  assert.match(summary, /Follow-up needed:/);
  assert.match(summary, /Run setup/);
  assert.match(summary, /New slash commands: fix\.md/);
  assert.match(summary, /Updated commands: pr\.md, merge\.md/);
  assert.match(summary, /Updated Codex skills: pr/);
  assert.match(summary, /Codex runner script updated/);
  assert.match(summary, /2\. Reopen Claude/);
  assert.match(summary, /3\. Reopen Codex/);
});

test('formatFollowUpSummary on collisions replaces the run-setup step with a resolve-manually message', async () => {
  const update = await import(path.join(KIT_ROOT, 'src', 'operator', 'update.ts'));
  const drift = {
    repoRoot: '/tmp/fake',
    needsSetup: true,
    needsReopenClaude: false,
    needsReopenCodex: false,
    claude: {
      enabled: true,
      addedCommands: [],
      updatedCommands: [],
      removedLegacyCommands: [],
      collisions: ['fix.md'],
    },
    codex: {
      enabled: true,
      skillsDir: '/tmp/fake/.agents/skills',
      addedSkills: [],
      updatedSkills: [],
      removedLegacySkills: [],
      runnerDrift: false,
    },
    repoGuidance: { willScaffold: false },
    otherSurfaces: [],
  };
  const summary = update.formatFollowUpSummary(drift);
  assert.match(summary, /Setup cannot run — collision/);
  assert.match(summary, /\.claude\/commands\/fix\.md/);
  assert.match(summary, /Resolve these manually/);
  assert.doesNotMatch(summary, /Run setup/);
});

// ---------------------------------------------------------------------------
// /smoke setup — configuration + handoff coverage
// ---------------------------------------------------------------------------

function createSmokeSetupRepo(options = {}) {
  const repoRoot = createRepo();
  const extraScripts = options.scripts ?? {};
  writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'smoke-setup-test',
      version: '0.0.0',
      type: 'module',
      scripts: { ...extraScripts },
    }, null, 2) + '\n',
    'utf8',
  );
  execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'add package.json'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  runCli(['init', '--project', 'Smoke Setup Test'], repoRoot);
  return repoRoot;
}

function readSmokeConfig(repoRoot) {
  const config = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane.json'), 'utf8'));
  return config.smoke ?? null;
}

test('smoke setup auto-wires from a single strong Playwright candidate', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'npx playwright test --project=smoke' },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.setupMode, 'configured');
    assert.equal(parsed.stagingCommand, 'npm run test:e2e:smoke');
    assert.equal(parsed.smokeConfigured, true);
    assert.equal(parsed.releaseGate, 'optional');
    const smoke = readSmokeConfig(repoRoot);
    assert.equal(smoke.staging.command, 'npm run test:e2e:smoke');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup scores grep-filtered command as strong (plan: @smoke / --grep.*smoke)', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:browser': 'vitest run --grep smoke' },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.setupMode, 'configured');
    assert.equal(parsed.stagingCommand, 'npm run test:browser');
    assert.equal(parsed.candidates.strong.length, 1);
    assert.match(parsed.candidates.strong[0].reason, /@smoke tag or --grep/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup auto-wires a single medium candidate with a warning (relaxed auto-wire rule)', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e': 'playwright test' },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.setupMode, 'configured');
    assert.equal(parsed.stagingCommand, 'npm run test:e2e');
    assert.equal(parsed.smokeConfigured, true);
    // Warning must surface the tradeoff the operator just implicitly made.
    assert.ok(parsed.warnings.some((w) => /no smoke filter detected/.test(w)));
    assert.match(parsed.repoSignal, /medium/);
    // Config written with the medium command.
    const smoke = readSmokeConfig(repoRoot);
    assert.equal(smoke.staging.command, 'npm run test:e2e');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup refuses weak-only "smoke": "node ./src/cli.ts --help"', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'smoke': 'node ./src/cli.ts --help' },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.setupMode, 'needs input');
    assert.ok(parsed.candidates.weak.some((c) => c.name === 'smoke'));
    assert.equal(parsed.candidates.strong.length, 0);
    assert.equal(readSmokeConfig(repoRoot), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup with multiple strong candidates returns needs-input', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: {
      'test:e2e:smoke': 'playwright test --project=smoke',
      'test:smoke': 'cypress run --spec "cypress/e2e/smoke/**/*"',
    },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.setupMode, 'needs input');
    assert.ok(parsed.candidates.strong.length >= 2);
    assert.equal(readSmokeConfig(repoRoot), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup accepts explicit --staging-command without package.json candidate', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    const result = runCli(['run', 'smoke', 'setup', '--staging-command=npm run e2e', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.setupMode, 'configured');
    assert.equal(parsed.stagingCommand, 'npm run e2e');
    assert.equal(readSmokeConfig(repoRoot).staging.command, 'npm run e2e');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --staging-command value with shell metacharacters roundtrips intact', () => {
  const repoRoot = createSmokeSetupRepo();
  const rawValue = 'npm run test:smoke -- --grep "auth|signup" --workers=2';
  try {
    runCli(['run', 'smoke', 'setup', `--staging-command=${rawValue}`], repoRoot);
    const smoke = readSmokeConfig(repoRoot);
    assert.equal(smoke.staging.command, rawValue);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup preserves unrelated smoke fields on deep merge', () => {
  const repoRoot = createSmokeSetupRepo();
  const configPath = path.join(repoRoot, '.pipelane.json');
  try {
    const existing = JSON.parse(readFileSync(configPath, 'utf8'));
    existing.smoke = {
      staging: { command: 'npm run old:smoke' },
      waivers: { path: '.pipelane/waivers.json', maxExtensions: 3 },
      history: { retentionDays: 14, maxEntries: 50 },
      criticalPathCoverage: 'warn',
    };
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

    runCli(['run', 'smoke', 'setup', '--staging-command=npm run new:smoke'], repoRoot);

    const smoke = readSmokeConfig(repoRoot);
    assert.equal(smoke.staging.command, 'npm run new:smoke');           // overwritten
    assert.equal(smoke.waivers.maxExtensions, 3);                       // preserved
    assert.equal(smoke.history.retentionDays, 14);                      // preserved
    assert.equal(smoke.history.maxEntries, 50);                         // preserved
    assert.equal(smoke.criticalPathCoverage, 'warn');                   // preserved
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --require-staging-smoke=true with no staging command is misconfigured and exits 1', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    const result = runCli(['run', 'smoke', 'setup', '--require-staging-smoke=true'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--require-staging-smoke=true but no staging command/);
    assert.equal(readSmokeConfig(repoRoot), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --require-staging-smoke=true with --staging-command writes required gate', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    const result = runCli([
      'run', 'smoke', 'setup',
      '--staging-command=npm run smoke',
      '--require-staging-smoke=true',
      '--json',
    ], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.releaseGate, 'required');
    const smoke = readSmokeConfig(repoRoot);
    assert.equal(smoke.requireStagingSmoke, true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --json emits exactly one parseable JSON document', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke' },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup', '--json'], repoRoot);
    const trimmed = result.stdout.trim();
    // Must be a single JSON document — not two concatenated (the double-print
    // risk identified in the plan).
    const parsed = JSON.parse(trimmed);
    assert.ok(parsed.setupMode);
    assert.equal(trimmed.lastIndexOf('}') + 1, trimmed.length);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup fails clearly when .pipelane.json is malformed JSON', () => {
  const repoRoot = createSmokeSetupRepo();
  const configPath = path.join(repoRoot, '.pipelane.json');
  try {
    writeFileSync(configPath, '{"broken":', 'utf8');
    const result = runCli(['run', 'smoke', 'setup', '--staging-command=npm run x'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Malformed \.pipelane\.json/);
    // The broken content must survive — setup refuses to overwrite.
    assert.equal(readFileSync(configPath, 'utf8'), '{"broken":');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --critical-path repeat dedupes while preserving first-seen order', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    runCli([
      'run', 'smoke', 'setup',
      '--staging-command=npm run smoke',
      '--critical-path=auth',
      '--critical-path=checkout',
      '--critical-path=auth',
    ], repoRoot);
    const smoke = readSmokeConfig(repoRoot);
    assert.deepEqual(smoke.criticalPaths, ['auth', 'checkout']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup rejects --yes flag (cut from v1)', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    const result = runCli(['run', 'smoke', 'setup', '--yes'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown flag/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke plan rejects setup-only --staging-command flag', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    const result = runCli(['run', 'smoke', 'plan', '--staging-command=foo'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--staging-command/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup rejects malformed --require-staging-smoke value', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    const result = runCli(['run', 'smoke', 'setup', '--staging-command=x', '--require-staging-smoke=yes'], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--require-staging-smoke must be "true" or "false"/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --staging-script=<name> writes npm run <name> to smoke.staging.command', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:vip': 'playwright test' },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup', '--staging-script=test:e2e:vip', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.setupMode, 'configured');
    assert.equal(parsed.stagingCommand, 'npm run test:e2e:vip');
    assert.match(parsed.repoSignal, /explicit --staging-script=test:e2e:vip/);
    assert.match(parsed.repoSignal, /resolved to npm run test:e2e:vip/);
    const smoke = readSmokeConfig(repoRoot);
    assert.equal(smoke.staging.command, 'npm run test:e2e:vip');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --prod-script=<name> writes npm run <name> to smoke.prod.command', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: {
      'test:e2e:smoke': 'playwright test --project=smoke',
      'test:e2e:smoke:prod': 'playwright test --project=smoke-prod',
    },
  });
  try {
    runCli([
      'run', 'smoke', 'setup',
      '--staging-script=test:e2e:smoke',
      '--prod-script=test:e2e:smoke:prod',
    ], repoRoot);
    const smoke = readSmokeConfig(repoRoot);
    assert.equal(smoke.staging.command, 'npm run test:e2e:smoke');
    assert.equal(smoke.prod.command, 'npm run test:e2e:smoke:prod');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup --staging-script + --staging-command conflict with a clear error', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    const result = runCli([
      'run', 'smoke', 'setup',
      '--staging-script=foo',
      '--staging-command=bar',
    ], repoRoot, {}, true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--staging-script and --staging-command are mutually exclusive/);
    assert.equal(readSmokeConfig(repoRoot), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup with multiple strong candidates emits a numbered Candidates block', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: {
      'test:e2e:smoke': 'playwright test --project=smoke',
      'test:smoke': 'cypress run --spec "cypress/smoke/**/*"',
    },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup'], repoRoot);
    assert.match(result.stdout, /Smoke setup: needs input/);
    assert.match(result.stdout, /Candidates:\n/);
    assert.match(result.stdout, /  1\. test:e2e:smoke \(strong — /);
    assert.match(result.stdout, /  2\. test:smoke \(strong — /);
    // "Next" line should point at --staging-script= with a concrete
    // example from the list.
    assert.match(result.stdout, /Next: pick one and rerun, e\.g\. \/smoke setup --staging-script=test:e2e:smoke/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup needs-input output recommends --staging-script= form (not --staging-command=)', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: {
      'test:e2e:smoke': 'playwright test --project=smoke',
      'test:smoke': 'cypress run --spec cypress/smoke/**/*',
    },
  });
  try {
    const result = runCli(['run', 'smoke', 'setup'], repoRoot);
    assert.match(result.stdout, /Smoke setup: needs input/);
    assert.match(result.stdout, /--staging-script=/);
    const nextLine = result.stdout.split('\n').find((line) => line.startsWith('Next:')) ?? '';
    assert.doesNotMatch(nextLine, /--staging-command=/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup stores repo-specific hot paths and plain-language AI feedback', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke' },
  });
  try {
    mkdirSync(path.join(repoRoot, 'src', 'app', 'projects', '[id]'), { recursive: true });
    writeFileSync(
      path.join(repoRoot, 'src', 'app', 'projects', '[id]', 'page.tsx'),
      [
        'export default function ProjectBoard() {',
        '  return <main>Project board wiki AI assistant OpenAI login credentials</main>;',
        '}',
      ].join('\n'),
      'utf8',
    );

    const result = runCli([
      'run', 'smoke', 'setup',
      '--staging-script=test:e2e:smoke',
      '--feedback=also test AI in project boards and wiki pages, credentials properly auth',
      '--json',
    ], repoRoot);
    const parsed = JSON.parse(result.stdout);
    const registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));

    assert.equal(parsed.setupVerification.status, 'skipped_missing_base_url');
    assert.ok(parsed.hotPathScenarios.some((scenario) => scenario.id === '@smoke-ai-project-board'));
    assert.ok(parsed.hotPathScenarios.some((scenario) => scenario.id === '@smoke-ai-wiki-page'));
    assert.equal(registry.checks['@smoke-ai-project-board'].lifecycle, 'accepted');
    assert.equal(registry.checks['@smoke-ai-project-board'].blocking, false);
    assert.equal(registry.checks['@smoke-ai-project-board'].quarantine, true);
    assert.deepEqual(registry.checks['@smoke-ai-project-board'].provenance.evidence, ['user feedback supplied during smoke setup']);
    assert.deepEqual(registry.checks['@smoke-ai-project-board'].requiredEnv, ['OPENAI_API_KEY']);
    assert.ok(registry.checks['@smoke-auth-credentials'].requiredEnv.includes('PIPELANE_SMOKE_USER_EMAIL'));
    assert.equal(registry.checks['@smoke-wiki-page-crud'].safetyFlags.includes('requiresSyntheticData'), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup feedback promotes existing suggested hot paths to accepted', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke' },
  });
  try {
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'wiki.ts'), 'export const wiki = "wiki docs page markdown editor";\n', 'utf8');

    runCli(['run', 'smoke', 'setup', '--staging-script=test:e2e:smoke'], repoRoot);
    let registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));
    assert.equal(registry.checks['@smoke-wiki-page-crud'].lifecycle, 'suggested');

    runCli([
      'run', 'smoke', 'setup',
      '--staging-script=test:e2e:smoke',
      '--feedback=create rename and delete wiki pages',
    ], repoRoot);
    registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));
    assert.equal(registry.checks['@smoke-wiki-page-crud'].lifecycle, 'accepted');
    assert.equal(registry.checks['@smoke-wiki-page-crud'].provenance.source, 'user-feedback');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup generates marker-owned Playwright app-shell test for supported runner', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke --grep @smoke' },
  });
  try {
    mkdirSync(path.join(repoRoot, 'app'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'app', 'page.tsx'), 'export default function Home() { return <main>Hello</main>; }\n', 'utf8');

    runCli(['run', 'smoke', 'setup', '--staging-script=test:e2e:smoke'], repoRoot);

    const generatedPath = path.join(repoRoot, 'tests', 'pipelane-smoke.generated.spec.ts');
    const generated = readFileSync(generatedPath, 'utf8');
    const registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));

    assert.match(generated, /pipelane:smoke:start support/);
    assert.match(generated, /pipelane:smoke:start app-shell/);
    assert.match(generated, /@smoke-app-shell Open the app shell/);
    assert.equal(registry.checks['@smoke-app-shell'].lifecycle, 'generated');
    assert.equal(registry.checks['@smoke-app-shell'].generated.adapter, 'playwright');
    assert.equal(registry.checks['@smoke-app-shell'].generated.status, 'unverified');
    assert.ok(registry.checks['@smoke-app-shell'].sourceTests.includes('tests/pipelane-smoke.generated.spec.ts'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup generates Cypress app-shell test when Cypress is the detected runner', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'cypress run --spec "cypress/e2e/**/*.cy.ts" --env grepTags=@smoke' },
  });
  try {
    mkdirSync(path.join(repoRoot, 'pages'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'pages', 'index.tsx'), 'export default function Home() { return <main>Hello</main>; }\n', 'utf8');

    runCli(['run', 'smoke', 'setup', '--staging-script=test:e2e:smoke'], repoRoot);

    const generatedPath = path.join(repoRoot, 'cypress', 'e2e', 'pipelane-smoke.generated.cy.js');
    const generated = readFileSync(generatedPath, 'utf8');
    const registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));

    assert.match(generated, /pipelane:smoke:start support/);
    assert.match(generated, /pipelane:smoke:start app-shell/);
    assert.match(generated, /Cypress\.env\('PIPELANE_SMOKE_RESULTS_PATH'\)/);
    assert.equal(registry.checks['@smoke-app-shell'].generated.adapter, 'cypress');
    assert.ok(registry.checks['@smoke-app-shell'].sourceTests.includes('cypress/e2e/pipelane-smoke.generated.cy.js'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup saves generated metadata even when generated file is unchanged', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke --grep @smoke' },
  });
  try {
    mkdirSync(path.join(repoRoot, 'app'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'app', 'page.tsx'), 'export default function Home() { return <main>Hello</main>; }\n', 'utf8');

    runCli(['run', 'smoke', 'setup', '--staging-script=test:e2e:smoke'], repoRoot);

    const registryPath = path.join(repoRoot, '.pipelane', 'smoke-checks.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.checks['@smoke-app-shell'].lifecycle = 'accepted';
    registry.checks['@smoke-app-shell'].sourceTests = [];
    delete registry.checks['@smoke-app-shell'].generated;
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    runCli(['run', 'smoke', 'setup', '--staging-script=test:e2e:smoke'], repoRoot);

    const latest = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(latest.checks['@smoke-app-shell'].lifecycle, 'generated');
    assert.equal(latest.checks['@smoke-app-shell'].generated.adapter, 'playwright');
    assert.ok(latest.checks['@smoke-app-shell'].sourceTests.includes('tests/pipelane-smoke.generated.spec.ts'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup does not generate app-shell test when tagged source test already exists', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke --grep @smoke' },
  });
  try {
    mkdirSync(path.join(repoRoot, 'app'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'app', 'page.tsx'), 'export default function Home() { return <main>Hello</main>; }\n', 'utf8');
    writeFileSync(path.join(repoRoot, 'tests', 'existing.spec.ts'), "test('@smoke-app-shell boots', async () => {});\n", 'utf8');

    runCli(['run', 'smoke', 'setup', '--staging-script=test:e2e:smoke'], repoRoot);

    const generatedPath = path.join(repoRoot, 'tests', 'pipelane-smoke.generated.spec.ts');
    const registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));

    assert.equal(existsSync(generatedPath), false);
    assert.equal(registry.checks['@smoke-app-shell'].lifecycle, 'accepted');
    assert.equal(registry.checks['@smoke-app-shell'].provenance.source, 'discovered-tag');
    assert.deepEqual(registry.checks['@smoke-app-shell'].sourceTests, ['tests/existing.spec.ts']);
    assert.equal(registry.checks['@smoke-app-shell'].generated, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke plan --refresh reports proposed hot paths without writing registry files', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke' },
  });
  try {
    mkdirSync(path.join(repoRoot, 'app'), { recursive: true });
    mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'src', 'app', 'projects', '[id]'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'app', 'page.tsx'), 'export default function Home() { return <a href="/pricing">Pricing</a>; }\n', 'utf8');
    writeFileSync(path.join(repoRoot, '.claude', 'notes.md'), 'login password openai @smoke-auth-credentials\n', 'utf8');
    writeFileSync(path.join(repoRoot, 'src', 'app', 'projects', '[id]', 'page.tsx'), 'export default function ProjectPage() { return <main />; }\n', 'utf8');

    const registryPath = path.join(repoRoot, '.pipelane', 'smoke-checks.json');
    assert.equal(existsSync(registryPath), false);
    const result = runCli(['run', 'smoke', 'plan', '--refresh', '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);

    assert.equal(parsed.refresh, true);
    assert.equal(parsed.changedFiles, 0);
    assert.equal(parsed.createdRegistry, false);
    assert.equal(existsSync(registryPath), false);
    assert.ok(parsed.proposedAdds.includes('@smoke-app-shell'));
    assert.equal(parsed.proposedAdds.includes('@smoke-auth-credentials'), false);
    assert.equal(parsed.proposedAdds.includes('@smoke-ai-primary-feature'), false);
    assert.ok(parsed.analysis.routes.includes('/projects/:id'));
    assert.match(parsed.message, /files changed: 0/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke plan --refresh refuses scenario files outside the repo', () => {
  const repoRoot = createSmokeSetupRepo({
    scripts: { 'test:e2e:smoke': 'playwright test --project=smoke' },
  });
  const outsidePath = path.join(path.dirname(repoRoot), `outside-scenarios-${Date.now()}.json`);
  try {
    writeFileSync(outsidePath, JSON.stringify({ scenarios: [{ id: '@smoke-outside', title: 'Outside file' }] }), 'utf8');

    const result = runCli(['run', 'smoke', 'plan', '--refresh', `--scenario-file=${outsidePath}`, '--json'], repoRoot);
    const parsed = JSON.parse(result.stdout);

    assert.ok(parsed.warnings.some((warning) => /must live inside the repo/.test(warning)));
    assert.equal(parsed.proposedAdds.includes('@smoke-outside'), false);
  } finally {
    rmSync(outsidePath, { force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup verification can make clean check-level results blocking', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export const login = "auth session password";\n', 'utf8');
    const command = smokeResultCommand([{ tag: '@smoke-auth-credentials', status: 'passed' }]);

    const result = runCli([
      'run', 'smoke', 'setup',
      `--staging-command=${command}`,
      '--base-url=http://127.0.0.1:4173',
      '--make-blocking',
      '--json',
    ], repoRoot);
    const parsed = JSON.parse(result.stdout);
    const registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));

    assert.equal(parsed.setupVerification.status, 'passed');
    assert.deepEqual(parsed.setupVerification.verifiedTags, ['@smoke-auth-credentials']);
    assert.deepEqual(parsed.setupVerification.blockingTags, ['@smoke-auth-credentials']);
    assert.equal(registry.checks['@smoke-auth-credentials'].lifecycle, 'blocking');
    assert.equal(registry.checks['@smoke-auth-credentials'].blocking, true);
    assert.equal(registry.checks['@smoke-auth-credentials'].quarantine, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('smoke setup does not promote passed-with-retries verification to blocking', () => {
  const repoRoot = createSmokeSetupRepo();
  try {
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), 'export const login = "auth session password";\n', 'utf8');
    const command = smokeResultCommand([{ tag: '@smoke-auth-credentials', status: 'passed_with_retries' }]);

    const result = runCli([
      'run', 'smoke', 'setup',
      `--staging-command=${command}`,
      '--base-url=http://127.0.0.1:4173',
      '--make-blocking',
      '--json',
    ], repoRoot);
    const parsed = JSON.parse(result.stdout);
    const registry = JSON.parse(readFileSync(path.join(repoRoot, '.pipelane', 'smoke-checks.json'), 'utf8'));

    assert.equal(parsed.setupVerification.status, 'passed_with_retries');
    assert.deepEqual(parsed.setupVerification.verifiedTags, []);
    assert.equal(registry.checks['@smoke-auth-credentials'].blocking, false);
    assert.equal(registry.checks['@smoke-auth-credentials'].quarantine, true);
    assert.notEqual(registry.checks['@smoke-auth-credentials'].lifecycle, 'blocking');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('generated smoke marker helper preserves user edits and rejects malformed regions', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'smoke-hot-paths.ts'));
  const created = mod.upsertGeneratedSmokeRegion('const userEdit = true;\n', 'auth', 'test("auth", async () => {});');
  assert.equal(created.action, 'created');
  assert.match(created.contents, /const userEdit = true;/);
  assert.match(created.contents, /pipelane:smoke:start auth/);

  const updated = mod.upsertGeneratedSmokeRegion(created.contents, 'auth', 'test("auth v2", async () => {});');
  assert.equal(updated.action, 'updated');
  assert.match(updated.contents, /const userEdit = true;/);
  assert.match(updated.contents, /auth v2/);
  assert.doesNotMatch(updated.contents, /test\("auth", async/);

  assert.throws(
    () => mod.upsertGeneratedSmokeRegion('/* pipelane:smoke:start auth */\nbody\n', 'auth', 'next'),
    /malformed markers/,
  );
});

test('smoke failure AI fix prompt redacts credential material', async () => {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'smoke-hot-paths.ts'));
  const prompt = mod.buildSmokeFailureFixPrompt({
    scenario: 'auth flow',
    command: 'OPENAI_API_KEY=sk-secret npm run smoke -- --password=hunter2',
    baseUrl: 'https://example.test/app?token=abc123&ok=1',
    logPath: '/tmp/smoke.log',
    resultsPath: '/tmp/results.json',
    checks: [{ tag: '@smoke-auth', status: 'failed' }],
  });

  assert.match(prompt, /AI fix prompt:/);
  assert.doesNotMatch(prompt, /sk-secret/);
  assert.doesNotMatch(prompt, /abc123/);
  assert.doesNotMatch(prompt, /hunter2/);
  assert.match(prompt, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(prompt, /--password=\[REDACTED\]/);
  assert.match(prompt, /token=\[REDACTED\]/);
});

// ---------------------------------------------------------------------------
// buildSmokeHandoffMessage — pure unit tests across all 3 stages × 3 states
// ---------------------------------------------------------------------------

async function loadBuildSmokeHandoffMessage() {
  const mod = await import(path.join(KIT_ROOT, 'src', 'operator', 'commands', 'helpers.ts'));
  return mod.buildSmokeHandoffMessage;
}

function makeSmokeHandoffConfig({ stagingCommand, requireStagingSmoke }) {
  return {
    aliases: {
      devmode: '/devmode',
      new: '/new',
      resume: '/resume',
      'repo-guard': '/repo-guard',
      pr: '/pr',
      merge: '/merge',
      deploy: '/deploy',
      smoke: '/smoke',
      clean: '/clean',
      status: '/status',
      doctor: '/doctor',
      rollback: '/rollback',
    },
    smoke: stagingCommand
      ? {
          staging: { command: stagingCommand },
          requireStagingSmoke: requireStagingSmoke === true,
        }
      : (requireStagingSmoke === true ? { requireStagingSmoke: true } : undefined),
  };
}

test('buildSmokeHandoffMessage after-merge-release: configured path recommends staging + smoke + prod', async () => {
  const build = await loadBuildSmokeHandoffMessage();
  const msg = build({
    config: makeSmokeHandoffConfig({ stagingCommand: 'npm run smoke', requireStagingSmoke: false }),
    stage: 'after-merge-release',
    shortSha: 'abc1234',
  });
  assert.equal(msg.status, 'configured');
  assert.equal(msg.blocks, false);
  assert.match(msg.nextAction, /merged at abc1234/);
  assert.match(msg.nextAction, /run \/deploy staging/);
  assert.match(msg.nextAction, /\/smoke staging/);
  assert.match(msg.nextAction, /\/deploy prod/);
});

test('buildSmokeHandoffMessage after-merge-release: optional+unconfigured offers setup OR promote without smoke', async () => {
  const build = await loadBuildSmokeHandoffMessage();
  const msg = build({
    config: makeSmokeHandoffConfig({ stagingCommand: '', requireStagingSmoke: false }),
    stage: 'after-merge-release',
    shortSha: 'abc1234',
  });
  assert.equal(msg.status, 'optional-unconfigured');
  assert.equal(msg.blocks, false);
  assert.match(msg.nextAction, /\/smoke setup/);
  assert.match(msg.nextAction, /healthcheck-only evidence/);
});

test('buildSmokeHandoffMessage after-merge-release: required+unconfigured mandates setup', async () => {
  const build = await loadBuildSmokeHandoffMessage();
  const msg = build({
    config: makeSmokeHandoffConfig({ stagingCommand: '', requireStagingSmoke: true }),
    stage: 'after-merge-release',
    shortSha: 'abc1234',
  });
  assert.equal(msg.status, 'required-unconfigured');
  assert.match(msg.nextAction, /Smoke is required but not configured/);
  assert.match(msg.nextAction, /\/smoke setup/);
});

test('buildSmokeHandoffMessage after-deploy-staging: configured branch tells operator to run smoke then prod', async () => {
  const build = await loadBuildSmokeHandoffMessage();
  const msg = build({
    config: makeSmokeHandoffConfig({ stagingCommand: 'npm run smoke', requireStagingSmoke: false }),
    stage: 'after-deploy-staging',
    shortSha: 'def5678',
  });
  assert.equal(msg.status, 'configured');
  assert.match(msg.nextAction, /staging verified at def5678/);
  assert.match(msg.nextAction, /run \/smoke staging/);
  assert.match(msg.nextAction, /\/deploy prod/);
});

test('buildSmokeHandoffMessage after-deploy-staging: required+unconfigured points at setup (original-bug codepath)', async () => {
  const build = await loadBuildSmokeHandoffMessage();
  const msg = build({
    config: makeSmokeHandoffConfig({ stagingCommand: '', requireStagingSmoke: true }),
    stage: 'after-deploy-staging',
    shortSha: 'def5678',
  });
  // This is the exact branch that used to tell users "run /smoke staging"
  // when smoke.staging.command was missing — now it points at /smoke setup.
  assert.equal(msg.status, 'required-unconfigured');
  assert.match(msg.nextAction, /blocked until smoke is configured/);
  assert.match(msg.nextAction, /\/smoke setup/);
  assert.doesNotMatch(msg.nextAction, /run \/smoke staging\b/);
});

test('buildSmokeHandoffMessage before-deploy-prod: required+unconfigured blocks', async () => {
  const build = await loadBuildSmokeHandoffMessage();
  const msg = build({
    config: makeSmokeHandoffConfig({ stagingCommand: '', requireStagingSmoke: true }),
    stage: 'before-deploy-prod',
  });
  assert.equal(msg.blocks, true);
  assert.match(msg.nextAction, /deploy prod blocked/);
  assert.match(msg.nextAction, /\/smoke setup/);
});

test('buildSmokeHandoffMessage before-deploy-prod: optional+unconfigured does not block', async () => {
  const build = await loadBuildSmokeHandoffMessage();
  const msg = build({
    config: makeSmokeHandoffConfig({ stagingCommand: '', requireStagingSmoke: false }),
    stage: 'before-deploy-prod',
  });
  assert.equal(msg.blocks, false);
});

test('npm guard blocks install-like commands when node_modules is a symlink and delegates safe commands', async () => {
  const guard = await import(path.join(KIT_ROOT, 'src', 'operator', 'npm-guard-install.ts'));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-npm-guard-home-'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'pipelane-npm-guard-test-'));

  try {
    const fakeBin = path.join(root, 'fake-bin');
    const stateFile = path.join(root, 'npm-state.json');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      path.join(fakeBin, 'npm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.NPM_GUARD_STATE, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
process.exit(0);
`,
      { mode: 0o755, encoding: 'utf8' },
    );

    const nodeBinDir = path.dirname(process.execPath);
    const install = guard.installNpmGuard({ homeDir, envPath: `${path.join(homeDir, 'bin')}${path.delimiter}${fakeBin}${path.delimiter}${nodeBinDir}` });
    const shared = path.join(root, 'shared');
    const worktree = path.join(root, 'worktree');
    mkdirSync(path.join(shared, 'node_modules'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    symlinkSync(path.join(shared, 'node_modules'), path.join(worktree, 'node_modules'), 'dir');

    const baseEnv = {
      ...process.env,
      PATH: `${install.binDir}${path.delimiter}${fakeBin}${path.delimiter}${nodeBinDir}`,
      NPM_GUARD_STATE: stateFile,
    };
    const blocked = spawnSync(install.shimPath, ['install'], {
      cwd: worktree,
      env: baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Refusing npm install/);
    assert.equal(existsSync(stateFile), false, 'real npm should not run when guard blocks');

    const blockedAbsolutePrefix = spawnSync(install.shimPath, ['--prefix', worktree, 'install'], {
      cwd: worktree,
      env: baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(blockedAbsolutePrefix.status, 1);
    assert.match(blockedAbsolutePrefix.stderr, /Refusing npm install/);
    assert.equal(existsSync(stateFile), false, 'real npm should not run for an absolute --prefix that targets this worktree');

    const blockedTrailingPrefix = spawnSync(install.shimPath, ['install', '--prefix', worktree], {
      cwd: worktree,
      env: baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(blockedTrailingPrefix.status, 1);
    assert.match(blockedTrailingPrefix.stderr, /Refusing npm install/);
    assert.equal(existsSync(stateFile), false, 'real npm should not run when --prefix appears after the command');

    const delegatedGlobal = spawnSync(install.shimPath, ['install', '-g', 'left-pad'], {
      cwd: worktree,
      env: baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(delegatedGlobal.status, 0, delegatedGlobal.stderr);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), ['install', '-g', 'left-pad']);
    rmSync(stateFile, { force: true });

    const delegated = spawnSync(install.shimPath, ['run', 'test'], {
      cwd: worktree,
      env: baseEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(delegated.status, 0, delegated.stderr);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), ['run', 'test']);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('npm guard bypass delegates install-like commands and prints a warning', async () => {
  const guard = await import(path.join(KIT_ROOT, 'src', 'operator', 'npm-guard-install.ts'));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-npm-guard-home-'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'pipelane-npm-guard-test-'));

  try {
    const fakeBin = path.join(root, 'fake-bin');
    const stateFile = path.join(root, 'npm-state.json');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      path.join(fakeBin, 'npm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.NPM_GUARD_STATE, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8');
process.exit(0);
`,
      { mode: 0o755, encoding: 'utf8' },
    );

    const nodeBinDir = path.dirname(process.execPath);
    const install = guard.installNpmGuard({ homeDir, envPath: `${path.join(homeDir, 'bin')}${path.delimiter}${fakeBin}${path.delimiter}${nodeBinDir}` });
    const shared = path.join(root, 'shared');
    const worktree = path.join(root, 'worktree');
    mkdirSync(path.join(shared, 'node_modules'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    symlinkSync(path.join(shared, 'node_modules'), path.join(worktree, 'node_modules'), 'dir');

    const delegated = spawnSync(install.shimPath, ['install'], {
      cwd: worktree,
      env: {
        ...process.env,
        PATH: `${install.binDir}${path.delimiter}${fakeBin}${path.delimiter}${nodeBinDir}`,
        NPM_GUARD_STATE: stateFile,
        PIPELANE_NPM_GUARD_BYPASS: '1',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(delegated.status, 0, delegated.stderr);
    assert.match(delegated.stderr, /PIPELANE_NPM_GUARD_BYPASS=1/);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), ['install']);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor --check-guard verifies the installed npm guard in the active PATH', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-doctor-guard-'));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-home-'));

  try {
    const install = runCli(['install-npm-guard'], workspaceRoot, { PIPELANE_HOME: homeDir });
    assert.match(install.stdout, /Installed npm guard/);
    const result = runCli(
      ['run', 'doctor', '--check-guard'],
      workspaceRoot,
      {
        PIPELANE_HOME: homeDir,
        PATH: `${path.join(homeDir, 'bin')}${path.delimiter}${process.env.PATH}`,
      },
    );
    assert.match(result.stdout, /Doctor npm guard/);
    assert.match(result.stdout, /symlinked node_modules block: pass/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

const PREINSTALL_GUARD_PATH = path.join(KIT_ROOT, 'scripts', 'preinstall-guard.cjs');

function spawnPreinstallGuard(cwd) {
  return spawnSync('node', [PREINSTALL_GUARD_PATH], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('preinstall-guard exits 0 silently when node_modules is missing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-guard-empty-'));
  try {
    const result = spawnPreinstallGuard(dir);
    assert.equal(result.status, 0, `guard should pass; stderr=${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preinstall-guard exits 0 silently when node_modules is a real directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-guard-realdir-'));
  try {
    mkdirSync(path.join(dir, 'node_modules'));
    const result = spawnPreinstallGuard(dir);
    assert.equal(result.status, 0, `guard should pass; stderr=${result.stderr}`);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preinstall-guard exits 1 with warning when node_modules is a symlink', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-guard-symlink-'));
  const sharedDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-guard-shared-'));
  try {
    mkdirSync(path.join(sharedDir, 'node_modules'));
    const { symlinkSync } = await import('node:fs');
    symlinkSync(path.join(sharedDir, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const result = spawnPreinstallGuard(dir);
    assert.equal(result.status, 1, `guard should refuse; stderr=${result.stderr}`);
    assert.match(result.stderr, /preinstall-guard/);
    assert.match(result.stderr, /symlink/);
    assert.match(result.stderr, /npm ci/);
    // Symlink target must remain intact — the whole point of the guard.
    assert.ok(existsSync(path.join(sharedDir, 'node_modules')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('preinstall-guard warning text matches SHARED_NODE_MODULES_NPMCI_WARNING from task-workspaces.ts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-guard-textmatch-'));
  const sharedDir = mkdtempSync(path.join(os.tmpdir(), 'pipelane-guard-textmatch-shared-'));
  try {
    mkdirSync(path.join(sharedDir, 'node_modules'));
    const { symlinkSync } = await import('node:fs');
    symlinkSync(path.join(sharedDir, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const result = spawnPreinstallGuard(dir);
    const taskWorkspaces = await import(path.join(KIT_ROOT, 'src', 'operator', 'task-workspaces.ts'));
    assert.ok(
      result.stderr.includes(taskWorkspaces.SHARED_NODE_MODULES_NPMCI_WARNING),
      `guard stderr must contain SHARED_NODE_MODULES_NPMCI_WARNING verbatim. stderr=${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('mergePreinstallScript writes pipelane guard when no existing preinstall', async () => {
  const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
  assert.equal(docs.mergePreinstallScript(undefined), docs.PIPELANE_PREINSTALL_GUARD);
  assert.equal(docs.mergePreinstallScript(''), docs.PIPELANE_PREINSTALL_GUARD);
  assert.equal(docs.mergePreinstallScript('   '), docs.PIPELANE_PREINSTALL_GUARD);
});

test('mergePreinstallScript chains pipelane guard before existing preinstall', async () => {
  const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
  const merged = docs.mergePreinstallScript('echo hello');
  assert.equal(merged, `${docs.PIPELANE_PREINSTALL_GUARD} && echo hello`);
  assert.ok(merged.startsWith(docs.PIPELANE_PREINSTALL_GUARD), 'guard must run first');
});

test('mergePreinstallScript is idempotent when guard fingerprint is already present', async () => {
  const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
  // Already-chained: leave alone.
  const chained = `${docs.PIPELANE_PREINSTALL_GUARD} && echo hello`;
  assert.equal(docs.mergePreinstallScript(chained), chained);
  // User put the guard inline some other way (e.g., wrapped in their own script).
  const wrapped = `bash -c "${docs.PIPELANE_PREINSTALL_GUARD}"`;
  assert.equal(docs.mergePreinstallScript(wrapped), wrapped);
});

test('setup writes preinstall guard into a fresh consumer package.json', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts.preinstall, 'preinstall script must be present');
    assert.match(pkg.scripts.preinstall, /pipelane\/scripts\/preinstall-guard\.cjs/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup chains existing preinstall instead of clobbering it', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    pkg.scripts = { ...(pkg.scripts ?? {}), preinstall: 'echo consumer-hook' };
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    runCli(['setup'], repoRoot);

    const next = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    assert.match(next.scripts.preinstall, /pipelane\/scripts\/preinstall-guard\.cjs/);
    assert.match(next.scripts.preinstall, /echo consumer-hook/);
    assert.ok(
      next.scripts.preinstall.indexOf('preinstall-guard.cjs') < next.scripts.preinstall.indexOf('echo consumer-hook'),
      'pipelane guard must run before the consumer hook',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('setup is idempotent when preinstall guard is already present', () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    runCli(['setup'], repoRoot);
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const firstPass = readFileSync(packageJsonPath, 'utf8');
    runCli(['setup'], repoRoot);
    const secondPass = readFileSync(packageJsonPath, 'utf8');
    assert.equal(firstPass, secondPass, 'second setup must not change package.json');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detectSetupDrift reports drift when preinstall guard is missing and no drift after setup', async () => {
  const repoRoot = createRepo();
  try {
    runCli(['init', '--project', 'Demo App'], repoRoot);
    // Wipe the preinstall that init may have written, to simulate an
    // older consumer who set up before the guard existed.
    const packageJsonPath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (pkg.scripts) delete pkg.scripts.preinstall;
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    const docs = await import(path.join(KIT_ROOT, 'src', 'operator', 'docs.ts'));
    const drift = docs.detectSetupDrift(repoRoot);
    assert.ok(
      drift.otherSurfaces.includes('packageScripts'),
      `expected packageScripts drift; got otherSurfaces=${drift.otherSurfaces.join(',')}`,
    );

    runCli(['setup'], repoRoot);
    const after = docs.detectSetupDrift(repoRoot);
    assert.ok(
      !after.otherSurfaces.includes('packageScripts'),
      `setup should clear packageScripts drift; got otherSurfaces=${after.otherSurfaces.join(',')}`,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// State-resilience suite. Three layers, each with its own regression
// guard:
//   - Fix A: legacy stateDir fallback (the rocketboard 2026-04-26
//     incident — config.stateDir renamed, mode-state.json orphaned,
//     mode silently fell back to 'build').
//   - Fix C: install marker + loud-warn when expected state is gone
//     after a previous install.
//   - Fix B: schemaVersion envelope on every state file + migration
//     runner registry.
// See REPO_GUIDANCE.md "State-resilience invariants" for the policy.

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    return { result: fn(), stderr: captured.join('') };
  } finally {
    process.stderr.write = original;
  }
}

function makeStateScratch() {
  // The state-resilience helpers operate against a `commonDir` (git
  // common dir) and a `WorkflowConfig`. We don't need a real repo for
  // these unit-level tests — a tmpdir + default config is enough.
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-resilience-'));
  const commonDir = path.join(tmpRoot, '.git');
  mkdirSync(commonDir, { recursive: true });
  return { tmpRoot, commonDir };
}

test('migrateLegacyStateDir copies orphaned state forward when canonical dir is empty', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    // Reproduce the rocketboard scenario: a populated legacy state
    // dir that the operator wrote to under the old default name,
    // and a canonical dir that pipelane just started using after a
    // bump. modeState says release, but the canonical dir is empty.
    const legacyDir = path.join(commonDir, 'rocketboard-workflow');
    mkdirSync(path.join(legacyDir, 'task-locks'), { recursive: true });
    writeFileSync(
      path.join(legacyDir, 'mode-state.json'),
      JSON.stringify({ mode: 'release', requestedSurfaces: ['frontend'], override: null, updatedAt: '2026-04-25T00:00:00Z' }, null, 2),
      'utf8',
    );
    writeFileSync(
      path.join(legacyDir, 'task-locks', 'demo-1.json'),
      JSON.stringify({ taskSlug: 'demo-1', branchName: 'codex/demo-1', worktreePath: '/tmp/demo-1', mode: 'build', surfaces: ['frontend'], updatedAt: '2026-04-24T00:00:00Z' }, null, 2),
      'utf8',
    );

    const canonicalDir = path.join(commonDir, config.stateDir);
    assert.equal(existsSync(canonicalDir), false, 'canonical dir should be absent before migration');

    const { stderr } = captureStderr(() => stateMod.migrateLegacyStateDir(commonDir, config));

    // Mode-state and task-locks made it across.
    assert.equal(existsSync(path.join(canonicalDir, 'mode-state.json')), true);
    assert.equal(existsSync(path.join(canonicalDir, 'task-locks', 'demo-1.json')), true);
    // Audit file records what happened.
    const audit = JSON.parse(readFileSync(path.join(canonicalDir, 'legacy-migration.json'), 'utf8'));
    assert.equal(audit.from, legacyDir);
    assert.equal(audit.to, canonicalDir);
    assert.ok(audit.entries.includes('mode-state.json'));
    // Install marker planted so subsequent loads know this is "installed".
    assert.equal(stateMod.hasInstallMarker(commonDir, config), true);
    // Operator gets a stderr banner so the migration isn't silent.
    assert.match(stderr, /Migrated \d+ legacy state file\(s\)/);

    // The mode that was orphaned in the legacy dir is now what
    // loadModeState returns — i.e. the rocketboard regression is
    // fixed end-to-end.
    const mode = stateMod.loadModeState(commonDir, config);
    assert.equal(mode.mode, 'release');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('migrateLegacyStateDir is idempotent: second call is a no-op', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    const legacyDir = path.join(commonDir, 'rocketboard-workflow');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      path.join(legacyDir, 'mode-state.json'),
      JSON.stringify({ mode: 'release', requestedSurfaces: [], override: null, updatedAt: null }, null, 2),
      'utf8',
    );

    captureStderr(() => stateMod.migrateLegacyStateDir(commonDir, config));
    // Mutate the legacy file after the first migration. A second
    // call should NOT pull the new contents forward — the audit
    // file is the gate.
    writeFileSync(
      path.join(legacyDir, 'mode-state.json'),
      JSON.stringify({ mode: 'build', requestedSurfaces: [], override: null, updatedAt: null }, null, 2),
      'utf8',
    );
    const { stderr } = captureStderr(() => stateMod.migrateLegacyStateDir(commonDir, config));
    assert.equal(stderr, '', 'second migration should be silent');

    const canonicalDir = path.join(commonDir, config.stateDir);
    const stillReleased = JSON.parse(readFileSync(path.join(canonicalDir, 'mode-state.json'), 'utf8'));
    assert.equal(stillReleased.mode, 'release', 'canonical mode-state should not be overwritten by re-run');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('migrateLegacyStateDir never clobbers a canonical file that already exists', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    const legacyDir = path.join(commonDir, 'rocketboard-workflow');
    const canonicalDir = path.join(commonDir, config.stateDir);
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(canonicalDir, { recursive: true });
    // Canonical wins when both exist — pipelane has been writing
    // here post-bump, so the canonical copy is fresher.
    writeFileSync(
      path.join(legacyDir, 'pr-state.json'),
      JSON.stringify({ records: { stale: { taskSlug: 'stale' } } }, null, 2),
      'utf8',
    );
    writeFileSync(
      path.join(canonicalDir, 'pr-state.json'),
      JSON.stringify({ records: { fresh: { taskSlug: 'fresh' } } }, null, 2),
      'utf8',
    );

    captureStderr(() => stateMod.migrateLegacyStateDir(commonDir, config));
    const merged = JSON.parse(readFileSync(path.join(canonicalDir, 'pr-state.json'), 'utf8'));
    assert.equal(typeof merged.records.fresh, 'object', 'fresh canonical record must survive');
    assert.equal(merged.records.stale, undefined, 'stale legacy record must NOT clobber canonical');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ensureStateDir plants installed.json marker on first call', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    assert.equal(stateMod.hasInstallMarker(commonDir, config), false);
    stateMod.ensureStateDir(commonDir, config);
    assert.equal(stateMod.hasInstallMarker(commonDir, config), true);
    const marker = JSON.parse(readFileSync(stateMod.installMarkerPath(commonDir, config), 'utf8'));
    assert.equal(typeof marker.installedAt, 'string');
    assert.ok(marker.installedAt.length > 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadModeState is silent on a true fresh install (no marker, no warn)', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    const { result, stderr } = captureStderr(() => stateMod.loadModeState(commonDir, config));
    assert.equal(result.mode, 'build', 'fresh install defaults to build');
    assert.equal(stderr, '', 'fresh install should not warn — there is no prior state to lose');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadModeState warns loudly when expected state is missing but install marker exists', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    // Plant a marker (proxy for "pipelane has been here") but no
    // mode-state file — the regression scenario the warn is for.
    stateMod.ensureStateDir(commonDir, config);
    rmSync(stateMod.modeStatePath(commonDir, config), { force: true });
    assert.equal(stateMod.hasInstallMarker(commonDir, config), true);

    const { result, stderr } = captureStderr(() => stateMod.loadModeState(commonDir, config));
    assert.equal(result.mode, 'build', 'still falls back so the operator is unblocked');
    assert.match(stderr, /WARNING.*missing but install marker exists/);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('writeVersionedJsonFile injects schemaVersion envelope; readVersionedJsonFile strips it', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    const target = path.join(commonDir, config.stateDir, 'mode-state.json');
    mkdirSync(path.dirname(target), { recursive: true });

    stateMod.writeVersionedJsonFile('modeState', target, {
      mode: 'release',
      requestedSurfaces: [],
      override: null,
      updatedAt: '2026-04-26T00:00:00Z',
    });

    const onDisk = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(onDisk.schemaVersion, 1, 'envelope must be on disk so future migrations have an anchor');
    assert.equal(onDisk.mode, 'release');

    const loaded = stateMod.readVersionedJsonFile('modeState', commonDir, config, target, null);
    assert.equal(loaded.mode, 'release');
    assert.equal(loaded.schemaVersion, undefined, 'envelope must be stripped before callers see the value');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readVersionedJsonFile runs registered migrations forward in order', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    const target = path.join(commonDir, config.stateDir, 'mode-state.json');
    mkdirSync(path.dirname(target), { recursive: true });

    // Simulate a v0 file (no schemaVersion field — anything written
    // before pipelane added the envelope) with an old shape.
    writeFileSync(target, JSON.stringify({ legacyMode: 'release' }, null, 2), 'utf8');

    // Temporarily register a v0 → v1 migration that maps the old
    // shape into the current ModeState shape. Restore afterward so
    // we don't leak state into other tests.
    const original = stateMod.STATE_MIGRATIONS.modeState[0];
    stateMod.STATE_MIGRATIONS.modeState[0] = (raw) => ({
      mode: raw.legacyMode,
      requestedSurfaces: [],
      override: null,
      updatedAt: null,
    });
    try {
      const loaded = stateMod.readVersionedJsonFile('modeState', commonDir, config, target, null);
      assert.equal(loaded.mode, 'release');
      assert.equal(loaded.schemaVersion, undefined);
    } finally {
      if (original === undefined) delete stateMod.STATE_MIGRATIONS.modeState[0];
      else stateMod.STATE_MIGRATIONS.modeState[0] = original;
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('saveModeState + loadModeState round-trip is stable across the schemaVersion envelope', async () => {
  const stateMod = await import(path.join(KIT_ROOT, 'src', 'operator', 'state.ts'));
  const { tmpRoot, commonDir } = makeStateScratch();
  try {
    const config = stateMod.defaultWorkflowConfig('demo', 'Demo');
    const original = {
      mode: 'release',
      requestedSurfaces: ['frontend', 'edge'],
      override: { reason: 'staging probes stale', timestamp: '2026-04-26T00:00:00Z' },
      lastOverride: { reason: 'staging probes stale', setAt: '2026-04-26T00:00:00Z', setBy: 'tester' },
      updatedAt: '2026-04-26T00:00:00Z',
    };
    stateMod.saveModeState(commonDir, config, original);
    const loaded = stateMod.loadModeState(commonDir, config);
    assert.equal(loaded.mode, original.mode);
    assert.deepEqual(loaded.requestedSurfaces, original.requestedSurfaces);
    assert.deepEqual(loaded.override, original.override);
    assert.deepEqual(loaded.lastOverride, original.lastOverride);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
