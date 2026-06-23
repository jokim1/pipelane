import path from 'node:path';

import {
  readPackageJsonOverlay,
  resolveReadableConfigPath,
  resolveRepoRoot,
} from './state.ts';

export interface DeployOnboardingMessageOptions {
  environment?: string;
  pr?: string;
}

export function buildMissingDeployOnboardingMessage(
  cwd: string,
  options: DeployOnboardingMessageOptions = {},
): string | null {
  const repoRoot = resolveRepoRoot(cwd);
  if (resolveReadableConfigPath(repoRoot) || readPackageJsonOverlay(repoRoot)) {
    return null;
  }

  const environment = options.environment?.trim() || 'staging';
  const projectName = path.basename(repoRoot);
  const retry = [
    '/deploy',
    environment,
    options.pr?.trim() ? `--pr ${options.pr.trim()}` : '',
  ].filter(Boolean).join(' ');

  return [
    `Pipelane is installed on this machine, but this repo is not onboarded yet: ${repoRoot}`,
    'No .pipelane.json, .project-workflow.json, or package.json:pipelane block was found.',
    'No deploy started.',
    '',
    'Run the guided repo setup first:',
    `  /init-pipelane --project "${projectName}"`,
    '  /pipelane configure',
    `Then retry: ${retry}`,
    '',
    'For non-interactive setup, pass deploy values with `/pipelane configure --json ...`.',
  ].join('\n');
}

export function assertRepoOnboardedForDeploy(cwd: string, options: DeployOnboardingMessageOptions = {}): void {
  const message = buildMissingDeployOnboardingMessage(cwd, options);
  if (message) {
    throw new Error(message);
  }
}
