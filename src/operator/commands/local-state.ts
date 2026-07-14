import readline from 'node:readline/promises';

import {
  addPlannedManagedLocalState,
  escapeManagedIgnorePattern,
  inspectManagedLocalState,
  planManagedLocalStateAdd,
  planManagedLocalStateRemove,
  removePlannedManagedLocalState,
  type LocalStateEntryV1,
} from '../local-state.ts';
import { printResult, resolveWorkflowContext, type ParsedOperatorArgs } from '../state.ts';

export async function handleLocalState(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const subcommand = parsed.positional[0] ?? '';
  if (subcommand === 'list') {
    const inspection = inspectManagedLocalState(context.repoRoot);
    if (!inspection.canonicalBlock) throw new Error(inspection.warnings.join('\n'));
    const entries = inspection.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      reason: entry.reason,
      createdAt: entry.createdAt,
      present: entry.present,
      actualKind: entry.actualKind,
      conflict: entry.conflicts.length > 0,
      conflicts: [...entry.conflicts],
    }));
    printResult(parsed.flags, {
      command: 'local-state list',
      repoRoot: context.repoRoot,
      excludePath: inspection.excludePath,
      initialized: inspection.initialized,
      valid: inspection.valid,
      entries,
      message: renderListMessage(inspection.excludePath, inspection.valid, entries),
    });
    return;
  }

  if (subcommand === 'add') {
    const planned = planManagedLocalStateAdd(
      context.repoRoot,
      parsed.flags.localPath,
      parsed.flags.reason,
    );
    const pattern = escapeManagedIgnorePattern(planned.path, planned.kind);
    const approved = await authorizeMutation(parsed, [
      'Register this machine-local runtime root?',
      `Path: ${planned.path}`,
      `Kind: ${planned.kind}`,
      `Git exclude rule: ${pattern}`,
      `Reason: ${planned.reason}`,
      'Effect: untracked content at this exact root will stop appearing in normal Git status and git add -A.',
      'Tracked content remains visible. This does not delete the path or authorize cleanup.',
    ]);
    if (!approved) {
      printResult(parsed.flags, { cancelled: true, path: planned.path, message: `Cancelled local-state add for ${planned.path}; no exclude bytes were changed.` });
      return;
    }
    const entry = addPlannedManagedLocalState(context.repoRoot, planned);
    printResult(parsed.flags, {
      command: 'local-state add',
      repoRoot: context.repoRoot,
      excludePath: inspectManagedLocalState(context.repoRoot).excludePath,
      entry,
      removeCommand: `pipelane run local-state remove --path ${shellQuote(entry.path)} --yes`,
      message: [
        `Registered machine-local state root: ${entry.path}`,
        `Reason: ${entry.reason}`,
        `Rule: ${escapeManagedIgnorePattern(entry.path, entry.kind)}`,
        `Remove: pipelane run local-state remove --path ${shellQuote(entry.path)} --yes`,
      ].join('\n'),
    });
    return;
  }

  if (subcommand === 'remove') {
    const planned = planManagedLocalStateRemove(context.repoRoot, parsed.flags.localPath);
    const approved = await authorizeMutation(parsed, [
      'Remove this machine-local runtime declaration?',
      `Path: ${planned.path}`,
      `Reason: ${planned.reason}`,
      'Effect: existing runtime content will become visible to Git again.',
      'No file or directory will be deleted. The empty Pipelane v1 block will remain initialized.',
    ]);
    if (!approved) {
      printResult(parsed.flags, { cancelled: true, path: planned.path, message: `Cancelled local-state remove for ${planned.path}; no exclude bytes were changed.` });
      return;
    }
    const entry = removePlannedManagedLocalState(context.repoRoot, planned);
    printResult(parsed.flags, {
      command: 'local-state remove',
      repoRoot: context.repoRoot,
      excludePath: inspectManagedLocalState(context.repoRoot).excludePath,
      entry,
      message: [
        `Removed machine-local state declaration: ${entry.path}`,
        'Disk content was left untouched and is now visible to normal Git status.',
        'The canonical empty Pipelane local-state v1 block remains in place.',
      ].join('\n'),
    });
    return;
  }

  throw new Error('local-state requires one of: list, add, remove.');
}

async function authorizeMutation(parsed: ParsedOperatorArgs, previewLines: string[]): Promise<boolean> {
  if (parsed.flags.yes) return true;
  const stub = process.env.PIPELANE_LOCAL_STATE_CONFIRM_STUB;
  if (stub !== undefined && process.env.NODE_ENV !== 'test') {
    throw new Error('PIPELANE_LOCAL_STATE_CONFIRM_STUB is a test-only hook. Unset it and retry.');
  }
  const canPrompt = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!canPrompt && stub === undefined) {
    throw new Error([
      'Non-interactive local-state mutation requires explicit --yes authorization.',
      'For add, pass one exact --path, a non-empty --reason, and --yes.',
      'For remove, pass one exact --path and --yes.',
    ].join('\n'));
  }

  const preview = `${previewLines.join('\n')}\n`;
  if (parsed.flags.json) process.stderr.write(preview);
  else process.stdout.write(preview);
  if (stub !== undefined) {
    if (stub === 'eof') return false;
    return /^(?:1|y|yes)$/iu.test(stub.trim());
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Proceed? Enter 1 or Y to continue. [y/N] ')).trim();
    return /^(?:1|y|yes)$/iu.test(answer);
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

function renderListMessage(
  excludePath: string,
  valid: boolean,
  entries: Array<Pick<LocalStateEntryV1, 'path' | 'kind' | 'reason' | 'createdAt'> & {
    present: boolean;
    actualKind: string;
    conflict: boolean;
    conflicts: string[];
  }>,
): string {
  const lines = [
    'Pipelane machine-local state declarations',
    `Exclude file: ${excludePath}`,
    `Policy: ${valid ? 'valid' : 'conflicting'}`,
  ];
  if (entries.length === 0) {
    lines.push('Entries: none (the persistent empty v1 block is initialized).');
    return lines.join('\n');
  }
  lines.push('Entries:');
  for (const entry of entries) {
    lines.push(`- ${entry.path} [${entry.kind}] ${entry.present ? `present as ${entry.actualKind}` : 'missing'}${entry.conflict ? ' CONFLICT' : ''}`);
    lines.push(`  Reason: ${entry.reason}`);
    lines.push(`  Created: ${entry.createdAt}`);
    for (const conflict of entry.conflicts) lines.push(`  Conflict: ${conflict}`);
  }
  return lines.join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
