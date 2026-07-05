import { existsSync } from 'node:fs';

import { formatChecksReport, runChecks } from '../checks/runner.ts';
import {
  buildReleaseCheckMessage,
  emptyDeployConfig,
  evaluateReleaseReadiness,
  loadDeployConfig,
  resolveSharedDeployConfigPath,
  saveSharedDeployConfig,
} from '../release-gate.ts';
import {
  formatWorkflowCommand,
  loadDeployState,
  loadProbeState,
  printResult,
  resolveWorkflowContext,
  type ParsedOperatorArgs,
} from '../state.ts';
import { resolveCommandSurfaces } from './helpers.ts';
import { handleDoctor } from './doctor.ts';

export async function handleRelease(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const subcommand = parsed.positional[0] ?? 'status';
  if (subcommand === 'enable') {
    handleReleaseEnable(cwd, parsed);
    return;
  }
  if (subcommand === 'doctor') {
    await handleDoctor(cwd, {
      ...parsed,
      command: 'doctor',
      positional: parsed.positional.slice(1),
    });
    return;
  }
  await handleReleaseStatus(cwd, parsed);
}

function handleReleaseEnable(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const configPath = resolveSharedDeployConfigPath(context.repoRoot);
  const createdConfig = !existsSync(configPath);
  const existingConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  saveSharedDeployConfig(context.repoRoot, existingConfig);
  const configured = loadDeployConfig(context.repoRoot) !== null;

  const lines = [
    `Release module: ${configured ? 'enabled and configured' : 'enabled (deploy values still required)'}`,
    `Machine-local deploy config: ${createdConfig ? 'created' : 'updated'} at ${configPath}`,
    'Deploy Configuration: present in Pipelane state',
    'No application repo files were created or modified.',
    '',
    `Next: run ${formatWorkflowCommand(context.config, 'release', 'status')} to inspect readiness.`,
    `If values are empty, run /pipelane configure to fill staging and production deploy settings.`,
    `When staging is verified, switch with ${formatWorkflowCommand(context.config, 'devmode', 'release')}.`,
  ];

  printResult(parsed.flags, {
    enabled: true,
    configured,
    createdConfig,
    configPath,
    message: lines.join('\n'),
  });
}

async function handleReleaseStatus(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);
  const configuredDeployConfig = loadDeployConfig(context.repoRoot);
  const moduleState = detectReleaseModuleState(context.repoRoot);
  const deployConfig = configuredDeployConfig ?? emptyDeployConfig();
  const deployState = loadDeployState(context.commonDir, context.config);
  const probeState = loadProbeState(context.commonDir, context.config);
  const readiness = evaluateReleaseReadiness({
    config: context.config,
    deployConfig,
    deployRecords: deployState.records,
    probeState,
    surfaces,
  });
  const checksReport = configuredDeployConfig
    ? await runChecks({
        repoRoot: context.repoRoot,
        config: context.config,
        deployConfig,
      })
    : { ok: true, outcomes: [] };
  const ready = configuredDeployConfig !== null && readiness.ready && checksReport.ok;
  const moduleLabel = configuredDeployConfig
    ? 'configured'
    : moduleState.enabled
      ? 'enabled (missing deploy values)'
      : 'not enabled';

  const lines = [
    `Release module: ${moduleLabel}`,
    `Dev Mode: [${context.modeState.mode}]`,
    `Requested surfaces: ${surfaces.join(', ')}`,
    `Release readiness: ${ready ? 'ready' : 'blocked'}`,
    '',
    configuredDeployConfig
      ? buildReleaseCheckMessage(readiness, surfaces, context.config)
      : moduleState.enabled
        ? [
            'Deploy Configuration is present but empty or incomplete.',
            'Run /pipelane configure to fill staging and production deploy settings.',
          ].join('\n')
        : [
            'Deploy Configuration is missing.',
            `Enable: ${formatWorkflowCommand(context.config, 'release', 'enable')}`,
            'Then run /pipelane configure to fill staging and production deploy settings.',
          ].join('\n'),
    '',
    formatChecksReport(checksReport),
    '',
    `Automation gate: ${formatWorkflowCommand(context.config, 'release-check')} exits non-zero when readiness is blocked.`,
  ];

  printResult(parsed.flags, {
    enabled: moduleState.enabled,
    configured: configuredDeployConfig !== null,
    ready,
    mode: context.modeState.mode,
    surfaces,
    blockedSurfaces: configuredDeployConfig ? readiness.blockedSurfaces : surfaces,
    checks: checksReport,
    configPaths: moduleState.configPaths,
    message: lines.join('\n'),
  });
}

function detectReleaseModuleState(repoRoot: string): { enabled: boolean; configPaths: string[] } {
  const configPath = resolveSharedDeployConfigPath(repoRoot);
  const configPaths = existsSync(configPath) ? [configPath] : [];
  return { enabled: configPaths.length > 0, configPaths };
}
