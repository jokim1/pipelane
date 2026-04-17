import { buildReleaseCheckMessage, emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig } from '../release-gate.ts';
import { loadDeployState, printResult, saveModeState, type ParsedOperatorArgs, type WorkflowContext } from '../state.ts';
import { resolveWorkflowContext } from '../state.ts';
import { resolveCommandSurfaces } from './helpers.ts';

export async function handleDevmode(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const action = parsed.positional[0] ?? 'status';

  if (action === 'status') {
    printResult(parsed.flags, {
      mode: context.modeState.mode,
      requestedSurfaces: context.modeState.requestedSurfaces,
      override: context.modeState.override,
      message: [
        `Dev Mode: [${context.modeState.mode}]`,
        `Requested surfaces: ${context.modeState.requestedSurfaces.join(', ')}`,
        context.modeState.override
          ? `Release override: ${context.modeState.override.reason} (${context.modeState.override.timestamp})`
          : 'Release override: none',
      ].join('\n'),
    });
    return;
  }

  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);

  if (action === 'build') {
    saveModeState(context.commonDir, context.config, {
      mode: 'build',
      requestedSurfaces: surfaces,
      override: null,
      updatedAt: new Date().toISOString(),
    });
    printResult(parsed.flags, {
      mode: 'build',
      requestedSurfaces: surfaces,
      message: [
        'Dev Mode: [build]',
        `Requested surfaces: ${surfaces.join(', ')}`,
      ].join('\n'),
    });
    return;
  }

  if (action === 'release') {
    const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
    const deployState = loadDeployState(context.commonDir, context.config);
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      deployRecords: deployState.records,
      surfaces,
    });

    if (!readiness.ready && !parsed.flags.override) {
      printResult(parsed.flags, {
        ready: false,
        blockedSurfaces: readiness.blockedSurfaces,
        message: buildReleaseCheckMessage(readiness, surfaces),
      });
      process.exitCode = 1;
      return;
    }

    saveModeState(context.commonDir, context.config, {
      mode: 'release',
      requestedSurfaces: surfaces,
      override: parsed.flags.override
        ? {
          reason: parsed.flags.reason || 'manual override',
          timestamp: new Date().toISOString(),
        }
        : null,
      updatedAt: new Date().toISOString(),
    });

    printResult(parsed.flags, {
      mode: 'release',
      requestedSurfaces: surfaces,
      override: parsed.flags.override,
      message: [
        'Dev Mode: [release]',
        `Requested surfaces: ${surfaces.join(', ')}`,
        parsed.flags.override ? `Release override: ${parsed.flags.reason || 'manual override'}` : 'Release override: none',
      ].join('\n'),
    });
    return;
  }

  throw new Error(`Unknown devmode action "${action}".`);
}
