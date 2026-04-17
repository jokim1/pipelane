import { formatChecksReport, runChecks } from '../checks/runner.ts';
import { buildReleaseCheckMessage, emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig } from '../release-gate.ts';
import { loadDeployState, printResult, resolveWorkflowContext, type ParsedOperatorArgs } from '../state.ts';
import { resolveCommandSurfaces } from './helpers.ts';

export async function handleReleaseCheck(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);
  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const deployState = loadDeployState(context.commonDir, context.config);
  const readiness = evaluateReleaseReadiness({
    config: context.config,
    deployConfig,
    deployRecords: deployState.records,
    surfaces,
  });

  // v4: dispatch any configured pluggable checks. Absent config = no dispatch.
  // When dispatched, a failing plugin flips overall ready:false even if the
  // observed-deploy gate is clean.
  const checksReport = await runChecks({
    repoRoot: context.repoRoot,
    config: context.config,
    deployConfig,
  });

  const overallReady = readiness.ready && checksReport.ok;
  const message = [
    buildReleaseCheckMessage(readiness, surfaces),
    formatChecksReport(checksReport),
  ].join('\n\n');

  printResult(parsed.flags, {
    ready: overallReady,
    blockedSurfaces: readiness.blockedSurfaces,
    checks: checksReport,
    message,
  });

  if (!overallReady) {
    process.exitCode = 1;
  }
}
