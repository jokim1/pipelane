import { buildReleaseCheckMessage, emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig, normalizeDeployEnvironment } from '../release-gate.ts';
import { loadDeployState, loadPrRecord, printResult, resolveWorkflowContext, runGh, saveDeployState, type DeployRecord, type ParsedOperatorArgs } from '../state.ts';
import { inferActiveTaskLock, resolveCommandSurfaces, resolveDeployTargetForTask } from './helpers.ts';

function findMatchingDeployRecord(records: DeployRecord[], environment: 'staging' | 'prod', sha: string, surfaces: string[]): DeployRecord | null {
  const key = [...surfaces].sort().join(',');
  return [...records].reverse().find((record) =>
    record.environment === environment
    && record.sha === sha
    && [...record.surfaces].sort().join(',') === key
  ) ?? null;
}

export async function handleDeploy(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const environment = normalizeDeployEnvironment(parsed.positional[0] ?? '');
  const explicitSurfaces = [...parsed.flags.surfaces, ...parsed.positional.slice(1)];
  const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
  const surfaces = resolveCommandSurfaces(context, explicitSurfaces, lock.surfaces);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const prRecord = loadPrRecord(context.commonDir, context.config, taskSlug);
  const target = resolveDeployTargetForTask({
    repoRoot: context.repoRoot,
    baseBranch: context.config.baseBranch,
    explicitSha: parsed.flags.sha,
    prRecord,
    mode: context.modeState.mode,
  });

  if (context.modeState.mode === 'release') {
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      surfaces,
    });
    if (!readiness.ready && !context.modeState.override) {
      throw new Error(buildReleaseCheckMessage(readiness, surfaces));
    }
  }

  const deployState = loadDeployState(context.commonDir, context.config);
  if (context.modeState.mode === 'release' && environment === 'prod') {
    const staging = findMatchingDeployRecord(deployState.records, 'staging', target.sha, surfaces);
    if (!staging) {
      throw new Error('Run workflow:deploy -- staging first for the same merged SHA and surfaces.');
    }
  }

  const workflowName = environment === 'staging'
    ? (deployConfig.frontend.staging.deployWorkflow || context.config.deployWorkflowName)
    : (deployConfig.frontend.production.deployWorkflow || context.config.deployWorkflowName);

  runGh(context.repoRoot, [
    'workflow',
    'run',
    workflowName,
    '-f',
    `environment=${environment === 'prod' ? 'production' : 'staging'}`,
    '-f',
    `sha=${target.sha}`,
    '-f',
    `surfaces=${surfaces.join(',')}`,
  ]);

  const record: DeployRecord = {
    environment,
    sha: target.sha,
    surfaces,
    workflowName,
    requestedAt: new Date().toISOString(),
  };
  saveDeployState(context.commonDir, context.config, {
    records: [...deployState.records, record].slice(-100),
  });

  printResult(parsed.flags, {
    environment,
    sha: target.sha,
    surfaces,
    workflowName,
    message: [
      `Deploy requested: ${environment}`,
      `Task: ${taskSlug}`,
      `SHA: ${target.sha}`,
      `Surfaces: ${surfaces.join(', ')}`,
      `Workflow: ${workflowName}`,
      environment === 'staging'
        ? 'Next: verify staging, then run workflow:deploy -- prod.'
        : 'Next: verify production, then run workflow:clean.',
    ].join('\n'),
  });
}
