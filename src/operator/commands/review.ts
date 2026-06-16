import path from 'node:path';

import {
  detectPackageScripts,
  resolveReviewGateCatalog,
  buildReviewGatesConfigForPreset,
} from '../review-gates.ts';
import {
  defaultReviewGatesConfig,
  patchReadableWorkflowConfig,
  printResult,
  resolveReadableConfigPath,
  resolveWorkflowContext,
  type ParsedOperatorArgs,
  type ReviewGateConfig,
  type ReviewGatePreset,
  type ReviewGatesConfig,
  type ReviewPlanGateConfig,
} from '../state.ts';

type ReviewSetupStatus = 'configured' | 'reported';

interface ReviewSetupReport {
  command: 'review setup';
  status: ReviewSetupStatus;
  repoRoot: string;
  configPath: string | null;
  configPathIsLegacy: boolean;
  preset: ReviewGatePreset;
  packageJson: {
    path: string;
    found: boolean;
    malformed: boolean;
    parseError?: string;
  };
  detectedScripts: string[];
  effective: {
    planReview: {
      gates: ReviewPlanGateConfig[];
    };
    gates: ReviewGateConfig[];
  };
  missing: Array<{
    id: string;
    reason: string;
  }>;
  catalog?: Array<{
    id: string;
    kind: string;
    phase: string;
    type: string;
    presets: ReviewGatePreset[];
    available: boolean;
    command?: string;
    skill?: string;
    role?: string;
    userCommands?: string[];
    scriptNames?: string[];
    matchedScript?: string;
    optional?: boolean;
    missingReason?: string;
  }>;
  message: string;
}

export async function handleReview(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const subcommand = parsed.positional[0] ?? '';
  if (subcommand !== 'setup') {
    throw new Error('review requires one of: setup.');
  }

  handleReviewSetup(cwd, parsed);
}

function handleReviewSetup(cwd: string, parsed: ParsedOperatorArgs): void {
  let context = resolveWorkflowContext(cwd);
  const presetFlag = parsed.flags.reviewPreset.trim();
  let writeResult: { configPath: string; isLegacy: boolean } | null = null;

  if (presetFlag) {
    const preset = presetFlag as ReviewGatePreset;
    writeResult = patchReadableWorkflowConfig(context.repoRoot, (raw) => ({
      ...raw,
      reviewGates: buildReviewGatesPresetPatch(raw, preset, context.repoRoot),
    }));
    context = resolveWorkflowContext(cwd);
  }

  const preset = context.config.reviewGates?.preset ?? 'standard';
  const detection = detectPackageScripts(context.repoRoot);
  const resolvedCatalog = resolveReviewGateCatalog({ repoRoot: context.repoRoot })
    .filter((entry) => entry.presets.includes(preset));
  const effectivePlanGates = context.config.reviewGates?.planReview?.gates ?? [];
  const effectiveGates = context.config.reviewGates?.gates ?? [];
  const configPath = writeResult?.configPath ?? resolveReadableConfigPath(context.repoRoot);
  const report: ReviewSetupReport = {
    command: 'review setup',
    status: writeResult ? 'configured' : 'reported',
    repoRoot: context.repoRoot,
    configPath,
    configPathIsLegacy: writeResult?.isLegacy ?? (configPath ? path.basename(configPath) !== '.pipelane.json' : false),
    preset,
    packageJson: {
      path: detection.packageJsonPath,
      found: detection.found,
      malformed: detection.malformed,
      parseError: detection.parseError,
    },
    detectedScripts: Object.keys(detection.scripts).sort(),
    effective: {
      planReview: { gates: effectivePlanGates },
      gates: effectiveGates,
    },
    missing: resolvedCatalog
      .filter((entry) => !entry.available)
      .map((entry) => ({
        id: entry.id,
        reason: entry.missingReason ?? 'gate unavailable',
      })),
    catalog: parsed.flags.reviewListGates
      ? resolveReviewGateCatalog({ repoRoot: context.repoRoot }).map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          phase: entry.phase,
          type: entry.type,
          presets: entry.presets,
          available: entry.available,
          command: entry.command,
          skill: entry.skill,
          role: entry.role,
          userCommands: entry.userCommands,
          scriptNames: entry.scriptNames,
          matchedScript: entry.matchedScript,
          optional: entry.optional,
          missingReason: entry.missingReason,
        }))
      : undefined,
    message: '',
  };
  report.message = renderReviewSetupReport(report, {
    includeEffectiveJson: parsed.flags.reviewPrint,
    includeCatalog: parsed.flags.reviewListGates,
  });

  printResult(parsed.flags, report);
}

function renderReviewSetupReport(
  report: ReviewSetupReport,
  options: {
    includeEffectiveJson: boolean;
    includeCatalog: boolean;
  },
): string {
  const lines = [
    'Pipelane review setup',
    `Status: ${report.status}`,
    `Preset: ${report.preset}`,
    `Config: ${report.configPath ?? 'inferred from defaults/package.json overlay'}`,
  ];

  if (!report.packageJson.found) {
    lines.push(`Package scripts: no package.json found at ${report.packageJson.path}`);
  } else if (report.packageJson.malformed) {
    lines.push(`Package scripts: package.json is malformed - ${report.packageJson.parseError ?? 'unknown parse error'}`);
  } else {
    lines.push(`Package scripts: ${report.detectedScripts.length > 0 ? report.detectedScripts.join(', ') : 'none detected'}`);
  }

  lines.push('', 'Plan review gates:');
  lines.push(...formatPlanGates(report.effective.planReview.gates));

  lines.push('', 'Review gates:');
  lines.push(...formatReviewGates(report.effective.gates));

  if (report.missing.length > 0) {
    lines.push('', 'Setup gaps:');
    lines.push(...report.missing.map((entry) => `- ${entry.id}: ${entry.reason}`));
  }

  if (options.includeCatalog) {
    lines.push('', 'Gate catalog:');
    lines.push(...formatCatalog(report.catalog ?? []));
  }

  if (options.includeEffectiveJson) {
    lines.push(
      '',
      'Effective reviewGates:',
      JSON.stringify({
        preset: report.preset,
        planReview: report.effective.planReview,
        gates: report.effective.gates,
      }, null, 2),
    );
  }

  lines.push('', 'Next: use /pipelane review once the review runner slice lands.');
  return lines.join('\n');
}

function buildReviewGatesPresetPatch(
  raw: Record<string, unknown>,
  preset: ReviewGatePreset,
  repoRoot: string,
): Record<string, unknown> {
  const existing = asRecord(raw.reviewGates);
  if (!existing) {
    return { preset };
  }

  const next: Record<string, unknown> = { ...existing, preset };
  const existingPreset = isReviewGatePreset(existing.preset) ? existing.preset : 'standard';
  const generatedDefaultCandidates = getGeneratedDefaultCandidates(existingPreset, repoRoot);

  const planReview = asRecord(existing.planReview);
  if (
    planReview
    && Array.isArray(planReview.gates)
    && generatedDefaultCandidates.some((candidate) => sameJson(planReview.gates, candidate.planReview?.gates ?? []))
  ) {
    const nextPlanReview = { ...planReview };
    delete nextPlanReview.gates;
    if (Object.keys(nextPlanReview).length > 0) {
      next.planReview = nextPlanReview;
    } else {
      delete next.planReview;
    }
  }

  if (
    Array.isArray(existing.gates)
    && generatedDefaultCandidates.some((candidate) => sameJson(existing.gates, candidate.gates ?? []))
  ) {
    delete next.gates;
  }

  return next;
}

function getGeneratedDefaultCandidates(
  preset: ReviewGatePreset,
  repoRoot: string,
): ReviewGatesConfig[] {
  if (preset === 'standard') {
    return [
      defaultReviewGatesConfig({ repoRoot }),
      defaultReviewGatesConfig(),
    ];
  }
  return [
    buildReviewGatesConfigForPreset(preset, { repoRoot }),
    buildReviewGatesConfigForPreset(preset),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isReviewGatePreset(value: unknown): value is ReviewGatePreset {
  return value === 'lean' || value === 'standard' || value === 'strict-production';
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatPlanGates(gates: ReviewPlanGateConfig[]): string[] {
  if (gates.length === 0) return ['- none'];
  return gates.map((gate) => {
    const target = gate.skill ? `skill:${gate.skill}` : gate.role ? `role:${gate.role}` : gate.type;
    const when = gate.when ? ` when ${gate.when}` : '';
    return `- ${gate.id} (${target}, ${gate.blocking === false ? 'non-blocking' : 'blocking'})${when}`;
  });
}

function formatReviewGates(gates: ReviewGateConfig[]): string[] {
  if (gates.length === 0) return ['- none'];
  return gates.map((gate) => {
    const target = gate.command
      ? gate.command
      : gate.skill
        ? `skill:${gate.skill}`
        : gate.role
          ? `role:${gate.role}`
          : gate.type;
    const conditions = [
      gate.when ? `when ${gate.when}` : '',
      gate.whenChanged && gate.whenChanged.length > 0 ? `when changed: ${gate.whenChanged.join(', ')}` : '',
    ].filter(Boolean);
    const suffix = conditions.length > 0 ? ` (${conditions.join('; ')})` : '';
    return `- ${gate.id} [${gate.phase}] ${target} - ${gate.blocking === false ? 'non-blocking' : 'blocking'}${suffix}`;
  });
}

function formatCatalog(catalog: NonNullable<ReviewSetupReport['catalog']>): string[] {
  if (catalog.length === 0) return ['- none'];
  return catalog.map((entry) => {
    const target = entry.command
      ?? (entry.skill ? `skill:${entry.skill}` : undefined)
      ?? (entry.role ? `role:${entry.role}` : undefined)
      ?? (entry.scriptNames && entry.scriptNames.length > 0 ? `scripts:${entry.scriptNames.join('|')}` : undefined)
      ?? entry.type;
    const status = entry.available
      ? 'available'
      : `missing: ${entry.missingReason ?? 'gate unavailable'}`;
    const aliases = entry.userCommands && entry.userCommands.length > 0
      ? ` aliases:${entry.userCommands.join(', ')}`
      : '';
    const optional = entry.optional ? ' optional' : '';
    const matched = entry.matchedScript ? ` script:${entry.matchedScript}` : '';
    return `- ${entry.id} [${entry.kind}/${entry.phase}] ${target} - ${status} presets:${entry.presets.join('|')}${optional}${matched}${aliases}`;
  });
}
