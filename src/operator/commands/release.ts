import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { formatChecksReport, runChecks } from '../checks/runner.ts';
import { renderClaudeMdFromTemplate } from '../docs.ts';
import {
  buildReleaseCheckMessage,
  emptyDeployConfig,
  evaluateReleaseReadiness,
  loadDeployConfig,
  parseDeployConfigMarkdown,
  replaceDeployConfigSection,
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
  const claudePath = path.join(context.repoRoot, 'CLAUDE.md');
  const currentMarkdown = existsSync(claudePath)
    ? readFileSync(claudePath, 'utf8')
    : renderClaudeMdFromTemplate(context.config);
  const existingConfig = parseDeployConfigMarkdown(currentMarkdown)
    ?? loadDeployConfig(context.repoRoot)
    ?? emptyDeployConfig();
  const nextMarkdown = replaceDeployConfigSection(currentMarkdown, existingConfig);
  const createdClaude = !existsSync(claudePath);

  const tmpPath = `${claudePath}.pipelane.tmp`;
  writeFileSync(tmpPath, ensureTrailingNewline(nextMarkdown), 'utf8');
  renameSync(tmpPath, claudePath);
  saveSharedDeployConfig(context.repoRoot, existingConfig);
  const configured = loadDeployConfig(context.repoRoot) !== null;

  const lines = [
    `Release module: ${configured ? 'enabled and configured' : 'enabled (deploy values still required)'}`,
    `CLAUDE.md: ${createdClaude ? 'created' : 'updated'} at ${claudePath}`,
    'Deploy Configuration: present',
    '',
    `Next: run ${formatWorkflowCommand(context.config, 'release', 'status')} to inspect readiness.`,
    `If values are empty, run /pipelane configure to fill staging and production deploy settings.`,
    `When staging is verified, switch with ${formatWorkflowCommand(context.config, 'devmode', 'release')}.`,
  ];

  printResult(parsed.flags, {
    enabled: true,
    configured,
    createdClaude,
    claudePath,
    message: lines.join('\n'),
  });
}

async function handleReleaseStatus(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);
  const configuredDeployConfig = loadDeployConfig(context.repoRoot);
  const moduleState = detectReleaseModuleState(context.repoRoot, context.commonDir);
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

function detectReleaseModuleState(repoRoot: string, commonDir: string): { enabled: boolean; configPaths: string[] } {
  const candidatePaths = [
    path.join(repoRoot, 'CLAUDE.md'),
    path.join(path.dirname(commonDir), 'CLAUDE.md'),
  ];
  const configPaths = Array.from(new Set(candidatePaths.map((candidate) => path.resolve(candidate))))
    .filter((candidate) => {
      if (!existsSync(candidate)) return false;
      try {
        return parseDeployConfigMarkdown(readFileSync(candidate, 'utf8')) !== null;
      } catch {
        return true;
      }
    });
  return { enabled: configPaths.length > 0, configPaths };
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}
