import {
  buildReleaseCheckMessage,
  emptyDeployConfig,
  evaluateReleaseReadiness,
  loadDeployConfig,
  releaseReadinessHasOnlyStaleProbeAgeBlockers,
} from '../release-gate.ts';
import {
  formatWorkflowCommand,
  loadDeployState,
  loadProbeState,
  normalizeExistingPath,
  nowIso,
  printResult,
  saveModeState,
  updateTaskLock,
  type Mode,
  type ModeState,
  type ParsedOperatorArgs,
  type TaskLock,
  type WorkflowContext,
} from '../state.ts';
import { resolveWorkflowContext } from '../state.ts';
import { quoteShellWord, resolveModeSurfaces, resolveModeTaskLock, sanitizeForTerminal } from './helpers.ts';
import { executeProbeWithStateLock, type ProbeOutcome } from './doctor.ts';

export async function handleDevmode(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const action = parsed.positional[0] ?? 'status';

  if (action === 'status') {
    const last = context.modeState.lastOverride;
    const active = context.modeState.override;
    printResult(parsed.flags, {
      mode: context.modeState.mode,
      requestedSurfaces: context.modeState.requestedSurfaces,
      override: active,
      lastOverride: last ?? null,
      message: [
        `Dev Mode: [${context.modeState.mode}]`,
        `Requested surfaces: ${context.modeState.requestedSurfaces.join(', ')}`,
        active
          ? `Release override: ${sanitizeForTerminal(active.reason)} (${sanitizeForTerminal(active.timestamp)})`
          : 'Release override: none',
        last
          ? `Last override: ${sanitizeForTerminal(last.reason)} (${sanitizeForTerminal(last.setAt)} by ${sanitizeForTerminal(last.setBy)})`
          : 'Last override: none recorded',
      ].join('\n'),
    });
    return;
  }

  const taskLock = resolveModeTaskLock(context, parsed.flags.task);
  const surfaces = resolveModeSurfaces(context, parsed.flags.surfaces, taskLock);

  if (action === 'build') {
    // v1.5: keep lastOverride around when flipping off release. The durable
    // audit trail should survive mode churn — the gate-bypass breadcrumb is
    // only interesting long after the override is switched off.
    const nextModeState: ModeState = {
      mode: 'build',
      requestedSurfaces: surfaces,
      override: null,
      lastOverride: context.modeState.lastOverride,
      updatedAt: nowIso(),
    };
    const taskLockTransition = persistModeAndTaskLock(context, nextModeState, taskLock);
    printResult(parsed.flags, {
      mode: 'build',
      requestedSurfaces: surfaces,
      taskLockTransition,
      message: [
        'Dev Mode: [build]',
        `Requested surfaces: ${surfaces.join(', ')}`,
        taskLockTransition,
      ].filter(Boolean).join('\n'),
    });
    return;
  }

  if (action === 'release') {
    const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
    const deployState = loadDeployState(context.commonDir, context.config);
    const probeState = loadProbeState(context.commonDir, context.config);
    let readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      deployRecords: deployState.records,
      probeState,
      surfaces,
    });

    let probeRefresh: ProbeOutcome | null = null;
    if (!readiness.ready && !parsed.flags.override && releaseReadinessHasOnlyStaleProbeAgeBlockers(readiness)) {
      probeRefresh = await executeProbeWithStateLock(context);
      readiness = evaluateReleaseReadiness({
        config: context.config,
        deployConfig,
        // The probe is asynchronous. Re-read deploy state so a staging
        // request or failure recorded while healthchecks were running cannot
        // be hidden by the pre-probe success snapshot.
        deployRecords: loadDeployState(context.commonDir, context.config).records,
        probeState: loadProbeState(context.commonDir, context.config),
        surfaces,
      });
    }

    if (!readiness.ready && !parsed.flags.override) {
      printResult(parsed.flags, {
        ready: false,
        blockedSurfaces: readiness.blockedSurfaces,
        probeRefresh,
        message: [
          probeRefresh ? 'Refreshed stale release probes inline.' : '',
          probeRefresh?.message ?? '',
          buildReleaseCheckMessage(readiness, surfaces, context.config),
        ].filter(Boolean).join('\n\n'),
      });
      process.exitCode = 1;
      return;
    }

    // v1.5: --override now requires --reason. Bypassing release readiness is
    // auditable by construction — a silent "manual override" default would
    // defeat the point of recording who sidestepped the gate and why.
    if (parsed.flags.override && !parsed.flags.reason.trim()) {
      throw new Error([
        'Release override requires --reason.',
        `Example: ${formatWorkflowCommand(context.config, 'devmode', 'release')} --override --reason "shipping hotfix <ticket>"`,
        'Reasons are persisted to mode-state.json as lastOverride and surfaced by /status.',
      ].join('\n'));
    }

    const now = new Date().toISOString();
    const overrideReason = parsed.flags.reason.trim();
    const override = parsed.flags.override
      ? { reason: overrideReason, timestamp: now }
      : null;

    // v1.5: persist lastOverride across mode flips. It's the durable audit
    // trail; `override` above is the active-use field that mode=build clears.
    const lastOverride = override
      ? {
        reason: override.reason,
        setAt: now,
        setBy: resolveOverrideSetBy(),
      }
      : context.modeState.lastOverride;

    const nextModeState: ModeState = {
      mode: 'release',
      requestedSurfaces: surfaces,
      override,
      lastOverride,
      updatedAt: now,
    };
    const taskLockTransition = persistModeAndTaskLock(context, nextModeState, taskLock);

    printResult(parsed.flags, {
      mode: 'release',
      requestedSurfaces: surfaces,
      override: parsed.flags.override,
      taskLockTransition,
      probeRefresh,
      message: [
        probeRefresh ? 'Refreshed stale release probes inline.' : '',
        probeRefresh?.message ?? '',
        'Dev Mode: [release]',
        `Requested surfaces: ${surfaces.join(', ')}`,
        override ? `Release override: ${override.reason}` : 'Release override: none',
        taskLockTransition,
      ].filter(Boolean).join('\n'),
    });
    return;
  }

  throw new Error(`Unknown devmode action "${action}".`);
}

function persistModeAndTaskLock(
  context: WorkflowContext,
  nextModeState: ModeState,
  taskLock: TaskLock | null,
): string {
  if (!taskLock) {
    saveModeState(context.commonDir, context.config, nextModeState);
    return '';
  }

  let previousMode: Mode = taskLock.mode;
  let nextLock: TaskLock | null = null;
  nextLock = updateTaskLock(
    context.commonDir,
    context.config,
    taskLock.taskSlug,
    (latestLock) => {
      if (!latestLock) {
        throw new Error([
          `Task lock ${taskLock.taskSlug} disappeared while devmode ${nextModeState.mode} checked release readiness.`,
          'The lock was not recreated and global mode state was not changed.',
          'Resolve or resume the task workspace, then retry devmode.',
        ].join('\n'));
      }
      if (
        latestLock.taskBindingId !== taskLock.taskBindingId
        || latestLock.branchName !== taskLock.branchName
        || normalizeExistingPath(latestLock.worktreePath) !== normalizeExistingPath(taskLock.worktreePath)
      ) {
        throw new Error([
          `Task lock ${taskLock.taskSlug} changed binding while devmode ${nextModeState.mode} checked release readiness.`,
          `Current task worktree: ${latestLock.worktreePath}`,
          'No mode state was changed.',
          `Next: cd ${quoteShellWord(latestLock.worktreePath)} and retry devmode ${nextModeState.mode} --task "${taskLock.taskSlug}".`,
        ].join('\n'));
      }
      if (!sameSurfaceSet(latestLock.surfaces, taskLock.surfaces)) {
        throw new Error([
          `Task lock ${taskLock.taskSlug} changed surfaces while devmode ${nextModeState.mode} checked release readiness.`,
          `Checked surfaces: ${taskLock.surfaces.join(', ')}`,
          `Current task surfaces: ${latestLock.surfaces.join(', ')}`,
          'No mode state was changed.',
          `Retry devmode ${nextModeState.mode} --task "${taskLock.taskSlug}" so readiness covers the current task surfaces.`,
        ].join('\n'));
      }
      previousMode = latestLock.mode;
      if (latestLock.mode === nextModeState.mode) return latestLock;
      return {
        ...latestLock,
        mode: nextModeState.mode as Mode,
        updatedAt: nextModeState.updatedAt ?? nowIso(),
      };
    },
    {
      // Keep the per-task mutation lease through the global mode write so two
      // devmode processes for the same task cannot cross their writes.
      afterWrite: () => saveModeState(context.commonDir, context.config, nextModeState),
    },
  );
  if (!nextLock) throw new Error(`Task lock ${taskLock.taskSlug} disappeared during mode reconciliation.`);

  return previousMode === nextModeState.mode
    ? ''
    : `task lock ${taskLock.taskSlug}: ${previousMode} → ${nextModeState.mode}`;
}

function sameSurfaceSet(left: string[], right: string[]): boolean {
  const canonicalize = (values: string[]) => [...new Set(values)].sort().join('\n');
  return canonicalize(left) === canonicalize(right);
}

// v1.5: identify the operator who set the override. Mirrors the attribution
// heuristic in deploy.ts (PIPELANE_DEPLOY_TRIGGERED_BY → GITHUB_ACTOR → USER
// → fallback) so an override recorded in CI and one recorded locally carry
// the right label. GITHUB_ACTOR is attacker-controlled in some CI contexts
// (pull_request_target), so the raw value is filtered: only the characters
// in SET_BY_ALLOW survive, max 64 chars. Brackets `[]` are allowed so
// GitHub bot actors (`dependabot[bot]`, `github-actions[bot]`,
// `renovate[bot]`) round-trip; bracket alone can't form an ANSI escape
// without the ESC byte (\x1b), which is blocked by the control-char gate
// at every render site. Whitelist failures fall through to the next env
// in the chain. This keeps a legitimate username round-trip but denies a
// malicious actor the ability to plant ANSI escapes in mode-state.json.
const SET_BY_ALLOW = /^[A-Za-z0-9_.\-[\]]{1,64}$/;

function cleanSetBy(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!SET_BY_ALLOW.test(trimmed)) return null;
  return trimmed;
}

function resolveOverrideSetBy(): string {
  return (
    cleanSetBy(process.env.PIPELANE_OVERRIDE_SET_BY)
    ?? cleanSetBy(process.env.GITHUB_ACTOR)
    ?? cleanSetBy(process.env.USER)
    ?? 'pipelane'
  );
}
