import {
  computeDeployConfigFingerprint,
  emptyDeployConfig,
  loadDeployConfig,
  normalizeDeployEnvironment,
  resolveDeployStateKey,
  signDeployRecord,
  verifyDeployRecord,
} from '../release-gate.ts';
import {
  loadDeployState,
  loadPrRecord,
  nowIso,
  printResult,
  resolveWorkflowContext,
  runCommandCapture,
  runGh,
  runGit,
  slugifyTaskName,
  type DeployRecord,
  type DeployStatus,
  type DeployVerification,
  type ParsedOperatorArgs,
} from '../state.ts';
import {
  findLastGoodDeploy,
  inferActiveTaskLock,
  makeIdempotencyKey,
  resolveCommandSurfaces,
  resolveSurfaceHealthcheckUrl,
  setNextAction,
} from './helpers.ts';
import {
  findRecentRun,
  persistRecord,
  probeHealthcheck,
  requireProdConfirmation,
  resolveTriggeredBy,
  watchWorkflowRun,
} from './deploy.ts';

// v1.1: `/rollback <env>` dispatches a NEW deploy of the last-known-good
// sha for the named environment + surfaces. It is NOT a revert of the
// failing deploy — the gh workflow still runs, a healthcheck still
// probes, and a new DeployRecord is persisted with `rollbackOfSha`
// pointing at the failing sha.
//
// `--revert-pr` (release-mode only) is an orthogonal recovery path: it
// opens a `git revert <mergeCommit>` PR via `gh pr create`. No deploy
// is dispatched, no sha is touched on the main branch directly.
export async function handleRollback(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const environment = normalizeDeployEnvironment(parsed.positional[0] ?? '');
  const explicitSurfaces = [...parsed.flags.surfaces, ...parsed.positional.slice(1)];

  // --revert-pr has an explicit --sha path that doesn't need a task
  // lock — operators often run `/rollback prod --revert-pr --sha <merge>`
  // from `main` after `/clean` has pruned the lock. Defer lock lookup
  // for this branch so the escape hatch stays available. Codex r4 P2.
  if (parsed.flags.revertPr) {
    let taskSlugForRevert = '';
    try {
      taskSlugForRevert = inferActiveTaskLock(context, parsed.flags.task).taskSlug;
    } catch {
      // No task lock — if the operator still passed --task, honor it by
      // slugifying the name directly so handleRevertPr can look up the
      // matching PR record (Codex r5 P2: post-/clean flow shouldn't
      // silently ignore the stated task and fall through to base tip).
      if (parsed.flags.task.trim()) {
        taskSlugForRevert = slugifyTaskName(parsed.flags.task);
      }
    }
    await handleRevertPr(cwd, parsed, { taskSlug: taskSlugForRevert });
    return;
  }

  // Redeploy-rollback path: lock lookup is also best-effort here so
  // the command stays usable after /clean --apply has pruned the lock.
  // In that state the operator can still invoke with --task <slug>
  // --surfaces <csv> and we fall through to config.surfaces when
  // neither lock nor flags are present. Codex r7 P2. taskSlug is
  // required for the idempotency key + DeployRecord, so if no lock +
  // no --task, we fail with a clear message.
  let taskSlug = '';
  let lockSurfaces: string[] = [];
  try {
    const result = inferActiveTaskLock(context, parsed.flags.task);
    taskSlug = result.taskSlug;
    lockSurfaces = result.lock.surfaces ?? [];
  } catch (error) {
    if (parsed.flags.task.trim()) {
      taskSlug = slugifyTaskName(parsed.flags.task);
    } else {
      throw new Error([
        'rollback blocked: no active task lock and no --task passed.',
        'Run with --task <slug> (e.g. after /clean --apply pruned the lock), or resume the task workspace first.',
        `underlying: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'));
    }
  }
  const surfaces = resolveCommandSurfaces(context, explicitSurfaces, lockSurfaces);

  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const deployState = loadDeployState(context.commonDir, context.config);
  const stateKey = resolveDeployStateKey();
  const trustedRecords = stateKey
    ? deployState.records.filter((record) => verifyDeployRecord(record, stateKey))
    : deployState.records;

  // Resolve the sha we're rolling back FROM. Walk newest-first for a
  // matching env+surfaces record regardless of status — a failing deploy
  // is the expected input for rollback, so status:'failed' is fine.
  const currentRecord = findLatestRecord({
    records: trustedRecords,
    environment,
    surfaces,
  });
  if (!currentRecord) {
    throw new Error([
      `rollback ${environment} blocked: no prior DeployRecord exists for surfaces ${surfaces.join(',')}.`,
      `Deploy to ${environment} at least once before attempting rollback.`,
    ].join('\n'));
  }

  // Short-circuit when the environment is already at the result of a
  // prior SUCCESSFUL rollback. Without this guard, re-running /rollback
  // cascades BACKWARD: findLastGoodDeploy walks past the rollback
  // record (status=succeeded, excluded by sha) and picks the NEXT-older
  // good sha, dispatching a rollback to a still-earlier revision on
  // every repeated invocation. Applies only to succeeded rollbacks —
  // failed/pending retries fall through so the operator can retry the
  // same target (handled by the excludeSha logic below).
  if (currentRecord.status === 'succeeded' && currentRecord.rollbackOfSha) {
    throw new Error([
      `rollback ${environment} is a no-op: ${environment} is already at the result of a prior rollback`,
      `(${currentRecord.sha.slice(0, 7)} rolled back from ${currentRecord.rollbackOfSha.slice(0, 7)}).`,
      'If you want to roll back further, pass --sha <olderSha> via a fresh deploy or use --revert-pr.',
    ].join('\n'));
  }

  // When the current record is a failed/pending rollback (rollbackOfSha
  // set + status != succeeded), the environment is still at the
  // originally-failing sha, not at currentRecord.sha. Use rollbackOfSha
  // as the excludeSha so findLastGoodDeploy re-picks the same target —
  // a retry of the same rollback, not a walk further back. Without this
  // guard, the first retry excludes the prior target sha and lands on
  // an even-older good deploy, which is almost never what the operator
  // intended.
  const excludeSha = currentRecord.rollbackOfSha ?? currentRecord.sha;
  const target = findLastGoodDeploy({
    records: trustedRecords,
    environment,
    surfaces,
    excludeSha,
    configFingerprint: computeDeployConfigFingerprint(deployConfig, environment),
  });
  if (!target) {
    throw new Error([
      `rollback ${environment} blocked: no earlier succeeded+verified deploy exists for surfaces ${surfaces.join(',')}`,
      `prior to the current sha ${currentRecord.sha.slice(0, 7)} at the current config fingerprint.`,
      'Either the deploy history has rolled over (slice -100 window), or every prior deploy used a different config.',
      '`--revert-pr` or a fresh redeploy are the only paths forward.',
    ].join('\n'));
  }

  // Security: confirm target.sha still exists both locally AND on
  // origin before dispatching the gh workflow. gh workflow runs on
  // GitHub, so a local-only sha (e.g. force-pushed out of origin but
  // still in the operator's object DB) would make the downstream
  // workflow fail at checkout or fall back to the wrong ref. Fetch
  // origin first so `branch -r --contains` sees the latest refs.
  if (runGit(context.repoRoot, ['cat-file', '-e', '--end-of-options', target.sha], true) === null) {
    throw new Error([
      `rollback ${environment} blocked: target sha ${target.sha.slice(0, 7)} no longer exists in the local repo.`,
      'The commit may have been force-pushed out of history. Fetch origin and retry, or use --revert-pr.',
    ].join('\n'));
  }
  runGit(context.repoRoot, ['fetch', 'origin', context.config.baseBranch], true);
  const remoteRefs = runGit(context.repoRoot, ['branch', '-r', '--contains', target.sha], true);
  if (!remoteRefs || !remoteRefs.trim()) {
    throw new Error([
      `rollback ${environment} blocked: target sha ${target.sha.slice(0, 7)} exists locally but is not reachable from any origin branch.`,
      'The commit may have been force-pushed out of origin since the record was written. Push it back or use --revert-pr.',
    ].join('\n'));
  }

  // Prod rollbacks join the risky set — same typed-SHA prefix gate as
  // deploy.prod. Confirmation is required regardless of mode: build
  // mode is the default after `pipelane init`, and without this gate
  // `/rollback prod` in build mode would dispatch with zero human
  // confirmation (no staging gate, no release-readiness gate, and
  // Codex caught the mode-only guard as a P1). API path still bypasses
  // via PIPELANE_DEPLOY_PROD_API_CONFIRMED after consuming an HMAC
  // token, so programmatic callers aren't blocked.
  if (environment === 'prod') {
    await requireProdConfirmation(target.sha);
  }

  const workflowName = environment === 'staging'
    ? (deployConfig.frontend.staging.deployWorkflow || context.config.deployWorkflowName)
    : (deployConfig.frontend.production.deployWorkflow || context.config.deployWorkflowName);

  const requestedAt = nowIso();
  const triggeredBy = resolveTriggeredBy();
  const dispatchStart = Date.now();
  const configFingerprint = computeDeployConfigFingerprint(deployConfig, environment);

  // Fresh idempotency key scoped to (rollback target + ORIGINAL failing
  // sha + surfaces + task). Distinct from a plain re-deploy of the same
  // sha, so a rollback can't short-circuit against a pre-existing
  // succeeded record for the target sha. Using originalFailingSha (set
  // below) keeps the key stable across retries — retry 2 has the same
  // key as retry 1, which is the right semantics for a retry.
  const originalFailingSha = currentRecord.rollbackOfSha ?? currentRecord.sha;
  const idempotencyKey = makeIdempotencyKey({
    environment,
    sha: target.sha,
    surfaces,
    taskSlug,
    configFingerprint: `${configFingerprint}:rollback-from:${originalFailingSha}`,
  });

  runGh(context.repoRoot, [
    'workflow',
    'run',
    workflowName,
    '-f',
    `environment=${environment === 'prod' ? 'production' : 'staging'}`,
    '-f',
    `sha=${target.sha}`,
    '-f',
    `surfaces=${surfaces.join(',')}`,
  ]);

  // strict=true: rollback redeploys a known sha, so any prior
  // successful run of target.sha is a stale match that would make
  // watchWorkflowRun attach to the old succeeded run and mark the new
  // rollback succeeded without waiting for the fresh dispatch. Retry
  // a few times with a short delay to absorb `gh run list` propagation
  // lag — one-shot lookup races against GitHub's run-list index and
  // can return null even for a just-dispatched run (Codex r7 P2).
  let run: { id: string; url?: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    run = findRecentRun(context.repoRoot, workflowName, target.sha, dispatchStart, { strict: true });
    if (run) break;
    // 500ms, 1s, 2s, 4s, 8s — total ~15.5s of propagation tolerance.
    const delayMs = 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // originalFailingSha already computed above for the idempotency key.
  // Preserve it as the new record's rollbackOfSha — without this, a
  // second retry would record rollbackOfSha=<target>, and a third
  // retry's excludeSha lookup would then skip the target instead of
  // pinning it, walking the environment further back on every failure.
  // Codex caught this on round 3.
  let record: DeployRecord = {
    environment,
    sha: target.sha,
    surfaces,
    workflowName,
    requestedAt,
    taskSlug,
    status: 'requested',
    workflowRunId: run?.id,
    workflowRunUrl: run?.url,
    idempotencyKey,
    triggeredBy,
    rollbackOfSha: originalFailingSha,
  };

  // Sign the 'requested' record so signed repos' trustedRecords filter
  // keeps it visible during async dispatch. Without this, --async
  // rollback's breadcrumb is filtered out and a subsequent /rollback
  // can't see the in-flight attempt (Codex r6 P2). Matches the
  // deploy.ts pattern at the same step.
  if (stateKey) {
    record = { ...record, signature: signDeployRecord(record, stateKey) };
  }
  persistRecord(context.commonDir, context.config, deployState.records, record);

  if (parsed.flags.async) {
    printResult(parsed.flags, {
      ...record,
      message: [
        `Rollback dispatched (async): ${environment}`,
        `Task: ${taskSlug}`,
        `From: ${originalFailingSha.slice(0, 7)} (original failing sha)`,
        `To:   ${target.sha.slice(0, 7)} (${target.verifiedAt ? `verified ${target.verifiedAt}` : 'last-good'})`,
        `Surfaces: ${surfaces.join(', ')}`,
        `Workflow: ${workflowName}`,
        run?.id ? `Workflow run: ${run.url ?? run.id}` : 'Workflow run: not yet resolvable',
        'Exit without watching per --async.',
      ].filter(Boolean).join('\n'),
    });
    return;
  }

  // Watch + probe. The verification logic mirrors deploy.ts so the
  // rollback record carries the same per-surface verification shape
  // the release gate + dashboard already consume.
  const watched = watchWorkflowRun(context.repoRoot, run?.id);
  const finishedAt = nowIso();
  const durationMs = Date.now() - dispatchStart;
  let status: DeployStatus = watched.ok ? 'succeeded' : 'failed';
  let failureReason = watched.ok ? undefined : (watched.reason || 'workflow run reported non-zero exit');

  let verification: DeployVerification | undefined;
  let verificationBySurface: Record<string, DeployVerification> | undefined;
  if (watched.ok) {
    verificationBySurface = {};
    const perSurfaceFailures: string[] = [];
    const stubStatus = process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS;
    for (const surface of surfaces) {
      const surfaceUrl = resolveSurfaceHealthcheckUrl(deployConfig, environment, surface);
      if (!surfaceUrl && !stubStatus) {
        const empty: DeployVerification = { healthcheckUrl: '', probes: 0 };
        verificationBySurface[surface] = empty;
        perSurfaceFailures.push(`${surface}: no healthcheck URL configured`);
        continue;
      }
      const probe = await probeHealthcheck(surfaceUrl);
      verificationBySurface[surface] = probe;
      const code = probe.statusCode;
      if (typeof code !== 'number' || code < 200 || code >= 300) {
        perSurfaceFailures.push(
          probe.error
            ?? (code
              ? `${surface}: healthcheck returned HTTP ${code}`
              : `${surface}: healthcheck did not return a 2xx`),
        );
      }
    }
    verification = verificationBySurface['frontend']
      ?? verificationBySurface[surfaces[0]]
      ?? { healthcheckUrl: '', probes: 0 };
    if (perSurfaceFailures.length > 0) {
      status = 'failed';
      failureReason = perSurfaceFailures.join('; ');
    }
  }

  const verifiedAt = status === 'succeeded' ? nowIso() : undefined;

  record = {
    ...record,
    status,
    finishedAt,
    durationMs,
    verification,
    verificationBySurface,
    verifiedAt,
    configFingerprint,
    failureReason,
  };
  if (stateKey) {
    record = { ...record, signature: signDeployRecord(record, stateKey) };
  }

  const latestState = loadDeployState(context.commonDir, context.config);
  persistRecord(context.commonDir, context.config, latestState.records, record);

  if (status !== 'succeeded') {
    throw new Error([
      `Rollback did not verify: ${environment}`,
      failureReason ?? 'unknown failure',
      run?.url ? `Workflow: ${run.url}` : '',
    ].filter(Boolean).join('\n'));
  }

  setNextAction(
    context.commonDir,
    context.config,
    taskSlug,
    `${environment} rolled back to ${target.sha.slice(0, 7)} from ${originalFailingSha.slice(0, 7)}`,
  );

  printResult(parsed.flags, {
    ...record,
    message: [
      `Rollback verified: ${environment}`,
      `Task: ${taskSlug}`,
      `From: ${originalFailingSha}`,
      `To:   ${target.sha}`,
      `Surfaces: ${surfaces.join(', ')}`,
      `Workflow: ${workflowName}`,
      run?.url ? `Workflow run: ${run.url}` : '',
      verification?.healthcheckUrl
        ? `Healthcheck: ${verification.healthcheckUrl} → HTTP ${verification.statusCode} in ${verification.latencyMs}ms (${verification.probes} probe(s))`
        : 'Healthcheck: skipped (no URL configured)',
      environment === 'prod'
        ? 'Next: investigate the failing change and open a revert PR if needed (workflow:rollback -- prod --revert-pr).'
        : 'Next: validate staging, then decide whether to promote to prod or open a revert PR.',
    ].filter(Boolean).join('\n'),
  });
}

// v1.1: `--revert-pr` opens a git-revert PR instead of dispatching a
// deploy. Release-mode only — build-mode operators are already free to
// edit main directly, and the safety value here is keeping a paper
// trail through PR review. Never force-pushes, never touches main.
async function handleRevertPr(
  cwd: string,
  parsed: ParsedOperatorArgs,
  options: { taskSlug: string },
): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  if (context.modeState.mode !== 'release') {
    throw new Error('--revert-pr is release-mode only. Switch modes with workflow:devmode -- release first.');
  }

  // Refuse to operate against a dirty worktree — we're about to `switch`
  // branches mid-command, and uncommitted work that gets stranded on an
  // ephemeral revert branch is a terrible UX. Surface the dirty state
  // loudly before touching anything.
  const dirty = runGit(context.repoRoot, ['status', '--porcelain'], true);
  if (dirty && dirty.trim()) {
    throw new Error([
      '--revert-pr blocked: worktree has uncommitted changes.',
      'Commit or stash them before opening a revert PR — this command switches branches.',
    ].join('\n'));
  }

  // Resolution order: operator-supplied --sha (highest precedence,
  // covers the "pr-state.json is stale or wrong" incident case) →
  // recorded mergedSha on the task's PR record. NO tip fallback:
  // Codex r7 P1 caught that reverting the base-branch tip when newer
  // unrelated commits have landed opens a PR reverting the WRONG
  // commit. The ancestry check still passes because the tip is on
  // the base branch. Fail closed instead — the operator can pass
  // --sha explicitly if pr-state is missing.
  runGit(context.repoRoot, ['fetch', 'origin', context.config.baseBranch], true);
  const explicitSha = parsed.flags.sha.trim();
  const prRecord = options.taskSlug
    ? loadPrRecord(context.commonDir, context.config, options.taskSlug)
    : null;
  const rawSha = explicitSha || prRecord?.mergedSha;
  if (!rawSha) {
    throw new Error([
      '--revert-pr blocked: could not resolve a merge commit to revert.',
      'Pass --sha <mergeCommit> explicitly, or ensure pr-state.json has a recorded mergedSha for this task.',
      'Reverting the base-branch tip is not a safe default — newer unrelated commits may have landed.',
    ].join('\n'));
  }

  // Security: validate rawSha before anything touches git. Reject shapes
  // that would let an attacker with fs-write to pr-state.json inject a
  // flag-like value into `git revert` or make the derived revert branch
  // name start with `-` (which would then flag-inject into git switch /
  // git push). git's hex alphabet is [0-9a-f]; require 7-40 chars.
  if (!/^[0-9a-f]{7,40}$/i.test(rawSha)) {
    throw new Error([
      `--revert-pr blocked: "${rawSha}" is not a valid git sha (hex, 7-40 chars).`,
      'pr-state.json may be tampered; check its contents before retrying.',
    ].join('\n'));
  }

  // Normalize via rev-parse --verify so a short sha becomes a full 40
  // and unknown refs fail closed. --verify rejects any token starting
  // with `-` as a safety belt.
  const mergedSha = runGit(context.repoRoot, ['rev-parse', '--verify', `${rawSha}^{commit}`], true);
  if (!mergedSha) {
    throw new Error(`--revert-pr blocked: "${rawSha}" does not resolve to a commit in this repo.`);
  }

  // Base ref resolution — the fetch above already refreshed origin,
  // so origin/<base> is current. Fall back to local <base> if no
  // remote tracking ref exists (offline-or-fresh-clone scenario).
  const baseRef = runGit(context.repoRoot, ['rev-parse', '--verify', `origin/${context.config.baseBranch}`], true)
    ?? runGit(context.repoRoot, ['rev-parse', '--verify', context.config.baseBranch], true);
  if (!baseRef) {
    throw new Error(`--revert-pr blocked: cannot resolve base branch "${context.config.baseBranch}" locally or on origin.`);
  }

  // Security: confirm mergedSha is an ancestor of the base branch.
  // Otherwise an attacker controlling pr-state.json could point us at
  // an arbitrary commit on a disjoint history (e.g. a rogue branch).
  const ancestry = runCommandCapture('git', ['merge-base', '--is-ancestor', mergedSha, baseRef], { cwd: context.repoRoot });
  if (!ancestry.ok) {
    throw new Error([
      `--revert-pr blocked: ${mergedSha.slice(0, 7)} is not an ancestor of ${context.config.baseBranch}.`,
      'Refusing to revert a commit that is not on the base branch history.',
    ].join('\n'));
  }

  const revertShortSha = mergedSha.slice(0, 7);
  const revertBranch = `${context.config.branchPrefix}revert-${revertShortSha}`;

  // Refuse to reuse an existing branch — operators re-running /rollback
  // --revert-pr need deterministic behavior, not a silent append to a
  // pre-existing revert branch. Check both local and remote.
  if (runGit(context.repoRoot, ['rev-parse', '--verify', revertBranch], true)) {
    throw new Error(`--revert-pr blocked: branch ${revertBranch} already exists locally. Delete it or pass a different --sha.`);
  }
  if (runGit(context.repoRoot, ['ls-remote', '--exit-code', '--heads', 'origin', revertBranch], true) !== null) {
    throw new Error([
      `--revert-pr blocked: branch ${revertBranch} already exists on origin.`,
      `Delete it (\`git push origin --delete ${revertBranch}\`) before retrying.`,
    ].join('\n'));
  }

  // Capture the operator's current ref so we can put them back on it
  // regardless of success/failure. `symbolic-ref --short HEAD` returns
  // the branch name when HEAD is a branch; falls back to the detached
  // sha otherwise. Used in the restore-on-finally block below.
  const originalRef =
    runGit(context.repoRoot, ['symbolic-ref', '--short', 'HEAD'], true)
    ?? runGit(context.repoRoot, ['rev-parse', '--verify', 'HEAD'], true);

  const restoreOriginalRef = () => {
    if (!originalRef) return;
    runGit(context.repoRoot, ['switch', originalRef], true);
  };

  try {
    runGit(context.repoRoot, ['switch', '-c', revertBranch, baseRef]);
    const revertResult = runGit(context.repoRoot, ['revert', '--no-edit', mergedSha], true);
    if (revertResult === null) {
      runGit(context.repoRoot, ['revert', '--abort'], true);
      restoreOriginalRef();
      runGit(context.repoRoot, ['branch', '-D', revertBranch], true);
      throw new Error([
        `--revert-pr blocked: \`git revert ${revertShortSha}\` failed (likely a merge conflict).`,
        'Resolve manually: check out the branch, run git revert, commit, and open the PR by hand.',
      ].join('\n'));
    }

    runGit(context.repoRoot, ['push', '-u', 'origin', revertBranch]);
    const prUrl = runGh(context.repoRoot, [
      'pr',
      'create',
      '--base',
      context.config.baseBranch,
      '--head',
      revertBranch,
      '--title',
      `Revert "${revertShortSha}"`,
      '--body',
      [
        `Automated revert of ${mergedSha} created via \`/rollback --revert-pr\`.`,
        'Review the revert carefully before merging — this undoes the above commit.',
      ].join('\n\n'),
    ], true);

    if (prUrl === null) {
      // gh pr create failed post-push. Clean up the remote + local
      // branch so retry lands on a clean slate (instead of the
      // "branch already exists" guard above).
      runGit(context.repoRoot, ['push', 'origin', '--delete', revertBranch], true);
      restoreOriginalRef();
      runGit(context.repoRoot, ['branch', '-D', revertBranch], true);
      throw new Error([
        '--revert-pr blocked: `gh pr create` failed after pushing the revert branch.',
        'Cleaned up the remote + local branches. Re-run the command to retry.',
      ].join('\n'));
    }

    restoreOriginalRef();
    printResult(parsed.flags, {
      revertBranch,
      revertedSha: mergedSha,
      prUrl,
      message: [
        `Revert PR opened for ${revertShortSha}`,
        `Branch: ${revertBranch}`,
        `PR: ${prUrl}`,
        'No sha was pushed to main. Review + merge the PR to land the revert.',
      ].join('\n'),
    });
  } catch (error) {
    // Any unexpected throw past the try-block boundary (e.g. push fails
    // from runGit which doesn't allowFailure) leaves the worktree on
    // revertBranch. Restore before rethrowing so the operator lands
    // back where they started.
    restoreOriginalRef();
    throw error;
  }
}

function findLatestRecord(options: {
  records: DeployRecord[];
  environment: 'staging' | 'prod';
  surfaces: string[];
}): DeployRecord | null {
  const key = [...options.surfaces].sort().join(',');
  for (let i = options.records.length - 1; i >= 0; i -= 1) {
    const record = options.records[i];
    if (record.environment !== options.environment) continue;
    if (!record.sha) continue;
    const recordKey = [...(record.surfaces ?? [])].sort().join(',');
    if (recordKey !== key) continue;
    return record;
  }
  return null;
}

