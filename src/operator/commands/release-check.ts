import { buildReleaseCheckMessage, emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig } from '../release-gate.ts';
import { printResult, resolveWorkflowContext, type ParsedOperatorArgs } from '../state.ts';
import { resolveCommandSurfaces } from './helpers.ts';

export async function handleReleaseCheck(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const readiness = evaluateReleaseReadiness({
    config: context.config,
    deployConfig,
    surfaces,
  });

  printResult(parsed.flags, {
    ready: readiness.ready,
    blockedSurfaces: readiness.blockedSurfaces,
    message: buildReleaseCheckMessage(readiness, surfaces),
  });

  if (!readiness.ready) {
    process.exitCode = 1;
  }
}
