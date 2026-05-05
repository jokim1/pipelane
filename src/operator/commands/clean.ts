import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  acquireTaskCleanupLock,
  formatWorkflowCommand,
  loadDeployState,
  loadPrState,
  loadTaskLock,
  normalizePath,
  printResult,
  resolveWorkflowContext,
  runCommandCapture,
  runGit,
  slugifyTaskName,
  type DeployRecord,
  type ParsedOperatorArgs,
  type PrRecord,
  type TaskLock,
  type WorkflowConfig,
} from '../state.ts';
import { resolveDeployStateKey } from '../integrity.ts';
import { verifyDeployRecord } from '../release-gate.ts';
import {
  branchTreeMatchesRef,
  classifyOrphan,
  listActiveTaskLocks,
  listOrphanWorktrees,
  pruneDeadTaskLocks,
  removeOrphanWorktree,
  removeTaskArtifacts,
  resolveSharedRepoRoot,
  TASK_LOCK_MIN_PRUNE_AGE_MS,
  type OrphanClassification,
  type OrphanWorktree,
  type RemovedTaskLock,
} from '../task-workspaces.ts';

export async function handleClean(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const sharedRepoRoot = resolveSharedRepoRoot(context.commonDir);

  if (parsed.flags.apply) {
    if (parsed.flags.completedWithIgnored) {
      await handleApplyCompletedWithIgnored(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
      return;
    }
    if (parsed.flags.safeOrphans) {
      await handleApplySafeOrphans(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
      return;
    }
    if (parsed.flags.mergedOrphans) {
      await handleApplyMergedOrphans(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
      return;
    }
    await handleApplyTaskOrAllStale(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
    return;
  }

  await handleStatus(cwd, parsed, context.commonDir, context.config, sharedRepoRoot);
}

// -----------------------------------------------------------------------------
// Apply branches
// -----------------------------------------------------------------------------

async function handleApplyTaskOrAllStale(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const taskFlag = parsed.flags.task.trim();
  const allStale = parsed.flags.allStale;
  const prRecords = loadPrState(commonDir, config).records;
  const deployRecords = loadTrustedDeployRecords(commonDir, config);

  if (!taskFlag && !allStale) {
    throw new Error([
      '/clean --apply requires scope.',
      'Pass --task <slug> to prune one lock, --all-stale to prune every dead lock,',
      'or one of --completed-with-ignored, --safe-orphans, --merged-orphans for a bulk category.',
      'Locks younger than 5 minutes are always kept even when scope is set.',
    ].join('\n'));
  }

  const targetSlug = taskFlag ? slugifyTaskName(taskFlag) : undefined;
  if (taskFlag && !targetSlug) {
    throw new Error(`Could not derive a valid task slug from --task "${taskFlag}".`);
  }

  const { removed, skipped } = pruneDeadTaskLocks(commonDir, config, {
    taskSlug: targetSlug,
    minAgeMs: readMinAgeOverride(),
  });

  // --task is the end-of-task closer: prune the lock, then tear down the
  // worktree + local branch the lock pointed at. --all-stale stays
  // metadata-only — it sweeps abandoned locks across many tasks and the
  // blast radius of bulk worktree removal would be too high (e.g. an
  // operator restarting the daemon would briefly orphan locks for live
  // worktrees the operator wanted to keep).
  const artifactResults = taskFlag
    ? performArtifactRemoval({
        removed,
        sharedRepoRoot,
        callerCwd: cwd,
        force: parsed.flags.force,
        safeDeleteBranchRefs: buildSafeDeleteBranchRefs(removed, prRecords, deployRecords),
      })
    : [];

  const messageLines: string[] = [];
  if (removed.length === 0) {
    messageLines.push(
      taskFlag
        ? `No task lock matched --task ${targetSlug}.`
        : 'No stale task locks were pruned.',
    );
  } else if (taskFlag) {
    messageLines.push('Closed out task workspaces:');
    for (const lock of removed) {
      const result = artifactResults.find((entry) => entry.taskSlug === lock.taskSlug);
      const parts = ['lock'];
      if (result?.worktreeRemoved) parts.push('worktree');
      if (result?.branchRemoved) parts.push('branch');
      messageLines.push(`- ${lock.taskSlug}: removed ${parts.join(' + ')}`);
      if (result) {
        for (const warning of result.warnings) messageLines.push(`  note: ${warning}`);
        for (const error of result.errors) messageLines.push(`  ! ${error}`);
      }
    }
  } else {
    messageLines.push('Pruned stale task locks:');
    messageLines.push(
      ...removed.map((entry) => `- ${entry.taskSlug}: ${entry.branchName} @ ${entry.worktreePath}`),
    );
  }
  if (skipped.length > 0) {
    messageLines.push('Kept (too young to prune, <5 min):');
    messageLines.push(...skipped.map((entry) => `- ${entry.taskSlug}: ${entry.reason}`));
  }

  printResult(parsed.flags, {
    removed: removed.map((entry) => entry.taskSlug),
    skipped: skipped.map((entry) => ({ taskSlug: entry.taskSlug, reason: entry.reason })),
    artifacts: artifactResults,
    message: messageLines.join('\n'),
  });
}

async function handleApplyCompletedWithIgnored(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  // Scope: every active task lock that pipelane already knows is
  // prod-verified-merged, with the only blocker being ignored content
  // (dist/, build outputs). Same safety chain as auto-cleanup, just opting
  // into "I know there's build output here, please proceed."
  const result = closeSafeCompletedTaskWorkspaces({
    commonDir,
    config,
    sharedRepoRoot,
    callerCwd: cwd,
    minAgeMs: readMinAgeOverride(),
    allowIgnoredContent: true,
  });

  const lines: string[] = [];
  if (result.closed.length === 0) {
    lines.push('No prod-verified task workspaces were eligible for cleanup with ignored content.');
  } else {
    lines.push(`Closed out ${result.closed.length} prod-verified task workspace${result.closed.length === 1 ? '' : 's'} (allowing ignored build output):`);
    for (const entry of result.closed) {
      const parts = ['lock'];
      if (entry.worktreeRemoved) parts.push('worktree');
      if (entry.branchRemoved) parts.push('branch');
      lines.push(`- ${entry.taskSlug}: removed ${parts.join(' + ')}`);
      for (const warning of entry.warnings) lines.push(`  note: ${warning}`);
      for (const error of entry.errors) lines.push(`  ! ${error}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push('Kept for manual review:');
    for (const entry of result.skipped) {
      lines.push(`- ${entry.taskSlug}: ${entry.reason}`);
    }
  }

  printResult(parsed.flags, {
    closed: result.closed.map((entry) => entry.taskSlug),
    skipped: result.skipped,
    artifacts: result.closed,
    message: lines.join('\n'),
  });
}

async function handleApplySafeOrphans(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const orphans = listOrphanWorktrees(commonDir, config);
  const investigated = investigateOrphans(orphans, sharedRepoRoot, { skipPrLookup: true });
  const candidates = investigated.orphans.filter((entry) => entry.classification.treeState === 'clean');

  const removedSummaries: Array<{
    path: string;
    branchName: string | null;
    worktreeRemoved: boolean;
    branchRemoved: boolean;
    warnings: string[];
    errors: string[];
  }> = [];

  for (const candidate of candidates) {
    const result = removeOrphanWorktree({
      sharedRepoRoot,
      worktreePath: candidate.orphan.path,
      branchName: candidate.orphan.branchName,
      callerCwd: cwd,
      force: false,
    });
    removedSummaries.push({
      path: candidate.orphan.path,
      branchName: candidate.orphan.branchName,
      worktreeRemoved: result.worktreeRemoved,
      branchRemoved: result.branchRemoved,
      warnings: result.warnings,
      errors: result.errors,
    });
  }

  const lines: string[] = [];
  if (candidates.length === 0) {
    lines.push('No orphan worktrees with clean trees to remove.');
  } else {
    const fullySucceeded = removedSummaries.filter((entry) => entry.errors.length === 0 && entry.worktreeRemoved && entry.branchRemoved);
    lines.push(`Removed ${fullySucceeded.length} of ${candidates.length} clean orphan worktree${candidates.length === 1 ? '' : 's'}:`);
    for (const entry of removedSummaries) {
      const parts = [];
      if (entry.worktreeRemoved) parts.push('worktree');
      if (entry.branchRemoved && entry.branchName) parts.push('branch');
      const status = entry.errors.length === 0 ? `removed ${parts.join(' + ') || '(none)'}` : 'skipped';
      lines.push(`- ${entry.path}: ${status}`);
      for (const warning of entry.warnings) lines.push(`  note: ${warning}`);
      for (const error of entry.errors) lines.push(`  ! ${error}`);
    }
  }

  printResult(parsed.flags, {
    removed: removedSummaries.filter((entry) => entry.errors.length === 0).map((entry) => entry.path),
    artifacts: removedSummaries,
    message: lines.join('\n'),
  });
}

async function handleApplyMergedOrphans(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const orphans = listOrphanWorktrees(commonDir, config);
  const investigated = investigateOrphans(orphans, sharedRepoRoot, { skipPrLookup: false });
  const candidates = investigated.orphans.filter((entry) => entry.mergedPr !== null);

  const removedSummaries: Array<{
    path: string;
    branchName: string | null;
    prNumber: number | null;
    worktreeRemoved: boolean;
    branchRemoved: boolean;
    warnings: string[];
    errors: string[];
  }> = [];

  for (const candidate of candidates) {
    // Force-remove: the branch's PR is merged on main, so any tracked changes
    // here are stale follow-ups. The worktree's tree differs from the
    // squash-merge SHA, so safeDeleteBranchRef won't recognize it; --force
    // is the correct escape.
    const result = removeOrphanWorktree({
      sharedRepoRoot,
      worktreePath: candidate.orphan.path,
      branchName: candidate.orphan.branchName,
      callerCwd: cwd,
      force: true,
    });
    removedSummaries.push({
      path: candidate.orphan.path,
      branchName: candidate.orphan.branchName,
      prNumber: candidate.mergedPr?.number ?? null,
      worktreeRemoved: result.worktreeRemoved,
      branchRemoved: result.branchRemoved,
      warnings: result.warnings,
      errors: result.errors,
    });
  }

  const lines: string[] = [];
  if (!investigated.prLookupAvailable) {
    lines.push('PR-merge lookup unavailable (gh CLI missing or failed). No merged orphans removed.');
    for (const warning of investigated.warnings) {
      lines.push(`  note: ${warning}`);
    }
  } else if (candidates.length === 0) {
    lines.push('No orphan worktrees with merged PRs to remove.');
  } else {
    const fullySucceeded = removedSummaries.filter((entry) => entry.errors.length === 0 && entry.worktreeRemoved && entry.branchRemoved);
    lines.push(`Force-removed ${fullySucceeded.length} of ${candidates.length} orphan worktree${candidates.length === 1 ? '' : 's'} with merged PRs:`);
    for (const entry of removedSummaries) {
      const prTag = entry.prNumber !== null ? ` (PR #${entry.prNumber})` : '';
      const parts = [];
      if (entry.worktreeRemoved) parts.push('worktree');
      if (entry.branchRemoved && entry.branchName) parts.push('branch');
      const status = entry.errors.length === 0 ? `removed ${parts.join(' + ') || '(none)'}` : 'skipped';
      lines.push(`- ${entry.path}${prTag}: ${status}`);
      for (const warning of entry.warnings) lines.push(`  note: ${warning}`);
      for (const error of entry.errors) lines.push(`  ! ${error}`);
    }
  }

  printResult(parsed.flags, {
    removed: removedSummaries.filter((entry) => entry.errors.length === 0).map((entry) => entry.path),
    artifacts: removedSummaries,
    prLookupAvailable: investigated.prLookupAvailable,
    warnings: investigated.warnings,
    message: lines.join('\n'),
  });
}

// -----------------------------------------------------------------------------
// Status (no --apply)
// -----------------------------------------------------------------------------

async function handleStatus(
  cwd: string,
  parsed: ParsedOperatorArgs,
  commonDir: string,
  config: WorkflowConfig,
  sharedRepoRoot: string,
): Promise<void> {
  const autoCleanup = closeSafeCompletedTaskWorkspaces({
    commonDir,
    config,
    sharedRepoRoot,
    callerCwd: cwd,
    minAgeMs: readMinAgeOverride(),
    dryRun: parsed.flags.statusOnly,
  });
  const activeLocks = listActiveTaskLocks(commonDir, config);
  const orphans = listOrphanWorktrees(commonDir, config);
  const investigated = investigateOrphans(orphans, sharedRepoRoot, { skipPrLookup: false });

  const ignoredOnlySkips = autoCleanup.skipped.filter((entry) => entry.code === 'ignored-content');
  const cleanOrphans = investigated.orphans.filter((entry) => entry.classification.treeState === 'clean');
  const mergedDirtyOrphans = investigated.orphans.filter(
    (entry) => entry.mergedPr !== null && entry.classification.treeState !== 'clean',
  );
  // Anything left over: not clean, no merged PR. Could be in-progress
  // work an external agent is editing, abandoned dirty branches, or
  // build output without an upstream PR. The action menu calls these out
  // as needing manual inspection rather than offering a bulk delete.
  const suspiciousOrphans = investigated.orphans.filter(
    (entry) => entry.classification.treeState !== 'clean' && entry.mergedPr === null,
  );

  const lines: string[] = [];
  if (autoCleanup.closed.length > 0) {
    lines.push(parsed.flags.statusOnly ? 'Would close safe completed task workspaces:' : 'Closed out safe completed task workspaces:');
    for (const result of autoCleanup.closed) {
      if (parsed.flags.statusOnly) {
        lines.push(`- ${result.taskSlug}: would remove lock + worktree + branch`);
        continue;
      }
      const parts = ['lock'];
      if (result.worktreeRemoved) parts.push('worktree');
      if (result.branchRemoved) parts.push('branch');
      lines.push(`- ${result.taskSlug}: removed ${parts.join(' + ')}`);
      for (const warning of result.warnings) lines.push(`  note: ${warning}`);
      for (const error of result.errors) lines.push(`  ! ${error}`);
    }
    lines.push('');
  }
  if (autoCleanup.skipped.length > 0) {
    lines.push('Completed task workspaces kept for manual cleanup:');
    lines.push(...autoCleanup.skipped.map((entry) => `- ${entry.taskSlug}: ${entry.reason}`));
    lines.push('');
  }
  lines.push(
    'Workflow clean status:',
    `Active task locks: ${activeLocks.length}`,
  );
  if (activeLocks.length > 0) {
    lines.push(...activeLocks.map((lock) => `- ${lock.taskName || lock.taskSlug}: ${lock.branchName} @ ${lock.worktreePath}`));
  }
  if (orphans.length > 0) {
    lines.push(`Orphan worktrees (no matching task lock): ${orphans.length}`);
    for (const entry of investigated.orphans) {
      lines.push(formatOrphanLine(entry));
    }
  }
  for (const warning of investigated.warnings) {
    lines.push(`note: ${warning}`);
  }

  const menu = buildActionMenu({
    ignoredOnlyCandidates: ignoredOnlySkips,
    cleanOrphans,
    mergedDirtyOrphans,
    suspiciousOrphans,
    cleanCommandPrefix: formatWorkflowCommand(config, 'clean'),
    prLookupAvailable: investigated.prLookupAvailable,
  });
  if (menu.lines.length > 0) {
    lines.push('');
    lines.push(...menu.lines);
  } else {
    // No actionable categories — keep the user oriented with the flag list
    // so they can still drive the rare cases (--task <slug>, --all-stale).
    lines.push(`${formatWorkflowCommand(config, 'clean')} closes completed, prod-verified task workspaces automatically when safety checks pass.`);
    lines.push(`Run ${formatWorkflowCommand(config, 'clean')} --status-only to preview cleanup without removing anything,`);
    lines.push(`Run ${formatWorkflowCommand(config, 'clean')} --apply --all-stale to prune every stale task lock,`);
    lines.push(`or ${formatWorkflowCommand(config, 'clean')} --apply --task <slug> to close out one task explicitly.`);
  }

  printResult(parsed.flags, {
    autoCleaned: parsed.flags.statusOnly ? [] : autoCleanup.closed.map((entry) => entry.taskSlug),
    autoCleanCandidates: autoCleanup.closed.map((entry) => entry.taskSlug),
    autoCleanSkipped: autoCleanup.skipped,
    artifacts: autoCleanup.closed,
    activeLocks: activeLocks.map((lock) => ({
      taskSlug: lock.taskSlug,
      taskName: lock.taskName ?? null,
      branchName: lock.branchName,
      worktreePath: lock.worktreePath,
    })),
    orphanWorktrees: investigated.orphans.map((entry) => ({
      path: entry.orphan.path,
      branchName: entry.orphan.branchName,
      isDetached: entry.orphan.isDetached,
      source: entry.orphan.source,
      classification: entry.classification,
      mergedPr: entry.mergedPr,
    })),
    suggestedActions: menu.items,
    prLookupAvailable: investigated.prLookupAvailable,
    prLookupWarnings: investigated.warnings,
    message: lines.join('\n'),
  });
}

// -----------------------------------------------------------------------------
// Action menu
// -----------------------------------------------------------------------------

interface ActionMenuItem {
  label: string;
  command: string;
  count: number;
}

function buildActionMenu(state: {
  ignoredOnlyCandidates: AutoCleanupSkip[];
  cleanOrphans: OrphanWithMetadata[];
  mergedDirtyOrphans: OrphanWithMetadata[];
  suspiciousOrphans: OrphanWithMetadata[];
  cleanCommandPrefix: string;
  prLookupAvailable: boolean;
}): { lines: string[]; items: ActionMenuItem[] } {
  const items: ActionMenuItem[] = [];
  if (state.cleanOrphans.length > 0) {
    items.push({
      label: `Remove ${state.cleanOrphans.length} orphan worktree${pluralize(state.cleanOrphans.length)} with clean trees (no uncommitted work)`,
      command: `${state.cleanCommandPrefix} --apply --safe-orphans`,
      count: state.cleanOrphans.length,
    });
  }
  if (state.mergedDirtyOrphans.length > 0) {
    items.push({
      label: `Remove ${state.mergedDirtyOrphans.length} orphan worktree${pluralize(state.mergedDirtyOrphans.length)} whose branches have merged PRs (work is on main; remaining changes are stale follow-ups)`,
      command: `${state.cleanCommandPrefix} --apply --merged-orphans`,
      count: state.mergedDirtyOrphans.length,
    });
  }
  if (state.ignoredOnlyCandidates.length > 0) {
    items.push({
      label: `Close out ${state.ignoredOnlyCandidates.length} prod-verified task workspace${pluralize(state.ignoredOnlyCandidates.length)} blocked only on ignored build output`,
      command: `${state.cleanCommandPrefix} --apply --completed-with-ignored`,
      count: state.ignoredOnlyCandidates.length,
    });
  }

  if (items.length === 0 && state.suspiciousOrphans.length === 0) {
    return { lines: [], items: [] };
  }

  const lines: string[] = [];
  if (items.length > 0) {
    lines.push('Suggested actions:');
    items.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item.label}`);
      lines.push(`     ${item.command}`);
    });
  }
  if (state.suspiciousOrphans.length > 0) {
    if (items.length > 0) lines.push('');
    const tail = state.prLookupAvailable ? ' and no merged PR' : '';
    lines.push(`Inspect manually: ${state.suspiciousOrphans.length} orphan worktree${pluralize(state.suspiciousOrphans.length)} with uncommitted source changes${tail}:`);
    for (const entry of state.suspiciousOrphans.slice(0, 10)) {
      const branchTag = entry.orphan.branchName ?? '(detached)';
      lines.push(`  - ${entry.orphan.path}  [${entry.classification.trackedChanges} tracked, branch: ${branchTag}]`);
    }
    if (state.suspiciousOrphans.length > 10) {
      lines.push(`  + ${state.suspiciousOrphans.length - 10} more…`);
    }
  }

  return { lines, items };
}

function pluralize(count: number): string {
  return count === 1 ? '' : 's';
}

// -----------------------------------------------------------------------------
// Orphan investigation
// -----------------------------------------------------------------------------

interface MergedPrInfo {
  number: number;
  mergedAt: string;
  title: string;
}

interface OrphanWithMetadata {
  orphan: OrphanWorktree;
  classification: OrphanClassification;
  mergedPr: MergedPrInfo | null;
}

interface InvestigationResult {
  orphans: OrphanWithMetadata[];
  warnings: string[];
  prLookupAvailable: boolean;
}

function investigateOrphans(
  orphans: OrphanWorktree[],
  sharedRepoRoot: string,
  options: { skipPrLookup: boolean },
): InvestigationResult {
  if (orphans.length === 0) {
    return { orphans: [], warnings: [], prLookupAvailable: !options.skipPrLookup };
  }
  const branchNames = orphans
    .map((o) => o.branchName)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  const lookup = options.skipPrLookup
    ? { byBranch: new Map<string, MergedPrInfo>(), warnings: [] as string[], available: false }
    : lookupMergedPrsByBranch(sharedRepoRoot, branchNames);

  const enriched: OrphanWithMetadata[] = orphans.map((orphan) => ({
    orphan,
    classification: classifyOrphan(orphan.path),
    mergedPr: orphan.branchName ? lookup.byBranch.get(orphan.branchName) ?? null : null,
  }));
  return { orphans: enriched, warnings: lookup.warnings, prLookupAvailable: lookup.available };
}

interface MergedPrLookup {
  byBranch: Map<string, MergedPrInfo>;
  warnings: string[];
  available: boolean;
}

function lookupMergedPrsByBranch(repoRoot: string, branchNames: string[]): MergedPrLookup {
  if (branchNames.length === 0) {
    return { byBranch: new Map(), warnings: [], available: true };
  }
  // Test hook: gated to NODE_ENV==='test' so a stray env var in a shared
  // production shell can't quietly disable the merge-status check.
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_CLEAN_SKIP_PR_LOOKUP === '1') {
    return { byBranch: new Map(), warnings: [], available: false };
  }
  // Cheap probe — `gh --version` exits 0 when installed and on PATH.
  // Any non-zero exit (ENOENT, install error) means we can't drive gh.
  const probe = runCommandCapture('gh', ['--version'], { cwd: repoRoot });
  if (!probe.ok) {
    return {
      byBranch: new Map(),
      warnings: ['gh CLI not available; PR-merge classification skipped (install gh and `gh auth login` to enable).'],
      available: false,
    };
  }
  // Single batched query — cap at 500 so the call stays fast even on
  // long-history repos. Truncation hint emitted below if any of our
  // branches isn't in the result.
  const result = runCommandCapture(
    'gh',
    ['pr', 'list', '--state', 'merged', '--limit', '500', '--json', 'number,headRefName,mergedAt,title'],
    { cwd: repoRoot, timeoutMs: 30_000 },
  );
  if (!result.ok) {
    const message = (result.stderr || result.stdout || 'unknown error').trim().split('\n')[0];
    return {
      byBranch: new Map(),
      warnings: [`gh pr list failed: ${message}`],
      available: false,
    };
  }
  let parsed: Array<{ number: number; headRefName: string; mergedAt: string; title: string }>;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      byBranch: new Map(),
      warnings: ['gh pr list returned malformed JSON; PR-merge classification skipped.'],
      available: false,
    };
  }
  const byBranch = new Map<string, MergedPrInfo>();
  for (const entry of parsed) {
    if (!entry || typeof entry.headRefName !== 'string' || entry.headRefName.length === 0) continue;
    if (byBranch.has(entry.headRefName)) continue;
    byBranch.set(entry.headRefName, {
      number: typeof entry.number === 'number' ? entry.number : 0,
      mergedAt: typeof entry.mergedAt === 'string' ? entry.mergedAt : '',
      title: typeof entry.title === 'string' ? entry.title : '',
    });
  }
  const warnings: string[] = [];
  if (parsed.length >= 500 && branchNames.some((name) => !byBranch.has(name))) {
    warnings.push(
      'gh pr list capped at 500 merged PRs; some older orphans may have merged PRs that were not checked.',
    );
  }
  return { byBranch, warnings, available: true };
}

// -----------------------------------------------------------------------------
// Auto-cleanup helpers
// -----------------------------------------------------------------------------

interface ArtifactRemovalSummary {
  taskSlug: string;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  warnings: string[];
  errors: string[];
}

function performArtifactRemoval(options: {
  removed: RemovedTaskLock[];
  sharedRepoRoot: string;
  callerCwd: string;
  force: boolean;
  safeDeleteBranchRefs?: Map<string, string>;
}): ArtifactRemovalSummary[] {
  return options.removed.map((lock) => {
    const result = removeTaskArtifacts({
      sharedRepoRoot: options.sharedRepoRoot,
      worktreePath: lock.worktreePath,
      branchName: lock.branchName,
      callerCwd: options.callerCwd,
      force: options.force,
      safeDeleteBranchRef: options.safeDeleteBranchRefs?.get(lock.taskSlug),
    });
    return {
      taskSlug: lock.taskSlug,
      worktreeRemoved: result.worktreeRemoved,
      branchRemoved: result.branchRemoved,
      warnings: result.warnings,
      errors: result.errors,
    };
  });
}

type AutoCleanupBlockerCode =
  | 'lock-too-young'
  | 'unparseable-updated-at'
  | 'worktree-missing'
  | 'caller-inside'
  | 'branch-missing'
  | 'detached'
  | 'branch-mismatch'
  | 'status-failed'
  | 'uncommitted'
  | 'ignored-content'
  | 'tree-mismatch'
  | 'busy';

interface AutoCleanupSkip {
  taskSlug: string;
  reason: string;
  // Structured blocker code — drives the action-menu categorization. The
  // 'ignored-content' code is what `/clean --apply --completed-with-ignored`
  // targets: pipelane already verified prod-merge, the only thing left is
  // the operator's call on whether dist/build output should be discarded.
  code: AutoCleanupBlockerCode;
}

function closeSafeCompletedTaskWorkspaces(options: {
  commonDir: string;
  config: WorkflowConfig;
  sharedRepoRoot: string;
  callerCwd: string;
  minAgeMs?: number;
  dryRun?: boolean;
  // When true, the "ignored content" blocker is ignored — the rest of the
  // safety chain still has to pass. Used by --completed-with-ignored.
  allowIgnoredContent?: boolean;
}): { closed: ArtifactRemovalSummary[]; skipped: AutoCleanupSkip[] } {
  const prRecords = loadPrState(options.commonDir, options.config).records;
  const deployRecords = loadTrustedDeployRecords(options.commonDir, options.config);
  const minAgeMs = options.minAgeMs ?? TASK_LOCK_MIN_PRUNE_AGE_MS;
  const closed: ArtifactRemovalSummary[] = [];
  const skipped: AutoCleanupSkip[] = [];

  for (const observedLock of listActiveTaskLocks(options.commonDir, options.config)) {
    let releaseCleanupLock: (() => void) | null = null;
    if (!options.dryRun) {
      const cleanupLock = acquireTaskCleanupLock(options.commonDir, options.config, observedLock.taskSlug);
      if (cleanupLock.acquired === false) {
        skipped.push({ taskSlug: observedLock.taskSlug, reason: cleanupLock.reason, code: 'busy' });
        continue;
      }
      releaseCleanupLock = cleanupLock.release;
    }

    try {
      const lock = options.dryRun
        ? observedLock
        : loadTaskLock(options.commonDir, options.config, observedLock.taskSlug);
      if (!lock) {
        skipped.push({
          taskSlug: observedLock.taskSlug,
          reason: 'task lock disappeared before auto-clean could inspect it',
          code: 'busy',
        });
        continue;
      }

      const safeDeleteBranchRef = resolveVerifiedProdCleanupRef(lock, prRecords, deployRecords);
      if (!safeDeleteBranchRef) continue;

      const blocker = explainAutoCleanupBlocker({
        lock,
        safeDeleteBranchRef,
        sharedRepoRoot: options.sharedRepoRoot,
        callerCwd: options.callerCwd,
        minAgeMs,
        allowIgnoredContent: options.allowIgnoredContent === true,
      });
      if (blocker) {
        skipped.push({ taskSlug: lock.taskSlug, reason: blocker.message, code: blocker.code });
        continue;
      }

      if (options.dryRun) {
        closed.push({
          taskSlug: lock.taskSlug,
          worktreeRemoved: false,
          branchRemoved: false,
          warnings: [],
          errors: [],
        });
        continue;
      }

      const result = removeTaskArtifacts({
        sharedRepoRoot: options.sharedRepoRoot,
        worktreePath: lock.worktreePath,
        branchName: lock.branchName,
        callerCwd: options.callerCwd,
        force: false,
        safeDeleteBranchRef,
      });
      if (result.errors.length > 0 || !result.worktreeRemoved || !result.branchRemoved) {
        skipped.push({
          taskSlug: lock.taskSlug,
          reason: result.errors.join('; ') || 'artifact removal did not complete',
          code: 'busy',
        });
        continue;
      }

      const pruned = pruneDeadTaskLocks(options.commonDir, options.config, {
        taskSlug: lock.taskSlug,
        minAgeMs,
      });
      if (pruned.removed.length === 0) {
        skipped.push({
          taskSlug: lock.taskSlug,
          reason: pruned.skipped[0]?.reason ?? 'lock was already removed before auto-clean could prune it',
          code: 'busy',
        });
        continue;
      }

      closed.push({
        taskSlug: lock.taskSlug,
        worktreeRemoved: result.worktreeRemoved,
        branchRemoved: result.branchRemoved,
        warnings: result.warnings,
        errors: result.errors,
      });
    } finally {
      releaseCleanupLock?.();
    }
  }

  return { closed, skipped };
}

function loadTrustedDeployRecords(commonDir: string, config: WorkflowConfig): DeployRecord[] {
  const records = loadDeployState(commonDir, config).records.filter(isDeployRecordObject);
  const stateKey = resolveDeployStateKey();
  return stateKey ? records.filter((record) => verifyDeployRecord(record, stateKey)) : records;
}

function buildSafeDeleteBranchRefs(
  removed: RemovedTaskLock[],
  prRecords: Record<string, PrRecord>,
  deployRecords: DeployRecord[],
): Map<string, string> {
  const refs = new Map<string, string>();
  for (const lock of removed) {
    const ref = resolveVerifiedProdCleanupRef(lock, prRecords, deployRecords);
    if (ref) refs.set(lock.taskSlug, ref);
  }
  return refs;
}

function resolveVerifiedProdCleanupRef(
  lock: Pick<TaskLock, 'taskSlug' | 'surfaces'>,
  prRecords: Record<string, PrRecord>,
  deployRecords: DeployRecord[],
): string | null {
  const mergedSha = normalizeGitSha(prRecords[lock.taskSlug]?.mergedSha);
  if (!mergedSha) return null;

  for (let index = deployRecords.length - 1; index >= 0; index -= 1) {
    const record = deployRecords[index] as unknown;
    if (!isDeployRecordObject(record)) continue;
    if (deployRecordQualifiesForCleanup(record, lock.taskSlug, mergedSha, lock.surfaces)) {
      return mergedSha;
    }
  }

  return null;
}

function deployRecordQualifiesForCleanup(record: DeployRecord, taskSlug: string, mergedSha: string, requiredSurfaces: string[]): boolean {
  if (record.environment !== 'prod') return false;
  if (record.taskSlug !== taskSlug) return false;
  if (normalizeGitSha(record.sha) !== mergedSha) return false;
  if (record.status !== 'succeeded') return false;
  if (!isValidIsoTimestamp(record.verifiedAt)) return false;
  if (typeof record.configFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(record.configFingerprint)) return false;
  if (!Array.isArray(record.surfaces) || record.surfaces.length === 0) return false;
  const surfacesRequired = Array.isArray(requiredSurfaces) ? requiredSurfaces : [];
  if (!surfacesRequired.every((surface) => record.surfaces.includes(surface))) return false;
  return record.surfaces.every((surface) => deployRecordSurfaceVerified(record, surface));
}

function deployRecordSurfaceVerified(record: DeployRecord, surface: string): boolean {
  const perSurface = record.verificationBySurface?.[surface];
  if (perSurface) return verificationStatusCodeIs2xx(perSurface.statusCode);
  if (surface === 'frontend' && record.verification) return verificationStatusCodeIs2xx(record.verification.statusCode);
  return false;
}

function verificationStatusCodeIs2xx(value: unknown): boolean {
  return typeof value === 'number' && value >= 200 && value < 300;
}

function explainAutoCleanupBlocker(options: {
  lock: TaskLock;
  safeDeleteBranchRef: string;
  sharedRepoRoot: string;
  callerCwd: string;
  minAgeMs: number;
  allowIgnoredContent: boolean;
}): { message: string; code: AutoCleanupBlockerCode } | null {
  const ageMs = lockAgeMs(options.lock.updatedAt, Date.now());
  if (ageMs === null) {
    return {
      message: `updatedAt is missing or unparseable ("${options.lock.updatedAt ?? ''}")`,
      code: 'unparseable-updated-at',
    };
  }
  if (ageMs < options.minAgeMs) {
    return {
      message: `updatedAt ${options.lock.updatedAt} is ${Math.round(ageMs / 1000)}s old — below the ${Math.round(options.minAgeMs / 1000)}s prune floor`,
      code: 'lock-too-young',
    };
  }

  if (!existsSync(options.lock.worktreePath)) {
    return {
      message: 'saved worktree is missing; use --apply --all-stale for stale lock pruning',
      code: 'worktree-missing',
    };
  }
  if (isSameOrInside(options.lock.worktreePath, options.callerCwd)) {
    return {
      message: `cannot remove worktree ${options.lock.worktreePath} while running inside it`,
      code: 'caller-inside',
    };
  }

  const branchExists = runGit(options.sharedRepoRoot, ['rev-parse', '--verify', `refs/heads/${options.lock.branchName}`], true);
  if (!branchExists) {
    return {
      message: 'saved branch is missing; use --apply --all-stale for stale lock pruning',
      code: 'branch-missing',
    };
  }

  const worktreeBranch = runGit(options.lock.worktreePath, ['branch', '--show-current'], true)?.trim() ?? '';
  if (!worktreeBranch) {
    return {
      message: `saved worktree ${options.lock.worktreePath} is detached or has no current branch`,
      code: 'detached',
    };
  }
  if (worktreeBranch !== options.lock.branchName) {
    return {
      message: `saved worktree branch ${worktreeBranch} does not match saved branch ${options.lock.branchName}`,
      code: 'branch-mismatch',
    };
  }

  const status = runCommandCapture('git', ['status', '--porcelain'], { cwd: options.lock.worktreePath });
  if (!status.ok) {
    return {
      message: `could not inspect worktree status: ${status.stderr || status.stdout || 'git status failed'}`,
      code: 'status-failed',
    };
  }
  if (status.stdout.trim().length > 0) {
    return { message: 'worktree has uncommitted or untracked changes', code: 'uncommitted' };
  }
  if (!options.allowIgnoredContent) {
    const ignoredBlocker = explainIgnoredContentBlocker(options.lock.worktreePath);
    if (ignoredBlocker) {
      return { message: ignoredBlocker, code: 'ignored-content' };
    }
  }

  if (!branchTreeMatchesRef(options.sharedRepoRoot, options.lock.branchName, options.safeDeleteBranchRef)) {
    return {
      message: `branch tree differs from verified prod SHA ${options.safeDeleteBranchRef.slice(0, 7)}`,
      code: 'tree-mismatch',
    };
  }

  return null;
}

function lockAgeMs(updatedAt: string | undefined, now: number): number | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

function normalizeGitSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-f0-9]{7,40}$/i.test(trimmed) ? trimmed : null;
}

function isValidIsoTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isDeployRecordObject(value: unknown): value is DeployRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function explainIgnoredContentBlocker(worktreePath: string): string | null {
  const classification = classifyOrphan(worktreePath);
  if (classification.treeState === 'unknown') {
    return `could not inspect ignored worktree content (git status --ignored failed)`;
  }
  if (classification.ignoredEntries.length === 0) return null;
  const sample = classification.ignoredEntries.slice(0, 3).join(', ');
  const suffix = classification.ignoredEntries.length > 3 ? `, +${classification.ignoredEntries.length - 3} more` : '';
  return `worktree has ignored local files (${sample}${suffix}); use --apply --completed-with-ignored or --apply --task <slug> when deleting ignored content is intentional`;
}

function isSameOrInside(parentPath: string, childPath: string): boolean {
  const parent = normalizePath(parentPath);
  const child = normalizePath(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function formatOrphanLine(entry: OrphanWithMetadata): string {
  const sourceTag = entry.orphan.source === 'pipelane-managed' ? 'pipelane-managed' : 'external';
  const branchTag = entry.orphan.isDetached ? 'detached HEAD' : entry.orphan.branchName ?? '(no branch)';
  const treeTag = entry.classification.treeState;
  const prTag = entry.mergedPr ? `, PR #${entry.mergedPr.number} merged` : '';
  return `- ${entry.orphan.path}  [${sourceTag}, ${branchTag}, ${treeTag}${prTag}]`;
}

// Test hook: override the 5-min prune floor. Gated to NODE_ENV==='test' so a
// stray env var in a shared production shell cannot quietly disable the
// safety gate. Accepts a non-negative integer number of milliseconds;
// malformed values fall through to the default.
function readMinAgeOverride(): number | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined;
  const raw = process.env.PIPELANE_CLEAN_MIN_AGE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}
