import type { ParsedOperatorArgs } from '../state.ts';
import { buildWorkflowApiSnapshot } from '../api/snapshot.ts';

export async function handleApi(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const [subcommand] = parsed.positional;

  if (!subcommand || subcommand === 'snapshot') {
    const envelope = buildWorkflowApiSnapshot(cwd);
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  throw new Error(
    `Unknown api subcommand "${subcommand}". Supported in this build: snapshot. ` +
    '(action preflight/execute ships in a follow-up PR.)',
  );
}
