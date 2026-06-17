import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  buildGoalSpecDraft,
  type GoalSpecDraft,
} from '../goal-spec.ts';
import {
  buildOrchestrationRunRecord,
  saveOrchestrationRunRecord,
  type OrchestrationRunRecord,
} from '../orchestration-ledger.ts';
import {
  DEFAULT_GOAL_PROVIDER,
  type GoalProvider,
  printResult,
  resolveWorkflowContext,
  type ParsedOperatorArgs,
} from '../state.ts';

const MAX_PLAN_FILE_BYTES = 256 * 1024;

interface OrchestrateGoalSpecReport {
  command: 'orchestrate goal-spec';
  status: 'drafted';
  repoRoot: string;
  planPath: string | null;
  spec: GoalSpecDraft['spec'];
  provider: GoalProvider;
  providerPrompt: string;
  confirmationPrompt: string;
  requiresConfirmation: boolean;
  critique: string[];
  source: GoalSpecDraft['source'];
  message: string;
}

interface OrchestratePlanReport {
  command: 'orchestrate plan';
  status: 'planned';
  repoRoot: string;
  runId: string;
  ledgerPath: string;
  planPath: string | null;
  sliceCount: number;
  confirmationRecommended: boolean;
  run: OrchestrationRunRecord;
  message: string;
}

export async function handleOrchestrate(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const subcommand = parsed.positional[0] ?? '';
  if (subcommand === 'goal-spec') {
    handleGoalSpec(cwd, parsed);
    return;
  }
  if (subcommand === 'plan') {
    handlePlan(cwd, parsed);
    return;
  }

  throw new Error('orchestrate requires exactly: pipelane run orchestrate <goal-spec|plan> [--slice-id <id>] [--outcome <text>] [--plan-file <path>] [--provider codex|claude|generic]');
}

function handleGoalSpec(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const planPath = resolvePlanPath(context.repoRoot, parsed.flags.goalPlanFile);
  const draft = buildGoalSpecDraft({
    config: context.config,
    sliceId: parsed.flags.goalSliceId,
    outcome: parsed.flags.goalOutcome,
    planPath: planPath ?? undefined,
    planText: planPath ? readPlanFile(planPath) : undefined,
    provider: (parsed.flags.goalProvider.trim() as GoalProvider) || DEFAULT_GOAL_PROVIDER,
    maxTurns: parsePositiveInteger(parsed.flags.goalMaxTurns),
    maxMinutes: parsePositiveInteger(parsed.flags.goalMaxMinutes),
  });

  const report: OrchestrateGoalSpecReport = {
    command: 'orchestrate goal-spec',
    status: 'drafted',
    repoRoot: context.repoRoot,
    planPath,
    spec: draft.spec,
    provider: draft.provider,
    providerPrompt: draft.providerPrompt,
    confirmationPrompt: draft.confirmationPrompt,
    requiresConfirmation: draft.requiresConfirmation,
    critique: draft.critique,
    source: draft.source,
    message: renderGoalSpecReport(draft, planPath),
  };

  printResult(parsed.flags, report);
}

function handlePlan(cwd: string, parsed: ParsedOperatorArgs): void {
  const context = resolveWorkflowContext(cwd);
  const planPath = resolvePlanPath(context.repoRoot, parsed.flags.goalPlanFile);
  const planText = planPath ? readPlanFile(planPath) : '';
  const outcome = parsed.flags.goalOutcome.trim();
  if (!planText.trim() && !outcome) {
    throw new Error('orchestrate plan requires --plan-file <path> or --outcome <text>.');
  }

  const run = buildOrchestrationRunRecord({
    repoRoot: context.repoRoot,
    config: context.config,
    planPath: planPath ?? undefined,
    planText,
    outcome,
    sliceId: parsed.flags.goalSliceId,
    provider: (parsed.flags.goalProvider.trim() as GoalProvider) || DEFAULT_GOAL_PROVIDER,
    maxTurns: parsePositiveInteger(parsed.flags.goalMaxTurns),
    maxMinutes: parsePositiveInteger(parsed.flags.goalMaxMinutes),
  });
  const ledgerPath = saveOrchestrationRunRecord(context.commonDir, context.config, run);
  const confirmationRecommended = run.slices.some((slice) => slice.requiresConfirmation || slice.critique.length > 0);
  const report: OrchestratePlanReport = {
    command: 'orchestrate plan',
    status: 'planned',
    repoRoot: context.repoRoot,
    runId: run.id,
    ledgerPath,
    planPath,
    sliceCount: run.slices.length,
    confirmationRecommended,
    run,
    message: renderPlanReport(run, ledgerPath, planPath, confirmationRecommended),
  };

  printResult(parsed.flags, report);
}

function resolvePlanPath(repoRoot: string, rawPlanPath: string): string | null {
  const trimmed = rawPlanPath.trim();
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(repoRoot, trimmed);
  if (!existsSync(resolved)) {
    throw new Error(`--plan-file not found: ${trimmed}`);
  }
  const repoRealpath = realpathSync(repoRoot);
  const planRealpath = realpathSync(resolved);
  const relative = path.relative(repoRealpath, planRealpath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--plan-file must stay inside the repo: ${trimmed}`);
  }
  return planRealpath;
}

function readPlanFile(planPath: string): string {
  const stat = statSync(planPath);
  if (!stat.isFile()) {
    throw new Error(`--plan-file must point to a regular file: ${planPath}`);
  }
  if (stat.size > MAX_PLAN_FILE_BYTES) {
    throw new Error(`--plan-file is too large: ${stat.size} bytes, max ${MAX_PLAN_FILE_BYTES}.`);
  }
  return readFileSync(planPath, 'utf8');
}

function parsePositiveInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return Number.parseInt(trimmed, 10);
}

function renderGoalSpecReport(draft: GoalSpecDraft, planPath: string | null): string {
  const lines = [
    'Pipelane orchestrate goal-spec',
    '',
    `Status: drafted`,
    `Slice: ${draft.spec.sliceId}`,
    `Outcome: ${draft.spec.outcome}`,
    `Provider: ${draft.provider}`,
  ];

  if (planPath) lines.push(`Plan file: ${planPath}`);
  lines.push(
    `Confirmation: ${draft.requiresConfirmation ? 'recommended before execution' : 'not required by current policy'}`,
  );

  if (draft.critique.length > 0) {
    lines.push('', 'Critique:');
    for (const item of draft.critique) lines.push(`- ${item}`);
  }

  lines.push('', draft.confirmationPrompt);
  lines.push('', 'Provider prompt:', draft.providerPrompt);

  return lines.join('\n');
}

function renderPlanReport(
  run: OrchestrationRunRecord,
  ledgerPath: string,
  planPath: string | null,
  confirmationRecommended: boolean,
): string {
  const lines = [
    'Pipelane orchestrate plan',
    '',
    `Status: planned`,
    `Run: ${run.id}`,
    `Ledger: ${ledgerPath}`,
    `Plan: ${planPath ?? run.source.prompt ?? '(outcome only)'}`,
    `Slices: ${run.slices.length}`,
  ];

  if (confirmationRecommended) {
    lines.push('Confirmation: recommended before execution');
  }

  lines.push('', 'Slice ledger:');
  for (const slice of run.slices) {
    const flags = [
      slice.requiresConfirmation ? 'confirm' : '',
      slice.critique.length > 0 ? 'critique' : '',
    ].filter(Boolean);
    lines.push(`- ${slice.id}: ${slice.outcome}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`);
  }

  lines.push(
    '',
    'Next: review the generated GoalSpec prompts, then run future slice execution from this ledger.',
  );

  return lines.join('\n');
}
