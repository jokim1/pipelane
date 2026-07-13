import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  isReleaseManagedSurface,
  type DeployConfig,
} from './release-gate.ts';
import { runGit, type WorkflowConfig } from './state.ts';

const CONTRACT_MARKER = /^\s*#\s*pipelane-surface-contract:\s*(\S+)\s*$/mu;
const SURFACE_NAME = /^[a-z][a-z0-9_-]*$/u;

export interface DeploySurfaceContract {
  workflowName: string;
  workflowPath: string;
  manifestPath: string;
  surfaces: string[];
  surfacePathMap: Record<string, string[]>;
  issues: string[];
}

interface RawDeploySurfaceManifest {
  version?: unknown;
  workflow?: unknown;
  surfaces?: unknown;
}

export function loadDeploySurfaceContract(
  repoRoot: string,
  workflowName: string,
  ref?: string,
): DeploySurfaceContract | null {
  const workflow = resolveDeployWorkflow(repoRoot, workflowName, ref);
  if (!workflow) return null;

  const marker = CONTRACT_MARKER.exec(workflow.content);
  if (!marker) return null;

  const markerPath = marker[1];
  const manifestPath = path.resolve(repoRoot, markerPath);
  const base: DeploySurfaceContract = {
    workflowName,
    workflowPath: workflow.absolutePath,
    manifestPath,
    surfaces: [],
    surfacePathMap: {},
    issues: [],
  };

  if (!isPathInsideRepo(repoRoot, manifestPath)) {
    base.issues.push(`deploy surface contract path escapes the repository: ${markerPath}`);
    return base;
  }
  const manifestText = readRepoFile(repoRoot, markerPath, ref);
  if (manifestText === null) {
    base.issues.push(`deploy surface contract is missing: ${markerPath}`);
    return base;
  }

  let raw: RawDeploySurfaceManifest;
  try {
    raw = JSON.parse(manifestText) as RawDeploySurfaceManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    base.issues.push(`deploy surface contract is malformed: ${markerPath}: ${detail}`);
    return base;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    base.issues.push(`deploy surface contract must be a JSON object: ${markerPath}`);
    return base;
  }
  if (raw.version !== 1) {
    base.issues.push(`deploy surface contract ${markerPath} must use version 1`);
  }
  const declaredWorkflow = typeof raw.workflow === 'string' ? raw.workflow.trim() : '';
  const acceptedWorkflowNames = new Set([
    workflowName.trim(),
    workflow.declaredName,
  ].filter(Boolean));
  if (!declaredWorkflow || !acceptedWorkflowNames.has(declaredWorkflow)) {
    const expected = workflow.declaredName || workflowName;
    base.issues.push(`deploy surface contract ${markerPath} must declare workflow "${expected}"`);
  }
  if (!raw.surfaces || typeof raw.surfaces !== 'object' || Array.isArray(raw.surfaces)) {
    base.issues.push(`deploy surface contract ${markerPath} must declare a surfaces object`);
    return base;
  }

  for (const [rawSurface, rawPatterns] of Object.entries(raw.surfaces)) {
    const surface = rawSurface.trim();
    if (rawSurface !== surface || !SURFACE_NAME.test(surface)) {
      base.issues.push(`deploy surface contract has invalid surface name "${rawSurface}"`);
      continue;
    }
    if (!Array.isArray(rawPatterns)) {
      base.issues.push(`deploy surface contract surface ${surface} must be an array of paths`);
      continue;
    }
    if (rawPatterns.some((entry) => typeof entry !== 'string')) {
      base.issues.push(`deploy surface contract surface ${surface} paths must all be strings`);
      continue;
    }
    const patterns = [...new Set((rawPatterns as string[])
      .map((entry) => entry.trim().replace(/\\/gu, '/'))
      .filter(Boolean))];
    if (patterns.length === 0) {
      base.issues.push(`deploy surface contract surface ${surface} must declare at least one path`);
      continue;
    }
    if (patterns.some((entry) =>
      path.posix.isAbsolute(entry)
      || /^[a-z]:\//iu.test(entry)
      || entry.includes('\0')
      || entry.split('/').includes('..')
    )) {
      base.issues.push(`deploy surface contract surface ${surface} contains a path outside the repository`);
      continue;
    }
    base.surfacePathMap[surface] = patterns;
  }
  base.surfaces = Object.keys(base.surfacePathMap).sort();
  if (base.surfaces.length === 0) {
    base.issues.push(`deploy surface contract ${markerPath} declares no usable surfaces`);
  }
  return base;
}

export function loadConfiguredDeploySurfaceContracts(
  repoRoot: string,
  config: WorkflowConfig,
  deployConfig: DeployConfig,
): DeploySurfaceContract[] {
  const names = new Set([
    config.deployWorkflowName,
    deployConfig.frontend.staging.deployWorkflow,
    deployConfig.frontend.production.deployWorkflow,
  ].map((entry) => entry.trim()).filter(Boolean));
  return [...names]
    .map((workflowName) => loadDeploySurfaceContract(repoRoot, workflowName))
    .filter((entry): entry is DeploySurfaceContract => entry !== null);
}

export function loadDeploySurfaceContractForTarget(
  repoRoot: string,
  workflowName: string,
  targetRef: string,
  baseBranch: string,
): DeploySurfaceContract | null {
  const refs = [...new Set([
    targetRef.trim(),
    `origin/${baseBranch}`,
    baseBranch,
  ].filter(Boolean))];
  for (const ref of refs) {
    const contract = loadDeploySurfaceContract(repoRoot, workflowName, ref);
    if (contract) return contract;
  }
  return loadDeploySurfaceContract(repoRoot, workflowName);
}

export function deploySurfaceContractConfigurationIssues(
  contract: DeploySurfaceContract | null,
  config: WorkflowConfig,
  deployConfig: DeployConfig,
): string[] {
  if (!contract) return [];
  const issues = [...contract.issues];
  for (const surface of contract.surfaces) {
    if (!config.surfaces.includes(surface)) {
      issues.push(`workflow ${contract.workflowName} declares unconfigured surface ${surface}`);
    }
    if (!isReleaseManagedSurface(surface)) {
      const customConfig = deployConfig.surfaces[surface];
      if (!customConfig) {
        issues.push(`${surface} custom deploy configuration`);
        continue;
      }
      if (!customConfig.staging.deployCommand) {
        issues.push(`${surface} staging deploy command`);
      }
      if (!customConfig.production.deployCommand) {
        issues.push(`${surface} production deploy command`);
      }
      if (
        !customConfig.staging.verificationCommand
        && !customConfig.production.verificationCommand
        && !customConfig.staging.healthcheckUrl
        && !customConfig.production.healthcheckUrl
      ) {
        issues.push(`${surface} verification command or health check`);
      }
    }
  }
  return [...new Set(issues)];
}

export function resolveDeploySurfacePathMap(
  config: WorkflowConfig,
  contract: DeploySurfaceContract | null,
): Record<string, string[]> | undefined {
  const machineLocal = config.surfacePathMap ?? {};
  if (!contract || Object.keys(contract.surfacePathMap).length === 0) {
    return Object.keys(machineLocal).length > 0 ? machineLocal : undefined;
  }
  return {
    ...machineLocal,
    ...contract.surfacePathMap,
  };
}

export function workflowNameForDeployEnvironment(
  config: WorkflowConfig,
  deployConfig: DeployConfig,
  environment: 'staging' | 'prod',
): string {
  return environment === 'staging'
    ? (deployConfig.frontend.staging.deployWorkflow || config.deployWorkflowName)
    : (deployConfig.frontend.production.deployWorkflow || config.deployWorkflowName);
}

interface ResolvedDeployWorkflow {
  absolutePath: string;
  content: string;
  declaredName: string;
}

function resolveDeployWorkflow(
  repoRoot: string,
  workflowName: string,
  ref?: string,
): ResolvedDeployWorkflow | null {
  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  if (!ref && !existsSync(workflowDir)) return null;

  const direct = path.resolve(workflowDir, workflowName);
  if (isPathInsideRepo(workflowDir, direct)) {
    const directRelative = toRepoRelativePath(repoRoot, direct);
    const directContent = readRepoFile(repoRoot, directRelative, ref);
    if (directContent !== null) {
      return {
        absolutePath: direct,
        content: directContent,
        declaredName: workflowDisplayName(directContent),
      };
    }
  }

  const candidatePaths = ref
    ? (runGit(repoRoot, ['ls-tree', '-r', '--name-only', ref, '--', '.github/workflows'], true) ?? '')
      .split('\n')
      .filter((entry) => /\.ya?ml$/iu.test(entry))
      .sort()
    : readdirSync(workflowDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
      .map((entry) => toRepoRelativePath(repoRoot, path.join(workflowDir, entry.name)))
      .sort();
  for (const relativePath of candidatePaths) {
    const content = readRepoFile(repoRoot, relativePath, ref);
    if (content === null) continue;
    const name = workflowDisplayName(content);
    if (name === workflowName) {
      return {
        absolutePath: path.resolve(repoRoot, relativePath),
        content,
        declaredName: name,
      };
    }
  }
  return null;
}

function workflowDisplayName(content: string): string {
  return /^name:\s*(.+?)\s*$/mu.exec(content)?.[1]?.trim().replace(/^['"]|['"]$/gu, '') ?? '';
}

function readRepoFile(repoRoot: string, relativePath: string, ref?: string): string | null {
  if (ref) return runGit(repoRoot, ['show', `${ref}:${relativePath}`], true);
  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!isPathInsideRepo(repoRoot, absolutePath) || !existsSync(absolutePath)) return null;
  return readFileSync(absolutePath, 'utf8');
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replace(/\\/gu, '/');
}

function isPathInsideRepo(repoRoot: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
