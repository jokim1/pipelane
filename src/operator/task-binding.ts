import { createHash } from 'node:crypto';

import {
  inferTaskSlugsFromBranchName as inferTaskSlugsFromBranchNameFromHelpers,
  loadOpenPrForBranch,
} from './commands/helpers.ts';
import { taskBranchMatches, verifyTaskLockState } from './repo-guard.ts';
import {
  DEFAULT_MODE,
  formatWorkflowCommand,
  loadAllTaskLocks,
  loadPrRecord,
  loadTaskLock,
  normalizeExistingPath,
  normalizePath,
  nowIso,
  runGit,
  saveTaskLock,
  slugifyTaskName,
  type TaskLock,
  type WorkflowConfig,
  type WorkflowContext,
} from './state.ts';
import { readWorktreeStatusSnapshot } from './worktree-status.ts';

export const TASK_BINDING_RECOVERY_VALUES = [
  'use-current-checkout',
  'continue-attached-workspace',
] as const;

interface ReadWorktreeSnapshotOptions {
  includeStatusDigest?: boolean;
}

export type TaskBindingRecovery = (typeof TASK_BINDING_RECOVERY_VALUES)[number];

export interface TaskBindingRecoveryOption {
  value: TaskBindingRecovery;
  label: string;
  description: string;
  fingerprint: string;
  params: Record<string, string>;
}

export interface TaskBindingWorktreeSnapshot {
  repoRoot: string;
  exists: boolean;
  branchName: string;
  commonDir: string;
  head: string;
  statusDigest: string;
  dirty: boolean;
  statusEntryCount: number;
  statusDigestReliable: boolean;
  statusDigestWarnings: string[];
}

export type TaskBindingDiagnosis =
  | TaskBindingResolved
  | TaskBindingNeedsRecovery
  | TaskBindingBlocked;

export interface TaskBindingResolved {
  status: 'resolved';
  taskSlug: string;
  lock: TaskLock;
  current: TaskBindingWorktreeSnapshot;
}

export interface TaskBindingNeedsRecovery {
  status: 'needs-recovery';
  taskSlug: string;
  lock: TaskLock;
  current: TaskBindingWorktreeSnapshot;
  attached: TaskBindingWorktreeSnapshot;
  mismatches: string[];
  reason: string;
  options: TaskBindingRecoveryOption[];
}

export interface TaskBindingBlocked {
  status: 'blocked';
  current: TaskBindingWorktreeSnapshot;
  reason: string;
  taskSlug?: string;
  lock?: TaskLock;
  attached?: TaskBindingWorktreeSnapshot;
  mismatches?: string[];
}

export interface AppliedTaskBindingRecovery {
  taskSlug: string;
  lock: TaskLock;
  branchName: string;
}

export interface TaskBindingHandoff {
  taskSlug: string;
  lock: TaskLock;
  message: string;
}

export interface LocalPrTitleRequirement {
  required: boolean;
  defaultTitle: string;
}

export function isTaskBindingRecovery(value: unknown): value is TaskBindingRecovery {
  return TASK_BINDING_RECOVERY_VALUES.includes(value as TaskBindingRecovery);
}

export function inferTaskSlugsFromBranchName(config: WorkflowConfig, branchName: string): string[] {
  return inferTaskSlugsFromBranchNameFromHelpers(config, branchName);
}

export function inferTaskSlugFromBranchName(config: WorkflowConfig, branchName: string): string {
  const slugs = inferTaskSlugsFromBranchName(config, branchName);
  return slugs.length === 1 ? slugs[0] : '';
}

export function diagnoseTaskBinding(context: WorkflowContext, explicitTask = ''): TaskBindingDiagnosis {
  const current = readWorktreeSnapshot(context.repoRoot);
  if (!current.branchName) {
    return {
      status: 'blocked',
      current,
      reason: 'Cannot recover task binding from a detached HEAD. Check out a branch for this task, then retry.',
    };
  }

  const candidates = selectTaskBindingCandidates(context, current.branchName, explicitTask);

  if (candidates.status === 'blocked') {
    return {
      status: 'blocked',
      current,
      reason: candidates.reason,
      taskSlug: candidates.taskSlug,
    };
  }

  const { taskSlug, lock } = candidates;
  const mismatches = verifyTaskLockState({
    branchName: current.branchName,
    repoRoot: context.repoRoot,
    requestedMode: '',
    currentMode: context.modeState.mode ?? DEFAULT_MODE,
    lock,
  });

  if (mismatches.length === 0) {
    return {
      status: 'resolved',
      taskSlug,
      lock,
      current,
    };
  }

  const bindingMismatches = mismatches.filter((mismatch) =>
    mismatch.startsWith('expected branch ') || mismatch.startsWith('expected worktree ')
  );
  if (bindingMismatches.length === 0) {
    return {
      status: 'blocked',
      current,
      taskSlug,
      lock,
      reason: [
        'Task lock mismatch.',
        ...mismatches.map((mismatch) => `- ${mismatch}`),
      ].join('\n'),
      mismatches,
    };
  }
  if (bindingMismatches.length !== mismatches.length) {
    const nonBindingMismatches = mismatches.filter((mismatch) => !bindingMismatches.includes(mismatch));
    return {
      status: 'blocked',
      current,
      taskSlug,
      lock,
      reason: [
        `Cannot recover task ${taskSlug} because the task lock has mismatch(es) that rebinding cannot fix.`,
        ...nonBindingMismatches.map((mismatch) => `- ${mismatch}`),
        'Fix those mismatch(es), then retry PR recovery.',
      ].join('\n'),
      mismatches,
    };
  }

  const currentOwners = findCurrentCheckoutOwners(context, taskSlug, current);
  if (currentOwners.length > 0) {
    return {
      status: 'blocked',
      current,
      taskSlug,
      lock,
      reason: [
        `Cannot recover task ${taskSlug} into this checkout because it is already locked by another task.`,
        ...currentOwners.map((owner) => `- ${owner.taskSlug}: ${owner.branchName} at ${owner.worktreePath}`),
        'Use the existing task, clean up the stale lock, or switch to an unowned checkout before retrying.',
      ].join('\n'),
      mismatches,
    };
  }

  const attached = readWorktreeSnapshot(lock.worktreePath);
  if (attached.exists && !attached.commonDir) {
    return {
      status: 'blocked',
      current,
      attached,
      taskSlug,
      lock,
      reason: `Cannot recover task ${taskSlug} because its attached workspace is not a git checkout: ${lock.worktreePath}`,
      mismatches,
    };
  }
  if (attached.commonDir && normalizePath(attached.commonDir) !== normalizePath(context.commonDir)) {
    return {
      status: 'blocked',
      current,
      attached,
      taskSlug,
      lock,
      reason: [
        `Cannot recover task ${taskSlug} because the attached workspace uses a different git common dir.`,
        `Current common dir: ${context.commonDir}`,
        `Attached common dir: ${attached.commonDir}`,
      ].join('\n'),
      mismatches,
    };
  }

  const currentForRecovery = readWorktreeSnapshot(context.repoRoot, { includeStatusDigest: true });
  const attachedForRecovery = attached.exists
    ? readWorktreeSnapshot(lock.worktreePath, { includeStatusDigest: true })
    : attached;

  const diagnosis: Omit<TaskBindingNeedsRecovery, 'options'> = {
    status: 'needs-recovery',
    taskSlug,
    lock,
    current: currentForRecovery,
    attached: attachedForRecovery,
    mismatches,
    reason: buildRecoveryReason(taskSlug, mismatches),
  };

  const currentRecoveryBlocker = currentCheckoutRecoveryBlocker(context, diagnosis);
  const options = buildRecoveryOptions(context, diagnosis);
  if (options.length === 0) {
    const attachedBlocker = diagnosis.attached.exists
      ? ''
      : `Attached task workspace is missing: ${diagnosis.lock.worktreePath}`;
    return {
      status: 'blocked',
      current,
      attached,
      taskSlug,
      lock,
      reason: [
        `Cannot recover task ${taskSlug} from this checkout.`,
        currentRecoveryBlocker,
        attachedBlocker,
        'Switch to a task-owned branch or recreate the attached task workspace before retrying.',
      ].filter(Boolean).join('\n'),
      mismatches,
    };
  }

  return {
    ...diagnosis,
    reason: currentRecoveryBlocker
      ? [
        diagnosis.reason,
        '',
        'Current checkout rebind is unavailable:',
        currentRecoveryBlocker,
      ].join('\n')
      : diagnosis.reason,
    options,
  };
}

export function validateTaskBindingRecoverySelection(
  context: WorkflowContext,
  explicitTask: string,
  recovery: string,
  fingerprint: string,
): TaskBindingNeedsRecovery {
  if (!isTaskBindingRecovery(recovery)) {
    throw new Error(`Unknown task binding recovery choice "${recovery}".`);
  }
  const diagnosis = diagnoseTaskBinding(context, explicitTask);
  if (diagnosis.status !== 'needs-recovery') {
    throw new Error('Task binding recovery is no longer available. Run the preflight again.');
  }
  const option = diagnosis.options.find((candidate) => candidate.value === recovery);
  if (!option || option.fingerprint !== fingerprint.trim()) {
    throw new Error('Task binding recovery selection is stale. Run the preflight again.');
  }
  return diagnosis;
}

export function applyTaskBindingRecovery(
  context: WorkflowContext,
  explicitTask: string,
  recovery: string,
  fingerprint: string,
): AppliedTaskBindingRecovery | TaskBindingHandoff {
  const diagnosis = validateTaskBindingRecoverySelection(context, explicitTask, recovery, fingerprint);

  if (recovery === 'continue-attached-workspace') {
    return {
      taskSlug: diagnosis.taskSlug,
      lock: diagnosis.lock,
      message: [
        'Continue in the attached task workspace.',
        `Task: ${diagnosis.taskSlug}`,
        `Branch: ${diagnosis.lock.branchName}`,
        `Worktree: ${diagnosis.lock.worktreePath}`,
        'No PR action was run from the current checkout.',
      ].join('\n'),
    };
  }

  const latestLock = loadTaskLock(context.commonDir, context.config, diagnosis.taskSlug);
  if (!latestLock) {
    throw new Error(`No task lock found for ${diagnosis.taskSlug}. Run the preflight again.`);
  }
  if (
    latestLock.branchName !== diagnosis.lock.branchName
    || normalizeExistingPath(latestLock.worktreePath) !== normalizeExistingPath(diagnosis.lock.worktreePath)
    || latestLock.mode !== diagnosis.lock.mode
    || (latestLock.updatedAt ?? '') !== (diagnosis.lock.updatedAt ?? '')
  ) {
    throw new Error('Task binding recovery selection is stale. Run the preflight again.');
  }

  const updatedAt = nowIso();
  const history = [
    ...(Array.isArray(latestLock.bindingHistory) ? latestLock.bindingHistory : []),
    {
      reboundAt: updatedAt,
      reason: 'pr recovery: use current checkout',
      fromBranchName: latestLock.branchName,
      fromWorktreePath: latestLock.worktreePath,
      toBranchName: diagnosis.current.branchName,
      toWorktreePath: context.repoRoot,
      fingerprint,
    },
  ].slice(-20);

  const lock = saveTaskLock(context.commonDir, context.config, diagnosis.taskSlug, {
    taskSlug: latestLock.taskSlug,
    taskName: latestLock.taskName,
    branchName: diagnosis.current.branchName,
    worktreePath: context.repoRoot,
    mode: latestLock.mode,
    surfaces: latestLock.surfaces,
    bindingHistory: history,
    updatedAt,
  });

  return {
    taskSlug: diagnosis.taskSlug,
    lock,
    branchName: diagnosis.current.branchName,
  };
}

export function formatTaskBindingRecoveryMessage(diagnosis: TaskBindingNeedsRecovery): string {
  const optionLines = diagnosis.options.flatMap((option, index) => [
    `${index + 1}. ${option.label}`,
    `   ${option.description}`,
  ]);
  const optionCount = diagnosis.options.length;
  const attachedState = diagnosis.attached.exists
    ? `${diagnosis.lock.branchName} at ${diagnosis.lock.worktreePath}${diagnosis.attached.dirty ? ` (${diagnosis.attached.statusEntryCount} uncommitted status entr${diagnosis.attached.statusEntryCount === 1 ? 'y' : 'ies'})` : ''}`
    : `${diagnosis.lock.branchName} at ${diagnosis.lock.worktreePath} (missing)`;

  return [
    diagnosis.reason,
    '',
    `You have ${optionCount} option${optionCount === 1 ? '' : 's'}:`,
    ...optionLines,
    '',
    'Type which option you would like to proceed with.',
    '',
    `Current checkout: ${diagnosis.current.branchName} at ${diagnosis.current.repoRoot}`,
    `Attached task workspace: ${attachedState}`,
    `Task: ${diagnosis.taskSlug}`,
  ].join('\n');
}

export function resolveLocalPrTitleRequirement(
  context: WorkflowContext,
  taskSlug: string,
  branchName: string,
  providedTitle: string,
): LocalPrTitleRequirement {
  if (providedTitle.trim()) {
    return { required: false, defaultTitle: '' };
  }
  const statusText = runGit(context.repoRoot, ['status', '--short'], true) ?? '';
  if (!statusText.trim()) {
    return { required: false, defaultTitle: '' };
  }
  if (loadOpenPrForBranch(context.repoRoot, branchName)) {
    return { required: false, defaultTitle: '' };
  }
  const record = loadPrRecord(context.commonDir, context.config, taskSlug);
  const defaultTitle = record?.branchName === branchName ? record.title.trim() : '';
  return { required: true, defaultTitle };
}

function selectTaskBindingCandidates(
  context: WorkflowContext,
  currentBranchName: string,
  explicitTask: string,
): { status: 'selected'; taskSlug: string; lock: TaskLock } | { status: 'blocked'; reason: string; taskSlug?: string } {
  const explicit = explicitTask.trim();
  if (explicit) {
    const taskSlug = slugifyTaskName(explicit);
    const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
    if (!lock) {
      return { status: 'blocked', taskSlug, reason: `No task lock found for ${taskSlug}.` };
    }
    return { status: 'selected', taskSlug, lock };
  }

  const locks = loadAllTaskLocks(context.commonDir, context.config);
  const candidates = new Map<string, TaskLock>();

  for (const lock of locks) {
    if (lock.branchName === currentBranchName) {
      candidates.set(lock.taskSlug, lock);
    }
  }

  for (const taskSlug of inferTaskSlugsFromBranchName(context.config, currentBranchName)) {
    const lock = loadTaskLock(context.commonDir, context.config, taskSlug);
    if (lock) {
      candidates.set(taskSlug, lock);
    }
  }

  if (candidates.size === 1) {
    const [entry] = [...candidates.entries()];
    return { status: 'selected', taskSlug: entry[0], lock: entry[1] };
  }

  if (candidates.size > 1) {
    return {
      status: 'blocked',
      reason: `Multiple task locks could match branch ${currentBranchName}. Pass --task explicitly.`,
    };
  }

  return {
    status: 'blocked',
    reason: `No task lock matches branch ${currentBranchName} at ${context.repoRoot}. Run ${formatWorkflowCommand(context.config, 'new')} or pass --task.`,
  };
}

function findCurrentCheckoutOwners(
  context: WorkflowContext,
  taskSlug: string,
  current: TaskBindingWorktreeSnapshot,
): TaskLock[] {
  const currentRepoRoot = normalizeExistingPath(current.repoRoot);
  return loadAllTaskLocks(context.commonDir, context.config).filter((lock) => {
    if (lock.taskSlug === taskSlug) {
      return false;
    }
    return lock.branchName === current.branchName || normalizeExistingPath(lock.worktreePath) === currentRepoRoot;
  });
}

function buildRecoveryReason(taskSlug: string, mismatches: string[]): string {
  return [
    `Task ${taskSlug} is locked to a different checkout than the one running this command.`,
    'Task lock mismatch:',
    ...mismatches.map((mismatch) => `- ${mismatch}`),
  ].join('\n');
}

function buildRecoveryOption(
  context: WorkflowContext,
  diagnosis: Omit<TaskBindingNeedsRecovery, 'options'>,
  value: TaskBindingRecovery,
): TaskBindingRecoveryOption {
  const fingerprint = buildTaskBindingFingerprint(diagnosis, value);
  if (value === 'use-current-checkout') {
    const attachedDirtyWarning = diagnosis.attached.dirty
      ? ` The attached workspace currently has ${diagnosis.attached.statusEntryCount} uncommitted status entr${diagnosis.attached.statusEntryCount === 1 ? 'y' : 'ies'}; inspect it before cleanup.`
      : '';
    return {
      value,
      label: 'Use current checkout',
      description: `Rebind this task to ${diagnosis.current.branchName} at ${diagnosis.current.repoRoot}, then continue the PR here. No files are moved.${attachedDirtyWarning}`,
      fingerprint,
      params: {
        recover: value,
        bindingFingerprint: fingerprint,
        task: diagnosis.taskSlug,
      },
    };
  }

  return {
    value,
    label: 'Continue attached task workspace',
    description: `Leave the task lock unchanged and continue in ${diagnosis.lock.worktreePath}.${diagnosis.attached.dirty ? ` It has ${diagnosis.attached.statusEntryCount} uncommitted status entr${diagnosis.attached.statusEntryCount === 1 ? 'y' : 'ies'}.` : ''} No PR action runs from the current checkout.`,
    fingerprint,
    params: {
      recover: value,
      bindingFingerprint: fingerprint,
      task: diagnosis.taskSlug,
    },
  };
}

function buildRecoveryOptions(
  context: WorkflowContext,
  diagnosis: Omit<TaskBindingNeedsRecovery, 'options'>,
): TaskBindingRecoveryOption[] {
  const options: TaskBindingRecoveryOption[] = [];
  if (!currentCheckoutRecoveryBlocker(context, diagnosis)) {
    options.push(buildRecoveryOption(context, diagnosis, 'use-current-checkout'));
  }
  if (diagnosis.attached.exists) {
    options.push(buildRecoveryOption(context, diagnosis, 'continue-attached-workspace'));
  }
  return options;
}

function currentCheckoutRecoveryBlocker(
  context: WorkflowContext,
  diagnosis: Omit<TaskBindingNeedsRecovery, 'options'>,
): string {
  const branchName = diagnosis.current.branchName;
  if (isBaseBranchName(context.config, branchName)) {
    return `Current branch ${branchName} is a base branch and cannot be rebound to task ${diagnosis.taskSlug}.`;
  }
  if (!taskBranchMatches(context.config, diagnosis.taskSlug, branchName)) {
    return `Current branch ${branchName} does not belong to task ${diagnosis.taskSlug}.`;
  }
  if (diagnosis.current.dirty && !diagnosis.current.statusDigestReliable) {
    return [
      'Current checkout dirty state is too large or opaque to approve safely.',
      ...diagnosis.current.statusDigestWarnings.map((warning) => `- ${warning}`),
      'Clean up the checkout or move the work into a bounded, inspectable set of files before rebinding this task.',
    ].join('\n');
  }
  return '';
}

function isBaseBranchName(config: WorkflowConfig, branchName: string): boolean {
  return branchName === config.baseBranch || branchName === 'main' || branchName === 'master';
}

function buildTaskBindingFingerprint(
  diagnosis: Omit<TaskBindingNeedsRecovery, 'options'>,
  selectedOption: TaskBindingRecovery,
): string {
  const canonical = JSON.stringify(canonicalize({
    version: 1,
    selectedOption,
    taskSlug: diagnosis.taskSlug,
    current: pickSnapshotForFingerprint(diagnosis.current),
    attached: pickSnapshotForFingerprint(diagnosis.attached),
    lock: {
      taskSlug: diagnosis.lock.taskSlug,
      branchName: diagnosis.lock.branchName,
      worktreePath: normalizePath(diagnosis.lock.worktreePath),
      mode: diagnosis.lock.mode,
      surfaces: [...(diagnosis.lock.surfaces ?? [])].sort(),
      updatedAt: diagnosis.lock.updatedAt ?? '',
      bindingHistoryLength: Array.isArray(diagnosis.lock.bindingHistory) ? diagnosis.lock.bindingHistory.length : 0,
    },
    mismatches: diagnosis.mismatches,
  }));
  return createHash('sha256').update(canonical).digest('hex');
}

function pickSnapshotForFingerprint(snapshot: TaskBindingWorktreeSnapshot): Record<string, unknown> {
  return {
    repoRoot: normalizePath(snapshot.repoRoot),
    exists: snapshot.exists,
    branchName: snapshot.branchName,
    commonDir: snapshot.commonDir ? normalizePath(snapshot.commonDir) : '',
    head: snapshot.head,
    statusDigest: snapshot.statusDigest,
    dirty: snapshot.dirty,
    statusEntryCount: snapshot.statusEntryCount,
    statusDigestReliable: snapshot.statusDigestReliable,
    statusDigestWarnings: snapshot.statusDigestWarnings,
  };
}

function readWorktreeSnapshot(
  repoRoot: string,
  options: ReadWorktreeSnapshotOptions = {},
): TaskBindingWorktreeSnapshot {
  return readWorktreeStatusSnapshot(repoRoot, options);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]));
  }
  return value;
}
