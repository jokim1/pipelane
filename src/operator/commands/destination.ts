import {
  buildDestinationPlanForCommand,
  destinationPlanFingerprintDigest,
  printDestinationPlan,
  shouldInterceptDestinationPlan,
} from '../destination-planner.ts';
import {
  DESTINATION_APPROVED_ROUTE_FINGERPRINT_ENV,
  confirmDestinationRoute,
  DESTINATION_INTERNAL_STEP_ENV,
  executeDestinationRoute,
  nonTtyConfirmationMessageForParsed,
} from '../destination-executor.ts';
import { printResult, type ParsedOperatorArgs } from '../state.ts';

export async function maybeHandleDestinationCommand(cwd: string, parsed: ParsedOperatorArgs): Promise<boolean> {
  if (process.env[DESTINATION_INTERNAL_STEP_ENV] === '1') return false;

  const plan = buildDestinationPlanForCommand(cwd, parsed);
  if (!plan || !shouldInterceptDestinationPlan(plan, parsed)) return false;

  const approvedFingerprint = process.env[DESTINATION_APPROVED_ROUTE_FINGERPRINT_ENV]?.trim() ?? '';
  if (approvedFingerprint && destinationPlanFingerprintDigest(plan) !== approvedFingerprint) {
    printDestinationPlan(parsed.flags, {
      ...plan,
      message: [
        plan.message,
        '',
        'destination route changed after API confirmation. Re-run the preflight so the route, surfaces, PR, SHA, and worktree changes are approved together.',
      ].join('\n'),
    });
    process.exitCode = 1;
    return true;
  }

  if (plan.blockers.length > 0) {
    printDestinationPlan(parsed.flags, plan);
    process.exitCode = 1;
    return true;
  }
  if (parsed.flags.plan || plan.remainingSteps.length === 0) {
    printDestinationPlan(parsed.flags, plan);
    return true;
  }
  if (!parsed.flags.yes && !process.stdin.isTTY) {
    printDestinationPlan(parsed.flags, {
      ...plan,
      message: `${plan.message}\n\n${nonTtyConfirmationMessageForParsed(plan, parsed)}`,
    });
    process.exitCode = 1;
    return true;
  }

  // JSON callers need a single structured result; the final output below
  // carries the plan plus per-step execution records.
  if (!parsed.flags.json) {
    printDestinationPlan(parsed.flags, plan);
  }

  const confirmation = await confirmDestinationRoute(plan, parsed);
  if (confirmation === 'cancel') {
    return true;
  }

  const execution = await executeDestinationRoute(cwd, parsed, plan, {
    stopAfterFirstExecutableStep: confirmation === 'run_next',
  });
  if (!execution.completed) {
    const failedOutput = execution.steps
      .filter((step) => step.exitCode !== 0)
      .map((step) => step.stderr.trim() || step.stdout.trim())
      .filter(Boolean)
      .at(-1);
    const message = [
      `destination route stopped at ${execution.failedStep ?? 'unknown step'}.`,
      execution.failedStep ? `Next safe command: ${execution.failedStep}` : 'Inspect the execution records before retrying.',
      execution.failureMessage ?? failedOutput ?? '',
    ].filter(Boolean).join('\n');
    if (parsed.flags.json) {
      printResult(parsed.flags, { ...plan, execution, message });
      process.exitCode = 1;
      return true;
    }
    throw new Error(message);
  }
  if (parsed.flags.json) {
    const completedStep = execution.steps.at(-1)?.command ?? 'next step';
    printResult(parsed.flags, {
      ...plan,
      execution,
      message: confirmation === 'run_next'
        ? `Completed ${completedStep}; route to ${plan.targetCommand} was not continued.`
        : `Completed route to ${plan.targetCommand}.`,
    });
  }
  return true;
}
