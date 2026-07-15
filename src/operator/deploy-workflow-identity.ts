import crypto from 'node:crypto';

import { runCommandCapture, runGit } from './state.ts';

export interface DeployWorkflowRevision {
  repository: string;
  workflowName: string;
  ref: string;
  revision: string;
  yamlSha256: string;
}

export interface ResolvedDeployWorkflowRevision extends DeployWorkflowRevision {
  yaml: string;
}

export function resolveDeployWorkflowRevision(
  repoRoot: string,
  workflowName: string,
  baseBranch: string,
): ResolvedDeployWorkflowRevision {
  const repository = resolveGitHubRepository(repoRoot);
  const beforeRevision = resolveRemoteBranchRevision(repoRoot, baseBranch);
  const viewed = runCommandCapture('gh', [
    'workflow',
    'view',
    workflowName,
    '--yaml',
    '--repo',
    repository,
    '--ref',
    baseBranch,
  ], { cwd: repoRoot });
  const yaml = viewed.ok && viewed.stdout.trim()
    ? viewed.stdout
    : resolveTestLocalWorkflowYaml(repository, workflowName, beforeRevision);
  if (!yaml) {
    throw new Error([
      `Could not resolve deploy workflow ${workflowName} at ${repository}:${baseBranch}.`,
      viewed.stderr.trim() || viewed.stdout.trim() || 'gh workflow view returned no YAML.',
      'Confirm the workflow exists on the base branch and retry.',
    ].join('\n'));
  }
  const afterRevision = resolveRemoteBranchRevision(repoRoot, baseBranch);
  if (beforeRevision !== afterRevision) {
    throw new Error([
      `Deploy workflow revision changed while it was being resolved: ${beforeRevision.slice(0, 12)} → ${afterRevision.slice(0, 12)}.`,
      'No dispatch was attempted. Retry to inspect and approve the latest workflow revision.',
    ].join('\n'));
  }
  return {
    repository,
    workflowName,
    ref: baseBranch,
    revision: afterRevision,
    yamlSha256: crypto.createHash('sha256').update(yaml).digest('hex'),
    yaml,
  };
}

function resolveTestLocalWorkflowYaml(
  repository: string,
  workflowName: string,
  revision: string,
): string | null {
  if (process.env.NODE_ENV !== 'test' || !repository.startsWith('test.invalid/')) return null;
  // Local bare remotes used by integration tests have no GitHub API. Keep
  // their identity deterministic and revision-bound without introducing a
  // production fallback that could mask a failed `gh workflow view` lookup.
  return [
    `name: ${JSON.stringify(workflowName)}`,
    `# local-test-remote-revision: ${revision}`,
    'on:',
    '  workflow_dispatch: {}',
    '',
  ].join('\n');
}

export function deployWorkflowRevisionIdentity(
  value: ResolvedDeployWorkflowRevision | DeployWorkflowRevision,
): DeployWorkflowRevision {
  return {
    repository: value.repository,
    workflowName: value.workflowName,
    ref: value.ref,
    revision: value.revision,
    yamlSha256: value.yamlSha256,
  };
}

export function assertDeployWorkflowRevisionUnchanged(
  approved: DeployWorkflowRevision,
  current: DeployWorkflowRevision,
  effectLabel: string,
): void {
  if (
    approved.repository === current.repository
    && approved.workflowName === current.workflowName
    && approved.ref === current.ref
    && approved.revision === current.revision
    && approved.yamlSha256 === current.yamlSha256
  ) return;
  throw new Error([
    `${effectLabel} blocked: the GitHub Actions workflow changed after confirmation.`,
    `Repository: ${approved.repository} → ${current.repository}`,
    `Workflow/ref: ${approved.workflowName}@${approved.ref} → ${current.workflowName}@${current.ref}`,
    `Revision: ${approved.revision.slice(0, 12)} → ${current.revision.slice(0, 12)}`,
    `Workflow YAML: ${approved.yamlSha256.slice(0, 12)} → ${current.yamlSha256.slice(0, 12)}`,
    'No dispatch was attempted. Run preflight again, inspect the new effect, and approve a fresh confirmation token.',
  ].join('\n'));
}

function resolveRemoteBranchRevision(repoRoot: string, baseBranch: string): string {
  const output = runGit(repoRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${baseBranch}`], true)?.trim() ?? '';
  const revision = output.split(/\s+/u)[0] ?? '';
  if (/^[0-9a-f]{40,64}$/iu.test(revision)) return revision.toLowerCase();
  if (process.env.NODE_ENV === 'test') {
    for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
      const localRevision = runGit(repoRoot, ['rev-parse', '--verify', ref], true)?.trim() ?? '';
      if (/^[0-9a-f]{40,64}$/iu.test(localRevision)) return localRevision.toLowerCase();
    }
  }
  throw new Error([
    `Could not resolve immutable origin/${baseBranch} revision before workflow dispatch.`,
    'Fetch/check the origin remote and retry. No dispatch was attempted.',
  ].join('\n'));
}

function resolveGitHubRepository(repoRoot: string): string {
  const remote = runGit(repoRoot, ['remote', 'get-url', 'origin'], true)?.trim() ?? '';
  const parsed = parseGitHubRepository(remote);
  if (parsed) return parsed;
  if (process.env.NODE_ENV === 'test') {
    return `test.invalid/pipelane/${crypto.createHash('sha256').update(remote || repoRoot).digest('hex').slice(0, 16)}`;
  }
  throw new Error([
    `Could not resolve a GitHub repository from origin remote ${remote || '(missing)'}.`,
    'Set origin to a GitHub SSH/HTTPS remote and retry. No workflow dispatch was attempted.',
  ].join('\n'));
}

export function parseGitHubRepository(remote: string): string | null {
  let host = '';
  let pathname = '';
  const scp = remote.includes('://')
    ? null
    : remote.match(/^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/u);
  if (scp) {
    host = scp[1].toLowerCase();
    pathname = scp[2];
  } else {
    try {
      const url = new URL(remote);
      if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:') return null;
      host = url.hostname.toLowerCase();
      pathname = url.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  const segments = pathname.replace(/\.git$/iu, '').split('/').filter(Boolean);
  if (segments.length !== 2 || !segments.every((segment) => /^[A-Za-z0-9_.-]+$/u.test(segment))) return null;
  const ownerRepo = `${segments[0]}/${segments[1]}`;
  return host === 'github.com' ? ownerRepo : `${host}/${ownerRepo}`;
}
