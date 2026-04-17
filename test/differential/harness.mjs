import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIPELANE_CLI = path.join(KIT_ROOT, 'src', 'cli.ts');

export const ROCKETBOARD_OPERATOR = process.env.ROCKETBOARD_OPERATOR
  ?? '/Users/josephkim/dev/rocketboard/scripts/workflow-operator.mjs';

export const CANONICAL_LANE_STATES = new Set([
  'healthy',
  'running',
  'blocked',
  'degraded',
  'stale',
  'unknown',
  'bypassed',
  'awaiting_preflight',
]);

export const STABLE_ACTION_IDS = [
  'new',
  'resume',
  'devmode.build',
  'devmode.release',
  'taskLock.verify',
  'pr',
  'merge',
  'deploy.staging',
  'deploy.prod',
  'clean.plan',
  'clean.apply',
];

export const RISKY_ACTION_IDS = new Set(['merge', 'deploy.prod', 'clean.apply']);

export function setupMinimalFixture() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-diff-'));
  exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  exec('git', ['config', 'user.email', 'diff@example.com'], { cwd: repoRoot });
  exec('git', ['config', 'user.name', 'Diff'], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  // Pipelane requires .project-workflow.json; Rocketboard ignores it.
  // `pipelane init` writes the config + workflow/CLAUDE.template.md +
  // .claude/commands/ + docs/RELEASE_WORKFLOW.md, giving both binaries a
  // consistent enough repo layout to operate against.
  exec(process.execPath, [PIPELANE_CLI, 'init', '--project', 'Differential Fixture'], { cwd: repoRoot });
  exec('git', ['add', '.'], { cwd: repoRoot });
  exec('git', ['commit', '-q', '-m', 'initial'], { cwd: repoRoot });
  return repoRoot;
}

export function runPipelane(repoRoot, args) {
  return runNode(PIPELANE_CLI, ['run', ...args], repoRoot);
}

export function runRocketboard(repoRoot, args) {
  return runNode(ROCKETBOARD_OPERATOR, args, repoRoot);
}

function runNode(script, scriptArgs, cwd) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function exec(command, args, options) {
  return execFileSync(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

const VARIABLE_FIELDS = new Set([
  'checkedAt',
  'observedAt',
  'createdAt',
  'expiresAt',
  'updatedAt',
  'mergedAt',
  'requestedAt',
  'token',
  'worktreePath',
  'repoRoot',
]);

const SHA_PATTERN = /\b[a-f0-9]{40}\b/g;
const SHORT_SHA_PATTERN = /\b[a-f0-9]{7,12}\b/g;
const ABSOLUTE_PATH_PATTERN = /\/(?:var|tmp|private)\/[^\s"']*/g;

export function normalizeEnvelope(value) {
  return normalize(value);
}

function normalize(value) {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (VARIABLE_FIELDS.has(key)) {
        out[key] = typeof v === 'string' ? '<normalized>' : normalize(v);
      } else {
        out[key] = normalize(v);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(SHA_PATTERN, '<sha40>')
      .replace(SHORT_SHA_PATTERN, '<sha>')
      .replace(ABSOLUTE_PATH_PATTERN, '<path>');
  }
  return value;
}

export function keysAtPath(value, pathKey = '') {
  if (Array.isArray(value)) return [`${pathKey}[]`];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const child = pathKey ? `${pathKey}.${k}` : k;
      return [child, ...keysAtPath(v, child)];
    });
  }
  return [];
}

export function keyOnlyDiff(pipelaneEnv, rocketboardEnv) {
  const pKeys = new Set(keysAtPath(pipelaneEnv));
  const rKeys = new Set(keysAtPath(rocketboardEnv));
  const onlyPipelane = [...pKeys].filter((k) => !rKeys.has(k)).sort();
  const onlyRocketboard = [...rKeys].filter((k) => !pKeys.has(k)).sort();
  const shared = [...pKeys].filter((k) => rKeys.has(k)).sort();
  return { onlyPipelane, onlyRocketboard, shared };
}

export function collectLaneStates(envelope) {
  const states = new Set();
  walk(envelope, (node) => {
    if (node && typeof node === 'object' && typeof node.state === 'string') {
      states.add(node.state);
    }
  });
  return states;
}

function walk(value, visitor) {
  visitor(value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visitor);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) walk(entry, visitor);
  }
}
