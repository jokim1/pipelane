import type { DeployConfig } from './release-gate.ts';
import { resolveSurfaceHealthcheckUrl } from './commands/helpers.ts';

function deployEnvironmentLabel(environment: 'staging' | 'prod'): 'staging' | 'production' {
  return environment === 'prod' ? 'production' : 'staging';
}

export function listMissingDeployConfiguration(options: {
  config: DeployConfig;
  environment: 'staging' | 'prod';
  surfaces: string[];
  defaultWorkflowName: string;
  allowHealthcheckStubBypass?: boolean;
}): string[] {
  const missing = new Set<string>();
  const label = deployEnvironmentLabel(options.environment);
  const frontend = options.environment === 'staging'
    ? options.config.frontend.staging
    : options.config.frontend.production;

  if (!frontend.deployWorkflow && !options.defaultWorkflowName) {
    missing.add(`frontend ${label} deploy workflow`);
  }

  for (const surface of options.surfaces) {
    if (surface === 'frontend') {
      if (!frontend.url && !frontend.deployWorkflow && !options.defaultWorkflowName) {
        missing.add(`frontend ${label} URL or deploy workflow`);
      }
      if (!options.allowHealthcheckStubBypass && !resolveSurfaceHealthcheckUrl(options.config, options.environment, surface)) {
        missing.add(`frontend ${label} health check`);
      }
      continue;
    }

    if (!options.allowHealthcheckStubBypass && !resolveSurfaceHealthcheckUrl(options.config, options.environment, surface)) {
      missing.add(`${surface} ${label} health check`);
    }
  }

  return [...missing];
}
