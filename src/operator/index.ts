import { handleApi } from './commands/api.ts';
import { handleAdopt } from './commands/adopt.ts';
import { handleClean } from './commands/clean.ts';
import { handleDevmode } from './commands/devmode.ts';
import { handleDeploy } from './commands/deploy.ts';
import { handleDoctor } from './commands/doctor.ts';
import { handleMerge } from './commands/merge.ts';
import { handleLocalState } from './commands/local-state.ts';
import { handleNew } from './commands/new.ts';
import { handleOrchestrate } from './commands/orchestrate.ts';
import { handlePr } from './commands/pr.ts';
import { handleRelease } from './commands/release.ts';
import { handleReleaseCheck } from './commands/release-check.ts';
import { handleRepoGuard } from './commands/repo-guard.ts';
import { handleResume } from './commands/resume.ts';
import { handleReview } from './commands/review.ts';
import { handleRollback } from './commands/rollback.ts';
import { handleStatus } from './commands/status.ts';
import { handleTaskLock } from './commands/task-lock.ts';
import { assertRepoOnboardedForDeploy as assertDeployRepoOnboarded } from './onboarding.ts';
import { assertManagedLocalStateValid } from './local-state.ts';
import {
  parseOperatorArgs,
  resolveRepoRoot,
  resolveWorkflowContext,
  validateOperatorArgs,
  type ParsedOperatorArgs,
  type WorkflowContext,
} from './state.ts';

export interface LoadedContext extends WorkflowContext {
  deployConfigText: string;
}

export type ManagedLocalStateSensitivity = 'observe' | 'current-state' | 'target-tree' | 'independent-recovery';

export function loadWorkflowContext(cwd: string): LoadedContext {
  const context = resolveWorkflowContext(cwd);

  return {
    ...context,
    deployConfigText: '',
  };
}

export async function runOperator(cwd: string, argv: string[]): Promise<void> {
  const parsed = parseOperatorArgs(argv);
  const command = parsed.command;

  if (!command || command === '--help' || command === '-h' || parsed.flags.help) {
    printUsage();
    return;
  }

  validateOperatorArgs(parsed);
  assertRepoOnboardedForDeploy(cwd, parsed);
  const managedStateSensitivity = classifyOperatorManagedStateSensitivity(parsed);
  if (managedStateSensitivity === 'current-state' || managedStateSensitivity === 'target-tree') {
    assertManagedLocalStateValid(resolveRepoRoot(cwd));
  }

  if (command === 'devmode') {
    await handleDevmode(cwd, parsed);
    return;
  }

  if (command === 'new') {
    await handleNew(cwd, parsed);
    return;
  }

  if (command === 'adopt') {
    await handleAdopt(cwd, parsed);
    return;
  }

  if (command === 'resume') {
    await handleResume(cwd, parsed);
    return;
  }

  if (command === 'repo-guard') {
    await handleRepoGuard(cwd, parsed);
    return;
  }

  if (command === 'task-lock') {
    await handleTaskLock(cwd, parsed);
    return;
  }

  if (command === 'pr') {
    await handlePr(cwd, parsed);
    return;
  }

  if (command === 'merge') {
    await handleMerge(cwd, parsed);
    return;
  }

  if (command === 'release') {
    await handleRelease(cwd, parsed);
    return;
  }

  if (command === 'release-check') {
    await handleReleaseCheck(cwd, parsed);
    return;
  }

  if (command === 'deploy') {
    await handleDeploy(cwd, parsed);
    return;
  }

  if (command === 'clean') {
    await handleClean(cwd, parsed);
    return;
  }

  if (command === 'review') {
    await handleReview(cwd, parsed);
    return;
  }

  if (command === 'orchestrate') {
    await handleOrchestrate(cwd, parsed);
    return;
  }

  if (command === 'local-state') {
    await handleLocalState(cwd, parsed);
    return;
  }

  if (command === 'status') {
    await handleStatus(cwd, parsed);
    return;
  }

  if (command === 'doctor') {
    await handleDoctor(cwd, parsed);
    return;
  }

  if (command === 'rollback') {
    await handleRollback(cwd, parsed);
    return;
  }

  if (command === 'api') {
    await handleApi(cwd, parsed);
    return;
  }

  throw new Error(`Unknown Pipelane command "${command}". Run "pipelane run --help" to see supported commands.`);
}

export function classifyOperatorManagedStateSensitivity(parsed: ParsedOperatorArgs): ManagedLocalStateSensitivity {
  switch (parsed.command) {
    case 'devmode':
    case 'adopt':
    case 'resume':
    case 'task-lock':
    case 'release':
    case 'release-check':
    case 'local-state':
    case 'status':
    case 'doctor':
    case 'api':
      return 'observe';
    case 'new':
    case 'repo-guard':
      return 'target-tree';
    case 'pr':
    case 'deploy':
      return 'current-state';
    case 'merge':
    case 'clean':
      return 'independent-recovery';
    case 'rollback':
      return parsed.flags.revertPr ? 'target-tree' : 'independent-recovery';
    case 'review': {
      const subcommand = parsed.positional[0] ?? '';
      if (subcommand === '' ) return 'current-state';
      if (subcommand === 'gc') return 'independent-recovery';
      if (subcommand === 'setup' || subcommand === 'pass' || subcommand === 'attest' || subcommand === 'override') return 'observe';
      throw new Error(`Managed local-state sensitivity is not classified for review ${subcommand}.`);
    }
    case 'orchestrate': {
      const subcommand = parsed.positional[0] ?? '';
      if (subcommand === '' || subcommand === 'run' || subcommand === 'plan' || subcommand === 'analyze') return 'current-state';
      if (subcommand === 'prepare') return 'target-tree';
      if (subcommand === 'dispatch' || subcommand === 'start' || subcommand === 'review') return 'current-state';
      if (subcommand === 'finalize') return 'independent-recovery';
      if (subcommand === 'goal-spec' || subcommand === 'plan-review' || subcommand === 'scope'
        || subcommand === 'outline' || subcommand === 'upgrade-ledger') return 'observe';
      throw new Error(`Managed local-state sensitivity is not classified for orchestrate ${subcommand}.`);
    }
    default:
      throw new Error(`Managed local-state sensitivity is not classified for operator command ${parsed.command || '(empty)'}.`);
  }
}

function assertRepoOnboardedForDeploy(cwd: string, parsed: ParsedOperatorArgs): void {
  if (parsed.command !== 'deploy') {
    return;
  }
  assertDeployRepoOnboarded(cwd, {
    environment: parsed.positional[0],
    pr: parsed.flags.pr,
  });
}

function printUsage(): void {
  process.stdout.write(`pipelane

Usage:
  pipelane setup
  pipelane configure
  pipelane update
  pipelane run <command> [args...]
  pipelane install-claude
  pipelane install-codex
  pipelane install-npm-guard
  pipelane verify

Pipelane commands:
  devmode
  new
  adopt
  resume
  repo-guard
  pr
  merge
  release [status|enable|doctor]
  release-check
  task-lock
  deploy
  clean
  review [--dry-run] [--gate <id>] [--phase static|behavioral|ai-diff|instruction|runtime|human]
  review pass --gate <id> --message <text>
  review attest --gate <id> --status <passed|failed> --report-file <path> --findings-file <path> --provenance-file <path> --message <text> [--substitute-strict --reason <reason> --scope <exact-route-action>]
  review override --gate <id> --reason <informed-consent-reason> [--scope <exact-route-action>]
  review setup [gate[,gate...]...] [--yes] [--reset] [--print] [--list-gates] [--toggle <gate[,gate...]>] [--enable <gate[,gate...]>] [--disable <gate[,gate...]>] [--install <gate[,gate...]>]
  orchestrate [--plan-file <path> | --outcome <text>] [--preview|--plan|--yes] [--analysis-file <path>] [--provider codex|claude|generic] [--max-turns <n>] [--max-minutes <n>]
  orchestrate goal-spec [--slice-id <id>] [--outcome <text>] [--plan-file <path>] [--provider codex|claude|generic] [--max-turns <n>] [--max-minutes <n>]
  orchestrate plan [--slice-id <id>] (--plan-file <path> | --outcome <text>) [--provider codex|claude|generic] [--max-turns <n>] [--max-minutes <n>]
  orchestrate analyze (--plan-file <path> | --run-id <id>) --analysis-file <path> [--slices-file <path>]
  orchestrate plan-review <pass|bypass> --run-id <id> --gate <id> (--message <text> | --reason <text>)
  orchestrate prepare --run-id <id> [--offline]
  orchestrate dispatch --run-id <id>
  orchestrate start --run-id <id> [--slice-id <id>] [--force]
  orchestrate review --run-id <id> [--slice-id <id>] [--dry-run] [--gate <id>] [--phase static|behavioral|ai-diff|instruction|runtime|human]
  local-state list [--json]
  local-state add --path <path> --reason <text> [--yes]
  local-state remove --path <path> [--yes]
  status
  doctor [--probe | --fix | --check-guard]
  rollback <staging|prod> [--surfaces ...] [--revert-pr]
  api snapshot
  api branch --branch <branch>
  api branch --branch <branch> --patch --file <path> [--scope branch|workspace]
`);
}
