import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { handleApi } from './commands/api.ts';
import { handleClean } from './commands/clean.ts';
import { handleDevmode } from './commands/devmode.ts';
import { handleDeploy } from './commands/deploy.ts';
import { handleDoctor } from './commands/doctor.ts';
import { handleMerge } from './commands/merge.ts';
import { handleNew } from './commands/new.ts';
import { handlePr } from './commands/pr.ts';
import { handleReleaseCheck } from './commands/release-check.ts';
import { handleRepoGuard } from './commands/repo-guard.ts';
import { handleResume } from './commands/resume.ts';
import { handleRollback } from './commands/rollback.ts';
import { handleStatus } from './commands/status.ts';
import { handleTaskLock } from './commands/task-lock.ts';
import { loadDeployConfig } from './release-gate.ts';
import {
  parseOperatorArgs,
  resolveWorkflowContext,
  type ParsedOperatorArgs,
  type WorkflowContext,
} from './state.ts';

export interface LoadedContext extends WorkflowContext {
  deployConfigText: string;
}

export function loadWorkflowContext(cwd: string): LoadedContext {
  const context = resolveWorkflowContext(cwd);
  const claudePath = path.join(context.repoRoot, 'CLAUDE.md');
  const deployConfigText = loadDeployConfig(context.repoRoot) && existsSync(claudePath)
    ? readFileSync(claudePath, 'utf8')
    : '';

  return {
    ...context,
    deployConfigText,
  };
}

export async function runOperator(cwd: string, argv: string[]): Promise<void> {
  const parsed = parseOperatorArgs(argv);
  const command = parsed.command;

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'devmode') {
    await handleDevmode(cwd, parsed);
    return;
  }

  if (command === 'new') {
    await handleNew(cwd, parsed);
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

  throw new Error(`Unknown Pipelane command "${command}".`);
}

function printUsage(): void {
  process.stdout.write(`pipelane

Usage:
  pipelane bootstrap --project "Project Name"
  pipelane init --project "Project Name"
  pipelane setup
  pipelane run <command> [args...]
  pipelane sync-docs
  pipelane install-claude
  pipelane install-codex

Pipelane commands:
  devmode
  new
  resume
  repo-guard
  pr
  merge
  release-check
  task-lock
  deploy
  clean
  status
  doctor [--probe | --fix]
  rollback <staging|prod> [--surfaces ...] [--revert-pr]
  api snapshot
  api branch --branch <branch>
  api branch --branch <branch> --patch --file <path> [--scope branch|workspace]
`);
}
