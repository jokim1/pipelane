import type { ParsedOperatorArgs } from '../state.ts';
import { buildBranchDetailsEnvelope, buildBranchPatchEnvelope } from '../api/branch.ts';
import { buildWorkflowApiSnapshot } from '../api/snapshot.ts';
import {
  STABLE_ACTION_IDS,
  buildActionPreflightEnvelope,
  isStableActionId,
  runActionExecute,
} from '../api/actions.ts';

export async function handleApi(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const [subcommand, actionId] = parsed.positional;

  if (!subcommand || subcommand === 'snapshot') {
    const envelope = await buildWorkflowApiSnapshot(cwd);
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  if (subcommand === 'branch') {
    if (!parsed.flags.branch) {
      throw new Error('api branch requires --branch <branch-name>.');
    }
    if (parsed.flags.patch && !parsed.flags.file) {
      throw new Error('api branch --patch requires --file <path>.');
    }
    if (parsed.flags.scope && parsed.flags.scope !== 'branch' && parsed.flags.scope !== 'workspace') {
      throw new Error('api branch --scope must be "branch" or "workspace".');
    }

    const scope = parsed.flags.scope === 'workspace' ? 'workspace' : 'branch';
    const envelope = parsed.flags.patch
      ? await buildBranchPatchEnvelope(cwd, parsed.flags.branch, parsed.flags.file, scope)
      : await buildBranchDetailsEnvelope(cwd, parsed.flags.branch);

    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  if (subcommand === 'action') {
    if (!actionId) {
      throw new Error(
        `api action requires an action id. Supported: ${STABLE_ACTION_IDS.join(', ')}.`,
      );
    }
    if (!isStableActionId(actionId)) {
      throw new Error(
        `Unknown action id "${actionId}". Supported: ${STABLE_ACTION_IDS.join(', ')}.`,
      );
    }

    const execute = parsed.flags.execute ?? false;
    const confirmToken = parsed.flags.confirmToken ?? '';

    const envelope = execute
      ? await runActionExecute(cwd, actionId, parsed, confirmToken)
      : buildActionPreflightEnvelope(cwd, actionId, parsed);

    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    if (!envelope.ok) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(
    `Unknown api subcommand "${subcommand}". Supported: snapshot, branch, action.`,
  );
}
