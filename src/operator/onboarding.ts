import {
  detectLegacyWorkflowConfigCandidate,
  importLegacyWorkflowConfigIfNeeded,
  resolveConfigPath,
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
  if (resolveReadableConfigPath(repoRoot)) {
    return null;
  }

  const legacyCandidate = detectLegacyWorkflowConfigCandidate(repoRoot);

  const environment = options.environment?.trim() ?? '';
  const retry = [
    '/deploy',
    environment,
    options.pr?.trim() ? `--pr ${options.pr.trim()}` : '',
  ].filter(Boolean).join(' ');

  return [
    'Pipelane configuration has not been set up properly:',
    `- Repo: ${repoRoot}`,
    legacyCandidate
      ? `- Legacy Pipelane config was found at ${legacyCandidate.path}, but this read-only preflight did not import it.`
      : '- This repo is not onboarded yet with machine-local Pipelane config.',
    `- Missing machine-local workflow config: ${resolveConfigPath(repoRoot)}`,
    'No deploy started.',
    '',
    'Choose the action to take:',
    legacyCandidate
      ? '1. Import the legacy config and continue with safe /deploy (recommended).'
      : '1. Configure Pipelane for safe /deploy now (recommended).',
    '   Commands:',
    ...(legacyCandidate
      ? [`     ${retry}`]
      : ['     /pipelane setup --yes', '     /pipelane configure', `     ${retry}`]),
    '2. Set up workflow config only, then stop before deploy values.',
    '   Commands:',
    '     /pipelane setup --yes',
    '3. Cancel.',
    '   Command: cancel',
    '',
    'Deploy values may need app-specific URLs, workflows, healthchecks, or commands.',
    'Non-interactive example: pipelane configure --json --platform=github-actions --frontend-staging-url=https://staging.example.com --frontend-production-url=https://example.com',
  ].join('\n');
}

export function assertRepoOnboardedForDeploy(cwd: string, options: DeployOnboardingMessageOptions = {}): void {
  const repoRoot = resolveRepoRoot(cwd);
  if (!resolveReadableConfigPath(repoRoot)) importLegacyWorkflowConfigIfNeeded(repoRoot);
  const message = buildMissingDeployOnboardingMessage(cwd, options);
  if (message) {
    throw new Error(message);
  }
}
