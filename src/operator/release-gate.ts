import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { WorkflowConfig } from './state.ts';

export interface DeployConfig {
  platform: string;
  frontend: {
    production: {
      url: string;
      deployWorkflow: string;
      autoDeployOnMain: boolean;
      healthcheckUrl: string;
    };
    staging: {
      url: string;
      deployWorkflow: string;
      healthcheckUrl: string;
      ready: boolean;
    };
  };
  edge: {
    staging: {
      deployCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
      ready: boolean;
    };
    production: {
      deployCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
    };
  };
  sql: {
    staging: {
      applyCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
      ready: boolean;
    };
    production: {
      applyCommand: string;
      verificationCommand: string;
      healthcheckUrl: string;
    };
  };
  supabase: {
    staging: {
      projectRef: string;
    };
    production: {
      projectRef: string;
    };
  };
}

export function emptyDeployConfig(): DeployConfig {
  return {
    platform: '',
    frontend: {
      production: {
        url: '',
        deployWorkflow: '',
        autoDeployOnMain: false,
        healthcheckUrl: '',
      },
      staging: {
        url: '',
        deployWorkflow: '',
        healthcheckUrl: '',
        ready: false,
      },
    },
    edge: {
      staging: {
        deployCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
        ready: false,
      },
      production: {
        deployCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
      },
    },
    sql: {
      staging: {
        applyCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
        ready: false,
      },
      production: {
        applyCommand: '',
        verificationCommand: '',
        healthcheckUrl: '',
      },
    },
    supabase: {
      staging: {
        projectRef: '',
      },
      production: {
        projectRef: '',
      },
    },
  };
}

function isLocalUrl(value: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value);
}

function findDeployConfigSectionRange(markdown: string): { start: number; end: number } | null {
  const start = markdown.search(/^## Deploy Configuration\b/m);
  if (start === -1) {
    return null;
  }

  const remainder = markdown.slice(start);
  const nextHeading = remainder.slice(1).search(/\n##\s/m);
  const end = nextHeading === -1 ? markdown.length : start + 1 + nextHeading;
  return { start, end };
}

export function extractDeployConfigSection(markdown: string): string | null {
  const range = findDeployConfigSectionRange(markdown);
  return range ? markdown.slice(range.start, range.end).trimEnd() : null;
}

export function parseDeployConfigMarkdown(markdown: string): DeployConfig | null {
  const section = extractDeployConfigSection(markdown);

  if (!section) {
    return null;
  }

  const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i);
  if (!jsonMatch) {
    return null;
  }

  const parsed = JSON.parse(jsonMatch[1]) as Partial<DeployConfig>;
  const config = emptyDeployConfig();

  config.platform = parsed.platform ?? '';
  config.frontend.production.url = parsed.frontend?.production?.url ?? '';
  config.frontend.production.deployWorkflow = parsed.frontend?.production?.deployWorkflow ?? '';
  config.frontend.production.autoDeployOnMain = Boolean(parsed.frontend?.production?.autoDeployOnMain);
  config.frontend.production.healthcheckUrl = parsed.frontend?.production?.healthcheckUrl ?? '';
  config.frontend.staging.url = parsed.frontend?.staging?.url ?? '';
  config.frontend.staging.deployWorkflow = parsed.frontend?.staging?.deployWorkflow ?? '';
  config.frontend.staging.healthcheckUrl = parsed.frontend?.staging?.healthcheckUrl ?? '';
  config.frontend.staging.ready = Boolean(parsed.frontend?.staging?.ready);

  config.edge.staging.deployCommand = parsed.edge?.staging?.deployCommand ?? '';
  config.edge.staging.verificationCommand = parsed.edge?.staging?.verificationCommand ?? '';
  config.edge.staging.healthcheckUrl = parsed.edge?.staging?.healthcheckUrl ?? '';
  config.edge.staging.ready = Boolean(parsed.edge?.staging?.ready);
  config.edge.production.deployCommand = parsed.edge?.production?.deployCommand ?? '';
  config.edge.production.verificationCommand = parsed.edge?.production?.verificationCommand ?? '';
  config.edge.production.healthcheckUrl = parsed.edge?.production?.healthcheckUrl ?? '';

  config.sql.staging.applyCommand = parsed.sql?.staging?.applyCommand ?? '';
  config.sql.staging.verificationCommand = parsed.sql?.staging?.verificationCommand ?? '';
  config.sql.staging.healthcheckUrl = parsed.sql?.staging?.healthcheckUrl ?? '';
  config.sql.staging.ready = Boolean(parsed.sql?.staging?.ready);
  config.sql.production.applyCommand = parsed.sql?.production?.applyCommand ?? '';
  config.sql.production.verificationCommand = parsed.sql?.production?.verificationCommand ?? '';
  config.sql.production.healthcheckUrl = parsed.sql?.production?.healthcheckUrl ?? '';

  config.supabase.staging.projectRef = parsed.supabase?.staging?.projectRef ?? '';
  config.supabase.production.projectRef = parsed.supabase?.production?.projectRef ?? '';
  return config;
}

export function loadDeployConfig(repoRoot: string): DeployConfig | null {
  const claudePath = path.join(repoRoot, 'CLAUDE.md');

  if (!existsSync(claudePath)) {
    return null;
  }

  return parseDeployConfigMarkdown(readFileSync(claudePath, 'utf8'));
}

export function renderDeployConfigSection(config: DeployConfig): string {
  return `## Deploy Configuration

This section is machine-readable. Keep the JSON valid.
Set each \`.staging.ready\` flag to \`true\` only after that surface is fully configured and verified in staging.

\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`
`;
}

export function evaluateReleaseReadiness(options: {
  config: WorkflowConfig;
  deployConfig: DeployConfig;
  surfaces: string[];
}): {
  ready: boolean;
  blockedSurfaces: string[];
  results: Record<string, { ready: boolean; missing: string[] }>;
} {
  const results: Record<string, { ready: boolean; missing: string[] }> = {};

  for (const surface of options.surfaces) {
    const missing: string[] = [];

    if (surface === 'frontend') {
      const productionUrl = options.deployConfig.frontend.production.url;
      const productionWorkflow = options.deployConfig.frontend.production.deployWorkflow;
      const productionHealthcheck = options.deployConfig.frontend.production.healthcheckUrl || productionUrl;
      const stagingUrl = options.deployConfig.frontend.staging.url;
      const stagingWorkflow = options.deployConfig.frontend.staging.deployWorkflow;
      const stagingHealthcheck = options.deployConfig.frontend.staging.healthcheckUrl || stagingUrl;

      if (!productionUrl && !productionWorkflow) {
        missing.push('frontend production URL or workflow');
      }
      if (!productionHealthcheck) {
        missing.push('frontend production health check');
      }
      if (!stagingUrl && !stagingWorkflow) {
        missing.push('frontend staging URL or workflow');
      }
      if (!stagingHealthcheck) {
        missing.push('frontend staging health check');
      }
      if (productionUrl && stagingUrl && productionUrl === stagingUrl) {
        missing.push('frontend staging URL must differ from production URL');
      }
      if (stagingUrl && isLocalUrl(stagingUrl)) {
        missing.push('frontend staging URL must not be localhost');
      }
      if (stagingHealthcheck && isLocalUrl(stagingHealthcheck)) {
        missing.push('frontend staging health check must not be localhost');
      }
      if (!options.deployConfig.frontend.staging.ready) {
        missing.push('frontend staging readiness flag');
      }
    } else if (surface === 'edge') {
      if (!options.deployConfig.edge.staging.deployCommand) {
        missing.push('edge staging deploy command');
      }
      if (!options.deployConfig.edge.production.deployCommand) {
        missing.push('edge production deploy command');
      }
      if (!options.deployConfig.edge.staging.verificationCommand && !options.deployConfig.edge.production.verificationCommand && !options.deployConfig.edge.staging.healthcheckUrl && !options.deployConfig.edge.production.healthcheckUrl) {
        missing.push('edge verification command or health check');
      }
      if (!options.deployConfig.edge.staging.ready) {
        missing.push('edge staging readiness flag');
      }
    } else if (surface === 'sql') {
      if (!options.deployConfig.sql.staging.applyCommand) {
        missing.push('sql staging apply/reset path');
      }
      if (!options.deployConfig.sql.production.applyCommand) {
        missing.push('sql production apply path');
      }
      if (!options.deployConfig.sql.staging.verificationCommand && !options.deployConfig.sql.production.verificationCommand && !options.deployConfig.sql.staging.healthcheckUrl && !options.deployConfig.sql.production.healthcheckUrl) {
        missing.push('sql verification step');
      }
      if (!options.deployConfig.sql.staging.ready) {
        missing.push('sql staging readiness flag');
      }
    }

    results[surface] = {
      ready: missing.length === 0,
      missing,
    };
  }

  const blockedSurfaces = options.surfaces.filter((surface) => !results[surface]?.ready);
  return {
    ready: blockedSurfaces.length === 0,
    blockedSurfaces,
    results,
  };
}

export function buildReleaseCheckMessage(readiness: ReturnType<typeof evaluateReleaseReadiness>, surfaces: string[]): string {
  const lines = [
    readiness.ready ? 'Release readiness: PASS.' : 'Release readiness: FAIL.',
    `Requested surfaces: ${surfaces.join(', ')}`,
  ];

  if (!readiness.ready) {
    lines.push(`Blocked surfaces: ${readiness.blockedSurfaces.join(', ')}`);
    lines.push('Missing requirements:');
    for (const surface of readiness.blockedSurfaces) {
      lines.push(`- ${surface}:`);
      for (const missing of readiness.results[surface].missing) {
        lines.push(`  - ${missing}`);
      }
    }
    lines.push('Next: run npm run workflow:setup and complete local CLAUDE.md.');
  }

  return lines.join('\n');
}

export function normalizeDeployEnvironment(value: string): 'staging' | 'prod' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'staging') return 'staging';
  if (normalized === 'prod' || normalized === 'production') return 'prod';
  throw new Error('deploy requires an environment: staging or prod.');
}
