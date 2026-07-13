import { assertOnlyFlags, type OperatorFlagKey, type ParsedOperatorArgs } from '../state.ts';
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

    assertOnlyFlags(parsed, [
      ...API_ACTION_INPUT_FLAGS[actionId],
      'execute',
      'confirmToken',
      'autoConfirm',
    ]);

    const execute = parsed.flags.execute ?? false;
    let confirmToken = parsed.flags.confirmToken ?? '';

    if (execute && parsed.flags.autoConfirm) {
      const preflight = buildActionPreflightEnvelope(cwd, actionId, parsed);
      if (!preflight.ok) {
        process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
        process.exitCode = 1;
        return;
      }
      confirmToken = preflight.data.preflight.confirmation?.token ?? '';
    }

    const envelope = execute
      ? await runActionExecute(cwd, actionId, parsed, confirmToken)
      : buildActionPreflightEnvelope(cwd, actionId, parsed);

    if (!execute && !parsed.flags.json) {
      const token = envelope.data.preflight.confirmation?.token;
      if (token) process.stdout.write(`PIPELANE_CONFIRM_TOKEN=${token}\n`);
    }
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

const API_ACTION_INPUT_FLAGS: Record<(typeof STABLE_ACTION_IDS)[number], OperatorFlagKey[]> = {
  new: ['task', 'offline'],
  resume: ['task'],
  'devmode.build': ['task'],
  'devmode.release': ['task', 'surfaces', 'override', 'reason'],
  'taskLock.verify': ['task', 'mode'],
  pr: ['task', 'title', 'message', 'recover', 'bindingFingerprint', 'override', 'reason'],
  merge: ['task', 'pr', 'override', 'reason'],
  'deploy.staging': ['task', 'pr', 'sha', 'surfaces'],
  'deploy.prod': ['task', 'pr', 'sha', 'surfaces'],
  'route.merge': ['task', 'pr', 'title', 'message', 'override', 'reason'],
  'route.deploy.staging': ['task', 'pr', 'sha', 'surfaces', 'title', 'message'],
  'route.deploy.prod': ['task', 'pr', 'sha', 'surfaces', 'title', 'message'],
  'clean.plan': [],
  'clean.apply': ['task', 'allStale'],
  'doctor.diagnose': [],
  'doctor.probe': [],
  'git.catchupBase': [],
  'rollback.staging': ['task', 'surfaces'],
  'rollback.prod': ['task', 'surfaces'],
};
