import { buildReleaseCheckMessage, emptyDeployConfig, evaluateReleaseReadiness, loadDeployConfig } from '../release-gate.ts';
import { loadDeployState, printResult, saveModeState, type ParsedOperatorArgs, type WorkflowContext } from '../state.ts';
import { resolveWorkflowContext } from '../state.ts';
import { resolveCommandSurfaces, sanitizeForTerminal } from './helpers.ts';

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

  const surfaces = resolveCommandSurfaces(context, parsed.flags.surfaces);

  if (action === 'build') {
    // v1.5: keep lastOverride around when flipping off release. The durable
    // audit trail should survive mode churn — the gate-bypass breadcrumb is
    // only interesting long after the override is switched off.
    saveModeState(context.commonDir, context.config, {
      mode: 'build',
      requestedSurfaces: surfaces,
      override: null,
      lastOverride: context.modeState.lastOverride,
      updatedAt: new Date().toISOString(),
    });
    printResult(parsed.flags, {
      mode: 'build',
      requestedSurfaces: surfaces,
      message: [
        'Dev Mode: [build]',
        `Requested surfaces: ${surfaces.join(', ')}`,
      ].join('\n'),
    });
    return;
  }

  if (action === 'release') {
    const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
    const deployState = loadDeployState(context.commonDir, context.config);
    const readiness = evaluateReleaseReadiness({
      config: context.config,
      deployConfig,
      deployRecords: deployState.records,
      surfaces,
    });

    if (!readiness.ready && !parsed.flags.override) {
      printResult(parsed.flags, {
        ready: false,
        blockedSurfaces: readiness.blockedSurfaces,
        message: buildReleaseCheckMessage(readiness, surfaces),
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
        'Example: npm run workflow:devmode -- release --override --reason "shipping hotfix <ticket>"',
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

    saveModeState(context.commonDir, context.config, {
      mode: 'release',
      requestedSurfaces: surfaces,
      override,
      lastOverride,
      updatedAt: now,
    });

    printResult(parsed.flags, {
      mode: 'release',
      requestedSurfaces: surfaces,
      override: parsed.flags.override,
      message: [
        'Dev Mode: [release]',
        `Requested surfaces: ${surfaces.join(', ')}`,
        override ? `Release override: ${override.reason}` : 'Release override: none',
      ].join('\n'),
    });
    return;
  }

  throw new Error(`Unknown devmode action "${action}".`);
}

// v1.5: identify the operator who set the override. Mirrors the attribution
// heuristic in deploy.ts (PIPELANE_DEPLOY_TRIGGERED_BY → GITHUB_ACTOR → USER
// → fallback) so an override recorded in CI and one recorded locally carry
// the right label. GITHUB_ACTOR is attacker-controlled in some CI contexts
// (pull_request_target), so the raw value is filtered: only [A-Za-z0-9_.-]
// survive, max 64 chars. Anything that fails the whitelist falls through to
// the next env in the chain. This keeps a legitimate username round-trip
// but denies a malicious actor the ability to plant ANSI escapes in
// mode-state.json.
const SET_BY_ALLOW = /^[A-Za-z0-9_.\-]{1,64}$/;

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
