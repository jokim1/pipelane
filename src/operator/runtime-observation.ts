import type { ShellLayerHealth } from './api/envelope.ts';
import type { DeployConfig } from './release-gate.ts';
import type { DeployRuntimeObservation } from './state.ts';
import { nowIso } from './state.ts';

export const DEFAULT_RUNTIME_MARKER_PATH = '/.well-known/pipelane-release.json';
// Snapshot/runtime provenance is advisory. Keep the default timeout tight so
// /status and board refreshes do not stall on a slow or flaky production
// marker endpoint.
export const DEFAULT_RUNTIME_OBSERVATION_TIMEOUT_MS = 1_500;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export interface FrontendRuntimeObservation {
  surface: 'frontend';
  environment: 'staging' | 'prod';
  health: ShellLayerHealth;
  frontendUrl: string | null;
  markerUrl: string | null;
  observedSha: string | null;
  deployedAt: string | null;
  observedAt: string;
  reason: string;
  source: string | null;
  statusCode: number | null;
}

export function runtimeHealthToDeployMarkerState(
  health: ShellLayerHealth,
): DeployRuntimeObservation['releaseMarkerState'] {
  return health;
}

export function toDeployRuntimeObservation(
  observation: FrontendRuntimeObservation,
): DeployRuntimeObservation | undefined {
  if (observation.health === 'unavailable') {
    return undefined;
  }
  return {
    observedSha: observation.observedSha ?? undefined,
    observedAt: observation.observedAt,
    releaseMarkerUrl: observation.markerUrl ?? undefined,
    releaseMarkerState: runtimeHealthToDeployMarkerState(observation.health),
    reason: observation.reason || undefined,
  };
}

export async function observeFrontendRuntime(options: {
  deployConfig: DeployConfig;
  environment: 'staging' | 'prod';
  timeoutMs?: number;
}): Promise<FrontendRuntimeObservation> {
  const observedAt = nowIso();
  const frontend = options.environment === 'staging'
    ? options.deployConfig.frontend.staging
    : options.deployConfig.frontend.production;
  const runtimeMarker = frontend.runtimeMarker;

  if (!runtimeMarker?.enabled) {
    return {
      surface: 'frontend',
      environment: options.environment,
      health: 'unavailable',
      frontendUrl: frontend.url || null,
      markerUrl: null,
      observedSha: null,
      deployedAt: null,
      observedAt,
      reason: 'runtime marker capability is not enabled for this frontend target',
      source: null,
      statusCode: null,
    };
  }

  const frontendUrl = frontend.url.trim();
  if (!frontendUrl) {
    return {
      surface: 'frontend',
      environment: options.environment,
      health: 'unknown',
      frontendUrl: null,
      markerUrl: null,
      observedSha: null,
      deployedAt: null,
      observedAt,
      reason: 'runtime marker capability is enabled, but frontend URL is not configured',
      source: null,
      statusCode: null,
    };
  }

  const markerPath = runtimeMarker.path?.trim() || DEFAULT_RUNTIME_MARKER_PATH;
  let markerUrl: URL;
  let frontendBaseUrl: URL;
  try {
    frontendBaseUrl = new URL(frontendUrl);
    markerUrl = new URL(markerPath, frontendBaseUrl);
  } catch {
    return {
      surface: 'frontend',
      environment: options.environment,
      health: 'degraded',
      frontendUrl,
      markerUrl: null,
      observedSha: null,
      deployedAt: null,
      observedAt,
      reason: `runtime marker path "${markerPath}" is invalid for frontend URL ${frontendUrl}`,
      source: null,
      statusCode: null,
    };
  }

  if (markerUrl.origin !== frontendBaseUrl.origin) {
    return {
      surface: 'frontend',
      environment: options.environment,
      health: 'degraded',
      frontendUrl,
      markerUrl: markerUrl.toString(),
      observedSha: null,
      deployedAt: null,
      observedAt,
      reason: `runtime marker must stay same-origin with ${frontendBaseUrl.origin}`,
      source: null,
      statusCode: null,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_OBSERVATION_TIMEOUT_MS;

  try {
    const response = await fetch(markerUrl, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 404) {
      return {
        surface: 'frontend',
        environment: options.environment,
        health: 'unknown',
        frontendUrl,
        markerUrl: markerUrl.toString(),
        observedSha: null,
        deployedAt: null,
        observedAt,
        reason: `runtime marker is missing at ${markerUrl.pathname}`,
        source: null,
        statusCode: 404,
      };
    }

    if (!response.ok) {
      return {
        surface: 'frontend',
        environment: options.environment,
        health: 'degraded',
        frontendUrl,
        markerUrl: markerUrl.toString(),
        observedSha: null,
        deployedAt: null,
        observedAt,
        reason: `runtime marker returned HTTP ${response.status}`,
        source: null,
        statusCode: response.status,
      };
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        surface: 'frontend',
        environment: options.environment,
        health: 'degraded',
        frontendUrl,
        markerUrl: markerUrl.toString(),
        observedSha: null,
        deployedAt: null,
        observedAt,
        reason: 'runtime marker returned invalid JSON',
        source: null,
        statusCode: response.status,
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        surface: 'frontend',
        environment: options.environment,
        health: 'degraded',
        frontendUrl,
        markerUrl: markerUrl.toString(),
        observedSha: null,
        deployedAt: null,
        observedAt,
        reason: 'runtime marker JSON must be an object',
        source: null,
        statusCode: response.status,
      };
    }

    const record = parsed as Record<string, unknown>;
    const sha = typeof record.sha === 'string' ? record.sha.trim() : '';
    const markerEnvironment = typeof record.environment === 'string' ? record.environment.trim() : '';
    const deployedAt = typeof record.deployedAt === 'string' ? record.deployedAt.trim() : '';
    const source = typeof record.source === 'string' ? record.source.trim() : '';

    if (!sha || !COMMIT_SHA_PATTERN.test(sha)) {
      return {
        surface: 'frontend',
        environment: options.environment,
        health: 'degraded',
        frontendUrl,
        markerUrl: markerUrl.toString(),
        observedSha: null,
        deployedAt: deployedAt || null,
        observedAt,
        reason: 'runtime marker sha is missing or invalid',
        source: source || null,
        statusCode: response.status,
      };
    }

    if (markerEnvironment && markerEnvironment !== normalizeRuntimeEnvironment(options.environment)) {
      return {
        surface: 'frontend',
        environment: options.environment,
        health: 'degraded',
        frontendUrl,
        markerUrl: markerUrl.toString(),
        observedSha: sha,
        deployedAt: deployedAt || null,
        observedAt,
        reason: `runtime marker environment "${markerEnvironment}" does not match ${normalizeRuntimeEnvironment(options.environment)}`,
        source: source || null,
        statusCode: response.status,
      };
    }

    return {
      surface: 'frontend',
      environment: options.environment,
      health: 'healthy',
      frontendUrl,
      markerUrl: markerUrl.toString(),
      observedSha: sha,
      deployedAt: deployedAt || null,
      observedAt,
      reason: `runtime marker reports ${sha.slice(0, 7)}`,
      source: source || null,
      statusCode: response.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = /aborted|timeout/i.test(message);
    return {
      surface: 'frontend',
      environment: options.environment,
      health: 'unknown',
      frontendUrl,
      markerUrl: markerUrl.toString(),
      observedSha: null,
      deployedAt: null,
      observedAt,
      reason: isTimeout
        ? `runtime marker timed out after ${timeoutMs}ms`
        : `runtime marker request failed: ${message}`,
      source: null,
      statusCode: null,
    };
  }
}

function normalizeRuntimeEnvironment(environment: 'staging' | 'prod'): 'staging' | 'production' {
  return environment === 'prod' ? 'production' : 'staging';
}
